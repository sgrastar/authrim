---
project: Authrim
lang: en
date: 2026-08-16
description: 'Repository Guidelines.'
type: instructions
tags:
  - authrim
  - admin-ui
  - login-ui
  - testing
  - development
  - database
---

# Repository Guidelines

## Project Structure & Module Organization

Authrim is a `pnpm`/Turbo monorepo. Most code lives in `packages/`: Cloudflare Worker services like `ar-auth`, `ar-token`, and `ar-management`; shared modules under `ar-lib-*`; SvelteKit frontends in `ar-admin-ui` and `ar-login-ui`; and the setup CLI in `setup`. Keep source in `packages/*/src` and package tests in `src/__tests__`. Integration tests live in `test/integration`, accessibility and browser tests in `test-e2e`, migrations in `migrations`, scripts in `scripts`, and benchmarks in `load-testing`.

## Build, Test, and Development Commands

Use Node `>=22` and `pnpm@9`.

- `pnpm install`: install workspace dependencies.
- `pnpm dev`: run the full workspace in development mode through Turbo.
- `pnpm build` or `pnpm build:api`: build the workspace or only Worker packages.
- `pnpm test`: run Vitest suites across the monorepo.
- `pnpm test:e2e`: run Playwright flows in `test-e2e/`.
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check`: required quality gates before shipping.
- `pnpm --filter @authrim/ar-auth test`: run a single package’s tests while iterating.

### Migration Development Workflow

During development, keep the current product version and use the draft release manifest. Do not run
`pnpm release:migrations ... --write` and do not create `migrations/releases/<version>.json` merely to
deploy unfinished schema changes to a development or test environment. Prepare the release manifest
only at the actual release boundary. The product version becomes published—and therefore closed to
migration changes—only when its version tag is reachable from remote `main`.

After adding or editing an unapplied migration, regenerate and verify the draft manifest:

```sh
pnpm migrate:manifest
pnpm migrate:manifest:check
```

For a new core D1 migration, prefer the helper because it allocates the next filename and refreshes the
draft automatically:

```sh
pnpm migrate:create <snake_case_name>
```

For Admin, PII, or external PostgreSQL streams, add the next sequential SQL file in the appropriate
directory and then run `pnpm migrate:manifest`. Do not renumber existing migrations.

Preview and apply the current development draft to an existing test environment with:

```sh
pnpm run setup update --env test --allow-draft-manifest --all --dry-run
pnpm run setup update --env test --allow-draft-manifest --all --yes
```

If the disposable test environment must be recreated, do so only after the user explicitly authorizes
data loss. Delete the complete environment and then initialize it again; initial deployment accepts the
current draft manifest automatically:

```sh
pnpm run setup delete --env test --all --yes
pnpm run setup init --env test
```

Always use `pnpm run setup ...` for this CLI. `pnpm setup` invokes pnpm's own built-in setup command and
does not run Authrim's `setup` package script. Do not put an extra `--` between `setup` and the Authrim
subcommand.

The product version does not need to change for each development migration. Multiple migrations may be
added under one unpublished version. The repository owner decides when to generate a major/minor
baseline and when to consolidate a release's temporary migrations into its per-stream delta. AI agents
must not proactively run either write operation merely because the version or branch changed; wait for
an explicit owner instruction. Before a change is merged to `main`, run `pnpm migrate:release:check`
and report a missing or stale baseline/release delta instead of generating it. Do not hand-edit or merely
concatenate a baseline or release delta; when directed, use the repository migration tooling and verify
equivalent schema objects, constraints, indexes, triggers, and seed/reference data on every supported
database backend.

### Permanent baseline and delta policy

- Apply this policy independently to every migration stream, including core, PII, Admin, Control,
  Lookup, Plugin Runner, and external PostgreSQL.
- Create a complete fresh-install baseline at each major or minor boundary (`x.y.0`). Patch releases
  reuse that series baseline and must not create another fresh baseline.
- A fresh-install baseline is only for an empty database. Never apply a newer fresh baseline to upgrade
  an existing database; use the release deltas or an explicit, tested upgrade bridge selected from the
  installed product version.
- Development under an unpublished version may use multiple temporary migration files. Before release,
  and only when the repository owner directs it, semantically consolidate the files changed in each
  stream into that release's single versioned delta; streams with no schema change need no delta.
- Baseline generation and release-delta consolidation are owner-triggered operations. Do not infer
  authorization from a version bump, a release branch, or a PR to `main`. Main-bound validation is
  read-only: it must fail and point out missing/stale release files so the owner can choose when to
  prepare them.
- A version is published only when a tag for that version (normally `v<version>`) is reachable from the
  remote `main` branch. Fetch `origin/main` and tags before making the determination. Before rewriting
  an existing migration, verify from the remote-main tag and release-manifest/version evidence that the
  migration is unpublished.
- Once published, every baseline, delta, bridge, manifest, checksum, and provenance record is immutable:
  never edit, rename, delete, renumber, squash, or re-integrate it. Keep all prior published migration
  artifacts for upgrade history and verification. This rule applies to 0.x and remains mandatory at and
  after 1.0.0.
- Preserve semantic baseline provenance in both the current evidence file and the versioned
  `migrations/evidence/<version>.json` release record. Main-bound validation must compare tagged
  manifests, executable SQL, and versioned evidence with the remote-main tag rather than trusting a
  newly computed checksum in the working tree.
- `001_0_4_0_*_baseline.sql` is Authrim's first designated fresh-install baseline candidate. Until
  the 0.4.0 tag reaches remote `main`, update it only through semantic baseline tooling and preserve
  its evidence. Once that tag is published, it is locked for the 0.4 series; 0.4.1 and later changes
  are forward deltas.

### Release Update and Migration Rollout Policy

Expose one setup-managed release update to the operator. Do not require the operator to choose whether
setup or Control performs a migration. Setup owns the release plan, applies bootstrap-critical and fixed
platform databases that Control cannot safely migrate, publishes the immutable checksummed migration
artifact, and hands the pinned artifact to Control for databases in Control's durable inventory. Control
owns bounded fan-out, retries, idempotency, resume state, and per-target and aggregate progress for
managed tenant and shard databases. External databases remain operator-applied unless an authenticated
executor and target inventory have been registered explicitly.

Use the same `release_update` state machine for every product update:

- A Worker-only release has an empty schema delta. It must not contact or mutate databases merely
  because the product version changed, and it deploys only changed Workers and enabled UIs.
- A release containing database and Worker changes completes every required database migration before
  activating schema-dependent Workers. Setup then deploys Workers, verifies readiness, and only after
  complete release verification commits the installed `productVersion`.
- A database-only update is an explicit advanced operation. It may retain existing Workers only when
  the release contract declares them compatible with the resulting schema. Encode this only as
  `rollout.databaseOnly.compatibleWorkerVersions`, an exact non-empty product-version allow-list.
  Absence of that object denies database-only execution. Setup must also verify every retained Worker
  is recorded at the installed product version. A successful database-only update records
  `database_only_verified` without advancing `productVersion`, so the full update remains available.

The Setup-to-Control handoff must be a durable operation, not one long HTTP request. Pin the release,
manifest digest, target inventory, rollout policy, retry state, and completion evidence. Closing setup
or Admin UI must not cancel the rollout; restarting setup must resume observation of the same operation.
Expiry of a bounded setup observation window is an `inProgress` handoff result, not a failed release.
Control must not deploy or update itself. If a new coordinator is required, setup must first apply a
backward-compatible Control schema expansion and deploy a Control version that works with both the old
and expanded schema.

Published release manifests must store semantic rollout policy, not UI implementation details. Use the
following contracts unless a future manifest schema deliberately replaces them:

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

Do not put Admin UI paths, component names, button IDs, or translated text in a release manifest.
Control's durable rollout state is the source of truth; Management derives API capabilities from that
state, and Admin UI renders those capabilities and rollout progress. When `adminMutationMode` is
`read_only`, the Management API must reject covered mutations in addition to Admin UI disabling them.
Inspection, audit, progress, logout, and authorized recovery must remain available. Keep the mutation
fence active until the complete release is verified, not merely until database work finishes. Unknown
or contradictory rollout state must fail closed before schema-dependent Worker activation.
Treat `completed` as valid only when the rollout operation, every required step, and target progress
are mutually consistent. Authorized recovery may requeue one explicitly selected blocked release
target only after Management and Control have persisted audit evidence; keep that exact recovery route
available through the mutation fence and reject broader mutation exceptions.

Treat a clean major-version baseline and an in-place major-version upgrade as separate artifacts. A
2.x baseline may semantically consolidate cumulative 1.x SQL for fresh installations, but it must not
replace the immutable, explicitly tested 1.x-to-2.x bridge. Design that bridge as an expand,
migrate/backfill, switch compatible Workers, verify, then contract sequence. Declare the oldest direct
source in `minimumProductVersion`; older installations must use a supported intermediate release or a
separately documented export/import procedure.

Every release, including 0.x, requires a finalized release manifest. When the repository owner gives
the release-boundary instruction, run the semantic fresh-baseline writer for a major/minor release;
for every release, verify the draft and finalize the version with:

```sh
pnpm release:migrations -- --version <version> --write
```

The resulting `migrations/releases/<version>.json` records the fresh-install plan and explicit upgrade
path separately. It becomes immutable when the version tag is on remote `main`. Do not ship any release
from the draft manifest or require operators to pass `--allow-draft-manifest` for installation.

Within every supported release line, migrations are forward-only and append-only after publication. For
example, a 1.0.0 installation reaches 1.1.0 through published deltas/bridges, while a fresh 1.1.0
installation starts from the 1.1.0 baseline. The same rule applies to 0.4.x→0.5.0 and all later major or
minor boundaries. A release manifest must distinguish `freshInstallBaseline` from `upgradePaths`, and
Setup must select the path from the installed product version rather than from current database shape.

The operator-facing setup flow remains one update action even though execution is split internally.
Setup performs local-only/bootstrap work, deploys a compatible Control coordinator when required, and
creates or resumes the same pinned Control rollout operation. Control snapshots the managed database
inventory at handoff time and reconciles that frozen target set with bounded concurrency. Databases
created after the snapshot start at the active release and are not appended to the in-flight target
set. Setup must not mark the product version complete until Control reports database completion and
all selected Workers and UIs pass release verification.

Do not claim that the end-to-end Setup-to-Control fleet handoff is implemented until operation
persistence, target snapshotting, reconciliation, Admin progress reporting, API mutation fencing, setup
resume behavior, and their failure/retry tests are all wired together. Changes to this flow must update
the release manifest schema, setup, Control, Management API/OpenAPI, Admin UI, tests, and release
documentation together.

### Admin UI Dev Mock

For local Admin UI screen checks without a real admin login, use the Admin UI-only dev mock:

```sh
AUTHRIM_ADMIN_UI_DEV_MOCK=true pnpm --dir packages/ar-admin-ui exec vite dev --host 127.0.0.1 --port 5175
```

Then open `http://127.0.0.1:5175/admin/clients/new`,
`http://127.0.0.1:5175/admin/clients/dev-oidc-client`, or
`http://127.0.0.1:5175/admin/saml/dev-saml-sp`. This mock must remain physically scoped to
the `ar-admin-ui` dev server only: no Worker/API authentication bypass, no production-mode enablement,
no non-loopback host enablement, and no production admin session cookie. After production builds, run
`pnpm --filter @authrim/ar-admin-ui run check:dev-mock-guard` to confirm the dev mock flag and sentinel
are absent from the Admin UI production server output and `ar-management` Worker source.

