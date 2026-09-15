import type { DatabaseAdapter } from '../../db/adapter';
import { cleanupCancelledTenantBackupArtifactPage } from './cancelled-artifact-cleanup';
import type { TenantBackupStepContext } from './operation-executor';
import { TenantBackupSnapshotResources } from './snapshot-resources';
import { DatabaseTenantBundleReferenceIndex } from './validation-index';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
type Stage = 'boundary' | 'snapshots' | 'artifact' | 'validation' | 'staging' | 'additional';

interface CleanupCursor {
  version: 1;
  stage: Stage;
}

export interface TenantBackupOperationCleanupAdapter {
  /** Abort or prove terminal the exact Control boundary owned by this operation. */
  abortBoundary(context: TenantBackupStepContext): Promise<void>;
  /** Reopen the recorded physical source, even if tenant routing has since changed. */
  resolveSnapshotSource(
    resourceId: string,
    signal: AbortSignal
  ): Promise<{ resourceId: string; database: Database }>;
  /** Invalidate and remove at most one unpublished restore resource. */
  cleanupStagingPage(context: TenantBackupStepContext): Promise<{ done: boolean }>;
  /** Remove or tombstone one page of installed non-SQL resources. */
  cleanupAdditionalPage(context: TenantBackupStepContext): Promise<{ done: boolean }>;
  /** Recheck adapter-owned resources after every cleanup category reports empty. */
  assertClean(context: TenantBackupStepContext): Promise<void>;
}

interface CleanupBucket {
  head(key: string): Promise<object | null>;
  delete(key: string): Promise<void>;
}

function parseCursor(operation: TenantBackupStepContext['operation']): CleanupCursor {
  if (operation.cursor_json === null)
    return { version: 1, stage: operation.kind === 'export' ? 'boundary' : 'validation' };
  try {
    const value = JSON.parse(operation.cursor_json) as Record<string, unknown>;
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'stage,version' ||
      value.version !== 1 ||
      !['boundary', 'snapshots', 'artifact', 'validation', 'staging', 'additional'].includes(
        value.stage as string
      )
    )
      throw new Error();
    return value as unknown as CleanupCursor;
  } catch {
    throw new Error('backup_cleanup_cursor');
  }
}

function next(stage: Stage): string {
  return JSON.stringify({
    version: 1,
    stage:
      stage === 'boundary'
        ? 'snapshots'
        : stage === 'snapshots'
          ? 'artifact'
          : stage === 'artifact'
            ? 'validation'
            : stage === 'validation'
              ? 'staging'
              : 'additional',
  } satisfies CleanupCursor);
}

async function assertAdminResourcesClean(
  database: Database,
  context: TenantBackupStepContext,
  now: () => number
): Promise<void> {
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('backup_cleanup_clock');
  const row = await database.queryOne<{ active: number; dirty: number }>(
    `SELECT
      EXISTS (SELECT 1 FROM tenant_backup_operations WHERE id=? AND tenant_id=?
        AND state='cancelling' AND lease_owner=? AND fencing_token=?
        AND lease_expires_at>? AND updated_at<=?) AS active,
      EXISTS (SELECT 1 FROM tenant_backup_snapshot_resources WHERE operation_id=? AND tenant_id=? AND cleaned=0)
        OR EXISTS (SELECT 1 FROM tenant_backup_artifact_attempts WHERE operation_id=? AND tenant_id=?)
        OR EXISTS (SELECT 1 FROM tenant_backup_validation_sessions WHERE operation_id=? AND tenant_id=?) AS dirty`,
    [
      context.lease.operationId,
      context.lease.tenantId,
      context.lease.owner,
      context.lease.fencingToken,
      timestamp,
      timestamp,
      context.lease.operationId,
      context.lease.tenantId,
      context.lease.operationId,
      context.lease.tenantId,
      context.lease.operationId,
      context.lease.tenantId,
    ]
  );
  if (!row?.active) throw new Error('backup_cleanup_fenced');
  if (row.dirty) throw new Error('backup_cleanup_incomplete');
}

/** One bounded cancellation slice. Final completion requires a second empty check per resource kind. */
export async function runTenantBackupOperationCleanupStep(input: {
  database: Database;
  context: TenantBackupStepContext;
  adapter: TenantBackupOperationCleanupAdapter;
  artifactBucket?: CleanupBucket;
  now?: () => number;
}): Promise<{ cursor: string | null; done: boolean }> {
  const now = input.now ?? Date.now;
  input.context.signal.throwIfAborted();
  if (input.context.operation.state !== 'cancelling' || input.context.operation.phase !== 'cleanup')
    throw new Error('backup_cleanup_state');
  const cursor = parseCursor(input.context.operation);

  if (cursor.stage === 'boundary') {
    if (input.context.operation.kind !== 'export') throw new Error('backup_cleanup_cursor');
    await input.adapter.abortBoundary(input.context);
    return { cursor: next('boundary'), done: false };
  }
  if (cursor.stage === 'snapshots') {
    if (input.context.operation.kind !== 'export') throw new Error('backup_cleanup_cursor');
    const result = await new TenantBackupSnapshotResources(
      input.database,
      now
    ).cleanupCancellationPage(input.context, (resourceId, signal) =>
      input.adapter.resolveSnapshotSource(resourceId, signal)
    );
    return result.done
      ? { cursor: next('snapshots'), done: false }
      : { cursor: JSON.stringify(cursor), done: false };
  }
  if (cursor.stage === 'artifact') {
    if (input.context.operation.kind !== 'export') throw new Error('backup_cleanup_cursor');
    const result = await cleanupCancelledTenantBackupArtifactPage({
      database: input.database,
      bucket: input.artifactBucket,
      context: input.context,
      now,
    });
    return result.done
      ? { cursor: next('artifact'), done: false }
      : { cursor: JSON.stringify(cursor), done: false };
  }
  if (cursor.stage === 'validation') {
    const result = await DatabaseTenantBundleReferenceIndex.cleanupAbandonedPage(
      input.database,
      input.context.lease,
      now
    );
    return !result.found && result.done
      ? { cursor: next('validation'), done: false }
      : { cursor: JSON.stringify(cursor), done: false };
  }
  if (cursor.stage === 'staging') {
    const result = await input.adapter.cleanupStagingPage(input.context);
    return result.done
      ? { cursor: next('staging'), done: false }
      : { cursor: JSON.stringify(cursor), done: false };
  }
  const result = await input.adapter.cleanupAdditionalPage(input.context);
  if (!result.done) return { cursor: JSON.stringify(cursor), done: false };
  await assertAdminResourcesClean(input.database, input.context, now);
  await input.adapter.assertClean(input.context);
  input.context.signal.throwIfAborted();
  await assertAdminResourcesClean(input.database, input.context, now);
  return { cursor: null, done: true };
}
