# Mapping choice history and restore

The Admin API records changes to the tenant's default Mapping Set and an app's own
`identity_mapping` choice. It does not record or restore the contents of a Mapping Set. Restoring
an old choice still uses the set's currently usable version, unless the app's saved selector pins
a specific version.

## Inspect and restore a choice

1. Read `GET /api/admin/identity-mapping/history`. Use `tier=tenant_default` for the tenant's
   default, or `tier=client&client_id=...` for one app. Follow `next_cursor` without changing the
   filters. The default page size is 50, with a maximum of 100. A page may end earlier after 20 distinct
   target choices to bound reference checks; continue with next_cursor.
2. Select an entry whose `restorable` is true. The target is its `before` value. An unset choice
   follows the next default; an explicit `none` opts out. These are distinct states. Older unusable selectors are shown as invalid and cannot be restored.
3. Send `POST /api/admin/identity-mapping/history/{id}/restore` with `{"preview":true}`. Review
   `current`, `restores`, `later_changes`, and the apps' claim changes. The app list is bounded to
   200 apps, with at most 20 distinct selections and 20 resolved content versions across both
   sides, and later changes to 100; the corresponding
   truncation flags indicate an incomplete list.
4. After confirmation, send the preview's `expected_version` and an optional `reason` of up to
   500 characters. A successful response identifies the restored entry. The restore also creates
   a new history entry with `via: "restore"`.

Later edits to the same level produce a warning and may be overwritten after confirmation. If
the level changes after the preview, the execution returns a version conflict, including a change away from the value and back again. Preview again
before retrying. A deleted or inactive target set cannot be restored, and a choice already in
effect is not restorable. Both preview and execution recheck the target.

An unusable current choice does not prevent previewing a usable earlier choice. An app's
`before_unavailable` code identifies a missing or inactive current set, or an invalid current
Destination Profile. Its claim comparison starts from an empty mapping. Database failures still
stop the preview, and the restored choice must resolve successfully. The preview uses the
runtime's selected version and active catalog, including app-scoped activations; compiling a
draft snapshot does not change the comparison before that snapshot is activated.

The API operates within the calling tenant. Reading history requires settings read access;
reading app history also requires clients read access. A tenant-default restore uses the same
tenant settings edit authorization as settings PATCH. An app restore requires clients update
access. Previewing a tenant default also requires clients read access to show affected apps.
Agents cannot preview or execute restores. Normal authentication and authorization remain in
effect during release updates: the exact read-only preview body remains available while actual
restores are fenced.

## Confirming a change after a storage failure

Tenant settings and their history are committed in the same Admin database batch. A failed
history insert rolls back the settings change. Clearing the tenant's value records an unset
level rather than the inherited effective value. Bulk apply records the choice even when its
ordinary settings audit omits values.

An app's metadata and its history live in different databases. The update first prepares an
internal Admin history intent, then commits a version-conditional client update and a receipt
atomically in the client's metadata Core database. Only a verified receipt confirms the history.
Scheduled reconciliation can finish confirmation without repeating the client update.

A `503 temporarily_unavailable` response with `operation_id` can mean the client update committed
but history confirmation is pending. Read current state before retrying; the HTTP response alone
does not prove that the client stayed unchanged. An indeterminate result is never presented as
committed history. Unacknowledged receipts are protected from normal idempotency expiry until
their Admin history has been confirmed.

## Retention and tenant backups

Committed level history belongs to the tenant's `audit` dataset. It follows the existing Admin
audit cleanup cutoff and log archive configuration; no separate short-lived operational-log TTL
is introduced. Pending intents and internal Core receipts are not exported as audit history or
replayed after restore. The export boundary refuses a capture when a committed client change
has not yet been confirmed in Admin history, including an audit-only capture. Reconciliation
must finish before that capture can be retried.

Only committed history is eligible for archive or audit cleanup. Client history is retained until
its Core receipt has been acknowledged, even when the cleanup cutoff would otherwise remove it. The default D1-to-R2 move period
remains zero. The history API reads D1; it does not add a reader for older whole-row R2 archives.
Moving these rows to R2 therefore does not make them searchable or restorable through this API.

The schema is added by Admin migration `050_identity_mapping_level_history.sql`. Existing
environments must apply it before activating Workers that record level history.
