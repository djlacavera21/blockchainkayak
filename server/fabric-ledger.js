"use strict";
const { readFile } = require("node:fs/promises");
const { resolve, dirname } = require("node:path");
const { createPrivateKey } = require("node:crypto");
const grpc = require("@grpc/grpc-js");
const { connect, hash, signers } = require("@hyperledger/fabric-gateway");

class FabricLedger {
  constructor(client, gateways, contracts) {
    this.mode = "fabric";
    this.client = client;
    this.gateways = gateways;
    this.contracts = contracts;
  }
  contract(role) {
    if (!this.contracts[role])
      throw new Error("FORBIDDEN: No certificate configured for this role");
    return this.contracts[role];
  }
  async execute(action, payload, requestId, role) {
    const bytes = await this.contract(role).submitTransaction(
      "Execute",
      action,
      JSON.stringify(payload),
      requestId,
    );
    return JSON.parse(Buffer.from(bytes).toString());
  }
  async snapshot(role) {
    return JSON.parse(
      Buffer.from(
        await this.contract(role).evaluateTransaction("GetSnapshot"),
      ).toString(),
    );
  }
  async history(id, cursor = "", role) {
    return JSON.parse(
      Buffer.from(
        await this.contract(role).evaluateTransaction(
          "GetAssetHistory",
          id,
          cursor,
        ),
      ).toString(),
    );
  }
  async rental(id, role) {
    return JSON.parse(
      Buffer.from(
        await this.contract(role).evaluateTransaction("GetRental", id),
      ).toString(),
    );
  }
  async close() {
    for (const gateway of Object.values(this.gateways)) gateway.close();
    this.client.close();
  }
  static async create(env, roles) {
    for (const field of ["FABRIC_TLS_CERT_PATH", "FABRIC_IDENTITIES_PATH"])
      if (!env[field])
        throw new Error(
          `Fabric mode requires ${field}; demo fallback is disabled`,
        );
    const tlsRootCert = await readFile(env.FABRIC_TLS_CERT_PATH);
    const identitiesPath = resolve(env.FABRIC_IDENTITIES_PATH);
    const identities = JSON.parse(await readFile(identitiesPath, "utf8"));
    const options = env.FABRIC_PEER_HOST_ALIAS
      ? { "grpc.ssl_target_name_override": env.FABRIC_PEER_HOST_ALIAS }
      : {};
    const client = new grpc.Client(
      env.FABRIC_PEER_ENDPOINT || "localhost:7051",
      grpc.credentials.createSsl(tlsRootCert),
      options,
    );
    const gateways = {},
      contracts = {};
    try {
      for (const role of roles) {
        const config = identities[role];
        if (!config?.certPath || !config?.keyPath)
          throw new Error(`Missing ${role} certificate/key configuration`);
        const credentials = await readFile(
          resolve(dirname(identitiesPath), config.certPath),
        );
        const signer = signers.newPrivateKeySigner(
          createPrivateKey(
            await readFile(resolve(dirname(identitiesPath), config.keyPath)),
          ),
        );
        gateways[role] = connect({
          client,
          identity: { mspId: env.FABRIC_MSP_ID || "Org1MSP", credentials },
          signer,
          hash: hash.sha256,
          evaluateOptions: () => ({ deadline: Date.now() + 10000 }),
          endorseOptions: () => ({ deadline: Date.now() + 15000 }),
          submitOptions: () => ({ deadline: Date.now() + 15000 }),
          commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
        });
        contracts[role] = gateways[role]
          .getNetwork(env.FABRIC_CHANNEL || "kayakchannel")
          .getContract(
            env.FABRIC_CHAINCODE || "blockchainkayak",
            "KayakContract",
          );
      }
      const ledger = new FabricLedger(client, gateways, contracts);
      // Verify reachability, channel, chaincode, and certificate permissions now.
      for (const role of roles) {
        const caller = JSON.parse(
          Buffer.from(
            await ledger.contract(role).evaluateTransaction("GetIdentity"),
          ).toString(),
        );
        if (caller.role !== role)
          throw new Error(
            `The configured ${role} certificate has a different kayak.role attribute`,
          );
        await ledger.snapshot(role);
      }
      return ledger;
    } catch (error) {
      for (const gateway of Object.values(gateways)) gateway.close();
      client.close();
      throw error;
    }
  }
}
module.exports = { FabricLedger };
