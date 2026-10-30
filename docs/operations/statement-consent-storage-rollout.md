# Statement consent storage rollout safeguards

Definitions belong to tenant metadata; records, history, key states and operation receipts belong to
physical account stores. Flow `consent_records` and OAuth client consent retain their separate
contracts. DSQL statement-consent writes remain unsupported and fail closed. Definition-read login
handling and omitted optional decisions are unchanged.

## Release boundary and deployment order

Core D1 037 removes the two definition foreign keys from `user_consent_records` and installs step-B
triggers **after** rebuilding that table. PostgreSQL 020 installs matching functions/triggers without
a rebuild. D1 preserves all 21 columns, NOT NULL/default/unique constraints, rowids, five explicit
indexes and two automatic constraint indexes. Preflight rejects unexpected table/index definitions,
triggers, views, incoming foreign keys or existing foreign-key violations. Copy verification compares
counts and every value including the primary key before DROP. Apply the whole migration in one
transaction; a statement-by-statement nontransactional SQL loop is unsupported.

This is one full `release_update`, with the compatible Worker and migrations in the same release.
The draft manifest's `rollout` is `setup_then_control`, `after_required_databases`, Admin `read_only`,
and **has no `databaseOnly` allow-list**. A database-only deployment is prohibited.

1. Inventory every metadata and physical account Core store and pin the release artifact. Confirm
   backups, a tested restore route and the rollback floor. No routed consent data needs relocation;
   this release includes neither a relocation job nor legacy-copy cleanup.
2. Stop all mutation admission and drain in-flight work through the environment's release procedure:
   authentication, Management, provisioning, scheduled jobs, queued retries and restores. Admin
   read-only mode alone does not stop all these writers. Exclude old Worker versions and retries.
3. Apply D1 037 / PostgreSQL 020 to all required stores through setup/Control's manifest-aware
   rollout. Check the migration history/sentinel and physical-store inventory. Keep writes stopped
   if any target is missing, ambiguous or failed; do not activate schema-dependent Workers early.
4. Deploy the complete compatible Worker release. Verify readiness, generation projection on all
   account stores, repeated consent/withdrawal, and bounded retention under installed triggers.
   Only then record the release as complete and resume mutation admission.

Use `pnpm migrate:create <name> --stream core-d1|core-postgresql` for new files, followed by
`pnpm migrate:manifest` and `pnpm migrate:manifest:check`. Never edit published SQL. The generator
preserves the explicit rollout policy, including the absence of `databaseOnly`. A sandbox failure
at IPC or remote-tag verification is **not** a successful manifest check; the release owner must
complete it in an environment with the required access before publishing.

## Writer and retention enforcement

BEFORE INSERT guards continue to forbid overwriting an existing guard/key/operation/admission.
Bootstrap uses `INSERT ... SELECT ... WHERE NOT EXISTS`, then validates a primary reread. A lost
acknowledgement or concurrent creator can recover only from a matching row. Generation projection
co-commits identity-matched, monotone UPDATE followed by absent-row INSERT; a stale generation or
identity conflict fails and leaves durable work pending. PostgreSQL ordinary batches are transactional;
projection locks only the statement row, while transitions lock tenant, statement, then key. It never
holds a key or statement lock and then requests a tenant lock.

Ordinary evidence DELETE remains forbidden while a tenant guard is enforced or closed. The retention
job creates row-specific, immutable permits bound to tenant, user, statement, row kind/id and the
current account/physical/restore identity. It deletes and removes permits in the same transaction.
The trigger independently checks the permit lifetime, a cutoff no later than database time, current
terminal record status, strictly elapsed retention, and granted-record history protection. Snapshot
NULL deadlines remain unlimited. Only legacy rows use freshly read metadata retention days; unknown
policy retains them. Permits are rebuild state, excluded from portable authority. Key states remain
as replay fences after evidence retention. A failed or ambiguous page stays pending and can be retried.

## Disaster recovery and rebinding

Keep restore targets unpublished through rebinding and sealing. Keep serving and mutation admission
stopped through the subsequent projection and reference audit. Preserve logical record, user, statement and version IDs. Portable source guards and
projection jobs are excluded; source admissions and `executing` operations stay encrypted holds.

The SQLite `tenant-portability` restore path binds imported key states and terminal operations to
`physical_id = resourceId` from the pinned provisioning receipt, `restore_epoch = operationId` from
the fenced import, and `account_id = restore:<resourceId>`. Rebinding occurs before INSERT and during
every retry/readback, so resumed verification expects the same target identity. Terminal operation
insertion requires the target's live loading lease and that exact binding; it cannot import executing
work or replace an existing receipt. Source payload hashes remain evidence and cannot authenticate a
new target operation. At seal, fresh durable projection jobs are enqueued from restored definition generations (source job
cursors are excluded), and the tenant guard is rebuilt with that binding and every imported atomic
row's identity is checked. Source-bound or mismatched authority prevents sealing.

The direct PostgreSQL importer applies the same column transformation in its isolated transaction,
using its unique staging target ID for physical identity and restore epoch. A transaction-local
restore context admits only terminal receipts, without disabling any consent trigger. Nonempty
source guards/admissions remain unsupported. Because this importer has no encrypted hold store,
unfinished source operations reject the import and roll back. It rebuilds the tenant guard and enqueues fresh metadata projection work before
committing staging evidence. No source execution is replayed.

After sealing, direct maintenance to the restored stores under the mutation stop fence, rebuild
statement guards from trusted metadata generations with the durable projection job, and finish the
read-only reference audit. Confirm no unresolved references, wrong bindings or
unfinished authority before serving traffic/resuming writes. Rebinding, projection or audit
failure keeps the target stopped. Do not make a raw database clone with copied guards serve traffic;
normal writers cannot discover that such a copied guard belongs to a different physical database.

Empty restores create no consent guard. Generic tenant-row discard refuses nonempty consent
identity/replay tables before deleting any dataset; it cannot remove these immutable fences or use
rowid cleanup on WITHOUT ROWID tables. Discard a dedicated unpublished target through provider
resource deletion. Shared-target row discard with consent authority is unsupported and stays blocked.

The existing restriction remains: one restore target database per role. Restore into multiple users
shards and generic tenant-placement migration of enforced consent state are unsupported. Never remove
triggers or guard/key fences to finish a restore, placement move or rollback.

## Rollback and verification limits

There is no down migration or safe rollback to pre-037/020 writers. Removing triggers, lowering guards
or reattaching cross-database foreign keys loses guarantees or fails on valid separated records. On
failure keep mutation admission stopped and use forward repair or a verified backup restore with new
identity rebinding, projection and audit. Retain failure evidence and all original backups.

Local tests cover empty and 25,000-row SQLite rebuilds, unexpected schema/constraint failures,
rollback after DROP, real writer/projection entry points, retention and restore retries. Deployed D1
fleet timing and PostgreSQL triggers, functions, locks and restore SQL require deployment-specific
validation. **PostgreSQL was statically reviewed only and not executed in this environment.** Run the
explicit disposable PostgreSQL suite in `statement-consent-atomic-foundation.md` before PG rollout.

## 0.5.0 release note summary

Statement-consent definitions and user evidence can live in separate databases. D1 definition foreign
keys are replaced with generation-guarded atomic enforcement; retention has a guarded expiry-only
path, and restore explicitly rebinds evidence to its new database without resuming source operations.
Deploy the migrations and compatible Workers as one release. Database-only updates and rollback to
older consent writers are unsupported.
