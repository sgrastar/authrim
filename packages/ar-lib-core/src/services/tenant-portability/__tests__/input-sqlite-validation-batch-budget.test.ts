import { beforeEach, expect, it, vi } from 'vitest';
import type { TenantBackupExecutionInventory } from '../execution-inventory';
import type { TenantBackupStepContext } from '../operation-executor';
import { readNextTenantBackupContainerRow } from '../container-dataset-reader';
import { runTenantBackupSqliteInputValidationSequenceStep } from '../input-sqlite-validation-sequence';

const mocks = vi.hoisted(() => ({
  loadPlanned: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  finalizeBatch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  recordInspectionBatch: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  referencesPerRow: 10,
  inspected: 0,
  canReadAll: true,
}));
vi.mock('../input-plan', () => ({
  loadPlannedTenantBackupInput: (...args: unknown[]) => mocks.loadPlanned(...args),
}));
vi.mock('../dataset-inspection-receipt', () => ({
  finalizeSqliteDatasetInspection: vi.fn(),
  finalizeSqliteDatasetBatchInspections: (...args: unknown[]) => mocks.finalizeBatch(...args),
}));
vi.mock('../validation-index', () => ({
  DatabaseTenantBundleReferenceIndex: {
    resume: async () => ({ recordInspectionBatch: mocks.recordInspectionBatch }),
  },
}));
vi.mock('../sqlite-input-inspection', () => ({
  inspectSqliteInputRow: async (input: {
    rowOrdinal: number;
    manifest: { bundleId: string };
    index: {
      recordOnce(bundleId: string, sourceId: string, record: unknown): Promise<boolean>;
      referenceOnce(bundleId: string, sourceEdgeId: string, dependency: unknown): Promise<void>;
    };
  }) => {
    mocks.inspected++;
    const source = `row:${input.rowOrdinal}`;
    await input.index.recordOnce(input.manifest.bundleId, source, { id: source });
    for (let edge = 0; edge < mocks.referencesPerRow; edge++)
      await input.index.referenceOnce(input.manifest.bundleId, `${source}:edge:${edge}`, {});
  },
}));

const bundleId = 'ab'.repeat(16);
const datasets = ['core.a', 'core.b'].map((id) => ({
  id,
  module: 'applications' as const,
  kind: 'settings' as const,
  store: 'database' as const,
  schemaVersion: 1,
  disposition: 'include' as const,
}));
const manifest = {
  formatVersion: 1 as const,
  bundleId,
  source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: '0.4.2' },
  snapshotId: 'snapshot',
  boundaryUnixMs: 10,
  inventoryDigestSha256: '12'.repeat(32),
  selection: {},
  datasets,
};
const policies = datasets.map((dataset) => ({ dataset, schema: { table: dataset.id } }));
const inventory = {
  headForLease: vi.fn(async () => ({
    state: 'sealed',
    item_count: 1,
    chain_digest: 'ef'.repeat(32),
  })),
  readPage: vi.fn(async () => [{ ordinal: 0, item_id: `backup-input:${bundleId}` }]),
} as unknown as TenantBackupExecutionInventory;
const context = {
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

function rows(count: number) {
  return new TextEncoder().encode(
    Array.from({ length: count }, (_, index) => `{"id":["text","${index}"]}\n`).join('')
  );
}

function run(rowsPerDataset: number, firstEmpty = false) {
  const bytes = rows(rowsPerDataset);
  const empty = new Uint8Array();
  return runTenantBackupSqliteInputValidationSequenceStep(context, {
    database: {} as never,
    inventory,
    now: () => 100,
    loadInput: async () => ({
      expected: {
        bundleId,
        source: manifest.source,
        selection: manifest.selection,
        datasets,
      } as never,
      session: { envelope: new Uint8Array(93), contentKey: {} as CryptoKey },
      loadPolicy: async (id: string) => policies.find(({ dataset }) => dataset.id === id) as never,
      loadPolicies: async () => policies as never,
      openDataset: async (id: string) => {
        const value = firstEmpty && id === 'core.a' ? empty : bytes;
        return {
          id,
          rows: value === empty ? 0 : rowsPerDataset,
          bytes: value.length,
          readAll: async () => value,
          canReadAll: mocks.canReadAll,
          readNextRow: async (cursor: string | null) =>
            readNextTenantBackupContainerRow(value, cursor),
        };
      },
      assertAuthorized: async () => {},
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.referencesPerRow = 10;
  mocks.inspected = 0;
  mocks.canReadAll = true;
  mocks.loadPlanned.mockResolvedValue({
    identity: { key: 'input', version: 'v1', etag: 'etag', size: 1000 },
    limits: { maxFrames: 100, maxTotalBytes: 1000 },
    manifest,
  });
  mocks.finalizeBatch.mockResolvedValue(undefined);
  mocks.recordInspectionBatch.mockResolvedValue(undefined);
});

it('stops a combined batch before its index entries exceed the write budget', async () => {
  // 300 rows × (1 record + 10 references) = 3,300 entries per dataset; two would be 6,600.
  const result = await run(300);
  expect(mocks.recordInspectionBatch).toHaveBeenCalledTimes(1);
  const written = mocks.recordInspectionBatch.mock.calls[0]?.[0] as {
    records: unknown[];
    references: unknown[];
  };
  expect(written.records).toHaveLength(300);
  expect(written.references).toHaveLength(3000);
  expect(JSON.parse(result.cursor ?? 'null')).toMatchObject({ datasetIndex: 1 });
});

it('leaves a dataset that alone exceeds the budget to the per-dataset path', async () => {
  // 500 rows × 11 entries = 5,500 entries: more than one batch may write.
  const result = await run(500);
  expect(mocks.recordInspectionBatch).not.toHaveBeenCalled();
  // The budget is checked after each row: collection stops at the first row past 4,000 entries.
  expect(mocks.inspected).toBe(364);
  expect(result.phase).toBe('validate_sqlite_dataset');
  expect(JSON.parse(JSON.parse(result.cursor ?? 'null').datasetCursor)).toMatchObject({
    datasetId: 'core.a',
    sourceCursor: null,
    rows: 0,
  });
});

it('validates a dataset too fragmented to read whole row by row', async () => {
  mocks.canReadAll = false;
  const result = await run(10);
  expect(mocks.recordInspectionBatch).not.toHaveBeenCalled();
  expect(mocks.inspected).toBe(0);
  expect(result.phase).toBe('validate_sqlite_dataset');
});

it('sends a dataset over the 500-row receipt limit to the per-dataset path', async () => {
  // 600 rows and 600 entries fit the row and entry budgets, but not a batch inspection receipt.
  mocks.referencesPerRow = 0;
  const result = await run(600);
  expect(mocks.recordInspectionBatch).not.toHaveBeenCalled();
  expect(mocks.inspected).toBe(0);
  expect(result.phase).toBe('validate_sqlite_dataset');
});

it('finalizes a batch of only empty datasets without writing index entries', async () => {
  // core.a is empty; core.b (500 rows × 11 entries) exceeds the entry budget on its own.
  const result = await run(500, true);
  expect(mocks.recordInspectionBatch).not.toHaveBeenCalled();
  expect(mocks.finalizeBatch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(result.cursor ?? 'null')).toMatchObject({ datasetIndex: 1 });
});
