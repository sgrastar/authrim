---
project: Authrim
lang: en
date: 2026-05-11
description: "Authrim roadmap organized by production-readiness workstreams."
type: roadmap
tags:
  - authrim
  - identity-platform
  - product
  - roadmap
---
# Authrim Roadmap

Authrim is a pre-1.0 identity and access platform built around Cloudflare Workers.
Core protocol capabilities are implemented, but production readiness work is still in progress.

**Target release window:** Summer/Fall 2026

The exact release date depends on UI consolidation, SAML production readiness, storage portability hardening, and security validation.

---

## Current Status

| Area | Status | Notes |
| --- | --- | --- |
| Core OIDC/OAuth implementation | Implemented | Authorization, token, UserInfo, discovery, logout, PAR, DPoP, JAR, JARM, JWE, token exchange, client credentials |
| SAML 2.0 core IdP/SP | Implemented | Production readiness, interoperability, and DR-readiness work remain |
| SCIM 2.0 | Implemented | Provisioning support is available; production deployment guidance still needs refinement |
| Policy engine | Implemented | RBAC, ABAC, ReBAC, token embedding, real-time check API |
| Identity Hub | Implemented | External OIDC/OAuth providers, account linking, identity stitching |
| Passkey / email auth / local auth | Implemented | Login UI and production flow consolidation remain active work |
| VC/DID capabilities | Implemented | OpenID4VP, OpenID4VCI, did:web, did:key |
| JavaScript SDKs | Implemented | Core, web, server, and SvelteKit packages |
| Setup tooling | Implemented | Production setup path and documentation need continued hardening |
| UI consolidation | Active | Release blocker |
| Security, QA, and release validation | Active | Formal external audit and penetration test have not yet been completed |
| Storage portability | Active | Hyperdrive-backed PII/custom/audit paths are being refined; auth core remains D1/KV-biased in the public contract |
| SAML Production Readiness | Planned/Active | Release blocker for production SAML deployments |
| SAML DR-readiness | Planned for Summer 2026 | Limited to metadata, certificates, rollover, and failover assumptions |

---

## Completed Foundations

The following foundations are implemented and have unit/integration test coverage, though some areas still need production hardening and interoperability testing.

- OIDC/OAuth Provider
- OAuth 2.0 and OIDC advanced profiles
- SAML 2.0 core IdP/SP
- SCIM 2.0
- RBAC/ABAC/ReBAC policy engine
- Identity Hub and external IdP integration
- Account linking and identity stitching
- Passkey, email code, anonymous login, and DID authentication
- PII/non-PII data separation
- Verifiable Credentials and DID support
- JavaScript SDK packages
- Setup CLI and generated environment validation
- Load testing and OpenID conformance test automation

---

## Active Workstreams

### UI Consolidation

**Status:** Active
**Release impact:** Release blocker

Authrim currently has a broad Admin UI, a separate Login UI, and setup tooling.
Before a stable release, these surfaces need to be made more consistent and production-oriented.

**Checkpoints:**

- Review Admin UI information architecture and remove or mark incomplete surfaces.
- Align Admin UI, Login UI, and setup UI navigation and terminology.
- Verify critical flows: tenant setup, admin login, user management, client management, SAML provider management, runtime profiles, signing keys, and login UI settings.
- Reduce "looks available but is not complete" behavior in management screens.
- Confirm responsive layout and form behavior for core pages.
- Document known UI limitations before release.

### Authentication Flow Readiness

**Status:** Active
**Release impact:** Release blocker

Authrim supports multiple authentication methods, but the production login path needs a final pass across the server flow, Login UI, and session behavior.

**Checkpoints:**

- Clearly separate conformance/test-only built-in login behavior from production login flows.
- Validate Login UI flows for passkey, email code, signup, invitation, consent, device authorization, CIBA, and re-authentication.
- Expand SSO/session tests, especially currently under-covered prompt, session, and re-authentication cases.
- Verify cookie, SameSite, origin, redirect, and tenant-host behavior across custom domains.
- Confirm failure and recovery UX for expired challenges, invalid sessions, denied consent, and login cancellation.

