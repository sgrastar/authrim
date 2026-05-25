# Authrim Public Specification

Status: Draft
Last updated: 2026-05-25
Audience: application developers, SDK authors, operators, auditors, and contributors

## 1. Purpose

This document describes Authrim's public runtime contract so that a reader can understand the system without reading the source code.

It covers:

- OAuth 2.0 / OpenID Connect behavior
- Direct Auth
- Native SSO and device-secret token exchange
- built-in LoginUI behavior
- SDK session profiles
- DPoP and browser token rules
- cross-domain SSO and handoff
- logout and device/session management
- step-up and delegated write contracts
- privacy-preserving support operations
- SAML 2.0 IdP/SP behavior
- storage portability boundaries
- audit and managed logging routing
- Workers-native UI deployment
- public configuration names and defaults

This document intentionally uses an **OpenAPI-inspired format** for endpoint contracts, while also documenting non-HTTP runtime behavior such as storage placement and default security policy. A complete machine-readable OpenAPI document can be generated from this contract, but this file is the human-readable public source of truth.

## 2. Normative Language

The keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used as defined by RFC 2119.

## 3. Core Concepts

| Term | Meaning |
| --- | --- |
| Authenticated session | A client/RP-specific login session. It is distinct from Authrim's internal AS-wide SSO state. |
| AS SSO session | Authrim's internal global SSO state. It is not directly exposed as a public API object. |
| Direct Auth | A first-party headless authentication initiation layer. It is not a separate token model. |
| Direct Auth artifact | A single-use artifact returned by a Direct Auth finish operation and redeemed through a canonical token/session path. |
| Native SSO | Native app SSO based on `device_secret` and OAuth token exchange. Refresh-token sharing across apps is not the canonical model. |
| Device secret | Native SSO credential bound to an installation and used as the actor token in native token exchange. |
| Installation | A server-assigned opaque app installation record. Device inventory is exposed as installation inventory. |
| `managed_browser_session` | Built-in LoginUI profile. Authrim manages handoff, cookie session, domain policy, CORS, and CSP. Browser JavaScript does not receive OAuth/OIDC token material. |
| `cookie_session` | BFF/SSR/MPA profile using an opaque HttpOnly cookie and server-side session state. |
| `token_session` | Pure browser/API-oriented SDK profile using OAuth tokens, PKCE, DPoP, and memory-first token storage. |
| Application group | Public/Admin/API name for a related application set used for explicit group logout and managed grouping. Internally this maps to the security boundary historically named `trust_group`. |
| Web origin registry | Public/Admin/API name for the registry of RP/browser origins, CORS policy, CSP policy, handoff permission, iframe permission, and environment membership. Internally this may map to `rp_origin_registry`. |
| Storage profile | Runtime policy describing where auth core, PII, custom/extension, and related data are stored. |
| Audit profile | Runtime policy describing audit primary store, archive store, forwarding sinks, routing, and failure behavior. |
| Storage destination | Admin-managed or setup-managed storage/sink target used for archive, diagnostic detail, sensitive detail, import/export artifacts, DLQ payloads, or external logging delivery. |
| Logging policy snapshot | Published runtime logging policy used by Workers to resolve log type, plane, destination, fallback, and delivery behavior. |
| SAML entityID style | Tenant-wide choice that determines whether Authrim publishes metadata URL entityIDs or shorter role URL entityIDs for local IdP/SP metadata. |
| SAML interactive login redirect policy | Tenant-wide choice that determines whether SAML interactive login starts at the tenant login host or the shared Login UI base URL with a tenant hint. |
| Handoff | A short-lived, single-use browser continuation mechanism used when Authrim must move an authenticated result from one browser context or origin to another without relying on third-party cookies or exposing OAuth/OIDC token material to browser JavaScript. |
| Step-up | A fresh authentication or verification action required before a sensitive operation can proceed. Step-up proves recent user presence or a stronger factor and returns a short-lived receipt bound to the specific operation. |
| Support Ops | Privacy-preserving administrative support surface for aggregate investigation, cohort selection, and approved action execution without exposing individual end-user records through the standard support workflow. |
| Support Ops selector | A constrained JSON filter expression used to select or aggregate support-operation targets. It exposes only registered non-sensitive fields and compiles to parameterized storage queries. |
| Support Ops cohort | A frozen target snapshot derived from a selector, intended action, tenant, and support case. Cohorts expose only redacted counts and expire before execution can occur. |
| Approved action | A Support Ops action that was requested against a cohort and authorized through the approval workflow before execution. |
| Break-glass | Reserved future Support Ops flow for individually revealing end-user data under stricter approval. The current Support Ops action path must remain compatible with adding this later. |
| Policy | Runtime configuration and decision logic that determines whether a request is allowed, which assurance level is required, which origins or clients may participate, where data is stored, and how audit/retention rules apply. |

### 3.1 Handoff in Plain Terms

Handoff exists because modern browsers restrict third-party cookies, partitioned storage, and iframe-based silent authentication. A login result often needs to move from Authrim's login surface back to a relying party (RP), or from a top-level Authrim navigation back to a client-specific session mode.

Authrim treats this transfer as a separate security step:

1. Authrim creates a short-lived handoff artifact.
2. The target origin and client must match the artifact metadata and registered origin policy.
3. The artifact can be used once.
4. The completion path depends on the target session profile:
   - `managed_browser_session` / `cookie_session`: finalize a server-side cookie session.
   - `token_session`: verify through a DPoP-bound token continuation.

Handoff is not an alternate OAuth grant and is not a long-lived credential. It is a bounded continuation mechanism around standard OAuth/OIDC or Authrim-managed browser session flows.

### 3.2 Step-Up in Plain Terms

Step-up exists for operations where an existing session is valid but not strong or fresh enough. Examples include changing recovery settings, managing another user's account, deleting high-value data, exporting sensitive data, or performing delegated administration.

The normal pattern is:

1. A protected API determines that the caller is authenticated but needs stronger or fresher assurance.
2. The API returns `403 step_up_required` with a machine-readable `step_up` object.
3. The client starts and completes an allowed step-up method.
4. Authrim returns a short-lived `step_up_receipt`.
5. The original operation is retried with `Authrim-Step-Up-Receipt`.

The receipt is bound to operation/user/session policy and is rejected when expired, mismatched, or replayed. Step-up is therefore not just "MFA UI"; it is a protocol-level contract for proving recent assurance before a specific sensitive operation.

### 3.3 Policy Model in Plain Terms

Authrim uses policy as the decision layer around protocol and product flows. OAuth/OIDC defines how clients request tokens and identity information; Authrim policy decides whether a concrete request is allowed in the tenant, client, origin, session, storage, or administrative context.

Policy appears in several places:

- **Client and grant policy**: allowed grant types, redirect URIs, PKCE, DPoP, refresh token behavior, and resource/audience restrictions.
- **Origin policy**: CORS, CSP, iframe compatibility, and handoff eligibility through the web origin registry.
- **Session policy**: `managed_browser_session`, `cookie_session`, `token_session`, logout scope, refresh behavior, and CSRF requirements.
- **Native SSO policy**: same-client vs cross-client exchange, application-group eligibility, device-secret revoke/introspection permissions, and rotation.
- **Step-up policy**: when stronger assurance is required, acceptable methods, TTLs, attempts, resend limits, and receipt scope.
- **Delegated write policy**: who may act on another subject, whether audit reason/reference is required, and which operations need step-up.
- **Storage and audit policy**: storage boundary placement, residency behavior, audit routing, archive sinks, retention, and failure behavior.
- **Admin/API authorization policy**: RBAC/ABAC/ReBAC-style permission checks for management surfaces and policy APIs.

Public APIs expose policy outcomes and stable configuration names. Internal policy engines, rule storage, and evaluation implementation details are not public wire contracts unless explicitly documented.

## 4. Secure Defaults

| Area | Default | Rationale |
| --- | --- | --- |
| Built-in LoginUI session | `managed_browser_session` backed by cookie session | Prevents OAuth/OIDC token material from reaching browser JavaScript. |
| Browser SDK profile | Explicit profile required unless an adapter can safely infer it. Vanilla browser examples use `profile: "token"`. |
| SvelteKit/BFF profile | `profile: "auto"` may resolve to cookie/BFF when the adapter can prove server mediation. |
| Browser public token path | Authorization Code + PKCE + DPoP | Avoids implicit/ROPC defaults and constrains token replay. |
| Browser access token storage | Memory-only | Reduces persistent token theft after XSS. |
| Browser refresh token policy | `disabled` | Refresh tokens in browser are explicit opt-in only. |
| Browser refresh token opt-in | `dpop_bound` | If browser refresh tokens are enabled, they must be sender-constrained. |
| DPoP key fallback | `fail_closed` | SDKs must not silently downgrade sender-constraining. |
| DPoP algorithm | `ES256` for browser public clients | Broad Web Crypto support and good security/performance tradeoff. |
| Cookie session CSRF | SameSite + double-submit CSRF + Origin/Referer check | Cookie-bearing mutation requests need browser CSRF protection. |
| Same-origin cookie session | `SameSite=Lax; Secure; HttpOnly` | Safe default for same-site browser apps. |
| Cross-origin cookie session | `SameSite=None; Secure; HttpOnly` plus CSRF and Origin/Referer checks | Required for legitimate cross-origin deployments. |
| Cross-domain SSO | top-level redirect + login challenge + handoff | Avoids relying on third-party cookies and iframe storage access. |
| iframe OIDC authentication | Disabled by default | Optional compatibility feature only. |
| Handoff artifact TTL | 60 seconds | Short-lived single-use transfer. |
| Handoff artifact policy range | 30-300 seconds | Allows bounded deployment tuning. |
| Same-client Native SSO | Enabled | Allows a native client to re-establish its own installation session through `device_secret`. |
| Cross-client Native SSO | Disabled | Requires explicit application-group opt-in. |
| Native SSO token type | `DPoP` | Native public-client exchange requires DPoP sender-constraining. |
| Native SSO ID Token clock-skew window | 60 seconds | Short tolerance for exchange-time ID Token freshness. |
| Device secret rotation | Disabled | Rotation is tenant-policy controlled and explicit. |
| Support Ops self approval | Disabled | Support actions must be approved by a different operator unless tenant policy explicitly allows self approval. |
| Support Ops duty separation | Requester and approver must be distinct | Tenants may require requester, approver, and executor to all be distinct. |
| Support Ops minimum cohort size | 10 | Low-count matched/actionable/blocked subsets are suppressed or rejected depending on operation phase. |
| Support Ops aggregate counts | Bucketed and suppressible | Aggregate responses are not exact by default and apply low-count plus complementary suppression. |
| Support Ops cohort TTL | 24 hours | Expired cohorts cannot be used for action execution. |
| Support Ops action approval | Required | Action execution is bound to a matching approved approval request. |
| SAML entityID style | `metadata_url` | Published IdP/SP entityIDs default to metadata URLs for compatibility. |
| SAML interactive login redirect | `tenant_host` | SAML interactive login defaults to the tenant `/login` URL. |
| Bearer token transport | Authorization header only | Query/form bearer tokens are rejected on Authrim canonical endpoints. |
| Logout scope | Current client/session by default | Prevents accidental global logout. |
| UI deployment | Cloudflare Workers static assets / SSR | Cloudflare Pages is not the supported default UI deployment path. |

