---
project: Authrim
lang: en
date: 2026-05-12
description: "Authrim roadmap organized by product maturity workstreams."
type: roadmap
tags:
  - authrim
  - identity-platform
  - product
  - roadmap
---
# Authrim Roadmap

Authrim is a pre-1.0 identity and access platform built around Cloudflare Workers.
Core protocol capabilities are implemented, but production hardening is still in progress.

**Target release window:** Summer/Fall 2026

The exact release date depends on UI consolidation, SAML production hardening, storage portability hardening, and security validation.

---

## Current Status

| Area | Status | Notes |
| --- | --- | --- |
| Core OIDC/OAuth implementation | Implemented | Authorization, token, UserInfo, discovery, logout, PAR, DPoP, JAR, JARM, JWE, token exchange, client credentials |
| FAPI profiles | Implemented / certification target | FAPI 2.0 policy controls, PAR enforcement, PKCE S256, private_key_jwt, DPoP strict mode, and certification profiles exist; formal certification is still planned |
| CIBA | Implemented / certification target | Backchannel authentication, approval, polling, and request storage paths exist; formal certification and broader interoperability validation are still planned |
| SAML 2.0 IdP/SP | Active / implementation substantially complete | Core protocol support is implemented; production hardening, interoperability, and DR assumptions are tracked below |
| SCIM 2.0 | Implemented | Provisioning support is available; production deployment guidance still needs refinement |
| Policy engine | Implemented | RBAC, ABAC, ReBAC, token embedding, real-time check API |
| Identity Hub | Implemented | External OIDC/OAuth providers, account linking, identity stitching |
| Passkey / email auth / local auth | Implemented | Login UI and production flow hardening remain active work |
| VC/DID capabilities | Implemented | OpenID4VP, OpenID4VCI, did:web, did:key |
| JavaScript SDKs | Implemented | Core, web, server, and SvelteKit packages |
| Setup tooling | Implemented | Production setup path and documentation need continued hardening |
| UI consolidation | Active | Broad Admin UI and Login UI surfaces exist; consolidation and polish continue |
| Security, QA, and validation | Active | Formal external audit and penetration test have not yet been completed |
| Storage portability | Implementation baseline complete / validation active | Runtime profiles, Hyperdrive-backed user/custom/audit paths, setup validation, and schema portability checks are in place; control-plane limits remain documented |
| Multi-tenant isolation | Implementation baseline complete / validation active | Tenant-scoped storage, routing, admin boundaries, job isolation, and regression coverage are in place; production hardening continues |

---

## Completed Foundations

The following foundations are implemented and have unit/integration test coverage, though some areas still need production hardening and interoperability testing.

- [x] OIDC/OAuth Provider
- [x] OAuth 2.0 and OIDC advanced profiles
- [x] SAML 2.0 core IdP/SP
- [x] SCIM 2.0
- [x] RBAC/ABAC/ReBAC policy engine
- [x] Identity Hub and external IdP integration
- [x] Account linking and identity stitching
- [x] Passkey, email code, anonymous login, and DID authentication
- [x] PII/non-PII data separation
- [x] Multi-tenant issuer, storage, policy, admin, and job isolation baseline
- [x] Verifiable Credentials and DID support
- [x] JavaScript SDK packages
- [x] Setup CLI and generated environment validation
- [x] Load testing and OpenID conformance test automation

---

## Active Workstreams

### UI Consolidation

**Status:** Active

Authrim currently has a broad Admin UI, a separate Login UI, and setup tooling.
Before a stable release, these surfaces need to be made more consistent and production-oriented.

**Checkpoints:**

- [ ] Review Admin UI information architecture and remove or mark incomplete surfaces.
- [ ] Align Admin UI, Login UI, and setup UI navigation and terminology.
- [ ] Verify critical flows: tenant setup, admin login, user management, client management, SAML provider management, runtime profiles, signing keys, and login UI settings.
- [ ] Reduce "looks available but is not complete" behavior in management screens.
- [ ] Confirm responsive layout and form behavior for core pages.
- [ ] Document known UI limitations before release.

### Authentication Flow Hardening

**Status:** Active

Authrim supports multiple authentication methods, but the production login path needs a final pass across the server flow, Login UI, and session behavior.

**Checkpoints:**

- [ ] Ensure conformance helpers use the same protocol, session, consent, and challenge validation paths as production login flows.
- [ ] Validate Login UI flows for passkey, email code, signup, invitation, consent, device authorization, CIBA, and re-authentication.
- [ ] Expand SSO/session tests, especially currently under-covered prompt, session, and re-authentication cases.
- [ ] Verify cookie, SameSite, origin, redirect, and tenant-host behavior across custom domains.
- [ ] Confirm failure and recovery UX for expired challenges, invalid sessions, denied consent, and login cancellation.

### SAML Production Hardening

**Status:** Active / implementation substantially complete

The core SAML IdP/SP implementation now includes tenant-scoped provider lookup, metadata import/export hardening, signing policy controls, attribute presets, encryption hooks, SLO correlation, and operational observer surfaces. Remaining work is mainly validation depth, deployment-specific policy, and administrator UX polish.

**Checkpoints:**

