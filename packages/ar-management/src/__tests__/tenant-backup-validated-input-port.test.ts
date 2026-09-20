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
  plannedInputs: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  readNext: vi.fn<(...args: unknown[]) => unknown>(),
  readContainer: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  containerReceipt: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
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
  loadPlannedTenantBackupInputs: (...args: unknown[]) => mocks.plannedInputs(...args),
  tenantBackupInputDatasetOwners: (
    inputs: Array<{ manifest: { bundleId: string; datasets: Array<{ id: string }> } }>
  ) =>
    new Map(
      inputs.flatMap(({ manifest }) => manifest.datasets.map(({ id }) => [id, manifest.bundleId]))
    ),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/input-container-v2', () => ({
  readTenantBackupContainerV2Input: (...args: unknown[]) => mocks.readContainer(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/container-dataset-reader', () => ({
  readNextTenantBackupContainerRow: (...args: unknown[]) => mocks.readNext(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/container-input-store', () => ({
  TenantBackupContainerInputStore: class {
    load(...args: unknown[]) {
      return mocks.containerReceipt(...args);
    }
  },
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
    mocks.plannedInputs.mockImplementation(async () => [await mocks.planned()]);
    mocks.containerReceipt.mockResolvedValue({
      object_key: request.inputs[0].identity.key,
      object_version: request.inputs[0].identity.version,
      object_etag: request.inputs[0].identity.etag,
      object_size: request.inputs[0].identity.size,
    });
    mocks.readContainer.mockResolvedValue({
      datasets: new Map([[dataset.id, new TextEncoder().encode('{"id":["text","user-a"]}\n')]]),
    });
    mocks.readNext.mockImplementation((_bytes, sourceCursor) =>
      sourceCursor === null ? { rowJson: '{"id":["text","user-a"]}', nextCursor: '{}' } : null
    );
  });

  function ports(
    assertSources = vi.fn(async () => {}),
    assertUnpublishedTarget = vi.fn(async () => {})
  ) {
    return {
      assertSources,
      assertUnpublishedTarget,
      value: createTenantBackupValidatedInputPorts({
        env,
        datasets: () => [dataset],
        loadPolicy: vi.fn(async () => policy as never),
        assertSources,
        assertUnpublishedTarget,
        now: () => 100,
      }),
    };
  }

  it('loads only the sealed validated bundle and reuses its authenticated dataset', async () => {
    const { value, assertSources, assertUnpublishedTarget } = ports();
    const loaded = await value.loadValidatedDataset(context, {
      targetId: 'target-core',
      targetOrdinal: 1,
      datasetId: dataset.id,
      bundleId,
      table: 'users',
      manifestDigest: 'cd'.repeat(32),
      policyDigest: 'ef'.repeat(32),
      recordCount: 1,
      byteCount: 25,
      reconcilesGeneratedRows: false,
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
    expect(mocks.readContainer).toHaveBeenCalledTimes(1);
    expect(mocks.executionValidated).toHaveBeenCalled();
    expect(assertSources).toHaveBeenCalled();
    expect(assertUnpublishedTarget).not.toHaveBeenCalled();
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
        recordCount: 1,
        byteCount: 25,
        reconcilesGeneratedRows: false,
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
      recordCount: 1,
      byteCount: 25,
      reconcilesGeneratedRows: false,
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

  it('stops every validated read when the physical target becomes published', async () => {
    const assertUnpublishedTarget = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('backup_restore_target_published'));
    const { value } = ports(
      vi.fn(async () => {}),
      assertUnpublishedTarget
    );
    await expect(value.assertValidatedUnpublishedPlan(context, digest)).rejects.toThrow(
      'backup_restore_target_published'
    );
    expect(assertUnpublishedTarget).toHaveBeenCalledWith(context, digest);
    expect(assertUnpublishedTarget).toHaveBeenCalledTimes(2);
  });

  it('loads installed policies for every validated SQL dataset used by restore planning', async () => {
    const loadPolicy = vi.fn(async () => {
      throw new Error('individual policy loading must not be used');
    });
    const loadPolicies = vi.fn(async () => [policy as never]);
    const value = createTenantBackupValidatedInputPorts({
      env,
      datasets: () => [dataset],
      loadPolicies,
      loadPolicy,
      assertSources: vi.fn(async () => {}),
      assertUnpublishedTarget: vi.fn(async () => {}),
      now: () => 100,
    });
    const loaded = await value.loadValidatedSqliteDatasets(context);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.bundleId).toBe(bundleId);
    expect(loaded[0]?.policy).toEqual(policy);
    expect(mocks.executionValidated).toHaveBeenCalledTimes(2);
    expect(mocks.plannedInputs).toHaveBeenCalledWith(
      context,
      expect.anything(),
      expect.objectContaining({ source: request.intent.source })
    );
    expect(loadPolicies).toHaveBeenCalledOnce();
    expect(loadPolicy).not.toHaveBeenCalled();
  });

  it('keeps the validated source issuer when restoring into a different environment', async () => {
    mocks.issuer.mockResolvedValue('https://destination.example.test');
    const { value } = ports();

    await expect(value.loadValidatedSqliteDatasets(context)).resolves.toHaveLength(1);
    expect(mocks.plannedInputs).toHaveBeenCalledWith(
      context,
      expect.anything(),
      expect.objectContaining({ source: request.intent.source })
    );
    expect(mocks.issuer).not.toHaveBeenCalled();
  });

  it('reloads pinned input state after the scheduler renews the operation lease', async () => {
    const { value } = ports();
    const renewedContext = {
      ...context,
      lease: { ...context.lease, owner: 'worker-b', fencingToken: 3 },
    } as TenantBackupStepContext;

    await expect(value.loadValidatedSqliteDatasets(context)).resolves.toHaveLength(1);
    await expect(value.loadValidatedSqliteDatasets(renewedContext)).resolves.toHaveLength(1);
    expect(mocks.request).toHaveBeenCalledWith(renewedContext, expect.any(Function));
  });

  it('loads a validated non-SQL sidecar source by installed dataset identity', async () => {
    const { value } = ports();
    const loaded = await value.loadValidatedDatasetById(context, digest, dataset.id);

    expect(loaded.policy).toEqual(policy);
    expect(loaded.manifest.bundleId).toBe(bundleId);
    await expect(loaded.readNextValidatedRow({ sourceCursor: null })).resolves.toEqual({
      rowJson: '{"id":["text","user-a"]}',
      nextCursor: '{}',
    });
    expect(mocks.readContainer).toHaveBeenCalledTimes(1);
    expect(mocks.readNext).toHaveBeenCalledWith(expect.any(Uint8Array), null);
  });

  it('reuses the sealed plan, input inventory, and installed policies within one lease', async () => {
    const loadPolicy = vi.fn(async () => {
      throw new Error('individual policy loading must not be used');
    });
    const loadPolicies = vi.fn(async () => [policy as never]);
    const assertUnpublishedTarget = vi.fn(async () => {});
    const value = createTenantBackupValidatedInputPorts({
      env,
      datasets: () => [dataset],
      loadPolicies,
      loadPolicy,
      assertSources: vi.fn(async () => {}),
      assertUnpublishedTarget,
      now: () => 100,
    });

    await value.loadValidatedDatasetById(context, digest, dataset.id);
    await value.loadValidatedDatasetById(context, digest, dataset.id);

    expect(mocks.restoreHead).toHaveBeenCalledTimes(1);
    expect(assertUnpublishedTarget).toHaveBeenCalledTimes(2);
    expect(mocks.plannedInputs).toHaveBeenCalledTimes(1);
    expect(loadPolicies).toHaveBeenCalledTimes(1);
    expect(loadPolicy).not.toHaveBeenCalled();
    expect(mocks.readContainer).toHaveBeenCalledTimes(1);
  });
});
