---
project: Authrim
lang: en
date: 2026-08-16
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

Direct API/UI Worker scripts are `worker_redeploy` operations. Initial assignment bootstrap, Control
Worker shard provisioning, external database registration, and R2 binding changes are
`topology_change` operations. Reapplying a pinned release to an existing target is a
`manual_migration` recovery operation and does not change Worker topology. A route name or UI
workflow does not change these rules.

## Release update ownership

Authrim exposes one release update operation to the operator. The operator must not have to choose
whether setup or Control applies a database migration. Setup owns the release decision and delegates
work according to database ownership:

- setup applies bootstrap-critical and fixed platform databases that Control cannot safely migrate
  itself, publishes the immutable migration release artifact, deploys Workers, verifies readiness,
  and commits the installed product version;
- Control applies the pinned artifact to databases in its durable inventory, including tenant and
  shard databases created after the previous product release;
- external databases remain operator-applied unless an authenticated executor and target inventory
  have been registered explicitly.

A Worker-only release follows the same `release_update` state machine with an empty schema delta. It
must not contact or mutate databases merely because the product version changes. A release containing
database changes performs the setup-owned database work, delegates the managed fleet to Control,
waits for every required target, and only then activates schema-dependent Workers.

Delegation is a durable handoff, not one long HTTP request. Control records an operation ID, the
pinned release and manifest digest, target inventory, per-target state, aggregate progress, retry
state, and the administrative mutation policy. Closing setup or Admin UI must not cancel the rollout.
Starting setup again resumes observation of the same operation.

Control must not update or deploy itself. When a newer coordinator is required, setup first applies a
backward-compatible Control schema expansion and deploys a Control version that can operate against
both the old and expanded schema. Destructive contraction occurs only after the managed fleet and
all Workers have crossed the compatibility boundary.

## Release manifest rollout policy

The migration release manifest carries machine-readable rollout policy in addition to checksummed SQL:

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

These values are semantic contracts, not UI route names. A manifest must not contain Admin UI paths,
component selectors, button IDs, or translated messages. Control persists the policy snapshot with
the rollout operation, and Management exposes capabilities derived from the current operation.
Admin UI renders those capabilities. This separation allows UI routes to change without changing the
meaning of a published manifest.

`adminMutationMode = read_only` keeps Admin inspection, audit, progress, logout, and explicitly
defined release-recovery operations available while rejecting schema-dependent Admin mutations.
The server must enforce the restriction; disabled controls in Admin UI are explanatory and are not a
security boundary. `available` may be used only when the release has demonstrated that Admin writes
are compatible throughout the complete mixed-schema interval.

Unknown rollout policy, contradictory status, or a target omitted from the pinned inventory must fail
closed before schema-dependent Worker activation.

`databaseOnly` is an optional, exact allow-list. Its absence prohibits database-only rollout. Setup
accepts `--database-only` only when every deployed Worker is still at the installed product version
and that exact version appears in `compatibleWorkerVersions`. A successful database-only rollout
records `database_only_verified`, retains both the Workers and installed `productVersion`, and leaves
the normal full update available. Compatibility is never inferred from schema shape or a SemVer range.

## Managed database rollout

Control must snapshot the eligible target inventory when accepting the handoff. Targets discovered
later are provisioned directly at the active release and do not silently join an existing snapshot.
Each target has a stable ID and records the database ID, stream ID, release ID, manifest digest,
attempt count, last error code, and completion evidence.

The rollout proceeds in bounded batches. A release may define an implementation-independent canary
policy, but correctness never depends on a particular batch size. A target is complete only when the
database migration history and release sentinel match the pinned artifact. Successful targets are not
reapplied after interruption. A checksum mismatch, partial supersedence, unknown commit state, or
missing target blocks the release.

Control reports at least these externally visible phases:

1. `database_rollout` — managed databases are being migrated;
2. `blocked` — at least one required target needs retry or operator action;
3. `awaiting_setup` — every delegated database is ready and setup must continue Worker deployment;
4. `verifying` — setup has deployed Workers and is completing readiness checks;
5. `completed` — databases and Workers are verified at the target version.

