---
project: Authrim
lang: en
date: 2026-05-11
description: "Authrim feature and SDK matrix."
type: reference
tags:
  - authrim
  - features
  - sdk
  - identity-platform
---
# Authrim Feature Matrix

Authrim is pre-1.0. This matrix separates implementation coverage, validation level, and production readiness.

## Status Legend

| Column | Value | Meaning |
| --- | --- | --- |
| Implementation | Complete | Feature is implemented end-to-end for the documented scope. |
|  | Basic complete | Main protocol or runtime path exists, but some operational surface remains. |
|  | Partial | Important pieces exist, but the feature is not usable as a complete capability yet. |
|  | Planned | Not implemented yet. |
| Validation | Certified | Validated through formal certification. |
|  | Unit/integration tested | Covered by automated tests in this repository. |
|  | Partial | Some automated tests exist, but broader interop or E2E coverage is still needed. |
|  | Not yet | Validation is not yet meaningful or not yet started. |
| Production readiness | Ready | Suitable for production use within documented constraints. |
|  | In progress | Release hardening, docs, interop, or operational work remains. |
|  | Experimental | Available, but intended for evaluation. |
|  | Not in scope | Intentionally not supported under the current architecture. |

## Protocol and Platform Capabilities

| Area | Implementation | Validation | Production readiness | Notes |
| --- | --- | --- | --- | --- |
| OpenID Provider | Complete | Certified | Ready | OpenID Provider profiles and Logout profiles |
| OpenID Provider certification profiles | Complete | Certified | Ready | Basic, Implicit, Hybrid, Config, Dynamic, Form Post, and Third-Party Initiated OP |
| OpenID Provider Logout profiles | Complete | Certified | Ready | RP-Initiated, Session, Front-Channel, and Back-Channel Logout OP |
| OpenID Relying Party / federation client | Basic complete | Partial | In progress | External IdP bridge support exists; broader RP conformance is not a release target |
| Authorization Code + PKCE | Complete | Certified | Ready | Standard OAuth/OIDC browser flow |
| Implicit and Hybrid Flow | Complete | Certified | Ready | Supported for OP conformance and compatibility |
| Form Post Response Mode | Complete | Certified | Ready | Supported by OP conformance profiles |
| Third-Party Initiated Login | Complete | Certified | Ready | Supported by OP conformance profiles |
| Dynamic Client Registration | Complete | Certified | Ready | RFC 7591 |
| PAR | Complete | Unit/integration tested | In progress | RFC 9126 |
| DPoP | Complete | Unit/integration tested | In progress | RFC 9449 |
| JAR | Complete | Unit/integration tested | In progress | RFC 9101 |
| JARM | Complete | Unit/integration tested | In progress | Signed authorization responses |
| JWE | Complete | Unit/integration tested | In progress | Encrypted token support |
| Pairwise Subject Identifiers | Complete | Unit/integration tested | In progress | Pairwise subject generation |
| Claims Parameter | Complete | Unit/integration tested | In progress | Claims request parsing, scope policy, and claim-level release policy |
| OIDC Advanced Syntax for Claims | Complete | Unit/integration tested | In progress | Selective Abort/Omit and predefined transformed claims |
| OIDC Session Management | Complete | Certified | Ready | `session_state` and configurable `check_session_iframe` |
| Token Introspection | Complete | Unit/integration tested | In progress | RFC 7662 |
| Token Revocation | Complete | Unit/integration tested | In progress | RFC 7009 |
| Token Exchange | Complete | Unit/integration tested | In progress | RFC 8693 |
| ID-JAG | Complete | Unit/integration tested | Experimental | Identity Assertion Authorization Grant draft support |
| Client Credentials | Complete | Unit/integration tested | In progress | RFC 6749 section 4.4 |
| Private Key JWT | Complete | Unit/integration tested | In progress | Client authentication |
| JWT Signing and Key Rotation | Complete | Unit/integration tested | In progress | Durable Object backed key management |
| Refresh Token Rotation | Complete | Unit/integration tested | In progress | Refresh token family tracking and theft detection support |
| NIST Assurance Levels | Complete | Unit/integration tested | In progress | AAL/FAL/IAL claims and policy hooks |
| SAML 2.0 IdP/SP | Basic complete | Partial | In progress | IdP/SP endpoints, metadata, SSO/SLO, provider admin, and XML security tests exist; tenant scoping, interop, and DR-readiness remain active work |
| SCIM 2.0 | Complete | Unit/integration tested | In progress | User provisioning |
| Device Flow | Complete | Unit/integration tested | In progress | RFC 8628 |
| CIBA | Complete | Unit/integration tested | In progress | OpenID Connect CIBA |
| JWT Bearer | Complete | Unit/integration tested | In progress | RFC 7523 |
| Native SSO | Complete | Unit/integration tested | In progress | OIDC Native SSO draft support for `device_secret`, `ds_hash`, DPoP-bound token exchange, revoke/introspection, and device management; release hardening remains |
| Direct Auth | Complete | Unit/integration tested | In progress | Headless/direct passkey, email code, social, anonymous, and managed browser session flows |
| Passkey/WebAuthn | Complete | Unit/integration tested | In progress | Direct authentication and registration flows |
| Passkey Conditional UI | Complete | Unit/integration tested | In progress | Browser autofill integration support |
| Email Code/OTP | Complete | Unit/integration tested | In progress | Passwordless authentication |
| Social Login | Complete | Unit/integration tested | In progress | External OIDC/OAuth providers |
| Anonymous Login and Upgrade | Complete | Unit/integration tested | In progress | Anonymous user creation and account upgrade flow |
| Identity Linking | Complete | Unit/integration tested | In progress | Link multiple identities to one user |
| Identity Stitching | Complete | Unit/integration tested | In progress | Determine identity across sources |
| RBAC / ABAC / ReBAC | Complete | Unit/integration tested | In progress | Policy engine and relationship-based checks |
| Real-time Check API | Complete | Unit/integration tested | In progress | Runtime authorization checks |
| WebSocket Push | Complete | Unit/integration tested | In progress | Authorization update push channel |
| Custom Claims | Complete | Unit/integration tested | In progress | Schema-driven custom claims for tokens, UserInfo, introspection, and VC targets |
| OpenID4VP | Complete | Unit/integration tested | Experimental | Verifiable presentation verification |
| OpenID4VCI | Complete | Unit/integration tested | Experimental | Credential issuance |
| SD-JWT | Complete | Unit/integration tested | Experimental | Selective disclosure utilities and VC-oriented support |
| DID support | Complete | Unit/integration tested | Experimental | did:web and did:key |
| PII/non-PII separation | Complete | Unit/integration tested | In progress | Separate storage and access boundaries |
| Runtime storage profiles | Partial | Partial | In progress | Runtime profiles and Hyperdrive-backed PII/custom/audit paths exist; auth core tenant-specific backend switching is not part of the public contract |
| Admin UI | Basic complete | Partial | In progress | Broad surface exists; consolidation is a release workstream |
| Login UI | Basic complete | Partial | In progress | Production flow readiness is a release workstream |
| UI localization | Basic complete | Partial | In progress | Admin/Login UI currently focus on English and Japanese; setup tooling has broader locale files |
| Setup tooling | Complete | Unit/integration tested | In progress | Production deployment documentation is still being refined |

