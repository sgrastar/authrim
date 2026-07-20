import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  DEFAULT_STORAGE_PROFILE_ID,
} from '../../types/runtime-profile';
import { resolveConsentGatePersistenceFromEnv } from '../consent-gate-persistence';
import { clearTenantDatabaseResolverMemoryCache } from '../tenant-database-resolver';
import {
  signTenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistrySnapshot,
} from '../tenant-runtime-registry-snapshot';

function createMockKV(initial: Record<string, string>): KVNamespace {
  const values = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
  } as unknown as KVNamespace;
}

async function createTenantIsolatedEnv(driver: 'd1' | 'postgres', adapter: DatabaseAdapter) {
  const profileId = `test:storage:${driver}-tenant-isolated`;
  const bindingRef = driver === 'd1' ? 'TENANT_D1_CORE' : 'TENANT_POSTGRES_CORE';
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  privateJwk.kid = 'consent-topology-key';
  publicJwk.kid = 'consent-topology-key';
  const snapshot: TenantRuntimeRegistrySnapshot = {
    version: 1,
    tenantId: 'tenant-a',
    snapshotScope: 'tenant',
    deploymentTarget: 'edge-a',
    runtimeGeneration: 1,
    storageProfileId: profileId,
    publishedAt: '2026-07-20T00:00:00.000Z',
    expiresAt: '2099-07-20T00:30:00.000Z',
    stores: [
      {
        tenantId: 'tenant-a',
        role: 'tenant_core',
        generation: 1,
        runtimeGeneration: 1,
        schemaVersion: 1,
        shardGroup: 'default',
        shardIndex: 0,
        shardCount: 1,
        shardKeyStrategy: 'none',
        provider: driver === 'd1' ? 'd1' : 'postgres',
        driver,
        bindingRef,
        connectionRef: null,
        deploymentTarget: 'edge-a',
        status: 'active',
        healthStatus: 'active',
        databaseId: `${driver}-database`,
        databaseName: `${driver}-tenant-a-core`,
        regionHint: null,
        jurisdiction: null,
      },
    ],
    metadata: {
      storeCount: 1,
      roles: ['tenant_core'],
      signature: null,
      signatureKeyId: null,
      signatureAlgorithm: null,
      signedAt: null,
    },
  };
  const signedSnapshot = await signTenantRuntimeRegistrySnapshot(
    snapshot,
    { privateJwk, keyId: 'consent-topology-key' },
    '2026-07-20T00:00:00.000Z'
  );
  return {
    DB: createAdapter('shared-fallback'),
    [bindingRef]: adapter,
    AUTHRIM_CONFIG: createMockKV({
      [`profile-registry:storage:${profileId}`]: JSON.stringify({
        id: profileId,
        kind: 'storage',
        label: profileId,
        deploymentProfile: driver === 'd1' ? 'tenant-d1' : 'external-durable',
        logicalSources: {
          identity_core: {
            driver,
            resolverRef: 'tenant-database-registry',
            role: 'tenant_core',
            logicalSource: 'identity_core',
          },
        },
        slices: {
          identity_core: {
            driver,
            resolverRef: 'tenant-database-registry',
            role: 'tenant_core',
          },
        },
      }),
    }),
    PROFILE_REGISTRY_BACKEND: 'kv',
    DEFAULT_STORAGE_PROFILE_ID: profileId,
    DEFAULT_AUDIT_PROFILE_ID,
    DEFAULT_RESIDENCY_PROFILE_ID,
    AUTHRIM_DEPLOYMENT_TARGET: 'edge-a',
    TENANT_RUNTIME_REGISTRY: {
      get: vi.fn(async (key: string) =>
        key.includes(':runtime-registry:generation:')
          ? JSON.stringify({ runtimeGeneration: 1 })
          : JSON.stringify(signedSnapshot)
      ),
    },
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
  };
}

function createAdapter(name: string): DatabaseAdapter {
  return {
    query: async () => [],
    queryOne: async () => null,
    execute: async () => ({ success: true, rowsAffected: 0 }),
    transaction: async (callback) =>
      callback({
        query: async () => [],
        queryOne: async () => null,
        execute: async () => ({ success: true, rowsAffected: 0 }),
      }),
    batch: async () => [],
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: name }),
    getType: () => name,
    close: async () => undefined,
  };
}

