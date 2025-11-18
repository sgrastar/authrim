# Enrai Project Schedule

## Project Overview
**Enrai** - A lightweight OpenID Connect Provider built on Cloudflare Workers
**Start Date**: November 10, 2025
**Goal**: Obtain OpenID Certified™ Basic OP Profile certification
**Tech Stack**: Cloudflare Workers, Hono, Durable Objects, KV Storage, JOSE

**Related Documents:**
- [Task Breakdown](./TASKS.md) - Detailed task list (440+ items)
- [Kickoff Checklist](./KICKOFF.md) - Week 1 setup guide
- [GitHub Workflow](./GITHUB_WORKFLOW.md) - Issue tracking guide
- [Technical Specifications](../architecture/technical-specs.md) - System architecture
- [Conformance Overview](../conformance/overview.md) - Certification strategy

---

## Overall Timeline (Extended Plan)

```
Phase 1: Foundation                    [Nov 10 - Dec 15, 2025]     (5 weeks)
Phase 2: Core Implementation           [Dec 16 - Jan 31, 2026]     (6 weeks)
Phase 3: Testing & Validation          [Feb 1 - Mar 15, 2026]      (6 weeks)
Phase 4: Extended Features             [Mar 16 - Apr 30, 2026]     (6 weeks)
Phase 5: UI/UX Implementation          [May 1 - May 31, 2026]      (4 weeks)
Phase 6: CLI & Automation              [Jun 12 - Aug 10, 2026]     (9 weeks)
Phase 7: Enterprise Features           [Aug 11 - Oct 31, 2026]     (11 weeks)
Phase 8: Verifiable Credentials        [Nov 3, 2026 - Jan 31, 2027] (13 weeks)
Phase 9: White-Label & SaaS            [Feb 1, 2027 onwards]       (ongoing)
Phase 10: Certification & Production   [Final Phase]               (4 weeks)
```

---

## Milestone Details

### 🏁 Milestone 1: Foundation Complete
**Due Date**: December 15, 2025
**Objective**: Establish development environment and project structure

**Deliverables**:
- ✅ Project structure design
- ✅ TypeScript configuration complete
- ✅ Cloudflare Workers environment setup
- ✅ Hono framework integration
- ✅ Basic CI/CD configuration
- ✅ Development documentation

**Completion Criteria**:
- `wrangler dev` launches local development server
- Basic routing is functional
- TypeScript builds successfully

---

### 🏁 Milestone 2: OIDC Core Implementation Complete
**Due Date**: January 31, 2026
**Objective**: Implement OpenID Connect Core functionality

**Deliverables**:
- ✅ `/.well-known/openid-configuration` endpoint
- ✅ `/.well-known/jwks.json` endpoint
- ✅ `/authorize` endpoint (Authorization Code Flow)
- ✅ `/token` endpoint (ID Token + Access Token issuance)
- ✅ `/userinfo` endpoint
- ✅ JWT signing functionality (RS256)
- ✅ Cloudflare KV-based state/nonce/code management
- ✅ Error handling implementation

**Completion Criteria**:
- Manual Authorization Code Flow works end-to-end
- ID Tokens are properly signed and verifiable
- All endpoints return spec-compliant responses

---

### 🏁 Milestone 3: OpenID Conformance Suite Passing ✅ COMPLETE
**Due Date**: March 15, 2026 | **Actual**: Nov 12, 2025 (Early!)
**Objective**: Pass OpenID Foundation Conformance Suite tests

**Deliverables**:
- ✅ Conformance Suite environment setup (Docker)
- ✅ Basic OP Profile tests passing (23/24 Phase 3 tests)
- ✅ Discovery 1.0 tests passing
- ✅ JWT/JWK tests passing
- ✅ OAuth 2.0 tests passing
- ✅ Bug fixes and refactoring
- ✅ Test results report

**Completion Criteria**:
- ✅ Phase 3 Conformance: 95.8% (23/24 tests)
- ✅ Overall Conformance: 72.7% (24/33 tests)
- ✅ All critical issues resolved

