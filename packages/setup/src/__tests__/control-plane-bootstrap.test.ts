import { existsSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createD1Database: vi.fn(),
  executeD1Command: vi.fn(),
  executeD1Migration: vi.fn(),
  findMigrationsRoot: vi.fn(),
  getKVKeyByNamespaceId: vi.fn(),
  getOptionalKVKeyByNamespaceId: vi.fn(),
  putKVKeyByNamespaceId: vi.fn(),
  queryD1Rows: vi.fn(),
  runD1Migrations: vi.fn(),
  getLatestMigrationVersionFromDirectory: vi.fn(),
  signTenantDatabaseRegistryResources: vi.fn(),
  buildTenantDatabaseRegistrySql: vi.fn(),
}));

vi.mock('../core/cloudflare.js', () => ({
  buildInitialTenantBootstrapSql: vi.fn(() => 'INITIAL TENANT SQL'),
  createD1Database: mocks.createD1Database,
  executeD1Command: mocks.executeD1Command,
  executeD1Migration: mocks.executeD1Migration,
  findMigrationsRoot: mocks.findMigrationsRoot,
  getKVKeyByNamespaceId: mocks.getKVKeyByNamespaceId,
  getOptionalKVKeyByNamespaceId: mocks.getOptionalKVKeyByNamespaceId,
  getProvisioningResourceAdoptionPolicy: (
    resources: Record<string, { state: string; id?: string }>,
    resource: { kind: string; binding: string }
  ) => {
    const checkpoint = resources[`${resource.kind}:${resource.binding}`];
    return {
      allowExisting: checkpoint?.state === 'identified' || checkpoint?.state === 'created',
      recordedState: checkpoint?.state,
      expectedExistingId: checkpoint?.id,
    };
  },
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
  };
});

import { createDefaultConfig } from '../core/config.js';
import {
  buildInitialTenantAliasBootstrap,
  ensureInitialControlPlaneResources,
  ensureInitialTenantRegionShardConfig,
  inspectInitialControlPlaneTopology,
  publishInitialControlPlaneRuntimeSnapshot,
} from '../core/control-plane-bootstrap.js';
import {
  calculateReleaseManifestChecksum,
  type ReleaseMigrationManifest,
} from '../core/release-migrations.js';
import { loadProvisioningIntent } from '../core/provisioning-intent.js';
import { loadLockFileAuto, saveLockFile } from '../core/lock.js';

let root: string;

function config(automaticProvisioning = true) {
  const value = createDefaultConfig('prod');
  value.cloudflare.accountId = 'a'.repeat(32);
  value.controlPlane.automaticProvisioning = automaticProvisioning;
  value.tenant.name = 'tenant-ohara';
  return value;
}

function lock() {
  return {
    d1: {
      DB_ADMIN: { id: 'admin-id', name: 'admin-db' },
      CONTROL_DB: { id: 'control-id', name: 'control-db' },
      LOOKUP_DB: { id: 'lookup-id', name: 'lookup-db' },
      PROD_TDB_DEFAULT_BOOTSTRAP_CORE: {
        id: 'default-id',
        name: 'prod-authrim-tenant-default-bootstrap-db',
      },
      PROD_TDB_USERS_BOOTSTRAP_CORE: {
        id: 'users-id',
        name: 'prod-authrim-tenant-users-bootstrap-db',
      },
      PROD_TDB_PII_BOOTSTRAP_PII: {
        id: 'pii-id',
        name: 'prod-authrim-tenant-pii-bootstrap-db',
      },
    },
    kv: {
      AUTHRIM_CONFIG: { id: 'config-kv', title: 'config' },
      TENANT_RUNTIME_REGISTRY: { id: 'registry-kv', title: 'registry' },
    },
  } as never;
}

function release(): ReleaseMigrationManifest {
  return {
    formatVersion: 2,
    productVersion: '1.0.0',
    streams: [
      {
        id: 'core-d1',
        schemaFamily: 'core',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['core', 'tenant_core'],
        files: [{ path: '001_core.sql', checksum: '1'.repeat(64) }],
      },
      {
        id: 'pii-d1',
        schemaFamily: 'pii',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['pii', 'tenant_pii'],
        files: [{ path: '001_pii.sql', checksum: '2'.repeat(64) }],
      },
      {
        id: 'lookup-d1',
        schemaFamily: 'lookup',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['lookup'],
        files: [{ path: '001_lookup.sql', checksum: '3'.repeat(64) }],
      },
    ],
  };
}

async function writeRuntimeRegistrySigningKey(): Promise<void> {
  const keyPair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const privateJwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
  privateJwk.kid = 'registry-key-file';
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'tenant_runtime_registry_signing_private.jwk.json'),
    JSON.stringify(privateJwk)
  );
  await writeFile(join(root, 'tenant_runtime_registry_signing_key_id.txt'), 'registry-key-file');
}

