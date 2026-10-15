# Fabric development network

These commands target the **official Fabric Docker test network** with Org1, Org2, and a Raft orderer. That sample topology is for development, as the [Fabric documentation](https://hyperledger-fabric.readthedocs.io/en/latest/test_network.html) explains. It is not a production network design.

## 1. Install prerequisites and official tools

Use Linux/macOS with Docker Engine or Docker Desktop, Docker Compose, Git, Bash, curl, and Node 22.13+ (24 recommended). Follow the current [official installation guide](https://hyperledger-fabric.readthedocs.io/en/latest/install.html). A Fabric 2.5 development line works with the Gateway integration; the documented baseline below is 2.5.16 with CA 1.5.17.

In a directory outside this repository:

```bash
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
# Inspect the downloaded script before running it.
chmod +x install-fabric.sh
./install-fabric.sh --fabric-version 2.5.16 --ca-version 1.5.17 docker binary samples
```

Confirm `fabric-samples/bin/peer`, `fabric-samples/bin/fabric-ca-client`, and `fabric-samples/test-network/network.sh` exist. If your installation lacks CA client binaries, install the matching CA client using the official [Fabric CA documentation](https://hyperledger-fabric-ca.readthedocs.io/en/latest/users-guide.html).

## 2. Deploy the contract

From the blockchainkayak repository:

```bash
npm ci
npm --prefix chaincode ci
export FABRIC_SAMPLES_PATH=/absolute/path/to/fabric-samples
npm run fabric:up
npm run fabric:deploy
```

The scripts use `kayakchannel`, chaincode `blockchainkayak`, contract `KayakContract`, and the sample network's default multi-organization endorsement policy. No real inventory or sample inventory is automatically inserted into Fabric.

For a later contract upgrade, supply a new version and sequence, after reviewing the change:

```bash
CHAINCODE_VERSION=0.1.1 CHAINCODE_SEQUENCE=2 npm run fabric:deploy
```

The contract is self-contained in `chaincode/`, including its own lockfile. It does not depend on the API server's directory being present in the chaincode container.

## 3. Enroll role identities

```bash
npm run fabric:enroll
```

This script uses **only the local test-network Org1 CA** at `https://localhost:7054`, and its built-in development administrator. It registers/enrolls three client identities with certificate attributes:

| Identity | `kayak.role` | Capability |
| --- | --- | --- |
| `kayak-manager` | `manager` | All stand operations |
| `kayak-staff` | `staff` | Inspect, check out, return, read |
| `kayak-auditor` | `auditor` | Read only |

It generates random enrollment secrets and API access tokens. Local certificates and keys go under ignored `credentials/`; connections go in ignored `fabric-identities.json` and `.env.fabric-test`. Files written by the script use private permissions. Do not commit these files.

The contract trusts only the operator MSP ID in `chaincode/policy.json`, initially `Org1MSP`. For another operator MSP, change that packaged policy and deploy it through the network's approval process. An API environment variable alone cannot alter chaincode authorization. A certificate without the correct organization **and** role attribute is rejected, even on read calls.

## 4. Start the actual Fabric application

```bash
npm run fabric:start
```

Open `http://127.0.0.1:3000`. Enter the relevant `API_MANAGER_TOKEN`, `API_STAFF_TOKEN`, or `API_AUDITOR_TOKEN` from your local `.env.fabric-test` file. Do not paste a CA secret or private key into the UI.

The banner must say **HYPERLEDGER FABRIC**. Start with Add equipment, perform inspections, record a launch review, and then check out a rental. Provide the SHA-256 digest of the real signed waiver from your approved off-ledger records if running an authorized pilot. For a development test, use only synthetic evidence and references.

## 5. Verify the network

Stop the HTTP server if desired; the smoke test connects directly to Gateway:

```bash
npm run test:fabric
```

This test writes uniquely named synthetic equipment and rental records. It verifies role restrictions, a committed checkout and replay, competing checkouts for the same equipment, returns, and history reads. It requires `KAYAK_TEST_NETWORK=true` in addition to Fabric mode so it cannot casually be pointed at an operating stand. It leaves its synthetic records behind as an audit trail.

## Custom Gateway connection

Use `.env.example` as a starting point and `LEDGER_MODE=fabric`. Configure at least one unique role token. For every configured API role, provide its matching certificate and key:

```json
{
  "manager": {
    "certPath": "/absolute/path/to/manager-cert.pem",
    "keyPath": "/absolute/path/to/manager-key.pem"
  },
  "staff": {
    "certPath": "/absolute/path/to/staff-cert.pem",
    "keyPath": "/absolute/path/to/staff-key.pem"
  },
  "auditor": {
    "certPath": "/absolute/path/to/auditor-cert.pem",
    "keyPath": "/absolute/path/to/auditor-key.pem"
  }
}
```

Relative paths resolve against the identities JSON file. The TLS root certificate authenticates the peer. The optional peer host alias is for a test-network endpoint exposed on localhost; use the correct DNS name and valid certificate for your own deployment. Gateway configuration errors stop startup. No automatic writes are made at startup in Fabric mode.

## Reset / troubleshoot

`npm run fabric:down` is destructive **to the sample network** and removes its test ledger. After a reset, remove this project's ignored `credentials/`, `fabric-identities.json`, and `.env.fabric-test` before enrolling again, because the CA database has also been reset. Never use the network reset command for business data.

If startup rejects an identity, check both `Org1MSP` and the enrolled `kayak.role` certificate attribute. An Org1 admin certificate by itself is not a stand manager identity. If a transaction conflicts, refresh availability and retry with the original idempotency key. If the submit/commit result is uncertain, preserve the original payload and key: a fresh key could duplicate a successful request.
