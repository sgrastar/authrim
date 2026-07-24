import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultConfig } from '../core/config.js';

const mocks = vi.hoisted(() => ({
  createD1Database: vi.fn(),
  deployCommand: vi.fn(),
  executeD1Migration: vi.fn(),
  listD1Databases: vi.fn(),
  runD1Migrations: vi.fn(),
  spinner: {
    text: '',
    start: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('ora', () => ({ default: vi.fn(() => mocks.spinner) }));
vi.mock('../cli/commands/deploy.js', () => ({ deployCommand: mocks.deployCommand }));
vi.mock('../core/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/cloudflare.js')>();
  return {
    ...actual,
    createD1Database: mocks.createD1Database,
    executeD1Migration: mocks.executeD1Migration,
    findMigrationsRoot: vi.fn(async () => ({ path: '/virtual/migrations', searchPaths: [] })),
    listD1Databases: mocks.listD1Databases,
    runD1Migrations: mocks.runD1Migrations,
  };
});
vi.mock('../core/release-migrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/release-migrations.js')>();
  return {
    ...actual,
    loadInstalledReleaseMigrationManifest: vi.fn(() => ({
      path: '/virtual/migrations/releases/0.4.0.json',
      manifest: {
        formatVersion: 1,
        productVersion: '0.4.0',
        streams: [
          {
            id: 'd1-core',
            dialect: 'sqlite',
            logicalRoles: ['core'],
            files: [{ path: '0001_core.sql', checksum: 'a'.repeat(64) }],
          },
          {
            id: 'd1-pii',
            dialect: 'sqlite',
            logicalRoles: ['pii'],
            files: [{ path: '0001_pii.sql', checksum: 'b'.repeat(64) }],
          },
        ],
      },
    })),
  };
});

import { tenantDatabaseCommand } from '../cli/commands/tenant-db.js';
import { buildTenantDatabaseProvisioningPlan } from '../core/tenant-database.js';

const originalCwd = process.cwd();
let tempDir: string | null = null;

async function writeEnvironment(): Promise<void> {
  const environmentDir = join(tempDir!, '.authrim', 'prod');
  await mkdir(environmentDir, { recursive: true });
  await writeFile(
    join(tempDir!, 'package.json'),
    `${JSON.stringify({ name: 'authrim-test-installation', version: '0.4.0' }, null, 2)}\n`
  );
  await writeFile(
    join(environmentDir, 'config.json'),
    `${JSON.stringify(createDefaultConfig('prod'), null, 2)}\n`
  );
  await writeFile(
    join(environmentDir, 'lock.json'),
    `${JSON.stringify(
      {
        version: '1.0.0',
        productVersion: '0.4.0',
        env: 'prod',
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
        d1: { DB_ADMIN: { id: 'admin-id', name: 'prod-authrim-admin-db' } },
        kv: {},
      },
      null,
      2
    )}\n`
  );
}

describe('tenant-db command interruption recovery', () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-tenant-db-command-')));
    process.chdir(tempDir);
    vi.clearAllMocks();
    mocks.spinner.start.mockReturnValue(mocks.spinner);
    const plan = buildTenantDatabaseProvisioningPlan({ env: 'prod', tenantId: 'tenant-a' });
    mocks.createD1Database.mockImplementation(async (name: string) => ({
      id: `${name}-id`,
      name,
    }));
    mocks.listD1Databases.mockResolvedValue(
      plan.resources.map((resource) => ({
        uuid: `${resource.databaseName}-id`,
        name: resource.databaseName,
      }))
    );
    mocks.executeD1Migration.mockResolvedValue({ success: true });
    mocks.deployCommand.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('keeps preparation blocked and reuses its exact databases after a migration failure', async () => {
    await writeEnvironment();
    mocks.runD1Migrations.mockResolvedValueOnce({ success: false, error: 'migration failed' });

    await expect(
      tenantDatabaseCommand({ env: 'prod', tenantId: 'tenant-a', yes: true })
    ).rejects.toThrow('Core tenant D1 migration failed: migration failed');

    const lockPath = join(tempDir!, '.authrim/prod/lock.json');
    const interruptedLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(interruptedLock.topologyUpdate).toMatchObject({
      kind: 'tenant_database',
      phase: 'preparing',
      subject: 'tenant-a:1',
    });
    expect(
      Object.keys(interruptedLock.d1).filter((binding) => binding.startsWith('TDB_'))
    ).toHaveLength(2);
    expect(mocks.createD1Database).toHaveBeenCalledTimes(2);
    expect(mocks.deployCommand).not.toHaveBeenCalled();

    mocks.runD1Migrations.mockReset();
    mocks.runD1Migrations.mockResolvedValue({ success: true, appliedCount: 1, applied: [] });
    await tenantDatabaseCommand({ env: 'prod', tenantId: 'tenant-a', yes: true });

    expect(mocks.createD1Database).toHaveBeenCalledTimes(2);
    expect(mocks.runD1Migrations).toHaveBeenCalledTimes(2);
    expect(mocks.deployCommand).toHaveBeenCalledOnce();
    const readyLock = JSON.parse(await readFile(lockPath, 'utf-8'));
    expect(readyLock.topologyUpdate).toMatchObject({
      kind: 'tenant_database',
      phase: 'pending_deploy',
      subject: 'tenant-a:1',
    });
  });
});
