import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
  invalidateCache: vi.fn(),
  audit: vi.fn(),
  safeFetch: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    resolveOptionalCoreAdapterFromHono: vi.fn(() => mocks.adapter),
    resolveTenantDatabaseSourceFromRegistry: vi.fn(async (_env, input) => ({
      tenantId: input.tenantId,
      source: mocks.adapter,
    })),
    loadVerifiedLookupBucketAssignmentProvider: vi.fn(async () => ({})),
    LookupRouteResolver: class {
      async resolveAliases() {
        return [{ tenantId: 'tenant-a', routeProjection: {} }];
      }
    },
    ensureDatabaseAdapter: vi.fn((db) => db),
    hasAdminPermission: vi.fn((permissions: string[], permission: string) =>
      permissions.includes(permission)
    ),
    createErrorResponse: vi.fn((c, code, options) => {
      const status =
        code === actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS
          ? 403
          : code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
            ? 404
            : code === actual.AR_ERROR_CODES.INTERNAL_ERROR
              ? 500
              : 400;
      return c.json({ error: code, ...options }, status);
    }),
    invalidateTenantVanityDomainCache: mocks.invalidateCache,
    createAuditLogFromContext: mocks.audit,
    safeFetch: mocks.safeFetch,
    readResponseTextWithLimit: vi.fn((response: Response) => response.text()),
    getLogger: vi.fn(() => ({ module: vi.fn(() => ({ error: vi.fn() })) })),
  };
});

vi.mock('../tenant-alias-directory', () => ({
  resolveTenantDiscoveryAliasDirectoryInput: vi.fn(async (_env, input) => ({
    ...input,
    routeProjection: {},
  })),
  prepareTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  activateTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  ensureActiveTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  disableTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
}));

import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import {
  createPlatformTenantVanityDomainHandler,
  createTenantVanityDomainHandler,
  deletePlatformTenantVanityDomainHandler,
  deleteTenantVanityDomainHandler,
  getPlatformTenantVanityDomainHandler,
  getTenantVanityDomainHandler,
  listPlatformTenantVanityDomainsHandler,
  listTenantVanityDomainsHandler,
  setPrimaryPlatformTenantVanityDomainHandler,
  setPrimaryTenantVanityDomainHandler,
  syncPlatformTenantVanityDomainHandler,
  syncTenantVanityDomainHandler,
  updateTenantVanityDomainHandler,
  verifyPlatformTenantVanityDomainHandler,
  verifyTenantVanityDomainHandler,
} from '../admin-tenant-vanity-domains';

