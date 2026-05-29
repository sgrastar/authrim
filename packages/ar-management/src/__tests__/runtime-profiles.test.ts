import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
  DEFAULT_STORAGE_PROFILE_ID,
  TENANT_RUNTIME_REGISTRY_EMERGENCY_PURGE_CONFIRMATION,
} from '@authrim/ar-lib-core';

const { mockWriteAdminAuditLog } = vi.hoisted(() => ({
  mockWriteAdminAuditLog: vi.fn(),
}));

vi.mock('../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-shared')>();
  return {
    ...actual,
    writeAdminAuditLog: mockWriteAdminAuditLog,
  };
});

import {
  adminRuntimeProfileDefaultsHandler,
  adminRuntimeProfileDefaultsUpdateHandler,
  adminRuntimeProfileDeleteHandler,
  adminRuntimeProfileGetHandler,
  adminRuntimeProfileListHandler,
  adminRuntimeProfileUpsertHandler,
  adminTenantRuntimeRegistryEmergencyPurgeHandler,
  adminTenantRuntimeProfilesHandler,
} from '../runtime-profiles';

function createMockKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string }) => ({
      keys: Array.from(store.keys())
        .filter((key) => !options?.prefix || key.startsWith(options.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: '',
    })),
  } as unknown as KVNamespace;
}

function createMockD1First(row: Record<string, unknown> | null): D1Database {
  const first = vi.fn(async () => row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({
    bind,
    first,
  }));

  return {
    prepare,
    batch: vi.fn(),
    dump: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

function createTestApp() {
  const app = new Hono<{
    Bindings: Env;
    Variables: {
      adminAuth?: {
        userId: string;
        actorId: string;
        roles: string[];
        tenantScope?: string[];
        authMethod: 'session';
      };
    };
  }>();
  app.use('*', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      actorId: 'admin-1',
      roles: ['system_admin'],
      tenantScope: ['*'],
      authMethod: 'session',
    });
    await next();
  });
  app.get('/api/admin/runtime-profiles', adminRuntimeProfileListHandler);
  app.get('/api/admin/runtime-profiles/defaults', adminRuntimeProfileDefaultsHandler);
  app.put('/api/admin/runtime-profiles/defaults', adminRuntimeProfileDefaultsUpdateHandler);
  app.get('/api/admin/runtime-profiles/:kind/:id', adminRuntimeProfileGetHandler);
  app.put('/api/admin/runtime-profiles/:kind/:id', adminRuntimeProfileUpsertHandler);
  app.delete('/api/admin/runtime-profiles/:kind/:id', adminRuntimeProfileDeleteHandler);
  app.get('/api/admin/tenants/:id/runtime-profiles', adminTenantRuntimeProfilesHandler);
  app.use('/api/admin/tenants/:id/runtime-registry/emergency-purge', async (c, next) => {
    c.set('adminAuth', {
      userId: 'admin-1',
      actorId: 'admin-1',
      roles: ['system_admin'],
      authMethod: 'session',
    });
    await next();
  });
  app.post(
    '/api/admin/tenants/:id/runtime-registry/emergency-purge',
    adminTenantRuntimeRegistryEmergencyPurgeHandler
  );
  return app;
}

function createEnv(kvData: Record<string, string> = {}): Env {
  return {
    DB: {} as D1Database,
    AUTHRIM_CONFIG: createMockKV(kvData),
    SETTINGS: createMockKV(),
    AUDIT_QUEUE: {
      send: vi.fn(),
      sendBatch: vi.fn(),
    },
    AUDIT_ARCHIVE: {} as R2Bucket,
    DIAGNOSTIC_LOGS: {} as R2Bucket,
    PROFILE_REGISTRY_BACKEND: 'kv',
    DEFAULT_STORAGE_PROFILE_ID,
    DEFAULT_AUDIT_PROFILE_ID,
    DEFAULT_RESIDENCY_PROFILE_ID,
    BASE_DOMAIN: 'auth.example.com',
  } as unknown as Env;
}

