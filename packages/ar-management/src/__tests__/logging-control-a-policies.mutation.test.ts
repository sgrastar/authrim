/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- admin API response bodies and hono/vi fakes are untyped in these route tests */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditWrite = vi.hoisted(() => vi.fn(async () => 'audit_1'));
vi.mock('../admin-shared', async (original) => ({
  ...(await original<typeof import('../admin-shared')>()),
  writeAdminAuditLog: auditWrite,
}));

const stepUp = vi.hoisted(() => vi.fn(async (..._args: any[]): Promise<Response | null> => null));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: stepUp,
  refuseAdminFreshAuth: vi.fn(async () => null),
}));

const mockAdapter = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  batch: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_CONFLICT]: 409,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    requireAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
    getTenantIdFromContext: vi.fn((c: { get: (key: string) => unknown }) => c.get('tenantId')),
    createErrorResponse: vi.fn(
      (
        c: { json: (body: unknown, status?: number) => Response },
        errorCode: string,
        options?: { extensions?: Record<string, unknown> }
      ) =>
        c.json({ error: errorCode, ...(options?.extensions ?? {}) }, statusByCode[errorCode] ?? 500)
    ),
  };
});

import { ADMIN_PERMISSIONS, AR_ERROR_CODES } from '@authrim/ar-lib-core';
import { createApp, destinationRow, resetAdapter, routeSql } from './logging-control-a-harness';
import { must } from './helpers/must';

const P = ADMIN_PERMISSIONS;
const BASE = '/api/admin/logging-policies';
type Body = Record<string, any>;

async function call(
  perms: string[],
  method: string,
  path: string,
  body?: unknown,
  opts: { platform?: boolean; tenantId?: string } = {}
) {
  const res = await createApp(perms, {
    platform: opts.platform ?? false,
    tenantId: opts.tenantId,
  }).request(
    `${BASE}${path}`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { DB_ADMIN: {} }
  );
  return { status: res.status, body: await res.json<Body>(), headers: res.headers };
}

/** Destination lookups and the storage assignment probe. */
function world(
  destination: Record<string, unknown> | null,
  opts: { assigned?: boolean; existingFallback?: unknown } = {}
) {
  routeSql(mockAdapter, {
    one: [
      {
        match: /FROM storage_destination_assignments/,
        result: opts.assigned === false ? null : { id: 'sda_1' },
      },
      { match: /FROM logging_fallback_policies/, result: opts.existingFallback ?? null },
      { match: /FROM admin_destinations/, result: destination },
    ],
  });
}

const healthy = (extra: Record<string, unknown> = {}) =>
  destinationRow({ health_status: 'healthy', ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  resetAdapter(mockAdapter);
  stepUp.mockReset().mockResolvedValue(null);
  auditWrite.mockReset().mockResolvedValue('audit_1');
});

