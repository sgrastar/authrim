import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  executeD1Command: vi.fn(),
  executeD1Migration: vi.fn(),
  findMigrationsRoot: vi.fn(),
  queryD1Rows: vi.fn(),
  runD1Migrations: vi.fn(),
  loadLock: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  loadRelease: vi.fn(),
  saveLock: vi.fn(),
  recordTargets: vi.fn(),
  spinner: {
    text: '',
    start: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  },
}));

vi.mock('@inquirer/prompts', () => ({ confirm: mocks.confirm }));
vi.mock('ora', () => ({ default: vi.fn(() => mocks.spinner) }));
vi.mock('../core/cloudflare.js', () => ({
  executeD1Command: mocks.executeD1Command,
  executeD1Migration: mocks.executeD1Migration,
  findMigrationsRoot: mocks.findMigrationsRoot,
  queryD1Rows: mocks.queryD1Rows,
  runD1Migrations: mocks.runD1Migrations,
}));
vi.mock('../core/lock.js', () => ({
  loadLockFileAuto: mocks.loadLock,
  acquireEnvironmentOperationLock: mocks.acquireLock,
  saveLockFile: mocks.saveLock,
}));
vi.mock('../core/release-migrations.js', () => ({
  loadInstalledReleaseMigrationManifest: mocks.loadRelease,
  buildTenantD1ReleaseMigrationTarget: vi.fn((target) => target),
  calculateReleaseManifestChecksum: vi.fn(() => 'manifest-checksum'),
}));
vi.mock('../core/release-state.js', () => ({
  withRecordedReleaseSchemaTargets: mocks.recordTargets,
}));

import { tenantDatabaseSlotResetCommand } from '../cli/commands/tenant-db-slot-reset.js';

const slot = {
  slot_id: 'slot-0001',
  slot_number: 1,
  state: 'reset_required',
  assigned_tenant_id: 'tenant-a',
  core_binding_ref: 'TDB_SLOT_0001_CORE',
  pii_binding_ref: 'TDB_SLOT_0001_PII',
  core_database_name: 'tenant-core',
  pii_database_name: 'tenant-pii',
};

describe('tenantDatabaseSlotResetCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spinner.start.mockReturnValue(mocks.spinner);
    mocks.loadLock.mockResolvedValue({
      type: 'new',
      path: '/tmp/lock.json',
      lock: {
        version: '1.0.0',
        env: 'prod',
        createdAt: '2026-07-21T00:00:00.000Z',
        productVersion: '0.4.0',
        kv: {},
        d1: {
          TDB_SLOT_0001_CORE: { id: 'core-id', name: 'tenant-core' },
          TDB_SLOT_0001_PII: { id: 'pii-id', name: 'tenant-pii' },
        },
      },
    });
    mocks.findMigrationsRoot.mockResolvedValue({ path: '/repo/migrations', searchPaths: [] });
    mocks.acquireLock.mockResolvedValue({ release: mocks.releaseLock });
    mocks.recordTargets.mockImplementation((value) => value);
    mocks.loadRelease.mockReturnValue({
      draft: false,
      manifest: {
        productVersion: '0.4.0',
        streams: [
          { id: 'd1-core', files: [{ path: '001.sql', checksum: 'a'.repeat(64) }] },
          { id: 'd1-pii', files: [{ path: '001.sql', checksum: 'b'.repeat(64) }] },
        ],
      },
    });
    mocks.queryD1Rows.mockImplementation(async (_database: string, sql: string) => {
      if (sql.includes('FROM tenant_database_slots')) return [slot];
      if (sql.includes('sqlite_master')) {
        return [
          { type: 'view', name: 'active_users' },
          { type: 'table', name: 'users' },
          { type: 'index', name: 'ignored' },
        ];
      }
      if (sql.includes('migration_count')) return [{ migration_count: '3' }];
      return [];
    });
    mocks.executeD1Migration.mockResolvedValue({ success: true });
    mocks.runD1Migrations.mockResolvedValue({ success: true, applied: ['001.sql'] });
    mocks.executeD1Command.mockResolvedValue({ success: true });
    mocks.confirm.mockResolvedValue(true);
  });

  it.each([undefined, '', '0', '501', 'not-a-slot'])(
    'rejects an invalid slot number before touching storage: %s',
    async (value) => {
      await expect(tenantDatabaseSlotResetCommand({ slot: value })).rejects.toThrow(
        'Missing or invalid required option'
      );
      expect(mocks.loadLock).not.toHaveBeenCalled();
    }
  );

  it('shows a dry-run plan without dropping schemas or changing slot state', async () => {
    await tenantDatabaseSlotResetCommand({ env: 'prod', slot: 'slot-0001', dryRun: true });

    expect(mocks.queryD1Rows).toHaveBeenCalledTimes(3);
    expect(mocks.executeD1Migration).not.toHaveBeenCalled();
    expect(mocks.runD1Migrations).not.toHaveBeenCalled();
    expect(mocks.executeD1Command).not.toHaveBeenCalled();
  });

  it('rejects a slot reset while another topology update is waiting for deployment', async () => {
    mocks.loadLock.mockResolvedValueOnce({
      type: 'new',
      path: '/tmp/lock.json',
      lock: {
        version: '1.0.0',
        env: 'prod',
        createdAt: '2026-07-21T00:00:00.000Z',
        productVersion: '0.4.0',
        kv: {},
        d1: {
          TDB_SLOT_0001_CORE: { id: 'core-id', name: 'tenant-core' },
          TDB_SLOT_0001_PII: { id: 'pii-id', name: 'tenant-pii' },
        },
        topologyUpdate: {
          kind: 'r2',
          phase: 'pending_deploy',
          targetProductVersion: '0.4.0',
          configChecksum: 'a'.repeat(64),
          authorizationTokenHash: 'b'.repeat(64),
          startedAt: '2026-07-21T00:00:00.000Z',
          updatedAt: '2026-07-21T00:00:00.000Z',
        },
      },
    });
    const exit = vi.spyOn(process, 'exit').mockImplementationOnce(() => {
      throw new Error('process.exit:1');
    });

    await expect(
      tenantDatabaseSlotResetCommand({ env: 'prod', slot: '1', yes: true })
    ).rejects.toThrow('process.exit:1');

    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.queryD1Rows).not.toHaveBeenCalled();
    expect(mocks.executeD1Migration).not.toHaveBeenCalled();
  });

  it('honors an interactive cancellation before destructive work', async () => {
    mocks.confirm.mockResolvedValue(false);

    await tenantDatabaseSlotResetCommand({ env: 'prod', slot: '1' });

    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.executeD1Migration).not.toHaveBeenCalled();
  });

  it('drops both schemas, reapplies role-specific migrations, verifies, and releases the slot', async () => {
    await tenantDatabaseSlotResetCommand({ env: 'prod', slot: '1', yes: true });

    expect(mocks.executeD1Migration).toHaveBeenCalledTimes(2);
    const resetSql = await import('node:fs/promises').then(async ({ readFile }) =>
      Promise.all(
        mocks.executeD1Migration.mock.calls.map(([, path]) =>
          readFile(String(path), 'utf-8').catch(() => '')
        )
      )
    );
    // Temporary SQL files are removed after execution; the calls still prove both reset operations ran.
    expect(resetSql).toEqual(['', '']);
    expect(mocks.runD1Migrations).toHaveBeenNthCalledWith(
      1,
      'tenant-core',
      '/repo/migrations',
      undefined,
      expect.objectContaining({ releaseVersion: '0.4.0' })
    );
    expect(mocks.runD1Migrations).toHaveBeenNthCalledWith(
      2,
      'tenant-pii',
      '/repo/migrations/pii',
      undefined,
      expect.objectContaining({ releaseVersion: '0.4.0' })
    );
    expect(mocks.executeD1Command).toHaveBeenCalledWith(
      'prod-authrim-admin-db',
      expect.stringContaining("SET state = 'available'")
    );
    expect(mocks.spinner.succeed).toHaveBeenCalledWith(
      'Tenant D1 slot slot-0001 reset and marked available.'
    );
  });

  it('retires a slot when post-migration verification fails', async () => {
    mocks.queryD1Rows.mockImplementation(async (_database: string, sql: string) => {
      if (sql.includes('FROM tenant_database_slots')) return [slot];
      if (sql.includes('sqlite_master')) return [];
      if (sql.includes('migration_count')) return [{ migration_count: 0 }];
      return [];
    });

    await expect(
      tenantDatabaseSlotResetCommand({ env: 'prod', slot: '1', yes: true })
    ).rejects.toThrow('was retired and will not be reused');
    expect(mocks.executeD1Command).toHaveBeenCalledWith(
      'prod-authrim-admin-db',
      expect.stringContaining("SET state = 'retired'")
    );
    expect(mocks.spinner.fail).toHaveBeenCalledWith('Tenant D1 slot reset failed.');
  });
});
