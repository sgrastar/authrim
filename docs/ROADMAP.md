# Authrim Product Roadmap

**Vision:** One-command identity infrastructure for the modern web

**Timeline:** November 2025 - 2027+

---

## Timeline Overview

```
2025                 2026                                    2027
Nov  Dec  Jan  Feb  Mar  Apr  May  Jun  Jul  Aug  Sep  Oct  Nov  Dec  Jan  Feb+
│    │    │    │    │    │    │    │    │    │    │    │    │    │    │    │
├─P1─┼─P2─┼─P3─┼────┼─P4─┼─P5─┼─────────────P6──────────────┼──P7───────┼─P8+
│    │    │    │    │    │    │    │    │    │    │    │    │    │    │    │
✅   ✅   ✅   ✅   ✅   ✅   ⏳   ⏳   ⏳   ⏳   ⏳   ⏳   🔜   🔜   🔜   🔜

Legend:
✅ Complete (Phases 1-5)
⏳ In Progress (Phase 6: 8/11 features complete)
🔜 Planned (Phases 7-10)
```

---

## Milestones

| Milestone | Date | Status | Description |
|-----------|------|--------|-------------|
| **M1: Foundation** | 2025-12-15 | ✅ Complete | Project setup, tooling, basic structure |
| **M2: Core API** | 2026-01-31 | ✅ Complete | All OIDC endpoints functional |
| **M3: Conformance** | 2025-11-12 | ✅ Complete | Basic OP 78.95%, Config OP 100%, Form Post 84.21% |
| **M4: Extensions** | 2025-11-12 | ✅ Complete | PAR, DPoP, Pairwise, Token Management |
| **M5: UI/UX** | 2025-11-18 | ✅ Complete | SvelteKit Frontend, Admin Dashboard, 15+ pages |
| **M6: Enterprise** | 2026-10 | ⏳ 8/11 | Device Flow, CIBA, SCIM, JWE, Hybrid, JAR, JARM, JWT Bearer |
| **M7: CLI** | 2027-Q1 | 🔜 Planned | create-authrim package, automation |
| **M8: Next-Gen** | 2027-Q2 | 🔜 Planned | Verifiable Credentials, OAuth 2.1, Federation |
| **M9: SaaS** | 2027+ | 🔜 Planned | Multi-tenant platform, Billing, Marketplace |
| **M10: Launch** | TBD | 🔜 Final | OpenID Certification, Production Launch |

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

## Phase 6: Enterprise Features ⏳ IN PROGRESS (8/11 Complete)

**Timeline:** Jun 1 - Oct 31, 2026

**Goal:** Enterprise-grade authentication flows and integrations

### Completed Features (Nov 2025)

| Feature | RFC/Spec | Status | Date |
|---------|----------|--------|------|
| Device Flow | RFC 8628 | ✅ Complete | Nov 21, 2025 |
| JWT Bearer Flow | RFC 7523 | ✅ Complete | Nov 21, 2025 |
| JWE | RFC 7516 | ✅ Complete | Nov 21, 2025 |
| Hybrid Flow | OIDC Core 3.3 | ✅ Complete | Nov 25, 2025 |
| CIBA | OpenID Connect | ✅ Complete | Nov 25, 2025 |
| SCIM 2.0 | RFC 7643/7644 | ✅ Complete | Nov 25, 2025 |
| JAR | RFC 9101 | ✅ Complete | Nov 25, 2025 |
| JARM | OIDC JARM | ✅ Complete | Nov 25, 2025 |

### Remaining Features (3/11)

| Feature | Description | Status |
|---------|-------------|--------|
| Social Login | Google, GitHub, Microsoft, Apple, Facebook, Twitter, LinkedIn | 🔜 Planned |
| SAML 2.0 Bridge | OIDC ↔ SAML 2.0 conversion | 🔜 Planned |
| LDAP/AD Integration | Enterprise directory integration | 🔜 Planned |

### Optional/Deferred

| Feature | Description | Status |
|---------|-------------|--------|
| Visual Flow Builder | SimCity-inspired drag & drop UI | Deferred |
| WebSDK | High-customization web components | Deferred |

---

## Phase 7: CLI & Automation 🔜 PLANNED

**Timeline:** 2027-Q1

