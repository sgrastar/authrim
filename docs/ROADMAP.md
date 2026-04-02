---
project: Authrim
lang: en
date: 2026-01-30
description: "Vision: Identity & Access Platform for the modern web — Authentication, Authorization, and Identity Hub in one."
type: roadmap
tags:
  - authrim
  - identity-platform
  - product
  - roadmap
---
# Authrim Product Roadmap

**Vision:** Identity & Access Platform for the modern web — Authentication, Authorization, and Identity Hub in one.

**Timeline:** November 2025 - 2026-Q1

---

## Timeline Overview

```mermaid
timeline
    title Authrim Development Timeline
    section 2025
        Nov-Dec : ✅ P1-9 Complete
                : ✅ P8 Policy Integration
                : ✅ P7 Identity Hub
                : ✅ P9 Advanced Identity (VC/DID)
    section 2026
        Jan : ✅ P10 SDK & API Complete
            : ⏳ P11 Security & QA (~50%)
        Q1 : P12 Certification & Release
```

**Legend:**

- ✅ Complete (Phases 1-10)
- ⏳ In Progress (Phase 11)
- 🔜 Planned (Phase 12: 2026-Q1)

---

## Architecture Vision

```
═══════════════════════════════════════════════════════════════════════════
                 Authrim: Unified Identity & Access Platform
═══════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────┐
│              Identity Sources (Federation & Native Auth)                │
│                                                                         │
│   Google    GitHub    Microsoft    SAML IdP    Wallet    Passkey/Local  │
│     │         │          │           │        (VC/VP)         │         │
│     └─────────┴──────────┴───────────┴───────────┴───────────┘         │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   Federation & Native Auth Layer                        │
│                                                                         │
│   • External IdP (OAuth 2.0 / OIDC / SAML)                             │
│   • Wallet VP/VC Verification (OpenID4VP)                              │
│   • Local Auth (Password / Magic Link / Passkey)                       │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Unified Identity Layer                             │
│                                                                         │
│   • Identity Linking (link multiple accounts to one user)              │
│   • Identity Stitching (determine identity across Federated/Local/Wallet)│
│   • Attribute Aggregation (aggregate attributes from multiple sources) │
│   • Claims Transformation (transform and normalize claims)             │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 Policy Engine (RBAC + ABAC + ReBAC)                     │
│                                                                         │
│   ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────────────┐   │
│   │   Roles   │  │ Attributes│  │ Relations │  │   Feature Flags   │   │
│   │  (RBAC)   │  │  (ABAC)   │  │  (ReBAC)  │  │   (Dynamic Cfg)   │   │
│   └───────────┘  └───────────┘  └───────────┘  └───────────────────┘   │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      IdP Module (OIDC Provider)                         │
│                                                                         │
│   • Token Issuance (ID Token / Access Token / Refresh Token)           │
│   • Claims Embedding (roles, permissions, flags, relationships)        │
│   • Inline Policy Evaluation (sync evaluation at token issuance)       │
│   • Real-time Policy Check API (/policy/check - for downstream services)│
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Customer Applications                            │
│                                                                         │
│   • Tokens: ID Token + Access Token (authentication & authorization)   │
│   • Embedded: Permissions / Roles / Feature Flags                      │
│   • Real-time: /policy/check API for dynamic decisions                 │
└─────────────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════════
```

### Key Differentiators

| Feature                       | Description                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------- |
| **OP-embedded Policy Engine** | Sync evaluation of RBAC/ABAC/ReBAC at token issuance. No extra API calls needed |
| **Dual Authorization Model**  | Token embedding (fast) + Real-time API (dynamic) combined                       |
| **Identity Stitching**        | Auto-link same email, conditional VC subject linking, re-auth on change         |
| **Edge-native**               | All layers run at edge on Cloudflare Workers. Global low latency                |

---

## Milestones

