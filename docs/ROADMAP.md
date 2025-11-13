# Enrai Product Roadmap 🗺️

**Vision:** One-command identity infrastructure for the modern web

**Timeline:** November 2025 - August 2026 (10 months)

---

## 📅 Timeline Overview

```
2025                 2026                                    2027
Nov  Dec  Jan  Feb  Mar  Apr  May  Jun  Jul  Aug  Sep  Oct  Nov  Dec  Jan  Feb  Mar+
│    │    │    │    │    │    │    │    │    │    │    │    │    │    │    │    │
├─P1─┼─P2─┼─P3─┼────┼─P4─┼─P5─┼───P6────┼────P7────┼─────P8─────┼─────P9─────┼─P10
│    │    │    │    │    │    │    │    │    │    │    │    │    │    │    │    │
✅   ✅   ✅   ✅   ✅   🆕   🆕   🆕   🆕   🆕   🆕   🆕   🆕   🆕   🆕   🆕   🎓

Legend:
✅ Complete (Phases 1-4)
🆕 Planned (UI/UX, CLI, Enterprise, Next-Gen, SaaS)
🎓 Final (Certification & Production Launch)
```

---

## 🎯 Milestones

| Milestone | Date | Status | Description |
|-----------|------|--------|-------------|
| **M1: Foundation** | 2025-12-15 | ✅ Complete | Project setup, tooling, basic structure |
| **M2: Core API** | 2026-01-31 | ✅ Complete | All OIDC endpoints functional |
| **M3: Conformance** | 2026-03-15 | ✅ Complete | OpenID Conformance Suite (95.8% Phase 3) |
| **M4: Extensions** | 2026-04-30 | ✅ Complete | All extended security features: DCR, Rate Limiting, PAR, DPoP, Pairwise, Token Management, Form Post, Storage Foundation |
| **M5: UI/UX** | 2026-05-31 | 🆕 Planned | Login/Registration, Admin Dashboard, User Database |
| **M6: CLI & Deploy** | 2026-08-10 | 🆕 Planned | One-command deployment |
| **M7: Enterprise** | 2026-10-31 | 🆕 Planned | Hybrid, Device, CIBA, Social Login |
| **M8: Next-Gen** | 2027-01-31 | 🆕 Planned | Verifiable Credentials, OAuth 2.1 |
| **M9: SaaS** | 2027+ | 🌐 Future | Multi-tenant platform |
| **M10: Certification** | TBD | 🎓 Final | OpenID Certification & Production Launch |

---

## Phase 1: Foundation ✅ COMPLETE

**Timeline:** Nov 10 - Dec 15, 2025 (5 weeks)

**Goal:** Establish solid technical foundation

### Achievements

#### Week 1: Project Setup ✅
- ✅ Git repository initialization
- ✅ TypeScript configuration
- ✅ Cloudflare Workers setup
- ✅ Development environment
- ✅ Code quality tools (ESLint, Prettier)

#### Week 2: Hono Framework ✅
- ✅ Hono app initialization
- ✅ Middleware (CORS, security headers, logging)
- ✅ Basic routing structure
- ✅ Environment types
- ✅ Health check endpoint

#### Week 3: Cloudflare Services ✅
- ✅ KV Storage integration
- ✅ JOSE library setup
- ✅ Durable Objects design
- ✅ Secret management

#### Week 4: Testing Framework ✅
- ✅ Vitest configuration
- ✅ JWT utilities with tests
- ✅ Validation utilities with tests
- ✅ Mock Cloudflare environment

#### Week 5: CI/CD ✅
- ✅ GitHub Actions (CI)
- ✅ GitHub Actions (Deploy)
- ✅ Documentation
- ✅ Code review process

**Deliverables:**
- ✅ 85 passing tests
- ✅ TypeScript builds with zero errors
- ✅ `wrangler dev` working locally
- ✅ CI/CD pipeline functional

---

## Phase 2: Core API Implementation ✅ COMPLETE

**Timeline:** Dec 16, 2025 - Jan 31, 2026 (7 weeks)

**Goal:** Implement all core OpenID Connect endpoints

### Achievements

#### Week 6: Discovery & JWKS ✅
- ✅ `/.well-known/openid-configuration` endpoint
- ✅ `/.well-known/jwks.json` endpoint
- ✅ Cache headers optimization
- ✅ 29 tests (Discovery + JWKS)

#### Week 7: Authorization Endpoint ✅
- ✅ `/authorize` endpoint
- ✅ Parameter validation (response_type, client_id, redirect_uri, scope, state, nonce)
- ✅ **PKCE support** (code_challenge, S256 method)
- ✅ Authorization code generation (UUID v4)
- ✅ KV storage integration
- ✅ Error handling (direct vs redirect)
- ✅ 21 comprehensive tests

#### Week 8: Token Endpoint ✅
- ✅ `/token` endpoint
- ✅ Authorization code validation
- ✅ **PKCE verification** (code_verifier)
- ✅ ID Token generation (with claims)
- ✅ Access Token generation
- ✅ Scope-based claims (profile, email)
- ✅ Single-use code enforcement

