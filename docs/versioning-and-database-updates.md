---
project: Authrim
lang: en
date: 2026-08-16
description: 'Steps for preparing, testing, publishing, deploying, and verifying an Authrim release.'
type: guide
tags:
  - authrim
  - release
  - versioning
  - database
  - deployment
---

# Authrim release procedure

This document is the working procedure for releasing a new Authrim product version and updating an
existing environment. For a normal release, follow the sections in order.

The commands use a `0.3.3` to `0.4.0` release as an example. Replace the versions and environment names
for another release.

## 1. Record the release information

Record these items before starting:

| Item                                       | Example                           |
| ------------------------------------------ | --------------------------------- |
| Version to release                         | `0.4.0`                           |
| Oldest version supported for direct update | `0.3.3`                           |
| Test environment                           | `test`                            |
| Production environment                     | `prod`                            |
| Login UI                                   | Enabled or disabled               |
| Admin UI                                   | Enabled or disabled               |
| External PostgreSQL                        | None or the target database names |
| Release owner                              | Name                              |
| Planned release time                       | Date and time                     |

Choose the version using these guidelines:

| Change | Example            | Use it for                                        |
| ------ | ------------------ | ------------------------------------------------- |
| Major  | `1.4.2` to `2.0.0` | A change that is not compatible with existing use |
| Minor  | `1.4.2` to `1.5.0` | A compatible feature addition                     |
| Patch  | `1.4.2` to `1.4.3` | A compatible bug fix                              |

Before `1.0.0`, an incompatible change will normally increase the middle number, while a compatible
fix will increase the last number. The number of SQL files does not decide the version.

## 2. Release checklist

The normal sequence is:

1. Prepare the release candidate on `develop`.
2. Update and check the test environment with the development SQL file list.
3. Fix the SQL files for the release.
4. Check the test environment again with the prepared release SQL file list.
5. Run all checks and merge the `develop` to `main` pull request.
6. Publish the tag and GitHub Release.
7. Update and verify production.

Check each item when it is complete:

- [ ] The release version is decided
- [ ] The root and all package versions match
- [ ] The development SQL file list is current
- [ ] The development changes were applied to the test environment
- [ ] Required test-environment checks passed
- [ ] The release SQL and prepared release SQL file list were created
- [ ] The test environment was checked against the prepared release SQL file list
- [ ] Lint, type checking, tests, and build passed
- [ ] The `develop` to `main` release pull request passed
- [ ] The tag and GitHub Release were published
- [ ] Production prechecks and backups were completed
- [ ] The production environment was updated
- [ ] Production checks passed
- [ ] The release result was recorded

## 3. Prepare the release candidate

### 3.1 Check local changes

```sh
git status --short
```

Confirm that there are no unintended changes, secrets, `.authrim/` files, keys, or generated
`wrangler.toml` files.

### 3.2 Make product versions match

Set `version` to the release version in the root `package.json` and every
`packages/*/package.json`. For a `0.4.0` release, they must all contain `0.4.0`.

Use these commands to find package-version differences and an out-of-date SQL file list:

```sh
pnpm migrate:manifest
pnpm migrate:manifest:check
```

Before changing an existing migration, fetch `origin/main` and tags. If the version tag is reachable
from remote `main`, the database artifacts are published and immutable; use the next product version.

### 3.3 Check locked dependencies

```sh
pnpm install --frozen-lockfile
```

If it fails, stop the release and correct the difference between `package.json` and `pnpm-lock.yaml`.

## 4. Test the release candidate in the test environment

Test the development SQL before fixing the release file list. At this point, a problem can still be
corrected by adding another SQL file.

### 4.1 Check the development SQL file list

```sh
pnpm migrate:manifest
pnpm migrate:manifest:check
```

### 4.2 Preview the test update

```sh
pnpm run setup update --env test --allow-draft-manifest --all --dry-run
```

Confirm:

- The target product version is correct
- Core, PII, and Admin D1 are included
- Tenant-specific and split D1 databases are included
- External database targets are correct
- Enabled Workers and UIs are correct

### 4.3 Apply the test update

```sh
pnpm run setup update --env test --allow-draft-manifest --all --yes
```

This command updates the required databases before publishing Workers.

### 4.4 Check the test environment

```sh
pnpm run setup status --env test
pnpm exec tsx test/generated-environment/smoke-generated-api.ts --env test
pnpm exec tsx test/generated-environment/smoke-generated-admin-api.ts --env test
pnpm exec tsx test/generated-environment/smoke-generated-auth-flow.ts --env test
pnpm exec tsx test/generated-environment/smoke-generated-approvals.ts --env test
pnpm exec tsx test/generated-environment/smoke-generated-server-surfaces.ts --env test
```

