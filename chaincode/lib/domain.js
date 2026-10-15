"use strict";

// Shared by the local demonstration and Fabric. Never use wall-clock time,
// randomness, network requests, or floating-point money in this module.
const { createHash } = require("node:crypto");
const TYPES = ["kayak", "tandem", "paddleboard", "pfd", "paddle"];
const REASONS = [
  "ROUTINE",
  "BODY_DAMAGE",
  "FITTINGS",
  "CLEANING",
  "WEATHER",
  "WATER",
  "AIR_QUALITY",
  "STAFF_REVIEW",
  "OTHER",
];
const PERMISSIONS = {
  RegisterAsset: ["manager"],
  InspectAsset: ["manager", "staff"],
  CheckoutRental: ["manager", "staff"],
  ReturnRental: ["manager", "staff"],
  SetLaunchStatus: ["manager"],
  SetAssetStatus: ["manager"],
};
class DomainError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
function fail(code, message) {
  throw new DomainError(code, message);
}
function assert(value, message, code = "VALIDATION") {
  if (!value) fail(code, message);
}
function object(value, keys) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected an object",
  );
  assert(
    Object.keys(value).every((key) => keys.includes(key)),
    "Unexpected field in request",
  );
}
function id(value, label = "ID") {
  assert(
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(value),
    `${label} must be 2–64 letters, digits, dashes or underscores`,
  );
  return value;
}
function choice(value, values, label) {
  assert(values.includes(value), `Invalid ${label}`);
  return value;
}
function integer(value, min, max, label) {
  assert(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `Invalid ${label}`,
  );
  return value;
}
function iso(value) {
  assert(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "Use a UTC ISO timestamp with milliseconds",
  );
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
const reverseTime = (timestamp) =>
  String(9999999999999 - Date.parse(timestamp)).padStart(13, "0");
async function required(store, key, label) {
  const value = await store.get(key);
  assert(value, `${label} does not exist`, "NOT_FOUND");
  return value;
}
async function saveAsset(store, ctx, asset, action) {
  assert(
    !asset.updatedAt || ctx.timestamp >= asset.updatedAt,
    "Operation predates the equipment record",
    "CONFLICT",
  );
  asset.updatedAt = ctx.timestamp;
  await store.put(`asset~${asset.id}`, asset);
  await store.put(
    `history~${asset.id}~${reverseTime(ctx.timestamp)}~${ctx.txId}`,
    {
      transactionId: ctx.txId,
      timestamp: ctx.timestamp,
      action,
      actor: ctx.actor,
      asset,
    },
  );
}
async function RegisterAsset(store, ctx, p) {
  object(p, ["id", "type", "label"]);
  id(p.id, "Asset ID");
  choice(p.type, TYPES, "equipment type");
  assert(
    typeof p.label === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9 .()_-]{1,63}$/.test(p.label),
    "Use a 2–64 character equipment label",
  );
  assert(
    !(await store.get(`asset~${p.id}`)),
    "Asset ID already exists",
    "CONFLICT",
  );
  const fleet = await store.list("asset~", 1000);
  assert(fleet.items.length < 1000, "Fleet limit reached", "CONFLICT");
  const asset = {
    id: p.id,
    type: p.type,
    label: p.label,
    capacity: p.type === "tandem" ? 2 : 1,
    status: "inspection_due",
    rentalId: null,
    lastInspection: null,
    createdAt: ctx.timestamp,
  };
  await saveAsset(store, ctx, asset, "RegisterAsset");
  return asset;
}
async function InspectAsset(store, ctx, p) {
  object(p, ["assetId", "result", "checks", "reasonCode"]);
  id(p.assetId);
  choice(p.result, ["pass", "fail"], "inspection result");
  choice(p.reasonCode, REASONS, "reason code");
  object(p.checks, ["body", "fittings", "clean"]);
  assert(
    ["body", "fittings", "clean"].every(
      (key) => typeof p.checks[key] === "boolean",
    ),
    "Complete all inspection checks",
  );
  assert(
    p.result !== "pass" || Object.values(p.checks).every(Boolean),
    "All checks must pass before release",
  );
  assert(
    p.result !== "fail" || Object.values(p.checks).some((value) => !value),
    "Mark the failed inspection check",
  );
  const asset = await required(store, `asset~${p.assetId}`, "Asset");
  assert(
    !["in_use", "retired"].includes(asset.status),
    "This asset cannot be inspected now",
    "CONFLICT",
  );
  assert(
    !(
      asset.status === "maintenance" &&
      p.result === "pass" &&
      ctx.role !== "manager"
    ),
    "A manager must release equipment from maintenance",
    "FORBIDDEN",
  );
  asset.lastInspection = {
    result: p.result,
    checks: p.checks,
    reasonCode: p.reasonCode,
    inspectedAt: ctx.timestamp,
    actor: ctx.actor,
  };
  asset.status = p.result === "pass" ? "available" : "maintenance";
  await saveAsset(store, ctx, asset, "InspectAsset");
  return asset;
}
async function SetAssetStatus(store, ctx, p) {
  object(p, ["assetId", "status", "reasonCode"]);
  id(p.assetId);
  choice(p.status, ["maintenance", "retired"], "status");
  choice(p.reasonCode, REASONS, "reason code");
  const asset = await required(store, `asset~${p.assetId}`, "Asset");
  assert(
    !["in_use", "retired"].includes(asset.status),
    "Cannot change an active rental or retired asset",
    "CONFLICT",
  );
  asset.status = p.status;
  asset.reasonCode = p.reasonCode;
  await saveAsset(store, ctx, asset, "SetAssetStatus");
  return asset;
}
async function SetLaunchStatus(store, ctx, p) {
  object(p, ["status", "reasonCode", "validUntil"]);
  choice(p.status, ["open", "hold", "closed"], "launch status");
  choice(p.reasonCode, REASONS, "reason code");
  iso(p.validUntil);
  const duration = Date.parse(p.validUntil) - Date.parse(ctx.timestamp);
  assert(
    duration > 0 && duration <= 12 * 3600000,
    "Launch review must expire within 12 hours",
  );
  const previous = await store.get("launch~current");
  assert(
    !previous || ctx.timestamp >= previous.reviewedAt,
    "Review predates the current launch decision",
    "CONFLICT",
  );
  const value = { ...p, reviewedAt: ctx.timestamp, actor: ctx.actor };
  await store.put("launch~current", value);
  return value;
}
async function CheckoutRental(store, ctx, p) {
  object(p, [
    "id",
    "assetIds",
    "partySize",
    "renterRef",
    "waiverHash",
    "dueAt",
    "briefingConfirmed",
    "pfdFitConfirmed",
  ]);
  id(p.id, "Rental ID");
  integer(p.partySize, 1, 20, "party size");
  iso(p.dueAt);
  assert(
    typeof p.renterRef === "string" && /^R-[A-F0-9]{16,64}$/.test(p.renterRef),
    "Use a random renter reference, not personal details",
  );
  assert(
    typeof p.waiverHash === "string" && /^[a-f0-9]{64}$/.test(p.waiverHash),
    "Provide a SHA-256 waiver digest",
  );
  assert(
    p.briefingConfirmed === true && p.pfdFitConfirmed === true,
    "Confirm the briefing and fitted PFDs",
  );
  assert(
    Array.isArray(p.assetIds) &&
      p.assetIds.length > 0 &&
      p.assetIds.length <= 64 &&
      new Set(p.assetIds).size === p.assetIds.length,
    "Choose unique equipment IDs",
  );
  p.assetIds.forEach((value) => id(value));
  const duration = Date.parse(p.dueAt) - Date.parse(ctx.timestamp);
  assert(
    duration > 0 && duration <= 24 * 3600000,
    "Return time must be within the next 24 hours",
  );
  assert(
    !(await store.get(`rental~${p.id}`)),
    "Rental ID already exists",
    "CONFLICT",
  );
  const launch = await required(store, "launch~current", "Launch review");
  assert(
    launch.status === "open" &&
      launch.reviewedAt <= ctx.timestamp &&
      launch.validUntil > ctx.timestamp,
    "Launch is closed, held, or needs a fresh review",
    "CONFLICT",
  );
  const assets = [];
  for (const assetId of [...p.assetIds].sort()) {
    const asset = await required(store, `asset~${assetId}`, "Asset");
    assert(
      asset.status === "available",
      `${assetId} is not available`,
      "CONFLICT",
    );
    // A pass is valid for at most one day; every return still requires a new inspection.
    const inspectionAge =
      Date.parse(ctx.timestamp) - Date.parse(asset.lastInspection?.inspectedAt);
    assert(
      asset.lastInspection?.result === "pass" &&
        inspectionAge >= 0 &&
        inspectionAge <= 24 * 3600000,
      `${assetId} needs a fresh inspection`,
      "CONFLICT",
    );
    assets.push(asset);
  }
  assert(
    assets
      .filter((a) => ["kayak", "tandem", "paddleboard"].includes(a.type))
      .reduce((n, a) => n + a.capacity, 0) >= p.partySize,
    "Select enough vessel seats",
  );
  assert(
    assets.filter((a) => a.type === "pfd").length >= p.partySize,
    "Assign one fitted PFD per paddler",
  );
  assert(
    assets.filter((a) => a.type === "paddle").length >= p.partySize,
    "Assign one paddle per paddler",
  );
  const rental = {
    ...p,
    assetIds: assets.map((a) => a.id),
    status: "active",
    checkedOutAt: ctx.timestamp,
    checkedOutBy: ctx.actor,
  };
  for (const asset of assets) {
    asset.status = "in_use";
    asset.rentalId = p.id;
    await saveAsset(store, ctx, asset, "CheckoutRental");
  }
  await store.put(`rental~${p.id}`, rental);
  await store.put(`active~${p.id}`, rental);
  return rental;
}
async function ReturnRental(store, ctx, p) {
  object(p, ["rentalId", "damagedAssetIds"]);
  id(p.rentalId);
  const rental = await required(store, `rental~${p.rentalId}`, "Rental");
  assert(
    rental.status === "active",
    "Rental has already been returned",
    "CONFLICT",
  );
  assert(
    ctx.timestamp >= rental.checkedOutAt,
    "Return predates checkout",
    "CONFLICT",
  );
  assert(
    Array.isArray(p.damagedAssetIds) &&
      new Set(p.damagedAssetIds).size === p.damagedAssetIds.length &&
      p.damagedAssetIds.every((value) => rental.assetIds.includes(value)),
    "Choose damaged equipment from this rental",
  );
  for (const assetId of rental.assetIds) {
    const asset = await required(store, `asset~${assetId}`, "Asset");
    assert(
      asset.status === "in_use" && asset.rentalId === rental.id,
      "Equipment custody mismatch",
      "CONFLICT",
    );
    asset.status = p.damagedAssetIds.includes(assetId)
      ? "maintenance"
      : "inspection_due";
    asset.rentalId = null;
    await saveAsset(store, ctx, asset, "ReturnRental");
  }
  rental.status = "returned";
  rental.returnedAt = ctx.timestamp;
  rental.returnedBy = ctx.actor;
  rental.damagedAssetIds = [...p.damagedAssetIds].sort();
  await store.put(`rental~${rental.id}`, rental);
  await store.delete(`active~${rental.id}`);
  return rental;
}
const handlers = {
  RegisterAsset,
  InspectAsset,
  SetAssetStatus,
  SetLaunchStatus,
  CheckoutRental,
  ReturnRental,
};
async function execute(store, ctx, action, payload, requestId) {
  assert(Object.hasOwn(PERMISSIONS, action), "Unknown action");
  assert(
    PERMISSIONS[action].includes(ctx.role),
    "Role cannot perform this action",
    "FORBIDDEN",
  );
  id(requestId, "Idempotency key");
  iso(ctx.timestamp);
  const fingerprint = digest(canonical({ action, payload, actor: ctx.actor }));
  const previous = await store.get(`request~${requestId}`);
  if (previous) {
    assert(
      previous.fingerprint === fingerprint,
      "Idempotency key was used for a different request",
      "CONFLICT",
    );
    return previous.receipt;
  }
  const result = await handlers[action](store, ctx, payload);
  const receipt = {
    transactionId: ctx.txId,
    timestamp: ctx.timestamp,
    action,
    result,
  };
  const assetIds = result.assetIds || (result.type ? [result.id] : []);
  const event = {
    transactionId: ctx.txId,
    timestamp: ctx.timestamp,
    action,
    actor: ctx.actor,
    role: ctx.role,
    subjectId: result.id || "launch",
    assetIds,
  };
  await store.put(`event~${reverseTime(ctx.timestamp)}~${ctx.txId}`, event);
  await store.put(`request~${requestId}`, { fingerprint, receipt });
  return receipt;
}
async function snapshot(store) {
  const assets = await store.list("asset~", 1000);
  const rentals = await store.list("active~", 500);
  assert(
    !assets.nextCursor && !rentals.nextCursor,
    "Snapshot capacity exceeded; use a paginated service",
    "CAPACITY",
  );
  return {
    assets: assets.items,
    rentals: rentals.items,
    launch: await store.get("launch~current"),
    events: (await store.list("event~", 50)).items,
  };
}
async function history(store, assetId, cursor = "") {
  id(assetId);
  await required(store, `asset~${assetId}`, "Asset");
  const prefix = `history~${assetId}~`;
  assert(
    typeof cursor === "string" &&
      (cursor === "" ||
        (cursor.startsWith(prefix) &&
          /^[A-Za-z0-9_~.:-]+$/.test(cursor) &&
          cursor.length < 200)),
    "Invalid history cursor",
  );
  return store.list(prefix, 50, cursor);
}
module.exports = {
  execute,
  snapshot,
  history,
  required,
  DomainError,
  PERMISSIONS,
  TYPES,
  REASONS,
  canonical,
  digest,
};