## 5. OAuth 2.0 and OpenID Connect

Authrim is an OpenID Provider and OAuth Authorization Server. Standard endpoints keep standard semantics. Product-specific behavior such as Direct Auth, handoff, and step-up is exposed through separate surfaces.

### 5.1 Discovery

```yaml
GET /.well-known/openid-configuration
security: none
```

Returns OpenID Provider metadata.

Key defaults:

| Field | Default / Behavior |
| --- | --- |
| `authorization_endpoint` | `{issuer}/authorize` |
| `token_endpoint` | `{issuer}/token` |
| `userinfo_endpoint` | `{issuer}/userinfo` |
| `jwks_uri` | `{issuer}/.well-known/jwks.json` |
| `registration_endpoint` | `{issuer}/register` when Dynamic Client Registration is enabled |
| `code_challenge_methods_supported` | `S256` is the default and recommended method. |
| `dpop_signing_alg_values_supported` | `ES256`, `PS256`, `EdDSA` |
| `native_sso_supported` | Authoritative Native SSO capability field when Native SSO is enabled. Removed fields such as `native_sso_token_exchange_supported` and `native_sso_device_secret_supported` are not authoritative. |

### 5.2 Authorization Endpoint

```yaml
GET /authorize
POST /authorize
security: none
```

Starts an OAuth/OIDC authorization request.

Query/form parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `response_type` | Yes | none | Default browser-facing profile SHOULD use `code`. Implicit and Hybrid response types are compatibility/conformance options only. |
| `client_id` | Yes | none | Registered client identifier. |
| `redirect_uri` | Required unless PAR/request object supplies it | none | Must match registered redirect URI policy. |
| `scope` | Yes | none | OIDC requests include `openid`. |
| `state` | Strongly recommended; required by SDKs | none | SDKs must validate exact round-trip. |
| `nonce` | Required for OIDC flows that issue ID Tokens | none | SDKs must validate exact round-trip. |
| `code_challenge` | Required for public/browser/native clients | none | PKCE is required for default browser-facing flows. |
| `code_challenge_method` | No | `S256` | `plain` is compatibility only and SHOULD NOT be used by SDK defaults. |
| `prompt` | No | normal login policy | Supports `none`, `login`, `consent`, `select_account`. |
| `max_age` | No | no freshness requirement | When supplied, Authrim must enforce `auth_time` freshness. |
| `acr_values` | No | client/default assurance policy | Passed through login challenge and session metadata. |
| `claims` | No | none | JSON claims request. |
| `ui_locales` | No | deployment default locale | Space-separated locale preference. |
| `login_hint` | No | none | Passed to LoginUI / upstream provider when applicable. |
| `request_uri` | No | none | PAR request URI when PAR is used. |
| `handoff` | No | `false` | `true` asks for handoff-based continuation for compatible clients. |

Default behavior:

- Browser-facing SDK and LoginUI defaults use Authorization Code + PKCE.
- `prompt=none` failures map to OIDC-standard `login_required`, `interaction_required`, or `consent_required`.
- LoginUI receives login challenge metadata and must preserve `state`, `nonce`, PKCE, `prompt`, `max_age`, and `acr_values`.
- Default LoginUI session mode is `managed_browser_session`.
- `token_session` handoff uses DPoP-bound token verification.
- `managed_browser_session` handoff uses cookie-session finalize.

### 5.3 Token Endpoint

```yaml
POST /token
content-type: application/x-www-form-urlencoded
security: client authentication as required by client type
```

Common parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `grant_type` | Yes | none | Standard or Authrim extension grant. |
| `client_id` | Public clients: yes | none | Confidential clients may authenticate through standard client auth. |
| `client_secret` | Confidential clients depending on auth method | none | Never accepted for public browser clients. |
| `code` | Authorization Code grant | none | Single-use authorization code. |
| `code_verifier` | Authorization Code + PKCE; Direct Auth finish | none | Must match original `code_challenge`. |
| `redirect_uri` | Authorization Code when originally supplied | none | Must match authorization request. |
| `refresh_token` | Refresh Token grant | none | Rotation and reuse detection apply. |
| `resource` / `audience` | Optional | client default resource | Issuer fallback MUST NOT be used as resource audience. |
| `direct_auth_artifact` | Direct Auth finish grant | none | Single-use artifact. |
| `channel` | Direct Auth finish grant | none | `browser`, `native`, or `server`. |

Supported default grants:

| Grant | Default status | Notes |
| --- | --- | --- |
| `authorization_code` | Enabled | Default browser-facing flow. PKCE required for public clients. |
| `refresh_token` | Enabled when client policy permits it | Rotation and reuse detection required. |
| `client_credentials` | Enabled for service clients | Scope/resource policy applies. |
| `urn:authrim:params:oauth:grant-type:direct-auth-finish` | Enabled for Direct Auth | Redeems a Direct Auth artifact. |
| `urn:ietf:params:oauth:grant-type:token-exchange` | Optional / policy-controlled | Downstream grant and delegation policy applies. |

Token defaults:

| Token property | Default / Behavior |
| --- | --- |
| `access_token` | Canonical OAuth access token. |
| `aud` | Target resource from request or client default. If unresolved, issuance fails with `invalid_target`. |
| `client_id` | Requesting client identity. |
| `token_type` | `Bearer` or `DPoP`; DPoP-bound flows return/use DPoP semantics. |
| Browser access token storage | SDK default is memory-only. |
| Browser refresh token | Disabled unless `browser_refresh_token_policy=dpop_bound`. |
| Refresh reuse detection | Reuse revokes the affected token family and affected session/device. |

Access-token validation profile:

| Actor | Default / Behavior |
| --- | --- |
| OAuth clients | Treat access tokens as opaque strings. Clients MUST NOT parse access-token claims for application behavior. |
| Resource servers | Default validation profile is JWT + JWKS unless configured otherwise. |
| High-risk / real-time state checks | Resource servers SHOULD use introspection when they need immediate revocation state, user/session status, policy-sensitive decisions, or device-secret metadata. |
| Future opaque token profile | Reserved for explicit validation-profile configuration. Authrim clients remain compatible because clients treat access tokens as opaque. |

Bearer transport:

- Authrim canonical endpoints accept bearer tokens through the `Authorization` header only.
- Query/form bearer tokens are rejected.
- Any future external legacy adapter exception would apply only to Authrim-managed outbound calls to non-Authrim legacy APIs, not to Authrim inbound endpoints.

### 5.4 UserInfo Endpoint

```yaml
GET /userinfo
POST /userinfo
security: Bearer or DPoP access token
```

Defaults:

| Behavior | Default |
| --- | --- |
| Missing Authorization header | `401` with RFC 6750-compatible error. |
| DPoP-bound token without DPoP proof | `401 invalid_dpop_proof`. |
| Claims returned | Filtered by granted scopes and claims policy. |
| Encrypted/signed response | Controlled by client metadata. |

### 5.5 Introspection Endpoint

```yaml
POST /introspect
content-type: application/x-www-form-urlencoded
security: client authentication
```

Parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `token` | Yes | none | Token to inspect. |
| `token_type_hint` | No | none | Hint only. |

Behavior:

- Returns `active: false` for unknown, expired, revoked, or invalid tokens.
- `app_display_name` is returned only when Authrim can resolve it; otherwise it is omitted.
- Sensitive internal storage details are not exposed.

### 5.6 Revocation Endpoint

```yaml
POST /revoke
content-type: application/x-www-form-urlencoded
security: client authentication
```

Parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `token` | Yes | none | Token to revoke. |
| `token_type_hint` | No | none | Hint only. |

Behavior:

- Revocation is idempotent.
- Refresh token family policy applies where applicable.

### 5.7 Dynamic Client Registration

```yaml
POST /register
security: deployment policy
```

Selected parameters and defaults:

| Parameter | Default | Notes |
| --- | --- | --- |
| `redirect_uris` | required for redirect-based clients | Must satisfy origin/redirect policy. |
| `response_types` | `["code"]` | Browser SDK/LoginUI defaults do not auto-select implicit or hybrid. |
| `grant_types` | inferred from response types | Authorization Code is the default browser-facing grant. |
| `token_endpoint_auth_method` | client type dependent | Public browser clients do not use client secret. |
| `application_group` | managed/Admin assignment only | Public runtime registration cannot set internal trust-group fields directly. |
| `web_origin_registry` | managed/Admin/setup surface | SDK receives read-only metadata through discovery/login challenge. |
| `browser_public_client_mode` | built-in LoginUI: `cookie_fallback`; custom browser public client: `strict` | See session profiles below. |
| `browser_refresh_token_policy` | `disabled` | `dpop_bound` requires explicit opt-in. |

### 5.8 Native SSO Token Exchange

Native SSO uses OAuth token exchange semantics. The canonical credential is `device_secret`; sharing refresh tokens across native applications is not the canonical Authrim SSO model.

```yaml
POST /token
content-type: application/x-www-form-urlencoded
grant_type: urn:ietf:params:oauth:grant-type:token-exchange
security: DPoP proof; client authentication according to client type and policy
```