| Milestone                  | Date       | Status      | Description                                                           |
| -------------------------- | ---------- | ----------- | --------------------------------------------------------------------- |
| **M1: Foundation**         | 2025-12-15 | ✅ Complete | Project setup, tooling, basic structure                               |
| **M2: Core API**           | 2026-01-31 | ✅ Complete | All OIDC endpoints functional                                         |
| **M3: Conformance**        | 2025-11-12 | ✅ Complete | Basic OP 78.95%, Config OP 100%, Form Post 84.21%                     |
| **M4: Extensions**         | 2025-11-12 | ✅ Complete | PAR, DPoP, Pairwise, Token Management                                 |
| **M5: UI/UX**              | 2025-11-18 | ✅ Complete | SvelteKit Frontend, Admin Dashboard, 15+ pages                        |
| **M6: Enterprise**         | 2025-12-02 | ✅ Complete | Device Flow, CIBA, SCIM, JWE, Hybrid, JAR, JARM, JWT Bearer, SAML 2.0 |
| **M7: Identity Hub**       | 2025-12-20 | ✅ Complete | RP Module, Social Login (7 providers), PII Separation                 |
| **M8: Policy Integration** | 2025-12-19 | ✅ Complete | Unified AuthN + AuthZ, Token embedding, Check API                     |
| **M9: Advanced Identity**  | 2025-12-20 | ✅ Complete | OpenID4VP/CI, DID Resolver, DID Auth, 227 tests                       |
| **M10: SDK & API**         | 2026-01-30 | ✅ Complete | @authrim/core, web, server, sveltekit SDKs, Documentation Portal      |
| **M11: Security & QA**     | 2025-Q4    | ⏳ ~50%     | Load Testing ✅, Client Credentials ✅, Conformance OP ✅, Audit pending |
| **M12: Release**           | 2026-Q1    | 🔜 Final    | OpenID Certification, Public Release                                  |

---

## Phase 1: Foundation ✅ COMPLETE

**Timeline:** Nov 10 - Dec 15, 2025

**Achievements:**

- ✅ Git repository, TypeScript configuration
- ✅ Cloudflare Workers setup, Hono framework
- ✅ KV Storage, JOSE library
- ✅ Vitest testing framework
- ✅ CI/CD with GitHub Actions

---

## Phase 2: Core API Implementation ✅ COMPLETE

**Timeline:** Dec 16, 2025 - Jan 31, 2026

**Achievements:**

- ✅ Discovery & JWKS endpoints
- ✅ Authorization endpoint with PKCE
- ✅ Token endpoint (ID Token + Access Token)
- ✅ UserInfo endpoint
- ✅ All standard scopes (openid, profile, email, address, phone)

---

## Phase 3: Testing & Validation ✅ COMPLETE

**Timeline:** Feb 1 - Mar 15, 2026 | **Actual:** Nov 12, 2025

**Achievements:**

- ✅ OpenID Conformance Suite testing
- ✅ Basic OP: 78.95% (30/38 tests, 4 intentional skips)
- ✅ Config OP: 100%
- ✅ Form Post Basic: 84.21%

---

## Phase 4: Extended Features ✅ COMPLETE

**Timeline:** Mar 16 - Apr 30, 2026 | **Actual:** Nov 12, 2025

**Achievements:**

- ✅ Dynamic Client Registration (RFC 7591)
- ✅ PAR - Pushed Authorization Requests (RFC 9126)
- ✅ DPoP - Demonstrating Proof of Possession (RFC 9449)
- ✅ Pairwise Subject Identifiers
- ✅ Refresh Token with rotation
- ✅ Token Introspection (RFC 7662) & Revocation (RFC 7009)
- ✅ Form Post Response Mode
- ✅ Rate Limiting, Security Headers

---

## Phase 5: UI/UX Implementation ✅ COMPLETE

**Timeline:** May 1-31, 2026 | **Actual:** Nov 18, 2025

**Achievements:**

- ✅ D1 Database (12 tables)
- ✅ 14 Durable Objects
- ✅ SvelteKit + UnoCSS + Melt UI frontend
- ✅ Authentication UI (login, signup, consent, device, ciba)
- ✅ Admin Dashboard (7 pages)
- ✅ WebAuthn/Passkey API
- ✅ Magic Link authentication
- ✅ Multi-language support (EN/JA with Paraglide)
- ✅ E2E Testing (Playwright), Accessibility (axe-core)

---

## Phase 6: Enterprise Features ✅ COMPLETE

**Timeline:** Jun 1 - Oct 31, 2026 | **Actual:** Dec 02, 2025

**Goal:** Enterprise-grade authentication flows and integrations

### All Features Complete

