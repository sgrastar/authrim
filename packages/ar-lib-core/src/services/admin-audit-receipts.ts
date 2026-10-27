import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';

/** Business completion evidence has a lifetime separate from the display log.
 * The keyed digest binds the full event without copying its metadata/body. */
export function adminAuditReceiptStatement(
  record: LogArchiveRecord,
  tenantId: string,
  guard?: { where: string; params: readonly unknown[] }
): PreparedStatement {
  if (
    record.source_dataset !== 'admin.admin_audit_log' ||
    !tenantId ||
    !/^[a-f0-9]{64}$/.test(record.payload_hmac)
  )
    throw new Error('admin_audit_receipt_invalid');
  return {
    sql: `INSERT INTO admin_audit_receipts(id,tenant_id,payload_hmac,recorded_at) SELECT ?,?,?,? WHERE ${guard ? `(${guard.where})` : '1=1'} ON CONFLICT(id) DO UPDATE SET payload_hmac=CASE WHEN admin_audit_receipts.tenant_id=excluded.tenant_id AND admin_audit_receipts.payload_hmac=excluded.payload_hmac AND admin_audit_receipts.recorded_at=excluded.recorded_at THEN admin_audit_receipts.payload_hmac ELSE NULL END`,
    params: [
      record.event_id,
      tenantId,
      record.payload_hmac,
      record.event_at,
      ...(guard?.params ?? []),
    ],
  };
}
export async function confirmAdminAuditReceipt(
  adapter: DatabaseAdapter,
  record: LogArchiveRecord,
  tenantId: string
): Promise<void> {
  const receipt = await adapter.queryOne<{
    tenant_id: string;
    payload_hmac: string;
    recorded_at: number;
  }>(
    'SELECT tenant_id,payload_hmac,recorded_at FROM admin_audit_receipts WHERE id=?',
    [record.event_id],
    { consistencyClass: 'primary_required' }
  );
  if (
    !receipt ||
    receipt.tenant_id !== tenantId ||
    receipt.payload_hmac !== record.payload_hmac ||
    receipt.recorded_at !== record.event_at
  )
    throw new Error('admin_audit_receipt_conflict');
}