### SAML Production Readiness

**Status:** Planned/Active
**Release impact:** Release blocker for production SAML deployments

The core SAML IdP/SP implementation exists, but production SAML usage requires stronger tenant scoping, metadata handling, certificate handling, and interoperability validation.

**Checkpoints:**

- Make SAML provider lookup and management consistently tenant-scoped.
- Harden SAML provider admin authorization beyond shared administrative secrets.
- Support production-grade IdP signing certificate handling.
- Add explicit signing policy for SAML responses, assertions, and AuthnRequests.
- Support stronger AuthnRequest signature validation policy per SP.
- Improve SAML metadata import/export behavior.
- Add publisher/SP interoperability tests using real metadata samples where possible.
- Expand SAML/XML security coverage, including signature wrapping, XXE, oversized XML, replay, clock skew, and binding-specific behavior.
- Improve SAML audit events and error reporting.

### SAML DR-readiness

**Status:** Planned for Summer 2026
**Release impact:** Production readiness

This workstream is about making SAML deployments easier to operate with disaster-recovery assumptions.
It does not include a separate AWS/Azure runtime.

**Checkpoints:**

- Support stable SAML entityID, SSO URL, and SLO URL configuration.
- Allow backup signing certificates to be published in metadata.
- Define signing certificate rollover behavior.
- Provide static metadata export suitable for SPs that do not automatically refresh metadata.
- Document DNS, TLS certificate, metadata, and resolver-cache assumptions for failover planning.
- Document that active session migration is not included in DR-readiness.

### Multi-tenant Administration

**Status:** Active
**Release impact:** Enterprise readiness

Authrim uses tenant-scoped records with issuer/host-based separation and tenant-specific policy configuration.
The remaining work is to harden the administrative model around tenant boundaries and delegated administration.

**Checkpoints:**

- Verify tenant isolation across user, client, policy, SAML, SCIM, plugin, and runtime-profile management.
- Define member-tenant administrator and platform administrator boundaries.
- Ensure cross-tenant operations require explicit policy and audit coverage.
- Add regression tests for tenant boundary enforcement in management APIs.
- Improve audit logs for tenant-scoped administrative actions.
- Document the current model: tenant-scoped records in a shared relational data model, not one database per tenant.

### Storage Portability

**Status:** Active
**Release impact:** Production readiness

Authrim has early storage portability work through runtime profiles and Hyperdrive-backed PostgreSQL/MySQL adapters.
The original motivation is D1 maturity, customer-controlled data placement, data residency, audit export, and database portability.

**Checkpoints:**

- Harden Hyperdrive-backed PostgreSQL/MySQL profiles.
- Verify external storage paths for user core, PII, custom claims, SAML provider data, and audit data.
- Document which storage planes can be moved off D1 and which control-plane paths remain D1/KV-biased.
- Improve schema portability checks across D1, PostgreSQL, and MySQL.
- Ensure runtime profile resolution is reliable and well documented.
- Provide setup and deployment guidance for external database configurations.

### Security, QA, and Release Validation

**Status:** Active
**Release impact:** Release blocker

Security and QA work is ongoing. A formal external security audit and penetration test have not yet been completed.

**Checkpoints:**

- Run full unit, integration, typecheck, lint, and UI build validation.
- Continue OpenID conformance and logout profile validation.
- Review security-critical flows: token issuance, refresh token rotation, session handling, SAML, SCIM, policy decisions, and tenant boundaries.
- Add missing regression tests for SSO/session behavior.
- Review test-only and conformance-only endpoints and document production behavior.
- Maintain a known limitations list for pre-1.0 users.
- Prepare for an external security audit when budget and scope allow.

### Setup, Deployment, and Documentation

