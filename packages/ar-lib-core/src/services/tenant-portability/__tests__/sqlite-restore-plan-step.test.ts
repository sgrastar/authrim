import { beforeEach, expect, it, vi } from 'vitest';
import type { TenantBackupStepContext } from '../operation-executor';
import type { DatabaseTenantBackupRestorePlanInventory } from '../restore-plan-inventory';
import { runTenantBackupSqliteRestorePlanStep } from '../sqlite-restore-plan-step';

const mocks = vi.hoisted(() => ({
  persistTarget: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  persistSequence: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('../sqlite-restore-plan', () => ({
  persistInitializedSqliteRestoreTarget: (...args: unknown[]) => mocks.persistTarget(...args),
}));
vi.mock('../restore-sqlite-sequence', () => ({
  persistSqliteRestoreSequence: (...args: unknown[]) => mocks.persistSequence(...args),
}));

const inputDigest = 'ab'.repeat(32);
const context = {
  operation: {
    id: 'operation',
    tenant_id: 'tenant',
    kind: 'import',
    state: 'running',
    phase: 'prepare_restore_plan',
    cursor_json: JSON.stringify({
      version: 1,
      sessionId: 'validation',
      inputSetDigest: inputDigest,
    }),
  },
  lease: { operationId: 'operation', tenantId: 'tenant', owner: 'worker', fencingToken: 1 },
  signal: new AbortController().signal,
} as unknown as TenantBackupStepContext;
const head = {
  operation_id: 'operation',
  tenant_id: 'tenant',
  input_inventory_digest: inputDigest,
  state: 'building' as const,
  item_count: 0,
  chain_digest: '0'.repeat(64),
};
const inventory = {
  create: vi.fn(async () => head),
  headForLease: vi.fn(async () => head),
  seal: vi.fn(async () => ({ ...head, state: 'sealed' as const, item_count: 2 })),
  append: vi.fn(async () => {}),
  readPage: vi.fn(async () => []),
  assertInputValidated: vi.fn(async () => {}),
} as unknown as DatabaseTenantBackupRestorePlanInventory;
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
  bundleId: 'cd'.repeat(16),
  source: { tenantId: 'tenant', issuer: 'https://issuer.example', productVersion: '0.4.2' },
  snapshotId: 'snapshot',
  boundaryUnixMs: 1,
  inventoryDigestSha256: 'ef'.repeat(32),
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
const resource = {
  targetId: 'core',
  resourceId: 'd1-target',
  provisioningId: 'provisioning',
  database: {},
};
const target = {
  targetId: resource.targetId,
  resourceId: resource.resourceId,
  provisioningId: resource.provisioningId,
  datasets: [{ manifest, policy, recordCount: 1, byteCount: 1 }],
  initialize: vi.fn(async () => resource),
  assertProvisioningOwnership: vi.fn(async () => {}),
};
const assertInputs = vi.fn(async () => {});

function run(value: TenantBackupStepContext = context, targets = [target]) {
  return runTenantBackupSqliteRestorePlanStep({
    context: value,
    inventory,
    targets,
    assertInputs,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(inventory.create).mockResolvedValue(head);
  vi.mocked(inventory.headForLease).mockResolvedValue(head);
  vi.mocked(inventory.seal).mockResolvedValue({ ...head, state: 'sealed', item_count: 2 });
  mocks.persistTarget.mockResolvedValue(undefined);
  mocks.persistSequence.mockResolvedValue(undefined);
});

it('pins initialized targets and the sequence in one slice', async () => {
  mocks.persistTarget.mockImplementationOnce(async (raw) => {
    const request = raw as { assertProvisioningOwnership(): Promise<void> };
    await request.assertProvisioningOwnership();
  });
  const first = await run();
  expect(first.phase).toBe('start_sqlite_restore_sequence');
  expect(mocks.persistTarget).toHaveBeenCalledWith(
    expect.objectContaining({ ordinal: 0, resource })
  );
  expect(mocks.persistSequence).toHaveBeenCalledWith(inventory, 1, [
    expect.objectContaining({ targetId: 'core', ordinal: 0, manifest, policy }),
  ]);
  expect(inventory.seal).toHaveBeenCalled();
  expect(assertInputs.mock.calls.length).toBeGreaterThanOrEqual(3);
});

it('seals the complete plan before starting writes', async () => {
  vi.mocked(inventory.headForLease).mockResolvedValue({
    ...head,
    item_count: 2,
    chain_digest: '12'.repeat(32),
  });
  const started = await run();
  expect(inventory.seal).toHaveBeenCalledWith(2, '12'.repeat(32));
  expect(started).toEqual({
    phase: 'start_sqlite_restore_sequence',
    cursor: JSON.stringify({
      version: 1,
      sequenceOrdinal: 1,
      jobIndex: 0,
      datasetCursor: null,
      completedRows: [],
      emptyPrepared: false,
    }),
    disposition: 'continue',
  });
});

it('rejects duplicate targets, unsupported datasets, and mismatched provisioning receipts', async () => {
  await expect(run(context, [target, target])).rejects.toThrow('step_invalid');
  await expect(
    run(context, [
      {
        ...target,
        datasets: [
          { manifest: { ...manifest, datasets: [] }, policy, recordCount: 1, byteCount: 1 },
        ],
      },
    ])
  ).rejects.toThrow('step_invalid');
  target.initialize.mockResolvedValueOnce({ ...resource, resourceId: 'different' });
  await expect(run()).rejects.toThrow('step_invalid');
  expect(mocks.persistTarget).not.toHaveBeenCalled();
});
