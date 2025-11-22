# Authrim Scripts Documentation

This directory contains setup and deletion scripts for managing Cloudflare resources used by the Authrim OpenID Connect Provider.

## Table of Contents

- [Setup Scripts](#setup-scripts)
- [Deletion Scripts](#deletion-scripts)
- [Deployment Scripts](#deployment-scripts)
- [Utility Scripts](#utility-scripts)
- [Safety Guidelines](#safety-guidelines)

---

## Setup Scripts

### setup-keys.sh
Generate RSA key pair for JWT signing and OpenID Connect operations.

**Usage:**
```bash
./scripts/setup-keys.sh [--kid=custom-key-id]
```

**What it does:**
- Generates RSA 2048-bit key pair
- Saves private key as PEM (`.keys/private.pem`)
- Saves public key as JWK (`.keys/public.jwk.json`)
- Creates metadata file with key information
- Required for all environments (local and remote)

**Output:**
- `.keys/private.pem` - Private key for JWT signing
- `.keys/public.jwk.json` - Public key in JWK format (for JWKS endpoint)
- `.keys/metadata.json` - Key metadata including Key ID

### setup-local-vars.sh
Generate `.dev.vars` file for local development environment variables.

**Usage:**
```bash
./scripts/setup-local-vars.sh
```

**What it does:**
- Loads RSA keys from `.keys/` directory
- Creates `.dev.vars` file with JWT keys
- Optionally configures Resend API for email (magic links)
- Sets local development configuration

**Requirements:**
- Requires `setup-keys.sh` to have been run first

**Environment Variables:**
- `PRIVATE_KEY_PEM` - JWT signing key
- `PUBLIC_JWK_JSON` - JWT verification key
- `KEY_ID` - JWT key identifier
- `RESEND_API_KEY` (optional) - Resend email service API key
- `EMAIL_FROM` (optional) - Sender email address

### setup-local-wrangler.sh
Generate `wrangler.toml` files for local development environment.

**Usage:**
```bash
./scripts/setup-local-wrangler.sh
```

**What it does:**
- Generates `wrangler.toml` for all worker packages
- Sets ISSUER_URL to `http://localhost:8787` for local development
- Configures Durable Objects bindings
- Sets KV namespace placeholders (to be filled by setup-kv.sh)
- Sets D1 database placeholders (to be filled by setup-d1.sh)

**ISSUER_URL:**
- Local: `http://localhost:8787`

**Requirements:**
- Requires `setup-keys.sh` to have been run first (for KEY_ID)

### setup-remote-wrangler.sh
Generate `wrangler.toml` files for remote Cloudflare Workers deployment.

Supports two deployment modes with automatic routing configuration:

**Usage:**
```bash
# Interactive mode (prompts for deployment mode)
./scripts/setup-remote-wrangler.sh

# Specify mode via CLI
./scripts/setup-remote-wrangler.sh --mode=test|production
./scripts/setup-remote-wrangler.sh --issuer-url=https://...
```

**Deployment Modes:**

#### 1) Test Environment (workers.dev + Router Worker)
- Uses Router Worker with Service Bindings
- Unified endpoint: `https://authrim.{subdomain}.workers.dev`
- All backend workers hidden (workers_dev=false)
- Only Router Worker is public (workers_dev=true)
- Automatically generates `packages/router/wrangler.toml`

**When to use:**
- Development and testing
- Quick setup without custom domain
- OpenID Connect compliant

#### 2) Production Environment (Custom Domain + Cloudflare Routes)
- Direct routing via Cloudflare Routes
- Custom domain endpoint: `https://id.yourdomain.com`
- Optimal performance (no extra router hop)
- All workers use workers_dev=false
- Automatically adds Cloudflare Routes to each worker
- Removes router configuration (not needed)

**When to use:**
- Production deployments
- Custom domain with Cloudflare DNS
- Optimal performance required

**What it does:**
- Interactive deployment mode selection
- workers.dev subdomain detection/input (for test mode)
- ISSUER_URL configuration
- UI_BASE_URL configuration (optional, for Device Flow)
- Updates all worker wrangler.toml files
- Configures Router Worker or Cloudflare Routes based on mode
- Sets workers_dev appropriately for each worker

**Configuration Examples:**
- Test: `https://authrim.sgrastar.workers.dev` (Router Worker)
- Production: `https://id.yourdomain.com` (Cloudflare Routes)

**Requirements:**
- Requires `setup-keys.sh` to have been run first (for KEY_ID)
- For production mode: Cloudflare-managed domain required

### setup-resend.sh
Configure Resend email service for sending magic link emails.

**Usage:**
```bash
./scripts/setup-resend.sh [--env=local|remote]
```

**What it does:**
- Prompts for Resend API key (optional)
- Configures email sender address
- For local: adds configuration to `.dev.vars`
- For remote: uploads as Cloudflare Secrets

**Environments:**
- `local` - Stores in `.dev.vars` (for local development)
- `remote` - Uploads to Cloudflare Secrets (for remote workers)

**Optional:** This script is optional. Without Resend:
- Magic links return URLs instead of sending emails
- Useful for development and testing

### setup-kv.sh
Create and configure KV namespaces for Authrim.

**Usage:**
```bash
# Interactive mode
./scripts/setup-kv.sh

# Reset mode (deletes and recreates all namespaces)
./scripts/setup-kv.sh --reset
```

**KV Namespaces created:**
- `AUTH_CODES` - OAuth authorization codes
- `STATE_STORE` - OAuth state parameters
- `NONCE_STORE` - OpenID Connect nonces
- `CLIENTS` - Registered OAuth clients
- `RATE_LIMIT` - Rate limiting counters
- `REFRESH_TOKENS` - OAuth refresh tokens
- `REVOKED_TOKENS` - Revoked token list
- `INITIAL_ACCESS_TOKENS` - Dynamic Client Registration tokens

Each namespace includes both production and preview versions.

### setup-d1.sh
Create and configure D1 databases for Authrim.

**Usage:**
```bash
# Interactive mode
./scripts/setup-d1.sh

# Reset mode (deletes and recreates database)
./scripts/setup-d1.sh --reset
```

**What it does:**
- Creates D1 database (default: `authrim-users-db`, customizable)
- Updates wrangler.toml files with D1 bindings
- Optionally runs database migrations

### setup-durable-objects.sh
Deploy Durable Objects for session and state management.

**Usage:**
```bash
# Deploy Durable Objects
./scripts/setup-durable-objects.sh

# Show information about DOs
./scripts/setup-durable-objects.sh --info
```

**Durable Objects deployed:**
- `SessionStore` - User session management with hot/cold storage
- `AuthorizationCodeStore` - OAuth authorization code management
- `RefreshTokenRotator` - Atomic refresh token rotation
- `KeyManager` - Cryptographic key management

### setup-secrets.sh
Configure secrets and environment variables for remote workers.

**Usage:**
```bash
./scripts/setup-secrets.sh
```

**What it does:**
- Uploads `PRIVATE_KEY_PEM` to Cloudflare Secrets
- Uploads `KEY_ID` as environment variable
- Applies to all worker packages

**Requirements:**
- Requires `setup-keys.sh` to have been run first
- Requires authentication with Cloudflare: `wrangler login`

### setup-remote-cors.sh
Configure CORS settings for remote Cloudflare Workers.

**Usage:**
```bash
./scripts/setup-remote-cors.sh
./scripts/setup-remote-cors.sh --origins="https://app.example.com"
```

**What it does:**
- Interactive CORS configuration
- Stores settings in `SETTINGS_KV` namespace
- Configurable:
  - Allowed Origins (comma-separated)
  - Allowed Methods (default: GET, POST, PUT, DELETE, OPTIONS)
  - Allowed Headers (default: Content-Type, Authorization, Accept)
  - Max Age (default: 86400 seconds)

**Requirements:**
- Requires authentication with Cloudflare: `wrangler login`
- SETTINGS_KV namespace must exist (created by setup-kv.sh)

**Note:** Can be called automatically by `deploy-remote-ui.sh`

### setup-github.sh
Configure GitHub integration and CI/CD settings.

**Usage:**
```bash
./scripts/setup-github.sh
```

---

## Deletion Scripts

⚠️ **WARNING**: These scripts permanently delete resources. Use with caution!

### delete-kv.sh
Delete KV namespaces for Authrim.

**Usage:**
```bash
# Interactive mode (with confirmation)
./scripts/delete-kv.sh

# Dry run mode (preview what would be deleted)
./scripts/delete-kv.sh --dry-run

# Force deletion (no confirmation - USE WITH CAUTION)
./scripts/delete-kv.sh --force
```

**What it deletes:**
- All Authrim KV namespaces (production and preview)
- Only deletes namespaces with names matching the Authrim pattern

**Safety features:**
- Requires typing 'DELETE' to confirm
- Only targets Authrim-specific namespaces
- Provides detailed summary before deletion
- Handles namespace-in-use errors gracefully

### delete-d1.sh
Delete D1 databases by environment.

**Usage:**
```bash
# Interactive mode (prompts for environment)
./scripts/delete-d1.sh

# Delete specific environment
./scripts/delete-d1.sh local
./scripts/delete-d1.sh remote

# Dry run mode
./scripts/delete-d1.sh local --dry-run

# Force deletion (USE WITH EXTREME CAUTION)
./scripts/delete-d1.sh local --force
```

**What it deletes:**
- D1 database for specified environment (default: `authrim-users-db`)
- Shows table contents before deletion
- Remote databases require typing 'DELETE REMOTE' to confirm

**Safety features:**
- Environment-specific deletion (won't delete all databases)
- Extra confirmation required for remote environment
- Shows database contents before deletion

### delete-workers.sh
Delete Cloudflare Workers and associated Durable Objects.

**Usage:**
```bash
# Interactive mode (select workers to delete)
./scripts/delete-workers.sh

# Delete all Authrim workers
./scripts/delete-workers.sh --all

# Delete specific worker
./scripts/delete-workers.sh --worker authrim-shared

# Dry run mode
./scripts/delete-workers.sh --all --dry-run

# Force deletion
./scripts/delete-workers.sh --all --force
```

**What it deletes:**
- Selected Cloudflare Workers
- Associated Durable Objects (automatically deleted with workers)
- Only deletes workers with names matching the Authrim pattern

**Requirements:**
- Requires `CLOUDFLARE_API_TOKEN` environment variable
- API token must have 'Workers Scripts:Edit' permission

**How to get API token:**
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Create a token with 'Workers Scripts:Edit' permission
3. Set as environment variable:
   ```bash
   export CLOUDFLARE_API_TOKEN=your_token_here
   ```

**Safety features:**
- Uses Cloudflare REST API for reliable deletion
- Requires typing 'DELETE' to confirm
- Only targets Authrim-specific workers (authrim-*)
- Uses `force=true` parameter to cleanly delete associated Durable Objects

### delete-all.sh
Master script to delete all Authrim resources in the correct order.

**Usage:**
```bash
# Interactive mode (prompts for environment)
./scripts/delete-all.sh

# Delete all resources for specific environment
./scripts/delete-all.sh local
./scripts/delete-all.sh remote

# Dry run mode (preview all deletions)
./scripts/delete-all.sh local --dry-run

# Force deletion (USE WITH EXTREME CAUTION)
./scripts/delete-all.sh local --force
```

**Deletion order:**
1. Workers and Durable Objects
2. KV Namespaces (production and preview)
3. D1 Database

**What it deletes:**
- All Cloudflare Workers (7 workers)
- All KV namespaces (16 namespaces: 8 production + 8 preview)
- D1 database for specified environment
- Associated Durable Objects (deleted automatically with workers)

**Safety features:**
- Environment-specific deletion
- Requires typing 'DELETE ALL' to confirm
- Remote environment requires typing 'DELETE REMOTE' + additional 'YES' confirmation
- Waits between deletion steps for Cloudflare propagation
- Provides detailed summary before and after deletion

**When to use this:**
- Clean slate for testing new deployment
- Environment teardown
- Troubleshooting deployment issues

---

## Deployment Scripts

### deploy-with-retry.sh
Deploy workers with retry logic and proper sequencing.

**Usage:**
```bash
# Deploy all workers with retries
./scripts/deploy-with-retry.sh

# Or use npm script
pnpm run deploy:retry
```

**What it does:**
- Deploys workers in correct order
- Retries failed deployments automatically
- Waits between deployments to avoid rate limits

### deploy-remote-ui.sh
Deploy SvelteKit UI (Login/Admin Pages) to Cloudflare Pages.

**Usage:**
```bash
./scripts/deploy-remote-ui.sh
```

**What it does:**
- Interactive domain configuration
- Supports custom domains or Cloudflare Pages auto-generated URLs
- Creates `.env` file with API Base URL
- Builds SvelteKit application
- Deploys to Cloudflare Pages
- Offers to configure CORS automatically
- Shows deployed URLs after completion

**Configuration Options:**
1. Domain Type:
   - Custom Domain (e.g., `https://login.example.com`)
   - Cloudflare Pages auto-generated URL (assigned after deployment)
2. Deployment Type:
   - Login Page only
   - Admin Page only
   - Both (Login + Admin)
3. API Base URL (e.g., `https://authrim.subdomain.workers.dev`)
4. Project names (defaults: `authrim-login`, `authrim-admin`)

**Requirements:**
- Requires authentication with Cloudflare: `wrangler login`
- Requires `setup-remote-cors.sh` to exist (for CORS auto-configuration)

**Note:** Automatically calls `setup-remote-cors.sh` to configure CORS after deployment

---

## Utility Scripts

### generate-initial-access-token.sh
Generate initial access tokens for Dynamic Client Registration.

**Usage:**
```bash
./scripts/generate-initial-access-token.sh
```

### performance-test.sh
Run performance tests against deployed workers.

**Usage:**
```bash
./scripts/performance-test.sh
```

### create-phase1-issues.sh
Create GitHub issues for Phase 1 implementation tasks.

**Usage:**
```bash
./scripts/create-phase1-issues.sh
```

---

## Safety Guidelines

### General Principles

1. **Always use dry-run mode first** when using deletion scripts
   ```bash
   ./scripts/delete-all.sh local --dry-run
   ```

2. **Never use `--force` flag on remote environment** unless you are absolutely certain

3. **Backup important data** before running deletion scripts

4. **Verify the environment** before executing deletion commands

5. **Check Cloudflare Dashboard** to confirm deletions

### Common Workflows

#### Starting Fresh (Local Development)

```bash
# 1. Delete all local resources (if they exist)
./scripts/delete-all.sh local

# 2. Set up fresh local environment
./scripts/setup-keys.sh                     # 1. Generate RSA keys
./scripts/setup-local-vars.sh               # 2. Create .dev.vars with environment variables
./scripts/setup-local-wrangler.sh           # 3. Generate wrangler.toml for local development
./scripts/setup-kv.sh                       # 4. Create KV namespaces
./scripts/setup-d1.sh                       # 5. Create D1 database
./scripts/setup-durable-objects.sh          # 6. Deploy Durable Objects
./scripts/setup-resend.sh --env=local       # 7. (Optional) Configure Resend for email

# 3. Start local development
pnpm run dev
```

#### Remote Environment Deployment

```bash
# 1. Generate keys
./scripts/setup-keys.sh

# 2. Generate wrangler.toml for remote
./scripts/setup-remote-wrangler.sh          # Prompts for ISSUER_URL (your remote endpoint)

# 3. Create cloud resources
./scripts/setup-kv.sh                       # Create KV namespaces
./scripts/setup-d1.sh remote                # Create D1 database
./scripts/setup-durable-objects.sh          # Deploy Durable Objects

# 4. Upload secrets
./scripts/setup-secrets.sh                  # Upload JWT keys to Cloudflare

# 5. Deploy API workers
pnpm run deploy:retry

# 6. Deploy UI to Cloudflare Pages (with optional CORS configuration)
./scripts/deploy-remote-ui.sh               # Deploy Login/Admin Pages
                                            # Prompts for domain config (custom or pages.dev)
                                            # Offers to configure CORS automatically

# 7. (Optional) Configure email
./scripts/setup-resend.sh --env=remote      # Configure Resend for email notifications

# OR manually configure CORS if skipped in step 6
./scripts/setup-remote-cors.sh              # Configure CORS for allowed origins
```

**Notes:**
- `deploy-remote-ui.sh` handles domain selection and CORS configuration
- For custom domains: Enter your domain URLs directly
- For Pages.dev URLs: Deployment generates the URLs automatically
- CORS configuration can be done automatically during UI deployment or manually later

#### Deleting Only KV Namespaces

```bash
# Preview what would be deleted
./scripts/delete-kv.sh --dry-run

# Delete after confirmation
./scripts/delete-kv.sh
```

#### Deleting Only Workers

```bash
# Set API token
export CLOUDFLARE_API_TOKEN=your_token_here

# Preview deletions
./scripts/delete-workers.sh --all --dry-run

# Delete specific worker
./scripts/delete-workers.sh --worker authrim-shared

# Delete all workers
./scripts/delete-workers.sh --all
```

#### Remote Environment Deletion (USE WITH EXTREME CAUTION)

```bash
# Always use dry-run first!
./scripts/delete-all.sh remote --dry-run

# If you're absolutely sure, run the actual deletion
# You will need to:
# 1. Type 'DELETE REMOTE'
# 2. Type 'YES' for final confirmation
./scripts/delete-all.sh remote
```

### Troubleshooting

#### "Cannot delete namespace - in use by workers"

Workers must be deleted before KV namespaces. Use `delete-all.sh` which deletes in correct order, or delete workers first:

```bash
./scripts/delete-workers.sh --all
# Wait 10 seconds
./scripts/delete-kv.sh
```

#### "Could not find Cloudflare API token"

For `delete-workers.sh`, you need to set the API token:

```bash
export CLOUDFLARE_API_TOKEN=your_token_here
./scripts/delete-workers.sh --all
```

Get your token from: https://dash.cloudflare.com/profile/api-tokens

#### "Database not found"

Ensure you're logged into the correct Cloudflare account:

```bash
npx wrangler whoami
npx wrangler login  # if needed
```

### Environment Variables

Required for deletion scripts:

```bash
# For delete-workers.sh
export CLOUDFLARE_API_TOKEN=your_api_token_here

# Optional: If wrangler doesn't detect automatically
export CLOUDFLARE_ACCOUNT_ID=your_account_id_here
```

---

## Script Execution Permissions

All scripts are executable. If you encounter permission issues:

```bash
chmod +x scripts/*.sh
```

---

## API Documentation References

The deletion scripts use the latest Cloudflare APIs:

- **Workers API**: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/
- **KV API**: https://developers.cloudflare.com/kv/reference/kv-commands/
- **D1 API**: https://developers.cloudflare.com/d1/wrangler-commands/

All API responses are in JSON format and properly parsed by the scripts.

---

## Contributing

When adding new scripts:

1. Add appropriate error handling
2. Include `--dry-run` mode for destructive operations
3. Require confirmation for production operations
4. Update this README with usage instructions
5. Add clear help text with `--help` flag

---

## Support

For issues or questions:

1. Check the troubleshooting section above
2. Verify you have the latest version of wrangler: `pnpm install -g wrangler`
3. Check Cloudflare status: https://www.cloudflarestatus.com/
4. Review Cloudflare documentation: https://developers.cloudflare.com/workers/

---

**Last Updated**: 2025-11-22

---

## Setup Flow Summary

### Local Development Environment
```
setup-keys.sh
    ↓
setup-local-vars.sh
    ↓
setup-local-wrangler.sh
    ↓
setup-kv.sh / setup-d1.sh / setup-durable-objects.sh
    ↓
setup-resend.sh --env=local (optional)
    ↓
pnpm run dev
```

### Remote Environment Deployment
```
setup-keys.sh
    ↓
setup-remote-wrangler.sh
    ↓
setup-kv.sh / setup-d1.sh / setup-durable-objects.sh
    ↓
setup-secrets.sh
    ↓
pnpm run deploy:retry (API Workers)
    ↓
deploy-remote-ui.sh (UI + optional CORS)
    ↓
setup-resend.sh --env=remote (optional)
```

**OR manually configure CORS:**
```
deploy-remote-ui.sh
    ↓
setup-remote-cors.sh (if CORS skipped in previous step)
```
