# Runtime-Topology Matrix — Overlap Record

## Existing related tests and coverage comparison

| Existing test                                                                                                                             | What it already proves                                                                                  | New interaction added here                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ar-lib-core/src/utils/__tests__/issuer.test.ts`                                                                                 | Standalone host/issuer parsing units (`getRequestHost`, `buildRequestIssuerUrl`, `validateHostHeader`). | Cross-header precedence through the real middleware with typed Hono apps and real `Request` objects, including conflicting/malformed forwarded states; treated as an overlap baseline, not re-certified. |
| `test/integration/tenant-system/fixtures/tenant-system-3wise-constrained-valid-matrix.csv` + `test/integration/tenant-system/settings-matrix.test.ts` | 308-data-row tenant routing settings matrix.                                                            | Treated as an overlap baseline; the new suite targets the cross-layer chain (host → context → vanity → signed registry → binding → issuer), not a duplicate of the 308-row settings matrix.              |
| `test/integration/tenant-system/vanity-domains.test.ts`, `oidc-tenant-binding.test.ts`                                                    | Vanity and binding resolution via canonical fixtures.                                                   | Not duplicated; the new suite adds the interplay with signed runtime-registry states, canonical-issuer state, and forwarded-host precedence.                                                             |

## Matrices and required 3-wise groups

| Matrix | Purpose                                                                                          | Required groups                                                                                  | Rows |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---- |
| R-A    | request routing through `requestContextMiddleware`                                               | G1 host × forwarded-host policy × request class (incl. admin)                                    | 49   |
| R-B    | registry and binding resolution through `resolveTenantDatabaseSourceFromRegistry` (both tenants) | G2 host tenant × registry tenant × binding owner; G4 allocation scope × owner tenant × data role | 48   |
| R-C    | generation-document route status × cache × runtime generation                                    | G3 route status × cache state × runtime generation                                               | 9    |
| R-D    | vanity × canonical issuer × browser/protocol through the middleware                              | G5 vanity state × canonical issuer × browser/protocol request                                    | 16   |
| R-E    | service binding × forwarded host × tenant context through the middleware                         | G6 service-binding state × forwarded host × tenant context                                       | 13   |

Legal-triple counts (independently declared literals, independent checker): G1 33, G2 8, G3 9,
G4 8, G5 16, G6 13. All six groups are covered 100% by their matrices, and all legal
2-way pairs are covered per matrix (R-A 365, R-B 350, plus the full small matrices).

## New interactions per matrix

### Matrix R-A (request routing)

- `requestContextMiddleware` + `getRequestContext` + `getRequestIssuer` on a typed Hono
  app; every row is a real `Request` with a real `Host`, optional
  `X-Authrim-Forwarded-Host`, and a request-class path (browser, protocol, discovery,
  internal, admin).
- Full chain exercised per row: host/forwarded → request context → tenant existence and
  lifecycle → vanity binding → signed runtime registry → D1 binding ownership → canonical
  issuer.
- Ledger-observed side effects: tenant-exists query + positive KV cache write, vanity
  resolution attempt, primary-vanity query, settings read, registry snapshot read,
  security-event writes, tenant-access set, binding operation, secret-leak scan.
- Admin rows in the table (X-Tenant-Id pins the tenant; the forwarded host shapes the
  issuer only) plus a dedicated admin preflight table covering matching / missing /
  foreign / malformed X-Tenant-Id × path match × forwarded trust, with foreign-tenant
  access asserted zero.

### Matrix R-B (registry and binding resolution)

- `resolveTenantDatabaseSourceFromRegistry` driven directly with explicit request-local
  options; module-level resolver memory caches cleared per test.
- BOTH tenants exercised in every security-relevant state: foreign registry tenant, owner
  mismatch, payload-tampered / signature-tampered / unknown-kid / unsigned / expired /
  quarantined / missing snapshots, stale/ahead/missing generations, shared-pool and
  tenant-exclusive allocation, core-default / core-users / pii data roles, present /
  missing / wrong-type / throwing bindings, all service routes, D1 and unsupported
  providers, cold / warm / warm-stale caches.
- After a successful resolution the selected DatabaseSource receives a minimal real
  `SELECT 1`, and the binding identity (DB / DB_PII / DB_LOGIN) is observed in the ledger.
- Side-effect observation: security-event writes, request-cache population (empty on
  resolver failure; a binding-access failure occurs AFTER the resolver already succeeded,
  so the request cache retains that resolution while the outcome stays fail-closed),
  tenant-access set (D1 bind-parameter labels + KV key shapes),
  foreign-tenant access, secret leak, selected binding/generation/allocation/owner/
  data-role/provider.

### Matrix R-C (route status × cache × generation)

- Generation-document route status (active/quarantining/quarantined/disabled) drives the
  resolver; a non-active route throws `quarantined_route` before the cache and generation
  checks. Warm cache reuse, warm-stale re-resolution, and a route that becomes
  quarantined after a warm resolution are pinned.

### Matrix R-D (canonical issuer)

- vanity state × canonical issuer state × browser/protocol: tenant-canonical, primary
  naked, active vanity, mismatched (308 browser / 404 protocol canonicalization and
  binding-policy rejections), and unavailable (fail-closed) issuer outcomes through the
  middleware with the issuer observed via `getRequestIssuer`.

### Matrix R-E (service binding × forwarded host × tenant context)

- The forwarded host selects the tenant context; the service binding is resolved for the
  CONTEXT tenant (never the host tenant), and a foreign context selected by a conflicting
  forwarded host is rejected by the tenant host-binding policy after its own binding was
  used — the foreign tenant's registry/binding is observed and the host tenant is never
  touched.

## Coverage

Independent brute-force checker (independently declared literals, no shared constraint/decision
functions with the generator): legal-pair counts R-A 365 / R-B 350, the six required
group triple counts (33/8/9/8/16/13), generator↔independent set equality for all five
matrices, 100% pair and required-triple coverage. The checker also rejects: a matrix that
drops one legal pair, a matrix that keeps pairwise coverage but drops a required triple,
and a matrix that hides legal tuples behind a wrong constraint; duplicate IDs and
duplicate semantic fingerprints are rejected.

## Fixture fixity

- The Ed25519 fixed test keys are FIXED embedded constants (primary kid
  `security-matrix-runtime-registry-kid-001`, second kid `security-matrix-runtime-registry-kid-002` never
  in the verification JWKS), identical in every process; the public JWKS never contains
  private material; the same payload produces the same signing input every time.
- A signature-corruption helper flips a middle signature byte (the last-character edit
  problem is documented in FINDINGS.md).

## Mutation witnesses

11 mutation IDs (see FINDINGS.md for the full catalog) are each connected to a
production observation field; a meta test runs a representative case through production,
asserts the common assertion passes, corrupts exactly the mapped field in the REAL
observation, and asserts the same assertion rejects.

## Node-contract evidence boundary

The full cross-layer chain is exercised in Node. Real Cloudflare runtime obligations
(service-binding transport, D1 transactions, KV eventual consistency, regional caches,
concurrency, binding-type enforcement, platform outages) remain unverified and are listed
in `FINDINGS.md`.
