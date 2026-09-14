import { beforeEach, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import {
  loadTenantBackupExportExecution,
  runTenantBackupArtifactExecution,
  runTenantBackupExportPreparation,
  runTenantBackupImportDecode,
  runTenantBackupImportPreparation,
  runTenantBackupImportRestorePlanning,
  runTenantBackupImportValidation,
} from '../tenant-backup-execution';
import { version } from '../../package.json';
const mocks = vi.hoisted(() => ({
  request: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  issuer: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  keys: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  active: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  exportStep: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  verifyStep: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  prepareStep: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  boundary: vi.fn<(...args: unknown[]) => unknown>(),
  placement: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  publishStep: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  database: {},
  importRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  activeInputs: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  probe: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  persistInput: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  inventoryCreate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  inventorySeal: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  tenantResources: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fixedResources: vi.fn<(...args: unknown[]) => unknown>(),
  sqlitePlanStep: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  decodeSequence: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  validationSequence: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  restorePlanStep: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/input-decode-sequence', () => ({
  runTenantBackupInputDecodeSequenceStep: (...args: unknown[]) => mocks.decodeSequence(...args),
}));
vi.mock(
  '@authrim/ar-lib-core/services/tenant-portability/input-sqlite-validation-sequence',
  () => ({
    runTenantBackupSqliteInputValidationSequenceStep: (...args: unknown[]) =>
      mocks.validationSequence(...args),
  })
);
vi.mock('@authrim/ar-lib-core/services/tenant-portability/sqlite-restore-plan-step', () => ({
  runTenantBackupSqliteRestorePlanStep: (...args: unknown[]) => mocks.restorePlanStep(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/database-resources', () => ({
  resolveBackupTenantDatabaseResources: (...args: unknown[]) => mocks.tenantResources(...args),
  backupDatabaseResourceDescriptor: (resource: { databaseId: string }) =>
    JSON.stringify({ databaseId: resource.databaseId }),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/fixed-database-resources', () => ({
  resolveFixedBackupDatabaseResources: (...args: unknown[]) => mocks.fixedResources(...args),
  fixedBackupDatabaseResourceDescriptor: (resource: { binding: string; databaseId: string }) =>
    JSON.stringify({ binding: resource.binding, databaseId: resource.databaseId }),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/sqlite-export-plan-step', () => ({
  runTenantBackupSqliteExportPlanStep: (...args: unknown[]) => mocks.sqlitePlanStep(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/execution-inventory', () => ({
  TenantBackupExecutionInventory: class {
    create(...args: unknown[]) {
      return mocks.inventoryCreate(...args);
    }
    seal(...args: unknown[]) {
      return mocks.inventorySeal(...args);
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/import-request', () => ({
  TenantBackupImportRequestStore: class {
    loadForExecution(...args: unknown[]) {
      return mocks.importRequest(...args);
    }
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/input-manifest-probe', () => ({
  probeTenantBackupInputManifest: (...args: unknown[]) => mocks.probe(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/input-plan', () => ({
  persistTenantBackupInput: (...args: unknown[]) => mocks.persistInput(...args),
}));
vi.mock('../tenant-backup-database-inventory', () => ({
  resolveTenantBackupDatabaseInventory: (...args: unknown[]) => mocks.placement(...args),
  tenantBackupDatabaseFamily: (resource: { assignments: Array<{ role: string }> }) => {
    const roles = new Set(resource.assignments.map((assignment) => assignment.role));
    if (roles.size !== 1) throw new Error('backup_export_database_adapter_missing');
    if (roles.has('tenant_core')) return 'core';
    if (roles.has('tenant_pii')) return 'pii';
    throw new Error('backup_export_database_adapter_missing');
  },
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/publish-artifact-step', () => ({
  runTenantBackupArtifactPublicationStep: (...args: unknown[]) => mocks.publishStep(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/prepare-artifact-step', () => ({
  runPrepareTenantBackupArtifactStep: (...args: unknown[]) => mocks.prepareStep(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/export-artifact-step', () => ({
  runTenantBackupArtifactStep: (...args: unknown[]) => mocks.exportStep(...args),
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/verify-artifact-step', () => ({
  runTenantBackupArtifactVerificationStep: (...args: unknown[]) => mocks.verifyStep(...args),
}));
vi.mock('@authrim/ar-lib-core', () => ({
  requireDedicatedAdminDatabaseAdapter: () => mocks.database,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/operation-request', () => ({
  TenantBackupRequestStore: class {
    loadForExecution(...args: unknown[]) {
      return mocks.request(...args);
    }
  },
}));
vi.mock('../tenant-backup-services', () => ({
  getTenantBackupKeyStore: (...args: unknown[]) => mocks.keys(...args),
  getTenantBackupBoundaryClient: (...args: unknown[]) => mocks.boundary(...args),
}));
vi.mock('../request-issuer', () => ({
  getCanonicalTenantBaseUrlAsync: (...args: unknown[]) => mocks.issuer(...args),
}));
const intent = {
  version: 1,
  kind: 'export',
  source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: version },
  selection: { settings: true },
  inputs: [],
};
const context = {
  operation: { id: 'op', tenant_id: 'tenant', kind: 'export', state: 'running', phase: 'prepare' },
  lease: { tenantId: 'tenant', operationId: 'op', owner: 'worker', fencingToken: 1 },
  signal: new AbortController().signal,
} as unknown as TenantBackupStepContext;
const env = { EXPORT_ARTIFACTS: {} } as unknown as Env;
const requiredDatabases = { roles: ['tenant_core' as const], fixed: ['DB_ADMIN' as const] };
const assertPublishable = async () => {};
const key = { envelope: new Uint8Array(93), contentKey: {} };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.request.mockReset().mockResolvedValue(intent);
  mocks.issuer.mockResolvedValue(intent.source.issuer);
  mocks.keys.mockResolvedValue({ loadActive: mocks.active, loadActiveInputs: mocks.activeInputs });
  mocks.active.mockResolvedValue(key);
  mocks.inventoryCreate.mockResolvedValue({ item_count: 0, chain_digest: '0'.repeat(64) });
  mocks.inventorySeal.mockResolvedValue({});
  mocks.persistInput.mockResolvedValue(undefined);
  mocks.tenantResources.mockResolvedValue([]);
  mocks.fixedResources.mockReturnValue([]);
  mocks.sqlitePlanStep.mockResolvedValue({
    phase: 'prepare',
    cursor: '{}',
    disposition: 'continue',
  });
  mocks.decodeSequence.mockResolvedValue({
    phase: 'decode_input',
    cursor: '{}',
    disposition: 'continue',
  });
  mocks.validationSequence.mockResolvedValue({
    phase: 'validate_input_modules',
    cursor: '{}',
    disposition: 'continue',
  });
  mocks.restorePlanStep.mockResolvedValue({
    phase: 'prepare_restore_plan',
    cursor: '{}',
    disposition: 'continue',
  });
});
it('loads the persisted request and active key, then rechecks the exact live slice', async () => {
  const now = () => 100;
  expect(await loadTenantBackupExportExecution(env, context, now)).toEqual({
    database: mocks.database,
    bucket: env.EXPORT_ARTIFACTS,
    intent,
    key,
  });
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(mocks.request).toHaveBeenNthCalledWith(2, context, now);
  expect(mocks.active).toHaveBeenCalledWith(context.lease, now);
  expect(mocks.request.mock.invocationCallOrder[1]).toBeGreaterThan(
    mocks.active.mock.invocationCallOrder[0]
  );
});
it('rejects changed source identity or product version before key unwrapping', async () => {
  mocks.issuer.mockResolvedValue('https://changed.example');
  await expect(loadTenantBackupExportExecution(env, context)).rejects.toThrow(
    'backup_export_source_changed'
  );
  mocks.issuer.mockResolvedValue(intent.source.issuer);
  mocks.request.mockResolvedValue({
    ...intent,
    source: { ...intent.source, productVersion: '0.0.0' },
  });
  await expect(loadTenantBackupExportExecution(env, context)).rejects.toThrow(
    'backup_export_source_changed'
  );
  expect(mocks.active).not.toHaveBeenCalled();
});
it('does not return a key if the slice changes during loading and rejects unavailable execution', async () => {
  mocks.request
    .mockResolvedValueOnce(intent)
    .mockRejectedValueOnce(new Error('backup_request_execution_fenced'));
  await expect(loadTenantBackupExportExecution(env, context)).rejects.toThrow('execution_fenced');
  expect(mocks.active).toHaveBeenCalledTimes(1);
  await expect(loadTenantBackupExportExecution({} as Env, context)).rejects.toThrow(
    'backup_export_execution_unavailable'
  );
  mocks.request.mockReset().mockResolvedValue(intent);
  mocks.keys.mockResolvedValue(null);
  await expect(loadTenantBackupExportExecution(env, context)).rejects.toThrow(
    'backup_export_key_unavailable'
  );
});

it('resolves and rechecks the installed physical database set for export preparation', async () => {
  const coreDatabase = { id: 'core' };
  const adminDatabase = { id: 'admin' };
  mocks.tenantResources.mockResolvedValue([
    {
      databaseId: 'core_db',
      assignments: [{ role: 'tenant_core' }],
      database: coreDatabase,
    },
  ]);
  mocks.fixedResources.mockReturnValue([
    {
      binding: 'DB_ADMIN',
      family: 'admin',
      databaseId: 'admin_db',
      database: adminDatabase,
    },
  ]);
  const result = await runTenantBackupExportPreparation(env, context, requiredDatabases, () => 100);
  expect(result).toEqual({ phase: 'prepare', cursor: '{}', disposition: 'continue' });
  const input = mocks.sqlitePlanStep.mock.calls[0]?.[0] as {
    resources: Array<{ resourceId: string; family: string; database: unknown }>;
    assertSources(): Promise<void>;
  };
  expect(input.resources).toEqual([
    expect.objectContaining({ resourceId: 'core_db', family: 'core', database: coreDatabase }),
    expect.objectContaining({ resourceId: 'admin_db', family: 'admin', database: adminDatabase }),
  ]);
  await input.assertSources();
  expect(mocks.tenantResources).toHaveBeenCalledTimes(2);
  expect(mocks.fixedResources).toHaveBeenCalledTimes(2);
  expect(mocks.request.mock.calls.length).toBeGreaterThanOrEqual(3);
});

it('rejects an unsupported or changed installed database assignment during preparation', async () => {
  mocks.tenantResources.mockResolvedValue([
    {
      databaseId: 'audit_db',
      assignments: [{ role: 'tenant_audit' }],
      database: {},
    },
  ]);
  await expect(
    runTenantBackupExportPreparation(env, context, {
      roles: ['tenant_audit'],
      fixed: [],
    })
  ).rejects.toThrow('database_adapter_missing');

  mocks.tenantResources.mockReset().mockResolvedValueOnce([
    {
      databaseId: 'core_db',
      assignments: [{ role: 'tenant_core' }],
      database: {},
    },
  ]);
  mocks.sqlitePlanStep.mockImplementationOnce(async (input) => {
    const value = input as { assertSources(): Promise<void> };
    mocks.tenantResources.mockResolvedValue([
      {
        databaseId: 'changed_db',
        assignments: [{ role: 'tenant_core' }],
        database: {},
      },
    ]);
    await value.assertSources();
    throw new Error('must_not_continue');
  });
  await expect(
    runTenantBackupExportPreparation(env, context, { roles: ['tenant_core'], fixed: [] })
  ).rejects.toThrow('backup_export_source_changed');
});

it('probes and pins one immutable import input per preparation slice, then seals the inventory', async () => {
  const selection = {
    settings: true,
    users: false,
    admin: false,
    logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
    artifacts: false,
  };
  const datasets = [
    {
      id: 'core.clients',
      module: 'applications' as const,
      kind: 'settings' as const,
      store: 'database' as const,
      schemaVersion: 1,
      disposition: 'include' as const,
    },
  ];
  const identity = { key: 'input/key', version: 'v1', etag: 'etag', size: 4096 };
  const imported = {
    intent: {
      version: 1,
      kind: 'import',
      source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: version },
      selection,
      inputs: [{ id: 'upload-a', digestSha256: 'ab'.repeat(32) }],
    },
    inputs: [
      {
        inputId: 'upload-a',
        ordinal: 0,
        identity,
        digestSha256: 'ab'.repeat(32),
        boundAt: 50,
      },
    ],
  };
  const importContext = {
    ...context,
    operation: {
      ...context.operation,
      kind: 'import',
      phase: 'prepare',
      cursor_json: null,
    },
  } as TenantBackupStepContext;
  const importKey = { envelope: new Uint8Array(93), contentKey: {} as CryptoKey };
  const manifest = {
    formatVersion: 1 as const,
    bundleId: '0'.repeat(32),
    source: imported.intent.source,
    snapshotId: 'snapshot-a',
    boundaryUnixMs: 40,
    inventoryDigestSha256: 'cd'.repeat(32),
    selection,
    datasets,
  };
  mocks.importRequest.mockResolvedValue(imported);
  mocks.issuer.mockResolvedValue(imported.intent.source.issuer);
  mocks.activeInputs.mockResolvedValue([{ inputId: 'upload-a', key: importKey }]);
  mocks.probe.mockImplementation(async (input) => {
    const value = input as { assertAuthorized(): Promise<void>; expected: object };
    await value.assertAuthorized();
    return { manifest, expected: { bundleId: manifest.bundleId, ...value.expected } };
  });
  mocks.persistInput.mockImplementation(async (input) => {
    const value = input as {
      identity: { key: string; version: string; etag: string; size: number };
      assertUploadOwnership(value: {
        key: string;
        version: string;
        etag: string;
        size: number;
      }): Promise<void>;
    };
    await value.assertUploadOwnership(value.identity);
  });
  const importEnv = { IMPORT_ARTIFACTS: {} } as unknown as Env;
  expect(
    await runTenantBackupImportPreparation(
      importEnv,
      importContext,
      () => datasets,
      () => 100
    )
  ).toEqual({
    phase: 'prepare',
    cursor: JSON.stringify({ version: 1, nextInput: 1 }),
    disposition: 'continue',
  });
  expect(mocks.probe).toHaveBeenCalledWith(
    expect.objectContaining({
      identity,
      session: importKey,
      expected: { source: imported.intent.source, selection, datasets },
    })
  );
  expect(mocks.persistInput).toHaveBeenCalledWith(
    expect.objectContaining({ ordinal: 0, identity, manifest })
  );
  expect(mocks.importRequest.mock.calls.length).toBeGreaterThanOrEqual(4);

  mocks.inventoryCreate.mockResolvedValue({ item_count: 1, chain_digest: 'ef'.repeat(32) });
  const finalContext = {
    ...importContext,
    operation: {
      ...importContext.operation,
      cursor_json: JSON.stringify({ version: 1, nextInput: 1 }),
    },
  };
  expect(
    await runTenantBackupImportPreparation(
      importEnv,
      finalContext,
      () => datasets,
      () => 100
    )
  ).toEqual({
    phase: 'decode_input',
    cursor: JSON.stringify({ version: 1, inputOrdinal: 0 }),
    disposition: 'continue',
  });
  expect(mocks.inventorySeal).toHaveBeenCalledWith(1, 'ef'.repeat(32));
});

it('fails import preparation before reads when its key mapping or durable cursor changed', async () => {
  const imported = {
    intent: {
      version: 1,
      kind: 'import',
      source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: version },
      selection: {},
      inputs: [{ id: 'upload-a', digestSha256: 'ab'.repeat(32) }],
    },
    inputs: [
      {
        inputId: 'upload-a',
        ordinal: 0,
        identity: { key: 'input/key', version: 'v1', etag: 'etag', size: 4096 },
        digestSha256: 'ab'.repeat(32),
        boundAt: 50,
      },
    ],
  };
  const importContext = {
    ...context,
    operation: { ...context.operation, kind: 'import', phase: 'prepare', cursor_json: null },
  } as TenantBackupStepContext;
  mocks.importRequest.mockResolvedValue(imported);
  mocks.issuer.mockResolvedValue(imported.intent.source.issuer);
  mocks.activeInputs.mockResolvedValue([{ inputId: 'wrong', key }]);
  const importEnv = { IMPORT_ARTIFACTS: {} } as unknown as Env;
  const installed = () => [
    {
      id: 'core.clients',
      module: 'applications' as const,
      kind: 'settings' as const,
      store: 'database' as const,
      schemaVersion: 1,
      disposition: 'include' as const,
    },
  ];
  await expect(
    runTenantBackupImportPreparation(importEnv, importContext, installed)
  ).rejects.toThrow('backup_import_key_unavailable');
  expect(mocks.probe).not.toHaveBeenCalled();

  mocks.activeInputs.mockResolvedValue([{ inputId: 'upload-a', key }]);
  mocks.inventoryCreate.mockResolvedValue({ item_count: 1, chain_digest: '0'.repeat(64) });
  await expect(
    runTenantBackupImportPreparation(importEnv, importContext, installed)
  ).rejects.toThrow('backup_import_execution_cursor');
  expect(mocks.probe).not.toHaveBeenCalled();
});

it('decodes one frame from the durable ordered import inputs and rechecks request ownership', async () => {
  const datasets = [
    {
      id: 'core.clients',
      module: 'applications' as const,
      kind: 'settings' as const,
      store: 'database' as const,
      schemaVersion: 1,
      disposition: 'include' as const,
    },
  ];
  const imported = {
    intent: {
      version: 1,
      kind: 'import',
      source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: version },
      selection: {},
      inputs: [{ id: 'upload-a', digestSha256: 'ab'.repeat(32) }],
    },
    inputs: [
      {
        inputId: 'upload-a',
        ordinal: 0,
        identity: { key: 'input/key', version: 'v1', etag: 'etag', size: 4096 },
        digestSha256: 'ab'.repeat(32),
        boundAt: 50,
      },
    ],
  };
  const importKey = { envelope: new Uint8Array(93), contentKey: {} as CryptoKey };
  const importContext = {
    ...context,
    operation: { ...context.operation, kind: 'import', phase: 'decode_input' },
  } as TenantBackupStepContext;
  mocks.importRequest.mockResolvedValue(imported);
  mocks.issuer.mockResolvedValue(imported.intent.source.issuer);
  mocks.activeInputs.mockResolvedValue([{ inputId: 'upload-a', key: importKey }]);
  mocks.decodeSequence.mockImplementationOnce(async (_context, raw) => {
    const input = raw as {
      inputCount: number;
      loadInput(ordinal: number, bundleId: string): Promise<unknown>;
    };
    expect(input.inputCount).toBe(1);
    expect(await input.loadInput(0, 'cd'.repeat(16))).toEqual({
      session: importKey,
      expected: {
        bundleId: 'cd'.repeat(16),
        source: imported.intent.source,
        selection: imported.intent.selection,
        datasets,
      },
    });
    return { phase: 'decode_input', cursor: '{}', disposition: 'continue' };
  });
  expect(
    await runTenantBackupImportDecode(
      { IMPORT_ARTIFACTS: {} } as unknown as Env,
      importContext,
      () => datasets,
      () => 100
    )
  ).toEqual({ phase: 'decode_input', cursor: '{}', disposition: 'continue' });
  expect(mocks.importRequest.mock.calls.length).toBeGreaterThanOrEqual(3);
});

it('rejects changed input-key order before import decode', async () => {
  const imported = {
    intent: {
      source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: version },
      selection: {},
    },
    inputs: [{ inputId: 'upload-a', ordinal: 0, digestSha256: 'ab'.repeat(32) }],
  };
  const importContext = {
    ...context,
    operation: { ...context.operation, kind: 'import', phase: 'decode_input' },
  } as TenantBackupStepContext;
  mocks.importRequest.mockResolvedValue(imported);
  mocks.issuer.mockResolvedValue(imported.intent.source.issuer);
  mocks.activeInputs.mockResolvedValue([{ inputId: 'wrong', key }]);
  await expect(
    runTenantBackupImportDecode({ IMPORT_ARTIFACTS: {} } as unknown as Env, importContext, () => [
      {
        id: 'core.clients',
        module: 'applications',
        kind: 'settings',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      },
    ])
  ).rejects.toThrow('backup_import_key_unavailable');
  expect(mocks.decodeSequence).not.toHaveBeenCalled();
});

it('validates imported SQL through installed policies with live request and key checks', async () => {
  const datasets = [
    {
      id: 'core.clients',
      module: 'applications' as const,
      kind: 'settings' as const,
      store: 'database' as const,
      schemaVersion: 1,
      disposition: 'include' as const,
    },
  ];
  const imported = {
    intent: {
      source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: version },
      selection: {},
    },
    inputs: [{ inputId: 'upload-a', ordinal: 0, digestSha256: 'ab'.repeat(32) }],
  };
  const importContext = {
    ...context,
    operation: { ...context.operation, kind: 'import', phase: 'validate_input_modules' },
  } as TenantBackupStepContext;
  mocks.importRequest.mockResolvedValue(imported);
  mocks.issuer.mockResolvedValue(imported.intent.source.issuer);
  mocks.activeInputs.mockResolvedValue([{ inputId: 'upload-a', key }]);
  const loadPolicy = vi.fn(async () => ({ dataset: datasets[0] }));
  const assertSources = vi.fn(async () => {});
  mocks.validationSequence.mockImplementationOnce(async (_context, raw) => {
    const input = raw as {
      loadInput(
        ordinal: number,
        bundleId: string
      ): Promise<{
        expected: unknown;
        loadPolicy(datasetId: string): Promise<unknown>;
        assertAuthorized(): Promise<void>;
      }>;
    };
    const loaded = await input.loadInput(0, 'cd'.repeat(16));
    expect(loaded.expected).toEqual({
      bundleId: 'cd'.repeat(16),
      source: imported.intent.source,
      selection: imported.intent.selection,
      datasets,
    });
    await loaded.loadPolicy(datasets[0].id);
    await loaded.assertAuthorized();
    return { phase: 'validate_input_modules', cursor: '{}', disposition: 'continue' };
  });
  await expect(
    runTenantBackupImportValidation(
      { IMPORT_ARTIFACTS: {} } as unknown as Env,
      importContext,
      { datasets: () => datasets, loadPolicy: loadPolicy as never, assertSources },
      () => 100
    )
  ).resolves.toMatchObject({ phase: 'validate_input_modules' });
  expect(loadPolicy).toHaveBeenCalledWith(datasets[0].id);
  expect(assertSources.mock.calls.length).toBeGreaterThanOrEqual(5);
  expect(mocks.activeInputs.mock.calls.length).toBeGreaterThanOrEqual(5);
});

it('builds restore planning only while the validated input request and keys remain live', async () => {
  const imported = {
    intent: {
      source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: version },
    },
    inputs: [{ inputId: 'upload-a', ordinal: 0, digestSha256: 'ab'.repeat(32) }],
  };
  const importContext = {
    ...context,
    operation: { ...context.operation, kind: 'import', phase: 'prepare_restore_plan' },
  } as TenantBackupStepContext;
  mocks.importRequest.mockResolvedValue(imported);
  mocks.issuer.mockResolvedValue(imported.intent.source.issuer);
  mocks.activeInputs.mockResolvedValue([{ inputId: 'upload-a', key }]);
  const assertSources = vi.fn(async () => {});
  mocks.restorePlanStep.mockImplementationOnce(async (raw) => {
    const request = raw as { assertInputs(): Promise<void>; targets: unknown[] };
    expect(request.targets).toHaveLength(1);
    await request.assertInputs();
    return { phase: 'prepare_restore_plan', cursor: '{}', disposition: 'continue' };
  });
  await runTenantBackupImportRestorePlanning(
    {} as Env,
    importContext,
    { targets: [{}] as never, assertSources },
    () => 100
  );
  expect(assertSources.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(mocks.activeInputs.mock.calls.length).toBeGreaterThanOrEqual(3);
});

it.each(['export_artifact', 'verify_artifact'])(
  'dispatches %s from persisted request and key rather than caller manifest',
  async (phase) => {
    const ctx = {
      ...context,
      operation: {
        ...context.operation,
        phase,
        cursor_json: JSON.stringify({ version: 1, attemptId: 'ab'.repeat(32) }),
      },
    };
    const next = { phase: 'next', cursor: null, disposition: 'continue' };
    mocks.exportStep.mockResolvedValue(next);
    mocks.verifyStep.mockResolvedValue(next);
    const assertSources = vi.fn(async () => {});
    const datasets = [
      {
        id: 'core.tenants',
        module: 'tenant-runtime' as const,
        kind: 'settings' as const,
        store: 'database' as const,
        schemaVersion: 1,
        disposition: 'include' as const,
      },
    ];
    expect(
      await runTenantBackupArtifactExecution(
        env,
        ctx,
        {
          datasets,
          assertSources,
          requiredDatabases,
          assertPublishable,
          readNext: async () => null,
        },
        () => 100
      )
    ).toEqual(next);
    const selected = phase === 'export_artifact' ? mocks.exportStep : mocks.verifyStep;
    expect(selected).toHaveBeenCalledTimes(1);
    expect(selected.mock.calls[0][1]).toMatchObject({
      expected: {
        bundleId: '0'.repeat(32),
        source: intent.source,
        selection: intent.selection,
        datasets,
      },
    });
    expect(selected.mock.calls[0][1]).not.toHaveProperty('manifest');
    expect(assertSources).toHaveBeenCalledTimes(2);
  }
);

it('prepares output from durable source/key and authenticated Control receipts', async () => {
  const cursor = {
    version: 1,
    boundaryId: 'ab'.repeat(32),
    inventoryDigest: 'cd'.repeat(32),
    releasedAt: 100,
    participants: [{ resourceId: 'core', snapshotId: 'ef'.repeat(32) }],
  };
  const ctx = {
    ...context,
    operation: {
      ...context.operation,
      phase: 'prepare_export_artifact',
      cursor_json: JSON.stringify(cursor),
    },
  };
  const configured = { ...env, AUTHRIM_ENVIRONMENT_NAME: 'env-a' };
  const receipts = {};
  mocks.boundary.mockReturnValue({ receipts });
  const next = { phase: 'export_artifact', cursor: 'prepared', disposition: 'continue' };
  mocks.prepareStep.mockResolvedValue(next);
  const adapters = {
    requiredDatabases,
    assertPublishable,
    datasets: [],
    assertSources: vi.fn(async () => {}),
    readNext: async () => null,
  };
  expect(await runTenantBackupArtifactExecution(configured, ctx, adapters)).toEqual(next);
  expect(mocks.boundary).toHaveBeenCalledWith(configured, {
    tenantId: 'tenant',
    operationId: 'op',
    inventoryDigest: cursor.inventoryDigest,
  });
  expect(mocks.prepareStep).toHaveBeenCalledWith(
    expect.objectContaining({
      receipts,
      environmentId: 'env-a',
      boundaryTenantId: 'tenant',
      key,
      manifest: {
        formatVersion: 1,
        bundleId: '0'.repeat(32),
        source: intent.source,
        selection: intent.selection,
        datasets: [],
        snapshotId: cursor.boundaryId,
        inventoryDigestSha256: cursor.inventoryDigest,
        boundaryUnixMs: 100,
      },
    })
  );
  expect(mocks.exportStep).not.toHaveBeenCalled();
  expect(adapters.assertSources).toHaveBeenCalledTimes(2);
  mocks.prepareStep.mockClear();
  await expect(runTenantBackupArtifactExecution(env, ctx, adapters)).rejects.toThrow(
    'backup_boundary_rpc_unavailable'
  );
  adapters.assertSources.mockRejectedValueOnce(new Error('source_changed'));
  await expect(runTenantBackupArtifactExecution(configured, ctx, adapters)).rejects.toThrow(
    'source_changed'
  );
  expect(mocks.prepareStep).not.toHaveBeenCalled();
});

it.each(['prepare_export_artifact', 'export_artifact', 'verify_artifact', 'publish_artifact'])(
  'stops %s before any artifact side effect when the physical inventory changes',
  async (phase) => {
    mocks.placement.mockRejectedValueOnce(new Error('backup_resource_inventory_changed'));
    const ctx = { ...context, operation: { ...context.operation, phase, cursor_json: '{}' } };
    await expect(
      runTenantBackupArtifactExecution(env, ctx, {
        datasets: [],
        requiredDatabases,
        assertPublishable,
        assertSources: async () => {},
        readNext: async () => null,
      })
    ).rejects.toThrow('inventory_changed');
    expect(mocks.prepareStep).not.toHaveBeenCalled();
    expect(mocks.exportStep).not.toHaveBeenCalled();
    expect(mocks.verifyStep).not.toHaveBeenCalled();
    expect(mocks.publishStep).not.toHaveBeenCalled();
  }
);

it('publishes only through the final coverage guard and refuses its failure', async () => {
  const ctx = {
    ...context,
    operation: {
      ...context.operation,
      phase: 'publish_artifact',
      cursor_json: JSON.stringify({
        version: 1,
        attemptId: 'ab'.repeat(32),
        nextPart: 3,
        verifiedBytes: 500,
      }),
    },
  };
  const next = { phase: 'complete', cursor: null, disposition: 'ready' };
  const guard = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue();
  mocks.publishStep.mockImplementation(async (_context, value) => {
    const input = value as { assertPublishable(digest: string): Promise<void> };
    await input.assertPublishable('cd'.repeat(32));
    return next;
  });
  const adapters = {
    datasets: [],
    requiredDatabases,
    assertPublishable: guard,
    assertSources: async () => {},
    readNext: async () => null,
  };
  expect(await runTenantBackupArtifactExecution(env, ctx, adapters)).toEqual(next);
  expect(guard).toHaveBeenCalledWith('cd'.repeat(32));
  expect(mocks.placement).toHaveBeenCalledTimes(4);
  guard.mockRejectedValueOnce(new Error('module_receipts_incomplete'));
  await expect(runTenantBackupArtifactExecution(env, ctx, adapters)).rejects.toThrow(
    'receipts_incomplete'
  );
});
