import type { Client } from 'pg';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { VerifiedTenantBackupV2 } from '../import/backup-reader';
import { POSTGRES_RESTORE_EXTENSION_CONTRACTS } from '../import/postgres-restore-extension-contract';
import { readVerifiedRows } from '../import/verified-rows';

function invalid(): never {
  throw new Error('aws_live_database_invalid');
}
function scalar(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') invalid();
  return String(value);
}
function integer(value: unknown): bigint {
  const text = scalar(value);
  if (text === null || !/^(?:0|[1-9][0-9]*)$/u.test(text)) invalid();
  const n = BigInt(text);
  if (n > 2n ** 63n - 1n) invalid();
  return n;
}
function value(row: PortableSqliteRow, column: string): string | null {
  const entry = row[column];
  if (!entry || !['text', 'integer', 'null'].includes(entry[0])) invalid();
  return entry[1];
}

/** Read within the same Core snapshot as the independently checked immutable account fields. */
export async function verifyActivatedLoginProjections(input: {
  backup: VerifiedTenantBackupV2;
  core: Client;
  accounts: ReadonlyMap<string, Record<string, unknown>>;
  activatedAtMs: number;
}): Promise<void> {
  const ids = new Set(input.backup.manifest.datasets.map((dataset) => dataset.id));
  const hasGroups = ids.has('core.service_group_inputs');
  const hasOutbox = ids.has('core.account_webhook_outbox');
  // Legacy 18-table receipts do not attest these optional source projections.
  if (!hasGroups && !hasOutbox) return;
  const tenantId = input.backup.manifest.source.tenantId;
  const increments = new Map<string, bigint>();
  const events = new Map<string, bigint>();
  if (hasGroups) {
    const source = await readVerifiedRows(input.backup, 'core.service_group_inputs');
    const target = await input.core.query<Record<string, unknown>>(
      'SELECT tenant_id,user_id,revision FROM service_group_inputs WHERE tenant_id=$1 LIMIT $2',
      [tenantId, source.length + 1]
    );
    if (target.rows.length !== source.length) invalid();
    const current = new Map(target.rows.map((row) => [scalar(row.user_id), row]));
    for (const row of source) {
      if (Object.keys(row).length !== 3 || value(row, 'tenant_id') !== tenantId) invalid();
      const userId = value(row, 'user_id');
      const actual = current.get(userId);
      if (!userId || !actual || increments.has(userId)) invalid();
      const difference = integer(actual.revision) - integer(value(row, 'revision'));
      if (difference < 0n) invalid();
      increments.set(userId, difference);
    }
  }
  if (hasOutbox) {
    const spec = POSTGRES_RESTORE_EXTENSION_CONTRACTS.find(
      (item) => item.datasetId === 'core.account_webhook_outbox'
    );
    if (!spec) invalid();
    const source = await readVerifiedRows(input.backup, spec.datasetId);
    const original = new Map(source.map((row) => [value(row, 'id'), row]));
    if (original.size !== source.length) invalid();
    // A generation is bounded. Exhaustion requires a new snapshot; never silently omit tail rows.
    const target = await input.core.query<Record<string, unknown>>(
      `SELECT ${spec.columns.map((column) => `"${column}"`).join(',')} FROM account_webhook_outbox WHERE tenant_id=$1 LIMIT 100001`,
      [tenantId]
    );
    if (target.rows.length > 100000 || target.rows.length < source.length) invalid();
    const users = new Map<string, Record<string, unknown>>();
    for (const account of input.accounts.values()) {
      const userId = scalar(account.legacy_user_id);
      if (userId !== null) {
        if (users.has(userId)) invalid();
        users.set(userId, account);
      }
    }
    for (const row of target.rows) {
      const id = scalar(row.id);
      const prior = original.get(id);
      if (prior) {
        if (
          Object.keys(prior).length !== spec.columns.length ||
          spec.columns.some((column) => value(prior, column) !== scalar(row[column]))
        )
          invalid();
        original.delete(id);
        continue;
      }
      const userId = scalar(row.user_id);
      const account = userId === null ? undefined : users.get(userId);
      if (
        !id ||
        !/^evt_[a-f0-9]{32}$/u.test(id) ||
        !userId ||
        !account ||
        row.tenant_id !== tenantId ||
        row.event_type !== 'account.updated' ||
        row.changed_field !== 'account' ||
        row.previous_registration_state !== null ||
        row.registration_state !== account.registration_state ||
        account.account_type !== 'user' ||
        account.directory_publication_state !== 'active' ||
        account.lifecycle_state !== 'active' ||
        integer(row.occurred_at) < BigInt(input.activatedAtMs) ||
        integer(row.attempts) !== 0n ||
        integer(row.next_attempt_at) !== 0n ||
        row.lease_token !== null ||
        integer(row.lease_until) !== 0n ||
        row.delivered_at !== null
      )
        invalid();
      events.set(userId, (events.get(userId) ?? 0n) + 1n);
    }
    if (original.size) invalid();
  }
  if (hasGroups && hasOutbox) {
    for (const [userId, increase] of increments)
      if (increase !== (events.get(userId) ?? 0n)) invalid();
    for (const userId of events.keys()) if (!increments.has(userId)) invalid();
  } else if ([...increments.values()].some((n) => n !== 0n) || events.size) {
    // Partial optional projections cannot prove a live login's coupled side effects.
    invalid();
  }
}
