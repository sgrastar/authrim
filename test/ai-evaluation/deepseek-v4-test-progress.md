) | 174 |# DeepSeek V4 Flash 0731 — AI evaluation build progress ledger

Resumability ledger for the DeepSeek build session of the Authrim AI evaluation campaign.
This is not a substitute for the tests; it tracks checkpoint completion and exact remaining
obligations.

## Run metadata

- Provider: `opencode-go` (alias `opencode-go/deepseek-v4-flash`)
- Model label requested: DeepSeek V4 Flash 0731. No `0731` snapshot identifier is claimed;
  the provider exposed only the alias. Provenance uses the exact campaign values.
- Run ID: `deepseek-v4-flash-build-20260813-01`
- Generated at: `2026-08-12T22:19:04.000Z`
- Generated root: `test/ai-evaluation/`

## Completed checkpoints

### 1. Shared harness (`fixtures/`)

Files:
- `fixtures/coverage-golden.ts` — verbatim copy of the reviewer-owned golden values.
- `fixtures/covering-array.ts` — deterministic constrained covering-array generator.
- `fixtures/coverage-verifier.ts` — independent brute-force verifier (does not import the
  generator's enumeration) plus `runBinaryGoldenChecks`.
- `fixtures/case-fingerprint.ts` — stable IDs, semantic fingerprints, duplicate detection.
- `fixtures/deterministic-clock.ts` — pinned `Date.now` with install/restore helpers.
- `fixtures/fixed-keys.ts` — process-local fixed RSA signing key.
- `fixtures/call-ledger.ts` — call ledger and ledger-backed `ExecutionContext` with drain.
- `fixtures/durable-storage.ts` — in-memory Durable Object storage/state.
- `fixtures/kv.ts`, `d1-adapter.ts`, `r2.ts`, `queue.ts`, `service-binding.ts`,
  `do-namespace.ts` — transport/persistence fakes.
- `fixtures/hono-context.ts` — real Hono apps registering the production handlers at their
  exact routes with context-seeding middleware.
- `fixtures/env.ts` — fake Env builder wiring all bindings to real DO instances over fake
  storage.
- `fixtures/oracles.ts` — response/claims/ledger/secret-leakage oracles.
- `fixtures/request-runner.ts` — request runner helper.

Obligations covered: golden coverage counts reproduced independently, covering-array
generation, fingerprinting, ledger execution context, instance reconstruction.

### 2. authorize-matrix

- `authorize-matrix/suite.manifest.json`
- `authorize-matrix/cases.ts` — generated covering array over
  `requestSource × clientType × redirectValid × responseType`.
- `authorize-matrix/authorize.eval.test.ts` — real `authorizeHandler` on `GET /authorize`
  for request/request_uri conflict, response-type validation, unknown client, redirect
  safety, malformed PAR, plus table rows.
- `authorize-matrix/OVERLAP.md`, `authorize-matrix/FINDINGS.md`
- Collected: 33. Baseline green.

### 2b. authorize-matrix — authentication / SSO / session / consent matrix (Matrix A)

- `authorize-matrix/authn-matrix.ts` — generated covering array over
  `clientSso × tenantSso × session × prompt × maxAge × consent` (137 rows) with the two
  declared constraints re-verified against production reachability and the required
  triples `clientSso × tenantSso × session`, `prompt × session × maxAge`, and
  `prompt × consent × session`.
- `authorize-matrix/decision.ts` (authn section) — independent decision oracle corrected
  against the production source: legacy sharded cookies still read the session store;
  prompt=login and max_age=0/exceeded force reauth even with SSO disabled; malformed
  max_age resets all session-read flags; challenge metadata uses the production camelCase
  `sessionUserId` key.
- `authorize-matrix/seed.ts` (authn part) — SSO settings seeded with the production
  dotted keys (`client.sso_enabled` / `oauth.sso_enabled`); consent dimensions seeded
  with the correct scope sets (sufficient/expired = full request scope, insufficient =
  strictly narrower).
- `authorize-matrix/authn.eval.test.ts` — every row runs through the real
  `authorizeHandler` on a typed Hono app with a real `Request`, frozen `Env`,
  ledger-backed `ExecutionContext` and drained `waitUntil`; asserts HTTP status,
  error/success response, Location correctness, challenge type and stored metadata,
  authorization-code creation or confirmed absence, consent lookup/write presence,
  session-read presence, absence of cross-tenant store access, and secret redaction.
  Meta tests: 100% legal pair coverage, 100% required-triple coverage, unique
  ids/fingerprints, discriminating mutation witnesses per case, oracle sensitivity
  against locally corrupted observations per outcome family, independent exact-boundary
  time check, and the reviewer binary coverage golden.
- Collected: 147 (137 rows + 4 dedicated boundary preflights + 6 meta). Suite total then
  180; overall then 242. Baseline green. The protocol-source / PAR / JAR matrix (Matrix B)
  is implemented in the next checkpoint.

### 2c. authorize-matrix — protocol source / PAR / JAR / PKCE / redirect matrix (Matrix B)

- `authorize-matrix/protocol-matrix.ts` — generated covering array over
  `source × containerState × clientType × clientBinding × pkce × responseType ×
  responseMode × redirectValid × jarmRequirement × phase × sessionBinding` (74 rows)
  with the six declared constraints re-verified against production reachability and the
  four required triples (`source × clientBinding × sessionBinding`, `clientType × pkce ×
  responseType`, `responseType × responseMode × jarmRequirement`, `redirectValid × phase
  × responseMode`).
- `authorize-matrix/decision.ts` (protocol section) — independent decision oracle
  corrected against production: PAR-failure error redirects are always query-encoded;
  `validateResponseType` rejects `token`; JAR failures never redirect; the
  request+request_uri conflict precedes any PAR read; error-redirect outcomes carry the
  redirect target (`registered` vs `unvalidated`) for target pinning.
- `authorize-matrix/seed.ts` (protocol part) — PAR expiry seeded with a zero TTL under
  the frozen clock; `seedParTenantMismatch` writes the conflicting record directly to
  durable storage so the live PARRequestStore instance observes the overridden tenant;
  `seedForeignTenantSession`/`seedConsentDimension` accept a request-tenant parameter.
- `authorize-matrix/protocol.eval.test.ts` — every row runs through the real
  `authorizeHandler` under the non-default request tenant `tenant-b` with a real
  `Request`, frozen `Env`, ledger-backed `ExecutionContext` and drained `waitUntil`;
  asserts HTTP status, OAuth error/success result, Location target and shape, code/state/
  iss/response-mode/JARM shape, authorization-code creation or confirmed absence, PAR
  read/consume or confirmed absence, challenge creation or absence, absence of
  cross-tenant store access, and secret redaction. Dedicated preflights pin the valid-PAR
  consume path, the login-UI non-consume path, the valid signed-JAR path, the JARM
  requirement gate and JARM success, and query-encoded PAR-failure redirects.
  Meta tests: 100% legal pair coverage, 100% required-triple coverage, unique
  ids/fingerprints, pinned expected case count (74), discriminating mutation witnesses
  per case, oracle sensitivity against locally corrupted observations per outcome family
  (including preflight-only families), and the reviewer binary coverage golden.
- Collected: 89 (74 rows + 7 dedicated boundary preflights + 8 meta). Suite total 269;
  overall 331. Baseline green.

### 2d. authorize-matrix — Matrix B oracle hardening (final acceptance prep)

- `protocol.eval.test.ts`:
  - form_post: `<form action>` extraction (attribute-order independent) stored in the
    observation `target`/`formAction`; success and error responses must post exactly to
    the registered redirect URI (preflights `proto-boundary-006`/`007`); the
    `form-action` corruption domain is covered by oracle sensitivity.
  - JARM: the authorization-response JWT is independently verified with jose against the
    fixed evaluation public key (signature, alg=RS256, typ=oauth-authz-resp+jwt, iss,
    aud, state, numeric iat/exp with the production 600s lifetime); the JARM-embedded
    code is compared internally against the persisted authorization code
    (`jarmCodeMatchesPersisted`); a dedicated meta test proves broken signatures, wrong
    alg, wrong iss/aud/state, and expiry anomalies are all rejected.
  - secret-leak: every ledger entry's target and safely-serializable detail is scanned;
    legitimate delivery surfaces (Location code/JARM token, form_post body code,
    AuthorizationCodeStore `code:` storage labels) are explicitly excluded; the report
    scope is limited to the inspected event kinds and the checked secrets.
- `suite.manifest.json`: dimensions normalized (Matrix B `protoClientType` includes
  `requires-pkce`, `protoResponseType` includes `none`; the legacy request-source matrix
  axes are separated as `legacyClientType`/`legacyResponseType`/`legacyRedirectValid`),
  subject extended with PARRequestStore/ChallengeStore/SessionStore/
  SessionRevocationStore, expected_case_count 269.
- Collected: 89 (74 rows + 7 boundary preflights + 8 meta). Suite total 269; overall 331.
  Baseline green.

### 3. token-matrix

- `token-matrix/suite.manifest.json`
- `token-matrix/cases.ts` — generated covering arrays for Matrix T-A
  (`registeredMethod × presented × client × codeState × requestTenant`, 112 rows after
  the `client_secret_jwt` split) and Matrix T-B (`codeBinding × pkce × redirect ×
  resource × dpop × downstream × replayState × jtiState`, 96 rows), each with appended
  success/replay rows that the greedy covering array otherwise never selects, plus
  independent decision tables (`decideTokenA`/`decideTokenB`) and discriminating
  mutation witnesses.
- `token-matrix/observation.ts` — shared observation oracle: every request is normalized
  into a `TokenObservation` (status, error, cache headers, consume-reached, durable used
  flag, registration/family/revocation counts, family tenant, foreign-tenant access,
  secret-leak, and token claim booleans: kid, at_hash, refresh TTL, JTI registration,
  cnf.jkt, scope, auth_time, nonce) checked by a pure 20-domain comparator.
- `token-matrix/token-a.eval.test.ts` — Matrix T-A through the real `tokenHandler` on
  `POST /token`, every row verified against the observation oracle plus an
  oracle-sensitivity meta test that corrupts each domain of a REAL production
  observation and proves the same comparator rejects it; registered authentication
  methods × presented credentials × client kind; authentication failures return before
  any code read; code states
  fresh/consumed/replayed/expired/malformed/wrong-client/wrong-tenant; matching/foreign
  request tenants; T-A order boundaries (malformed-before-credential-failure and
  credential-failure-before-code-ownership) as explicit cases; the mandatory PKCE
  authenticated-replay ordering regression preserved (the bound code is now seeded
  directly into durable storage so the consume hydrates the challenge); the dedicated
  OIDC Core §9 `client_secret_jwt` case (HMAC assertions, wrong secret, and asymmetric
  method misuse) whose correct-HMAC success is **retained as the one deliberate
  finding** (production rejects both HS256 and asymmetric assertions; see FINDINGS.md);
  `private_key_jwt` rejects HMAC assertions.
- `token-matrix/token-b.eval.test.ts` — Matrix T-B through the real `tokenHandler`,
  every row verified against the observation oracle with claim oracles: signing-key
  `kid`, left-half SHA-256 `at_hash` computed independently from the delivered access
  token, the configured refresh-token TTL (REFRESH_TOKEN_EXPIRY=2592000), the issued
  JTI registered in the durable code record, and `cnf.jkt` matching the presented DPoP
  proof thumbprint; binding failures never transition a fresh code to used; replay ×
  registered-JTI × revocation outcome; downstream failure injection (signing,
  refresh-family shard-config KV, raced registration rejection, revocation store) plus a
  throwing `createFamilyRpc` that fails issuance with no partial postcondition;
  oracle-sensitivity and mutation-witness meta tests.
- `token-matrix/smoke.eval.test.ts` — independent coverage checker: literal legal-pair
  and required-triple counts (T-A 182/87 after the `client_secret_jwt` split — was
  190/90 —, T-B 399/120), 100% legal 2-way tuple coverage and 100% required-triple
  coverage for both matrices via an independent predicate enumeration, combination
  sets, faulty-matrix rejection (dropped legal triples and over-constrained pairs), and
  case-count pins (T-A 112, T-B 96).
- `token-matrix/OVERLAP.md`, `token-matrix/FINDINGS.md`
- Collected: 237 (T-A 123 + T-B 99 + meta/smoke 15). Green except the one retained
  `client_secret_jwt` §9 finding (deliberate). The 29-case legacy covering array and its
  test file were replaced by this split; the PKCE replay ordering regression is
  preserved.

### 4. runtime-topology-matrix (expanded — six required groups, admin, strict snapshot paths, fixed keys)

- `runtime-topology-matrix/suite.manifest.json` — five matrices (R-A 49, R-B 48, R-C 9,
  R-D 16, R-E 13 rows), expected_case_count 175.
- `runtime-topology-matrix/cases.ts` — Matrix R-A over `deploymentMode × hostClass ×
  forwardedPolicy × forwardedState × requestClass(+admin) × tenantLifecycle × vanityState
  × registryState × bindingState` (constraints grounded in `request-context.ts`), Matrix
  R-B over `tenantHost × snapshotState(8, incl. payload-tampered/signature-tampered/
  unknown-kid/unsigned) × generationState × allocationScope × registryTenant ×
  bindingOwner × dataRole × bindingState × serviceRoute × provider × cacheState` for BOTH
  tenants (constraints grounded in `tenant-database-resolver.ts`), Matrix R-C (route
  status × cache × generation), Matrix R-D (vanity × canonical issuer × browser/protocol),
  and Matrix R-E (service binding × forwarded host × tenant context), with independent
  decision tables and per-row mutation witnesses.
- The six required 3-wise groups are implemented literally (not substituted):
  G1 host × forwarded-host policy × request class (33 legal triples, incl. admin),
  G2 host tenant × registry tenant × binding owner (8), G3 route status × cache state ×
  runtime generation (9), G4 allocation scope × owner tenant × data role (8), G5 vanity
  state × canonical issuer × browser/protocol request (16), G6 service-binding state ×
  forwarded host × tenant context (13); each is verified 100% covered by an independent
  brute-force checker with reviewer-owned literals.
- `runtime-topology-matrix/ra.eval.test.ts` — R-A rows through the real
  `requestContextMiddleware` (probe via `getRequestContext`/`getRequestIssuer`), plus a
  dedicated admin preflight table (matching/missing/foreign/malformed X-Tenant-Id × path
  match × forwarded trust, zero foreign-tenant access) and oracle-sensitivity/mutation
  meta tests.
- `runtime-topology-matrix/rb.eval.test.ts` + `rb-harness.ts` — R-B rows through the real
  `resolveTenantDatabaseSourceFromRegistry` with request-local options; every successful
  resolution exercises the selected binding with a real `SELECT 1` and the binding
  identity (DB/DB_PII/DB_LOGIN) is observed via wrapper labels; warm/warm-stale cache
  semantics are asserted, and the resolver-failure empty-cache invariant is asserted
  (a binding-access failure leaves the request cache populated because the resolver
  already succeeded; the outcome is still fail-closed and is never treated as a success
  route).
- `runtime-topology-matrix/rc.eval.test.ts` — route status × cache × generation rows
  including the quarantined-after-warm regression.
- `runtime-topology-matrix/rd.eval.test.ts` — vanity × canonical issuer ×
  browser/protocol rows (tenant-canonical / primary-naked / active-vanity / mismatched /
  unavailable).
- `runtime-topology-matrix/re.eval.test.ts` — service binding × forwarded host × tenant
  context rows; a conflicting forwarded host selects the foreign context and its binding,
  which the host-binding policy then rejects (foreign context never silently accepted).
- `runtime-topology-matrix/observation.ts` — shared pure comparator and per-domain
  corruption helpers for both observation shapes (21 R-A / 16 R-B comparable domains).
- `runtime-topology-matrix/tenant-ledger-adapter.ts` + `routing-env.ts` — tenant-aware D1
  instrumentation: safe tenant-routing labels (`alpha`/`beta`/`default`) recorded from
  bind parameters (raw parameters and secrets never logged) plus safe KV key-shape
  extraction, normalized into a tenant-access set per row.
- `runtime-topology-matrix/registry-fixtures.ts` — FIXED embedded Ed25519 key pairs
  (primary kid `ai-eval-runtime-registry-kid-001`; second kid `ai-eval-runtime-registry-
  kid-002` never in the verification JWKS, used for the unknown-kid path), snapshot
  builder/signer, and a signature-corruption helper that flips a middle signature byte
  (the last-character base64url padding-bit defect found in the previous fixture is
  documented in FINDINGS.md).
- `runtime-topology-matrix/meta.eval.test.ts` — independent checker with reviewer-owned
  literals (R-A 365 / R-B 350 legal pairs; group literals 33/8/9/8/16/13), generator↔
  independent set equality for all five matrices, faulty-matrix rejection (dropped pair,
  dropped triple, wrong constraint), duplicate id/fingerprint rejection, case-count pins,
  fixture fixity (fixed key, deterministic signature, no private material in the JWKS,
  no hostname false positives in tenant extraction), and the 11-mutation catalog
  connected to real production observations (common assertion passes, then the mapped
  field is corrupted in the REAL observation and the same assertion rejects).
- `runtime-topology-matrix/OVERLAP.md`, `runtime-topology-matrix/FINDINGS.md` — overlap
  record, constraint re-audit with production-reachability classification (A/B/C), the
  production-ambiguity note for `invalid_snapshot_signature`, the 11-mutation catalog,
  and the Node-contract evidence boundary.
- Collected: 175 (R-A 49 + 12 dedicated/meta; R-B 48 + 2; R-C 9 + 3; R-D 16 + 2; R-E 13 +
  3; coverage/fixture/mutation meta 17). Baseline green; the one `client_secret_jwt` §9
  finding in token-matrix remains the only failure in the overall run.

### 5. state-transition-matrix

- `state-transition-matrix/suite.manifest.json`
- `state-transition-matrix/cases.ts` — eight covering-array matrices over the real
  production state owners, token endpoint, and queue consumers (458 rows + dedicated
  appended rows that reach the theft/unsupported-schema edges):
  - R (refresh token family, 77 rows): `familyState × operation × versionRelation ×
    jtiRelation × clientBinding × tenantBinding × scopeRelation × storageOutcome ×
    instanceState × sequence × ttlState`. `sequence=repeated/replay` rows execute a REAL
    first rotate (v1 → v2) before the matrix operation; `instanceState=reconstructed`
    rows run the matrix operation on a NEW production DO over the SAME storage.
  - D-S (device flow store owner, 38 rows): `state × operation × clientBinding ×
    tenantBinding × expiry × reservationResult` — forbidden approve/deny edges fail
    closed.
  - D-T (device flow token endpoint, 65 rows): `state × clientBinding × tenantBinding ×
    pollingTiming × attempt × reservationResult × expiry × tokenOutcome`.
  - C-S (CIBA store owner, 87 rows): `deliveryMode × state × operation × nonce × acr ×
    approvalResult × tenantBinding × reservationResult`.
  - C-T (CIBA token endpoint, 86 rows): `deliveryMode × state × pollingTiming × attempt ×
    nonce × acr × clientAuth × clientBinding × tenantBinding × reservationResult ×
    tokenOutcome`.
  - Q-A (audit queue consumer, 33 rows), Q-D (DLQ consumer, 21 rows), Q-L (logging-delivery
    consumer, 51 rows): `batchComposition × attempt × delivery × bindingState × tenant ×
    dlqArchive × payloadFamily` (+ `schema × lane` for Q-L). `delivery=duplicate` executes
    a REAL redelivery (same message twice over the same durable state, clock advanced);
    `Message.attempts` reflects the attempt axis.
- `state-transition-matrix/harness.ts` — failure-injectable storage, ledger-captured
  waitUntil DO state, real-class local namespace, D1 wrapper with param recording,
  MessageBatch fakes with EVERY ack/retry call counted (ackCalls/retryCalls +
  first-call-wins effective disposition), and a capturing structured logger.
- `state-transition-matrix/{refresh,device,ciba,queue}-observation.ts` — shared
  seed/run/observe helpers used by the eval files AND the meta test.
- `state-transition-matrix/refresh.eval.test.ts` — REAL `RefreshTokenRotator` over
  failure-injectable storage; every row asserts family state from the storage snapshot,
  theft ⇒ family deletion + exactly one synchronous critical audit, scope expansion
  rejection, tenant pinning, storage failure paths, REAL first-rotate sequence
  execution, REAL instance reconstruction over the same storage, and an
  oracle-sensitivity meta test that corrupts each domain of a REAL observation.
- `state-transition-matrix/device.eval.test.ts` — REAL `DeviceCodeStore` (D-S) and the
  real `tokenHandler` (D-T) for store → approve → issue, deny → delete, forbidden
  edges fail closed, expired/alarm cleanup, slow_down polling, wrong client,
  reservation fail-closed.
- `state-transition-matrix/ciba.eval.test.ts` — REAL `CIBARequestStore` (C-S) and the
  real `tokenHandler` (C-T): poll/ping/push, nonce/ACR propagation into the issued ID
  token (verified by decoding the real token), and the strict reservation fail-closed
  boundary (zero signing, zero refresh family, zero issued-token registration) for every
  non-success reservation shape.
- `state-transition-matrix/queue.eval.test.ts` — production `processAuditQueue` /
  `processDLQQueue` / `processLoggingDeliveryQueue` with every ack/retry call counted
  (ackCalls+retryCalls ≥ 1, never both positive, effective disposition one of
  ack/retry), mixed-batch isolation, unsupported-schema DLQ-before-ack, REAL duplicate
  redelivery over the same durable state, REAL Message.attempts, binding/archive failure
  modes, and a non-vacuous canary secret-leak oracle (logger + D1 params + R2 keys/
  metadata/bodies, including DLQ archives, + error surfaces). The canary is injected
  only as the encryption-root credential and is absent from message data. A forward/
  reverse two-message probe exercises out-of-order delivery through all three production
  consumers.
- `state-transition-matrix/meta.eval.test.ts` — independent checker with reviewer-owned
  literals re-derived from the production sources (fixed legal-pair counts), generator↔
  independent set equality for all eight matrices, 100% legal-pair and required-triple
  coverage, faulty-matrix rejection (dropped pair, dropped triple, wrong constraint),
  unique id/fingerprint rejection, pinned covering-array case counts, a reviewer-owned
  dimension-effect audit (every retained dimension changes production input / operation
  sequence / DO instance / failure injection / observation), and the 11-mutation catalog
  connected to its exact production path: the representative condition is asserted
  before the run and the mapped observation domain is corrupted in the REAL observation
  and rejected by the common assertion.
- `state-transition-matrix/OVERLAP.md`, `state-transition-matrix/FINDINGS.md` — overlap
  record, production-behavior/evidence-boundary notes, and the strict failing findings:
  redelivery of fanout/chunk-write/future-schema/DLQ-save messages duplicates durable
  effects (9 strict failing rows, see FINDINGS.md).
- Collected: 489 (458 covering-array rows + 31 dedicated/meta tests). Baseline green
  except the 9 documented strict production findings; the single deliberate
  `client_secret_jwt` §9 finding remains confined to token-matrix.

### 6. Cross-suite metadata

- `README.md` — generated suite documentation.
- `deepseek-v4-test-progress.md` — this ledger.

## Validation commands and results

All run from the repository root.

- `node private/test-ai-evaluation/check-boundary.mjs` — PASS (17 quarantined test files,
  4 manifests).
- `node private/test-ai-evaluation/check-collection.mjs` — PASS (1170 cases, 4 manifests;
  token-matrix 237, authorize-matrix 269, runtime-topology-matrix 175,
  state-transition-matrix 489).
- `pnpm exec tsc --noEmit -p private/test-ai-evaluation/tsconfig.json` — PASS.
- `AUTHRIM_AI_EVALUATION_NETWORK=disabled pnpm exec vitest list --config
  private/test-ai-evaluation/vitest.config.ts --filesOnly` — PASS (17 files listed).
- `AUTHRIM_AI_EVALUATION_NETWORK=disabled pnpm exec vitest run --config
  private/test-ai-evaluation/vitest.config.ts` — 1156 passed / 14 failed across 1170
  cases: the single deliberate `client_secret_jwt` §9 finding in token-matrix, the 9
  documented state-transition strict findings (redelivery duplicates durable effects),
  and the 4 environment-induced runtime-topology R-A failures from the uncommitted
  `request-context.ts` change (reported as external state).
- State-transition alone completed three separate runs with the identical result:
  480 passed / 9 strict documented findings out of 489 cases.
- `git diff --check -- test/ai-evaluation` — PASS.

## Resolved production finding

The CIBA reservation fail-closed invariant (previously `state-transition-matrix/state-012`)
was resolved by a separately authorized production fix. The identical strict regression
now passes unchanged within the C-T matrix across every non-success reservation shape
(assertions were not modified, inverted, skipped, or softened): a non-successful
`mark-token-issued` reservation that is not classified as `already issued` returns an
OAuth error with zero token signing, zero refresh-family creation, zero issued-token
registration, and no token material. Resolution evidence is recorded in
`state-transition-matrix/FINDINGS.md`. This is a Node-level sequential verification; it
does not prove real Cloudflare input-gate serialization or concurrent request
serialization.

## Environment note (uncommitted production change vs runtime-topology)

At verification time, the working tree contains an uncommitted change to
`packages/ar-lib-core/src/middleware/request-context.ts` (adds `discovery_ui` to
`shouldResolveTenantDataContexts`). Under that change, four runtime-topology R-A cases
(`topo-ra-004`, `topo-ra-026`, `topo-ra-043`, and the R-A oracle-sensitivity meta test)
fail because discovery-request-class rows now resolve tenant data contexts
(`missing_generation` 409) where the runtime-topology matrix expects no tenant context.
With the change stashed, the R-A suite is green (61/61).

- This change was NOT made by the state-transition rework; it pre-exists in the
  working tree (`fix/oauth-oidc-security-invariants`).
- The state-transition suite has the same result BOTH with and without the change (480
  passed, with only the 9 documented strict findings in both cases), so the rework itself is
  unaffected.
- Per user decision, the R-A failures are reported as-is (environment-induced by the
  uncommitted production change) and are not masked, modified, or re-certified here.

## Non-collected real-runtime obligations

Sequential fake calls do not prove Durable Object concurrency/atomicity, crash/restart
recovery, real alarms, real Queue retry delivery, D1 transactions, KV eventual consistency,
or service-binding transport. These are documented per suite in `FINDINGS.md` and are not
claimed.

## Remaining work

- Cross-suite oracle-sensitivity meta-checks and the targeted source-mutant catalog runs
  remain the campaign orchestrator's acceptance steps (builder must not apply source
  mutants).