| Feature         | RFC/Spec        | Status      | Date         |
| --------------- | --------------- | ----------- | ------------ |
| Device Flow     | RFC 8628        | ✅ Complete | Nov 21, 2025 |
| JWT Bearer Flow | RFC 7523        | ✅ Complete | Nov 21, 2025 |
| JWE             | RFC 7516        | ✅ Complete | Nov 21, 2025 |
| Hybrid Flow     | OIDC Core 3.3   | ✅ Complete | Nov 25, 2025 |
| CIBA            | OpenID Connect  | ✅ Complete | Nov 25, 2025 |
| SCIM 2.0        | RFC 7643/7644   | ✅ Complete | Nov 25, 2025 |
| JAR             | RFC 9101        | ✅ Complete | Nov 25, 2025 |
| JARM            | OIDC JARM       | ✅ Complete | Nov 25, 2025 |
| SAML 2.0        | SAML 2.0 IdP/SP | ✅ Complete | Dec 02, 2025 |
| Policy Service  | RBAC/ABAC       | ✅ Complete | Dec 02, 2025 |
| SD-JWT          | RFC 9901        | ✅ Complete | Dec 03, 2025 |
| Feature Flags   | Hybrid config   | ✅ Complete | Dec 03, 2025 |
| ReBAC Check API | Zanzibar-style  | ✅ Complete | Dec 03, 2025 |

> **Note:** LDAP/AD Integration removed - incompatible with Workers architecture (no TCP sockets)

---

## Phase 7: Identity Hub Foundation ✅ COMPLETE

**Timeline:** 2025-12 to 2026-Q1 | **Actual:** Dec 20, 2025

**Goal:** Transform Authrim from IdP-only to Identity Hub with RP capabilities + GDPR/CCPA compliance

### 7.1 RP Module Foundation ✅ COMPLETE

| Feature               | Description                                | Status      |
| --------------------- | ------------------------------------------ | ----------- |
| Upstream IdP Registry | Store external IdP configurations (D1)     | ✅ Complete |
| OIDC RP Client        | Connect to external OIDC providers         | ✅ Complete |
| OAuth 2.0 RP Client   | Generic OAuth 2.0 support                  | ✅ Complete |
| Session Linking       | Link upstream sessions to Authrim sessions | ✅ Complete |

### 7.2 Social Login Providers ✅ COMPLETE

| Provider             | Protocol  | Priority | Status      |
| -------------------- | --------- | -------- | ----------- |
| Google               | OIDC      | High     | ✅ Complete |
| Microsoft (Entra ID) | OIDC      | High     | ✅ Complete |
| GitHub               | OAuth 2.0 | High     | ✅ Complete |
| Apple                | OIDC      | Medium   | ✅ Complete |
| LinkedIn             | OAuth 2.0 | Medium   | ✅ Complete |
| Facebook             | OAuth 2.0 | Medium   | ✅ Complete |
| Twitter/X            | OAuth 2.0 | Medium   | ✅ Complete |

> **Note:** All 7 major providers complete. Microsoft supports multi-tenant (common/organizations/consumers) with automatic issuer validation. GitHub supports Enterprise Server. Any OIDC/OAuth2 provider can be dynamically added via Admin API.

### 7.3 Identity Linking ✅ COMPLETE

| Feature             | Description                                   | Status      |
| ------------------- | --------------------------------------------- | ----------- |
| Account Linking     | Link multiple external identities to one user | ✅ Complete |
| Identity Stitching  | Email-based automatic account linking         | ✅ Complete |
| Attribute Mapping   | Map upstream claims to Authrim schema         | ✅ Complete |
| Conflict Resolution | Handle email conflicts across providers       | ✅ Complete |
| Linking UI          | User interface for managing linked accounts   | ✅ Complete |

### 7.4 Admin Console Enhancement

| Feature              | Description                         | Status      |
| -------------------- | ----------------------------------- | ----------- |
| Provider Management  | Add/edit/delete upstream IdPs       | ✅ Complete |
| Attribute Mapping UI | Visual claim mapping editor         | ⚠️ Partial  |
| Login Flow Designer  | Configure authentication flow order | 🔜 Planned  |

### 7.5 PII/Non-PII Database Separation ✅ COMPLETE (Dec 18, 2025)

