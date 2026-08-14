# Authrim security matrix tests

This directory contains deterministic, high-volume security regression tests for Authrim's OAuth,
OIDC, multi-tenant runtime, Durable Object, and Queue behavior. The suites exercise real production
handlers and state owners through local in-memory Cloudflare-compatible adapters.

The tests use a dedicated Vitest configuration because they freeze the clock, use fixed test keys,
run serialized case tables, and intentionally block external network access. They are maintained
repository tests with no external runtime dependency.

## Suites

| Suite             | Directory                  | Cases |
| ----------------- | -------------------------- | ----: |
| Authorization     | `authorize-matrix/`        |   269 |
| Token             | `token-matrix/`            |   239 |
| Runtime topology  | `runtime-topology-matrix/` |   175 |
| State transitions | `state-transition-matrix/` |   489 |

Each suite keeps its deterministic case table, production observation adapters, independent coverage
checks, `COVERAGE.md`, and `FINDINGS.md` together. Shared Cloudflare-compatible fakes and covering-array
utilities live in `fixtures/`.

## Covered security boundaries

- Authorization: SSO inheritance, sessions, `prompt`, `max_age`, consent, PAR, JAR, PKCE, redirect
  safety, `form_post`, and JARM signature and claim validation.
- Token: client authentication, authorization-code ownership and replay, PKCE ordering, DPoP binding,
  redirect/resource binding, token claims, refresh families, and downstream failure cleanup.
- Runtime topology: host and forwarded-host policy, tenant context, vanity domains, signed runtime
  registry snapshots, D1 allocation and ownership, canonical issuers, cache state, and service bindings.
- State transitions: refresh theft and revocation, device flow, CIBA reservation, audit/DLQ/logging
  queues, redelivery, out-of-order batches, and durable side effects.

Every matrix checks observable results and relevant side effects. Coverage meta-tests independently
enumerate legal pairs and selected security-critical triples, reject faulty constraints, and verify
that mutation witnesses are observable by the same assertions used for production behavior.

## Runtime boundary

The suites prove handler decisions, response contracts, call ordering, storage operations,
fail-closed behavior, and reconstruction against the local Cloudflare-compatible adapters. They do
not prove real Workers scheduling, Durable Object input-gate serialization, crash recovery, real
Queue retry delivery, D1 transactions, KV eventual consistency, regional caches, or service-binding
transport. Those remaining runtime obligations are recorded in each suite's `FINDINGS.md`.

## Resolved production regressions

The suite pins two fixes: unsupported `client_secret_jwt` is no longer advertised or accepted
for new registrations, and Queue redelivery converges on stable durable identifiers instead of
creating duplicate chunks or DLQ records.

## Running the tests

```sh
pnpm test:security-matrices:typecheck
pnpm exec vitest list --config vitest.security-matrices.config.ts --filesOnly
pnpm test:security-matrices
node scripts/check-test-quality.mjs
```

The runner loads `test/setup.ts` plus `setup.ts` in this directory. External `fetch` is disabled, each
test must execute at least one assertion, file-level parallelism is disabled, and no real external
service is required.
