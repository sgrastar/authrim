/**
 * zod 3 -> 4 migration pins for admin-security.ts
 * (ListAlertsQuerySchema with z.coerce.number(), AcknowledgeAlertSchema, IpReputationRequestSchema).
 *
 * `createErrorResponse` is mocked: status comes from the real implementation, the body is
 * `{ error: code, ...options }` so `variables.reason` (joined zod messages) is pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  core: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  audit: { queryOne: vi.fn() },
  hotSupport: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.core })),
    createAuditLogFromContext: vi.fn(),
    createErrorResponse: vi.fn(async (c, code, options) => {
      const real = await actual.createErrorResponse(c, code, options);
      return Response.json({ error: code, ...options }, { status: real.status });
    }),
    getLogger: vi.fn(() => ({ module: vi.fn(() => ({ error: vi.fn() })) })),
  };
});

vi.mock('../../audit-hot-query', () => ({
  getAuditHotQuerySupport: mocks.hotSupport,
  createAuditHotQueryUnsupportedResponse: vi.fn((c) => c.json({ error: 'unsupported' }, 503)),
  getAuditHotQuerySqlSpec: vi.fn(() => ({ tableName: 'audit_events', actionColumn: 'action' })),
  getAuditTimeRange: vi.fn((from: number, to: number) => [from, to]),
}));

import {
  adminSecurityAlertAcknowledgeHandler,
  adminSecurityAlertsListHandler,
  adminSecurityIpReputationHandler,
  adminSecuritySuspiciousActivitiesHandler,
  adminSecurityThreatsHandler,
} from '../../admin-security';

function context(
  options: { query?: Record<string, string | undefined>; body?: unknown; bodyError?: boolean } = {}
) {
  const query = options.query ?? {};
  return {
    get: vi.fn((name: string) => (name === 'adminAuth' ? { adminId: 'admin-1' } : undefined)),
    req: {
      path: '/api/admin/security/alerts',
      header: vi.fn(() => undefined),
      query: vi.fn((name: string) => query[name]),
      param: vi.fn((name: string) => (name === 'id' ? 'alert-1' : undefined)),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

async function run(handler: (c: never) => Promise<Response>, c: never) {
  const response = await handler(c);
  return { status: response.status, body: await response.json() };
}

const invalid = (field: string, reason: string) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field, reason } },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.core.query.mockReset();
  mocks.core.queryOne.mockReset();
  mocks.core.execute.mockReset();
  mocks.core.query.mockResolvedValue([]);
  mocks.core.queryOne.mockResolvedValue(null);
  mocks.core.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  mocks.audit.queryOne.mockResolvedValue({ count: 0 });
  mocks.hotSupport.mockResolvedValue({
    supported: true,
    context: { adapter: mocks.audit, mode: 'events', createdAtUnit: 'seconds' },
  });
});

describe('zod pins: ListAlertsQuerySchema (z.coerce.number on query strings)', () => {
  const list = (query: Record<string, string | undefined>) =>
    run(adminSecurityAlertsListHandler, context({ query }));
  const boundLimit = () => {
    const bindings = mocks.core.query.mock.calls[0]?.[1] as unknown[];
    return bindings[bindings.length - 1];
  };

  it('coercion failures and bounds produce these exact reasons', async () => {
    const cases: Array<[string, string]> = [
      ['0', 'Number must be greater than or equal to 1'],
      ['-1', 'Number must be greater than or equal to 1'],
      ['101', 'Number must be less than or equal to 100'],
      ['1.5', 'Expected integer, received float'],
      ['abc', 'Expected number, received nan'],
      ['', 'Number must be greater than or equal to 1'],
      [' ', 'Number must be greater than or equal to 1'],
      // zod 4 rejects ±Infinity at the number type check (zod 3 reached .int() and the range).
      ['Infinity', 'Number must be finite'],
      ['-Infinity', 'Number must be finite'],
      ['1.5e2', 'Number must be less than or equal to 100'],
      // zod 4: a non-integer stops at the integer check, so the range message no longer follows.
      ['100.5', 'Expected integer, received float'],
      ['0.5', 'Expected integer, received float'],
      ['null', 'Expected number, received nan'],
    ];
    for (const [limit, reason] of cases) {
      expect(await list({ limit })).toEqual(invalid('query', reason));
    }
  });

  it('numeric strings that Number() accepts are coerced and accepted', async () => {
    const accepted: Array<[string, number]> = [
      ['1', 1],
      ['100', 100],
      ['0x10', 16],
      ['1e1', 10],
      [' 5 ', 5],
      ['+7', 7],
      ['010', 10],
    ];
    for (const [limit, expected] of accepted) {
      mocks.core.query.mockClear();
      const result = await list({ limit });
      expect(result.status).toBe(200);
      expect(boundLimit()).toBe(expected + 1);
    }
  });

  it('limit defaults to 20 when absent (undefined input)', async () => {
    const result = await list({});
    expect(result).toEqual({ status: 200, body: { data: [], pagination: { has_more: false } } });
    expect(boundLimit()).toBe(21);
  });

  it('other query fields are plain optional strings', async () => {
    // non-string values cannot occur from c.req.query(); accepted strings pass through to later checks
    const result = await list({ sort: 'created_at', filter: 'status=open', limit: '5' });
    expect(result.status).toBe(200);
  });

  it('threats and suspicious-activities share the same query validation', async () => {
    for (const handler of [adminSecurityThreatsHandler, adminSecuritySuspiciousActivitiesHandler]) {
      expect(await run(handler, context({ query: { limit: 'abc' } }))).toEqual(
        invalid('query', 'Expected number, received nan')
      );
      expect(await run(handler, context({ query: { limit: '101' } }))).toEqual(
        invalid('query', 'Number must be less than or equal to 100')
      );
      expect((await run(handler, context({ query: {} }))).status).toBe(200);
    }
  });
});

describe('zod pins: AcknowledgeAlertSchema (POST /alerts/:id/acknowledge)', () => {
  const ack = (body: unknown, bodyError = false) =>
    run(adminSecurityAlertAcknowledgeHandler, context({ body, bodyError }));

  it('field and root issues', async () => {
    expect(await ack({ notes: 5 })).toEqual(invalid('body', 'Expected string, received number'));
    expect(await ack({ notes: 'n'.repeat(1001) })).toEqual(
      invalid('body', 'String must contain at most 1000 character(s)')
    );
    expect(await ack({ resolution: 'r'.repeat(501) })).toEqual(
      invalid('body', 'String must contain at most 500 character(s)')
    );
    expect(await ack({ resolution: null })).toEqual(
      invalid('body', 'Expected string, received null')
    );
    expect(await ack({ notes: 1, resolution: 2 })).toEqual(
      invalid('body', 'Expected string, received number, Expected string, received number')
    );
    expect(await ack(null)).toEqual(invalid('body', 'Expected object, received null'));
    expect(await ack([])).toEqual(invalid('body', 'Expected object, received array'));
    expect(await ack('text')).toEqual(invalid('body', 'Expected object, received string'));
  });

  it('boundary lengths, empty strings, unknown keys, and a body that fails to parse as JSON all pass schema', async () => {
    // alert lookup returns null -> 404 means the schema accepted the input
    const status = async (body: unknown, bodyError = false) => (await ack(body, bodyError)).status;
    expect(await status({ notes: 'n'.repeat(1000), resolution: 'r'.repeat(500) })).toBe(404);
    expect(await status({ notes: '', resolution: '' })).toBe(404);
    expect(await status({ unknown: true })).toBe(404);
    expect(await status({})).toBe(404);
    expect(await status(undefined, true)).toBe(404);
  });
});

describe('zod pins: IpReputationRequestSchema (POST /ip-reputation)', () => {
  const check = (body: unknown, bodyError = false) =>
    run(adminSecurityIpReputationHandler, context({ body, bodyError }));
  const badIp = (reason: string) => invalid('ip_addresses', reason);

  it('root / array issues', async () => {
    expect(await check({})).toEqual(badIp('Required'));
    expect(await check(null)).toEqual(badIp('Expected object, received null'));
    expect(await check([])).toEqual(badIp('Expected object, received array'));
    expect(await check({ ip_addresses: 'x' })).toEqual(badIp('Expected array, received string'));
    expect(await check({ ip_addresses: null })).toEqual(badIp('Expected array, received null'));
    expect(await check({ ip_addresses: [] })).toEqual(
      badIp('Array must contain at least 1 element(s)')
    );
    expect(await check({ ip_addresses: Array.from({ length: 101 }, () => '1.1.1.1') })).toEqual(
      badIp('Array must contain at most 100 element(s)')
    );
  });

  it('element issues are reported per element, in index order', async () => {
    expect(await check({ ip_addresses: ['nope'] })).toEqual(badIp('Invalid IP address'));
    expect(await check({ ip_addresses: ['1.1.1.1', 'bad', 5, 'worse'] })).toEqual(
      badIp('Invalid IP address, Expected string, received number, Invalid IP address')
    );
    expect(await check({ ip_addresses: [] })).toEqual(
      badIp('Array must contain at least 1 element(s)')
    );
  });

  it('IP pattern edge cases (status per value)', async () => {
    const values = [
      '1.2.3.4',
      '01.2.3.4',
      '001.2.3.4',
      '256.1.1.1',
      '1.2.3',
      '1.2.3.4.5',
      ' 1.2.3.4',
      '1.2.3.4\n',
      '::1',
      '::',
      'fe80::1',
      '1::',
      '2001:db8::',
      '2001:db8:0:0:0:0:0:1',
      '2001:db8::1::2',
      '::ffff:1.2.3.4',
      'fe80::1%eth0',
      'g::1',
      '',
    ];
    const statuses: Record<string, number> = {};
    for (const ip of values) statuses[ip] = (await check({ ip_addresses: [ip] })).status;
    expect(statuses).toEqual({
      '1.2.3.4': 200,
      '01.2.3.4': 200,
      '001.2.3.4': 200,
      '256.1.1.1': 400,
      '1.2.3': 400,
      '1.2.3.4.5': 400,
      ' 1.2.3.4': 400,
      '1.2.3.4\n': 400,
      '::1': 200,
      '::': 400,
      'fe80::1': 200,
      '1::': 200,
      '2001:db8::': 200,
      '2001:db8:0:0:0:0:0:1': 200,
      '2001:db8::1::2': 400,
      '::ffff:1.2.3.4': 400,
      'fe80::1%eth0': 400,
      'g::1': 400,
      '': 400,
    });
  });

  it('valid body returns one result per IP; unknown keys are ignored; malformed JSON -> 500', async () => {
    const ok = await check({ ip_addresses: ['203.0.113.9', '::1'], other: 1 });
    expect(ok.status).toBe(200);
    expect(
      (ok.body as { results: Array<{ ip_address: string }> }).results.map((r) => r.ip_address)
    ).toEqual(['203.0.113.9', '::1']);
    expect((await check(undefined, true)).status).toBe(500);
  });
});
