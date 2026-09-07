import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '@authrim/ar-lib-core';
import {
  DEFAULT_AUDIT_PROFILE_ID,
  DEFAULT_RESIDENCY_PROFILE_ID,
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
    DEFAULT_AUDIT_PROFILE_ID,
    DEFAULT_RESIDENCY_PROFILE_ID,
    BASE_DOMAIN: 'auth.example.com',
  } as unknown as Env;
}

describe('runtime profile admin handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists only audit and residency profiles', async () => {
    const app = createTestApp();
    const env = createEnv();

    const response = await app.request('/api/admin/runtime-profiles', undefined, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      profiles: Record<string, Array<{ id: string }>>;
      reference_status: Record<string, unknown>;
      activation_status: Record<string, unknown>;
    };

    expect(Object.keys(body.profiles).sort()).toEqual(['audit', 'residency']);
    expect(Object.keys(body.reference_status).sort()).toEqual(['audit', 'residency']);
    expect(Object.keys(body.activation_status).sort()).toEqual(['audit', 'residency']);
  });

  it('uses the matching PII and admin release streams for custom D1 audit targets', async () => {
    const app = createTestApp();
    const env = createEnv({
      'profile-registry:audit:pii-d1-audit': JSON.stringify({
        id: 'pii-d1-audit',
        kind: 'audit',
        label: 'PII D1 Audit',
        builtin: false,
        primary: { type: 'd1', bindingRef: 'DB_PII', dataset: 'pii_log' },
        archive: null,
        sinks: [],
      }),
      'profile-registry:audit:admin-d1-audit': JSON.stringify({
        id: 'admin-d1-audit',
        kind: 'audit',
        label: 'Admin D1 Audit',
        builtin: false,
        primary: { type: 'd1', bindingRef: 'DB_ADMIN', dataset: 'admin_audit_log' },
        archive: null,
        sinks: [],
      }),
    });
    env.DB_PII = {} as D1Database;
    env.DB_ADMIN = {} as D1Database;
    env.AUTHRIM_REGISTERED_SCHEMA_REFS = JSON.stringify([
      'binding:DB_PII:pii-d1',
      'binding:DB_ADMIN:admin-d1',
    ]);

    for (const profileId of ['pii-d1-audit', 'admin-d1-audit']) {
      const getRes = await app.request(
        `/api/admin/runtime-profiles/audit/${profileId}`,
        undefined,
        env
      );
      expect(getRes.status).toBe(200);
      await expect(getRes.json()).resolves.toMatchObject({
        reference_status: [expect.objectContaining({ path: 'primary', activation: 'ready' })],
        activation_status: expect.objectContaining({ activatable: true, state: 'ready' }),
      });

      const defaultsRes = await app.request(
        '/api/admin/runtime-profiles/defaults',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ auditProfileId: profileId }),
        },
        env
      );
      expect(defaultsRes.status).toBe(200);
    }
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
    expect(Object.keys(beforeBody.defaults).sort()).toEqual([
      'auditProfileId',
      'residencyProfileId',
    ]);
    expect(Object.keys(beforeBody.effective).sort()).toEqual(['audit', 'residency']);
    expect(Object.keys(beforeBody.reference_status).sort()).toEqual(['audit', 'residency']);
    expect(Object.keys(beforeBody.activation_status).sort()).toEqual(['audit', 'residency']);
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

  it('blocks external audit database activation until an audit release stream exists', async () => {
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
          severity: 'error',
          activation: 'blocked',
        }),
      ])
    );
    expect(getBody.activation_status).toEqual(
      expect.objectContaining({
        activatable: false,
        state: 'blocked',
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
    expect(defaultsRes.status).toBe(400);
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

  it('rejects unknown kinds, unknown default fields, and builtin profile mutation attempts', async () => {
    const app = createTestApp();
    const env = createEnv();

    const invalidRes = await app.request(
      '/api/admin/runtime-profiles?kind=unknown',
      undefined,
      env
    );
    expect(invalidRes.status).toBe(400);

    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const unknownKindRes = await app.request(
        '/api/admin/runtime-profiles/unknown/not-a-profile',
        {
          method,
          ...(method === 'PUT'
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: 'Removed' }),
              }
            : {}),
        },
        env
      );
      expect(unknownKindRes.status).toBe(400);
    }

    const unknownDefaultRes = await app.request(
      '/api/admin/runtime-profiles/defaults',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unknownProfileId: 'not-a-profile' }),
      },
      env
    );
    expect(unknownDefaultRes.status).toBe(400);

    const builtinPutRes = await app.request(
      `/api/admin/runtime-profiles/audit/${DEFAULT_AUDIT_PROFILE_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: 'Should Fail',
          primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
          archive: null,
          sinks: [],
        }),
      },
      env
    );
    expect(builtinPutRes.status).toBe(409);

    const builtinDeleteRes = await app.request(
      `/api/admin/runtime-profiles/audit/${DEFAULT_AUDIT_PROFILE_ID}`,
      { method: 'DELETE' },
      env
    );
    expect(builtinDeleteRes.status).toBe(409);
  });

  it('resolves exactly the tenant audit and residency profiles', async () => {
    const app = createTestApp();
    const env = createEnv({
      'profile-registry:audit:tenant-a-audit': JSON.stringify({
        id: 'tenant-a-audit',
        kind: 'audit',
        label: 'Tenant A Audit',
        primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
        archive: null,
        sinks: [],
      }),
      'settings:tenant:acme:tenant': JSON.stringify({
        'tenant.audit_profile_id': 'tenant-a-audit',
        'tenant.residency_profile_id': 'builtin:residency:eu',
      }),
    });

    const response = await app.request('/api/admin/tenants/acme/runtime-profiles', undefined, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      tenant_id: string;
      refs: {
        auditProfileId: string;
        residencyProfileId: string;
        inherited: {
          audit: boolean;
          residency: boolean;
        };
      };
      effective: {
        audit: { id: string };
        residency: { id: string };
      };
    };

    expect(body.tenant_id).toBe('acme');
    expect(body.refs.auditProfileId).toBe('tenant-a-audit');
    expect(body.refs.residencyProfileId).toBe('builtin:residency:eu');
    expect(body.refs.inherited).toEqual({
      audit: false,
      residency: false,
    });
    expect(body.effective.audit.id).toBe('tenant-a-audit');
    expect(body.effective.residency.id).toBe('builtin:residency:eu');
    expect(Object.keys(body.refs).sort()).toEqual([
      'auditProfileId',
      'inherited',
      'residencyProfileId',
    ]);
    expect(Object.keys(body.effective).sort()).toEqual(['audit', 'residency']);
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
