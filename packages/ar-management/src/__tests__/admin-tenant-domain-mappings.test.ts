import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  adapterResolver: vi.fn(),
  audit: vi.fn(),
  hashConfig: vi.fn(),
  hash: vi.fn(),
  token: vi.fn(),
  expired: vi.fn(),
  dns: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveOptionalCoreAdapterFromHono: mocks.adapterResolver,
    createAuditLogFromContext: mocks.audit,
    getEmailDomainHashConfig: mocks.hashConfig,
    generateEmailDomainHashWithVersion: mocks.hash,
    generateVerificationToken: mocks.token,
    calculateVerificationExpiry: vi.fn(() => 1_800_000_000),
    isVerificationExpired: mocks.expired,
    verifyDomainDnsTxt: mocks.dns,
    getVerificationRecordName: vi.fn((domain) => `_authrim-verification.${domain}`),
    getExpectedRecordValue: vi.fn((token) => `authrim-verification=${token}`),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    createErrorResponse: vi.fn((c, code, options) => {
      const status =
        code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
          ? 404
          : code === actual.AR_ERROR_CODES.INTERNAL_ERROR
            ? 500
            : 400;
      return c.json({ error: code, ...options }, status);
    }),
  };
});

import {
  confirmTenantDomainVerificationHandler,
  createTenantDomainMappingHandler,
  deleteTenantDomainMappingHandler,
  getTenantDomainMappingHandler,
  initiateTenantDomainVerificationHandler,
  listTenantDomainMappingsHandler,
  updateTenantDomainMappingHandler,
} from '../admin-tenant-domain-mappings';

