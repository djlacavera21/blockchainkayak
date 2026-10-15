"use strict";
const { Contract } = require("fabric-contract-api");
const domain = require("./domain");
const policy = require("../policy.json");

class FabricStore {
  constructor(stub) {
    this.stub = stub;
  }
  async get(key) {
    const bytes = await this.stub.getState(key);
    return bytes?.length ? JSON.parse(bytes.toString()) : null;
  }
  async put(key, value) {
    await this.stub.putState(key, Buffer.from(domain.canonical(value)));
  }
  async delete(key) {
    await this.stub.deleteState(key);
  }
  async list(prefix, limit, cursor = "") {
    const iterator = await this.stub.getStateByRange(
      cursor || prefix,
      `${prefix}\uffff`,
    );
    const records = [];
    try {
      while (records.length <= limit) {
        const next = await iterator.next();
        if (next.value?.key && next.value.key > cursor)
          records.push({
            key: next.value.key,
            value: JSON.parse(next.value.value.toString()),
          });
        if (next.done) break;
      }
    } finally {
      await iterator.close();
    }
    return {
      items: records.slice(0, limit).map((r) => r.value),
      nextCursor: records.length > limit ? records[limit - 1].key : null,
    };
  }
}
function identity(ctx) {
  if (ctx.clientIdentity.getMSPID() !== policy.operatorMspId)
    throw new domain.DomainError(
      "FORBIDDEN",
      "Identity is outside the operator organization",
    );
  const role = ctx.clientIdentity.getAttributeValue("kayak.role");
  if (!["manager", "staff", "auditor"].includes(role))
    throw new domain.DomainError(
      "FORBIDDEN",
      "Certificate needs a kayak.role attribute",
    );
  return { role, actor: domain.digest(ctx.clientIdentity.getID()) };
}
class KayakContract extends Contract {
  constructor() {
    super("KayakContract");
  }
  async Execute(ctx, action, payloadJSON, requestId) {
    const caller = identity(ctx);
    let payload;
    try {
      payload = JSON.parse(payloadJSON);
    } catch {
      throw new domain.DomainError("VALIDATION", "Invalid JSON");
    }
    const timestamp = ctx.stub.getTxTimestamp();
    const millis =
      Number(timestamp.seconds.toString()) * 1000 +
      Math.floor(timestamp.nanos / 1000000);
    const receipt = await domain.execute(
      new FabricStore(ctx.stub),
      {
        ...caller,
        txId: ctx.stub.getTxID(),
        timestamp: new Date(millis).toISOString(),
      },
      action,
      payload,
      requestId,
    );
    // A replay has the original receipt and should not emit another business event.
    if (receipt.transactionId === ctx.stub.getTxID())
      ctx.stub.setEvent(
        "KayakOperation",
        Buffer.from(
          domain.canonical({
            transactionId: receipt.transactionId,
            action,
            timestamp: receipt.timestamp,
          }),
        ),
      );
    return domain.canonical(receipt);
  }
  async GetSnapshot(ctx) {
    identity(ctx);
    return domain.canonical(await domain.snapshot(new FabricStore(ctx.stub)));
  }
  async GetIdentity(ctx) {
    const caller = identity(ctx);
    return domain.canonical({
      ...caller,
      mspId: ctx.clientIdentity.getMSPID(),
    });
  }
  // Fabric infers parameters from function.length; keep both arguments explicit.
  async GetAssetHistory(ctx, assetId, cursor) {
    identity(ctx);
    return domain.canonical(
      await domain.history(new FabricStore(ctx.stub), assetId, cursor || ""),
    );
  }
  async GetRental(ctx, rentalId) {
    identity(ctx);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(rentalId))
      throw new domain.DomainError("VALIDATION", "Invalid rental ID");
    return domain.canonical(
      await domain.required(
        new FabricStore(ctx.stub),
        `rental~${rentalId}`,
        "Rental",
      ),
    );
  }
}
module.exports = KayakContract;
module.exports.FabricStore = FabricStore;