describe('GET / and /matrix', () => {
  const READ = P.LOGGING_OVERVIEW_READ;

  it.each(['', '/matrix'])(
    'answers on %s for any of the three read permissions',
    async (suffix) => {
      for (const perm of [
        P.LOGGING_OVERVIEW_READ,
        P.LOGGING_PLATFORM_DEFAULTS_READ,
        P.LOGGING_TENANT_OVERRIDES_READ,
      ]) {
        expect((await call([perm], 'GET', suffix)).status).toBe(200);
      }
      const denied = await call([], 'GET', suffix);
      expect(denied.status).toBe(403);
    }
  );

  it('scopes tenant admins to their own tenant and rejects other tenant ids', async () => {
    const own = await call([READ], 'GET', '/matrix?tenant_id=tenant-a');
    expect(own.status).toBe(200);
    expect(own.body.item.tenant_id).toBe('tenant-a');
    const other = await call([READ], 'GET', '/matrix?tenant_id=tenant-b');
    expect(other.status).toBe(403);
    expect(other.body.details.permission).toEqual({
      required_scope: 'current_tenant',
      reason: 'tenant_scope_mismatch',
    });
    const implicit = await call([READ], 'GET', '/matrix', undefined, { tenantId: 'tenant-q' });
    expect(implicit.body.item.tenant_id).toBe('tenant-q');
  });

  it('lets platform admins pick a tenant or fall back to the context tenant', async () => {
    const picked = await call([READ], 'GET', '/matrix?tenant_id=tenant-z', undefined, {
      platform: true,
    });
    expect(picked.body.item.tenant_id).toBe('tenant-z');
    const fallback = await call([READ], 'GET', '/matrix', undefined, {
      platform: true,
      tenantId: 'ctx',
    });
    expect(fallback.body.item.tenant_id).toBe('ctx');
  });

  it('queries the three tables with limits and exposes the newest snapshot version as ETag', async () => {
    routeSql(mockAdapter, {
      many: [
        { match: /FROM logging_destination_overrides/, result: [{ id: 'a1' }] },
        { match: /FROM logging_fallback_policies/, result: [{ id: 'f1' }] },
        {
          match: /FROM logging_policy_snapshots/,
          result: [{ version: 3 }, { version: '7' }, { version: 5 }],
        },
      ],
    });
    const res = await call([READ], 'GET', '/matrix?limit=500');
    expect(res.body.item).toMatchObject({
      tenant_id: 'tenant-a',
      version: 7,
      assignments: [{ id: 'a1' }],
      fallbacks: [{ id: 'f1' }],
      snapshots: [{ version: 3 }, { version: '7' }, { version: 5 }],
    });
    expect(res.headers.get('etag')).toBe('"v7"');
    const calls = mockAdapter.query.mock.calls;
    expect(calls[0][1]).toEqual(['tenant-a', 200]);
    expect(calls[1][1]).toEqual(['tenant-a', 200]);
    expect(calls[2][1]).toEqual(['tenant-a', 25]);
  });

  it('omits the ETag without snapshots and maps failures to 500', async () => {
    const res = await call([READ], 'GET', '/matrix?limit=3');
    expect(res.body.item.version).toBe(0);
    expect(res.headers.get('etag')).toBeNull();
    expect(mockAdapter.query.mock.calls[2][1]).toEqual(['tenant-a', 3]);
    mockAdapter.query.mockRejectedValue(new Error('db'));
    expect((await call([READ], 'GET', '/matrix')).status).toBe(500);
  });
});

describe('POST /assignments: body validation', () => {
  it('lists every missing field', async () => {
    const res = await call(
      [P.LOGGING_PLATFORM_DEFAULTS_UPDATE],
      'POST',
      '/assignments',
      {},
      { platform: true }
    );
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual([
      { path: 'log_type', code: 'invalid_value', message: 'Log type is not supported.' },
      { path: 'plane', code: 'invalid_value', message: 'Log plane is not supported.' },
      { path: 'destination_id', code: 'required', message: 'Destination id is required.' },
    ]);
  });

  it('rejects unknown log types and planes individually', async () => {
    const a = await call(
      [P.LOGGING_PLATFORM_DEFAULTS_UPDATE],
      'POST',
      '/assignments',
      {
        log_type: 'bogus',
        plane: 'primary',
        destination_id: 'd',
      },
      { platform: true }
    );
    expect(a.body.details.fields).toHaveLength(1);
    expect(a.body.details.fields[0].path).toBe('log_type');
    const b = await call(
      [P.LOGGING_PLATFORM_DEFAULTS_UPDATE],
      'POST',
      '/assignments',
      {
        log_type: 'normal',
        plane: 'nope',
        destination_id: 'd',
      },
      { platform: true }
    );
    expect(b.body.details.fields).toEqual([
      { path: 'plane', code: 'invalid_value', message: 'Log plane is not supported.' },
    ]);
  });
});

