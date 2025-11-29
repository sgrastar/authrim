# Authrim Documentation

Complete documentation for the Authrim OpenID Connect Provider project.

> **Quick Navigation**: Use the search function (Ctrl+F / Cmd+F) or jump to:
> [Getting Started](#-getting-started) | [Architecture](#️-architecture) | [Features](#-features) | [API](#-api-documentation) | [Operations](#-operations)

---

## 🚀 Getting Started

Essential guides for development and deployment.

| Document | Description |
|:---------|:------------|
| [Development Guide](./DEVELOPMENT.md) | Development environment setup and workflow |
| [Deployment Guide](./DEPLOYMENT.md) | Deploying to Cloudflare Workers |
| [Testing Guide](./TESTING.md) | Testing strategy and test execution |

---

## 📋 Project Management

Documents for planning, scheduling, and tracking project progress.

| Document | Description |
|:---------|:------------|
| [Vision](./VISION.md) | Long-term vision and strategic goals |
| [Roadmap](./ROADMAP.md) | Product roadmap (Phase 6: 8/11 complete) |
| [Project Schedule](./project-management/SCHEDULE.md) | Timeline with major milestones |
| [Task Breakdown](./project-management/TASKS.md) | Task checklist by phase |
| [API Inventory](./project-management/API_INVENTORY.md) | Complete API endpoint status |
| [Kickoff Checklist](./project-management/KICKOFF.md) | Week 1 immediate action items |
| [GitHub Workflow](./project-management/GITHUB_WORKFLOW.md) | Issue tracking and project board setup |

---

## 🏗️ Architecture

Technical specifications and system design documentation.

| Document | Description |
|:---------|:------------|
| [Technical Specs](./architecture/technical-specs.md) | System architecture and endpoint specifications |
| [Protocol Flow](./architecture/protocol-flow.md) | End-to-end OIDC Authorization Code Flow |
| [Workers Architecture](./architecture/workers.md) | Cloudflare Workers monorepo and worker split design |
| [Architecture Patterns](./architecture/patterns.md) | Deployment architecture patterns (A/B/C/D) |
| [Router Setup](./architecture/router-setup.md) | Router Worker configuration guide |
| [Durable Objects](./architecture/durable-objects.md) | Durable Objects design and usage |
| [Database Schema](./architecture/database-schema.md) | D1 database schema documentation |
| [Storage Strategy](./architecture/storage-strategy.md) | KV, D1, DO storage selection guide |
| [Storage Consistency Design](./architecture/storage-consistency-design.md) | Consistency guarantees and design |
| [Storage Implementation](./architecture/storage-consistency-implementation.md) | Implementation record of storage design |

---

## ⚡ Features

Documentation for OIDC features and extensions.

### Core Features
| Document | Description |
|:---------|:------------|
| [PKCE](./features/pkce.md) | Proof Key for Code Exchange |
| [Hybrid Flow](./features/hybrid-flow.md) | OAuth 2.0 Hybrid Flow implementation |
| [Token Management](./features/token-management.md) | Token lifecycle and rotation |

### Advanced Features
| Document | Description |
|:---------|:------------|
| [PAR](./features/par.md) | Pushed Authorization Requests (RFC 9126) |
| [DPoP](./features/dpop.md) | Demonstrating Proof of Possession |
| [JAR/JARM](./features/jar-jarm.md) | JWT Secured Authorization Request/Response Mode |
| [Device Flow](./features/device-flow.md) | OAuth 2.0 Device Authorization Grant |
| [Dynamic Client Registration](./features/dynamic-client-registration.md) | OpenID Connect DCR |
| [Form Post Response Mode](./features/form-post-response-mode.md) | OAuth 2.0 Form Post Response Mode |
| [Pairwise Subject Identifiers](./features/pairwise-subject-identifiers.md) | Privacy-preserving subject identifiers |

### Enterprise Features
| Document | Description |
|:---------|:------------|
| [CIBA](./features/ciba.md) | Client Initiated Backchannel Authentication |
| [SCIM](./features/scim.md) | System for Cross-domain Identity Management |
| [SCIM Implementation](./features/scim-implementation.md) | SCIM implementation summary |

### Relying Party Support
| Document | Description |
|:---------|:------------|
| [RP Quick Reference](./features/rp-quick-reference.md) | Quick reference for Relying Parties |
| [RP Support Analysis](./features/rp-support-analysis.md) | Detailed RP compatibility analysis |

---

## 📡 API Documentation

API endpoint documentation and conventions.

| Document | Description |
|:---------|:------------|
| [API Overview](./api/README.md) | API documentation index |
| [API List](./api/list.md) | Complete API endpoint inventory |
| [Naming Conventions](./api/naming-conventions.md) | API design and naming standards |

### Admin API
| Document | Description |
|:---------|:------------|
| [Users API](./api/admin/users.md) | User management endpoints |
| [Clients API](./api/admin/clients.md) | OAuth client management |
| [Sessions API](./api/admin/sessions.md) | Session management endpoints |
| [Statistics API](./api/admin/statistics.md) | Analytics and statistics |
| [Avatars API](./api/admin/avatars.md) | User avatar management |

### Auth API
| Document | Description |
|:---------|:------------|
| [Passkey API](./api/auth/passkey.md) | WebAuthn/Passkey authentication |
| [Magic Link API](./api/auth/magic-link.md) | Passwordless email authentication |
| [Consent API](./api/auth/consent.md) | User consent handling |
| [Logout API](./api/auth/logout.md) | Session logout endpoints |
| [Session Management](./api/auth/session-management.md) | Active session management |

### Durable Objects API
| Document | Description |
|:---------|:------------|
| [SessionStore](./api/durable-objects/SessionStore.md) | User session Durable Object |
| [AuthorizationCodeStore](./api/durable-objects/AuthorizationCodeStore.md) | Auth code storage |
| [RefreshTokenRotator](./api/durable-objects/RefreshTokenRotator.md) | Token rotation logic |
| [KeyManager](./api/durable-objects/KeyManager.md) | Cryptographic key management |

---

## 🔒 Security

Security documentation and reviews.

| Document | Description |
|:---------|:------------|
| [Envelope Encryption](./security/envelope-encryption.md) | Private key protection using two-factor storage |
| [Device/Hybrid Flow Review](./security/device-hybrid-review.md) | Security analysis of Device Flow and Hybrid Flow |

---

## ⚙️ Operations

Operational guides and performance documentation.

| Document | Description |
|:---------|:------------|
| [Secret Management](./operations/secret-management.md) | Key generation, storage, and rotation |
| [Performance](./operations/performance.md) | Performance optimization and benchmarks |

---

## 🎨 Design

UI/UX design documentation.

| Document | Description |
|:---------|:------------|
| [Design System](./design/design-system.md) | Component library and design tokens |
| [Wireframes](./design/wireframes.md) | UI wireframes and mockups |
| [Accessibility](./design/accessibility.md) | WCAG compliance and a11y guidelines |

---

## ✅ Conformance Testing

OpenID Connect conformance testing documentation.

| Document | Description |
|:---------|:------------|
| [Conformance Overview](./conformance/README.md) | Conformance testing strategy |
| [OpenID Certification](./conformance/OPENID-CERTIFICATION.md) | Certification roadmap |
| [FAPI 2.0 Status](./conformance/FAPI-2.0-STATUS.md) | FAPI 2.0 compliance status |

### Test Profiles
- [OIDC Basic OP](./conformance/OIDC%20Basic%20OP/)
- [OIDC Config OP](./conformance/OIDC%20Config%20OP/)
- [OIDC Dynamic OP](./conformance/OIDC%20Dynamic%20OP/)
- [OIDC Hybrid OP](./conformance/OIDC%20Hybrid%20OP/)
- [OIDC Form Post OP](./conformance/OIDC%20Form%20Post%20OP/)
- [OIDC RP-Initiated Logout OP](./conformance/OIDC%20RP-Initiated%20Logout%20OP/)
- [OIDC FAPI2.0 Security Profile](./conformance/OIDC%20FAPI2.0%20Security%20Profile/)

---

## 📁 Archive

Historical and completed documents.

| Document | Description |
|:---------|:------------|
| [Phase 1 Review](./archive/phase1-review-report.md) | Phase 1 completion review |
| [Phase 2 Code Review](./archive/PHASE2_CODE_REVIEW.md) | Phase 2 code review |
| [Phase 2 Prerequisites](./archive/phase2-prerequisites-checklist.md) | Phase 2 prerequisites checklist |
| [Phase 5 Certification Original](./archive/phase5-certification-original.md) | Original certification plan |
| [CIBA TODO](./archive/ciba-todo.md) | CIBA implementation status (archived) |
| [CIBA Implementation](./archive/ciba-implementation-complete.md) | CIBA completion summary (archived) |
| [Recent Fixes 2025-11-20](./archive/recent-fixes-2025-11-20.md) | Recent bug fixes summary |

---

## 📚 External Resources

### OpenID Connect Specifications
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)
- [Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)

### OAuth 2.0 Specifications
- [RFC 6749 - OAuth 2.0 Framework](https://datatracker.ietf.org/doc/html/rfc6749)
- [RFC 6750 - Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)
- [RFC 9126 - Pushed Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9126)

### JWT/JWK Specifications
- [RFC 7519 - JSON Web Token (JWT)](https://datatracker.ietf.org/doc/html/rfc7519)
- [RFC 7517 - JSON Web Key (JWK)](https://datatracker.ietf.org/doc/html/rfc7517)

### Technology Stack
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Hono Framework](https://hono.dev/)
- [JOSE Library](https://github.com/panva/jose)

---

> **Authrim** — Edge-native OpenID Connect Provider documentation.
