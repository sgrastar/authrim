import type { D1Database } from '@cloudflare/workers-types';
import type {
  ControlLookupBucketMigrationView,
  ControlServiceBinding,
  Env,
} from '@authrim/ar-lib-core';
import { LookupBucketMigrationWorker } from './lookup-bucket-migration-worker';
import { collectLookupBucketLoadSnapshot } from './lookup-bucket-load-snapshot';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const PERMANENT_FAILURE = /^lookup_bucket_migration_(?:cursor|row|view|state|verification)_/u;
const MAX_VERIFICATION_ATTEMPTS = 3;
const MAX_PAGES_PER_INVOCATION = 8;
const PLAN_INTERVAL_MINUTES = 10;

export interface LookupBucketMigrationScheduledResult {
  status: 'idle' | 'progressed' | 'waiting_grace' | 'completed' | 'blocked';
  operationId: string | null;
  state: string | null;
  processedRows: number;
}

function database(env: Env, bindingRef: string): D1Database {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(bindingRef)) {
    throw new Error('lookup_bucket_migration_binding_invalid');
  }
  const value = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!value || typeof value !== 'object') {
    throw new Error('lookup_bucket_migration_binding_unavailable');
  }
  const candidate = value as Partial<D1Database>;
  if (
    typeof candidate.prepare !== 'function' ||
    typeof candidate.batch !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error('lookup_bucket_migration_binding_unavailable');
  }
  return value as D1Database;
}

function control(
  env: Env
):
  | (Required<
      Pick<
        ControlServiceBinding,
        | 'claimNextLookupBucketMigration'
        | 'checkpointLookupBucketMigration'
        | 'cutoverLookupBucketMigration'
        | 'completeLookupBucketMigration'
        | 'blockLookupBucketMigration'
      >
    > &
      Pick<
        ControlServiceBinding,
        'planNextLookupBucketMigration' | 'reconcileLookupScaleOut' | 'releaseLookupBucketMigration'
      >)
  | null {
  const value = env.CONTROL;
  if (!value || typeof value.claimNextLookupBucketMigration !== 'function') return null;
  if (
    typeof value.checkpointLookupBucketMigration !== 'function' ||
    typeof value.cutoverLookupBucketMigration !== 'function' ||
    typeof value.completeLookupBucketMigration !== 'function' ||
    typeof value.blockLookupBucketMigration !== 'function'
  ) {
    throw new Error('lookup_bucket_migration_control_unavailable');
  }
  return value as Required<
    Pick<
      ControlServiceBinding,
      | 'claimNextLookupBucketMigration'
      | 'checkpointLookupBucketMigration'
      | 'cutoverLookupBucketMigration'
      | 'completeLookupBucketMigration'
      | 'blockLookupBucketMigration'
    >
  > &
    Pick<
      ControlServiceBinding,
      'planNextLookupBucketMigration' | 'reconcileLookupScaleOut' | 'releaseLookupBucketMigration'
    >;
}

async function releaseLease(
  rpc: Pick<ControlServiceBinding, 'releaseLookupBucketMigration'>,
  view: ControlLookupBucketMigrationView,
  ownerId: string
): Promise<void> {
  await rpc.releaseLookupBucketMigration?.({
    operationId: view.operationId,
    ownerId,
    fencingToken: view.fencingToken,
  });
}

function fixedErrorCode(error: unknown): string {
  if (error instanceof Error && /^lookup_bucket_migration_[a-z0-9_]{1,96}$/u.test(error.message)) {
    return error.message;
  }
  return 'lookup_bucket_migration_internal_failure';
}

function validateView(view: ControlLookupBucketMigrationView): void {
  if (
    !SAFE_ID.test(view.operationId) ||
    !Number.isSafeInteger(view.fencingToken) ||
    view.fencingToken < 1 ||
    !Number.isSafeInteger(view.leaseExpiresAt) ||
    view.leaseExpiresAt < 1 ||
    !Number.isSafeInteger(view.verificationAttemptCount) ||
    view.verificationAttemptCount < 0 ||
    view.verificationAttemptCount > MAX_VERIFICATION_ATTEMPTS ||
    view.source.lookupShardId === view.target.lookupShardId ||
    view.source.bindingRef === view.target.bindingRef
  ) {
    throw new Error('lookup_bucket_migration_view_invalid');
  }
}

