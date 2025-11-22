# Authrim ✨

> **One-command identity infrastructure for the modern web**

A lightweight, serverless **OpenID Connect Provider** that deploys to **Cloudflare's global edge network** in under 5 minutes.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)

---

## 🎯 Vision

**Authrim** makes identity infrastructure as simple as deploying a website:

```bash
# Future goal (Phase 6)
npx create-authrim my-identity-provider
```

**Result:** A production-ready OpenID Connect Provider with login screens, admin dashboard, and global edge deployment—all in under 5 minutes.

[📖 Read the full vision](./docs/VISION.md)

---

## ✨ What is Authrim?

Authrim is an **enterprise-grade OpenID Connect Provider** built for:

- 🚀 **Developers** - Simple integration, great DX
- 🏢 **Enterprises** - Self-hosted, no vendor lock-in
- 🌍 **Global apps** - <50ms latency worldwide
- 💰 **Startups** - Generous free tier, no hidden costs

### Why Authrim?

| Feature         | Authrim      | Auth0     | Keycloak | Cognito   |
| --------------- | ------------ | --------- | -------- | --------- |
| **Setup Time**  | 5 min (goal) | 30 min    | 2+ hours | 1+ hour   |
| **Cold Starts** | 0ms          | N/A       | N/A      | 100-500ms |
| **Global Edge** | ✅            | ✅         | ❌        | ❌         |
| **Self-Hosted** | ✅            | ❌         | ✅        | ❌         |
| **Open Source** | ✅ Apache 2.0 | ❌         | ✅ Apache | ❌         |
| **Custom UI**   | ✅ Full       | ⚠️ Limited | ✅ Full   | ⚠️ Limited |

---

## 🚀 Current Status

### Phase 5: UI/UX Implementation ✅ 100% COMPLETE

**Full-stack OpenID Provider with modern UI and comprehensive testing!**

**Backend:**
- ✅ **D1 Database** - 12 tables (users, sessions, passkeys, clients, etc.)
- ✅ **9 Durable Objects** - SessionStore, AuthCodeStore, RefreshTokenRotator, KeyManager, etc.
- ✅ **WebAuthn/Passkey API** - Full FIDO2 implementation
- ✅ **Magic Link Auth** - Passwordless email authentication
- ✅ **Admin APIs** - User/client/session management (20+ endpoints)
- ✅ **Storage Abstraction Layer** - CloudflareAdapter with intelligent routing

**Frontend:**
- ✅ **SvelteKit + UnoCSS + Melt UI** - Modern, accessible UI framework
- ✅ **Authentication Pages** - Login, register, magic link, consent, error (6 pages)
- ✅ **Admin Dashboard** - Users, clients, settings, audit log (7 pages)
- ✅ **Internationalization** - English & Japanese (Paraglide)
- ✅ **Design System** - Reusable components & design tokens

**Testing:**
- ✅ **Unit Tests** - 400+ tests across backend, Durable Objects, and UI components
- ✅ **E2E Tests** - 19 tests with Playwright (homepage, accessibility)
- ✅ **Accessibility** - WCAG 2.1 AA compliance verified with axe-core (5 pages, zero violations)
- ✅ **Performance** - Lighthouse score 100 (Performance), LCP: 0.11s (exceptional)
- ✅ **CI/CD Integration** - GitHub Actions with automated testing pipeline

### Previous Phases ✅ COMPLETE

**Phase 1-2: Core API**
- ✅ All OpenID Connect endpoints functional
- ✅ 178 tests passing (Authorization, Token, UserInfo, Discovery, JWKS)
- ✅ PKCE support (RFC 7636)

**Phase 3: Testing & Validation**
- ✅ **23/24 Phase 3 tests passed (95.8%)**
- ✅ **Overall: 24/33 tests (72.7%)**
- ✅ Token revocation, claims parameter, all standard scopes
- **Plan ID:** e90FqMh4xG2mg | **Date:** 2025-11-12

**Phase 4: Extended Features**
- ✅ Dynamic Client Registration (RFC 7591)
- ✅ Token Management (Refresh, Introspection, Revocation)
- ✅ PAR, DPoP, Pairwise Identifiers, Form Post Response Mode
- ✅ 378+ tests passing

[📋 View detailed roadmap](./docs/ROADMAP.md)

---

## 📦 Technical Stack