**Goal:** One-command deployment experience

### Key Features

- [ ] `create-authrim` NPM package
- [ ] Interactive setup wizard
- [ ] Project scaffolding
- [ ] Cloudflare API integration (Worker, KV, D1, DO deployment)
- [ ] Management CLI (20+ commands)
- [ ] Integration examples (Next.js, React, Vue, Svelte)

---

## Phase 8: Verifiable Credentials & Next-Gen 🔜 PLANNED

**Timeline:** 2027-Q2

**Goal:** Decentralized identity and next-generation protocols

### Key Features

- [ ] OpenID4VP (Verifiable Presentations)
- [ ] OpenID4CI (Credential Issuance)
- [ ] OpenID4IA (Identity Assurance)
- [ ] OpenID Federation 1.0
- [ ] OAuth 2.1 compliance
- [ ] Mobile SDKs (iOS, Android, React Native, Flutter)
- [ ] Infrastructure as Code (Terraform, Helm, Pulumi)
- [ ] GraphQL API

---

## Phase 9: White-Label & SaaS Platform 🔜 PLANNED

**Timeline:** 2027+

**Goal:** Multi-tenant SaaS platform and marketplace

### Key Features

- [ ] Multi-tenant architecture
- [ ] Custom domain per tenant
- [ ] Stripe billing integration
- [ ] Usage metering (MAU, API calls)
- [ ] Plugin marketplace
- [ ] White-label customization

---

## Phase 10: Certification & Production Launch 🔜 FINAL

**Timeline:** TBD

**Goal:** Official OpenID Certification and production deployment

### Key Stages

1. Pre-submission testing (full conformance suite)
2. OpenID Foundation certification submission
3. Production deployment (`https://id.authrim.org`)
4. Public announcement
5. Migration guides (from Auth0, Keycloak)

---

## Success Metrics

### Phase 1-5 (Complete)

| Metric | Target | Actual |
|--------|--------|--------|
| Unit tests | 200+ | 60 files, ~25,270 lines |
| Conformance (Basic OP) | 85% | 78.95% ✅ |
| Conformance (Config OP) | 85% | 100% ✅ |
| UI pages | 10+ | 15+ ✅ |
| Durable Objects | 10+ | 14 ✅ |

### Phase 6 (In Progress)

| Metric | Target | Actual |
|--------|--------|--------|
| Enterprise features | 11 | 8/11 (73%) |
| Device Flow tests | 50+ | 70+ ✅ |
| CIBA modes | 3 | 3 (poll, ping, push) ✅ |
| SCIM endpoints | 4 | 4 (Users + Groups CRUD) ✅ |

### Phase 7-10 (Planned)

| Metric | Target |
|--------|--------|
| CLI commands | 20+ |
| Deployment time | < 5 min |
| Social login providers | 7+ |
| Mobile SDKs | 4 platforms |
| OpenID Certification | ✅ Obtained |

---

## Key Results (Overall)

By 2027, Authrim will be:

1. **OpenID Certified** - Official certification obtained
2. **Passwordless-first** - WebAuthn + Magic Link
3. **Fully automated** - One command from zero to production
4. **Globally distributed** - <50ms latency worldwide
5. **Enterprise-ready** - SAML, LDAP, SCIM, Social Login
6. **Advanced Flows** - Hybrid, Device, CIBA, JWT Bearer
7. **Maximum Security** - DPoP, PAR, JAR, JARM, JWE
8. **Verifiable Credentials** - OpenID4VP/CI/IA support
9. **Open Source** - Apache 2.0, self-hosted

---

## Change Log

| Date | Change |
|------|--------|
| 2025-11-11 | Initial roadmap |
| 2025-11-12 | Phase 3 & 4 completed early |
| 2025-11-18 | Phase 5 completed |
| 2025-11-25 | Phase 6: 8/11 features complete (Device Flow, JWT Bearer, JWE, Hybrid, CIBA, SCIM, JAR, JARM) |
| 2025-11-29 | Documentation restructure, Phase numbering clarification |

---

> **Last Update:** 2025-11-29
>
> **Current Status:** Phase 6 (8/11 Enterprise Features Complete)
>
> **Authrim** - Building the future of identity infrastructure, one phase at a time.
