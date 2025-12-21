# Authrim

> **Unified Identity & Access Platform for the modern web**

A lightweight, serverless **Identity Hub** that combines authentication, authorization, and identity federation on **Cloudflare's global edge network**.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)

## 🚧 Authrim is not production-ready (yet)

Authrim is in active development and undergoing major changes.
We’re sharing the repository early so people can follow progress, test things, and participate —
but it is not safe for production use.

Key caveats:

- Security hardening and audits not completed
- Breaking changes happen without notice
- Many features are experimental
- No backward compatibility guarantees
- 🚫 Do not use in production environments

## Vision

**Authrim** makes identity & access management as simple as deploying a website:

```bash
# Coming in 2026-Q1 (Phase 12)
npx create-authrim my-identity-provider
```

**Result:** A production-ready Identity & Access Platform with login screens, admin dashboard, policy engine, and global edge deployment—all in under 5 minutes.

---

Authrim is a **Unified Identity & Access Platform** that integrates:

- **Authentication (AuthN)** — OIDC Provider, Social Login, Passkey, SAML
- **Authorization (AuthZ)** — RBAC, ABAC, ReBAC policy engine built-in
- **Identity Federation** — Connect multiple identity sources into one unified identity

The project aims to deliver:

- Unified AuthN + AuthZ in a single platform (no separate policy service needed)
- Identity Hub capabilities (Social Login, SAML, Wallet/VC as upstream sources)
- Fast global performance via edge execution (<50ms worldwide)
- Flexibility to evolve with new identity standards (OpenID4VP/CI, DID)

Authrim is designed to be practical, adaptable, and straightforward for both users and developers.

[Read the full vision](./docs/VISION.md)

## What is Authrim?

Authrim is an **enterprise-grade Identity & Access Platform** built for:

- **Developers** - Simple integration, great DX, unified AuthN + AuthZ
- **Enterprises** - Self-hosted, no vendor lock-in, full policy engine
- **Global apps** - <50ms latency worldwide via edge deployment
- **Startups** - Generous free tier, no hidden costs

## Performance

K6 Cloud distributed load testing (December 2025) demonstrated **zero-error operation** across all endpoints within capacity limits.

Token operations sustain **2,500–3,500 RPS**,  
full 5-step OAuth login flows handle **150 logins/sec** (P95 756ms),  
and token validation maintains **100% accuracy** even under peak load.

CPU time stays constant at 1–4ms —  
**horizontal scaling via Durable Object sharding** is the proven strategy.

Authrim scales horizontally by design.  
In practice, capacity can be increased by adjusting a single scaling parameter —  
globally, without migrations or downtime.

[View detailed reports](./load-testing/reports/Dec2025/)

## Approximate Cloudflare Cost (Reference Only)

⚠️ The following table is a **rough reference only**.  
Actual costs depend on request volume, CPU time, and usage of KV / D1 / R2.

| Product Scale                   | Users (Total) | Est. CF Cost | Notes                                |
| ------------------------------- | ------------: | -----------: | ------------------------------------ |
| Side project / Portfolio        |           ~1K |         Free | Workers Free tier (limited requests) |
| Internal tool / Small community |          ~10K |       ~$5/mo | Paid plan base                       |
| Startup SaaS / Small e-commerce |          ~50K |    ~$5–15/mo | Light API usage                      |
| Growing B2B SaaS                |         ~100K |   ~$15–30/mo | Moderate auth traffic                |
| Mid-size consumer app           |         ~500K |   ~$30–60/mo | KV/DO costs accumulate               |
| Enterprise SaaS                 |           ~1M |  ~$60–120/mo | Cached / sharded                     |
| High-traffic consumer service   |           ~5M | ~$150–300/mo | Heavy auth traffic                   |
| Large-scale platform            |          ~10M | ~$300–600/mo | 150 login/sec tested                 |

### Assumptions

- Workers Paid plan ($5/month)
- Optimized request patterns (caching, batching)
- Typical authentication flows (OIDC, token refresh)
- Excludes large R2 storage and excessive KV/D1 writes
- Assumes ~20% DAU with weekly logins
- Authrim scales primarily with **requests and CPU time**, not with user count

### Verified by Load Testing (Dec 2025)

| Metric | Value | Cost |
|--------|-------|------|
| Workers Requests | 18M/month | $5.70 (7%) |
| KV Reads | 78M/month | $39.00 (44%) |
| DO Requests + Duration | 64M/month | $22.10 (25%) |
| D1 Writes | 6.8M rows | $7.00 (8%) |
| Base fee | — | $5.00 (6%) |
| **Total (excl. tax)** | **≈ 5M users equiv.** | **$79.78** |