The installed `productVersion` does not advance while the operation is in any phase other than
`completed`.

Setup may stop actively observing after a bounded UI/CLI observation window, but this is not a rollout
failure. It returns an in-progress handoff result and later resumes the same operation ID. Control's
durable operation continues regardless of either UI process. `completed` is trustworthy only when the
operation and all three required steps succeeded and completed/total target counts agree; any
contradiction is exposed as `blocked` with a redacted `release_rollout_state_inconsistent` code.

## Admin visibility and mutation fence

After handoff, Admin UI must show the source and target versions, current phase, completed and total
database counts, last update time, and a redacted failure reason when blocked. It polls a read-only
Management endpoint backed by Control; it does not inspect setup's local lock file.

While the persisted policy restricts mutations, Management rejects covered non-read requests even if
they bypass Admin UI. Admin UI displays a persistent rollout banner and disables affected settings and
other mutation controls. The Control Plane page remains available for progress and authorized
recovery. The restriction ends only after setup records final verification, not merely when the last
database reports success.

For a blocked database target, the Control Plane page exposes a platform-admin, human-only retry for
that exact target. Management must persist the Admin audit before invoking Control. Control then
persists its own idempotent audit event and requeues only the selected blocked target. This narrowly
defined endpoint remains available through the mutation fence; similarly shaped or broader writes do
not.

Before its first externally visible mutation can affect a later deployment, a topology command must
persist a `preparing` journal. A topology change that replaces `config.json` must first durably write a
sidecar candidate, then persist a `config_staged` journal containing its checksum, atomically rename the
candidate over the active configuration, and finally advance the journal to `pending_deploy`. A restart
at either side of the rename must resume from the checksum-pinned candidate or active configuration.
Before releasing the exclusive preparation lock, the command must therefore persist its final config,
schema/resource evidence, and `topologyUpdate` journal atomically from the perspective of subsequent
commands with phase `pending_deploy`. The delegated deployment must require that phase and verify its
product version and config checksum. Rerunning the same dedicated command resumes the journal without
allocating another physical resource or database generation. An unrelated topology command, generic deploy, config
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

- fixed platform databases and initial Core/PII assignment databases;
- every setup-bootstrap or Control-managed assignment binding projected into the lock;
- every future external adapter target explicitly registered with setup and its schema evidence;
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

The record must be written for databases created between product releases, including initial tenant
bootstrap, Control shard provisioning, migration recovery, and reconciliation. A future update uses the per-target record
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
including storage/audit profiles, Hyperdrive references, and D1 layout. Dedicated setup or Control
topology operations perform those changes under the installed release manifest. Non-topology settings
may be saved under the environment lock when no release update is in progress.

## Required entry-point coverage

The policy and exclusive lock apply to:

- setup CLI deploy, update, delete, tenant DB bootstrap, R2, and migration commands;
- setup Web provision, deploy, Worker update, individual component, Service Site, email deployment,
  configuration, R2, migration, and environment deletion routes;
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

- Single- and multi-shard assignments, `shared_pool` and `tenant_exclusive` placement, and explicitly
  registered future external adapter targets are enumerated through the same target model.
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

### Delegated rollout tests

- A Worker-only release creates no database work and still reaches verified release state.
- Setup-owned database failure prevents handoff and Worker publication.
- Handoff snapshots every Control-managed target and is idempotent by environment and release.
- Closing setup does not cancel the Control operation; a later setup process resumes it.
- Bounded retries never reapply a target whose release sentinel is already ready.
- Admin progress remains readable while restricted mutations are rejected by Management.
- `awaiting_setup` does not advance the installed product version or remove the Admin mutation fence.
- Worker readiness failure preserves the operation for deterministic setup retry.

## Release gate

Before publishing a product release, the setup package tests, lint, typecheck, monorepo typecheck,
release-manifest validation, and the policy/entry-point/topology matrices above must pass. Passing unit
tests alone is not evidence that all mutation entry points obey this specification.
