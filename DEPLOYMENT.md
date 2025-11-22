# Authrim Deployment Guide

This guide covers deploying Authrim to Cloudflare Workers with support for multiple environments (dev, staging, production, etc.) within a single Cloudflare account.

## Table of Contents

- [Overview](#overview)
- [Multiple Environment Support](#multiple-environment-support)
- [Prerequisites](#prerequisites)
- [Environment Setup](#environment-setup)
- [Deployment Options](#deployment-options)
- [Post-Deployment](#post-deployment)
- [Troubleshooting](#troubleshooting)

## Overview

Authrim is deployed as a set of Cloudflare Workers:
- **OP Workers**: OpenID Connect protocol endpoints (discovery, auth, token, userinfo, management)
- **Shared Worker**: Durable Objects for session/state management
- **Router Worker**: (Optional) Unified endpoint for test environments

## Multiple Environment Support

Authrim supports deploying multiple environments to a single Cloudflare account. Each environment has:

- **Separate Resources**: KV namespaces, D1 databases, Workers all have environment-specific names
- **Isolated Data**: Dev, staging, and production data are completely separated
- **Same Codebase**: All environments use the same application code

### Environment Naming

All Cloudflare resources are prefixed with the environment name:

```
dev-authrim-op-auth          # Dev environment worker
dev-CLIENTS                  # Dev environment KV namespace
dev-authrim-users-db         # Dev environment D1 database

staging-authrim-op-auth      # Staging environment worker
staging-CLIENTS              # Staging KV namespace
staging-authrim-users-db     # Staging D1 database
```

## Prerequisites

1. **Cloudflare Account**
   - Free tier is sufficient for testing
   - Paid plan recommended for production

2. **Node.js & pnpm**
   ```bash
   node --version  # v22.0.0 or higher
   pnpm --version  # v9.0.0 or higher
   ```

3. **Wrangler CLI**
   ```bash
   pnpm install -g wrangler@latest
   wrangler login
   ```

4. **Domain (Production)**
   - Custom domain managed by Cloudflare DNS (for production)
   - workers.dev subdomain works for dev/staging

## Environment Setup

### Step 1: Generate Cryptographic Keys

Generate JWT signing keys (shared across all environments):

```bash
./scripts/setup-keys.sh
```

This creates:
- `.keys/private.pem` - Private key for signing
- `.keys/public.jwk.json` - Public key for verification
- `.keys/metadata.json` - Key metadata (KEY_ID)

### Step 2: Generate Wrangler Configuration

Choose between local (for development) or remote (for deployment):

#### For Local Development

```bash
./scripts/setup-local-wrangler.sh --env=dev
```

This generates `wrangler.dev.toml` files for each package with:
- Worker names: `dev-authrim-{package}`
- ISSUER_URL: `http://localhost:8787`
- Placeholder KV/D1 IDs (updated in next steps)

#### For Remote Deployment

```bash
# Dev environment
./scripts/setup-remote-wrangler.sh \
  --env=dev \
  --domain=https://dev-auth.yourdomain.com \
  --mode=test

# Staging environment
./scripts/setup-remote-wrangler.sh \
  --env=staging \
  --domain=https://staging-auth.yourdomain.com \
  --mode=test

# Production environment
./scripts/setup-remote-wrangler.sh \
  --env=prod \
  --domain=https://auth.yourdomain.com \
  --mode=production
```

**Deployment Modes:**
- `test`: Uses Router Worker + workers.dev (good for dev/staging)
- `production`: Uses Cloudflare Routes + custom domain (optimal performance)

### Step 3: Create KV Namespaces

```bash
# Dev environment
./scripts/setup-kv.sh --env=dev

# Staging environment
./scripts/setup-kv.sh --env=staging

# Production environment
./scripts/setup-kv.sh --env=prod
```

This creates environment-specific KV namespaces:
- `{env}-CLIENTS`
- `{env}-INITIAL_ACCESS_TOKENS`
- `{env}-SETTINGS`

### Step 4: Create D1 Database

```bash
# Dev environment
./scripts/setup-d1.sh --env=dev

# Staging environment
./scripts/setup-d1.sh --env=staging

# Production environment
./scripts/setup-d1.sh --env=prod
```

Creates `{env}-authrim-users-db` and runs migrations.

### Step 5: Upload Secrets

```bash
# Dev environment
./scripts/setup-secrets.sh --env=dev

# Staging environment
./scripts/setup-secrets.sh --env=staging

# Production environment
./scripts/setup-secrets.sh --env=prod
```

Uploads to environment-specific workers:
- `PRIVATE_KEY_PEM` - JWT signing key
- `PUBLIC_JWK_JSON` - JWT verification key

### Step 6: Configure Email (Optional)

```bash
# Dev environment
./scripts/setup-resend.sh --env=dev

# Production environment
./scripts/setup-resend.sh --env=prod
```

Configures Resend API for magic link emails.

## Deployment Options

### Option 1: Deploy Specific Environment

```bash
# Build and deploy to dev
pnpm run deploy -- --env=dev

# Build and deploy to staging
pnpm run deploy -- --env=staging

# Build and deploy to production
pnpm run deploy -- --env=prod
```

### Option 2: Deploy API Only (Exclude UI)

```bash
pnpm run deploy -- --env=dev --api-only
```

### Option 3: Deploy Individual Packages

```bash
# Deploy specific package to dev environment
cd packages/op-auth
DEPLOY_ENV=dev pnpm run deploy
```

## Deployment Workflow

Complete workflow for setting up a new environment:

```bash
# 1. Generate keys (once, shared across all environments)
./scripts/setup-keys.sh

# 2. Generate wrangler config for your environment
./scripts/setup-remote-wrangler.sh \
  --env=staging \
  --domain=https://staging-auth.yourdomain.com

# 3. Create KV namespaces
./scripts/setup-kv.sh --env=staging

# 4. Create D1 database
./scripts/setup-d1.sh --env=staging

# 5. Upload secrets
./scripts/setup-secrets.sh --env=staging

# 6. Configure email (optional)
./scripts/setup-resend.sh --env=staging

# 7. Deploy
pnpm run deploy -- --env=staging
```

## Post-Deployment

### Verify Deployment

```bash
# Check OpenID Configuration
curl https://staging-auth.yourdomain.com/.well-known/openid-configuration | jq

# Check JWKS
curl https://staging-auth.yourdomain.com/.well-known/jwks.json | jq
```

### Test OAuth Flow

1. Register a client:
   ```bash
   curl -X POST https://staging-auth.yourdomain.com/register \
     -H "Content-Type: application/json" \
     -d '{
       "client_name": "Test Client",
       "redirect_uris": ["https://example.com/callback"]
     }'
   ```

2. Note the `client_id` and `client_secret`

3. Test authorization endpoint:
   ```
   https://staging-auth.yourdomain.com/authorize?
     client_id=YOUR_CLIENT_ID&
     redirect_uri=https://example.com/callback&
     response_type=code&
     scope=openid profile email
   ```

### Monitor Resources

View environment-specific resources in Cloudflare Dashboard:

- **Workers**: Filter by `{env}-authrim-*`
- **KV**: Look for `{env}-CLIENTS`, `{env}-SETTINGS`, etc.
- **D1**: Find `{env}-authrim-users-db`
- **Durable Objects**: Check `{env}-authrim-shared`

## Environment Variables

Key environment variables in `wrangler.{env}.toml`:

```toml
[vars]
ISSUER_URL = "https://auth.yourdomain.com"
TOKEN_EXPIRY = "3600"           # 1 hour
CODE_EXPIRY = "120"             # 2 minutes
REFRESH_TOKEN_EXPIRY = "2592000"  # 30 days
ALLOW_HTTP_REDIRECT = "false"   # Only allow HTTPS in production
OPEN_REGISTRATION = "false"     # Disable in production
```

## Troubleshooting

### Missing Configuration Files

**Error**: `Missing: packages/op-auth/wrangler.{env}.toml`

**Solution**: Run setup-remote-wrangler.sh or setup-local-wrangler.sh for that environment

```bash
./scripts/setup-remote-wrangler.sh --env=dev --domain=https://dev-auth.example.com
```

### Placeholder KV/D1 IDs

**Error**: `Found placeholder KV namespace ID`

**Solution**: Run setup scripts for the environment:

```bash
./scripts/setup-kv.sh --env=dev
./scripts/setup-d1.sh --env=dev
```

### Worker Not Found (Secrets Upload)

**Error**: `Worker {env}-authrim-op-auth not found`

**Solution**: Deploy workers first, then upload secrets:

```bash
pnpm run deploy -- --env=dev
./scripts/setup-secrets.sh --env=dev
```

### Rate Limits During Deployment

**Error**: `Service unavailable (code 7010)`

**Solution**: The deploy script automatically handles this with delays. If it persists:

```bash
# Deploy with longer delays
INTER_DEPLOY_DELAY=15 pnpm run deploy -- --env=dev
```

### Durable Objects Migration

If you see Durable Objects errors, ensure shared worker is deployed first:

```bash
cd packages/shared
DEPLOY_ENV=dev pnpm run deploy
```

## Best Practices

### Environment Strategy

1. **Dev**: Use for active development
   - workers.dev subdomain
   - Test mode with Router Worker
   - Frequent deployments

2. **Staging**: Mirror production setup
   - Custom domain or workers.dev
   - Production mode
   - Pre-release testing

3. **Production**: Stable releases only
   - Custom domain
   - Production mode
   - Cloudflare Routes for best performance

### Security

- **Never commit** `.keys/` or `.dev.vars` to version control
- Use **different secrets** for each environment
- Set `ALLOW_HTTP_REDIRECT="false"` in production
- Set `OPEN_REGISTRATION="false"` in production
- Review `TRUSTED_DOMAINS` for your use case

### Resource Management

- **Name consistently**: Always use environment prefixes
- **Clean up unused environments**: Delete old KV/D1/Workers
- **Monitor costs**: Check Cloudflare dashboard for usage
- **Database backups**: Export D1 data periodically

```bash
# Export D1 database
wrangler d1 execute prod-authrim-users-db \
  --remote \
  --command="SELECT * FROM users;" > backup.sql
```

## Additional Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Reference](https://developers.cloudflare.com/workers/wrangler/)
- [OpenID Connect Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [Authrim GitHub Repository](https://github.com/sgrastar/authrim)

## Support

For issues or questions:
- GitHub Issues: [sgrastar/authrim/issues](https://github.com/sgrastar/authrim/issues)
- Documentation: [README.md](./README.md)
