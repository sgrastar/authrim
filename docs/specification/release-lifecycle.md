---
project: Authrim
lang: en
date: 2026-07-21
description: 'Normative release, schema, topology, and deployment lifecycle for setup-managed environments.'
type: specification
tags:
  - authrim
  - release
  - migration
  - database
  - deployment
---

# Release lifecycle specification

## Purpose

This document defines the rules that bind an Authrim product release to every physical database and
Worker deployment in a setup-managed environment. It is normative for the setup CLI, setup Web API,
repository deployment scripts, and future automation.

The implementation must fail closed. A convenience entry point may not publish a Worker, change a
database topology, or replace environment metadata unless the operation is permitted by this model.

## Environment lifecycle

The lifecycle is derived from the environment lock file. Callers must not infer it independently.

| State          | Lock condition                                                                       | Meaning                                                              |
| -------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `absent`       | No lock file                                                                         | The environment has not been provisioned.                            |
| `provisioned`  | No `productVersion` and no recorded Workers                                          | Resources may exist, but no release is installed.                    |
| `legacy`       | Workers exist, but `productVersion` is absent                                        | A pre-lifecycle deployment must be reconciled by `update`.           |
| `updating`     | `releaseUpdate.phase` is not `verified`                                              | A schema-first release operation is incomplete and must be resumed.  |
| `deployed`     | `productVersion` exists and the release state is verified or predates explicit state | A complete product release is installed.                             |
| `inconsistent` | Recorded release state contradicts itself                                            | Only a full `release_update` reconciliation or deletion may proceed. |

`releaseUpdate.phase = verified` is historical evidence for the installed release. A later operation
must not clear it or replace the lock with a newly created lock.

`topologyUpdate.phase = config_staged | preparing | pending_deploy` is an orthogonal, durable
substate of `deployed`. It records the dedicated operation kind, installed product version, canonical
configuration checksum, start/update timestamps, and a hashed Web authorization token. While present,
only deletion or the matching `topology_change` resume may mutate the environment. A successful,
readiness-verified Worker deployment clears it; any failure preserves it for deterministic retry.

## Operation model

Every mutating entry point must declare exactly one operation kind and use the shared policy evaluator.