**Request-to-User conversion:**
- 1 OIDC login ≈ 4 requests (authorize → token → userinfo → discovery)
- 18M requests ≈ 4.5M logins/month
- With 20% DAU and weekly login assumption → **~5M total users equivalent**

> Infrastructure cost only (self-hosted). No vendor fees. See [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/) for details.

---

## Current Status

| Phase | Name                           | Timeline          | Status      |
| ----- | ------------------------------ | ----------------- | ----------- |
| 1-5   | Foundation, Core API, UI/UX    | 2025-11           | ✅ Complete |
| 6     | Enterprise Features            | 2025-12           | ✅ Complete |
| 7     | **Identity Hub Foundation**    | 2025-12           | ✅ Complete |
| 8     | **Unified Policy Integration** | 2025-12           | ✅ Complete |
| 9     | **Advanced Identity (VC/DID)** | 2025-12           | ✅ Complete |
| 10    | SDK & API                      | 2025-Q4           | 🔜 Planned  |
| 11    | Security & QA                  | 2025-Q4           | ⏳ ~20%     |
| 12    | Certification & Release        | 2026-Q1           | 🔜 Final    |

[View detailed roadmap](./docs/ROADMAP.md)

---

## Technical Stack

### Backend (API)

| Layer         | Technology                | Version | Purpose                            |
| ------------- | ------------------------- | ------- | ---------------------------------- |
| **Runtime**   | Cloudflare Workers        | -       | Global edge deployment             |
| **Framework** | Hono                      | 4.x     | Fast, lightweight web framework    |
| **Build**     | Turborepo + pnpm          | 9.x     | Monorepo, parallel builds, caching |
| **Storage**   | KV / D1 / Durable Objects | -       | Flexible data persistence          |
| **Crypto**    | JOSE                      | 6.x     | JWT/JWS/JWE/JWK (RS256, ES256)     |
| **WebAuthn**  | SimpleWebAuthn            | 13.x    | Passkey authentication             |
| **SAML**      | xmldom + pako             | -       | SAML 2.0 XML processing            |
| **Email**     | Resend                    | 6.x     | Magic Link, OTP delivery           |
| **Testing**   | Vitest                    | 2.x     | Unit & integration tests           |

### Frontend (UI)

| Layer          | Technology               | Version   | Purpose                        |
| -------------- | ------------------------ | --------- | ------------------------------ |
| **Framework**  | SvelteKit + Svelte       | 2.x / 5.x | Modern reactive framework      |
| **Deployment** | Cloudflare Pages         | -         | Global CDN                     |
| **CSS**        | UnoCSS                   | 66.x      | Utility-first CSS              |
| **Components** | Melt UI                  | 0.86.x    | Headless, accessible           |
| **i18n**       | typesafe-i18n            | 5.x       | Type-safe internationalization |
| **WebAuthn**   | SimpleWebAuthn Browser   | 13.x      | Client-side passkey support    |
| **Testing**    | Vitest + Testing Library | 4.x       | Component & E2E tests          |

### Packages (15 total)

| Package          | Type      | Purpose                                  |
| ---------------- | --------- | ---------------------------------------- |
| `shared`         | Library   | Common utilities, types, Durable Objects |
| `policy-core`    | Library   | RBAC/ABAC/ReBAC policy engine core       |
| `op-auth`        | Worker    | Authorization endpoint, login flows      |
| `op-token`       | Worker    | Token endpoint (all grant types)         |
| `op-userinfo`    | Worker    | UserInfo endpoint                        |
| `op-management`  | Worker    | Admin API, introspection, revocation     |
| `op-discovery`   | Worker    | Discovery & JWKS endpoints               |
| `op-async`       | Worker    | Device Flow, CIBA polling                |
| `op-saml`        | Worker    | SAML 2.0 IdP & SP                        |
| `external-idp`   | Worker    | Social login (Google, MS, GitHub, Apple, LinkedIn, Facebook, X) |
| `policy-service` | Worker    | Policy evaluation API                    |
| `scim`           | Worker    | SCIM 2.0 user provisioning               |
| `vc`             | Worker    | OpenID4VP/VCI, DID resolution            |
| `router`         | Worker    | Request routing & load balancing         |
| `ui`             | SvelteKit | Authentication & admin UI                |

### Durable Objects (17 total)

