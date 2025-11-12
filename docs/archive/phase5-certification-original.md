# Archive: Original Phase 5 - Certification Preparation

**Original Timeline:** May 1-31, 2026 (4 weeks)

**Status:** Content moved to Phase 10 (Final Phase) on 2025-11-12

**Reason:** Certification and production deployment moved to final phase after all features (UI, CLI, Enterprise, etc.) are complete for a more complete product certification.

---

## Phase 5: Certification & Enterprise Security ⏳

**Timeline:** May 1-31, 2026 (4 weeks)

**Goal:** Obtain official OpenID certification + enterprise-grade security

**Priority:** 認証取得に有利、エンタープライズで高評価

### Week 26: Advanced Security Protocols

#### JARM (JWT Secured Authorization Response Mode) - JARM Spec
- [ ] `response_mode=jwt` support
- [ ] `response_mode=query.jwt` support
- [ ] `response_mode=fragment.jwt` support
- [ ] `response_mode=form_post.jwt` support
- [ ] Authorization response JWT signing
- [ ] Tests & conformance validation
- **Why:** OpenID認証で高評価、レスポンス改ざん防止

#### MTLS (Mutual TLS Client Authentication) - RFC 8705
- [ ] MTLS client certificate validation
- [ ] Certificate-bound access tokens
- [ ] `tls_client_auth` method support
- [ ] `self_signed_tls_client_auth` support
- [ ] Certificate thumbprint validation
- [ ] Tests & conformance validation
- **Why:** エンタープライズ必須、最高レベルのセキュリティ、金融業界標準

#### JAR (JWT-Secured Authorization Request) - RFC 9101
- [ ] `request` parameter support (JWT)
- [ ] `request_uri` parameter support
- [ ] Request object validation
- [ ] Request object encryption (JWE)
- [ ] Tests & conformance validation
- **Why:** セキュリティ強化、リクエスト改ざん防止、OpenID認証で必須

### Week 27: Client Credentials & Production Deployment

#### Client Credentials Flow - RFC 6749 Section 4.4
- [ ] `grant_type=client_credentials` support
- [ ] Client authentication (client_secret_basic)
- [ ] Client authentication (client_secret_post)
- [ ] Client authentication (private_key_jwt)
- [ ] Machine-to-machine token issuance
- [ ] Scope-based access control
- [ ] Tests & conformance validation
- **Why:** 基本フロー、サーバー間認証で必須、メジャーな実装

#### Production Deployment
- [ ] Production Cloudflare account setup
- [ ] Custom domain configuration (`id.hibana.dev`)
- [ ] DNS records setup
- [ ] SSL/TLS configuration (with MTLS support)
- [ ] Production secrets generation
- [ ] Production deployment
- [ ] External client testing
- [ ] Load testing & performance validation

### Week 28: Certification Submission

#### Pre-Submission Testing
- [ ] Full conformance suite run (all tests)
- [ ] PAR, DPoP, JARM, MTLS validation
- [ ] Security audit (external)
- [ ] Performance benchmarks
- [ ] Documentation review

#### Submission Process
- [ ] Application preparation
- [ ] Architecture documentation
- [ ] Test results compilation (all phases)
- [ ] Feature list documentation
- [ ] Security assessment report
- [ ] Submission to OpenID Foundation
- [ ] Access provision for testing

### Week 29: Final Preparation & Release

#### Certification Review
- [ ] Certification review feedback
- [ ] Final adjustments (if needed)
- [ ] Re-testing (if needed)
- [ ] Certification approval

#### Release Preparation
- [ ] Release notes preparation
- [ ] API documentation finalization
- [ ] Migration guide (from Auth0/Keycloak)
- [ ] Video tutorials
- [ ] Blog post & announcement
- [ ] Press kit preparation

**Deliverables:**
- [ ] JARM (JWT Secured Authorization Response) functional
- [ ] MTLS (Mutual TLS) implemented
- [ ] JAR (JWT-Secured Authorization Request) operational
- [ ] Client Credentials Flow working
- [ ] Production deployment live
- [ ] OpenID Certification obtained ✨
- [ ] Public announcement ready
- [ ] Migration guides published

---

## New Location

This content has been moved to **Phase 10: Certification & Production Launch** (Final Phase, TBD).

See:
- `docs/project-management/TASKS.md` - Phase 10
- `docs/ROADMAP.md` - Phase 10
- `docs/project-management/SCHEDULE.md` - Phase 10

---

## Advanced Security Features Status

These features may be implemented in earlier phases or deferred:

### JARM (JWT Secured Authorization Response Mode)
- **Status:** Deferred to Phase 10 or earlier if needed
- **RFC:** JARM Specification
- **Priority:** High for certification

### MTLS (Mutual TLS Client Authentication)
- **Status:** Deferred to Phase 10 or earlier if needed
- **RFC:** RFC 8705
- **Priority:** High for enterprise/financial

### JAR (JWT-Secured Authorization Request)
- **Status:** May be implemented in Phase 4 as part of Request Object support
- **RFC:** RFC 9101
- **Priority:** High for certification

### Client Credentials Flow
- **Status:** May be implemented in Phase 4 or Phase 7 (Enterprise)
- **RFC:** RFC 6749 Section 4.4
- **Priority:** Medium (common enterprise use case)

---

**Archive Date:** 2025-11-12

**Archive Reason:** Phase reordering - Certification moved to final phase (Phase 10)
