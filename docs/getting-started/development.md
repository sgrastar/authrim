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

Before you begin, ensure you have the following installed:

- **Node.js** ≥22.0.0 ([Download](https://nodejs.org/))
- **pnpm** ≥9.0.0 ([Install](https://pnpm.io/installation))
- **Git** ([Download](https://git-scm.com/))
- **Cloudflare account** ([Sign up](https://dash.cloudflare.com/sign-up))

## Initial Setup

### 1. Clone and Install

```bash
# Clone the repository
git clone https://github.com/sgrastar/authrim.git
cd authrim

# Install dependencies
pnpm install

# Login to Cloudflare
wrangler login
```

### 2. Generate Keys

```bash
./scripts/setup-keys.sh
```

This generates:

- `.keys/private.pem` - Private key for JWT signing
- `.keys/public.jwk.json` - Public key in JWK format
- `.keys/metadata.json` - Key metadata including Key ID

### 3. Configure Local Environment

```bash
# Create .dev.vars with environment variables
./scripts/setup-local-vars.sh

# Generate wrangler.toml for local development
./scripts/setup-local-wrangler.sh
```

### 4. Set Up Cloud Resources

```bash
# Create KV namespaces (automatically initializes default settings)
./scripts/setup-kv.sh --env=dev

# Create D1 database
./scripts/setup-d1.sh

# Deploy Durable Objects
./scripts/setup-durable-objects.sh
```

### 5. (Optional) Configure Email

```bash
./scripts/setup-resend.sh --env=local
```

Without Resend, magic links return URLs instead of sending emails (useful for development).

### 6. Start Development Server

```bash
pnpm run dev
```

This starts all workers in development mode. Access endpoints at `http://localhost:8787`.

## Development Workflow

### Quick Start

```bash
pnpm run dev     # Start dev server with hot reload
```

### Testing Endpoints

```bash
# Discovery endpoint
curl http://localhost:8787/.well-known/openid-configuration | jq

# JWKS endpoint
curl http://localhost:8787/.well-known/jwks.json | jq

# Authorization flow
# Navigate to:
# http://localhost:8787/authorize?response_type=code&client_id=test-client&redirect_uri=http://localhost:3000/callback&scope=openid&state=random-state
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
│   ├── shared/           # Shared utilities, types, Durable Objects
│   ├── op-discovery/     # Discovery & JWKS endpoints
│   ├── op-auth/          # Authorization & consent
│   ├── op-token/         # Token endpoint
│   ├── op-userinfo/      # UserInfo endpoint
│   ├── op-management/    # Admin API & client registration
│   ├── op-async/         # Device Flow & CIBA
│   ├── op-saml/          # SAML IdP/SP
│   ├── scim/             # SCIM 2.0 provisioning
│   ├── policy-core/      # Policy engine core
│   ├── policy-service/   # Policy evaluation service
│   ├── external-idp/     # External IdP integration
│   ├── router/           # Unified router (test/dev)
│   └── ui/               # SvelteKit frontend
├── scripts/              # Setup & deployment scripts
├── migrations/           # D1 database migrations
├── load-testing/         # Performance benchmarks
└── docs/                 # Documentation
```

### Worker Overview

| Worker            | Purpose           | Endpoints                                |
| ----------------- | ----------------- | ---------------------------------------- |
| **op-discovery**  | OIDC Discovery    | `/.well-known/*`                         |
| **op-auth**       | Authorization     | `/authorize`, `/consent`                 |
| **op-token**      | Token issuance    | `/token`, `/introspect`, `/revoke`       |
| **op-userinfo**   | User info         | `/userinfo`                              |
| **op-management** | Admin API         | `/api/admin/*`, `/register`              |
| **op-async**      | Async flows       | `/device_authorization`, `/bc-authorize` |
| **scim**          | User provisioning | `/scim/v2/*`                             |
| **router**        | Request routing   | All (development only)                   |

## Available Scripts

### Development

```bash
pnpm run dev              # Start all workers with hot reload
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
pnpm run deploy:ui        # Deploy UI to Cloudflare Pages
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

### Port 8787 already in use

```bash
# Kill the process using the port
lsof -ti:8787 | xargs kill -9

# Or use a different port
wrangler dev --port 8788
```

### KV namespace not found

Ensure KV namespaces are created:

```bash
wrangler kv namespace list
./scripts/setup-kv.sh --env=dev
```

### Private key not found

Regenerate keys:

```bash
./scripts/setup-keys.sh
./scripts/setup-local-vars.sh
```

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

### View logs

```bash
# Development
wrangler dev --log-level debug

# Production
wrangler tail --env production
```

### Inspect KV data

```bash
wrangler kv key list --binding=CLIENTS
wrangler kv key get "key-name" --binding=CLIENTS
```

## Setup Flow Summary

```
setup-keys.sh
    ↓
setup-local-vars.sh
    ↓
setup-local-wrangler.sh
    ↓
setup-kv.sh --env=dev  ← Automatically initializes settings
    ↓
setup-d1.sh + setup-durable-objects.sh
    ↓
setup-resend.sh --env=local (optional)
    ↓
pnpm run dev
```

## Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Hono Documentation](https://hono.dev/)
- [OpenID Connect Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [OAuth 2.0 RFC 6749](https://tools.ietf.org/html/rfc6749)

---

Happy coding! 🚀
