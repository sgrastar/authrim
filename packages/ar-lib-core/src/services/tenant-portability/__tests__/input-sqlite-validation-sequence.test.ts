import { beforeEach, expect, it, vi } from 'vitest';
import type { TenantBackupExecutionInventory } from '../execution-inventory';
import type { TenantBackupStepContext } from '../operation-executor';
import { runTenantBackupSqliteInputValidationSequenceStep } from '../input-sqlite-validation-sequence';

const mocks = vi.hoisted(() => ({
  loadPlanned: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  datasetStart: vi.fn<(...args: unknown[]) => Promise<number>>(),
  replay: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  validateDataset: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  finalizeDataset: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  validateReferences: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  finalizeInput: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  readRow: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('../input-plan', () => ({
  loadPlannedTenantBackupInput: (...args: unknown[]) => mocks.loadPlanned(...args),
}));
vi.mock('../input-receipts', () => ({
  TenantBackupInputReceipts: class {
    datasetStart(...args: unknown[]) {
      return mocks.datasetStart(...args);
    }
    replay(...args: unknown[]) {
      return mocks.replay(...args);
    }
  },
}));
vi.mock('../validate-sqlite-input-step', () => ({
  runSqliteInputValidationStep: (...args: unknown[]) => mocks.validateDataset(...args),
}));
vi.mock('../dataset-inspection-receipt', () => ({
  finalizeSqliteDatasetInspection: (...args: unknown[]) => mocks.finalizeDataset(...args),
}));
vi.mock('../validate-references-step', () => ({
  runTenantBackupReferenceValidationStep: (...args: unknown[]) => mocks.validateReferences(...args),
}));
vi.mock('../finalize-input-validation', () => ({
  finalizeTenantBackupInputValidation: (...args: unknown[]) => mocks.finalizeInput(...args),
}));
vi.mock('../sqlite-input-row-source', () => ({
  readNextSqliteInputRow: (...args: unknown[]) => mocks.readRow(...args),
}));

const bundleIds = ['ab'.repeat(16), 'cd'.repeat(16)];
const digest = 'ef'.repeat(32);
const dataset = {
  id: 'core.clients',
  module: 'applications' as const,
  kind: 'settings' as const,
  store: 'database' as const,
  schemaVersion: 1,
  disposition: 'include' as const,
};
const manifest = {
  formatVersion: 1 as const,
  bundleId: bundleIds[0],
  source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: '0.4.2' },
  snapshotId: 'snapshot',
  boundaryUnixMs: 10,
  inventoryDigestSha256: '12'.repeat(32),
  selection: {
    settings: true,
    users: false,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
  },
  datasets: [dataset],
};
const policy = {
  dataset,
  schema: {
    table: 'oauth_clients',
    columns: ['client_id', 'tenant_id'],
    primaryKey: ['client_id'],
    uniqueKeys: [],
    tenantColumn: 'tenant_id',
  },
  inspectRow: vi.fn(async () => []),
};
const key = { envelope: new Uint8Array(93), contentKey: {} as CryptoKey };
const authorize = vi.fn(async () => {});
const loadPolicy = vi.fn(async () => policy);
const loadInput = vi.fn(async (_ordinal: number, bundleId: string) => ({
  expected: {
    bundleId,
    source: manifest.source,
    selection: manifest.selection,
    datasets: [dataset],
  },
  session: key,
  loadPolicy,
  assertAuthorized: authorize,
}));
const head = { state: 'sealed', item_count: 1, chain_digest: digest };
const inventory = {
  headForLease: vi.fn(async () => head),
  readPage: vi.fn(async (ordinal: number) => [
    { ordinal, item_id: `backup-input:${bundleIds[ordinal]}` },
  ]),
} as unknown as TenantBackupExecutionInventory;
const base = {
  operation: {
    id: 'operation',
    tenant_id: 'tenant',
    kind: 'import',
    state: 'running',
    phase: 'validate_input_modules',
    cursor_json: JSON.stringify({
      version: 1,
      sessionId: 'validation-session',
      inputOrdinal: 0,
      datasetIndex: 0,
    }),
  },
  lease: { tenantId: 'tenant', operationId: 'operation', owner: 'worker', fencingToken: 1 },
  signal: new AbortController().signal,
} as unknown as TenantBackupStepContext;

function run(
  context: TenantBackupStepContext = base,
  ownsDataset?: (ordinal: number, bundleId: string, datasetId: string) => Promise<boolean>
) {
  return runTenantBackupSqliteInputValidationSequenceStep(context, {
    database: {} as never,
    bucket: {} as never,
    inventory,
    now: () => 100,
    loadInput,
    ...(ownsDataset ? { ownsDataset } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(inventory.headForLease).mockResolvedValue(head as never);
  vi.mocked(inventory.readPage).mockImplementation(async (ordinal: number) => [
    { ordinal, item_id: `backup-input:${bundleIds[ordinal]}` } as never,
  ]);
  mocks.loadPlanned.mockResolvedValue({
    identity: { key: 'input', version: 'v1', etag: 'etag', size: 1000 },
    limits: { maxFrames: 100, maxTotalBytes: 1000 },
    manifest,
  });
  mocks.datasetStart.mockResolvedValue(2);
  mocks.validateDataset.mockResolvedValue({
    phase: 'validate_sqlite_dataset',
    cursor: '{"inner":1}',
    disposition: 'continue',
  });
  mocks.finalizeDataset.mockResolvedValue({});
  mocks.validateReferences.mockResolvedValue({
    phase: 'finalize_input_validation',
    cursor: '{"references":1}',
    disposition: 'continue',
  });
  mocks.finalizeInput.mockResolvedValue(undefined);
  mocks.readRow.mockResolvedValue(null);
});

it('starts the installed SQL policy at the exact ordered input and dataset', async () => {
  const result = await run();
  expect(result.phase).toBe('validate_sqlite_dataset');
  const outer = JSON.parse(result.cursor ?? 'null');
  expect(outer).toMatchObject({
    version: 1,
    sessionId: 'validation-session',
    inputOrdinal: 0,
    datasetIndex: 0,
  });
  expect(JSON.parse(outer.datasetCursor)).toEqual({
    version: 1,
    sessionId: 'validation-session',
    bundleId: bundleIds[0],
    datasetId: dataset.id,
    sourceCursor: null,
    rows: 0,
  });
  expect(loadInput).toHaveBeenCalledWith(0, bundleIds[0]);
  expect(loadPolicy).toHaveBeenCalledWith(dataset.id);
  expect(authorize).toHaveBeenCalled();
});

it('skips an overlapping dataset owned by a newer input', async () => {
  const ownsDataset = vi.fn(async () => false);
  await expect(run(base, ownsDataset)).resolves.toEqual({
    phase: 'validate_input_modules',
    cursor: JSON.stringify({
      version: 1,
      sessionId: 'validation-session',
      inputOrdinal: 0,
      datasetIndex: 1,
    }),
    disposition: 'continue',
  });
  expect(ownsDataset).toHaveBeenCalledWith(0, bundleIds[0], dataset.id);
  expect(loadPolicy).not.toHaveBeenCalled();
});

it.each(['kv', 'durable_object', 'object'] as const)(
  'starts the same installed row validation pipeline for %s datasets',
  async (store) => {
    const recordDataset = { ...dataset, id: `settings.${store}`, store };
    mocks.loadPlanned.mockResolvedValueOnce({
      identity: { key: 'input', version: 'v1', etag: 'etag', size: 1000 },
      limits: { maxFrames: 100, maxTotalBytes: 1000 },
      manifest: { ...manifest, datasets: [recordDataset] },
    });
    loadInput.mockResolvedValueOnce({
      expected: {
        bundleId: bundleIds[0],
        source: manifest.source,
        selection: manifest.selection,
        datasets: [recordDataset],
      },
      session: key,
      loadPolicy: vi.fn(async () => ({ ...policy, dataset: recordDataset })),
      assertAuthorized: authorize,
    });
    await expect(run()).resolves.toMatchObject({ phase: 'validate_sqlite_dataset' });
  }
);

it('runs one resumable SQL validation slice through immutable input receipts', async () => {
  const started = await run();
  const result = await run({
    ...base,
    operation: { ...base.operation, phase: started.phase, cursor_json: started.cursor },
  });
  expect(result.phase).toBe('validate_sqlite_dataset');
  expect(JSON.parse(JSON.parse(result.cursor ?? 'null').datasetCursor)).toEqual({ inner: 1 });
  expect(mocks.datasetStart).toHaveBeenCalledWith(bundleIds[0], dataset.id, expect.any(Object));
  const request = mocks.validateDataset.mock.calls[0]?.[1] as {
    readNextRow(cursor: string | null): Promise<unknown>;
  };
  await request.readNextRow(null);
  expect(mocks.readRow).toHaveBeenCalledWith(
    expect.objectContaining({ datasetId: dataset.id, firstSequence: 2, planDigest: digest })
  );
});

it('records dataset completion, then advances to reference validation only after all inputs', async () => {
  const inner = JSON.stringify({
    version: 1,
    sessionId: 'validation-session',
    bundleId: bundleIds[0],
    datasetId: dataset.id,
    sourceCursor: 'row:1',
    rows: 1,
  });
  const advanced = await run({
    ...base,
    operation: {
      ...base.operation,
      phase: 'advance_validation_dataset',
      cursor_json: JSON.stringify({
        version: 1,
        sessionId: 'validation-session',
        inputOrdinal: 0,
        datasetIndex: 0,
        datasetCursor: inner,
      }),
    },
  });
  expect(mocks.finalizeDataset).toHaveBeenCalledTimes(1);
  expect(advanced).toEqual({
    phase: 'validate_input_modules',
    cursor: JSON.stringify({
      version: 1,
      sessionId: 'validation-session',
      inputOrdinal: 0,
      datasetIndex: 1,
    }),
    disposition: 'continue',
  });
  const references = await run({
    ...base,
    operation: { ...base.operation, cursor_json: advanced.cursor },
  });
  expect(references.phase).toBe('validate_input_references');
  expect(JSON.parse(references.cursor ?? 'null')).toEqual({
    version: 1,
    sessionId: 'validation-session',
    inputSetDigest: digest,
    after: '',
    examined: 0,
    unresolvedProvenance: 0,
  });
});

it('delegates reference pages and persists whole-input completion before restore planning', async () => {
  const referenceCursor = JSON.stringify({
    version: 1,
    sessionId: 'validation-session',
    inputSetDigest: digest,
    after: '',
    examined: 0,
    unresolvedProvenance: 0,
  });
  expect(
    await run({
      ...base,
      operation: {
        ...base.operation,
        phase: 'validate_input_references',
        cursor_json: referenceCursor,
      },
    })
  ).toEqual({
    phase: 'finalize_input_validation',
    cursor: '{"references":1}',
    disposition: 'continue',
  });
  const finalized = await run({
    ...base,
    operation: {
      ...base.operation,
      phase: 'finalize_input_validation',
      cursor_json: JSON.stringify({
        version: 1,
        sessionId: 'validation-session',
        inputSetDigest: digest,
        after: 'edge',
        examined: 1,
        unresolvedProvenance: 0,
      }),
    },
  });
  expect(mocks.finalizeInput).toHaveBeenCalledTimes(1);
  expect(finalized).toEqual({
    phase: 'prepare_restore_plan',
    cursor: JSON.stringify({
      version: 1,
      sessionId: 'validation-session',
      inputSetDigest: digest,
    }),
    disposition: 'continue',
  });
});

it('stops on environment-only records, reordered inputs, or changed inventory state', async () => {
  mocks.loadPlanned.mockResolvedValueOnce({
    identity: {},
    limits: {},
    manifest: { ...manifest, datasets: [{ ...dataset, store: 'environment' }] },
  });
  await expect(run()).rejects.toThrow('sequence_invalid');
  expect(mocks.validateDataset).not.toHaveBeenCalled();

  vi.mocked(inventory.readPage).mockResolvedValueOnce([
    { ordinal: 0, item_id: `backup-input:${bundleIds[1]}` } as never,
  ]);
  loadInput.mockRejectedValueOnce(new Error('input_order_changed'));
  await expect(run()).rejects.toThrow('input_order_changed');

  vi.mocked(inventory.headForLease).mockResolvedValueOnce({ ...head, state: 'building' } as never);
  await expect(run()).rejects.toThrow('sequence_invalid');
});
