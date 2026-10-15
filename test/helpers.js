"use strict";
const { randomUUID } = require("node:crypto");
const { DemoLedger } = require("../server/demo-ledger");
const NOW = "2026-10-15T14:00:00.000Z";
const later = (hours = 1) =>
  new Date(Date.parse(NOW) + hours * 3600000).toISOString();
const inspection = (assetId) => ({
  assetId,
  result: "pass",
  checks: { body: true, fittings: true, clean: true },
  reasonCode: "ROUTINE",
});
const rental = (overrides = {}) => ({
  id: "RENTAL-01",
  assetIds: ["K-01", "F-01", "P-01"],
  partySize: 1,
  renterRef: "R-0123456789ABCDEF",
  waiverHash: "a".repeat(64),
  dueAt: later(),
  briefingConfirmed: true,
  pfdFitConfirmed: true,
  ...overrides,
});
async function fixture(t) {
  const ledger = new DemoLedger(":memory:");
  t.after(() => ledger.close());
  const run = (
    action,
    payload,
    role = "manager",
    key = randomUUID(),
    timestamp = NOW,
  ) => ledger.execute(action, payload, key, role, timestamp);
  for (const [id, type] of [
    ["K-01", "kayak"],
    ["F-01", "pfd"],
    ["P-01", "paddle"],
  ]) {
    await run("RegisterAsset", { id, type, label: `Equipment ${id}` });
    await run("InspectAsset", inspection(id));
  }
  await run("SetLaunchStatus", {
    status: "open",
    reasonCode: "STAFF_REVIEW",
    validUntil: later(4),
  });
  return { ledger, run };
}
module.exports = { fixture, NOW, later, rental, inspection };
