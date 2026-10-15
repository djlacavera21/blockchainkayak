"use strict";
const { randomBytes } = require("node:crypto");
const { DemoLedger } = require("./demo-ledger");
const { createApp } = require("./app");

async function main() {
  const mode = process.argv.includes("--demo")
    ? "demo"
    : process.env.LEDGER_MODE || "demo";
  if (!["demo", "fabric"].includes(mode))
    throw new Error("LEDGER_MODE must be demo or fabric");
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  const tokens = {};
  for (const role of ["manager", "staff", "auditor"]) {
    const token = process.env[`API_${role.toUpperCase()}_TOKEN`];
    if (token) {
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
        throw new Error(
          `${role} token must contain 32–256 letters, digits, dashes or underscores`,
        );
      tokens[role] = token;
    }
  }
  const localDemo =
    mode === "demo" && ["127.0.0.1", "localhost", "::1"].includes(host);
  const generated = localDemo && Object.keys(tokens).length === 0;
  if (generated) tokens.manager = randomBytes(32).toString("hex");
  if (!Object.keys(tokens).length)
    throw new Error("Configure at least one API role token");
  if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length)
    throw new Error("Role tokens must be unique");
  let ledger;
  if (mode === "demo") {
    ledger = new DemoLedger(process.env.DEMO_DB_PATH || "./data/demo.sqlite");
    await ledger.seed();
  } else {
    const { FabricLedger } = require("./fabric-ledger");
    ledger = await FabricLedger.create(process.env, Object.keys(tokens));
  }
  const app = createApp({
    ledger,
    tokens,
    publicOrigin: process.env.PUBLIC_ORIGIN,
  });
  await new Promise((resolve, reject) => {
    app.once("error", reject);
    app.listen(port, host, resolve);
  });
  const displayHost = host.includes(":") ? `[${host}]` : host;
  console.log(
    `\nChagrin River | ${mode === "demo" ? "LOCAL DEMO — synthetic equipment and waivers; SQLite, no blockchain consensus" : "HYPERLEDGER FABRIC — connected"}\n`,
  );
  console.log(
    `Open http://${displayHost}:${port}/${generated ? `#token=${tokens.manager}` : ""}`,
  );
  if (generated)
    console.log(
      "The fragment contains your temporary local manager key. It is removed from the address bar after login.",
    );
  async function shutdown() {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    await ledger.close();
    process.exit(0);
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
main().catch((error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exit(1);
});