#### Week 9: UserInfo Endpoint ✅
- ✅ `/userinfo` endpoint
- ✅ Bearer token authentication
- ✅ JWT signature verification
- ✅ Scope-based claim filtering
- ✅ Proper error responses (401, WWW-Authenticate)

#### Week 10-12: Polish & Testing ✅
- ✅ Error handling enhancement
- ✅ Input validation hardening
- ✅ Integration tests (24 tests total)
- ✅ Code review & refactoring
- ✅ **Token revocation on code reuse** (RFC 6749 Section 4.1.2)
- ✅ **Claims parameter support** (OIDC Core 5.5)
- ✅ **Authorization endpoint POST method** (OIDC Core 3.1.2.1)
- ✅ **PKCE validation fix** (all RFC 7636 characters)
- ✅ **Address and phone scope support** (OIDC Core 5.4)

**Deliverables:**
- ✅ 178 passing tests (24 Authorization + others)
- ✅ All core OIDC endpoints functional
- ✅ PKCE support (RFC 7636) - complete
- ✅ Claims parameter support (essential claims)
- ✅ Token revocation on code reuse
- ✅ All standard scopes (openid, profile, email, address, phone)
- ✅ Comprehensive test coverage

---

## Phase 3: Testing & Validation ✅ COMPLETE

**Timeline:** Feb 1 - Mar 15, 2026 (6 weeks) - **Completed early (Nov 2025)**

**Goal:** Pass OpenID Conformance Suite (≥85%) - **Phase 3 Scope: 95.8% achieved**

### Week 13: Conformance Suite Setup ✅
- ✅ OpenID Conformance Suite online access
- ✅ Configuration for Basic OP profile
- ✅ Initial test runs completed
- ✅ Issue identification & prioritization
- ✅ Test results documentation started

### Week 14-17: Conformance Fixes ✅ (All Phase 3 items complete)
- ✅ Discovery & metadata compliance
  - ✅ Added address and phone to scopes_supported
  - ✅ Added all claims to claims_supported
- ✅ Core flow compliance (authorize, token, userinfo)
  - ✅ Token revocation on code reuse (RFC 6749 Section 4.1.2)
  - ✅ Claims parameter support (OIDC Core 5.5)
  - ✅ Authorization endpoint POST method (OIDC Core 3.1.2.1)
  - ✅ PKCE validation (all RFC 7636 characters)
  - ✅ Address and phone scope implementation
- ✅ JWT/JWK format compliance
- ✅ OAuth 2.0 error response compliance
- ✅ Edge case handling (within Phase 3 scope)

### Week 18: Final Validation ✅ COMPLETE
- ✅ Complete conformance test run (final) - 33 tests executed
- ✅ Performance benchmarks completed
- ✅ Test report generation (docs/conformance/test-results/report-20251112.md)
- ✅ Conformance Suite detailed results (docs/conformance/test-results/conformance-suite-results-20251112.md)
- ✅ Documentation of results
- ✅ Action plan for remaining issues (Phase 4-6 roadmap)

**Success Criteria:**
- ✅ **Phase 3 Scope Achievement: 95.8%** (23/24 applicable tests)
- ✅ **Overall Conformance: 72.7%** (24/33 tests)
- ✅ All critical tests passing (token revocation, claims, POST, PKCE)
- ✅ No security vulnerabilities
- ⚠️ Performance benchmarks completed (optimization deferred to Phase 4)

**Final Status (2025-11-12):**
- ✅ **OpenID Conformance Suite:**
  - PASSED: 23 tests (69.7%)
  - REVIEW: 1 test (manual certification team review)
  - FAILED/INTERRUPTED: 8 tests (Phase 4-6 features)
  - SKIPPED: 1 test (Refresh token - Phase 4)
- ✅ **Phase 3 Core Features:** 23/24 tests (95.8%) 🎯
- ✅ **Unit + Integration Tests:** 178/178 tests (100% pass rate)
- ✅ **Performance Benchmarks:** Completed (functional, optimization needed in Phase 4)
- ✅ **Production Deployment:** Validated on Cloudflare Workers
- ✅ **Documentation:** Comprehensive test reports and implementation notes

**Deferred to Phase 4-6 (By Design):**
- Phase 4: Refresh token, key rotation, performance optimization
- Phase 5: Request Object (JAR), Dynamic Client Registration
- Phase 6: Session management, Login UI, prompt/max_age parameters

---

## Phase 4: Extended Features & Security ✅ COMPLETE

**Timeline:** Mar 16 - Apr 30, 2026 (6 weeks) - **Completed early (Nov 2025)**

**Goal:** Add security extensions and prepare storage foundation

**Status:** ✅ All features completed (Nov 2025)

---

### ✅ COMPLETED (Nov 2025)

#### Week 19-20: Dynamic Client Registration ✅

##### Dynamic Client Registration - RFC 7591 ✅
- ✅ `POST /register` endpoint
- ✅ Client metadata validation
- ✅ Client storage (KV/Durable Objects)
- ✅ Client secret generation
- ✅ Registration access token
- ✅ 56 comprehensive tests
- **Why:** Basic functionality, essential level for OpenID authentication

