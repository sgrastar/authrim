# Deployment Guide

This guide walks you through deploying Authrim to Cloudflare Workers, resulting in a production-ready OpenID Connect Provider accessible via a public URL.

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

## Environment Types

Authrim supports three distinct environment types, each with different purposes and configuration methods:

### 🏠 Development Environment (Local)

**Purpose**: Local development and debugging on your machine

**Characteristics**:
- 💻 **Location**: `localhost` (ports 8787-8791)
- 🔧 **Command**: `pnpm run dev` (uses `wrangler dev`)
- 📁 **Configuration**: `.dev.vars` file (gitignored)
- 🔓 **Security**: HTTP allowed, relaxed security settings
- 🔑 **Secrets**: Stored in `.dev.vars` (local file)
- 🌐 **Access**: Local machine only
- 📧 **Email**: Magic links return URLs (no actual email sent unless configured)

**Setup**:
```bash
# Generate keys and create .dev.vars
./scripts/setup-dev.sh

# Optional: Add Resend API Key during setup
# Or manually add to .dev.vars:
echo 'RESEND_API_KEY="re_your_key"' >> .dev.vars
echo 'EMAIL_FROM="noreply@yourdomain.com"' >> .dev.vars

# Start development servers
pnpm run dev
```

**`.dev.vars` Example**:
```bash
PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----..."
PUBLIC_JWK_JSON='{"kty":"RSA",...}'
ALLOW_HTTP_REDIRECT="true"
RESEND_API_KEY="re_xxxxxxxxxxxx"  # Optional
EMAIL_FROM="noreply@yourdomain.com"  # Optional
```

---

### 🧪 Test Environment (Remote - workers.dev)

**Purpose**: Integration testing, demos, staging deployments

**Characteristics**:
- ☁️ **Location**: Cloudflare Workers
- 🌐 **URL**: `https://authrim.{your-subdomain}.workers.dev`
- 🔐 **Security**: HTTPS required, production-like security
- 🔑 **Secrets**: Uploaded via `wrangler secret put`
- 🌍 **Access**: Public internet
- 📧 **Email**: Actual emails sent via Resend (if configured)
- 🎯 **Use case**: Testing before production, demos, conformance testing

**Setup**:
```bash
# Configure for test environment
./scripts/setup-production.sh
# Choose: 1) Test Environment (workers.dev + Router Worker)

# Upload secrets (including optional Resend API Key)
./scripts/setup-secrets.sh

# Deploy all workers
pnpm run deploy
```

---

### 🚀 Production Environment (Remote - Custom Domain)

**Purpose**: Production deployment for real users

**Characteristics**:
- ☁️ **Location**: Cloudflare Workers
- 🌐 **URL**: Your custom domain (e.g., `https://id.yourdomain.com`)
- 🔒 **Security**: Strict security settings, HTTPS only
- 🔑 **Secrets**: Uploaded via `wrangler secret put`
- 🌍 **Access**: Public internet
- 📧 **Email**: Actual emails sent via Resend
- 🎯 **Use case**: Production service for real users
- 📊 **Performance**: Optimal (no extra router hop)

**Setup**:
```bash
# Configure for production
./scripts/setup-production.sh
# Choose: 2) Production Environment (Custom Domain + Routes)

# Upload secrets (including Resend API Key)
./scripts/setup-secrets.sh

# Deploy all workers
pnpm run deploy
```

---

### 📧 Email Configuration (Resend API Key)

Magic link authentication requires email configuration. This is **optional for development** (magic links return URLs) but **required for production**.

#### Development Environment

```bash
# Option 1: Interactive setup
./scripts/setup-dev.sh
# Follow prompts to enter Resend API Key

# Option 2: Manual configuration
echo 'RESEND_API_KEY="re_your_actual_key"' >> .dev.vars
echo 'EMAIL_FROM="noreply@yourdomain.com"' >> .dev.vars

# Restart dev server
pnpm run dev
```

#### Test/Production Environment

```bash
# Option 1: During secret upload
./scripts/setup-secrets.sh
# Answer 'y' when prompted for email configuration

# Option 2: Manual upload
cd packages/op-auth
echo "re_your_actual_key" | wrangler secret put RESEND_API_KEY
echo "noreply@yourdomain.com" | wrangler secret put EMAIL_FROM
cd ../..
```

