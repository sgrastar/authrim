---
project: Authrim
lang: en
date: 2026-08-25
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

The exact release date depends on UI consolidation, SAML interoperability validation, storage/logging hardening, deployment documentation, and security validation.

---

## Current Status

| Area                              | Status                                               | Notes                                                                                                                                                                                                                                                                   |
| --- | --- | --- |
| Core OIDC/OAuth implementation    | Implemented                                          | Authorization, token, UserInfo, discovery, logout, PAR, DPoP, JAR, JARM, JWE, token exchange, client credentials                                                                                                                                                        |
| OpenID certification              | Certified / maintained                               | Authrim 0.4.0 is certified for OpenID Provider, Session OP, Logout, Relying Party, and Relying Party Logout profiles                                                                                                                                    |
| FAPI profiles                     | Certified / maintained                               | FAPI 2.0 OP/RP Security Profile, Message Signing, and Client Credentials profiles are certified                                                                                                                                                         |
| CIBA                              | Certified / maintained                               | FAPI-CIBA Poll and Ping profiles using private-key authentication are certified; Suite-side incoming TLS warnings remain documented for Ping                                                                                                        |
| SAML 2.0 IdP/SP                   | Active / implementation substantially complete       | Core protocol support, local entity metadata, entityID style, interactive login redirect policy, signing subject/rollover, and metadata import/export are implemented; interoperability and DR assumptions are tracked below                                            |
| SCIM 2.0 | Inbound implemented | Users, Groups, and Bulk receiver are available; outbound provisioning is out of scope |
| Policy engine                     | Implemented                                          | RBAC, ABAC, ReBAC, token embedding, real-time check API                                                                                                                                                                                                                 |
| Identity Hub                      | Implemented                                          | External OIDC/OAuth providers, account linking, identity stitching                                                                                                                                                                                                      |
| Passkey / email auth / local auth | Implemented                                          | Login UI and production flow hardening remain active work                                                                                                                                                                                                               |
| VC/DID capabilities               | Partial / interoperability active                    | OpenID4VCI and OpenID4VP implementation baselines exist, but the official Final and HAIP Suite plans currently have known conformance gaps; did:web and did:key support exists                                                                                          |
| JavaScript SDKs                   | Implemented                                          | Core, web, server, and SvelteKit packages                                                                                                                                                                                                                               |
| Setup tooling                     | Implemented                                          | Source-download setup, fresh root migrations, standard SAML/CIBA/VC installation, optional Admin/Login UI, DNS guidance, and deletion cleanup exist; documentation needs continued hardening                                                                            |
| UI consolidation                  | Active                                               | Broad Admin UI and Login UI surfaces exist; SAML, database, storage, logging, tenant discovery, and provider icon surfaces have been updated; consolidation and polish continue                                                                                         |
| Security, QA, and validation      | Active                                               | Formal external audit and penetration test have not yet been completed                                                                                                                                                                                                  |
| Storage/logging portability       | Implementation baseline complete / validation active | Runtime profiles, Hyperdrive-backed user/custom/audit paths, setup-managed D1/R2 inventory, storage destinations, logging policy snapshots, delivery/DLQ surfaces, setup validation, and schema portability checks are in place; control-plane limits remain documented |
| Multi-tenant isolation            | Implementation baseline complete / validation active | Tenant-scoped storage, routing, admin boundaries, job isolation, and regression coverage are in place; production hardening continues                                                                                                                                   |

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
- [x] Verifiable Credentials and DID implementation baseline
- [x] JavaScript SDK packages
- [x] Setup CLI and generated environment validation
- [x] Fresh root migration set for new deployments
- [x] Setup-managed D1/R2 resource inventory in Admin UI
- [x] Load testing and OpenID conformance test automation
- [x] OpenID Foundation certification for Authrim 0.4.0: Core OP, Logout, RP, RP Logout, FAPI 2.0 OP/RP, and FAPI-CIBA profiles

---

## Active Workstreams

### UI Consolidation

**Status:** Active

Authrim currently has a broad Admin UI, a separate Login UI, and setup tooling.
Before a stable release, these surfaces need to be made more consistent and production-oriented.

**Checkpoints:**

- [ ] Review Admin UI information architecture and remove or mark incomplete surfaces.
- [ ] Align Admin UI, Login UI, and setup UI navigation and terminology.
- [ ] Verify critical flows: tenant setup, admin login, user management, client management, SAML provider management, runtime profiles, signing keys, storage/logging destinations, and login UI settings.
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

### OpenID4VC Final Interoperability

**Status:** Active / official Suite gap analysis complete

Authrim has OpenID4VCI issuer and OpenID4VP verifier endpoint baselines with unit and integration
coverage. July 2026 runs against the official OpenID Foundation Conformance Suite confirmed that the
implementation is not yet conformant to the OpenID4VCI 1.0 Final, OpenID4VP 1.0 Final, or their HAIP
profiles. The public status is therefore `Partial`, not `Implemented` or `Complete`.

