# Token Matrix — Overlap Record

## Existing related tests and coverage comparison

| Existing test                                                                                                                   | What it already proves                                                                              | New interaction added here                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ar-token/src/__tests__/security-critical.test.ts` (PKCE validation, replay attack prevention, refresh rotation/theft) | Single-request PKCE rejection and DO-level replay return values via mocked `AUTH_CODE_STORE` stubs. | A real `AuthorizationCodeStore` over fake durable storage routed through the production `tokenHandler` on a real Hono router; the multi-request authenticated-replay ordering (missing → malformed → mismatched → correct verifier) and revocation ledger assertions.                                             |
| `packages/ar-token/src/__tests__/client-auth.test.ts`                                                                           | Registered-method matrix with mocked `getClientCached`.                                             | D1-backed client metadata resolved through the real `getClientCached` path; tenant-aware client rows (public/confidential/unknown/wrong-tenant); `client_secret_basic`, `client_secret_post`, `client_secret_jwt`, and `private_key_jwt` presented end-to-end, including malformed and conflicting presentations. |
| `packages/ar-token/src/__tests__/token-lifecycle-flow.test.ts`, `test/integration/token-refresh-introspect-revoke.test.ts`      | End-to-end token issuance under mocked or fixture environments.                                     | Node-contract issuance with a frozen deterministic clock, fixed signing keys, independent token-claim verification against the fixed public key, and a call ledger observing `consumeCodeRpc`, `registerIssuedTokensRpc`, and `createFamilyRpc` on the real stores.                                               |
| `test/integration/durable-objects.test.ts`                                                                                      | Real `AuthorizationCodeStore` over a hand-rolled `DurableObjectState`.                              | Instance-reconstruction and replay-ordering evidence over a reusable `MemoryDurableObjectStorage` fake plus ledger recording.                                                                                                                                                                                     |
| `packages/ar-lib-core/src/utils/__tests__/dpop.test.ts`                                                                         | DPoP proof validation branches with mocked JTI stores.                                              | DPoP proofs generated with ES256 keys and presented through the real handler with a code bound to the same key (cnf.jkt comparison), a different key, a malformed proof, and a replayed proof jti against a replay-detecting JTI store stub.                                                                      |
| `packages/ar-token/src/__tests__/client-assertion.test.ts`                                                                      | RFC 7523 assertion validation with mocked JWKS.                                                     | Signed client assertions (RS256, fixed key, client JWKS) validated through the real handler with the real token endpoint audience, and the jose-vs-frozen-clock interaction documented.                                                                                                                           |

## Overlap baselines (not re-certified)

- The existing 308-data-row fixture `test/integration/tenant-system/fixtures/tenant-system-3wise-constrained-valid-matrix.csv` and its consuming integration test are treated as an overlap baseline; the runtime-topology suite does not re-certify that matrix.
- Standalone host-parser matrices in `packages/ar-lib-core/src/utils/__tests__/issuer.test.ts` are baselines; the runtime-topology suite targets cross-layer issuer precedence, not a duplicate parser.
- Authorization-code scope subset/expansion control is explicitly NOT exercised here; it belongs to refresh-token state transitions.

## New interactions per case family

### Matrix T-A (client authentication × code ownership/state)

- Registered method (none/basic/post/client_secret_jwt/private_key_jwt) × presented
  credentials (none/basic/post/jwt/malformed/conflicting) × client kind
  (public/confidential/unknown/wrong-tenant): authentication failures return 401
  `invalid_client` before any code read and never consume or revoke; successful
  authentication proceeds to the code state. Legacy `client_secret_jwt` registrations
  always fail closed because Authrim does not store a reversible HMAC secret.
- Code states: fresh (issuance), consumed (replay classification without registered
  JTIs), replayed with registered access/refresh JTIs (exact revocation), expired,
  malformed (rejected by validateAuthCode before the consume), wrong client, wrong
  tenant, and a foreign request tenant (the code lives in a store the request tenant
  never reads).
- A genuine success path is guaranteed per supported authentication combination
  (the covering array otherwise covers every legal triple with failing rows).

### Matrix T-B (grant binding × issuance/postcondition)

- Code bindings (none/pkce/dpop/pkce+dpop) × PKCE verifier × DPoP proof: PKCE
  missing/mismatched/malformed and DPoP key mismatch/proof-required fail inside the
  consume without transitioning a fresh code to used; malformed proofs and reused proof
  jtis are rejected before the consume; a valid bound request issues tokens with
  `cnf.jkt` matching the proof key.
- Redirect URI (exact/omitted/mismatched/malformed) and resource/audience
  (omitted-default/exact/changed/conflict/disallowed): failures return before any code
  consumption.
- Replay × registered JTI state × revocation outcome: an authenticated replay revokes
  exactly the registered JTIs; a raced registration rejection revokes the tokens issued
  by the request; a revocation-store failure is swallowed by the replay handler without
  leaking.
- Downstream failure injection: signing (KeyManager throw with cache TTL aged out),
  refresh-family creation (shard-config KV failure), raced registration rejection, and
  revocation failure — no success response or untracked token is ever returned.
- Token claim oracle: access/ID/refresh tokens are independently signature-verified
  against the fixed fixed test public key (alg/kid, iss, aud, sub, client_id, scope,
  iat/exp, jti, auth_time, at_hash, nonce, rtv, resource_aud, cnf.jkt).

## Meta tests

- 100% legal 2-way tuple coverage for T-A and T-B via an independent brute-force
  enumeration.
- 100% coverage of the required triples: `registeredMethod × presented × client`,
  `codeBinding × pkce × dpop`, `redirect × resource × replayState` (dimension-based),
  plus the derived `codeState × authResult × requestTenant` and
  `replayState × jtiState × revocationOutcome` combination sets.
- Unique case ids and semantic fingerprints across both matrices.
- Faulty-matrix rejection: dropping a legal triple is detected even when every pair
  remains covered; an over-constrained matrix that hides a legal pair is rejected.
- Discriminating mutation witnesses per case (each declared mutation id changes the
  expected decision).
- Pinned expected case counts for T-A and T-B.

## Mutation witnesses intended

| Case family                                | Mutation IDs                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Authentication-failure rows                | `token:consume-before-auth`, `token:accept-bad-client-credentials`      |
| Code/grant failure rows that still consume | `token:issue-without-code-consume`                                      |
| Non-replay grant failures                  | `token:revoke-on-non-replay-grant-failure`                              |
| Replay rows                                | `token:omit-revocation-after-replay`                                    |
| Success rows                               | `token:derive-claims-wrong-tenant`                                      |
| Rejected grants that must not consume      | `token:consume-code-on-rejected-grant`                                  |
| DPoP-rejected rows                         | `token:accept-bad-dpop-proof`                                           |
| Success registration rows                  | `token:skip-issued-token-registration`, `token:register-before-success` |