**Status:** Active
**Release impact:** Release blocker

Authrim needs a reproducible production deployment path and documentation that matches the current architecture.

**Checkpoints:**

- Update README and documentation to remove stale release language.
- Keep the public specification aligned with runtime-profile and storage-portability behavior.
- Improve setup wizard coverage for production domains, Cloudflare resources, UI deployment, and runtime profiles.
- Document deployment modes and limitations clearly.
- Add SAML production readiness and storage portability guides.
- Add release notes and migration guidance for pre-1.0 users.

---

## Release Criteria

Authrim should be considered production-ready when a documented supported deployment profile can be installed, operated, upgraded, audited, and recovered without relying on internal developer knowledge, and when protocol/security-critical behavior is covered by conformance, regression, adversarial, and other security-focused testing.

Authrim should not be recommended for production migration until these baseline criteria are met:

- Admin UI and Login UI critical paths are consolidated and documented.
- Production deployment path is reproducible from setup documentation.
- SAML production readiness baseline is complete.
- Tenant boundary behavior is tested across critical management and protocol paths.
- Storage portability behavior and limitations are documented.
- Security-critical tests pass consistently.
- OpenID conformance status is current and documented.
- Known limitations are clearly documented.
- External audit and penetration testing status is explicitly stated.

---

## Not Currently In Scope

| Item | Reason / Alternative |
| --- | --- |
| Full AWS/Azure runtime support | Authrim currently depends on Cloudflare-native primitives such as D1, KV, R2, Durable Objects, Workers bindings, and service bindings. Hono portability helps at the HTTP layer, but it does not make the whole runtime portable. |
| Multi-cloud active-active deployment | Requires a separate architecture for state, storage, keys, DNS, metadata, and operations. |
| Direct LDAP/AD integration | Cloudflare Workers runtime does not provide general TCP socket support for LDAP/AD. Use SCIM or federate through an external IdP that supports OIDC/SAML. |
| Direct MTLS termination | Cloudflare Workers terminates TLS at the edge, so application code cannot directly control the TLS handshake. Use private_key_jwt, DPoP, or Cloudflare-specific mTLS/API Shield features where appropriate. |

---

## Historical Milestones

This section is a compressed history of major completed work. It replaces the older phase-based roadmap.

| Date | Milestone |
| --- | --- |
| 2025-11 | Initial foundation, Cloudflare Workers setup, Hono framework, TypeScript, testing, CI/CD |
| 2025-11 | OIDC/OAuth core implementation and initial conformance testing |
| 2025-11 | Advanced OAuth/OIDC features: PAR, DPoP, pairwise identifiers, token management, form post |
| 2025-11 | Admin UI, login/signup/consent/device/CIBA UI, passkey, email code, multi-language support |
| 2025-12 | Enterprise protocol work: Device Flow, CIBA, SCIM, JWE, Hybrid, JAR, JARM, JWT Bearer, SAML core |
| 2025-12 | Identity Hub foundation, social login providers, account linking, identity stitching |
| 2025-12 | PII/non-PII data separation, DatabaseAdapter, repository pattern, PII routing |
| 2025-12 | Policy integration: RBAC, ABAC, ReBAC, token embedding, check API, permission change notifications |
| 2025-12 | Advanced identity: OpenID4VP, OpenID4VCI, DID resolver, DID authentication |
| 2025-12 | Load testing and Durable Object sharding work |
| 2026-01 | Client Credentials flow |
| 2026-01 | JavaScript SDK ecosystem: core, web, server, SvelteKit |
| 2026-04/05 | Runtime profiles, storage portability, audit export, Hyperdrive-backed PostgreSQL/MySQL work |

---

> **Last Update:** 2026-05-11
>
> **Current Status:** Pre-1.0 | Target release window: Summer/Fall 2026 | Active workstreams: UI, SAML readiness, storage portability, multi-tenant administration, security/QA