Also check the changed features through their UI or API. If a problem is found, correct the code or add
a new SQL file, then repeat from section 4.1.

### 4.5 Major/minor fresh-install baseline

For an `x.y.0` release, preview and then write the semantic fresh-install baseline for every stream.
Do not run this for a patch release, and do not run the write command until the repository owner
explicitly requests baseline generation:

```sh
pnpm release:migrations:semantic
pnpm release:migrations:semantic -- --write
pnpm migrate:manifest:check
git diff -- migrations
```

This is not textual concatenation. The command materializes the prior fresh plan plus current changes
for SQLite and PostgreSQL, reapplies the generated baselines to empty databases, and requires schema
and seed equivalence. It adds the new baseline without replacing earlier baselines, deltas, manifests,
or provenance. It records the current evidence in `migrations/semantic-baseline.evidence.json` and a
release-specific copy in `migrations/evidence/<version>.json`. Existing environments continue through
explicit deltas or bridges.

## 5. Fix the database update for the release

After the test environment passes, stop adding SQL files and create the release files.
This is an owner-triggered release-boundary action. A version bump, release branch, or PR to `main`
does not authorize an AI agent or automation to generate these files.

### 5.1 Preview the release files

This command only displays the planned file changes:

```sh
pnpm release:migrations -- --version 0.4.0
```

For a major/minor release, the semantic baseline from section 4.5 is the complete fresh-install
artifact. The release delta or bridge remains separate and upgrades the immediately preceding
supported release. Use `--minimum-version` when an explicit compatibility boundary is needed.

### 5.2 Write the release files

```sh
pnpm release:migrations -- --version 0.4.0 --write
```

This prepares `migrations/releases/0.4.0.json` from the verified baseline. Later releases use the same
command to combine unpublished files in each changed stream into one versioned release delta and
record their source paths and checksums in `supersedes`. Before writing, it verifies the source files
and consolidated delta from the same prior schema on SQLite or PostgreSQL and stores the resulting
schema/seed checksums and object count as semantic evidence.

Do not remove source SQL files yourself. If the command is interrupted, run the same `--write` command
again.

### 5.3 Review the result

```sh
pnpm migrate:manifest:check
git diff -- migrations
```

Confirm:

- `migrations/releases/0.4.0.json` exists
- It contains only the intended SQL
- Combined SQL contains every intended source file
- No migration belonging to a remote-main tag changed
- `freshInstallBaseline` identifies the correct series baseline
- `upgradePaths` contains deltas/bridges only and never a fresh baseline

The PR and main publication workflows run `pnpm migrate:release:check`. This check is read-only: when
the owner-triggered baseline or consolidated release delta has not been prepared, it fails and reports
the omission instead of creating files automatically.

The normal `pnpm migrate:manifest` command updates only the draft manifest. It does not silently refresh
an existing release candidate; development installs that explicitly allow the draft use that draft,
while the main-bound check reports any candidate divergence.

A version is published when its tag is reachable from remote `main`. From that point, do not change,
rename, delete, or re-integrate its SQL, manifest, checksum, or provenance. This applies to 0.x and
continues unchanged after 1.0.0; put every correction in a later release delta.

## 6. Check the test environment against the prepared release SQL file list

Run the test update again after fixing the release file list:

```sh
pnpm run setup update --env test --all --dry-run
pnpm run setup update --env test --all --yes
pnpm run setup status --env test
```

If every development SQL file was already applied with the same content, setup will not run the
combined SQL again. It stops if only some source files were applied or their contents differ. Do not
continue to production in that case.

## 7. Run release checks

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If a UI changed, also run:

```sh
pnpm test:e2e
```

For authentication, token, permission, or database changes, also check the affected package tests and
failure cases. Do not open the release pull request while a required check is failing.

## 8. Create the release pull request and merge it to main

Authrim tests `develop` in the test environment before opening a release pull request to `main`.
Automatic test deployment from `develop` pauses while that pull request is open. Open the release pull
request only after completing the test-environment checks.

Before creating the pull request, prepare English release notes at
`private/docs/releases/0.4.0-github-release.md`. Include the main changes, update notes, incompatible
changes, and check results.

Create the pull request in GitHub or with this command. Write its title and body in English:

```sh
gh pr create \
  --base main \
  --head develop \
  --title "Release 0.4.0" \
  --body-file private/docs/releases/0.4.0-github-release.md
```

Before merging, confirm:

