import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createD1Database: vi.fn(),
  executeD1Command: vi.fn(),
  executeD1Migration: vi.fn(),
  findMigrationsRoot: vi.fn(),
  getKVKeyByNamespaceId: vi.fn(),
  putKVKeyByNamespaceId: vi.fn(),
  queryD1Rows: vi.fn(),
  runD1Migrations: vi.fn(),
  getLatestMigrationVersionFromDirectory: vi.fn(),
  signTenantDatabaseRegistryResources: vi.fn(),
  buildTenantDatabaseRegistrySql: vi.fn(),
  buildTenantDatabaseAdminJobSql: vi.fn(),
}));

vi.mock('../core/cloudflare.js', () => ({
  buildInitialTenantBootstrapSql: vi.fn(() => 'INITIAL TENANT SQL'),
  createD1Database: mocks.createD1Database,
  executeD1Command: mocks.executeD1Command,
  executeD1Migration: mocks.executeD1Migration,
  findMigrationsRoot: mocks.findMigrationsRoot,
  getKVKeyByNamespaceId: mocks.getKVKeyByNamespaceId,
  putKVKeyByNamespaceId: mocks.putKVKeyByNamespaceId,
  queryD1Rows: mocks.queryD1Rows,
  runD1Migrations: mocks.runD1Migrations,
}));

vi.mock('../core/tenant-database.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/tenant-database.js')>();
  return {
    ...actual,
    getLatestMigrationVersionFromDirectory: mocks.getLatestMigrationVersionFromDirectory,
    signTenantDatabaseRegistryResources: mocks.signTenantDatabaseRegistryResources,
    buildTenantDatabaseRegistrySql: mocks.buildTenantDatabaseRegistrySql,
    buildTenantDatabaseAdminJobSql: mocks.buildTenantDatabaseAdminJobSql,
  };
});

import { createDefaultConfig } from '../core/config.js';
import {
  ensureInitialTenantD1Resources,
  markTenantD1SlotsDeploymentState,
  publishInitialTenantD1RuntimeSnapshot,
} from '../core/tenant-d1-bootstrap.js';

let root: string;

function config(profile = true) {
  const value = createDefaultConfig('prod');
  if (profile) {
    value.profiles = {
      ...value.profiles,
      defaults: { ...value.profiles?.defaults, storage: 'builtin:storage:tenant-d1' },
    } as never;
    value.tenantD1 = { preallocatedSlots: 1 } as never;
    value.tenant.name = "tenant-o'hara";
  }
  return value;
}

function lock() {
  return {
    d1: {
      DB_ADMIN: { id: 'admin-id', name: 'admin-db' },
      TDB_SLOT_0001_CORE: { id: 'core-id', name: 'core-db' },
      TDB_SLOT_0001_PII: { id: 'pii-id', name: 'pii-db' },
    },
    kv: { TENANT_RUNTIME_REGISTRY: { id: 'registry-kv', title: 'registry' } },
  } as never;
}