export async function processNextLookupBucketMigration(
  env: Env,
  options: { ownerId?: string; now?: () => number } = {}
): Promise<LookupBucketMigrationScheduledResult> {
  const ownerId = options.ownerId ?? `management-migration:${crypto.randomUUID()}`;
  if (!SAFE_ID.test(ownerId)) throw new Error('lookup_bucket_migration_owner_invalid');
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const rpc = control(env);
  if (!rpc) return { status: 'idle', operationId: null, state: null, processedRows: 0 };
  const observedAt = now();
  const observationDue = Math.floor(observedAt / 60) % PLAN_INTERVAL_MINUTES === 0;
  let snapshot: Awaited<ReturnType<typeof collectLookupBucketLoadSnapshot>> | null = null;
  let capacityState: LookupBucketMigrationScheduledResult | null = null;
  if (
    observationDue &&
    (typeof rpc.reconcileLookupScaleOut === 'function' ||
      typeof rpc.planNextLookupBucketMigration === 'function')
  ) {
    snapshot = await collectLookupBucketLoadSnapshot(env, ownerId, observedAt);
    if (typeof rpc.reconcileLookupScaleOut === 'function') {
      const forecasts = await rpc.reconcileLookupScaleOut(snapshot);
      const blocked = forecasts.find((forecast) => forecast.status === 'blocked');
      if (blocked) {
        capacityState = {
          status: 'blocked',
          operationId: blocked.requestedOperationId,
          state: blocked.lastErrorCode ?? 'lookup_scale_out_blocked',
          processedRows: 0,
        };
      } else {
        const provisioning = forecasts.find((forecast) => forecast.status === 'provisioning');
        if (provisioning) {
          capacityState = {
            status: 'progressed',
            operationId: provisioning.requestedOperationId,
            state: provisioning.requestedOperationId
              ? 'lookup_capacity_provisioning'
              : 'lookup_capacity_pending',
            processedRows: 0,
          };
        }
      }
    }
  }
  const view = await rpc.claimNextLookupBucketMigration({ ownerId });
  if (!view) {
    if (capacityState) return capacityState;
    if (!snapshot || typeof rpc.planNextLookupBucketMigration !== 'function') {
      return { status: 'idle', operationId: null, state: null, processedRows: 0 };
    }
    const planned = await rpc.planNextLookupBucketMigration(snapshot);
    if (!planned) return { status: 'idle', operationId: null, state: null, processedRows: 0 };
    validateView(planned);
    await releaseLease(rpc, planned, ownerId);
    return {
      status: 'progressed',
      operationId: planned.operationId,
      state: planned.state,
      processedRows: 0,
    };
  }
  try {
    validateView(view);
    if (view.state === 'dual_write') {
      const advanced = await rpc.checkpointLookupBucketMigration({
        operationId: view.operationId,
        ownerId,
        fencingToken: view.fencingToken,
        expectedState: 'dual_write',
        nextState: 'backfilling',
        backfillCursor: '{}',
        sourceRowCount: null,
        targetRowCount: null,
        verificationDigest: null,
      });
      await releaseLease(rpc, advanced, ownerId);
      return {
        status: 'progressed',
        operationId: view.operationId,
        state: advanced.state,
        processedRows: 0,
      };
    }
    if (view.state === 'backfilling') {
      const worker = new LookupBucketMigrationWorker(
        database(env, view.source.bindingRef),
        database(env, view.target.bindingRef),
        now
      );
      let cursor = view.backfillCursor;
      let processedRows = 0;
      let done = false;
      for (let page = 0; page < MAX_PAGES_PER_INVOCATION && !done; page += 1) {
        const copied = await worker.copyNext(view, cursor);
        cursor = copied.cursor;
        processedRows += copied.processedRows;
        done = copied.done;
      }
      const advanced = await rpc.checkpointLookupBucketMigration({
        operationId: view.operationId,
        ownerId,
        fencingToken: view.fencingToken,
        expectedState: 'backfilling',
        nextState: done ? 'verifying' : 'backfilling',
        backfillCursor: done ? '{}' : cursor,
        sourceRowCount: null,
        targetRowCount: null,
        verificationDigest: null,
      });
      await releaseLease(rpc, advanced, ownerId);
      return {
        status: 'progressed',
        operationId: view.operationId,
        state: advanced.state,
        processedRows,
      };
    }
    if (view.state === 'verifying') {
      const worker = new LookupBucketMigrationWorker(
        database(env, view.source.bindingRef),
        database(env, view.target.bindingRef),
        now
      );
      let cursor = view.backfillCursor;
      let processedRows = 0;
      let verified = await worker.verifyNext(view, cursor);
      processedRows += verified.processedRows;
      for (let page = 1; page < MAX_PAGES_PER_INVOCATION && !verified.done; page += 1) {
        cursor = verified.cursor;
        verified = await worker.verifyNext(view, cursor);
        processedRows += verified.processedRows;
      }
      const advanced = await rpc.checkpointLookupBucketMigration({
        operationId: view.operationId,
        ownerId,
        fencingToken: view.fencingToken,
        expectedState: 'verifying',
        nextState: verified.done ? 'cutover_pending' : 'verifying',
        backfillCursor: verified.cursor,
        sourceRowCount: verified.sourceRowCount,
        targetRowCount: verified.targetRowCount,
        verificationDigest: verified.verificationDigest,
      });
      await releaseLease(rpc, advanced, ownerId);
      return {
        status: 'progressed',
        operationId: view.operationId,
        state: advanced.state,
        processedRows,
      };
    }
    if (view.state === 'cutover_pending') {
      const advanced = await rpc.cutoverLookupBucketMigration({
        operationId: view.operationId,
        ownerId,
        fencingToken: view.fencingToken,
      });
      await releaseLease(rpc, advanced, ownerId);
      return {
        status: 'progressed',
        operationId: view.operationId,
        state: advanced.state,
        processedRows: 0,
      };
    }
    if (view.state === 'grace') {
      if (view.graceExpiresAt === null || now() < view.graceExpiresAt) {
        await releaseLease(rpc, view, ownerId);
        return {
          status: 'waiting_grace',
          operationId: view.operationId,
          state: view.state,
          processedRows: 0,
        };
      }
      const worker = new LookupBucketMigrationWorker(
        database(env, view.source.bindingRef),
        database(env, view.target.bindingRef),
        now
      );
      await worker.quarantineSource(view);
      const completed = await rpc.completeLookupBucketMigration({
        operationId: view.operationId,
        ownerId,
        fencingToken: view.fencingToken,
        oldRowsQuarantined: true,
      });
      return {
        status: 'completed',
        operationId: view.operationId,
        state: completed.state,
        processedRows: 0,
      };
    }
    throw new Error('lookup_bucket_migration_state_invalid');
  } catch (error) {
    const code = fixedErrorCode(error);
    if (
      code === 'lookup_bucket_migration_verification_mismatch' &&
      view.state === 'verifying' &&
      view.verificationAttemptCount < MAX_VERIFICATION_ATTEMPTS - 1
    ) {
      const advanced = await rpc.checkpointLookupBucketMigration({
        operationId: view.operationId,
        ownerId,
        fencingToken: view.fencingToken,
        expectedState: 'verifying',
        nextState: 'backfilling',
        backfillCursor: '{}',
        sourceRowCount: null,
        targetRowCount: null,
        verificationDigest: null,
      });
      await releaseLease(rpc, advanced, ownerId);
      return {
        status: 'progressed',
        operationId: view.operationId,
        state: advanced.state,
        processedRows: 0,
      };
    }
    if (PERMANENT_FAILURE.test(code)) {
      const blocked = await rpc.blockLookupBucketMigration({
        operationId: view.operationId,
        ownerId,
        fencingToken: view.fencingToken,
        errorCode: code,
      });
      return {
        status: 'blocked',
        operationId: view.operationId,
        state: blocked.state,
        processedRows: 0,
      };
    }
    throw error;
  }
}
