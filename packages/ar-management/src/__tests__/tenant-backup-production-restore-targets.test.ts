import { beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import type { Phase8ValidatedSqliteRestoreDataset } from '@authrim/ar-lib-core/services/tenant-portability/phase8-restore-targets';

const mocks = vi.hoisted(() => ({
  resources: vi.fn(),
  fixed: vi.fn(),
  scopedFingerprint: vi.fn(async () => 'a'.repeat(64)),
}));

vi.mock('@authrim/ar-lib-core/services/tenant-portability/database-resources', () => ({
  resolveBackupTenantDatabaseResources: mocks.resources,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/fixed-database-resources', () => ({
  resolveFixedBackupDatabaseResources: mocks.fixed,
}));
vi.mock('@authrim/ar-lib-core/services/tenant-portability/scoped-restore-seed', () => ({
  readScopedSqliteRestoreSeedFingerprint: mocks.scopedFingerprint,
}));

import { createProductionTenantBackupRestoreTargets } from '../tenant-backup-production-restore-targets';

type TestAdapter = DatabaseAdapter & {
  setLifecycle(value: string | null): void;
  setRows(value: unknown[]): void;
};

function adapter(initialLifecycle: string | null = null): TestAdapter {
  let lifecycle = initialLifecycle;
  let rows: unknown[] = [];
  const value = {
    async query<T>() {
      return rows as T[];
    },
    async queryOne<T>() {
      return (lifecycle ? { lifecycle_state: lifecycle } : null) as T | null;
    },
    execute: vi.fn(async () => ({ success: true, rowsAffected: 1 })),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(async () => true),
    getType: vi.fn(() => 'd1'),
    close: vi.fn(async () => {}),
    setLifecycle(next: string | null) {
      lifecycle = next;
    },
    setRows(next: unknown[]) {
      rows = next;
    },
  };
  return value as unknown as TestAdapter;
}

function dataset(
  id: string,
  role: 'admin' | 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii'
): Phase8ValidatedSqliteRestoreDataset {
  const family = role === 'admin' ? 'admin' : role === 'tenant_pii' ? 'pii' : 'core';
  return {
    manifest: {
      formatVersion: 1,
      bundleId: id.padEnd(32, 'a').slice(0, 32),
      source: { tenantId: 'tenant-a', issuer: 'https://a.example', productVersion: '0.4.2' },
      selection: {
        settings: true,
        users: true,
        admin: true,
        artifacts: false,
        logs: { audit: false, other: false, sensitive: false, period: 'all' },
      },
      snapshotId: 'snapshot-a',
      boundaryUnixMs: 1,
      inventoryDigestSha256: 'b'.repeat(64),
      datasets: [],
    },
    policy: {
      dataset: {
        id,
        module: 'test',
        kind: role === 'tenant_core/users' ? 'users' : 'settings',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      },
      schema: {
        table: id.split('.')[1],
        columns: ['id', 'tenant_id'],
        primaryKey: ['id'],
        uniqueKeys: [],
        tenantColumn: 'tenant_id',
      },
      async inspectRow() {
        return [];
      },
      restoreTargetRole: role,
      databaseFamily: family,
    },
  } as unknown as Phase8ValidatedSqliteRestoreDataset;
}

const context = {
  lease: { tenantId: 'tenant-a', operationId: 'operation-a' },
  signal: new AbortController().signal,
} as never;

let platform: TestAdapter;
let admin: TestAdapter;
let core: TestAdapter;
let pii: TestAdapter;

beforeEach(() => {
  vi.clearAllMocks();
  platform = adapter('provisioning');
  admin = adapter();
  core = adapter();
  pii = adapter();
  mocks.resources.mockResolvedValue([
    {
      databaseId: 'core-db',
      database: core,
      assignments: [
        { dataRole: 'tenant_core/default', assignmentGeneration: 7 },
        { dataRole: 'tenant_core/users', assignmentGeneration: 7 },
      ],
    },
    {
      databaseId: 'pii-db',
      database: pii,
      assignments: [{ dataRole: 'tenant_pii', assignmentGeneration: 9 }],
    },
  ]);
  mocks.fixed.mockReturnValue([{ databaseId: 'admin-db', database: admin }]);
});

it('groups validated roles by the exact setup-provisioned physical database', async () => {
  const provider = createProductionTenantBackupRestoreTargets({
    env: { DB: platform, DB_ADMIN: admin } as unknown as Env,
    tenantKey: 'tenant-key-a',
  });
  const targets = await provider.plan(context, [
    dataset('admin.roles', 'admin'),
    dataset('core.tenants', 'tenant_core/default'),
    dataset('core.users', 'tenant_core/users'),
    dataset('pii.users', 'tenant_pii'),
  ]);

  expect(targets).toHaveLength(3);
  expect(targets.find(({ resourceId }) => resourceId === 'core-db')?.datasets).toHaveLength(2);
  const adminTarget = targets.find(({ resourceId }) => resourceId === 'admin-db');
  expect(adminTarget?.targetId).toBe('operation-a:admin-db');
  await adminTarget?.initialize();
  expect(mocks.scopedFingerprint).not.toHaveBeenCalled();
  const initialized = await adminTarget?.initialize();
  await (
    initialized as unknown as {
      readSeedFingerprint?: (admission: () => Promise<void>) => Promise<string>;
    }
  )?.readSeedFingerprint?.(async () => {});
  expect(mocks.scopedFingerprint).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: 'tenant-a', tenantKey: 'tenant-key-a' })
  );
});

it('rejects a target after it has become publicly active', async () => {
  platform.setLifecycle('active');
  const provider = createProductionTenantBackupRestoreTargets({
    env: { DB: platform, DB_ADMIN: admin } as unknown as Env,
    tenantKey: 'tenant-key-a',
  });
  await expect(
    provider.plan(context, [dataset('core.tenants', 'tenant_core/default')])
  ).rejects.toThrow('backup_production_restore_target_invalid');
});

it('reopens the exact sealed shared target receipt', async () => {
  admin.setRows([
    {
      payload_json: JSON.stringify({
        version: 1,
        kind: 'sqlite-restore-target',
        targetId: 'operation-a:admin-db',
        resourceId: 'admin-db',
        provisioningId: 'setup:admin:admin-db',
        seedFingerprint: 'c'.repeat(64),
      }),
    },
  ]);
  const provider = createProductionTenantBackupRestoreTargets({
    env: { DB: platform, DB_ADMIN: admin } as unknown as Env,
    tenantKey: 'tenant-key-a',
  });
  const target = await provider.resolveTarget(context, 'admin-db', 'setup:admin:admin-db');
  await expect(target.readSeedFingerprint?.(async () => {})).resolves.toBe('c'.repeat(64));
});
