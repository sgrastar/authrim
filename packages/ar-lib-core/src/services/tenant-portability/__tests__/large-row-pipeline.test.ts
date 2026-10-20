import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { encodeTenantBackupContainerV2 } from '../backup-container-v2';
import {
  createTenantBundleKeyEnvelope,
  type TenantBundleKeyEnvelope,
} from '../bundle-key-envelope';
import type { TenantBundleManifest } from '../bundle-manifest';
import {
  TenantBackupContainerFrameReader,
  type TenantBackupContainerDatasetSource,
} from '../container-frame-reader';
import { walkTenantBackupContainerV2Frames } from '../input-container-verification';
import type { TenantBackupStepContext } from '../operation-executor';
import { runSqliteRestoreDatasetVerificationStep } from '../restore-sqlite-step';
import type { SqliteDatasetInspectionPolicy } from '../sqlite-dataset-inspector';
import { runSqliteInputValidationStep } from '../validate-sqlite-input-step';

const mocks = vi.hoisted(() => ({
  inspected: [] as number[],
  verifyRows: vi.fn(async (..._args: unknown[]) => {}),
  verifyRow: vi.fn(async (..._args: unknown[]) => {}),
  verifyDataset: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock('../validation-index', () => ({
  DatabaseTenantBundleReferenceIndex: {
    resume: async () => ({ recordInspectionBatch: async () => {} }),
  },
}));
vi.mock('../sqlite-input-inspection', () => ({
  inspectSqliteInputRow: async (input: { rowJson: string }) => {
    mocks.inspected.push(new TextEncoder().encode(input.rowJson).length);
  },
}));
vi.mock('../sqlite-restore-plan', () => ({
  openPlannedSqliteRestoreTarget: async () => ({
    verifyRows: mocks.verifyRows,
    verifyRow: mocks.verifyRow,
    verifyDataset: mocks.verifyDataset,
  }),
}));

const MiB = 1024 * 1024;
const signal = new AbortController().signal;
const lease = { tenantId: 'tenant-a', operationId: 'import-a', owner: 'worker', fencingToken: 1 };
const dataset = {
  id: 'core.items',
  module: 'applications',
  kind: 'settings' as const,
  store: 'database' as const,
  schemaVersion: 1,
  disposition: 'include' as const,
};
const policy = {
  dataset,
  schema: {
    table: 'items',
    columns: ['id', 'value'],
    primaryKey: ['id'],
    uniqueKeys: [],
    tenantColumn: 'id',
  },
  async inspectRow() {
    return [];
  },
} as unknown as SqliteDatasetInspectionPolicy;
let session: TenantBundleKeyEnvelope;
let manifest: TenantBundleManifest;
let source: TenantBackupContainerDatasetSource;
const sizes = [100, 5 * MiB, 100, 15 * MiB, 100];

function row(index: number, bytes: number): string {
  const head = `{"id":["text","row-${index}"],"value":["text","`;
  return `${head}${'v'.repeat(Math.max(1, bytes - head.length - 4))}"]}\n`;
}

beforeAll(async () => {
  session = await createTenantBundleKeyEnvelope('fixture passphrase for large rows');
  const bundleId = Array.from(session.envelope.subarray(1, 17), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  manifest = {
    formatVersion: 1,
    bundleId,
    source: { tenantId: 'tenant-a', issuer: 'https://issuer.example', productVersion: '0.4.2' },
    snapshotId: 'snapshot-a',
    boundaryUnixMs: 1,
    inventoryDigestSha256: 'ab'.repeat(32),
    selection: {
      settings: true,
      users: false,
      admin: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
      artifacts: false,
    },
    datasets: [dataset],
  } as TenantBundleManifest;
  const encoded = await encodeTenantBackupContainerV2({
    manifest,
    datasets: (async function* () {
      yield {
        datasetId: dataset.id,
        chunks: (async function* () {
          for (const [index, bytes] of sizes.entries())
            yield new TextEncoder().encode(row(index, bytes));
        })(),
      };
    })(),
    session,
  });
  const object = new Uint8Array(encoded.parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of encoded.parts) {
    object.set(part, offset);
    offset += part.length;
  }
  const pinned = {
    size: object.length,
    read: async (from: number, length: number) => object.slice(from, from + length),
  } as never;
  const reader = await TenantBackupContainerFrameReader.open({
    object: pinned,
    session,
    frames: await walkTenantBackupContainerV2Frames({ object: pinned, maxFrames: 100, signal }),
    datasets: encoded.manifest.datasets,
    totalBytes: encoded.manifest.totalBytes,
  });
  source = reader.dataset(dataset.id);
}, 180_000);

beforeEach(() => {
  mocks.inspected.length = 0;
  vi.clearAllMocks();
});

it(
  'validates rows over the batch bound alone instead of stalling on them',
  { timeout: 180_000 },
  async () => {
    let cursor = JSON.stringify({
      version: 1,
      sessionId: 'session-a',
      bundleId: manifest.bundleId,
      datasetId: dataset.id,
      sourceCursor: null,
      rows: 0,
    });
    const perSlice: number[] = [];
    for (let slices = 0; slices < 10; slices++) {
      const before = mocks.inspected.length;
      const result = await runSqliteInputValidationStep(
        {
          operation: {
            id: 'import-a',
            tenant_id: 'tenant-a',
            kind: 'import',
            state: 'running',
            phase: 'validate_sqlite_dataset',
            cursor_json: cursor,
          },
          lease,
          signal,
        } as unknown as TenantBackupStepContext,
        {
          database: { batch: async () => [] } as never,
          now: () => 100,
          sessionId: 'session-a',
          policy,
          manifest,
          assertPinnedInput: async () => {},
          readNextRow: (sourceCursor) => source.readNextRow(sourceCursor),
        }
      );
      perSlice.push(mocks.inspected.length - before);
      cursor = result.cursor!;
      if (result.phase === 'advance_validation_dataset') break;
      expect(perSlice.at(-1)).toBeGreaterThan(0);
    }
    // Small row; 5 MiB row alone; small row; 15 MiB row alone; small row and the end.
    expect(perSlice).toEqual([1, 1, 1, 1, 1]);
    expect(mocks.inspected.length).toBe(sizes.length);
    expect(JSON.parse(cursor).rows).toBe(sizes.length);
  }
);

it(
  'verifies restored rows over the batch bound on the single-row path',
  { timeout: 180_000 },
  async () => {
    let cursor = JSON.stringify({
      version: 1,
      targetId: 'target-a',
      targetOrdinal: 0,
      datasetId: dataset.id,
      sourceCursor: 'written',
      rowsWritten: sizes.length,
      verifySourceCursor: null,
      rowsVerified: 0,
    });
    let phase = 'verify_sqlite_dataset';
    for (let slices = 0; slices < 10 && phase === 'verify_sqlite_dataset'; slices++) {
      const before = JSON.parse(cursor).rowsVerified;
      const result = await runSqliteRestoreDatasetVerificationStep(
        {
          operation: {
            id: 'import-a',
            tenant_id: 'tenant-a',
            kind: 'import',
            state: 'running',
            phase,
            cursor_json: cursor,
          },
          lease,
          signal,
        } as unknown as TenantBackupStepContext,
        {
          inventory: { headForLease: async () => ({ chain_digest: 'cd'.repeat(32) }) },
          assertValidatedUnpublishedPlan: async () => {},
          targetId: 'target-a',
          ordinal: 0,
          policy,
          manifest,
          readNextValidatedRow: ({ sourceCursor }) => source.readNextRow(sourceCursor),
        } as never
      );
      phase = result.phase;
      cursor = result.cursor!;
      if (phase === 'verify_sqlite_dataset')
        expect(JSON.parse(cursor).rowsVerified).toBeGreaterThan(before);
    }
    expect(phase).toBe('advance_restore_dataset');
    expect(JSON.parse(cursor).rowsVerified).toBe(sizes.length);
    expect(mocks.verifyRow).toHaveBeenCalledTimes(2);
    expect(mocks.verifyDataset).toHaveBeenCalledWith(expect.anything(), sizes.length);
  }
);