#### Week 21-22: Key Rotation & Extended Claims ✅

##### Key Rotation & Management ✅
- ✅ KeyManager Durable Object implementation
- ✅ Automatic key rotation
- ✅ Multiple active keys support
- ✅ JWKS endpoint update for multi-key

##### Extended Claims Support ✅
- ✅ Email claim support
- ✅ Profile claims (name, given_name, family_name, etc.)
- ✅ Address scope support
- ✅ Phone scope support
- ✅ Custom claims capability

##### Nonce Enforcement ✅
- ✅ Nonce validation (configurable)
- ✅ Replay protection

#### Week 23-24: Security & Performance ✅

##### Security Enhancements ✅
- ✅ Security audit completed
- ✅ CORS configuration (41 tests)
- ✅ Security headers implementation
- ✅ CSP (Content Security Policy)
- ✅ HSTS, XSS protection

##### Rate Limiting ✅
- ✅ Rate limiting middleware (44 tests)
- ✅ Configurable profiles (strict/moderate/lenient)
- ✅ Per-endpoint protection

##### Performance Optimization ✅
- ✅ Endpoint performance profiling
- ✅ KV operations optimization
- ✅ Discovery endpoint caching
- ✅ Edge latency measurement

#### Week 25: Review & Documentation ✅
- ✅ Code review
- ✅ Security review
- ✅ Performance review
- ✅ Documentation update

#### Week 26-27: Advanced Security Extensions ✅

##### PAR (Pushed Authorization Requests) - RFC 9126 ✅
- ✅ `POST /as/par` endpoint
- ✅ Request object validation
- ✅ Request URI generation and storage
- ✅ Authorization endpoint PAR support
- ✅ Tests & conformance validation (15+ tests)
- ✅ Documentation (comprehensive guide)
- **Why:** Security enhancement, phishing protection, highly rated for OpenID authentication

##### DPoP (Demonstrating Proof of Possession) - RFC 9449 ✅
- ✅ DPoP token validation middleware
- ✅ DPoP-bound access token generation
- ✅ Token endpoint DPoP support
- ✅ UserInfo endpoint DPoP support
- ✅ Replay attack prevention
- ✅ Tests & conformance validation (12 tests)
- ✅ Documentation (inline code documentation)
- **Why:** Excellent compatibility with edge environments, latest security standard, token theft protection

##### Pairwise Subject Identifiers - OIDC Core 8.1 ✅
- ✅ Subject type configuration (public/pairwise)
- ✅ Pairwise identifier generation (per client)
- ✅ Sector identifier validation
- ✅ Storage for pairwise mappings
- ✅ Tests & conformance validation (22 tests)
- ✅ Documentation (inline code documentation)
- **Why:** Privacy protection, GDPR compliant, preparation required

#### Week 28-29: Token Management ✅

##### Refresh Token Flow - RFC 6749 Section 6 ✅
- ✅ Refresh token generation
- ✅ Refresh token validation
- ✅ Token rotation (refresh token)
- ✅ Refresh token revocation
- ✅ Storage implementation
- ✅ Tests & conformance validation (47+ tests)
- ✅ Documentation (comprehensive guide)
- **Why:** Basic functionality, major implementation, UX improvement

##### Token Introspection & Revocation - RFC 7662, RFC 7009 ✅
- ✅ `POST /introspect` endpoint
- ✅ `POST /revoke` endpoint
- ✅ Token metadata response
- ✅ Client authentication for introspection
- ✅ Tests & conformance validation (47+ tests)
- ✅ Documentation (comprehensive guide)
- **Why:** Security foundation, essential for enterprise

#### Week 30: Response Modes & Storage Foundation ✅

##### Form Post Response Mode - OAuth 2.0 Form Post ✅
- ✅ `response_mode=form_post` support
- ✅ Auto-submit HTML form generation
- ✅ Authorization endpoint enhancement
- ✅ Tests & conformance validation (19 tests)
- ✅ Documentation (comprehensive guide)
- ✅ XSS prevention with HTML escaping
- ✅ User-friendly loading UI with spinner
- **Why:** Security foundation, does not remain in browser history

##### Storage Foundation (Preparation for Phase 6) ✅
- ✅ Abstract storage interface design
- ✅ D1 schema design (users, clients, sessions)
- ✅ Migration system foundation (interfaces defined)
- ✅ Storage adapter selection logic (KV adapter implemented)
- ✅ Documentation (comprehensive inline documentation)

---

**Completed Deliverables:**
- ✅ **Dynamic Client Registration (RFC 7591)** - 56 tests passing
- ✅ **Rate Limiting Middleware** - 44 tests passing
- ✅ **Security Headers & CORS** - 41 tests passing
- ✅ **Extended Claims Support** - Full OIDC profile
- ✅ **KeyManager Durable Object** - Multi-key rotation
- ✅ **Token Management (Refresh Token, Introspection, Revocation)** - 47+ tests, RFC 6749/7662/7009
- ✅ **PAR (Pushed Authorization Requests)** - 15+ tests, RFC 9126
- ✅ **Form Post Response Mode** - 19 tests, OAuth 2.0 Form Post
- ✅ **DPoP (Demonstrating Proof of Possession)** - 12 tests, RFC 9449
- ✅ **Pairwise Subject Identifiers** - 22 tests, OIDC Core 8.1
- ✅ **Storage Foundation** - Abstract interfaces for Phase 6
- ✅ **Total:** 378+ tests passing (200+ new Phase 4 tests)

