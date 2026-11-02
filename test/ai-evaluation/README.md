# Authrim AI Evaluation Suites

Generated combinatorial evaluation tests for the Authrim identity provider. These tests are
**evaluation evidence only**; they are not release evidence and no test becomes canonical
without a separate human promotion review.

## Isolation

All generated output lives under `test/ai-evaluation/`. Production code, canonical tests,
package manifests, lockfiles, workflows, and the private campaign controls are never modified
by the builder. The suites are executed only through the dedicated runner config
`private/test-ai-evaluation/vitest.config.ts` and are excluded from canonical `pnpm test`,
coverage aggregation, and required CI.

External network access is forbidden and enforced by the evaluation runner
(`AUTHRIM_AI_EVALUATION_NETWORK=disabled`).

## Suites

| Suite | Directory | Manifest | Collected cases |
| ----- | --------- | -------- | --------------- |
| Authorization | `authorize-matrix/` | `suite.manifest.json` | 269 |
| Token | `token-matrix/` | `suite.manifest.json` | 237 |
| Runtime topology | `runtime-topology-matrix/` | `suite.manifest.json` | 175 |
| State transitions | `state-transition-matrix/` | `suite.manifest.json` | 489 |

Each suite directory contains:
- `suite.manifest.json` (validated against the campaign schema),
- `OVERLAP.md` (canonical overlap record),
- `FINDINGS.md` (production findings and evidence boundaries),
- `cases.ts` (deterministic case table generated from a constrained covering array),
- `*.eval.test.ts` (table-driven protocol tests) and meta tests.

Shared harness code lives in `fixtures/` (covering arrays, independent verifier, golden
coverage examples, call ledger, durable storage, KV/D1/R2/Queue/service-binding fakes, Hono
context adapter, oracles, deterministic clock and keys).

## Mandatory security regressions

- **Authentication / SSO / session / consent matrix** (authorize-matrix): every retained
  row runs through the real `authorizeHandler`; prompt=none never returns interactive UI;
  prompt=login and max_age=0/exceeded force reauth even with SSO disabled; expired,
  revoked, legacy, wrong-tenant, and store-failure sessions are never active; consent
  lookup failures never issue codes; trusted auto-grant writes consent only when missing;
  the exact max_age boundary is judged by an independent time computation; SSO client
  settings override tenant settings and lookup failures inherit the next level while
  remaining ledger-observable.
- **Protocol source / PAR / JAR / PKCE / redirect matrix** (authorize-matrix): every
  retained row runs through the real `authorizeHandler` under a non-default request
  tenant; a valid PAR is consumed only after the user authorizes (never for login UI
  display); expired/replayed/client-mismatch/tenant-mismatch PARs are rejected and their
  error redirects are always query-encoded; malformed, bad-signature, and claims-mismatch
  JARs are rejected directly while a valid signed JAR reaches the flow only after
  signature verification against the client JWKS; request+request_uri conflicts are
  rejected before either container is processed; PKCE S256 is enforced for public and
  require_pkce clients and plain/malformed challenges are rejected for every client;
  response_mode=fragment+code and invalid modes are rejected; a JARM requirement rejects
  non-JWT modes; foreign-tenant clients and sessions are rejected with no cross-tenant
  store access.
- **Oracle hardening** (authorize-matrix, Matrix B): form_post responses are inspected
  for their `<form action>` target, which must exactly equal the registered redirect URI
  for both success and error responses; JARM authorization responses are independently
  verified against the fixed evaluation public key (signature, alg=RS256,
  typ=oauth-authz-resp+jwt, iss, aud, state, iat/exp with the production 600s lifetime)
  and the JARM-embedded code is compared against the persisted authorization code;
  secret-leak scans cover every ledger entry's target and safely-serializable detail
  (excluding only the legitimate delivery surfaces).