---

### 🏁 Milestone 4: Extended Features Implementation ✅ COMPLETE
**Due Date**: April 30, 2026 | **Actual**: Nov 12, 2025 (Early!)
**Objective**: Implement additional specifications and enhancements

**Deliverables**:
- ✅ `/register` endpoint (Dynamic Client Registration - RFC 7591)
- ✅ JWKS key rotation capability (KeyManager Durable Object)
- ✅ Extended claim support (email, profile, address, phone)
- ✅ Mandatory nonce verification
- ✅ Token Management (Refresh tokens, introspection, revocation)
- ✅ PAR (Pushed Authorization Requests - RFC 9126)
- ✅ DPoP (Demonstrating Proof of Possession - RFC 9449)
- ✅ Pairwise Subject Identifiers (OIDC Core 8.1)
- ✅ Form Post Response Mode
- ✅ Storage Foundation (abstract interfaces)
- ✅ Performance optimization
- ✅ Security audit conducted

**Completion Criteria**:
- ✅ All Phase 4 features implemented
- ✅ 378+ tests passing (200+ new Phase 4 tests)
- ✅ Comprehensive documentation

---

### 🏁 Milestone 5: UI/UX Implementation Complete ✅ COMPLETE
**Due Date**: May 31, 2026 | **Actual**: Nov 18, 2025 (Early!)
**Objective**: Complete user interface and experience implementation

**Deliverables**:
- ✅ Login/Registration screens implemented (Passwordless-first)
- ✅ OAuth consent screen functional
- ✅ Admin dashboard created (7 pages)
- ✅ User management UI complete
- ✅ Client management UI complete
- ✅ Data storage abstraction layer ready (CloudflareAdapter)
- ✅ WebAuthn/Passkey API implemented
- ✅ Magic Link authentication working
- ✅ Multi-language support (EN/JA with Paraglide)
- ✅ E2E testing (Playwright - 19 tests)
- ✅ Accessibility testing (axe-core - WCAG 2.1 AA)
- ✅ Performance testing (Lighthouse CI - Score: 100)

**Completion Criteria**:
- ✅ All authentication UI flows functional (6 pages)
- ✅ Admin dashboard operational (7 pages)
- ✅ Mobile-responsive design verified
- ✅ WCAG 2.1 AA compliance achieved (zero violations)
- ✅ 400+ tests passing (unit + E2E + accessibility + performance)

---

## Phase-by-Phase Detailed Plan

### Phase 1: Foundation (Nov 10 - Dec 15, 2025)

| Week | Tasks | Owner | Status |
|:-----|:------|:------|:-------|
| Week 1 (11/10-11/16) | Project structure design, environment setup, TypeScript/Wrangler config | Dev | 🔄 In Progress |
| Week 2 (11/17-11/23) | Hono framework integration, basic routing implementation | Dev | ⏳ Pending |
| Week 3 (11/24-11/30) | Cloudflare KV/Durable Objects integration, JOSE library verification | Dev | ⏳ Pending |
| Week 4 (12/1-12/7) | Auth key generation & management, test framework setup | Dev | ⏳ Pending |
| Week 5 (12/8-12/15) | CI/CD configuration, documentation, M1 review | Dev | ⏳ Pending |

---

### Phase 2: Core Implementation (Dec 16, 2025 - Jan 31, 2026)

| Week | Tasks | Owner | Status |
|:-----|:------|:------|:-------|
| Week 6 (12/16-12/22) | Discovery/JWKS endpoint implementation | Dev | ⏳ Pending |
| Week 7 (12/23-12/29) | `/authorize` endpoint implementation, state/nonce management | Dev | ⏳ Pending |
| Week 8 (12/30-1/5) | `/token` endpoint implementation, JWT signing functionality | Dev | ⏳ Pending |
| Week 9 (1/6-1/12) | `/userinfo` endpoint implementation, access token validation | Dev | ⏳ Pending |
| Week 10 (1/13-1/19) | Error handling, validation hardening | Dev | ⏳ Pending |
| Week 11 (1/20-1/26) | Integration test creation, bug fixes | Dev | ⏳ Pending |
| Week 12 (1/27-1/31) | Code review, refactoring, M2 review | Dev | ⏳ Pending |

