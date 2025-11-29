# Authrim

> **One-command identity infrastructure for the modern web**

A lightweight, serverless **OpenID Connect Provider** that deploys to **Cloudflare's global edge network** in under 5 minutes.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)

---

## Vision

**Authrim** makes identity infrastructure as simple as deploying a website:

```bash
# Future goal (Phase 7)
npx create-authrim my-identity-provider
```

**Result:** A production-ready OpenID Connect Provider with login screens, admin dashboard, and global edge deployment—all in under 5 minutes.

[Read the full vision](./docs/VISION.md)

---

## What is Authrim?

Authrim is an **enterprise-grade OpenID Connect Provider** built for:

- **Developers** - Simple integration, great DX
- **Enterprises** - Self-hosted, no vendor lock-in
- **Global apps** - <50ms latency worldwide
- **Startups** - Generous free tier, no hidden costs

### Why Authrim?

| Feature         | Authrim      | Auth0     | Keycloak | Cognito   |
| --------------- | ------------ | --------- | -------- | --------- |
| **Setup Time**  | 5 min (goal) | 30 min    | 2+ hours | 1+ hour   |
| **Cold Starts** | 0ms          | N/A       | N/A      | 100-500ms |
| **Global Edge** | ✅            | ✅         | ❌        | ❌         |
| **Self-Hosted** | ✅            | ❌         | ✅        | ❌         |
| **Open Source** | ✅ Apache 2.0 | ❌         | ✅ Apache | ❌         |

---

## Current Status

### Phase 6: Enterprise Features (8/11 Complete)

**Latest Achievements (Nov 2025):**
- ✅ **Device Flow (RFC 8628)** - Smart TV, CLI, IoT authentication
- ✅ **JWT Bearer Flow (RFC 7523)** - Service-to-service authentication
- ✅ **JWE (RFC 7516)** - ID Token and UserInfo encryption
- ✅ **Hybrid Flow (OIDC Core 3.3)** - All three response types
- ✅ **CIBA** - Backchannel authentication with poll/ping/push modes
- ✅ **SCIM 2.0 (RFC 7643/7644)** - User/Group provisioning
- ✅ **JAR (RFC 9101)** - JWT-Secured Authorization Requests
- ✅ **JARM** - JWT-Secured Authorization Response Mode

**Remaining (3/11):**
- Social Login (Google, GitHub, Microsoft, Apple, etc.)
- SAML 2.0 Bridge / LDAP Integration
- Visual Flow Builder

### Previous Phases (Complete)

| Phase | Description | Status |
|-------|-------------|--------|
| 1-2 | Foundation & Core API | ✅ Complete |
| 3 | Testing & Conformance (Basic OP 78.95%) | ✅ Complete |
| 4 | Extended Features (PAR, DPoP, Pairwise, Token Management) | ✅ Complete |
| 5 | UI/UX (SvelteKit, Admin Dashboard, 15+ pages) | ✅ Complete |

### Conformance Test Results

| Profile | Pass Rate | Status |
|---------|-----------|--------|
| Basic OP | 78.95% (30/38) | ✅ Passed (4 intentional skips) |
| Config OP | 100% | ✅ Passed |
| Form Post Basic | 84.21% | ✅ Passed |

[View detailed roadmap](./docs/ROADMAP.md)

---

## Technical Stack

### Backend (API)

| Layer         | Technology                | Purpose                            |
| ------------- | ------------------------- | ---------------------------------- |
| **Runtime**   | Cloudflare Workers        | Global edge deployment             |
| **Framework** | Hono                      | Fast, lightweight web framework    |
| **Build**     | Turborepo + pnpm          | Monorepo, parallel builds, caching |
| **Storage**   | KV / D1 / Durable Objects | Flexible data persistence          |
| **Crypto**    | JOSE                      | JWT/JWK standards (RS256)          |

### Frontend (UI)

| Layer          | Technology       | Purpose                        |
| -------------- | ---------------- | ------------------------------ |
| **Framework**  | SvelteKit v5     | Modern reactive framework      |
| **Deployment** | Cloudflare Pages | Global CDN                     |
| **CSS**        | UnoCSS           | Lightweight utility-first      |
| **Components** | Melt UI          | Headless, accessible           |
| **i18n**       | Paraglide        | Type-safe internationalization |

### Durable Objects (14 total)