**Verified baseline:**

- [x] OpenID4VCI metadata, offer, token, credential, nonce, deferred issuance, and status endpoints exist.
- [x] OpenID4VP verifier metadata, authorization initiation, request storage, response handling, request status, and SD-JWT verification paths exist.
- [x] Holder-binding, proof validation, replay-resistant request state, DPoP/PAR/FAPI building blocks, and local automated tests exist.
- [x] Official Final and HAIP Suite plans were run as gap analyses without product-code changes.

**Remaining Final interoperability work:**

- [ ] Publish OpenID4VCI Final array-form claim descriptors and the required `openid_credential` Authorization Server metadata.
- [ ] Do not return an ID Token from the OAuth-only OpenID4VCI authorization-code flow.
- [ ] Generate OpenID4VP Final client identifiers without the removed `client_id_scheme` parameter and include required `client_metadata.vp_formats`.
- [ ] Accept and correctly validate the Suite-generated Final `dc+sd-jwt` VP response, including negative KB-JWT and credential-signature cases.
- [ ] Align verifier metadata with runtime support; do not advertise `direct_post.jwt` or `mso_mdoc` until their processing paths are implemented and tested.

**Remaining HAIP work:**

- [ ] Add Credential Configuration scopes and Wallet/Client Attestation plus PoP authentication at PAR and Token endpoints.
- [ ] Add tenant-scoped trust anchors, certificate-chain validation, replay protection, and attestation metadata.
- [ ] Implement OpenID4VP `x509_hash`, signed authorization requests by `request_uri`, and `direct_post.jwt` response processing.
- [ ] Re-run every Final and HAIP plan from its first unresolved module and then complete a clean full-plan run with no failures.

### SAML Production Hardening

**Status:** Active / implementation substantially complete

The core SAML IdP/SP implementation now includes tenant-scoped provider lookup, local entity metadata pages, metadata import/export hardening, configurable published entityIDs, interactive login redirect policy, signing subject and rollover controls, attribute presets, encryption hooks, SLO correlation, and operational observer surfaces. Remaining work is mainly validation depth, deployment-specific policy, and administrator UX polish.

**Checkpoints:**

- [x] Tenant-scoped SAML provider lookup, request correlation, signing key lookup, and metadata handling are implemented.
- [x] Response/assertion signing policy, AuthnRequest signature policy, SLO signature policy, and algorithm allow-lists are implemented.
- [x] Metadata import/export covers stable descriptors, ETag, cache duration, optional XML Signature, certificates, endpoints, RequestedAttribute suggestions, and encryption keys.
- [x] Metadata refresh stores diff and expiry status and emits audit events.
- [x] Signing rollover supports active, next, and backup certificate slots with Admin APIs and UI controls.
- [x] IdP-initiated multi-SP SLO has tenant-scoped fanout state and scheduled timeout observation.
- [x] Admin UI exposes SAML provider metadata status, RequestedAttribute counts, aggregate metadata import, mdui logo/keyword intake, attribute presets, local entity info, certificates, fingerprints, entityID style, login redirect policy, and key rollover actions.
- [x] Interoperability fixtures exist, with real publisher metadata intake tracked privately where redistribution is restricted.

**DR assumptions:**

- [x] Stable SAML entityID, SSO URL, and SLO URL configuration are supported.
- [x] Backup signing certificates can be published in metadata during rollover.
- [x] Static metadata export is suitable for SPs that do not automatically refresh metadata.
- [x] DNS and TLS wildcard guidance is surfaced in setup; deployment-specific metadata and resolver-cache guidance still needs release-level documentation.
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

### Storage and Logging Portability

**Status:** Active

Authrim has storage portability work through runtime profiles and Hyperdrive-backed PostgreSQL/MySQL adapters. Managed logging adds policy snapshots, storage destinations, object archive, sensitive-detail chunks, delivery events, exports, and DLQ replay. The original motivation is D1 maturity, customer-controlled data placement, data residency, audit export, operational evidence, and database portability.

**Checkpoints:**

