---
project: Authrim
lang: en
date: 2026-07-11
description: "Database migration layout for Authrim D1 and external PostgreSQL schemas."
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

These files are consolidated for fresh Authrim installs. Current preview
releases do not guarantee in-place upgrades from older migration layouts; use a
fresh database or reinstall when moving between incompatible release snapshots.

## Layout

| Path | Target database | Notes |
| --- | --- | --- |
| `migrations/*.sql` | D1 core database | Runtime protocol, identity, consent, flow, directory auth, and end-user auth state. |
| `migrations/pii/*.sql` | D1 PII database | Personal data, linked identities, sensitive values, and PII audit rows. |
| `migrations/admin/*.sql` | D1 admin database | Admin users, RBAC, approvals, jobs, logging, storage, identity mapping, and admin object catalog. |
| `migrations/external/postgres/*.sql` | External PostgreSQL profile | Durable external core/PII schema and feature-specific PostgreSQL extensions. |

Top-level core migrations intentionally exclude the `admin`, `archive`,
`external`, and `pii` directories when the D1 core runner walks this directory.

## Current Core Files

| File | Category |
| --- | --- |
| `001_core_foundation.sql` | Tenant foundation and trust groups. |
| `002_core_protocol_and_consent.sql` | OAuth/OIDC, sessions, grants, consent baseline, and device credentials. |
| `003_core_policy_identity_tables.sql` | Policy, permissions, tenants, identity schema, and runtime identity tables. |
| `004_core_integrations_users_tables.sql` | Integrations, users, passkeys, custom fields, and external providers. |
| `005_core_indexes_and_log_objects.sql` | Indexes, logs, imports, exports, object catalog, and operational storage. |
| `006_core_extended_operations.sql` | Webhooks, flows, SAML, CIBA, alerts, setup tokens, and runtime support tables. |
| `007_tenant_lifecycle_state.sql` | Tenant lifecycle state. |
| `008_unified_identity_canonical_schema.sql` | Unified identity canonical schema. |
| `009_custom_claim_schema_ui_metadata.sql` | Custom claim UI metadata. |
| `010_oidc_identity_mapping_selector.sql` | OIDC identity mapping selector. |
| `011_oidc_attribute_release_consent.sql` | OIDC attribute release consent. |
| `012_attribute_release_consents.sql` | Attribute release consent records. |
| `013_passkeys_canonical_user_binding.sql` | Passkey canonical user binding. |
| `014_core_identity_sessions_authenticators.sql` | Field usage bindings, session revocation epochs, passkey AAGUID display metadata, and TOTP credentials. |
| `015_core_consent_screens_scopes.sql` | Consent policy, consent records, screen profiles, OIDC scopes, and consent canonical user IDs. |
| `016_core_directory_auth.sql` | Directory identity links, connector fleet, directory-auth migration/compliance tables, release channels, and object catalog classes. |
| `017_core_flow_runtime.sql` | Flow runtime contract, interaction context, templates, and unique assignments. |
| `018_repair_device_code_client_foreign_key.sql` | Repairs tenant-scoped device-code client foreign keys. |
| `019_vc_verification_evidence.sql` | Adds minimized VC verification evidence, freshness/invalidation metadata, and the VC attribute scope. |
| `020_flow_assignment_credential_profiles.sql` | Extends Flow assignments with credential-profile targets without modifying the applied Flow baseline. |

## Current Admin Files

| File | Category |
| --- | --- |
| `001_admin_users_rbac_security.sql` | Admin users, sessions, passkeys, RBAC, audit, and security controls. |
| `002_admin_policy_relationships.sql` | Admin ABAC/ReBAC, setup tokens, role inheritance, and relationship definitions. |
| `003_admin_workflows_infrastructure.sql` | Audit indexes, object catalog, approvals, storage resources, role templates, machine access, and role assignment normalization. |
| `004_admin_tenant_runtime_jobs.sql` | External token refresh, tenant database registry/statistics, discovery/runtime registry, notifications, migration jobs, admin jobs, and database slots. |
| `005_admin_logging_storage.sql` | Logging storage foundation. |
| `006_admin_logging_jobs_roles.sql` | Logging message jobs and system role canonicalization. |
| `007_identity_mapping_control_plane.sql` | Identity mapping, source profiles, destination profiles, and field catalog metadata. |
| `008_persistent_identifier_profiles.sql` | Persistent identifier profiles and values. |
| `009_directory_auth_object_catalog_classes.sql` | Directory-auth object catalog classes. |
| `010_repair_approval_object_catalog_foreign_key.sql` | Repairs approval foreign keys after the object catalog rebuild. |
| `011_vc_credential_profiles.sql` | Adds versioned Credential Profiles that pin VC flows and field mappings. |

## Current PII Files

| File | Category |
| --- | --- |
| `001_pii_schema.sql` | D1 PII baseline and cleanup from earlier mixed-database layouts. |

## Current External PostgreSQL Files

| File | Category |
| --- | --- |
| `001_external_durable_core.sql` | External durable core schema. |
| `002_external_durable_pii.sql` | External durable PII schema. |
| `003_external_consent_screens_scopes.sql` | Consent audit snapshots, consent records, screen profiles, OIDC scopes, and consent canonical user IDs. |
| `004_external_passkeys.sql` | Passkey AAGUID display metadata. |
| `005_external_directory_auth.sql` | Directory identity links, connector fleet, and release channel metadata. |
| `006_external_flow_runtime.sql` | Flow runtime contract, interaction context, templates, and unique assignments. |
| `007_external_totp_credentials.sql` | TOTP credentials and backup codes. |
| `008_external_vc_verification_evidence.sql` | Adds VC verification evidence, freshness metadata, and the VC attribute scope for external PostgreSQL. |
| `009_external_flow_assignment_credential_profiles.sql` | Extends external PostgreSQL Flow assignments with credential-profile targets. |

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
