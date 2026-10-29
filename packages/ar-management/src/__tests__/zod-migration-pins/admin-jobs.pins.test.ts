/**
 * zod 3 -> 4 migration pins for admin-jobs.ts
 * (ListJobsQuerySchema, BulkUpdateOptionsSchema, ReportOptionsSchema, BulkMembersOptionsSchema,
 *  ImportOptionsSchema is only reachable behind R2 artifact checks and is not pinned here).
 *
 * `createErrorResponse` is mocked: status comes from the real implementation, the body is
 * `{ error: code, ...options }` so `variables.reason` (joined zod messages) is pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  adapter: { queryOne: vi.fn(), query: vi.fn(), execute: vi.fn() },
}));

vi.mock('../../tenant-routed-storage', () => ({ usesRoutedAccountStorage: vi.fn(() => false) }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mocks.adapter),
    createAuditLogFromContext: vi.fn(async () => undefined),
    getLogger: vi.fn(() => ({ module: () => ({ error: vi.fn() }) })),
    createErrorResponse: vi.fn(
      async (...[c, code, options]: Parameters<typeof actual.createErrorResponse>) => {
        const real = await actual.createErrorResponse(c, code, options);
        return Response.json({ error: code, ...options }, { status: real.status });
      }
    ),
  };
});

vi.mock('../../admin-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../admin-shared')>();
  return { ...actual, writeAdminAuditLog: vi.fn(async () => undefined) };
});

import {
  adminJobsListHandler,
  adminJobsOrgBulkMembersHandler,
  adminJobsReportsGenerateHandler,
  adminJobsUsersBulkUpdateHandler,
} from '../../admin-jobs';

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as never as { set: (k: string, v: unknown) => void }).set('adminAuth', {
      adminId: 'admin-1',
      userId: 'admin-1',
      roles: ['ar_super_admin'],
      permissions: ['*'],
    });
    await next();
  });
  app.post('/api/admin/jobs/users/bulk-update', adminJobsUsersBulkUpdateHandler);
  app.post('/api/admin/jobs/reports/generate', adminJobsReportsGenerateHandler);
  app.post('/api/admin/jobs/organizations/:id/bulk-members', adminJobsOrgBulkMembersHandler);
  app.get('/api/admin/jobs', adminJobsListHandler);
  return app;
}

async function send(method: string, path: string, body?: unknown) {
  const response = await createApp().request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': 'tenant-a' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    {} as Env
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const invalid = (field: string, reason: string) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field, reason } },
});
const invalidBody = (reason: string) => invalid('body', reason);

const UUID_A = '11111111-1111-4111-8111-111111111111';

function insertedConfig(): Record<string, unknown> {
  const call = mocks.adapter.execute.mock.calls.find((c) =>
    String(c[0]).includes('INSERT INTO admin_jobs')
  );
  const params = call?.[1] as unknown[];
  // [id, tenant_id, job_type, status, progress, config, ...]
  return JSON.parse(String(params[5])) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter.queryOne.mockReset();
  mocks.adapter.query.mockReset();
  mocks.adapter.execute.mockReset();
  mocks.adapter.query.mockResolvedValue([]);
  mocks.adapter.queryOne.mockResolvedValue(null);
  mocks.adapter.execute.mockResolvedValue(undefined);
});

describe('zod pins: ListJobsQuerySchema (GET /jobs, z.coerce.number)', () => {
  const list = (query: string) => send('GET', `/api/admin/jobs${query}`);

  it('coercion / bounds reasons', async () => {
    const cases: Array<[string, string]> = [
      ['limit=0', 'Number must be greater than or equal to 1'],
      ['limit=101', 'Number must be less than or equal to 100'],
      ['limit=1.5', 'Expected integer, received float'],
      ['limit=abc', 'Expected number, received nan'],
      ['limit=', 'Number must be greater than or equal to 1'],
      ['limit=-5', 'Number must be greater than or equal to 1'],
    ];
    for (const [query, reason] of cases) {
      expect(await list(`?${query}`)).toEqual(invalid('query', reason));
    }
  });

  it('page-based pagination is rejected before zod', async () => {
    expect(await list('?page=1')).toEqual(
      invalid('pagination', 'Use cursor-based pagination. page/page_size not supported.')
    );
  });

  it('default limit 20 and coerced string limits reach the SQL LIMIT binding (limit + 1)', async () => {
    const limitBinding = async (query: string) => {
      mocks.adapter.query.mockClear();
      const result = await list(query);
      expect(result.status).toBe(200);
      const bindings = mocks.adapter.query.mock.calls.at(-1)?.[1] as unknown[];
      return bindings[bindings.length - 1];
    };
    expect(await limitBinding('')).toBe(21);
    expect(await limitBinding('?limit=5')).toBe(6);
    expect(await limitBinding('?limit=0x10')).toBe(17);
    expect(await limitBinding('?limit=100')).toBe(101);
  });
});

describe('zod pins: BulkUpdateOptionsSchema (POST /jobs/users/bulk-update)', () => {
  const bulk = (body: unknown) => send('POST', '/api/admin/jobs/users/bulk-update', body);
  const good = { fields: ['status'], values: { status: 'suspended' } };

  it('root and field issues', async () => {
    expect(await bulk(null)).toEqual(invalidBody('Expected object, received null'));
    expect(await bulk([])).toEqual(invalidBody('Expected object, received array'));
    expect(await bulk({})).toEqual(invalidBody('Required, Required'));
    expect(await bulk({ fields: [], values: {} })).toEqual(
      invalidBody('Array must contain at least 1 element(s)')
    );
    expect(await bulk({ fields: 'status', values: {} })).toEqual(
      invalidBody('Expected array, received string')
    );
    expect(await bulk({ fields: [1], values: {} })).toEqual(
      invalidBody('Expected string, received number')
    );
    expect(await bulk({ fields: ['a'], values: [] })).toEqual(
      invalidBody('Expected object, received array')
    );
    expect(await bulk({ fields: ['a'], values: null })).toEqual(
      invalidBody('Expected object, received null')
    );
    expect(await bulk({ ...good, filter: [] })).toEqual(
      invalidBody('Expected object, received array')
    );
    expect(await bulk({ ...good, filter: 'x' })).toEqual(
      invalidBody('Expected object, received string')
    );
    expect(await bulk({ ...good, dry_run: 'yes' })).toEqual(
      invalidBody('Expected boolean, received string')
    );
    expect(await bulk({ ...good, batch_size: 0 })).toEqual(
      invalidBody('Number must be greater than or equal to 1')
    );
    expect(await bulk({ ...good, batch_size: 1001 })).toEqual(
      invalidBody('Number must be less than or equal to 1000')
    );
    expect(await bulk({ ...good, batch_size: 1.5 })).toEqual(
      invalidBody('Expected integer, received float')
    );
    expect(await bulk({ ...good, result_delivery: 'email' })).toEqual(
      invalidBody("Invalid enum value. Expected 'auto' | 'inline' | 'artifact', received 'email'")
    );
    expect(await bulk({ ...good, result_delivery: null })).toEqual(
      invalidBody("Expected 'auto' | 'inline' | 'artifact', received null")
    );
    expect(
      await bulk({
        fields: 1,
        values: 2,
        filter: 3,
        dry_run: 4,
        batch_size: 'x',
        result_delivery: 5,
      })
    ).toEqual(
      invalidBody(
        "Expected array, received number, Expected object, received number, Expected object, received number, Expected boolean, received number, Expected number, received string, Expected 'auto' | 'inline' | 'artifact', received number"
      )
    );
  });

  it('hand-written config validation runs after zod (unsafe field is not a zod issue)', async () => {
    const result = await bulk({ fields: ['email'], values: { email: 'a@example.com' } });
    expect(result.status).toBe(400);
    expect((result.body.variables as { field: string }).field).toBe('body');
  });

  it('defaults dry_run=false and result_delivery="auto" are stored in the job config; unknown keys are stripped', async () => {
    mocks.adapter.queryOne.mockResolvedValue({ count: 2 });
    const result = await bulk({ ...good, unknown_key: 'dropped' });
    expect(result.status).toBe(202);
    const config = insertedConfig();
    expect(config).toEqual({
      fields: ['status'],
      values: { status: 'suspended' },
      dry_run: false,
      result_delivery: 'auto',
      lifecycle_version_ms: expect.any(Number) as unknown,
    });
    expect(result.body.dry_run).toBe(false);
  });

  it('explicit values: filter record, batch_size boundaries, dry_run true', async () => {
    mocks.adapter.queryOne.mockResolvedValue({ count: 1 });
    const result = await bulk({
      ...good,
      filter: { lifecycle_state: 'active' },
      batch_size: 1000,
      dry_run: true,
      result_delivery: 'artifact',
    });
    expect(result.status).toBe(202);
    expect(insertedConfig()).toEqual({
      fields: ['status'],
      filter: { lifecycle_state: 'active' },
      values: { status: 'suspended' },
      dry_run: true,
      batch_size: 1000,
      result_delivery: 'artifact',
      lifecycle_version_ms: expect.any(Number) as unknown,
    });
  });
});

describe('zod pins: ReportOptionsSchema (POST /jobs/reports/generate)', () => {
  const report = (body: unknown) => send('POST', '/api/admin/jobs/reports/generate', body);
  const good = {
    type: 'user_activity',
    from_date: '2026-07-01T00:00:00.000Z',
    to_date: '2026-07-02T00:00:00.000Z',
  };
  const TYPE_ENUM = "'user_activity' | 'access_summary' | 'compliance_audit' | 'security_events'";

  it('root and field issues', async () => {
    expect(await report(null)).toEqual(invalidBody('Expected object, received null'));
    expect(await report({})).toEqual(invalidBody('Required, Required, Required'));
    expect(await report({ ...good, type: 'nope' })).toEqual(
      invalidBody(`Invalid enum value. Expected ${TYPE_ENUM}, received 'nope'`)
    );
    expect(await report({ ...good, type: 5 })).toEqual(
      invalidBody(`Expected ${TYPE_ENUM}, received number`)
    );
    expect(await report({ ...good, from_date: 'yesterday' })).toEqual(
      invalidBody('Invalid datetime')
    );
    expect(await report({ ...good, to_date: 5 })).toEqual(
      invalidBody('Expected string, received number')
    );
    expect(await report({ ...good, format: 'xml' })).toEqual(
      invalidBody("Invalid enum value. Expected 'json' | 'csv', received 'xml'")
    );
    expect(await report({ ...good, filters: [] })).toEqual(
      invalidBody('Expected object, received array')
    );
    expect(await report({ ...good, result_delivery: 'mail' })).toEqual(
      invalidBody("Invalid enum value. Expected 'auto' | 'inline' | 'artifact', received 'mail'")
    );
    expect(await report({ type: 'x', from_date: 'a', to_date: 'b', format: 'z' })).toEqual(
      invalidBody(
        `Invalid enum value. Expected ${TYPE_ENUM}, received 'x', Invalid datetime, Invalid datetime, Invalid enum value. Expected 'json' | 'csv', received 'z'`
      )
    );
  });

  it('datetime() (no offset option) edge cases: status per from_date value', async () => {
    const values = [
      '2026-07-01T00:00Z',
      '2026-07-01T00:00:00Z',
      '2026-07-01T00:00:00.5Z',
      '2026-07-01T09:00:00+09:00',
      '2026-07-01T09:00:00+0900',
      '2026-07-01',
      '2026-07-01T00:00:00',
      '2026-02-30T00:00:00Z',
    ];
    const statuses: Record<string, number> = {};
    for (const from_date of values) {
      const result = await report({ ...good, from_date, to_date: '2026-07-02T00:00:00Z' });
      statuses[from_date] = result.status;
    }
    expect(statuses).toEqual({
      '2026-07-01T00:00Z': 202,
      '2026-07-01T00:00:00Z': 202,
      '2026-07-01T00:00:00.5Z': 202,
      '2026-07-01T09:00:00+09:00': 400,
      '2026-07-01T09:00:00+0900': 400,
      '2026-07-01': 400,
      '2026-07-01T00:00:00': 400,
      '2026-02-30T00:00:00Z': 400,
    });
  });

  it('post-zod range checks keep hand-written messages', async () => {
    expect(await report({ ...good, from_date: good.to_date, to_date: good.from_date })).toEqual(
      invalid('from_date', 'from_date must be before to_date')
    );
    expect(
      await report({ ...good, from_date: '2026-01-01T00:00:00Z', to_date: '2026-06-01T00:00:00Z' })
    ).toEqual(invalid('date_range', 'Maximum date range is 90 days'));
  });

  it('defaults format="json" and result_delivery="auto" are stored in the job config', async () => {
    const result = await report({ ...good, extra: 1 });
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ report_type: 'user_activity', format: 'json' });
    expect(insertedConfig()).toEqual({
      type: 'user_activity',
      from_date: '2026-07-01T00:00:00.000Z',
      to_date: '2026-07-02T00:00:00.000Z',
      format: 'json',
      result_delivery: 'auto',
    });
  });

  it('filters record and explicit csv format are kept', async () => {
    const result = await report({ ...good, format: 'csv', filters: { a: [1, { b: 2 }] } });
    expect(result.status).toBe(202);
    expect(insertedConfig()).toEqual({
      type: 'user_activity',
      from_date: '2026-07-01T00:00:00.000Z',
      to_date: '2026-07-02T00:00:00.000Z',
      format: 'csv',
      filters: { a: [1, { b: 2 }] },
      result_delivery: 'auto',
    });
  });
});

describe('zod pins: BulkMembersOptionsSchema (POST /jobs/organizations/:id/bulk-members)', () => {
  const members = (body: unknown) =>
    send('POST', '/api/admin/jobs/organizations/org-1/bulk-members', body);

  it('root and field issues', async () => {
    expect(await members(null)).toEqual(invalidBody('Expected object, received null'));
    expect(await members({})).toEqual(invalidBody('Required'));
    expect(await members({ user_ids: [] })).toEqual(
      invalidBody('Array must contain at least 1 element(s)')
    );
    expect(await members({ user_ids: ['not-a-uuid'] })).toEqual(invalidBody('Invalid uuid'));
    expect(await members({ user_ids: [UUID_A, 'x', 5, 'y'] })).toEqual(
      invalidBody('Invalid uuid, Expected string, received number, Invalid uuid')
    );
    expect(await members({ user_ids: Array.from({ length: 1001 }, () => UUID_A) })).toEqual(
      invalidBody('Array must contain at most 1000 element(s)')
    );
    expect(await members({ user_ids: [UUID_A], role: 'guest' })).toEqual(
      invalidBody("Invalid enum value. Expected 'member' | 'admin' | 'owner', received 'guest'")
    );
    expect(await members({ user_ids: [UUID_A], action: 'move' })).toEqual(
      invalidBody("Invalid enum value. Expected 'add' | 'remove', received 'move'")
    );
    expect(await members({ user_ids: [UUID_A], result_delivery: 'x' })).toEqual(
      invalidBody("Invalid enum value. Expected 'auto' | 'inline' | 'artifact', received 'x'")
    );
  });

  it('uuid() edge cases (status per value; unknown org -> 404 means schema passed)', async () => {
    const values = [
      UUID_A,
      UUID_A.toUpperCase(),
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      '11111111-1111-1111-8111-111111111111',
      '11111111-1111-7111-8111-111111111111',
      '11111111111141118111111111111111',
      `{${UUID_A}}`,
      `${UUID_A} `,
      '11111111-1111-4111-8111-11111111111g',
    ];
    const statuses: Record<string, number> = {};
    for (const id of values) statuses[id] = (await members({ user_ids: [id] })).status;
    expect(statuses).toEqual({
      [UUID_A]: 404,
      [UUID_A.toUpperCase()]: 404,
      '00000000-0000-0000-0000-000000000000': 404,
      'ffffffff-ffff-ffff-ffff-ffffffffffff': 404,
      '11111111-1111-1111-8111-111111111111': 404,
      '11111111-1111-7111-8111-111111111111': 404,
      '11111111111141118111111111111111': 400,
      [`{${UUID_A}}`]: 400,
      [`${UUID_A} `]: 400,
      '11111111-1111-4111-8111-11111111111g': 400,
    });
  });

  it('defaults action="add" and result_delivery="auto" are stored in the job config', async () => {
    mocks.adapter.queryOne.mockResolvedValue({ id: 'org-1', tenant_id: 'tenant-a', name: 'Org' });
    mocks.adapter.query.mockResolvedValue([{ id: UUID_A }]);
    const result = await members({ user_ids: [UUID_A], surplus: true });
    expect(result.status).toBe(202);
    expect(insertedConfig()).toEqual({
      organization_id: 'org-1',
      organization_name: 'Org',
      action: 'add',
      user_ids: [UUID_A],
      result_delivery: 'auto',
    });
    expect(result.body).toMatchObject({ action: 'add', user_count: 1 });
  });
});
