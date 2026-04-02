---
project: Authrim
lang: en
date: 2026-02-09
description: "Open Source Identity & Access Platform for the modern web"
type: reference
tags:
  - authrim
  - identity-platform
  - cloudflare-workers
  - oidc
  - oauth2
  - saml
---
# Authrim

> **Open Source Identity & Access Platform for the modern web**

An open-source, serverless **Identity Hub** that combines authentication, authorization, and identity federation on **Cloudflare's global edge network**.

[![Open Source](https://img.shields.io/badge/Open%20Source-Apache%202.0-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2Fsgrastar%2Fauthrim.svg?type=shield)](https://app.fossa.com/projects/git%2Bgithub.com%2Fsgrastar%2Fauthrim?ref=badge_shield)

<table>
<tr>
<td>
<a href="https://openid.net/certification/">
  <img src="./docs/images/openid-certified.jpg" alt="OpenID Certified" height="100">
</a>
</td>
<td>
✓ <a href="https://openid.net/certification/certified-openid-providers-profiles/">OpenID Provider</a> (7 profiles)<br>
✓ <a href="https://openid.net/certification/certified-openid-providers-for-logout-profiles/">Logout Profiles</a> (4 profiles)
</td>
</tr>
</table>

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
npx @authrim/setup
```

[Read the full vision](./docs/VISION.md)

## Quick Start

### Option 1: Using @authrim/setup (Recommended)

```bash
# Interactive setup with Web UI
npx @authrim/setup

# Or CLI mode for terminal-based setup
npx @authrim/setup --cli
```

The setup wizard will guide you through:
- Cloudflare authentication
- Resource provisioning (D1, KV, Queues)
- Key generation
- Worker deployment
- Initial admin creation

### Option 2: Manual Setup (Development)

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

📚 **Full guides:** [Development](./docs/getting-started/development.md) | [Deployment](./docs/getting-started/deployment.md) | [Testing](./docs/getting-started/testing.md) | [Setup CLI](./packages/setup/README.md)

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
| 10    | **SDK & API**                  | 2026-01  | ✅ Complete |
| 11    | Security & QA                  | 2026-Q1  | ⏳ ~50%     |
| 12    | Certification & Release        | 2026-Q1  | 🔜 Final    |

[View detailed roadmap](./docs/ROADMAP.md)

---

## Technical Stack

### Backend (API)

| Layer         | Technology                | Version  | Purpose                            |
| ------------- | ------------------------- | -------- | ---------------------------------- |
| **Runtime**   | Cloudflare Workers        | -        | Global edge deployment             |
| **Framework** | Hono                      | 4.11.x   | Fast, lightweight web framework    |
| **Language**  | TypeScript                | 5.9.x    | Type-safe development              |
| **Build**     | Turbo + pnpm              | 2.x      | Monorepo, parallel builds, caching |
| **Storage**   | KV / D1 / Durable Objects | -        | Flexible data persistence          |
| **Crypto**    | JOSE                      | 6.x      | JWT/JWS/JWE/JWK (RS256, ES256)     |
| **WebAuthn**  | SimpleWebAuthn            | 13.x     | Passkey authentication             |
| **SAML**      | xmldom + pako             | -        | SAML 2.0 XML processing            |
| **Email**     | Resend                    | 6.x      | Magic Link, OTP delivery           |
| **Testing**   | Vitest                    | 4.x      | Unit & integration tests           |

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

| Feature | Status | Test Result / Note |
|---------|--------|------|
| **OpenID Provider** | | |
| Basic OP | ✅ Done | [View Result](https://www.certification.openid.net/plan-detail.html?plan=rC9mDif1jiuFD&public=true) |
| Implicit OP | ✅ Done | [View Result](https://www.certification.openid.net/plan-detail.html?plan=aZHmoBP9mzeH0&public=true) |
| Hybrid OP | ✅ Done | [View Result](https://www.certification.openid.net/plan-detail.html?plan=LKV8BKyTZZbl9&public=true) |
| Config OP (Discovery / JWKS) | ✅ Done | [View Result](https://www.certification.openid.net/plan-detail.html?plan=YVvNf5mprr0Ks&public=true) |
| Dynamic OP | ✅ Done | [`code`](https://www.certification.openid.net/plan-detail.html?plan=dCoXptjFq1VoP&public=true), [`id_token`](https://www.certification.openid.net/plan-detail.html?plan=uogVbOOQsKOur&public=true)<br>[`id_token token`](https://www.certification.openid.net/plan-detail.html?plan=szzLvB2IsMRy7&public=true), [`code id_token`](https://www.certification.openid.net/plan-detail.html?plan=MgbxkrOkg4kVG&public=true)<br>[`code token`](https://www.certification.openid.net/plan-detail.html?plan=WOHqvMoO6XjTG&public=true), [`code id_token token`](https://www.certification.openid.net/plan-detail.html?plan=U04s3T2zYOHCu&public=true) |
| Form Post OP | ✅ Done | [Basic](https://www.certification.openid.net/plan-detail.html?plan=bSTOLyFujxs3m&public=true), [Implicit](https://www.certification.openid.net/plan-detail.html?plan=c31kQmt39zuT0&public=true), [Hybrid](https://www.certification.openid.net/plan-detail.html?plan=cQ3itsQtPgZdP&public=true) |
| 3rd Party-Init OP | ✅ Done | [`code`](https://www.certification.openid.net/plan-detail.html?plan=K6OtyPJ2plwuX&public=true), [`id_token`](https://www.certification.openid.net/plan-detail.html?plan=PlXsATTbxvoUu&public=true)<br>[`id_token token`](https://www.certification.openid.net/plan-detail.html?plan=F4137vXl2vQsU&public=true), [`code id_token`](https://www.certification.openid.net/plan-detail.html?plan=fW9JtNjtIf5Vh&public=true)<br>[`code token`](https://www.certification.openid.net/plan-detail.html?plan=KoOGvJwua3Mix&public=true), [`code id_token token`](https://www.certification.openid.net/plan-detail.html?plan=TXWQFGNUlQ7jD&public=true) |
| Authorization Code Flow + PKCE | ✅ Done | |
| **OpenID Provider Logout Profiles** | | |
| RP-Initiated OP | ✅ Done | [`code`](https://www.certification.openid.net/plan-detail.html?plan=ms8UmTwCsVMg3&public=true), [`id_token`](https://www.certification.openid.net/plan-detail.html?plan=RETZUmMlazyYD&public=true)<br>[`id_token token`](https://www.certification.openid.net/plan-detail.html?plan=9hVLKioECp2aI&public=true), [`code id_token`](https://www.certification.openid.net/plan-detail.html?plan=gtaa7IZIhLdsR&public=true)<br>[`code token`](https://www.certification.openid.net/plan-detail.html?plan=2cDNqDsp9Dbl5&public=true), [`code id_token token`](https://www.certification.openid.net/plan-detail.html?plan=STPR0zraLS31P&public=true) |
| Session OP | ✅ Done | [`code`](https://www.certification.openid.net/plan-detail.html?plan=ULOYyV8BOyoJm&public=true), [`id_token`](https://www.certification.openid.net/plan-detail.html?plan=tF5HaTejrTebE&public=true)<br>[`id_token token`](https://www.certification.openid.net/plan-detail.html?plan=YNhqAS1StLy9o&public=true), [`code id_token`](https://www.certification.openid.net/plan-detail.html?plan=idSiUuXR82ZoR&public=true)<br>[`code token`](https://www.certification.openid.net/plan-detail.html?plan=8n0n6NXFolp3j&public=true), [`code id_token token`](https://www.certification.openid.net/plan-detail.html?plan=JLzoFbwarUXKe&public=true) |
| Front-Channel OP | ✅ Done | [`code`](https://www.certification.openid.net/plan-detail.html?plan=8NmrgZhWbOUAi&public=true), [`id_token`](https://www.certification.openid.net/plan-detail.html?plan=xSEsIAFEPcuUD&public=true)<br>[`id_token token`](https://www.certification.openid.net/plan-detail.html?plan=NxOP0F237Ox26&public=true), [`code id_token`](https://www.certification.openid.net/plan-detail.html?plan=KqcoCop3Dlqmm&public=true)<br>[`code token`](https://www.certification.openid.net/plan-detail.html?plan=0CBRXtKgDBEWn&public=true), [`code id_token token`](https://www.certification.openid.net/plan-detail.html?plan=zTXc1bRXG3fdd&public=true) |
| Back-Channel OP | ✅ Done | [`code`](https://www.certification.openid.net/plan-detail.html?plan=oWIJMYozUYuF6&public=true), [`id_token`](https://www.certification.openid.net/plan-detail.html?plan=62tXUxHRhA569&public=true)<br>[`id_token token`](https://www.certification.openid.net/plan-detail.html?plan=IkAwZzpjQPmaH&public=true), [`code id_token`](https://www.certification.openid.net/plan-detail.html?plan=3cuS6wB3lu8ac&public=true)<br>[`code token`](https://www.certification.openid.net/plan-detail.html?plan=mqyJda2Vz5AeB&public=true), [`code id_token token`](https://www.certification.openid.net/plan-detail.html?plan=RysSDebbnj9UV&public=true) |
| **OpenID Relying Parties** | | |
| Basic RP | ✅ Done | |
| Config RP (Discovery / JWKS) | ✅ Done | |
| Form Post RP | ✅ Done | |
| Front-Channel RP | Not Supported | |
| Hybrid RP | Not Supported | |
| Dynamic RP | Not Supported | |
| 3rd Party-Init RP | Not Supported | |
| **OpenID Relying Parties Logout Profiles** | | |
| Back-Channel RP | ✅ Done | |
| RP-Initiated RP | Not Supported | |
| Session RP | Not Supported | |
| Front-Channel RP | Not Supported | |
| **Advanced Security** | | |
| PAR (RFC 9126) | ✅ Done | |
| DPoP (RFC 9449) | ✅ Done | |
| JAR (RFC 9101) | ✅ Done | |
| JARM | ✅ Done | |
| JWE (RFC 7516) | ✅ Done | |
| Pairwise Subject Identifiers | ✅ Done | |
| NIST SP 800-63-4 (AAL/FAL/IAL) | ✅ Done | Assurance Levels |
| **Token Management** | | |
| JWT Signing (RS256) + Key Rotation | ✅ Done | |
| Refresh Token Rotation | ✅ Done | |
| Token Introspection (RFC 7662) | ✅ Done | |
| Token Revocation (RFC 7009) | ✅ Done | |
| Token Exchange (RFC 8693) | ✅ Done | |
| ID-JAG (draft-ietf-oauth-identity-assertion-authz-grant) | ✅ Done | AI Agent認可 |
| Client Credentials (RFC 6749 §4.4) | ✅ Done | |
| Dynamic Client Registration (RFC 7591) | ✅ Done | |
| **Authentication** | | |
| WebAuthn / Passkey | ✅ Done | |
| Email OTP | ✅ Done | |
| Device Flow (RFC 8628) | ✅ Done | |
| CIBA | ✅ Done | |
| JWT Bearer (RFC 7523) | ✅ Done | |
| **Identity Hub** | | |
| Social Login (7 providers) | ✅ Done | |
| Identity Linking | ✅ Done | |
| PII/Non-PII Separation | ✅ Done | |
| **Authorization** | | |
| RBAC / ABAC / ReBAC | ✅ Done | |
| Real-time Check API | ✅ Done | |
| WebSocket Push | ✅ Done | |
| **Verifiable Credentials** | | |
| OpenID4VP | ✅ Done | |
| OpenID4VCI | ✅ Done | |
| DID (did:web, did:key) | ✅ Done | |
| **Enterprise** | | |
| SCIM 2.0 (RFC 7643/7644) | ✅ Done | |
| SAML 2.0 IdP/SP | ✅ Done | |
| Admin Dashboard | ✅ Done | |
| Multi-language (EN/JA) | ✅ Done | |
| **Tooling** | | |
| Setup CLI (`@authrim/setup`) | ✅ Done | [Documentation](./packages/setup/README.md) |
| **SDK Packages** | | |
| @authrim/core | ✅ Done | v0.1.11 - Platform-agnostic OIDC client |
| @authrim/web | ✅ Done | v0.1.9 - Browser SDK |
| @authrim/server | ✅ Done | v0.1.1 - Server SDK (Express, Hono, etc.) |
| @authrim/sveltekit | ✅ Done | v0.1.2 - SvelteKit integration |
| **Future SDKs** | | |
| @authrim/react | 🔜 Post-v1.0 | React hooks/components |
| @authrim/vue | 🔜 Post-v1.0 | Vue.js integration |
| **Not Supported** | | |
| MTLS (RFC 8705) | — | |
| AD / LDAP | — | |

> **Note:** All "Done" features are implemented and have unit tests. Integration testing and OpenID conformance certification are in progress.
>
> **Not Supported:** MTLS is not available due to Cloudflare Workers TLS termination at edge. AD/LDAP requires TCP sockets not supported in Workers runtime. Use SAML/OIDC federation or SCIM provisioning as alternatives.

---

## SDK Feature Matrix

`@authrim/core` is a platform-agnostic TypeScript library. `@authrim/web` provides browser-specific implementations.

| Feature | Server | Core SDK | Web SDK | Note |
|---------|:------:|:--------:|:-------:|------|
| **Basic OAuth/OIDC** | | | | |
| OIDC Discovery | ✅ | ✅ | ✅ | Auto-discovery from issuer |
| Authorization Code Flow + PKCE | ✅ | ✅ | ✅ | Standard secure flow |
| Silent Auth (iframe) | ✅ | ✅ | ✅ | Session renewal |
| Popup Auth | ✅ | — | ✅ | Browser popup flow |
| Redirect Auth | ✅ | ✅ | ✅ | Standard redirect flow |
| State/Nonce Management | ✅ | ✅ | ✅ | CSRF protection |
| **Direct Auth (Passwordless)** | | | | |
| Passkey (WebAuthn) | ✅ | — | ✅ | Login, SignUp, Register |
| Passkey Conditional UI | ✅ | — | ✅ | Autofill integration |
| Email Code (OTP) | ✅ | — | ✅ | Send, Verify |
| Social Login | ✅ | — | ✅ | Popup + Redirect |
| **Token Management** | | | | |
| Token Storage | ✅ | ✅ | ✅ | Secure storage |
| Token Refresh | ✅ | ✅ | ✅ | Auto-refresh |
| Token Introspection (RFC 7662) | ✅ | ✅ | — | Server-side validation |
| Token Revocation (RFC 7009) | ✅ | ✅ | — | Explicit invalidation |
| Token Exchange (RFC 8693) | ✅ | ✅ | — | Cross-service tokens |
| **Advanced Security** | | | | |
| PAR (RFC 9126) | ✅ | ✅ | — | FAPI 2.0 security baseline |
| DPoP (RFC 9449) | ✅ | ✅ | — | Token binding/proof of possession |
| JAR (RFC 9101) | ✅ | ✅ | — | Signed authorization requests |
| JARM | ✅ | ✅ | — | Signed authorization responses |
| **Client Authentication** | | | | |
| Client Credentials (RFC 6749 §4.4) | ✅ | ✅ | — | M2M auth (Node SDK only) |
| Private Key JWT | ✅ | ✅ | — | client_assertion |
| **Device Flow** | | | | |
| Device Flow (RFC 8628) | ✅ | ✅ | ✅ | CLI/TV/IoT |
| DeviceFlowUI Helper | — | — | ✅ | Events, countdown, QR |
| **Session Management** | | | | |
| Session State Calculator | ✅ | ✅ | — | session_state hash calculation |
| Check Session Iframe | ✅ | — | ✅ | postMessage session check |
| Session Monitor | ✅ | — | ✅ | Periodic session polling |
| **Logout** | | | | |
| RP-Initiated Logout | ✅ | ✅ | ✅ | LogoutHandler / signOut |
| Front-Channel Logout | ✅ | ✅ | ✅ | URL builder + handler |
| Back-Channel Logout | ✅ | ✅ | — | logout_token JWT validation |
| **Utilities** | | | | |
| PKCE Helper | — | ✅ | — | Code verifier/challenge |
| JWT Decode/Validate | — | ✅ | — | Without signature verification |
| Base64url Encode/Decode | — | ✅ | — | Standard encoding |
| Timing-safe Comparison | — | ✅ | — | Security utility |
| **Event System** | | | | |
| Auth Lifecycle Events | — | ✅ | ✅ | Login, logout, token refresh |
| Session Events | — | — | ✅ | Changed, expired |
| **Deferred (Not Implemented)** | | | | |
| JWE | ✅ | — | — | Signing sufficient for most cases |
| CIBA | ✅ | — | — | Specialized use case (PSD2/banking) |
| VC (OpenID4VP/VCI/DID) | ✅ | — | — | Specs still maturing |

### Summary

| SDK | Features Implemented | Primary Use Case |
|-----|---------------------|------------------|
| **@authrim/core** | 26 features | Platform-agnostic (Node.js, Deno, Workers, etc.) |
| **@authrim/web** | 22 features | Browser SPA/PWA with Direct Auth focus |

> **Design Principles:**
> - Core returns "facts" only — UX events are handled by upper SDKs (web/react/svelte)
> - Fail safe — Insecure options require explicit `dangerouslyAllowInsecure` opt-in
> - Respect Discovery — Enforces `require_pushed_authorization_requests` and `require_signed_request_object` flags
> - Security first — Timing-safe comparison, input length validation, JTI replay guidance

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


[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2Fsgrastar%2Fauthrim.svg?type=large)](https://app.fossa.com/projects/git%2Bgithub.com%2Fsgrastar%2Fauthrim?ref=badge_large)

## Community

- **GitHub**: [sgrastar/authrim](https://github.com/sgrastar/authrim)
- **Issues**: [Report bugs](https://github.com/sgrastar/authrim/issues)
- **Discussions**: [Feature requests](https://github.com/sgrastar/authrim/discussions)
- **Email**: yuta@sgrastar.org

---

> **Authrim** — _Identity & Access at the edge of everywhere_
>
> **Status:** Phase 1-10 ✅ Complete | Phase 11 ~50% | Phase 12 🔜 Planned
>
> _From zero to production-ready Identity & Access Platform in under 5 minutes._
>
> ```bash
> npx @authrim/setup
> ```