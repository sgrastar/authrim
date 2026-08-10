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

These files support both fresh installs and release-coupled in-place updates.
Published release manifests are the immutable contract for deciding which
migrations apply to an existing physical database.

## Layout

| Path                                 | Target database             | Notes                                                                                             |
| ------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `migrations/*.sql`                   | D1 core database            | Runtime protocol, identity, consent, flow, directory auth, and end-user auth state.               |
| `migrations/pii/*.sql`               | D1 PII database             | Personal data, linked identities, sensitive values, and PII audit rows.                           |
| `migrations/admin/*.sql`             | D1 admin database           | Admin users, RBAC, approvals, jobs, logging, storage, identity mapping, and admin object catalog. |
| `migrations/external/postgres/*.sql` | External PostgreSQL profile | Durable external core/PII schema and feature-specific PostgreSQL extensions.                      |

Top-level core migrations intentionally exclude the `admin`, `archive`,
`external`, and `pii` directories when the D1 core runner walks this directory.

## Current Core Files

| File                                            | Category                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `001_core_foundation.sql`                       | Tenant foundation and trust groups.                                                                                                  |
| `002_core_protocol_and_consent.sql`             | OAuth/OIDC, sessions, grants, consent baseline, and device credentials.                                                              |
| `003_core_policy_identity_tables.sql`           | Policy, permissions, tenants, identity schema, and runtime identity tables.                                                          |
| `004_core_integrations_users_tables.sql`        | Integrations, users, passkeys, custom fields, and external providers.                                                                |
| `005_core_indexes_and_log_objects.sql`          | Indexes, logs, imports, exports, object catalog, and operational storage.                                                            |
| `006_core_extended_operations.sql`              | Webhooks, flows, SAML, CIBA, alerts, setup tokens, and runtime support tables.                                                       |
| `007_tenant_lifecycle_state.sql`                | Tenant lifecycle state.                                                                                                              |
| `008_unified_identity_canonical_schema.sql`     | Unified identity canonical schema.                                                                                                   |
| `009_custom_claim_schema_ui_metadata.sql`       | Custom claim UI metadata.                                                                                                            |
| `010_oidc_identity_mapping_selector.sql`        | OIDC identity mapping selector.                                                                                                      |
| `011_oidc_attribute_release_consent.sql`        | OIDC attribute release consent.                                                                                                      |
| `012_attribute_release_consents.sql`            | Attribute release consent records.                                                                                                   |
| `013_passkeys_canonical_user_binding.sql`       | Passkey canonical user binding.                                                                                                      |
| `014_core_identity_sessions_authenticators.sql` | Field usage bindings, session revocation epochs, passkey AAGUID display metadata, and TOTP credentials.                              |
| `015_core_consent_screens_scopes.sql`           | Consent policy, consent records, screen profiles, OIDC scopes, and consent canonical user IDs.                                       |
| `016_core_directory_auth.sql`                   | Directory identity links, connector fleet, directory-auth migration/compliance tables, release channels, and object catalog classes. |
| `017_core_flow_runtime.sql`                     | Flow runtime contract, interaction context, templates, and unique assignments.                                                       |
| `018_repair_device_code_client_foreign_key.sql` | Repairs tenant-scoped device-code client foreign keys.                                                                               |
| `019_vc_verification_evidence.sql`              | Adds minimized VC verification evidence, freshness/invalidation metadata, and the VC attribute scope.                                |
| `020_flow_assignment_credential_profiles.sql`   | Extends Flow assignments with credential-profile targets without modifying the applied Flow baseline.                                |
| `021_remove_legacy_ai_grants.sql`               | Removes the unenforced legacy core AI Grant table; Admin Agent grants move to DB_ADMIN.                                              |
| `022_oauth_client_jarm_metadata.sql`            | Adds RFC 9102 JARM signing and encryption preferences to tenant-scoped OAuth clients.                                                |
| `023_oauth_client_auth_signing_algorithm.sql`   | Adds the RFC 7523 private-key JWT signing preference to tenant-scoped OAuth clients.                                                 |
| `024_external_provider_session_sid.sql`         | Adds upstream provider session identifiers for federated logout.                                                                     |
| `025_agent_access_self_service_clients.sql`     | Adds self-service OAuth client metadata for Agent access.                                                                            |
| `026_oauth_client_tls_certificate_binding.sql`  | Adds OAuth client mutual-TLS certificate binding metadata.                                                                           |
| `029_account_page_customization.sql`            | Adds account page customization settings.                                                                                            |
| `030_saml_sp_oidc_rp_flow.sql`                  | Adds a published, unassigned no-consent Login Flow for SAML SP and OIDC RP requests.                                                 |

