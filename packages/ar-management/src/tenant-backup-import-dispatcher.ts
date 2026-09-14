import type { Env } from '@authrim/ar-lib-core';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import type { TenantBackupSelection } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import type {
  TenantBackupStepContext,
  TenantBackupStepResult,
} from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { DatabaseTenantBackupRestorePlanInventory } from '@authrim/ar-lib-core/services/tenant-portability/restore-plan-inventory';
import { runSqliteRestoreSequenceStep } from '@authrim/ar-lib-core/services/tenant-portability/restore-sqlite-sequence';
import type { SqliteDatasetInspectionPolicy } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { TenantBackupSqliteRestorePlanTarget } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-restore-plan-step';
import { requireDedicatedAdminDatabaseAdapter } from '@authrim/ar-lib-core';
import {
  runTenantBackupImportDecode,
  runTenantBackupImportPreparation,
  runTenantBackupImportRestorePlanning,
  runTenantBackupImportValidation,
} from './tenant-backup-execution';

type RestoreInput = Parameters<typeof runSqliteRestoreSequenceStep>[1];

/** Server-installed code only. Uploaded manifests cannot supply policies or target callbacks. */
export interface TenantBackupInstalledImportAdapter {
  datasets(selection: TenantBackupSelection): readonly TenantPortableDataset[];
  loadPolicy(
    context: TenantBackupStepContext,
    datasetId: string
  ): Promise<SqliteDatasetInspectionPolicy>;
  assertSources(context: TenantBackupStepContext): Promise<void>;
  restoreTargets(
    context: TenantBackupStepContext
  ): Promise<readonly TenantBackupSqliteRestorePlanTarget[]>;
  resolveRestoreTarget(
    context: TenantBackupStepContext,
    ...args: Parameters<RestoreInput['resolve']>
  ): ReturnType<RestoreInput['resolve']>;
  loadValidatedDataset(
    context: TenantBackupStepContext,
    ...args: Parameters<RestoreInput['loadValidatedDataset']>
  ): ReturnType<RestoreInput['loadValidatedDataset']>;
  assertValidatedUnpublishedPlan(
    context: TenantBackupStepContext,
    ...args: Parameters<RestoreInput['assertValidatedUnpublishedPlan']>
  ): ReturnType<RestoreInput['assertValidatedUnpublishedPlan']>;
  /** Verify installed non-SQL stores and side-effect holds before activation. */
  verifyOtherStores(context: TenantBackupStepContext, planDigest: string): Promise<void>;
  /** Persist a recoverable activation intent without publishing routing. */
  prepareActivation(context: TenantBackupStepContext, planDigest: string): Promise<void>;
  /** Idempotently publish the validated target set. A lost response must be safe to retry. */
  activate(context: TenantBackupStepContext, planDigest: string): Promise<void>;
  /** Read routing and every selected store after publication. */
  verifyActivation(context: TenantBackupStepContext, planDigest: string): Promise<void>;
}

function fail(): never {
  throw new Error('backup_import_dispatch_invalid');
}
function validateAdapter(adapter: TenantBackupInstalledImportAdapter): void {
  if (typeof adapter.datasets !== 'function') fail();
  let datasets: readonly TenantPortableDataset[];
  try {
    datasets = adapter.datasets({
      settings: true,
      users: true,
      admin: true,
      artifacts: true,
      logs: { audit: true, other: true, sensitive: true, period: 'all' },
    });
  } catch {
    return fail();
  }
  if (
    !datasets.length ||
    datasets.length > 4096 ||
    new Set(datasets.map((dataset) => dataset.id)).size !== datasets.length ||
    datasets.some(
      (dataset) =>
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(dataset.id) ||
        dataset.store !== 'database' ||
        dataset.disposition !== 'include'
    )
  )
    fail();
}

function activationCursor(value: string | null, expectedDigest?: string) {
  if (value === null) {
    if (expectedDigest === undefined) fail();
    return { version: 1 as const, planDigest: expectedDigest };
  }
  try {
    const cursor = JSON.parse(value) as Record<string, unknown>;
    if (
      !cursor ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !== 'planDigest,version' ||
      cursor.version !== 1 ||
      typeof cursor.planDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(cursor.planDigest) ||
      (expectedDigest !== undefined && cursor.planDigest !== expectedDigest)
    )
      fail();
    return cursor as { version: 1; planDigest: string };
  } catch {
    return fail();
  }
}

