# Authrim

> **Open Source Identity & Access Platform for the modern web**

An open-source, serverless **Identity Hub** that combines authentication, authorization, and identity federation on **Cloudflare's global edge network**.

[![Open Source](https://img.shields.io/badge/Open%20Source-Apache%202.0-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)

## ⚠️ Pre-1.0 Software

Authrim is functional but pre-1.0. APIs may change, and no formal security audit has been completed yet.
Evaluate thoroughly before production use.

## Vision

**Authrim** is a unified Identity & Access Platform combining:

- **Authentication** — OIDC Provider, Social Login, Passkey, SAML
- **Authorization** — RBAC, ABAC, ReBAC policy engine built-in
- **Identity Federation** — Multiple identity sources into one unified identity

Built for edge deployment with <50ms latency worldwide.

```bash
# Coming in 2026-Q1
npx create-authrim my-identity-provider
```

[Read the full vision](./docs/VISION.md)

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/sgrastar/authrim.git
cd authrim && pnpm install

# 2. Setup (generates keys, configures local environment)
./scripts/setup-keys.sh
./scripts/setup-local-wrangler.sh
./scripts/setup-kv.sh --env=dev
./scripts/setup-d1.sh

# 3. Run locally
pnpm run dev
# → http://localhost:8787/.well-known/openid-configuration
```

📚 **Full guides:** [Development](./docs/getting-started/development.md) | [Deployment](./docs/getting-started/deployment.md) | [Testing](./docs/getting-started/testing.md)

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

| Metric                 | Value                 | Cost         |
| ---------------------- | --------------------- | ------------ |
| Workers Requests       | 18M/month             | $5.70 (7%)   |
| KV Reads               | 78M/month             | $39.00 (44%) |
| DO Requests + Duration | 64M/month             | $22.10 (25%) |
| D1 Writes              | 6.8M rows             | $7.00 (8%)   |
| Base fee               | —                     | $5.00 (6%)   |
| **Total (excl. tax)**  | **≈ 5M users equiv.** | **$79.78**   |

**Request-to-User conversion:**

- 1 OIDC login ≈ 4 requests (authorize → token → userinfo → discovery)
- 18M requests ≈ 4.5M logins/month
- With 20% DAU and weekly login assumption → **~5M total users equivalent**

> Infrastructure cost only (self-hosted). No vendor fees. See [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/) for details.

---

## Current Status

| Phase | Name                           | Timeline | Status      |
| ----- | ------------------------------ | -------- | ----------- |
| 1-5   | Foundation, Core API, UI/UX    | 2025-11  | ✅ Complete |
| 6     | Enterprise Features            | 2025-12  | ✅ Complete |
| 7     | **Identity Hub Foundation**    | 2025-12  | ✅ Complete |
| 8     | **Unified Policy Integration** | 2025-12  | ✅ Complete |
| 9     | **Advanced Identity (VC/DID)** | 2025-12  | ✅ Complete |
| 10    | SDK & API                      | 2025-Q4  | 🔜 Planned  |
| 11    | Security & QA                  | 2025-Q4  | ⏳ ~20%     |
| 12    | Certification & Release        | 2026-Q1  | 🔜 Final    |

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

## Features

| Feature | Status |
|---------|--------|
| **Core OIDC** | |
| OpenID Connect Core 1.0 | ✅ Done |
| Authorization Code Flow + PKCE | ✅ Done |
| Hybrid Flow | ✅ Done |
| Discovery / JWKS | ✅ Done |
| JWT Signing (RS256) + Key Rotation | ✅ Done |
| **Advanced Security** | |
| PAR (RFC 9126) | ✅ Done |
| DPoP (RFC 9449) | ✅ Done |
| JAR (RFC 9101) | ✅ Done |
| JARM | ✅ Done |
| JWE (RFC 7516) | ✅ Done |
| Pairwise Subject Identifiers | ✅ Done |
| **Token Management** | |
| Refresh Token Rotation | ✅ Done |
| Token Introspection (RFC 7662) | ✅ Done |
| Token Revocation (RFC 7009) | ✅ Done |
| Dynamic Client Registration (RFC 7591) | ✅ Done |
| **Authentication** | |
| WebAuthn / Passkey | ✅ Done |
| Email OTP | ✅ Done |
| Device Flow (RFC 8628) | ✅ Done |
| CIBA | ✅ Done |
| JWT Bearer (RFC 7523) | ✅ Done |
| **Identity Hub** | |
| Social Login (7 providers) | ✅ Done |
| RP Module (OIDC/OAuth 2.0) | ✅ Done |
| Identity Linking | ✅ Done |
| PII/Non-PII Separation | ✅ Done |
| **Authorization** | |
| RBAC / ABAC / ReBAC | ✅ Done |
| Real-time Check API | ✅ Done |
| WebSocket Push | ✅ Done |
| **Verifiable Credentials** | |
| OpenID4VP | ✅ Done |
| OpenID4VCI | ✅ Done |
| DID (did:web, did:key) | ✅ Done |
| **Enterprise** | |
| SCIM 2.0 (RFC 7643/7644) | ✅ Done |
| SAML 2.0 IdP/SP | ✅ Done |
| Admin Dashboard | ✅ Done |
| Multi-language (EN/JA) | ✅ Done |
| **Roadmap** | |
| WebSDK | Planned |
| CLI (`create-authrim`) | Planned |
| OpenID Certification | Planned |
| **Not Supported** | |
| MTLS (RFC 8705) | — |
| AD / LDAP | — |

> **Note:** All "Done" features are implemented and have unit tests. Integration testing and OpenID conformance certification are in progress.
>
> **Not Supported:** MTLS is not available due to Cloudflare Workers TLS termination at edge. AD/LDAP requires TCP sockets not supported in Workers runtime. Use SAML/OIDC federation or SCIM provisioning as alternatives.

---

## Contributing

Authrim is open source under Apache 2.0, currently maintained by a single author.

- 🐛 **Bug reports** — Welcome via [GitHub Issues](https://github.com/sgrastar/authrim/issues)
- 💡 **Feature requests** — Welcome via [GitHub Discussions](https://github.com/sgrastar/authrim/discussions)
- 🔧 **Pull requests** — Not accepted at this time (see [CONTRIBUTING.md](./CONTRIBUTING.md) for details)

---

## License

Apache License 2.0 © 2025 [Yuta Hoshina](https://github.com/sgrastar)

See [LICENSE](./LICENSE) for details.

---

## Community

- **GitHub**: [sgrastar/authrim](https://github.com/sgrastar/authrim)
- **Issues**: [Report bugs](https://github.com/sgrastar/authrim/issues)
- **Discussions**: [Feature requests](https://github.com/sgrastar/authrim/discussions)
- **Email**: yuta@sgrastar.org

---

> **Authrim** — _Identity & Access at the edge of everywhere_
>
> **Status:** Phase 6 ✅ | Phase 7 ✅ | Phase 8 ✅ | Phase 9 ✅ | Phase 11 ~20%
>
> _From zero to production-ready Identity & Access Platform in under 5 minutes._ (Goal: 2026-Q1)
