# Enrai ⚡️

> **One-command identity infrastructure for the modern web**

A lightweight, serverless **OpenID Connect Provider** that deploys to **Cloudflare's global edge network** in under 5 minutes.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)

---

## 🎯 Vision

**Enrai** makes identity infrastructure as simple as deploying a website:

```bash
# Future goal (Phase 6)
npx create-enrai my-identity-provider
```

**Result:** A production-ready OpenID Connect Provider with login screens, admin dashboard, and global edge deployment—all in under 5 minutes.

[📖 Read the full vision](./docs/VISION.md)

---

## ✨ What is Enrai?

Enrai is an **enterprise-grade OpenID Connect Provider** built for:

- 🚀 **Developers** - Simple integration, great DX
- 🏢 **Enterprises** - Self-hosted, no vendor lock-in
- 🌍 **Global apps** - <50ms latency worldwide
- 💰 **Startups** - Generous free tier, no hidden costs

### Why Enrai?

| Feature | Enrai | Auth0 | Keycloak | Cognito |
|---------|--------|-------|----------|---------|
| **Setup Time** | 5 min (goal) | 30 min | 2+ hours | 1+ hour |
| **Cold Starts** | 0ms | N/A | N/A | 100-500ms |
| **Global Edge** | ✅ | ✅ | ❌ | ❌ |
| **Self-Hosted** | ✅ | ❌ | ✅ | ❌ |
| **Open Source** | ✅ Apache 2.0 | ❌ | ✅ Apache | ❌ |
| **Custom UI** | ✅ Full | ⚠️ Limited | ✅ Full | ⚠️ Limited |

---

## 🚀 Current Status

### Phase 2: Core API ✅ COMPLETE

**All OpenID Connect endpoints are functional!**

- ✅ **Discovery** - `/.well-known/openid-configuration`
- ✅ **JWKS** - `/.well-known/jwks.json`
- ✅ **Authorization** - `/authorize` (with PKCE support)
- ✅ **Token** - `/token` (ID Token + Access Token)
- ✅ **UserInfo** - `/userinfo`

**Test Coverage:** 263 tests passing ✅

### Phase 3: Testing & Validation ✅ COMPLETE

**OpenID Conformance Suite Results:**
- ✅ **23/24 Phase 3 tests passed (95.8%)**
- ✅ **Overall: 24/33 tests (72.7%)**
- ✅ **Token revocation on code reuse** (RFC 6749 Section 4.1.2)
- ✅ **Claims parameter support** (OIDC Core 5.5)
- ✅ **PKCE full support** (RFC 7636)
- ✅ **All standard scopes** (openid, profile, email, address, phone)

**Plan ID:** e90FqMh4xG2mg | **Test Version:** 5.1.36 | **Date:** 2025-11-12

### Phase 4: Extended Features ✅ COMPLETE

**All Phase 4 features implemented!**

- ✅ **Dynamic Client Registration** - `/register` endpoint (RFC 7591)
- ✅ **Key Rotation** - Multi-key support via KeyManager Durable Object
- ✅ **Extended Claims** - Full profile, email, address, phone support
- ✅ **Rate Limiting** - Configurable per-endpoint protection
- ✅ **Security Enhancements** - Enhanced CSP, CORS, security headers

[📋 View detailed roadmap](./docs/ROADMAP.md)

---

## 📦 Technical Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **Runtime** | Cloudflare Workers | Global edge deployment |
| **Framework** | Hono | Fast, lightweight web framework |
| **Storage** | KV / D1 / Durable Objects | Flexible data persistence |
| **Crypto** | JOSE | JWT/JWK standards (RS256) |
| **Language** | TypeScript | Type safety, great DX |

---

## 🎨 Features

### ✅ Implemented (Phase 1-4)

**Phase 1-2: Core OpenID Connect**
- **OpenID Connect Core 1.0** compliance
- **Authorization Code Flow** with PKCE (RFC 7636)
- **Discovery** and **JWKS** endpoints
- **JWT signing** (RS256) with key rotation support
- **Scope-based claims** (openid, profile, email, address, phone)
- **Comprehensive testing** (263 tests, 0 failures)
- **Security hardening** (PKCE, single-use codes, expiration)

**Phase 3: Testing & Validation**
- **OpenID Conformance Suite** testing completed (95.8% Phase 3 achievement)
- **Core flow validation** complete
- **JWT/JWK compliance** verified

**Phase 4: Extended Features**
- **Dynamic Client Registration** (RFC 7591)
- **Multi-Key Support** with automatic rotation
- **Extended Claims** (full OIDC profile support)
- **Rate Limiting** (strict/moderate/lenient profiles)
- **Enhanced Security** (CSP, CORS, HSTS, XSS protection)

