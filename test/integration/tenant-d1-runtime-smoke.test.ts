import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  createAuthContextFromHono,
  createPIIContextFromHono,
  loadTenantRuntimeRegistryVerificationKeysFromEnv,
  requestContextMiddleware,
  signTenantRuntimeRegistrySnapshot,
  verifyTenantRuntimeRegistrySnapshotSignature,
  type Env,
  type AccountDataContext,
  type TenantRuntimeRegistrySnapshot,
} from '@authrim/ar-lib-core';

function createTenantExistsDb(): D1Database {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(sql.includes('SELECT 1') ? { '1': 1 } : { id: 'acme' }),
      }),
      first: vi.fn().mockResolvedValue({ id: 'acme' }),
    })),
    batch: vi.fn(),
  } as unknown as D1Database;
}

function createD1Binding(name: string): D1Database {
  return {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({ binding: name }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
      first: vi.fn().mockResolvedValue({ binding: name }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true }),
    }),
    batch: vi.fn(),
  } as unknown as D1Database;
}

async function generateEd25519Jwks(kid = 'runtime-registry-key-1') {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
  privateJwk.kid = kid;
  publicJwk.kid = kid;
  privateJwk.alg = 'EdDSA';
  privateJwk.use = 'sig';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';
  return { privateJwk, publicJwk };
}

async function createSnapshot(privateJwk: JsonWebKey): Promise<TenantRuntimeRegistrySnapshot> {
  const now = new Date('2026-05-16T00:00:00.000Z');
  const snapshot: TenantRuntimeRegistrySnapshot = {
    version: 2,
    tenantId: 'acme',
    snapshotScope: 'tenant',
    deploymentTarget: 'primary',
    runtimeGeneration: 7,
    routeStatus: 'active',
    quarantineDenyGeneration: 0,
    storageProfileId: 'builtin:storage:tenant-d1',
    publishedAt: now.toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    stores: [
      {
        tenantId: 'acme',
        role: 'tenant_core',
        generation: 2,
        runtimeGeneration: 7,
        schemaVersion: 87,
        shardGroup: 'default',
        shardIndex: 0,
        shardCount: 1,
        shardKeyStrategy: 'none',
        provider: 'd1',
        driver: 'd1',
        bindingRef: 'TDB_ACME_CORE',
        connectionRef: null,
        deploymentTarget: 'primary',
        status: 'active',
        healthStatus: 'active',
        databaseId: 'core-db-id',
        databaseName: 'authrim-test-acme-core',
        regionHint: null,
        jurisdiction: null,
      },
      {
        tenantId: 'acme',
        role: 'tenant_pii',
        generation: 2,
        runtimeGeneration: 7,
        schemaVersion: 12,
        shardGroup: 'default',
        shardIndex: 0,
        shardCount: 1,
        shardKeyStrategy: 'none',
        provider: 'd1',
        driver: 'd1',
        bindingRef: 'TDB_ACME_PII',
        connectionRef: null,
        deploymentTarget: 'primary',
        status: 'active',
        healthStatus: 'active',
        databaseId: 'pii-db-id',
        databaseName: 'authrim-test-acme-pii',
        regionHint: null,
        jurisdiction: null,
      },
    ],
    metadata: {
      storeCount: 2,
      roles: ['tenant_core', 'tenant_pii'],
      signature: null,
      signatureKeyId: null,
      signatureAlgorithm: null,
      signedAt: null,
    },
  };
  return signTenantRuntimeRegistrySnapshot(
    snapshot,
    { privateJwk, keyId: 'runtime-registry-key-1' },
    now.toISOString()
  );
}

