# Runtime-Topology Matrix — Findings

## Status

Baseline green for the expanded cross-layer chain (175 collected cases; R-A request
routing 49 rows + 11 dedicated/meta, R-B registry/binding 48 rows + 2 meta, R-C route
status 9 rows + 3, R-D canonical issuer 16 rows + 2, R-E service binding × forwarded ×
tenant context 13 rows + 3, coverage/fixture/mutation meta 17).

The suite drives the production chain `Host/forwarded host → request context → tenant
existence/lifecycle → vanity binding → signed runtime registry → D1 binding ownership →
canonical issuer/service route` through the real `requestContextMiddleware` (R-A, R-D,
R-E) and the real `resolveTenantDatabaseSourceFromRegistry` (R-B, R-C).

## Node-contract evidence boundary

The suite proves the following in Node with real `Request` objects, a typed Hono app,
fresh env objects with pinned time (production bindings are mutable by design, so the
suite freezes the clock, not the env), ledger-backed execution contexts, and the exported
production resolvers:

- forwarded-host / Host precedence exactly as implemented (`AUTHRIM_TRUST_FORWARDED_HOST`
  wins with a normalized `X-Authrim-Forwarded-Host`; otherwise the normalized `Host` wins
  before `getRequestHost` fallbacks);
- tenant resolution and lifecycle fail-closed (inactive/missing tenants never become
  active; unresolvable hosts reject before registry interaction; reserved UI host resets
  to the default tenant);
- vanity resolution through the KV-cache + D1 revalidation path (inactive aliases,
  non-primary aliases, and cross-tenant cached rows fail closed; browser 308
  canonicalization vs protocol 404; the canonical issuer state is observed per row);
- the six required 3-wise groups are implemented as explicit matrices and covered 100%
  (G1 host × forwarded-host policy × request class including admin: 33 legal triples;
  G2 host tenant × registry tenant × binding owner for BOTH tenants: 8; G3 route status ×
  cache state × runtime generation: 9; G4 allocation scope × owner tenant × data role: 8;
  G5 vanity state × canonical issuer × browser/protocol request: 16; G6 service-binding
  state × forwarded host × tenant context: 13);
- signed runtime-registry verification with STRICT separation of the four verification
  paths: payload tampered after signing, signature bytes tampered, unknown kid (a valid
  JWS signed with a key whose kid is absent from the verification JWKS), and unsigned —
  all fail closed with `invalid_snapshot_signature` and a security event; expired →
  `expired_snapshot`; quarantined → `quarantined_route`; missing → `missing_snapshot`;
  generation stale/ahead/missing fail closed;
- binding ownership and allocation (shared_pool ⇒ owner null, tenant_exclusive ⇒ owner ==
  tenant enforced by snapshot parsing; unsupported provider parse-fails; missing/wrong-type
  binding → `missing_binding` with health event and no common-DB fallback; a throwing
  binding transport is observed failing closed at the tenant-exists check);
- warm / warm-stale request-cache semantics (same-generation reuse; generation advance
  evicts and re-resolves; a route that becomes quarantined after a warm resolution is
  never served from the cache);
- the actual binding operation is exercised after every successful resolution (a minimal
  `SELECT 1` on the selected DatabaseSource) and the binding identity is observed in the
  ledger (DB / DB_PII / DB_LOGIN are distinct wrappers);
- no foreign-tenant registry/binding access, no signature/JWK material in errors, ledger,
  or responses. Foreign-tenant D1 access is detected via safe tenant-routing labels
  recorded from bind parameters (raw parameters and secrets are never logged) plus safe
  KV key-shape extraction.

## Binding-access failure cache contract

The request-local cache contract differs by failure stage, and the suite asserts the
distinction:

- **Resolver failures** (missing/wrong-type bindings, invalid snapshots, generation or
  route failures, unsupported providers, missing generation/snapshot): the resolver
  itself fails before caching, so the request cache is EMPTY after the failure and no
  partial cache write occurs.
- **Binding-access failures** (`throws` rows): the resolver has already SUCCEEDED and
  written the resolved binding into the request-local cache; the real `SELECT 1` on the
  selected binding then throws. The HTTP/observation outcome is fail-closed
  (`binding_access_threw`, no success route, no binding operation recorded), but the
  request cache legitimately retains the resolution from the earlier successful stage.
  The suite does NOT empty the cache for this case, and the oracle treats the outcome as
  an error with `errorCode=binding_access_threw`.
- This Node-level distinction is not a proof of real Cloudflare service-binding transport;
  it only documents which production stage failed and what the resolver had already
  persisted in memory.

It does **not** prove Cloudflare service-binding transport, D1 transaction semantics, KV
eventual consistency, regional cache behavior, concurrent request ordering, real Worker
binding-type enforcement, or platform outage/latency. Those are non-collected real-runtime
obligations; no claim is made for them.

## Constraint re-audit (production reachability)

Each constraint below is classified as (A) production-reachable and observable only in
that combination, (B) reachable but later-stage failures make the deeper layers
unobservable (kept minimal so the failure attributes to the layer under test), or (C) a
semantic duplicate removed from the legal set. Constraints that merely enforce the
minimal resolvable shape for failure attribution are class (B); none of the constraints
hides a production-reachable security interaction, and no tuple is dropped "for minimal
failure shape" without the layered-failure justification.

