# hibana 🔥
A lightweight OpenID Connect Provider implemented on **Cloudflare Workers** using **Hono**, **Durable Objects**, and **KV Storage**.  
Designed to demonstrate that a fully compliant OpenID Provider can be deployed and operated even by an individual developer at the Edge.

---

## Overview

**hibana** implements a minimal yet standards-compliant **OpenID Connect (OIDC) Provider** running entirely on Cloudflare’s Edge network.  
It aims to pass the **OpenID Certified™ Basic OP Profile** while remaining small, serverless, and easily maintainable.

---

## Objectives

- Provide a fully functional OpenID Provider using **serverless edge architecture**.  
- Achieve **OIDC Core compliance** sufficient for conformance testing.  
- Enable individuals to deploy and own their own identity issuer (`iss=https://id.<domain>`).  
- Showcase interoperability across OpenID Connect and OAuth 2.0 ecosystems.

---

## Specification Coverage

| Specification | Status | Reference |
|:--|:--|:--|
| **OpenID Connect Core 1.0** | 🚧 *In Progress (utilities ready, endpoints planned for Week 7-9)* | [openid-connect-core-1_0.html](https://openid.net/specs/openid-connect-core-1_0.html) |
| **OpenID Connect Discovery 1.0** | ✅ *Fully implemented (`/.well-known/openid-configuration`)* | [openid-connect-discovery-1_0.html](https://openid.net/specs/openid-connect-discovery-1_0.html) |
| **OpenID Connect Dynamic Client Registration 1.0** | 🚧 *Planned (Phase 4)* | [openid-connect-registration-1_0.html](https://openid.net/specs/openid-connect-registration-1_0.html) |
| **OpenID Connect Session Management 1.0** | ❌ *Not planned for initial release* | [openid-connect-session-1_0.html](https://openid.net/specs/openid-connect-session-1_0.html) |
| **RFC 7517 / 7519** – JSON Web Key / JSON Web Token | ✅ *Implemented via JOSE (RS256 signing)* | [RFC 7517](https://datatracker.ietf.org/doc/html/rfc7517), [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519) |
| **RFC 6749 / 6750** – OAuth 2.0 Authorization Framework | 🚧 *Utilities ready, endpoints in progress* | [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749), [RFC 6750](https://datatracker.ietf.org/doc/html/rfc6750) |

---

## Supported Endpoints

| Endpoint | Description | Status |
|:--|:--|:--|
| `/.well-known/openid-configuration` | Discovery document | ✅ Implemented |
| `/.well-known/jwks.json` | Public JSON Web Key Set | ✅ Implemented |
| `/authorize` | Authorization endpoint (code flow) | 🚧 Planned (Week 7) |
| `/token` | Token endpoint (ID token + access token) | 🚧 Planned (Week 8) |
| `/userinfo` | UserInfo endpoint (static user data) | 🚧 Planned (Week 9) |
| `/register` | Dynamic client registration | 🚧 Planned (Phase 4) |
| `/check_session_iframe` | Session management | ❌ Not yet implemented |

---

## Technical Stack

| Layer | Technology |
|:--|:--|
| Edge Runtime | **Cloudflare Workers** |
| Web Framework | **Hono** |
| Data Storage | **Cloudflare KV** (state, nonce, code) |
| Key Management | **Durable Objects / Secrets** |
| Signing Library | **jose (RS256 / ES256)** |
| Infrastructure | **wrangler.toml**, automatic TLS by Cloudflare |

---

## Current Features

- RFC-compliant **JWT / JWS signing**
- **OIDC Discovery** and **JWKS exposure**
- **Authorization Code Flow** with `state` validation
- **Minimal stateless design**
- Ready for **OpenID Conformance Suite** Basic OP testing

---

## Planned Features

- Dynamic Client Registration endpoint (`/register`)
- Session Management (check_session_iframe)
- Rotating JWKS keys using Durable Objects
- Extended claim support (email, profile)
- Public OP Conformance certification submission

---

## Getting Started

### For New Contributors

**Recommended Reading Order:**

1. Start with [Documentation Index](./docs/README.md) - Overview of all documentation
2. Read [Project Schedule](./docs/project-management/SCHEDULE.md) - Understand the 6-month timeline
3. Review [Kickoff Checklist](./docs/project-management/KICKOFF.md) - Week 1 setup tasks
4. Check [Technical Specifications](./docs/architecture/technical-specs.md) - Understand the architecture

### For Developers

**Development Setup:**

1. **Clone and Install**
   ```bash
   git clone https://github.com/sgrastar/hibana.git
   cd hibana
   pnpm install
   ```

2. **Configure Cloudflare Workers**
   ```bash
   # Copy example configuration (when available)
   cp wrangler.toml.example wrangler.toml

   # Edit wrangler.toml with your settings
   ```

3. **Start Development Server**
   ```bash
   pnpm dev
   # Server will start at http://localhost:8787
   ```

4. **Set Up GitHub Issue Tracking** (Optional)
   ```bash
   # Create labels, milestones, and issues
   ./scripts/setup-github.sh
   ./scripts/create-phase1-issues.sh
   ```

   See [GitHub Workflow Guide](./docs/project-management/GITHUB_WORKFLOW.md) for details.

### Project Management

This project uses GitHub Issues, Milestones, and Projects for task management:

- **Milestones**: M1-M5 tracking major project phases
- **Labels**: Organized by phase, type, priority, and component
- **Issues**: Week-by-week task tracking with checklists
- **Project Board**: Kanban-style workflow (Backlog → In Progress → Done)

**Quick Links**:
- [View Issues](https://github.com/sgrastar/hibana/issues)
- [View Milestones](https://github.com/sgrastar/hibana/milestones)
- [View Project Board](https://github.com/sgrastar/hibana/projects)

---

## Deployment

```bash
pnpm install
pnpm build
pnpm dlx wrangler publish
```

---

## Environment Variables

| Variable        | Description                                                                        | Example                                                         |
| :-------------- | :--------------------------------------------------------------------------------- | :-------------------------------------------------------------- |
| `PRIVATE_KEY`   | RSA private key in PEM (PKCS#8) format used for signing ID Tokens (RS256).         | `"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"` |
| `STATE_KV`      | Cloudflare KV namespace binding for authorization codes, state, and nonce storage. | `"state-kv-namespace-id"`                                       |
| `ISSUER_DOMAIN` | The public domain representing this OP (used for `iss` and Discovery).             | `"id.example.dev"` (production: `"id.hibana.dev"`)              |
| `JWKS_KID`      | The Key ID (kid) for the JWK published at `/.well-known/jwks.json`.                | `"edge-key-1"`                                                  |
| `TOKEN_TTL`     | Token lifetime in seconds for issued ID tokens.                                    | `600`                                                           |

> All variables can be configured via `wrangler.toml` under `[vars]` or via Cloudflare Dashboard > Workers > Settings > Variables.
> **Note**: In documentation, `id.example.dev` is used for examples. The production deployment will use `id.hibana.dev`.

---

## Conformance Target

* **Profile:** OpenID Connect *Basic OP*
* **Test Suite:** OpenID Foundation Conformance Suite (Docker)
* **Goal:** Pass all **MUST** / **SHOULD** requirements for:

  * OpenID Connect Core 1.0
  * Discovery 1.0
  * OAuth 2.0 (RFC 6749 / 6750)
  * JWK / JWS (RFC 7517 / 7519)
* **Stretch Goals:**

  * Dynamic Client Registration 1.0
  * Session Management 1.0 (check_session_iframe)
  * Form Post response mode

---

## License

MIT License © 2025 [sgrastar](https://github.com/sgrastar)

---

## Acknowledgements

Built with ❤️ using:

* [Hono](https://hono.dev/)
* [Cloudflare Workers](https://developers.cloudflare.com/workers/)
* [JOSE](https://github.com/panva/jose)
* [OpenID Foundation Specifications](https://openid.net/developers/specifications/)

> *hibana* — a spark of identity on the edge.