describe('policy mutation permission rules', () => {
  const body = (extra: Record<string, unknown> = {}) => ({
    log_type: 'diagnostic',
    plane: 'external_sink',
    destination_id: 'dest_1',
    ...extra,
  });
  const forbidden = (res: { status: number; body: Body }) => {
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
    expect(mockAdapter.execute).not.toHaveBeenCalled();
    mockAdapter.execute.mockClear();
  };

  it('requires the tenant-override permission for tenant policies', async () => {
    world(healthy());
    forbidden(
      await call(
        [P.LOGGING_PLATFORM_DEFAULTS_UPDATE],
        'POST',
        '/assignments',
        body({ tenant_id: 'tenant-a' })
      )
    );
  });

  it('requires the platform-default permission and platform authority for platform policies', async () => {
    world(healthy());
    forbidden(
      await call([P.LOGGING_TENANT_OVERRIDES_UPDATE], 'POST', '/assignments', body(), {
        platform: true,
      })
    );
    forbidden(await call([P.LOGGING_PLATFORM_DEFAULTS_UPDATE], 'POST', '/assignments', body()));
  });

  it("refuses a tenant admin editing another tenant's policy but allows platform admins", async () => {
    world(healthy());
    forbidden(
      await call(
        [P.LOGGING_TENANT_OVERRIDES_UPDATE],
        'POST',
        '/assignments',
        body({ tenant_id: 'tenant-b' })
      )
    );
    const ok = await call(
      [P.LOGGING_TENANT_OVERRIDES_UPDATE],
      'POST',
      '/assignments',
      body({ tenant_id: 'tenant-b' }),
      { platform: true }
    );
    expect(ok.status).toBe(201);
  });

  it('keeps critical and non-configurable log types away from tenants', async () => {
    world(healthy({ critical_allowed: 1 }));
    forbidden(
      await call(
        [P.LOGGING_TENANT_OVERRIDES_UPDATE, P.LOGGING_CRITICAL_UPDATE],
        'POST',
        '/assignments',
        body({ tenant_id: 'tenant-a', log_type: 'audit', plane: 'archive' })
      )
    );
    forbidden(
      await call(
        [P.LOGGING_TENANT_OVERRIDES_UPDATE],
        'POST',
        '/assignments',
        body({ tenant_id: 'tenant-a', log_type: 'normal' })
      )
    );
    for (const logType of ['diagnostic', 'webhook', 'job']) {
      const res = await call(
        [P.LOGGING_TENANT_OVERRIDES_UPDATE],
        'POST',
        '/assignments',
        body({ tenant_id: 'tenant-a', log_type: logType })
      );
      expect(res.status).toBe(201);
      mockAdapter.execute.mockClear();
    }
    // sensitive_detail plane is critical regardless of the log type
    forbidden(
      await call(
        [P.LOGGING_TENANT_OVERRIDES_UPDATE],
        'POST',
        '/assignments',
        body({ tenant_id: 'tenant-a', plane: 'sensitive_detail' })
      )
    );
  });

  it.each(['audit', 'admin_audit', 'security', 'pii'])(
    'requires critical permission and confirmation for %s',
    async (logType) => {
      world(healthy({ critical_allowed: 1 }));
      const perms = [P.LOGGING_PLATFORM_DEFAULTS_UPDATE];
      forbidden(
        await call(perms, 'POST', '/assignments', body({ log_type: logType }), { platform: true })
      );
      const wrong = await call(
        [...perms, P.LOGGING_CRITICAL_UPDATE],
        'POST',
        '/assignments',
        body({ log_type: logType, confirmation: 'nope' }),
        { platform: true }
      );
      expect(wrong.status).toBe(400);
      expect(wrong.body.details.fields).toEqual([
        {
          path: 'confirmation',
          code: 'confirmation_mismatch',
          message: `Confirmation must be "CHANGE CRITICAL LOGGING ${logType}:external_sink".`,
        },
      ]);
      const ok = await call(
        [...perms, P.LOGGING_CRITICAL_UPDATE],
        'POST',
        '/assignments',
        body({
          log_type: logType,
          confirmation: `CHANGE CRITICAL LOGGING ${logType}:external_sink`,
        }),
        { platform: true }
      );
      expect(ok.status).toBe(201);
      expect(auditWrite).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ severity: 'warn' })
      );
    }
  );
});

