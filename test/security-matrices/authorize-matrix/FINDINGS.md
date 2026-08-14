# Authorize Matrix — Findings

## Status

- Matrix A (authentication / session / SSO / consent): green as of this build session;
  every retained row runs through the real `authorizeHandler`. No production defect
  observed in the exercised authentication surface.
- Matrix B (protocol source / PAR / JAR / PKCE / redirect): green as of this build
  session; every retained row and dedicated preflight runs through the real
  `authorizeHandler` on a typed Hono app under a non-default request tenant
  (`tenant-b`). No production defect observed.

## Constraint provenance (Matrix A, verified, unchanged)

- `session non-active implies consent=missing and maxAge in (omitted, malformed)` — a
  non-usable session never yields `sessionUserId` (authorize.ts:2832), so consent
  evaluation and the max_age re-authentication bounds are unreachable; `malformed`
  max_age is the only value that changes the observable result (direct 400 before any
  session read, authorize.ts:2003).
- `consent=auto-grant requires session=active` — trusted-client auto-grant is only
  evaluated after an authenticated subject exists (authorize.ts:3456-3582).

## Constraint provenance (Matrix B, verified, unchanged)

- `containerState must match the request source` — only the declared container of the
  request source is processed (PAR read at authorize.ts:1088-1599, JAR processing at
  authorize.ts:1606-1948); direct and conflict requests have no container.
- `phase must equal the dominant validation phase of the row` — container errors precede
  the client fetch; effective response-type validation (authorize.ts:1954-1987) precedes
  the client tenant check (authorize.ts:2054); the tenant check precedes redirect
  validation (authorize.ts:2237-2438).
- `par-valid carries a registered redirect` — a valid PAR restores its stored
  redirect_uri (authorize.ts:1569) which is then validated against the client
  registration.
- `par-valid never restores a missing response_type` — production defaults the restored
  response_type to `code` (authorize.ts:1462).
- `request-source and pre-redirect errors occur before any session read` — the session
  store is only read at authorize.ts:2811.
- `foreign-tenant client binding is decided before post-validation` — the client tenant
  check (authorize.ts:2054-2066) fires only when the request tenant is NOT the deployment
  default tenant; the Matrix B suite therefore executes under a non-default request
  tenant so the cross-tenant client row is genuinely rejected.

## Oracle corrections recorded against production source (not production findings)

- PAR failure error redirection is ALWAYS query-encoded: the production call passes no
  `response_mode` and hardcodes `responseType: 'code'` (authorize.ts:1506-1513), so a
  `jwt`/`fragment` outer response_mode does not affect PAR-error redirects.
- `validateResponseType` rejects `token` as unsupported (validation.ts:708), so the
  `unsupported` response-type dimension is a direct 400 before the tenant check.
- JAR processing failures are returned directly as JSON (authorize.ts:1607-1948); they
  never redirect, even for registered redirects.
- The `request` + `request_uri` conflict is rejected before either container is read
  (authorize.ts:786); the PAR store is never touched for conflict requests.
- `alg=none` request objects are rejected in the local test environment (non-production,
  `oidc.allowNoneAlgorithm` defaults false), pinned by the `jar-malformed` rows.
- JARM error/success responses carry the OAuth parameters inside the signed JWT
  (`response` parameter); the code is never placed in query parameters under JARM.
- `seedParTenantMismatch` writes the conflicting record directly to durable storage so
  the live PARRequestStore instance (which lazily hydrates from storage) observes the
  overridden `tenant_id`; going through `storeRequestRpc` would leave the in-memory copy
  with the request-tenant binding and hide the mismatch.

## Node-contract evidence boundary

- Tests invoke the real `authorizeHandler` through a real Hono router with a real
  `Request`, a frozen `Env`, a ledger-backed `ExecutionContext`, and drained
  `waitUntil`. Branch decisions, HTTP results, redirect targets, challenge records,
  consent lookups/writes, session reads, PAR reads/consumes, JARM responses, and
  auth-code storage are production behavior under the declared fake contracts.
- It does **not** prove Cloudflare Workers request scheduling, real PAR/JAR/Challenge/
  AuthCode store RPC transport, D1 transactions, KV eventual consistency, HTTPS
  request_uri fetching, or platform latency. The browser-visible login/consent UI
  screens are outside this suite's contract.

## Potential production findings

None recorded in this suite.

## Notes

- `select_account` has no direct authorization-endpoint branch in production
  (authorize.ts:3213); Matrix A asserts it observes exactly the prompt-omitted contract.
- The exact max_age boundary (auth age == max_age) is asserted with an independent time
  computation in Matrix A.
- Matrix B runs under request tenant `tenant-b` (non-default) so the foreign-tenant
  client rejection is genuinely reachable; all tenant-scoped fixtures (region shard
  config, settings, sessions, consent, PAR instances) are seeded under that tenant and
  the request ledger is scanned for foreign-tenant store accesses.
- Valid signed JAR inputs are verified against the client's registered JWKS at seed time
  (input construction only, using production crypto utilities); expected results are
  computed exclusively by the independent decision table.
