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
  maxTransitionsPerOperation = 1,
  /** Wall-time budget per claimed operation; transitions stop at the first boundary past it. */
  operationBudgetMs?: number,
  /**
   * Budget shared by every operation this tick serves. The operations run in one invocation, so
   * they share its CPU time and subrequests; a failed batch counts as having used its whole cap.
   */
  invocationBudget?: { transitions: number; wallMs: number }
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
  if (
    invocationBudget &&
    (!Number.isSafeInteger(invocationBudget.transitions) ||
      invocationBudget.transitions < 1 ||
      !Number.isSafeInteger(invocationBudget.wallMs) ||
      invocationBudget.wallMs < 1)
  )
    throw new Error('invalid_backup_scheduler_transition_limit');
  const store = new TenantBackupOperationStore(database);
  let advanced = 0,
    failures = 0,
    spent = 0;
  const failureCodes = new Set<string>();
  for (const item of due) {
    const workerId = crypto.randomUUID();
    signal.throwIfAborted();
    let maxTransitions = maxTransitionsPerOperation;
    let budgetMs = operationBudgetMs;
    if (invocationBudget) {
      const remainingMs = invocationBudget.wallMs - (now() - timestamp);
      const remaining = invocationBudget.transitions - spent;
      if (remaining < 1 || remainingMs < 1) break;
      maxTransitions = Math.min(maxTransitions, remaining);
      budgetMs = Math.min(budgetMs ?? remainingMs, remainingMs);
    }
    try {
      const result = await executeTenantBackupBatch(
        store,
        { tenantId: item.tenant_id, operationId: item.id, workerId, signal },
        handlers,
        now,
        maxTransitions,
        budgetMs
      );
      advanced += result.transitions;
      spent += result.transitions;
    } catch (error) {
      spent += maxTransitions;
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
