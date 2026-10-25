# Statement consent storage rollout safeguards

This change adds compatibility tests and rollout requirements. It does not move consent data,
change storage authority, introduce an account-storage mode, or complete the storage split.
There is no new production factory, setting, schema, migration, background job, copy cursor,
queue producer, cleanup task, or activation switch.

The current statement consent definitions, versions, policies and localizations remain in tenant
metadata. Existing callers keep their current record and history adapters. This preserves current
behavior; it does not imply that every existing caller already uses the intended account owner.
Existing grant, withdrawal, statement DELETE, retention and API permissions are unchanged.

## Compatibility boundary

The D1 `user_consent_records` table retains its statement and version foreign keys, all 20 columns,
primary-key nullability, tenant/user/statement uniqueness, and its five explicit indexes. Its two
automatic constraint indexes also remain. The PostgreSQL declaration has the same 20 logical
columns and uniqueness but already lacks these two definition foreign keys and has different
indexes. No PostgreSQL FK-removal migration is needed merely to match D1.

The permanent D1 regression uses the existing screen helper, Management DELETE handler and
decision producer with foreign keys enabled. A normal grant succeeds and preserves its retention
snapshot. After the actual statement DELETE completes, a delayed grant using the previously
obtained screen targets is rejected, leaving no new record, history or logical orphan. This is a
SQLite-backed D1 schema/handler test, not a deployed D1, authenticated browser or PostgreSQL test.

Flow `consent_records` continue to use metadata, including their existing timestamp, supersession
and release behavior. OAuth client consent, withdrawal generation and token/session revocation are
separate contracts and are not moved by this work. Existing consent dataset classifications,
retention and restore/discard policies remain unchanged.

## Conditions for a later storage split

- Prepare every statement writer and maintenance path, atomic record/history transitions, stable
  operation evidence, fresh definition/owner checks and withdrawal generations before activation.
- Enforce the boundary against old unconditional SQL, including old in-flight and rollback writers.
  Participating-writer admission, a lease, a completed deployment or backup admission alone cannot
  provide this enforcement. Validate the database enforcement or an equivalent cutover barrier and
  an enforced rollback floor while the legacy mode still operates.
- Only then consider a forward D1 rebuild that removes the two foreign keys. Preserve all columns,
  evidence, constraints and indexes, fail closed for unexpected schema objects, verify rollback and
  final constraints, and update the restore FK inventory in the same change. Never rewrite a
  published baseline or migration to perform this transition.
- Inventory both metadata and actual account owners. Use bounded durable copy with fixed physical
  ownership and primary confirmation before switching reads. Keep conflicting or unresolved data
  blocked and preserved; do not guess an owner, dual-write, or fall back after a failed account read.
- Protect backup and restore after the switch for as long as legacy copies remain. Authority and
  withdrawal evidence are required even when optional history is not selected. Validate authoritative
  export selection and restore re-binding, or refuse the affected backup boundary. Do not restore an
  unfinished migration as live work.
- Close statement deletion and new-grant races across every relevant physical store, including
  old permits, route changes and newly assigned shards. Remove legacy source copies only in a later
  bounded operation after migration, retention, restore and rollback evidence has been verified.

These conditions are requirements for future implementation. The compatibility tests do not claim
that replacement enforcement, distributed migration, external PostgreSQL execution or live rollout
has been implemented or validated.