describe('runtime profile admin handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists built-in and custom runtime profiles, with include_builtins filtering', async () => {
    const app = createTestApp();
    const env = createEnv({
      'profile-registry:storage:tenant-a-storage': JSON.stringify({
        id: 'tenant-a-storage',
        kind: 'storage',
        label: 'Tenant A Storage',
        slices: {
          custom_claims: {
            driver: 'postgres',
            connectionRef: 'tenant-a-core',
            role: 'core',
          },
        },
      }),
    });
    (env as unknown as Record<string, unknown>).HYPERDRIVE_CORE_PRIMARY = {
      connectionString: 'postgres://core-primary',
    };

    const allRes = await app.request('/api/admin/runtime-profiles?kind=storage', undefined, env);
    expect(allRes.status).toBe(200);
    const allBody = (await allRes.json()) as {
      include_builtins: boolean;
      profiles: { storage: Array<{ id: string }> };
      reference_status: {
        storage: Record<
          string,
          Array<{
            path: string;
            resolution: string;
            severity: string;
            activation: string;
            connectionRef?: string;
          }>
        >;
      };
      activation_status: {
        storage: Record<
          string,
          { activatable: boolean; state: string; blockingReasons: string[]; warnings: string[] }
        >;
      };
      reference_management: {
        mode: string;
        future: string;
        activationPolicy: string;
      };
      reference_catalog: {
        bindingRefs: {
          d1: string[];
          r2: string[];
          hyperdrive: string[];
        };
        connectionRefs: {
          all: string[];
        };
      };
      storage_policy: {
        environmentDefaultStorageProfileId: string;
        authCoreSlices: string[];
        slicePolicies: {
          identity_core: {
            boundaryClass: string;
            tenantOverrideAllowed: boolean;
          };
          identity_pii: {
            boundaryClass: string;
            nonD1OptionRequired: boolean;
          };
        };
        tenantOverrideEligibility: Record<string, { tenantOverrideAllowed: boolean }>;
        tenantDatabaseStatsStatus?: {
          available: boolean;
          attentionRequired: boolean;
          staleAfterHours: number;
          unavailableReason?: string;
          summary: {
            active_tenant_core_databases: number;
            stats_rows: number;
            missing_stats_count: number;
            stale_stats_count: number;
            warning_count: number;
            strong_warning_count: number;
            stale_file_size_count: number;
            unavailable_file_size_count: number;
          } | null;
        };
        capabilityStatus?: Record<
          string,
          {
            mvpReady: boolean;
            unsupportedCount: number;
            partialCount: number;
            capabilities: Array<{ id: string; state: string }>;
          }
        >;
        deploymentSelectionPolicy: {
          selectionScope: string;
          environmentDefaultStorageProfileId: string;
          profiles: Record<
            string,
            {
              deploymentSelectionAllowed: boolean;
              isEnvironmentDefault: boolean;
              guidance: { deploymentProfile: string; warnings: string[] };
            }
          >;
        };
      };
    };
    expect(allBody.include_builtins).toBe(true);
    expect(
      allBody.profiles.storage.some((profile) => profile.id === DEFAULT_STORAGE_PROFILE_ID)
    ).toBe(true);
    expect(allBody.profiles.storage.some((profile) => profile.id === 'tenant-a-storage')).toBe(
      true
    );
    expect(allBody.reference_status.storage['tenant-a-storage']).toEqual([
      expect.objectContaining({
        path: 'slices.custom_claims',
        resolution: 'reference_only',
        severity: 'warning',
        activation: 'blocked',
        connectionRef: 'tenant-a-core',
      }),
    ]);
    expect(allBody.activation_status.storage['tenant-a-storage']).toEqual(
      expect.objectContaining({
        activatable: false,
        state: 'blocked',
      })
    );
    expect(allBody.reference_management).toEqual(
      expect.objectContaining({
        mode: 'setup_only',
        future: 'admin_ui_planned',
        activationPolicy: 'save_ok_activate_ng',
      })
    );
    expect(allBody.reference_catalog.bindingRefs.d1).toEqual(expect.arrayContaining(['DB']));
    expect(allBody.reference_catalog.bindingRefs.r2).toEqual(
      expect.arrayContaining(['AUDIT_ARCHIVE'])
    );
    expect(allBody.reference_catalog.bindingRefs.hyperdrive).toEqual(
      expect.arrayContaining(['HYPERDRIVE_CORE_PRIMARY'])
    );
    expect(allBody.reference_catalog.connectionRefs.all).toEqual(
      expect.arrayContaining(['core-primary', 'tenant-a-core'])
    );
    expect(allBody).toHaveProperty('storage_policy.environmentDefaultStorageProfileId');
    expect(allBody).toHaveProperty(
      'storage_policy.tenantOverrideEligibility.tenant-a-storage.tenantOverrideAllowed',
      true
    );
    expect(allBody.storage_policy.tenantDatabaseStatsStatus).toEqual(
      expect.objectContaining({
        available: false,
        attentionRequired: false,
        staleAfterHours: 36,
        unavailableReason: 'db_admin_not_configured',
        summary: null,
      })
    );
    expect(allBody.storage_policy.capabilityStatus?.[DEFAULT_STORAGE_PROFILE_ID]).toEqual(
      expect.objectContaining({
        mvpReady: true,
        unsupportedCount: 0,
      })
    );
    expect(allBody.storage_policy.capabilityStatus?.['builtin:storage:tenant-d1']).toEqual(
      expect.objectContaining({
        mvpReady: false,
        unsupportedCount: expect.any(Number),
        capabilities: expect.arrayContaining([
          expect.objectContaining({ id: 'device_ciba_cold_persistence', state: 'unsupported' }),
        ]),
      })
    );
    expect(allBody.storage_policy.deploymentSelectionPolicy).toEqual(
      expect.objectContaining({
        selectionScope: 'deployment',
        environmentDefaultStorageProfileId: DEFAULT_STORAGE_PROFILE_ID,
      })
    );
    expect(
      allBody.storage_policy.deploymentSelectionPolicy.profiles[DEFAULT_STORAGE_PROFILE_ID]
    ).toEqual(
      expect.objectContaining({
        deploymentSelectionAllowed: true,
        isEnvironmentDefault: true,
        guidance: expect.objectContaining({
          deploymentProfile: 'shared-d1',
          warnings: expect.arrayContaining([expect.stringContaining('Shared D1')]),
        }),
      })
    );
    expect(allBody.storage_policy.authCoreSlices).toEqual(['identity_core']);
    expect(allBody.storage_policy.slicePolicies.identity_core).toEqual(
      expect.objectContaining({
        boundaryClass: 'auth_core',
        tenantOverrideAllowed: false,
      })
    );
    expect(allBody.storage_policy.slicePolicies.identity_pii).toEqual(
      expect.objectContaining({
        boundaryClass: 'pii',
        nonD1OptionRequired: true,
      })
    );

    const customOnlyRes = await app.request(
      '/api/admin/runtime-profiles?kind=storage&include_builtins=false',
      undefined,
      env
    );
    expect(customOnlyRes.status).toBe(200);
    const customOnlyBody = (await customOnlyRes.json()) as {
      profiles: { storage: Array<{ id: string }> };
    };
    expect(customOnlyBody.profiles.storage.map((profile) => profile.id)).toEqual([
      'tenant-a-storage',
    ]);
  });

  it('includes tenant database stats summary in storage policy when control DB is available', async () => {
    const app = createTestApp();
    const env = createEnv();
    env.DB_ADMIN = createMockD1First({
      active_tenant_core_databases: 4,
      stats_rows: 3,
      missing_stats_count: 1,
      stale_stats_count: 1,
      warning_count: 1,
      strong_warning_count: 1,
      stale_file_size_count: 1,
      unavailable_file_size_count: 0,
    });

    const res = await app.request('/api/admin/runtime-profiles?kind=storage', undefined, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      storage_policy: {
        tenantDatabaseStatsStatus: {
          available: boolean;
          attentionRequired: boolean;
          staleAfterHours: number;
          summary: {
            active_tenant_core_databases: number;
            missing_stats_count: number;
            stale_stats_count: number;
            warning_count: number;
            strong_warning_count: number;
            stale_file_size_count: number;
            unavailable_file_size_count: number;
          };
        };
      };
    };

    expect(body.storage_policy.tenantDatabaseStatsStatus).toEqual(
      expect.objectContaining({
        available: true,
        attentionRequired: true,
        staleAfterHours: 36,
        summary: expect.objectContaining({
          active_tenant_core_databases: 4,
          missing_stats_count: 1,
          stale_stats_count: 1,
          warning_count: 1,
          strong_warning_count: 1,
          stale_file_size_count: 1,
          unavailable_file_size_count: 0,
        }),
      })
    );
  });

  it('creates, updates, fetches, and deletes a custom runtime profile', async () => {
    const app = createTestApp();
    const env = createEnv();

    const createRes = await app.request(
      '/api/admin/runtime-profiles/storage/tenant-a-storage',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Tenant A Storage',
          slices: {
            custom_claims: {
              driver: 'postgres',
              connectionRef: 'tenant-a-core',
              role: 'core',
            },
          },
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      created: boolean;
      profile: { id: string; label: string; builtin: boolean };
    };
    expect(createBody.created).toBe(true);
    expect(createBody.profile.id).toBe('tenant-a-storage');
    expect(createBody.profile.builtin).toBe(false);

    const updateRes = await app.request(
      '/api/admin/runtime-profiles/storage/tenant-a-storage',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Tenant A Storage Updated',
          description: 'updated',
          slices: {
            custom_claims: {
              driver: 'postgres',
              connectionRef: 'tenant-a-core',
              role: 'core',
            },
          },
        }),
      },
      env
    );
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      created: boolean;
      profile: { label: string };
    };
    expect(updateBody.created).toBe(false);
    expect(updateBody.profile.label).toBe('Tenant A Storage Updated');

    const getRes = await app.request(
      '/api/admin/runtime-profiles/storage/tenant-a-storage',
      undefined,
      env
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      profile: { id: string; label: string };
      reference_status: Array<{
        path: string;
        resolution: string;
        severity: string;
        activation: string;
        connectionRef?: string;
      }>;
      activation_status: { activatable: boolean; state: string; blockingReasons: string[] };
      reference_management: { mode: string; activationPolicy: string };
      storage_policy: { tenantOverrideAllowed: boolean };
    };
    expect(getBody.profile.id).toBe('tenant-a-storage');
    expect(getBody.profile.label).toBe('Tenant A Storage Updated');
    expect(getBody.reference_status).toEqual([
      expect.objectContaining({
        path: 'slices.custom_claims',
        resolution: 'reference_only',
        severity: 'warning',
        activation: 'blocked',
        connectionRef: 'tenant-a-core',
      }),
    ]);
    expect(getBody.activation_status).toEqual(
      expect.objectContaining({
        activatable: false,
        state: 'blocked',
      })
    );
    expect(getBody.reference_management).toEqual(
      expect.objectContaining({
        mode: 'setup_only',
        activationPolicy: 'save_ok_activate_ng',
      })
    );
    expect(getBody.storage_policy.tenantOverrideAllowed).toBe(true);

    const deleteRes = await app.request(
      '/api/admin/runtime-profiles/storage/tenant-a-storage',
      { method: 'DELETE' },
      env
    );
    expect(deleteRes.status).toBe(200);
    const deleteBody = (await deleteRes.json()) as { deleted: boolean };
    expect(deleteBody.deleted).toBe(true);

    const missingRes = await app.request(
      '/api/admin/runtime-profiles/storage/tenant-a-storage',
      undefined,
      env
    );
    expect(missingRes.status).toBe(404);
  });

  it('persists audit profiles with primary=null and failure modes', async () => {
    const app = createTestApp();
    const env = createEnv();

    const createRes = await app.request(
      '/api/admin/runtime-profiles/audit/archive-only',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Archive Only',
          primary: null,
          archive: {
            type: 'r2',
            bucketRef: 'DIAGNOSTIC_LOGS',
            prefix: 'audit/',
          },
          sinks: [
            {
              type: 'logpush',
              destinationRef: 'workers-logpush',
              dataset: 'authrim_audit',
            },
          ],
          archiveFailureMode: 'gate_cleanup',
          sinkFailureMode: 'retry_until_ttl',
        }),
      },
      env
    );

    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      profile: {
        primary: null;
        archiveFailureMode: string;
        sinkFailureMode: string;
      };
    };
    expect(createBody.profile.primary).toBeNull();
    expect(createBody.profile.archiveFailureMode).toBe('gate_cleanup');
    expect(createBody.profile.sinkFailureMode).toBe('retry_until_ttl');
  });

  it('persists audit profiles with generic HTTP sinks', async () => {
    const app = createTestApp();
    const env = createEnv();

    const createRes = await app.request(
      '/api/admin/runtime-profiles/audit/http-sink-profile',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'HTTP Sink Profile',
          primary: null,
          archive: null,
          sinks: [
            {
              type: 'http',
              url: 'https://example.com/audit',
              headers: {
                'X-Authrim-Sink': 'enabled',
              },
            },
          ],
        }),
      },
      env
    );

    expect(createRes.status).toBe(201);
    const body = (await createRes.json()) as {
      profile: {
        sinks: Array<{ type: string; url?: string }>;
      };
    };
    expect(body.profile.sinks).toEqual([
      expect.objectContaining({
        type: 'http',
        url: 'https://example.com/audit',
      }),
    ]);
  });

  it('rejects non-https generic HTTP sinks', async () => {
    const app = createTestApp();
    const env = createEnv();

    const createRes = await app.request(
      '/api/admin/runtime-profiles/audit/http-sink-profile',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'HTTP Sink Profile',
          primary: null,
          archive: null,
          sinks: [
            {
              type: 'http',
              url: 'http://example.com/audit',
            },
          ],
        }),
      },
      env
    );

    expect(createRes.status).toBe(400);
  });

  it('rejects audit profiles without any delivery target', async () => {
    const app = createTestApp();
    const env = createEnv();

    const createRes = await app.request(
      '/api/admin/runtime-profiles/audit/invalid-empty',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Invalid Empty',
          primary: null,
          archive: null,
          sinks: [],
        }),
      },
      env
    );

    expect(createRes.status).toBe(400);
  });

  it('rejects audit profiles with fan-out targets when AUDIT_QUEUE is unavailable', async () => {
    const app = createTestApp();
    const env = createEnv();
    delete (env as Partial<Env>).AUDIT_QUEUE;

    const createRes = await app.request(
      '/api/admin/runtime-profiles/audit/archive-only',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Archive Only',
          primary: null,
          archive: {
            type: 'r2',
            bucketRef: 'DIAGNOSTIC_LOGS',
            prefix: 'audit/',
          },
          sinks: [],
        }),
      },
      env
    );

    expect(createRes.status).toBe(400);
  });

  it('returns runtime profile defaults and updates them through infrastructure settings', async () => {
    const app = createTestApp();
    const env = createEnv({
      'profile-registry:audit:archive-only': JSON.stringify({
        id: 'archive-only',
        kind: 'audit',
        label: 'Archive Only',
        builtin: false,
        primary: null,
        archive: {
          type: 'r2',
          bucketRef: 'DIAGNOSTIC_LOGS',
          prefix: 'audit/',
        },
        sinks: [],
      }),
    });

    const beforeRes = await app.request('/api/admin/runtime-profiles/defaults', undefined, env);
    expect(beforeRes.status).toBe(200);
    const beforeBody = (await beforeRes.json()) as {
      defaults: { auditProfileId: string };
      effective: { audit: { id: string } };
      reference_status: {
        audit: Array<{
          path: string;
          resolution: string;
          severity: string;
          activation: string;
          reference?: string;
        }>;
      };
      activation_status: {
        audit: { activatable: boolean; state: string };
      };
      reference_management: { mode: string; activationPolicy: string };
      reference_catalog: {
        bindingRefs: {
          d1: string[];
          r2: string[];
        };
      };
    };
    expect(beforeBody.defaults.auditProfileId).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(beforeBody.effective.audit.id).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(beforeBody.activation_status.audit).toEqual(
      expect.objectContaining({
        activatable: true,
        state: 'ready',
      })
    );
    expect(beforeBody.reference_management.mode).toBe('setup_only');
    expect(beforeBody.reference_catalog.bindingRefs.d1).toEqual(expect.arrayContaining(['DB']));
    expect(beforeBody.reference_catalog.bindingRefs.r2).toEqual(
      expect.arrayContaining(['AUDIT_ARCHIVE'])
    );
    expect(beforeBody.reference_status.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'primary',
        }),
      ])
    );

    const updateRes = await app.request(
      '/api/admin/runtime-profiles/defaults',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auditProfileId: 'archive-only',
        }),
      },
      env
    );
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      updated: string[];
      defaults: { auditProfileId: string };
      effective: { audit: { id: string } };
      reference_status: {
        audit: Array<{
          path: string;
          resolution: string;
          severity: string;
          activation: string;
          reference?: string;
        }>;
      };
      activation_status: {
        audit: { activatable: boolean; state: string };
      };
    };
    expect(updateBody.updated).toContain('infra.default_audit_profile_id');
    expect(updateBody.defaults.auditProfileId).toBe('archive-only');
    expect(updateBody.effective.audit.id).toBe('archive-only');
    expect(updateBody.activation_status.audit).toEqual(
      expect.objectContaining({
        activatable: true,
        state: 'ready',
      })
    );
    expect(updateBody.reference_status.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'archive',
          resolution: 'configured',
          reference: 'DIAGNOSTIC_LOGS',
        }),
      ])
    );
  });

  it('allows saving a storage profile with connectionRef but rejects activating it as the default', async () => {
    const app = createTestApp();
    const env = createEnv();

    const createRes = await app.request(
      '/api/admin/runtime-profiles/storage/tenant-a-storage',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Tenant A Storage',
          slices: {
            custom_claims: {
              driver: 'postgres',
              connectionRef: 'tenant-a-core',
              role: 'core',
            },
          },
        }),
      },
      env
    );
    expect(createRes.status).toBe(201);

    const updateDefaultsRes = await app.request(
      '/api/admin/runtime-profiles/defaults',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storageProfileId: 'tenant-a-storage',
        }),
      },
      env
    );

    expect(updateDefaultsRes.status).toBe(400);
  });

  it('allows activating an audit profile when connectionRef resolves through a Hyperdrive binding', async () => {
    const app = createTestApp();
    const env = createEnv({
      'profile-registry:audit:external-audit': JSON.stringify({
        id: 'external-audit',
        kind: 'audit',
        label: 'External Audit',
        builtin: false,
        primary: {
          type: 'postgres',
          connectionRef: 'audit-primary',
          dataset: 'event_log',
        },
        archive: null,
        sinks: [],
      }),
    });
    (env as unknown as Record<string, unknown>).HYPERDRIVE_AUDIT_PRIMARY = {
      connectionString: 'postgres://audit-primary',
    };

    const getRes = await app.request(
      '/api/admin/runtime-profiles/audit/external-audit',
      undefined,
      env
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      reference_status: Array<{
        path: string;
        resolution: string;
        severity: string;
        activation: string;
      }>;
      activation_status: { activatable: boolean; state: string };
    };
    expect(getBody.reference_status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'primary',
          resolution: 'configured',
          severity: 'info',
          activation: 'ready',
        }),
      ])
    );
    expect(getBody.activation_status).toEqual(
      expect.objectContaining({
        activatable: true,
        state: 'ready',
      })
    );

    const defaultsRes = await app.request(
      '/api/admin/runtime-profiles/defaults',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auditProfileId: 'external-audit',
        }),
      },
      env
    );
    expect(defaultsRes.status).toBe(200);
  });

  it('allows activating a storage profile when connectionRef resolves through Hyperdrive bindings', async () => {
    const app = createTestApp();
    const env = createEnv({
      'profile-registry:storage:external-storage': JSON.stringify({
        id: 'external-storage',
        kind: 'storage',
        label: 'External Storage',
        builtin: false,
        slices: {
          identity_core: {
            driver: 'postgres',
            connectionRef: 'core-primary',
            role: 'core',
          },
          identity_pii: {
            driver: 'postgres',
            connectionRef: 'pii-primary',
            role: 'pii',
          },
        },
      }),
    });
    (env as unknown as Record<string, unknown>).HYPERDRIVE_CORE_PRIMARY = {
      connectionString: 'postgres://core-primary',
    };
    (env as unknown as Record<string, unknown>).HYPERDRIVE_PII_PRIMARY = {
      connectionString: 'postgres://pii-primary',
    };

    const getRes = await app.request(
      '/api/admin/runtime-profiles/storage/external-storage',
      undefined,
      env
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      reference_status: Array<{
        path: string;
        resolution: string;
        severity: string;
        activation: string;
      }>;
      activation_status: { activatable: boolean; state: string };
    };
    expect(getBody.reference_status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'slices.identity_core',
          resolution: 'configured',
          severity: 'info',
          activation: 'ready',
        }),
        expect.objectContaining({
          path: 'slices.identity_pii',
          resolution: 'configured',
          severity: 'info',
          activation: 'ready',
        }),
      ])
    );
    expect(getBody.activation_status).toEqual(
      expect.objectContaining({
        activatable: true,
        state: 'ready',
      })
    );

    const defaultsRes = await app.request(
      '/api/admin/runtime-profiles/defaults',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storageProfileId: 'external-storage',
        }),
      },
      env
    );
    expect(defaultsRes.status).toBe(200);
  });

  it('rejects unknown runtime profile defaults', async () => {
    const app = createTestApp();
    const env = createEnv();

    const res = await app.request(
      '/api/admin/runtime-profiles/defaults',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auditProfileId: 'missing-profile',
        }),
      },
      env
    );

    expect(res.status).toBe(404);
  });

  it('rejects switching defaults to an audit profile that requires AUDIT_QUEUE when it is unavailable', async () => {
    const app = createTestApp();
    const env = createEnv({
      'profile-registry:audit:archive-only': JSON.stringify({
        id: 'archive-only',
        kind: 'audit',
        label: 'Archive Only',
        builtin: false,
        primary: null,
        archive: {
          type: 'r2',
          bucketRef: 'DIAGNOSTIC_LOGS',
          prefix: 'audit/',
        },
        sinks: [],
      }),
    });
    delete (env as Partial<Env>).AUDIT_QUEUE;

    const res = await app.request(
      '/api/admin/runtime-profiles/defaults',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auditProfileId: 'archive-only',
        }),
      },
      env
    );

    expect(res.status).toBe(400);
  });

  it('rejects invalid kinds and builtin profile mutation attempts', async () => {
    const app = createTestApp();
    const env = createEnv();

    const invalidRes = await app.request(
      '/api/admin/runtime-profiles?kind=unknown',
      undefined,
      env
    );
    expect(invalidRes.status).toBe(400);

    const builtinPutRes = await app.request(
      `/api/admin/runtime-profiles/storage/${DEFAULT_STORAGE_PROFILE_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Should Fail',
          slices: {
            custom_claims: {
              driver: 'postgres',
              connectionRef: 'forbidden',
              role: 'core',
            },
          },
        }),
      },
      env
    );
    expect(builtinPutRes.status).toBe(409);

    const builtinDeleteRes = await app.request(
      `/api/admin/runtime-profiles/storage/${DEFAULT_STORAGE_PROFILE_ID}`,
      { method: 'DELETE' },
      env
    );
    expect(builtinDeleteRes.status).toBe(409);
  });

  it('marks auth-core-changing storage profiles as not tenant-override compatible', async () => {
    const app = createTestApp();
    const env = createEnv({
      'profile-registry:storage:tenant-auth-core-storage': JSON.stringify({
        id: 'tenant-auth-core-storage',
        kind: 'storage',
        label: 'Tenant Auth Core Storage',
        slices: {
          identity_core: {
            driver: 'postgres',
            connectionRef: 'tenant-a-core',
            role: 'core',
          },
        },
      }),
    });

    const response = await app.request(
      '/api/admin/runtime-profiles/storage/tenant-auth-core-storage',
      undefined,
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      storage_policy: {
        authCoreSlice: string;
        authCoreSlices: string[];
        slicePolicies: {
          identity_core: Record<string, unknown>;
        };
        tenantOverrideAllowed: boolean;
        violationCode?: string;
      };
    };

    expect(body.storage_policy.authCoreSlice).toBe('identity_core');
    expect(body.storage_policy.authCoreSlices).toEqual(['identity_core']);
    expect(body.storage_policy.slicePolicies.identity_core).not.toHaveProperty(
      'compatibilityShorthand'
    );
    expect(body.storage_policy.tenantOverrideAllowed).toBe(false);
    expect(body.storage_policy.violationCode).toBe('tenant_auth_core_override_not_allowed');
  });

  it('resolves tenant effective runtime profiles from deployment defaults and tenant audit/residency overrides', async () => {
    const app = createTestApp();
    const env = createEnv({
      'profile-registry:storage:tenant-a-storage': JSON.stringify({
        id: 'tenant-a-storage',
        kind: 'storage',
        label: 'Tenant A Storage',
        slices: {
          custom_claims: {
            driver: 'postgres',
            connectionRef: 'tenant-a-core',
            role: 'core',
          },
        },
      }),
      'settings:tenant:acme:tenant': JSON.stringify({
        'tenant.storage_profile_id': 'tenant-a-storage',
        'tenant.residency_profile_id': 'builtin:residency:eu',
      }),
    });

    const response = await app.request('/api/admin/tenants/acme/runtime-profiles', undefined, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tenant_id: string;
      refs: {
        storageProfileId: string;
        auditProfileId: string;
        residencyProfileId: string;
        inherited: {
          storage: boolean;
          audit: boolean;
          residency: boolean;
        };
      };
      effective: {
        storage: { id: string };
        audit: { id: string };
        residency: { id: string };
      };
      storage_policy: {
        slicePolicies: {
          custom_claims: {
            boundaryClass: string;
            tenantOverrideAllowed: boolean;
          };
        };
        tenantOverrideRequested: boolean;
        tenantOverrideAllowed: boolean;
        deploymentSelectionPolicy: {
          selectionScope: string;
          isEnvironmentDefault: boolean;
        };
      };
    };

    expect(body.tenant_id).toBe('acme');
    expect(body.refs.storageProfileId).toBe('tenant-a-storage');
    expect(body.refs.auditProfileId).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(body.refs.residencyProfileId).toBe('builtin:residency:eu');
    expect(body.refs.inherited).toEqual({
      storage: false,
      audit: true,
      residency: false,
    });
    expect(body.effective.storage.id).toBe('tenant-a-storage');
    expect(body.effective.audit.id).toBe(DEFAULT_AUDIT_PROFILE_ID);
    expect(body.effective.residency.id).toBe('builtin:residency:eu');
    expect(body.storage_policy.slicePolicies.custom_claims).toEqual(
      expect.objectContaining({
        boundaryClass: 'custom_extension',
        tenantOverrideAllowed: true,
      })
    );
    expect(body.storage_policy.tenantOverrideRequested).toBe(true);
    expect(body.storage_policy.tenantOverrideAllowed).toBe(true);
    expect(body.storage_policy.deploymentSelectionPolicy).toEqual(
      expect.objectContaining({
        selectionScope: 'deployment',
        isEnvironmentDefault: false,
      })
    );
  });

  it('purges tenant runtime registry snapshots with break-glass confirmation and audit log', async () => {
    const app = createTestApp();
    const registry = createMockKV({
      'tenant:acme:runtime-registry:snapshot:tenant:edge-a': JSON.stringify({ tenant_id: 'acme' }),
      'tenant:acme:runtime-registry:generation:tenant:edge-a': '7',
    });
    const env = {
      ...createEnv(),
      TENANT_RUNTIME_REGISTRY: registry,
    } as Env;

    const response = await app.request(
      '/api/admin/tenants/acme/runtime-registry/emergency-purge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          breakGlassConfirmation: TENANT_RUNTIME_REGISTRY_EMERGENCY_PURGE_CONFIRMATION,
          reason: 'stale generated binding after emergency rollback',
          deploymentTarget: 'edge-a',
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      purged: boolean;
      tenant_id: string;
      deployment_target: string;
      snapshot_key: string;
      generation_key: string;
    };
    expect(body).toEqual(
      expect.objectContaining({
        purged: true,
        tenant_id: 'acme',
        deployment_target: 'edge-a',
        snapshot_key: 'tenant:acme:runtime-registry:snapshot:tenant:edge-a',
        generation_key: 'tenant:acme:runtime-registry:generation:tenant:edge-a',
      })
    );
    await expect(registry.get(body.snapshot_key)).resolves.toBeNull();
    await expect(registry.get(body.generation_key)).resolves.toBeNull();
    expect(mockWriteAdminAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'tenant_runtime_registry_snapshot.emergency_purge',
        resourceType: 'tenant_runtime_registry_snapshot',
        resourceId: 'tenant:acme:runtime-registry:snapshot:tenant:edge-a',
        result: 'success',
        severity: 'critical',
        metadata: expect.objectContaining({
          tenant_id: 'acme',
          deployment_target: 'edge-a',
          reason: 'stale generated binding after emergency rollback',
          generation_key: 'tenant:acme:runtime-registry:generation:tenant:edge-a',
        }),
      })
    );
  });

  it('rejects tenant runtime registry emergency purge without exact confirmation', async () => {
    const app = createTestApp();
    const registry = createMockKV({
      'tenant:acme:runtime-registry:snapshot:tenant:edge-a': JSON.stringify({ tenant_id: 'acme' }),
      'tenant:acme:runtime-registry:generation:tenant:edge-a': '7',
    });
    const env = {
      ...createEnv(),
      TENANT_RUNTIME_REGISTRY: registry,
    } as Env;

    const response = await app.request(
      '/api/admin/tenants/acme/runtime-registry/emergency-purge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          breakGlassConfirmation: 'PURGE',
          reason: 'operator typed the wrong confirmation',
          deploymentTarget: 'edge-a',
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    await expect(
      registry.get('tenant:acme:runtime-registry:snapshot:tenant:edge-a')
    ).resolves.not.toBeNull();
    await expect(
      registry.get('tenant:acme:runtime-registry:generation:tenant:edge-a')
    ).resolves.toBe('7');
    expect(mockWriteAdminAuditLog).not.toHaveBeenCalled();
  });
});
