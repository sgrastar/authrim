# Deployment Guide

This guide covers deploying Authrim to Cloudflare Workers for a production-ready OpenID Connect Provider.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Environment Types](#environment-types)
- [Quick Deployment](#quick-deployment)
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

| Environment | Worker Prefix | KV Prefix | Example Issuer URL |
|-------------|---------------|-----------|-------------------|
| `dev` | `dev-authrim-*` | `dev-*` | `https://dev-auth.example.com` |
| `staging` | `staging-authrim-*` | `staging-*` | `https://staging-auth.example.com` |
| `conformance` | `conformance-authrim-*` | `conformance-*` | `https://conformance.example.com` |
| `prod` | `authrim-*` | `*` | `https://auth.example.com` |

### Deployment Modes

#### Test Mode (workers.dev + Router Worker)
- Uses Router Worker with Service Bindings
- Single endpoint: `https://authrim.{subdomain}.workers.dev`
- Best for: Development, testing, demos

#### Production Mode (Custom Domain + Routes)
- Direct routing via Cloudflare Routes
- Optimal performance (no router hop)
- Best for: Production deployments

---

## Quick Deployment

For experienced users:

```bash
# 1. Setup infrastructure
./scripts/setup-keys.sh                           # Generate RSA keys
./scripts/setup-remote-wrangler.sh --env=prod     # Generate wrangler configs
./scripts/setup-kv.sh --env=prod                  # Create KV namespaces
./scripts/setup-d1.sh --env=prod                  # Create D1 database
./scripts/setup-secrets.sh --env=prod             # Upload secrets

# 2. Deploy API workers
pnpm run deploy -- --env=prod

# 3. Deploy UI (optional)
pnpm run deploy:ui -- --env=prod
```

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
./scripts/setup-remote-wrangler.sh --env=prod --domain=https://auth.example.com
```

Interactive prompts:
1. **Deployment Mode**: Test (workers.dev) or Production (custom domain)
2. **ISSUER_URL**: Your OP's public URL
3. **UI_BASE_URL**: Optional, for Device Flow consent pages

Creates `wrangler.{env}.toml` files for all packages.

### 3. Create KV Namespaces

```bash
./scripts/setup-kv.sh --env=prod
```

Creates:
- `{ENV}-CLIENTS` - Registered OAuth clients
- `{ENV}-INITIAL_ACCESS_TOKENS` - DCR tokens
- `{ENV}-SETTINGS` - System settings (auto-initialized)

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
1. `shared` - Durable Objects (deployed first)
2. `op-discovery` - Discovery & JWKS
3. `op-management` - Admin API & registration
4. `op-auth` - Authorization endpoint
5. `op-token` - Token endpoint
6. `op-userinfo` - UserInfo endpoint
7. `op-async` - Device Flow & CIBA
8. `policy-service` - Policy evaluation
9. `op-saml` - SAML IdP/SP
10. `external-idp` - External IdP integration
11. `router` - (Test mode only)

Features:
- Sequential deployment with 10s delays
- Automatic retries on failure
- Version registration in VersionManager DO

---

## UI Deployment

Deploy the SvelteKit login/consent UI to Cloudflare Pages:

```bash
pnpm run deploy:ui -- --env=prod
```

Project naming:
- `prod` → `authrim-ui`
- Other envs → `{env}-authrim-ui`

For interactive domain configuration:
```bash
./scripts/deploy-remote-ui.sh
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
cd packages/op-token
wrangler tail

# View version status
curl "$ISSUER_URL/api/internal/version-manager/status" \
  -H "Authorization: Bearer $ADMIN_API_SECRET"
```

---

## Custom Domain Setup

### Using Cloudflare Routes (Recommended)

The `setup-remote-wrangler.sh` script automatically configures routes when using production mode:

```toml
# packages/op-discovery/wrangler.prod.toml
[[routes]]
pattern = "auth.example.com/.well-known/*"
zone_name = "example.com"
```

Routes configured automatically:
| Pattern | Worker |
|---------|--------|
| `/.well-known/*` | op-discovery |
| `/authorize`, `/as/*` | op-auth |
| `/token` | op-token |
| `/userinfo` | op-userinfo |
| `/register`, `/introspect`, `/revoke` | op-management |

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
script_name = "prod-authrim-shared"
```

---

## Environment Management

### Deploy Multiple Environments

```bash
# Development
./scripts/setup-remote-wrangler.sh --env=dev --domain=https://dev-auth.example.com
./scripts/setup-kv.sh --env=dev
./scripts/setup-d1.sh --env=dev
./scripts/setup-secrets.sh --env=dev
pnpm run deploy -- --env=dev

# Production
./scripts/setup-remote-wrangler.sh --env=prod --domain=https://auth.example.com
./scripts/setup-kv.sh --env=prod
./scripts/setup-d1.sh --env=prod
./scripts/setup-secrets.sh --env=prod
pnpm run deploy -- --env=prod
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

## Next Steps

After deployment:

1. **Test OAuth Flow** - Register a client and test authorization
2. **Configure Email** - `./scripts/setup-resend.sh --env=prod`
3. **Set Up Monitoring** - Cloudflare Analytics dashboard
4. **Run Conformance Tests** - `pnpm run conformance:all`

---

## Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Reference](https://developers.cloudflare.com/workers/wrangler/)
- [OpenID Connect Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [Scripts Documentation](../../scripts/README.md)