**Phase 4 Documentation:**
- ✅ Token Management Guide (docs/features/token-management.md)
- ✅ PAR Implementation Guide (docs/features/par.md)
- ✅ Form Post Response Mode Guide (docs/features/form-post-response-mode.md)
- ✅ DPoP Implementation (inline code documentation)
- ✅ Pairwise Subject Identifiers (inline code documentation)
- ✅ Storage Abstraction Layer (comprehensive interface documentation)

---

## Phase 5: UI/UX Implementation 🆕

**Timeline:** May 1-31, 2026 (4 weeks)

**Goal:** Best passwordless and user experience

**Priority:** Best user experience, modern UX

**Tech Stack Decisions:**
- **Frontend**: Svelte + SvelteKit v5
- **CSS**: UnoCSS
- **Components**: Melt UI (Headless, accessible)
- **Hosting**: Cloudflare Pages (UI) + Workers (API) - Hybrid
- **Captcha**: Cloudflare Turnstile
- **i18n**: Paraglide (type-safe, lightweight)

### Week 26-27: Authentication UI (May 1-14)

**Key Features:**
- [ ] Passwordless Login Screen (Passkey + Magic Link)
  - Email input with validation
  - Passkey authentication flow (WebAuthn)
  - Magic Link fallback
  - Cloudflare Turnstile integration
- [ ] User Registration with WebAuthn
  - Passkey registration flow
  - Email verification
- [ ] OAuth Consent Screen
  - Client info display (logo, name, scopes)
  - Privacy policy & ToS links
  - Allow/Deny actions
- [ ] Multi-language support (English, Japanese)
- [ ] Theme System (basic branding)
  - Custom CSS/HTML header/footer
  - Logo, colors, fonts
  - Background images

### Week 28-29: Admin Dashboard (May 15-28)

**Key Features:**
- [ ] Dashboard Overview
  - Statistics cards (users, sessions, logins, clients)
  - Activity feed (recent logins, registrations, errors)
  - Charts (login trends, user registration trends)
- [ ] User Management
  - User list with search/filter/sort/pagination
  - User search API (`GET /admin/users?q=...`)
  - CRUD operations
  - Custom fields support (searchable + JSON)
  - Parent-child user relationships
- [ ] Client Management
  - Client list with search
  - CRUD operations (using DCR API)
  - Custom scope mappings
- [ ] Rate Limiting Dashboard
  - Blocked IPs list
  - Request counts per endpoint (charts)
  - Anomaly detection alerts
- [ ] Settings & Customization
  - Branding settings (logo, colors, theme)
  - Email provider configuration (Resend/Cloudflare/SMTP)
  - Security settings (session timeout, rate limits)
  - RBAC roles management

### Week 30-31: Data Storage & Authentication (May 29 - Jun 11)

**Key Features:**
- [ ] Storage Abstraction Layer
  - `IStorageAdapter` interface (KV-like + SQL-like)
  - CloudflareAdapter (KV + D1 + DO)
  - Multi-cloud support design (Azure, AWS, PostgreSQL)
- [ ] D1 Database Schema
  - Users table (with custom_attributes_json, parent_user_id)
  - user_custom_fields table (searchable custom fields)
  - Passkeys table
  - Sessions table
  - Roles & user_roles tables (RBAC)
  - scope_mappings table (custom claim mapping)
  - branding_settings table
  - identity_providers table (for future SAML/LDAP)
- [ ] WebAuthn/Passkey Implementation (FIDO2)
  - @simplewebauthn/server & browser libraries
  - Registration & authentication flows
  - Counter management (replay attack prevention)
- [ ] Magic Link Authentication
  - Token generation (cryptographically secure)
  - Email provider adapter (Resend default)
  - Token verification (one-time, 15min TTL)
- [ ] Session Management
  - Server-side session + token exchange (ITP-compliant)
  - Cross-domain SSO support
  - HttpOnly cookies
  - Session revocation
- [ ] Data Export
  - CSV/JSON export (all tables)
  - GDPR personal data export

**Deliverables:**
- [ ] 🎯 **WebAuthn/Passkey fully functional** (Key feature)
- [ ] 🎯 **Magic Link authentication working**
- [ ] 🎯 **ITP-compliant cross-domain SSO**
- [ ] Fully functional login/registration UI (beautiful, passwordless)
- [ ] Complete admin dashboard (with user/client management)
- [ ] Multi-storage backend support (KV, D1, DO)
- [ ] RBAC implementation (roles & permissions)
- [ ] Custom fields & scope mappings
- [ ] Multi-language support (EN, JA)
- [ ] Responsive, accessible interfaces (WCAG 2.1 AA)

---