## Coding Style & Naming Conventions

TypeScript uses ESM imports. Backend and library packages follow the root Prettier config: 2-space indentation, semicolons, single quotes, trailing commas (`es5`), and 100-character lines. `ar-admin-ui` and `ar-login-ui` use package-local Prettier with tabs and `prettier-plugin-svelte`; do not normalize them to the backend style. ESLint forbids `console`, prefers `_unused` for intentionally unused parameters, and rejects new `any` in Worker code. Package tests use `*.test.ts`; Playwright specs use `*.spec.ts`.

## Testing Guidelines

Add or update tests with every behavior change. Use Vitest for unit and integration coverage, and Playwright plus `axe-core` for end-to-end and accessibility flows. Keep fast unit tests close to the code they validate; place system-level scenarios in `test/integration`. Run `pnpm test` locally before sharing work, and use coverage (`pnpm test -- --coverage` or package `test:coverage`) for auth, token, policy, or other security-sensitive changes.

For security-sensitive work, treat coverage as a signal, not the goal. Add tests that would fail for plausible regressions, especially for redirect URI validation, client authentication, PKCE, token claims, tenant or issuer resolution, CSRF/origin checks, JWK selection, session/logout behavior, logging redaction, and audit evidence.

Use decision-table or matrix-style tests when a behavior depends on multiple conditions. Use state-transition tests for sessions, refresh-token families, device flow, CIBA, passkey binding, external IdP linking, tenant lifecycle, approval flows, and queue delivery. Use contract or snapshot tests only for stable external contracts such as discovery metadata, JWKS shape, OpenAPI, setup output, webhook payloads, audit schemas, and queue payload schemas.