describe('POST /assignments: destination eligibility', () => {
  const perms = [P.LOGGING_PLATFORM_DEFAULTS_UPDATE];
  const post = (
    extra: Record<string, unknown> = {},
    opts: { platform?: boolean } = { platform: true }
  ) =>
    call(
      perms,
      'POST',
      '/assignments',
      {
        log_type: 'diagnostic',
        plane: 'external_sink',
        destination_id: 'dest_1',
        ...extra,
      },
      opts
    );
  const field = (res: { status: number; body: Body }) => {
    expect(res.status).toBe(400);
    return res.body.details.fields[0] as Body;
  };

  it('404s an unknown destination', async () => {
    world(null);
    expect((await post()).status).toBe(404);
  });

  it('rejects inactive, unhealthy and non-critical destinations', async () => {
    world(healthy({ lifecycle_status: 'disabled' }));
    expect(field(await post())).toEqual({
      path: 'destination_id',
      code: 'destination_inactive',
      message: 'Destination is not active.',
    });
    for (const status of ['failing', 'degraded', 'unreachable']) {
      world(healthy({ health_status: status }));
      expect(field(await post())).toMatchObject({
        code: 'destination_unhealthy',
        message: 'Destination is not selectable.',
      });
    }
    for (const status of ['unknown', 'configured', 'healthy']) {
      world(healthy({ health_status: status }));
      expect((await post()).status).toBe(201);
    }
    world(healthy({ critical_allowed: 0 }));
    expect(
      field(
        await call(
          [P.LOGGING_PLATFORM_DEFAULTS_UPDATE, P.LOGGING_CRITICAL_UPDATE],
          'POST',
          '/assignments',
          {
            log_type: 'security',
            plane: 'external_sink',
            destination_id: 'dest_1',
            confirmation: 'CHANGE CRITICAL LOGGING security:external_sink',
          },
          { platform: true }
        )
      ).code
    ).toBe('critical_not_allowed');
  });

  it('rejects tenant-scoped destinations for platform defaults and for other tenants', async () => {
    world(healthy({ scope_type: 'tenant', scope_id: 'tenant-a' }));
    expect(field(await post())).toMatchObject({
      code: 'tenant_destination_for_platform_policy',
      message: 'Tenant-scoped destinations cannot be used for platform defaults.',
    });
    world(healthy({ scope_type: 'tenant', scope_id: 'tenant-other' }));
    const res = await call([P.LOGGING_TENANT_OVERRIDES_UPDATE], 'POST', '/assignments', {
      log_type: 'diagnostic',
      plane: 'external_sink',
      destination_id: 'dest_1',
      tenant_id: 'tenant-a',
    });
    expect(field(res)).toMatchObject({
      code: 'tenant_not_allowed',
      message: 'Destination is not assigned to tenant.',
    });
    world(healthy({ scope_type: 'tenant', scope_id: 'tenant-a' }));
    const ok = await call([P.LOGGING_TENANT_OVERRIDES_UPDATE], 'POST', '/assignments', {
      log_type: 'diagnostic',
      plane: 'external_sink',
      destination_id: 'dest_1',
      tenant_id: 'tenant-a',
    });
    expect(ok.status).toBe(201);
  });

  it('requires a storage assignment and names the missing scope', async () => {
    world(healthy(), { assigned: false });
    expect(field(await post())).toEqual({
      path: 'destination_id',
      code: 'log_type_or_plane_not_allowed',
      message: 'Destination is not assigned to this log type and plane.',
    });
    const tenant = await call([P.LOGGING_TENANT_OVERRIDES_UPDATE], 'POST', '/assignments', {
      log_type: 'diagnostic',
      plane: 'external_sink',
      destination_id: 'dest_1',
      tenant_id: 'tenant-a',
    });
    expect(field(tenant)).toMatchObject({ code: 'tenant_not_allowed' });
    const probe = must(
      mockAdapter.queryOne.mock.calls
        .filter(([sql]) => String(sql).includes('storage_destination_assignments'))
        .at(-1)
    );
    expect(probe[1]).toEqual([
      'dest_1',
      'tenant-a',
      'tenant-a',
      'diagnostic',
      'diagnostic',
      'external_sink',
      'external_sink',
    ]);
  });
});
