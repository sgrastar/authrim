# Authorize Matrix — Overlap Record

## Existing related tests and coverage comparison

| Existing test                                                                                                                        | What it already proves                                                              | New interaction added here                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ar-auth/src/__tests__/authorize.test.ts`                                                                                   | Parameter validation, prompt handling, and redirect validation with mocked helpers. | Real `authorizeHandler` on a real Hono router with a D1-backed client lookup, frozen clock, and ledger-backed execution context; RFC 9126 error-redirect safety assertions.                                                       |
| `packages/ar-auth/src/__tests__/par.test.ts`, `jar-advanced.test.ts`                                                                 | PAR and JAR request-object handling with mocked stores.                             | Real PAR read/consume over a real PARRequestStore, real signed-JAR verification against client JWKS, container failure handling through the real handler, and the invariant that errors never target an unvalidated redirect URI. |
| `packages/ar-auth/src/__tests__/consent.test.ts`, `packages/ar-lib-core/src/services/__tests__/consent-store.test.ts`                | Consent trust policy and upsert logic with mocked adapters.                         | Trusted-client auto-grant, sufficient/expired/insufficient/lookup-failure consent, and prompt=consent through the real handler with real challenge records and ledger-observed consent lookups/writes.                            |
| `packages/ar-lib-core/src/durable-objects/__tests__/SessionStore.test.ts`, `SessionRevocationStore.test.ts`, `PARRequestStore` tests | Session and PAR semantics over fake storage.                                        | Session cookie end-to-end (active/expired/revoked/legacy/wrong-tenant/store-failure) and PAR read/consume/expiry/replay/client-mismatch/tenant-mismatch through the real handler with ledger-observed durable side effects.       |
| `test/integration/authorization-flow.test.ts`                                                                                        | Full authorization-code issuance flows.                                             | Matrix A/B rows pin the authorization-endpoint decision surface with the real handler; code issuance is asserted through the redirect response AND the durable auth-code record.                                                  |

## New interactions per case family

### Matrix A (authentication / session / SSO / consent)

- SSO priority client > tenant > default; lookup failures inherit the next level while
  the failed KV read stays ledger-observable.
- Expired/revoked/legacy/wrong-tenant/store-failure sessions are never active; the
  session-store read is still attempted for every sharded cookie.
- prompt=none never returns interactive UI; prompt=login forces reauth even with SSO
  disabled; `none` combined with other values is `invalid_request`; select_account
  observes the prompt-omitted contract; prompt=consent always forces the consent
  challenge.
- max_age 0/exceeded force reauth (login_required under prompt=none); the exact boundary
  does not; malformed is a direct 400.
- Consent lookup failures never issue codes; trusted auto-grant writes consent only when
  missing.

### Matrix B (protocol source / PAR / JAR / PKCE / redirect)

- PAR: valid requests are read without consuming; consumption happens only after an
  authenticated session reaches the consent/code phase; expired, replayed, client-
  mismatch, and tenant-mismatch requests are rejected (`invalid_request_uri`), with an
  RFC 9126 error redirect only when the outer client and redirect are independently
  re-validated; PAR-error redirects are always query-encoded.
- JAR: malformed (alg=none), bad-signature, and claims-mismatch request objects are
  rejected directly (`invalid_request_object`); a valid signed JAR reaches the
  authorization flow after signature verification against the client's registered JWKS.
- request + request_uri conflict is rejected before either container is processed.
- PKCE: public and require_pkce clients always need a valid S256 challenge; presented
  plain/malformed challenges are rejected for every client; confidential clients may
  omit the challenge.
- response type: missing/unsupported are direct 400s; `none` is rejected by the tenant
  profile gate; `code` proceeds.
- response mode / JARM: invalid modes and fragment+code are `invalid_request`; a JARM
  requirement rejects non-JWT modes; JWT mode returns the response as a signed JWT.
- Tenant bindings: foreign-tenant clients are rejected (`invalid_client`) under the
  non-default request tenant; foreign-tenant sessions are rejected by their storage
  binding; the request ledger is scanned for foreign-tenant store accesses.

## Meta tests

- Matrix A: 100% legal 2-way tuple coverage and 100% coverage of the three required
  triples; unique ids/fingerprints; discriminating mutation witnesses; oracle
  sensitivity across outcome families; independent exact-boundary time check; golden
  binary counts.
- Matrix B: 100% legal 2-way tuple coverage and 100% coverage of the four required
  triples; unique ids/fingerprints; pinned expected case count; discriminating mutation
  witnesses; oracle sensitivity across outcome families (including preflight-only
  families such as code-success via PAR/JAR and the JARM success path); golden binary
  counts.
- Dedicated preflights (Matrix B): valid PAR consumed after authorization only; login
  UI does not consume a valid PAR; valid signed JAR reaches the flow; JARM requirement
  enforced and honored; PAR-failure error redirects are always query-encoded.

## Notes

- The deep browser login/consent UI screens and the token endpoint exchange of the
  issued code are covered by canonical integration tests and the token suite; this suite
  pins the authorization-endpoint decision surface with the real handler.
- Cross-tenant access is asserted by scanning the whole request ledger for the foreign
  tenant identifier in both matrices.

## Mutation witnesses intended

| Mutation ID                                       | Witnessed row family                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `authorize:accept-malformed-max-age`              | malformed max_age rows (Matrix A)                                                                |
| `authorize:accept-none-combination`               | prompt=none combined with other values (Matrix A)                                                |
| `authorize:reuse-session-for-prompt-login`        | prompt=login on a usable session (Matrix A)                                                      |
| `authorize:accept-max-age-reauth-as-reusable`     | max_age=0/exceeded on a usable session (Matrix A)                                                |
| `authorize:prompt-none-enters-interactive-ui`     | prompt=none rows (Matrix A)                                                                      |
| `authorize:reuse-session-when-sso-disabled`       | usable session with SSO disabled (Matrix A)                                                      |
| `authorize:session-state-ignored`                 | non-usable session treated as active (Matrix A/B)                                                |
| `authorize:ignore-prompt-consent`                 | prompt=consent forcing the consent challenge (Matrix A, preflight `authn-boundary-003`)          |
| `authorize:omit-consent-lookup-or-write`          | code rows with consent satisfied (Matrix A)                                                      |
| `authorize:issue-code-without-consent`            | consent-required rows issuing a code anyway (Matrix A)                                           |
| `authorize:break-tenant-sso-inheritance`          | tenant SSO inherited by a default/failure client (Matrix A, preflights `authn-boundary-002/004`) |
| `authorize:accept-invalid-par`                    | expired/replayed/mismatched PAR accepted (Matrix B)                                              |
| `authorize:accept-invalid-request-object`         | invalid JAR accepted (Matrix B)                                                                  |
| `authorize:accept-request-plus-request-uri`       | conflicting request+request_uri accepted (Matrix B)                                              |
| `authorize:consume-par-while-displaying-login-ui` | PAR consumed for login UI display (Matrix B)                                                     |
| `authorize:skip-par-consume`                      | code issued without consuming the PAR (Matrix B, preflight `proto-boundary-001`)                 |
| `authorize:accept-foreign-session-as-active`      | foreign-tenant session accepted (Matrix B)                                                       |
| `authorize:accept-response-type-none`             | response_type=none admitted (Matrix B)                                                           |
| `authorize:accept-unsupported-response-type`      | unsupported response_type admitted (Matrix B)                                                    |
| `authorize:accept-missing-response-type`          | missing response_type admitted (Matrix B)                                                        |
| `authorize:ignore-invalid-response-mode`          | invalid/fragment+code response mode accepted (Matrix B)                                          |
| `authorize:ignore-jarm-requirement`               | JARM requirement ignored (Matrix B, preflight `proto-boundary-004`)                              |
| `authorize:accept-invalid-pkce-challenge`         | invalid PKCE challenge accepted (Matrix B)                                                       |
| `authorize:accept-cross-tenant-client`            | foreign-tenant client accepted (Matrix B)                                                        |
| `authorize:redirect-error-to-unvalidated-uri`     | errors redirected to an unvalidated URI (Matrix B, safety net for every row)                     |
