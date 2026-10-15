# Operating notes

## What v0.1 establishes

This project can demonstrate the equipment handoff workflow and can connect to an independently configured Fabric network. It does not establish the employer's authorization to run the system, certify equipment, replace staff judgment, or prove that an outdoor launch is safe. All sample equipment, reviews and waiver evidence are synthetic.

The manager launch review is a recorded human decision. There are no live weather, USGS, Lake Erie conditions, air quality, closure, or incident feeds. Missing or expired reviews block checkout. Returns continue when departures are held. Equipment inspections are operational attestations, not automated measurements.

## Identities and data

The first release uses separate manager/staff/auditor access keys and separate Fabric role certificates. Each credential is a shared role service identity. For individual employee accountability, introduce individual authentication, role assignment, certificate issuance or delegated signing, session revocation, and offboarding. Do not claim that a hashed role identity proves which employee operated a shared terminal.

The local demo binds to loopback by default and generates a temporary key. For any remote access, configure explicit role keys, terminate HTTPS at an internal reverse proxy, set `PUBLIC_ORIGIN` to the exact HTTPS origin, and limit network access to authorized staff. The origin check assumes that the reverse proxy preserves the configured site origin. The application does not trust forwarded identity headers.

The browser removes token URL fragments and stores access only for the tab session. Lock clears that session's key. Rate limiting is basic, per socket address and process; it is not a substitute for managed identity or edge controls. A reverse proxy may cause multiple clients to share that address. This release does not implement individual session revocation or automated certificate rotation.

Keep customer identities, signed waivers, emergency contacts and incident narratives in an authorized private records system with its own retention policy. Store only random opaque references and document digests here. Even hashes and opaque references are pseudonymous records, not a guarantee of anonymity. All participating channel organizations can retain shared ledger records. Plan that retention before using real evidence.

## Network and recovery

Production infrastructure needs approved organization membership, independent peer/orderer administration, certificate issuance and revocation, TLS, endorsement policy, monitoring, backups and a restore rehearsal. The included Fabric test network is not that infrastructure. If there is only one operator and no independent parties sharing custody evidence, a conventional database may be simpler; Fabric is useful when multiple authorized organizations need a shared, endorsed record.

SQLite mode is explicitly a development demonstration, with a serial transaction queue and durable local file. It provides no distributed endorsement or consensus. Fabric mode never substitutes a demo after a failure. A missing network, identity or certificate attribute causes startup to fail.

On an uncertain transaction result, refresh and retry with its original request key and unchanged payload. Do not issue a new key just because a client timed out. Online checkout is required; this version has no offline mutation queue, and staff should use an approved fallback process when the system is unavailable. The browser's pending submission is kept only in the open dialog, so external operational clients should durably store unresolved request references.

## Suggested next implementation increments

1. Confirm actual fleet IDs, inspection checks, staffing roles and rental policies with the operator.
2. Connect an approved waiver/customer-record system without moving personal details onto the shared channel.
3. Add individual staff authentication and credential lifecycle management.
4. Run the supplied real-network smoke test, rehearse concurrent checkouts, network outages and restore, and approve a pilot topology.
5. Add reservations, payments and environmental data only when their providers, permissions and operational rules are specified.

No business accounts, payment providers or live infrastructure are changed by this source implementation.
