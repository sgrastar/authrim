import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { TenantBackupRestorePreview } from '@authrim/ar-lib-core/services/tenant-portability/restore-preview';
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
const safePreview = (): TenantBackupRestorePreview => ({
  version: 1 as const,
  planDigest: 'ab'.repeat(32),
  prerequisites: [],
  deliverySafety: {
    version: 1 as const,
    sourceEnvironment: 'stopped' as const,
    historicalDelivery: 'hold' as const,
    scheduledCatchup: 'disabled' as const,
    activation: 'new_events_only' as const,
  },
  blockers: [],
});
const adapter = {
  datasets: () => [dataset],
  loadPolicy: vi.fn(async () => ({ dataset })),
  assertSources: vi.fn(async () => {}),
  restoreTargets: vi.fn(async () => [{}]),
  resolveRestoreTarget: vi.fn(async () => ({})),
  loadValidatedDataset: vi.fn(async () => ({})),
  assertValidatedUnpublishedPlan: vi.fn(async () => {}),
  restoreOtherStores: vi.fn(
    async (): Promise<{ cursor: string | null; done: boolean }> => ({ cursor: null, done: true })
  ),
  verifyOtherStores: vi.fn(
    async (): Promise<{ cursor: string | null; done: boolean }> => ({ cursor: null, done: true })
  ),
  previewRestore: vi.fn(async () => safePreview()),
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
  adapter.previewRestore.mockResolvedValue(safePreview());
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

it('waits for approval after sealing the restore plan and resumes from its immutable cursor', async () => {
  const restoreCursor = JSON.stringify({ version: 1, sequenceOrdinal: 0 });
  mocks.plan.mockResolvedValueOnce({
    phase: 'start_sqlite_restore_sequence',
    cursor: restoreCursor,
    disposition: 'continue',
  });
  const waiting = await runTenantBackupImportOperationStep(
    env,
    { ...context, operation: { ...context.operation, phase: 'prepare_restore_plan' } },
    adapter as never,
    () => 100
  );
  expect(waiting.phase).toBe('await_restore_approval');
  expect(waiting.disposition).toBe('wait');
  expect(adapter.previewRestore).toHaveBeenCalledWith(expect.anything(), 'ab'.repeat(32));

  const approved = await runTenantBackupImportOperationStep(
    env,
    {
      ...context,
      operation: {
        ...context.operation,
        phase: 'await_restore_approval',
        cursor_json: waiting.cursor,
      },
    },
    adapter as never,
    () => 100
  );
  expect(approved).toEqual({
    phase: 'start_sqlite_restore_sequence',
    cursor: restoreCursor,
    disposition: 'continue',
  });
});

it('refuses to start target writes when blockers appear or the approved preview changes', async () => {
  const restoreCursor = JSON.stringify({ version: 1, sequenceOrdinal: 0 });
  mocks.plan.mockResolvedValue({
    phase: 'start_sqlite_restore_sequence',
    cursor: restoreCursor,
    disposition: 'continue',
  });
  const waiting = await runTenantBackupImportOperationStep(
    env,
    { ...context, operation: { ...context.operation, phase: 'prepare_restore_plan' } },
    adapter as never,
    () => 100
  );
  adapter.previewRestore.mockResolvedValueOnce({
    ...safePreview(),
    blockers: [{ code: 'delivery_safety_unconfirmed' as const, subjectId: null }],
  });
  await expect(
    runTenantBackupImportOperationStep(
      env,
      {
        ...context,
        operation: {
          ...context.operation,
          phase: 'await_restore_approval',
          cursor_json: waiting.cursor,
        },
      },
      adapter as never,
      () => 100
    )
  ).rejects.toThrow('backup_import_dispatch_invalid');
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

it('wraps the SQL cursor while restoring other stores in durable pages', async () => {
  const sequenceCursor = {
    version: 1,
    sequenceOrdinal: 3,
    jobIndex: 2,
    datasetCursor: null,
  };
  mocks.restore.mockResolvedValueOnce({
    phase: 'restore_other_stores',
    cursor: JSON.stringify(sequenceCursor),
    disposition: 'continue',
  });
  const transition = await runTenantBackupImportOperationStep(
    env,
    {
      ...context,
      operation: {
        ...context.operation,
        phase: 'advance_restore_dataset',
        cursor_json: JSON.stringify({ version: 1, sequenceOrdinal: 3 }),
      },
    },
    adapter as never,
    () => 100
  );
  if (!transition.cursor) throw new Error('expected_cursor');
  const wrapped = JSON.parse(transition.cursor) as Record<string, unknown>;
  expect(transition.phase).toBe('restore_other_stores');
  expect(wrapped).toEqual({
    version: 1,
    planDigest: 'ab'.repeat(32),
    sequenceCursor,
    storeCursor: null,
  });

  adapter.restoreOtherStores.mockResolvedValueOnce({ cursor: '{"page":2}', done: false });
  const page = await runTenantBackupImportOperationStep(
    env,
    {
      ...context,
      operation: {
        ...context.operation,
        phase: 'restore_other_stores',
        cursor_json: transition.cursor,
      },
    },
    adapter as never,
    () => 100
  );
  if (!page.cursor) throw new Error('expected_cursor');
  expect(JSON.parse(page.cursor)).toEqual({ ...wrapped, storeCursor: '{"page":2}' });
  expect(page.phase).toBe('restore_other_stores');

  const completed = await runTenantBackupImportOperationStep(
    env,
    {
      ...context,
      operation: {
        ...context.operation,
        phase: 'restore_other_stores',
        cursor_json: page.cursor,
      },
    },
    adapter as never,
    () => 100
  );
  expect(completed).toEqual({
    phase: 'verify_restore_targets',
    cursor: JSON.stringify(sequenceCursor),
    disposition: 'continue',
  });
  expect(adapter.assertSources).toHaveBeenCalledTimes(6);
});

it.each([
  { cursor: null, done: false },
  { cursor: '{"page":1}', done: true },
  { cursor: '{"page":1}', done: false },
  { cursor: 'not-json', done: false },
] as const)('rejects invalid or stalled non-SQL restore progress %#', async (invalidResult) => {
  const cursor = JSON.stringify({
    version: 1,
    planDigest: 'ab'.repeat(32),
    sequenceCursor: { version: 1, sequenceOrdinal: 3, jobIndex: 2, datasetCursor: null },
    storeCursor: invalidResult.cursor === '{"page":1}' ? '{"page":1}' : null,
  });
  adapter.restoreOtherStores.mockResolvedValueOnce(invalidResult);
  await expect(
    runTenantBackupImportOperationStep(
      env,
      {
        ...context,
        operation: { ...context.operation, phase: 'restore_other_stores', cursor_json: cursor },
      },
      adapter as never,
      () => 100
    )
  ).rejects.toThrow('dispatch_invalid');
});

it.each([
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
          cursor_json: cursor,
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

it('verifies other stores in durable pages before activation preparation', async () => {
  mocks.restore.mockResolvedValueOnce({
    phase: 'verify_other_restore_stores',
    cursor: '{"sql":"complete"}',
    disposition: 'continue',
  });
  const transition = await runTenantBackupImportOperationStep(
    env,
    {
      ...context,
      operation: {
        ...context.operation,
        phase: 'verify_sealed_sqlite_datasets',
        cursor_json: JSON.stringify({ version: 1, sequenceOrdinal: 3 }),
      },
    },
    adapter as never,
    () => 100
  );
  const initial = JSON.stringify({
    version: 1,
    planDigest: 'ab'.repeat(32),
    storeCursor: null,
  });
  expect(transition).toEqual({
    phase: 'verify_other_restore_stores',
    cursor: initial,
    disposition: 'continue',
  });
  adapter.verifyOtherStores.mockResolvedValueOnce({ cursor: '{"after":"client-a"}', done: false });
  const page = await runTenantBackupImportOperationStep(
    env,
    {
      ...context,
      operation: {
        ...context.operation,
        phase: 'verify_other_restore_stores',
        cursor_json: initial,
      },
    },
    adapter as never,
    () => 100
  );
  expect(page.phase).toBe('verify_other_restore_stores');
  const completed = await runTenantBackupImportOperationStep(
    env,
    {
      ...context,
      operation: { ...context.operation, phase: page.phase, cursor_json: page.cursor },
    },
    adapter as never,
    () => 100
  );
  expect(completed).toEqual({
    phase: 'prepare_restore_activation',
    cursor: JSON.stringify({ version: 1, planDigest: 'ab'.repeat(32) }),
    disposition: 'continue',
  });
});

it('rejects unknown phases, environment-only records, or duplicate installed datasets', async () => {
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
      datasets: () => [{ ...dataset, store: 'environment' }],
    } as never)
  ).rejects.toThrow('dispatch_invalid');
  await expect(
    runTenantBackupImportOperationStep(env, context, {
      ...adapter,
      datasets: () => [dataset, dataset],
    } as never)
  ).rejects.toThrow('dispatch_invalid');
});
