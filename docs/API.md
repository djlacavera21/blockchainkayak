# API and data model

All staff API calls require `Authorization: Bearer <role-access-key>`. The dashboard and health endpoint do not require a key. Responses are JSON. Role keys stay out of the response and application logs.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Startup readiness and adapter mode; not a continuous peer-health probe |
| GET | `/api/snapshot` | Current fleet, active rentals, launch review, newest 50 events, mode and role |
| GET | `/api/assets/{id}/history?cursor=...` | Newest 50 equipment changes with `nextCursor` for earlier pages |
| GET | `/api/rentals/{id}` | Current or returned rental |
| POST | `/api/transactions` | Execute an authorized business operation |

Every mutation requires an `Idempotency-Key` header: 2–64 letters, digits, dashes or underscores. Use a UUID and retain it with the exact original action and payload. A committed replay returns the original receipt without another business event or equipment history entry. A different payload or identity using that key receives `409 CONFLICT`. There is no automatic retry with a new key after an uncertain network result.

Request bodies are limited to 32 KiB. Unknown request fields are rejected. Time fields use UTC ISO-8601 with milliseconds, for example `2026-10-15T18:00:00.000Z`. Dates in this document are examples, not current launch approvals.

## Operations

| Action | Payload fields | Roles |
| --- | --- | --- |
| `RegisterAsset` | `id`, `type`, `label` | manager |
| `InspectAsset` | `assetId`, `result`, `checks: {body, fittings, clean}`, `reasonCode` | manager, staff |
| `SetAssetStatus` | `assetId`, `status: maintenance\|retired`, `reasonCode` | manager |
| `SetLaunchStatus` | `status: open\|hold\|closed`, `reasonCode`, `validUntil` | manager |
| `CheckoutRental` | `id`, `assetIds`, `partySize`, `renterRef`, `waiverHash`, `dueAt`, `briefingConfirmed`, `pfdFitConfirmed` | manager, staff |
| `ReturnRental` | `rentalId`, `damagedAssetIds` | manager, staff |

```json
{
  "action": "CheckoutRental",
  "payload": {
    "id": "RENTAL-EXAMPLE-01",
    "assetIds": ["K-01", "F-01", "P-01"],
    "partySize": 1,
    "renterRef": "R-0123456789ABCDEF01234567",
    "waiverHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "dueAt": "2026-10-15T18:00:00.000Z",
    "briefingConfirmed": true,
    "pfdFitConfirmed": true
  }
}
```

The all-`a` waiver digest above is an example placeholder; real workflow evidence is hashed from the signed source document. The browser can calculate it locally. The contract checks its format, not the contents or legal effect of an off-ledger document.

`type`: `kayak`, `tandem`, `paddleboard`, `pfd`, `paddle`.

`reasonCode`: `ROUTINE`, `BODY_DAMAGE`, `FITTINGS`, `CLEANING`, `WEATHER`, `WATER`, `AIR_QUALITY`, `STAFF_REVIEW`, `OTHER`. Free-form incident narratives are intentionally excluded from this shared ledger.

Receipt:

```json
{
  "transactionId": "Fabric transaction ID, or demo-prefixed local ID",
  "timestamp": "2026-10-15T16:00:00.000Z",
  "action": "CheckoutRental",
  "result": { "id": "RENTAL-EXAMPLE-01", "status": "active" }
}
```

`result` contains the complete updated record. In Fabric mode the Gateway submit call returns after a valid commit. Receipt timestamps come from the transaction proposal timestamp, and **are not independent proof of the wall-clock time of a physical handoff**. Contracts make no external requests and use no host clock or randomness.

## Stored records

| Key prefix | Content |
| --- | --- |
| `asset~` | Current equipment condition, status, active rental pointer, last inspection |
| `rental~` | Durable rental record with equipment IDs, opaque renter reference and waiver digest |
| `active~` | Active-rental index, removed on return |
| `launch~current` | Current manager decision, reason and expiry |
| `request~` | Identity-bound request fingerprint and original receipt |
| `event~` | Append-only business operations indexed by reverse proposal timestamp |
| `history~` | Append-only equipment versions with actor hash and transaction reference |

Records are shared with channel members in Fabric, not encrypted customer-record storage. Actor hashes represent enrolled role identities. Token secrets and private keys are never ledger values. Snapshot reads are bounded to 1,000 assets and 500 active rentals; a truncated snapshot is rejected, rather than silently hiding active equipment. Equipment history is paginated. Full rental archives and operational analytics should be indexed separately if the stand grows beyond this starter's scope.

## Errors

`400 VALIDATION`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT/CAPACITY`, `429 RATE_LIMITED`, or `503 LEDGER_UNAVAILABLE`. Fabric MVCC/phantom conflicts map to 409. A 503 or transport error may represent an uncertain commit result. Retry the same key and unchanged payload to retrieve the original receipt if it committed. The UI retains an uncertain submission's payload while the dialog remains open. External clients should durably retain pending keys and payloads across their own restarts.
