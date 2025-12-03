# Authrim Project Schedule

## Project Overview

**Authrim** - Unified Identity & Access Platform built on Cloudflare Workers

**Start Date**: November 10, 2025
**Goal**: OpenID Certified™ Identity & Access Platform with integrated AuthN + AuthZ
**Tech Stack**: Cloudflare Workers, Hono, Durable Objects, KV/D1, JOSE

**Related Documents:**

- [Task Breakdown](./TASKS.md) - Detailed task list
- [Roadmap](../ROADMAP.md) - Product roadmap
- [Technical Specifications](../architecture/technical-specs.md) - System architecture

---

## Overall Timeline

```
Phase 1: Foundation                    [Nov 10 - Dec 15, 2025]     ✅ Complete
Phase 2: Core Implementation           [Dec 16 - Jan 31, 2026]     ✅ Complete
Phase 3: Testing & Validation          [Feb 1 - Mar 15, 2026]      ✅ Complete (Nov 2025)
Phase 4: Extended Features             [Mar 16 - Apr 30, 2026]     ✅ Complete (Nov 2025)
Phase 5: UI/UX Implementation          [May 1 - May 31, 2026]      ✅ Complete (Nov 2025)
Phase 6: Enterprise Features           [Jun 1 - Oct 31, 2026]      ✅ Complete (Dec 2025)
Phase 7: Identity Hub Foundation       [2025-12 ~ 2026-Q1]         ⏳ Starting
Phase 8: Unified Policy Integration    [2026-Q2]                   🔜 Planned
Phase 9: Advanced Identity (VC/DID)    [2026-Q3]                   🔜 Planned
Phase 10: SDK & API                    [2026-Q4]                   🔜 Planned
Phase 11: Security & QA                [2027-Q1]                   🔜 Planned
Phase 12: Certification & Release      [2027-Q2]                   🔜 Final
```

---

## Key Dates

| Date       | Event                                       | Status      |
| :--------- | :------------------------------------------ | :---------- |
| 2025-11-10 | Project Kickoff                             | ✅ Complete |
| 2025-11-12 | M3: Conformance Suite Passed                | ✅ Complete |
| 2025-11-12 | M4: Extended Features Complete              | ✅ Complete |
| 2025-11-18 | M5: UI/UX Implementation Complete           | ✅ Complete |
| 2025-11-21 | Device Flow, JWT Bearer, JWE Complete       | ✅ Complete |
| 2025-11-25 | Hybrid Flow, CIBA, SCIM, JAR, JARM Complete | ✅ Complete |
| 2025-12-02 | SAML 2.0, Policy Service Complete           | ✅ Complete |
| 2025-12-03 | SD-JWT, Feature Flags, ReBAC API Complete   | ✅ Complete |
| 2025-12-03 | **Strategic Pivot: Identity Hub + Policy**  | ✅ Complete |
| 2026-Q1    | M7: Identity Hub Foundation                 | ⏳ Starting |
| 2026-Q2    | M8: Unified Policy Integration              | 🔜 Planned  |
| 2026-Q3    | M9: Advanced Identity (VC/DID)              | 🔜 Planned  |
| 2026-Q4    | M10: SDK & API                              | 🔜 Planned  |
| 2027-Q1    | M11: Security & QA                          | 🔜 Planned  |
| 2027-Q2    | M12: Certification & Release                | 🔜 Final    |

---

## Milestone Details

### M1: Foundation Complete ✅

**Due Date**: December 15, 2025 | **Actual**: Completed

**Deliverables**:

- ✅ TypeScript configuration
- ✅ Cloudflare Workers environment
- ✅ Hono framework integration
- ✅ CI/CD configuration (GitHub Actions)

---

### M2: OIDC Core Implementation Complete ✅

**Due Date**: January 31, 2026 | **Actual**: Completed

**Deliverables**:

- ✅ Discovery & JWKS endpoints
- ✅ Authorization endpoint with PKCE
- ✅ Token endpoint
- ✅ UserInfo endpoint
- ✅ All standard scopes

---

### M3: OpenID Conformance Suite Passing ✅

**Due Date**: March 15, 2026 | **Actual**: Nov 12, 2025

**Results**:

- ✅ Basic OP: 78.95% (30/38, 4 intentional skips)
- ✅ Config OP: 100%
- ✅ Form Post Basic: 84.21%

---

