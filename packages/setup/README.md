---
project: Authrim
lang: en
date: 2026-06-15
description: 'Setup CLI and local Web UI for provisioning, deploying, and managing Authrim on Cloudflare Workers.'
type: reference
tags:
  - authrim
  - setup
  - cloudflare-workers
  - deployment
  - environment-management
---

# @authrim/setup

`@authrim/setup` is the local setup tool for Authrim. It provides a browser-based setup UI and CLI commands for creating Cloudflare resources, deploying Workers, updating existing environments, and deleting environments when they are no longer needed.

The Web UI is the primary path for interactive setup. It runs only on your local machine, talks to a local HTTP server started by the CLI, and uses your local `wrangler` authentication to operate against Cloudflare.

## Quick Start

```bash
# From this repository
pnpm run setup

# From npm
npx @authrim/setup

# CLI prompts instead of the Web UI
npx @authrim/setup --cli

# Open environment management directly
npx @authrim/setup manage
```

The default command starts the local Web UI, checks the current Wrangler session, and guides you through:

1. Local and Cloudflare readiness checks
2. Start mode selection: new setup, load config, or manage environments
3. Basic environment settings
4. Domain and tenant URL settings
5. D1, KV, and storage profile selection
6. Optional email configuration
7. Resource provisioning
8. Worker deployment
9. Completion and next steps

## Requirements

- Node.js `>=20.0.0`
- `pnpm@9` for repository development
- Wrangler CLI installed and authenticated with `wrangler login`
- A Cloudflare account that can create Workers, D1 databases, KV namespaces, and optional R2 buckets

For repository development, the root project currently expects Node `>=22`.

## Web UI

```bash
npx @authrim/setup [options]
```

Common options:

| Option            | Description                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| `--cli`           | Use terminal prompts instead of the Web UI.                             |
| `--config <path>` | Load an existing `authrim-config.json` or `.authrim/{env}/config.json`. |
| `--keep <path>`   | Keep downloaded Authrim source files at the specified path.             |
| `--env <name>`    | Initial environment name. Defaults to `prod`.                           |
| `--lang <code>`   | Initial language, for example `ja`, `en`, or `zh-CN`.                   |

The Web UI serves static font files from the local setup server and does not load Google Fonts at runtime.

## Environment Files

The current environment layout is:

```text
.authrim/
└── {env}/
    ├── config.json
    ├── lock.json
    ├── version.txt
    ├── keys/
    └── wrangler/
```

| Path                         | Purpose                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `.authrim/{env}/config.json` | Setup choices and environment configuration.                    |
| `.authrim/{env}/lock.json`   | Cloudflare resource IDs and deployment state.                   |
| `.authrim/{env}/version.txt` | Setup tool version used for the environment.                    |
| `.authrim/{env}/keys/`       | Local cryptographic key backup. Keep private and do not commit. |
| `.authrim/{env}/wrangler/`   | Generated Wrangler configuration files.                         |

Legacy root-level `authrim-config.json` files can still be loaded by the setup UI for migration and resume flows.

## Commands

### `init`

Default command. Starts the Web UI unless `--cli` is provided.

```bash
npx @authrim/setup init --env prod --lang ja
```

### `manage`

Open the Web UI in environment management mode.

```bash
npx @authrim/setup manage
npx @authrim/setup manage --port 3456 --no-browser
```

### `deploy`

Deploy an existing configured environment.

```bash
npx @authrim/setup deploy --env prod --yes
```

Useful options:

| Option               | Description                                      |
| -------------------- | ------------------------------------------------ |
| `--config <path>`    | Configuration file path.                         |
| `--source <path>`    | Authrim source directory containing `packages/`. |
| `--component <name>` | Deploy one component.                            |
| `--dry-run`          | Preview changes without deploying.               |
| `--skip-secrets`     | Skip uploading secrets.                          |
| `--skip-build`       | Skip package builds.                             |
| `--skip-ui`          | Skip UI Worker deployment.                       |
| `--skip-migrations`  | Skip D1 migrations.                              |
| `--keys-dir <path>`  | Override keys directory.                         |
| `-y, --yes`          | Skip confirmation prompts.                       |

