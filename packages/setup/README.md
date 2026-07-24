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

This command permits an initial deployment or a same-product-version redeploy. If the repository
product version differs from the deployed lock, it stops and directs the operator to `update`; product
upgrades cannot bypass the schema-first release state machine through CLI deploy, component upgrade,
root deployment scripts, configuration-triggered Web redeploys, tenant-pool/R2 deployment helpers, or
Web Worker update routes. The Web `/deploy` flow is initial-setup-only and applies its D1 schemas before
publishing any Worker. Manual Web migration routes and tenant D1 provisioning/reset/migrate commands
also require the checkout product version to match the deployed product; release schema changes go
through `update`.

External PostgreSQL topology changes use a separate, fail-closed workflow. First apply the migration
streams for the installed Authrim version to each new database, then pass a candidate environment
configuration and acknowledge that schema step:

```bash
npx @authrim/setup external-db-register \
  --env prod \
  --config ./authrim-prod-external-db.json \
  --external-schema-ready \
  --yes
```

The command accepts only runtime storage/audit profile and Hyperdrive-reference changes. It records
versioned schema evidence in the environment lock and deploys the resulting bindings. PostgreSQL core
and PII streams are supported; a target without a published release stream (including MySQL today) is
rejected. Use `--dry-run` to validate the candidate without changing local or Cloudflare state.

Topology commands (`tenant-db`, `tenant-db-pool-expand`, `r2-provision`, and
`external-db-register`) persist a durable preparation/deployment journal in the environment lock before
publishing Worker bindings. Configuration-changing topology commands also stage the new configuration
and checksum in that journal before atomically replacing `config.json`; an interrupted replacement is
completed deterministically on retry. If deployment or readiness verification fails, rerun the same
dedicated command. The command resumes the recorded target without allocating another tenant slot,
creating another tenant database generation, or requiring a second external-schema acknowledgement.
Other configuration, release, and Worker-only operations remain blocked until the pending topology
deployment succeeds. For pool expansion and external database registration, retry-only arguments may
be omitted because the target configuration is pinned by the journal. `authrim-setup status --env
<env>` shows the pending kind, phase, recorded subject, and the command to resume.

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

Update an existing environment as one release operation. The command resolves the release migration
manifest, updates every automatic D1 target first, deploys changed API and enabled UI Workers, runs
health checks, and records the completed product version in the environment lock file only after every
enabled Worker succeeds. Re-running the command resumes an interrupted update from the recorded phase,
including partially completed UI deployment.

Legacy locks without `productVersion` are reconciled from recorded Worker versions. If those versions
are mixed, setup does not guess the database release: it checks cumulative D1 history and converges all
Workers to the requested release, while refusing any target below the highest recorded Worker version.

```bash
npx @authrim/setup update --env prod --dry-run
npx @authrim/setup update --env prod --all --yes
# Development checkout only, before the release manifest exists:
npx @authrim/setup update --env dev --allow-draft-manifest
```

The D1 target plan includes the shared core, PII, and Admin databases plus every generated tenant D1
binding in the lock file. Tenant bindings with shard suffixes such as `_CORE_S1` are migrated as
independent physical targets using the same logical core schema stream. When multiple schema streams
map to one physical database, they run sequentially for that database.

External PostgreSQL/MySQL targets are discovered from every seeded deployable runtime profile, not
only the environment default, so tenant-specific profile selections cannot escape the release plan.
PostgreSQL core and PII connections use separate logical migration streams. Setup records the applied product version per
physical target, so an existing target receives a release delta while a newly added target receives the
cumulative stream. Setup does not have the database credentials behind a Hyperdrive binding, so
external migrations currently fail closed. Apply the listed files using operator-managed database
tooling, then acknowledge that step with `--external-schema-ready`. The acknowledgement is preserved
when an interrupted update resumes. Per-target stream paths and checksums are stored as well, so a
database that applied development draft files is recognized as equivalent when the same-version
published bundle later supersedes those exact files. MySQL and external audit targets remain
hard-blocked until their own release migration streams are provided. Legacy D1 rows with blank
checksums are upgraded only from a checksum-verified published manifest, including the manifest's
superseded-file evidence; development drafts never authorize that backfill.

The normative lifecycle, operation, topology, readiness, and test rules are documented in
[`docs/specification/release-lifecycle.md`](../../docs/specification/release-lifecycle.md).

Useful options:

| Option                    | Description                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `--dry-run`               | Show Worker, D1, tenant/shard, and external database changes without applying them.    |
| `--all`                   | Redeploy every Worker even if its package version is unchanged.                        |
| `--allow-draft-manifest`  | Explicitly allow a development manifest. Published updates require a release manifest. |
| `--external-schema-ready` | Confirm required external schema files were applied separately.                        |
| `--skip-build`            | Skip package builds.                                                                   |
| `-y, --yes`               | Accept the displayed release plan without an interactive prompt.                       |

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

| Command                 | Purpose                                                   |
| ----------------------- | --------------------------------------------------------- |
| `download`              | Download Authrim source code.                             |
| `status`                | Show deployment status.                                   |
| `secrets`               | Upload secrets to Cloudflare.                             |
| `r2-provision`          | Create R2 buckets and immediately deploy their bindings.  |
| `external-db-register`  | Register migrated external DBs and deploy their bindings. |
| `upgrade`               | Upgrade a single Worker or UI component.                  |
| `tenant-db`             | Create tenant-specific D1 databases for one tenant.       |
| `tenant-db-migrate-all` | Run migrations for generated tenant D1 databases.         |
| `tenant-db-pool-expand` | Add preallocated tenant D1 slots.                         |
| `tenant-db-pool-status` | Show tenant D1 pool capacity.                             |
| `tenant-db-slot-reset`  | Reset a failed tenant D1 slot.                            |
| `migrate`               | Migrate legacy files into `.authrim/{env}/`.              |
| `migrate-status`        | Show migration status and recommendation.                 |

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
