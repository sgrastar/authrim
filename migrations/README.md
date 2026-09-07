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

These files support both fresh installs and release-coupled in-place updates. A release manifest keeps
those two plans separate: `streams` is the fresh-install plan, `freshInstallBaseline` identifies its
major/minor baseline, and `upgradePaths` contains only the delta or bridge from an explicit installed
version. Setup resolves upgrade paths from the recorded installed product version.

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

## Semantic fresh-install baselines

Create a complete fresh-install baseline for every migration stream at each major or minor boundary
(`x.y.0`). Patch releases reuse the series baseline and add release deltas only for changed streams.
The 0.4.0 files listed below are the first designated baseline candidates. They remain semantically
regenerable until the 0.4.0 tag reaches remote `main`, and become immutable at that publication point.
Generation is never inferred from a version bump or branch name. Run the write command only after the
repository owner explicitly requests the baseline.

Preview and then write the rewrite with:

```bash
pnpm release:migrations:semantic
pnpm release:migrations:semantic -- --write
```

The command applies the prior fresh plan plus current unpublished changes to empty SQLite databases and
isolated PostgreSQL 17 databases. It dumps the final schema and required seed state, reapplies each
generated baseline to a second empty database, and requires equivalent schema and seed dumps. It adds
the new baseline without deleting earlier baselines, deltas, release manifests, or provenance. Docker
must be available for PostgreSQL verification. It is valid only for `x.y.0`, and refuses to rewrite a
version whose tag is reachable from remote `main`.

## Layout

| Path                                | Stream / target    | Notes                                                                                             |
| ----------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `migrations/core/d1/*.sql`          | `core-d1`          | Runtime protocol, identity, consent, flow, directory auth, and end-user auth state.               |
| `migrations/pii/d1/*.sql`           | `pii-d1`           | Personal data, linked identities, sensitive values, and PII audit rows.                           |
| `migrations/admin/d1/*.sql`         | `admin-d1`         | Admin users, RBAC, approvals, jobs, logging, storage, identity mapping, and admin object catalog. |
| `migrations/control/d1/*.sql`       | `control-d1`       | Durable fleet inventory, rollout coordination, provisioning, and recovery state.                  |
| `migrations/lookup/d1/*.sql`        | `lookup-d1`        | Identifier lookup, routing, bucket state, and retention controls.                                 |
| `migrations/plugin-runner/d1/*.sql` | `plugin-runner-d1` | Plugin registry, activation, runtime resources, and delivery controls.                            |
| `migrations/core/postgresql/*.sql`  | `core-postgresql`  | PostgreSQL core, custom-claim, and policy schema.                                                 |
| `migrations/pii/postgresql/*.sql`   | `pii-postgresql`   | PostgreSQL PII schema.                                                                            |

The schema family is always the first path component. `external` is an execution/profile property,
not a schema identity. Release manifest format 2 records `schemaFamily`, `dialect`, `targetKind`, and
`logicalRoles`; consumers reject metadata that differs from the shared canonical stream contract.

## Authrim 0.4 fresh-install baseline files

| Stream           | File                                                    |
| ---------------- | ------------------------------------------------------- |
| D1 core          | `core/d1/001_0_4_0_core_baseline.sql`                   |
| D1 PII           | `pii/d1/001_0_4_0_pii_baseline.sql`                     |
| D1 Admin         | `admin/d1/001_0_4_0_admin_baseline.sql`                 |
| D1 Control       | `control/d1/001_0_4_0_control_baseline.sql`             |
| D1 Lookup        | `lookup/d1/001_0_4_0_lookup_baseline.sql`               |
| D1 Plugin Runner | `plugin-runner/d1/001_0_4_0_plugin_runner_baseline.sql` |
| PostgreSQL core  | `core/postgresql/001_0_4_0_core_baseline.sql`           |
| PostgreSQL PII   | `pii/postgresql/001_0_4_0_pii_baseline.sql`             |

The version token in each filename is generated from the root product version (`0.4.0` becomes
`0_4_0`). These files are new-install-only. Once 0.4.0 is published, they stay locked for the entire
0.4 series. A 0.4.x database is upgraded with release deltas; a 0.5.0 fresh install uses a new 0.5
baseline instead.

