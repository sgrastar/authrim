import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../index';

function createDb(options: { throwOnPrepare?: boolean } = {}) {
  const run = vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } });
  const first = vi.fn().mockResolvedValue(null);
  const all = vi.fn().mockResolvedValue({ results: [] });
  const prepare = vi.fn(() => {
    if (options.throwOnPrepare) throw new Error('database unavailable');
    return {
      bind: vi.fn().mockReturnThis(),
      first,
      all,
      run,
    };
  });
  return { prepare, batch: vi.fn().mockResolvedValue([]), run, first, all };
}

function createKv(options: { throwOnWrite?: boolean } = {}) {
  const data = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      if (options.throwOnWrite) throw new Error('KV write failed');
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      if (options.throwOnWrite) throw new Error('KV delete failed');
      data.delete(key);
    }),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  };
}

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    POLICY_API_SECRET: 'policy-secret',
    ENABLE_POLICY_SIMULATION_API: 'true',
    ENABLE_REBAC: 'true',
    DB: createDb(),
    VERSION_MANAGER: {
      idFromName: vi.fn(() => ({ toString: () => 'version-id' })),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => new Response(JSON.stringify({ uuid: 'version' }))),
      })),
    },
    CODE_VERSION_UUID: '',
    ...overrides,
  };
}