### Backend (API)
| Layer         | Technology                | Purpose                                                          |
| ------------- | ------------------------- | ---------------------------------------------------------------- |
| **Runtime**   | Cloudflare Workers        | Global edge deployment (6 specialized workers + optional Router) |
| **Framework** | Hono                      | Fast, lightweight web framework                                  |
| **Build**     | Turborepo + pnpm          | Monorepo, parallel builds, caching                               |
| **Storage**   | KV / D1 / Durable Objects | Flexible data persistence (4 DO types)                           |
| **Crypto**    | JOSE                      | JWT/JWK standards (RS256)                                        |
| **Language**  | TypeScript                | Type safety, great DX                                            |
| **Routing**   | Service Bindings / Routes | Unified endpoint (test/prod modes)                               |

### Frontend (UI)
| Layer          | Technology       | Purpose                                     |
| -------------- | ---------------- | ------------------------------------------- |
| **Framework**  | SvelteKit v5     | Modern reactive framework with SSR          |
| **Deployment** | Cloudflare Pages | Global CDN, automatic deployments           |
| **CSS**        | UnoCSS           | Lightweight utility-first (3.10 KB gzipped) |
| **Components** | Melt UI          | Headless, accessible UI components          |
| **Icons**      | Lucide Svelte    | Beautiful, consistent icons                 |
| **i18n**       | Paraglide        | Type-safe internationalization (EN/JA)      |
| **Language**   | TypeScript       | Full type safety across UI                  |

### 🔥 Durable Objects Architecture

Authrim leverages **Cloudflare Durable Objects** for stateful operations with strong consistency guarantees:

| Durable Object             | Purpose                 | Key Features                                                         |
| -------------------------- | ----------------------- | -------------------------------------------------------------------- |
| **SessionStore**           | User session management | Hot/cold storage pattern, multi-device support, instant invalidation |
| **AuthorizationCodeStore** | OAuth code lifecycle    | One-time use, PKCE validation, replay attack prevention              |
| **RefreshTokenRotator**    | Token rotation          | Atomic rotation, theft detection, audit logging                      |
| **KeyManager**             | Cryptographic keys      | JWK management, automatic key rotation, secure storage               |

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

### ⏳ Phase 6 (In Progress)

**Phase 6: Enterprise Features & Advanced Flows** (Jun-Oct 2026)

**Goal:** Enterprise-grade authentication flows and integrations

**✅ Completed Features (Nov 2025):**
- ✅ **Device Flow (RFC 8628)** - Smart TV, CLI, IoT device authentication (70 tests passing)
- ✅ **JWT Bearer Flow (RFC 7523)** - Service-to-service authentication without user interaction
- ✅ **JWE (RFC 7516)** - JSON Web Encryption for ID Token and UserInfo responses
- 📚 **Documentation** - Comprehensive Device Flow guide with examples and security considerations

**🔄 Planned Features:**
- 🏢 **Hybrid Flow** - OIDC Core 3.3 hybrid response types
- 🔐 **CIBA** - Client Initiated Backchannel Authentication
- 🌐 **Social Login** - Google, GitHub, Microsoft, Apple, Facebook, Twitter, LinkedIn (7+ providers)
- 🔗 **Enterprise Integration** - SAML 2.0 bridge, LDAP/AD, SCIM 2.0 provisioning
- 🎨 **Visual Flow Builder** - SimCity-inspired drag & drop authentication flow constructor
- 🧩 **WebSDK** - Highly customizable Web Components for login/registration
- ✅ **Compliance** - GDPR automation, Risk-based authentication, ABAC

**Why This Matters:**
- Enables enterprise adoption with required authentication methods
- Provides flexibility for complex authentication scenarios
- Ensures regulatory compliance (GDPR, SOC 2, ISO 27001)

[📖 Device Flow Documentation](./docs/features/device-flow.md)

### 🆕 Planned (Phase 7-9)

**Phase 7: Verifiable Credentials & Next-Gen** (Nov 2026 - Jan 2027)
- 🆔 Verifiable Credentials (OpenID4VP/CI/IA, W3C VC support, DID resolution)
- 🌐 OpenID Federation 1.0
- 🔮 OAuth 2.1 compliance
- 🔒 Ephemeral Identity & differential privacy
- 📱 Mobile SDKs (iOS, Android, React Native, Flutter)
- 📊 GraphQL API & Infrastructure as Code (Terraform, Helm, Pulumi)