## Current Admin Files

| File                                                 | Category                                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001_admin_users_rbac_security.sql`                  | Admin users, sessions, passkeys, RBAC, audit, and security controls.                                                                                    |
| `002_admin_policy_relationships.sql`                 | Admin ABAC/ReBAC, setup tokens, role inheritance, and relationship definitions.                                                                         |
| `003_admin_workflows_infrastructure.sql`             | Audit indexes, object catalog, approvals, storage resources, role templates, machine access, and role assignment normalization.                         |
| `004_admin_tenant_runtime_jobs.sql`                  | External token refresh, tenant database registry/statistics, discovery/runtime registry, notifications, migration jobs, admin jobs, and database slots. |
| `005_admin_logging_storage.sql`                      | Logging storage foundation.                                                                                                                             |
| `006_admin_logging_jobs_roles.sql`                   | Logging message jobs and system role canonicalization.                                                                                                  |
| `007_identity_mapping_control_plane.sql`             | Identity mapping, source profiles, destination profiles, and field catalog metadata.                                                                    |
| `008_persistent_identifier_profiles.sql`             | Persistent identifier profiles and values.                                                                                                              |
| `009_directory_auth_object_catalog_classes.sql`      | Directory-auth object catalog classes.                                                                                                                  |
| `010_repair_approval_object_catalog_foreign_key.sql` | Repairs approval foreign keys after the object catalog rebuild.                                                                                         |
| `011_vc_credential_profiles.sql`                     | Adds versioned Credential Profiles that pin VC flows and field mappings.                                                                                |
| `012_agent_access_control_plane.sql`                 | Adds Admin Agent grants, consent, elevation and target execution recovery, refresh-family revocation, and Agent audit fields.                           |
| `013_agent_elevation_approval_link.sql`              | Binds operation-scoped Agent elevation challenges to the existing Approval/CIBA workflow.                                                               |
| `014_agent_configuration_copilot.sql`                | Adds versioned Task Sets, Scope Policies, immutable configuration Plans, confirmations, and opaque secret references.                                   |
| `015_agent_bulk_baseline.sql`                        | Adds immutable multi-tenant Bulk Plans, tenant child executions, templates, baselines, assignments, and exceptions.                                     |
| `016_agent_bulk_capability_binding.sql`              | Binds Bulk Plans and tenant child capabilities to authenticated Agent context and immutable source versions.                                            |
| `017_require_versioned_agent_grant_snapshots.sql`    | Suspends legacy Agent Grants without complete versioned Task Set and Scope Policy snapshots.                                                            |
| `018_agent_token_family_revocation_owner.sql`        | Adds the refresh-family revocation outbox ownership locator.                                                                                            |
| `019_split_agent_user_data_task_set.sql`             | Removes user-data Tools from general built-in Task Sets by suspending v3 Grants before the v4 cut-over.                                                 |
| `020_agent_access_system_managed_objects.sql`        | Adds system-managed Agent access objects.                                                                                                               |
| `021_admin_agent_login_handoffs.sql`                 | Adds Admin Agent login handoff state.                                                                                                                   |
| `022_admin_agent_derived_session_target.sql`         | Binds derived Admin Agent sessions to their target.                                                                                                     |
| `023_admin_invitations.sql`                          | Adds one-time Admin Passkey enrollment invitations with optional per-invitation IP restrictions.                                                        |
| `024_agent_discovery_profile_task_set.sql`           | Suspends v4 built-in Agent Grants and queues token-family revocation before the Discovery Profile-aware v5 cut-over.                                    |
| `025_agent_mcp_session_registry.sql`                 | Adds the Admin Agent MCP session registry used for explicit session lifecycle and policy enforcement.                                                   |

## Current PII Files

| File                                  | Category                                                         |
| ------------------------------------- | ---------------------------------------------------------------- |
| `001_pii_schema.sql`                  | D1 PII baseline and cleanup from earlier mixed-database layouts. |
| `002_linked_identity_oidc_fields.sql` | Adds OIDC token and profile metadata to linked identities.       |

## Current External PostgreSQL Files

| File                                                   | Category                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `001_external_durable_core.sql`                        | External durable core schema.                                                                           |
| `002_external_durable_pii.sql`                         | External durable PII schema.                                                                            |
| `003_external_consent_screens_scopes.sql`              | Consent audit snapshots, consent records, screen profiles, OIDC scopes, and consent canonical user IDs. |
| `004_external_passkeys.sql`                            | Passkey AAGUID display metadata.                                                                        |
| `005_external_directory_auth.sql`                      | Directory identity links, connector fleet, and release channel metadata.                                |
| `006_external_flow_runtime.sql`                        | Flow runtime contract, interaction context, templates, and unique assignments.                          |
| `007_external_totp_credentials.sql`                    | TOTP credentials and backup codes.                                                                      |
| `008_external_vc_verification_evidence.sql`            | Adds VC verification evidence, freshness metadata, and the VC attribute scope for external PostgreSQL.  |
| `009_external_flow_assignment_credential_profiles.sql` | Extends external PostgreSQL Flow assignments with credential-profile targets.                           |
| `010_external_linked_identity_oidc_fields.sql`         | Adds OIDC token and profile metadata to linked identities.                                              |
| `011_external_provider_session_sid.sql`                | Adds upstream provider session identifiers for external PostgreSQL.                                     |
| `014_external_account_page_customization.sql`          | Adds PostgreSQL parity for account page customization settings.                                         |
| `015_external_saml_sp_oidc_rp_flow.sql`                | Adds PostgreSQL parity for the SAML SP/OIDC RP Login Flow preset.                                       |

## Commands

```bash
# Apply D1 migrations for an environment through the setup migration runner
DEPLOY_ENV=test node scripts/ci-run-migrations.mjs

