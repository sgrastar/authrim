/**
 * zod 3 -> 4 migration pins for admin-tenant-vanity-domains.ts
 * (CreateSchema incl. `.omit({ tenant_id: true })`, UpdateSchema).
 *
 * The REAL `createErrorResponse` is used. Validation failures here carry no `variables`, so the
 * only observable output of the schemas is pass/fail plus what flows into the persisted row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
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
    invalidateTenantVanityDomainCache: vi.fn(async () => undefined),
    createAuditLogFromContext: vi.fn(async () => undefined),
    safeFetch: vi.fn(),
    readResponseTextWithLimit: vi.fn((response: Response) => response.text()),
    getLogger: vi.fn(() => ({ module: vi.fn(() => ({ error: vi.fn() })) })),
  };
});

vi.mock('../../tenant-alias-directory', () => ({
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
  updateTenantVanityDomainHandler,
} from '../../admin-tenant-vanity-domains';

const INVALID_VALUE_BODY = {
  error: 'invalid_request',
  error_description: 'The provided value is invalid.',
  error_code: 'AR130003',
};

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

function context(body: unknown, asSystemAdmin = false, bodyError = false) {
  const auth = asSystemAdmin
    ? {
        userId: 'system-1',
        roles: ['system_admin'],
        permissions: [],
        globalRoles: ['system_admin'],
        tenantScope: ['*'],
      }
    : {
        userId: 'admin-1',
        roles: [],
        permissions: Object.values(ADMIN_PERMISSIONS),
        globalRoles: [],
        tenantScope: ['tenant-a'],
      };
  return {
    get: vi.fn((name: string) => (name === 'adminAuth' ? auth : undefined)),
    req: {
      path: '/api/admin/tenant-vanity-domains',
      header: vi.fn(() => undefined),
      json: bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('invalid json'))
        : vi.fn().mockResolvedValue(body),
      param: vi.fn((name: string) => (name === 'id' ? 'domain-1' : undefined)),
      query: vi.fn(() => undefined),
    },
    env: {
      AUTHRIM_CONFIG: { delete: vi.fn() },
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      TENANT_RUNTIME_REGISTRY: { get: vi.fn() },
      TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{"keys":[]}',
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

async function run(handler: (c: never) => Promise<Response>, c: never) {
  const response = await handler(c);
  return { status: response.status, body: await response.json() };
}

const REJECTED = { status: 400, body: INVALID_VALUE_BODY };

function queueRows(...rows: Array<unknown>) {
  for (const value of rows) mocks.adapter.queryOne.mockResolvedValueOnce(value);
}

describe('zod pins: vanity domains CreateSchema', () => {
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
  });

  const createTenant = (body: unknown, bodyError = false) =>
    run(createTenantVanityDomainHandler, context(body, false, bodyError));
  const createPlatform = (body: unknown) =>
    run(createPlatformTenantVanityDomainHandler, context(body, true));

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'login.example.com'],
    ['empty object', {}],
    ['hostname missing', { is_primary: true }],
    ['hostname empty', { hostname: '' }],
    ['hostname number', { hostname: 5 }],
    ['hostname null', { hostname: null }],
    ['hostname 254 chars', { hostname: 'a'.repeat(254) }],
    ['is_primary string', { hostname: 'login.example.com', is_primary: 'true' }],
    ['is_primary null', { hostname: 'login.example.com', is_primary: null }],
    ['is_primary number', { hostname: 'login.example.com', is_primary: 1 }],
    ['zone id empty', { hostname: 'login.example.com', cloudflare_zone_id: '' }],
    ['zone id number', { hostname: 'login.example.com', cloudflare_zone_id: 12 }],
    ['zone id null', { hostname: 'login.example.com', cloudflare_zone_id: null }],
  ])('tenant create rejects at schema level: %s', async (_name, body) => {
    expect(await createTenant(body)).toEqual(REJECTED);
  });

  it('tenant create: malformed JSON becomes a null body and is rejected', async () => {
    expect(await createTenant(undefined, true)).toEqual(REJECTED);
  });

  it('tenant create: whitespace-only hostname passes zod min(1) but is rejected by the hand-written check (same body)', async () => {
    expect(await createTenant({ hostname: '   ' })).toEqual(REJECTED);
  });

  it('tenant create: tenant_id is dropped by .omit() and never used (context tenant wins)', async () => {
    queueRows({ id: 'tenant-a' }, null, domain());
    const result = await createTenant({
      hostname: 'Login.Example.COM.',
      tenant_id: 'tenant-evil',
      surplus: 1,
    });
    expect(result.status).toBe(201);
    const insert = mocks.adapter.execute.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO tenant_vanity_domains')
    );
    // [id, tenant_id, hostname, active_hostname, primary_key, status, zone, ...]
    expect((insert?.[1] as unknown[]).slice(1, 4)).toEqual([
      'tenant-a',
      'login.example.com',
      'login.example.com',
    ]);
  });

  it('is_primary defaults to true: an already-active row is promoted via a transaction', async () => {
    queueRows(
      { id: 'tenant-a' },
      null,
      domain({ status: 'active' }),
      domain({ status: 'active', is_primary: 1 })
    );
    const result = await createTenant({ hostname: 'login.example.com' });
    expect(result.status).toBe(201);
    expect(mocks.adapter.transaction).toHaveBeenCalledTimes(1);
  });

  it('explicit is_primary=false is not promoted', async () => {
    queueRows({ id: 'tenant-a' }, null, domain({ status: 'active' }));
    const result = await createTenant({ hostname: 'login.example.com', is_primary: false });
    expect(result.status).toBe(201);
    expect(mocks.adapter.transaction).not.toHaveBeenCalled();
  });

  it('cloudflare_zone_id is carried to the persisted row', async () => {
    queueRows({ id: 'tenant-a' }, null, domain());
    await createTenant({ hostname: 'login.example.com', cloudflare_zone_id: 'zone-123' });
    const insert = mocks.adapter.execute.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO tenant_vanity_domains')
    );
    expect((insert?.[1] as unknown[])[6]).toBe('zone-123');
  });

  it.each([
    ['missing tenant_id', { hostname: 'login.example.com' }],
    ['empty tenant_id', { hostname: 'login.example.com', tenant_id: '' }],
    ['tenant_id too long', { hostname: 'login.example.com', tenant_id: 't'.repeat(64) }],
    ['tenant_id number', { hostname: 'login.example.com', tenant_id: 7 }],
    ['tenant_id null', { hostname: 'login.example.com', tenant_id: null }],
    ['hostname missing', { tenant_id: 'tenant-b' }],
    ['null body', null],
  ])('platform create rejects: %s', async (_name, body) => {
    expect(await createPlatform(body)).toEqual(REJECTED);
  });

  it('platform create accepts tenant_id (63 chars) and persists it', async () => {
    const tenantId = 't'.repeat(63);
    queueRows({ id: tenantId }, null, domain({ tenant_id: tenantId }));
    const result = await createPlatform({
      hostname: 'login-b.example.com',
      tenant_id: tenantId,
      is_primary: false,
    });
    expect(result.status).toBe(201);
    const insert = mocks.adapter.execute.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO tenant_vanity_domains')
    );
    expect((insert?.[1] as unknown[]).slice(1, 3)).toEqual([tenantId, 'login-b.example.com']);
  });
});

describe('zod pins: vanity domains UpdateSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  });

  const update = (body: unknown, bodyError = false) =>
    run(updateTenantVanityDomainHandler, context(body, false, bodyError));

  it.each([
    ['null', null],
    ['array', []],
    ['number', 3],
    ['is_active string', { is_active: 'true' }],
    ['is_active number', { is_active: 1 }],
    ['is_active null', { is_active: null }],
  ])('rejects: %s', async (_name, body) => {
    expect(await update(body)).toEqual(REJECTED);
  });

  it('malformed JSON is treated as null and rejected', async () => {
    expect(await update(undefined, true)).toEqual(REJECTED);
  });

  it('passes validation for {} / unknown keys (then 404 from the missing row)', async () => {
    expect(await update({})).toMatchObject({ status: 404 });
    expect(await update({ unknown: 1 })).toMatchObject({ status: 404 });
    expect(await update({ is_active: true })).toMatchObject({ status: 404 });
  });

  it('empty object parses to no changes: existing row is returned without UPDATE', async () => {
    queueRows(domain(), domain());
    const result = await update({ extra: 'dropped' });
    expect(result.status).toBe(200);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });
});
