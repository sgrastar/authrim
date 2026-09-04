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
5. Unified Control Plane placement and automatic-provisioning settings
6. Optional email configuration
7. Resource provisioning
8. Worker deployment
9. Completion and next steps

R2 object storage is enabled by default. Setup provisions the complete standard bucket topology and
deploys each binding only to the Workers that require it. Login UI assets and tenant-scoped avatars
share `PUBLIC_ASSETS` under separate object-key prefixes; there is no dedicated avatar bucket. The
pre-1.0 resource layout is intentionally not backward compatible: if an environment lock still
contains the removed `AVATARS` bucket, recreate that environment instead of attempting an in-place
R2 topology conversion.

## Requirements

- Node.js `>=20.0.0`
- `pnpm@9` for repository development
- Wrangler CLI installed and authenticated with `wrangler login`

### Deployment readiness and DNS propagation

CLI and Web deployments perform readiness checks from the setup Node.js process; they do not depend
on `curl`, `dig`, or another operating-system command. When the system resolver returns `ENOTFOUND`
or `EAI_AGAIN` for a new HTTPS custom domain, setup retries through Cloudflare public DNS while
preserving the original hostname for TLS and SNI validation. HTTP failures are never bypassed as DNS
failures.

The core API router readiness gate remains required. Post-deploy readiness for optional downstream
grant introspection uses one shared 60-second budget across router readiness, tenant discovery, Admin
machine token issuance, and Admin API client configuration. It probes candidate origins concurrently
and reuses the router result already verified by the core deployment gate. If that optional setup does
not converge within the budget, setup records it as deferred and continues with core login, Admin UI,
and token issuance available.

- A Cloudflare account that can create Workers, D1 databases, KV namespaces, and R2 buckets

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

Setup remains Authrim's release and deployment plane after the initial deployment. It owns version
updates, Worker deployment and rollback, whole-environment migrations, Control Worker updates,
environment deletion, and operator-driven D1 provisioning or repair. The Control Worker does not
update or delete itself.

Every new D1 environment uses the unified Control Plane. The interactive CLI and Web setup offer
`Automatic provisioning` as an execution-authority choice, not as a routing-mode choice:

| Credential                                                                                                      | Owner and purpose                                                                                                            | Used by Web Setup itself                                  |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Wrangler OAuth                                                                                                  | Interactive operator credential for resource creation, migrations, Worker deployment, deletion, and post-deploy verification | Yes                                                       |
| `CLOUDFLARE_API_TOKEN`                                                                                          | Generic operator credential for headless/non-interactive Setup                                                               | Only when explicitly configured instead of Wrangler OAuth |
| One-time bootstrap API token                                                                                    | Creates the Control Worker's narrowly scoped child tokens and is then revoked                                                | Only for the bounded token bootstrap transaction          |
| `CLOUDFLARE_D1_API_TOKEN`, `CLOUDFLARE_WORKERS_API_TOKEN`, `CLOUDFLARE_KV_API_TOKEN`, `CLOUDFLARE_R2_API_TOKEN` | Runtime child secrets owned by the Control Worker                                                                            | No                                                        |

Setup must not use a Control child token for its own migrations, deletion, inventory, deployment, or
verification work. In Web setup, those operations remain on the account-pinned Wrangler OAuth
session and refresh that session once when Cloudflare rejects an expired access token.

- **On:** setup opens a Cloudflare Dashboard link prefilled with only API-token creation permission.
  The Control Worker needs this one-time bootstrap token to create its scoped execution credentials;
  setup displays an explicit required-token message if it has not been entered. Enter the token once.
  Setup creates distinct account-scoped D1 and
  Workers Scripts tokens and, when the enabled capability requires them, separate KV and R2 tokens.
  Before registering a child secret, setup verifies that the token can list only its own resource
  class and that Cloudflare rejects the other D1, Workers Scripts, KV, and R2 list endpoints with
  `401` or `403`. Transport errors and other provider responses are not accepted as denial evidence.
  Setup then registers the values directly as Control Worker secrets and revokes the bootstrap token.
  Dashboard authentication is separate from Wrangler OAuth and may require another login.
- **Off / Skip:** no Cloudflare API token is stored on the Control Worker. Setup continues to use the
  operator's Wrangler OAuth session to execute canonical pending Control DB operations. Existing
  routing remains active; new automatic provisioning fails closed as `operator_action_required`.

An installed Control Plane environment can be switched from Off to On from its environment Overview in
Web setup. The same one-time bootstrap flow is used; authority remains pending until the common
deployment path succeeds and the scoped child tokens are registered. The CLI delays opening the
token template and accepting the token until Worker deployment is ready. If Web preparation or
deployment fails after a token was entered, setup immediately attempts to revoke that bootstrap
token through its loopback-only cleanup route; an unconfirmed revocation is reported as a required
Dashboard cleanup rather than success.