/** Dispatch one import phase; the common scheduler owns its outer lease and checkpoint. */
export async function runTenantBackupImportOperationStep(
  env: Env,
  context: TenantBackupStepContext,
  adapter: TenantBackupInstalledImportAdapter,
  now: () => number = Date.now
): Promise<TenantBackupStepResult> {
  if (context.operation.kind !== 'import' || context.operation.state !== 'running') fail();
  validateAdapter(adapter);
  if (context.operation.phase === 'prepare')
    return runTenantBackupImportPreparation(env, context, adapter.datasets, now);
  if (context.operation.phase === 'decode_input')
    return runTenantBackupImportDecode(env, context, adapter.datasets, now);
  if (
    [
      'validate_input_modules',
      'validate_sqlite_dataset',
      'advance_validation_dataset',
      'validate_input_references',
      'finalize_input_validation',
    ].includes(context.operation.phase)
  )
    return runTenantBackupImportValidation(
      env,
      context,
      {
        datasets: adapter.datasets,
        loadPolicy: (datasetId) => adapter.loadPolicy(context, datasetId),
        assertSources: () => adapter.assertSources(context),
      },
      now
    );
  if (context.operation.phase === 'prepare_restore_plan') {
    const targets = await adapter.restoreTargets(context);
    return runTenantBackupImportRestorePlanning(
      env,
      context,
      { targets, assertSources: () => adapter.assertSources(context) },
      now
    );
  }
  if (
    [
      'start_sqlite_restore_sequence',
      'apply_sqlite_dataset',
      'verify_sqlite_dataset',
      'advance_restore_dataset',
      'verify_restore_targets',
      'verify_sealed_sqlite_datasets',
    ].includes(context.operation.phase)
  ) {
    const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
    let cursor: { sequenceOrdinal?: unknown };
    try {
      cursor = JSON.parse(context.operation.cursor_json ?? 'null') as typeof cursor;
    } catch {
      return fail();
    }
    if (!cursor || !Number.isSafeInteger(cursor.sequenceOrdinal)) fail();
    await adapter.assertSources(context);
    const result = await runSqliteRestoreSequenceStep(context, {
      inventory: new DatabaseTenantBackupRestorePlanInventory(database, context.lease, now),
      now,
      resolve: (resourceId, provisioningId) =>
        adapter.resolveRestoreTarget(context, resourceId, provisioningId),
      loadValidatedDataset: (job) => adapter.loadValidatedDataset(context, job),
      assertValidatedUnpublishedPlan: (digest) =>
        adapter.assertValidatedUnpublishedPlan(context, digest),
      sequenceOrdinal: cursor.sequenceOrdinal as number,
    });
    await adapter.assertSources(context);
    return result;
  }
  if (
    [
      'verify_other_restore_stores',
      'prepare_restore_activation',
      'activate_restore',
      'verify_restore_activation',
    ].includes(context.operation.phase)
  ) {
    const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
    const inventory = new DatabaseTenantBackupRestorePlanInventory(database, context.lease, now);
    const head = await inventory.headForLease(context.lease);
    if (head.state !== 'sealed') fail();
    const cursor =
      context.operation.phase === 'verify_other_restore_stores'
        ? activationCursor(null, head.chain_digest)
        : activationCursor(context.operation.cursor_json, head.chain_digest);
    await adapter.assertSources(context);
    if (context.operation.phase === 'verify_other_restore_stores')
      await adapter.verifyOtherStores(context, cursor.planDigest);
    else if (context.operation.phase === 'prepare_restore_activation')
      await adapter.prepareActivation(context, cursor.planDigest);
    else if (context.operation.phase === 'activate_restore')
      await adapter.activate(context, cursor.planDigest);
    else await adapter.verifyActivation(context, cursor.planDigest);
    await adapter.assertSources(context);
    const phase = {
      verify_other_restore_stores: 'prepare_restore_activation',
      prepare_restore_activation: 'activate_restore',
      activate_restore: 'verify_restore_activation',
      verify_restore_activation: 'ready',
    }[context.operation.phase];
    if (!phase) fail();
    return {
      phase,
      cursor: JSON.stringify(cursor),
      disposition: context.operation.phase === 'verify_restore_activation' ? 'ready' : 'continue',
    };
  }
  fail();
}
