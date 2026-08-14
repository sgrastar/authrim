# State-Transition Matrix — Overlap Record

## Existing related tests and coverage comparison

| Existing test                                                                                                         | What it already proves                                                                       | New interaction added here                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/integration/durable-objects.test.ts`                                                                            | Real `RefreshTokenRotator`/`AuthorizationCodeStore` over a hand-rolled `DurableObjectState`. | Instance reconstruction over a reusable `MemoryDurableObjectStorage`, theft-deletion + synchronous critical audit ledger assertions, scope-expansion rejection, tenant pinning.                                                                                     |
| `packages/ar-token/src/__tests__/security-critical.test.ts`                                                           | Refresh rotation and theft detection with mocked DO stubs.                                   | Real rotator over failure-injectable storage; old-version and JTI-mismatch theft both assert family deletion and critical audit evidence; delete/write/read failure paths; REAL first rotate for repeated/replay sequences.                                         |
| `packages/ar-token/src/__tests__/device-flow-integration.test.ts`, `test/integration/hybrid-flow-integration.test.ts` | Device approval/denial transitions with fetch mocks.                                         | Real `DeviceCodeStore` over fake storage: store → approve → issue, deny then approve rejection, pending issuance rejection, forbidden-edge fail-closed, alarm/delete idempotency, boundary expiry semantics.                                                        |
| `packages/ar-token/src/__tests__/client-auth.test.ts` / CIBA token tests                                              | CIBA grant handling with mocked stores.                                                      | Real `CIBARequestStore` over fake storage transitions (poll/ping/push), nonce/ACR propagation into the issued ID token, and the reservation fail-closed boundary through the real `tokenHandler`.                                                                   |
| `packages/ar-lib-core/src/services/audit` queue-consumer tests                                                        | Per-consumer unit behavior with mocked bindings.                                             | Real `processAuditQueue` / `processDLQQueue` / `processLoggingDeliveryQueue` over D1/R2 fakes with per-message ack/retry call counting, mixed-batch isolation, unsupported-schema DLQ-before-ack, REAL duplicate redelivery, and REAL Message.attempts propagation. |

## Overlap baselines (not re-certified)

- The 308-data-row tenant-system matrix and standalone host-parser matrices are baselines
  for the runtime-topology suite; they are not exercised here.
- Authorization (authorize-matrix) and token (token-matrix) suites cover the authorize and
  token endpoints; this suite exercises the same `tokenHandler` for the device and CIBA
  grant types but never re-runs authorize rows.

## New interactions per case family

- **Refresh token family (R):** absent → version 1 → version N → absent. create/recreate,
  rotate (exact/old/future version), validate, revoke-family, revoke-by-jti, batch-revoke;
  old-version theft and JTI-mismatch theft both delete the family and record exactly one
  synchronous critical audit; replay of a rotated version is theft; scope expansion
  rejected; TTL boundary counts as expired; read/write/delete storage failures.
  `sequence=repeated/replay` rows execute a REAL first rotate (v1 → v2) before the matrix
  operation; `instanceState=reconstructed` rows run the matrix operation on a NEW
  production DO over the SAME storage.
- **Device flow store owner (D-S):** store → approve → issue; store → deny → delete;
  pending/approved → expired; mark-issued reservation boundary (second issuance fails
  closed); forbidden approve/deny on non-pending records fail closed; alarm cleanup.
- **Device flow token endpoint (D-T):** the real `tokenHandler` with the real store for
  issuance and a programmable stub for reservation shapes; authorization_pending /
  slow_down polling; wrong client rejected; expired/missing/denied/issued states.
- **CIBA store owner (C-S):** store → approve (nonce/acr stored) → mark-issued; deny;
  alarm cleanup of expired requests; approval of an already-approved or issued request
  fails closed.
- **CIBA token endpoint (C-T):** the real `tokenHandler` with client_secret_post
  authentication; nonce/ACR propagate into the issued ID token; the mark-token-issued
  reservation boundary fails closed (zero signing, zero refresh family, zero issued-token
  registration) for every non-success reservation shape.
- **Queue delivery (Q-A/Q-D/Q-L):** the production audit, DLQ, and logging-delivery
  consumers with every ack/retry call counted and first-call-wins effective disposition;
  mixed batches isolate failures; unsupported schemas are DLQ-saved before ack; malformed
  envelopes retry; REAL duplicate delivery (two deliveries, fresh Message objects, shared
  durable state, clock advanced) exposes which paths are idempotent and which duplicate
  durable effects (see FINDINGS.md); `Message.attempts` reflects the attempt axis and is
  observable through the recorded attempt_count values.

## Mutation witnesses per case family

| Case family               | Mutation IDs                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Refresh theft/rotate rows | `refresh:keep-family-after-old-version-theft`, `refresh:keep-family-after-jti-mismatch-theft`, `refresh:allow-scope-expansion`                                     |
| Device transition rows    | `device:allow-forbidden-approval`, `device:allow-forbidden-denial`, `device:allow-forbidden-issuance`                                                              |
| CIBA reservation row      | `ciba:issue-after-reservation-failure`                                                                                                                             |
| Queue consumer rows       | `queue:retry-entire-mixed-batch`, `queue:ack-unsupported-schema-before-durable-dlq`, `queue:ack-transient-failure`, `queue:duplicate-durable-effect-on-redelivery` |

Every mutation ID is connected to a REAL production observation in
`meta.test.ts` with a independently declared representative condition asserted BEFORE the
run: a representative case runs against production, the common assertion passes, then
the mapped observation domain is corrupted in the REAL observation and the same
assertion rejects it. Mutation IDs are only assigned to cases whose production edge
they target; unrelated fallback assignments were removed.
