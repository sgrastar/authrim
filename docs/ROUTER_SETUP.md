# Router Worker Setup Guide

## Problem Statement

After splitting Enrai into multiple specialized Workers, an OpenID Connect specification violation was discovered:

**Issue**: The issuer was set to `https://enrai.sgrastar.workers.dev`, but the discovery document was actually at `https://enrai-op-discovery.sgrastar.workers.dev/.well-known/openid-configuration`.

**OIDC Requirement**: The issuer identifier and all endpoints MUST be accessible from the same domain.

## Solution Overview

We implemented a dual-mode deployment system:

### 1. Test Environment (workers.dev + Router Worker)
- **Use case**: Development, testing, quick setup
- **How it works**: Deploy a Router Worker that acts as a single entry point
- **Issuer**: `https://enrai-router.subdomain.workers.dev`
- **Mechanism**: Service Bindings route requests to specialized workers
- **Pros**: OpenID Connect compliant, works with workers.dev
- **Cons**: Adds ~1-5ms latency per request

### 2. Production Environment (Custom Domain + Routes)
- **Use case**: Production deployments
- **How it works**: Cloudflare Routes map paths directly to workers
- **Issuer**: Your custom domain (e.g., `https://id.yourdomain.com`)
- **Mechanism**: Infrastructure-level routing (no extra worker)
- **Pros**: Optimal performance, no extra hop
- **Cons**: Requires Cloudflare-managed domain

## Setup Instructions

### Prerequisites

Before running the setup, ensure you have:
1. Run `./scripts/setup-dev.sh` to generate keys and wrangler.toml files
2. Run `./scripts/setup-kv.sh` to create KV namespaces
3. Run `./scripts/setup-secrets.sh` to upload secrets

### Step 1: Configure Deployment Mode

Run the production setup script:

```bash
./scripts/setup-production.sh
```

You'll be prompted to choose:

```
1) Test Environment (workers.dev + Router Worker)
   - Single unified endpoint
   - Uses Router Worker with Service Bindings
   - Best for: Development, testing

2) Production Environment (Custom Domain + Routes)
   - Custom domain with Cloudflare Routes
   - Optimal performance
   - Best for: Production
```

### Step 2: Build and Deploy

After setup completes, build and deploy:

**For Test Environment:**
```bash
pnpm run build
pnpm run deploy:with-router
```

**For Production Environment:**
```bash
pnpm run build
pnpm run deploy
```

### Step 3: Verify

Test your deployment:

```bash
# Replace with your actual URL
curl https://enrai-router.subdomain.workers.dev/.well-known/openid-configuration | jq

# Or for custom domain
curl https://id.yourdomain.com/.well-known/openid-configuration | jq
```

Verify that:
- ✅ `issuer` field matches the URL you're accessing
- ✅ All endpoint URLs start with the issuer URL
- ✅ `jwks_uri` is accessible

## Architecture Diagrams

### Test Environment (Router Worker)

```
┌─────────────────────────────────────────┐
│  enrai-router.subdomain.workers.dev     │
│  (Issuer: this URL)                     │
└──────────────┬──────────────────────────┘
               │
      ┌────────┴────────┐
      │  Router Worker  │
      │ (Service Bindings)│
      └────────┬────────┘
               │
    ┌──────────┼──────────┐
    ↓          ↓          ↓
┌────────┐ ┌────────┐ ┌────────┐
│Discovery│ │  Auth  │ │ Token  │
│ Worker │ │ Worker │ │ Worker │
└────────┘ └────────┘ └────────┘
```

### Production Environment (Routes)

```
┌─────────────────────────────────────────┐
│  id.yourdomain.com (Issuer: this URL)   │
└──────────────┬──────────────────────────┘
               │
      ┌────────┴────────┐
      │ Cloudflare Routes│
      │ (Infrastructure) │
      └────────┬────────┘
               │
    ┌──────────┼──────────┐
    ↓          ↓          ↓
┌────────┐ ┌────────┐ ┌────────┐
│Discovery│ │  Auth  │ │ Token  │
│ Worker │ │ Worker │ │ Worker │
└────────┘ └────────┘ └────────┘
```

## What Gets Configured

### Test Environment

The setup script:
1. Sets issuer to `https://enrai-router.subdomain.workers.dev`
2. Generates `packages/router/wrangler.toml` with Service Bindings
3. Updates all worker wrangler.toml files with the issuer URL
4. Instructs you to deploy with `pnpm run deploy:with-router`

### Production Environment

The setup script:
1. Sets issuer to your custom domain (e.g., `https://id.yourdomain.com`)
2. Adds Cloudflare Routes to each worker's wrangler.toml:
   - Discovery: `id.yourdomain.com/.well-known/*`
   - Auth: `id.yourdomain.com/authorize`, `id.yourdomain.com/as/*`
   - Token: `id.yourdomain.com/token`
   - UserInfo: `id.yourdomain.com/userinfo`
   - Management: `id.yourdomain.com/register`, `/introspect`, `/revoke`
3. Skips Router Worker deployment
4. Instructs you to deploy with `pnpm run deploy`

## Switching Between Modes

You can re-run `./scripts/setup-production.sh` at any time to switch modes. The script will:
1. Ask you to choose a new deployment mode
2. Reconfigure all wrangler.toml files accordingly
3. Show updated deployment instructions

## Troubleshooting

### Issue: Routes not working on custom domain

**Solution:**
1. Verify your domain is managed by Cloudflare (DNS)
2. Check that your zone name is correct in wrangler.toml
3. After deployment, visit Cloudflare Dashboard → Workers → Your worker → Routes
4. Confirm routes are registered

### Issue: Service Bindings not found

**Solution:**
1. Ensure all workers are deployed before deploying the router
2. Deploy in this order:
   ```bash
   cd packages/op-discovery && pnpm run deploy
   cd packages/op-auth && pnpm run deploy
   # ... deploy all other workers
   cd packages/router && pnpm run deploy
   ```

### Issue: Issuer mismatch errors

**Solution:**
1. Verify issuer in discovery document matches the URL you're accessing
2. Clear browser cache
3. Re-run `./scripts/setup-production.sh` to reconfigure

## Performance Comparison

| Metric | Test Env (Router) | Production (Routes) |
|--------|-------------------|---------------------|
| Latency overhead | ~1-5ms | ~0ms (direct) |
| Cold start | Same | Same |
| Compliance | ✅ OIDC compliant | ✅ OIDC compliant |
| Setup complexity | Low | Medium |
| Cost | +1 worker invocation | 0 extra invocations |

## See Also

- [packages/router/README.md](../packages/router/README.md) - Router Worker technical details
- [DEPLOYMENT.md](DEPLOYMENT.md) - General deployment guide
- [WORKERS.md](../WORKERS.md) - Worker architecture overview
