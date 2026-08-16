# Runtime-topology matrix

This suite exercises Authrim's cross-layer routing and tenant-resolution chain with deterministic,
Cloudflare-compatible adapters. Five matrices cover the path from an incoming host to tenant context,
runtime registry, storage binding, and canonical issuer.

## Covered behavior

- R-A covers request host and forwarded-host policy, route class, tenant hints, and vanity-domain
  resolution.
- R-B covers signed registry snapshots, D1 allocation and ownership, binding resolution, and
  fail-closed behavior for missing, stale, or mismatched records.
- R-C covers route status, cache state, and registry generation changes.
- R-D covers canonical issuer construction and alias handling.
- R-E covers service bindings, forwarded hosts, and propagation of tenant context.
- Assertions observe resolved identities and bindings, cache transitions, issuer values, error
  contracts, and whether unsafe downstream calls were prevented.

This suite complements rather than duplicates the canonical 308-row tenant settings matrix. It does
not cover SAML or SCIM protocol behavior. Detailed overlap, required 3-wise groups, fixture guarantees,
and real-runtime limitations are recorded in [COVERAGE.md](./COVERAGE.md) and
[FINDINGS.md](./FINDINGS.md).

## Running the suite

```sh
pnpm exec vitest run --config vitest.security-matrices.config.ts \
  test/security-matrices/runtime-topology-matrix
```