| Operation             | Allowed lifecycle                                            | Product-version rule                          | Required behavior                                                                                                                                       |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provision`           | `absent`                                                     | None                                          | Create resources and the first lock. Refuse an existing lock.                                                                                           |
| `initial_deploy`      | `provisioned`                                                | Target checkout version                       | Apply the exact release schema to every target before publishing any Worker; deploy the complete enabled release; verify; then record `productVersion`. |
| `release_update`      | `deployed`, `legacy`, resumable `updating`, `inconsistent`   | Target must be a supported forward release    | Resolve all targets, apply/acknowledge schemas, deploy Workers, verify, and commit the release state.                                                   |
| `worker_redeploy`     | `deployed`                                                   | Installed version must equal checkout version | Redeploy only; it may not create an initial or product-version transition.                                                                              |
| `topology_change`     | `deployed`                                                   | Installed version must equal checkout version | Provision targets, apply the installed release's cumulative schema, record target state, then publish affected bindings.                                |
| `manual_migration`    | `deployed`                                                   | Installed version must equal checkout version | Apply only files from the installed immutable manifest. A full stream application may update target state; a partial selection may not.                 |
| `config_mutation`     | `absent`, `provisioned`, `deployed`                          | A deployed environment must equal checkout    | Non-topology configuration may change. Database topology changes require `topology_change`.                                                             |
| `structure_migration` | Existing state with no incomplete release/topology operation | None                                          | Move legacy local environment files to the current layout without changing their semantic contents.                                                     |
| `delete`              | Any existing state                                           | None                                          | Exclusively delete the environment. This is also allowed for recovery from an incomplete update.                                                        |

Direct API/UI Worker scripts are `worker_redeploy` operations. Tenant D1 provisioning, pool expansion,
external database registration, and R2 binding changes are `topology_change` operations. A tenant D1
slot reset is a `manual_migration` recovery operation because it reapplies the installed release to
existing bindings and does not change Worker topology. A route name or UI workflow does not change
these rules.

Before its first externally visible mutation can affect a later deployment, a topology command must
persist a `preparing` journal. A topology change that replaces `config.json` must first durably write a
sidecar candidate, then persist a `config_staged` journal containing its checksum, atomically rename the
candidate over the active configuration, and finally advance the journal to `pending_deploy`. A restart
at either side of the rename must resume from the checksum-pinned candidate or active configuration.
Before releasing the exclusive preparation lock, the command must therefore persist its final config,
schema/resource evidence, and `topologyUpdate` journal atomically from the perspective of subsequent
commands with phase `pending_deploy`. The delegated deployment must require that phase and verify its
product version and config checksum. Rerunning the same dedicated command resumes the journal without
allocating another slot or database generation. An unrelated topology command, generic deploy, config
mutation, or release update must fail closed until the journal is completed or the environment is
deleted.

## Exclusive environment operations

All mutating operations must acquire the same filesystem-backed environment operation lock before the
first external or local mutation and release it in `finally`. This lock coordinates separate CLI and
Web processes; an in-process mutex is not sufficient.

After acquiring the lock, an operation that planned from an existing lock must reload it and reject a
changed snapshot. Configuration-dependent operations must also reload or checksum the configuration
when a concurrent configuration change could invalidate their plan.

The exclusive section includes Cloudflare resource creation/deletion, migration execution, Worker
deployment, configuration or lock writes, and readiness verification. An orchestration command may
release the lock only before delegating to another command that acquires the same lock.

## Schema target model

A schema target is a physical database plus one logical migration stream. Target IDs must remain stable
across runs. Two streams in one physical database are two target IDs; two shards using one stream are
also two target IDs.

The target inventory includes:

- shared core, PII, and Admin D1 databases;
- the PII stream in the shared database for single-DB deployments;
- every setup-managed tenant D1 binding in the lock, including `_S<n>` shards;
- every external database referenced by any deployable seeded storage or audit profile, not only the
  environment default profile;
- explicit future targets added to the setup-managed inventory.

Runtime-created profiles that are not represented in setup configuration or lock inventory are outside
automatic discovery. They must be registered with setup before a tenant can activate them. Activation
without a registered release target must fail closed.

External PostgreSQL core and PII streams are operator-applied until setup has credentials for a direct
executor. MySQL and external roles without a published stream remain hard-blocked. An acknowledgement
cannot bypass a missing stream.

## Per-target schema state

After a complete stream is applied or explicitly acknowledged, `schemaTargets[targetId]` must record:

- product version;
- release manifest checksum;
- stream ID;
- exact file paths and checksums;
- whether setup or an operator applied it;
- update timestamp.

The record must be written for databases created between product releases, including tenant database
provisioning, pool expansion, slot reset, and reconciliation. A future update uses the per-target record
to choose a delta. A target without a trustworthy record receives the cumulative target stream.

No operation may mark a target current merely because a migration command returned successfully for a
different target or a partial file selection.

## Deployment completion

A deployment is complete only when all of the following hold:

1. the Cloudflare deployment reports success and traffic is committed where applicable;
2. the deployed version is visible through the Cloudflare deployment API;
3. an HTTP readiness check passes when the Worker has a reachable health or entry URL;
4. the lock is updated without discarding concurrent or historical release state.

These rules apply equally to full, bulk-update, and individual component paths. Readiness failure must
return failure even if upload or traffic promotion succeeded; the lock may retain committed deployment
evidence so a retry can reconcile it.

## Configuration and provisioning safety

Provisioning must refuse an existing lock. It must never recreate a lock for an existing environment,
and it only creates resources and initial metadata. It must not apply any database migration; initial
schema application belongs exclusively to the complete `initial_deploy` operation.

For a deployed environment, generic configuration saving must reject changes to schema topology fields,
including storage/audit profiles, Hyperdrive references, D1 layout, and tenant D1 capacity. Dedicated
topology operations perform those changes under the installed release manifest. Non-topology settings
may be saved under the environment lock when no release update is in progress.

## Required entry-point coverage

The policy and exclusive lock apply to:

- setup CLI deploy, update, delete, tenant DB, pool, slot reset, R2, and migration commands;
- setup Web provision, deploy, Worker update, individual component, Service Site, email deployment,
  configuration, tenant pool, R2, migration, and environment deletion routes;
- repository API/UI deployment and migration scripts;
- future automation that writes environment config, lock state, Cloudflare resources, schemas, or
  Workers.

## Test requirements

The implementation must include behavior tests, not source-text presence checks.

### Policy decision table

- Every operation kind against `absent`, `provisioned`, `legacy`, `updating`, `deployed same version`,
  and `deployed different version`.
- Inconsistent and unknown Worker-version states fail closed.

### Entry-point contract tests

- Initial state rejects bulk Worker update, individual API/UI deploy, Service Site deploy, email deploy,
  and direct deployment scripts.
- Existing environments reject provisioning without changing lock/config files.
- Product upgrades reject every path except `release_update`.
- Incomplete updates reject redeploy, migration, topology, and config operations but allow resume/delete.

### Exclusivity tests

- A held operation lock rejects Web and CLI mutations for the same environment.
- Different environments can mutate independently.
- Exceptions release the operation lock.
- Delete cannot race update, migration, or deployment.

### Topology and schema-state tests

- Shared D1, single D1, tenant D1, shard D1, external default profile, and tenant-selectable seeded
  external profile targets are enumerated.
- Newly provisioned, expanded, reset, and reconciled D1 targets record the installed manifest.
- A new target gets the cumulative stream; an existing target gets only its delta.
- Partial migrations do not mark a full stream current.
- Missing MySQL/audit streams and unregistered runtime targets fail closed.
- Interrupted topology deployments persist their journal, reject unrelated mutations, and resume the
  exact recorded config without allocating duplicate resources.

### Deployment completion tests

- Individual API and UI deployment waits for visibility.
- Reachable Workers wait for HTTP readiness.
- Visibility/HTTP failure returns failure and does not report the operation complete.

## Release gate

Before publishing a product release, the setup package tests, lint, typecheck, monorepo typecheck,
release-manifest validation, and the policy/entry-point/topology matrices above must pass. Passing unit
tests alone is not evidence that all mutation entry points obey this specification.