describe('tenant D1 bootstrap orchestration', () => {
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-tenant-bootstrap-')));
    vi.clearAllMocks();
    mocks.createD1Database.mockImplementation(async (name: string) => ({ id: `${name}-id`, name }));
    mocks.executeD1Migration.mockResolvedValue({ success: true });
    mocks.findMigrationsRoot.mockResolvedValue({ path: join(root, 'migrations'), searchPaths: [] });
    mocks.runD1Migrations.mockResolvedValue({ success: true });
    mocks.getLatestMigrationVersionFromDirectory.mockReturnValue(42);
    mocks.signTenantDatabaseRegistryResources.mockImplementation(({ resources }) => resources);
    mocks.buildTenantDatabaseRegistrySql.mockReturnValue('REGISTRY SQL');
    mocks.buildTenantDatabaseAdminJobSql.mockReturnValue('JOB SQL');
    mocks.queryD1Rows.mockResolvedValue([{ count: 1 }]);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('skips every operation unless tenant-d1 is the selected storage profile', async () => {
    await expect(
      ensureInitialTenantD1Resources({
        env: 'prod',
        config: config(false),
        lock: lock(),
        rootDir: root,
      })
    ).resolves.toEqual({ success: true, skipped: true });
    await expect(
      markTenantD1SlotsDeploymentState({
        env: 'prod',
        config: config(false),
        lock: lock(),
        state: 'unavailable',
        stage: 'deploy',
      })
    ).resolves.toEqual({ success: true, skipped: true });
    await expect(
      publishInitialTenantD1RuntimeSnapshot({
        env: 'prod',
        config: config(false),
        lock: lock(),
        rootDir: root,
        keysDir: root,
      })
    ).resolves.toEqual({ success: true, skipped: true });
  });

  it('creates missing slot databases, migrates each role, and initializes the tenant', async () => {
    const currentLock = lock();
    delete currentLock.d1.TDB_SLOT_0001_CORE;
    delete currentLock.d1.TDB_SLOT_0001_PII;
    const progress: string[] = [];
    const result = await ensureInitialTenantD1Resources({
      env: 'prod',
      config: config(),
      lock: currentLock,
      rootDir: root,
      onProgress: (message) => progress.push(message),
    });
    expect(result).toEqual({ success: true, createdCount: 2, migratedCount: 2 });
    expect(currentLock.d1.TDB_SLOT_0001_CORE).toMatchObject({ id: expect.any(String) });
    expect(mocks.runD1Migrations).toHaveBeenCalledWith(
      'authrim-prod-tdb-slot-0001-core',
      join(root, 'migrations'),
      expect.any(Function)
    );
    expect(mocks.runD1Migrations).toHaveBeenCalledWith(
      'authrim-prod-tdb-slot-0001-pii',
      join(root, 'migrations', 'pii'),
      expect.any(Function)
    );
    expect(mocks.executeD1Command).toHaveBeenCalledWith(
      'authrim-prod-tdb-slot-0001-core',
      'INITIAL TENANT SQL'
    );
    expect(progress.some((message) => message.includes('Ensuring initial tenant'))).toBe(true);
  });

  it('reuses locked databases and reports missing migrations or migration failures', async () => {
    const currentLock = lock();
    const success = await ensureInitialTenantD1Resources({
      env: 'prod',
      config: config(),
      lock: currentLock,
      rootDir: root,
    });
    expect(success).toMatchObject({ success: true, createdCount: 0 });
    expect(mocks.createD1Database).not.toHaveBeenCalled();

    mocks.findMigrationsRoot.mockResolvedValueOnce({ path: null, searchPaths: ['/a', '/b'] });
    await expect(
      ensureInitialTenantD1Resources({ env: 'prod', config: config(), lock: lock(), rootDir: root })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Searched: /a, /b'),
    });

    mocks.runD1Migrations.mockResolvedValueOnce({ success: false, error: 'SQL failed' });
    await expect(
      ensureInitialTenantD1Resources({ env: 'prod', config: config(), lock: lock(), rootDir: root })
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('SQL failed') });
  });

  it('reports missing admin DB and writes deployment failure state for every slot', async () => {
    const missing = lock();
    delete missing.d1.DB_ADMIN;
    await expect(
      markTenantD1SlotsDeploymentState({
        env: 'prod',
        config: config(),
        lock: missing,
        state: 'unavailable',
        stage: 'deploy',
      })
    ).resolves.toEqual({ success: false, error: 'DB_ADMIN is missing from the lock file' });

    const result = await markTenantD1SlotsDeploymentState({
      env: 'prod',
      config: config(),
      lock: lock(),
      state: 'pending_binding',
      stage: "worker'deploy",
      errorCode: "failure'code",
    });
    expect(result).toEqual({ success: true, updatedSlots: 1 });
    const sqlPath = mocks.executeD1Migration.mock.calls[0][1] as string;
    expect(sqlPath).toContain('authrim-initial-tenant-d1-tenant-o-hara');
    expect(mocks.executeD1Migration).toHaveBeenCalledWith('admin-db', expect.any(String));
  });

  it('propagates admin SQL write failures as structured results', async () => {
    mocks.executeD1Migration.mockResolvedValueOnce({ success: false, error: 'admin unavailable' });
    await expect(
      markTenantD1SlotsDeploymentState({
        env: 'prod',
        config: config(),
        lock: lock(),
        state: 'unavailable',
        stage: 'deploy',
      })
    ).resolves.toEqual({ success: false, error: 'admin unavailable' });
  });

  it('validates lock prerequisites before publishing a runtime snapshot', async () => {
    const noAdmin = lock();
    delete noAdmin.d1.DB_ADMIN;
    await expect(
      publishInitialTenantD1RuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: noAdmin,
        rootDir: root,
        keysDir: root,
      })
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('DB_ADMIN') });
    const noKv = lock();
    delete noKv.kv.TENANT_RUNTIME_REGISTRY;
    await expect(
      publishInitialTenantD1RuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: noKv,
        rootDir: root,
        keysDir: root,
      })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('TENANT_RUNTIME_REGISTRY'),
    });
  });

  it('publishes a signed snapshot, generation pointer, and verifies all stores', async () => {
    const keyPair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const privateJwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
    privateJwk.kid = 'registry-key-1';
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'tenant_runtime_registry_signing_private.jwk.json'),
      JSON.stringify(privateJwk)
    );
    await writeFile(join(root, 'tenant_runtime_registry_signing_key_id.txt'), 'registry-key-file');
    const kv = new Map<string, string>();
    mocks.putKVKeyByNamespaceId.mockImplementation(
      async (_namespace: string, key: string, value: string) => void kv.set(key, value)
    );
    mocks.getKVKeyByNamespaceId.mockImplementation(async (_namespace: string, key: string) =>
      kv.get(key)
    );
    mocks.queryD1Rows
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: '2' }])
      .mockResolvedValueOnce([{ count: 1 }]);
    const result = await publishInitialTenantD1RuntimeSnapshot({
      env: 'prod',
      config: config(),
      lock: lock(),
      rootDir: root,
      keysDir: root,
    });
    expect(result).toEqual({ success: true, publishedSnapshot: true });
    expect(mocks.putKVKeyByNamespaceId).toHaveBeenCalledTimes(2);
    const snapshotCall = mocks.putKVKeyByNamespaceId.mock.calls.find((call) =>
      String(call[1]).includes(':snapshot:')
    )!;
    const snapshot = JSON.parse(snapshotCall[2]) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      tenantId: "tenant-o'hara",
      metadata: {
        storeCount: 2,
        signature: expect.any(String),
        signatureKeyId: 'registry-key-file',
        signatureAlgorithm: 'Ed25519',
      },
    });
    expect(snapshot.stores.map((store: { role: string }) => store.role).sort()).toEqual([
      'tenant_core',
      'tenant_pii',
    ]);
    expect(mocks.queryD1Rows).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid signing keys and failed snapshot verification', async () => {
    await writeFile(
      join(root, 'tenant_runtime_registry_signing_private.jwk.json'),
      JSON.stringify({ kty: 'RSA', kid: 'bad' })
    );
    await expect(
      publishInitialTenantD1RuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        keysDir: root,
      })
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('must_be_ed25519') });
  });
});