Data separation architecture for GDPR/CCPA compliance:

| Feature                | Description                                      | Status      |
| ---------------------- | ------------------------------------------------ | ----------- |
| DatabaseAdapter        | D1 abstraction, future Postgres/DynamoDB support | ✅ Complete |
| Repository Pattern     | UserCore, UserPII, Cache repositories            | ✅ Complete |
| PIIPartitionRouter     | Tenant/attribute/geo-based routing               | ✅ Complete |
| AuthContext/PIIContext | Type-safe PII access control                     | ✅ Complete |
| Schema Migration       | users_core, users_pii, tombstones                | ✅ Complete |
| Full Package Migration | 47 files, 4255 lines added                       | ✅ Complete |
| Admin API              | retry-pii, delete-pii, partitions, tombstones    | ✅ Complete |

---

## Phase 8: Unified Policy Integration ✅ COMPLETE

**Timeline:** 2025-12 (Completed ahead of schedule)

**Goal:** Integrate authentication and authorization into unified flow

### 8.1 Policy ↔ Identity Integration ✅ Complete

| Feature                   | Description                                    | Status      |
| ------------------------- | ---------------------------------------------- | ----------- |
| Attribute Injection       | Inject upstream attributes into policy context | ✅ Complete |
| Dynamic Role Assignment   | Assign roles based on upstream attributes      | ✅ Complete |
| Just-in-Time Provisioning | Create users/roles on first login              | ✅ Complete |

### 8.2 Token Embedding Model ✅ Complete

| Feature               | Description                                 | Status      |
| --------------------- | ------------------------------------------- | ----------- |
| Permissions in Token  | Embed evaluated permissions in access token | ✅ Complete |
| Roles in Token        | Embed assigned roles in ID token            | ✅ Complete |
| Resource Permissions  | Per-resource permission embedding           | ✅ Complete |
| Custom Claims Builder | Token claim rules via Admin API             | ✅ Complete |

### 8.3 Real-time Check API Model ✅ Complete

| Feature               | Description                               | Status      |
| --------------------- | ----------------------------------------- | ----------- |
| `/api/check` Endpoint | Real-time authorization check             | ✅ Complete |
| Batch Check API       | Check multiple permissions at once        | ✅ Complete |
| WebSocket Push        | Real-time permission change notifications | ✅ Complete |
| SDK Integration       | Client SDK for check API                  | 🔜 Phase 10 |

### 8.4 Policy Admin Console → Moved to Phase 10

> Policy Admin Console (Role Editor, Policy Editor, Relationship Viewer, Audit Log Viewer) has been
> moved to Phase 10 (SDK & API). Developing it alongside the SDK provides a consistent developer experience.

---

## Phase 9: Advanced Identity Sources ✅ COMPLETE

**Timeline:** 2025-12 | **Actual:** Dec 20, 2025

**Goal:** Support next-generation identity protocols (Verifiable Credentials)

### 9.1 OpenID4VP (Verifiable Presentations) ✅ COMPLETE

| Feature                  | Description                       | Status      |
| ------------------------ | --------------------------------- | ----------- |
| VP Request Generation    | Create presentation requests      | ✅ Complete |
| VP Verification          | Verify presentations from wallets | ✅ Complete |
| Credential Type Registry | Define accepted credential types  | ✅ Complete |
| Selective Disclosure     | Request specific claims only      | ✅ Complete |
| HAIP Compliance          | Algorithm restrictions, KB-JWT    | ✅ Complete |
| Security Tests           | 64+ tests (OWASP coverage)        | ✅ Complete |

### 9.2 OpenID4VCI (Credential Issuance) ✅ COMPLETE

| Feature             | Description                   | Status      |
| ------------------- | ----------------------------- | ----------- |
| Credential Endpoint | Issue VCs to users            | ✅ Complete |
| Credential Offer    | Generate issuance offers      | ✅ Complete |
| SD-JWT VC Format    | Issue SD-JWT credentials      | ✅ Complete |
| Credential Status   | Revocation/suspension support | 🔜 Phase 10 |

### 9.3 DID Support ✅ COMPLETE