Before issuing child tokens, setup also revokes every other user- or account-owned token with the
same deterministic bootstrap name. This cleans up unused tokens created by an earlier Dashboard
attempt while preserving unrelated operator credentials. Failure to confirm this cleanup blocks the
bootstrap before any child token or Control secret is created.

Bootstrap and generated child token values are never written to `.authrim`, `.authrim-key`, config,
lock files, Control DB, generated artifacts, logs, audit payloads, command arguments, or Web
responses. CI and advanced operators may use the documented split-token environment fallback; D1
and Workers tokens must remain distinct and account-scoped.

Custom Dynamic Worker plugins use Cloudflare's Worker Loader binding on the Workers Paid plan; they
do not require Workers for Platforms or a Dispatch Namespace. The capability is disabled by default
and can be enabled with `features.pluginDynamicWorkers.enabled = true`. Enabling it also requires R2
bundle storage. Built-in notification and human-verification providers continue to run in-process
without a Worker Loader; a configured Dynamic Worker plugin never falls back to in-process
execution when the loader, bundle, or paid capability is unavailable.

Each custom plugin manifest must also declare `credentials` (an empty array is valid). A credential
slot contains `configKey`, `required`, `destinationHost`, `injectionKind`, and `injectionName`.
`destinationHost` must be an exact host in `egressAllowedHosts`; wildcard-only credential injection,
reserved/forwarding headers, and built-in plugin IDs are rejected. The manifest contains no values.
Setup publishes each immutable code-and-policy version and one platform active version pointer into
Plugin Runner D1. Tenant enable pins that version. Later setup publication affects new installations
only until an explicit tenant rollout or bounded platform rollout is requested. A platform rollout
uses a resumable server-owned cursor and processes at most 25 enabled tenant installations per call.
The first call may use a batch size of one as an observed first batch; a dedicated canary tenant or
environment is not required.

The manifest must also declare `hostInterfaces` and `resources` (empty arrays are valid). Host
interfaces use versioned IDs from Authrim's typed catalog; arbitrary RPC methods and raw Authrim D1
bindings are rejected. A dedicated resource uses this shape:

```json
{
  "schemaVersion": 1,
  "logicalResourceId": "plugin_cache",
  "binding": "PLUGIN_CACHE",
  "kind": "kv_namespace",
  "scope": "tenant",
  "access": "read_write",
  "provisioning": { "defaultMode": "managed", "allowExisting": true },
  "migrationStream": null
}
```

Managed provisioning is the normal path and requires no tenant administrator input. When
`allowExisting` is true, the Admin UI exposes a collapsed advanced option to select an existing
Cloudflare resource by both ID and name. Authrim verifies and binds that reference but does not delete
the underlying provider resource. D1 resources require a non-null approved `migrationStream`.

Admin submits tenant credential values to the narrow Plugin Runner RPC. Values are encrypted in
Plugin Runner D1 and injected only by the host outbound gateway. They are not stored in Settings KV,
Control DB, generated files, setup output, logs, audit payloads, or Dynamic Worker bindings.

Both execution modes use the same Control DB desired state, operation steps, deterministic naming,
capacity planner, migration checksums, binding-preservation rules, retry policy, and fenced leases.
Post-handoff setup execution is supported only through that canonical operation path; direct resource
mutation outside the Control operation remains rejected.

Plugin resource bindings are also part of the generated deployment state. Setup projects only
Control DB resources in `ready` or `active` state into the Plugin Runner Wrangler configuration and
uses fixed `PRES_D1_*`, `PRES_KV_*`, and `PRES_R2_*` binding families. A normal deploy therefore
preserves managed plugin resources. Cleanup changes them to `deleting`, removes the live bindings,
and refreshes the focused generated artifact so a later deploy cannot recreate quarantined
bindings. Local validation checks the Runner-only binding shape without network access;
`--live-cloudflare` additionally verifies exact Control desired identity and Cloudflare inventory.

Pending operations are shown first in Web setup. The CLI executes the same server-owned operation;
it accepts an operation ID but no tenant, database, binding, role, residency, or capacity override:

```bash
npx @authrim/setup control-provision --env test --dry-run
npx @authrim/setup control-provision --env test --operation-id <operation-id> --yes
```

The command advances the authoritative operation one provider step at a time: deterministic D1
creation, the pinned migration release, then the capability-derived Worker binding patch. In Off
mode, the Control Worker needs no Cloudflare API token to finish the private Service Binding smoke,
30-second stabilization, final runtime-version check, and activation. A response-lost binding PATCH
is reconciled from the fenced deployment evidence and is not issued a second time.

An active-tenant disaster recovery operation also appears in the same pending list when Automatic
provisioning is Off. Setup receives the tenant and the complete server-owned binding target set; it
does not ask for databases, roles, residencies, or binding names. The common binding executor rejects
an incomplete target set, uses the same deployment lease/fencing, and hands the operation back to
Control for smoke, stabilization, and explicit Admin reactivation. Time Travel itself remains a
manual Cloudflare operator action and is not executed by setup.

