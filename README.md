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

### Backend (API)
| Layer | Technology | Purpose |
|-------|------------|---------|
| **Runtime** | Cloudflare Workers | Global edge deployment (6 specialized workers + optional Router) |
| **Framework** | Hono | Fast, lightweight web framework |
| **Build** | Turborepo + pnpm | Monorepo, parallel builds, caching |
| **Storage** | KV / D1 / Durable Objects | Flexible data persistence (4 DO types) |
| **Crypto** | JOSE | JWT/JWK standards (RS256) |
| **Language** | TypeScript | Type safety, great DX |
| **Routing** | Service Bindings / Routes | Unified endpoint (test/prod modes) |

### Frontend (UI)
| Layer | Technology | Purpose |
|-------|------------|---------|
| **Framework** | SvelteKit v5 | Modern reactive framework with SSR |
| **Deployment** | Cloudflare Pages | Global CDN, automatic deployments |
| **CSS** | UnoCSS | Lightweight utility-first (3.10 KB gzipped) |
| **Components** | Melt UI | Headless, accessible UI components |
| **Icons** | Lucide Svelte | Beautiful, consistent icons |
| **i18n** | Paraglide | Type-safe internationalization (EN/JA) |
| **Language** | TypeScript | Full type safety across UI |

### 🔥 Durable Objects Architecture

Enrai leverages **Cloudflare Durable Objects** for stateful operations with strong consistency guarantees:

| Durable Object | Purpose | Key Features |
|----------------|---------|--------------|
| **SessionStore** | User session management | Hot/cold storage pattern, multi-device support, instant invalidation |
| **AuthorizationCodeStore** | OAuth code lifecycle | One-time use, PKCE validation, replay attack prevention |
| **RefreshTokenRotator** | Token rotation | Atomic rotation, theft detection, audit logging |
| **KeyManager** | Cryptographic keys | JWK management, automatic key rotation, secure storage |

**Benefits:**
- ⚡️ **Strong Consistency** - No race conditions on critical operations
- 🔒 **Security** - Atomic token rotation prevents theft
- 🌍 **Global** - Single source of truth with edge locality
- 💾 **Persistent** - Automatic D1 fallback for cold starts

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

### 🚧 In Progress (Phase 5)

**Phase 5: UI/UX Implementation** (In Progress - Stage 3 Complete!)

**Stage 1-2: Backend** ✅
- ✅ **Durable Objects** - Complete (SessionStore, AuthCodeStore, RefreshTokenRotator, KeyManager)
- ✅ **Storage Abstraction Layer** - Complete (unified interface for KV/D1/DO)
- ✅ **Integration Tests** - Complete (cross-DO workflows validated)

**Stage 3: Frontend Foundation** ✅ COMPLETE
- ✅ **SvelteKit v5** - Modern framework with TypeScript
- ✅ **UnoCSS** - Lightweight CSS framework (3.10 KB gzipped)
- ✅ **Melt UI** - Headless, accessible components
- ✅ **Paraglide i18n** - Type-safe internationalization (EN/JA)
- ✅ **Design System** - Complete color palette, typography, components
- ✅ **Cloudflare Pages** - Deployment configuration

**Stage 4: Authentication UI** 🚧 Next
- 🚧 Login & registration screens (Passwordless-first)
- 🚧 OAuth consent screen
- 🚧 Magic Link flow
- 🚧 Passkey/WebAuthn integration

**Stage 5: Admin Dashboard** 🚧 Planned
- 🚧 Admin dashboard
- 🚧 User management interface
- 🚧 Client management interface

### 🆕 Planned (Phase 6-10)

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
- pnpm
- Cloudflare account (free tier works)

### Quick Start (Recommended - Configuration-Based)

**New unified setup process** - supports all deployment patterns (A-D):

```bash
# 1. Clone repository
git clone https://github.com/sgrastar/enrai.git
cd enrai

# 2. Install dependencies (monorepo setup)
pnpm install

# 3. Create configuration file (interactive)
./scripts/setup-config.sh

# 4. Build and deploy based on configuration
./scripts/build.sh --config enrai-config-1.0.0.json

# Workers start at:
# - Configured domains based on your pattern selection
# - See docs/ARCHITECTURE_PATTERNS.md for deployment patterns
```

**Features:**
- ✅ **Interactive Setup** - Guided configuration for all deployment patterns
- ✅ **Pattern Support** - Pattern A (Unified), B (Separate Admin), C (Multi-Domain), D (Headless)
- ✅ **Conflict Detection** - Checks for existing resources before deployment
- ✅ **Version Management** - Configuration files are versioned for easy rollback

> **Note:** The configuration-based setup supports all [Architecture Patterns](./docs/ARCHITECTURE_PATTERNS.md) and is the recommended approach for both development and production.

### Quick Start (Legacy - Manual Setup)

**Traditional step-by-step setup** - for advanced users who prefer manual control:

```bash
# 1. Clone repository
git clone https://github.com/sgrastar/enrai.git
cd enrai

# 2. Install dependencies (monorepo setup)
pnpm install

# 3. Set up RSA keys and generate wrangler.toml files (includes Durable Objects config)
./scripts/setup-dev.sh

# 4. Set up KV namespaces
./scripts/setup-kv.sh

# 5. Set up D1 database (Phase 5)
./scripts/setup-d1.sh

# 6. Build all packages
pnpm run build

# 7. Start all workers in parallel (development mode)
pnpm run dev

# For production deployment:
# Deploy all workers (including Durable Objects automatically)
pnpm run deploy:retry
# - Deploys enrai-shared (Durable Objects) first
# - Then deploys other workers sequentially
# - Optional: Use ./scripts/setup-durable-objects.sh to deploy DOs separately

# Workers start at:
# - op-discovery: http://localhost:8787
# - op-auth: http://localhost:8788
# - op-token: http://localhost:8789
# - op-userinfo: http://localhost:8790
# - op-management: http://localhost:8791
# - router: http://localhost:8786 (optional, for unified endpoint)
```

> **Note:** Enrai uses a monorepo structure with 5 specialized workers plus an optional Router Worker for unified endpoint access. See [WORKERS.md](./WORKERS.md) and [docs/ROUTER_SETUP.md](./docs/ROUTER_SETUP.md) for architecture details.

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
- [API Naming Conventions](./docs/API_NAMING_CONVENTIONS.md) - API design standards & best practices
- [Architecture Patterns](./docs/ARCHITECTURE_PATTERNS.md) - Deployment patterns (A/B/C/D)
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
pnpm install

# 2. Set up RSA keys and generate wrangler.toml files
./scripts/setup-dev.sh

# 3. Set up KV namespaces
./scripts/setup-kv.sh

# 4. Set up D1 database (Phase 5 - optional for Phase 1-4)
./scripts/setup-d1.sh

# 5. Upload secrets to Cloudflare
./scripts/setup-secrets.sh

# 6. Choose deployment mode and configure
./scripts/setup-production.sh
# → Select: 1) Test Environment (Router Worker)
#       or: 2) Production Environment (Custom Domain + Routes)

# 7. Build TypeScript
pnpm run build

# 8. Deploy with retry logic (recommended)
pnpm run deploy:with-router
# This uses deploy-with-retry.sh for sequential deployment with delays
# - Deploys enrai-shared (Durable Objects) first
# - Router Worker is included if wrangler.toml exists (test mode)
# - Router Worker is skipped if wrangler.toml missing (production mode)
```

### Deployment Modes

Enrai supports two deployment modes to ensure OpenID Connect specification compliance:

#### 1️⃣ Test Environment (workers.dev + Router Worker)
- **Unified endpoint**: `https://enrai.{subdomain}.workers.dev`
- **Use case**: Development, testing, quick setup
- **Pros**: No custom domain needed, OpenID Connect compliant ✅
- **Deploy**: `pnpm run deploy:with-router` (includes Router Worker)

**Workers deployed:**
- 🌍 **enrai-shared** (Durable Objects - deployed first)
- 🌍 **enrai** (unified entry point - Router Worker)
- 🌍 **enrai-op-discovery**, **enrai-op-auth**, **enrai-op-token**, **enrai-op-userinfo**, **enrai-op-management**

#### 2️⃣ Production Environment (Custom Domain + Routes)
- **Custom domain**: `https://id.yourdomain.com`
- **Use case**: Production deployments
- **Pros**: Optimal performance, professional URL
- **Deploy**: `pnpm run deploy:with-router` (Router Worker skipped automatically)
- **Requires**: Cloudflare-managed domain

**Workers deployed:**
- 🌍 **enrai-shared** (Durable Objects - deployed first)
- 🌍 **enrai-op-discovery**, **enrai-op-auth**, **enrai-op-token**, **enrai-op-userinfo**, **enrai-op-management**
- Router Worker is automatically excluded (no wrangler.toml generated in production mode)

> 💡 **Learn more**: See [docs/ROUTER_SETUP.md](./docs/ROUTER_SETUP.md) for detailed architecture and [DEPLOYMENT.md](./docs/DEPLOYMENT.md) for step-by-step instructions.

### Deployment Commands

All deployment commands now use sequential deployment with retry logic to avoid API rate limits:

```bash
# Recommended: Deploy with retry logic (works for both modes)
pnpm run deploy:with-router

# Alternative: Same as above (deploy:retry is an alias)
pnpm run deploy:retry

# Legacy: Parallel deployment (NOT recommended, may hit rate limits)
pnpm run deploy
```

**Benefits of sequential deployment:**
- ✅ Avoids Cloudflare API rate limits (1,200 requests per 5 minutes)
- ✅ Prevents "Service unavailable" errors (code 7010)
- ✅ Automatic retry with exponential backoff (up to 4 attempts)
- ✅ 10-second delays between deployments
- ✅ Conditional router deployment based on configuration

### Troubleshooting Deployment

If you encounter KV namespace errors during deployment:

```bash
# Reset and recreate all KV namespaces
./scripts/setup-kv.sh --reset

# Then deploy with retry logic
pnpm run deploy:with-router
```

The `--reset` option will:
- Delete all existing KV namespaces
- Recreate them with fresh IDs
- Update all `wrangler.toml` files automatically

**Note:** You may need to undeploy workers first if namespaces are in use.

### GitHub Actions (CI/CD)

Automatic deployment is configured for the `main` branch:
- ✅ Tests run on every push (using pnpm)
- 🚀 Deploys workers to Cloudflare on merge to main (mode-dependent)
- 🔐 Requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets
- ⚡ Turborepo caching for faster builds
- 🎯 Router Worker deployment depends on configuration

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