function request(
  path: string,
  options: { method?: string; body?: unknown; rawBody?: string; auth?: string | null } = {}
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth !== null) {
    headers.Authorization = options.auth ?? 'Bearer policy-secret';
  }
  return new Request(`https://policy.example${path}`, {
    method: options.method ?? 'GET',
    headers,
    body:
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

describe('Policy service branch and failure behavior', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('internal authentication and feature flags', () => {
    it.each([null, 'Basic policy-secret', 'Bearer wrong-secret', 'Bearer '])(
      'rejects invalid internal authentication without leaking details',
      async (auth) => {
        const response = await app.fetch(request('/api/policy/flags', { auth }), createEnv());
        expect(response.status).toBe(401);
      }
    );

    it('returns flag sources with and without KV', async () => {
      let response = await app.fetch(request('/api/policy/flags'), createEnv());
      expect(response.status).toBe(200);
      expect((await response.json()).kvEnabled).toBe(false);

      response = await app.fetch(
        request('/api/policy/flags'),
        createEnv({ POLICY_FLAGS_KV: createKv() })
      );
      expect(response.status).toBe(200);
      expect((await response.json()).kvEnabled).toBe(true);
    });

    it.each(['put', 'delete'] as const)(
      '%s rejects unknown feature names and missing KV',
      async (operation) => {
        const method = operation.toUpperCase();
        let response = await app.fetch(
          request('/api/policy/flags/UNKNOWN', { method, body: { value: true } }),
          createEnv()
        );
        expect(response.status).toBe(400);

        response = await app.fetch(
          request('/api/policy/flags/ENABLE_ABAC', { method, body: { value: true } }),
          createEnv()
        );
        expect(response.status).toBe(500);
      }
    );

    it('validates and persists boolean feature overrides', async () => {
      const kv = createKv();
      let response = await app.fetch(
        request('/api/policy/flags/ENABLE_ABAC', {
          method: 'PUT',
          body: { value: 'true' },
        }),
        createEnv({ POLICY_FLAGS_KV: kv })
      );
      expect(response.status).toBe(400);

      response = await app.fetch(
        request('/api/policy/flags/ENABLE_ABAC', { method: 'PUT', body: { value: false } }),
        createEnv({ POLICY_FLAGS_KV: kv })
      );
      expect(response.status).toBe(200);
      expect(kv.put).toHaveBeenCalled();

      response = await app.fetch(
        request('/api/policy/flags/ENABLE_ABAC', { method: 'DELETE' }),
        createEnv({ POLICY_FLAGS_KV: kv })
      );
      expect(response.status).toBe(200);
      expect(kv.delete).toHaveBeenCalled();
    });

    it('maps unexpected flag storage failures to the global internal error handler', async () => {
      const response = await app.fetch(
        request('/api/policy/flags/ENABLE_ABAC', { method: 'PUT', body: { value: true } }),
        createEnv({ POLICY_FLAGS_KV: createKv({ throwOnWrite: true }) })
      );
      expect(response.status).toBe(500);
    });
  });

  describe('simulation endpoints', () => {
    it.each(['/evaluate', '/check-role', '/check-access', '/is-admin'])(
      'fails closed when simulation API is disabled: %s',
      async (path) => {
        const response = await app.fetch(
          request(`/api/policy${path}`, { method: 'POST', body: {} }),
          createEnv({ ENABLE_POLICY_SIMULATION_API: undefined })
        );
        expect(response.status).toBe(403);
      }
    );

    it.each(['/evaluate', '/check-role', '/check-access', '/is-admin'])(
      'handles malformed JSON without exposing an exception: %s',
      async (path) => {
        const response = await app.fetch(
          request(`/api/policy${path}`, { method: 'POST', rawBody: '{' }),
          createEnv()
        );
        expect(response.status).toBe(500);
      }
    );

    it('uses the supplied timestamp and excludes expired roles from the response', async () => {
      const evaluate = await app.fetch(
        request('/api/policy/evaluate', {
          method: 'POST',
          body: {
            subject: { id: 'user', roles: [{ name: 'system_admin', scope: 'global' }] },
            resource: { type: 'document', id: 'doc' },
            action: { name: 'read' },
            timestamp: 1,
          },
        }),
        createEnv()
      );
      expect(evaluate.status).toBe(200);

      const roles = await app.fetch(
        request('/api/policy/check-role', {
          method: 'POST',
          body: {
            subject: {
              id: 'user',
              roles: [
                { name: 'expired', scope: 'global', expiresAt: 1 },
                { name: 'active', scope: 'global' },
                { name: 'active', scope: 'global' },
              ],
            },
            roles: ['active', 'missing'],
          },
        }),
        createEnv()
      );
      expect(await roles.json()).toMatchObject({ hasRole: true, activeRoles: ['active'] });
    });

    it('allows claims subject override and empty direct subject ids without trusting caller data', async () => {
      const claimsResponse = await app.fetch(
        request('/api/policy/check-access', {
          method: 'POST',
          body: {
            claims: { sub: 'claim-user', authrim_roles: ['end_user'] },
            subjectId: 'explicit-user',
            resourceType: 'document',
            resourceId: 'doc',
            resourceOwnerId: 'explicit-user',
            resourceOrgId: 'org',
            action: 'read',
            operation: 'view',
          },
        }),
        createEnv()
      );
      expect(claimsResponse.status).toBe(200);
      expect((await claimsResponse.json()).allowed).toBe(true);

      const rolesResponse = await app.fetch(
        request('/api/policy/check-access', {
          method: 'POST',
          body: {
            roles: [],
            resourceType: 'document',
            resourceId: 'doc',
            action: 'read',
          },
        }),
        createEnv()
      );
      expect(rolesResponse.status).toBe(200);
      expect((await rolesResponse.json()).allowed).toBe(false);
    });
  });

  describe('legacy ReBAC read APIs', () => {
    it.each(['/check', '/batch-check', '/list-objects', '/list-users'])(
      'requires internal authentication: %s',
      async (path) => {
        const response = await app.fetch(
          request(`/api/rebac${path}`, { method: 'POST', body: {}, auth: null }),
          createEnv()
        );
        expect(response.status).toBe(401);
      }
    );

    it.each(['/batch-check', '/list-objects', '/list-users'])(
      'fails closed when ReBAC is disabled: %s',
      async (path) => {
        const response = await app.fetch(
          request(`/api/rebac${path}`, { method: 'POST', body: {} }),
          createEnv({ ENABLE_REBAC: 'false' })
        );
        expect(response.status).toBe(403);
      }
    );

    it.each([
      ['/batch-check', {}],
      ['/batch-check', { checks: [] }],
      ['/list-objects', {}],
      ['/list-users', {}],
    ])('validates malformed requests: %s', async (path, body) => {
      const response = await app.fetch(
        request(`/api/rebac${path}`, { method: 'POST', body }),
        createEnv()
      );
      expect(response.status).toBe(400);
    });

    it('rejects oversized batches and missing tenant IDs in any batch item', async () => {
      let response = await app.fetch(
        request('/api/rebac/batch-check', {
          method: 'POST',
          body: { checks: Array.from({ length: 101 }, () => ({ tenant_id: 'tenant-a' })) },
        }),
        createEnv()
      );
      expect(response.status).toBe(400);

      response = await app.fetch(
        request('/api/rebac/batch-check', {
          method: 'POST',
          body: {
            checks: [
              {
                tenant_id: 'tenant-a',
                user_id: 'user:a',
                relation: 'viewer',
                object: 'document:a',
              },
              { tenant_id: '  ', user_id: 'user:b', relation: 'viewer', object: 'document:b' },
            ],
          },
        }),
        createEnv()
      );
      expect(response.status).toBe(400);
    });

    it('executes tenant-scoped batch and list requests with bounded limits', async () => {
      const env = createEnv();
      const batch = await app.fetch(
        request('/api/rebac/batch-check', {
          method: 'POST',
          body: {
            checks: [
              {
                tenant_id: ' tenant-a ',
                user_id: 'user:a',
                relation: 'viewer',
                object: 'document:a',
              },
            ],
          },
        }),
        env
      );
      expect(batch.status).toBe(200);

      for (const [path, body] of [
        [
          '/list-objects',
          {
            tenant_id: 'tenant-a',
            user_id: 'user:a',
            relation: 'viewer',
            object_type: 'document',
            limit: 5000,
            cursor: 'next',
          },
        ],
        [
          '/list-users',
          {
            tenant_id: 'tenant-a',
            object: 'document:a',
            object_type: 'document',
            relation: 'viewer',
            limit: 0,
            cursor: 'next',
          },
        ],
      ] as const) {
        const response = await app.fetch(
          request(`/api/rebac${path}`, { method: 'POST', body }),
          env
        );
        expect(response.status).toBe(200);
      }
    });

    it.each(['/check', '/batch-check', '/list-objects', '/list-users'])(
      'maps database failures to an internal error: %s',
      async (path) => {
        const bodies: Record<string, unknown> = {
          '/check': {
            tenant_id: 'tenant-a',
            user_id: 'user:a',
            relation: 'viewer',
            object: 'document:a',
          },
          '/batch-check': {
            checks: [
              {
                tenant_id: 'tenant-a',
                user_id: 'user:a',
                relation: 'viewer',
                object: 'document:a',
              },
            ],
          },
          '/list-objects': {
            tenant_id: 'tenant-a',
            user_id: 'user:a',
            relation: 'viewer',
            object_type: 'document',
          },
          '/list-users': {
            tenant_id: 'tenant-a',
            object: 'document:a',
            relation: 'viewer',
          },
        };
        const response = await app.fetch(
          request(`/api/rebac${path}`, { method: 'POST', body: bodies[path] }),
          createEnv({ DB: createDb({ throwOnPrepare: true }) })
        );
        expect(response.status).toBe(500);
      }
    );
  });
});
