# Tenant backup import: cleanup after a cancel or a permanent failure

A tenant DR import writes into an unpublished `provisioning` tenant. When such an import is
cancelled, or stops for good (`backup_sqlite_row_too_large` and the other permanent failures),
the cleanup either leaves the tenant as it was or **discards** it. This page describes what each
outcome leaves behind, how to read the cleanup's state, and what to do when it stops.

## When an import can be cancelled

Cancelling, and the automatic cleanup after a permanent failure, are accepted only while the
import has written nothing but its SQL restore targets: from `prepare` up to and including
`advance_restore_dataset`. From `restore_other_stores` on, the import also writes KV, R2, Durable
Objects and keys, and later activates the tenant. A cancel there, or on a `ready` import, is
refused with `409 backup_operation_conflict`; such an import is left to finish or to wait.

## What the cleanup decides

The cleanup first waits about 3.5 minutes after it first sees the operation, so every restore
worker that held a lease before the cancel has stopped. Then it records one decision in
`tenant_backup_import_discards` (Admin database):

- `none`: no restore target was opened, so nothing was written. The tenant stays
  `provisioning` exactly as setup left it; nothing is deleted. A later import can start.
- `discard`: the import wrote at least one restore target. The restored tenant is discarded.

## What a discard deletes and keeps

Rows are chosen only by the reviewed ownership of each table (tenant column, tenant key, scope or
parent row), never by values from the backup bundle. It covers every database assigned to the
tenant (its core and PII databases and the shared Admin database).

Deleted: the tenant's rows in every installed SQL dataset table and in the derived core/PII tables
(sessions, tokens, dynamic-group state, lookup indexes, outboxes), plus the tenant's KV copies:
its settings keys (`settings:tenant:<id>:` and `settings:client:<id>:`), its contract and
tenant-exists cache entries.

Kept:

- **The tenant row.** It is marked `lifecycle_state='deleted'` in both the platform and the core
  database; it is not deleted.
- **Audit and log rows**: every dataset of kind `audit`, `history`, `sensitive_logs`,
  `delivery_state` and `log_dependencies`, and the object catalog (`artifacts`) that stores
  externalized audit details. The import's own request, approval and cancellation audit entries
  are among them.
- `core.plugin_account_metadata_mutations` (a ledger the database forbids deleting).
- Backup records (`tenant_backup_*`, including restored holds and admin mappings) and the
  receipts of the restore targets, which stay `invalid`.
- Admin database rows outside the backup datasets (database registry, provisioning records,
  sessions). The normal tenant deletion does not accept a `deleted` tenant today; reclaiming them
  is a separate task.

A kept log row that refers to a deleted row by foreign key follows that key's `ON DELETE`
action: `CASCADE` deletes it (for example a restored user's consent history), `SET NULL` clears
the reference. A `RESTRICT` or `NO ACTION` reference stops the cleanup instead (see below).

After the tables are empty the cleanup marks the tenant deleted, deletes the KV copies, and waits
17 minutes (the longest scheduled run plus the time a KV listing takes to show a new key) before
a final KV sweep, because a settings projection that read a document before it was deleted may
still write its key until then.

## Reading the state

`GET /api/admin/tenant-backups/{operationId}` returns `discard`:

```json
{ "decision": "discard", "blocker": { "kind": "legal_hold", "detail": { "holdIds": ["…"], "restoredHolds": 1, "bundleHoldIds": ["…"], "bundleHolds": 2 } } }
```

While a blocker is set the operation stays `cancelling` and is retried with backoff. Watch
`discard.blocker`, not `lastErrorCode`: the operation records every failed attempt as
`backup_operation_slice_failed`. The failure code in the table below appears in the scheduled
run's `failureCodes` log. The same record is in `tenant_backup_import_discards` (`decision`,
`blocker_kind`, `blocker_json`).

## When the cleanup stops

| Failure code | Blocker | Meaning | What to do |
| --- | --- | --- | --- |
| `backup_import_cleanup_legal_hold` | `legal_hold` | The restored data has legal holds (`restoredHolds`, first IDs in `holdIds`) or the bundle carries some not restored yet (`bundleHolds`, first IDs in `bundleHoldIds`). Nothing was deleted. | See below. This blocker never clears by itself. |
| `backup_import_cleanup_blocked` | `blocked_rows` | A row of `table` in `resourceId` could not be deleted: another tenant's row (or a row of unknown owner) refers to it with `CASCADE`/`SET NULL`, or a kept row restricts it. Rows deleted before it stay deleted; nothing of another tenant changed. | Find the referencing row (`PRAGMA foreign_key_list` of the referencing tables). Decide with the owner of that row; once the reference is gone the next scheduled run continues. |
| `backup_import_cleanup_schema_changed` | `schema_changed` | The database schema of `resourceId` changed after the decision (a migration ran). Every delete also checks the schema itself, so nothing was deleted against the new schema. | Do not deploy while an import cleanup runs. The cleanup continues once the schema matches the recorded one again; otherwise contact engineering, since the discard plan has to be reviewed against the new schema. |
| `backup_import_discard_tenant_published` | — | The tenant is no longer `provisioning` (or `deleted`). | The cleanup never touches a published tenant. Investigate how it was activated. |

### Legal holds

A legal hold cannot be released by deleting it: the database forbids deleting holds and their
events, and an account with an active hold cannot be deleted. The cleanup therefore never deletes
anything of such an import.

1. Read `holdIds` (restored holds in the target, up to five) and `bundleHoldIds` (holds in the
   backup that were not restored yet, up to five; `bundleHolds` is their number). The complete
   list of a tenant's holds is in the source environment.
2. Decide with whoever owns the hold (legal / compliance) whether the restored data must be kept.
3. Keep the target as it is: the tenant stays `provisioning` and unpublished, and the operation
   stays `cancelling`. Discarding the environment is the way to remove it entirely, for example by
   setting up a fresh restore environment; that is an operator decision, not something the
   cleanup does.

## Operating notes

- Do not deploy migrations while an import cleanup is running; the cleanup checks the schema
  before and after every step and stops on a change.
- The shared Admin database keeps one restore receipt per tenant, so another tenant can still be
  imported into the same environment after a discard. A dedicated core or PII database still
  accepts a single restore in its lifetime.
