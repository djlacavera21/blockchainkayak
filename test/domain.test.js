"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { DemoLedger } = require("../server/demo-ledger");
const { fixture, NOW, later, rental, inspection } = require("./helpers");

test("complete custody lifecycle, damage hold, manager release and asset history", async (t) => {
  const { ledger, run } = await fixture(t);
  await run("CheckoutRental", rental(), "staff");
  assert.ok(
    (await ledger.snapshot()).assets.every((a) => a.status === "in_use"),
  );
  await run(
    "ReturnRental",
    { rentalId: "RENTAL-01", damagedAssetIds: ["K-01"] },
    "staff",
  );
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.rentals.length, 0);
  assert.equal(
    snapshot.assets.find((a) => a.id === "K-01").status,
    "maintenance",
  );
  assert.equal(
    snapshot.assets.find((a) => a.id === "F-01").status,
    "inspection_due",
  );
  await assert.rejects(
    run("InspectAsset", inspection("K-01"), "staff"),
    /FORBIDDEN/,
  );
  await run("InspectAsset", inspection("K-01"));
  assert.equal((await ledger.history("K-01")).items.length, 5);
  assert.equal((await ledger.rental("RENTAL-01")).status, "returned");
});
test("simultaneous checkouts cannot double-assign a boat", async (t) => {
  const { ledger, run } = await fixture(t);
  const results = await Promise.allSettled([
    run("CheckoutRental", rental()),
    run("CheckoutRental", rental({ id: "RENTAL-02" })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /not available/,
  );
  assert.equal((await ledger.snapshot()).rentals.length, 1);
});
test("failed checkout has no partial custody updates or extra event", async (t) => {
  const { ledger, run } = await fixture(t);
  const before = await ledger.snapshot();
  await assert.rejects(
    run("CheckoutRental", rental({ assetIds: ["K-01", "P-01"] })),
    /PFD/,
  );
  assert.deepEqual(await ledger.snapshot(), before);
});
test("idempotent request returns original receipt and does not append an event", async (t) => {
  const { ledger, run } = await fixture(t);
  const key = randomUUID();
  const first = await run("CheckoutRental", rental(), "manager", key);
  const snapshot = await ledger.snapshot();
  assert.deepEqual(
    await run("CheckoutRental", rental(), "manager", key, later(0.25)),
    first,
  );
  assert.deepEqual(await ledger.snapshot(), snapshot);
  await assert.rejects(
    run("CheckoutRental", rental({ id: "OTHER-RENTAL" }), "manager", key),
    /different request/,
  );
});
test("held, closed and expired launch reviews block departure but permit returns", async (t) => {
  const { run } = await fixture(t);
  for (const status of ["hold", "closed"]) {
    await run("SetLaunchStatus", {
      status,
      reasonCode: "WEATHER",
      validUntil: later(2),
    });
    await assert.rejects(
      run("CheckoutRental", rental()),
      /Launch is closed, held/,
    );
  }
  await run("SetLaunchStatus", {
    status: "open",
    reasonCode: "STAFF_REVIEW",
    validUntil: later(0.5),
  });
  await assert.rejects(
    run(
      "CheckoutRental",
      rental({ dueAt: later(2) }),
      "manager",
      randomUUID(),
      later(1),
    ),
    /fresh review/,
  );
  await run("CheckoutRental", rental());
  await run("SetLaunchStatus", {
    status: "closed",
    reasonCode: "WATER",
    validUntil: later(4),
  });
  await run(
    "ReturnRental",
    { rentalId: "RENTAL-01", damagedAssetIds: [] },
    "staff",
  );
});
test("an unreviewed launch fails closed", async (t) => {
  const ledger = new DemoLedger(":memory:");
  t.after(() => ledger.close());
  await assert.rejects(
    ledger.execute("CheckoutRental", rental(), randomUUID(), "manager", NOW),
    /Launch review does not exist/,
  );
});
test("invalid and excessive review lifetimes are rejected", async (t) => {
  const { run } = await fixture(t);
  for (const validUntil of [NOW, later(13), "2026-02-31T14:00:00.000Z"])
    await assert.rejects(
      run("SetLaunchStatus", {
        status: "open",
        reasonCode: "STAFF_REVIEW",
        validUntil,
      }),
      /VALIDATION/,
    );
});
test("stale inspection and backdated operation are rejected", async (t) => {
  const { run } = await fixture(t);
  await run(
    "SetLaunchStatus",
    { status: "open", reasonCode: "STAFF_REVIEW", validUntil: later(28) },
    "manager",
    randomUUID(),
    later(25),
  );
  await assert.rejects(
    run(
      "CheckoutRental",
      rental({ dueAt: later(26) }),
      "manager",
      randomUUID(),
      later(25),
    ),
    /fresh inspection/,
  );
  const yesterday = new Date(Date.parse(NOW) - 3600000).toISOString();
  await assert.rejects(
    run("InspectAsset", inspection("K-01"), "manager", randomUUID(), yesterday),
    /predates/,
  );
});
test("registration starts in inspection due, failed checks hold equipment", async (t) => {
  const { ledger, run } = await fixture(t);
  await run("RegisterAsset", {
    id: "S-02",
    type: "paddleboard",
    label: "New Board",
  });
  assert.equal(
    (await ledger.snapshot()).assets.find((a) => a.id === "S-02").status,
    "inspection_due",
  );
  await assert.rejects(
    run("InspectAsset", {
      ...inspection("S-02"),
      checks: { body: false, fittings: true, clean: true },
    }),
    /All checks must pass/,
  );
  await run("InspectAsset", {
    ...inspection("S-02"),
    result: "fail",
    checks: { body: false, fittings: true, clean: true },
    reasonCode: "BODY_DAMAGE",
  });
  assert.equal(
    (await ledger.snapshot()).assets.find((a) => a.id === "S-02").status,
    "maintenance",
  );
});
test("retirement is terminal and rented equipment cannot be retired", async (t) => {
  const { run } = await fixture(t);
  await run("CheckoutRental", rental());
  await assert.rejects(
    run("SetAssetStatus", {
      assetId: "K-01",
      status: "retired",
      reasonCode: "OTHER",
    }),
    /active rental/,
  );
  await run("ReturnRental", { rentalId: "RENTAL-01", damagedAssetIds: [] });
  await run("SetAssetStatus", {
    assetId: "K-01",
    status: "retired",
    reasonCode: "OTHER",
  });
  await assert.rejects(
    run("InspectAsset", inspection("K-01")),
    /cannot be inspected/,
  );
});
test("roles are enforced independently of the HTTP service", async (t) => {
  const { run } = await fixture(t);
  await assert.rejects(
    run("RegisterAsset", { id: "XX", type: "kayak", label: "Test" }, "staff"),
    /FORBIDDEN/,
  );
  await assert.rejects(run("CheckoutRental", rental(), "auditor"), /FORBIDDEN/);
  await assert.rejects(
    run(
      "SetLaunchStatus",
      { status: "open", reasonCode: "WATER", validUntil: later(1) },
      "staff",
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(run("constructor", {}), /Unknown action/);
});
test("checkout rejects personal fields, invalid references, duplicate gear and incomplete checks", async (t) => {
  const { run } = await fixture(t);
  for (const payload of [
    rental({ customerName: "Jane" }),
    rental({ renterRef: "jane@example.com" }),
    rental({ waiverHash: "unverified" }),
    rental({ briefingConfirmed: false }),
    rental({ pfdFitConfirmed: false }),
    rental({ assetIds: ["K-01", "K-01", "F-01", "P-01"] }),
    rental({ partySize: 2 }),
    rental({ dueAt: NOW }),
    rental({ partySize: 1.5 }),
  ])
    await assert.rejects(run("CheckoutRental", payload), /VALIDATION/);
});
test("returns reject unrelated equipment, double return and pre-checkout time", async (t) => {
  const { run } = await fixture(t);
  await run("CheckoutRental", rental());
  await assert.rejects(
    run("ReturnRental", { rentalId: "RENTAL-01", damagedAssetIds: ["OTHER"] }),
    /from this rental/,
  );
  await assert.rejects(
    run(
      "ReturnRental",
      { rentalId: "RENTAL-01", damagedAssetIds: [] },
      "staff",
      randomUUID(),
      new Date(Date.parse(NOW) - 1000).toISOString(),
    ),
    /predates/,
  );
  await run("ReturnRental", { rentalId: "RENTAL-01", damagedAssetIds: [] });
  await assert.rejects(
    run("ReturnRental", { rentalId: "RENTAL-01", damagedAssetIds: [] }),
    /already been returned/,
  );
});
test("history paginates without losing or duplicating records", async (t) => {
  const { ledger, run } = await fixture(t);
  for (let i = 1; i <= 55; i++)
    await run(
      "InspectAsset",
      inspection("K-01"),
      "manager",
      randomUUID(),
      new Date(Date.parse(NOW) + i * 1000).toISOString(),
    );
  const first = await ledger.history("K-01");
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  const second = await ledger.history("K-01", first.nextCursor);
  assert.equal(second.items.length, 7);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((item) => item.transactionId))
      .size,
    57,
  );
  await assert.rejects(
    ledger.history("K-01", "history~F-01~wrong"),
    /Invalid history cursor/,
  );
});
test("demo database survives reopening and demo data is explicitly synthetic", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kayak-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "demo.sqlite");
  let ledger = new DemoLedger(path);
  await ledger.seed(new Date(NOW));
  const initial = await ledger.snapshot();
  await ledger.close();
  ledger = new DemoLedger(path);
  await ledger.seed(new Date(later(1)));
  assert.deepEqual(await ledger.snapshot(), initial);
  await ledger.close();
  assert.ok(
    initial.events.every((event) => event.transactionId.startsWith("demo-")),
  );
  assert.equal(initial.assets.length, 32);
  assert.equal(initial.rentals.length, 2);
});