## SDK Packages

| Package | Status | Primary use case |
| --- | --- | --- |
| `@authrim/core` | Implemented | Platform-agnostic OIDC/PKCE client utilities |
| `@authrim/web` | Implemented | Browser SDK for direct auth and OAuth flows |
| `@authrim/server` | Implemented | Server-side token validation and middleware |
| `@authrim/sveltekit` | Implemented | SvelteKit integration |
| `@authrim/react` | Future candidate | React hooks and components |
| `@authrim/vue` | Future candidate | Vue integration |

## SDK Capability Overview

Values: `Yes` means public/high-level support, `Helper` means exported lower-level support, `Internal` means used by the SDK but not exposed as a public capability, and `No` means no public SDK support. Other short labels describe narrower support, such as validation-only, types-only, or parameter pass-through support.

| Capability | Server SDK | Core SDK | Web SDK | SvelteKit SDK | Notes |
| --- | :---: | :---: | :---: | :---: | --- |
| OIDC Discovery | Yes | Yes | Yes | Yes | Server SDK discovers JWKS; client SDKs use OP discovery |
| Authorization Code + PKCE | No | Yes | Yes | Yes | Browser-facing SDKs use core OAuth flow support |
| Redirect auth | No | Yes | Yes | Yes | Browser redirect flow |
| Silent auth | No | Yes | Yes | Yes | Web/SvelteKit expose browser silent login helpers |
| Popup auth | No | No | Yes | Yes | Browser popup flow |
| State/nonce management | No | Yes | Yes | Yes | CSRF and OIDC replay protection |
| Token/session storage | Helper | Yes | Yes | Yes | Server SDK has cookie-session helpers; browser SDKs manage client session state |
| Passkey/WebAuthn | No | Types | Yes | Yes | Login, signup, registration |
| Passkey Conditional UI | No | No | Yes | Yes | Browser autofill integration |
| Email code | No | Types | Yes | Yes | Send and verify |
| Social login | No | Types | Yes | Yes | Popup and redirect |
| Token refresh | Helper | Yes | Yes | Yes | Server SDK has BFF/session helpers; client SDKs refresh access tokens |
| Token introspection | Yes | Yes | No | No | Server-side validation and admin/service use cases |
| Token revocation | Yes | Yes | No | No | Explicit invalidation for server/core clients |
| Token exchange | No | Yes | Internal | Internal | Web/SvelteKit use exchange internally for Direct Auth artifacts |
| PAR | No | Yes | No | No | Core SDK exposes PAR directly |
| DPoP | Validate | Yes | Yes | Yes | Server validates proofs; browser SDKs generate DPoP proofs and handle nonce retry |
| JAR | No | Helper | No | No | Core SDK exports request object builder |
| JARM | No | Helper | No | No | Core SDK exports response validator |
| Claims parameter policy | No | Via params | No | No | Core can pass custom authorization parameters |
| ASC/SAO claims | No | Via params | No | No | Core can pass claims requests through authorization parameters |
| Client credentials | No | Yes | No | No | Machine-to-machine auth |
| Private Key JWT | No | Helper | No | No | Client assertion builder in core |
| Device Flow | No | Yes | UI helper | Yes | Core implements device grant; browser SDKs support user-facing device verification helpers |
| DeviceFlowUI helper | No | No | Yes | UI components | Events, countdown, QR, and Svelte UI integration |
| Native SSO helpers | Device secret ops | Yes | No | No | Core supports `device_secret` token exchange; server supports device-secret revoke/introspection |
| RP-Initiated Logout | No | Yes | Yes | Yes | Core logout handler; browser SDK sign-out helpers |
| Front-Channel Logout | No | Helper | Yes | No | Core URL builder; Web SDK iframe handler |
| Back-Channel Logout | Yes | Types | No | No | Server SDK validates logout tokens |
| Session state calculator | No | Yes | No | No | OIDC Session Management hash calculation |
| Check Session Iframe | No | Types | Yes | No | Browser `postMessage` session checks |
| Session monitor | No | No | Yes | No | Periodic browser session polling |
| Auth lifecycle events | No | Yes | Yes | Yes | Login, logout, token refresh |
| Session events | No | Yes | Yes | Yes | Changed and expired events |
| PKCE helper | No | Yes | No | No | Code verifier/challenge utilities |
| JWT decode/validate helpers | Yes | Yes | No | No | Server verifies JWTs; core provides client-side decode/validation helpers |
| Base64url utilities | Yes | Yes | No | No | Standard encoding helpers |
| Timing-safe comparison | Internal | Yes | No | No | Server uses timing-safe utilities internally; core exports a helper |