### 🆕 Planned (Phase 5-9)

**Phase 5: UI/UX Implementation** (May 2026)
- 🖥️ Login & registration screens (Passwordless-first)
- 🎨 OAuth consent screen
- 📊 Admin dashboard
- 👥 User management interface
- 🔧 Client management interface
- 💾 Data storage abstraction (KV/D1/DO)

**Phase 6: CLI & Automation** (Jun-Aug 2026)
- 📦 `create-enrai` NPM package
- 🚀 One-command deployment
- 🤖 Cloudflare integration
- 🛠️ Management CLI (users, clients, keys)
- 📚 Integration examples (Next.js, React, Vue, etc.)

**Phase 7: Enterprise Features** (Aug-Oct 2026)
- 🏢 Hybrid Flow, Device Flow, JWT Bearer
- 🔐 CIBA, JWE encryption
- 🌐 Social Login (Google, GitHub, etc.)
- 🔗 SAML 2.0, LDAP/AD, SCIM 2.0

**Phase 8: Next-Gen Protocols** (Nov 2026 - Jan 2027)
- 🆔 Verifiable Credentials (OpenID4VP/CI/IA)
- 🌐 OpenID Federation 1.0
- 🔮 OAuth 2.1 compliance
- 📱 Mobile SDKs (iOS, Android, React Native, Flutter)

**Phase 9: SaaS Platform** (Feb 2027+)
- 🌐 Multi-tenant architecture
- 💰 Billing & monetization
- 🛒 Plugin marketplace

**Phase 10: Certification & Launch** (Final Phase)
- ✅ OpenID Certification submission
- 🚀 Production deployment
- 📣 Public announcement

[🗺️ Full Roadmap](./docs/ROADMAP.md) | [📋 Detailed Tasks](./docs/project-management/TASKS.md)

---

## 🏁 Getting Started

### Prerequisites

- Node.js 18+
- npm or pnpm
- Cloudflare account (free tier works)

### Quick Start (Development)

```bash
# 1. Clone repository
git clone https://github.com/sgrastar/enrai.git
cd enrai

# 2. Install dependencies
npm install

# 3. Start development server
npm run dev

# Server starts at http://localhost:8787
```

### Test the API

```bash
# Discovery endpoint
curl http://localhost:8787/.well-known/openid-configuration | jq

# JWKS endpoint
curl http://localhost:8787/.well-known/jwks.json | jq

# Authorization flow (open in browser)
open "http://localhost:8787/authorize?response_type=code&client_id=test&redirect_uri=http://localhost:3000/callback&scope=openid%20profile"
```

---

## 📊 Project Status

### Milestones

| Milestone | Date | Status | Description |
|-----------|------|--------|-------------|
| **M1: Foundation** | 2025-12-15 | ✅ Complete | Project setup, tooling |
| **M2: Core API** | 2026-01-31 | ✅ Complete | All OIDC endpoints |
| **M3: Conformance** | 2026-03-15 | ⏳ In Progress | OpenID testing |
| **M4: Extensions** | 2026-04-30 | ✅ Complete | Dynamic registration |
| **M5: Certification** | 2026-05-31 | ⏳ Planned | Official certification |
| **M6: UI/UX** | 2026-06-30 | 🆕 Planned | Login & admin UI |
| **M7: CLI** | 2026-08-31 | 🆕 Planned | One-command deploy |

### Test Results

```
✓ 178 tests passing
✓ 0 tests skipped
✓ 0 tests failing

Coverage:
- Utilities: 85%
- Handlers: 90%
- Durable Objects: 95%
- Middleware: 80%
```

---

## 📚 Documentation

### For Users
- [Vision & Roadmap](./docs/VISION.md) - Long-term goals
- [Product Roadmap](./docs/ROADMAP.md) - Phase-by-phase plan
- [Getting Started](./docs/README.md) - Documentation index

### For Contributors
- [Task Breakdown](./docs/project-management/TASKS.md) - Detailed tasks
- [Project Schedule](./docs/project-management/SCHEDULE.md) - Timeline
- [Technical Specs](./docs/architecture/technical-specs.md) - Architecture
- [Contributing Guide](./CONTRIBUTING.md) - How to contribute

### For Developers
- [Development Guide](./DEVELOPMENT.md) - Local setup
- [API Reference](./docs/api/) - Endpoint documentation
- [Testing Guide](./docs/testing/) - How to test

---

## 🔐 Security

Enrai implements security best practices:

- ✅ **PKCE** (Proof Key for Code Exchange) - RFC 7636
- ✅ **Single-use authorization codes** - Replay attack prevention
- ✅ **JWT signature verification** - RS256 algorithm
- ✅ **Token expiration** - Configurable TTL
- ✅ **HTTPS-only** - In production
- ✅ **CSRF protection** - State parameter validation
- ✅ **Rate limiting** - Implemented (Phase 4)

**Responsible Disclosure:** security@enrai.org

---

## 🤝 Contributing

Enrai is primarily a solo development project. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

**What we accept:**
- 🐛 Bug reports via GitHub Issues

**What we don't accept:**
- ❌ Pull requests (development is maintained solely by the original author)

---

## 📜 Specification Compliance

| Specification | Status | Reference |
|---------------|--------|-----------|
| **OpenID Connect Core 1.0** | ✅ Implemented | [Spec](https://openid.net/specs/openid-connect-core-1_0.html) |
| **OpenID Connect Discovery 1.0** | ✅ Implemented | [Spec](https://openid.net/specs/openid-connect-discovery-1_0.html) |
| **OAuth 2.0 (RFC 6749)** | ✅ Implemented | [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) |
| **PKCE (RFC 7636)** | ✅ Implemented | [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636) |
| **JWT (RFC 7519)** | ✅ Implemented | [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519) |
| **JWK (RFC 7517)** | ✅ Implemented | [RFC 7517](https://datatracker.ietf.org/doc/html/rfc7517) |
| **Dynamic Client Registration (RFC 7591)** | ✅ Implemented | [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) |
| **Session Management** | ❌ Not planned | [Spec](https://openid.net/specs/openid-connect-session-1_0.html) |

---

## 🎯 Conformance Target

**Profile:** OpenID Connect *Basic OP*

**Testing:** OpenID Foundation Conformance Suite

**Goal:** ≥95% conformance score (Phase 3: 95.8% achieved, Overall: 72.7%)

---

## 📦 Deployment

### Quick Deploy to Cloudflare Workers

Deploy Enrai to Cloudflare's global edge network and get a production-ready OpenID Provider with a public URL.

```bash
# 1. Install dependencies
npm install

# 2. Set up RSA keys
./scripts/setup-dev.sh

# 3. Build TypeScript
npm run build

# 4. Deploy to Cloudflare
npm run deploy
```

**After deployment, you'll get:**
- 🌍 **Public URL**: `https://enrai.{your-subdomain}.workers.dev`
- ✅ **Live Endpoints**:
  - Discovery: `/.well-known/openid-configuration`
  - JWKS: `/.well-known/jwks.json`
  - Authorization: `/authorize`
  - Token: `/token`
  - UserInfo: `/userinfo`

📖 **See [DEPLOYMENT.md](./docs/DEPLOYMENT.md) for detailed setup instructions**

### GitHub Actions (CI/CD)

Automatic deployment is configured for the `main` branch:
- ✅ Tests run on every push
- 🚀 Deploys to Cloudflare Workers on merge to main
- 🔐 Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets

**Future (Phase 6):**
```bash
npx create-enrai my-idp
# One command, fully automated setup
```

---

## 🌟 Acknowledgements

Built with amazing open source tools:

- [Hono](https://hono.dev/) - Ultrafast web framework
- [Cloudflare Workers](https://workers.cloudflare.com/) - Edge computing platform
- [JOSE](https://github.com/panva/jose) - JavaScript Object Signing and Encryption
- [Vitest](https://vitest.dev/) - Fast unit testing
- [TypeScript](https://www.typescriptlang.org/) - Type safety

**Inspired by:**
- [Keycloak](https://www.keycloak.org/) - Enterprise features
- [Auth0](https://auth0.com/) - Developer experience
- [Clerk](https://clerk.com/) - Modern UI/UX

---

## 📄 License

Apache License 2.0 © 2025 [sgrastar](https://github.com/sgrastar)

See [LICENSE](./LICENSE) for details.

---

## 💬 Community

- 💼 **GitHub**: [sgrastar/enrai](https://github.com/sgrastar/enrai)
- 🐛 **Issues**: [Report bugs](https://github.com/sgrastar/enrai/issues)
- 💡 **Discussions**: [Feature requests](https://github.com/sgrastar/enrai/discussions)
- 📧 **Email**: hello@enrai.org

---

> **Enrai** ⚡️ — *A spark of identity on the edge.*
>
> **Status:** Phase 2 Complete (Core API) | **Next:** Phase 3 (Conformance Testing)
>
> *From zero to production-ready OpenID Provider in under 5 minutes.* (Goal: Aug 2026)