# Inspect migration status through setup package helpers
pnpm --filter @authrim/setup test -- src/__tests__/cloudflare-migration-status.test.ts
```

Applied migration files are immutable because the setup runner verifies their
recorded checksums. Add a new sequential migration for every schema change,
including preview environments and consolidated baseline corrections.

## Release-coupled schema updates

`migrations/release-manifest.draft.json` is the cumulative development view of every logical schema
stream. It records exact paths and dialect-rendered checksums for D1 core, D1 PII, D1 Admin, external
PostgreSQL core, and external PostgreSQL PII migrations. `pnpm migrate:create` refreshes the draft
automatically, and the root typecheck gate runs `pnpm migrate:manifest:check` so manually added or
edited SQL cannot be forgotten. Once `releases/<version>.json` exists, that product version is closed:
bump the root/workspace versions before creating another migration. A same-version draft that differs
from its published manifest is rejected instead of being selected silently. Draft generation and
manifest checks also reject a root product version older than the latest published release.

Before a release, preview consolidation without changing files:

```bash
pnpm release:migrations -- --version 1.1.0 --minimum-version 1.0.0
```

When adopting this workflow for a repository that already has releases, create the non-destructive
baseline manifest from the last published tag once:

```bash
pnpm release:migrations:baseline -- --version 0.3.3 --git-ref v0.3.3 --write
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
