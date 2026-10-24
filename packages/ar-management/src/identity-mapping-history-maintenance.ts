import {
  ensureDatabaseAdapter,
  requireDedicatedAdminDatabaseAdapter,
  resolveTenantMetadataContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  ackIdentityMappingClientHistoryReceipt,
  listIdentityMappingClientHistoryReceipts,
  readIdentityMappingClientHistoryReceipt,
  type IdentityMappingClientHistoryReceipt,
} from '@authrim/ar-lib-core/services/identity-mapping-client-history-receipt';
import {
  finalizeIdentityMappingLevelHistoryFromReceipt,
  identityMappingLevelHistoryChoicesEqual,
  readIdentityMappingLevelHistory,
  type IdentityMappingLevelHistoryRow,
} from '@authrim/ar-lib-core/services/identity-mapping-level-history';

interface MaintenanceLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
}

async function tenantMetadata(env: Env, tenantId: string): Promise<DatabaseAdapter> {
  const context = await resolveTenantMetadataContext(env, tenantId);
  if (context.tenantId !== tenantId) throw new Error('identity_mapping_history_tenant_mismatch');
  return ensureDatabaseAdapter(context.coreDb, 'identity-mapping-history-maintenance');
}

function receiptMatches(
  row: IdentityMappingLevelHistoryRow,
  receipt: IdentityMappingClientHistoryReceipt
): boolean {
  return (
    row.id === receipt.historyId &&
    row.tenant_id === receipt.tenantId &&
    row.tier === 'client' &&
    row.client_id === receipt.clientId &&
    row.actor_id === receipt.actorId &&
    row.actor_type === receipt.actorType &&
    row.via === receipt.via &&
    row.bulk_id === receipt.bulkId &&
    row.created_at === receipt.createdAt &&
    row.source_version ===
      (row.status === 'committed' ? receipt.sourceVersion : String(receipt.expectedUpdatedAt)) &&
    identityMappingLevelHistoryChoicesEqual('client', row.before_json, receipt.beforeJson) &&
    identityMappingLevelHistoryChoicesEqual('client', row.after_json, receipt.afterJson)
  );
}

/**
 * Repair only prepared intents with an atomic Core commit receipt. Never inspect the current
 * client value to infer success, create missing history, or replay a client mutation.
 */
export async function processPendingIdentityMappingHistory(
  env: Env,
  log: MaintenanceLogger,
  options: { limit?: number; now?: () => number } = {}
): Promise<{ scanned: number; committed: number; acknowledged: number; failed: number }> {
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('identity_mapping_history_reconcile_limit');
  const now = options.now ?? Date.now;
  const admin = requireDedicatedAdminDatabaseAdapter(env, 'identity-mapping-history-maintenance');
  const rows = await admin.query<IdentityMappingLevelHistoryRow>(
    `SELECT * FROM identity_mapping_level_history
     WHERE tier='client' AND (status='pending' OR
       (status='committed' AND receipt_acknowledged_at IS NULL))
     ORDER BY last_reconciled_at,created_at,id LIMIT ?`,
    [limit],
    { consistencyClass: 'primary_required' }
  );
  const sources = new Map<string, Promise<DatabaseAdapter>>();
  const summary = { scanned: rows.length, committed: 0, acknowledged: 0, failed: 0 };
  for (const row of rows) {
    try {
      const at = now();
      if (!Number.isSafeInteger(at) || at < 1)
        throw new Error('identity_mapping_history_reconcile_time');
      // Rotate even permanently unknown receipts and unavailable tenant routes to the end.
      const claimed = await admin.execute(
        `UPDATE identity_mapping_level_history SET last_reconciled_at=?
         WHERE tenant_id=? AND id=? AND status IN ('pending','committed')`,
        [at, row.tenant_id, row.id]
      );
      if (claimed.rowsAffected !== 1) continue;
      let source = sources.get(row.tenant_id);
      if (!source) {
        source = tenantMetadata(env, row.tenant_id);
        sources.set(row.tenant_id, source);
      }
      const core = await source;
      const receipt = await readIdentityMappingClientHistoryReceipt(core, row.tenant_id, row.id);
      if (!receipt && row.status === 'pending') continue;
      if (receipt) {
        if (!receiptMatches(row, receipt))
          throw new Error('identity_mapping_history_receipt_mismatch');
        await finalizeIdentityMappingLevelHistoryFromReceipt(
          admin,
          {
            historyId: receipt.historyId,
            tenantId: receipt.tenantId,
            clientId: receipt.clientId,
            before: JSON.parse(receipt.beforeJson) as Record<string, unknown> | null,
            after: JSON.parse(receipt.afterJson) as Record<string, unknown> | null,
            expectedSourceVersion: String(receipt.expectedUpdatedAt),
            sourceVersion: receipt.sourceVersion,
          },
          at
        );
        if (row.status === 'pending') summary.committed += 1;
        // finalize reads the committed Admin row from its primary before this TTL write.
        await ackIdentityMappingClientHistoryReceipt(core, row.tenant_id, row.id, at);
      } else {
        // A restored committed record has no source-environment receipt. It is already audit
        // evidence, and cannot create/replay source work in this environment.
        const confirmed = await readIdentityMappingLevelHistory(admin, row.tenant_id, row.id);
        if (!confirmed || confirmed.status !== 'committed')
          throw new Error('identity_mapping_history_unavailable');
      }
      await admin.execute(
        `UPDATE identity_mapping_level_history SET receipt_acknowledged_at=?
         WHERE tenant_id=? AND id=? AND status='committed'`,
        [at, row.tenant_id, row.id]
      );
      summary.acknowledged += 1;
    } catch (error) {
      summary.failed += 1;
      log.warn('Identity mapping history reconciliation deferred', {
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    }
  }
  return summary;
}

/** Called inside the snapshot write hold, including audit-only backups with users disabled. */
export async function assertIdentityMappingHistoryBoundaryReady(
  env: Env,
  tenantId: string
): Promise<void> {
  const core = await tenantMetadata(env, tenantId);
  const admin = requireDedicatedAdminDatabaseAdapter(env, 'identity-mapping-history-boundary');
  const { receipts, nextAfterId } = await listIdentityMappingClientHistoryReceipts(core, tenantId, {
    limit: 100,
  });
  // A bounded inspection is not proof for receipts past its bound. Reconcile, then retry.
  if (nextAfterId !== null) throw new Error('backup_identity_mapping_history_unsettled');
  for (const receipt of receipts) {
    const row = await readIdentityMappingLevelHistory(admin, tenantId, receipt.historyId);
    if (!row || row.status !== 'committed' || !receiptMatches(row, receipt))
      throw new Error('backup_identity_mapping_history_unsettled');
  }
}