## Operational Readiness

| Area | Status | Notes |
| --- | --- | --- |
| Multi-tenancy isolation | In progress | Tenant isolation is designed around issuer/tenant boundaries; broader validation is ongoing |
| Audit logging | In progress | Audit capture exists; export and storage portability are active work |
| Storage portability | In progress | PII, custom/extension, and audit storage targets have runtime-profile and Hyperdrive paths; auth core remains D1/KV-biased in the public contract |
| Backup and restore | Planned | Documented procedures and repeatable test scenarios are still needed |
| SAML DR-readiness | Planned / Active | Metadata stability, signing key rollover, issuer continuity, and failover assumptions |
| Security testing | In progress | Automated tests exist; external audit and penetration testing are not yet completed |
| Performance testing | Partial | K6 benchmarks exist for representative OIDC workloads |
| Deployment documentation | In progress | Setup tooling exists; production deployment guidance is being refined |

## Not Supported

| Item | Reason / Alternative |
| --- | --- |
| Direct MTLS termination | Cloudflare Workers terminates TLS at the edge, so application code cannot directly control the TLS handshake. Use private_key_jwt, DPoP, or Cloudflare-specific mTLS/API Shield features where appropriate. |
| Direct LDAP/AD integration | Cloudflare Workers runtime does not provide general TCP socket support for LDAP/AD. Use SCIM or federate through an external IdP that supports OIDC/SAML. |

## Related Documents

- [Roadmap](./ROADMAP.md)
- [Public Specification](./specification/authrim-specification.md)
- [Access Control](./access-control.md)