---

### Phase 3: Testing & Validation (Feb 1 - Mar 15, 2026)

| Week | Tasks | Owner | Status |
|:-----|:------|:------|:-------|
| Week 13 (2/1-2/7) | Conformance Suite environment setup, initial test run | Dev | ⏳ Pending |
| Week 14 (2/8-2/14) | Discovery/Core spec test compliance | Dev | ⏳ Pending |
| Week 15 (2/15-2/21) | JWT/JWK signature verification test compliance | Dev | ⏳ Pending |
| Week 16 (2/22-2/28) | OAuth 2.0 flow test compliance | Dev | ⏳ Pending |
| Week 17 (3/1-3/7) | Negative test case compliance, edge case fixes | Dev | ⏳ Pending |
| Week 18 (3/8-3/15) | Final validation, test report creation, M3 review | Dev | ⏳ Pending |

---

### Phase 4: Extended Features (Mar 16 - Apr 30, 2026)

| Week | Tasks | Owner | Status |
|:-----|:------|:------|:-------|
| Week 19 (3/16-3/22) | Dynamic Client Registration design & implementation | Dev | ⏳ Pending |
| Week 20 (3/23-3/29) | Key rotation implementation via Durable Objects | Dev | ⏳ Pending |
| Week 21 (3/30-4/5) | Extended claims support, mandatory nonce verification | Dev | ⏳ Pending |
| Week 22 (4/6-4/12) | Security audit, vulnerability assessment | Dev | ⏳ Pending |
| Week 23 (4/13-4/19) | Performance testing, optimization | Dev | ⏳ Pending |
| Week 24 (4/20-4/26) | Additional feature testing, bug fixes | Dev | ⏳ Pending |
| Week 25 (4/27-4/30) | M4 review, documentation updates | Dev | ⏳ Pending |

---

### Phase 5: UI/UX Implementation (May 1 - May 31, 2026)

| Week | Tasks | Owner | Status |
|:-----|:------|:------|:-------|
| Week 26 (5/1-5/7) | Login screen, user registration, consent screen implementation | Dev | ⏳ Pending |
| Week 27 (5/8-5/14) | Session management UI, frontend stack setup | Dev | ⏳ Pending |
| Week 28 (5/15-5/21) | Admin dashboard overview, user management UI | Dev | ⏳ Pending |
| Week 29 (5/22-5/28) | Client management, settings & customization UI | Dev | ⏳ Pending |
| Week 30 (5/29-5/31) | Data storage abstraction layer, M5 review | Dev | ⏳ Pending |

---

### Phase 6: CLI & Automation (Jun 12 - Aug 10, 2026)

| Week | Tasks | Owner | Status |
|:-----|:------|:------|:-------|
| Week 32 (6/12-6/18) | CLI tool development, create-enrai package setup | Dev | ⏳ Pending |
| Week 33 (6/19-6/25) | Project scaffolding, interactive setup wizard | Dev | ⏳ Pending |
| Week 34 (6/26-7/2) | Cloudflare API integration, Worker deployment API | Dev | ⏳ Pending |
| Week 35 (7/3-7/9) | KV/D1/DO management, DNS & custom domain setup | Dev | ⏳ Pending |
| Week 36 (7/10-7/16) | Setup automation wizard, health checks | Dev | ⏳ Pending |
| Week 37 (7/17-7/23) | Integration examples, environment management | Dev | ⏳ Pending |
| Week 38 (7/24-7/30) | Production readiness, error handling | Dev | ⏳ Pending |
| Week 39 (7/31-8/10) | Performance optimization, security hardening, NPM publishing | Dev | ⏳ Pending |