### M4: Extended Features Complete ✅

**Due Date**: April 30, 2026 | **Actual**: Nov 12, 2025

**Deliverables**:

- ✅ Dynamic Client Registration (RFC 7591)
- ✅ PAR (RFC 9126), DPoP (RFC 9449)
- ✅ Pairwise Subject Identifiers
- ✅ Token Introspection & Revocation
- ✅ Rate Limiting & Security Headers

---

### M5: UI/UX Implementation Complete ✅

**Due Date**: May 31, 2026 | **Actual**: Nov 18, 2025

**Deliverables**:

- ✅ D1 Database (12 tables)
- ✅ 14 Durable Objects
- ✅ SvelteKit + UnoCSS + Melt UI frontend
- ✅ Authentication UI (6 pages)
- ✅ Admin Dashboard (7 pages)
- ✅ WebAuthn/Passkey API
- ✅ Magic Link authentication
- ✅ E2E Testing (Playwright)

---

### M6: Enterprise Features ✅ COMPLETE

**Target**: 2026-Q2 | **Actual**: Dec 03, 2025

**Completed**:

- ✅ Device Flow (RFC 8628)
- ✅ JWT Bearer Flow (RFC 7523)
- ✅ JWE (RFC 7516)
- ✅ Hybrid Flow (OIDC Core 3.3)
- ✅ CIBA (OpenID Connect)
- ✅ SCIM 2.0 (RFC 7643/7644)
- ✅ JAR (RFC 9101)
- ✅ JARM
- ✅ SAML 2.0 (IdP/SP with SSO/SLO)
- ✅ Policy Service (RBAC/ABAC/ReBAC)
- ✅ SD-JWT (RFC 9901)
- ✅ Feature Flags (Hybrid config)
- ✅ ReBAC Check API

> **Note**: Social Login moved to Phase 7 (Identity Hub Foundation)
> **Note**: LDAP/AD removed - incompatible with Workers architecture

---

### M7: Identity Hub Foundation ⏳ STARTING

**Target**: 2025-12 ~ 2026-Q1

**Goal**: Transform Authrim from IdP-only to Identity Hub with RP capabilities

**7.1 RP Module Foundation**:

- 🔜 Upstream IdP Registry (D1)
- 🔜 OIDC RP Client
- 🔜 OAuth 2.0 RP Client
- 🔜 Session Linking

**7.2 Social Login Providers**:

- 🔜 Google (OIDC) - High Priority
- 🔜 GitHub (OAuth 2.0) - High Priority
- 🔜 Microsoft Entra ID (OIDC) - High Priority
- 🔜 Apple (OIDC) - Medium Priority
- 🔜 Facebook (OAuth 2.0) - Medium Priority
- 🔜 Twitter/X (OAuth 2.0) - Low Priority
- 🔜 LinkedIn (OAuth 2.0) - Low Priority

**7.3 Identity Linking**:

- 🔜 Account Linking
- 🔜 Identity Stitching (Federated/Local/Wallet同一性判断)
- 🔜 Attribute Mapping
- 🔜 Conflict Resolution

**7.4 Admin Console Enhancement**:

- 🔜 Provider Management UI
- 🔜 Attribute Mapping UI
- 🔜 Login Flow Designer

---

### M8: Unified Policy Integration 🔜 PLANNED

**Target**: 2026-Q2

**Goal**: Integrate authentication and authorization into unified flow

**8.1 Policy ↔ Identity Integration**:

- 🔜 Attribute Injection (upstream → policy context)
- 🔜 Dynamic Role Assignment
- 🔜 Just-in-Time Provisioning

**8.2 Token Embedding Model**:

- 🔜 Permissions in Token
- 🔜 Roles in Token
- 🔜 Resource Permissions
- 🔜 Custom Claims Builder

**8.3 Real-time Check API Model**:

- 🔜 `/api/check` Endpoint
- 🔜 Batch Check API
- 🔜 WebSocket Push
- 🔜 SDK Integration

**8.4 Policy Admin Console**:

- 🔜 Role Editor (Visual RBAC)
- 🔜 Policy Editor (ABAC builder)
- 🔜 Relationship Viewer (ReBAC graph)
- 🔜 Audit Log Viewer

---

### M9: Advanced Identity (VC/DID) 🔜 PLANNED

**Target**: 2026-Q3

**Goal**: Support next-generation identity protocols (Verifiable Credentials)

