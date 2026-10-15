"use strict";
// Only for the official Fabric two-organization development test network.
const {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} = require("node:fs");
const { resolve, join } = require("node:path");
const { randomBytes } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = resolve(__dirname, "..");
if (!process.env.FABRIC_SAMPLES_PATH)
  throw new Error("Set FABRIC_SAMPLES_PATH first. See docs/FABRIC.md.");
const samples = resolve(process.env.FABRIC_SAMPLES_PATH);
const tls = join(
  samples,
  "test-network/organizations/fabric-ca/org1/ca-cert.pem",
);
if (!existsSync(tls))
  throw new Error(
    "Start the test network with certificate authorities first: npm run fabric:up",
  );
const caClient = join(samples, "bin/fabric-ca-client");
const credentialDir = join(root, "credentials");
mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
const secretsPath = join(credentialDir, "test-enrollment.json");
const secrets = existsSync(secretsPath)
  ? JSON.parse(readFileSync(secretsPath))
  : {};
const save = () =>
  writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), { mode: 0o600 });
function ca(args, home) {
  try {
    execFileSync(
      caClient,
      [...args, "--caname", "ca-org1", "--tls.certfiles", tls],
      { env: { ...process.env, FABRIC_CA_CLIENT_HOME: home }, stdio: "pipe" },
    );
  } catch {
    throw new Error(
      "Test CA enrollment failed. Check that the Org1 CA is running and credentials match this test network. No secrets were logged.",
    );
  }
}
const adminHome = join(credentialDir, "ca-admin");
ca(["enroll", "-u", "https://admin:adminpw@localhost:7054"], adminHome);
const identities = {},
  envLines = [
    "LEDGER_MODE=fabric",
    "HOST=127.0.0.1",
    "PORT=3000",
    "KAYAK_TEST_NETWORK=true",
    "FABRIC_MSP_ID=Org1MSP",
    `FABRIC_CHANNEL=${process.env.FABRIC_CHANNEL || "kayakchannel"}`,
    "FABRIC_CHAINCODE=blockchainkayak",
    "FABRIC_PEER_ENDPOINT=localhost:7051",
    "FABRIC_PEER_HOST_ALIAS=peer0.org1.example.com",
    `FABRIC_TLS_CERT_PATH=${JSON.stringify(join(samples, "test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"))}`,
    `FABRIC_IDENTITIES_PATH=${JSON.stringify(join(root, "fabric-identities.json"))}`,
  ];
for (const role of ["manager", "staff", "auditor"]) {
  secrets[role] ||= {
    secret: randomBytes(24).toString("hex"),
    token: randomBytes(32).toString("hex"),
    registered: false,
  };
  save();
  const home = join(credentialDir, role);
  if (!secrets[role].registered) {
    ca(
      [
        "register",
        "--id.name",
        `kayak-${role}`,
        "--id.secret",
        secrets[role].secret,
        "--id.type",
        "client",
        "--id.attrs",
        `kayak.role=${role}:ecert`,
      ],
      adminHome,
    );
    secrets[role].registered = true;
    save();
  }
  ca(
    [
      "enroll",
      "-u",
      `https://kayak-${role}:${secrets[role].secret}@localhost:7054`,
    ],
    home,
  );
  const certDir = join(home, "msp/signcerts"),
    keyDir = join(home, "msp/keystore");
  // CA enroll may retain old keys. Match the public key to the new certificate.
  const {
    X509Certificate,
    createPrivateKey,
    createPublicKey,
  } = require("node:crypto");
  const certPath = join(
    certDir,
    readdirSync(certDir).find((file) => file.endsWith(".pem")),
  );
  const certKey = new X509Certificate(readFileSync(certPath)).publicKey.export({
    type: "spki",
    format: "pem",
  });
  const keyFile = readdirSync(keyDir).find(
    (file) =>
      createPublicKey(
        createPrivateKey(readFileSync(join(keyDir, file))),
      ).export({ type: "spki", format: "pem" }) === certKey,
  );
  if (!keyFile) throw new Error(`Cannot find matching ${role} enrollment key`);
  identities[role] = { certPath, keyPath: join(keyDir, keyFile) };
  envLines.push(`API_${role.toUpperCase()}_TOKEN=${secrets[role].token}`);
}
writeFileSync(
  join(root, "fabric-identities.json"),
  JSON.stringify(identities, null, 2),
  { mode: 0o600 },
);
writeFileSync(join(root, ".env.fabric-test"), envLines.join("\n") + "\n", {
  mode: 0o600,
});
console.log(
  "Enrolled manager, staff, and auditor test identities with kayak.role certificate attributes.",
);
console.log(
  "Local connection settings saved. Start with: npm run fabric:start",
);
console.log(
  "After resetting the test network, remove credentials/ and rerun this enrollment command.",
);