Request parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `grant_type` | Yes | none | `urn:ietf:params:oauth:grant-type:token-exchange`. |
| `subject_token` | Yes | none | ID Token from the source installation/session. |
| `subject_token_type` | Yes | none | `urn:ietf:params:oauth:token-type:id_token`. |
| `actor_token` | Yes | none | `device_secret`. |
| `actor_token_type` | Yes | none | `urn:openid:params:token-type:device-secret`. |
| `client_id` | Public clients: yes | none | Target client. |
| `channel` | Native public clients: yes | none | Must be `native` for native public-client exchange. |
| `audience` | Optional | client default resource | RFC 8693 target parameter. |
| `scope` | Optional | client/resource policy default | Granted scope may be narrowed by policy. |

Native public-client eligibility:

- The client must be registered as a native public client.
- Eligibility is determined from client metadata, not redirect URI inference alone.
- `application_type=native` and native channel permission are required.
- Registered native public clients may omit confidential-client authentication only when `channel=native`, `device_secret`, and valid DPoP proof are all present.

Native SSO defaults:

| Setting | Default |
| --- | --- |
| Same-client Native SSO | Enabled |
| Cross-client Native SSO | Disabled |
| Cross-client sharing boundary | Explicit `application_group` opt-in; internally this may map to a trust-group boundary. |
| ID Token expiry / clock-skew window | 60 seconds |
| Device secret rotation | Disabled |

Success response:

```json
{
  "access_token": "...",
  "token_type": "DPoP",
  "expires_in": 600,
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "scope": "openid profile api:read",
  "refresh_token": "...",
  "refresh_token_expires_in": 2592000,
  "refresh_token_expires_at": "2026-06-03T12:34:56Z",
  "refresh_token_expires_at_unix": 1780480496,
  "id_token": "...",
  "installation_id": "ins_123",
  "client_id": "client_abc",
  "app_display_name": "Authrim Wallet",
  "platform": "ios",
  "display_name": "",
  "fallback_display_name": "iPhone 15 Pro",
  "last_seen_at": "2026-05-04T12:34:56Z",
  "last_seen_at_unix": 1777869296
}
```

Success response rules:

- `token_type` must be `DPoP`.
- `issued_token_type` must be `urn:ietf:params:oauth:token-type:access_token`.
- `scope` is a space-delimited string.
- `resource` and `audience` are not echoed.
- `installation_id` is always returned.
- Same-client exchange returns the current canonical installation id.
- Cross-client exchange returns a target-side installation id.
- `client_id` identifies the issued-side client.
- `app_display_name` is returned only when it can be resolved; otherwise it is omitted.
- `platform` is an open string and may be `unknown`.
- If no user-set display name exists, `display_name` is `""` and `fallback_display_name` may be returned.
- If a user-set display name exists, `fallback_display_name` is omitted.
- `source_client_id`, `issued_client_id`, `trust_group_id`, `effective_native_sso_scope`, `current`, and DPoP `cnf` / `jkt` are not public response fields.
- If a refresh token is not issued, `refresh_token` is omitted.
- If a refresh token has an expiry, `refresh_token_expires_in`, `refresh_token_expires_at`, and `refresh_token_expires_at_unix` are all returned.

Failure mapping:

| Condition | Top-level error | `error_details.code` |
| --- | --- | --- |
| Native SSO disabled | `unsupported_grant_type` | `native_sso_disabled` |
| Client not configured for Native SSO | `unauthorized_client` | `native_sso_client_disabled` |
| Missing `device_secret` actor token | `invalid_request` | `device_secret_missing` |
| Rate limit exceeded | `slow_down` | `native_sso_rate_limited` |
| Malformed ID Token subject token | `invalid_grant` | `id_token_malformed` |
| Invalid ID Token signature | `invalid_grant` | `id_token_signature_invalid` |
| Invalid ID Token issuer | `invalid_grant` | `id_token_issuer_invalid` |
| Invalid ID Token audience | `invalid_grant` | `id_token_audience_invalid` |
| ID Token expired beyond allowed window | `invalid_grant` | `id_token_expired` |
| Replayed ID Token subject token | `invalid_grant` | `id_token_replayed` |
| Missing DPoP proof | `invalid_request` | `dpop_proof_missing` |
| Invalid DPoP proof | `invalid_request` | `dpop_proof_invalid` |
| ID Token / device secret binding mismatch | `invalid_grant` | `device_secret_binding_failed` |
| Cross-client exchange not allowed by application group | `access_denied` | `trust_group_not_allowed` |
| Inactive or revoked device secret | `invalid_grant` | `device_secret_inactive` |
| Server-side Native SSO issuance failure | `server_error` | `native_sso_server_error` |

Cross-client installation semantics:

- Cross-client success creates a distinct target-side canonical installation record.
- The target-side installation receives a new installation id.
- The source-side installation and source-side `device_secret` remain valid unless independently revoked.
- Authrim may keep internal lineage such as source installation/client ids, but lineage is not exposed on public wire.

Device-secret revocation through `/revoke`:

- `token_type_hint=device_secret` should be accepted.
- An invalid hint is ignored if the token can still be identified as a device secret.
- Unknown or already inactive device secrets are treated as successful revocation.
- Unauthorized callers receive `403`.
- Policy-disabled revoke returns `403` with `error_details.code=revoke_disabled`.
- End-user self-service callers should use `/me/devices/*`.
- A native public client may revoke its own device secret.
- Cross-client revocation requires caller-class policy. Application-group membership alone is not enough.

Device-secret introspection through `/introspect`:

- Native public clients and end-user self-service callers are denied by default.
- Confidential/service clients and admin actors may introspect by policy/permission.
- Cross-client introspection requires explicit caller-class policy. Application-group membership alone is not enough.
- Policy-disabled introspection returns `403` with `error_details.code=introspection_disabled`.
- Unauthorized introspection returns `403` with `error_details.code=unauthorized_introspection_caller`.

Active device-secret introspection response:

```json
{
  "active": true,
  "token_type": "device_secret",
  "exp": 1777869296,
  "iat": 1777865696,
  "nbf": 1777865696,
  "sub": "usr_123",
  "iss": "https://auth.example.com",
  "jti": "jti_123",
  "installation_id": "ins_123",
  "client_id": "client_abc",
  "app_display_name": "Authrim Wallet",
  "platform": "ios",
  "display_name": "",
  "fallback_display_name": "iPhone 15 Pro"
}
```

Device-secret introspection claim rules:

- Inactive response is `{ "active": false }`.
- `token_type=device_secret`, `installation_id`, and `client_id` are returned for active responses.
- `exp`, `iat`, and optional `nbf` are Unix epoch seconds.
- `sub` is the Authrim stable user id.
- `aud`, `last_seen_at`, `trust_group_id`, and `effective_native_sso_scope` are not exposed.

Device-secret rotation:

- Rotation is tenant-policy controlled and disabled by default.
- Token exchange does not rotate `device_secret` by default.
- When explicit rotation occurs, the old `device_secret` is revoked with `revoke_reason=rotation`.
- If no overlap policy is configured, the old `device_secret` becomes inactive immediately.

## 6. Direct Auth

Direct Auth starts first-party authentication without redefining OAuth token semantics.

### 6.1 Passkey Login

```yaml
POST /api/v1/auth/direct/passkey/login/start
POST /api/v1/auth/direct/passkey/login/finish
```

Start parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `client_id` | Yes | none | Client initiating Direct Auth. |
| `channel` | Yes | none | `browser`, `native`, or `server`. |
| `transaction_id` | Recommended / SDK generated | generated by SDK | Binds start and finish. |
| `code_challenge` | Yes | none | PKCE challenge. |
| `code_challenge_method` | No | `S256` | SDKs use `S256`. |
| `login_hint` | No | none | Optional user hint. |

Finish parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `client_id` | Yes | none | Must match start. |
| `channel` | Yes | none | Must match request policy. |
| `transaction_id` | Yes | none | Must match start. |
| `credential` / WebAuthn response | Yes | none | Passkey assertion. |

Finish behavior:

- Returns a single-use Direct Auth artifact or managed-session continuation depending on endpoint.
- The artifact is bound to `client_id`, `transaction_id`, and PKCE challenge.
- Browser token-session clients redeem through `/token` with Direct Auth finish grant.
- Built-in LoginUI redeems server-side through `/api/v1/auth/direct/session`.

### 6.2 Passkey Signup

```yaml
POST /api/v1/auth/direct/passkey/signup/start
POST /api/v1/auth/direct/passkey/signup/finish
```

Defaults are the same as passkey login, plus registration-field validation.

Custom field behavior:

- `registration_required=true` controls built-in signup form required fields.
- `is_required=true` controls final server-side required validation.
- `show_on_registration=false` fields do not fail signup only because `is_required=true`.
- Missing fields return `missing_required_fields` with `field_key`, `label`, and `field_type`.

### 6.3 Email Code

```yaml
POST /api/v1/auth/direct/email-code/send
POST /api/v1/auth/direct/email-code/verify
```

Send parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `client_id` | Yes | none | Client initiating Direct Auth. |
| `channel` | Yes | none | `browser`, `native`, or `server`. |
| `email` | Yes | none | Email address. |
| `transaction_id` | Recommended / SDK generated | generated by SDK | Binds send and verify. |
| `code_challenge` | Yes | none | PKCE challenge. |
| `code_challenge_method` | No | `S256` | SDK default. |

Verify parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `client_id` | Yes | none | Must match send. |
| `channel` | Yes | none | Must match request policy. |
| `email` | Yes | none | Must match pending transaction. |
| `code` | Yes | none | One-time email code. |
| `transaction_id` | Yes | none | Must match send. |

### 6.4 Managed Browser Session Finish

```yaml
POST /api/v1/auth/direct/session
```

Used by built-in LoginUI and other server-mediated browser surfaces.

Parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `direct_auth_artifact` | Yes | none | Single-use artifact. |
| `client_id` | Yes | none | Client that initiated the flow. |
| `code_verifier` | Yes | none | Must match PKCE challenge. |
| `challenge_id` | When continuing authorization/login challenge | none | Preserves OAuth/OIDC continuation. |

Behavior:

- Establishes a server-side session and returns cookie-session response.
- MUST NOT return OAuth/OIDC token material to browser JavaScript.
- If a login challenge is being completed, returns or follows an authorization continuation URL preserving OIDC request state.

### 6.5 Direct Auth Logout

```yaml
POST /api/v1/auth/direct/logout
```

Parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `client_id` | Recommended | resolved from session when possible | Used for scoped logout. |
| `logout_scope` | No | `local` | `local`, `group`, or `global`. `group` maps to application group logout. |
| `revoke_tokens` | No | `false` | Whether related tokens should be revoked when supported. |

Default behavior:

- Missing `logout_scope` logs out the current client/session only.
- Application group logout requires explicit `logout_scope=group`.
- Global logout requires explicit `logout_scope=global`.

## 7. Login Challenge, Consent, and Handoff

Login challenge and consent are the standard OAuth/OIDC-facing coordination points between authorization requests, LoginUI, and user approval. Handoff is Authrim's browser continuation mechanism for the cases where the authenticated result must safely cross an origin or session-profile boundary.

Handoff is most visible in cross-domain SSO and built-in LoginUI flows. It replaces brittle iframe/third-party-cookie assumptions with a top-level navigation plus a short-lived artifact. The artifact is not a durable login token: it is bound to client, origin, state, expiry, and the expected completion method.

### 7.1 Login Challenge

```yaml
GET /auth/login-challenge
```

Parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `challenge_id` | Yes | none | Login challenge identifier generated by Authrim. |

Response includes:

| Field | Default / Behavior |
| --- | --- |
| `client_id` | Client requesting login. |
| `session_mode` | `managed_browser_session` unless client policy requires `token_session`. |
| `handoff_methods` | `cookie_session_finalize` for managed browser session; `dpop_token_verify` for token session. |
| `prompt` | Original OIDC prompt when present. |
| `max_age` | Original OIDC max age when present. |
| `acr_values` | Original OIDC ACR values when present. |
| `nonce_present` | Indicates nonce was supplied without exposing nonce to UI unnecessarily. |
| `web_origin_registry` metadata | Read-only CORS/CSP/handoff/iframe metadata when applicable. |

### 7.2 Consent

```yaml
GET /auth/consent
POST /auth/consent
```

Behavior:

- Handles OIDC consent challenge.
- Preserves standard OAuth/OIDC authorization request state.
- Legacy `/api/auth/*` wrappers are compatibility only; LoginUI should use canonical paths.

### 7.3 Handoff Verify

```yaml
POST /handoff/verify
security: DPoP proof required
```

Use this path when the target profile expects a token-session continuation. The caller proves possession of the DPoP key, submits the single-use handoff artifact, and receives only the continuation data allowed by the artifact and client policy.

Parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `handoff_token` | Yes | none | Single-use handoff artifact. |
| `state` | Yes | none | Must match artifact metadata. |
| `client_id` | Yes | none | Must match artifact metadata. |
| `include` | No | none | Comma-separated extension fields, for example `session,user`. |

Defaults:

- DPoP proof is required.
- Artifact TTL default is 60 seconds.
- Artifact policy range is 30-300 seconds.
- Issued token is DPoP-bound.
- `session` and `user` are returned only when explicitly requested through `include`.

### 7.4 Handoff Finalize

```yaml
POST /handoff/finalize
security: browser cookie/session context
```

Use this path when the target profile is `managed_browser_session` or `cookie_session`. Authrim finalizes the browser session through HttpOnly cookie/session state and does not expose OAuth/OIDC token material to browser JavaScript.

Parameters:

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `handoff_token` | Yes | none | Single-use handoff artifact. |
| `state` | Yes | none | Must match artifact metadata. |
| `client_id` | Yes | none | Must match artifact metadata. |

Defaults:

- Used by built-in LoginUI and cookie-session profiles.
- Sets or confirms a cookie-backed managed browser session.
- MUST NOT return OAuth/OIDC token material to browser JavaScript.

Compatibility aliases:

- `/auth/external/handoff/verify`
- `/auth/external/handoff/finalize`
- `/api/external/handoff/verify`
- `/api/external/handoff/finalize`

## 8. Session Profiles and SDK Behavior

### 8.1 Profile Selection

| Profile | Intended use | Default storage | Token material visible to browser JS |
| --- | --- | --- | --- |
| `managed_browser_session` | Built-in LoginUI | HttpOnly cookie + Authrim-managed server-side session | No |
| `cookie_session` | BFF/SSR/MPA SDK/server apps | HttpOnly cookie + application server session | No |
| `token_session` | Pure browser/API SDK apps | Memory-only access token; optional DPoP-bound refresh token | Yes, access token in memory only |

SDK defaults:

| SDK / Surface | Default / Behavior |
| --- | --- |
| Core SDK | Exposes OAuth/OIDC/PKCE/DPoP primitives. Lower abstraction level. |
| Web SDK | Requires `profile`; `auto` only works when runtime adapter can safely infer. |
| SvelteKit SDK | `profile: "auto"` may resolve to server-mediated cookie profile. |
| Server SDK | Provides BFF/cookie session helpers, CSRF helpers, DPoP validation, and Direct Auth artifact redeem helper. |
| Built-in LoginUI | Uses `managed_browser_session`. |

### 8.2 `authrim.fetch()` Defaults

| Behavior | Default |
| --- | --- |
| Cookie profile request credentials | Include credentials and attach CSRF header for state-changing requests when configured. |
| Token profile Authorization | Attach access token through Authorization header. |
| Token profile DPoP | Attach DPoP proof when required. |
| DPoP nonce challenge | Retry once with nonce. |
| 401 refresh retry | Retry refresh once. |
| Original request replay | GET/HEAD/OPTIONS may replay. Mutations replay only when `Idempotency-Key` is present. |
| Network retry | No automatic network retry by default. |

### 8.3 DPoP Key Lifecycle

| Setting | Default |
| --- | --- |
| Key scope | `issuer + client_id` |
| Browser key type | Non-extractable `CryptoKey` preferred |
| Browser persistent storage | IndexedDB-class storage |
| Fallback policy | `fail_closed` |
| Compatibility fallback | `wrapped_exported_key`, explicit opt-in only |
| Ephemeral fallback | `memory_only_key`, explicit opt-in only |
| Logout behavior | Clear scoped key on logout/current device unlink |

## 9. Cross-Domain SSO and Origin Registry

Cross-domain SSO does not rely on third-party cookies. The primary flow is:

1. RP initiates login or silent attempt.
2. Authrim returns login challenge metadata.
3. SDK/LoginUI uses top-level redirect and handoff when needed.
4. Authrim validates origin membership and handoff policy.
5. A single-use handoff artifact completes the target session mode.

### 9.1 Web Origin Registry

Public name: `web_origin_registry`  
Internal implementation name may be `rp_origin_registry`.

Fields:

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `origin` | Yes | none | Full origin, for example `https://app.example.com`. |
| `client_ids` | Yes | empty | Clients allowed to use this origin. |
| `cors.allowed` | No | `false` | Whether CORS should be enabled for the origin. |
| `csp.frame_ancestors` | No | empty | Frame ancestor policy for optional iframe compatibility. |
| `handoff_allowed` | No | `false` | Whether top-level handoff may target this origin. |
| `iframe_allowed` | No | `false` | Whether optional iframe OIDC metadata may be returned. |
| `environment` | No | deployment default | Environment label such as production/staging. |

Wildcard rule:

- Wildcard origins are denied by default.
- Advanced policy MAY allow only single-label subdomain wildcard such as `https://*.example.com`.
- Broad wildcard origins MUST be rejected.

### 9.2 iframe OIDC Compatibility

Default: disabled.

To enable iframe-based OIDC authentication/session management metadata, all of the following must be true:

- deployment or tenant feature flag `ENABLE_IFRAME_OIDC_AUTH=true`
- client/origin metadata has `iframe_allowed=true`
- origin is trusted and registered
- CSP frame ancestor policy permits the RP
- CORS/origin registration is valid

## 10. Device and Session Inventory

Canonical self-service device inventory:

```yaml
GET /me/devices
PATCH /me/devices/{id}
DELETE /me/devices/{id}
security: user session or access token
```

Record model:

- The canonical record unit is one installation.
- The current `device_secret` belongs to that installation record.
- The public installation id is a server-assigned opaque id.
- Existing device-secret rows may be lazily migrated into canonical installation records on first use.

Canonical device shape:

| Field | Type | Default / Rule |
| --- | --- | --- |
| `id` | string | Opaque installation id. |
| `display_name` | string | User-set name, or `""` when unset. |
| `fallback_display_name` | string | Optional; returned only when user-set name is absent. |
| `platform` | string | Open string; representative values include `ios`, `android`, `macos`, `windows`, `linux`, `web`, `unknown`. |
| `current` | boolean | Only the current caller app/session installation is `true`. |
| `last_seen_at` | RFC3339 string or `null` | Canonical time field. |
| `last_seen_at_unix` | integer or `null` | Unix epoch seconds mirror of `last_seen_at`. |
| `client_id` | string | May be returned for application-group-wide inventory. |
| `app_display_name` | string | Optional; omitted when unresolved. |

`GET /me/devices`:

| Query parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `cursor` | No | none | Cursor from the previous response. |
| `limit` | No | `50` | Server max is `100`. |

Response:

```json
{
  "devices": [
    {
      "id": "ins_123",
      "display_name": "",
      "fallback_display_name": "iPhone 15 Pro",
      "platform": "ios",
      "current": true,
      "last_seen_at": "2026-05-04T12:34:56Z",
      "last_seen_at_unix": 1777869296,
      "client_id": "client_abc",
      "app_display_name": "Authrim Wallet"
    }
  ],
  "next_cursor": "cur_123"
}
```

Rules:

- Top-level key is `devices`.
- Pagination uses cursor pagination.
- The final page omits `next_cursor`.
- Invalid, expired, or tampered cursors return `400 invalid_cursor`.
- Default sort places `current=true` first, then `last_seen_at desc`.

`PATCH /me/devices/{id}`:

```json
{
  "display_name": "My iPhone"
}
```

Rules:

- Request body is `{ "display_name": string }`.
- Response body is `{ "device": { ...canonical device shape... } }`.
- No-op rename still returns `200`.
- Rename is installation-local; sibling installations are not renamed automatically.
- `display_name` is trimmed and lightly normalized.
- Empty or whitespace-only names are rejected.
- Maximum `display_name` length is 64 characters.

`DELETE /me/devices/{id}`:

```json
{
  "ok": true,
  "device_unlink_result": {
    "action": "device_unlinked",
    "target_id": "ins_123",
    "signed_out_required": true,
    "status": "completed"
  }
}
```

Rules:

- Success response is `200` with JSON body.
- Action result key is `device_unlink_result`.
- `action` is `device_unlinked`.
- `status` is `completed` or `already_applied`.
- Current device unlink sets `signed_out_required=true`.
- Non-current device unlink sets `signed_out_required=false`.
- Unlinked installation disappears immediately from self-service list.
- Authrim may keep tombstone data for audit/admin purposes.
- Unlinking a source installation does not cascade to target-side installations created by cross-client Native SSO.

Summary defaults:

| Behavior | Default |
| --- | --- |
| Listed object | Installation/device-session record visible to the current user. |
| Revocation | Revokes the selected device/session. |
| Current client logout | Local/current client by default. |
| Application group logout | Explicit action only. |
| Global logout | Explicit action only. |

## 11. Step-Up and Delegated Writes

### 11.1 Delegated Write Identity Model

Self-service and delegated operations use different path families:

| Operation type | Path model | Identity rule |
| --- | --- | --- |
| Self-service | `/me/*` | Actor and subject are the current authenticated user. |
| Delegated operation | `/users/{subject_user_id}/...` | Actor remains actor. Subject impersonation tokens are not standard behavior. |

Downstream elevation grants are product-specific protected-resource flows. They are not accepted as the standard delegated write credential unless a route explicitly opts into that product-specific flow.

### 11.2 Delegated Write Envelope

Delegated write requests use:

```json
{
  "input": {},
  "audit": {
    "reason_code": "admin_repair",
    "reason_note": "approved by on-call",
    "reference_id": "CASE-123"
  }
}
```

Rules:

- `input` is always present, even when empty.
- `audit` is optional, but if present it uses the fixed public shape below.
- `step_up_receipt` is not accepted in the JSON body.
- Step-up receipt is passed through the `Authrim-Step-Up-Receipt` header.
- Delegated writes require `Idempotency-Key`.

Delegated audit object:

| Field | Default / Rule |
| --- | --- |
| `reason_code` | Open string on wire. Unknown values may still satisfy a reason-required policy. |
| `reason_note` | Optional text. Empty after trim is treated as unspecified. Newlines are allowed. Max length is 1024 grapheme clusters. |
| `reference_id` | Single public string. Max length is 128 characters. Empty after trim is invalid only when policy requires a reference. |

Audit rules:

- Unknown `audit` fields return `400 unknown_audit_field`.
- Empty `audit: {}` returns `400`.
- Trimming applies only to leading/trailing whitespace.

Delegated write success responses:

```json
{
  "user": {
    "...": "canonical read model"
  },
  "actor": {
    "id": "usr_actor"
  },
  "subject": {
    "id": "usr_subject"
  },
  "audit": {
    "reason_code": "admin_repair",
    "reason_note": "approved by on-call",
    "reference_id": "CASE-123"
  }
}
```

```json
{
  "email_delete_result": {
    "ok": true,
    "action": "email_deleted",
    "target_id": "email_123",
    "status": "completed"
  }
}
```

Response rules:

- Create/update returns the canonical read model.
- Resource response key is `<resource>`.
- Action result key is `<resource>_<verb>_result`.
- Action enum naming is `<resource>_<verb>`.
- Included `actor`, `subject`, and `audit` objects are siblings, not nested into the resource/result object.
- Unspecified include fields are omitted.
- Idempotent replay with the same request body returns the original success response verbatim.

`include=actor,subject,audit`:

- Allowed only on delegated write responses.
- Returned `audit` is a canonicalized summary, not a raw request echo.
- `actor.id` is the current authenticated actor stable user id.
- `subject.id` matches the path `subject_user_id`.

### 11.3 Step-Up

Step-up is the protocol Authrim uses when a normal authenticated session is not enough for a specific operation. It is intentionally separate from the initial login flow: a user can already be signed in, but Authrim can still require a fresh passkey, MFA method, email code, or another configured verification method before allowing a high-risk operation.

The API contract is machine-readable so SDKs and UIs can render the next action without hard-coding every policy rule. A protected route reports the requirement with `403 step_up_required`, the client completes one acceptable method, and the resulting receipt is sent back on the original operation through `Authrim-Step-Up-Receipt`.

Canonical namespace:

```yaml
/auth/step-up/*
```

Primary endpoints:

```yaml
POST /auth/step-up/start
GET /auth/step-up/actions/{action_id}
POST /auth/step-up/actions/{action_id}/complete
POST /auth/step-up/actions/{action_id}/resend
DELETE /auth/step-up/actions/{action_id}
```

Defaults:

| Behavior | Default |
| --- | --- |
| Response cache policy | `Cache-Control: no-store` |
| Error shape | Machine-readable `status` and `input_state`. |
| Receipt transport | `Authrim-Step-Up-Receipt` header. |
| Receipt scope | Bound to operation/user/session policy. |
| Receipt replay | Rejected when expired, mismatched, or replayed. |

Step-up requirement error:

- HTTP status is `403`.
- Top-level error is `step_up_required`.
- Response includes a `step_up` object.
- `step_up.step_up_token` is always returned.
- `acceptable_methods.categories` and/or `acceptable_methods.methods` is present.
- `preferred_method_unavailable` also returns `403` with the latest `step_up` object.

Pending action reuse:

- For the same actor, subject, and operation hash, only one pending action may exist.
- A new start or new `step_up_required` response should reuse the existing pending action.
- Reused response includes `action_id` and current `next_action`.
- If no pending action exists, top-level `action_id` and `next_action` are omitted.

Start request:

```json
{
  "step_up_token": "stu_123",
  "preferred_method": {
    "category": "mfa",
    "method": "passkey"
  }
}
```

Start rules:

- `preferred_method` shape is `{ "category"?: string, "method"?: string }`.
- Empty `{}` returns `400 invalid_request`.
- Contradictory category/method returns `400 invalid_request`.
- Syntactically valid but unavailable method returns `preferred_method_unavailable`.

Complete/resend rules:

- Complete request body is `{ "method": string, "input": object }`.
- Complete requires `Idempotency-Key`.
- Resend requires `Idempotency-Key`.
- Invalid input uses `invalid_step_up_input`.
- Exhausted attempts use `step_up_attempts_exhausted`.
- Successful completion returns a single-use `step_up_receipt`.
- Malformed receipt is `400 invalid_request`.
- Expired, reused, or operation-mismatched receipt is `403 step_up_required`.
- Receipt is short-lived and bound to actor, subject, operation hash, and idempotency context.
- Receipt must be stored server-side or verifiable against server-side single-use state.
- Resend reuses the same action.
- Resend-unsupported method returns `400 invalid_request`.
- Cooldown-hit resend returns `429` and `Retry-After`.

Input state:

| Field | Default / Rule |
| --- | --- |
| `remaining_attempts` | Returned for input-based methods. |
| `attempt_limit` | Returned for input-based methods. |
| `remaining_resends` | Returned when resend applies. |
| `resend_available_at` | RFC3339 time when resend applies. |

Input state rules:

- `input_state` is omitted for non-input methods.
- Terminal invalid-input failure may still return `input_state`.
- `remaining_attempts=0` implies terminal failure.
- Time fields should use RFC3339 with optional parallel `*_unix`.

Default step-up policy:

| Policy | Default |
| --- | --- |
| `step_up_token_ttl_seconds` | `300` |
| `step_up_action_ttl_seconds` | `600` |
| `step_up_receipt_ttl_seconds` | `300` |
| `step_up_attempt_limit` | `5` |
| `step_up_resend_cooldown_seconds` | `60` |
| `step_up_max_resends` | `3` |

Tenant administrators may override these values by policy. Implementations reject non-positive TTL/cooldown values and should enforce safety bounds so tenant overrides cannot create indefinitely reusable step-up tokens, actions, or receipts.

## 12. Privacy-Preserving Support Operations

Support Ops is the administrative support surface for investigating and operating on end-user populations without exposing individual end-user records in the standard workflow. It is intended for cases such as login issue investigation, social-login distribution analysis, or applying an approved operation to a safely selected cohort.

Support Ops is not a replacement for break-glass access. Individual user inspection is a future, stricter flow and must not be required for the aggregate/cohort/action path described here.

### 12.1 Resource Registry and Selectors

```yaml
GET /api/admin/support-ops/registry
security: admin permission `admin:support_ops:registry:read`
```

Returns Support Ops resource descriptors, fields, actions, minimum count policy, and snapshot-size policy.

MVP resource registry:

| Resource | Default `minCount` | Default `maxSnapshotCount` | Implemented action |
| --- | --- | --- | --- |
| `User` | `10` | `10000` | `suspend` |

User fields:

| Field | Filterable | Aggregatable | Sensitive | Notes |
| --- | --- | --- | --- | --- |
| `status` | Yes | Yes | No | Enum: `active`, `suspended`, `locked`. |
| `lifecycle_state` | Yes | Yes | No | Enum lifecycle stage. |
| `email_verified` | Yes | Yes | No | Boolean. |
| `pii_status` | Yes | Yes | No | PII write/delete state, not raw PII. |
| `user_type` | Yes | Yes | No | Enum: `end_user`, `admin`, `m2m`. |
| `created_at` | Yes | No | No | Datetime. Filter comparisons normalize seconds and milliseconds. |
| `updated_at` | Yes | No | No | Datetime. Filter comparisons normalize seconds and milliseconds. |
| `last_login_at` | Yes | No | No | Datetime. Filter comparisons normalize seconds and milliseconds. |
| `email` | No | No | Yes | Reserved as sensitive and not selectable. |

Selector shape:

```json
{
  "all": [
    { "field": "status", "op": "eq", "value": "active" },
    { "field": "email_verified", "op": "eq", "value": true }
  ]
}
```

Selector rules:

- A selector is either a condition or a group.
- A group MUST include exactly one of `all` or `any`.
- A group may include 1-20 child selectors.
- `in` accepts 1-25 values.
- Enum values are validated server-side.
- Sensitive fields, unknown fields, and unsupported operators are rejected.
- Storage queries are parameterized; selectors do not accept raw SQL.
- Semantically equivalent selectors with different JSON key order may produce different selector hashes.

Supported operators:

| Operator | Meaning |
| --- | --- |
| `eq` / `ne` | Equal / not equal. |
| `in` | Value is in list. |
| `lt` / `lte` / `gt` / `gte` | Ordered comparison for datetime/number fields. |
| `exists` / `not_exists` | Null checks. |

### 12.2 Aggregates

```yaml
POST /api/admin/support-ops/aggregate
security: admin permission `admin:support_ops:aggregate:read`
```

Request:

```json
{
  "resource": "User",
  "selector": { "field": "status", "op": "eq", "value": "active" },
  "group_by": ["status"]
}
```

Response:

```json
{
  "resource": "User",
  "groups": [
    { "key": { "status": "active" }, "count": 120 }
  ],
  "suppressed_groups": 1,
  "privacy": {
    "min_count": 10,
    "count_precision": 10,
    "count_exact": false,
    "low_count_suppressed": true,
    "complementary_suppression": true
  }
}
```

Aggregate privacy rules:

- `group_by` must include 1-3 aggregatable fields.
- Counts are bucketed down to `count_precision`.
- Counts between 1 and `minCount - 1` are suppressed.
- If low-count suppression occurs, adjacent visible groups may also be suppressed to reduce differencing risk.
- Responses must declare `count_exact: false`.
- Audit metadata for aggregate requests records selector hash and suppression metadata, not exact suppressed group counts.
- Deployments MAY add tenant/operator query budgets or rate limits for stronger differencing resistance.

### 12.3 Cohort Preview and Creation

```yaml
POST /api/admin/support-ops/cohorts/preview
security: admin permission `admin:support_ops:cohorts:preview`
```

Preview estimates selector effect without creating a frozen target set. `intent.action` is optional for preview; when present it is used to calculate action-specific blockers.

```yaml
POST /api/admin/support-ops/cohorts
security: admin permission `admin:support_ops:cohorts:create`
```

```yaml
GET /api/admin/support-ops/cohorts/{cohort_id}
security: admin permission `admin:support_ops:cohorts:preview`
```

The cohort read endpoint returns cohort status, redacted counts, risk summary, support case id, expiration, and snapshot status. It is also the polling endpoint for async snapshot completion.

Creation request:

```json
{
  "resource": "User",
  "selector": { "field": "status", "op": "eq", "value": "active" },
  "intent": {
    "action": "suspend",
    "reason": "case cleanup",
    "support_case_id": "CASE-123"
  }
}
```

Creation rules:

- `intent.action` is required for cohort creation.
- The intended action is persisted and later action requests must match it.
- Matched count below `minCount` is rejected before snapshotting.
- The frozen actionable target set must also satisfy `minCount`.
- Low-count matched/actionable/blocked subsets are redacted in responses.
- `blocked_reasons` are suppressed when the blocked subset is low-count.
- Cohorts expire after 24 hours by default.
- Expired cohorts cannot be used for action request or execution.
- Synchronous snapshots are used up to `maxSnapshotCount`.
- Larger snapshots use a background job.

Snapshot rules:

- Cohort target sets are frozen against a creation-time cutoff.
- Snapshot selection filters out records created or updated after the cutoff.
- Datetime cutoff comparison normalizes seconds and milliseconds.
- Async snapshot jobs use a lease/stale-claim guard so only one worker advances a job at a time.
- Async snapshot jobs store sanitized failure codes such as `snapshot_processing_failed`, not raw exception messages.
- Admin Jobs surfaces must redact Support Ops snapshot job config and progress. They may expose cohort id, resource, intended action, selector hash, support case id, stage, and bucketed progress counts. They must not expose `selector_json` or exact target counts.

Cohort response:

```json
{
  "cohort_id": "cohort_123",
  "resource": "User",
  "intended_action": "suspend",
  "matched_count": 120,
  "actionable_count": 110,
  "blocked_count": 10,
  "blocked_reasons": ["not_active"],
  "blocked_reasons_suppressed": false,
  "privacy": {
    "min_count": 10,
    "low_count_suppressed": false
  },
  "snapshot_status": "completed",
  "snapshot_job_id": null,
  "expires_at": 1778323200000,
  "selector_hash": "sha256:..."
}
```

### 12.4 Approved Actions

```yaml
POST /api/admin/support-ops/actions
security: admin permission `admin:support_ops:actions:request`
```

Request:

```json
{
  "cohort_id": "cohort_123",
  "action": "suspend",
  "reason": "case cleanup",
  "support_case_id": "CASE-123"
}
```

Action request rules:

- Cohort must exist in the current tenant.
- Cohort must not be expired.
- Cohort snapshot must be `completed`.
- Requested action must match the cohort `intended_action`.
- The frozen actionable count must satisfy `minCount`.
- A linked approval request is created with `request_surface=support_ops`.
- The approval scope uses `redaction_level=summary_only`.
- Approval scope includes action id, cohort id, resource, action, selector hash, and redacted count summary.

```yaml
POST /api/admin/support-ops/actions/{action_id}/execute
security: admin permission `admin:support_ops:actions:execute`
```

```yaml
GET /api/admin/support-ops/actions/{action_id}
security: admin permission `admin:support_ops:actions:read`
```

The action read endpoint returns action status, linked approval request id, support case id, and redacted result summary.

Execution rules:

- Action must be approved before execution.
- Linked approval status is not sufficient by itself. The approval request must be bound to the same tenant, support action id, cohort id, requested action, and selector hash.
- The approval request itself must not be expired.
- The cohort must still be unexpired at execution time.
- The cohort snapshot must still be `completed`.
- Execution uses a conditional approved-to-running transition.
- Concurrent execution attempts must not both run.
- Execution failures mark the action `failed` with a sanitized result summary.
- Completed and failed result summaries returned through Support Ops APIs are redacted using the same count privacy policy.

MVP action behavior:

| Action | Resource | Behavior |
| --- | --- | --- |
| `suspend` | `User` | Sets active users in the frozen actionable target set to `status=suspended`, clears `suspended_until`, and records suspension/update timestamps. |

Reserved actions:

| Action | Status |
| --- | --- |
| `delete` | Reserved, not implemented. |
| `revoke_sessions` | Reserved, not implemented. |
| `resync_profile` | Reserved, not implemented. |

### 12.5 Approval, Duty Separation, and Break-Glass Compatibility

Support Ops approval defaults:

| Setting | Default |
| --- | --- |
| `support_ops.allow_self_approval` | `false` |
| `support_ops.duty_separation` | `requester_approver` |

Rules:

- When self approval is disabled, the requester cannot approve the linked approval request.
- `requester_approver` requires requester and approver to differ.
- `requester_approver_executor` additionally requires executor to differ from requester and approver.
- The legacy local `/actions/{action_id}/approve` route is only a compatibility fallback for actions without a linked approval request. Linked approval requests must be approved through the approval workflow.
- Future break-glass flows must use separate permissions and approval scopes. They must not weaken the cohort/action privacy contract.

Reserved break-glass permissions:

| Permission | Meaning |
| --- | --- |
| `admin:support_ops:break_glass:request` | Request individual detail access. |
| `admin:support_ops:break_glass:reveal` | Reveal approved individual detail. |

### 12.6 Audit and Error Handling

Support Ops audit rules:

- Audit records use `resourceType=support_ops`.
- Audit metadata must not contain exact low-count matched/actionable/blocked values.
- Audit metadata should include selector hash, support case id, action, resource, status, suppression flags, and redacted count summaries.
- Raw storage/adapter exception messages must not be returned to API callers.
- User-facing Support Ops API errors use stable codes such as `invalid_selector`, `invalid_cohort`, `cohort_expired`, `cohort_snapshot_not_ready`, `approval_scope_mismatch`, and `execution_failed`.

## 13. SAML 2.0

Authrim exposes tenant-scoped SAML 2.0 IdP and SP behavior. SAML support is part of the standard
runtime capability set in setup-generated deployments, while individual SAML providers and
federation partners are configured in Admin UI.

### 13.1 Local Authrim Entity Metadata

Each tenant can expose local Authrim IdP and SP registration metadata.

Default endpoint references:

| Role | Endpoint | Default URL pattern |
| --- | --- | --- |
| IdP | SSO | `{tenantIssuer}/saml/idp/sso` |
| IdP | Metadata | `{tenantIssuer}/saml/idp/metadata` |
| IdP | SLO | `{tenantIssuer}/saml/idp/slo` |
| SP | ACS | `{tenantIssuer}/saml/sp/acs` |
| SP | Metadata | `{tenantIssuer}/saml/sp/metadata` |
| SP | SLO | `{tenantIssuer}/saml/sp/slo` |

Published entityID style is tenant-wide:

| Style | IdP entityID | SP entityID |
| --- | --- | --- |
| `metadata_url` | `{tenantIssuer}/saml/idp/metadata` | `{tenantIssuer}/saml/sp/metadata` |
| `role_url` | `{tenantIssuer}/saml/idp` | `{tenantIssuer}/saml/sp` |

Changing published entityIDs affects SAML trust. Existing SP/IdP configurations may need updated
metadata, audience settings, issuer settings, and certificate validation review before production
use.

### 13.2 Signing Certificates

Authrim local SAML signing keys are modeled per role and slot:

| Slot | Meaning |
| --- | --- |
| `active` | Current signing key and primary metadata certificate. |
| `next` | Published future certificate used during rollover preparation. |
| `backup` | Previous certificate kept in metadata while partner caches age out. |

Operators can recreate local signing material, publish next, promote next, and retire backup through
Admin UI/API. The default certificate subject is configurable for newly generated certificates and
supports common subject attributes such as country, state/province, locality, organization,
organizational unit, and common name.

Admin surfaces display certificate subject, issuer, validity, public key algorithm, signature
algorithm, SHA-1 fingerprint, SHA-256 fingerprint, PEM copy, and PEM download.