### `update`

Update Workers for an existing environment.

```bash
npx @authrim/setup update --env prod --dry-run
npx @authrim/setup update --env prod --all --yes
```

### `delete`

Delete an environment and its Cloudflare resources.

```bash
npx @authrim/setup delete --env staging
npx @authrim/setup delete --env staging --yes --no-r2
```

Resource keep flags include `--no-workers`, `--no-d1`, `--no-kv`, `--no-queues`, and `--no-r2`.

### `info`

Inspect deployed resources.

```bash
npx @authrim/setup info --env prod
npx @authrim/setup info --env prod --json
```

### `config`

Show or validate local configuration.

```bash
npx @authrim/setup config --env prod --show
npx @authrim/setup config --config .authrim/prod/config.json --validate
```

### Other Maintenance Commands

| Command                 | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `download`              | Download Authrim source code.                            |
| `status`                | Show deployment status.                                  |
| `secrets`               | Upload secrets to Cloudflare.                            |
| `r2-provision`          | Create dedicated R2 buckets for an existing environment. |
| `upgrade`               | Upgrade a single Worker or UI component.                 |
| `tenant-db`             | Create tenant-specific D1 databases for one tenant.      |
| `tenant-db-migrate-all` | Run migrations for generated tenant D1 databases.        |
| `tenant-db-pool-expand` | Add preallocated tenant D1 slots.                        |
| `tenant-db-pool-status` | Show tenant D1 pool capacity.                            |
| `tenant-db-slot-reset`  | Reset a failed tenant D1 slot.                           |
| `migrate`               | Migrate legacy files into `.authrim/{env}/`.             |
| `migrate-status`        | Show migration status and recommendation.                |

## Supported Languages

The setup tool currently includes translations for:

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

Language can be selected with `--lang`, the Web UI language selector, `?lang=...`, or `AUTHRIM_LANG`.

## Resource Naming

Typical resource names use the environment name as a prefix:

| Type    | Pattern                   | Example                |
| ------- | ------------------------- | ---------------------- |
| Workers | `{env}-ar-{component}`    | `prod-ar-auth`         |
| D1      | `{env}-authrim-{role}-db` | `prod-authrim-core-db` |
| KV      | `{ENV}-{NAME}`            | `PROD-CLIENTS_CACHE`   |
| R2      | `{env}-authrim-{purpose}` | `prod-authrim-objects` |

Exact names depend on the selected topology, enabled components, and resource profile.

## Environment Variables

| Variable                | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `AUTHRIM_LANG`          | Default setup language.                          |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API token for non-interactive flows.  |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID for non-interactive flows. |

Interactive Web UI flows normally use the locally authenticated Wrangler session.

## Development

```bash
pnpm --filter @authrim/setup build
pnpm --filter @authrim/setup lint
pnpm --filter @authrim/setup typecheck
pnpm --filter @authrim/setup test
```

The package entry point is `src/index.ts`. The Web UI server and template live under `src/web/`.

## Troubleshooting

**Wrangler is missing or not authenticated**

```bash
npm install -g wrangler
wrangler login
```

**The default Web UI port is already in use**

The server automatically tries another port and prints the URL. For environment management, you can also pass `--port`.

**An environment already exists**

Use `manage` to inspect or delete it, or choose a different environment name. Loading a config with an existing environment name will warn before continuing.

**Generated files should not be committed**

Do not commit `.authrim/`, generated `wrangler` files, keys, secrets, local databases, or `.dev.vars`.

## Bundled Fonts

The Web UI bundles WOFF2 font assets under `src/web/fonts/` and serves them from `/assets/fonts/...` on the local setup server. This avoids runtime requests to Google Fonts or `fonts.gstatic.com` while preserving the mockup typography.

Current bundled font families include:

- Cinzel
- Lora
- Public Sans
- Spline Sans Mono
- Zen Kaku Gothic New

These font families are available from Google Fonts under the SIL Open Font License 1.1. The setup package itself remains Apache-2.0 licensed.

## License

Apache License 2.0
