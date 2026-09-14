import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { runTenantBackupImportOperationStep } from '../tenant-backup-import-dispatcher';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  decode: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  validate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  plan: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  restore: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  database: {},
}));
vi.mock('../tenant-backup-execution', () => ({
  runTenantBackupImportPreparation: (...args: unknown[]) => mocks.prepare(...args),
  runTenantBackupImportDecode: (...args: unknown[]) => mocks.decode(...args),
  runTenantBackupImportValidation: (...args: unknown[]) => mocks.validate(...args),
  runTenantBackupImportRestorePlanning: (...args: unknown[]) => mocks.plan(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/restore-sqlite-sequence', () => ({
  runSqliteRestoreSequenceStep: (...args: unknown[]) => mocks.restore(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/restore-plan-inventory', () => ({
  DatabaseTenantBackupRestorePlanInventory: class {
    async headForLease() {
      return { state: 'sealed', chain_digest: 'ab'.repeat(32) };
    }
  },
}));
vi.mock('@authrim/ar-lib-core', () => ({
  requireDedicatedAdminDatabaseAdapter: () => mocks.database,
}));

const dataset = {
  id: 'core.clients',
  module: 'applications' as const,
  kind: 'settings' as const,
  store: 'database' as const,
  schemaVersion: 1,
  disposition: 'include' as const,
};
const adapter = {
  datasets: () => [dataset],
  loadPolicy: vi.fn(async () => ({ dataset })),
  assertSources: vi.fn(async () => {}),
  restoreTargets: vi.fn(async () => [{}]),
  resolveRestoreTarget: vi.fn(async () => ({})),
  loadValidatedDataset: vi.fn(async () => ({})),
  assertValidatedUnpublishedPlan: vi.fn(async () => {}),
  verifyOtherStores: vi.fn(async () => {}),
  prepareActivation: vi.fn(async () => {}),
  activate: vi.fn(async () => {}),
  verifyActivation: vi.fn(async () => {}),
};
const context = {
  operation: {
    id: 'operation',
    tenant_id: 'tenant',
    kind: 'import',
    state: 'running',
    phase: 'prepare',
    cursor_json: null,
  },
  lease: { operationId: 'operation', tenantId: 'tenant', owner: 'worker', fencingToken: 1 },
  signal: new AbortController().signal,
} as unknown as TenantBackupStepContext;
const env = {} as Env;
const next = { phase: 'next', cursor: '{}', disposition: 'continue' as const };

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of [mocks.prepare, mocks.decode, mocks.validate, mocks.plan, mocks.restore])
    mock.mockResolvedValue(next);
  adapter.restoreTargets.mockResolvedValue([{}]);
});

it.each([
  ['prepare', 'prepare'],
  ['decode_input', 'decode'],
  ['validate_input_modules', 'validate'],
  ['validate_sqlite_dataset', 'validate'],
  ['advance_validation_dataset', 'validate'],
  ['validate_input_references', 'validate'],
  ['finalize_input_validation', 'validate'],
  ['prepare_restore_plan', 'plan'],
] as const)('routes %s through the installed import adapter (%s)', async (phase, selected) => {
  const result = await runTenantBackupImportOperationStep(
    env,
    { ...context, operation: { ...context.operation, phase } },
    adapter as never,
    () => 100
  );
  expect(result).toEqual(next);
  expect(mocks[selected]).toHaveBeenCalledTimes(1);
  if (phase === 'prepare_restore_plan') expect(adapter.restoreTargets).toHaveBeenCalledTimes(1);
});

it('routes SQL restore phases through the separate restore-plan inventory', async () => {
  const result = await runTenantBackupImportOperationStep(
    env,
    {
      ...context,
      operation: {
        ...context.operation,
        phase: 'apply_sqlite_dataset',
        cursor_json: JSON.stringify({ version: 1, sequenceOrdinal: 3 }),
      },
    },
    adapter as never,
    () => 100
  );
  expect(result).toEqual(next);
  const request = mocks.restore.mock.calls[0]?.[1] as {
    sequenceOrdinal: number;
    resolve(resourceId: string, provisioningId: string): Promise<unknown>;
    loadValidatedDataset(job: unknown): Promise<unknown>;
    assertValidatedUnpublishedPlan(digest: string): Promise<void>;
  };
  expect(request.sequenceOrdinal).toBe(3);
  await request.resolve('resource', 'provisioning');
  await request.loadValidatedDataset({ id: 'job' });
  await request.assertValidatedUnpublishedPlan('ab'.repeat(32));
  const resolveCall = adapter.resolveRestoreTarget.mock.calls[0] as unknown as [
    TenantBackupStepContext,
    string,
    string,
  ];
  const loadCall = adapter.loadValidatedDataset.mock.calls[0] as unknown as [
    TenantBackupStepContext,
    unknown,
  ];
  const guardCall = adapter.assertValidatedUnpublishedPlan.mock.calls[0] as unknown as [
    TenantBackupStepContext,
    string,
  ];
  expect([resolveCall[0].operation.id, ...resolveCall.slice(1)]).toEqual([
    'operation',
    'resource',
    'provisioning',
  ]);
  expect(loadCall[0].operation.id).toBe('operation');
  expect(loadCall[1]).toEqual({ id: 'job' });
  expect([guardCall[0].operation.id, guardCall[1]]).toEqual(['operation', 'ab'.repeat(32)]);
  expect(adapter.assertSources).toHaveBeenCalledTimes(2);
});

it.each([
  ['verify_other_restore_stores', 'prepare_restore_activation', 'verifyOtherStores', 'continue'],
  ['prepare_restore_activation', 'activate_restore', 'prepareActivation', 'continue'],
  ['activate_restore', 'verify_restore_activation', 'activate', 'continue'],
  ['verify_restore_activation', 'ready', 'verifyActivation', 'ready'],
] as const)(
  'runs %s against the sealed plan before advancing to %s',
  async (phase, expectedPhase, callback, disposition) => {
    const cursor = JSON.stringify({ version: 1, planDigest: 'ab'.repeat(32) });
    const result = await runTenantBackupImportOperationStep(
      env,
      {
        ...context,
        operation: {
          ...context.operation,
          phase,
          cursor_json: phase === 'verify_other_restore_stores' ? '{}' : cursor,
        },
      },
      adapter as never,
      () => 100
    );
    expect(result).toEqual({ phase: expectedPhase, cursor, disposition });
    const activationCall = adapter[callback].mock.calls[0] as unknown as [
      TenantBackupStepContext,
      string,
    ];
    expect([activationCall[0].operation.id, activationCall[1]]).toEqual([
      'operation',
      'ab'.repeat(32),
    ]);
    expect(adapter.assertSources).toHaveBeenCalledTimes(2);
  }
);

it('rejects unknown phases and non-SQL or duplicate installed datasets', async () => {
  await expect(
    runTenantBackupImportOperationStep(
      env,
      { ...context, operation: { ...context.operation, phase: 'unknown' } },
      adapter as never
    )
  ).rejects.toThrow('dispatch_invalid');
  await expect(
    runTenantBackupImportOperationStep(env, context, {
      ...adapter,
      datasets: () => [{ ...dataset, store: 'object' }],
    } as never)
  ).rejects.toThrow('dispatch_invalid');
  await expect(
    runTenantBackupImportOperationStep(env, context, {
      ...adapter,
      datasets: () => [dataset, dataset],
    } as never)
  ).rejects.toThrow('dispatch_invalid');
});