**Getting Resend API Key**:
1. Sign up at [resend.com](https://resend.com)
2. Verify your domain (or use sandbox domain for testing)
3. Go to [API Keys](https://resend.com/api-keys) and create a new key
4. Copy the key (starts with `re_`)

**Testing Email Configuration**:
```bash
# Send test magic link
curl -X POST http://localhost:8788/auth/magic-link/send \
  -H "Content-Type: application/json" \
  -d '{"email":"your-email@example.com","name":"Test User"}'

# With RESEND_API_KEY: Email will be sent
# Without RESEND_API_KEY: Response includes magic_link_url
```

---

### Environment Comparison

| Feature | Development (Local) | Test (workers.dev) | Production (Custom Domain) |
|---------|---------------------|--------------------|-----------------------------|
| **Location** | localhost | Cloudflare Workers | Cloudflare Workers |
| **URL** | `http://localhost:8787` | `https://authrim.{subdomain}.workers.dev` | `https://id.yourdomain.com` |
| **Command** | `wrangler dev` | `wrangler deploy` | `wrangler deploy` |
| **Setup Script** | `setup-dev.sh` | `setup-production.sh` (Test) | `setup-production.sh` (Production) |
| **Secrets** | `.dev.vars` file | `wrangler secret put` | `wrangler secret put` |
| **HTTP** | ✅ Allowed | ❌ HTTPS only | ❌ HTTPS only |
| **Public Access** | ❌ Local only | ✅ Internet | ✅ Internet |
| **Email Sending** | ⚠️ Optional (returns URLs) | ✅ Real emails | ✅ Real emails |
| **Use Case** | Development, debugging | Testing, demos | Production service |

---

## Multiple Environment Support

Authrim supports deploying multiple environments to a single Cloudflare account. Each environment has:

- **Separate Resources**: KV namespaces, D1 databases, Workers all have environment-specific names
- **Isolated Data**: Dev, staging, and production data are completely separated
- **Same Codebase**: All environments use the same application code

### Environment Naming Convention

All Cloudflare resources are prefixed with the environment name:

```
dev-authrim-op-auth          # Dev environment worker
dev-CLIENTS                  # Dev environment KV namespace
dev-authrim-users-db         # Dev environment D1 database

staging-authrim-op-auth      # Staging environment worker
staging-CLIENTS              # Staging KV namespace
staging-authrim-users-db     # Staging D1 database

prod-authrim-op-auth         # Production environment worker
prod-CLIENTS                 # Production KV namespace
prod-authrim-users-db        # Production D1 database
```

### Environment-Specific Setup

Use the `--env` flag with setup scripts:

```bash
# Dev environment
./scripts/setup-remote-wrangler.sh --env=dev --domain=https://dev-auth.yourdomain.com
./scripts/setup-kv.sh --env=dev
./scripts/setup-d1.sh --env=dev
./scripts/setup-secrets.sh --env=dev
pnpm run deploy -- --env=dev

# Staging environment
./scripts/setup-remote-wrangler.sh --env=staging --domain=https://staging-auth.yourdomain.com
./scripts/setup-kv.sh --env=staging
./scripts/setup-d1.sh --env=staging
./scripts/setup-secrets.sh --env=staging
pnpm run deploy -- --env=staging

# Production environment
./scripts/setup-remote-wrangler.sh --env=prod --domain=https://auth.yourdomain.com --mode=production
./scripts/setup-kv.sh --env=prod
./scripts/setup-d1.sh --env=prod
./scripts/setup-secrets.sh --env=prod
pnpm run deploy -- --env=prod
```

### Deployment Options

```bash
# Deploy specific environment
pnpm run deploy -- --env=dev

# Deploy API only (exclude UI)
pnpm run deploy -- --env=dev --api-only

# Deploy individual package
cd packages/op-auth
DEPLOY_ENV=dev pnpm run deploy
```

### Monitor Environment-Specific Resources

View resources in Cloudflare Dashboard:

- **Workers**: Filter by `{env}-authrim-*`
- **KV**: Look for `{env}-CLIENTS`, `{env}-SETTINGS`, etc.
- **D1**: Find `{env}-authrim-users-db`
- **Durable Objects**: Check `{env}-authrim-shared`

---

## Prerequisites

Before deploying Authrim, ensure you have:

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

Authrim is a **monorepo** containing **6 specialized Cloudflare Workers** (including Durable Objects) plus an optional **Router Worker**:

| Worker | Package | Purpose |
|--------|---------|---------|
| **authrim-shared** | `packages/shared` | **Durable Objects** (SessionStore, AuthCodeStore, RefreshTokenRotator, KeyManager) |
| **authrim-op-discovery** | `packages/op-discovery` | Discovery & JWKS endpoints |
| **authrim-op-auth** | `packages/op-auth` | Authorization endpoint & PAR |
| **authrim-op-token** | `packages/op-token` | Token endpoint |
| **authrim-op-userinfo** | `packages/op-userinfo` | UserInfo endpoint |
| **authrim-op-management** | `packages/op-management` | Client registration |
| **authrim-router** | `packages/router` | Unified entry point (test env only) |

### 🔥 Durable Objects Layer

Authrim leverages **Cloudflare Durable Objects** for stateful operations with strong consistency:

| Durable Object | Purpose | Key Features |
|----------------|---------|--------------|
| **SessionStore** | User session management | Hot/cold storage, multi-device support, instant invalidation |
| **AuthorizationCodeStore** | OAuth code lifecycle | One-time use, PKCE validation, replay attack prevention |
| **RefreshTokenRotator** | Token rotation | Atomic rotation, theft detection, audit logging |
| **KeyManager** | Cryptographic keys | JWK management, automatic rotation, secure storage |

**⚠️ CRITICAL:** The `authrim-shared` package **MUST be deployed first** before deploying other workers!

### 🎯 Deployment Modes

Authrim supports two deployment modes to ensure OpenID Connect specification compliance:

#### 1️⃣ Test Environment (workers.dev + Router Worker)
- **Use case**: Development, testing, quick setup
- **How**: Router Worker acts as unified entry point with Service Bindings
- **Issuer**: `https://authrim.subdomain.workers.dev`
- **Pros**: OpenID Connect compliant, no custom domain needed
- **Deploy**: `pnpm run deploy`

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
git clone https://github.com/sgrastar/authrim.git
cd authrim
pnpm install

# 2. Login to Cloudflare
wrangler login

# 3. Run setup scripts (in order)
./scripts/setup-keys.sh                # Generate RSA keys
./scripts/setup-local-wrangler.sh      # Generate local wrangler.toml files
                                       # OR ./scripts/setup-remote-wrangler.sh for remote
./scripts/setup-kv.sh                  # Create KV namespaces
./scripts/setup-d1.sh                  # Create D1 database (Phase 5)
./scripts/setup-secrets.sh             # Upload secrets to Cloudflare
./scripts/setup-resend.sh --env=remote # Optional: Configure email (magic links)

# 4. Build all packages
pnpm run build

# 5. Deploy all workers with retry logic (recommended)
pnpm run deploy
# - Deploys in correct order: shared (Durable Objects) → workers → router
# - Uses sequential deployment with delays to avoid rate limits
# - Includes automatic retries on failure

# 6. Deploy UI to Cloudflare Pages (Phase 5+)
./scripts/deploy-remote-ui.sh
# - Interactive domain configuration (custom domain or Pages.dev)
# - Builds SvelteKit UI
# - Deploys to Cloudflare Pages
# - Auto-configures CORS settings
```

**Done!** Your OpenID Provider is now live with login UI.

> 💡 **Important**:
> - `setup-keys.sh` generates RSA keys (required first step)
> - Use `setup-local-wrangler.sh` for local development or `setup-remote-wrangler.sh` for Cloudflare deployment
> - `setup-remote-wrangler.sh` requires `ISSUER_URL` (your API domain)
> - `deploy-remote-ui.sh` is optional but provides login/registration UI (Phase 5+)
> - The deploy command automatically deploys `authrim-shared` (Durable Objects) first
> - Router Worker is conditionally deployed based on your configuration

---

## Step-by-Step Deployment

### 1. Clone and Install Dependencies

```bash
# Clone the repository
git clone https://github.com/sgrastar/authrim.git
cd authrim

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

### 3. Generate RSA Keys

**Important:** Generate RSA keys first, before creating infrastructure.

```bash
./scripts/setup-keys.sh
```

**What this does:**
- Generates an RSA-2048 key pair using OpenSSL
- Saves private key to `.keys/private.pem`
- Saves public key (JWK format) to `.keys/public.jwk.json`
- Saves key metadata to `.keys/metadata.json`

**Output:**
```
🔐 Authrim Key Generation
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Generating RSA keys...
✅ RSA key pair generated successfully!
   Key ID: dev-key-1731532800000-abc123
   Private Key: .keys/private.pem
   Public JWK: .keys/public.jwk.json
   Metadata: .keys/metadata.json
```

### 3b. Generate wrangler.toml Files

**For Local Development:**

```bash
./scripts/setup-local-wrangler.sh
```

Creates `wrangler.toml` files with:
- `ISSUER_URL = "http://localhost:8787"`
- Local environment variables
- Placeholder KV/D1 IDs (to be filled in by setup-kv.sh and setup-d1.sh)
- Router Worker configuration for local testing

**For Remote Deployment (Cloudflare):**

```bash
./scripts/setup-remote-wrangler.sh
```

**Interactive Deployment Mode Selection:**

The script will prompt you to choose between two deployment architectures:

#### Option 1: Test Environment (workers.dev + Router Worker)
```
📝 Deployment Mode Configuration

  1) Test Environment (workers.dev + Router Worker)
     • Single unified endpoint via Router Worker
     • Uses Service Bindings for internal routing
     • Best for: Development, testing, quick setup
     • OpenID Connect compliant ✅
```

**Configuration:**
- ISSUER_URL: `https://authrim.{subdomain}.workers.dev`
- workers.dev subdomain auto-detection from Cloudflare account
- Router Worker enabled with Service Bindings
- Backend workers hidden (workers_dev=false, routable only via Service Bindings)
- Generates `packages/router/wrangler.toml` with Service Bindings

**When to use:**
- Development and testing
- Quick deployment without custom domain setup
- OpenID Connect conformance testing

#### Option 2: Production Environment (Custom Domain + Cloudflare Routes)
```
  2) Production Environment (Custom Domain + Routes)
     • Direct routing via Cloudflare Routes
     • Optimal performance (no extra router hop)
     • Best for: Production deployments
     • Requires: Cloudflare-managed domain
```

**Configuration:**
- ISSUER_URL: Custom domain (e.g., `https://id.yourdomain.com`)
- Automatically adds Cloudflare Routes to each worker:
  - op-discovery: `/.well-known/*`
  - op-auth: `/authorize`, `/as/*`
  - op-token: `/token`
  - op-userinfo: `/userinfo`
  - op-management: `/register`, `/introspect`, `/revoke`
- All workers: workers_dev=false
- Router Worker removed (not needed)

**When to use:**
- Production deployments
- Custom domain with Cloudflare DNS management
- Optimal performance required
- Direct routing without extra hop

**What this does:**
- Prompts for deployment mode (Test or Production)
- Configures ISSUER_URL appropriately
- Optionally configures UI_BASE_URL (for Device Flow support)
- Generates all `wrangler.toml` files with correct settings
- Configures Router Worker (test mode) or Cloudflare Routes (production mode)
- Sets workers_dev appropriately for each worker

**⚠️ Important:**
- If `wrangler.toml` files already exist, confirmation is requested before overwriting
- This prevents accidental loss of KV namespace IDs, D1 bindings, or custom URLs
- For production mode, your domain must be managed by Cloudflare

**Output:**
```
🔐 Authrim Development Setup
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
⚡️ Authrim KV Namespace Setup
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
- Creates D1 database (`authrim-dev` or `authrim-prod`)
- Updates all `packages/*/wrangler.toml` files with D1 bindings
- Optionally runs database migrations (11 tables, 20 indexes)
- Displays database status and helpful commands

**Interactive prompts:**
```
📦 D1 Database Setup

Environment (dev/prod) [dev]: dev

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Database: authrim-dev
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📝 Creating D1 database: authrim-dev
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
wrangler d1 execute authrim-dev --file=migrations/001_initial_schema.sql
wrangler d1 execute authrim-dev --file=migrations/002_seed_default_data.sql
```

**Verify database:**

```bash
# List tables
wrangler d1 execute authrim-dev --command="SELECT name FROM sqlite_master WHERE type='table';"

# Count records
wrangler d1 execute authrim-dev --command="SELECT COUNT(*) FROM users;"
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
🔐 Authrim Cloudflare Secrets Setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Uploading secrets to op-discovery...
  • Uploading PRIVATE_KEY_PEM...
  • Uploading PUBLIC_JWK_JSON...
✅ op-discovery secrets uploaded
...
🎉 All secrets uploaded successfully!
```

**⚠️ IMPORTANT:** Never commit `.keys/` to version control! It's already in `.gitignore`.

### 7. Optional: Configure Email (Resend API)

For production magic link authentication via email:

```bash
./scripts/setup-resend.sh --env=remote
```

**What this does:**
- Prompts for Resend API key (from https://resend.com)
- Configures email sender address
- Uploads secrets to Cloudflare Workers

**Note:** This is optional. Without it, magic links will return URLs instead of sending emails (useful for development).

For **local development**, use:
```bash
./scripts/setup-resend.sh --env=local
```

This adds email configuration to `.dev.vars` for local testing.

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
pnpm run deploy
```

This is now the **recommended deployment method** for both test and production environments.

**What this does:**
- Builds all packages
- Deploys **`authrim-shared` (Durable Objects) first**
- Deploys other workers **sequentially** (one at a time)
- Adds 10-second delays between deployments to avoid rate limits
- Retries failed deployments automatically (up to 4 attempts with exponential backoff)
- **Conditionally deploys Router Worker**:
  - ✅ **Included** if `packages/router/wrangler.toml` exists (Test Environment)
  - ⊗ **Skipped** if `packages/router/wrangler.toml` missing (Production Environment)

**Workers deployed (Test Environment):**
- `authrim-shared` (Durable Objects - deployed first)
- `authrim-op-discovery`
- `authrim-op-management`
- `authrim-op-auth`
- `authrim-op-token`
- `authrim-op-userinfo`
- `authrim` (unified entry point - Router Worker)

**Workers deployed (Production Environment):**
- `authrim-shared` (Durable Objects - deployed first)
- `authrim-op-discovery`
- `authrim-op-management`
- `authrim-op-auth`
- `authrim-op-token`
- `authrim-op-userinfo`
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

• Packages in scope: @authrim/op-auth, @authrim/op-discovery, @authrim/op-management, @authrim/op-token, @authrim/op-userinfo, @authrim/router, @authrim/shared
• Running build in 7 packages
...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Deploying: op-discovery
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Published authrim-op-discovery (0.01 sec)
https://authrim-op-discovery.your-subdomain.workers.dev
✅ Successfully deployed: op-discovery

⏸️  Waiting 10s before next deployment to avoid rate limits...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Deploying: op-management
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Deploying: router
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Published authrim (0.01 sec)
https://authrim.your-subdomain.workers.dev
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

### 10. Deploy UI to Cloudflare Pages (Phase 5+)

Deploy the SvelteKit login/registration UI to Cloudflare Pages:

```bash
./scripts/deploy-remote-ui.sh
```

**What this does:**
- Interactive setup for UI domain configuration:
  - **Option 1**: Custom Domain (e.g., `https://login.example.com`)
  - **Option 2**: Auto-generated Cloudflare Pages URLs
- Prompts for API Base URL (your deployed workers' issuer URL)
- Builds SvelteKit UI to `.svelte-kit/cloudflare`
- Deploys to Cloudflare Pages
- **Auto-configures CORS** with detected URLs

**Interactive prompts:**
```
🚀 Authrim Remote UI Deployment
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 Domain Configuration

How would you like to configure UI domains?

  1) Custom Domain (e.g., https://login.example.com)
  2) Cloudflare Pages auto-generated URL (e.g., https://authrim-login-abc.pages.dev)
  3) Cancel

Enter your choice (1-3): 1

📝 Enter custom domains:
Login Page domain (e.g., https://login.example.com): https://login.example.com
Admin Page domain (e.g., https://admin.example.com): https://admin.example.com

🔌 API Base URL (e.g., https://authrim.subdomain.workers.dev): https://auth.example.com

📦 Which UI components would you like to deploy?
  1) Login Page only
  2) Admin Page only
  3) Both (Login + Admin)

Enter your choice (1-3) [3]: 3

✅ Configuration Summary
🌐 Domain Configuration:
   Type: Custom Domain
   Login Page: https://login.example.com
   Admin Page: https://admin.example.com

🔌 API Configuration:
   Base URL: https://auth.example.com

🔒 CORS Configuration
Configure CORS for these origins? (Y/n): y

🔧 Running CORS configuration...
```

**Output:**
```
🎉 UI Deployment Complete!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Deployed URLs:
   🌐 https://login.example.com
   🌐 https://admin.example.com

✅ CORS Configuration Complete!
   • Stored in: SETTINGS_KV[cors_settings]
   • Origins: https://login.example.com, https://admin.example.com
```

**Note:**
- This step is **optional but recommended for Phase 5+** (UI/UX implementation)
- For Phase 1-4, skip this step (API-only deployment)
- CORS auto-configuration happens after deployment (can be skipped and run later with `./scripts/setup-remote-cors.sh`)

### 11. Verify Deployment

Test your deployed OpenID Provider and UI:

```bash
# Replace with your configured ISSUER_URL
ISSUER_URL="https://id.example.com"
LOGIN_UI="https://login.example.com"

# Test discovery endpoint
curl "$ISSUER_URL/.well-known/openid-configuration" | jq

# Test JWKS endpoint
curl "$ISSUER_URL/.well-known/jwks.json" | jq

# Verify UI is accessible
curl -I "$LOGIN_UI"
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

Authrim includes pre-configured GitHub Actions workflows for automated testing and deployment.

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
https://authrim.your-subdomain.workers.dev
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
- `https://authrim-op-discovery.your-subdomain.workers.dev`
- `https://authrim-op-auth.your-subdomain.workers.dev`
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

Authrim supports two approaches for custom domains:
1. **Custom Domains** - Point a full domain/subdomain to a single Worker
2. **Routes** - Map specific URL patterns to different Workers (recommended for path-based routing)

### Understanding Custom Domains vs Routes

| Feature | Custom Domains | Routes |
|---------|---------------|--------|
| **Use Case** | Single Worker per domain/subdomain | Multiple Workers per domain with path-based routing |
| **Path Control** | All paths go to one Worker | Different paths can go to different Workers |
| **DNS Management** | Automatic | Manual or automatic |
| **SSL Certificates** | Automatic | Automatic (via Cloudflare) |
| **Best For** | Simple deployments | Complex routing, microservices |

#### Example Scenarios

**Custom Domains:**
- `api.example.com` → All paths to API Worker
- `login.example.com` → All paths to Login Worker
- `admin.example.com` → All paths to Admin Worker

**Routes (Path-Based):**
- `example.com/api/*` → API Worker
- `example.com/login/*` → Login Worker (Cloudflare Pages)
- `example.com/admin/*` → Admin Worker (Cloudflare Pages)
- `example.com/.well-known/*` → Discovery Worker

### Method 1: Using Cloudflare Routes (Recommended for Production)

Routes provide fine-grained control over which Worker handles which paths. This is the recommended approach for production deployments and allows all services (API, login, admin) to share the same domain.

#### Step 1: Configure Domain in Cloudflare DNS

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your domain (e.g., `example.com`)
3. Navigate to **DNS** → **Records**
4. Add an **A** or **AAAA** record:
   - **Type**: A
   - **Name**: `@` (for root domain) or subdomain (e.g., `auth`)
   - **IPv4 address**: `192.0.2.1` (placeholder, Cloudflare will proxy)
   - **Proxy status**: ✅ Proxied (orange cloud)
   - Click **Save**

> **Note:** The IP address is a placeholder. When proxied through Cloudflare, the actual IP doesn't matter as Workers will intercept requests via Routes.

#### Step 2: Configure Routes in wrangler.toml

**Option A: Using `setup-remote-wrangler.sh` (Recommended)**

```bash
./scripts/setup-remote-wrangler.sh --mode=production --issuer-url=https://auth.example.com
```

This script automatically:
- Configures all `wrangler.toml` files with your domain
- Adds appropriate Routes to each worker
- Sets `workers_dev = false` for production
- Removes the Router Worker (not needed in production)

**Option B: Manual Configuration**

Edit each worker's `wrangler.toml` to add Routes. Here's a complete example:

**packages/op-discovery/wrangler.toml:**
```toml
name = "authrim-op-discovery"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

# Routes for Discovery endpoints
[[routes]]
pattern = "auth.example.com/.well-known/*"
zone_name = "example.com"

# Durable Objects Bindings
[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "RATE_LIMITER"
class_name = "RateLimiterCounter"
script_name = "authrim-shared"

[vars]
ISSUER_URL = "https://auth.example.com"
TOKEN_EXPIRY = "3600"
CODE_EXPIRY = "600"
STATE_EXPIRY = "600"
NONCE_EXPIRY = "600"
REFRESH_TOKEN_EXPIRY = "2592000"
KEY_ID = "your-key-id"
ALLOW_HTTP_REDIRECT = "false"
```

**packages/op-auth/wrangler.toml:**
```toml
name = "authrim-op-auth"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

# Routes for Authorization endpoints
[[routes]]
pattern = "auth.example.com/authorize"
zone_name = "example.com"

[[routes]]
pattern = "auth.example.com/as/*"
zone_name = "example.com"

# KV Namespaces
[[kv_namespaces]]
binding = "CLIENTS"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "authrim-users-db"
database_id = "your-d1-database-id"

# Durable Objects Bindings
[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"
script_name = "authrim-shared"

[vars]
ISSUER_URL = "https://auth.example.com"
TOKEN_EXPIRY = "3600"
CODE_EXPIRY = "600"
STATE_EXPIRY = "600"
NONCE_EXPIRY = "600"
REFRESH_TOKEN_EXPIRY = "2592000"
KEY_ID = "your-key-id"
ALLOW_HTTP_REDIRECT = "false"
```

**packages/op-token/wrangler.toml:**
```toml
name = "authrim-op-token"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

# Routes for Token endpoint
[[routes]]
pattern = "auth.example.com/token"
zone_name = "example.com"

# KV Namespaces
[[kv_namespaces]]
binding = "CLIENTS"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"

# Durable Objects Bindings
[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "AUTH_CODE_STORE"
class_name = "AuthorizationCodeStore"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"
script_name = "authrim-shared"

[vars]
ISSUER_URL = "https://auth.example.com"
TOKEN_EXPIRY = "3600"
CODE_EXPIRY = "600"
STATE_EXPIRY = "600"
NONCE_EXPIRY = "600"
REFRESH_TOKEN_EXPIRY = "2592000"
KEY_ID = "your-key-id"
ALLOW_HTTP_REDIRECT = "false"
```

**packages/op-userinfo/wrangler.toml:**
```toml
name = "authrim-op-userinfo"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

# Routes for UserInfo endpoint
[[routes]]
pattern = "auth.example.com/userinfo"
zone_name = "example.com"

# KV Namespaces
[[kv_namespaces]]
binding = "CLIENTS"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "authrim-users-db"
database_id = "your-d1-database-id"

# Durable Objects Bindings
[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "authrim-shared"

[vars]
ISSUER_URL = "https://auth.example.com"
TOKEN_EXPIRY = "3600"
CODE_EXPIRY = "600"
STATE_EXPIRY = "600"
NONCE_EXPIRY = "600"
REFRESH_TOKEN_EXPIRY = "2592000"
KEY_ID = "your-key-id"
ALLOW_HTTP_REDIRECT = "false"
```

**packages/op-management/wrangler.toml:**
```toml
name = "authrim-op-management"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

# Routes for Management endpoints
[[routes]]
pattern = "auth.example.com/register"
zone_name = "example.com"

[[routes]]
pattern = "auth.example.com/introspect"
zone_name = "example.com"

[[routes]]
pattern = "auth.example.com/revoke"
zone_name = "example.com"

# KV Namespaces
[[kv_namespaces]]
binding = "CLIENTS"
id = "your-kv-namespace-id"
preview_id = "your-preview-kv-namespace-id"

[[kv_namespaces]]
binding = "INITIAL_ACCESS_TOKENS"
id = "your-initial-access-tokens-kv-id"
preview_id = "your-preview-initial-access-tokens-kv-id"

[[kv_namespaces]]
binding = "SETTINGS"
id = "your-settings-kv-id"
preview_id = "your-preview-settings-kv-id"

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "authrim-users-db"
database_id = "your-d1-database-id"

# Durable Objects Bindings
[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "REFRESH_TOKEN_ROTATOR"
class_name = "RefreshTokenRotator"
script_name = "authrim-shared"

[[durable_objects.bindings]]
name = "SESSION_STORE"
class_name = "SessionStore"
script_name = "authrim-shared"

[vars]
ISSUER_URL = "https://auth.example.com"
TOKEN_EXPIRY = "3600"
CODE_EXPIRY = "600"
STATE_EXPIRY = "600"
NONCE_EXPIRY = "600"
REFRESH_TOKEN_EXPIRY = "2592000"
KEY_ID = "your-key-id"
ALLOW_HTTP_REDIRECT = "false"
```

#### Step 3: Deploy Workers

```bash
# Build all packages
pnpm run build

# Deploy with retry logic (recommended)
pnpm run deploy
```

#### Step 4: Verify Routes in Cloudflare Dashboard

After deploying, verify that Routes are properly configured in the Cloudflare Dashboard.

**Via Cloudflare Dashboard:**

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your domain (e.g., `example.com`)
3. Navigate to **Workers Routes** (in the left sidebar)
4. You should see all routes automatically created by `wrangler deploy`

**Expected Routes:**
- `auth.example.com/.well-known/*` → `authrim-op-discovery`
- `auth.example.com/authorize` → `authrim-op-auth`
- `auth.example.com/as/*` → `authrim-op-auth`
- `auth.example.com/token` → `authrim-op-token`
- `auth.example.com/userinfo` → `authrim-op-userinfo`
- `auth.example.com/register` → `authrim-op-management`
- `auth.example.com/introspect` → `authrim-op-management`
- `auth.example.com/revoke` → `authrim-op-management`

**Via Wrangler CLI:**

```bash
# List all routes for a specific worker
cd packages/op-discovery
wrangler deployments list

# View routes in wrangler.toml
cat wrangler.toml | grep -A 2 "routes"
```

#### Cloudflare Dashboard Operations Guide

This section provides detailed step-by-step instructions for configuring custom domains and routes in the Cloudflare Dashboard.

##### 1. Adding DNS Records

Before configuring Workers, ensure your domain has proper DNS records:

**Steps:**
1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your domain from the account home
3. Click **DNS** in the left sidebar
4. Click **Add record**
5. Configure the record:
   - **Type**: Select `A` (IPv4) or `AAAA` (IPv6)
   - **Name**: Enter subdomain (e.g., `auth` for `auth.example.com`) or `@` for root domain
   - **IPv4/IPv6 address**: Enter `192.0.2.1` (placeholder, will be proxied)
   - **Proxy status**: Toggle **ON** (orange cloud icon) - This is critical for Workers to intercept requests
   - **TTL**: Auto
6. Click **Save**

**Result:** Your domain/subdomain is now proxied through Cloudflare and ready for Worker Routes.

> **Important:** The "Proxied" status (orange cloud) must be enabled. If it's DNS-only (grey cloud), Workers Routes will not work.

##### 2. Viewing Worker Routes

After deploying workers with `wrangler deploy`, routes are automatically registered.

**Steps to view routes:**
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your domain
3. Click **Workers Routes** in the left sidebar (under "Workers & Pages" section)
4. You'll see a table with columns:
   - **Route** - URL pattern (e.g., `auth.example.com/token`)
   - **Worker** - Assigned worker name (e.g., `authrim-op-token`)
   - **Environment** - Production or Preview
   - **Status** - Active or Inactive

**What you should see:**

| Route | Worker | Environment |
|-------|--------|-------------|
| `auth.example.com/.well-known/*` | `authrim-op-discovery` | Production |
| `auth.example.com/authorize` | `authrim-op-auth` | Production |
| `auth.example.com/as/*` | `authrim-op-auth` | Production |
| `auth.example.com/token` | `authrim-op-token` | Production |
| `auth.example.com/userinfo` | `authrim-op-userinfo` | Production |
| `auth.example.com/register` | `authrim-op-management` | Production |
| `auth.example.com/introspect` | `authrim-op-management` | Production |
| `auth.example.com/revoke` | `authrim-op-management` | Production |

##### 3. Manually Adding or Editing Routes (if needed)

If routes weren't automatically created or you need to modify them:

**Steps:**
1. Go to **Workers Routes** (as described above)
2. Click **Add route**
3. Fill in the form:
   - **Route**: Enter the URL pattern (e.g., `auth.example.com/token`)
   - **Zone**: Select your domain from dropdown
   - **Worker**: Select the worker from dropdown (e.g., `authrim-op-token`)
   - **Environment**: Select `Production`
4. Click **Save**

**Example:** Adding a route for the Token endpoint:
- **Route**: `auth.example.com/token`
- **Zone**: `example.com`
- **Worker**: `authrim-op-token`
- **Environment**: Production

**Wildcard Routes:**

For path patterns with wildcards (e.g., `/.well-known/*`), use the `*` character:
- **Route**: `auth.example.com/.well-known/*`
- This matches: `/.well-known/openid-configuration`, `/.well-known/jwks.json`, etc.

##### 4. Adding Custom Domains to Individual Workers

If you prefer Custom Domains over Routes (simpler but less flexible):

**Steps:**
1. Go to **Workers & Pages** in the left sidebar
2. Click on your worker (e.g., `authrim-op-discovery`)
3. Click **Settings** tab
4. Click **Domains & Routes**
5. Under **Custom Domains**, click **Add Custom Domain**
6. Enter your domain:
   - **Domain**: `api.example.com` (full domain or subdomain)
   - Cloudflare automatically:
     - Creates DNS records (if not exist)
     - Provisions SSL certificate
     - Configures routing
7. Click **Add Custom Domain**
8. Wait 1-2 minutes for SSL certificate provisioning

**Result:** The worker is now accessible at `https://api.example.com` (all paths)

**Limitations:**
- All paths under `api.example.com` go to this worker
- Cannot split paths to different workers (use Routes instead)

##### 5. Monitoring Worker Performance

**Steps:**
1. Go to **Workers & Pages**
2. Click on your worker
3. Click **Metrics** tab
4. View analytics:
   - **Requests** - Total requests over time
   - **Errors** - Error rate and types
   - **CPU Time** - Average CPU time per request
   - **Duration** - p50, p95, p99 latency
   - **Success Rate** - Percentage of successful requests

**Useful for:**
- Identifying performance bottlenecks
- Monitoring errors and debugging
- Analyzing traffic patterns

##### 6. Viewing Worker Logs

**Real-time logs via Dashboard:**
1. Go to **Workers & Pages**
2. Click on your worker
3. Click **Logs** tab
4. Click **Begin log stream**
5. View real-time logs as requests come in

**Filtering logs:**
- Filter by **Status** (e.g., only errors)
- Filter by **Method** (GET, POST, etc.)
- Search by **Text** (search log messages)

**Via Wrangler CLI (recommended for development):**

```bash
# Stream logs for a specific worker
cd packages/op-token
wrangler tail

# Filter logs
wrangler tail --status error
wrangler tail --method POST
wrangler tail --search "token"
```

##### 7. Managing Worker Secrets

Secrets (like `PRIVATE_KEY_PEM`) are managed separately from environment variables.

**Steps to add/update secrets:**
1. Go to **Workers & Pages**
2. Click on your worker
3. Click **Settings** tab
4. Scroll to **Variables and Secrets**
5. Click **Add variable**
6. Select **Secret** (not "Variable")
7. Enter:
   - **Variable name**: `PRIVATE_KEY_PEM`
   - **Value**: Paste your private key
8. Click **Save**

**Via Wrangler CLI (recommended):**

```bash
cd packages/op-token
cat ../../.keys/private.pem | wrangler secret put PRIVATE_KEY_PEM
```

**Viewing secrets:**
- Secret values are never displayed in the dashboard (for security)
- You can only see secret names, not values
- To update, you must re-upload the secret

##### 8. Rolling Back Deployments

If a deployment causes issues, you can roll back:

**Steps:**
1. Go to **Workers & Pages**
2. Click on your worker
3. Click **Deployments** tab
4. Find the previous working deployment
5. Click **⋯** (three dots) → **Rollback to this deployment**
6. Confirm rollback

**Via Wrangler CLI:**

```bash
cd packages/op-token
wrangler deployments list
# Note the deployment ID of the version you want to roll back to
wrangler rollback [deployment-id]
```

##### 9. Configuring Zone Settings for Workers

**SSL/TLS Settings:**
1. Go to your domain dashboard
2. Click **SSL/TLS** in the left sidebar
3. Set **SSL/TLS encryption mode** to **Full** or **Full (strict)** (recommended)
   - **Flexible**: Not recommended (Cloudflare to origin is HTTP)
   - **Full**: Cloudflare to origin is HTTPS (self-signed cert OK)
   - **Full (strict)**: Cloudflare to origin is HTTPS (valid cert required)

For Workers, **Full** is usually sufficient since Workers don't have traditional "origins."

**Security Settings:**
1. Go to **Security** → **Settings**
2. Configure:
   - **Security Level**: Medium or High
   - **Challenge Passage**: 30 minutes (default)
   - **Browser Integrity Check**: On (recommended)

**Firewall Rules:**
1. Go to **Security** → **WAF**
2. Configure Web Application Firewall rules if needed
3. For API endpoints, consider:
   - Rate limiting rules
   - IP allowlisting/blocklisting
   - Custom firewall rules

##### 10. Testing Your Configuration

After configuring routes and domains, test your endpoints:

**Test Discovery Endpoint:**
```bash
curl https://auth.example.com/.well-known/openid-configuration | jq
```

**Test JWKS Endpoint:**
```bash
curl https://auth.example.com/.well-known/jwks.json | jq
```

**Test Authorization Endpoint (expect redirect or error):**
```bash
curl -I https://auth.example.com/authorize
```

**Test Token Endpoint (expect error without proper request):**
```bash
curl -X POST https://auth.example.com/token
```

**Check SSL Certificate:**
```bash
curl -vI https://auth.example.com/.well-known/openid-configuration 2>&1 | grep -i "SSL"
```

**Expected Results:**
- ✅ All endpoints return 200 OK or appropriate errors
- ✅ SSL certificate is valid (issued by Cloudflare)
- ✅ Response headers include CORS headers (if configured)
- ✅ Discovery endpoint returns valid JSON with correct `issuer` URL

### Method 2: Using Custom Domains (Simple Approach)

Custom Domains are simpler but less flexible. Each domain/subdomain points to a single Worker.

#### Using Cloudflare-Managed Domain

1. Go to **Workers & Pages** → Select worker → **Settings** → **Domains & Routes**
2. Click **Add Custom Domain**
3. Enter your domain (e.g., `id.example.com`)
4. Cloudflare will automatically provision SSL certificate

Repeat for all workers if you want separate subdomains:
- `api.example.com` → Discovery Worker
- `auth.example.com` → Auth Worker
- etc.

#### Using External Domain

1. Add a CNAME record pointing to your Worker:
   ```
   id.example.com CNAME authrim-op-discovery.your-subdomain.workers.dev
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

### Advanced: Path-Based Routing for API + UI on Same Domain

**Question:** Can API, Login UI, and Admin UI all use the same custom domain with different paths?

**Answer:** ✅ **YES!** You can use Cloudflare Routes to achieve this.

#### Example Setup

Let's deploy everything under `example.com`:

**Goal:**
- `example.com/api/*` → Authrim API (Workers)
- `example.com/login/*` → Login UI (Cloudflare Pages)
- `example.com/admin/*` → Admin UI (Cloudflare Pages)
- `example.com/.well-known/*` → Discovery endpoint

#### Implementation Steps

**1. Configure API Workers with `/api` prefix:**

Modify each worker's Routes to include `/api` prefix:

```toml
# packages/op-discovery/wrangler.toml
[[routes]]
pattern = "example.com/api/.well-known/*"
zone_name = "example.com"

# packages/op-auth/wrangler.toml
[[routes]]
pattern = "example.com/api/authorize"
zone_name = "example.com"

[[routes]]
pattern = "example.com/api/as/*"
zone_name = "example.com"

# packages/op-token/wrangler.toml
[[routes]]
pattern = "example.com/api/token"
zone_name = "example.com"

# packages/op-userinfo/wrangler.toml
[[routes]]
pattern = "example.com/api/userinfo"
zone_name = "example.com"

# packages/op-management/wrangler.toml
[[routes]]
pattern = "example.com/api/register"
zone_name = "example.com"

[[routes]]
pattern = "example.com/api/introspect"
zone_name = "example.com"

[[routes]]
pattern = "example.com/api/revoke"
zone_name = "example.com"
```

**Important:** Update `ISSUER_URL` to include `/api`:
```toml
[vars]
ISSUER_URL = "https://example.com/api"
```

**2. Configure Cloudflare Pages for UI:**

When deploying Login and Admin UIs to Cloudflare Pages:

**Login UI:**
- Deploy to Cloudflare Pages
- In Pages Dashboard → Custom domains → Add `example.com`
- Configure **Path** routing (if available) or use Pages Functions to handle `/login/*`

**Admin UI:**
- Deploy to separate Cloudflare Pages project
- Configure **Path** routing for `/admin/*`

**Alternative Approach (Using a Router Worker):**

If Cloudflare Pages doesn't support path-based routing directly, create a Router Worker:

```typescript
// packages/unified-router/src/index.ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route API requests to API Workers
    if (url.pathname.startsWith('/api/')) {
      // Strip /api prefix and forward to appropriate worker
      const apiPath = url.pathname.substring(4);

      if (apiPath.startsWith('/.well-known/')) {
        return env.OP_DISCOVERY.fetch(request);
      } else if (apiPath === '/authorize' || apiPath.startsWith('/as/')) {
        return env.OP_AUTH.fetch(request);
      } else if (apiPath === '/token') {
        return env.OP_TOKEN.fetch(request);
      } else if (apiPath === '/userinfo') {
        return env.OP_USERINFO.fetch(request);
      } else if (apiPath.match(/^\/(register|introspect|revoke)/)) {
        return env.OP_MANAGEMENT.fetch(request);
      }
    }

    // Route UI requests to Cloudflare Pages
    if (url.pathname.startsWith('/login/')) {
      return fetch(`https://your-login-ui.pages.dev${url.pathname}`);
    }

    if (url.pathname.startsWith('/admin/')) {
      return fetch(`https://your-admin-ui.pages.dev${url.pathname}`);
    }

    return new Response('Not Found', { status: 404 });
  }
};
```

**wrangler.toml for unified router:**
```toml
name = "authrim-unified"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
workers_dev = false

# Catch-all route for entire domain
[[routes]]
pattern = "example.com/*"
zone_name = "example.com"

# Service Bindings to API workers
[[services]]
binding = "OP_DISCOVERY"
service = "authrim-op-discovery"

[[services]]
binding = "OP_AUTH"
service = "authrim-op-auth"

[[services]]
binding = "OP_TOKEN"
service = "authrim-op-token"

[[services]]
binding = "OP_USERINFO"
service = "authrim-op-userinfo"

[[services]]
binding = "OP_MANAGEMENT"
service = "authrim-op-management"

[vars]
LOGIN_UI_URL = "https://your-login-ui.pages.dev"
ADMIN_UI_URL = "https://your-admin-ui.pages.dev"
```

**3. Deploy everything:**

```bash
pnpm run build
pnpm run deploy
```

**Result:**
- `https://example.com/api/.well-known/openid-configuration` → Discovery
- `https://example.com/api/authorize` → Authorization
- `https://example.com/api/token` → Token
- `https://example.com/login/` → Login UI
- `https://example.com/admin/` → Admin UI

#### CORS Configuration

When using path-based routing on the same domain, configure CORS to allow UI to call API:

```bash
./scripts/setup-remote-cors.sh --origins="https://example.com"
```

Or manually in SETTINGS_KV:
```json
{
  "enabled": true,
  "allowed_origins": ["https://example.com"],
  "allowed_methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  "allowed_headers": ["Content-Type", "Authorization", "Accept"],
  "max_age": 86400
}
```

> **Note:** When API and UI share the same domain (even with different paths), CORS may not be strictly necessary since they share the same origin. However, it's still recommended for security and flexibility.

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
pnpm run deploy
```

Option 2: Recreate specific namespaces interactively:
```bash
./scripts/setup-kv.sh
# Choose option 2 (Delete and recreate) when prompted
```

**Note:** If workers are already deployed, you may need to undeploy them first:
```bash
cd packages/op-auth
wrangler delete authrim-op-auth
```

### Issue: "Error: Missing required KV namespace"

**Cause:** KV namespaces not created or IDs not updated in `wrangler.toml`

**Solution:**
```bash
./scripts/setup-kv.sh
pnpm run deploy
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
service = "authrim-op-token"
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
pnpm run deploy
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
pnpm run deploy
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
pnpm run deploy
```

If still experiencing issues, undeploy and redeploy:
```bash
# Undeploy all workers
cd packages/op-discovery && wrangler delete authrim-op-discovery
cd ../op-auth && wrangler delete authrim-op-auth
cd ../op-token && wrangler delete authrim-op-token
cd ../op-userinfo && wrangler delete authrim-op-userinfo
cd ../op-management && wrangler delete authrim-op-management
cd ../..

# Wait and redeploy
sleep 30
pnpm run deploy
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
- [Authrim Development Guide](../DEVELOPMENT.md)
- [Authrim Worker Architecture](../WORKERS.md)

---

## Support

If you encounter issues:

1. Check the [Troubleshooting](#troubleshooting) section
2. Review [GitHub Issues](https://github.com/sgrastar/authrim/issues)
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
