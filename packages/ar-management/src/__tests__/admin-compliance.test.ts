import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  core: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  auditDb: { queryOne: vi.fn() },
  hotSupport: vi.fn(),
  audit: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.core })),
    createAuditLogFromContext: mocks.audit,
    createErrorResponse: vi.fn((c, code, options) =>
      c.json({ error: code, ...options }, code === actual.AR_ERROR_CODES.INTERNAL_ERROR ? 500 : 400)
    ),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  };
});

vi.mock('../audit-hot-query', () => ({
  getAuditHotQuerySupport: mocks.hotSupport,
  getAuditHotQuerySqlSpec: vi.fn(() => ({ tableName: 'audit_events' })),
  getAuditTimeRange: vi.fn((from: number, to: number) => [from, to]),
}));

import {
  adminComplianceAccessReviewsCreateHandler,
  adminComplianceAccessReviewsListHandler,
  adminComplianceReportsListHandler,
  adminComplianceStatusHandler,
  adminDataRetentionStatusHandler,
} from '../admin-compliance';

function context(
  options: {
    query?: Record<string, string | undefined>;
    body?: unknown;
    bodyError?: boolean;
    adminId?: string;
  } = {}
) {
  return {
    get: vi.fn((name: string) =>
      name === 'adminAuth' && options.adminId ? { adminId: options.adminId } : null
    ),
    req: {
      query: vi.fn((name: string) => options.query?.[name]),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-1',
    tenant_id: 'tenant-a',
    name: 'Quarterly review',
    description: null,
    scope: 'all_users',
    scope_value: null,
    status: 'pending',
    reviewer_id: 'admin-1',
    total_items: 4,
    reviewed_items: 2,
    approved_items: 1,
    revoked_items: 1,
    created_at: 100,
    started_at: null,
    completed_at: null,
    due_date: null,
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: 'report-1',
    tenant_id: 'tenant-a',
    type: 'soc2_audit',
    name: 'SOC2',
    status: 'completed',
    requested_by: 'admin-1',
    parameters: '{"year":2026}',
    result_url: null,
    error_message: null,
    created_at: 100,
    completed_at: 200,
    expires_at: null,
    ...overrides,
  };
}

describe('admin compliance APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.core.query.mockReset();
    mocks.core.queryOne.mockReset();
    mocks.core.execute.mockReset();
    mocks.auditDb.queryOne.mockReset();
    mocks.hotSupport.mockReset();
    mocks.core.query.mockResolvedValue([]);
    mocks.core.queryOne.mockResolvedValue(null);
    mocks.core.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.auditDb.queryOne.mockResolvedValue(null);
    mocks.hotSupport.mockResolvedValue({ supported: false, status: 'not_supported' });
    mocks.audit.mockResolvedValue(undefined);
  });

  it.each([
    [null, false, 0],
    ['{', false, 0],
    ['[]', false, 0],
    [
      JSON.stringify({
        data_retention: { enabled: 'true', days: '30' },
        security: { mfa_enforced: 1 },
        audit: { retention_days: '180' },
      }),
      true,
      100,
    ],
    [
      JSON.stringify({
        data_retention: { enabled: 'false', days: 'invalid' },
        security: { mfa_enforced: '0' },
        audit: { retention_days: Number.NaN },
      }),
      false,
      50,
    ],
  ])('builds compliance status from tenant settings %#', async (settings, enabled, mfaCoverage) => {
    mocks.core.queryOne
      .mockResolvedValueOnce(settings === null ? null : { settings })
      .mockResolvedValueOnce({ users_with_mfa: mfaCoverage, users_without_mfa: 100 - mfaCoverage })
      .mockResolvedValueOnce({ active_roles: enabled ? 2 : 0, users_with_roles: 2 })
      .mockResolvedValueOnce({ pending_deletions: 3 })
      .mockResolvedValueOnce({ last_rotation: 100 });
    const body = (await (await adminComplianceStatusHandler(context())).json()) as {
      data_retention: { policy_enabled: boolean };
      mfa_status: { mfa_coverage_percent: number };
      audit_log: { hot_query_status: string };
    };
    expect(body.data_retention.policy_enabled).toBe(enabled);
    expect(body.mfa_status.mfa_coverage_percent).toBe(mfaCoverage);
    expect(body.audit_log.hot_query_status).toBe('not_supported');
  });

  it('uses supported audit storage and reports compliant frameworks', async () => {
    mocks.hotSupport.mockResolvedValueOnce({
      supported: true,
      context: { adapter: mocks.auditDb, createdAtUnit: 'seconds' },
    });
    mocks.auditDb.queryOne.mockResolvedValueOnce({ total: 10, last_30_days: 4 });
    mocks.core.queryOne
      .mockResolvedValueOnce({ settings: '{"data_retention":{"enabled":true,"days":30}}' })
      .mockResolvedValueOnce({ users_with_mfa: 8, users_without_mfa: 2 })
      .mockResolvedValueOnce({ active_roles: 2, users_with_roles: 8 })
      .mockResolvedValueOnce({ pending_deletions: 0 })
      .mockResolvedValueOnce({ last_rotation: 1_700_000_000_000 });
    const body = (await (await adminComplianceStatusHandler(context())).json()) as {
      overall_status: string;
      audit_log: { total_entries: number; hot_query_status: string };
    };
    expect(body).toMatchObject({
      overall_status: 'compliant',
      audit_log: { total_entries: 10, hot_query_status: 'supported' },
    });
  });

  it('returns internal_error when compliance status storage fails', async () => {
    mocks.core.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminComplianceStatusHandler(context())).status).toBe(500);
  });

  it.each([[{ page: '1' }], [{ page_size: '20' }]])(
    'rejects page pagination for access reviews %#',
    async (query) => {
      expect((await adminComplianceAccessReviewsListHandler(context({ query }))).status).toBe(400);
    }
  );

  it.each(['bad', Buffer.from('{}').toString('base64url'), Buffer.from('{').toString('base64url')])(
    'rejects invalid access-review cursor %s',
    async (cursor) => {
      expect(
        (await adminComplianceAccessReviewsListHandler(context({ query: { cursor } }))).status
      ).toBe(400);
    }
  );

  it.each([
    [{}, 20],
    [{ limit: '0', filter: 'status=pending' }, 20],
    [{ limit: '999', filter: 'status=invalid' }, 100],
  ])('lists access reviews with bounded pagination %#', async (query, limit) => {
    const rows = Array.from({ length: limit + 1 }, (_, index) =>
      review({ id: `review-${index}`, total_items: index ? 4 : 0, created_at: 100 - index })
    );
    mocks.core.query.mockResolvedValueOnce(rows);
    const body = (await (
      await adminComplianceAccessReviewsListHandler(context({ query }))
    ).json()) as { data: unknown[]; pagination: Record<string, unknown> };
    expect(body.data).toHaveLength(limit);
    expect(body.pagination).toMatchObject({ has_more: true, next_cursor: expect.any(String) });
  });

  it('applies a valid cursor and returns no next cursor on the final page', async () => {
    const cursor = Buffer.from(JSON.stringify({ id: 'review-old', created_at: 100 })).toString(
      'base64url'
    );
    mocks.core.query.mockResolvedValueOnce([review()]);
    const body = (await (
      await adminComplianceAccessReviewsListHandler(context({ query: { cursor } }))
    ).json()) as { pagination: Record<string, unknown> };
    expect(body.pagination).toEqual({ has_more: false });
    expect(mocks.core.query.mock.calls[0][1]).toEqual(
      expect.arrayContaining([100, 100, 'review-old'])
    );
  });

  it('handles access review listing failures', async () => {
    mocks.core.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminComplianceAccessReviewsListHandler(context())).status).toBe(500);
  });

  it.each([
    [{}],
    [{ name: '', scope: 'all_users' }],
    [{ name: 'Review', scope: 'unknown' }],
    [{ name: 'Review', scope: 'all_users', due_date: 'tomorrow' }],
  ])('validates access review creation %#', async (body) => {
    expect((await adminComplianceAccessReviewsCreateHandler(context({ body }))).status).toBe(400);
  });

  it.each([
    ['all_users', undefined, 4],
    ['role', 'role-1', 3],
    ['role', undefined, 0],
    ['organization', 'org-1', 2],
    ['organization', undefined, 0],
    ['inactive_users', undefined, 1],
  ])('creates %s access review with scope value %#', async (scope, scope_value, count) => {
    mocks.core.queryOne.mockResolvedValueOnce({ count });
    const response = await adminComplianceAccessReviewsCreateHandler(
      context({
        adminId: 'admin-1',
        body: {
          name: 'Review',
          description: '',
          scope,
          scope_value,
          due_date: '2027-01-01T00:00:00.000Z',
        },
      })
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      reviewer_id: 'admin-1',
      total_items: count,
    });
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('uses unknown reviewer and handles access-review creation failures', async () => {
    mocks.core.execute.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await adminComplianceAccessReviewsCreateHandler(
          context({ body: { name: 'Review', scope: 'all_users' } })
        )
      ).status
    ).toBe(500);
  });

  it.each([[{ page: '1' }], [{ page_size: '20' }]])(
    'rejects page pagination for reports %#',
    async (query) => {
      expect((await adminComplianceReportsListHandler(context({ query }))).status).toBe(400);
    }
  );

  it('lists filtered reports, safely ignores corrupt parameters, and paginates', async () => {
    mocks.core.query.mockResolvedValueOnce([
      report(),
      report({ id: 'report-2', parameters: '{', completed_at: null }),
      report({ id: 'extra' }),
    ]);
    const body = (await (
      await adminComplianceReportsListHandler(
        context({ query: { limit: '2', filter: 'status=completed,type=soc2_audit' } })
      )
    ).json()) as { data: Array<Record<string, unknown>>; pagination: Record<string, unknown> };
    expect(body.data).toEqual([
      expect.objectContaining({ parameters: { year: 2026 } }),
      expect.objectContaining({ parameters: null, completed_at: null }),
    ]);
    expect(body.pagination.next_cursor).toEqual(expect.any(String));
  });

  it.each(['bad', Buffer.from('{}').toString('base64url')])(
    'rejects invalid report cursor %s',
    async (cursor) => {
      expect((await adminComplianceReportsListHandler(context({ query: { cursor } }))).status).toBe(
        400
      );
    }
  );

  it('ignores unknown report filters and handles query failures', async () => {
    await expect(
      (
        await adminComplianceReportsListHandler(
          context({ query: { filter: 'status=nope,type=nope' } })
        )
      ).json()
    ).resolves.toMatchObject({ pagination: { has_more: false } });
    mocks.core.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminComplianceReportsListHandler(context())).status).toBe(500);
  });

  it.each([
    [null, false],
    ['{', false],
    [
      JSON.stringify({
        data_retention: { enabled: true, days: 30, last_cleanup_at: 100, next_cleanup_at: 200 },
        audit: { retention_days: 60 },
        session: { retention_days: 14 },
        compliance: { tombstone_retention_days: 3650 },
      }),
      true,
    ],
  ])('builds data retention status from settings %#', async (settings, enabled) => {
    mocks.core.queryOne
      .mockResolvedValueOnce(settings === null ? null : { settings })
      .mockResolvedValueOnce({ total: 10, expired: 2, oldest_date: 100 })
      .mockResolvedValueOnce({ total: 3, oldest_date: 100 })
      .mockResolvedValueOnce({ pending: 1 });
    const body = (await (await adminDataRetentionStatusHandler(context())).json()) as {
      policy: { enabled: boolean };
      summary: { total_records: number; records_pending_deletion: number };
    };
    expect(body.policy.enabled).toBe(enabled);
    expect(body.summary).toMatchObject({ total_records: 13, records_pending_deletion: 2 });
  });

  it('includes audit retention statistics when hot query is supported', async () => {
    mocks.hotSupport.mockResolvedValueOnce({
      supported: true,
      context: { adapter: mocks.auditDb, createdAtUnit: 'seconds' },
    });
    mocks.auditDb.queryOne.mockResolvedValueOnce({
      total: 5,
      pending_deletion: 2,
      oldest_date: 100,
      deleted_last_30_days: 0,
    });
    const body = (await (await adminDataRetentionStatusHandler(context())).json()) as {
      categories: Array<Record<string, unknown>>;
    };
    expect(body.categories[0]).toMatchObject({
      total_records: 5,
      records_pending_deletion: 2,
      hot_query_status: 'supported',
    });
  });

  it('handles data-retention storage failures', async () => {
    mocks.core.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminDataRetentionStatusHandler(context())).status).toBe(500);
  });
});