| Feature              | Description                     | Status      |
| -------------------- | ------------------------------- | ----------- |
| did:web Resolver     | Resolve did:web identifiers     | ✅ Complete |
| did:key Resolver     | Resolve did:key identifiers     | ✅ Complete |
| DID Document Hosting | Host Authrim's own DID document | ✅ Complete |
| DID Authentication   | Challenge-response DID auth     | ✅ Complete |
| DID Linking          | Link DIDs to user accounts      | ✅ Complete |

### 9.4 Use Cases Enabled

```
┌─────────────────────────────────────────────────────────────┐
│  Example: Enterprise Application with VC                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. User logs in via Microsoft Entra (Social Login/RP)      │
│     → Basic identity: email, name                           │
│                                                             │
│  2. App requests age verification                           │
│     → Authrim sends OpenID4VP request                       │
│     → User presents VC from digital wallet                  │
│     → Authrim verifies and extracts: age_over_20: true      │
│                                                             │
│  3. Policy Engine evaluates                                 │
│     RBAC: department=Engineering → role: developer          │
│     ABAC: age_over_20=true → access: restricted_content     │
│                                                             │
│  4. Token issued with permissions                           │
│     → App receives unified token with all permissions       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 10: SDK & API ✅ COMPLETE

**Timeline:** December 2025 - January 2026

**Goal:** Developer SDKs and comprehensive API documentation

### JavaScript SDK Packages ✅

All JavaScript SDKs are production-ready and published:

| Package | Version | Description | Status |
|---------|---------|-------------|--------|
| **@authrim/core** | 0.1.11 | Platform-agnostic OIDC/PKCE client | ✅ Complete |
| **@authrim/web** | 0.1.9 | Browser SDK (Direct Auth, OAuth flows, Session) | ✅ Complete |
| **@authrim/server** | 0.1.1 | Server SDK (JWT validation, DPoP, Middleware) | ✅ Complete |
| **@authrim/sveltekit** | 0.1.2 | SvelteKit integration (SSR, Components, Stores) | ✅ Complete |

**SDK Features Implemented:**
- ✅ Authorization Code Flow with PKCE (RFC 7636)
- ✅ Token Exchange (RFC 8693), Introspection (RFC 7662), Revocation (RFC 7009)
- ✅ DPoP Support (RFC 9449) - Proof of Possession validation
- ✅ Direct Auth (Passkey/WebAuthn, Email Code/OTP, Social Login)
- ✅ Device Flow UI (RFC 8628) with QR code helpers
- ✅ Silent Authentication & Session Management
- ✅ Back-Channel Logout (OIDC 1.0)
- ✅ SCIM 2.0 Provisioning (RFC 7643/7644)
- ✅ Verifiable Credentials (OpenID4VCI/VP)
- ✅ Framework Middleware (Express, Fastify, Hono, Koa, NestJS)

**Test Coverage:**
- js-core: 13 test files
- js-server: 28 test files
- js-web: 16 test files
- Total: 57 test files

### Documentation & Examples ✅

| Feature | Description | Status |
|---------|-------------|--------|
| **Documentation Portal** | Astro/Starlight-based site | ✅ Complete |
| **API Reference** | Comprehensive SDK docs | ✅ Complete |
| **Error Code Catalog** | 91 error codes documented | ✅ Complete |
| **Example: Web** | Vanilla JS reference app | ✅ Complete |
| **Example: SvelteKit** | SvelteKit reference app | ✅ Complete |

### Future SDK Expansion 🔜

Framework-specific packages planned for post-v1.0:

| Package | Description | Status |
|---------|-------------|--------|
| @authrim/react | React hooks and components | 🔜 Post-v1.0 |
| @authrim/vue | Vue.js integration | 🔜 Post-v1.0 |
| @authrim/angular | Angular integration | 🔜 Post-v1.0 |
| @authrim/flutter | Flutter/Dart SDK | 🔜 Post-v1.0 |
| @authrim/react-native | React Native SDK | 🔜 Post-v1.0 |

> **Note:** JavaScript SDK ecosystem is complete. Additional framework SDKs will be developed based on community demand after v1.0 release.

---

## Phase 11: Security & QA ⏳ IN PROGRESS

**Timeline:** 2025-Q4 (December 2025)

**Goal:** Security hardening and quality assurance

### Key Features

| Feature               | Description                        | Status      |
| --------------------- | ---------------------------------- | ----------- |
| Client Credentials    | RFC 6749 §4.4 server-to-server     | ✅ Complete |
| Load Testing          | Performance benchmarks             | ✅ Complete |
| Conformance Tests (OP)| All OP profiles (7) + Logout (4)   | ✅ Complete |
| Conformance Tests (RP)| RP profiles certification          | 🔜 Planned  |
| Security Audit        | External security review           | 🔜 Planned  |
| Penetration Testing   | Third-party security assessment    | 🔜 Planned  |

### API Deprecation Plan

With the introduction of **Contract-based Presets** (FAPI 2.0, regulated-finance, etc.), the following legacy APIs will be deprecated:

| Legacy API/Feature | Replacement | Timeline | Status |
| ------------------ | ----------- | -------- | ------ |
| `GET/PUT /api/admin/settings/fapi-security` | Contract Presets (`fapi2-security-profile`, `fapi2-message-signing`) | Phase 12 | 🔜 Planned |
| `fapi.enabled` system flag | `TenantContract.preset` per tenant | Phase 12 | 🔜 Planned |
| Global FAPI mode toggle | Per-tenant preset selection | Phase 12 | 🔜 Planned |
| Certification Profiles API | Contract Presets (for production) | Phase 12 | 🔜 Planned |

**Migration Path:**
1. New tenants use Contract Presets from creation
2. Existing tenants assigned appropriate preset based on current `fapi.enabled` setting
3. Legacy APIs return deprecation warning headers
4. Legacy APIs removed in v1.0 release

**Benefits of Contract-based Approach:**
- Multi-tenant support with different security levels (e.g., Tenant A: FAPI 2.0, Tenant B: B2C standard)
- No environment variables or API calls needed for FAPI compliance
- Preset selection at tenant creation time

### Load Testing Results (December 2025) ✅

| Endpoint                        | Recommended RPS | Peak RPS | Key Finding                        |
| ------------------------------- | --------------- | -------- | ---------------------------------- |
| Silent Auth (128 shards)        | 2,500           | 3,500    | DO sharding eliminates errors      |
| Refresh Token (48 shards)       | 2,500           | 3,000    | Linear shard scaling               |
| UserInfo                        | 2,000           | 2,500    | JWT validation stable at 1-4ms CPU |
| Token Exchange                  | 1,500           | 2,500    | 100% token validation accuracy     |
| Token Introspection (32 shards) | 300             | 500      | Region-aware JTI sharding          |
| Full Login (32 shards)          | 100 LPS         | 150 LPS  | 91% P95 latency reduction          |

> **Reports:** [load-testing/reports/Dec2025/](../load-testing/reports/Dec2025/)

---

## Phase 12: Certification & Release 🔜 FINAL

**Timeline:** 2026-Q1 (January - March 2026)

**Goal:** OpenID Certification and official public release

### Certification

| Stage                        | Description                      | Status     |
| ---------------------------- | -------------------------------- | ---------- |
| GitHub Public                | Open source repository           | 🔜 Planned |
| Documentation Review         | Complete docs and guides         | 🔜 Planned |
| OpenID Foundation Submission | Apply for certification          | 🔜 Planned |
| Test Environment             | Provision certification test env | 🔜 Planned |
| Certification Obtained       | Official OpenID Certified mark   | 🔜 Planned |

### Release

| Feature          | Description                         | Status     |
| ---------------- | ----------------------------------- | ---------- |
| create-authrim   | NPM package for project scaffolding | 🔜 Planned |
| Setup Wizard     | Interactive configuration           | 🔜 Planned |
| Migration Guides | From Auth0, Keycloak, Okta          | 🔜 Planned |
| Public Launch    | Official announcement               | 🔜 Final   |

---

## Success Metrics

### Phase 1-6 (Complete)

| Metric                  | Target | Actual                  |
| ----------------------- | ------ | ----------------------- |
| Unit tests              | 200+   | 60 files, ~25,270 lines |
| Conformance (Basic OP)  | 85%    | 78.95% ✅               |
| Conformance (Config OP) | 85%    | 100% ✅                 |
| UI pages                | 10+    | 15+ ✅                  |
| Durable Objects         | 10+    | 14 ✅                   |
| Enterprise features     | 9      | 13/13 (100%) ✅         |

### Phase 7-12 (In Progress / Planned)

| Metric                   | Target      | Current                                           | Phase |
| ------------------------ | ----------- | ------------------------------------------------- | ----- |
| Social login providers   | 7+          | ✅ 7 (Google, MS, GitHub, Apple, LinkedIn, FB, X) | P7 ✅ |
| OIDC RP Client tests     | 50+         | ✅ 315 tests                                      | P7 ✅ |
| Identity linking tests   | 50+         | ✅ 14,666 lines                                   | P7 ✅ |
| Provider Management UI   | Complete    | ✅ Complete                                       | P7 ✅ |
| Policy integration tests | 100+        | ✅ Complete                                       | P8 ✅ |
| VC/DID tests             | 100+        | ✅ 227 tests                                      | P9 ✅ |
| SDK downloads            | 1000+       | -                                                 | P10   |
| Load test RPS            | 10,000+     | ✅ 3,500 (Silent Auth)                            | P11   |
| OP Conformance           | All profiles| ✅ 7 OP + 4 Logout profiles                       | P11 ✅|
| RP Conformance           | Basic/Config| 🔜 Planned                                        | P11   |
| Security hardening       | 100%        | ⏳ ~50%                                           | P11   |
| OpenID Certification     | ✅ Obtained | -                                                 | P12   |

---

## Key Results (Overall)

By 2026-Q1, Authrim will be:

1. **Identity Hub** - Unified authentication from multiple sources (Social, SAML, OIDC, Wallets)
2. **Policy-Integrated** - AuthN + AuthZ in single platform (RBAC, ABAC, ReBAC)
3. **VC-Ready** - OpenID4VP/CI for next-generation identity
4. **OpenID Certified** - Official certification obtained
5. **Passwordless-first** - WebAuthn + Magic Link + Social Login
6. **Globally distributed** - <50ms latency worldwide (Cloudflare Edge)
7. **Enterprise-ready** - SAML, SCIM, Device Flow, CIBA
8. **Maximum Security** - DPoP, PAR, JAR, JARM, JWE, MTLS
9. **Developer-friendly** - WebSDK, CLI, comprehensive docs
10. **Open Source** - Apache 2.0, self-hosted

---

## Change Log

| Date       | Change                                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2025-11-11 | Initial roadmap                                                                                                                                                                                            |
| 2025-11-12 | Phase 3 & 4 completed early                                                                                                                                                                                |
| 2025-11-18 | Phase 5 completed                                                                                                                                                                                          |
| 2025-11-25 | Phase 6: 8/11 features complete                                                                                                                                                                            |
| 2025-11-29 | Documentation restructure                                                                                                                                                                                  |
| 2025-12-02 | Major roadmap restructure: Phase 7-12 redefined, SaaS removed, Policy Service added                                                                                                                        |
| 2025-12-02 | SAML 2.0 complete, Phase 6 complete                                                                                                                                                                        |
| 2025-12-03 | **Major pivot: Identity Hub + Policy Integration strategy**                                                                                                                                                |
| 2025-12-03 | Phase 7 redefined: Identity Hub Foundation (RP, Social Login)                                                                                                                                              |
| 2025-12-03 | Phase 8 redefined: Unified Policy Integration                                                                                                                                                              |
| 2025-12-03 | Phase 9 redefined: Advanced Identity (OpenID4VP/CI, DID)                                                                                                                                                   |
| 2025-12-03 | Timeline compressed: Target completion 2027-Q2                                                                                                                                                             |
| 2025-12-15 | **Phase 7 ~80% complete**: RP Module, Google, Identity Linking/Stitching done                                                                                                                              |
| 2025-12-15 | Remaining P7 tasks: GitHub/Microsoft templates, Login Flow Designer                                                                                                                                        |
| 2025-12-15 | **Microsoft (Entra ID) complete**: Multi-tenant support (common/organizations/consumers), issuer pattern validation, comprehensive security tests                                                          |
| 2025-12-17 | **GitHub OAuth 2.0 complete**: Enterprise Server support, /user/emails API, 57 tests                                                                                                                       |
| 2025-12-17 | **Durable Objects best practices**: blockConcurrencyWhile, Tombstone pattern, DO retry utility                                                                                                             |
| 2025-12-17 | External IdP documentation added, other social providers deferred to Phase 8+                                                                                                                              |
| 2025-12-17 | **Phase 11 Load Testing ✅ Complete**: 6 benchmark reports (Silent Auth, UserInfo, Token Exchange, Token Introspection, Refresh Token, Full Login), K6 Cloud distributed testing, DO sharding optimization |
| 2025-12-17 | **MTLS (RFC 8705) removed from scope**: Cloudflare Workers architecture limitation                                                                                                                         |
| 2025-12-18 | **PII/Non-PII Database Separation ✅ Complete**: DatabaseAdapter, Repository pattern, PIIPartitionRouter, AuthContext/PIIContext, 47 files migrated                                                        |
| 2025-12-18 | **Phase 7 ~95% Complete**: GDPR/CCPA compliant architecture complete, ready for Phase 8                                                                                                                    |
| 2025-12-18 | **8.4 Policy Admin Console → Moved to Phase 10**: Develop alongside SDK for consistent developer experience                                                                                                |
| 2025-12-18 | **8.1 Policy ↔ Identity Integration ✅ Complete**: Rule Evaluator, JIT Provisioning with dynamic role assignment, org auto-join, email domain hash with key rotation, Admin APIs                          |
| 2025-12-19 | **Phase 8 ✅ Complete**: Token Embedding Model (8.2), Real-time Check API (8.3) with UnifiedCheckService, Permission Parser, WebSocket Push via PermissionChangeHub DO, Check API Keys Admin API           |
| 2025-12-20 | **Phase 7 ✅ Complete**: All 7 social login providers (Google, Microsoft, GitHub, Apple, LinkedIn, Facebook, Twitter/X)                                                                                    |
| 2025-12-20 | **Phase 9 ✅ Complete**: OpenID4VP/VCI, DID Support (did:web, did:key, DID Auth), 227 tests                                                                                                                |
| 2025-12-21 | **Phase 11 Security Hardening**: DPoP `ath` timing-safe comparison (RFC 9449), JWT algorithm consistency (`ALLOWED_ASYMMETRIC_ALGS`), Policy Flags Admin API (CLAUDE.md compliant)                         |
| 2025-12-26 | **FAPI 2.0 Contract Presets**: Added `fapi2-security-profile` and `fapi2-message-signing` presets based on OIDF FAPI 2.0 Final specs. Deprecation plan for legacy `fapi-security` API added to roadmap. |
| 2026-01-01 | **Client Credentials Flow ✅ Complete** (RFC 6749 §4.4): `client_secret_basic`, `client_secret_post`, `private_key_jwt` authentication methods implemented with 382 lines of tests. |
| 2026-01-01 | **Documentation Alignment**: Updated PII Separation (✅ Complete), RAR Phase 1 (✅ Complete), Flow×UI Types (✅ Complete) documentation to reflect actual implementation status. |
| 2026-01-30 | **Phase 10 ✅ Complete**: JavaScript SDK ecosystem fully implemented - @authrim/core (v0.1.11), @authrim/web (v0.1.9), @authrim/server (v0.1.1), @authrim/sveltekit (v0.1.2). Documentation portal (Astro/Starlight), 57 test files, 2 example apps. |

---

## Not Supported

The following features are intentionally **not supported** due to architectural constraints:

| Feature                 | Reason                                                                                                                                                                                          | Alternative                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MTLS (RFC 8705)**     | Cloudflare Workers terminates TLS at edge; cannot control TLS handshake directly. SHA-256 certificate thumbprint requires additional Cloudflare configuration (Managed Transforms, API Shield). | FAPI 2.0 supports `private_key_jwt` as an alternative client authentication method. DPoP (RFC 9449) provides sender-constrained tokens without MTLS. |
| **LDAP/AD Integration** | Cloudflare Workers runtime has no TCP socket support.                                                                                                                                           | Use SCIM 2.0 for user provisioning, or connect via external IdP (Azure AD, Okta) that provides OIDC/SAML federation.                                 |

---

> **Last Update:** 2026-01-30
>
> **Current Status:** Phase 1-10 ✅ Complete | Phase 11 ~50% | Phase 12 🔜 Planned
>
> **Authrim** - The Identity & Access Platform for the modern web.