- All required GitHub Actions checks passed
- The version matches in every package
- Release SQL and the prepared release SQL file list are in the pull request
- The tested commit matches the pull request
- Release and update notes are included

After the merge to `main`, Authrim automatically publishes `@authrim/setup` when the version in
`packages/setup` differs from the version on npm.

## 9. Publish the tag and GitHub Release

Wait for the `main` checks and `@authrim/setup` publication result before continuing.

```sh
git switch main
git pull --ff-only
git tag -a v0.4.0 -m "Authrim 0.4.0"
git push origin v0.4.0
```

Pushing a `v0.4.0` tag starts the GitHub Actions job that produces release software-component and
build-source evidence.

Create the GitHub Release from the release notes:

```sh
gh release create v0.4.0 \
  --title "Authrim 0.4.0" \
  --notes-file private/docs/releases/0.4.0-github-release.md
```

## 10. Update production

### 10.0 Understand the update coordinator

The operator always starts one update through setup. Setup decides the internal execution path from
the release manifest and the installed per-target schema evidence:

| Release contents                           | Database work                                                                                   | Worker work                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Workers only                               | None                                                                                            | Deploy only the changed Workers and enabled UIs |
| Database and Workers                       | Setup updates bootstrap-critical databases, then delegates Control-managed databases to Control | Deploy after every required database is ready   |
| Database only, explicit advanced operation | Apply the database rollout and retain compatible Workers                                        | No Worker deployment                            |

The normal user experience remains one update action. Setup publishes and pins the checksummed
migration artifact before delegation. Control then owns the durable fan-out across tenant and shard
databases, including batching, retries, resume state, and aggregate progress. Setup continues after
Control reports `awaiting_setup`, deploys Workers, verifies readiness, and records completion.

During a delegated rollout, Admin UI shows progress independently of the setup process. When the
manifest declares `adminMutationMode: read_only`, Admin settings and other covered mutations are
disabled and the Management API rejects equivalent writes. Read-only inspection, audit, logout,
rollout status, and authorized recovery remain available. The restriction remains until the complete
release—not only its database portion—is verified.

For an intentionally decoupled schema rollout, the release manifest must opt in with an exact Worker
version allow-list:

```json
{
  "rollout": {
    "databaseExecution": "setup_then_control",
    "workerActivation": "after_required_databases",
    "adminMutationMode": "read_only",
    "databaseOnly": {
      "compatibleWorkerVersions": ["1.0.0"]
    }
  }
}
```

Its absence means database-only update is forbidden. Setup also verifies that every recorded Worker
is at the installed product version. Run the advanced operation explicitly:

```sh
pnpm run setup update --env prod --database-only --yes
```

The Web setup screen exposes the same advanced action with a confirmation. On success, the schema is
verified at the target release while Workers and `productVersion` remain unchanged; the ordinary full
update remains available afterward. Exact versions are used deliberately—SemVer ranges or inferred
compatibility are not accepted.

Setup observes a handed-off rollout for a bounded interval. Reaching that observation limit returns a
successful `inProgress` result rather than failing a healthy large fleet. Control continues the pinned
operation, and setup or Admin UI can resume observation by operation ID. If a target becomes blocked,
a platform administrator can retry that specific target from Admin UI; both Management and Control
write audit evidence, and the mutation fence allows only this narrow recovery endpoint.

For a major release, the published cumulative SQL may be reorganized into a new clean baseline for
fresh 2.x installations. That baseline is not the 1.x-to-2.x upgrade program. Existing 1.x databases
must use an immutable, explicitly tested bridge path (normally expand, migrate/backfill, switch
compatible Workers, verify, then contract). The manifest's `minimumProductVersion` declares the oldest
directly supported source. Older installations must update through a supported intermediate release
or use a separately documented export/import procedure.

### 10.1 Production prechecks

- [ ] The target commit on `main` matches `v0.4.0`
- [ ] Test-environment checks are complete
- [ ] D1, external databases, R2, environment settings, and keys were backed up as required
- [ ] An owner can access each external PostgreSQL database
- [ ] The monitoring owner and contact method are decided
- [ ] Login UI and Admin UI settings match the intended production setup

Use the exact tagged source:

```sh
git switch --detach v0.4.0
pnpm install --frozen-lockfile
```

### 10.2 Check the current production state

```sh
pnpm run setup status --env prod
pnpm run setup update --env prod --dry-run
```

Review the source version, target version, D1 databases, external databases, Workers, and UIs.

### 10.3 Apply external PostgreSQL SQL when required