- **PKCE authenticated-replay ordering** (token-matrix): an already-used PKCE-bound code with
  registered JTIs is exercised through `POST /token`; missing, malformed, and mismatched
  verifiers are rejected on the generic `invalid_grant` path without replay classification,
  state consumption, or JTI revocation; a later correct verifier reaches authenticated replay
  handling, returns `invalid_grant`, and revokes exactly the registered access and refresh
  JTIs.
- **Client authentication × code ownership/state** (token-matrix, T-A): registered methods
  (none/basic/post/client_secret_jwt/private_key_jwt) × presented credentials
  (none/basic/post/jwt/malformed/conflicting) × client kind (public/confidential/unknown/
  wrong-tenant); authentication failures return before any code read and never consume or
  revoke; fresh/consumed/replayed/expired/malformed/wrong-client/wrong-tenant code states
  and matching/foreign request tenants are exercised through the real handler. Every row
  is checked by the shared observation oracle (`observation.ts`, 20 comparable domains)
  with `Cache-Control`/`Pragma`, durable code-state, ledger, revocation, and secret-leak
  facts, and the same comparator is proven sensitive to every domain on real production
  observations. `client_secret_jwt` is split out of the covering array into a dedicated
  OIDC Core §9 case; the production implementation rejects HMAC shared-secret assertions
  (and asymmetric ones) for `client_secret_jwt`, so that case stays red as exactly one
  retained finding (see `FINDINGS.md`); `private_key_jwt` keeps its asymmetric assertion
  path green. The PKCE authenticated-replay ordering regression seeds the bound code
  directly into durable storage so the consume hydrates the challenge from storage.
- **Grant binding × issuance/postcondition** (token-matrix, T-B): code bindings
  (none/pkce/dpop/pkce+dpop) × PKCE verifier × DPoP proof; PKCE and DPoP binding failures
  never transition a fresh code to used; malformed and replayed DPoP proofs are rejected;
  redirect/resource mismatches never consume; authenticated replays revoke exactly the
  registered JTIs; signing, refresh-family, raced-registration, and revocation failures
  never return a success response; access/ID/refresh tokens are independently
  signature-verified against the fixed evaluation public key, with claim oracles for the
  signing-key `kid`, the left-half SHA-256 `at_hash` computed independently from the
  delivered access token, the configured refresh-token TTL, the JTI registered in the
  durable code record, and `cnf.jkt` matching the presented DPoP proof thumbprint; a
  throwing `createFamilyRpc` fails issuance with no partial postcondition.
