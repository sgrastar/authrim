# @authrim/setup

> CLI and Web UI for setting up Authrim OIDC Provider on Cloudflare Workers

[![npm version](https://img.shields.io/npm/v/@authrim/setup.svg)](https://www.npmjs.com/package/@authrim/setup)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../../LICENSE)

## Overview

`@authrim/setup` is the official setup tool for deploying [Authrim](https://github.com/sgrastar/authrim) to Cloudflare Workers. It provides both an interactive CLI and a Web UI to guide you through:

- Provisioning Cloudflare resources (D1 databases, KV namespaces, Queues)
- Generating cryptographic keys and secrets
- Configuring environment-specific settings
- Deploying all Authrim workers in the correct order
- Setting up the initial administrator account

## Quick Start

```bash
# Using npx (recommended)
npx @authrim/setup

# Or install globally
npm install -g @authrim/setup
authrim-setup
```

## Usage Modes

### 1. Web UI Mode (Default)

Run without arguments to launch the interactive Web UI:

```bash
npx @authrim/setup
```

This opens a browser with a step-by-step wizard that guides you through the entire setup process.

### 2. CLI Mode

For terminal-based setup or CI/CD integration:

```bash
npx @authrim/setup --cli
```

### 3. Deploy Existing Configuration

If you already have an `authrim-config.json`:

```bash
npx @authrim/setup deploy --config ./authrim-config.json --env prod
```

## Commands

### `init`

Initialize a new Authrim project:

```bash
authrim-setup init [options]

Options:
  -e, --env <env>      Environment name (default: "dev")
  -d, --dir <dir>      Output directory (default: ".")
  --keys-dir <dir>     Directory for keys (default: ".keys")
  --skip-keys          Skip key generation
  --skip-provision     Skip resource provisioning
  -y, --yes            Skip confirmation prompts
```

### `deploy`

Deploy Authrim to Cloudflare:

```bash
authrim-setup deploy [options]

Options:
  -c, --config <path>  Config file path (default: "authrim-config.json")
  -e, --env <env>      Environment name
  --component <name>   Deploy single component
  --dry-run            Preview without deploying
  --skip-secrets       Skip secrets upload
  --skip-ui            Skip UI deployment
  -y, --yes            Skip confirmation prompts
```

### `status`

Check deployment status:

```bash
authrim-setup status [options]

Options:
  -c, --config <path>  Config file path
```

## Configuration Files

### authrim-config.json

The main configuration file containing all environment settings:

```json
{
  "version": "1.0.0",
  "environment": {
    "prefix": "prod"
  },
  "urls": {
    "api": {
      "custom": "https://auth.example.com",
      "auto": "https://prod-ar-router.workers.dev"
    },
    "loginUi": {
      "custom": "https://login.example.com",
      "auto": "https://prod-ar-ui.pages.dev"
    },
    "adminUi": {
      "custom": null,
      "auto": "https://prod-ar-ui.pages.dev/admin"
    }
  },
  "components": {
    "api": true,
    "loginUi": true,
    "adminUi": true,
    "saml": false,
    "async": false,
    "vc": false
  },
  "keys": {
    "keyId": "kid-xxxxxxxx",
    "secretsPath": "./.keys/"
  }
}
```

### authrim-lock.json

Records provisioned resource IDs for re-deployment:

```json
{
  "version": "1.0.0",
  "env": "prod",
  "d1": {
    "DB": { "name": "prod-authrim-core-db", "id": "..." },
    "PII_DB": { "name": "prod-authrim-pii-db", "id": "..." }
  },
  "kv": {
    "CLIENTS_CACHE": { "name": "prod-CLIENTS_CACHE", "id": "..." },
    "SETTINGS": { "name": "prod-SETTINGS", "id": "..." }
  }
}
```

### .keys/ Directory

Contains sensitive cryptographic material (gitignored):

```
.keys/
├── private.pem              # RSA private key for JWT signing
├── public.jwk.json          # Public key in JWK format
├── rp_token_encryption_key.txt
├── admin_api_secret.txt
├── key_manager_secret.txt
└── setup_token.txt          # Initial admin setup token
```

## Deployment Order

Authrim workers are deployed in a specific order to satisfy dependencies:

```
Level 0: ar-lib-core         # Durable Objects definitions (always first)
Level 1: ar-discovery        # Discovery endpoint
Level 2: ar-auth, ar-token, ar-userinfo, ar-management  # Core services (parallel)
Level 3: ar-async, ar-saml, ar-vc, ar-bridge           # Optional (parallel)
Level 4: ar-router           # Service bindings (always last)
Level 5: ar-ui               # Cloudflare Pages (optional)
```

## Initial Admin Setup

After deployment, the CLI displays a one-time setup URL:

```
━━━ Initial Admin Setup ━━━

To create the initial administrator account, visit:

  https://auth.example.com/setup?token=abc123...

⚠️  Important:
  • This link expires in 1 hour
  • Setup can only be completed once
  • You will need to register a Passkey (biometric/security key)
```

This URL allows you to:
1. Register a Passkey as the system administrator
2. Access the Admin Dashboard
3. Create OAuth clients and configure settings

## Security Features

- **Session Token Authentication**: API endpoints require session tokens to prevent unauthorized access
- **Path Traversal Prevention**: Key storage directory is validated to prevent directory traversal attacks
- **Command Injection Prevention**: Browser launch URLs are validated to prevent shell injection
- **Error Sanitization**: Error messages are sanitized to prevent information leakage
- **Operation Locking**: Concurrent operations are serialized to prevent race conditions
- **Localhost-Only Web UI**: Web UI only binds to localhost for security

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Web UI server port | `3456` |
| `HOST` | Web UI server host | `localhost` |

## Development

### Local Testing

```bash
# From the authrim repository root
cd packages/setup

# Run in development mode
pnpm dev

# Build and run
pnpm build
pnpm start

# Run tests
pnpm test
```

### Using with pnpm link

```bash
# In packages/setup
pnpm build
pnpm link --global

# In another directory
authrim-setup --help
```

## Requirements

- Node.js >= 20.0.0
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed and authenticated
- Cloudflare account with Workers Paid plan (for D1, KV, Durable Objects)

## Troubleshooting

### "Wrangler is not installed"

Install wrangler globally:

```bash
npm install -g wrangler
wrangler login
```

### "Not logged in to Cloudflare"

Authenticate with Cloudflare:

```bash
wrangler login
```

### "Lock file not found"

Run the init command first to provision resources:

```bash
authrim-setup init --env prod
```

### Deployment fails with "Service Bindings"

Ensure all dependent workers are deployed. The ar-router must be deployed last as it references other workers via Service Bindings.

## License

Apache License 2.0 - see [LICENSE](../../LICENSE) for details.

## Related

- [Authrim Documentation](https://github.com/sgrastar/authrim/tree/main/docs)
- [Deployment Guide](https://github.com/sgrastar/authrim/blob/main/docs/getting-started/deployment.md)
- [Development Guide](https://github.com/sgrastar/authrim/blob/main/docs/getting-started/development.md)
