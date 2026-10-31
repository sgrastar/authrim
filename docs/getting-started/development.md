---
project: Authrim
lang: en
date: 2025-12-27
description: 'This guide will help you set up your development environment for Authrim.'
type: guide
tags:
  - authrim
  - development
---

# Development Guide

This guide will help you set up your development environment for Authrim.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Initial Setup](#initial-setup)
- [Development Workflow](#development-workflow)
- [Project Structure](#project-structure)
- [Available Scripts](#available-scripts)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **Node.js** ≥22.0.0 ([Download](https://nodejs.org/))
- **pnpm** ≥9.0.0 ([Install](https://pnpm.io/installation))
- **Git** ([Download](https://git-scm.com/))

Local development mode runs on **macOS, Linux and WSL**. Native Windows is not supported: `init`,
`up` and `reset` stop with an error before doing anything. On Windows, install WSL
(`wsl --install`), clone Authrim inside the WSL file system and run every command from the WSL
shell. (Local mode starts wrangler and Vite as process groups so that stopping it also stops the
processes behind `pnpm exec`, which native Windows cannot do.)

A Cloudflare account is **not** required: local development runs every Worker under
`wrangler dev` with Miniflare's local D1, KV and Durable Objects.

## Initial Setup

```bash
git clone https://github.com/sgrastar/authrim.git
cd authrim
pnpm install

pnpm setup:local init     # keys, Wrangler configs, local databases and seed data (about a minute)
pnpm dev                  # = pnpm setup:local up
```

Every `pnpm setup:local ...`, `pnpm dev` and `pnpm setup:local-smoke` first runs
`pnpm setup:bootstrap` (a cached `turbo run build` of the packages the setup CLI imports, such as
`ar-lib-core`), so the commands work straight after `pnpm install`. The first run builds those
packages; later runs are skipped by the Turbo cache.

`pnpm dev` starts all Workers (one `wrangler dev` session, so Service Bindings and Durable
Objects work across Workers) and the Login and Admin UI dev servers. The API and the two UIs
each have their own `http://localhost` port:

| URL                                                      | What                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `http://localhost:8787/.well-known/openid-configuration` | Discovery (issuer `http://localhost:8787`)                  |
| `http://localhost:5173/login`                            | Login UI (Vite dev server, hot reload)                      |
| `http://localhost:5174/admin/info`                       | Admin UI (Vite dev server, hot reload)                      |
| `http://localhost:8787/admin-init-setup?token=...`       | Create the first administrator (the URL is printed by `up`) |

Why three ports: each Vite dev server serves its modules and hot-reload socket from root-relative
paths (`/@fs/...`, `/@vite/client`), and both UIs use the same paths, so neither can be mounted
behind the router or share an origin with the other. Browsers treat `localhost` ports as one
site, so cookies set by the API (`SameSite=Lax`) are sent from the UIs, and the Login UI reaches
the API through its own `/api` proxy. The router does not proxy the UIs in local mode. To start an
OAuth flow in a browser, open an `/authorize` URL of the API; it sends you to the Login UI. Open
`http://localhost:8787/logout` to confirm and end the browser session.

> `pnpm setup` is a built-in pnpm command, so the setup CLI is run as `pnpm setup:local ...`
> (or `pnpm run setup local ...`).

### Commands

```bash
pnpm setup:local init [--env local] [--port 8787] [--login-ui-port 5173] [--admin-ui-port 5174]
                      [--admin-ui legacy|console] [--tenant default]
pnpm setup:local up   [--env local] [--only auth,token] [--no-ui]
pnpm setup:local reset [--env local]       # delete the local environment and rebuild it
pnpm setup:local-smoke                     # sign in (passkey and email code) and run the code flow
```

- `--only` narrows the Workers that run. `ar-lib-core` (the Durable Object host) and `ar-router`
  are always included, and `ar-control` is added whenever `ar-management` runs.
- Generated files, all git-ignored: `.authrim-local/<env>/` (keys, Miniflare state, logs),
  `packages/*/wrangler.local.<env>.toml` and `packages/*/.dev.vars.<env>`. Both names carry the
  environment, so several environments can exist side by side and `reset` removes only its own
  files. They are regenerated from the same code that produces Cloudflare deployments; do not
  edit them. Cloudflare environments under `.authrim/` are never touched.
- One command at a time per environment: `init`, `up` and `reset` take a lock
  (`.authrim-local/<env>.lock/`, one entry file per process, named with its PID). A second `up`,
  or a `reset` while `up` is running, stops with a message naming the process that holds it.
  Entries of processes that no longer exist are removed automatically. Whether the owner exists
  is decided by its PID alone. If an unrelated process reuses that PID after a crash, the stale
  entry keeps blocking (never the other way round: start times are not used to declare an entry
  stale, since a clock correction can change them for a live process). The error then prints the
  entry's path together with the start time recorded in it and the current start time of that PID,
  as a hint. After checking that the process it names is really gone, delete the file
  (`rm .authrim-local/<env>.lock/<entry>`).
- `up` checks before starting that the three ports are distinct and free, waits until each UI
  answers, and stops everything with an error if a Worker session or a UI dev server exits. Ctrl+C
  during startup stops what has started and starts nothing further.
  Two environments running at the same time need different ports (`init --port ... --login-ui-port
... --admin-ui-port ...`).
- Edit the code and the Workers reload. `local up` re-signs the local registries when they are
  older than 12 hours; restart `up` after a long idle session.

### Signing in locally

- **Passkeys** work on `http://localhost` (relying party ID `localhost`).
- **Email codes, magic links and other notifications** are written to the Worker log instead of
  being sent, by the local-only `notifier-log` provider that `local init` installs for every
  channel. Read them with `grep LOCAL-NOTIFICATION .authrim-local/local/logs/workers.log`.
  The log line contains the one-time code itself, which is acceptable only on your own machine.
  The provider is registered in the plugin runner only when the deployment sets
  `AUTHRIM_LOCAL_NOTIFICATION_LOG=true`, which setup emits for local development and never for a
  Cloudflare deployment, and it cannot be selected through the Admin API or Admin UI.

### What is different from a deployed environment

- The Control Worker (`ar-control`) runs, but without Cloudflare credentials and without cron
  triggers. Setup seeds the Control tables and signs the runtime, Lookup and plugin-runner
  registries directly (`local up` refreshes them). Anything that needs the Cloudflare API is not
  available and fails: provisioning new D1 databases or capacity, tenant creation that needs a
  new database, release-migration rollout, Worker inventory and bootstrap-handoff verification,
  and tenant backup (the backup key is deliberately not configured, so settings changes are not
  gated on a backup permit).
- No queues, R2 buckets or cron triggers; Durable Objects, D1 and KV are local files.
- `HTTPS_REDIRECT_ONLY=false`: the Login UI client registers `http://localhost` redirect URIs.
- Wrangler never talks to Cloudflare, so `wrangler login` is not needed.

## Development Workflow

### Testing Endpoints

```bash
curl http://localhost:8787/.well-known/openid-configuration | jq
curl http://localhost:8787/.well-known/jwks.json | jq
```

### Code Quality

Before committing, run:

```bash
pnpm run test           # Run tests
pnpm run lint           # Run ESLint
pnpm run typecheck      # TypeScript type checking
pnpm run format:check   # Check formatting
```

## Project Structure

```
authrim/
├── packages/
│   ├── ar-lib-core/      # Shared utilities, types, Durable Objects
│   ├── ar-discovery/     # Discovery & JWKS endpoints
│   ├── ar-auth/          # Authorization & consent
│   ├── ar-token/         # Token endpoint
│   ├── ar-userinfo/      # UserInfo endpoint
│   ├── ar-management/    # Admin API & client registration
│   ├── ar-async/         # Device Flow & CIBA
│   ├── ar-saml/          # SAML IdP/SP
│   ├── ar-policy/        # Policy evaluation service (ReBAC)
│   ├── ar-bridge/        # External IdP integration
│   ├── ar-vc/            # Verifiable Credentials
│   ├── ar-router/        # Unified router (test/dev)
│   └── ar-ui/            # SvelteKit frontend
├── scripts/              # Setup & deployment scripts
├── migrations/           # D1 database migrations
├── load-testing/         # Performance benchmarks
└── docs/                 # Documentation
```

### Worker Overview

| Worker            | Purpose         | Endpoints                                             |
| ----------------- | --------------- | ----------------------------------------------------- |
| **ar-discovery**  | OIDC Discovery  | `/.well-known/*`                                      |
| **ar-auth**       | Authorization   | `/authorize`, `/consent`, `/setup`                    |
| **ar-token**      | Token issuance  | `/token`                                              |
| **ar-userinfo**   | User info       | `/userinfo`                                           |
| **ar-management** | Admin API       | `/api/admin/*`, `/register`, `/introspect`, `/revoke` |
| **ar-async**      | Async flows     | `/device_authorization`, `/bc-authorize`              |
| **ar-policy**     | Policy (ReBAC)  | `/api/policy/*`                                       |
| **ar-router**     | Request routing | All (test mode only)                                  |

## Available Scripts

### Development

```bash
pnpm run dev              # Start the local environment (pnpm setup:local up)
pnpm run build            # Build all packages
pnpm run build:api        # Build API workers only (exclude UI)
```

### Testing

```bash
pnpm run test             # Run unit tests
pnpm run test:e2e         # Run E2E tests (Playwright)
pnpm run test:e2e:ui      # Run E2E tests with UI
pnpm run test:lighthouse  # Run Lighthouse performance tests
```

### Code Quality

```bash
pnpm run lint             # Run ESLint
pnpm run typecheck        # TypeScript type checking
pnpm run format           # Format code with Prettier
pnpm run format:check     # Check code formatting
```

### Deployment

```bash
pnpm run deploy           # Deploy workers with retry logic
pnpm run deploy:ui        # Deploy UI Workers with static assets
pnpm run deploy:all       # Deploy everything
```

### Database

```bash
pnpm run migrate:create <name>   # Create new migration file
```

For applying migrations:

```bash
wrangler d1 migrations list authrim-db
wrangler d1 migrations apply authrim-db
```

## Troubleshooting

### A port is already in use

`pnpm dev` refuses to start when 8787 (API), 5173 (Login UI) or 5174 (Admin UI) is taken, and
names the port. Free it, or move the environment:

```bash
# Stop whatever is using the port...
lsof -ti:8787 | xargs kill -9

# ...or create the environment on other ports (the issuer URL contains the API port)
pnpm setup:local reset   # only needed if "local" already exists
rm -rf .authrim-local/local && pnpm setup:local init --port 8788 --login-ui-port 5183 --admin-ui-port 5184
```

### The environment is in a broken state

```bash
pnpm setup:local reset
```

`reset` refuses to run while `local up` is running (stop it with Ctrl+C first).

### Where are the logs?

`.authrim-local/local/logs/` holds `workers.log` (all Workers, including notifications),
`ar-login-ui.log`, `ar-admin-ui.log` and `build.log`.

### TypeScript errors

```bash
pnpm run typecheck
```

### esbuild platform mismatch (WSL)

If you see `@esbuild/win32-x64` vs `@esbuild/linux-x64` errors:

```bash
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

Always install dependencies in the environment where you run the code.

### Inspect local data

```bash
# KV and D1 live in .authrim-local/<env>/state (Miniflare). Use the generated seed config:
npx wrangler kv key list --binding SETTINGS --local \
  --persist-to .authrim-local/local/state -c .authrim-local/local/seed/wrangler.toml
npx wrangler d1 execute DB_ADMIN --local --persist-to .authrim-local/local/state \
  -c .authrim-local/local/seed/wrangler.toml --command "SELECT name FROM sqlite_master"
```

## Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Hono Documentation](https://hono.dev/)
- [OpenID Connect Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [OAuth 2.0 RFC 6749](https://tools.ietf.org/html/rfc6749)

---

Happy coding! 🚀
