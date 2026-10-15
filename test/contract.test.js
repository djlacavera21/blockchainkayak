"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const KayakContract = require("../chaincode/lib/kayak-contract");
const { NOW } = require("./helpers");
function mockContext({
  role = "manager",
  msp = "Org1MSP",
  timestamp = NOW,
  txId = "a".repeat(64),
} = {}) {
  const state = new Map(),
    events = [];
  let closed = 0;
  const ctx = {
    clientIdentity: {
      getMSPID: () => msp,
      getAttributeValue: (name) => (name === "kayak.role" ? role : null),
      getID: () => `x509::test-${role}`,
    },
    stub: {
      getState: async (key) =>
        state.has(key) ? Buffer.from(state.get(key)) : Buffer.alloc(0),
      putState: async (key, value) => state.set(key, value.toString()),
      deleteState: async (key) => state.delete(key),
      getTxID: () => txId,
      getTxTimestamp: () => ({
        seconds: {
          toString: () => String(Math.floor(Date.parse(timestamp) / 1000)),
        },
        nanos: (Date.parse(timestamp) % 1000) * 1000000,
      }),
      setEvent: (name, payload) =>
        events.push({ name, payload: payload.toString() }),
      getStateByRange: async (start, end) => {
        const values = [...state]
          .filter(([key]) => key >= start && key < end)
          .sort(([a], [b]) => (a < b ? -1 : 1));
        let position = 0;
        return {
          next: async () =>
            position < values.length
              ? {
                  value: {
                    key: values[position][0],
                    value: Buffer.from(values[position++][1]),
                  },
                  done: false,
                }
              : { done: true },
          close: async () => {
            closed++;
          },
        };
      },
    },
  };
  return { ctx, state, events, closed: () => closed };
}
test("contract produces deterministic bytes using proposal time and emits a receipt event", async () => {
  const first = mockContext(),
    second = mockContext();
  const contract = new KayakContract();
  const payload = JSON.stringify({
    id: "K-01",
    type: "kayak",
    label: "River Birch",
  });
  const receipt = await contract.Execute(
    first.ctx,
    "RegisterAsset",
    payload,
    "request-01",
  );
  assert.equal(
    await contract.Execute(second.ctx, "RegisterAsset", payload, "request-01"),
    receipt,
  );
  assert.deepEqual([...first.state], [...second.state]);
  assert.equal(JSON.parse(receipt).timestamp, NOW);
  assert.equal(first.events[0].name, "KayakOperation");
  assert.equal(
    JSON.parse(await contract.GetSnapshot(first.ctx)).assets.length,
    1,
  );
  assert.ok(first.closed() > 0);
  assert.equal(
    JSON.parse(await contract.GetIdentity(first.ctx)).role,
    "manager",
  );
});
test("contract enforces operator MSP and certificate role on queries and writes", async () => {
  const contract = new KayakContract();
  for (const options of [
    { msp: "OtherMSP" },
    { role: null },
    { role: "admin" },
  ]) {
    const { ctx } = mockContext(options);
    await assert.rejects(contract.GetSnapshot(ctx), /FORBIDDEN/);
    await assert.rejects(
      contract.Execute(ctx, "SetLaunchStatus", "{}", "request-01"),
      /FORBIDDEN/,
    );
  }
  await assert.rejects(
    contract.Execute(
      mockContext({ role: "auditor" }).ctx,
      "RegisterAsset",
      "{}",
      "request-01",
    ),
    /FORBIDDEN/,
  );
  await assert.rejects(
    contract.Execute(mockContext().ctx, "RegisterAsset", "{", "request-01"),
    /Invalid JSON/,
  );
});
test("Fabric range pagination closes iterators and skips the inclusive cursor", async () => {
  const mock = mockContext();
  mock.state.set("asset~01", '{"id":"01"}');
  mock.state.set("asset~02", '{"id":"02"}');
  mock.state.set("asset~03", '{"id":"03"}');
  const store = new KayakContract.FabricStore(mock.ctx.stub);
  const first = await store.list("asset~", 2);
  assert.deepEqual(
    first.items.map((a) => a.id),
    ["01", "02"],
  );
  const second = await store.list("asset~", 2, first.nextCursor);
  assert.deepEqual(
    second.items.map((a) => a.id),
    ["03"],
  );
  assert.equal(second.nextCursor, null);
  assert.equal(mock.closed(), 2);
});
module.exports = { mockContext };
test("Fabric runtime metadata accepts the Gateway argument list including a history cursor", () => {
  const Bootstrap = require("../chaincode/node_modules/fabric-shim/lib/contract-spi/bootstrap");
  const ChaincodeFromContract = require("../chaincode/node_modules/fabric-shim/lib/contract-spi/chaincodefromcontract");
  const info = Bootstrap.getInfoFromContract(
    require("node:path").resolve(__dirname, "../chaincode"),
  );
  const runtime = new ChaincodeFromContract(
    [...info.contracts],
    info.serializers,
    {},
    info.title,
    info.version,
  );
  const descriptors = runtime.metadata.contracts.KayakContract.transactions;
  assert.equal(
    descriptors.find((item) => item.name === "Execute").parameters.length,
    3,
  );
  assert.equal(
    descriptors.find((item) => item.name === "GetAssetHistory").parameters
      .length,
    2,
  );
  assert.equal(
    descriptors.find((item) => item.name === "GetRental").parameters.length,
    1,
  );
});