- [x] Implement and test Hyperdrive-backed PostgreSQL/MySQL runtime profile paths.
- [x] Verify external storage paths for user core, PII, custom claims, and audit data.
- [x] Document which storage planes can be moved off D1 and which control-plane paths remain D1/KV-biased.
- [x] Improve schema portability checks across D1, PostgreSQL, and MySQL.
- [x] Ensure runtime profile resolution is reliable and covered by automated tests.
- [x] Surface setup-managed D1 database connections with tenant assignment badges.
- [x] Surface setup-managed R2 buckets and tenant/platform storage destinations.
- [x] Implement managed logging destination, policy, delivery event, sensitive detail, export, and DLQ control surfaces.
- [ ] Provide setup and deployment guidance for external database configurations.
- [ ] Provide production guidance for logging retention, archive destinations, credential rotation, and DLQ operations.

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
- [x] Consolidate setup migrations for fresh deployments.
- [x] Improve setup wizard coverage for production domains, Cloudflare resources, optional UI deployment, tenant discovery, and DNS guidance.
- [ ] Document deployment modes and limitations clearly.
- [x] Add SAML production hardening guide.
- [ ] Add storage/logging portability guide.
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
- [x] Logging/storage destination control-plane baseline is implemented.
- [ ] Security-critical tests pass consistently.
- [ ] OpenID conformance status is current and documented.
- [ ] Current operational constraints and unsupported deployment modes are clearly documented.
- [ ] External audit and penetration testing status is explicitly stated.

---

## Not Currently In Scope

| Item                                 | Reason / Alternative                                                                                                                                                                                                              |
| --- | --- |
| Full AWS/Azure runtime support       | Authrim currently depends on Cloudflare-native primitives such as D1, KV, R2, Durable Objects, Workers bindings, and service bindings. Hono portability helps at the HTTP layer, but it does not make the whole runtime portable. |
| Multi-cloud active-active deployment | Requires a separate architecture for state, storage, keys, DNS, metadata, and operations.                                                                                                                                         |
| Direct LDAP/AD integration           | Cloudflare Workers runtime does not provide general TCP socket support for LDAP/AD. Use SCIM or federate through an external IdP that supports OIDC/SAML.                                                                         |
| Direct MTLS termination              | Cloudflare Workers terminates TLS at the edge, so application code cannot directly control the TLS handshake. Use private_key_jwt, DPoP, or Cloudflare-specific mTLS/API Shield features where appropriate.                       |
| SFTP storage or delivery             | Cloudflare Workers does not provide a general SSH/SFTP runtime. Use R2, S3-compatible object storage, HTTPS sinks, Cloudflare Logpush, or another external collector instead.                                                     |
| FAPI 1.0 Final and regional profiles | Deferred. Authrim prioritizes FAPI 2.0 and FAPI-CIBA. Supporting FAPI 1.0 would add a second long-term compatibility surface, including legacy message-signing and ecosystem-specific requirements. Revisit only when a concrete customer or regulatory requirement exists. |

---

## Historical Milestones

This section is a compressed history of major completed work. It replaces the older phase-based roadmap.

| Date       | Milestone                                                                                                                                                               |
| --- | --- |
| 2025-11    | Initial foundation, Cloudflare Workers setup, Hono framework, TypeScript, testing, CI/CD                                                                                |
| 2025-11    | OIDC/OAuth core implementation and initial conformance testing                                                                                                          |
| 2025-11    | Advanced OAuth/OIDC features: PAR, DPoP, pairwise identifiers, token management, form post                                                                              |
| 2025-11    | Admin UI, login/signup/consent/device/CIBA UI, passkey, email code, multi-language support                                                                              |
| 2025-12    | Enterprise protocol work: Device Flow, CIBA, SCIM, JWE, Hybrid, JAR, JARM, JWT Bearer, SAML core                                                                        |
| 2025-12    | Identity Hub foundation, social login providers, account linking, identity stitching                                                                                    |
| 2025-12    | PII/non-PII data separation, DatabaseAdapter, repository pattern, PII routing                                                                                           |
| 2025-12    | Policy integration: RBAC, ABAC, ReBAC, token embedding, check API, permission change notifications                                                                      |
| 2025-12    | Advanced identity implementation baseline: OpenID4VP, OpenID4VCI, DID resolver, DID authentication                                                                      |
| 2025-12    | Load testing and Durable Object sharding work                                                                                                                           |
| 2026-01    | Client Credentials flow                                                                                                                                                 |
| 2026-01    | JavaScript SDK ecosystem: core, web, server, SvelteKit                                                                                                                  |
| 2026-04/05 | Runtime profiles, storage portability, audit export, Hyperdrive-backed PostgreSQL/MySQL work                                                                            |
| 2026-05    | SAML local entity info, signing subject/rollover UI, tenant discovery WAYF, setup migration consolidation, database/storage inventory, and managed logging control work |
| 2026-08    | OpenID Foundation certification for Authrim 0.4.0: OpenID Provider, Logout, RP, RP Logout, FAPI 2.0 OP/RP, and FAPI-CIBA profiles                                      |

---

> **Last Update:** 2026-08-25
>
> **Current Status:** Pre-1.0 | Target release window: Summer/Fall 2026 | Active workstreams: UI, OpenID4VC Final/HAIP interoperability, SAML interoperability, storage/logging portability, multi-tenant administration, security/QA