Apply every external PostgreSQL SQL file shown by `--dry-run` to its target database. Example:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f migrations/external/postgres/001_0_4_0_external_postgres_core_baseline.sql
```

Use the actual file shown by `--dry-run`. If Core and PII use different databases, apply each SQL file
to its matching database.

### 10.4 Run the production update

Without an external PostgreSQL target:

```sh
pnpm run setup update --env prod --all --yes
```

After applying required external PostgreSQL SQL:

```sh
pnpm run setup update --env prod --all --external-schema-ready --yes
```

Setup confirms required external database work, updates every D1 database, and only then publishes
Workers. It publishes Login UI and Admin UI only when they are enabled in the environment
configuration.

## 11. Verify production

### 11.1 Check the installed version

```sh
pnpm run setup status --env prod
```

Confirm that the installed product version is `0.4.0` and the update is complete.

### 11.2 Check public endpoints

```sh
curl -fsS https://auth.example.com/.well-known/openid-configuration | jq
curl -fsS https://auth.example.com/.well-known/jwks.json | jq
```

Replace the example host with the production host.

### 11.3 Check enabled features

- Login and logout
- Token issue and refresh
- Admin API
- Login UI and Admin UI when enabled
- SAML, external identity providers, Agent Access, or other changed features
- Error rate, Worker logs, and external database connections

Record the tag, time, operator, check results, and any problem in the release record.

## 12. If a problem occurs

### The update stopped

Correct the cause and run `setup update` again for the same version and environment. Setup checks its
saved database records and continues the release.

```sh
pnpm run setup status --env prod
pnpm run setup update --env prod --all --yes
```

Include `--external-schema-ready` again when external PostgreSQL was already confirmed.

### Worker publication failed after SQL was applied

Do not overwrite the environment with Workers from an older product version. Run the same
`setup update` again and complete publication of the current version.

### A problem was found after release

Once the release tag is present on remote `main`, do not change its fixed SQL or release manifest. For
example, after the 0.4.0 tag is published, keep `migrations/releases/0.4.0.json` unchanged, prepare
`0.4.1`, and add a new correction SQL file if required. Before that tag exists, 0.4.0 remains an
unpublished candidate and may be regenerated only after the repository owner requests it.

Authrim does not support downgrading the product and database to an older version.

## 13. Headless installation check

The remaining sections are supporting procedures for cases that need them. A normal release to an
existing environment is complete after section 12.

For an environment without Login UI and Admin UI, use this configuration:

```json
{
  "components": {
    "loginUi": false,
    "adminUi": false
  }
}
```

With this setting, only databases and API Workers are updated.

`--skip-ui` skips UI publication for one command. It does not define a headless installation. An
initial deployment rejects `--skip-ui` while either UI is enabled.

## 14. Creating a new environment

Start a new environment with setup:

```sh
pnpm run setup init --env prod
```

To answer setup questions in the terminal:

```sh
pnpm run setup init --env prod --cli
```

If D1 and KV already exist but no Worker has been published:

```sh
pnpm run setup deploy --env prod --dry-run
pnpm run setup deploy --env prod --yes
```

The initial deployment also updates every target D1 database before publishing Workers.

## 15. Adding SQL during normal development

Do not increase the product version for every SQL file. One unpublished product version may contain
several SQL files.

Create a Core D1 SQL file with:

```sh
pnpm migrate:create add_user_preferences
pnpm migrate:manifest:check
```

For Admin, PII, or external PostgreSQL, add the next numbered file to the matching directory, then run:

```sh
pnpm migrate:manifest
pnpm migrate:manifest:check
```

Do not edit SQL after it has been applied to a database that must be kept. Add a new correction SQL
file.

If the SQL was applied only to a disposable test environment and its data may be deleted, recreate it.
The following command deletes the test environment data:

```sh
pnpm run setup delete --env test --all --yes
pnpm run setup init --env test
```

If the current product version has already been published, change the root and every package to the
next product version before adding SQL. New SQL cannot be added to a published version.

## 16. Main files

| File or location                         | Purpose                           |
| ---------------------------------------- | --------------------------------- |
| Root `package.json`                      | Authrim product version           |
| `packages/*/package.json`                | Package versions                  |
| `migrations/*.sql`                       | Core D1 SQL                       |
| `migrations/pii/*.sql`                   | PII D1 SQL                        |
| `migrations/admin/*.sql`                 | Admin D1 SQL                      |
| `migrations/external/postgres/*.sql`     | External PostgreSQL SQL           |
| `migrations/release-manifest.draft.json` | Development SQL file list         |
| `migrations/releases/<version>.json`     | Fixed SQL file list for a release |

The code and error messages call the SQL file list a `release manifest`.