**Phase 8: SaaS Platform** (Feb 2027+)
- 🌐 Multi-tenant architecture with custom domains
- 💰 Billing & monetization (Stripe integration, usage metering)
- 🛒 Plugin marketplace & revenue sharing
- 🏷️ White-label customization

**Phase 9: CLI & Production Launch** (TBD - Final Phase)
- 📦 `create-authrim` NPM package (one-command deployment)
- 🚀 Cloudflare integration (automatic Worker/KV/D1/DO setup)
- 🛠️ Management CLI (20+ commands for users, clients, keys)
- ✅ OpenID Certification submission & approval
- 🌍 Production deployment (`https://id.authrim.org`)
- 📣 Public announcement & migration guides

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
git clone https://github.com/sgrastar/authrim.git
cd authrim

# 2. Install dependencies (monorepo setup)
pnpm install

# 3. Create configuration file (interactive)
./scripts/setup-config.sh

# 4. Build and deploy based on configuration
./scripts/build.sh --config authrim-config-1.0.0.json

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
git clone https://github.com/sgrastar/authrim.git
cd authrim

# 2. Install dependencies (monorepo setup)
pnpm install

# 3. Generate RSA keys (shared across all environments)
./scripts/setup-keys.sh

# 4. Generate environment-specific wrangler.toml files
# For local development:
./scripts/setup-local-wrangler.sh --env=dev

# OR for remote deployment:
./scripts/setup-remote-wrangler.sh \
  --env=dev \
  --domain=https://dev-auth.yourdomain.com \
  --mode=test

# 5. Set up environment-specific KV namespaces
./scripts/setup-kv.sh --env=dev

# 6. Set up environment-specific D1 database
./scripts/setup-d1.sh --env=dev

# 7. Build all packages
pnpm run build

# 8. Start all workers in parallel (development mode)
pnpm run dev

# For remote deployment:
# Deploy to specific environment (including Durable Objects automatically)
pnpm run deploy -- --env=dev
# - Deploys dev-authrim-shared (Durable Objects) first
# - Then deploys other workers sequentially
# - Includes retry logic and rate limit protection

# 9. Optional: Deploy UI to Cloudflare Pages
./scripts/deploy-remote-ui.sh
# - Builds and deploys SvelteKit UI
# - Configures CORS automatically
# - Provides login/registration interface

# Local workers start at:
# - op-discovery: http://localhost:8787
# - op-auth: http://localhost:8788
# - op-token: http://localhost:8789
# - op-userinfo: http://localhost:8790
# - op-management: http://localhost:8791
# - router: http://localhost:8786 (optional, for unified endpoint)
```

> **Note:** Authrim uses a monorepo structure with 5 specialized workers plus an optional Router Worker for unified endpoint access. See [WORKERS.md](./WORKERS.md) and [docs/ROUTER_SETUP.md](./docs/ROUTER_SETUP.md) for architecture details.

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

| Milestone            | Date       | Status     | Description                                       |
| -------------------- | ---------- | ---------- | ------------------------------------------------- |
| **M1: Foundation**   | 2025-12-15 | ✅ Complete | Project setup, tooling                            |
| **M2: Core API**     | 2026-01-31 | ✅ Complete | All OIDC endpoints                                |
| **M3: Conformance**  | 2026-03-15 | ✅ Complete | OpenID testing (95.8% Phase 3)                    |
| **M4: Extensions**   | 2026-04-30 | ✅ Complete | Dynamic registration, PAR, DPoP                   |
| **M5: UI/UX**        | 2026-05-31 | ✅ Complete | Full-stack implementation + testing               |
| **M6: Enterprise**   | 2026-10-31 | 🏢 Planned  | Advanced flows, social login, SAML, LDAP, SCIM    |
| **M7: Next-Gen**     | 2027-01-31 | 🚀 Planned  | Verifiable Credentials, OAuth 2.1, Mobile SDKs    |
| **M8: SaaS**         | 2027+      | 🌐 Planned  | Multi-tenant platform, Billing, Marketplace       |
| **M9: CLI & Launch** | TBD        | 🎓 Final    | One-command deployment, Certification, Production |

### Test Results

```
✓ 400+ unit tests passing (backend, Durable Objects, UI components)
✓ 19 E2E tests passing (Playwright)
✓ 5 pages tested for accessibility (WCAG 2.1 AA, zero violations)
✓ Lighthouse Performance: 100 (LCP: 0.11s - exceptional)

Coverage:
- Backend API: 378+ tests
- Durable Objects: 54 tests
- UI Components: 11+ tests
- E2E Flows: 19 tests
- Total: 400+ tests passing
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