### Matrix R-A (`cases.ts` → `request-context.ts`)

| Constraint                                                                                                                            | Class | Production branch / rationale                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| single-tenant rows keep unrelated-host browser/protocol shapes with registry state free                                               | B     | `isMultiTenantEnabled(env)` guards every host/vanity/registry/binding block; the protocol path still resolves default-tenant metadata, so the registry state is observable             |
| discovery/internal allow unknown tenants; discovery resolves tenant metadata while internal health does not                         | A     | `allowUnknownTenant`; `shouldResolveTenantDataContexts` includes discovery, so unresolved discovery uses default-tenant metadata and canonical discovery reaches tenant existence     |
| active-vanity requires active tenant + signed registry; canonical/cross-tenant states only                                            | B     | `resolveTenantFromVanityHost` requires the signed default store before the D1 revalidation; an invalid registry would misattribute the failure                                         |
| inactive-vanity-alias requires a valid registry                                                                                       | B     | same layered-failure attribution                                                                                                                                                       |
| non-primary-alias resolves through vanity then fails tenant binding policy                                                            | A     | `validateTenantRequestBinding` allows only canonical host + primary vanity                                                                                                             |
| reserved UI host resets resolution to default                                                                                         | A     | `isReservedUiHost` clears success and the error before the failure branch                                                                                                              |
| sub-subdomain/malformed/missing/unrelated hosts reject before registry/vanity interaction (protocol rows)                             | B     | `validateHostHeader` rejects before any storage access; unrelated/missing additionally appear in the discovery/internal shapes                                                         |
| naked/uppercase/port resolve to a tenant; registry must be valid                                                                      | B     | the middleware primary-vanity block still runs for every resolved host, so the registry must resolve first                                                                             |
| admin rows pin the tenant via X-Tenant-Id; forwarded state shapes the issuer only                                                     | A     | `requestClass === 'tenant_scoped_admin'` is exempt from the resolution-failure branch and overrides `tenantId` from the header; the forwarded host only shapes `buildRequestIssuerUrl` |
| canonical subdomain shapes (trusted forwarded wins only when configured; `tenant_not_found` never falls back to forwarded)            | A     | `resolveTenantFromRequest` precedence                                                                                                                                                  |

### Matrix R-B (`cases.ts` → `tenant-database-resolver.ts`)

| Constraint                                                                                                                                                                      | Class | Production branch / rationale                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| warm/warm-stale require a previously resolved success                                                                                                                           | B     | the request cache only ever holds entries from prior successes; a first-call failure makes the cache state unobservable                                                                            |
| foreign registry tenant is signature-valid but names another tenant                                                                                                             | A     | `snapshot.tenantId !== options.tenantId` → `invalid_snapshot_signature`, no security event; exercised for BOTH alpha and beta hosts                                                                |
| tenant_exclusive owner mismatch / shared_pool owner non-null parse-fail                                                                                                         | A     | `parseRuntimeRegistrySnapshot` owner contract; exercised for both tenants                                                                                                                          |
| unsupported provider fails closed during parsing                                                                                                                                | A     | `parseRuntimeRegistrySnapshot` requires `store.provider === 'd1'` → `invalid_route_contract`                                                                                                       |
| non-valid snapshots (expired/payload-tampered/signature-tampered/unknown-kid/unsigned/quarantined/missing) exercised with matching generation over the minimal resolvable shape | B     | each failure must attribute to the snapshot layer, so generation/owner/provider/binding/route layers are kept valid                                                                                |
| stale/ahead/missing generations require a signature-valid snapshot                                                                                                              | B     | the generation checks run after signature verification; an invalid signature would misattribute                                                                                                    |
| missing/wrong-type/throws bindings require a valid snapshot and matching generation                                                                                             | B     | `getBinding` is reached only after snapshot verification                                                                                                                                           |
| unavailable route ⇒ missing binding; login-ui ⇒ core-default; pii ⇒ dedicated PII service binding; core-users ⇒ issuer-hosted UI binding                                        | A     | the bindingRef labels carried by the snapshot for each route/data-role pair                                                                                                                        |
| beta tenant is NOT restricted to a success shape                                                                                                                                | —     | the previous beta-only-success constraint was removed; beta is now exercised in every security-relevant state (foreign registry, owner mismatch, tampered snapshots, missing bindings, warm cache) |

### Matrix R-C (route status × cache × generation)

| Constraint                                              | Class | Rationale                                                                                                                                                           |
| ------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| non-active route ⇒ cold + matching generation           | B     | `assertRuntimeRouteAvailable` throws `quarantined_route` before the cache and generation-vs-snapshot checks, so those layers are unobservable for non-active routes |
| warm ⇒ active + matching; warm-stale ⇒ active + ahead   | B     | cache reuse requires a prior success; the warm-stale shape observes the advanced generation by design                                                               |
| stale/ahead/missing ⇒ active + cold (except warm-stale) | B     | generation failures are only observable when the route is active                                                                                                    |