function domain(overrides: Record<string, unknown> = {}) {
  return {
    id: 'domain-1',
    tenant_id: 'tenant-a',
    hostname: 'login.example.com',
    is_active: 1,
    is_primary: 0,
    status: 'pending_manual',
    cloudflare_zone_id: null,
    cloudflare_custom_hostname_id: null,
    ssl_status: null,
    ownership_status: null,
    validation_method: null,
    validation_records_json: null,
    last_sync_at: null,
    created_by: 'admin-1',
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

type Auth = { userId: string; roles: string[]; permissions: string[] };

function context(
  options: {
    body?: unknown;
    bodyError?: boolean;
    id?: string;
    query?: Record<string, string | undefined>;
    auth?: Auth | null;
    env?: Record<string, unknown>;
  } = {}
) {
  const query = options.query ?? {};
  const auth =
    options.auth === undefined
      ? {
          userId: 'admin-1',
          roles: [],
          permissions: Object.values(ADMIN_PERMISSIONS),
        }
      : options.auth;
  return {
    get: vi.fn((name: string) => (name === 'adminAuth' ? auth : undefined)),
    req: {
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('invalid json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
      param: vi.fn((name: string) => (name === 'id' ? (options.id ?? 'domain-1') : undefined)),
      query: vi.fn((name: string) => query[name]),
    },
    env: {
      AUTHRIM_CONFIG: { delete: vi.fn() },
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY: { get: vi.fn() },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
      ...options.env,
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function queueRows(...rows: Array<unknown>) {
  for (const value of rows) mocks.adapter.queryOne.mockResolvedValueOnce(value);
}

function cfResponse(
  result: unknown,
  options: { ok?: boolean; success?: boolean; errors?: unknown } = {}
) {
  return new Response(
    JSON.stringify({ success: options.success ?? true, result, errors: options.errors }),
    { status: options.ok === false ? 400 : 200 }
  );
}

describe('tenant vanity domain administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.transaction.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.adapter.transaction.mockImplementation(async (callback) => callback(mocks.adapter));
    mocks.invalidateCache.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
    mocks.safeFetch.mockResolvedValue(cfResponse({}));
  });

  describe('authorization boundaries', () => {
    it.each([
      ['tenant list', listTenantVanityDomainsHandler],
      ['tenant create', createTenantVanityDomainHandler],
      ['tenant get', getTenantVanityDomainHandler],
      ['tenant update', updateTenantVanityDomainHandler],
      ['tenant primary', setPrimaryTenantVanityDomainHandler],
      ['tenant sync', syncTenantVanityDomainHandler],
      ['tenant verify', verifyTenantVanityDomainHandler],
      ['tenant delete', deleteTenantVanityDomainHandler],
    ])('denies %s without the required permission', async (_name, handler) => {
      const response = await handler(
        context({ auth: { userId: 'admin-1', roles: [], permissions: [] } })
      );
      expect(response.status).toBe(403);
      expect(mocks.adapter.queryOne).not.toHaveBeenCalled();
    });

    it.each([
      ['platform list', listPlatformTenantVanityDomainsHandler],
      ['platform create', createPlatformTenantVanityDomainHandler],
      ['platform get', getPlatformTenantVanityDomainHandler],
      ['platform primary', setPrimaryPlatformTenantVanityDomainHandler],
      ['platform sync', syncPlatformTenantVanityDomainHandler],
      ['platform verify', verifyPlatformTenantVanityDomainHandler],
      ['platform delete', deletePlatformTenantVanityDomainHandler],
    ])('denies %s to a tenant admin', async (_name, handler) => {
      const response = await handler(context());
      expect(response.status).toBe(403);
    });

    it.each([['system_admin'], ['super_admin']])(
      'accepts %s as platform authority',
      async (role) => {
        const response = await listPlatformTenantVanityDomainsHandler(
          context({ auth: { userId: 'system-1', roles: [role], permissions: [] } })
        );
        expect(response.status).toBe(200);
      }
    );
  });

  describe('listing and lookup', () => {
    it('formats tenant rows without exposing database flags', async () => {
      mocks.adapter.query.mockResolvedValueOnce([
        domain({
          is_primary: 1,
          validation_records_json: JSON.stringify({ txt: '_cf-custom-hostname' }),
        }),
      ]);
      const response = await listTenantVanityDomainsHandler(context());
      await expect(response.json()).resolves.toMatchObject({
        domains: [
          {
            hostname: 'login.example.com',
            is_active: true,
            is_primary: true,
            validation_records: { txt: '_cf-custom-hostname' },
          },
        ],
        cloudflare_configured: false,
      });
    });

    it('reports Cloudflare configured from token plus either zone binding', async () => {
      const response = await listTenantVanityDomainsHandler(
        context({ env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ZONE_ID: 'zone-1' } })
      );
      await expect(response.json()).resolves.toMatchObject({ cloudflare_configured: true });
    });

    it('gets only a domain in the request tenant', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(domain());
      const response = await getTenantVanityDomainHandler(context());
      expect(response.status).toBe(200);
      expect(mocks.adapter.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('tenant_id = ?'),
        ['domain-1', 'tenant-a']
      );
    });

    it('does not reveal a missing or cross-tenant domain', async () => {
      expect((await getTenantVanityDomainHandler(context())).status).toBe(404);
    });

    it('filters platform listing by optional tenant ID', async () => {
      const auth = { userId: 'system-1', roles: ['system_admin'], permissions: [] };
      await listPlatformTenantVanityDomainsHandler(
        context({ auth, query: { tenant_id: 'tenant-b' } })
      );
      expect(mocks.adapter.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE tenant_id = ?'),
        ['tenant-b']
      );

      await listPlatformTenantVanityDomainsHandler(context({ auth }));
      expect(mocks.adapter.query).toHaveBeenLastCalledWith(expect.any(String), []);
    });

    it('gets a platform domain without constraining it to the caller tenant', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(domain({ tenant_id: 'tenant-b' }));
      const response = await getPlatformTenantVanityDomainHandler(
        context({ auth: { userId: 'system-1', roles: ['super_admin'], permissions: [] } })
      );
      expect(response.status).toBe(200);
      expect(mocks.adapter.queryOne).toHaveBeenCalledWith(
        expect.not.stringContaining('tenant_id'),
        ['domain-1']
      );
    });
  });

  describe('creation', () => {
    it.each([
      [{}, false],
      [{ hostname: '' }, false],
      [{ hostname: 'not a host' }, false],
      [{ hostname: '-bad.example.com' }, false],
      [{ hostname: `${'a'.repeat(250)}.com` }, false],
    ])('rejects invalid tenant hostname input %#', async (body, _expected) => {
      expect((await createTenantVanityDomainHandler(context({ body }))).status).toBe(400);
    });

    it('normalizes case, whitespace, and trailing dot before persistence', async () => {
      queueRows({ id: 'tenant-a' }, null, domain());
      const response = await createTenantVanityDomainHandler(
        context({ body: { hostname: ' Login.Example.COM. ', is_primary: false } })
      );
      expect(response.status).toBe(201);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO tenant_vanity_domains'),
        expect.arrayContaining(['tenant-a', 'login.example.com', 'login.example.com'])
      );
    });

    it('rejects an inactive or missing tenant', async () => {
      const response = await createTenantVanityDomainHandler(
        context({ body: { hostname: 'login.example.com' } })
      );
      expect(response.status).toBe(404);
    });

    it('rejects a hostname already active for any tenant', async () => {
      queueRows({ id: 'tenant-a' }, { id: 'existing-domain' });
      const response = await createTenantVanityDomainHandler(
        context({ body: { hostname: 'login.example.com' } })
      );
      expect(response.status).toBe(400);
    });

    it('creates a manual domain when Cloudflare bindings are absent', async () => {
      queueRows({ id: 'tenant-a' }, null, domain());
      const response = await createTenantVanityDomainHandler(
        context({ body: { hostname: 'login.example.com' } })
      );
      await expect(response.json()).resolves.toMatchObject({
        cloudflare_configured: false,
        manual_setup_required: true,
        cloudflare_error: null,
      });
      expect(mocks.safeFetch).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.anything(),
        'tenant_vanity_domain.created',
        'tenant_vanity_domain',
        expect.any(String),
        expect.objectContaining({ tenant_id: 'tenant-a', status: 'pending_manual' })
      );
    });

    it('creates and immediately promotes an active Cloudflare hostname', async () => {
      const active = domain({
        status: 'active',
        cloudflare_zone_id: 'zone-override',
        cloudflare_custom_hostname_id: 'cf-host-1',
        ssl_status: 'active',
      });
      queueRows({ id: 'tenant-a' }, null, active, { ...active, is_primary: 1 });
      mocks.safeFetch.mockResolvedValueOnce(
        cfResponse({
          id: 'cf-host-1',
          hostname: 'login.example.com',
          status: 'active',
          ownership_verification: { type: 'txt' },
          ssl: { status: 'active', method: 'http', validation_records: [] },
        })
      );
      const response = await createTenantVanityDomainHandler(
        context({
          body: {
            hostname: 'login.example.com',
            cloudflare_zone_id: 'zone-override',
            is_primary: true,
          },
          env: { CLOUDFLARE_API_TOKEN: 'token' },
        })
      );
      expect(response.status).toBe(201);
      expect(mocks.adapter.transaction).toHaveBeenCalledOnce();
      expect(mocks.safeFetch).toHaveBeenCalledWith(
        expect.stringContaining('/zones/zone-override/custom_hostnames'),
        expect.objectContaining({ method: 'POST', requireHttps: true })
      );
    });

    it.each([
      [
        'API error body',
        cfResponse(null, { ok: false, success: false, errors: [{ message: 'bad zone' }] }),
      ],
      ['malformed body', new Response('{', { status: 200 })],
    ])('persists failed status and a safe diagnostic after %s', async (_name, apiResponse) => {
      queueRows({ id: 'tenant-a' }, null, domain({ status: 'failed' }));
      mocks.safeFetch.mockResolvedValueOnce(apiResponse);
      const response = await createTenantVanityDomainHandler(
        context({
          body: { hostname: 'login.example.com' },
          env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_ID: 'zone-1' },
        })
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { cloudflare_error: string };
      expect(body.cloudflare_error).toBeTruthy();
    });

    it('requires tenant_id on the platform create endpoint', async () => {
      const response = await createPlatformTenantVanityDomainHandler(
        context({
          body: { hostname: 'login.example.com' },
          auth: { userId: 'system-1', roles: ['system_admin'], permissions: [] },
        })
      );
      expect(response.status).toBe(400);
    });

    it('creates a platform-selected tenant domain', async () => {
      queueRows({ id: 'tenant-b' }, null, domain({ tenant_id: 'tenant-b' }));
      const response = await createPlatformTenantVanityDomainHandler(
        context({
          body: { tenant_id: 'tenant-b', hostname: 'login-b.example.com', is_primary: false },
          auth: { userId: 'system-1', roles: ['system_admin'], permissions: [] },
        })
      );
      expect(response.status).toBe(201);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['tenant-b', 'login-b.example.com'])
      );
    });
  });

  describe('activation and primary state', () => {
    it('rejects malformed activation updates and missing domains', async () => {
      expect(
        (await updateTenantVanityDomainHandler(context({ body: { is_active: 'true' } }))).status
      ).toBe(400);
      expect(
        (await updateTenantVanityDomainHandler(context({ body: { is_active: true } }))).status
      ).toBe(404);
    });

    it('blocks reactivation when another active row owns the hostname', async () => {
      queueRows(domain({ is_active: 0 }), { id: 'collision' });
      const response = await updateTenantVanityDomainHandler(
        context({ body: { is_active: true } })
      );
      expect(response.status).toBe(400);
    });

    it.each([
      [true, 1, 'login.example.com'],
      [false, 0, null],
    ])(
      'updates activation=%s and invalidates both cache keys',
      async (isActive, flag, hostname) => {
        const existing = domain({ is_active: isActive ? 0 : 1 });
        queueRows(existing, ...(isActive ? [null] : []), domain({ is_active: flag }));
        const response = await updateTenantVanityDomainHandler(
          context({ body: { is_active: isActive } })
        );
        expect(response.status).toBe(200);
        expect(mocks.adapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('active_hostname = ?'),
          expect.arrayContaining([flag, hostname])
        );
        expect(mocks.invalidateCache).toHaveBeenCalledWith(expect.anything(), {
          hostname: 'login.example.com',
          tenantId: 'tenant-a',
        });
      }
    );

    it('allows an empty activation patch without a database update', async () => {
      queueRows(domain(), domain());
      const response = await updateTenantVanityDomainHandler(context({ body: {} }));
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).not.toHaveBeenCalled();
    });

    it('promotes only an active domain in a transaction', async () => {
      queueRows(domain({ status: 'active', is_primary: 1 }));
      const response = await setPrimaryTenantVanityDomainHandler(context());
      expect(response.status).toBe(200);
      expect(mocks.adapter.transaction).toHaveBeenCalledOnce();
      expect(mocks.adapter.execute).toHaveBeenCalledTimes(2);
    });

    it.each([[null], [domain({ is_primary: 0 })]])(
      'refuses primary promotion when final state is not canonical %#',
      async (updated) => {
        queueRows(updated);
        expect((await setPrimaryTenantVanityDomainHandler(context())).status).toBe(400);
      }
    );

    it('uses the selected domain tenant for platform primary promotion', async () => {
      queueRows(
        domain({ tenant_id: 'tenant-b' }),
        domain({ tenant_id: 'tenant-b', is_primary: 1 })
      );
      const response = await setPrimaryPlatformTenantVanityDomainHandler(
        context({ auth: { userId: 'system-1', roles: ['system_admin'], permissions: [] } })
      );
      expect(response.status).toBe(200);
    });
  });

  describe('sync, verify, and delete', () => {
    it('returns not_found or manual status without calling Cloudflare', async () => {
      expect((await syncTenantVanityDomainHandler(context())).status).toBe(404);
      mocks.adapter.queryOne.mockResolvedValueOnce(domain());
      const response = await syncTenantVanityDomainHandler(context());
      await expect(response.json()).resolves.toMatchObject({ cloudflare_configured: false });
      expect(mocks.safeFetch).not.toHaveBeenCalled();
    });

    it.each([
      ['pending', 'pending', 'pending'],
      ['active', 'active', 'active'],
    ])(
      'syncs Cloudflare hostname status=%s ssl=%s to %s',
      async (cfStatus, sslStatus, expected) => {
        const existing = domain({
          cloudflare_zone_id: 'zone-1',
          cloudflare_custom_hostname_id: 'cf-host-1',
        });
        queueRows(existing, domain({ ...existing, status: expected }));
        mocks.safeFetch.mockResolvedValueOnce(
          cfResponse({
            id: 'cf-host-1',
            hostname: existing.hostname,
            status: cfStatus,
            ssl: { status: sslStatus, method: 'txt', validation_records: [{ txt_name: '_cf' }] },
          })
        );
        const response = await syncTenantVanityDomainHandler(
          context({ env: { CLOUDFLARE_API_TOKEN: 'token' } })
        );
        expect(response.status).toBe(200);
        expect(mocks.adapter.execute).toHaveBeenCalledWith(
          expect.stringContaining('SET status = ?'),
          expect.arrayContaining([expected, sslStatus, cfStatus, 'txt'])
        );
      }
    );

    it('returns internal error without leaking unknown Cloudflare failures', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(
        domain({ cloudflare_zone_id: 'zone-1', cloudflare_custom_hostname_id: 'cf-host-1' })
      );
      mocks.safeFetch.mockRejectedValueOnce('network failed');
      expect(
        (await syncTenantVanityDomainHandler(context({ env: { CLOUDFLARE_API_TOKEN: 'token' } })))
          .status
      ).toBe(500);
    });

    it('manually verifies an unmanaged domain and invalidates routing cache', async () => {
      queueRows(domain(), domain({ status: 'active', ssl_status: 'active' }));
      const response = await verifyTenantVanityDomainHandler(context());
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining("validation_method = 'manual'"),
        expect.arrayContaining(['domain-1', 'tenant-a'])
      );
    });

    it('delegates managed verification to Cloudflare sync', async () => {
      const existing = domain({
        cloudflare_zone_id: 'zone-1',
        cloudflare_custom_hostname_id: 'cf-host-1',
      });
      queueRows(existing, existing, existing);
      mocks.safeFetch.mockResolvedValueOnce(
        cfResponse({ id: 'cf-host-1', hostname: existing.hostname, status: 'pending', ssl: {} })
      );
      expect(
        (await verifyTenantVanityDomainHandler(context({ env: { CLOUDFLARE_API_TOKEN: 'token' } })))
          .status
      ).toBe(200);
    });

    it('soft-deletes locally even when Cloudflare deletion fails', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(
        domain({ cloudflare_zone_id: 'zone-1', cloudflare_custom_hostname_id: 'cf-host-1' })
      );
      mocks.safeFetch.mockRejectedValueOnce(new Error('Cloudflare unavailable'));
      const response = await deleteTenantVanityDomainHandler(
        context({ env: { CLOUDFLARE_API_TOKEN: 'token' } })
      );
      expect(response.status).toBe(200);
      expect(mocks.adapter.execute).toHaveBeenCalledWith(
        expect.stringContaining("status = 'deleted'"),
        expect.arrayContaining(['domain-1', 'tenant-a'])
      );
    });

    it('does not call Cloudflare for a local-only delete', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(domain());
      expect((await deleteTenantVanityDomainHandler(context())).status).toBe(200);
      expect(mocks.safeFetch).not.toHaveBeenCalled();
    });

    it('covers platform manual verification and deletion using the row tenant', async () => {
      const auth = { userId: 'system-1', roles: ['system_admin'], permissions: [] };
      queueRows(
        domain({ tenant_id: 'tenant-b' }),
        domain({ tenant_id: 'tenant-b', status: 'active' })
      );
      expect((await verifyPlatformTenantVanityDomainHandler(context({ auth }))).status).toBe(200);

      mocks.adapter.queryOne.mockResolvedValueOnce(domain({ tenant_id: 'tenant-b' }));
      expect((await deletePlatformTenantVanityDomainHandler(context({ auth }))).status).toBe(200);
      expect(mocks.invalidateCache).toHaveBeenLastCalledWith(expect.anything(), {
        hostname: 'login.example.com',
        tenantId: 'tenant-b',
      });
    });

    it('covers platform Cloudflare sync and API failure paths', async () => {
      const auth = { userId: 'system-1', roles: ['super_admin'], permissions: [] };
      const existing = domain({
        tenant_id: 'tenant-b',
        cloudflare_zone_id: 'zone-1',
        cloudflare_custom_hostname_id: 'cf-host-1',
      });
      queueRows(existing, existing);
      mocks.safeFetch.mockResolvedValueOnce(
        cfResponse({
          id: 'cf-host-1',
          hostname: existing.hostname,
          status: 'active',
          ssl: { status: 'active' },
        })
      );
      expect(
        (
          await syncPlatformTenantVanityDomainHandler(
            context({ auth, env: { CLOUDFLARE_API_TOKEN: 'token' } })
          )
        ).status
      ).toBe(200);

      mocks.adapter.queryOne.mockResolvedValueOnce(existing);
      mocks.safeFetch.mockRejectedValueOnce(new Error('network failure'));
      expect(
        (
          await syncPlatformTenantVanityDomainHandler(
            context({ auth, env: { CLOUDFLARE_API_TOKEN: 'token' } })
          )
        ).status
      ).toBe(500);
    });

    it.each([
      [syncPlatformTenantVanityDomainHandler],
      [verifyPlatformTenantVanityDomainHandler],
      [deletePlatformTenantVanityDomainHandler],
      [setPrimaryPlatformTenantVanityDomainHandler],
    ])('returns not_found for missing platform domain %#', async (handler) => {
      const response = await handler(
        context({ auth: { userId: 'system-1', roles: ['system_admin'], permissions: [] } })
      );
      expect(response.status).toBe(404);
    });
  });
});
