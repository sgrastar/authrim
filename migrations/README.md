---
project: Authrim
lang: en
date: 2026-07-11
description: 'Database migration layout for Authrim D1 and external PostgreSQL schemas.'
type: reference
tags:
  - authrim
  - migrations
  - d1
  - postgres
  - database
---

# Authrim Database Migrations

This directory contains the SQL schema migrations used by Authrim setup and CI.
The D1 runner applies files in lexical order and records applied files in each
database's `authrim_migrations` table.

These files support fresh installs and, after 1.0.0, release-coupled in-place updates. From 1.0.0
onward, published release manifests are the immutable contract for deciding which migrations apply to
an existing physical database. Pre-1.0 manifests instead declare
`databaseCompatibility: "fresh_install_only"`; they are new-install artifacts and may be replaced by
a newly verified semantic baseline.

The manifest also carries a semantic rollout policy. It declares who executes managed database work,
when schema-dependent Workers may activate, and whether Admin mutations remain compatible during the
mixed-schema interval. It intentionally does not name UI routes or controls. Runtime rollout state is
stored by Control and exposed as capabilities to Admin UI.

Database-only deployment is disabled unless `rollout.databaseOnly.compatibleWorkerVersions` contains
the exact installed Worker product version. The allow-list is release evidence, not a SemVer promise:
setup also verifies that all retained Workers have that recorded version before applying any schema.
The verified checkpoint retains the installed `productVersion`, so the full Worker update remains
available later.

A new major-version baseline may consolidate cumulative SQL for fresh installations, but it never
replaces the tested bridge migrations used by existing installations. Baseline installation and
in-place upgrade are separate artifacts with separate validation requirements.

## Pre-1.0 semantic baseline

Authrim does not support retaining or upgrading a database created by an older pre-1.0 checkout. The
setup lock, Workers, and databases must be recreated together. This permits the migration history to
be reorganized semantically while the schema is unstable, instead of preserving transitional table
rebuilds and obsolete columns in the 1.0.0 fresh-install path.

Preview and then write the rewrite with:

```bash
pnpm release:migrations:semantic
pnpm release:migrations:semantic -- --write
```

The command applies every current SQLite stream to an empty SQLite database and both external streams
to isolated PostgreSQL 17 databases. It dumps the final schema and required seed state, applies each
generated baseline to a second empty database, and requires the resulting dump to match. Only after
that verification does `--write` replace the source SQL, remove obsolete 0.x release manifests,
regenerate `release-manifest.draft.json`, and write `semantic-baseline.evidence.json`. Docker must be
available for PostgreSQL verification. The command is forbidden after a 1.0.0-or-newer manifest has
been published.

Any test environment that used replaced files must be deleted and initialized again. Do not run a
normal update against that environment; setup rejects a different installed pre-1.0 baseline with
`fresh_install_required`.

## Layout

| Path                                 | Target database             | Notes                                                                                             |
| ------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `migrations/*.sql`                   | D1 core database            | Runtime protocol, identity, consent, flow, directory auth, and end-user auth state.               |
| `migrations/pii/*.sql`               | D1 PII database             | Personal data, linked identities, sensitive values, and PII audit rows.                           |
| `migrations/admin/*.sql`             | D1 admin database           | Admin users, RBAC, approvals, jobs, logging, storage, identity mapping, and admin object catalog. |
| `migrations/control/*.sql`           | D1 control database         | Durable fleet inventory, rollout coordination, provisioning, and recovery state.                  |
| `migrations/lookup/*.sql`            | D1 lookup database          | Identifier lookup, routing, bucket state, and retention controls.                                 |
| `migrations/plugin-runner/*.sql`     | D1 plugin-runner database   | Plugin registry, activation, runtime resources, and delivery controls.                            |
| `migrations/external/postgres/*.sql` | External PostgreSQL profile | Durable external core/PII schemas.                                                                |

Top-level core migrations intentionally exclude the `admin`, `archive`,
`external`, and `pii` directories when the D1 core runner walks this directory.

## Current pre-1.0 baseline files

| Stream                   | File                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| D1 core                  | `001_pre_1_0_core_baseline.sql`                                     |
| D1 PII                   | `pii/001_pre_1_0_pii_baseline.sql`                                  |
| D1 Admin                 | `admin/001_pre_1_0_admin_baseline.sql`                              |
| D1 Control               | `control/001_pre_1_0_control_baseline.sql`                          |
| D1 Lookup                | `lookup/001_pre_1_0_lookup_baseline.sql`                            |
| D1 Plugin Runner         | `plugin-runner/001_pre_1_0_plugin_runner_baseline.sql`              |
| External PostgreSQL core | `external/postgres/001_pre_1_0_external_postgres_core_baseline.sql` |
| External PostgreSQL PII  | `external/postgres/002_pre_1_0_external_postgres_pii_baseline.sql`  |

