import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import type { DatabaseAdapter } from '../db/adapter';
import { LOG_ICEBERG_DB_NOW } from './log-iceberg-lease';

export interface LogIcebergRestoreHold {
  id: string;
  operation_id: string;
  tenant_id: string;
  payload_hmac: string;
  storage_generation: string;
  state: 'holding' | 'aborted';
  expires_at: number | null;
  created_at: number;
  cleanup_completed_at: number | null;
}
export interface LogIcebergRestoreHoldStatus extends LogIcebergRestoreHold {
  operation_state: 'pending' | 'active' | 'aborted' | null;
}
export function isLogIcebergRestoreHoldVisible(hold: LogIcebergRestoreHoldStatus | null): boolean {
  return !hold || (hold.state === 'holding' && hold.operation_state === 'active');
}
function alias(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('log_iceberg_sql_alias_invalid');
  return value;
}
function activeWitness(hold: string): string {
  return `EXISTS(SELECT 1 FROM log_iceberg_restore_activations a WHERE a.id=${hold}.operation_id AND a.tenant_id=${hold}.tenant_id AND a.storage_generation=${hold}.storage_generation AND a.state='active')`;
}
const holdProjection = `h.id,h.operation_id,h.tenant_id,h.payload_hmac,h.storage_generation,h.state,h.expires_at,h.created_at,h.cleanup_completed_at,(SELECT a.state FROM log_iceberg_restore_activations a WHERE a.id=h.operation_id AND a.tenant_id=h.tenant_id AND a.storage_generation=h.storage_generation) AS operation_state`;

/** A pending operation still owns staging; original TTL and a final abort take precedence. */
export function logIcebergRestorePendingSql(table = 'log_iceberg_outbox'): string {
  return `EXISTS(SELECT 1 FROM log_iceberg_restore_holds h WHERE h.id=${alias(table)}.id AND h.state!='aborted' AND NOT EXISTS(SELECT 1 FROM log_iceberg_restore_activations d WHERE d.id=h.operation_id AND d.state='aborted') AND NOT ${activeWitness('h')})`;
}
/** A held historical copy is not a live tenant log until its target is activated. */
export function logIcebergRestoreVisibleSql(table = 'log_iceberg_records'): string {
  return `NOT EXISTS(SELECT 1 FROM log_iceberg_restore_holds h WHERE h.id=${alias(table)}.id AND (h.state='aborted' OR NOT ${activeWitness('h')}))`;
}
/** A final abort or the original retention deadline blocks every late prepared write. */
export async function loadLogIcebergRestoreHold(
  admin: DatabaseAdapter,
  id: string
): Promise<LogIcebergRestoreHoldStatus | null> {
  return admin.queryOne<LogIcebergRestoreHoldStatus>(
    `SELECT ${holdProjection} FROM log_iceberg_restore_holds h WHERE h.id=?`,
    [id],
    { consistencyClass: 'primary_required' }
  );
}
export async function isLogIcebergRestoreDenied(
  admin: DatabaseAdapter,
  id: string
): Promise<boolean> {
  return !!(await admin.queryOne(
    `SELECT id FROM log_iceberg_restore_holds h WHERE h.id=? AND (h.state='aborted' OR EXISTS(SELECT 1 FROM log_iceberg_restore_activations a WHERE a.id=h.operation_id AND a.state='aborted') OR (h.expires_at IS NOT NULL AND h.expires_at<=${LOG_ICEBERG_DB_NOW}))`,
    [id],
    { consistencyClass: 'primary_required' }
  ));
}
export async function filterLogIcebergRestoreRecords(
  admin: DatabaseAdapter,
  entries: readonly { id: string; tenantId: string; record: LogArchiveRecord }[],
  restoreOperationId?: string
): Promise<LogArchiveRecord[]> {
  const holds = new Map<string, LogIcebergRestoreHoldStatus>();
  for (let offset = 0; offset < entries.length; offset += 64) {
    const ids = entries.slice(offset, offset + 64).map((entry) => entry.id);
    const rows = await admin.query<LogIcebergRestoreHoldStatus>(
      `SELECT ${holdProjection} FROM log_iceberg_restore_holds h WHERE h.id IN(${ids.map(() => '?').join(',')})`,
      ids,
      { consistencyClass: 'primary_required' }
    );
    for (const row of rows) holds.set(row.id, row);
  }
  return entries.flatMap((entry) => {
    const hold = holds.get(entry.id);
    if (hold) {
      assertLogIcebergRestoreHoldScope(hold, {
        id: entry.id,
        tenantId: entry.tenantId,
        hmac: entry.record.payload_hmac,
        generation: entry.record.storage_generation,
        expiresAt: entry.record.expires_at,
      });
      if (
        !isLogIcebergRestoreHoldVisible(hold) &&
        !(
          hold.state === 'holding' &&
          hold.operation_state === 'pending' &&
          restoreOperationId === hold.operation_id
        )
      )
        return [];
    }
    return [entry.record];
  });
}
export function assertLogIcebergRestoreHoldScope(
  hold: LogIcebergRestoreHold | null,
  input: {
    id: string;
    tenantId: string;
    hmac: string;
    generation: string;
    expiresAt: number | null;
  }
): void {
  if (
    hold &&
    (hold.id !== input.id ||
      hold.tenant_id !== input.tenantId ||
      hold.payload_hmac !== input.hmac ||
      hold.storage_generation !== input.generation ||
      hold.expires_at !== input.expiresAt)
  )
    throw new Error('log_iceberg_restore_hold_scope_changed');
}
export function logIcebergRestoreWriteGuard(input: {
  id: string;
  tenantId: string;
  hmac: string;
  generation: string;
  expiresAt: number | null;
}): { where: string; params: unknown[] } {
  return {
    where: `NOT EXISTS(SELECT 1 FROM log_iceberg_restore_holds h WHERE h.id=? AND (h.tenant_id!=? OR h.payload_hmac!=? OR h.storage_generation!=? OR h.expires_at IS NOT ? OR h.state='aborted' OR EXISTS(SELECT 1 FROM log_iceberg_restore_activations a WHERE a.id=h.operation_id AND a.state='aborted') OR (h.expires_at IS NOT NULL AND h.expires_at<=${LOG_ICEBERG_DB_NOW})))`,
    params: [input.id, input.tenantId, input.hmac, input.generation, input.expiresAt],
  };
}