**9.1 OpenID4VP**:

- 🔜 VP Request Generation
- 🔜 VP Verification
- 🔜 Credential Type Registry
- 🔜 Selective Disclosure

**9.2 OpenID4CI**:

- 🔜 Credential Endpoint
- 🔜 Credential Offer
- 🔜 SD-JWT VC Format
- 🔜 Credential Status

**9.3 DID Support**:

- 🔜 did:web Resolver
- 🔜 did:key Resolver
- 🔜 DID Document Hosting

---

### M10: SDK & API 🔜 PLANNED

**Target**: 2026-Q4

**Planned**:

- 🔜 @authrim/sdk-core (Headless OIDC/PKCE client)
- 🔜 @authrim/sdk-web (Web Components with Lit/Stencil)
- 🔜 @authrim/sdk-react (React hooks and components)
- 🔜 CDN Bundle (authrim-sdk.min.js)
- 🔜 OpenAPI Specification
- 🔜 API Documentation Portal

---

### M11: Security & QA 🔜 PLANNED

**Target**: 2027-Q1

**Planned**:

- 🔜 MTLS (RFC 8705)
- 🔜 Client Credentials Flow (RFC 6749 Section 4.4)
- 🔜 Security Audit (External review)
- 🔜 Load Testing (10k+ RPS)
- 🔜 Penetration Testing
- 🔜 Additional Conformance Tests (Hybrid OP, Dynamic OP, RP)

---

### M12: Certification & Release 🔜 FINAL

**Target**: 2027-Q2

**Certification**:

- 🔜 GitHub private → public
- 🔜 License review
- 🔜 Documentation finalization
- 🔜 OpenID Foundation submission
- 🔜 Certification obtained

**Release**:

- 🔜 create-authrim NPM package
- 🔜 Interactive setup wizard
- 🔜 Cloudflare API integration
- 🔜 Migration guides (Auth0, Keycloak, Okta)
- 🔜 Public launch

---

## Current Status

### Active Phase: Phase 7 (Identity Hub Foundation)

**Phase 6 Status**: ✅ Complete (13/13 features, Dec 03, 2025)

**Next Actions**:

1. Design RP Module architecture
2. Implement OIDC RP Client for Google
3. Build Upstream IdP Registry (D1 schema)
4. Create Identity Linking logic

### Completed Phases

| Phase | Description         | Completion Date |
| ----- | ------------------- | --------------- |
| 1     | Foundation          | Dec 2025        |
| 2     | Core API            | Jan 2026        |
| 3     | Conformance         | Nov 12, 2025    |
| 4     | Extended Features   | Nov 12, 2025    |
| 5     | UI/UX               | Nov 18, 2025    |
| 6     | Enterprise Features | Dec 03, 2025    |

---

## Risks and Mitigation

| Risk                              | Impact | Mitigation                                 |
| :-------------------------------- | :----- | :----------------------------------------- |
| Social Login provider API changes | Medium | Abstract provider layer, version pinning   |
| Identity Stitching complexity     | High   | Clear strategy definition, edge case tests |
| Policy performance at scale       | Medium | Edge caching, precomputed permissions      |
| VC/DID standard evolution         | Medium | Modular design, spec tracking              |
| Schedule delays                   | Medium | Weekly progress reviews                    |

---

## Success Criteria

### Technical Criteria (Phase 1-6) ✅

- ✅ OpenID Conformance: Basic OP 78.95%, Config OP 100%
- ✅ All core OIDC endpoints functional
- ✅ JWT signature verification working
- ✅ 14 Durable Objects implemented
- ✅ 15+ UI pages complete
- ✅ Enterprise flows: 13/13 complete
- ✅ Policy Service (RBAC/ABAC/ReBAC) implemented

### Phase 7-12 Criteria

- 🔜 Social Login: 7+ providers integrated
- 🔜 Identity Linking: 50+ test cases
- 🔜 Policy Integration: 100+ tests
- 🔜 VC Credentials: 5+ types supported
- 🔜 SDK Downloads: 1000+
- 🔜 Load Test: 10,000+ RPS
- 🔜 OpenID Certified™ certification obtained

---

> **Last Update**: 2025-12-03
>
> **Current Status**: Phase 6 Complete ✅ | Phase 7 Starting (Identity Hub Foundation)
>
> **Strategic Direction**: Identity Hub + Unified Policy Integration
