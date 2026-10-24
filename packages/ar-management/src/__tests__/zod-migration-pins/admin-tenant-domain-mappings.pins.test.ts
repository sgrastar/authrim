/**
 * zod 3 -> 4 migration pins for admin-tenant-domain-mappings.ts (CreateSchema / UpdateSchema).
 *
 * `createErrorResponse` is mocked: status comes from the real implementation, the body is
 * `{ error: code, ...options }` so `variables.reason` (joined zod messages) is pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveOptionalCoreAdapterFromHono: vi.fn(() => mocks.adapter),
    createAuditLogFromContext: vi.fn(),
    getEmailDomainHashConfig: vi.fn(async () => ({ currentVersion: 2 })),
    generateEmailDomainHashWithVersion: vi.fn(async () => ({ hash: 'hash-1', version: 2 })),
    getLogger: vi.fn(() => ({ module: vi.fn(() => ({ error: vi.fn() })) })),
    createErrorResponse: vi.fn(async (c, code, options) => {
      const real = await actual.createErrorResponse(c, code, options);
      return Response.json({ error: code, ...options }, { status: real.status });
    }),
  };
});

import {
  createTenantDomainMappingHandler,
  updateTenantDomainMappingHandler,
} from '../../admin-tenant-domain-mappings';

function context(body: unknown, id = 'mapping-1') {
  return {
    get: vi.fn(() => ({ adminId: 'admin-1' })),
    req: {
      path: '/api/admin/platform/tenant-domain-mappings',
      header: vi.fn(() => undefined),
      query: vi.fn(() => undefined),
      param: vi.fn(() => id),
      json: vi.fn().mockResolvedValue(body),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

async function run(handler: (c: never) => Promise<Response>, body: unknown) {
  const response = await handler(context(body));
  return { status: response.status, body: await response.json() };
}

const invalidBody = (reason: string) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field: 'body', reason } },
});

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'mapping-1',
  domain_hash: 'hash-1',
  hash_version: 2,
  tenant_id: 'tenant-a',
  priority: 0,
  is_active: 1,
  verified: 0,
  verification_expires_at: null,
  created_by: 'admin-1',
  created_at: 100,
  updated_at: 100,
  ...overrides,
});

describe('zod pins: tenant domain mappings CreateSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  });

  it('root body that is not an object', async () => {
    expect(await run(createTenantDomainMappingHandler, null)).toEqual(
      invalidBody('Expected object, received null')
    );
    expect(await run(createTenantDomainMappingHandler, [])).toEqual(
      invalidBody('Expected object, received array')
    );
    expect(await run(createTenantDomainMappingHandler, 'x')).toEqual(
      invalidBody('Expected object, received string')
    );
  });

  it('missing required fields (issue order follows schema order)', async () => {
    expect(await run(createTenantDomainMappingHandler, {})).toEqual(
      invalidBody('Required, Required')
    );
    expect(await run(createTenantDomainMappingHandler, { domain: 'example.com' })).toEqual(
      invalidBody('Required')
    );
  });

  it('wrong types, min/max, int, range', async () => {
    const base = { domain: 'example.com', tenant_id: 'tenant-a' };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ domain: 5, tenant_id: 'tenant-a' }, 'Expected string, received number'],
      [{ domain: '', tenant_id: 'tenant-a' }, 'String must contain at least 1 character(s)'],
      [
        { domain: 'a'.repeat(254), tenant_id: 'tenant-a' },
        'String must contain at most 253 character(s)',
      ],
      [{ domain: 'example.com', tenant_id: '' }, 'String must contain at least 1 character(s)'],
      [
        { domain: 'example.com', tenant_id: 't'.repeat(64) },
        'String must contain at most 63 character(s)',
      ],
      [{ ...base, priority: 1.5 }, 'Expected integer, received float'],
      [{ ...base, priority: -1 }, 'Number must be greater than or equal to 0'],
      [{ ...base, priority: 1001 }, 'Number must be less than or equal to 1000'],
      [{ ...base, priority: '1' }, 'Expected number, received string'],
      [{ ...base, priority: null }, 'Expected number, received null'],
      [{ ...base, is_active: 'true' }, 'Expected boolean, received string'],
      [{ ...base, is_active: 1 }, 'Expected boolean, received number'],
      [{ ...base, verified: null }, 'Expected boolean, received null'],
      [
        { ...base, priority: 1000.5 },
        'Expected integer, received float, Number must be less than or equal to 1000',
      ],
      [
        { domain: 1, tenant_id: 2, priority: 'p', is_active: 'a', verified: 'v' },
        'Expected string, received number, Expected string, received number, Expected number, received string, Expected boolean, received string, Expected boolean, received string',
      ],
    ];
    for (const [body, reason] of cases) {
      expect(await run(createTenantDomainMappingHandler, body)).toEqual(invalidBody(reason));
    }
  });

  it('domain format is validated after zod with its own (non-zod) message', async () => {
    expect(
      await run(createTenantDomainMappingHandler, { domain: 'localhost', tenant_id: 'tenant-a' })
    ).toEqual({
      status: 400,
      body: {
        error: 'AR130003',
        variables: {
          field: 'domain',
          reason:
            'invalid domain format. Must be lowercase letters, numbers, hyphens, and dots. Labels cannot start or end with hyphens.',
        },
      },
    });
    // whitespace-only passes min(1) and is rejected by the hand-written check
    expect(
      await run(createTenantDomainMappingHandler, { domain: '   ', tenant_id: 'tenant-a' })
    ).toEqual({
      status: 400,
      body: { error: 'AR130003', variables: { field: 'domain', reason: 'domain is required' } },
    });
  });

  it('unknown keys are stripped; defaults priority=0, is_active=true, verified=false', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce({ id: 'tenant-a' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row());
    const result = await run(createTenantDomainMappingHandler, {
      domain: 'Example.com',
      tenant_id: 'tenant-a',
      unknown_key: 'ignored',
    });
    expect(result.status).toBe(201);
    const params = mocks.adapter.execute.mock.calls[0]?.[1] as unknown[];
    // [id, hash, version, tenant_id, priority, is_active, active_hash, verified, created_by, ...]
    expect(params.slice(1, 9)).toEqual(['hash-1', 2, 'tenant-a', 0, 1, 'hash-1', 0, 'admin-1']);
  });

  it('explicit values override defaults; boundaries accepted', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce({ id: 'tenant-a' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row());
    const result = await run(createTenantDomainMappingHandler, {
      domain: 'example.com',
      tenant_id: 't'.repeat(63),
      priority: 1000,
      is_active: false,
      verified: true,
    });
    expect(result.status).toBe(201);
    const params = mocks.adapter.execute.mock.calls[0]?.[1] as unknown[];
    expect(params.slice(1, 9)).toEqual(['hash-1', 2, 't'.repeat(63), 1000, 0, null, 1, 'admin-1']);
  });
});

describe('zod pins: tenant domain mappings UpdateSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  });

  it('root and field issues', async () => {
    expect(await run(updateTenantDomainMappingHandler, null)).toEqual(
      invalidBody('Expected object, received null')
    );
    expect(await run(updateTenantDomainMappingHandler, 5)).toEqual(
      invalidBody('Expected object, received number')
    );
    expect(await run(updateTenantDomainMappingHandler, { priority: 1.5 })).toEqual(
      invalidBody('Expected integer, received float')
    );
    expect(await run(updateTenantDomainMappingHandler, { priority: -1 })).toEqual(
      invalidBody('Number must be greater than or equal to 0')
    );
    expect(await run(updateTenantDomainMappingHandler, { priority: 1001 })).toEqual(
      invalidBody('Number must be less than or equal to 1000')
    );
    expect(await run(updateTenantDomainMappingHandler, { priority: 'x', is_active: 'y' })).toEqual(
      invalidBody('Expected number, received string, Expected boolean, received string')
    );
    expect(await run(updateTenantDomainMappingHandler, { priority: null })).toEqual(
      invalidBody('Expected number, received null')
    );
  });

  it('empty object / unknown keys parse to no updates (returns existing mapping, no UPDATE)', async () => {
    mocks.adapter.queryOne.mockResolvedValue(row());
    const expected = {
      status: 200,
      body: {
        id: 'mapping-1',
        tenant_id: 'tenant-a',
        hash_version: 2,
        priority: 0,
        is_active: true,
        verified: false,
        verification_expires_at: null,
        created_by: 'admin-1',
        created_at: 100,
        updated_at: 100,
      },
    };
    expect(await run(updateTenantDomainMappingHandler, {})).toEqual(expected);
    expect(
      await run(updateTenantDomainMappingHandler, { domain: 'ignored.example', verified: true })
    ).toEqual(expected);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('valid partial update only touches provided keys', async () => {
    mocks.adapter.queryOne.mockResolvedValue(row({ priority: 7 }));
    const result = await run(updateTenantDomainMappingHandler, { priority: 7 });
    expect(result.status).toBe(200);
    const [sql, values] = mocks.adapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe('UPDATE tenant_domain_mappings SET priority = ?, updated_at = ? WHERE id = ?');
    expect([values[0], values[2]]).toEqual([7, 'mapping-1']);
  });
});
