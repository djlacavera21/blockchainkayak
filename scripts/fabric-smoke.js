"use strict";
const assert = require("node:assert/strict");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { FabricLedger } = require("../server/fabric-ledger");
async function main() {
  if (
    process.env.LEDGER_MODE !== "fabric" ||
    process.env.KAYAK_TEST_NETWORK !== "true"
  )
    throw new Error(
      "This write test requires an isolated test network and KAYAK_TEST_NETWORK=true.",
    );
  const ledger = await FabricLedger.create(process.env, [
    "manager",
    "staff",
    "auditor",
  ]);
  const suffix = randomBytes(4).toString("hex");
  const execute = (
    action,
    payload,
    role = "manager",
    requestId = randomUUID(),
  ) => ledger.execute(action, payload, requestId, role);
  const assets = [
    ["K", "kayak"],
    ["F", "pfd"],
    ["P", "paddle"],
  ].map(([prefix, type]) => ({
    id: `${prefix}-${suffix}`,
    type,
    label: `Smoke ${prefix} ${suffix}`,
  }));
  try {
    for (const asset of assets) {
      await execute("RegisterAsset", asset);
      await execute(
        "InspectAsset",
        {
          assetId: asset.id,
          result: "pass",
          checks: { body: true, fittings: true, clean: true },
          reasonCode: "ROUTINE",
        },
        "staff",
      );
    }
    await execute("SetLaunchStatus", {
      status: "open",
      reasonCode: "STAFF_REVIEW",
      validUntil: new Date(Date.now() + 3600000).toISOString(),
    });
    const rental = {
      id: `RNT-${suffix}`,
      assetIds: assets.map((a) => a.id),
      partySize: 1,
      renterRef: `R-${randomBytes(8).toString("hex").toUpperCase()}`,
      waiverHash: createHash("sha256")
        .update(`SYNTHETIC SMOKE WAIVER ${suffix}`)
        .digest("hex"),
      dueAt: new Date(Date.now() + 3600000).toISOString(),
      briefingConfirmed: true,
      pfdFitConfirmed: true,
    };
    const key = randomUUID();
    const first = await execute("CheckoutRental", rental, "staff", key);
    assert.deepEqual(
      await execute("CheckoutRental", rental, "staff", key),
      first,
    );
    assert.equal((await ledger.rental(rental.id, "auditor")).status, "active");
    await assert.rejects(
      execute(
        "SetAssetStatus",
        { assetId: assets[0].id, status: "retired", reasonCode: "OTHER" },
        "auditor",
      ),
    );
    await execute(
      "ReturnRental",
      { rentalId: rental.id, damagedAssetIds: [] },
      "staff",
    );
    for (const asset of assets)
      await execute(
        "InspectAsset",
        {
          assetId: asset.id,
          result: "pass",
          checks: { body: true, fittings: true, clean: true },
          reasonCode: "ROUTINE",
        },
        "staff",
      );
    const races = await Promise.allSettled(
      ["A", "B"].map((letter) =>
        execute(
          "CheckoutRental",
          { ...rental, id: `RACE-${letter}-${suffix}` },
          "staff",
        ),
      ),
    );
    assert.equal(
      races.filter((result) => result.status === "fulfilled").length,
      1,
      "Exactly one competing equipment checkout may commit",
    );
    const winner = races.find((result) => result.status === "fulfilled").value
      .result.id;
    await execute(
      "ReturnRental",
      { rentalId: winner, damagedAssetIds: [assets[0].id] },
      "staff",
    );
    const snapshot = await ledger.snapshot("auditor");
    assert.equal(
      snapshot.assets.find((a) => a.id === assets[0].id).status,
      "maintenance",
    );
    assert.equal(
      snapshot.assets.find((a) => a.id === assets[1].id).status,
      "inspection_due",
    );
    assert.ok(
      (await ledger.history(assets[0].id, "", "auditor")).items.length >= 4,
    );
    console.log(
      "Fabric smoke passed: register → inspect → launch review → checkout → replay → role rejection → return → competing checkouts → damaged return → history.",
    );
  } finally {
    await ledger.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