Plugin **Disable** is non-destructive: bindings and dedicated resources remain available for a later
re-enable. An explicitly confirmed Admin **Uninstall**, or explicit Cancel before activation,
creates a canonical cleanup operation. Automatic provisioning On lets Control execute it; Off hands
the same operation to the pending-operation-first setup CLI/Web flow. Cleanup removes only the
installation's derived bindings, waits 30 minutes, deletes only Authrim-managed resources, and
detaches existing-resource references without provider deletion. Setup may be closed during the
drain; reopening it shows the same operation and resumes after the recorded deadline. Raw provider
identities are server-owned and cannot be edited from setup.

When setup is asked to add capacity, CLI and Web use the same server-owned plan and offer only:

- **Minimum:** add the smallest valid capacity unit that resolves the current shortage.
- **Recommended (default):** include current use, low-watermark, in-flight allocations, and target
  capacity.
- **Extra headroom:** add one spare capacity unit to the recommended plan.

The preview lists the exact D1 count, data role, residency partition, and Worker bindings for every
unit. Operators select a tenant-exclusive tenant or the environment shared pool; they do not edit raw
database names, binding names, database IDs, data roles, residencies, or D1 counts. Plans that exceed
tenant policy, Authrim resource caps, or the Cloudflare account limit are unavailable.

CLI and Web create the same short-lived setup machine principal only around each preview or request
and remove both the Admin D1 principal and local key files before reporting success. Bootstrap,
action, and cleanup failures are reported separately; an uncertain cleanup is never treated as a
successful capacity operation. The complete bootstrap/action/cleanup interval holds the existing
per-environment setup operation lock, so CLI, Web, deploy, update, and delete cannot race the fixed
ephemeral principal or its local key files. While one Web mutation is running, another submission is
rejected with `409 setup_operation_in_progress`; the operator can retry after the active operation
finishes. Accepted operations then acquire the cross-process environment lock.

Preview or request the same profiles from the CLI without exposing physical resource inputs:

```bash
npx @authrim/setup control-provision --env test --scope shared_pool \
  --capacity-profile recommended --dry-run
npx @authrim/setup control-provision --env test --scope tenant_exclusive \
  --tenant-id <tenant-id> --capacity-profile extra_headroom --yes
```

Without `--yes`, tenant-exclusive mode selects from the active server-owned tenant placement
policies. Non-interactive execution requires `--tenant-id`; it never infers an owner or falls back to
the shared pool.

This command permits an initial deployment or a same-product-version redeploy. If the repository
product version differs from the deployed lock, it stops and directs the operator to `update`; product
upgrades cannot bypass the schema-first release state machine through CLI deploy, component upgrade,
root deployment scripts, configuration-triggered Web redeploys, tenant-pool/R2 deployment helpers, or
Web Worker update routes. The Web `/deploy` flow is initial-setup-only and applies its D1 schemas before
publishing any Worker. Direct tenant-database provisioning, reset, and migration commands are not
available; release schema changes go through `update`, while pending placement and capacity work goes
through the canonical `control-provision` operation.

External PostgreSQL/MySQL user-data backends are not exposed as completed Setup options. The
`DatabaseAdapter` boundary and schema streams remain extension points, but a future external resource
must be registered through the Control Plane with explicit schema evidence before runtime activation.

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

The D1 target plan includes fixed platform metadata/audit databases, initial tenant Core/PII
assignments, and every Control-managed assignment binding projected into the lock file. Fixed `DB`
and `DB_PII` bindings are not tenant identity routes and are never used as assignment fallbacks.
Assignment bindings with shard
suffixes such as `_CORE_S1` are migrated as
independent physical targets using the same logical core schema stream. When multiple schema streams
map to one physical database, they run sequentially for that database.

Setup records the applied product version per
physical target, so an existing target receives a release delta while a newly added target receives the
cumulative stream. Per-target stream paths and checksums are stored as well, so a
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

Resource keep flags include `--no-workers`, `--no-d1`, `--no-kv`, `--no-queues`, `--no-r2`, and
`--no-pages`. Partial deletion preserves the local environment state for the resource types that
remain.

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

| Command             | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| `download`          | Download Authrim source code.                            |
| `status`            | Show deployment status.                                  |
| `secrets`           | Upload secrets to Cloudflare.                            |
| `r2-provision`      | Create R2 buckets and immediately deploy their bindings. |
| `upgrade`           | Upgrade a single Worker or UI component.                 |
| `control-provision` | Execute a pending canonical Control operation.           |

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

**Setup reports insufficient local disk space**

Free local disk space and retry the same operation. Setup requires at least 1 GiB before resource
provisioning, package builds, and release deployment, then keeps a 512 MiB reserve before each Worker
mutation. The preflight stops before the next Cloudflare mutation. If a previous run exhausted the
disk during deployment, Setup preserves its checkpoints and resumes the remaining Worker work after
capacity is restored.

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