| Durable Object         | Purpose                         |
| ---------------------- | ------------------------------- |
| SessionStore           | User session management         |
| AuthorizationCodeStore | OAuth code lifecycle            |
| RefreshTokenRotator    | Token rotation & theft detection |
| KeyManager             | Cryptographic key management    |
| DeviceCodeStore        | Device Flow code storage        |
| CIBARequestStore       | CIBA request management         |
| PARRequestStore        | Pushed Authorization Requests   |
| DPoPJTIStore           | DPoP replay prevention          |
| TokenRevocationStore   | Token revocation tracking       |
| ChallengeStore         | WebAuthn challenge storage      |
| RateLimiterCounter     | Rate limiting                   |
| UserCodeRateLimiter    | User code rate limiting         |
| VersionManager         | Version management              |

---

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

- Social Login (7+ providers)
- SAML 2.0 Bridge
- LDAP/AD Integration
- Visual Flow Builder
- CLI (`create-authrim`)
- Verifiable Credentials (OpenID4VP/CI/IA)

---

## Quick Start

### Prerequisites

- Node.js 18+
- pnpm
- Cloudflare account (free tier works)

### Development Setup

```bash
# Clone repository
git clone https://github.com/sgrastar/authrim.git
cd authrim

# Install dependencies
pnpm install

# Generate RSA keys
./scripts/setup-keys.sh

# Set up local environment
./scripts/setup-local-wrangler.sh --env=dev
./scripts/setup-kv.sh --env=dev
./scripts/setup-d1.sh --env=dev

# Build and start
pnpm run build
pnpm run dev

# Workers start at:
# - op-discovery: http://localhost:8787
# - op-auth: http://localhost:8788
# - op-token: http://localhost:8789
# - op-userinfo: http://localhost:8790
# - op-management: http://localhost:8791
```

### Test the API

```bash
# Discovery endpoint
curl http://localhost:8787/.well-known/openid-configuration | jq

# JWKS endpoint
curl http://localhost:8787/.well-known/jwks.json | jq
```

For production deployment, see [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## Documentation

| Category | Documents |
|----------|-----------|
| **Getting Started** | [Vision](./docs/VISION.md), [Roadmap](./docs/ROADMAP.md), [Development](./DEVELOPMENT.md) |
| **Architecture** | [Technical Specs](./docs/architecture/technical-specs.md), [Durable Objects](./docs/architecture/durable-objects.md) |
| **Features** | [Device Flow](./docs/features/device-flow.md), [CIBA](./docs/features/ciba.md), [SCIM](./docs/features/scim.md), [JAR/JARM](./docs/features/jar-jarm.md) |
| **API Reference** | [API Overview](./docs/api/README.md), [Admin API](./docs/api/admin/) |
| **Project** | [Tasks](./docs/project-management/TASKS.md), [Schedule](./docs/project-management/SCHEDULE.md) |

Full documentation: [docs/README.md](./docs/README.md)

---

## Specification Compliance

| Specification                              | Status        |
| ------------------------------------------ | ------------- |
| OpenID Connect Core 1.0                    | ✅ Implemented |
| OpenID Connect Discovery 1.0               | ✅ Implemented |
| OAuth 2.0 (RFC 6749)                       | ✅ Implemented |
| PKCE (RFC 7636)                            | ✅ Implemented |
| JWT (RFC 7519) / JWK (RFC 7517)            | ✅ Implemented |
| JWE (RFC 7516)                             | ✅ Implemented |
| Dynamic Client Registration (RFC 7591)    | ✅ Implemented |
| Token Introspection (RFC 7662)             | ✅ Implemented |
| Token Revocation (RFC 7009)                | ✅ Implemented |
| PAR (RFC 9126)                             | ✅ Implemented |
| DPoP (RFC 9449)                            | ✅ Implemented |
| JAR (RFC 9101)                             | ✅ Implemented |
| Device Flow (RFC 8628)                     | ✅ Implemented |
| JWT Bearer (RFC 7523)                      | ✅ Implemented |
| SCIM 2.0 (RFC 7643/7644)                   | ✅ Implemented |
| CIBA (OpenID Connect)                      | ✅ Implemented |

---

## Security

Authrim implements security best practices:

- ✅ PKCE (Proof Key for Code Exchange)
- ✅ Single-use authorization codes
- ✅ JWT signature verification (RS256)
- ✅ Token expiration with configurable TTL
- ✅ HTTPS-only in production
- ✅ CSRF protection (state parameter)
- ✅ Rate limiting (configurable profiles)
- ✅ DPoP token binding
- ✅ Security headers (CSP, HSTS, XSS protection)

**Responsible Disclosure:** security@authrim.org

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

> **Authrim** — *Authentication at the edge of everywhere*
>
> **Status:** Phase 6 (8/11 Enterprise Features Complete)
>
> *From zero to production-ready OpenID Provider in under 5 minutes.* (Goal: 2026)
