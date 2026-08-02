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

describe('retired tenant-db command', () => {
  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'authrim-tenant-db-command-')));
    process.chdir(tempDir);
    vi.clearAllMocks();
    mocks.spinner.start.mockReturnValue(mocks.spinner);
    mocks.createD1Database.mockImplementation(async (name: string) => ({
      id: `${name}-id`,
      name,
    }));
    mocks.listD1Databases.mockResolvedValue([]);
    mocks.executeD1Migration.mockResolvedValue({ success: true });
    mocks.deployCommand.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('fails closed without mutating topology managed by the Control Plane', async () => {
    await writeEnvironment();
    const lockPath = join(tempDir!, '.authrim/prod/lock.json');
    const before = await readFile(lockPath, 'utf-8');

    await expect(
      tenantDatabaseCommand({ env: 'prod', tenantId: 'tenant-a', yes: true })
    ).rejects.toThrow('process.exit unexpectedly called with "1"');

    expect(await readFile(lockPath, 'utf-8')).toBe(before);
    expect(mocks.createD1Database).not.toHaveBeenCalled();
    expect(mocks.runD1Migrations).not.toHaveBeenCalled();
    expect(mocks.deployCommand).not.toHaveBeenCalled();
  });
});