- **Runtime topology** (runtime-topology-matrix, 175 cases): five matrices implement the
  six required 3-wise groups literally. Matrix R-A drives the real
  `requestContextMiddleware` on a typed Hono app over the full chain Host/forwarded host →
  request context → tenant existence/lifecycle → vanity binding → signed runtime registry →
  D1 binding ownership → canonical issuer, with deployment mode, host class, forwarded-host
  policy/state, request class (browser/protocol/discovery/internal/**admin**), tenant
  lifecycle, vanity state, registry state, and binding state; a dedicated admin preflight
  table covers matching/missing/foreign/malformed `X-Tenant-Id` × path match × forwarded
  trust with zero foreign-tenant access. Matrix R-B drives
  `resolveTenantDatabaseSourceFromRegistry` for BOTH tenants over signed snapshots
  (valid/missing/expired/payload-tampered/signature-tampered/unknown-kid/unsigned/
  quarantined) × generation × allocation × registry tenant × binding owner × data role ×
  binding state × service route × provider × cache state, and every successful resolution
  exercises the selected binding with a real minimal query whose binding identity is
  observed. Matrix R-C pins route status × cache state × runtime generation
  (a quarantined route is never served from a warm cache). Matrix R-D pins vanity state ×
  canonical issuer state × browser/protocol request. Matrix R-E pins service-binding
  state × forwarded host × tenant context (the binding follows the forwarded-selected
  context tenant; a conflicting forwarded host is rejected by the host-binding policy).
  Observations include the tenant-access set from D1 bind-parameter labels and safe KV key
  shapes (raw parameters and secrets are never logged), binding operations, security
  events, canonical issuer/tenant context state, and secret leaks. The Ed25519 evaluation
  keys are fixed embedded constants. The independent brute-force checker asserts the six
  group legal-triple literals (33/8/9/8/16/13) plus full pair coverage and rejects faulty
  matrices; every mutation ID (11 total) is connected to a production observation field
  and verified against a real production observation.
- **Refresh token family** (state-transition R): create → rotate → revoke across
  absent/active/expired/deleted families; old-version and JTI-mismatch theft both delete
  the family and emit exactly one synchronous critical theft audit; scope expansion
  rejected; TTL boundary counts as expired; read/write/delete storage failures.
- **Device flow** (state-transition D-S/D-T): the real `DeviceCodeStore` and the real
  `tokenHandler` for store → approve → issue, store → deny → delete, expired/alarm
  cleanup, slow_down polling, wrong client rejection, and the mark-issued reservation
  boundary.
- **CIBA** (state-transition C-S/C-T): the real `CIBARequestStore` and the real
  `tokenHandler` for poll/ping/push, nonce/ACR propagation into the issued ID token, and
  the strict reservation fail-closed boundary (zero signing, zero refresh family, zero
  issued-token registration) for every non-success reservation shape.
- **Queue delivery** (state-transition Q-A/Q-D/Q-L): the production audit, DLQ, and
  logging-delivery consumers with EVERY ack/retry call counted (first-call-wins
  effective disposition), mixed-batch isolation, unsupported-schema DLQ-before-ack,
  malformed retry, REAL duplicate redelivery (two deliveries over the same durable
  state), forward/reverse out-of-order batches through all three consumers, REAL
  Message.attempts propagation, and binding/archive failure modes.
- **Strict findings** (state-transition): redelivery of fanout/chunk-write/future-schema/
  DLQ-save messages duplicates durable effects (new clock-derived records/objects per
  delivery); 9 rows fail strictly and are documented in `FINDINGS.md`.
- **Independent checker** (state-transition meta): reviewer-owned predicates re-derived
  from the production sources with fixed legal-pair literals, 100% legal-pair and
  required-triple coverage, faulty-matrix rejection, unique ids/fingerprints, pinned
  covering-array counts, a reviewer-owned dimension-effect audit, and every mutation ID
  connected to its exact production path with the representative condition asserted
  before the run.

## Node-contract evidence boundary

Tests run real production handlers, state owners, and consumers over in-memory fakes. They
prove branch decisions, protocol results, call ordering, storage operations, fail-closed
handling, and instance reconstruction over the same fake storage. They do **not** prove
Cloudflare Workers scheduling, Durable Object input-gate serialization, atomicity, crash or
restart recovery, real alarms, real Queue retry delivery, D1 transactions, KV eventual
consistency, or service-binding transport. Those are documented as non-collected real-runtime
obligations in each suite's `FINDINGS.md`.

## Validation

```sh
node private/test-ai-evaluation/check-boundary.mjs
node private/test-ai-evaluation/check-collection.mjs
pnpm exec tsc --noEmit -p private/test-ai-evaluation/tsconfig.json
AUTHRIM_AI_EVALUATION_NETWORK=disabled pnpm exec vitest list --config private/test-ai-evaluation/vitest.config.ts --filesOnly
AUTHRIM_AI_EVALUATION_NETWORK=disabled pnpm exec vitest run --config private/test-ai-evaluation/vitest.config.ts
git diff --check -- test/ai-evaluation
```

## Provenance

- Provider: `opencode-go`
- Model: `deepseek-v4-flash`
- Run ID: `deepseek-v4-flash-build-20260813-01`
- Generated at: `2026-08-13T12:00:00.000Z`
