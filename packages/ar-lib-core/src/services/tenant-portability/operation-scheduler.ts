import type { DatabaseAdapter } from '../../db/adapter';
import { TenantBackupOperationStore } from './operation-store';
import { executeTenantBackupSlice, type TenantBackupOperationHandlers } from './operation-executor';

/** One bounded scheduling tick. The database lease arbitrates overlapping invocations. */
export async function runTenantBackupScheduler(
  database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>,
  handlers: TenantBackupOperationHandlers,
  signal: AbortSignal,
  now: () => number = Date.now
): Promise<{ inspected: number; advanced: number; failures: number }> {
  signal.throwIfAborted();
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error('invalid_backup_scheduler_clock');
  // Oldest updated first prevents a repeatedly yielding operation from monopolizing every tick.
  const due = await database.query<{ id: string; tenant_id: string }>(
    `SELECT id,tenant_id FROM tenant_backup_operations
    WHERE next_attempt_at<=? AND updated_at<=? AND
    (state='queued' OR (state='running' AND lease_expires_at<=?) OR
    (state='cancelling' AND (lease_expires_at IS NULL OR lease_expires_at<=?)))
    ORDER BY updated_at,id LIMIT 5`,
    [timestamp, timestamp, timestamp, timestamp]
  );
  const store = new TenantBackupOperationStore(database);
  let advanced = 0,
    failures = 0;
  for (const item of due) {
    signal.throwIfAborted();
    const workerId = crypto.randomUUID();
    try {
      const result = await executeTenantBackupSlice(
        store,
        { tenantId: item.tenant_id, operationId: item.id, workerId, signal },
        handlers,
        now
      );
      if (result.outcome === 'yielded') advanced++;
    } catch {
      signal.throwIfAborted();
      const current = await store.get(item.tenant_id, item.id);
      // Do not reschedule a new owner after cancellation, lease takeover, or a stale response.
      if (current?.lease_owner === workerId) {
        await store.retryFailure(
          {
            tenantId: item.tenant_id,
            operationId: item.id,
            owner: workerId,
            fencingToken: current.fencing_token,
          },
          current.revision,
          now()
        );
      }
      failures++;
    }
  }
  return { inspected: due.length, advanced, failures };
}