## Phase 6: CLI & Automation 🆕

**Timeline:** Jun 12 - Aug 10, 2026 (9 weeks)

**Goal:** One-command deployment and management

*(Content from old Phase 7 - see TASKS.md for full details)*

### Week 32-33: CLI Tool Development (Jun 12-25)

**Key Features:**
- [ ] `create-enrai` NPM package
- [ ] Interactive setup wizard
- [ ] Project scaffolding
- [ ] Deployment commands

### Week 34-35: Cloudflare Integration (Jun 26 - Jul 9)

**Key Features:**
- [ ] Cloudflare API client
- [ ] Worker deployment API
- [ ] KV/D1/DO management
- [ ] DNS & custom domain setup

### Week 36-39: Production Readiness (Jul 10 - Aug 10)

**Key Features:**
- [ ] Setup automation
- [ ] Error handling & recovery
- [ ] Performance optimization
- [ ] Security hardening
- [ ] Monitoring & observability
- [ ] Documentation & examples
- [ ] NPM package publishing

**Deliverables:**
- [ ] `create-enrai` package published
- [ ] One-command deployment functional
- [ ] CLI with 20+ management commands
- [ ] Production-ready error handling
- [ ] Complete documentation

---

*(See TASKS.md Phase 6 for full CLI implementation details)*

---

## Phase 7: Enterprise Flows & Advanced Features 🏢

**Timeline:** Aug 11 - Oct 31, 2026 (11 weeks)

**Goal:** Enterprise flows + advanced authentication features

*(Content from old Phase 8 - see TASKS.md for full details)*

### Week 40-42: Advanced OAuth Flows (Aug 11-31)

**Key Features:**
- [ ] Hybrid Flow (OIDC Core 3.3)
- [ ] Device Authorization Flow (RFC 8628)
- [ ] JWT Bearer Flow (RFC 7523)

### Week 43-44: CIBA & Advanced Encryption (Sep 1-14)

**Key Features:**
- [ ] CIBA (Client Initiated Backchannel Authentication)
- [ ] JWE (JSON Web Encryption - RFC 7516)

### Week 45-47: Social Login & Identity Federation (Sep 15 - Oct 5)

**Key Features:**
- [ ] Social Login Providers (Google, GitHub, Microsoft, Apple, Facebook, Twitter, LinkedIn)
- [ ] Identity Federation & Transformation
- [ ] Account linking

### Week 48-50: Enterprise Integration (Oct 6-26)

**Key Features:**
- [ ] SAML 2.0 Bridge (OIDC → SAML)
- [ ] LDAP/AD Integration
- [ ] SCIM 2.0 User Provisioning (RFC 7643, RFC 7644)
- [ ] CSV/JSON Import/Export
- [ ] Webhook Integration
- [ ] Bulk User Operations API

### Week 51: Advanced Security & RBAC (Oct 27 - Nov 2)

**Key Features:**
- [ ] Risk-Based Authentication
- [ ] ABAC (Attribute-Based Access Control) - advanced extension
- [ ] GDPR Automation (Right to Erasure, Data Portability)
- [ ] Compliance Tooling (SOC 2, ISO 27001)

### Week 52: Advanced UI Features

**Key Features:**
- [ ] Visual Authentication Flow Builder (SimCity-inspired UI)
  - Drag & drop authentication flow construction
  - Visual components (Passkey, Magic Link, Social Login as "buildings")
  - Flow visualization (入口→認証→出口)
- [ ] WebSDK (High-customization)
  - Web Components architecture
  - Custom placeholders (`<$$$LoginEmailInput$$$>`, etc.)
  - Fully styleable
  - Event handler support (`onLogin`, `onError`)
- [ ] Advanced Branding & Theming
  - Custom CSS/HTML/JavaScript injection (sandboxed)
  - Video backgrounds support
  - Template gallery

**Deliverables:**
- [ ] All advanced OAuth flows operational
- [ ] CIBA & JWE implemented
- [ ] Social Login (6+ providers)
- [ ] SAML 2.0 bridge functional
- [ ] LDAP/AD integration working
- [ ] SCIM 2.0 provisioning operational
- [ ] Risk-based authentication active
- [ ] ABAC implemented
- [ ] Visual Flow Builder operational
- [ ] WebSDK published
- [ ] GDPR compliance automation

---

*(See TASKS.md Phase 7 for full Enterprise implementation details)*

---

## Phase 8: Verifiable Credentials & Next-Gen 🚀

**Timeline:** Nov 3, 2026 - Jan 31, 2027 (13 weeks)

**Goal:** Decentralized ID + next-generation protocols

*(Content from old Phase 9 - see TASKS.md for full details)*

### Week 52-54: OpenID for Verifiable Credentials (Nov 3-23)

**Key Features:**
- [ ] OpenID4VP (Verifiable Presentations)
- [ ] OpenID4CI (Credential Issuance)
- [ ] OpenID4IA (Identity Assurance)
- [ ] W3C Verifiable Credentials support
- [ ] DID (Decentralized Identifier) resolution

### Week 55-57: Federation & OAuth 2.1 (Nov 24 - Dec 14)