| Durable Object         | Purpose                          |
| ---------------------- | -------------------------------- |
| SessionStore           | User session management          |
| AuthorizationCodeStore | OAuth code lifecycle             |
| RefreshTokenRotator    | Token rotation & theft detection |
| KeyManager             | Cryptographic key management     |
| DeviceCodeStore        | Device Flow code storage         |
| CIBARequestStore       | CIBA request management          |
| PARRequestStore        | Pushed Authorization Requests    |
| DPoPJTIStore           | DPoP replay prevention           |
| TokenRevocationStore   | Token revocation tracking        |
| ChallengeStore         | WebAuthn challenge storage       |
| SAMLRequestStore       | SAML request management          |
| RateLimiterCounter     | Rate limiting                    |
| UserCodeRateLimiter    | User code rate limiting          |
| VersionManager         | Version management               |
| VPRequestStore         | OpenID4VP request management     |
| CredentialOfferStore   | OpenID4VCI offer management      |
| PermissionChangeHub    | Real-time permission notifications |

## Features

### Implemented

**Core OIDC:**

- OpenID Connect Core 1.0 compliance
- Authorization Code Flow with PKCE (RFC 7636)
- Hybrid Flow (code id_token, code token, code id_token token)
- Discovery and JWKS endpoints
- JWT signing (RS256) with key rotation

**Advanced Security:**

- PAR - Pushed Authorization Requests (RFC 9126)
- DPoP - Demonstrating Proof of Possession (RFC 9449)
- JAR - JWT-Secured Authorization Requests (RFC 9101)
- JARM - JWT-Secured Authorization Response Mode
- JWE - JSON Web Encryption (RFC 7516)
- Pairwise Subject Identifiers

**Token Management:**

- Refresh Token with rotation
- Token Introspection (RFC 7662)
- Token Revocation (RFC 7009)
- Dynamic Client Registration (RFC 7591)

**Authentication Methods:**

- WebAuthn/Passkey (passwordless)
- Magic Link (email-based)
- Device Flow (RFC 8628)
- CIBA (Client Initiated Backchannel Authentication)
- JWT Bearer Flow (RFC 7523)

**Enterprise:**

- SCIM 2.0 User Provisioning (RFC 7643/7644)
- Admin Dashboard (7 pages)
- Multi-language support (EN/JA)

### Planned

**Phase 7: Identity Hub Foundation** ✅ Complete

- Social Login: Google, Microsoft, GitHub, Apple, LinkedIn, Facebook, Twitter/X (全7プロバイダ) ✅
- RP Module (OIDC/OAuth 2.0 client for upstream IdPs) ✅
- Identity Linking & Stitching (unified user identity across sources) ✅
- PII/Non-PII Database Separation (GDPR/CCPA compliance) ✅

**Phase 8: Unified Policy Integration** ✅ Complete

- Token-embedded permissions (roles, permissions in tokens) ✅
- Real-time Check API (`/api/check`, `/api/check/batch`) ✅
- WebSocket Push (real-time permission change notifications) ✅
- Policy Admin Console → Moved to Phase 10 (SDK & API)

**Phase 9: Advanced Identity** ✅ Complete (227 tests)

- OpenID4VP (Verifiable Presentations) ✅ - VP request, verification, HAIP compliance
- OpenID4VCI (Credential Issuance) ✅ - Credential endpoint, offers, deferred issuance
- DID Support ✅ - did:web, did:key resolver, document hosting
- DID Authentication ✅ - Challenge-response, DID linking

**Phase 10-12:**

- WebSDK (@authrim/sdk-core, @authrim/sdk-web, @authrim/sdk-react)
- CLI (`create-authrim`)
- OpenID Certification

---

## Contributing

Authrim is primarily a solo development project. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

**What we accept:**

- Bug reports via GitHub Issues

**What we don't accept:**

- Pull requests (development is maintained solely by the original author)

---

## License

Apache License 2.0 © 2025 [Yuta Hoshina](https://github.com/sgrastar)

See [LICENSE](./LICENSE) for details.

---

## Community

- **GitHub**: [sgrastar/authrim](https://github.com/sgrastar/authrim)
- **Issues**: [Report bugs](https://github.com/sgrastar/authrim/issues)
- **Discussions**: [Feature requests](https://github.com/sgrastar/authrim/discussions)
- **Email**: yuta@authrim.com

---

> **Authrim** — _Identity & Access at the edge of everywhere_
>
> **Status:** Phase 6 ✅ | Phase 7 ✅ | Phase 8 ✅ | Phase 9 ✅ | Phase 11 ~20%
>
> _From zero to production-ready Identity & Access Platform in under 5 minutes._ (Goal: 2026-Q1)
