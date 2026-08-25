# Authrim

> **Open Source Identity & Access Platform for the modern web**

An open-source, serverless **Identity Hub** that combines authentication, authorization, and identity federation on **Cloudflare's global edge network**.

[![Open Source](https://img.shields.io/badge/Open%20Source-Apache%202.0-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![FOSSA Status](https://app.fossa.com/api/projects/git%2Bgithub.com%2Fsgrastar%2Fauthrim.svg?type=shield)](https://app.fossa.com/projects/git%2Bgithub.com%2Fsgrastar%2Fauthrim?ref=badge_shield)

<table style="border:none">
<tbody><tr style="border:none">
<td style="border:none">
<a href="https://openid.net/certification/">
  <img src="https://github.com/sgrastar/authrim/raw/main/docs/images/openid-certified.jpg" alt="OpenID Certified" height="100">
</a>
</td>
<td style="font-size:75%;border:none">
✓ <a href="https://openid.net/certification/certified-openid-providers-profiles/">OpenID Provider &amp; Profiles</a> (7 profiles)<br>
✓ <a href="https://openid.net/certification/certified-openid-providers-for-logout-profiles/">OpenID Provider Logout Profiles</a> (4 profiles)<br>
✓ <a href="https://openid.net/certification/certified-openid-relying-parties-profiles/">OpenID Relying Parties &amp; Profiles</a> (4 profiles)<br>
✓ <a href="https://openid.net/certification/certified-openid-relying-parties-logout-profiles/">OpenID Relying Parties &amp; Logout Profiles</a> (2 profiles)<br>
✓ <a href="https://openid.net/certification/certified-fapi-2-0-op-security-profile-final-message-signing-final/">FAPI 2.0 OP &amp; Message Signing</a> (5 profiles)<br>
✓ <a href="https://openid.net/certification/certified-fapi-2-0-rp-security-profile-final-message-signing-final/">FAPI 2.0 RP &amp; Message Signing</a> (4 profiles)<br>
✓ <a href="https://openid.net/certification/certified-fapi-ciba-openid-providers-profiles/">FAPI-CIBA OP</a> (2 profiles)
</td>
</tr>
</tbody></table>

## ⚠️ Pre-1.0 Software

Authrim is functional but pre-1.0. APIs may change, and no formal security audit has been completed yet.
Evaluate thoroughly before production use.
Production hardening is tracked against documented deployment, operations, recovery, auditability, and protocol/security validation criteria in the roadmap.

Authrim is still under active development, and breaking changes, including database schema changes, are expected until at least 0.5.0 and possibly until 1.0.0.


### For Organizations Considering Adoption

Authrim is open source, and we also accept consultations for adoption planning, evaluation, and PoC.

For details, see [Adoption Support and Consultation](./docs/adoption-support.md).

## Vision

**Authrim** is a unified Identity & Access Platform combining:

- **Authentication** — OIDC Provider, Social Login, Passkey, SAML
- **Authorization** — RBAC, ABAC, ReBAC policy engine built-in
- **Identity Federation** — Multiple identity sources into one unified identity

Designed for low-latency edge deployment on Cloudflare Workers.

```bash
npx @authrim/setup
```

[Read the full vision](./docs/VISION.md)

## Quick Start

### Published setup package (Recommended)

```bash
npx @authrim/setup
# Terminal-based setup
npx @authrim/setup --cli
```

The local Web UI guides you through Cloudflare authentication, resource provisioning, key generation,
Worker deployment, optional UI deployment, and initial admin creation.

### From source

```bash
git clone https://github.com/sgrastar/authrim.git
cd authrim
pnpm install
pnpm run setup
```

📚 **Full guides:** [Development](./docs/getting-started/development.md) | [Deployment](./docs/getting-started/deployment.md) | [Testing](./docs/getting-started/testing.md) | [Setup CLI](./packages/setup/README.md)

## Performance

### OIDC benchmarks (December 2025)

K6 Cloud distributed load testing in December 2025 validated the sharded Workers architecture in
use at that time under representative OIDC workloads.

Observed benchmark results include:

- Token-oriented endpoints: **2,500-3,500 RPS** within tested capacity limits
- Full 5-step OAuth login flow: **150 logins/sec** with P95 around 756ms
- CPU time: typically **1-4ms** in the tested scenarios

[View the December 2025 reports](./load-testing/reports/Dec2025/)

### SCIM attribute updates (August 2026)

An August 2026 test of mapped `displayName` updates found:

- Individual PATCH: approximately **13 successful updates/sec** near a 14/sec offer; a no-drop
  14/sec run was not demonstrated.
- Bulk PATCH: **30 updates/sec** completed successfully in a one-minute trial, with P95 request
  latency around 111.5 seconds due to queueing.
- Provisional operating guidance remains **10 updates/sec** until longer soak testing is complete.

[View the August 2026 SCIM report](./load-testing/reports/Aug2026/scim-attribute-update.md)

Capacity depends on workload shape, Cloudflare plan limits, storage usage, sharding configuration,
and test duration. These results are benchmark evidence, not an SLA.

---

## Current Status

Authrim is currently pre-1.0. Core protocol and platform capabilities are implemented, but production hardening is still in progress.

**Target release window:** Summer/Fall 2026

| Area                             | Implementation    | Operational maturity | Notes                                                                                                                                                                                                             |
| -------------------------------- | ----------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenID Provider / RP certification | Complete          | Ready                | Certified OpenID Provider, Session OP, Logout, Relying Party, and Relying Party Logout profiles                                                                                                                   |
| OAuth/OIDC advanced profiles     | Complete          | In progress          | PAR, DPoP, JAR, JARM, JWE, claims policy, token exchange, session management, introspection, and revocation; OIDC Session Management is covered by the certified Session OP profile, while token exchange is not separately certified |
| FAPI profiles                    | Complete          | Ready                | Certified FAPI 2.0 OP/RP Security Profile, Message Signing, and Client Credentials profiles                                                                                                                       |
| SAML 2.0 IdP/SP                  | Hardening active  | In progress          | Tenant-scoped IdP/SP endpoints, metadata import/export, configurable entityIDs, signing certificate rollover, encryption options, SSO/SLO correlation, and Admin UI operations                                   |
| SCIM 2.0                         | Inbound complete  | In progress          | Users, Groups, and Bulk receiver with Mapping Set-based writes; outbound provisioning is out of scope                                                                                                             |
| Authentication                   | Complete          | In progress          | Passkey, email code, social login, anonymous login and upgrade, Direct Auth, device flow, and CIBA                                                                                                                 |
| CIBA                             | Complete          | Ready                | Certified FAPI-CIBA Poll and Ping profiles using private-key authentication                                                                                                                                        |
| Native SSO                       | Complete          | In progress          | `device_secret`, `ds_hash`, DPoP-bound token exchange, token revocation/introspection, and device management                                                                                                       |
| Authorization                    | Complete          | In progress          | RBAC, ABAC, ReBAC, token embedding, real-time check API, and authorization update push                                                                                                                             |
| Identity Hub                     | Complete          | In progress          | External IdP integration, account linking, identity stitching, and tenant discovery                                                                                                                               |
| Account lifecycle and governance | Baseline complete | In progress          | Durable account lifecycle, identifier replacement, support context, legal holds, retention controls, and email delivery history                                                                                   |
| VC/DID                           | Partial           | Experimental         | OpenID4VCI/OpenID4VP endpoint baselines and did:web/did:key support exist; OpenID4VCI/VP 1.0 + HAIP certification has not been obtained and Suite validation continues |
| JavaScript SDKs                  | Complete          | In progress          | Core, web, server, and SvelteKit packages                                                                                                                                                                         |
| Admin/Login UI                   | Basic complete    | In progress          | Admin operations cover identity, SAML, storage, logging, governance, and Control Plane surfaces; Login UI production-flow hardening continues                                                                     |
| Unified Control Plane            | Basic complete    | In progress          | Signed Runtime Registry and Lookup routes resolve single- or multi-shard D1 assignments with `shared_pool` or `tenant_exclusive` placement                                                                         |
| Setup and release updates        | Baseline complete | In progress          | Setup and Control include resumable database-before-Worker release-operation paths; end-to-end production validation and deployment documentation continue                                                       |
| Runtime storage profiles         | Basic complete    | In progress          | Setup-managed D1/R2 inventory and Hyperdrive-backed user core, PII, custom/extension, and audit paths exist; control-plane storage remains D1/KV-biased                                                          |
| Multi-tenancy isolation          | Baseline complete | In progress          | Tenant-scoped issuer routing, storage access, admin boundaries, job artifacts, and regression coverage are in place                                                                                               |
| Logging and operational evidence | Basic complete    | In progress          | Structured runtime logs, admin/user audit logs, sensitive-detail chunks, delivery events, exports, DLQ replay, retention jobs, and storage-destination controls are implemented                                  |
| Security, QA, and validation     | Active            | In progress          | Security regression matrices and internal review remediation are active; a formal external audit and penetration test have not yet been completed                                                                 |

[View the detailed roadmap](./docs/ROADMAP.md) and [feature matrix](./docs/FEATURES.md).

---

## Technical Stack

### Backend (API)

| Layer          | Technology                             | Version               | Purpose                                                                    |
| ------------- | ------------------------- | -------- | ---------------------------------- |
| **Runtime**    | Cloudflare Workers                     | -                     | Global edge deployment                                                     |
| **Framework**  | Hono                                   | 4.13.x                | Fast, lightweight web framework                                            |
| **Language**   | TypeScript                             | 5.9.x                 | Type-safe development                                                      |
| **Build**      | Turbo + pnpm                           | 2.9.x / 9.x           | Monorepo, parallel builds, caching                                         |
| **Deployment** | Wrangler                               | 4.110.x               | Workers deployment and local runtime                                       |
| **Storage**    | KV / D1 / Durable Objects / Hyperdrive | -                     | Cloudflare-native persistence with external database paths where supported |
| **Crypto**     | JOSE                                   | 6.2.x                 | JWT/JWS/JWE/JWK (RS256, ES256)                                             |
| **WebAuthn**   | SimpleWebAuthn                         | 13.2.x                | Passkey authentication                                                     |
| **SAML**       | xmldom + xml-crypto + pako             | 0.8.x / 6.1.x / 2.1.x | SAML 2.0 XML processing, signatures, and bindings                          |
| **Email**      | Cloudflare Email Sending               | -                     | Workers `send_email` binding for transactional email                       |
| **Email**      | Resend                                 | 6.8.x                 | Magic Link, OTP delivery                                                   |
| **Testing**    | Vitest + Playwright                    | 4.1.x / 1.57.x        | Unit, integration, and E2E tests                                           |

### Frontend (UI)

| Layer          | Technology                                         | Version            | Purpose                                                     |
| -------------- | ------------------------ | --------- | ------------------------------ |
| **Framework**  | SvelteKit + Svelte                                 | 2.70.x / 5.56.x    | Modern reactive framework                                   |
| **Deployment** | Cloudflare Workers static assets                   | -                  | UI Workers and global edge delivery                         |
| **Build**      | Vite                                               | 7.3.x              | UI build and dev server                                     |
| **CSS**        | UnoCSS                                             | 66.6.x             | Utility-first CSS                                           |
| **Components** | Melt UI                                            | 0.86.x             | Headless, accessible components                             |
| **Icons**      | UnoCSS preset-icons + Iconify Heroicons / Phosphor | 66.6.x / 1.2.x     | Utility icon classes and selectable Login UI provider icons |
| **i18n**       | typesafe-i18n                                      | 5.26.x             | Type-safe internationalization                              |
| **WebAuthn**   | SimpleWebAuthn Browser                             | 13.2.x             | Client-side passkey support                                 |
| **Testing**    | Vitest + Testing Library                           | 4.1.x / 5.2.x-next | Component tests                                             |

## Approximate Cloudflare Cost (December 2025 Reference)

⚠️ The following estimates use the workload assumptions and Cloudflare pricing considered for the
December 2025 benchmark. They are historical reference values, not current quotes. Actual costs
depend on request volume, CPU time, and usage of KV, D1, Durable Objects, and R2.

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

### December 2025 assumptions

- Workers Paid plan base fee used in the estimate: $5/month
- Optimized request patterns (caching, batching)
- Typical authentication flows (OIDC, token refresh)
- Excludes large R2 storage and excessive KV/D1 writes
- Assumes ~20% DAU with weekly logins
- Authrim scales primarily with **requests and CPU time**, not with user count

### December 2025 benchmark estimate

| Metric                 | Value                 | Cost         |
| ---------------------- | --------------------- | ------------ |
| Workers Requests       | 18M/month             | $5.70 (7%)   |
| KV Reads               | 78M/month             | $39.00 (44%) |
| DO Requests + Duration | 64M/month             | $22.10 (25%) |
| D1 Writes              | 6.8M rows             | $7.00 (8%)   |
| Base fee               | —                     | $5.00 (6%)   |
| **Total (excl. tax)**  | **≈ 5M users equiv.** | **$79.78**   |

**Request-to-user conversion used in the estimate:**

- 1 OIDC login ≈ 4 requests (authorize → token → userinfo → discovery)
- 18M requests ≈ 4.5M logins/month
- With 20% DAU and weekly login assumption → **~5M total users equivalent**

> Infrastructure cost only (self-hosted). Check the current Cloudflare pricing for
> [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
> [D1](https://developers.cloudflare.com/d1/platform/pricing/),
> [Workers KV](https://developers.cloudflare.com/kv/platform/pricing/), and
> [R2](https://developers.cloudflare.com/r2/pricing/) before estimating a deployment.

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