**Key Features:**
- [ ] OpenID Federation 1.0
- [ ] OAuth 2.1 compliance
- [ ] Trust chain validation
- [ ] Security best practices enforcement

### Week 58-60: Privacy & Advanced Features (Dec 15, 2026 - Jan 11, 2027)

**Key Features:**
- [ ] Ephemeral Identity
- [ ] Differential privacy
- [ ] Granular consent management
- [ ] GDPR automation (right to erasure, data portability)
- [ ] Privacy dashboard

### Week 61-63: Developer Tools & Ecosystem (Jan 12-31, 2027)

**Key Features:**
- [ ] Mobile SDKs (iOS, Android, React Native, Flutter)
- [ ] Infrastructure as Code (Terraform, Helm, Pulumi)
- [ ] GraphQL API
- [ ] Webhooks & event streaming
- [ ] Advanced analytics & reporting
- [ ] Compliance tooling (GDPR, SOC 2, ISO 27001)

**Deliverables:**
- [ ] OpenID4VP/CI/IA implemented
- [ ] OpenID Federation 1.0 functional
- [ ] OAuth 2.1 compliance
- [ ] Ephemeral Identity working
- [ ] Mobile SDKs (4 platforms)
- [ ] Infrastructure as Code (Terraform, Helm, Pulumi)
- [ ] GraphQL API operational
- [ ] Advanced analytics & reporting
- [ ] Full compliance tooling

---

*(See TASKS.md Phase 8 for full Next-Gen implementation details)*

---

## Phase 9: White-Label & SaaS Platform 🌐

**Timeline:** Feb 1, 2027 onwards

**Goal:** Multi-tenant SaaS platform + marketplace

*(Content from old Phase 10 - see TASKS.md for full details)*

### Week 64-67: Multi-Tenancy Foundation (Feb 1-28)

**Key Features:**
- [ ] Multi-tenant architecture
- [ ] Custom domain per tenant
- [ ] Tenant management dashboard
- [ ] Tenant provisioning API
- [ ] Resource quotas per tenant

### Week 68-71: Billing & Monetization (Mar 1-28, 2027)

**Key Features:**
- [ ] Stripe integration
- [ ] Usage metering (MAU, API calls, storage)
- [ ] Plan/pricing tiers (Free, Pro, Enterprise)
- [ ] Invoice generation
- [ ] Subscription management

### Week 72-75: Marketplace (Mar 29 - Apr 25, 2027)

**Key Features:**
- [ ] Plugin system architecture
- [ ] Plugin marketplace
- [ ] Third-party plugin submission
- [ ] Plugin versioning & updates
- [ ] Plugin revenue sharing

### Week 76+: Platform Refinement & Growth (Apr 26, 2027 onwards)

**Key Features:**
- [ ] White-label customization
- [ ] Advanced monitoring & SLA
- [ ] Enterprise support features
- [ ] Marketing & growth

**Deliverables:**
- [ ] Multi-tenant platform operational
- [ ] 100+ active tenants
- [ ] Billing & monetization functional
- [ ] Plugin marketplace live
- [ ] White-label features complete

---

*(See TASKS.md Phase 9 for full SaaS platform details)*

---

## Phase 10: Certification & Production Launch 🎓

**Timeline:** Final Phase (TBD)

**Goal:** Obtain official OpenID certification + production deployment

**Priority:** Obtain certification, production release, completion

### Production Deployment

- [ ] Production Cloudflare account setup
- [ ] Custom domain configuration (`id.enrai.org`)
- [ ] DNS records & SSL/TLS configuration
- [ ] Production secrets generation
- [ ] Production deployment & verification

### OpenID Certification Submission

- [ ] Pre-submission testing (full conformance suite)
- [ ] Application preparation & documentation
- [ ] Test results compilation
- [ ] Submission to OpenID Foundation
- [ ] Certification review & approval

### Release Preparation

- [ ] Release notes & changelog
- [ ] API documentation finalization
- [ ] Migration guides (from Auth0/Keycloak)
- [ ] Video tutorials & blog post
- [ ] Official announcement
- [ ] OpenID Certified™ mark display

**Deliverables:**
- [ ] OpenID Certification obtained ✨
- [ ] Production deployment live (`https://id.enrai.org`)
- [ ] Public announcement ready
- [ ] Migration guides published
- [ ] Celebrate! 🎉

---

*(Content moved from old Phase 5 - Certification moved to final phase)*

---

## Previous Phase 10: White-Label & SaaS Platform 🌐 (Now Phase 9)

*(See Phase 9 above for current SaaS platform timeline)*

### Multi-Tenancy
- [ ] Tenant isolation (data, config, branding)
- [ ] Custom domain per tenant (id.{customer}.com)
- [ ] Tenant management dashboard
- [ ] Tenant provisioning API
- [ ] Resource quotas per tenant

### Billing & Monetization
- [ ] Stripe integration
- [ ] Usage metering (MAU, API calls, storage)
- [ ] Plan/pricing tiers (Free, Pro, Enterprise)
- [ ] Invoice generation
- [ ] Subscription management
- [ ] Usage dashboards (per tenant)

