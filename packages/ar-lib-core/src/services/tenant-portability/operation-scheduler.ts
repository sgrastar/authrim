import type { DatabaseAdapter } from '../../db/adapter';
import { TenantBackupOperationStore } from './operation-store';
import { executeTenantBackupBatch, type TenantBackupOperationHandlers } from './operation-executor';

/** One bounded scheduling tick. The database lease arbitrates overlapping invocations. */
export async function runTenantBackupScheduler(
  database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>,
  handlers: TenantBackupOperationHandlers,
  signal: AbortSignal,
  now: () => number = Date.now,
  kinds: readonly ('export' | 'import')[] = ['export', 'import'],
  maxTransitionsPerOperation = 1
): Promise<{ inspected: number; advanced: number; failures: number; failureCodes: string[] }> {
  signal.throwIfAborted();
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error('invalid_backup_scheduler_clock');
  if (!kinds.length || kinds.length > 2 || new Set(kinds).size !== kinds.length)
    throw new Error('invalid_backup_scheduler_kinds');
  if (
    !Number.isSafeInteger(maxTransitionsPerOperation) ||
    maxTransitionsPerOperation < 1 ||
    maxTransitionsPerOperation > 32
  )
    throw new Error('invalid_backup_scheduler_transition_limit');
  const kindPredicate =
    kinds.length === 2 ? '' : kinds[0] === 'export' ? "AND kind='export'" : "AND kind='import'";
  // Oldest updated first prevents a repeatedly yielding operation from monopolizing every tick.
  const due = await database.query<{ id: string; tenant_id: string }>(
    `SELECT id,tenant_id FROM tenant_backup_operations
    WHERE next_attempt_at<=? AND updated_at<=? AND
    (state='queued' OR (state='running' AND lease_expires_at<=?) OR
    (state='cancelling' AND (lease_expires_at IS NULL OR lease_expires_at<=?)))
    ${kindPredicate}
    ORDER BY updated_at,id LIMIT 5`,
    [timestamp, timestamp, timestamp, timestamp]
  );
  const store = new TenantBackupOperationStore(database);
  let advanced = 0,
    failures = 0;
  const failureCodes = new Set<string>();
  for (const item of due) {
    const workerId = crypto.randomUUID();
    signal.throwIfAborted();
    try {
      const result = await executeTenantBackupBatch(
        store,
        { tenantId: item.tenant_id, operationId: item.id, workerId, signal },
        handlers,
        now,
        maxTransitionsPerOperation
      );
      advanced += result.transitions;
    } catch (error) {
      signal.throwIfAborted();
      const current = await store.get(item.tenant_id, item.id);
      const cause = error instanceof Error ? error.cause : undefined;
      const errorCode =
        cause instanceof Error && /^[a-z0-9_:-]{1,128}$/.test(cause.message)
          ? cause.message
          : 'backup_operation_slice_failed';
      failureCodes.add(errorCode);
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
  return { inspected: due.length, advanced, failures, failureCodes: [...failureCodes].sort() };
}
