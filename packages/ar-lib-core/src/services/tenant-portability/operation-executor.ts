import {
  TenantBackupOperationStore,
  type TenantBackupLease,
  type TenantBackupOperation,
} from './operation-store';

export interface TenantBackupStepContext {
  operation: Readonly<TenantBackupOperation>;
  lease: Readonly<TenantBackupLease>;
  /** Implementations must respect cancellation and perform bounded, idempotent work. */
  signal: AbortSignal;
}
export interface TenantBackupStepResult {
  phase: string;
  cursor: string | null;
  disposition: 'continue' | 'wait' | 'ready';
}
export interface TenantBackupOperationHandlers {
  /** Storage writers independently check the operation fence before committing side effects. */
  run(context: TenantBackupStepContext): Promise<TenantBackupStepResult>;
  /** done means all operation-owned resources were verified clean, not just deletion requested. */
  cleanup(context: TenantBackupStepContext): Promise<{ cursor: string | null; done: boolean }>;
}
export type TenantBackupExecutionResult =
  | { outcome: 'unclaimed' | 'fenced' }
  | { outcome: 'yielded'; operation: TenantBackupOperation };

/**
 * Executes one bounded slice. No durable queue/scheduler or production adapters are
 * implied by this dispatcher; those must invoke it with authenticated operation context.
 * On exceptions the persisted lease expires for retry; never guess cursor advancement.
 */
export async function executeTenantBackupSlice(
  store: TenantBackupOperationStore,
  input: { tenantId: string; operationId: string; workerId: string; signal: AbortSignal },
  handlers: TenantBackupOperationHandlers,
  now: () => number
): Promise<TenantBackupExecutionResult> {
  input.signal.throwIfAborted();
  const current = await store.get(input.tenantId, input.operationId);
  if (!current) return { outcome: 'unclaimed' };
  const cleanup = current.state === 'cancelling';
  const operation = cleanup
    ? await store.claimCancellation(input.tenantId, input.operationId, input.workerId, now())
    : await store.claim(input.tenantId, input.operationId, input.workerId, now());
  if (!operation) return { outcome: 'unclaimed' };
  const lease: TenantBackupLease = {
    tenantId: operation.tenant_id,
    operationId: operation.id,
    owner: input.workerId,
    fencingToken: operation.fencing_token,
  };
  const context = {
    operation: Object.freeze({ ...operation }),
    lease: Object.freeze({ ...lease }),
    signal: input.signal,
  };
  try {
    if (cleanup) {
      const result = await handlers.cleanup(context);
      input.signal.throwIfAborted();
      if (typeof result.done !== 'boolean') throw new Error('invalid_backup_cleanup_result');
      const saved = await store.checkpointCancellation(
        lease,
        operation.revision,
        result.cursor,
        now()
      );
      if (!saved) return { outcome: 'fenced' };
      const finished = result.done
        ? await store.finishCancellation(lease, saved.revision, now())
        : await store.yieldCancellation(lease, saved.revision, now());
      return finished ? { outcome: 'yielded', operation: finished } : { outcome: 'fenced' };
    }
    const result = await handlers.run(context);
    input.signal.throwIfAborted();
    if (!['continue', 'wait', 'ready'].includes(result.disposition))
      throw new Error('invalid_backup_step_result');
    const saved = await store.checkpoint(
      lease,
      operation.revision,
      result.phase,
      result.cursor,
      now()
    );
    if (!saved) return { outcome: 'fenced' };
    const state = { continue: 'queued', wait: 'waiting', ready: 'ready' } as const;
    const released = await store.release(lease, saved.revision, state[result.disposition], now());
    return released ? { outcome: 'yielded', operation: released } : { outcome: 'fenced' };
  } catch {
    // Module exceptions can contain decrypted rows; persist/report only a stable code.
    throw new Error('backup_operation_slice_failed');
  }
}
