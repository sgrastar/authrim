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

This suite does not cover SAML or SCIM. Those protocols are part of the
[canonical integration suite](../../integration/README.md). Detailed overlap, transition families,
mutation witnesses, and real-runtime limitations are recorded in [COVERAGE.md](./COVERAGE.md) and
[FINDINGS.md](./FINDINGS.md).

## Running the suite

```sh
pnpm exec vitest run --config vitest.security-matrices.config.ts \
  test/security-matrices/state-transition-matrix
```
