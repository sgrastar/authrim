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

## Matrix definition

The five covering arrays contain 135 generated rows. Dedicated admin/boundary checks, mutation
witnesses, oracle-sensitivity checks, and meta-tests bring the complete suite to 175 tests. Every
matrix covers 100% of its legal 2-way tuples in addition to the required 3-wise group shown below.

| Matrix                           | Rows | Main dimensions                                                                                                                                                         | Required 3-wise group                                                                       | Production boundary and observations                                                                                                                  |
| -------------------------------- | ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-A: request routing             |   49 | deployment mode; host class; forwarded-host policy/state; browser, protocol, discovery, internal or admin request; tenant lifecycle; vanity, registry and binding state | host class × forwarded-host policy × request class                                          | `requestContextMiddleware`; resolved tenant/issuer, registry and binding access, security events, redirects/errors, foreign-tenant access prevention  |
| R-B: registry/binding resolution |   48 | host tenant; signed snapshot and generation state; shared/exclusive allocation; registry tenant; binding owner; data role; binding/service/provider/cache state         | tenant host × registry tenant × binding owner; allocation scope × binding owner × data role | `resolveTenantDatabaseSourceFromRegistry`; selected generation/allocation/owner/data role/binding, request cache, real `SELECT 1`, fail-closed errors |
| R-C: route/cache generation      |    9 | active/quarantining/quarantined/disabled route; cold/warm/warm-stale cache; matching/stale/ahead/missing generation                                                     | route status × cache state × runtime generation                                             | resolver route gate and cache reuse/re-resolution; quarantine and generation failures                                                                 |
| R-D: canonical issuer            |   16 | canonical/naked/vanity/alias/unresolvable host; vanity state; canonical issuer state; browser/protocol request                                                          | vanity state × canonical issuer state × request class                                       | middleware issuer construction; canonical issuer, browser redirect, protocol rejection, unavailable fail-closed result                                |
| R-E: service binding/context     |   13 | binding present/missing/wrong-type/throws; absent/matching/conflicting forwarded host; matching/foreign/missing tenant context; host resolvability                      | service-binding state × forwarded host × tenant context                                     | middleware context propagation; binding selected for the context tenant, host-binding rejection, untouched foreign/host tenant ledgers                |

The independent checker pins the six legal-triple counts at 33, 8, 8, 9, 16, and 13 for the R-A,
R-B (two groups), R-C, R-D, and R-E groups respectively. It also rejects a table that preserves all
pairs while dropping one required triple.

This suite complements rather than duplicates the canonical 308-row tenant settings matrix. It does
not cover SAML or SCIM protocol behavior. Detailed overlap, required 3-wise groups, fixture guarantees,
and real-runtime limitations are recorded in [COVERAGE.md](./COVERAGE.md) and
[FINDINGS.md](./FINDINGS.md).

## Running the suite

```sh
pnpm exec vitest run --config vitest.security-matrices.config.ts \
  test/security-matrices/runtime-topology-matrix
```
