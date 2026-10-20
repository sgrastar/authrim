import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adminAuthMiddleware,
  buildTenantRuntimeRegistryGenerationKey,
  buildTenantRuntimeRegistrySnapshotKey,
  clearTenantDatabaseResolverMemoryCache,
  resolveAuthCorePersistenceAdapterFromEnv,
  signTenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistrySnapshot,
} from '@authrim/ar-lib-core';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, createAuditLogFromContext: vi.fn(async () => undefined) };
});

import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import settingsV2 from '../routes/settings-v2';
import {
  GLOBAL_SUPER_ADMIN,
  TENANT,
  setupApp,
  signIn,
  sqliteAdapter,
} from './helpers/admin-authority-fixture';
import { insertOAuthClient, insertTenant, openCoreDatabase } from './helpers/core-database';

/**
 * The preview of a bulk apply counts a tenant's apps in the tenant's own Core database. With the
 * real tenant database resolver, a tenant whose signed Runtime Registry names a binding the
 * deployment does not have makes the resolver write a health notification and a repair job; a
 * preview must look without leaving either.
 */

const REPO_ROOT = resolve(__dirname, '../../../..');
const BULK = '/api/admin/settings/bulk-apply';
const KEY = 'identity_mapping.oidc_default_set_id';
const TARGET = 'edge-a';
const SETTINGS_MIGRATIONS = [
  '028_tenant_settings_documents.sql',
  '038_tenant_settings_reconciled_at.sql',
  '039_platform_settings_documents.sql',
  '040_settings_legacy_import_state.sql',
];

async function keyPair() {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  for (const jwk of [privateJwk, publicJwk]) {
    Object.assign(jwk, { kid: 'runtime-registry-key-1', alg: 'EdDSA', use: 'sig' });
  }
  return { privateJwk, publicJwk };
}

/** tenant-b's signed route, published long ago, to a Core database binding nobody has. */
function snapshotOf(tenantId: string): TenantRuntimeRegistrySnapshot {
  return {
    version: 4,
    tenantId,
    snapshotScope: 'tenant',
    deploymentTarget: TARGET,
    runtimeGeneration: 8,
    routeStatus: 'active',
    quarantineDenyGeneration: 0,
    backend: { provider: 'd1', resolver: 'control-plane' },
    placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
    publishedAt: '2026-05-16T00:00:00.000Z',
    expiresAt: '2099-05-16T00:30:00.000Z',
    stores: [
      {
        tenantId,
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        residencyPolicyId: 'builtin:residency:default',
        residencyPartition: 'default',
        shardId: 'shard-core-default',
        assignmentGeneration: 1,
        bindingRouteGeneration: 3,
        placementPolicyGeneration: 1,
        allocationScope: 'tenant_exclusive',
        ownerTenantId: tenantId,
        generation: 3,
        runtimeGeneration: 8,
        schemaVersion: 2,
        shardGroup: 'default',
        shardIndex: 0,
        shardCount: 1,
        shardKeyStrategy: 'none',
        provider: 'd1',
        driver: 'd1',
        bindingRef: 'TDB_NOBODY_HAS_THIS_CORE',
        connectionRef: null,
        deploymentTarget: TARGET,
        status: 'active',
        healthStatus: 'active',
        databaseId: 'db-id',
        databaseName: 'authrim-dev-tenant-core',
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
}

async function setup() {
  clearTenantDatabaseResolverMemoryCache();
  const { privateJwk, publicJwk } = await keyPair();
  const signed = await signTenantRuntimeRegistrySnapshot(
    snapshotOf('tenant-b'),
    { privateJwk, keyId: 'runtime-registry-key-1' },
    '2026-05-16T00:00:00.000Z'
  );
  const generationKey = buildTenantRuntimeRegistryGenerationKey('tenant-b', TARGET);
  const snapshotKey = buildTenantRuntimeRegistrySnapshotKey('tenant-b', TARGET);
  const registry = {
    get: vi.fn(async (key: string) => {
      if (key === generationKey) {
        return JSON.stringify({
          runtimeGeneration: 8,
          routeStatus: 'active',
          quarantineDenyGeneration: 0,
          publishedAt: '2026-05-16T00:00:00.000Z',
          expiresAt: '2099-05-23T00:00:00.000Z',
        });
      }
      return key === snapshotKey ? JSON.stringify(signed) : null;
    }),
  };

  const core = openCoreDatabase();
  insertTenant(core, TENANT);
  const directory = openCoreDatabase();
  for (const id of [TENANT, 'tenant-b']) insertTenant(directory, id);
  const store = new Map<string, string>();
  const settings = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace;
  insertOAuthClient(core, { tenantId: TENANT, clientId: 'app-1' });

  const env = {
    DB: sqliteAdapter(directory),
    SETTINGS: settings,
    AUTHRIM_CONFIG: settings,
    BASE_DOMAIN: 'example.com',
    AUTHRIM_DEPLOYMENT_TARGET: TARGET,
    TENANT_RUNTIME_REGISTRY: registry,
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    RATE_LIMITER: {
      idFromName: vi.fn().mockReturnValue('rate-limit-id'),
      get: vi.fn().mockReturnValue({
        incrementRpc: vi.fn().mockResolvedValue({
          allowed: true,
          current: 1,
          limit: 100,
          resetAt: Math.floor(Date.now() / 1000) + 60,
        }),
      }),
    },
  };
  const context = setupApp((app) => {
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: unknown): void }).set('tenantMetadataContext', {
        tenantId: TENANT,
        coreDb: sqliteAdapter(core),
        route: {},
      });
      await next();
    });
    app.use(
      '/api/admin/*',
      adminAuthMiddleware({ plane: 'tenant' }),
      enforceDeclaredAdminRouteAccess()
    );
    app.route('/api/admin', settingsV2);
  }, env);
  for (const file of SETTINGS_MIGRATIONS) {
    context.db.exec(readFileSync(resolve(REPO_ROOT, `migrations/admin/d1/${file}`), 'utf8'));
  }
  const cookie = signIn(context.db, GLOBAL_SUPER_ADMIN).cookie;
  const count = (table: string) =>
    (context.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { ...context, env, cookie, count };
}

