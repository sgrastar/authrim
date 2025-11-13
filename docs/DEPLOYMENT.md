# Deployment Guide

This guide walks you through deploying Enrai to Cloudflare Workers, resulting in a production-ready OpenID Connect Provider accessible via a public URL.

## 📋 Table of Contents

- [Prerequisites](#prerequisites)
- [Deployment Overview](#deployment-overview)
- [Quick Deployment](#quick-deployment)
- [Step-by-Step Deployment](#step-by-step-deployment)
- [Production Configuration](#production-configuration)
- [GitHub Actions CI/CD](#github-actions-cicd)
- [Post-Deployment](#post-deployment)
- [Custom Domain Setup](#custom-domain-setup)
- [Security Considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before deploying Enrai, ensure you have:

1. **Cloudflare Account** (free tier works)
   - Sign up at [cloudflare.com](https://dash.cloudflare.com/sign-up)

2. **Wrangler CLI** installed
   ```bash
   pnpm install -g wrangler
   ```

3. **Cloudflare API Token** (for CI/CD)
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
   - Create token with "Edit Cloudflare Workers" template
   - Save the token securely

4. **Node.js 18+** and **pnpm** installed
   ```bash
   node --version  # Should be 18+
   pnpm --version  # Should be 9.0.0+
   ```

---

## Deployment Overview

### 🌍 Architecture

Enrai is a **monorepo** containing **6 specialized Cloudflare Workers** (including Durable Objects) plus an optional **Router Worker**:

| Worker | Package | Purpose |
|--------|---------|---------|
| **enrai-shared** | `packages/shared` | **Durable Objects** (SessionStore, AuthCodeStore, RefreshTokenRotator, KeyManager) |
| **enrai-op-discovery** | `packages/op-discovery` | Discovery & JWKS endpoints |
| **enrai-op-auth** | `packages/op-auth` | Authorization endpoint & PAR |
| **enrai-op-token** | `packages/op-token` | Token endpoint |
| **enrai-op-userinfo** | `packages/op-userinfo` | UserInfo endpoint |
| **enrai-op-management** | `packages/op-management` | Client registration |
| **enrai-router** | `packages/router` | Unified entry point (test env only) |

### 🔥 Durable Objects Layer

Enrai leverages **Cloudflare Durable Objects** for stateful operations with strong consistency:

| Durable Object | Purpose | Key Features |
|----------------|---------|--------------|
| **SessionStore** | User session management | Hot/cold storage, multi-device support, instant invalidation |
| **AuthorizationCodeStore** | OAuth code lifecycle | One-time use, PKCE validation, replay attack prevention |
| **RefreshTokenRotator** | Token rotation | Atomic rotation, theft detection, audit logging |
| **KeyManager** | Cryptographic keys | JWK management, automatic rotation, secure storage |

**⚠️ CRITICAL:** The `enrai-shared` package **MUST be deployed first** before deploying other workers!

### 🎯 Deployment Modes

Enrai supports two deployment modes to ensure OpenID Connect specification compliance:

#### 1️⃣ Test Environment (workers.dev + Router Worker)
- **Use case**: Development, testing, quick setup
- **How**: Router Worker acts as unified entry point with Service Bindings
- **Issuer**: `https://enrai.subdomain.workers.dev`
- **Pros**: OpenID Connect compliant, no custom domain needed
- **Deploy**: `pnpm run deploy:with-router`

#### 2️⃣ Production Environment (Custom Domain + Routes)
- **Use case**: Production deployments
- **How**: Cloudflare Routes map paths directly to specialized workers
- **Issuer**: Your custom domain (e.g., `https://id.yourdomain.com`)
- **Pros**: Optimal performance (no extra hop), professional URL
- **Deploy**: `pnpm run deploy`

Each worker is deployed independently but shares the same issuer URL.

### ✅ Live OpenID Connect Endpoints

After deployment, all endpoints will be accessible under your configured domain:

| Endpoint | URL | Description |
|----------|-----|-------------|
| **Discovery** | `/.well-known/openid-configuration` | OpenID Provider metadata |
| **JWKS** | `/.well-known/jwks.json` | Public keys for token verification |
| **Authorization** | `/authorize` | OAuth 2.0 authorization endpoint |
| **PAR** | `/as/par` | Pushed Authorization Requests |
| **Token** | `/token` | Token exchange endpoint |
| **UserInfo** | `/userinfo` | User claims endpoint |
| **Registration** | `/register` | Dynamic client registration |

### 🚀 Global Edge Deployment

- Deployed to 300+ Cloudflare data centers worldwide
- <50ms latency for most users globally
- 0ms cold starts
- Automatic HTTPS

---

## Quick Deployment

For experienced users, here's the TL;DR:

```bash
# 1. Clone and install
git clone https://github.com/sgrastar/enrai.git
cd enrai
pnpm install

# 2. Login to Cloudflare
wrangler login

# 3. Run setup scripts (in order)
./scripts/setup-dev.sh         # Generate RSA keys & wrangler.toml files (includes DO config)
./scripts/setup-kv.sh          # Create KV namespaces
./scripts/setup-d1.sh          # Create D1 database (Phase 5)
./scripts/setup-secrets.sh     # Upload secrets to Cloudflare
./scripts/setup-production.sh  # Choose deployment mode & configure URLs
                               # → Select option 1 (Test) or 2 (Production)

# 4. Build and deploy
pnpm run build

# 5. Deploy Durable Objects FIRST (CRITICAL!)
./scripts/setup-durable-objects.sh
# Wait 30 seconds for DO propagation...

# 6. Deploy all workers with retry logic (recommended)
pnpm run deploy:retry
# - Deploys in correct order: shared → workers → router
# - Uses sequential deployment with delays to avoid rate limits
# - Includes automatic retries on failure
```

**Done!** Your OpenID Provider is now live.

> 💡 **Important**: Both `deploy:with-router` and `deploy:retry` now use the same sequential deployment script with retry logic. The router is conditionally deployed based on your configuration from `setup-production.sh`.

---

## Step-by-Step Deployment

### 1. Clone and Install Dependencies

```bash
# Clone the repository
git clone https://github.com/sgrastar/enrai.git
cd enrai

# Install dependencies for all packages
pnpm install
```

This installs dependencies for the monorepo and all 5 worker packages.

### 2. Authenticate with Cloudflare

```bash
# Login to Cloudflare (opens browser)
wrangler login

# Verify authentication
wrangler whoami
```

You should see your Cloudflare account email and account ID.

### 3. Generate RSA Keys and Base Configuration

**Important:** Generate wrangler.toml files first before creating infrastructure.

```bash
./scripts/setup-dev.sh
```

**What this does:**
- Generates an RSA-2048 key pair
- Saves private key to `.keys/private.pem`
- Saves public key (JWK format) to `.keys/public.jwk.json`
- Saves key metadata to `.keys/metadata.json`
- Creates `.dev.vars` for local development
- **Generates base `wrangler.toml` files for all packages**

**Output:**
```
🔐 Enrai Development Setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Generating RSA keys...
✅ .dev.vars file created successfully!
📝 Generating wrangler.toml files for each worker...

📋 Key Information:
  • Key ID: dev-key-1731532800000-abc123
  • Private Key: .keys/private.pem
  • Public JWK: .keys/public.jwk.json
```

### 4. Create KV Namespaces

**Important:** Create KV namespaces after base wrangler.toml files exist.

Create Cloudflare KV namespaces for storing state, codes, and clients:

```bash
./scripts/setup-kv.sh
```

**What this does:**
- Creates 7 KV namespaces (production)
- Creates 7 KV namespaces (preview)
- Updates all `packages/*/wrangler.toml` files with namespace IDs
- Prompts for each existing namespace (use/recreate/abort)

**Namespaces created:**
- `AUTH_CODES` - Authorization codes
- `STATE_STORE` - OAuth state parameters
- `NONCE_STORE` - OpenID nonces
- `CLIENTS` - Registered clients
- `RATE_LIMIT` - Rate limiting data
- `REFRESH_TOKENS` - Refresh tokens
- `REVOKED_TOKENS` - Revoked tokens

**Output:**
```
⚡️ Enrai KV Namespace Setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Creating production namespaces...
✅ AUTH_CODES: abc123def456...
✅ STATE_STORE: def456ghi789...
...
✅ All wrangler.toml files updated!

⚠️  Important: Wait 10-30 seconds before deploying to allow
   Cloudflare to propagate the changes.
```

**Reset Option:**

If you need to delete and recreate all KV namespaces (e.g., after deployment errors):

```bash
./scripts/setup-kv.sh --reset
```

This will:
- Automatically delete all existing KV namespaces
- Recreate them with fresh IDs
- Update all `wrangler.toml` files
- Require 'YES' confirmation to prevent accidental data loss

**Note:** You may need to undeploy workers first if namespaces are in use.

### 5. Create D1 Database (Phase 5)

**Phase 5 Feature:** Create Cloudflare D1 database for persistent storage.

```bash
./scripts/setup-d1.sh
```

**What this does:**
- Creates D1 database (`enrai-dev` or `enrai-prod`)
- Updates all `packages/*/wrangler.toml` files with D1 bindings
- Optionally runs database migrations (11 tables, 20 indexes)
- Displays database status and helpful commands

**Interactive prompts:**
```
📦 D1 Database Setup

Environment (dev/prod) [dev]: dev

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Database: enrai-dev
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📝 Creating D1 database: enrai-dev
✅ Database created successfully!
   Database ID: abc123-def456-...

Run database migrations now? (y/N): y

🚀 Running migrations...
📝 Applying 001_initial_schema.sql...
✅ Schema migration complete

📝 Applying 002_seed_default_data.sql...
✅ Seed data migration complete

✅ All migrations applied!
```

**Database schema created:**
- 11 tables (users, oauth_clients, sessions, roles, etc.)
- 20 indexes for optimized queries
- Default roles (super_admin, admin, viewer, support)
- OIDC scope mappings (profile, email, phone, address)
- Test data (development only)

**Reset Option:**

If you need to reset the database (development only):

```bash
./scripts/setup-d1.sh --reset
```

This will:
- Delete the existing D1 database
- Recreate it with a fresh ID
- Update all `wrangler.toml` files
- Require 'YES' confirmation to prevent accidental data loss

**Manual migration:**

If you skip migrations during setup, you can run them later:

```bash
# Using migrate.sh (recommended)
bash migrations/migrate.sh dev up

# Or manually with wrangler
wrangler d1 execute enrai-dev --file=migrations/001_initial_schema.sql
wrangler d1 execute enrai-dev --file=migrations/002_seed_default_data.sql
```

**Verify database:**

```bash
# List tables
wrangler d1 execute enrai-dev --command="SELECT name FROM sqlite_master WHERE type='table';"

# Count records
wrangler d1 execute enrai-dev --command="SELECT COUNT(*) FROM users;"
```

**⚠️ IMPORTANT:**
- D1 database is required for Phase 5 features (UI/UX, admin dashboard)
- For Phase 1-4, you can skip this step (uses KV storage only)
- See [migrations/README.md](../migrations/README.md) for detailed schema documentation

### 6. Upload Secrets to Cloudflare

Upload your private and public keys to Cloudflare Workers secrets:

```bash
./scripts/setup-secrets.sh
```

**What this does:**
- Uploads `PRIVATE_KEY_PEM` to workers that need it (op-discovery, op-token, op-management)
- Uploads `PUBLIC_JWK_JSON` to workers that need it (op-discovery, op-auth, op-userinfo, op-management)

**Output:**
```
🔐 Enrai Cloudflare Secrets Setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Uploading secrets to op-discovery...
  • Uploading PRIVATE_KEY_PEM...
  • Uploading PUBLIC_JWK_JSON...
✅ op-discovery secrets uploaded
...
🎉 All secrets uploaded successfully!
```

**⚠️ IMPORTANT:** Never commit `.keys/` to version control! It's already in `.gitignore`.

### 7. Configure Deployment Mode

Choose your deployment mode and configure URLs:

```bash
./scripts/setup-production.sh
```

**What this does:**
- Asks you to choose between Test or Production deployment mode
- Configures wrangler.toml files accordingly
- Updates `ISSUER_URL` in all worker configurations

**Interactive prompt:**
```
📝 Deployment Mode Configuration

   Choose how you want to deploy Enrai:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1) Test Environment (workers.dev + Router Worker)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     • Single unified endpoint: https://enrai.subdomain.workers.dev
     • Uses Router Worker with Service Bindings
     • All endpoints accessible under one domain
     • Best for: Development, testing, quick setup
     • OpenID Connect compliant ✅

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  2) Production Environment (Custom Domain + Routes)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     • Custom domain: https://id.yourdomain.com
     • Uses Cloudflare Routes (direct routing)
     • Optimal performance (no extra hop)
     • Best for: Production deployments
     • Requires: Cloudflare-managed domain

Enter your choice (1/2):

🔍 Configuration Summary:
   ISSUER_URL: https://id.example.com

Is this correct? (y/N): y
```

### 8. Build the Project

Build all worker packages (including Router if in test mode):

```bash
pnpm run build
```

This uses Turborepo to build all packages in parallel with caching.

**Output:**
```
• Packages in scope: op-auth, op-discovery, op-management, op-token, op-userinfo, router, shared
• Running build in 7 packages
op-discovery:build: cache hit, replaying logs
op-auth:build: cache hit, replaying logs
router:build: cache hit, replaying logs
...
```

### 9. Deploy to Cloudflare Workers

Deploy workers using the recommended sequential deployment with retry logic:

#### Recommended: Deploy with Retry Logic (All Modes)

```bash
pnpm run deploy:with-router
```

This is now the **recommended deployment method** for both test and production environments.

**What this does:**
- Builds all packages
- Deploys workers **sequentially** (one at a time)
- Adds 10-second delays between deployments to avoid rate limits
- Retries failed deployments automatically (up to 4 attempts with exponential backoff)
- **Conditionally deploys Router Worker**:
  - ✅ **Included** if `packages/router/wrangler.toml` exists (Test Environment)
  - ⊗ **Skipped** if `packages/router/wrangler.toml` missing (Production Environment)

**Workers deployed (Test Environment):**
- `enrai-op-discovery`
- `enrai-op-management`
- `enrai-op-auth`
- `enrai-op-token`
- `enrai-op-userinfo`
- `enrai` (unified entry point - Router Worker)

**Workers deployed (Production Environment):**
- `enrai-op-discovery`
- `enrai-op-management`
- `enrai-op-auth`
- `enrai-op-token`
- `enrai-op-userinfo`
- Router Worker is automatically skipped

#### Alternative: Parallel Deployment (Legacy, Not Recommended)

```bash
pnpm run deploy
```

**⚠️ Warning:** This uses Turbo's parallel deployment which may cause:
- Cloudflare API rate limit errors
- "Service unavailable" errors (code 7010)
- Random deployment failures

Only use this if you understand the risks. The sequential deployment (`deploy:with-router`) is **strongly recommended**.

**Output Example:**
```
🚀 Starting deployment with retry logic...

🔨 Building packages...

• Packages in scope: @enrai/op-auth, @enrai/op-discovery, @enrai/op-management, @enrai/op-token, @enrai/op-userinfo, @enrai/router, @enrai/shared
• Running build in 7 packages
...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Deploying: op-discovery
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Published enrai-op-discovery (0.01 sec)
https://enrai-op-discovery.your-subdomain.workers.dev
✅ Successfully deployed: op-discovery

⏸️  Waiting 10s before next deployment to avoid rate limits...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Deploying: op-management
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Deploying: router
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Published enrai (0.01 sec)
https://enrai.your-subdomain.workers.dev
✅ Successfully deployed: router

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Deployment Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ All packages deployed successfully!
```

**If Router Worker is not needed (Production mode):**
```
⊗ Skipping router (wrangler.toml not found - not needed in production mode)
```

### 10. Verify Deployment

Test your deployed OpenID Provider:

```bash
# Replace with your configured ISSUER_URL
ISSUER_URL="https://id.example.com"

# Test discovery endpoint
curl "$ISSUER_URL/.well-known/openid-configuration" | jq

# Test JWKS endpoint
curl "$ISSUER_URL/.well-known/jwks.json" | jq
```

**Expected discovery response:**
```json
{
  "issuer": "https://id.example.com",
  "authorization_endpoint": "https://id.example.com/authorize",
  "token_endpoint": "https://id.example.com/token",
  "userinfo_endpoint": "https://id.example.com/userinfo",
  "jwks_uri": "https://id.example.com/.well-known/jwks.json",
  "registration_endpoint": "https://id.example.com/register",
  ...
}
```

**Expected JWKS response:**
```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "kid": "dev-key-1731532800000-abc123",
      "alg": "RS256",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

---

## Production Configuration

### Environment Variables

Each worker's `wrangler.toml` contains environment variables:

```toml
[vars]
ISSUER_URL = "https://id.example.com"  # Your OP's public URL
TOKEN_EXPIRY = "3600"                   # Access token lifetime (seconds)
CODE_EXPIRY = "600"                     # Authorization code lifetime (seconds)
STATE_EXPIRY = "600"                    # State parameter lifetime (seconds)
NONCE_EXPIRY = "600"                    # Nonce parameter lifetime (seconds)
REFRESH_TOKEN_EXPIRY = "2592000"        # Refresh token lifetime (seconds)
```

These can be customized per worker if needed.

### Secrets (via Wrangler)

Secrets are managed separately and **never** appear in `wrangler.toml`:

- `PRIVATE_KEY_PEM` - RSA private key for JWT signing
- `PUBLIC_JWK_JSON` - RSA public key in JWK format

To update secrets manually:

```bash
cd packages/op-discovery
cat ../../.keys/private.pem | wrangler secret put PRIVATE_KEY_PEM
echo "$(cat ../../.keys/public.jwk.json | jq -c .)" | wrangler secret put PUBLIC_JWK_JSON
```

---

## GitHub Actions CI/CD

Enrai includes pre-configured GitHub Actions workflows for automated testing and deployment.

### Setup GitHub Secrets

Add these secrets to your GitHub repository:

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Add new repository secrets:

| Secret Name | Value | Where to Get It |
|-------------|-------|-----------------|
| `CLOUDFLARE_API_TOKEN` | Your API token | [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID | [Cloudflare Dashboard](https://dash.cloudflare.com/) (right sidebar) |

### Workflows

#### 1. CI Workflow (`.github/workflows/ci.yml`)

**Triggers:** Push to `main` or `claude/**` branches, pull requests

**Actions:**
- Installs dependencies with pnpm
- Runs linter
- Performs type checking
- Executes test suite (263 tests)
- Builds all 5 packages
- Checks code formatting

#### 2. Deploy Workflow (`.github/workflows/deploy.yml`)

**Triggers:** Push to `main` branch only

**Actions:**
- Runs tests
- Builds all packages
- **Deploys all 5 workers to Cloudflare Workers**

### Automatic Deployment Flow

```
Push to main → Run tests → Build packages → Deploy to Cloudflare → Live at production URL
```

**Note:**
- Secrets (`PRIVATE_KEY_PEM`, `PUBLIC_JWK_JSON`) and KV namespaces must be configured manually via Wrangler before the first deployment
- GitHub Actions uses the API token to deploy, but cannot create secrets or KV namespaces
- GitHub Actions deployments use sequential deployment with retry logic to avoid rate limits

---

## Post-Deployment

### 1. Verify OpenID Connect Compliance

After deployment, verify that all endpoints are accessible from the issuer URL.

#### For Test Environment (Router Worker):

Your unified endpoint should be:
```
https://enrai.your-subdomain.workers.dev
```

All OpenID Connect endpoints are automatically routed by the Router Worker:
- `/.well-known/openid-configuration` → Discovery Worker
- `/.well-known/jwks.json` → Discovery Worker
- `/authorize` → Auth Worker
- `/token` → Token Worker
- `/userinfo` → UserInfo Worker
- `/register`, `/introspect`, `/revoke` → Management Worker

**No additional configuration needed!** The Router Worker handles everything.

Individual workers are still accessible at their own subdomains for debugging:
- `https://enrai-op-discovery.your-subdomain.workers.dev`
- `https://enrai-op-auth.your-subdomain.workers.dev`
- etc.

#### For Production Environment (Custom Domain + Routes):

Cloudflare Routes were automatically configured by `setup-production.sh` and applied during deployment.

Verify routes in Cloudflare Dashboard:
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your domain
3. Navigate to **Workers Routes**
4. Verify routes are configured for each worker

Example routes configuration (already in your wrangler.toml files):

```toml
# In packages/op-discovery/wrangler.toml
[[routes]]
pattern = "id.example.com/.well-known/*"
zone_name = "example.com"

# In packages/op-auth/wrangler.toml
[[routes]]
pattern = "id.example.com/authorize"
zone_name = "example.com"

[[routes]]
pattern = "id.example.com/as/*"
zone_name = "example.com"

# In packages/op-token/wrangler.toml
[[routes]]
pattern = "id.example.com/token"
zone_name = "example.com"

# In packages/op-userinfo/wrangler.toml
[[routes]]
pattern = "id.example.com/userinfo"
zone_name = "example.com"

# In packages/op-management/wrangler.toml
[[routes]]
pattern = "id.example.com/register"
zone_name = "example.com"
```

> 💡 **Tip**: For more details on routing architecture, see [docs/ROUTER_SETUP.md](ROUTER_SETUP.md)

### 2. Test Full OAuth Flow

Use the deployed OP with a test client application:

```bash
# Example authorization URL
https://id.example.com/authorize?
  response_type=code&
  client_id=test-client&
  redirect_uri=https://your-app.com/callback&
  scope=openid%20profile%20email&
  state=random-state&
  nonce=random-nonce&
  code_challenge=BASE64URL(SHA256(verifier))&
  code_challenge_method=S256
```

### 3. Monitor Logs

View logs in Cloudflare Dashboard or via Wrangler:

```bash
# Stream real-time logs for a specific worker
cd packages/op-discovery
wrangler tail

# View logs in dashboard
# https://dash.cloudflare.com → Workers → Select worker → Logs
```

### 4. Set Up Analytics

Cloudflare provides analytics for each worker:

- Request count
- Error rate
- CPU time
- Response time (p50, p95, p99)

Access via: **Cloudflare Dashboard** → **Workers & Pages** → Select worker → **Analytics**

---

## Custom Domain Setup

### Using Cloudflare-Managed Domain

If your domain is managed by Cloudflare:

1. Go to **Workers & Pages** → Select worker → **Settings** → **Domains & Routes**
2. Click **Add Custom Domain**
3. Enter your domain (e.g., `id.example.com`)
4. Cloudflare will automatically provision SSL certificate

Repeat for all 5 workers or use routes (see Post-Deployment section).

### Using External Domain

1. Add a CNAME record pointing to your Worker:
   ```
   id.example.com CNAME enrai-op-discovery.your-subdomain.workers.dev
   ```

2. Add the custom domain in Cloudflare Dashboard (same as above)

3. Update `ISSUER_URL` in all `wrangler.toml` files:
   ```bash
   ./scripts/setup-production.sh
   # Enter: https://id.example.com
   ```

4. Redeploy:
   ```bash
   pnpm run deploy
   ```

---

## Security Considerations

### 🔐 Production Security Checklist

- ✅ **HTTPS Only**: Cloudflare Workers enforce HTTPS automatically
- ✅ **Secure Secrets**: Use Wrangler secrets, never commit keys to Git
- ✅ **Key Rotation**: Supported via KeyManager Durable Object (Phase 4)
- ✅ **PKCE**: Enabled by default for public clients
- ✅ **Short-lived Codes**: Authorization codes expire in 600 seconds
- ✅ **Rate Limiting**: Implemented via KV-based rate limiter
- ✅ **Security Headers**: CSP, HSTS, X-Frame-Options, etc.

### Private Key Protection

**NEVER:**
- Commit `.keys/` directory to Git (it's in `.gitignore`)
- Share private keys via email, Slack, etc.
- Use the same keys in development and production
- Store keys in environment variables in `wrangler.toml`

**ALWAYS:**
- Generate separate keys for production
- Store keys in Cloudflare secrets
- Rotate keys periodically
- Use key rotation via KeyManager

### Key Rotation

To rotate keys:

```bash
# 1. Generate new key pair
./scripts/setup-dev.sh

# 2. Upload new secrets
./scripts/setup-secrets.sh

# 3. Deploy (KeyManager will serve both old and new keys during transition)
pnpm run deploy

# 4. Old tokens remain valid until they expire
# 5. JWKS endpoint automatically returns all active keys
```

---

## Troubleshooting

### Issue: "KV namespace 'xxxxx' not found" During Deployment

**Cause:** KV namespace was deleted, renamed, or not properly propagated to Cloudflare's edge network

**Symptoms:**
```
✘ [ERROR] A request to the Cloudflare API failed.
  KV namespace 'bb5ca90df0fe4fe0a1600074822b8745' not found. [code: 10041]
```

**Solution:**

Option 1: Reset and recreate all KV namespaces (recommended):
```bash
# Delete and recreate all KV namespaces
./scripts/setup-kv.sh --reset

# Wait 10-30 seconds for propagation
sleep 30

# Deploy with retry logic
pnpm run deploy:retry
```

Option 2: Recreate specific namespaces interactively:
```bash
./scripts/setup-kv.sh
# Choose option 2 (Delete and recreate) when prompted
```

**Note:** If workers are already deployed, you may need to undeploy them first:
```bash
cd packages/op-auth
wrangler delete enrai-op-auth
```

### Issue: "Error: Missing required KV namespace"

**Cause:** KV namespaces not created or IDs not updated in `wrangler.toml`

**Solution:**
```bash
./scripts/setup-kv.sh
pnpm run deploy:retry
```

### Issue: "Error: No such secret: PRIVATE_KEY_PEM"

**Cause:** Secrets not uploaded to Cloudflare

**Solution:**
```bash
./scripts/setup-secrets.sh
```

Or manually:
```bash
cd packages/op-discovery
cat ../../.keys/private.pem | wrangler secret put PRIVATE_KEY_PEM
```

### Issue: JWKS Endpoint Returns Empty Array

**Cause:** `PUBLIC_JWK_JSON` secret not set or KeyManager not initialized

**Solution:**
```bash
./scripts/setup-secrets.sh
pnpm run deploy
```

### Issue: Token Endpoint Returns "Server configuration error"

**Cause:** `PRIVATE_KEY_PEM` secret not set or invalid

**Solution:**
1. Verify key format:
   ```bash
   cat .keys/private.pem
   # Should start with: -----BEGIN PRIVATE KEY-----
   ```
2. Re-upload secret:
   ```bash
   cd packages/op-token
   cat ../../.keys/private.pem | wrangler secret put PRIVATE_KEY_PEM
   ```

### Issue: GitHub Actions Deployment Fails

**Possible causes:**
- `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` secrets not set
- API token lacks necessary permissions
- Secrets or KV namespaces not configured in Cloudflare

**Solution:**
1. Verify GitHub secrets are set correctly
2. Ensure API token has "Edit Cloudflare Workers" permission
3. Run setup scripts manually:
   ```bash
   ./scripts/setup-kv.sh
   ./scripts/setup-secrets.sh
   ```

### Issue: "Invalid issuer" Error in Tokens

**Cause:** `ISSUER_URL` mismatch between configuration and actual request

**Solution:**
1. Ensure `ISSUER_URL` is set correctly in all `wrangler.toml` files
2. Run:
   ```bash
   ./scripts/setup-production.sh
   pnpm run deploy
   ```

### Issue: 404 Not Found on Endpoints

**Cause:** Workers are deployed but routes are not configured for custom domain

**Solution:**
Configure routes in `wrangler.toml` files or use workers.dev URLs directly (see [Custom Domain Setup](#custom-domain-setup))

### Issue: Workers Not Communicating (Service Bindings)

**Cause:** Service bindings not configured correctly

**Solution:**
Verify `wrangler.toml` service bindings:
```toml
# In packages/op-auth/wrangler.toml
[[services]]
binding = "OP_TOKEN"
service = "enrai-op-token"
```

Ensure worker names match exactly.

### Issue: Deployment Fails with Rate Limit or API Errors

**Cause:** Parallel deployment causing too many concurrent API requests to Cloudflare

**Symptoms:**
- Multiple workers fail during parallel deployment
- "Service unavailable" errors (code 7010)
- API rate limit errors (1,200 requests per 5 minutes)
- Random deployment failures

**Solution:**

Use the recommended sequential deployment with retry logic:
```bash
pnpm run deploy:with-router
```

This is now the **default recommended method** and automatically:
- Deploys one worker at a time
- Waits 10 seconds between deployments
- Retries failed deployments automatically (up to 4 attempts)
- Avoids overwhelming Cloudflare's API
- Conditionally deploys Router Worker based on configuration

**If you're still using the legacy parallel deployment:**
```bash
# Stop using this:
pnpm run deploy

# Switch to this instead:
pnpm run deploy:with-router
```

**Alternative:** Increase the delay in `scripts/deploy-with-retry.sh` if rate limits persist:
```bash
# Edit line 16 in scripts/deploy-with-retry.sh
INTER_DEPLOY_DELAY=15    # Increase from 10 to 15 seconds
```

### Issue: Deployment Succeeds but Endpoints Return Errors

**Cause:** KV namespaces were created/updated but not yet propagated globally

**Solution:**

Wait 30-60 seconds after running `setup-kv.sh` before deploying:
```bash
./scripts/setup-kv.sh
echo "Waiting for KV propagation..."
sleep 30
pnpm run deploy:retry
```

If still experiencing issues, undeploy and redeploy:
```bash
# Undeploy all workers
cd packages/op-discovery && wrangler delete enrai-op-discovery
cd ../op-auth && wrangler delete enrai-op-auth
cd ../op-token && wrangler delete enrai-op-token
cd ../op-userinfo && wrangler delete enrai-op-userinfo
cd ../op-management && wrangler delete enrai-op-management
cd ../..

# Wait and redeploy
sleep 30
pnpm run deploy:retry
```

---

## Next Steps

After successful deployment:

1. **Test OpenID Connect Flow**
   - Use the discovery endpoint to configure your OAuth client
   - Test the full authorization code flow with PKCE
   - Verify token validation and userinfo

2. **Register OAuth Clients**
   - Use the `/register` endpoint for dynamic client registration
   - Or configure static clients in your application

3. **Monitor Performance**
   - Check Cloudflare Analytics dashboard
   - Set up alerts for errors and performance degradation

4. **Plan for Scale**
   - Cloudflare Workers free tier: 100,000 requests/day
   - Paid tier: 10M+ requests/month
   - KV operations: 1,000 writes/day (free), 100M reads/day

5. **Consider Advanced Features**
   - Custom login UI (Phase 5)
   - Social login integration (Phase 7)
   - SAML 2.0 support (Phase 7)

---

## Additional Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Documentation](https://developers.cloudflare.com/workers/wrangler/)
- [OpenID Connect Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [Enrai Development Guide](../DEVELOPMENT.md)
- [Enrai Worker Architecture](../WORKERS.md)

---

## Support

If you encounter issues:

1. Check the [Troubleshooting](#troubleshooting) section
2. Review [GitHub Issues](https://github.com/sgrastar/enrai/issues)
3. Create a new issue with:
   - Deployment logs
   - Error messages
   - Steps to reproduce
   - Your environment details

---

**Deployment Complete!** 🎉

Your OpenID Connect Provider is now live with:
- ✅ 5 specialized workers deployed globally
- ✅ Automatic HTTPS and 0ms cold starts
- ✅ <50ms latency worldwide
- ✅ Production-ready OpenID Connect endpoints

Start integrating with your applications and enjoy global edge authentication!