- [x] Tenant-scoped SAML provider lookup, request correlation, signing key lookup, and metadata handling are implemented.
- [x] Response/assertion signing policy, AuthnRequest signature policy, SLO signature policy, and algorithm allow-lists are implemented.
- [x] Metadata import/export covers stable descriptors, ETag, cache duration, optional XML Signature, certificates, endpoints, RequestedAttribute suggestions, and encryption keys.
- [x] Metadata refresh stores diff and expiry status and emits audit events.
- [x] Signing rollover supports active, next, and backup certificate slots with admin APIs.
- [x] IdP-initiated multi-SP SLO has tenant-scoped fanout state and scheduled timeout observation.
- [x] Admin UI exposes SAML provider metadata status, RequestedAttribute counts, attribute presets, and key rollover actions.
- [x] Interoperability fixtures exist, with real publisher metadata intake tracked privately where redistribution is restricted.

**DR assumptions:**

- [x] Stable SAML entityID, SSO URL, and SLO URL configuration are supported.
- [x] Backup signing certificates can be published in metadata during rollover.
- [x] Static metadata export is suitable for SPs that do not automatically refresh metadata.
- [ ] DNS, TLS certificate, metadata, and resolver-cache assumptions still need deployment guidance.
- [x] Active session migration is not included; failover assumes re-authentication.
- [x] A separate AWS/Azure SAML runtime is not part of this workstream.

### Multi-tenant Administration

**Status:** Active

Authrim uses tenant-scoped records with issuer/host-based separation and tenant-specific policy configuration.
The current baseline uses shared relational tables with tenant-scoped keys and explicit platform-administrator paths; it is not a one-database-per-tenant model.
The remaining work is operational hardening, documentation polish, and broader end-to-end validation.

**Checkpoints:**

- [x] Verify tenant isolation across user, client, policy, SCIM, plugin, job, and runtime-profile management.
- [x] Define member-tenant administrator and platform administrator boundaries.
- [x] Ensure cross-tenant operations require explicit platform or tenant-scoped authority.
- [x] Add regression tests for tenant boundary enforcement in management APIs and runtime paths.
- [ ] Improve audit logs for tenant-scoped administrative actions.
- [x] Document the current model: tenant-scoped records in a shared relational data model, not one database per tenant.

### Storage Portability

**Status:** Active

Authrim has storage portability work through runtime profiles and Hyperdrive-backed PostgreSQL/MySQL adapters.
The original motivation is D1 maturity, customer-controlled data placement, data residency, audit export, and database portability.

**Checkpoints:**

- [x] Implement and test Hyperdrive-backed PostgreSQL/MySQL runtime profile paths.
- [x] Verify external storage paths for user core, PII, custom claims, and audit data.
- [x] Document which storage planes can be moved off D1 and which control-plane paths remain D1/KV-biased.
- [x] Improve schema portability checks across D1, PostgreSQL, and MySQL.
- [x] Ensure runtime profile resolution is reliable and covered by automated tests.
- [ ] Provide setup and deployment guidance for external database configurations.

### Security, QA, and Validation

**Status:** Active

Security and QA work is ongoing. A formal external security audit and penetration test have not yet been completed.

**Checkpoints:**

- [ ] Run full unit, integration, typecheck, lint, and UI build validation.
- [ ] Continue OpenID conformance and logout profile validation.
- [ ] Review security-critical flows: token issuance, refresh token rotation, session handling, SAML, SCIM, policy decisions, and tenant boundaries.
- [ ] Add missing regression tests for SSO/session behavior.
- [ ] Review test-only and conformance-only endpoints and document production behavior.
- [ ] Document current operational constraints and unsupported deployment modes for pre-1.0 users.
- [ ] Prepare for an external security audit when budget and scope allow.

### Setup, Deployment, and Documentation

**Status:** Active

Authrim needs a reproducible production deployment path and documentation that matches the current architecture.

**Checkpoints:**

- [x] Update README and documentation to remove stale release language.
- [x] Keep the public specification aligned with runtime-profile and storage-portability behavior.
- [ ] Improve setup wizard coverage for production domains, Cloudflare resources, UI deployment, and runtime profiles.
- [ ] Document deployment modes and limitations clearly.
- [x] Add SAML production hardening guide.
- [ ] Add storage portability guide.
- [ ] Add release notes and migration guidance for pre-1.0 users.

---

## Production Maturity Criteria

Authrim should be considered suitable for production adoption when a documented supported deployment profile can be installed, operated, upgraded, audited, and recovered without relying on internal developer knowledge, and when protocol/security-critical behavior is covered by conformance, regression, adversarial, and other security-focused testing.

Authrim should not be recommended for production migration until these baseline criteria are met:

- [ ] Admin UI and Login UI critical paths are consolidated and documented.
- [ ] Production deployment path is reproducible from setup documentation.
- [x] SAML production hardening baseline is complete.
- [x] Tenant boundary behavior is tested across critical management and protocol paths.
- [x] Storage portability behavior and limitations are documented.
- [ ] Security-critical tests pass consistently.
- [ ] OpenID conformance status is current and documented.
- [ ] Current operational constraints and unsupported deployment modes are clearly documented.
- [ ] External audit and penetration testing status is explicitly stated.

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

> **Last Update:** 2026-05-12
>
> **Current Status:** Pre-1.0 | Target release window: Summer/Fall 2026 | Active workstreams: UI, SAML hardening, storage portability, multi-tenant administration, security/QA
