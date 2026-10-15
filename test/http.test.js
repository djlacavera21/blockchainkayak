"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createApp, errorDetails } = require("../server/app");
const { fixture, rental, inspection } = require("./helpers");
const tokens = {
  manager: "m".repeat(32),
  staff: "s".repeat(32),
  auditor: "a".repeat(32),
};
async function service(t) {
  const { ledger } = await fixture(t);
  const app = createApp({
    ledger,
    tokens,
    logger: { error() {} },
    publicOrigin: "https://dock.example.test",
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        app.closeAllConnections();
        app.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${app.address().port}`;
  const request = (path, role = "manager", options = {}) =>
    fetch(url + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${tokens[role] || role}`,
        ...options.headers,
      },
    });
  const post = (
    action,
    payload,
    role = "manager",
    key = randomUUID(),
    headers = {},
  ) =>
    request("/api/transactions", role, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...headers,
      },
      body: JSON.stringify({ action, payload }),
    });
  return { url, request, post, ledger };
}
test("dashboard API is authenticated and never exposes credentials", async (t) => {
  const { request } = await service(t);
  assert.equal((await request("/api/snapshot", "")).status, 401);
  assert.equal((await request("/api/snapshot", "é".repeat(32))).status, 401);
  const response = await request("/api/snapshot", "auditor");
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.meta.role, "auditor");
  assert.equal(snapshot.meta.mode, "demo");
  assert.equal(JSON.stringify(snapshot).includes(tokens.manager), false);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(
    response.headers.get("content-security-policy"),
    /script-src 'self'/,
  );
});
test("HTTP service role restrictions match the contract permissions", async (t) => {
  const { post } = await service(t);
  assert.equal(
    (
      await post(
        "RegisterAsset",
        { id: "NEW-01", type: "kayak", label: "New Kayak" },
        "staff",
      )
    ).status,
    403,
  );
  assert.equal(
    (await post("InspectAsset", inspection("K-01"), "auditor")).status,
    403,
  );
  assert.equal(
    (await post("InspectAsset", inspection("K-01"), "staff")).status,
    200,
  );
  assert.equal((await post("constructor", {})).status, 400);
});
test("API validates JSON, origin, size and required idempotency keys", async (t) => {
  const { request, post } = await service(t);
  const status = await post("RegisterAsset", {}, "manager", randomUUID(), {
    Origin: "https://attacker.example",
  });
  assert.equal(status.status, 403);
  const noKey = await request("/api/transactions", "manager", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "InspectAsset",
      payload: inspection("K-01"),
    }),
  });
  assert.equal(noKey.status, 400);
  const malformed = await request("/api/transactions", "manager", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  const contentType = await request("/api/transactions", "manager", {
    method: "POST",
    body: "{}",
  });
  assert.equal(contentType.status, 400);
  const oversized = await request("/api/transactions", "manager", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ padding: "a".repeat(33000) }),
  });
  assert.equal(oversized.status, 400);
  assert.equal(
    (
      await post("InspectAsset", inspection("K-01"), "staff", randomUUID(), {
        Origin: "https://dock.example.test",
      })
    ).status,
    200,
  );
});
test("HTTP flow covers checkout, receipt replay, return, lookup and history", async (t) => {
  const { post, request, ledger } = await service(t);
  // Align test fixture's fixed proposal times with the current HTTP adapter clock.
  const execute = ledger.execute.bind(ledger);
  ledger.execute = (action, payload, key, role) =>
    execute(action, payload, key, role, "2026-10-15T14:00:00.000Z");
  const key = randomUUID();
  const first = await post("CheckoutRental", rental(), "staff", key);
  assert.equal(first.status, 200);
  const receipt = await first.json();
  assert.deepEqual(
    await (await post("CheckoutRental", rental(), "staff", key)).json(),
    receipt,
  );
  assert.equal(
    (await post("CheckoutRental", rental({ id: "OTHER-01" }), "staff", key))
      .status,
    409,
  );
  assert.equal(
    (
      await post(
        "ReturnRental",
        { rentalId: "RENTAL-01", damagedAssetIds: [] },
        "staff",
      )
    ).status,
    200,
  );
  assert.equal(
    (await (await request("/api/rentals/RENTAL-01", "auditor")).json()).status,
    "returned",
  );
  assert.equal(
    (await (await request("/api/assets/K-01/history", "auditor")).json()).items
      .length,
    4,
  );
  assert.equal((await request("/api/rentals/UNKNOWN", "auditor")).status, 404);
});
test("failed authentication is rate limited and health remains available", async (t) => {
  const { request } = await service(t);
  for (let i = 0; i < 30; i++)
    assert.equal((await request("/api/snapshot", "wrong")).status, 401);
  assert.equal((await request("/api/snapshot", "wrong")).status, 429);
  assert.equal((await request("/api/health", "wrong")).status, 200);
});
test("static file routing cannot read server code or credentials", async (t) => {
  const { request } = await service(t);
  assert.equal((await request("/")).status, 200);
  for (const path of [
    "/server/index.js",
    "/.env",
    "/credentials/manager/msp/keystore/key",
    "/%2e%2e/server/index.js",
  ])
    assert.equal((await request(path)).status, 404);
});
test("Fabric transport errors distinguish business rejection, MVCC conflict and uncertainty", () => {
  assert.equal(
    errorDetails({
      message: "endorsement failed",
      details: [{ message: "CONFLICT: K-01 is not available" }],
    }).status,
    409,
  );
  assert.equal(
    errorDetails({ message: "Transaction failed with code MVCC_READ_CONFLICT" })
      .status,
    409,
  );
  assert.equal(
    errorDetails({ message: "connection refused" }).code,
    "LEDGER_UNAVAILABLE",
  );
});
test("Fabric mode fails closed without identity configuration", () => {
  const env = {
    ...process.env,
    LEDGER_MODE: "fabric",
    API_MANAGER_TOKEN: tokens.manager,
  };
  delete env.FABRIC_TLS_CERT_PATH;
  delete env.FABRIC_IDENTITIES_PATH;
  const result = spawnSync(process.execPath, ["server/index.js"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires FABRIC_TLS_CERT_PATH/);
  assert.doesNotMatch(result.stdout, /LOCAL DEMO/);
});