Security bug fixes should include a regression test that fails before the fix when practical. Changes that touch authentication, authorization, tenant boundaries, storage topology, or logging/audit behavior should include at least one negative case for malformed, expired, replayed, cross-tenant, unauthorized, or privacy-sensitive input where applicable.

When behavior has important side effects, assert them. Examples include audit events, settings history, operational logs and redaction, session or grant state, queue delivery, webhook payloads and signatures, generated environment files, and tenant-scoped storage writes. Avoid tests that only execute uncovered lines without validating observable behavior or a stable boundary contract.

For runtime topology changes, consider single-tenant, multi-tenant, shared D1, tenant-specific D1, external database paths, naked domains, custom domains, service bindings, and UI proxy modes. Use local Vitest integration tests for topology and protocol matrices when possible; reserve Playwright for browser-visible behavior, WebAuthn/passkey flows, page storage, accessibility, and user navigation.

By default, tests must not depend on real external network services. Use deterministic clocks, keys, tenants, clients, users, mock IdPs, mock JWKS endpoints, fake delivery providers, and local fixtures. Do not change queue producer payload schemas unless the feature explicitly requires it; if the schema changes, update producer, consumer, contract tests, and documentation together.

## API Contract Documentation

OpenAPI documents live in package-local `openapi/` directories for packages that own externally reachable HTTP APIs. For example, Admin API contracts live in `packages/ar-management/openapi/admin.openapi.yaml`. When adding, deleting, renaming, or behaviorally changing an API route, update the owning package's OpenAPI document in the same change. Keep OpenAPI text in English and describe externally observable contracts only: paths, methods, parameters, authentication, request bodies, response shapes, and stable error contracts. Do not include secrets, production credentials, private tenant names, vulnerability notes, internal runbooks, generated environment files, or one-off test session values in OpenAPI files. Do not duplicate specs in `ar-router`; document the implementation package that owns the route.

Run `pnpm openapi:validate` after editing OpenAPI files. Run `pnpm openapi:routes -- --fail-on-missing` when changing Worker route tables so implemented public routes stay documented. `pnpm openapi:backfill-routes` may be used to create or refresh `x-authrim-route-coverage: inferred-from-source` coverage stubs, but those stubs are a starting point; replace them with detailed request, response, and error schemas when the API behavior is changed intentionally.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit-style subjects such as `feat: ...`, `fix(setup): ...`, and `style: ...`. Keep subjects imperative, scoped when useful, and limited to one change. Public pull requests are not currently accepted; use GitHub Issues for bugs and feature requests instead. For internal patches, include affected packages, migration filenames, commands run, and screenshots for `ar-admin-ui` or `ar-login-ui` changes.

## Security & Configuration Tips

Never commit secrets or generated environment files such as `.dev.vars`, `.authrim/`, `wrangler.*.toml`, `.keys/`, or database files. Use the setup scripts in `scripts/` to regenerate local configuration. Report vulnerabilities privately to `yuta@sgrastar.org`, not through public issues.
