# State-transition matrix

This suite validates durable protocol and delivery state transitions, including reconstruction and
observable side effects. It uses constrained case tables for eight matrices and independently checks
their legal-pair and selected security-critical 3-wise coverage.

## Covered behavior

- Refresh-token rotation covers normal use, reuse and theft detection, family revocation, expiry,
  tenant and client binding, concurrent or repeated sequences, and reconstructed state owners.
- Device Authorization covers issuance, polling cadence, approval, denial, expiry, redemption, and
  replay behavior across the device store and token endpoint.
- CIBA covers request reservation, approval or denial, polling, expiry, redemption, replay, and
  state reconstruction across the CIBA store and token endpoint.
- Queue matrices cover audit, dead-letter, and logging delivery, including retries, redelivery,
  duplicate and out-of-order batches, durable identifiers, chunking, and failure handling.
- Assertions include persisted state, audit or queue records, retry metadata, revocation effects, and
  the absence of partial side effects on rejected transitions.

## Matrix definition

`Rows` counts generated case-table rows. The complete suite also contains dedicated transition,
mutation, oracle-sensitivity, and independent coverage tests, bringing the complete suite to 489
tests. Every matrix covers 100% of its legal 2-way tuples plus the selected security-critical 3-wise
groups summarized below.

| Matrix                     | Rows | Main dimensions                                                                                                                                    | Selected 3-wise focus                                                                          | Production observations                                                                                |
| -------------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| R: refresh-token family    |   77 | family state, operation, version/JTI relation, client/tenant binding, scope, storage result, reconstructed instance, repeated/replay sequence, TTL | theft identity; operation/bindings; scope/version; TTL/storage/reconstruction; replay ordering | family version/existence, token result, exact revocation, synchronous critical audit, storage failures |
| D-S: Device store          |   38 | state, operation, tenant binding, expiry, duplicate reservation                                                                                    | state × operation × tenant; state × reservation × expiry                                       | durable state, approval/denial/issuance edges, alarm cleanup, duplicate reservation                    |
| D-T: Device token endpoint |   65 | state, client/tenant binding, polling timing/attempt, reservation result, expiry, token outcome                                                    | polling/retry; reservation/expiry/outcome; client/tenant binding                               | OAuth error or issuance, reservation call, signing/family/registration side effects                    |
| C-S: CIBA store            |   87 | delivery mode, state, operation, nonce, ACR, approval result, tenant binding, duplicate reservation                                                | delivery/state/operation; nonce/ACR/approval; state/operation/tenant; state/reservation/tenant | durable request state, nonce/ACR persistence, approval/denial, cleanup, duplicate issuance rejection   |
| C-T: CIBA token endpoint   |   86 | delivery mode, state, polling timing/attempt, nonce, ACR, client authentication/binding, tenant binding, reservation result/outcome                | delivery/polling; nonce/ACR/outcome; client-auth/tenant/state; reservation/outcome             | OAuth result, ID-token nonce/ACR, reservation call, zero signing/family/registration after failure     |
| Q-A: audit consumer        |   33 | batch composition, attempt, delivery, binding, tenant, archive, audit payload family                                                               | batch/attempt/redelivery; binding/payload; tenant/archive/payload                              | per-message ACK/retry, D1/R2 writes, fanout attempts, tenant isolation                                 |
| Q-D: dead-letter consumer  |   21 | success/failure batch, attempt, redelivery, binding, tenant, archive, event/PII payload                                                            | batch/attempt/redelivery; binding/archive/tenant; delivery/payload/binding                     | archive-before-ACK ordering, retry behavior, duplicate durable effects                                 |
| Q-L: logging delivery      |   51 | batch, attempt, schema, redelivery, lane, binding, tenant, archive, payload family                                                                 | schema/retry/lane; lane/binding/tenant; delivery/payload; archive/schema/attempt               | lane routing, schema handling, chunk/delivery writes, DLQ persistence, per-message disposition         |

### Representative fail-closed transitions

| Family  | Initial condition                                     | Operation | Expected result                                | Required side effects                  | Forbidden side effects                                              |
| ------- | ----------------------------------------------------- | --------- | ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| Refresh | active family, old version or mismatched JTI          | rotate    | theft error and family deletion                | exactly one synchronous critical audit | new refresh token or surviving family                               |
| Device  | pending request polled too early                      | redeem    | `slow_down`                                    | polling state retained                 | token signing or issuance reservation                               |
| CIBA    | approved request with failed/already-used reservation | redeem    | `invalid_grant`                                | reservation failure observed           | signing, refresh-family creation, token registration, success audit |
| Queue   | unsupported schema                                    | deliver   | durable DLQ disposition                        | DLQ/archive write before ACK           | ACK before durable evidence                                         |
| Queue   | mixed batch with one transient failure                | deliver   | healthy message ACKed, failing message retried | per-message isolation                  | whole-batch retry or partial durable success hidden                 |

This suite does not cover SAML or SCIM. Those protocols are part of the
[canonical integration suite](../../integration/README.md). Detailed overlap, transition families,
mutation witnesses, and real-runtime limitations are recorded in [COVERAGE.md](./COVERAGE.md) and
[FINDINGS.md](./FINDINGS.md).

## Running the suite

```sh
pnpm exec vitest run --config vitest.security-matrices.config.ts \
  test/security-matrices/state-transition-matrix
```
