import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { createTenantBackupValidatedInputPorts } from '../tenant-backup-validated-input-port';
import { version } from '../../package.json';

const mocks = vi.hoisted(() => ({
  database: {},
  request: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  issuer: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  keyStore: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  keys: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  executionHead: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  executionValidated: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  executionPage: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  restoreHead: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  restoreValidated: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  planned: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  datasetStart: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  readNext: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  requireDedicatedAdminDatabaseAdapter: () => mocks.database,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/import-request', () => ({
  TenantBackupImportRequestStore: class {
    loadForExecution(...args: unknown[]) {
      return mocks.request(...args);
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/execution-inventory', () => ({
  TenantBackupExecutionInventory: class {
    headForLease(...args: unknown[]) {
      return mocks.executionHead(...args);
    }
    assertInputValidated(...args: unknown[]) {
      return mocks.executionValidated(...args);
    }
    readPage(...args: unknown[]) {
      return mocks.executionPage(...args);
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/restore-plan-inventory', () => ({
  DatabaseTenantBackupRestorePlanInventory: class {
    headForLease(...args: unknown[]) {
      return mocks.restoreHead(...args);
    }
    assertInputValidated(...args: unknown[]) {
      return mocks.restoreValidated(...args);
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/input-plan', () => ({
  loadPlannedTenantBackupInput: (...args: unknown[]) => mocks.planned(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/input-receipts', () => ({
  TenantBackupInputReceipts: class {
    datasetStart(...args: unknown[]) {
      return mocks.datasetStart(...args);
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/sqlite-input-row-source', () => ({
  readNextSqliteInputRow: (...args: unknown[]) => mocks.readNext(...args),
}));
vi.mock('../tenant-backup-services', () => ({
  getTenantBackupKeyStore: (...args: unknown[]) => mocks.keyStore(...args),
}));
vi.mock('../request-issuer', () => ({
  getCanonicalTenantBaseUrlAsync: (...args: unknown[]) => mocks.issuer(...args),
}));

const digest = 'ab'.repeat(32);
const bundleId = '12'.repeat(16);
const dataset = {
  id: 'core.users',
  module: 'users',
  kind: 'users',
  store: 'database',
  schemaVersion: 1,
  disposition: 'include',
} as const;
const policy = {
  dataset,
  schema: { table: 'users', columns: [], primaryKey: ['id'] },
};
const request = {
  intent: {
    source: {
      tenantId: 'tenant-a',
      issuer: 'https://tenant.example.test',
      productVersion: version,
    },
    selection: {
      settings: false,
      users: true,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    },
  },
  inputs: [
    {
      inputId: 'input-a',
      ordinal: 0,
      identity: { key: 'input', version: 'v1', etag: 'etag', size: 1000 },
      digestSha256: '34'.repeat(32),
      boundAt: 1,
    },
  ],
};
const context = {
  operation: { id: 'operation-a', tenant_id: 'tenant-a', kind: 'import', state: 'running' },
  lease: { tenantId: 'tenant-a', operationId: 'operation-a', owner: 'worker-a', fencingToken: 2 },
  signal: new AbortController().signal,
} as unknown as TenantBackupStepContext;
const env = {
  IMPORT_ARTIFACTS: { get: vi.fn() },
  TENANT_BACKUP_WRAPPING_KEY: '11'.repeat(32),
} as unknown as Env;

describe('tenant backup validated input production port', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.request.mockResolvedValue(request);
    mocks.issuer.mockResolvedValue(request.intent.source.issuer);
    mocks.keys.mockResolvedValue([{ inputId: 'input-a', key: { id: 'session-a' } }]);
    mocks.keyStore.mockResolvedValue({ loadActiveInputs: mocks.keys });
    mocks.executionHead.mockResolvedValue({ state: 'sealed', item_count: 1 });
    mocks.executionValidated.mockResolvedValue(undefined);
    mocks.executionPage.mockResolvedValue([{ ordinal: 0, item_id: `backup-input:${bundleId}` }]);
    mocks.restoreHead.mockResolvedValue({ state: 'sealed', chain_digest: digest });
    mocks.restoreValidated.mockResolvedValue(undefined);
    mocks.planned.mockResolvedValue({
      identity: request.inputs[0].identity,
      limits: { maxFrames: 20, maxTotalBytes: 1000 },
      manifest: {
        bundleId,
        source: request.intent.source,
        selection: request.intent.selection,
        datasets: [dataset],
      },
    });
    mocks.datasetStart.mockResolvedValue(4);
    mocks.readNext.mockResolvedValue({ rowJson: '{"id":["text","user-a"]}', nextCursor: '{}' });
  });

  function ports(assertSources = vi.fn(async () => {})) {
    return {
      assertSources,
      value: createTenantBackupValidatedInputPorts({
        env,
        datasets: () => [dataset],
        loadPolicy: vi.fn(async () => policy as never),
        assertSources,
        now: () => 100,
      }),
    };
  }

  it('loads only the sealed validated bundle and rechecks the plan for every row read', async () => {
    const { value, assertSources } = ports();
    const loaded = await value.loadValidatedDataset(context, {
      targetId: 'target-core',
      targetOrdinal: 1,
      datasetId: dataset.id,
      bundleId,
      table: 'users',
      manifestDigest: 'cd'.repeat(32),
      policyDigest: 'ef'.repeat(32),
    });
    expect(loaded.policy).toEqual(policy);
    expect(loaded.manifest.bundleId).toBe(bundleId);
    await expect(
      loaded.readNextValidatedRow({
        datasetId: dataset.id,
        sourceCursor: null,
        planDigest: digest,
      })
    ).resolves.toEqual({ rowJson: '{"id":["text","user-a"]}', nextCursor: '{}' });
    const readInput = mocks.readNext.mock.calls[0]?.[0] as {
      firstSequence: number;
      assertValidatedPlan: (digest: string, bundleId: string, datasetId: string) => Promise<void>;
    };
    expect(readInput.firstSequence).toBe(4);
    await readInput.assertValidatedPlan(digest, bundleId, dataset.id);
    expect(mocks.restoreHead).toHaveBeenCalled();
    expect(mocks.executionValidated).toHaveBeenCalled();
    expect(assertSources).toHaveBeenCalled();
  });

  it('rejects a changed restore plan or input key before returning data', async () => {
    const { value } = ports();
    mocks.restoreHead.mockResolvedValueOnce({ state: 'sealed', chain_digest: 'ff'.repeat(32) });
    await expect(value.assertValidatedUnpublishedPlan(context, digest)).rejects.toThrow(
      'backup_validated_input_invalid'
    );

    mocks.keys.mockResolvedValueOnce([{ inputId: 'different', key: {} }]);
    await expect(
      value.loadValidatedDataset(context, {
        targetId: 'target-core',
        targetOrdinal: 1,
        datasetId: dataset.id,
        bundleId,
        table: 'users',
        manifestDigest: 'cd'.repeat(32),
        policyDigest: 'ef'.repeat(32),
      })
    ).rejects.toThrow('backup_validated_input_invalid');
  });

  it('rejects missing or duplicate bundle inventory ownership', async () => {
    const { value } = ports();
    const job = {
      targetId: 'target-core',
      targetOrdinal: 1,
      datasetId: dataset.id,
      bundleId,
      table: 'users',
      manifestDigest: 'cd'.repeat(32),
      policyDigest: 'ef'.repeat(32),
    };
    mocks.executionPage.mockResolvedValueOnce([]);
    await expect(value.loadValidatedDataset(context, job)).rejects.toThrow(
      'backup_validated_input_invalid'
    );
    mocks.executionHead.mockResolvedValue({ state: 'sealed', item_count: 17 });
    mocks.executionPage.mockResolvedValue([{ ordinal: 0, item_id: `backup-input:${bundleId}` }]);
    await expect(value.loadValidatedDataset(context, job)).rejects.toThrow(
      'backup_validated_input_invalid'
    );
  });
});