function context(
  options: { query?: Record<string, string>; id?: string; body?: unknown; adminId?: string } = {}
) {
  return {
    get: vi.fn((name: string) =>
      name === 'adminAuth' && options.adminId ? { adminId: options.adminId } : undefined
    ),
    req: {
      query: vi.fn((name: string) => options.query?.[name]),
      param: vi.fn(() => options.id ?? 'mapping-1'),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mapping-1',
    domain_hash: 'hash',
    hash_version: 2,
    tenant_id: 'tenant-a',
    priority: 10,
    is_active: 1,
    verified: 0,
    verification_token: null,
    verification_expires_at: null,
    created_by: null,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

describe('tenant domain mappings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.expired.mockReset();
    mocks.dns.mockReset();
    mocks.adapterResolver.mockReturnValue(mocks.adapter);
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.audit.mockResolvedValue(undefined);
    mocks.hashConfig.mockResolvedValue({ currentVersion: 2 });
    mocks.hash.mockResolvedValue({ hash: 'hash', version: 2 });
    mocks.token.mockResolvedValue('verification-token');
    mocks.expired.mockReturnValue(false);
    mocks.dns.mockResolvedValue(false);
  });

  it.each([
    [{}, [50, 0]],
    [
      { tenant_id: 'tenant-a', verified: 'true', limit: '500', offset: '10' },
      ['tenant-a', 1, 100, 10],
    ],
    [{ verified: 'false' }, [0, 50, 0]],
  ])('lists mappings with allowlisted filters %#', async (query, expectedParams) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ count: 1 });
    mocks.adapter.query.mockResolvedValueOnce([mapping()]);
    const body = (await (await listTenantDomainMappingsHandler(context({ query }))).json()) as {
      mappings: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.mappings[0]).toMatchObject({ is_active: true, verified: false });
    expect(body.mappings[0]).not.toHaveProperty('domain_hash');
    expect(mocks.adapter.query).toHaveBeenCalledWith(expect.any(String), expectedParams);
  });

  it('defaults a missing list count and handles missing adapter', async () => {
    await expect((await listTenantDomainMappingsHandler(context())).json()).resolves.toMatchObject({
      total: 0,
    });
    mocks.adapterResolver.mockReturnValueOnce(null);
    expect((await listTenantDomainMappingsHandler(context())).status).toBe(500);
  });

  it.each([
    [{}],
    [{ domain: '', tenant_id: 'tenant-a' }],
    [{ domain: 'example.com', tenant_id: '', priority: 0 }],
    [{ domain: 'example.com', tenant_id: 'tenant-a', priority: 1.5 }],
  ])('rejects malformed create input %#', async (body) => {
    expect((await createTenantDomainMappingHandler(context({ body }))).status).toBe(400);
  });

  it.each(['localhost', '-bad.example', `${'a'.repeat(250)}.com`])(
    'rejects invalid domain %s',
    async (domain) => {
      expect(
        (
          await createTenantDomainMappingHandler(
            context({ body: { domain, tenant_id: 'tenant-a' } })
          )
        ).status
      ).toBe(400);
    }
  );

  it('requires the target tenant to exist', async () => {
    expect(
      (
        await createTenantDomainMappingHandler(
          context({ body: { domain: 'example.com', tenant_id: 'missing' } })
        )
      ).status
    ).toBe(404);
  });

  it('rejects an active duplicate without exposing its hash', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce({ id: 'tenant-a' })
      .mockResolvedValueOnce({ id: 'existing' });
    expect(
      (
        await createTenantDomainMappingHandler(
          context({ body: { domain: 'Example.COM', tenant_id: 'tenant-a' } })
        )
      ).status
    ).toBe(400);
    expect(mocks.hash).toHaveBeenCalledWith('user@example.com', expect.anything());
  });

  it.each([true, false])('creates an active=%s mapping and audits it', async (is_active) => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce({ id: 'tenant-a' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mapping({ is_active: is_active ? 1 : 0, verified: 1 }));
    const response = await createTenantDomainMappingHandler(
      context({
        adminId: 'admin-1',
        body: {
          domain: 'Example.COM',
          tenant_id: 'tenant-a',
          priority: 7,
          is_active,
          verified: true,
        },
      })
    );
    expect(response.status).toBe(201);
    const insert = mocks.adapter.execute.mock.calls[0][1] as unknown[];
    expect(insert[6]).toBe(is_active ? 'hash' : null);
    expect(insert[8]).toBe('admin-1');
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('uses null created_by and handles create persistence failure', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'tenant-a' }).mockResolvedValueOnce(null);
    mocks.adapter.execute.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await createTenantDomainMappingHandler(
          context({ body: { domain: 'example.com', tenant_id: 'tenant-a' } })
        )
      ).status
    ).toBe(500);
  });

  it.each([null, mapping()])('gets mapping result %#', async (row) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(row);
    const response = await getTenantDomainMappingHandler(context());
    expect(response.status).toBe(row ? 200 : 404);
  });

  it('handles get failures', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await getTenantDomainMappingHandler(context())).status).toBe(500);
  });

  it('validates update input and missing mappings', async () => {
    expect(
      (await updateTenantDomainMappingHandler(context({ body: { priority: -1 } }))).status
    ).toBe(400);
    expect((await updateTenantDomainMappingHandler(context({ body: {} }))).status).toBe(404);
  });

  it('returns the unchanged row for an empty update', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(mapping());
    expect((await updateTenantDomainMappingHandler(context({ body: {} }))).status).toBe(200);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('rejects reactivation when another active mapping owns the domain', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce(mapping({ is_active: 0 }))
      .mockResolvedValueOnce({ id: 'other' });
    expect(
      (await updateTenantDomainMappingHandler(context({ body: { is_active: true } }))).status
    ).toBe(400);
  });

  it.each([
    [{ priority: 20 }, true],
    [{ is_active: false }, false],
    [{ is_active: true, priority: 20 }, true],
  ])('updates supported fields %#', async (body, resultingActive) => {
    const activates = 'is_active' in body && body.is_active === true;
    mocks.adapter.queryOne.mockResolvedValueOnce(mapping({ is_active: activates ? 0 : 1 }));
    if (activates) {
      mocks.adapter.queryOne.mockResolvedValueOnce(null);
    }
    mocks.adapter.queryOne.mockResolvedValueOnce(
      mapping({ priority: 20, is_active: resultingActive ? 1 : 0 })
    );
    const response = await updateTenantDomainMappingHandler(context({ body }));
    expect(response.status).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('handles update failures', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await updateTenantDomainMappingHandler(context({ body: {} }))).status).toBe(500);
  });

  it.each([null, { id: 'mapping-1' }])('deletes mapping result %#', async (row) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(row);
    const response = await deleteTenantDomainMappingHandler(context());
    expect(response.status).toBe(row ? 200 : 404);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(row ? 1 : 0);
    expect(mocks.audit).toHaveBeenCalledTimes(row ? 1 : 0);
  });

  it('handles delete failures', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await deleteTenantDomainMappingHandler(context())).status).toBe(500);
  });

  it('validates initiation and missing mappings', async () => {
    expect((await initiateTenantDomainVerificationHandler(context({ body: {} }))).status).toBe(400);
    expect(
      (
        await initiateTenantDomainVerificationHandler(
          context({ body: { id: 'missing', domain: 'example.com' } })
        )
      ).status
    ).toBe(404);
  });

  it('initiates DNS verification with a normalized record', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(mapping());
    const body = (await (
      await initiateTenantDomainVerificationHandler(
        context({ body: { id: 'mapping-1', domain: ' Example.COM ' } })
      )
    ).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      dns_record_name: '_authrim-verification.example.com',
      dns_record_value: 'authrim-verification=verification-token',
      expires_at: 1_800_000_000,
    });
    expect(mocks.adapter.execute).toHaveBeenCalled();
  });

  it('handles initiation failures', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await initiateTenantDomainVerificationHandler(
          context({ body: { id: 'mapping-1', domain: 'example.com' } })
        )
      ).status
    ).toBe(500);
  });

  it.each([
    [{}, null, false, false],
    [{ id: 'missing', domain: 'example.com' }, null, false, false],
    [{ id: 'mapping-1', domain: 'example.com' }, mapping(), false, false],
    [
      { id: 'mapping-1', domain: 'example.com' },
      mapping({ verification_token: 'token' }),
      true,
      false,
    ],
    [
      { id: 'mapping-1', domain: 'example.com' },
      mapping({ verification_token: 'token' }),
      false,
      false,
    ],
  ])('rejects invalid confirmation state %#', async (body, row, expired, dns) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(row);
    mocks.expired.mockReturnValueOnce(expired);
    mocks.dns.mockResolvedValueOnce(dns);
    expect((await confirmTenantDomainVerificationHandler(context({ body }))).status).not.toBe(200);
  });

  it('confirms DNS ownership, clears the token, and audits the domain', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce(mapping({ verification_token: 'token', verification_expires_at: 200 }))
      .mockResolvedValueOnce(mapping({ verified: 1 }));
    mocks.dns.mockResolvedValueOnce(true);
    const response = await confirmTenantDomainVerificationHandler(
      context({ body: { id: 'mapping-1', domain: ' Example.COM ' } })
    );
    expect(response.status).toBe(200);
    expect(mocks.dns).toHaveBeenCalledWith('example.com', 'token');
    expect(mocks.adapter.execute).toHaveBeenCalledWith(expect.stringContaining('verified = 1'), [
      expect.any(Number),
      'mapping-1',
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'tenant_domain_mapping.verified',
      'tenant_domain_mapping',
      'mapping-1',
      { domain: 'example.com' }
    );
  });

  it('handles confirmation failures', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await confirmTenantDomainVerificationHandler(
          context({ body: { id: 'mapping-1', domain: 'example.com' } })
        )
      ).status
    ).toBe(500);
  });
});