describe('resolveConsentGatePersistenceFromEnv', () => {
  it('creates every Consent Gate repository on the resolved shared auth-core adapter', async () => {
    const adapter = createAdapter('shared');
    const persistence = await resolveConsentGatePersistenceFromEnv(
      {
        DB: adapter,
        DEFAULT_STORAGE_PROFILE_ID,
        DEFAULT_AUDIT_PROFILE_ID,
        DEFAULT_RESIDENCY_PROFILE_ID,
      },
      'tenant-a'
    );
    expect(persistence.adapter).toBe(adapter);
    expect(persistence.policyBindings).toBeDefined();
    expect(persistence.documentAcknowledgments).toBeDefined();
    expect(persistence.decisionReceipts).toBeDefined();
  });

  it('requires a tenant before resolving storage', async () => {
    await expect(
      resolveConsentGatePersistenceFromEnv(
        {
          DB: createAdapter('shared'),
          DEFAULT_STORAGE_PROFILE_ID,
          DEFAULT_AUDIT_PROFILE_ID,
          DEFAULT_RESIDENCY_PROFILE_ID,
        },
        ' '
      )
    ).rejects.toThrow('requires tenantId');
  });

  it('does not fall back to shared DB for an unresolved tenant-isolated profile', async () => {
    const shared = createAdapter('shared');
    await expect(
      resolveConsentGatePersistenceFromEnv(
        {
          DB: shared,
          DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:tenant-d1',
          DEFAULT_AUDIT_PROFILE_ID,
          DEFAULT_RESIDENCY_PROFILE_ID,
        },
        'tenant-a'
      )
    ).rejects.toThrow();
  });

  it('resolves Consent Gate repositories across the supported storage topology matrix', async () => {
    const shared = createAdapter('shared-d1');
    await expect(
      resolveConsentGatePersistenceFromEnv(
        {
          DB: shared,
          DEFAULT_STORAGE_PROFILE_ID,
          DEFAULT_AUDIT_PROFILE_ID,
          DEFAULT_RESIDENCY_PROFILE_ID,
        },
        'tenant-a'
      )
    ).resolves.toMatchObject({ adapter: shared });

    const externalDeploymentWide = createAdapter('external-deployment-wide');
    const deploymentProfileId = 'test:storage:external-deployment-wide';
    const externalPersistence = await resolveConsentGatePersistenceFromEnv(
      {
        DB: shared,
        EXTERNAL_CORE: externalDeploymentWide,
        AUTHRIM_CONFIG: createMockKV({
          [`profile-registry:storage:${deploymentProfileId}`]: JSON.stringify({
            id: deploymentProfileId,
            kind: 'storage',
            label: deploymentProfileId,
            deploymentProfile: 'external-durable',
            logicalSources: {
              identity_core: {
                driver: 'postgres',
                bindingRef: 'EXTERNAL_CORE',
                role: 'core',
                logicalSource: 'identity_core',
              },
            },
            slices: {
              identity_core: {
                driver: 'postgres',
                bindingRef: 'EXTERNAL_CORE',
                role: 'core',
              },
            },
          }),
        }),
        PROFILE_REGISTRY_BACKEND: 'kv',
        DEFAULT_STORAGE_PROFILE_ID: deploymentProfileId,
        DEFAULT_AUDIT_PROFILE_ID,
        DEFAULT_RESIDENCY_PROFILE_ID,
      } as never,
      'tenant-a'
    );
    expect(externalPersistence.adapter.getType()).toBe('external-deployment-wide');

    for (const driver of ['d1', 'postgres'] as const) {
      clearTenantDatabaseResolverMemoryCache();
      const tenantAdapter = createAdapter(`${driver}-tenant-isolated`);
      const env = await createTenantIsolatedEnv(driver, tenantAdapter);
      const persistence = await resolveConsentGatePersistenceFromEnv(env as never, 'tenant-a');
      expect(persistence.adapter.getType()).toBe(`${driver}-tenant-isolated`);
    }
  });
});