describe('initial Control Plane bootstrap orchestration', () => {
  const regionPolicyRows = (input?: { jurisdiction?: 'eu' | 'fedramp' | null }) =>
    ['tenant_core/default', 'tenant_core/users', 'tenant_pii'].map((dataRole, index) => ({
      residency_policy_id: 'builtin:residency:default',
      residency_partition: 'default',
      policy_generation: 1,
      policy_updated_at: 1_700_000_000,
      jurisdiction: input?.jurisdiction ?? null,
      location_hint: null,
      data_role: dataRole,
      shard_id: index === 0 ? 'default-shard' : `shard-${index}`,
      selected_shard_id: 'default-shard',
    }));

  async function prepareRuntimeRegistryVerification() {
    await writeRuntimeRegistrySigningKey();
    const kv = new Map<string, string>();
    mocks.putKVKeyByNamespaceId.mockImplementation(
      async (_namespace: string, key: string, value: string) => void kv.set(key, value)
    );
    mocks.queryD1Rows.mockImplementation(async (_database: string, sql: string) => {
      if (sql.includes('control_tenant_default_allocations')) return regionPolicyRows();
      if (sql.includes('tenant_database_active_pointers')) return [{ count: '3' }];
      if (sql.includes('lookup_tenant_aliases')) return [{ count: '3' }];
      return [{ count: 1 }];
    });
    return kv;
  }

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'authrim-tenant-bootstrap-')));
    vi.clearAllMocks();
    mocks.createD1Database.mockImplementation(
      async (
        name: string,
        _options: unknown,
        behavior?: {
          onCreateIssued?: () => Promise<void>;
          onProviderIdentityIdentified?: (identity: { id: string }) => Promise<void>;
        }
      ) => {
        await behavior?.onCreateIssued?.();
        const id = `${name}-id`;
        await behavior?.onProviderIdentityIdentified?.({ id });
        return { id, name };
      }
    );
    mocks.executeD1Migration.mockResolvedValue({ success: true });
    mocks.findMigrationsRoot.mockResolvedValue({ path: join(root, 'migrations'), searchPaths: [] });
    mocks.runD1Migrations.mockResolvedValue({ success: true });
    mocks.getLatestMigrationVersionFromDirectory.mockReturnValue(42);
    mocks.signTenantDatabaseRegistryResources.mockImplementation(({ resources }) => resources);
    mocks.buildTenantDatabaseRegistrySql.mockReturnValue('REGISTRY SQL');
    mocks.getOptionalKVKeyByNamespaceId.mockResolvedValue(null);
    mocks.queryD1Rows.mockImplementation(async (_database: string, sql: string) =>
      sql.includes('control_tenant_default_allocations')
        ? regionPolicyRows()
        : [{ count: sql.includes('lookup_tenant_aliases') ? 3 : 1 }]
    );
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('builds active lookup aliases for the initial tenant and environment', async () => {
    const result = await buildInitialTenantAliasBootstrap({
      environmentId: 'prod',
      tenantId: 'first',
      tenantCode: 'first',
      defaultStore: {
        bindingRef: 'PROD_TDB_DEFAULT_BOOTSTRAP_CORE',
        bindingRouteGeneration: 1,
        residencyPolicyId: 'builtin:residency:default',
        residencyPartition: 'default',
        shardId: 'shard-bootstrap-default',
      } as never,
      now: 1_700_000_000,
    });

    expect(result.indexes.map((index) => index.aliasKind)).toEqual([
      'tenant_code',
      'tenant_slug',
      'environment_tenant',
    ]);
    expect(result.sql).toContain('INSERT INTO lookup_tenant_aliases');
    expect(result.sql).toContain("'active', 'active', 'active'");
    expect(JSON.parse(result.projectionJson)).toMatchObject({
      tenantRouteGeneration: 1,
      target: {
        dataRole: 'tenant_core/default',
        bindingRef: 'PROD_TDB_DEFAULT_BOOTSTRAP_CORE',
      },
    });
  });

  it('bootstraps the initial shards even when automatic provisioning is disabled', async () => {
    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(false),
        lock: lock(),
        rootDir: root,
        release: { manifest: release(), draft: true },
      })
    ).resolves.toEqual({ success: true, createdCount: 0, migratedCount: 3 });
    expect(mocks.runD1Migrations).toHaveBeenCalledTimes(3);
  });

  it('creates the initial default, users, and PII databases and pins their migrations', async () => {
    const currentLock = lock();
    delete currentLock.d1.PROD_TDB_DEFAULT_BOOTSTRAP_CORE;
    delete currentLock.d1.PROD_TDB_USERS_BOOTSTRAP_CORE;
    delete currentLock.d1.PROD_TDB_PII_BOOTSTRAP_PII;
    const progress: string[] = [];
    const persistedBindings: string[][] = [];
    const result = await ensureInitialControlPlaneResources({
      env: 'prod',
      config: config(),
      lock: currentLock,
      rootDir: root,
      release: { manifest: release(), draft: true },
      persistLockCheckpoint: async (checkpoint) => {
        const intent = await loadProvisioningIntent({ baseDir: root, environment: 'prod' });
        const lockedBindings = Object.keys(checkpoint.d1).filter((binding) =>
          binding.includes('_TDB_')
        );
        const lastBinding = lockedBindings.at(-1);
        expect(intent?.resources[`d1:${lastBinding}`]?.state).toBe('created');
        persistedBindings.push(lockedBindings);
      },
      onProgress: (message) => progress.push(message),
    });
    expect(result).toEqual({ success: true, createdCount: 3, migratedCount: 3 });
    expect(currentLock.d1.PROD_TDB_DEFAULT_BOOTSTRAP_CORE).toMatchObject({
      id: expect.any(String),
    });
    expect(mocks.runD1Migrations).toHaveBeenCalledWith(
      'prod-authrim-tenant-default-bootstrap-db-id',
      join(root, 'migrations', 'core', 'd1'),
      expect.any(Function),
      expect.objectContaining({
        releaseVersion: expect.stringMatching(/^1\.0\.0-draft\.[a-f0-9]{12}$/u),
      })
    );
    expect(mocks.runD1Migrations).toHaveBeenCalledWith(
      'prod-authrim-tenant-users-bootstrap-db-id',
      join(root, 'migrations', 'core', 'd1'),
      expect.any(Function),
      expect.objectContaining({
        releaseVersion: expect.stringMatching(/^1\.0\.0-draft\.[a-f0-9]{12}$/u),
      })
    );
    expect(mocks.runD1Migrations).toHaveBeenCalledWith(
      'prod-authrim-tenant-pii-bootstrap-db-id',
      join(root, 'migrations', 'pii', 'd1'),
      expect.any(Function),
      expect.objectContaining({
        releaseVersion: expect.stringMatching(/^1\.0\.0-draft\.[a-f0-9]{12}$/u),
      })
    );
    expect(mocks.executeD1Command).toHaveBeenCalledTimes(3);
    expect(mocks.queryD1Rows).toHaveBeenCalledWith(
      'control-id',
      expect.stringContaining('FROM control_bootstrap_handoffs')
    );
    expect(progress.some((message) => message.includes('Ensuring initial Control-plane'))).toBe(
      true
    );
    expect(persistedBindings.map((bindings) => bindings.length)).toEqual([1, 2, 3]);
  });

  it('fails closed with exact remediation after an ambiguous tenant-shard create', async () => {
    const currentLock = lock();
    delete currentLock.d1.PROD_TDB_DEFAULT_BOOTSTRAP_CORE;
    delete currentLock.d1.PROD_TDB_USERS_BOOTSTRAP_CORE;
    delete currentLock.d1.PROD_TDB_PII_BOOTSTRAP_PII;
    let providerAttempt = 0;
    const observedAllowExisting: boolean[] = [];
    mocks.createD1Database.mockImplementation(
      async (
        name: string,
        _options: unknown,
        behavior?: { allowExisting?: boolean; onCreateIssued?: () => Promise<void> }
      ) => {
        observedAllowExisting.push(behavior?.allowExisting === true);
        if (providerAttempt++ === 0) {
          await behavior?.onCreateIssued?.();
          throw new Error('provider response lost');
        }
        throw new Error(`unsafe second provider mutation for ${name}`);
      }
    );

    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: currentLock,
        rootDir: root,
        release: { manifest: release(), draft: true },
        persistLockCheckpoint: async () => undefined,
      })
    ).resolves.toMatchObject({ success: false, error: 'provider response lost' });
    await expect(
      loadProvisioningIntent({ baseDir: root, environment: 'prod' })
    ).resolves.toMatchObject({
      resources: {
        'd1:PROD_TDB_DEFAULT_BOOTSTRAP_CORE': { state: 'create_issued' },
      },
    });

    const resumed = await ensureInitialControlPlaneResources({
      env: 'prod',
      config: config(),
      lock: currentLock,
      rootDir: root,
      release: { manifest: release(), draft: true },
      persistLockCheckpoint: async () => undefined,
    });
    expect(resumed).toMatchObject({ success: false });
    expect(resumed.error).toContain('initial_control_plane_resource_create_ambiguous');
    expect(resumed.error).toContain('PROD_TDB_DEFAULT_BOOTSTRAP_CORE');
    expect(resumed.error).toContain('prod-authrim-tenant-default-bootstrap-db');
    expect(resumed.error).toContain('Cloudflare');
    expect(resumed.error).toContain('automatic recovery is unavailable');
    expect(resumed.error).toContain('inspect the exact name');
    expect(resumed.error).toContain('pnpm run setup delete --env prod --all --yes');
    expect(resumed.error).toContain('immutable identity is missing');
    expect(resumed.error).toContain('manually delete only that exact ambiguous name');
    expect(resumed.error).toContain('pnpm run setup init --env prod');
    expect(observedAllowExisting).toEqual([false]);
    expect(providerAttempt).toBe(1);
    await expect(
      loadProvisioningIntent({ baseDir: root, environment: 'prod' })
    ).resolves.toMatchObject({
      resources: {
        'd1:PROD_TDB_DEFAULT_BOOTSTRAP_CORE': { state: 'create_issued' },
      },
    });
  });

  it('clears a fully checkpointed intent when Control has already accepted the handoff', async () => {
    const currentLock = lock();
    delete currentLock.d1.PROD_TDB_DEFAULT_BOOTSTRAP_CORE;
    delete currentLock.d1.PROD_TDB_USERS_BOOTSTRAP_CORE;
    delete currentLock.d1.PROD_TDB_PII_BOOTSTRAP_PII;
    let checkpoints = 0;

    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: currentLock,
        rootDir: root,
        release: { manifest: release(), draft: true },
        persistLockCheckpoint: async () => {
          checkpoints += 1;
          if (checkpoints === 3) throw new Error('crash_after_final_lock_checkpoint');
        },
      })
    ).resolves.toMatchObject({ success: false, error: 'crash_after_final_lock_checkpoint' });
    await expect(
      loadProvisioningIntent({ baseDir: root, environment: 'prod' })
    ).resolves.toMatchObject({
      resources: {
        'd1:PROD_TDB_DEFAULT_BOOTSTRAP_CORE': { state: 'created' },
        'd1:PROD_TDB_USERS_BOOTSTRAP_CORE': { state: 'created' },
        'd1:PROD_TDB_PII_BOOTSTRAP_PII': { state: 'created' },
      },
    });

    mocks.queryD1Rows.mockResolvedValueOnce([{ state: 'accepted', verification_error_code: null }]);
    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: currentLock,
        rootDir: root,
        release: { manifest: release(), draft: true },
      })
    ).resolves.toEqual({ success: true, skipped: true });
    await expect(
      loadProvisioningIntent({ baseDir: root, environment: 'prod' })
    ).resolves.toBeNull();
  });

  it('does not complete an intent whose created checkpoint disagrees with the lock', async () => {
    const currentLock = lock();
    delete currentLock.d1.PROD_TDB_DEFAULT_BOOTSTRAP_CORE;
    delete currentLock.d1.PROD_TDB_USERS_BOOTSTRAP_CORE;
    delete currentLock.d1.PROD_TDB_PII_BOOTSTRAP_PII;

    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: currentLock,
        rootDir: root,
        release: { manifest: release(), draft: true },
        persistLockCheckpoint: async () => {
          throw new Error('crash_after_first_lock_checkpoint');
        },
      })
    ).resolves.toMatchObject({ success: false, error: 'crash_after_first_lock_checkpoint' });
    currentLock.d1.PROD_TDB_DEFAULT_BOOTSTRAP_CORE!.id = 'different-database-id';

    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: currentLock,
        rootDir: root,
        release: { manifest: release(), draft: true },
        persistLockCheckpoint: async () => undefined,
      })
    ).resolves.toMatchObject({
      success: false,
      error: 'initial_control_plane_intent_lock_mismatch:PROD_TDB_DEFAULT_BOOTSTRAP_CORE',
    });
    expect(mocks.createD1Database).toHaveBeenCalledTimes(1);
    await expect(
      loadProvisioningIntent({ baseDir: root, environment: 'prod' })
    ).resolves.not.toBeNull();
  });

  it('fails closed instead of overwriting a concurrently changed environment lock', async () => {
    const persistedLock = {
      ...lock(),
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      env: 'prod',
      kv: {
        AUTHRIM_CONFIG: { id: 'config-kv', name: 'prod-AUTHRIM_CONFIG' },
        TENANT_RUNTIME_REGISTRY: { id: 'registry-kv', name: 'prod-TENANT_RUNTIME_REGISTRY' },
      },
    };
    delete persistedLock.d1.PROD_TDB_DEFAULT_BOOTSTRAP_CORE;
    delete persistedLock.d1.PROD_TDB_USERS_BOOTSTRAP_CORE;
    delete persistedLock.d1.PROD_TDB_PII_BOOTSTRAP_PII;
    const lockPath = join(root, '.authrim', 'prod', 'lock.json');
    await saveLockFile(persistedLock, lockPath);
    const staleLock = structuredClone(persistedLock);
    const concurrentLock = structuredClone(persistedLock);
    concurrentLock.workers = { 'ar-control': { name: 'prod-ar-control' } };
    await saveLockFile(concurrentLock, lockPath);

    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: staleLock,
        rootDir: root,
        release: { manifest: release(), draft: true },
      })
    ).resolves.toMatchObject({
      success: false,
      error: 'initial_control_plane_lock_changed_before_checkpoint:PROD_TDB_DEFAULT_BOOTSTRAP_CORE',
    });
    const reflected = await loadLockFileAuto(root, 'prod');
    expect(reflected.lock?.workers?.['ar-control']).toEqual({ name: 'prod-ar-control' });
    expect(reflected.lock?.d1.PROD_TDB_DEFAULT_BOOTSTRAP_CORE).toBeUndefined();
  });

  it('strictly replaces stale in-memory lock keys from an already-persisted shard checkpoint', async () => {
    const persistedLock = {
      ...lock(),
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      env: 'prod',
      kv: {
        AUTHRIM_CONFIG: { id: 'config-kv', name: 'prod-AUTHRIM_CONFIG' },
        TENANT_RUNTIME_REGISTRY: { id: 'registry-kv', name: 'prod-TENANT_RUNTIME_REGISTRY' },
      },
    };
    const databaseName = 'prod-authrim-tenant-default-bootstrap-db';
    persistedLock.d1.PROD_TDB_DEFAULT_BOOTSTRAP_CORE = {
      id: `${databaseName}-id`,
      name: databaseName,
    };
    const lockPath = join(root, '.authrim', 'prod', 'lock.json');
    await saveLockFile(persistedLock, lockPath);

    const staleLock = structuredClone(persistedLock);
    delete staleLock.d1.PROD_TDB_DEFAULT_BOOTSTRAP_CORE;
    staleLock.d1.STALE_TENANT_DATABASE = { id: 'stale-id', name: 'stale-db' };
    (staleLock as typeof staleLock & { workers?: Record<string, { name: string }> }).workers = {
      'ar-control': { name: 'stale-prod-ar-control' },
    };

    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: staleLock as never,
        rootDir: root,
        release: { manifest: release(), draft: true },
      })
    ).resolves.toMatchObject({ success: true, createdCount: 1 });

    const reflected = await loadLockFileAuto(root, 'prod');
    expect(staleLock).toEqual(reflected.lock);
    expect(staleLock.d1.STALE_TENANT_DATABASE).toBeUndefined();
    expect('workers' in staleLock).toBe(false);
  });

  it('fails closed when an accepted handoff is missing a locked shard identity', async () => {
    const currentLock = lock();
    delete currentLock.d1.PROD_TDB_PII_BOOTSTRAP_PII;
    mocks.queryD1Rows.mockResolvedValueOnce([{ state: 'accepted', verification_error_code: null }]);

    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: currentLock,
        rootDir: root,
        release: { manifest: release(), draft: true },
      })
    ).resolves.toMatchObject({
      success: false,
      error: 'initial_control_plane_accepted_lock_incomplete:PROD_TDB_PII_BOOTSTRAP_PII',
    });
    expect(mocks.createD1Database).not.toHaveBeenCalled();
  });

  it('detects missing or unregistered tenant topology without mutating resources', () => {
    const manifest = release();
    const currentLock = lock();
    delete currentLock.d1.PROD_TDB_PII_BOOTSTRAP_PII;

    expect(
      inspectInitialControlPlaneTopology({
        env: 'prod',
        config: config(),
        lock: currentLock,
        productVersion: '1.0.0',
        manifest,
      })
    ).toEqual([
      {
        binding: 'PROD_TDB_DEFAULT_BOOTSTRAP_CORE',
        reason: 'schema_not_registered',
        targetId: 'd1:default-id:core-d1',
      },
      {
        binding: 'PROD_TDB_USERS_BOOTSTRAP_CORE',
        reason: 'schema_not_registered',
        targetId: 'd1:users-id:core-d1',
      },
      { binding: 'PROD_TDB_PII_BOOTSTRAP_PII', reason: 'missing_binding' },
    ]);
    expect(mocks.createD1Database).not.toHaveBeenCalled();

    currentLock.d1.PROD_TDB_PII_BOOTSTRAP_PII = {
      id: 'pii-id',
      name: 'prod-authrim-tenant-pii-bootstrap-db',
    };
    const manifestChecksum = calculateReleaseManifestChecksum(manifest);
    currentLock.schemaTargets = {
      'd1:default-id:core-d1': {
        productVersion: '1.0.0',
        manifestChecksum,
        streamId: 'core-d1',
        appliedBy: 'automatic',
        updatedAt: new Date().toISOString(),
      },
      'd1:users-id:core-d1': {
        productVersion: '1.0.0',
        manifestChecksum,
        streamId: 'core-d1',
        appliedBy: 'automatic',
        updatedAt: new Date().toISOString(),
      },
      'd1:pii-id:pii-d1': {
        productVersion: '1.0.0',
        manifestChecksum,
        streamId: 'pii-d1',
        appliedBy: 'automatic',
        updatedAt: new Date().toISOString(),
      },
    };
    expect(
      inspectInitialControlPlaneTopology({
        env: 'prod',
        config: config(),
        lock: currentLock,
        productVersion: '1.0.0',
        manifest,
      })
    ).toEqual([]);
  });

  it('reuses locked databases and reports missing migrations or migration failures', async () => {
    const currentLock = lock();
    const success = await ensureInitialControlPlaneResources({
      env: 'prod',
      config: config(),
      lock: currentLock,
      rootDir: root,
      release: { manifest: release(), draft: true },
    });
    expect(success).toMatchObject({ success: true, createdCount: 0 });
    expect(mocks.createD1Database).not.toHaveBeenCalled();

    mocks.findMigrationsRoot.mockResolvedValueOnce({ path: null, searchPaths: ['/a', '/b'] });
    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        release: { manifest: release(), draft: true },
      })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Searched: /a, /b'),
    });

    mocks.runD1Migrations.mockResolvedValueOnce({ success: false, error: 'SQL failed' });
    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        release: { manifest: release(), draft: true },
      })
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('SQL failed') });
  });

  it('revalidates locked resources when bootstrap handoff verification is pending', async () => {
    mocks.queryD1Rows.mockResolvedValueOnce([{ state: 'pending_verification' }]);

    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        release: { manifest: release(), draft: true },
      })
    ).resolves.toEqual({ success: true, createdCount: 0, migratedCount: 3 });
    expect(mocks.createD1Database).not.toHaveBeenCalled();
    expect(mocks.runD1Migrations).toHaveBeenCalledTimes(3);
  });

  it('validates lock prerequisites before publishing a runtime snapshot', async () => {
    const noAdmin = lock();
    delete noAdmin.d1.DB_ADMIN;
    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: noAdmin,
        rootDir: root,
        keysDir: root,
        release: release(),
      })
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('DB_ADMIN') });
    const noKv = lock();
    delete noKv.kv.TENANT_RUNTIME_REGISTRY;
    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: noKv,
        rootDir: root,
        keysDir: root,
        release: release(),
      })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('TENANT_RUNTIME_REGISTRY'),
    });
    const noConfigKv = lock();
    delete noConfigKv.kv.AUTHRIM_CONFIG;
    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: noConfigKv,
        rootDir: root,
        keysDir: root,
        release: release(),
      })
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('AUTHRIM_CONFIG'),
    });
  });

  it('does not fall back to the Control database name when its immutable ID is missing', async () => {
    const controlWithoutId = lock();
    delete (controlWithoutId.d1.CONTROL_DB as { id?: string }).id;

    await expect(
      ensureInitialControlPlaneResources({
        env: 'prod',
        config: config(),
        lock: controlWithoutId,
        rootDir: root,
        release: { manifest: release(), draft: true },
      })
    ).resolves.toMatchObject({ success: false, error: 'control_database_id_required' });
    expect(mocks.runD1Migrations).not.toHaveBeenCalled();
    expect(mocks.queryD1Rows).not.toHaveBeenCalled();
  });

  it('seeds a deterministic policy-bound region config and preserves a matching config', async () => {
    const values = new Map<string, string>();
    const first = await ensureInitialTenantRegionShardConfig({
      environmentId: 'prod',
      tenantId: "tenant-o'hara",
      controlDatabaseName: 'control-db',
      configNamespaceId: 'config-kv',
      query: vi.fn().mockResolvedValue(regionPolicyRows({ jurisdiction: 'eu' })),
      getOptionalKv: vi.fn().mockResolvedValue(null),
      putKv: vi.fn(async (_namespace: string, key: string, value: string) => {
        values.set(key, value);
      }),
    });
    expect(first.created).toBe(true);
    expect(first.config).toMatchObject({
      currentGeneration: 1,
      updatedAt: 1_700_000_000_000,
      residency: {
        allowedRegions: ['weur', 'eeur'],
        jurisdiction: 'eu',
        policyGeneration: 1,
      },
    });
    const serialized = values.get("region_shard_config:tenant-o'hara");
    expect(serialized).toBeTruthy();
    const putKv = vi.fn();
    const second = await ensureInitialTenantRegionShardConfig({
      environmentId: 'prod',
      tenantId: "tenant-o'hara",
      controlDatabaseName: 'control-db',
      configNamespaceId: 'config-kv',
      query: vi.fn().mockResolvedValue(regionPolicyRows({ jurisdiction: 'eu' })),
      getOptionalKv: vi.fn().mockResolvedValue(serialized),
      putKv,
    });
    expect(second).toEqual({ created: false, config: first.config });
    expect(putKv).not.toHaveBeenCalled();
  });

  it('fails closed for incomplete Control topology or a stale existing region policy', async () => {
    await expect(
      ensureInitialTenantRegionShardConfig({
        environmentId: 'prod',
        tenantId: 'tenant-a',
        controlDatabaseName: 'control-db',
        configNamespaceId: 'config-kv',
        query: vi.fn().mockResolvedValue(regionPolicyRows().slice(0, 2)),
        getOptionalKv: vi.fn(),
        putKv: vi.fn(),
      })
    ).rejects.toThrow('initial_tenant_region_control_topology_incomplete');

    const stale = {
      currentGeneration: 1,
      currentTotalShards: 4,
      currentRegions: {
        apac: { startShard: 0, endShard: 3, shardCount: 4 },
      },
      previousGenerations: [],
      maxPreviousGenerations: 5,
      updatedAt: 1,
      residency: {
        version: 1,
        residencyPolicyId: 'builtin:residency:other',
        residencyPartition: 'default',
        policyGeneration: 1,
        allowedRegions: ['apac'],
        jurisdiction: null,
      },
    };
    const putKv = vi.fn();
    await expect(
      ensureInitialTenantRegionShardConfig({
        environmentId: 'prod',
        tenantId: 'tenant-a',
        controlDatabaseName: 'control-db',
        configNamespaceId: 'config-kv',
        query: vi.fn().mockResolvedValue(regionPolicyRows()),
        getOptionalKv: vi.fn().mockResolvedValue(JSON.stringify(stale)),
        putKv,
      })
    ).rejects.toThrow('initial_tenant_region_config_policy_stale');
    expect(putKv).not.toHaveBeenCalled();
  });

  it('publishes a signed snapshot, generation pointer, and verifies all stores', async () => {
    const keyPair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const privateJwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
    privateJwk.kid = 'registry-key-file';
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
    mocks.queryD1Rows.mockImplementation(async (_database: string, sql: string) => {
      if (sql.includes('control_tenant_default_allocations')) return regionPolicyRows();
      if (sql.includes('tenant_database_active_pointers')) return [{ count: '3' }];
      if (sql.includes('lookup_tenant_aliases')) return [{ count: '3' }];
      return [{ count: 1 }];
    });
    let adminSqlPath = '';
    mocks.executeD1Migration.mockImplementationOnce(async (databaseId: string, sqlPath: string) => {
      expect(databaseId).toBe('admin-id');
      adminSqlPath = sqlPath;
      const metadata = await lstat(sqlPath);
      expect(metadata.isFile()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.nlink).toBe(1);
      if (process.platform !== 'win32') {
        expect(metadata.mode & 0o777).toBe(0o600);
        expect((await lstat(dirname(sqlPath))).mode & 0o777).toBe(0o700);
      }
      expect(await readFile(sqlPath, 'utf8')).toBe('REGISTRY SQL');
      return { success: true };
    });
    const result = await publishInitialControlPlaneRuntimeSnapshot({
      env: 'prod',
      config: config(),
      lock: lock(),
      rootDir: root,
      keysDir: root,
      release: release(),
    });
    expect(result).toEqual({ success: true, publishedSnapshot: true });
    expect(mocks.putKVKeyByNamespaceId).toHaveBeenCalledTimes(3);
    const snapshotCall = mocks.putKVKeyByNamespaceId.mock.calls.find((call) =>
      String(call[1]).includes(':snapshot:')
    )!;
    const snapshot = JSON.parse(snapshotCall[2]) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      version: 4,
      tenantId: 'tenant-ohara',
      backend: { provider: 'd1', resolver: 'control-plane' },
      placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
      metadata: {
        storeCount: 3,
        signature: expect.any(String),
        signatureKeyId: 'registry-key-file',
        signatureAlgorithm: 'EdDSA',
      },
    });
    const compactJws = (snapshot.metadata as { signature: string }).signature;
    expect(
      JSON.parse(Buffer.from(compactJws.split('.')[0]!, 'base64url').toString('utf8'))
    ).toEqual({
      alg: 'EdDSA',
      typ: 'authrim-runtime-registry+jws',
      kid: 'registry-key-file',
    });
    expect(
      snapshot.stores
        .map((store: { role: string; shardGroup: string }) => `${store.role}:${store.shardGroup}`)
        .sort()
    ).toEqual(['tenant_core:default', 'tenant_core:users', 'tenant_pii:default']);
    expect(snapshot.stores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dataRole: 'tenant_core/default',
          shardId: expect.stringMatching(/^shard_bootstrap_/u),
          assignmentGeneration: 1,
          bindingRouteGeneration: 1,
          placementPolicyGeneration: 1,
          allocationScope: 'tenant_exclusive',
          ownerTenantId: 'tenant-ohara',
        }),
        expect.objectContaining({ dataRole: 'tenant_core/users' }),
        expect.objectContaining({ dataRole: 'tenant_pii' }),
      ])
    );
    expect(mocks.executeD1Command).toHaveBeenCalledWith('default-id', 'INITIAL TENANT SQL');
    expect(mocks.executeD1Command).toHaveBeenCalledWith(
      'lookup-id',
      expect.stringContaining('INSERT INTO lookup_tenant_aliases')
    );
    expect(adminSqlPath).not.toBe('');
    expect(existsSync(adminSqlPath)).toBe(false);
    expect(existsSync(dirname(adminSqlPath))).toBe(false);
    expect(mocks.queryD1Rows).toHaveBeenCalledTimes(4);
  });

  it('waits for a stale runtime registry KV observation to converge to the exact publication', async () => {
    const kv = await prepareRuntimeRegistryVerification();
    const readsByKey = new Map<string, number>();
    const wait = vi.fn().mockResolvedValue(undefined);
    mocks.getKVKeyByNamespaceId.mockImplementation(async (_namespace: string, key: string) => {
      const value = kv.get(key)!;
      const readCount = readsByKey.get(key) ?? 0;
      readsByKey.set(key, readCount + 1);
      if (readCount > 0) return value;
      const stale = JSON.parse(value) as { publishedAt: string; expiresAt: string };
      stale.publishedAt = '2026-01-01T00:00:00.000Z';
      stale.expiresAt = '2026-01-02T00:00:00.000Z';
      return JSON.stringify(stale);
    });

    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        keysDir: root,
        release: release(),
        runtimeRegistryVerification: { retryDelaysMs: [1], wait },
      })
    ).resolves.toEqual({ success: true, publishedSnapshot: true });
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(1);
    expect(mocks.getKVKeyByNamespaceId).toHaveBeenCalledTimes(4);
    expect(mocks.putKVKeyByNamespaceId).toHaveBeenCalledTimes(3);
  });

  it('fails closed after bounded retries when a stale runtime registry publication persists', async () => {
    const kv = await prepareRuntimeRegistryVerification();
    const wait = vi.fn().mockResolvedValue(undefined);
    mocks.getKVKeyByNamespaceId.mockImplementation(async (_namespace: string, key: string) => {
      const value = kv.get(key)!;
      if (!key.includes(':snapshot:')) return value;
      const stale = JSON.parse(value) as { publishedAt: string; expiresAt: string };
      stale.publishedAt = '2026-01-01T00:00:00.000Z';
      stale.expiresAt = '2026-01-01T00:30:00.000Z';
      return JSON.stringify(stale);
    });

    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        keysDir: root,
        release: release(),
        runtimeRegistryVerification: { retryDelaysMs: [1, 2, 4], wait },
      })
    ).resolves.toEqual({
      success: false,
      error: 'initial_control_plane_runtime_snapshot_smoke_failed',
    });
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([1, 2, 4]);
    expect(mocks.getKVKeyByNamespaceId).toHaveBeenCalledTimes(8);
    expect(mocks.putKVKeyByNamespaceId).toHaveBeenCalledTimes(3);
  });

  it('fails closed immediately for a malformed reflected runtime registry snapshot', async () => {
    const kv = await prepareRuntimeRegistryVerification();
    const wait = vi.fn().mockResolvedValue(undefined);
    mocks.getKVKeyByNamespaceId.mockImplementation(async (_namespace: string, key: string) =>
      key.includes(':snapshot:') ? '{"invalid":' : kv.get(key)!
    );

    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        keysDir: root,
        release: release(),
        runtimeRegistryVerification: { retryDelaysMs: [1, 2, 4], wait },
      })
    ).resolves.toEqual({
      success: false,
      error: 'initial_control_plane_runtime_snapshot_malformed',
    });
    expect(wait).not.toHaveBeenCalled();
    expect(mocks.getKVKeyByNamespaceId).toHaveBeenCalledOnce();
    expect(mocks.putKVKeyByNamespaceId).toHaveBeenCalledTimes(3);
  });

  it('retries a transient runtime registry read error without rewriting the publication', async () => {
    const kv = await prepareRuntimeRegistryVerification();
    const wait = vi.fn().mockResolvedValue(undefined);
    let snapshotReadAttempts = 0;
    mocks.getKVKeyByNamespaceId.mockImplementation(async (_namespace: string, key: string) => {
      if (key.includes(':snapshot:') && snapshotReadAttempts++ === 0) {
        throw new Error('transient KV read failure');
      }
      return kv.get(key)!;
    });

    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        keysDir: root,
        release: release(),
        runtimeRegistryVerification: { retryDelaysMs: [1], wait },
      })
    ).resolves.toEqual({ success: true, publishedSnapshot: true });
    expect(wait).toHaveBeenCalledWith(1);
    expect(mocks.getKVKeyByNamespaceId).toHaveBeenCalledTimes(3);
    expect(mocks.putKVKeyByNamespaceId).toHaveBeenCalledTimes(3);
  });

  it('does not publish a runtime route when the dedicated core tenant seed fails', async () => {
    mocks.executeD1Command.mockRejectedValueOnce(new Error('dedicated core unavailable'));

    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        keysDir: root,
        release: release(),
      })
    ).resolves.toEqual({ success: false, error: 'dedicated core unavailable' });
    expect(
      mocks.putKVKeyByNamespaceId.mock.calls.some((call) =>
        String(call[1]).startsWith('tenant-runtime-registry:')
      )
    ).toBe(false);
  });

  it('signs the runtime snapshot with the Control-owned active slot after rotation', async () => {
    const oldPair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const oldPrivateJwk = await webcrypto.subtle.exportKey('jwk', oldPair.privateKey);
    oldPrivateJwk.kid = 'registry-key-old';
    const activePair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const activePrivateJwk = await webcrypto.subtle.exportKey('jwk', activePair.privateKey);
    activePrivateJwk.kid = 'registry-key-active';
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'tenant_runtime_registry_signing_private.jwk.json'),
      JSON.stringify(oldPrivateJwk)
    );
    await writeFile(
      join(root, 'runtime_registry_signing_jwk_slot_b.private.jwk.json'),
      JSON.stringify(activePrivateJwk)
    );
    await writeFile(
      join(root, 'tenant_runtime_registry_signing_key_id.txt'),
      'registry-key-active'
    );
    const rotatedLock = {
      d1: {
        DB_ADMIN: { id: 'admin-id', name: 'admin-db' },
        CONTROL_DB: { id: 'control-id', name: 'control-db' },
        LOOKUP_DB: { id: 'lookup-id', name: 'lookup-db' },
        PROD_TDB_DEFAULT_BOOTSTRAP_CORE: {
          id: 'default-id',
          name: 'prod-authrim-tenant-default-bootstrap-db',
        },
        PROD_TDB_USERS_BOOTSTRAP_CORE: {
          id: 'users-id',
          name: 'prod-authrim-tenant-users-bootstrap-db',
        },
        PROD_TDB_PII_BOOTSTRAP_PII: {
          id: 'pii-id',
          name: 'prod-authrim-tenant-pii-bootstrap-db',
        },
      },
      kv: {
        AUTHRIM_CONFIG: { id: 'config-kv', title: 'config' },
        TENANT_RUNTIME_REGISTRY: { id: 'registry-kv', title: 'registry' },
      },
      controlKeyState: {
        runtimeRegistry: {
          activeSlot: 'B',
          activeKeyId: 'registry-key-active',
          activeFingerprint: 'a'.repeat(64),
          previousSlot: 'A',
          previousKeyId: 'registry-key-old',
          previousFingerprint: 'b'.repeat(64),
          updatedAt: 1,
        },
      },
    } as never;
    const kv = new Map<string, string>();
    mocks.putKVKeyByNamespaceId.mockImplementation(
      async (_namespace: string, key: string, value: string) => void kv.set(key, value)
    );
    mocks.getKVKeyByNamespaceId.mockImplementation(async (_namespace: string, key: string) =>
      kv.get(key)
    );
    mocks.queryD1Rows.mockImplementation(async (_database: string, sql: string) => {
      if (sql.includes('control_tenant_default_allocations')) return regionPolicyRows();
      if (sql.includes('tenant_database_active_pointers')) return [{ count: '3' }];
      if (sql.includes('lookup_tenant_aliases')) return [{ count: '3' }];
      return [{ count: 1 }];
    });

    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: rotatedLock,
        rootDir: root,
        keysDir: root,
        release: release(),
      })
    ).resolves.toEqual({ success: true, publishedSnapshot: true });

    const snapshotCall = mocks.putKVKeyByNamespaceId.mock.calls.find((call) =>
      String(call[1]).includes(':snapshot:')
    )!;
    const snapshot = JSON.parse(snapshotCall[2]) as { metadata: { signature: string } };
    expect(
      JSON.parse(Buffer.from(snapshot.metadata.signature.split('.')[0]!, 'base64url').toString())
    ).toMatchObject({ kid: 'registry-key-active' });
  });

  it('fails closed when the reflected runtime snapshot omits a required data role', async () => {
    const keyPair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const privateJwk = await webcrypto.subtle.exportKey('jwk', keyPair.privateKey);
    privateJwk.kid = 'registry-key-file';
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'tenant_runtime_registry_signing_private.jwk.json'),
      JSON.stringify(privateJwk)
    );
    await writeFile(join(root, 'tenant_runtime_registry_signing_key_id.txt'), 'registry-key-file');
    const kv = new Map<string, string>();
    mocks.putKVKeyByNamespaceId.mockImplementation(
      async (_namespace: string, key: string, value: string) => {
        if (key.includes(':snapshot:')) {
          const snapshot = JSON.parse(value) as { stores: unknown[] };
          snapshot.stores = snapshot.stores.slice(0, 2);
          kv.set(key, JSON.stringify(snapshot));
          return;
        }
        kv.set(key, value);
      }
    );
    mocks.getKVKeyByNamespaceId.mockImplementation(async (_namespace: string, key: string) =>
      kv.get(key)
    );
    mocks.queryD1Rows.mockImplementation(async (_database: string, sql: string) => {
      if (sql.includes('control_tenant_default_allocations')) return regionPolicyRows();
      if (sql.includes('tenant_database_active_pointers')) return [{ count: '3' }];
      if (sql.includes('lookup_tenant_aliases')) return [{ count: '3' }];
      return [{ count: 1 }];
    });

    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        keysDir: root,
        release: release(),
        runtimeRegistryVerification: { retryDelaysMs: [] },
      })
    ).resolves.toEqual({
      success: false,
      error: 'initial_control_plane_runtime_snapshot_smoke_failed',
    });
  });

  it('fails closed when the reflected generation pointer does not match the signed snapshot', async () => {
    await writeRuntimeRegistrySigningKey();
    const kv = new Map<string, string>();
    mocks.putKVKeyByNamespaceId.mockImplementation(
      async (_namespace: string, key: string, value: string) => {
        if (key.includes(':generation:')) {
          const generation = JSON.parse(value) as { routeStatus: string };
          generation.routeStatus = 'quarantined';
          kv.set(key, JSON.stringify(generation));
          return;
        }
        kv.set(key, value);
      }
    );
    mocks.getKVKeyByNamespaceId.mockImplementation(async (_namespace: string, key: string) =>
      kv.get(key)
    );
    mocks.queryD1Rows.mockImplementation(async (_database: string, sql: string) => {
      if (sql.includes('control_tenant_default_allocations')) return regionPolicyRows();
      if (sql.includes('tenant_database_active_pointers')) return [{ count: '3' }];
      if (sql.includes('lookup_tenant_aliases')) return [{ count: '3' }];
      return [{ count: 1 }];
    });

    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        keysDir: root,
        release: release(),
        runtimeRegistryVerification: { retryDelaysMs: [] },
      })
    ).resolves.toEqual({
      success: false,
      error: 'initial_control_plane_runtime_snapshot_smoke_failed',
    });
  });

  it('rejects invalid signing keys and failed snapshot verification', async () => {
    await writeFile(
      join(root, 'tenant_runtime_registry_signing_private.jwk.json'),
      JSON.stringify({ kty: 'RSA', kid: 'bad' })
    );
    await expect(
      publishInitialControlPlaneRuntimeSnapshot({
        env: 'prod',
        config: config(),
        lock: lock(),
        rootDir: root,
        keysDir: root,
        release: release(),
      })
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('must_be_ed25519') });
  });
});
