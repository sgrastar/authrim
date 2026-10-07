---
project: Authrim
lang: en
date: 2026-01-05
description: "This guide covers deploying Authrim to Cloudflare Workers for a production-ready OpenID Connect Provider."
type: guide
tags:
  - authrim
  - oidc
  - deployment
  - cloudflare-workers
---
# Deployment Guide

This guide covers deploying Authrim to Cloudflare Workers for a production-ready OpenID Connect Provider.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Environment Types](#environment-types)
- [Quick Deployment](#quick-deployment)
  - [Using @authrim/setup (Recommended)](#using-authrimsetup-recommended)
  - [Manual Deployment](#manual-deployment)
- [Step-by-Step Deployment](#step-by-step-deployment)
- [UI Deployment](#ui-deployment)
- [Verification](#verification)
- [Custom Domain Setup](#custom-domain-setup)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before deploying, ensure you have:

- **Node.js** ≥22.0.0
- **pnpm** ≥9.0.0
- **Cloudflare Account** ([Sign up](https://dash.cloudflare.com/sign-up))
- **Wrangler CLI** authenticated (`wrangler login`)

```bash
# Verify prerequisites
node --version    # v22.x.x
pnpm --version    # 9.x.x
wrangler whoami   # Should show your account
```

---

## Environment Types

Authrim supports environment-specific deployments with naming conventions:

| Environment   | Worker Prefix           | KV Prefix       | Example Issuer URL                 |
| ------------- | ----------------------- | --------------- | ---------------------------------- |
| `dev`         | `dev-authrim-*`         | `dev-*`         | `https://dev-auth.example.com`     |
| `staging`     | `staging-authrim-*`     | `staging-*`     | `https://staging-auth.example.com` |
| `conformance` | `conformance-authrim-*` | `conformance-*` | `https://conformance.example.com`  |
| `prod`        | `authrim-*`             | `*`             | `https://auth.example.com`         |

### Deployment Modes

Every environment that `@authrim/setup` creates serves its public API endpoints through the Router
Worker (`ar-router`), which reaches the other API Workers over Service Bindings. The Router applies
the shared request checks (Origin/CSRF, security headers, bearer-token transport) before any API
Worker sees a request, so the API Workers have no public routes of their own.

The Login UI and Admin UI are served through the Router when they share the API host. A UI on its
own host (`urls.loginUi.sameAsApi` / `urls.adminUi.sameAsApi` set to `false` with a custom domain)
is served by its UI Worker on that host, and its API calls still reach the Router:

- **Login UI:** the browser calls `/api/*` on the Login UI host; the Login UI Worker forwards them
  to the Router over its Service Binding.
- **Admin UI, same site as the API** (for example `admin.example.com` with the API on
  `auth.example.com`): the browser calls the API host directly, with credentialed CORS and the
  Router's Origin/CSRF checks.
- **Admin UI, different site:** the Admin UI Worker acts as a BFF and forwards `/api/*` to the
  Router over its Service Binding; the browser never calls the API host.

#### workers.dev

- Single endpoint: `https://{env}-ar-router.{subdomain}.workers.dev`
- Best for: Development, testing, demos

#### Custom Domain

- The Router owns the custom domain (a Custom Domain binding or a zone route)
- Best for: Production deployments

---

## Quick Deployment

### Using @authrim/setup (Recommended)

The easiest way to deploy Authrim is using the interactive setup CLI:

```bash
# Interactive Web UI
npx @authrim/setup

# Or CLI mode
npx @authrim/setup --cli
```

This handles all the steps below automatically:
- Key generation
- Resource provisioning (D1, KV, Queues)
- Wrangler configuration
- Worker deployment
- Initial admin setup

See [@authrim/setup documentation](../../packages/setup/README.md) for details.

### CLI Deployment

The same flow from the command line. Creating an environment is interactive (`init --cli` asks for
the URLs and options); deploying and updating an existing environment can then run unattended with
`--yes`:

```bash
# 1. Create the environment (keys, Cloudflare resources, wrangler configuration) — interactive
npx @authrim/setup init --cli --env prod

# 2. Deploy (or redeploy) its Workers
npx @authrim/setup deploy --env prod --yes

# 3. Later releases: migrate and redeploy as one operation
npx @authrim/setup update --env prod --all --yes
```

From a repository checkout, `pnpm run setup:init` and `pnpm run setup:deploy` run the same
commands. See the [@authrim/setup documentation](../../packages/setup/README.md) for all options.

---

## Step-by-Step Deployment

### 1. Generate RSA Keys

```bash
./scripts/setup-keys.sh
```

Creates:

- `.keys/private.pem` - Private key for JWT signing
- `.keys/public.jwk.json` - Public key in JWK format
- `.keys/metadata.json` - Key metadata

### 2. Generate Wrangler Configuration

```bash
npx @authrim/setup init --cli --env prod
```

Setup asks for the issuer URL (workers.dev or a custom domain) and the UI settings, provisions the
Cloudflare resources, and writes each package's `wrangler.toml` with an `[env.prod]` section. Do not
edit the generated files. To change an environment, edit it in the Web UI (`npx @authrim/setup`) or
reload its configuration in the CLI with
`npx @authrim/setup init --cli --config .authrim/prod/config.json`, then deploy again.
(`npx @authrim/setup config --env prod --show` only displays or `--validate`s the configuration.)

> Steps 3–5 are part of `npx @authrim/setup init` above. The `setup-kv.sh`, `setup-d1.sh`, and
> `setup-secrets.sh` scripts below only maintain the retired `wrangler.{env}.toml` layout and are not
> needed for an environment created by `@authrim/setup`.

### 3. Create KV Namespaces

```bash
./scripts/setup-kv.sh --env=prod
```

Creates 7 KV namespaces including `CLIENTS_CACHE`, `SETTINGS`, `AUTHRIM_CONFIG`, etc. Default settings are auto-initialized.

### 4. Create D1 Database

```bash
./scripts/setup-d1.sh --env=prod
```

- Creates `{env}-authrim-users-db`
- Optionally runs migrations (recommended)

### 5. Upload Secrets

```bash
./scripts/setup-secrets.sh --env=prod
```

Uploads to all workers:

- `PRIVATE_KEY_PEM` - JWT signing key
- `PUBLIC_JWK_JSON` - JWT verification key

### 6. Deploy Workers

```bash
pnpm run deploy -- --env=prod
```

Deployment order (automatic):

1. `ar-lib-core` - Durable Objects (deployed first)
2. `ar-discovery` - Discovery & JWKS
3. `ar-management` - Admin API & registration
4. `ar-auth` - Authorization endpoint
5. `ar-token` - Token endpoint
6. `ar-userinfo` - UserInfo endpoint
7. `ar-async` - Device Flow & CIBA
8. `ar-policy` - Policy evaluation (ReBAC)
9. `ar-saml` - SAML IdP/SP
10. `ar-bridge` - External IdP integration
11. `ar-vc` - Verifiable Credentials
12. `ar-router` - (Test mode only)

Features:

- Sequential deployment with 10s delays
- Automatic retries on failure
- Version registration in VersionManager DO

---

## UI Deployment

Deploy the SvelteKit Login UI and Admin UI as Cloudflare Workers with static assets:

```bash
pnpm run deploy -- --env=prod
```

Worker naming:

- Login UI: `{env}-ar-login-ui`
- Admin UI: `{env}-ar-admin-ui`

The setup tool generates Workers static asset configuration and runs `wrangler deploy` for each UI worker. Pages projects are not part of the supported deployment path.

For interactive domain configuration and deployment:

```bash
authrim-setup deploy --env prod
```

---

## Verification

### Test Discovery Endpoint

```bash
ISSUER_URL="https://auth.example.com"

# Discovery
curl "$ISSUER_URL/.well-known/openid-configuration" | jq

# JWKS
curl "$ISSUER_URL/.well-known/jwks.json" | jq
```

### Expected Discovery Response

```json
{
  "issuer": "https://auth.example.com",
  "authorization_endpoint": "https://auth.example.com/authorize",
  "token_endpoint": "https://auth.example.com/token",
  "userinfo_endpoint": "https://auth.example.com/userinfo",
  "jwks_uri": "https://auth.example.com/.well-known/jwks.json",
  "registration_endpoint": "https://auth.example.com/register",
  ...
}
```

### Monitor Deployment

```bash
# Real-time logs
cd packages/ar-token
wrangler tail

# View version status
curl "$ISSUER_URL/api/internal/version-manager/status" \
  -H "Authorization: Bearer ${ADMIN_MACHINE_ACCESS_TOKEN}"
```

---

## Custom Domain Setup

### Router Custom Domain (Recommended)

When the environment's API URL is a custom domain, `@authrim/setup` attaches it to the Router
Worker only, either as a Custom Domain binding or as a zone route (plus the tenant wildcard in
multi-tenant mode):

```toml
# packages/ar-router/wrangler.toml (generated)
[[env.prod.routes]]
pattern = "auth.example.com"
custom_domain = true
```

Every API path — discovery, `/authorize`, `/token`, `/userinfo`, and the Device Flow and CIBA
approval APIs — enters through the Router, which forwards it to the owning Worker over a Service
Binding after its Origin/CSRF and header checks; so do the UI pages when the UI shares the API host.
A UI on its own host (`sameAsApi: false`) gets its own Custom Domain on the UI Worker; how its API
calls reach the Router is described under [Deployment Modes](#deployment-modes). Do not add routes
that send an API path straight to an API Worker: that request would skip the Router's checks.

### DNS Configuration

1. Go to Cloudflare Dashboard → DNS
2. Add A record:
   - **Name**: `auth` (or your subdomain)
   - **IPv4**: `192.0.2.1` (placeholder)
   - **Proxy status**: Proxied (orange cloud)

---

## Troubleshooting

### KV Namespace Not Found

```bash
# Reset and recreate
./scripts/setup-kv.sh --env=prod --reset
sleep 30  # Wait for propagation
pnpm run deploy -- --env=prod
```

### Missing Secrets

```bash
./scripts/setup-secrets.sh --env=prod
```

### Deployment Rate Limits

The deploy script automatically:

- Deploys sequentially (not in parallel)
- Waits 10s between deployments
- Retries failed deployments

### Configuration Validation Failed

```bash
# Check for placeholder values
grep -r 'placeholder' packages/*/wrangler.prod.toml

# Re-run setup scripts
./scripts/setup-kv.sh --env=prod
./scripts/setup-d1.sh --env=prod
```

### Workers Not Communicating

Verify Durable Object bindings in wrangler.toml:

```toml
[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "prod-ar-lib-core"
```

---

## Environment Management

### Deploy Multiple Environments

Each environment has its own configuration under `.authrim/{env}/`:

```bash
# Development (for example https://dev-auth.example.com)
npx @authrim/setup init --cli --env dev
npx @authrim/setup deploy --env dev --yes

# Production (for example https://auth.example.com)
npx @authrim/setup init --cli --env prod
npx @authrim/setup deploy --env prod --yes
```

### Clean Up Environment

```bash
# Delete all resources for an environment
./scripts/delete-all.sh --env=dev --dry-run  # Preview
./scripts/delete-all.sh --env=dev            # Execute
```

---

## Security Checklist

- ✅ **HTTPS Only**: Enforced by Cloudflare Workers
- ✅ **Secrets Management**: Use `wrangler secret`, never commit keys
- ✅ **Key Rotation**: Supported via KeyManager DO
- ✅ **PKCE**: Enabled by default
- ✅ **Rate Limiting**: Via RateLimiterCounter DO
- ✅ **Security Headers**: CSP, HSTS, X-Frame-Options

### Never Commit

```
.keys/           # RSA keys
.dev.vars        # Local secrets
wrangler.*.toml  # Contains KV/D1 IDs
```

---

## Initial Admin Setup

After deploying for the first time, you need to create the initial system administrator account. Authrim uses **passwordless authentication** (Passkey/WebAuthn), so the setup process involves registering a Passkey.

### Quick Setup

```bash
# Generate keys and setup token (with automatic KV upload)
./scripts/setup-keys.sh \
  --setup-url=https://auth.example.com \
  --kv-namespace-id=YOUR_AUTHRIM_CONFIG_KV_ID
```

The script outputs a URL like:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔐 Initial Admin Setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Open this URL in your browser within 1 hour:

  https://auth.example.com/setup?token=abc123...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Setup Flow

1. **Open the setup URL** in a browser that supports Passkeys
2. **Enter your email address** (this will be your admin account)
3. **Register a Passkey** using your device's biometric or security key
4. **Done!** You now have a `system_admin` account

### Manual Token Upload

If you didn't provide `--kv-namespace-id`, upload the token manually:

```bash
wrangler kv:key put "setup:token" "$(cat .keys/setup_token.txt)" \
  --namespace-id=YOUR_AUTHRIM_CONFIG_KV_ID \
  --expiration-ttl=3600
```

### Security Notes

- ⏰ **Token expires in 1 hour** - Generate a new one if expired
- 🔒 **One-time use** - Setup is permanently disabled after first admin is created
- 🚫 **Cannot be re-run** - The `setup:completed` flag prevents reuse
- 🔑 **Passkey required** - A WebAuthn-compatible device is required

### API Endpoints (for automation)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/setup/status` | GET | Check if setup is available |
| `/api/setup/initialize` | POST | Create user and get Passkey options |
| `/api/setup/complete` | POST | Complete Passkey registration |

### Troubleshooting

**"Setup has already been completed"**

The system already has an administrator. Use the normal login flow.

**"Invalid setup token"**

The token has expired or is incorrect. Generate a new one:

```bash
./scripts/setup-keys.sh --setup-url=https://auth.example.com --kv-namespace-id=xxx
```

**"Origin not allowed"**

Ensure your `ALLOWED_ORIGINS` or `ISSUER_URL` environment variable includes your domain.

---

## Next Steps

After deployment:

1. **Create Initial Admin** - Follow the [Initial Admin Setup](#initial-admin-setup) above
2. **Test OAuth Flow** - Register a client and test authorization
3. **Configure Email** - `./scripts/setup-resend.sh --env=prod`
4. **Set Up Monitoring** - Cloudflare Analytics dashboard
5. **Run Conformance Tests** - [OpenID Conformance Suite](https://www.certification.openid.net)

---

## Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Reference](https://developers.cloudflare.com/workers/wrangler/)
- [OpenID Connect Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [Scripts Documentation](../../scripts/README.md)