### 13.3 Metadata Import and Provider Login Presentation

SAML provider import supports direct provider metadata and aggregate metadata selection. Aggregate
imports can expose candidate entity display names, entity IDs, SSO endpoints, `mdui:Keywords`, and
`mdui:Logo` values.

When imported providers are used as Login UI methods:

- `mdui:Logo` can be stored as the provider logo URL.
- Login UI displays the logo in a square long-edge-fit container.
- If no logo URL is configured, the provider can use a curated login-button icon.
- Provider icon selection supports an explicit no-icon option.

### 13.4 Interactive Login Redirect Policy

SAML flows sometimes need interactive login before the IdP can produce a response. Authrim supports
two tenant-wide redirect policies:

| Policy | Behavior |
| --- | --- |
| `tenant_host` | Sends users to the tenant `/login` URL. This is the default for SAML. |
| `ui_base_url` | Sends users to the shared Login UI `/login` with a tenant hint. |

Admin UI previews the selected login URL and first visible page. The preview uses tenant discovery
settings, including tenant override behavior. If the common entry is configured as WAYF-only, the
first visible page is the tenant chooser and the email/discovery method UI is hidden.

### 13.5 Tenant Discovery and WAYF

Tenant discovery supports configured discovery methods plus WAYF-style tenant selection. WAYF lists
registered tenants and lets the user choose the tenant explicitly. If WAYF is the only enabled
common-entry method, Authrim shows only the tenant dropdown.

### 13.6 SAML Operational Rules

- Tenant-scoped request correlation is used for AuthnRequest, LogoutRequest, ACS, SLO, artifact
  state, and IdP-initiated multi-SP SLO fanout.
- Metadata refresh stores diff and expiry state rather than silently ignoring expired metadata.
- Response/assertion signing policy, AuthnRequest signature policy, SLO signature policy, and
  algorithm allow-lists are configurable.
- Optional encrypted assertion and encrypted NameID support are available with modern defaults and
  legacy algorithm opt-in.
- Transient SAML state is short-lived and not considered DR state.
- Active SAML sessions are not migrated during failover; failover assumes re-authentication.

## 14. Storage Portability

Authrim separates storage concerns into boundary classes. This section is public because operators need to know what can be moved to external storage and what remains part of Authrim's core runtime.

### 14.1 Profile Model

Authrim recognizes three profile categories:

| Profile category | Purpose |
| --- | --- |
| Storage profile | Places auth core, PII, custom/extension, and related data. |
| Audit profile | Places audit primary/archive/sink targets and routing. |
| Residency profile | Describes residency expectations for data placement. |

Profile rules:

- An environment has default profiles.
- A tenant stores profile pointers rather than full profile JSON.
- Tenant overrides are allowed only for supported boundary classes.
- Registry backend may vary by deployment profile.

### 14.2 Built-In Storage Profiles

| Profile | Default behavior |
| --- | --- |
| `builtin:storage:standard` | D1-centered default with separated PII support where configured. |
| `builtin:storage:single-db` | Compatibility profile; setup mirrors PII schema into the core DB. |
| `builtin:storage:eu-pii-split` | PII plane is separated for EU/data-residency use cases. |
| `builtin:storage:external-postgres` | External Postgres-capable profile for supported planes. |

### 14.3 Boundary Classes

| Boundary class | Tenant override | D1 default | Non-D1 option required | Typical data |
| --- | --- | --- | --- | --- |
| Auth core plane | No | Yes | Not initially | Clients, passkeys, roles, org membership, consents, session clients, device secrets, refresh token family metadata, security-sensitive cold persistence. |
| PII plane | Yes | Yes | Yes | `users_pii`, linked identities, subject identifiers, PII tombstones, PII audit data. |
| Custom / extension plane | Yes | Yes | Yes | Custom claims, registration fields, user custom fields, custom attributes JSON. |
| Audit profile | Yes | Not fixed to D1 | Yes | Audit primary store, archive store, forwarding sinks. |
| Control plane | No | D1/KV-biased today | Not a tenant user-data requirement | Tenants, settings, runtime profile registry, admin DB. |
| DO/KV canonical state | n/a | n/a | n/a | Refresh token rotator canonical state, session/device/CIBA hot state, cache/sharding metadata. |

Important rules:

- `users_core` is a historical shorthand for the auth core relational plane. It does not mean tenant-specific user-data backend switching is allowed.
- Auth core tenant-specific backend switching is not supported by the current public contract.
- PII, custom/extension, and audit are the first-class tenant override targets.
- Control plane and health/adapter implementation paths may still use D1/KV-specific bindings.
- Business paths for auth core, PII, custom, and audit SHOULD use runtime source resolvers or adapter helpers rather than ad hoc raw database binding access.
- Admin UI database connection inventory includes setup-managed D1 bindings such as core, PII,
  and Admin databases. These rows are read-oriented operational inventory and may show tenant
  assignment badges when a tenant database registry row points at the binding/connection.
- Shared D1 deployments may show multiple tenant badges on one setup-managed database connection.
- Storage destination inventory includes setup-managed R2 bindings and registry-backed R2/S3/sink
  destinations. Setup-managed destinations are read-only from the destination editor and are used
  to make actual deployment resources visible to operators.

### 14.4 Custom Schema Validation

| Field | Meaning | Default |
| --- | --- | --- |
| `is_required` | Canonical server-side required flag. | `false` |
| `registration_required` | Built-in LoginUI/signup required flag. | `false` |
| `show_on_registration` | Whether the field appears on registration. | `true` unless configured otherwise |

Write paths that must share validation semantics:

- signup
- admin user create/update
- SCIM create/replace/patch/bulk
- federation/JIT provisioning
- anonymous upgrade

Missing required fields return:

```json
{
  "error": "missing_required_fields",
  "fields": [
    {
      "field_key": "department",
      "label": "Department",
      "field_type": "string"
    }
  ]
}
```

### 14.5 Lifecycle Fields

| Field | Meaning |
| --- | --- |
| `status` | Operational access-control status. |
| `user_type` | Principal type. |
| `lifecycle_state` | Account lifecycle state. |

Default materialized lifecycle states include `active` and `incomplete`.

### 14.6 Migration and SQL Portability

Current public migration contract:

- Fresh schema creation is the supported public path for this pre-1.0 version.
- The root `migrations/` directory is the canonical migration source used by setup.
- Setup no longer relies on a separate mirrored setup migration tree.
- Existing pre-consolidation environments are not guaranteed to be upgrade-compatible.
- Follow-up in-place migrations require a separate specification before implementation.

## 15. Audit and Managed Logging

### 15.1 Audit Profile

Audit is a separate profile, not a storage slice.

Supported target categories:

| Target category | Supported targets |
| --- | --- |
| Primary store | D1, PostgreSQL + Hyperdrive, MySQL + Hyperdrive |
| Archive store | R2 |
| Forwarding sink | Cloudflare Logpush, generic HTTPS sink |

Defaults:

| Setting | Default / Behavior |
| --- | --- |
| Request-path primary write | Synchronous primary write. |
| Archive/sink fan-out | Queue consumer fan-out. |
| Archive-only profile | Allowed with `primary=null`. |
| Archive-only hot query/cleanup | `not_supported`. |
| Failure mode | Controlled by `archiveFailureMode` and `sinkFailureMode`. |
| Legacy `audit_log` write | Transitional compatibility behavior. |
| Queue consumer package | `ar-management`. |

### 15.2 Managed Logging Model

Managed logging separates the event type from the storage/delivery plane.

Log types:

| Type | Typical data |
| --- | --- |
| `normal` | General operational logs. |
| `audit` | End-user, protocol, and tenant audit evidence. |
| `admin_audit` | Admin UI/API operations. |
| `security` | Security-relevant runtime events. |
| `pii` | PII-related evidence and access records. |
| `diagnostic` | Troubleshooting records. |
| `job` | Background job activity. |
| `webhook` | Webhook delivery and callbacks. |
| `operational` | Platform operational state. |

Planes:

| Plane | Purpose |
| --- | --- |
| `primary` | Hot/queryable primary storage. |
| `archive` | Object archive such as R2/S3 JSONL chunks. |
| `external_sink` | External forwarding destination. |
| `sensitive_detail` | Separately protected sensitive detail chunks. |
| `diagnostic_detail` | Short-retention diagnostic detail. |
| `delivery_event` | Delivery/DLQ/retry telemetry. |

### 15.3 Storage Destinations

Storage destinations define where managed logs, artifacts, and sensitive detail are written.

Supported provider names include `r2`, `aws_s3`, `http`, `logpush`, `analytics_engine`,
`firehose`, `external`, and `custom`.

Destination capabilities include `archive_write`, `sensitive_detail_write`, `log_sink_write`,
`dlq_replay_payload_write`, and `export_artifact_write`.

Setup-managed R2 bindings may be surfaced as read-only destinations for avatars, diagnostic logs,
audit archive, import artifacts, export artifacts, and sensitive detail.

### 15.4 Runtime Policy Snapshots

Runtime logging policy is published as snapshots. A snapshot contains destination assignments,
fallback behavior, destination metadata, critical/fallback eligibility, and tenant/platform scope.
Workers resolve logging plans from the published snapshot pointer rather than from mutable draft
rows.

### 15.5 Audit Routing

Routing rule shape:

```json
{
  "targets": {
    "primaryStore": "primary-d1",
    "archiveStores": ["archive-r2"],
    "forwardingSinks": ["logpush"]
  },
  "retention": {}
}
```

Defaults:

- `primaryStore` is first-match wins.
- `archiveStores` and `forwardingSinks` are unioned across matched rules.
- Matched retention override is applied to the delivery plan.

### 15.6 Canonical Audit Format

Canonical payload format: `authrim.audit.v1`

Applied to:

- R2 JSONL archive
- Logpush structured logs
- generic HTTPS sink payload

## 16. Workers-Native UI Deployment

Supported public deployment path:

- Authrim API: Cloudflare Workers
- AdminUI: Cloudflare Workers static assets / SSR
- LoginUI: Cloudflare Workers static assets / SSR
- setup CLI: generates Workers deployment configuration

Defaults:

| Area | Default |
| --- | --- |
| UI deployment command | `wrangler deploy` |
| Pages deployment | Not the supported UI deployment path |
| LoginUI route handling | OAuth/OIDC core endpoints stay on core Authrim Workers; UI proxy/session/callback routes remain on LoginUI Worker. |
| AdminUI pilot | AdminUI is the lower-risk UI deployment pilot before LoginUI changes. |
| Setup runtime | `ui_runtime: workers` |

LoginUI Worker route policy:

- Core OAuth/OIDC endpoints such as `/authorize`, `/token`, `/userinfo`, `/introspect`, `/revoke`, `/register`, and `/.well-known/*` remain core Authrim endpoints.
- LoginUI keeps UI-owned routes such as callback/handoff finalize, login methods proxy, Direct Auth session support, logout UI behavior, and local UI language route where applicable.

## 17. Compatibility and Legacy Behavior

| Legacy surface | Public behavior |
| --- | --- |
| `/api/v1/auth/direct/token` | Must not issue tokens. Returns compatibility error such as `legacy_endpoint_not_supported` with `error_uri`. |
| `GET /api/admin/sessions/me` | Removed surface. Use `GET /api/admin/me/session` where available. |
| Discovery field `native_sso_token_exchange_supported` | Removed. Use `native_sso_supported`. |
| Discovery field `native_sso_device_secret_supported` | Removed. Use `native_sso_supported`. |
| Legacy `app_suite` runtime/public config | Not supported. Use `application_group`. |
| Query/form bearer token on Authrim endpoints | Not supported. Use Authorization header. |
| Implicit/Hybrid/Form Post/session-management/front-channel/back-channel/DCR conformance features | Supported only through explicit OP conformance / compatibility settings. Not selected by default SDK/LoginUI profiles. |
| iframe-based OIDC auth | Optional compatibility feature, default off. |

Exact compatibility errors:

| Error code | Default severity | `error_uri` |
| --- | --- | --- |
| `legacy_app_suite_not_supported` | fatal | Always returned |
| `legacy_native_sso_discovery_unsupported` | fatal | Always returned |
| `legacy_endpoint_not_supported` | fatal | Always returned |
| `legacy_passkey_error_unsupported` | fatal | Always returned |

Compatibility error rules:

- Authrim does not introduce an umbrella compatibility error code for these cases.
- Official SDKs surface the exact code as-is.
- Official SDKs treat these errors as fatal protocol/deployment compatibility errors.
- Stable English messages are returned.
- `error_uri` is returned for all four exact compatibility errors.
- `error_uri` is an absolute HTTPS URL using the public documentation canonical host.
- `error_uri` anchor naming uses the exact code name in kebab-case, for example `#legacy-native-sso-discovery-unsupported`.
- Step-up error responses do not use `error_uri`.

Legacy passkey error handling:

| Removed server/public code | Canonical SDK-generated code |
| --- | --- |
| `passkey_cancelled` | `passkey_user_canceled` |
| `passkey_not_found` | `passkey_no_credential` |
| `passkey_verification_failed` | `passkey_invalid_credential` |

Official SDKs classify inbound legacy passkey server errors as `legacy_passkey_error_unsupported` rather than silently normalizing a stale server protocol.

Legacy app-suite config hard-fail policy:

- Runtime config containing `app_suite` fails at load time.
- Config containing both `application_group`/internal trust-group data and `app_suite` fails even if values match.
- Admin/config write APIs receiving `app_suite` return `400 invalid_request` with `error_details.code=legacy_app_suite_not_supported`.

## 18. Error Shape

Authrim errors are machine-readable. OAuth/OIDC endpoints use OAuth/OIDC-compatible fields where applicable.

Common fields:

| Field | Meaning |
| --- | --- |
| `error` | Stable machine-readable error code. |
| `error_description` | Human-readable summary. |
| `error_uri` | Migration or documentation URI when applicable. |
| `error_details` | Optional machine-readable details, including nested `code` when a top-level OAuth error must remain standard. |
| `details` | Optional structured details. |

Error detail rules:

- `error_details.code` uses machine-readable snake_case.
- When `error_details` is returned for validation or retry semantics, `retryable` is also returned.
- Delegated field validation may additionally return `field`.

Examples:

```json
{
  "error": "missing_required_fields",
  "error_description": "Required fields are missing.",
  "details": {
    "fields": [
      {
        "field_key": "department",
        "label": "Department",
        "field_type": "string"
      }
    ]
  }
}
```

```json
{
  "error": "dpop_nonce_required",
  "error_description": "A fresh DPoP proof with the provided nonce is required."
}
```

## 19. Public Configuration Reference

### 19.1 Client Metadata

| Field | Default | Notes |
| --- | --- | --- |
| `browser_public_client_mode` | built-in LoginUI: `cookie_fallback`; custom browser public client: `strict` | Persisted compatibility enum. Public profile names are `managed_browser_session`, `cookie_session`, and `token_session`. |
| `browser_refresh_token_policy` | `disabled` | `dpop_bound` is explicit opt-in. |
| `dpop_bound_access_tokens` | policy dependent | Required for token-session browser public clients. |
| `handoff_artifact_ttl_seconds` | `60` | Policy range 30-300 seconds. |
| `allowed_redirect_origins` | empty | Legacy/fallback origin source when `web_origin_registry` is not configured. |
| `application_group` | none | Public grouping surface; maps to internal security boundary. |
| `web_origin_registry` | none | Source of truth for browser handoff/CORS/iframe metadata when configured. |

`browser_public_client_mode` values:

| Mode | Meaning |
| --- | --- |
| `strict` | Browser token path requires DPoP. If DPoP preflight/key setup fails, token path is unavailable. |
| `cookie_fallback` | Hosted/built-in/BFF-style cookie session path. Browser JavaScript does not receive token material. |
| `legacy` | Compatibility mode for custom browser clients only. Requires explicit opt-in and is never used by built-in LoginUI. |

Native SSO client metadata:

| Field | Default | Notes |
| --- | --- | --- |
| `native_sso_supported` | deployment/client policy dependent | Authoritative discovery capability when enabled. |
| `application_type` | client registration dependent | Native public-client exchange eligibility requires `native`. |
| Native channel permission | disabled unless configured | Required for public-client Native SSO exchange. |
| Cross-client Native SSO | disabled | Requires explicit `application_group` policy. |
| Device secret rotation policy | disabled | Explicit tenant policy may enable rotation. |

### 19.2 Web Origin Registry

| Field | Default |
| --- | --- |
| `cors.allowed` | `false` |
| `handoff_allowed` | `false` |
| `iframe_allowed` | `false` |
| `csp.frame_ancestors` | empty |
| `environment` | deployment default |

### 19.3 Deployment Flags

| Flag | Default | Notes |
| --- | --- | --- |
| `ENABLE_IFRAME_OIDC_AUTH` | `false` | Enables optional iframe OIDC metadata only when origin/client policy also allows it. |
| UI runtime | `workers` | setup-generated UI deployment uses Workers. |

### 19.4 Support Ops Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `support_ops.allow_self_approval` | `false` | When false, a Support Ops requester cannot approve their own action request. |
| `support_ops.duty_separation` | `requester_approver` | Allowed values are `requester_approver` and `requester_approver_executor`. |

Support Ops registry defaults are part of the runtime contract:

| Registry field | Default |
| --- | --- |
| `User.minCount` | `10` |
| `User.maxSnapshotCount` | `10000` |
| `User.actions.suspend.implemented` | `true` |
| `User.actions.delete.implemented` | `false` |
| `User.actions.revoke_sessions.implemented` | `false` |
| `User.actions.resync_profile.implemented` | `false` |

### 19.5 SAML Tenant Settings

| Setting | Default | Notes |
| --- | --- | --- |
| SAML entityID style | `metadata_url` | May be changed to `role_url`; changing this affects partner trust. |
| SAML interactive login redirect | `tenant_host` | May be changed to `ui_base_url` when shared Login UI entry is desired. |
| SAML signing certificate subject | `O=Authrim, CN=Authrim SAML Signing` plus deployment defaults | Applies to newly generated local SAML certificates. |

## 20. Security Requirements Checklist

Implementations and integrations SHOULD verify:

- Authorization Code + PKCE is the default browser-facing flow.
- Built-in LoginUI does not return token material to browser JavaScript.
- Browser token-session access tokens are memory-only by default.
- Browser refresh tokens are disabled unless explicitly `dpop_bound`.
- DPoP nonce retry happens once.
- Refresh retry happens once.
- Mutating request replay requires `Idempotency-Key`.
- Cookie sessions use HttpOnly, Secure, SameSite, CSRF, and Origin/Referer checks.
- Query/form bearer tokens are rejected.
- Handoff artifacts are single-use and short-lived.
- Cross-domain SSO uses top-level redirect/handoff by default.
- iframe OIDC is disabled unless explicitly enabled by feature flag and origin/client policy.
- Native SSO uses `device_secret`, not refresh-token sharing.
- Native public-client SSO exchange requires `channel=native`, client metadata eligibility, and DPoP.
- Cross-client Native SSO is disabled unless explicitly enabled by application-group policy.
- Device-secret revoke/introspection uses caller-class authorization; grouping alone is not permission.
- Device-secret rotation is disabled unless tenant policy enables it.
- `/me/devices` operates on installation records and unlink does not cascade to sibling cross-client installations.
- Delegated writes keep actor and subject separate and require `Idempotency-Key`.
- Step-up receipts are single-use, short-lived, and sent through `Authrim-Step-Up-Receipt`.
- Support Ops aggregate counts are bucketed and marked `count_exact=false`.
- Support Ops low-count matched/actionable/blocked subsets are suppressed or rejected.
- Support Ops audit metadata does not leak exact suppressed counts.
- Support Ops cohort snapshots are action-bound, tenant-bound, cutoff-bound, and expire before execution.
- Support Ops action execution revalidates cohort expiry, snapshot completion, approval expiry, and approval scope binding.
- Support Ops self approval is disabled by default, and stronger requester/approver/executor separation is available.
- Support Ops Admin Jobs config/progress output does not expose selector JSON or exact target counts.
- PII/custom/audit storage boundaries are not collapsed into auth core by accident.
- Public configuration uses `application_group` and `web_origin_registry` naming.
