# @authrim/setup

CLI and Web UI for deploying Authrim OIDC Provider to Cloudflare Workers.

[![npm version](https://img.shields.io/npm/v/@authrim/setup.svg)](https://www.npmjs.com/package/@authrim/setup)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/sgrastar/authrim/blob/main/LICENSE)

## Quick Start

```bash
# Web UI (recommended)
npx @authrim/setup

# CLI mode
npx @authrim/setup --cli

# Manage existing environments only
npx @authrim/setup manage
```

## Supported Languages

The setup tool supports the following 11 languages:

| Code    | Language              | Native Name      |
| ------- | --------------------- | ---------------- |
| `en`    | English               | English          |
| `ja`    | Japanese              | 日本語           |
| `zh-CN` | Chinese (Simplified)  | 简体中文         |
| `zh-TW` | Chinese (Traditional) | 繁體中文         |
| `es`    | Spanish               | Español          |
| `pt`    | Portuguese            | Português        |
| `fr`    | French                | Français         |
| `de`    | German                | Deutsch          |
| `ko`    | Korean                | 한국어           |
| `ru`    | Russian               | Русский          |
| `id`    | Indonesian            | Bahasa Indonesia |

Language is automatically detected from your system locale or browser settings. You can also specify a language manually:

```bash
# CLI: Use --lang option
npx @authrim/setup --lang=ja

# Web UI: Use ?lang query parameter
# http://localhost:3456/?lang=ja
```

## Requirements

- Node.js >= 20.0.0
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed and authenticated
- Cloudflare Workers Paid plan

## Commands

### `init` (default)

```bash
npx @authrim/setup [options]

Options:
  --cli              CLI mode instead of Web UI
  --lang <code>      Language (en, ja, zh-CN, etc.)
  --config <path>    Load existing configuration
  --env <name>       Environment name (prod, staging, dev)
```

### `manage`

Manage existing environments (no source code required):

```bash
npx @authrim/setup manage
```

### `deploy`

```bash
npx @authrim/setup deploy [options]

Options:
  -c, --config <path>  Config file path
  -e, --env <env>      Environment name
  --component <name>   Deploy single component
  --dry-run            Preview without deploying
  --skip-secrets       Skip secrets upload
  -y, --yes            Skip confirmation (CI/CD)
```

### `delete`

```bash
npx @authrim/setup delete [options]

Options:
  --env <name>    Environment to delete
  -y, --yes       Skip confirmation (CI/CD)
  --no-workers    Keep Workers
  --no-d1         Keep D1 databases
  --no-kv         Keep KV namespaces
```

### `info`

```bash
npx @authrim/setup info [options]

Options:
  --env <name>    Environment name
  --json          JSON output (for scripting)
  --d1            D1 info only
  --workers       Worker info only
```

### `config`

```bash
npx @authrim/setup config [options]

Options:
  --show       Show configuration
  --validate   Validate configuration
  --json       JSON output
```

## Configuration Structure

Authrim uses a unified directory structure for each environment:

```
project/
└── .authrim/
    └── {env}/              # e.g., prod, staging, dev
        ├── config.json     # Environment settings
        ├── lock.json       # Provisioned resource IDs
        ├── version.txt     # Setup tool version
        ├── keys/           # Cryptographic keys (gitignored)
        └── wrangler/       # Generated wrangler configs
```

### Configuration Files

| File                         | Description                     |
| ---------------------------- | ------------------------------- |
| `.authrim/{env}/config.json` | Environment settings            |
| `.authrim/{env}/lock.json`   | Provisioned resource IDs        |
| `.authrim/{env}/keys/`       | Cryptographic keys (gitignored) |

### Components

| Component | Description                         |
| --------- | ----------------------------------- |
| `api`     | Core OIDC API (required)            |
| `loginUi` | Login/consent UI                    |
| `adminUi` | Admin dashboard                     |
| `saml`    | SAML 2.0 IdP                        |
| `async`   | Email, webhooks                     |
| `vc`      | Verifiable Credentials              |
| `bridge`  | Social login (Google, GitHub, etc.) |
| `policy`  | ReBAC Policy Engine                 |

## Resource Naming

| Type    | Pattern                   | Example                |
| ------- | ------------------------- | ---------------------- |
| Workers | `{env}-ar-{component}`    | `prod-ar-auth`         |
| D1      | `{env}-authrim-{type}-db` | `prod-authrim-core-db` |
| KV      | `{env}-{NAME}`            | `prod-CLIENTS_CACHE`   |

## CI/CD

```bash
# Deploy without prompts
npx @authrim/setup deploy --env prod --yes

# Delete environment
npx @authrim/setup delete --env staging --yes

# Get info as JSON
npx @authrim/setup info --env prod --json | jq '.d1[0].databaseSize'
```

Environment variables:

- `CLOUDFLARE_API_TOKEN` - API token
- `CLOUDFLARE_ACCOUNT_ID` - Account ID
- `AUTHRIM_LANG` - Default language (e.g., `ja`, `en`)

## Troubleshooting

**Wrangler not installed**

```bash
npm install -g wrangler
wrangler login
```

**Lock file not found**

```bash
npx @authrim/setup init --env prod
```

**Service Bindings error**

Deploy missing components first, or disable them in configuration. The ar-router must be deployed last.

## License

Apache License 2.0
