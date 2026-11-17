# Connection settings API contracts

Contract inventory recorded before implementation. All routes below are Admin routes.

| Screen group / fields                          | Runtime storage and API contract                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RP sign-in / public keys                       | POST `/api/admin/clients`, PUT/GET `/api/admin/clients/:id`: `token_endpoint_auth_method`, `token_endpoint_auth_signing_alg`, `jwks_uri` or `jwks`. Repository already stores these fields; Admin mutation needs explicit validation and persistence. Public keys only; changing source must clear the other source atomically.                                                                                                           |
| RP profile / grants                            | Client row: `description`, `logo_uri`, `client_uri`, `policy_uri`, `tos_uri`, `contacts`, `minimum_ial`, `grant_types`, `browser_refresh_token_policy`. No mapping fields in this update.                                                                                                                                                                                                                                                 |
| RP token signing / logout                      | Client row: `id_token_signed_response_alg`, `userinfo_signed_response_alg`, `post_logout_redirect_uris`, `frontchannel_logout_uri`, `frontchannel_logout_session_required`, `backchannel_logout_uri`, `backchannel_logout_session_required`. Logout fields need Admin wiring; repository and runtime already support them.                                                                                                                |
| RP token lifetimes / refresh / security        | GET/PATCH `/api/admin/clients/:id/settings/oauth` owns `oauth.id_token_expiry`, `oauth.refresh_token_rotation`, `oauth.refresh_token_sliding_window_enabled`, `oauth.refresh_token_absolute_expiry_enabled`, `oauth.refresh_token_absolute_expiry`. `settings/security` owns `security.dpop_bound_access_tokens`, `security.require_encrypted_request_object`. Use API values/sources/locked and PATCH `ifMatch`, not prototype defaults. |
| RP security / exchange                         | Client row: `subject_type`, `sector_identifier_uri`, `skip_consent`, `tls_client_certificate_bound_access_tokens`, `token_exchange_allowed`, `delegation_mode`, `allowed_subject_token_clients`, `client_credentials_allowed`, `allowed_scopes`, `default_audience`. Web origins use the separate `web_origin_registry` contract and must not replace it with the prototype list.                                                         |
| SP endpoints / signing                         | PUT/GET `/api/admin/saml-providers/:id`, partial `config`: `acsUrls`, `sloUrl`, `sloBinding`, `allowedBindings`, `samlProfile`, `signResponses`, `signAssertions`, `authnRequestSignaturePolicy`, `logoutRequestSignaturePolicy`, `logoutResponseSignaturePolicy`, `authnRequestLegacyAlgorithmPolicy`. Existing certificate/mapping/unknown config remains in the backend merge.                                                         |
| SP encryption / assertion / refresh            | Same config: `encryptAssertions`, `encryptNameID`, `encryptionCertificate`, `assertionEncryptionAlgorithm`, `keyEncryptionAlgorithm`, `assertionValiditySeconds`, `authnContextClassRefMode`, `minimumIal`, `minimumAal`, `metadataRefreshPolicy.{mode,intervalSeconds}`. No fabricated inheritance. Legacy XML encryption also requires its separate algorithm policy; do not infer it from signature policy.                            |
| OP endpoints / accounts / button               | PUT/GET `/api/admin/external-providers/:id`: snake_case mutation names map to camelCase reads: endpoint URLs, `token_endpoint_auth_method`, `always_fetch_userinfo`, `jit_provisioning`, `trust_email`, `profile_update_fields`, `enable_sso`, `button_text`, `button_color`, `priority`. Preserve stored credentials and provider quirks.                                                                                                |
| IdP endpoints / assertion / accounts / refresh | SAML partial config: `ssoUrl`, `sloUrl`, `allowedBindings`, `providerName`, `logoutRequestSignaturePolicy`, `logoutRequestLegacyAlgorithmPolicy`, `nameIdFormat`, `authnContextPolicy`, `jitEmailLinkingPolicy`, `allowSyntheticEmailFallback`, `profileUpdateFields`, `metadataRefreshPolicy`. Certificate facts only from `certificateValidation`.                                                                                      |

RP PUT requires `admin:clients:write`. SAML writes retain the existing step-up flow and `expectedUpdatedAt`. RP client-row edits add optional `expected_updated_at` and use repository CAS. Settings categories keep their own permissions and version. OP currently lacks a conditional update; an explicit version check must be added before enabling advanced writes.

Prototype-only controls: OP templates are creation aids, not a persisted setting. OP hybrid response type and ID-token algorithm have no top-level Admin/runtime contract. JAR/FAPI needs a separate credential lifecycle and is unavailable in this slice. SAML inherited defaults are not returned by this API. Connection tests and endpoint downloads require separate real operations and are unavailable here. Incoming graph mapping and metadata parsing are owned by other slices.

## Public RP key lifecycle

An outgoing OIDC RP signs assertions using its own private key. Authrim, acting as OP, registers
only the corresponding public JWKS or HTTPS JWKS URI. Never paste or upload a private key. This
screen does not generate a private key, issue a dummy secret, or turn a public SPA/native client
into a confidential client. Existing secret clients may retain their secret while moving to key
authentication; switching back requires the separate credential lifecycle and is unavailable here.

Each registered key has a unique `kid`. Supported signing keys are RSA 2048–8192 bits (RS256 or
PS256), P-256 (ES256), and Ed25519 (EdDSA). To rotate inline keys, publish old and new public keys
together, change the app to sign with the new `kid`, and remove the old public key after its assertion
validity window. For a URI source, the app owns publication and rotation. Registration validates the
public HTTPS URL and its usable signing keys with bounded, SSRF-protected transport. Runtime
assertion authentication still retrieves and verifies the public keys. A source change sends the new
source and explicitly clears the other in the same Admin client-row update.

General settings use changed fields only and preserve mapping, credentials, certificates and unknown
extensions. Client row updates use `expected_updated_at`; SAML uses `expectedUpdatedAt`; Settings
API categories use `ifMatch` and the API's effective values, source information and locks. OP updates
now support optional `expected_updated_at` and use a conditional SQL update. Old callers remain
compatible; key/authentication edits also use the loaded row version even when the caller omits a version, preventing an inconsistent concurrent key-source change; the live editor always sends the loaded version. Conflicts require an explicit reload;
there is no automatic rebase over an unsaved draft.

## Editor limits

- Web origin registry membership is a structured contract with purpose flags. The prototype's flat
  web-origin list cannot faithfully represent it; this editor leaves the registry unchanged.
- JAR/FAPI setup for an upstream OP needs a supported Authrim credential lifecycle. These controls,
  hybrid response type and expected upstream ID-token algorithm are unavailable in this editor.
- A SAML profile selection fills the visible signing choices. Per-algorithm lists remain explicit;
  legacy signatures require both explicit opt-in and the appropriate accepted algorithm/digest URIs.
  Legacy XML encryption uses its own `encryptionAlgorithmPolicy`.
- Metadata automatic refresh is available only for a provider with a stored metadata source URL.
  Import, source selection and parsing are separate work. The refresh policy itself is editable here.
- No SAML platform/tenant inheritance is invented. Missing values are shown as unset; certificate
  validity/fingerprints are shown only when the API provides its validation summary.
- Connection tests and endpoint download buttons are absent until real operations are available.
  Mapping remains on the Mapping node, including incoming graph mapping in its separate slice.
