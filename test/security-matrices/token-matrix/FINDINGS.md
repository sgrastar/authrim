# Token Matrix — Findings

## Status

Matrix T-A (client authentication × code ownership/state) and Matrix T-B (grant binding ×
issuance/postcondition) are green. Every retained row runs through the exported
`tokenHandler` registered as `POST /token` on the typed Hono app with a real `Request`, a
frozen `Env`, reviewer-approved middleware state, an explicit ledger-backed
`ExecutionContext`, and drained `waitUntil` promises. No production defect was observed.

## Constraint provenance (production-reachability, verified)

- **T-A: authentication failure precedes any code read.** Client credential extraction
  and validation (token.ts:1594-1631, resolveTokenClientAuthenticationPolicy at
  token.ts:1789-1847) run before the consume (token.ts:1929), so a failed authentication
  loses no observable information by keeping `codeState=fresh` and
  `requestTenant=matching`; the failure is still verified to leave the code untouched.
- **T-A: client type and registered method describe one registration.** A public client
  is registered with method `none` and a confidential client with a credential method
  (`isPublicClientMetadata`, token.ts:476); mixed registrations do not exist in
  production, so `public × client_secret_basic`-style rows are excluded by constraint.
- **T-A: malformed codes are rejected before any consume.** `validateAuthCode`
  (token.ts:1646-1655) rejects a malformed code before the tenant-scoped consume, so the
  consume RPC is not reached even for a foreign request tenant.
- **T-B: replay-aware downstream failures require the consume to reach the intended
  branch.** Signing/family/registration failures only occur after a successful consume,
  so those rows require a fresh code with valid bindings; the revocation-failure row
  requires an authenticated replay (used code, registered JTIs, valid bindings) because
  only the replay handler attempts a revocation (token.ts:1948-2000).
- **T-B: registered JTIs require an already-used code.** `issuedAccessTokenJti` /
  `issuedRefreshTokenJti` are only written on a code that was consumed once
  (AuthorizationCodeStore:705-770).

## Node-contract evidence boundary

- Rows exercise the real token issuance chain: client authentication, DPoP proof
  validation, audience/resource resolution, PKCE/redirect/binding consume checks,
  authenticated-replay classification with JTI revocation, signing, refresh-family
  creation, and issued-token registration — all over in-memory fakes.
- It does **not** prove Cloudflare input-gate serialization, Durable Object atomicity
  under concurrency, crash/restart recovery, real alarm delivery, real Queue retry
  delivery, D1 transactions, or KV eventual consistency. The DPoP JTI store and the
  token revocation store are programmable transport stubs in this suite (their failure
  branches are exercised through deliberate injections, never used as oracles).
- JWT-based client authentication (`private_key_jwt`, plus fail-closed legacy
  `client_secret_jwt` rows) is verified by
  jose against the real wall clock while production lifetime checks use `Date.now`;
  rows presenting a client assertion therefore re-pin the frozen clock to real-now + 1h
  (captured once at suite start) so both checks pass deterministically within a run.
- DPoP proofs must use one of the allowed algorithms (ES256/PS256/EdDSA,
  constants.ts:303); the suite generates ES256 proofs accordingly.

## Deliberate failure injections (never used as oracles)

- **Signing failure:** the KeyManager stub throws and the frozen clock is advanced past
  the 30-minute signing-key cache TTL (token.ts:1264-1295) so the failure is observed.
- **Refresh-family failure:** the refresh shard-config KV read fails
  (`refresh-token-shards:*`), so `createRefreshTokenFamily` cannot resolve the rotator
  instance (refresh-token-sharding.ts:457-499) and issuance fails with server_error.
- **Raced registration rejection:** a code record is seeded directly into durable
  storage with `replayDetectedBeforeTokenRegistration=true` (DO not yet materialized),
  so `registerIssuedTokensRpc` returns false and the request revokes its own tokens
  (token.ts:3009-3029).
- **Revocation failure:** the token revocation store stub always returns 500; the replay
  handler swallows the revocation error (token.ts:1957-1991) and still returns the
  generic invalid_grant without leaking the failure.

## Oracle corrections recorded against production source (not production findings)

- The DPoP proof validation (token.ts:1763-1785) runs before audience/resource
  resolution (token.ts:1851), which itself runs before the code consume; the independent
  decision table follows that order.
- A reused DPoP proof jti is rejected by the JTI store with 400, which the handler maps
  to `use_dpop_nonce` (dpop.ts:361-375), not `invalid_dpop_proof`.
- A fresh code with a valid verifier and an exact redirect but a replay history reaches
  authenticated replay: the consume RPC is still invoked and the code is not
  transitioned again, while the registered JTIs are revoked exactly once.
- The raced-registration row legitimately consumes the code and creates the refresh
  family before the registration rejection revokes the just-issued tokens.
- The refresh-family failure (token.ts:2932-2938) and a throwing rotator return a plain
  `c.json` server_error with **no** `Cache-Control`/`Pragma` headers, while the signing
  failure (token.ts:2175) goes through `oauthError` with `no-store`/`no-cache`; the
  expected observations follow that split.
- A used-code seed (`replayState=used`) stays `used=true` no matter how the request
  rejects; only a binding validation failure inside `consumeCodeRpc` on a fresh code
  leaves it unused. `codeBinding` with no `pkce`/`dpop` does not bind the presented
  verifier/proof (the code record carries no challenge/JKT), so such rows consume
  normally even with a malformed/mismatched presentation.
- Rows are made order-independent: every row re-pins the frozen clock to the canonical
  instant (signing/family rows advance it to age out caches) and undoes the failure
  injections left by an earlier row in the same `it()` (KeyManager stub, KV get-failure
  keys, revocation/DPoP JTI store swaps).
- The client id is a public identifier and legitimately appears in rotator instance
  names (`refresh-rotator:{clientId}:v1:shard-0`) and refresh shard-config KV keys, so
  the secret-leak scan covers the authorization code and issued token material only.

## Resolved production finding

- **Unsupported `client_secret_jwt` was advertised and accepted at registration.** Authrim
  stores only a one-way `client_secret_hash`, which cannot verify an OIDC Core section 9
  HMAC assertion. The method is now absent from Discovery, dynamic registration, Admin
  registration, settings, and OpenAPI enums. Existing legacy rows still reject HMAC and
  asymmetric assertions with generic `invalid_client`; no hash is repurposed as an HMAC
  key and no reversible secret was introduced. The dedicated T-A case pins this
  fail-closed migration behavior.

## Secret-handling scope

- The response body, response headers, ledger targets, and safely-serializable ledger
  details are scanned for the authorization code, the client id, and issued token
  material; tokens are the legitimate delivery surface of a token response and are
  excluded from the body scan.
- The AuthorizationCodeStore durable-storage key label (`code:${code}`) is the
  legitimate storage label recorded by the transport ledger and is excluded from the
  ledger-target scan.
- JWT, token, and code values are never printed to logs or assertion messages.