---

### Phase 10: Certification & Production Launch (Final Phase)

| Week | Tasks | Owner | Status |
|:-----|:------|:------|:-------|
| Week N (TBD) | Production environment setup, domain configuration | Dev | ⏳ Pending |
| Week N+1 (TBD) | Production deployment, final verification | Dev | ⏳ Pending |
| Week N+2 (TBD) | Certification application preparation, OpenID Foundation submission | Dev | ⏳ Pending |
| Week N+3 (TBD) | Certification approval waiting, release preparation, official launch | Dev | ⏳ Pending |

---

## Key Dates

| Date | Event | Status |
|:-----|:------|:-------|
| 2025-11-10 | Project Kickoff | ✅ Complete |
| 2025-12-15 | M1: Foundation Complete | ✅ Complete |
| 2026-01-31 | M2: Core Features Complete | ✅ Complete |
| 2025-11-12 | M3: Conformance Suite Passed (Early!) | ✅ Complete |
| 2025-11-12 | M4: Extended Features Complete (Early!) | ✅ Complete |
| 2025-11-18 | M5: UI/UX Implementation Complete (Early!) | ✅ Complete |
| 2026-08-10 | M6: CLI & Automation Complete | 🆕 Planned |
| 2026-10-31 | M7: Enterprise Features Complete | 🆕 Planned |
| 2027-01-31 | M8: Verifiable Credentials Complete | 🆕 Planned |
| TBD | M10: OpenID Certification Obtained & Production Launch | 🎓 Final |

---

## Risks and Mitigation

| Risk | Impact | Mitigation |
|:-----|:-------|:-----------|
| Conformance Suite test failures | High | Start testing early, ensure adequate buffer time |
| Cloudflare limitations/constraints | Medium | Pre-research, prepare alternative designs |
| JWK signature compatibility issues | Medium | Use JOSE standard library, cross-check implementations |
| Security vulnerability discovered | High | Continuous security auditing, rapid remediation |
| Schedule delays | Medium | Weekly progress reviews, priority management |

---

## Success Criteria

### Technical Criteria (Phase 1-5)
- ✅ OpenID Conformance Suite: 95.8% Phase 3, 72.7% overall
- ✅ All core endpoints functioning per specifications
- ✅ JWT signature verification working with other RPs
- ✅ No critical issues in security audit
- ✅ Stable operation in edge environment
- ✅ 400+ tests passing (unit + E2E + accessibility + performance)
- ✅ WCAG 2.1 AA compliance (zero violations)
- ✅ Lighthouse Performance score: 100 (LCP: 0.11s)

### Project Criteria
- ⏳ OpenID Certified™ Basic OP Profile certification (pending Phase 10)
- ✅ Milestones 1-5 achieved ahead of schedule
- ✅ Documentation completeness 100% (Phase 1-5)
- ✅ Ready for CLI development (Phase 6)

---

## Next Actions

### Current Phase (Phase 6: CLI & Automation)

**Planned Start:** Jun 12, 2026 | **Target End:** Aug 10, 2026

**Key Objectives:**
1. Design and implement `create-enrai` NPM package
2. Interactive setup wizard for Cloudflare deployment
3. One-command deployment automation
4. Management CLI for users, clients, and keys
5. Integration examples (Next.js, React, Vue, Angular, Svelte)

### Completed Phases
- ✅ Phase 1: Foundation (Nov 10 - Dec 15, 2025)
- ✅ Phase 2: Core API (Dec 16, 2025 - Jan 31, 2026)
- ✅ Phase 3: Testing & Validation (Feb 1 - Nov 12, 2025 - Early!)
- ✅ Phase 4: Extended Features (Mar 16 - Nov 12, 2025 - Early!)
- ✅ Phase 5: UI/UX Implementation (May 1 - Nov 18, 2025 - Early!)

---

> **Enrai** 🔥 — Proving that even a solo developer can operate a globally distributed identity provider.