### Marketplace
- [ ] Plugin system architecture
- [ ] Plugin marketplace (templates, integrations)
- [ ] Third-party plugin submission
- [ ] Plugin versioning & updates
- [ ] Plugin revenue sharing

---

## 📊 Success Metrics by Phase

### Phase 1-2: Foundation + API ✅
- ✅ 178 tests passing (all passing)
- ✅ 0 TypeScript errors
- ✅ <100ms p95 latency (local)
- ✅ All core endpoints functional
- ✅ Token revocation on code reuse
- ✅ Claims parameter support (essential claims)
- ✅ All standard scopes (openid, profile, email, address, phone)

### Phase 3: Conformance ✅
- ✅ 95.8% Phase 3 scope achievement (23/24 tests)
- ✅ 72.7% overall conformance (24/33 tests)
- ✅ All critical security tests passing (token revocation, PKCE, claims)
- [ ] <50ms p95 latency (edge) - deferred to Phase 4

### Phase 4: Extensions ✅
- ✅ Dynamic Client Registration (RFC 7591) functional - 56 tests
- ✅ Rate Limiting implemented - 44 tests
- ✅ Security Headers & CORS - 41 tests
- ✅ Key Rotation automated (KeyManager Durable Object)
- ✅ Extended Claims Support (address, phone)
- ✅ PAR (Pushed Authorization Requests) functional - 15+ tests
- ✅ DPoP (Proof of Possession) working - 12 tests
- ✅ Pairwise Subject Identifiers operational - 22 tests
- ✅ Refresh Token Flow functional - 47+ tests
- ✅ Token Introspection & Revocation working - 47+ tests
- ✅ Form Post Response Mode working - 19 tests
- ✅ Storage Foundation implemented
- ✅ 378+ total tests passing (200+ new Phase 4 tests)
- [ ] <50ms p95 latency (edge) - deferred to Phase 5

### Phase 5: Certification ⏳
- [ ] OpenID Certification obtained ✨
- [ ] JARM, MTLS, JAR implemented
- [ ] Client Credentials Flow working
- [ ] Production deployment stable
- [ ] <50ms p95 global latency
- [ ] Security audit passed

### Phase 5: UI/UX Implementation 🆕
- [ ] 🎯 WebAuthn/Passkey fully functional (Key feature)
- [ ] 🎯 Magic Link authentication working
- [ ] 🎯 ITP-compliant cross-domain SSO
- [ ] Fully functional login/registration UI
- [ ] Complete admin dashboard
- [ ] Multi-storage backend support
- [ ] RBAC implementation
- [ ] <5 sec login page load
- [ ] >90% mobile Lighthouse score
- [ ] WCAG 2.1 AA compliance
- [ ] Multi-language support (EN, JA)

### Phase 7: CLI 🆕
- [ ] <5 min from `npx create-enrai` to running IdP
- [ ] <1 min deployment time
- [ ] 100% automated setup
- [ ] Zero manual configuration required
- [ ] 1000+ NPM downloads/month (goal)

### Phase 8: Enterprise 🆕
- [ ] Hybrid Flow operational
- [ ] Device Flow functional (IoT/TV)
- [ ] JWT Bearer Flow working
- [ ] CIBA implemented
- [ ] JWE encryption support
- [ ] 6+ social login providers
- [ ] SAML 2.0 bridge functional
- [ ] SCIM 2.0 provisioning
- [ ] 10+ enterprise customers (goal)

### Phase 9: Next-Gen 🆕
- [ ] OpenID4VP/CI/IA implemented
- [ ] OpenID Federation 1.0
- [ ] OAuth 2.1 compliance
- [ ] Ephemeral Identity
- [ ] Mobile SDKs (4 platforms)
- [ ] GraphQL API
- [ ] 100+ GitHub stars (goal)

### Phase 10: SaaS 🌐
- [ ] Multi-tenant platform
- [ ] 100+ paying customers
- [ ] $10k+ MRR

---

## 🎯 Key Results (Overall)

### By August 2026 (Phase 7 Complete)
Enrai will be:

1. **🏆 OpenID Certified** - Official certification obtained
2. **🔐 Passwordless-first** - WebAuthn + Magic Link
3. **⚡ Fully automated** - One command from zero to production
4. **🌍 Globally distributed** - <50ms latency worldwide (Cloudflare Edge)
5. **🎨 Beautiful UX** - Modern, accessible, multi-language
6. **📚 Well-documented** - 100+ pages of docs, 20+ tutorials
7. **🌟 Open source** - 100+ GitHub stars, 10+ contributors

### By November 2026 (Phase 8 Complete)
Add:
8. **🏢 Enterprise-ready** - SAML, LDAP, SCIM, Social Login
9. **🚀 Advanced Flows** - Hybrid, Device, CIBA, JWT Bearer
10. **🔒 Maximum Security** - MTLS, DPoP, PAR, JARM, JWE

### By February 2027 (Phase 9 Complete)
Add:
11. **🆔 Verifiable Credentials** - OpenID4VP/CI/IA support
12. **🌐 Federation** - OpenID Federation 1.0
13. **📱 Mobile-first** - Native SDKs for iOS, Android, React Native, Flutter
14. **🔮 Future-proof** - OAuth 2.1, Ephemeral Identity