### Matrix R-D (vanity × canonical issuer × browser/protocol)

| Constraint                                                                                                | Class | Rationale                                                                          |
| --------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| primary vanity makes the vanity host the canonical issuer; the canonical subdomain then redirects/rejects | A     | `getPrimaryTenantVanityDomain` + canonicalization blocks                           |
| non-primary alias fails the tenant binding policy                                                         | A     | `validateTenantRequestBinding` allows only canonical host + primary vanity         |
| inactive vanity alias fails closed                                                                        | A     | `queryActiveVanityTenant` requires `is_active=1 AND status='active'`               |
| cross-tenant stale vanity cache fails closed                                                              | A     | cache-vs-D1 revalidation mismatch                                                  |
| without vanity the issuer is the tenant subdomain, the naked domain, or unavailable                       | A     | `buildRequestIssuerUrl` / host resolution                                          |
| alias/unresolvable/naked host constraints                                                                 | B     | those hosts are only reachable through the seeded vanity row / without vanity rows |

### Matrix R-E (service binding × forwarded host × tenant context)

| Constraint                                                                                            | Class | Rationale                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| trusted conflicting forwarded host selects the foreign context; matching/absent keeps the host tenant | A     | `resolveTenantFromRequest` precedence                                                                                                                                |
| the service binding is resolved for the CONTEXT tenant, never the host tenant                         | A     | metadata context resolves the forwarded-selected tenant; the observation proves the foreign tenant's registry/binding was used and the host tenant was never touched |
| unresolvable host yields no context; binding never consulted                                          | B     | the required-tenant branch rejects before any storage access                                                                                                         |
| a foreign context is rejected by the tenant host-binding policy after its own binding was used        | A     | `validateTenantRequestBinding` compares the request HOST against the CONTEXT tenant's allowed hosts                                                                  |

## Production ambiguity in the rejection layer

The resolver exposes the same `invalid_snapshot_signature` error for three distinct
failures: a foreign registry tenant, a generation mismatch, and a bad signature. The
signature failure additionally writes a security event; the other two do not. The suite
attributes the layer from the seeded dimension only where the error surface cannot
distinguish the failure (`registry-tenant` vs `generation`). This is recorded as an
observable contract, not a defect.

## Potential production findings

None recorded in this suite. Two test-side defects were found and fixed during the build:

- The previous bad-signature fixture edited the _last base64url character_ of the JWS
  signature segment, which for Ed25519 (64 bytes → 86 chars) can change only the ignored
  padding bits ('A' → 'B' decodes to the same 64 bytes), so the mutation verified as
  valid ~25% of the time. The production verifier is correct; the fixture now flips a
  middle signature byte (`corruptSnapshotSignature`).
- The previous fixture generated a fresh random Ed25519 key per process. It now uses a fixed embedded
  key pair (see fixture fixity meta tests).

## Observation contract notes

- `errorDescription` is part of the comparable observation contract (deterministic fixed
  strings from the middleware).
- Signed snapshot payload, signature, and private JWK material never appear in failure
  messages, ledger targets/details, or responses (scanned per row).
- The tenant-aware D1 wrapper records only the safe tenant-routing labels (`alpha`,
  `beta`, `default`) found in bind parameters; raw parameters and secrets are never
  logged. KV tenant labels are extracted only from safe key shapes; the vanity-domain
  hostname keys are explicitly excluded (meta test proves no false positive).

## Mutation catalog

11 mutation IDs, each connected to a production observation field and exercised against a
real production observation (see meta tests):

1. `topology:trust-forwarded-host-without-config` → tenant/tenant-context
2. `topology:accept-inactive-vanity-alias` → tenant
3. `topology:use-foreign-tenant-registry-or-binding` → tenant-access-set
4. `topology:accept-tenant-exclusive-binding-ownership-mismatch` → owner
5. `topology:assign-pii-role-to-core-binding` → data-role
6. `topology:accept-bad-signature-snapshot` → error-code
7. `topology:use-quarantined-route-as-active` → error-code
8. `topology:fall-back-to-common-database-when-required-binding-missing` → error-code
9. `topology:return-success-route-after-service-binding-failure` → outcome
10. `topology:reuse-stale-runtime-generation-cache` → generation
11. `topology:use-stale-route-after-canonicalization` → location

## Cross-suite production status

The legacy `client_secret_jwt` path is now pinned fail-closed by token-matrix;
this suite adds no new failures.

## Non-collected real-runtime obligations

- Cloudflare service-binding transport (the 'throws' cases prove fail-closed semantics in
  Node, not real binding transport failures; the exercised `SELECT 1` on the selected
  binding proves which binding is used, not the transport).
- D1 transaction semantics (tenant-exists and registry health writes are adapter fakes).
- KV eventual consistency (vanity caches and registry KV are deterministic memory fakes).
- Regional cache behavior and concurrent request ordering.
- Real Worker runtime binding-type enforcement (an `isDatabaseSource` shape check in Node
  approximates the platform's binding-type enforcement).
- Platform outage/latency (failures are injected programmatically).