The generator writes the current evidence to `semantic-baseline.evidence.json` and preserves the
release candidate copy as `evidence/<version>.json`. These files retain the paths and checksums of
every source migration represented by each baseline. They are provenance and verification evidence,
not an upgrade map for a retained database. Once the corresponding remote-main tag is published, the
versioned evidence is immutable together with its baseline and manifest.

## Version examples

- `0.4.0`: fresh installs execute `001_0_4_0_*_baseline.sql`.
- `0.4.1`: fresh installs execute the 0.4.0 baseline plus `002_0_4_1_*_delta.sql`; existing
  0.4.0 databases execute only that delta.
- `0.4.2`: fresh installs execute the 0.4.0 baseline plus the 0.4.1 and 0.4.2 deltas; upgrades
  resolve only the deltas after their recorded source version.
- `0.5.0`: fresh installs execute `001_0_5_0_*_baseline.sql`; existing 0.4.x databases execute
  the validated 0.4.x-to-0.5.0 delta/bridge and never the 0.5 baseline.

The same rule continues at `1.0.0`, `1.0.1`, `1.1.0`, and later versions. Every stream receives a
new complete baseline at `x.y.0`; only changed streams receive a release delta.

## Commands

```bash
# Apply D1 migrations for an environment through the setup migration runner
DEPLOY_ENV=test node scripts/ci-run-migrations.mjs

# Inspect migration status through setup package helpers
pnpm --filter @authrim/setup test -- src/__tests__/cloudflare-migration-status.test.ts
```

Add sequential temporary migrations while developing an unpublished release. Before release,
consolidate each changed stream into one semantically verified versioned delta only when the repository
owner requests it. A version becomes published when its tag is reachable from remote `main`; every
migration and checksum in that release is then immutable, including for 0.x releases. A version bump,
branch name, or PR does not authorize baseline generation or delta consolidation.

## Release-coupled schema updates

`migrations/release-manifest.draft.json` records exact paths and dialect-rendered checksums for every
logical stream. Its fresh-install and upgrade plans are distinct. `pnpm migrate:create` refreshes the
draft automatically, and the root typecheck gate runs `pnpm migrate:manifest:check`. Before changing an
existing migration, fetch remote `main` and tags and verify that no matching version tag is reachable
from remote `main`. The presence of a local manifest alone is not publication; a remote-main tag is.

Before merging to `main`, run the read-only release gate. It reports a missing/stale baseline or
per-release delta and never generates either artifact:

```bash
pnpm migrate:release:check
```

`pnpm migrate:manifest` refreshes only the development draft. It does not update an existing
unpublished release candidate; preparing or replacing that candidate remains an explicit owner-directed
release action. Initial development deployments may select the newer draft without mutating the
candidate.

Before a release, preview consolidation without changing files:

```bash
pnpm release:migrations -- --version 1.1.0 --minimum-version 1.0.0
```

When importing an older tagged release that predates the manifest workflow, create its non-destructive
manifest from that tag once:

```bash
pnpm release:migrations:baseline -- --version 1.0.0 --git-ref v1.0.0 --write
```

After reviewing the plan, explicitly write it:

```bash
pnpm release:migrations -- --version 1.1.0 --minimum-version 1.0.0 --write
```

When the repository owner requests release preparation, generate the fresh baseline first at `x.y.0`.
For every release, the preparation command merges multiple unpublished files into at most one versioned
delta per changed stream. It applies the prior
fresh plan and earlier release deltas to two isolated databases, applies the source files to one and
the consolidated delta to the other, and requires equivalent schema objects and seed/reference data
on SQLite or PostgreSQL before writing. The manifest stores this semantic evidence together with the
`supersedes` paths and checksums. Published files and manifests remain immutable:

- when none of the unpublished files were applied, Setup or Control executes the bundle;
- when all were applied with matching checksums, Setup or Control records the bundle without executing
  it again;
- when only part was applied, or a checksum differs, Setup or Control stops and requires the
  pre-release database to be completed or recreated.

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

New PostgreSQL PII migrations must be placed under `migrations/pii/postgresql/`; core, custom, and
policy migrations remain at `migrations/core/postgresql/`. No filename-based classification or
legacy PostgreSQL root is used. MySQL and external audit databases are
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