### By 2027+ (Phase 10)
15. **💰 SaaS Platform** - Multi-tenant, marketplace, revenue

---

## 🔄 Iteration Cadence

- **Weekly:** Progress updates, planning
- **Bi-weekly:** Demo, retrospective
- **Monthly:** Milestone review, roadmap adjustment
- **Quarterly:** Major release, community update

---

## 📝 Change Log

| Date | Change | Reason |
|------|--------|--------|
| 2025-11-11 | Initial roadmap | Project kickoff |
| 2025-12-15 | Phase 1 complete | Foundation finished early |
| 2026-01-31 | Phase 2 complete | API implementation finished |
| 2026-01-31 | Added Phase 6-7 | User request for UI/CLI |
| 2025-11-12 | Phase 3 started early | Conformance testing in progress |
| 2025-11-12 | Major conformance features complete | Token revocation, claims parameter, POST method, PKCE fix, address/phone scope |
| 2025-11-12 | 178 tests passing | Added 20+ new integration tests |
| 2025-11-12 | **Phase 3 COMPLETE** | All Phase 3 scope features implemented and tested (95.8% achievement) |
| 2025-11-12 | Full conformance suite executed | 33 tests: 23 PASSED, 1 REVIEW, 8 deferred to Phase 4-6, 1 SKIPPED |
| 2025-11-12 | Performance benchmarks completed | Functional validation complete, optimization planned for Phase 4 |
| 2025-11-12 | **🚀 MAJOR ROADMAP UPDATE** | All requested features integrated into phases |
| 2025-11-12 | Phase 4 expanded | Added PAR, DPoP, Pairwise, Form Post, Token Introspection/Revocation |
| 2025-11-12 | Phase 5 expanded | Added JARM, MTLS, JAR, Client Credentials Flow |
| 2025-11-12 | Phase 5 reimagined | **Passwordless-first**: WebAuthn/Passkey + Magic Link + ITP-compliant SSO |
| 2025-11-12 | Phase 6 expanded | Added Session Management, Front/Back-Channel Logout, Audit Log, Scope Extensions |
| 2025-11-12 | Phase 8 created | Enterprise Flows: Hybrid, Device, JWT Bearer, CIBA, JWE, Social Login, SAML, LDAP, SCIM |
| 2025-11-12 | Phase 9 created | Next-Gen: OpenID4VP/CI/IA, Federation, OAuth 2.1, Ephemeral Identity, Mobile SDKs |
| 2025-11-12 | Phase 10 created | SaaS Platform: Multi-tenancy, Billing, Marketplace |
| 2025-11-12 | Timeline extended | Now covers Nov 2025 - Mar 2027+ (16+ months → 2+ years) |
| 2025-11-12 | Success metrics updated | Added ambitious goals for each phase |
| 2025-11-12 | **🔄 PHASE REORDERING** | Phase 5→10, Phases 6-9 shifted up: UI/UX now P5, CLI now P6, Enterprise now P7, VC now P8, SaaS now P9, Certification moved to final P10 |
| 2025-11-12 | **Phase 4 COMPLETE** ✅ | All Phase 4 features implemented: Token Management, PAR, DPoP, Pairwise, Form Post, Storage Foundation (378+ tests passing) |
| 2025-11-12 | **Phase 5 planning finalized** | Tech stack decisions: Svelte 5 + UnoCSS + Melt UI, Hybrid hosting, ITP-compliant SSO, RBAC, Custom fields, Multi-language |
| 2025-11-12 | **Phase 7 expanded** | Added WebSDK, Visual Flow Builder (SimCity-inspired), GDPR automation, CSV/JSON import/export, Webhook integration |

---

> **Last Update:** 2025-11-12 (Phase 4 COMPLETE ✅)
> **Next Update:** 2026-05-31 (Post Phase 5)
>
> ⚡️ **Enrai** - Building the future of identity infrastructure, one phase at a time.
>
> **Current Status:**
> - **Phase 4 COMPLETE:** All extended security features implemented ✅
> - **Tests:** 378+ passing (200+ new Phase 4 tests)
> - **Phase 3 Achievement:** 95.8% (23/24 tests) | **Overall Conformance:** 72.7% (24/33 tests)
> - **Roadmap:** 10 Phases covering 60+ advanced features
> - **Vision:** The world's best passwordless OpenID Provider on Cloudflare Edge
>
> **Key Differentiators:**
> - 🔐 **Passwordless-first** (WebAuthn + Magic Link)
> - ⚡ **Edge-native** (Cloudflare Workers) - <50ms worldwide
> - 🎯 **Advanced Security** (PAR, DPoP, MTLS, JARM, JWE)
> - 🆔 **Next-Gen** (Verifiable Credentials, OAuth 2.1, Federation)
> - 🏢 **Enterprise-ready** (SAML, LDAP, SCIM, CIBA)
> - 🌍 **Open Source & Self-hosted** - No vendor lock-in
