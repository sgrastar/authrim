# State-Transition Matrix — Findings

## Status

This suite exercises 489 cases across eight matrices. All rows pass. The CIBA reservation
fail-closed invariant is preserved: a non-successful `mark-token-issued` reservation
fails closed with zero signing and no token material.

## Resolved production finding (Queue redelivery idempotency)

`delivery=duplicate` executes a REAL redelivery: the SAME message id/body is delivered
twice with fresh Message objects sharing the same D1/R2 durable backing state, at a
later wall-clock time (clock advanced +60s, like a real Queue redelivery). The observed
write calls are separated from the FINAL unique durable records/objects. The following
paths formerly created a new clock-derived record identity on every delivery. Production
now derives chunk, catalog, DLQ, delivery-event, and notification identifiers from the
stable Queue message id and enqueue timestamp. R2 writes converge on the same object key;
D1 inserts use conflict-safe primary keys, and delivery aggregates are not incremented
when the corresponding stable delivery event already exists. The duplicate-delivery rows
pin identical final durable identities while still observing two ack/retry calls.

## Production behaviors pinned by this suite

- **Refresh theft deletes the family synchronously.** Both an old-version presentation
  and a JTI mismatch delete the family record and emit exactly one synchronous critical
  audit (event_log INSERT + audit queue enqueue) before the error surfaces.
- **Refresh sequences are executed for real.** `sequence=repeated/replay` rows first run
  a REAL rotate (version 1 → 2) with matching credentials and then run the matrix
  operation as the second call; `instanceState=reconstructed` rows run the matrix
  operation on a NEW production `RefreshTokenRotator` over the SAME storage so the
  family is restored from storage, not from the first instance's memory cache.
- **Scope expansion is rejected** (`invalid_scope`) before any rotation write.
- **Device boundary expiry is inclusive** (`Date.now() > expires_at`): a code whose
  `expires_at` equals now is still valid. **CIBA uses `>=`**, so the boundary is expired
  there. The two suites pin these asymmetric boundary semantics separately.
- **Device/CIBA store forbidden edges fail closed.** Approving/denying a non-pending
  device code and re-issuing an already-issued code return `server_error` with no write.
- **CIBA mark-token-issued reservation fails closed** for every non-success response
  shape: the token handler returns an OAuth error with zero signing calls, zero
  refresh-family creation, zero issued-token registration, and no success events.
- **Queue consumers are ack-or-retry per message.** Every production ack()/retry() call
  is counted (ackCalls/retryCalls), the first-call-wins effective disposition is one of
  ack/retry, mixed-batch success messages are never retried, and transient failures are
  never acked.
- **Out-of-order batches are executed for real.** Two successful stable-ID messages are
  delivered in forward and reverse order through each of the audit, DLQ, and logging-
  delivery consumers over fresh equivalent state; per-message disposition and durable-
  effect observations are identical.

## Node-contract evidence boundary

- Refresh/device/CIBA store transitions run the production state owners over in-memory
  durable storage. This proves sequential decision logic, storage operations, fail-closed
  handling, and reconstruction of a new instance over the same fake storage.
- Device and CIBA token-endpoint rows run the real `tokenHandler` on a typed Hono app
  with a frozen `Env`, ledger-backed `ExecutionContext`, and drained `waitUntil`; the CIBA
  rows that need non-success reservation shapes use a programmable stub for the CIBA
  request store (the real store always answers with its own JSON).
- Queue rows run the production consumers with the real adapter-backed D1/R2 fakes,
  MessageBatch fakes (every ack/retry call recorded with first-call-wins semantics), and
  a capturing structured logger. `Message.attempts` reflects the attempt axis; duplicate
  delivery is executed as two real deliveries over the same durable state. Unique durable
  effects are counted from the recorded INSERT identities and R2 object keys, so write
  calls and final records are observed separately.
- It does **not** prove Cloudflare input-gate serialization, real concurrent request
  serialization, atomicity, crash/restart recovery, real alarm delivery, real Queue
  delivery timing, Durable Object transport, or production D1/R2 latency.
- The production signing-key cache is module-level, so RPC call counts are not stable
  across tests; the observable contract asserted is: tokens issued ⇒ signing occurred,
  and every failure row signs zero times (fail closed).

## Secret-leak oracle

A fixed 256-bit hex canary credential is installed as the queue encryption-root binding;
it is deliberately absent from every delivered message. It must never surface in the
captured logger messages/structured fields, D1 prepared-statement params (safe-
serializable subset), R2 put keys, customMetadata or bodies (including DLQ archives), or
any error surface. The oracle is verified non-vacuous: it detects the canary in both a
derived R2 body and a DLQ archive.

## Coverage notes (independent checker)

- `meta.test.ts` re-declares every dimension order, value set, legality predicate,
  and selected-triple group as independently declared literals derived from the production
  sources, shares no constraint/decision code with `cases.ts`, and proves:
  - generator constraints and independent predicates accept the same assignment set for
    all eight matrices,
  - fixed legal-pair counts and 100% legal-pair + required-triple coverage of every
    matrix,
  - faulty-matrix rejection (dropped pair, dropped triple, wrong constraint),
  - unique ids/fingerprints and pinned covering-array case counts (including the
    dedicated appended rows that reach the theft/unsupported-schema edges),
  - every mutation ID is carried by at least one case AND every retained dimension has a
    independently declared effect description (production input / operation sequence / DO
    instance / failure injection / observable outcome),
  - every mutation ID runs its exact production path: the representative condition is
    asserted before the run, and the mapped observation domain is corrupted in the REAL
    observation and rejected by the common assertion.
- Collected: 489 (458 covering-array rows + 31 dedicated/meta tests). Row split:
  R 77, D-S 38, D-T 65, C-S 87, C-T 86, Q-A 33, Q-D 21, Q-L 51.