describe('tenant-d1 runtime smoke', () => {
  it('routes request-context auth and PII adapters to generated tenant D1 bindings', async () => {
    const { privateJwk, publicJwk } = await generateEd25519Jwks();
    const snapshot = await createSnapshot(privateJwk);
    const verificationKeys = loadTenantRuntimeRegistryVerificationKeysFromEnv({
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    });
    await expect(
      verifyTenantRuntimeRegistrySnapshotSignature(snapshot, verificationKeys)
    ).resolves.toBe('valid');
    const snapshotKey = buildTenantRuntimeRegistrySnapshotKey('acme', 'primary');
    const generationKey = buildTenantRuntimeRegistryGenerationKey('acme', 'primary');
    const kv = {
      get: vi.fn(async (key: string) => {
        if (key === snapshotKey) return JSON.stringify(snapshot);
        if (key === generationKey) {
          return JSON.stringify({ runtimeGeneration: snapshot.runtimeGeneration });
        }
        if (key === 'v1:tenant-exists:acme') return 'true';
        return null;
      }),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as KVNamespace;
    const coreBinding = createD1Binding('core');
    const piiBinding = createD1Binding('pii');
    const env = {
      BASE_DOMAIN: 'example.test',
      DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:tenant-d1',
      AUTHRIM_DEPLOYMENT_TARGET: 'primary',
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
      DB: createTenantExistsDb(),
      AUTHRIM_CONFIG: kv,
      TENANT_RUNTIME_REGISTRY: kv,
      TDB_ACME_CORE: coreBinding,
      TDB_ACME_PII: piiBinding,
    } as unknown as Env;

    const app = new Hono<{ Bindings: Env }>();
    app.use('*', requestContextMiddleware());
    app.get('/userinfo', async (c) => {
      const authCtx = createAuthContextFromHono(c);
      c.set('accountDataContext', {
        tenantId: 'acme',
        accountId: 'account:account-a',
        legacyUserId: 'account-a',
        storageProfileId: 'builtin:storage:tenant-d1',
        membership: {
          tenantId: 'acme',
          accountId: 'account:account-a',
          routeProjection: {
            schemaVersion: 1,
            accountRouteGeneration: 7,
            residencyPolicyId: 'default',
            targets: [],
          },
          accountRouteGeneration: 7,
          hmacKeyGeneration: 1,
          normalizationVersion: 1,
        },
        coreDb: coreBinding,
        piiDb: piiBinding,
        coreBindingRef: 'TDB_ACME_CORE',
        piiBindingRef: 'TDB_ACME_PII',
        coreResidencyPartition: 'default',
        piiResidencyPartition: 'default',
        accountRouteGeneration: 7,
        userCacheScope: {
          storageProfileId: 'builtin:storage:tenant-d1',
          sourceGeneration: 'core:7:pii:7',
          schemaVersion: 'core:87:pii:87',
        },
        piiCacheMode: 'no_cross_request_pii',
      } satisfies AccountDataContext);
      const piiCtx = createPIIContextFromHono(c);
      await authCtx.coreAdapter.query('SELECT 1 AS core_binding');
      await piiCtx.defaultPiiAdapter.query('SELECT 1 AS pii_binding');
      return c.json({
        authType: authCtx.coreAdapter.getType(),
        piiType: piiCtx.defaultPiiAdapter.getType(),
        cacheScope: piiCtx.userCacheScope,
      });
    });

    const response = await app.request(
      new Request('https://acme.example.test/userinfo', {
        headers: { Host: 'acme.example.test' },
      }),
      undefined,
      env
    );
    const body = (await response.json()) as {
      authType: string;
      piiType: string;
      cacheScope: { storageProfileId: string; sourceGeneration: string };
    };

    expect(response.status, JSON.stringify({ body, kvCalls: kv.get.mock.calls })).toBe(200);
    expect(body).toMatchObject({
      authType: 'd1',
      piiType: 'd1',
      cacheScope: {
        storageProfileId: 'builtin:storage:tenant-d1',
        sourceGeneration: 'core:7:pii:7',
      },
    });
    expect(coreBinding.prepare).toHaveBeenCalledWith('SELECT 1 AS core_binding');
    expect(piiBinding.prepare).toHaveBeenCalledWith('SELECT 1 AS pii_binding');
    expect(kv.get).toHaveBeenCalledWith(snapshotKey);
    expect(kv.get).toHaveBeenCalledWith(generationKey);
  });
});