The generated evidence file retains the paths and checksums of every source migration represented by
each baseline. It is provenance and verification evidence, not an upgrade map for a retained 0.x
database.

## Commands

```bash
# Apply D1 migrations for an environment through the setup migration runner
DEPLOY_ENV=test node scripts/ci-run-migrations.mjs

# Inspect migration status through setup package helpers
pnpm --filter @authrim/setup test -- src/__tests__/cloudflare-migration-status.test.ts
```

At and after 1.0.0, applied migration files are immutable because the setup runner verifies their
recorded checksums. Before 1.0.0, add sequential development migrations while implementing a change,
then regenerate the semantic fresh-install baseline and recreate disposable environments.

## Release-coupled schema updates

`migrations/release-manifest.draft.json` is the cumulative development view of every logical schema
stream. It records exact paths and dialect-rendered checksums for D1 core, D1 PII, D1 Admin, external
PostgreSQL core, and external PostgreSQL PII migrations. `pnpm migrate:create` refreshes the draft
automatically, and the root typecheck gate runs `pnpm migrate:manifest:check` so manually added or
edited SQL cannot be forgotten. At the 1.0.0 stability boundary and afterward, once
`releases/<version>.json` exists that product version is closed: bump the root/workspace versions before
creating another migration. A pre-1.0 semantic rewrite is the only exception and removes obsolete 0.x
manifests because their databases are not retained. A same-version stable draft that differs from its
published manifest is rejected instead of being selected silently. Draft generation and manifest
checks also reject a root product version older than the latest published stable release.

Before a release, preview consolidation without changing files:

```bash
pnpm release:migrations -- --version 1.1.0 --minimum-version 1.0.0
```

When adopting the forward-only workflow at or after 1.0.0 for a repository that already has stable
releases, create the non-destructive baseline manifest from the last published tag once:

```bash
pnpm release:migrations:baseline -- --version 1.0.0 --git-ref v1.0.0 --write
```

After reviewing the plan, explicitly write it:

```bash
pnpm release:migrations -- --version 1.1.0 --minimum-version 1.0.0 --write
```

The first release manifest establishes a baseline without rewriting existing files. For later
releases, the command merges multiple unpublished files into at most one release bundle per logical
stream. Published files and manifests are immutable. Each bundle records `supersedes` paths and
checksums:

- when none of the unpublished files were applied, setup executes the bundle;
- when all were applied with matching checksums, setup records the bundle without executing it again;
- when only part was applied, or a checksum differs, setup stops and requires the pre-release database
  to be completed or recreated.

`--write` first persists `migrations/releases/.<version>.prepare-state`, then writes bundles and the
release manifest atomically, and only then removes superseded draft files. If the command is
interrupted, rerun the same `prepare --write` command; it resumes from the journal and validates every
remaining source and bundle checksum before cleanup. Only one preparation journal may exist across
all versions, and manifest checks refuse to pass while any journal remains, so a forgotten interrupted
release cannot be hidden by preparing another version.

Release manifests describe logical schema streams rather than physical database names. During update,
setup expands them to fixed platform databases, all Control-managed assignment bindings, and every shard binding
such as `ENV_TDB_*_CORE_S1`. Legacy `TDB_*` environments must be recreated before applying the current
binding contract. This keeps the release
contract independent of tenant count and allows one tenant to span multiple D1 databases. Runtime-profile external database references are included in the
plan, but must currently be applied with operator-managed PostgreSQL/MySQL tooling because Hyperdrive
bindings do not expose database credentials to the local setup process.

New PostgreSQL PII migrations must be placed under `migrations/external/postgres/pii/`. Existing PII
files at the PostgreSQL migration root are classified through their legacy names. Core and custom
schema migrations remain at `migrations/external/postgres/`. MySQL and external audit databases are
rejected until corresponding logical streams exist; `--external-schema-ready` cannot bypass a missing
stream.

All D1 migration entry points discover the local release manifest automatically. This includes deploy,
Web deployment, initial tenant database bootstrap, and Control-managed shard provisioning, so consolidated bundles
always retain their `supersedes` behavior regardless of the command used. Status output also
materializes a fully applied draft set as its consolidated bundle, rather than reporting the bundle as
pending and every draft file as orphaned. For databases created before checksum recording was added,
the release updater may backfill blank history checksums only from a checksum-verified published
manifest. The evidence includes both bundle files and their `supersedes` entries; draft manifests
cannot authorize this compatibility conversion.

Repository maintenance helpers (`scripts/apply-migrations.sh`, `scripts/setup-admin-db.sh`, and the
legacy build resource setup) delegate to the same manifest-aware runner. Directly looping over SQL
files is unsupported because it cannot safely recognize consolidated release bundles. For
`scripts/setup-d1.sh`, core, PII, and Admin roles are applied separately; use `--role=core`,
`--role=pii`, or `--role=admin` when invoking `scripts/apply-migrations.sh` directly.