let sequence = 0;
const body = (mode: 'preview' | 'apply') => ({
  mode,
  tenant_ids: [TENANT, 'tenant-b'],
  changes: [{ category: 'identity-mapping', set: { [KEY]: 'none' } }],
});

beforeEach(() => clearTenantDatabaseResolverMemoryCache());

describe('a preview that counts the apps of a tenant whose database cannot be routed', () => {
  it('says it could not, and writes no health notification and no repair job', async () => {
    const t = await setup();
    const before = { events: t.count('internal_notification_events'), jobs: t.count('admin_jobs') };

    sequence += 1;
    const response = await t.call(t.cookie, 'POST', BULK, body('preview'), {
      'Idempotency-Key': `resolver-key-${sequence}`,
    });

    expect(response.status).toBe(200);
    const byTenant = Object.fromEntries(
      response.json.results.map((r: any) => [r.tenant_id, r.impact['identity-mapping']])
    );
    expect(byTenant['tenant-b']).toEqual({ available: false, reason: 'core_database_unavailable' });
    expect(byTenant[TENANT]).toMatchObject({ available: false });
    expect(t.count('internal_notification_events')).toBe(before.events);
    expect(t.count('admin_jobs')).toBe(before.jobs);
  });

  it('would have written both by looking, without the option (the check that this setup can see it)', async () => {
    const t = await setup();
    await expect(
      resolveAuthCorePersistenceAdapterFromEnv({ ...t.env, DB_ADMIN: t.adapter } as never, 'x', {
        tenantId: 'tenant-b',
      })
    ).rejects.toThrow();
    expect(t.count('internal_notification_events')).toBeGreaterThan(0);
    expect(t.count('admin_jobs')).toBeGreaterThan(0);
  });

  it('is also quiet in the validation of a login-entry App Login target', async () => {
    const t = await setup();
    // The App Login target is looked up in the tenant's Core database, which cannot be routed.
    const saved = await t.call(t.cookie, 'GET', '/api/admin/tenants/tenant-b/settings/login-entry');
    await t.call(t.cookie, 'PATCH', '/api/admin/tenants/tenant-b/settings/login-entry', {
      ifMatch: saved.json.version,
      set: {
        'login-entry.app_login_client_id': 'client-sensitive',
        'login-entry.app_login_redirect_uri': 'https://app.example.com/callback',
      },
    });
    const before = { events: t.count('internal_notification_events'), jobs: t.count('admin_jobs') };
    sequence += 1;
    const response = await t.call(
      t.cookie,
      'POST',
      BULK,
      {
        mode: 'preview',
        tenant_ids: ['tenant-b'],
        changes: [
          { category: 'login-entry', set: { 'login-entry.post_login_behavior': 'app_login' } },
        ],
      },
      { 'Idempotency-Key': `resolver-key-${sequence}` }
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.json)).not.toContain('client-sensitive');
    expect(t.count('internal_notification_events')).toBe(before.events);
    expect(t.count('admin_jobs')).toBe(before.jobs);
  });
});
