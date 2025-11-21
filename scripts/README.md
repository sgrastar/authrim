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

### setup-dev.sh
Initialize development environment configuration.

**Usage:**
```bash
./scripts/setup-dev.sh
```

**What it does:**
- Generates wrangler.toml files for all packages
- Sets up development environment variables
- Configures local development settings

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
- Creates D1 database (e.g., `authrim-dev`, `authrim-prod`)
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
Configure secrets and environment variables for workers.

**Usage:**
```bash
./scripts/setup-secrets.sh
```

### setup-production.sh
Setup production environment configuration.

**Usage:**
```bash
./scripts/setup-production.sh
```

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
./scripts/delete-d1.sh dev
./scripts/delete-d1.sh prod
./scripts/delete-d1.sh staging

# Dry run mode
./scripts/delete-d1.sh dev --dry-run

# Force deletion (USE WITH EXTREME CAUTION)
./scripts/delete-d1.sh dev --force
```

**What it deletes:**
- D1 database for specified environment (e.g., `authrim-dev`)
- Shows table contents before deletion
- Production databases require typing 'DELETE PRODUCTION' to confirm

**Safety features:**
- Environment-specific deletion (won't delete all databases)
- Extra confirmation required for production
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
./scripts/delete-all.sh dev
./scripts/delete-all.sh prod
./scripts/delete-all.sh staging

# Dry run mode (preview all deletions)
./scripts/delete-all.sh dev --dry-run

# Force deletion (USE WITH EXTREME CAUTION)
./scripts/delete-all.sh dev --force
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
- Production requires typing 'DELETE PRODUCTION' + additional 'YES' confirmation
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

---

## Utility Scripts

### generate-keys.ts
Generate cryptographic keys for JWT signing.

**Usage:**
```bash
pnpm run generate-keys

# Or directly
tsx scripts/generate-keys.ts
```

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
   ./scripts/delete-all.sh dev --dry-run
   ```

2. **Never use `--force` flag on production** unless you are absolutely certain

3. **Backup important data** before running deletion scripts

4. **Verify the environment** before executing deletion commands

5. **Check Cloudflare Dashboard** to confirm deletions

### Common Workflows

#### Starting Fresh (Development)

```bash
# 1. Delete all dev resources
./scripts/delete-all.sh dev

# 2. Set up fresh environment
./scripts/setup-dev.sh
./scripts/setup-kv.sh
./scripts/setup-d1.sh
./scripts/setup-durable-objects.sh
./scripts/setup-secrets.sh

# 3. Deploy
pnpm run deploy:retry
```

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

#### Production Deletion (USE WITH EXTREME CAUTION)

```bash
# Always use dry-run first!
./scripts/delete-all.sh prod --dry-run

# If you're absolutely sure, run the actual deletion
# You will need to:
# 1. Type 'DELETE PRODUCTION'
# 2. Type 'YES' for final confirmation
./scripts/delete-all.sh prod
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

**Last Updated**: 2025-01-14