Authrim implements security best practices:

- ✅ **PKCE** (Proof Key for Code Exchange) - RFC 7636
- ✅ **Single-use authorization codes** - Replay attack prevention
- ✅ **JWT signature verification** - RS256 algorithm
- ✅ **Token expiration** - Configurable TTL
- ✅ **HTTPS-only** - In production
- ✅ **CSRF protection** - State parameter validation
- ✅ **Rate limiting** - Implemented (Phase 4)

**Responsible Disclosure:** security@authrim.org

---

## 🤝 Contributing

Authrim is primarily a solo development project. See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

**What we accept:**
- 🐛 Bug reports via GitHub Issues

**What we don't accept:**
- ❌ Pull requests (development is maintained solely by the original author)

---

## 📜 Specification Compliance

| Specification                              | Status        | Reference                                                          |
| ------------------------------------------ | ------------- | ------------------------------------------------------------------ |
| **OpenID Connect Core 1.0**                | ✅ Implemented | [Spec](https://openid.net/specs/openid-connect-core-1_0.html)      |
| **OpenID Connect Discovery 1.0**           | ✅ Implemented | [Spec](https://openid.net/specs/openid-connect-discovery-1_0.html) |
| **OAuth 2.0 (RFC 6749)**                   | ✅ Implemented | [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)          |
| **PKCE (RFC 7636)**                        | ✅ Implemented | [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)          |
| **JWT (RFC 7519)**                         | ✅ Implemented | [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519)          |
| **JWK (RFC 7517)**                         | ✅ Implemented | [RFC 7517](https://datatracker.ietf.org/doc/html/rfc7517)          |
| **Dynamic Client Registration (RFC 7591)** | ✅ Implemented | [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)          |
| **Session Management**                     | ❌ Not planned | [Spec](https://openid.net/specs/openid-connect-session-1_0.html)   |

---

## 🎯 Conformance Target

**Profile:** OpenID Connect *Basic OP*

**Testing:** OpenID Foundation Conformance Suite

**Goal:** ≥95% conformance score (Phase 3: 95.8% achieved, Overall: 72.7%)

---

## 📦 Deployment

### Quick Deploy to Cloudflare Workers

Deploy Authrim to Cloudflare's global edge network and get a production-ready OpenID Provider with a public URL.

Authrim supports **multiple environments** (dev, staging, prod, or custom names) within a single Cloudflare account. See [DEPLOYMENT.md](./DEPLOYMENT.md) for comprehensive multi-environment setup guide.

```bash
# 1. Install dependencies
pnpm install

# 2. Generate RSA keys (shared across all environments)
./scripts/setup-keys.sh

# 3. Generate environment-specific wrangler.toml files
./scripts/setup-remote-wrangler.sh \
  --env=dev \
  --domain=https://dev-auth.yourdomain.com \
  --mode=test

# 4. Set up environment-specific KV namespaces
./scripts/setup-kv.sh --env=dev

# 5. Set up environment-specific D1 database
./scripts/setup-d1.sh --env=dev

# 6. Upload secrets to environment-specific workers
./scripts/setup-secrets.sh --env=dev

# 7. Build TypeScript
pnpm run build

# 8. Deploy to specific environment
pnpm run deploy -- --env=dev
# This uses deploy-with-retry.sh for sequential deployment with delays
# - Deploys dev-authrim-shared (Durable Objects) first
# - Router Worker is included if wrangler.toml exists (test mode)
# - Router Worker is skipped if wrangler.toml missing (production mode)

# 9. Optional: Deploy UI to Cloudflare Pages
./scripts/deploy-remote-ui.sh
# - Builds and deploys SvelteKit login/registration UI
# - Auto-configures CORS for API integration
```

**Example: Setting up multiple environments**
```bash
# Dev environment
./scripts/setup-remote-wrangler.sh --env=dev --domain=https://dev-auth.example.com --mode=test
./scripts/setup-kv.sh --env=dev
./scripts/setup-d1.sh --env=dev
./scripts/setup-secrets.sh --env=dev
pnpm run deploy -- --env=dev

# Production environment
./scripts/setup-remote-wrangler.sh --env=prod --domain=https://auth.example.com --mode=production
./scripts/setup-kv.sh --env=prod
./scripts/setup-d1.sh --env=prod
./scripts/setup-secrets.sh --env=prod
pnpm run deploy -- --env=prod
```

### Deployment Modes

Authrim supports two deployment modes to ensure OpenID Connect specification compliance:

#### 1️⃣ Test Mode (workers.dev + Router Worker)
- **Unified endpoint**: `https://{env}-authrim.{subdomain}.workers.dev`
- **Use case**: Development, staging, testing environments
- **Pros**: No custom domain needed, OpenID Connect compliant ✅
- **Deploy**: `pnpm run deploy -- --env=dev` (includes Router Worker)
- **Setup**: `./scripts/setup-remote-wrangler.sh --env=dev --domain=https://dev-auth.example.com --mode=test`

**Workers deployed:**
- 🌍 **{env}-authrim-shared** (Durable Objects - deployed first)
- 🌍 **authrim** (unified entry point - Router Worker)
- 🌍 **{env}-authrim-op-discovery**, **{env}-authrim-op-auth**, **{env}-authrim-op-token**, **{env}-authrim-op-userinfo**, **{env}-authrim-op-management**

#### 2️⃣ Production Mode (Custom Domain + Routes)
- **Custom domain**: `https://auth.yourdomain.com`
- **Use case**: Production deployments
- **Pros**: Optimal performance, professional URL
- **Deploy**: `pnpm run deploy -- --env=prod` (Router Worker skipped automatically)
- **Setup**: `./scripts/setup-remote-wrangler.sh --env=prod --domain=https://auth.yourdomain.com --mode=production`
- **Requires**: Cloudflare-managed domain (for Workers)

**Workers deployed:**
- 🌍 **prod-authrim-shared** (Durable Objects - deployed first)
- 🌍 **prod-authrim-op-discovery**, **prod-authrim-op-auth**, **prod-authrim-op-token**, **prod-authrim-op-userinfo**, **prod-authrim-op-management**
- Router Worker is automatically excluded (no wrangler.toml generated in production mode)

> 💡 **Learn more**: See [docs/ROUTER_SETUP.md](./docs/ROUTER_SETUP.md) for detailed architecture and [DEPLOYMENT.md](./DEPLOYMENT.md) for comprehensive multi-environment setup guide.

### Deployment Commands

All deployment commands now use sequential deployment with retry logic to avoid API rate limits:

```bash
# Deploy to specific environment
pnpm run deploy -- --env=dev

# Deploy API only (exclude UI packages)
pnpm run deploy -- --env=prod --api-only

# Deploy to multiple environments
pnpm run deploy -- --env=dev
pnpm run deploy -- --env=staging
pnpm run deploy -- --env=prod
```

**Benefits:**
- ✅ Avoids Cloudflare API rate limits (1,200 requests per 5 minutes)
- ✅ Prevents "Service unavailable" errors (code 7010)
- ✅ Automatic retry with exponential backoff (up to 4 attempts)
- ✅ 10-second delays between deployments
- ✅ Conditional router deployment based on configuration
- ✅ Environment-specific deployments for isolated testing

### UI Deployment (Phase 5+)

For login/registration UI, deploy to Cloudflare Pages after workers are deployed:

```bash
# Deploy login and admin pages
./scripts/deploy-remote-ui.sh
```

**Features:**
- Interactive domain configuration (custom domain or auto-generated Pages.dev URL)
- Automatic CORS configuration with detected UI origins
- Support for deploying login page only, admin page only, or both
- SvelteKit build with optimizations

### Troubleshooting Deployment

If you encounter KV namespace errors during deployment:

```bash
# Reset and recreate all KV namespaces
./scripts/setup-kv.sh --reset

# Then deploy with retry logic
pnpm run deploy
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
npx create-authrim my-idp
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

Apache License 2.0 © 2025 [Yuta Hoshina](https://github.com/sgrastar)

See [LICENSE](./LICENSE) for details.

---

## 💬 Community

- 💼 **GitHub**: [sgrastar/authrim](https://github.com/sgrastar/authrim)
- 🐛 **Issues**: [Report bugs](https://github.com/sgrastar/authrim/issues)
- 💡 **Discussions**: [Feature requests](https://github.com/sgrastar/authrim/discussions)
- 📧 **Email**: yuta@authrim.com

---

> **Authrim** ⚡️ — *Authentication at the edge of everywhere*
>
> **Status:** Phase 2 Complete (Core API) | **Next:** Phase 3 (Conformance Testing)
>
> *From zero to production-ready OpenID Provider in under 5 minutes.* (Goal: Aug 2026)
