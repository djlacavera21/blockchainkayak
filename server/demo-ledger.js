"use strict";
const { DatabaseSync } = require("node:sqlite");
const { mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { randomUUID } = require("node:crypto");
const domain = require("../chaincode/lib/domain");

class SqliteStore {
  constructor(db) {
    this.db = db;
  }
  async get(key) {
    const row = this.db
      .prepare("SELECT value FROM state WHERE key = ?")
      .get(key);
    return row ? JSON.parse(row.value) : null;
  }
  async put(key, value) {
    this.db
      .prepare(
        "INSERT INTO state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, domain.canonical(value));
  }
  async delete(key) {
    this.db.prepare("DELETE FROM state WHERE key = ?").run(key);
  }
  async list(prefix, limit, cursor = "") {
    const rows = this.db
      .prepare(
        "SELECT key,value FROM state WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?",
      )
      .all(prefix, `${prefix}\uffff`, cursor, limit + 1);
    return {
      items: rows.slice(0, limit).map((row) => JSON.parse(row.value)),
      nextCursor: rows.length > limit ? rows[limit - 1].key : null,
    };
  }
}
class DemoLedger {
  constructor(path) {
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    this.store = new SqliteStore(this.db);
    this.queue = Promise.resolve();
    this.mode = "demo";
  }
  serial(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  execute(
    action,
    payload,
    requestId,
    role = "manager",
    timestamp = new Date().toISOString(),
  ) {
    return this.serial(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const receipt = await domain.execute(
          this.store,
          {
            role,
            actor: domain.digest(`local-demo:${role}`),
            txId: `demo-${randomUUID()}`,
            timestamp,
          },
          action,
          payload,
          requestId,
        );
        this.db.exec("COMMIT");
        return receipt;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  snapshot() {
    return this.serial(() => domain.snapshot(this.store));
  }
  history(assetId, cursor) {
    return this.serial(() => domain.history(this.store, assetId, cursor));
  }
  rental(rentalId) {
    return this.serial(() =>
      domain.required(this.store, `rental~${rentalId}`, "Rental"),
    );
  }
  async close() {
    await this.queue;
    this.db.close();
  }
  async seed(now = new Date()) {
    if (await this.store.get("demo~seeded")) return;
    const timestamp = new Date(now.getTime() - 3600000).toISOString();
    const run = (action, payload) =>
      this.execute(action, payload, randomUUID(), "manager", timestamp);
    const vessels = [
      ["K-01", "kayak", "River Birch"],
      ["K-02", "kayak", "Blue Heron"],
      ["K-03", "kayak", "Driftwood"],
      ["K-04", "kayak", "Kingfisher"],
      ["T-01", "tandem", "Two Rivers"],
      ["S-01", "paddleboard", "Stillwater"],
      ["S-02", "paddleboard", "Sandbar"],
      ["S-03", "paddleboard", "Daybreak"],
    ];
    for (let i = 1; i <= 12; i++) {
      vessels.push([`F-${String(i).padStart(2, "0")}`, "pfd", `Demo PFD ${i}`]);
      vessels.push([
        `P-${String(i).padStart(2, "0")}`,
        "paddle",
        `Demo Paddle ${i}`,
      ]);
    }
    for (const [id, type, label] of vessels) {
      // Seed is restartable after an interrupted first launch.
      if (await this.store.get(`asset~${id}`)) continue;
      await run("RegisterAsset", { id, type, label });
      await run("InspectAsset", {
        assetId: id,
        result: "pass",
        checks: { body: true, fittings: true, clean: true },
        reasonCode: "ROUTINE",
      });
    }
    await run("SetLaunchStatus", {
      status: "open",
      reasonCode: "STAFF_REVIEW",
      validUntil: new Date(now.getTime() + 3 * 3600000).toISOString(),
    });
    for (const [id, assetIds, offset] of [
      ["DEMO-1001", ["K-02", "F-01", "P-01"], 45],
      ["DEMO-1002", ["S-01", "F-02", "P-02"], -10],
    ]) {
      if (await this.store.get(`rental~${id}`)) continue;
      await run("CheckoutRental", {
        id,
        assetIds,
        partySize: 1,
        renterRef: `R-${domain.digest(id).slice(0, 16).toUpperCase()}`,
        waiverHash: domain.digest(`SYNTHETIC DEMO WAIVER:${id}`),
        dueAt: new Date(now.getTime() + offset * 60000).toISOString(),
        briefingConfirmed: true,
        pfdFitConfirmed: true,
      });
    }
    await run("SetAssetStatus", {
      assetId: "K-04",
      status: "maintenance",
      reasonCode: "FITTINGS",
    });
    await this.store.put("demo~seeded", true);
  }
}
module.exports = { DemoLedger, SqliteStore };
