import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  audit: vi.fn(),
  generateId: vi.fn(() => 'attr-new'),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    generateId: mocks.generateId,
    createAuditLogFromContext: mocks.audit,
    createErrorResponse: vi.fn((c, code) =>
      c.json(
        { error: code },
        code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND ? 404 : 500
      )
    ),
  };
});

import {
  adminAttributeCreateHandler,
  adminAttributeDeleteHandler,
  adminAttributeNamesHandler,
  adminAttributeStatsHandler,
  adminAttributeUpdateHandler,
  adminAttributesListHandler,
  adminDeleteExpiredAttributesHandler,
  adminUserAttributesHandler,
  adminVerificationsListHandler,
} from '../admin-attributes';

function context(
  options: {
    query?: Record<string, string | undefined>;
    params?: Record<string, string | undefined>;
    body?: unknown;
    bodyError?: boolean;
  } = {}
) {
  return {
    req: {
      query: vi.fn((name: string) => options.query?.[name]),
      param: vi.fn((name: string) => options.params?.[name] ?? 'attr-1'),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

describe('admin attributes APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.audit.mockResolvedValue(undefined);
  });

  it('lists active attributes with filters, escaped search, and pagination', async () => {
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 51 }])
      .mockResolvedValueOnce([{ id: 'attr-1', user_id: 'user-1' }]);
    const response = await adminAttributesListHandler(
      context({
        query: {
          page: '2',
          limit: '25',
          user_id: 'user-1',
          attribute_name: 'department',
          source_type: 'manual',
          search: '100%_admin',
        },
      })
    );
    await expect(response.json()).resolves.toMatchObject({
      attributes: [{ id: 'attr-1' }],
      pagination: { page: 2, limit: 25, total: 51, total_pages: 3 },
    });
    expect(mocks.adapter.query).toHaveBeenLastCalledWith(
      expect.stringContaining('a.source_type = ?'),
      expect.arrayContaining(['user-1', 'department', 'manual', '%100\\%\\_admin%', 25, 25])
    );
  });

  it('can include expired attributes and defaults an absent count to zero', async () => {
    mocks.adapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const body = (await (
      await adminAttributesListHandler(context({ query: { include_expired: 'true' } }))
    ).json()) as { pagination: { total: number } };
    expect(body.pagination.total).toBe(0);
    expect(mocks.adapter.query.mock.calls[0][0]).not.toContain('expires_at IS NULL');
  });

  it('returns internal_error when listing fails', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('D1 unavailable'));
    expect((await adminAttributesListHandler(context())).status).toBe(500);
  });

  it.each([false, true])('gets a user and attributes (include expired=%s)', async (includeExpired) => {
    mocks.adapter.query
      .mockResolvedValueOnce([{ id: 'attr-1' }])
      .mockResolvedValueOnce([{ id: 'user-1', email: 'user@example.com', name: null }]);
    const body = (await (
      await adminUserAttributesHandler(
        context({
          params: { userId: 'user-1' },
          query: { include_expired: String(includeExpired) },
        })
      )
    ).json()) as { user: unknown };
    expect(body.user).toEqual(expect.objectContaining({ id: 'user-1' }));
    expect(mocks.adapter.query.mock.calls[0][0].includes('expires_at IS NULL')).toBe(!includeExpired);
  });

  it('returns null for a missing user and handles query errors', async () => {
    mocks.adapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect((await adminUserAttributesHandler(context())).json()).resolves.toMatchObject({
      user: null,
    });
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminUserAttributesHandler(context())).status).toBe(500);
  });

  it.each([
    [{}],
    [{ user_id: 'user-1', attribute_name: '', attribute_value: 'x' }],
    [{ user_id: 'user-1', attribute_name: 'department' }],
  ])('requires every create field %#', async (body) => {
    expect((await adminAttributeCreateHandler(context({ body }))).status).toBe(500);
    expect(mocks.adapter.query).not.toHaveBeenCalled();
  });

  it('does not create an attribute for a missing user', async () => {
    expect(
      (
        await adminAttributeCreateHandler(
          context({
            body: { user_id: 'missing', attribute_name: 'department', attribute_value: 'eng' },
          })
        )
      ).status
    ).toBe(404);
  });

  it('creates and audits a new manual attribute', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'user-1' }]);
    const response = await adminAttributeCreateHandler(
      context({
        body: {
          user_id: 'user-1',
          attribute_name: 'department',
          attribute_value: 'engineering',
          expires_at: 1_800_000_000,
        },
      })
    );
    expect(response.status).toBe(201);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO user_verified_attributes'),
      expect.arrayContaining(['attr-new', 'tenant-a', 'user-1', 'department', 'engineering'])
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'create',
      'user_attribute',
      'attr-new',
      expect.anything()
    );
  });

  it('updates an existing attribute instead of creating a duplicate', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'user-1' }]);
    mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'attr-existing', created_at: 1 });
    const body = (await (
      await adminAttributeCreateHandler(
        context({
          body: { user_id: 'user-1', attribute_name: 'department', attribute_value: 'sales' },
        })
      )
    ).json()) as { attribute: { id: string; expires_at: null } };
    expect(body.attribute).toMatchObject({ id: 'attr-existing', expires_at: null });
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE user_verified_attributes'),
      expect.any(Array)
    );
  });

  it('resolves a concurrent unique-key race by updating the winning row', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'user-1' }]);
    mocks.adapter.queryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'attr-raced', created_at: 1 });
    mocks.adapter.execute
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
      .mockResolvedValueOnce({ success: true });
    const body = (await (
      await adminAttributeCreateHandler(
        context({
          body: { user_id: 'user-1', attribute_name: 'department', attribute_value: 'sales' },
        })
      )
    ).json()) as { attribute: { id: string } };
    expect(body.attribute.id).toBe('attr-raced');
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new Error('write failure'), null],
    [new Error('UNIQUE constraint failed'), null],
  ])('returns internal_error for unresolved create failure %#', async (error, raced) => {
    mocks.adapter.query.mockResolvedValueOnce([{ id: 'user-1' }]);
    mocks.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(raced);
    mocks.adapter.execute.mockRejectedValueOnce(error);
    expect(
      (
        await adminAttributeCreateHandler(
          context({
            body: { user_id: 'user-1', attribute_name: 'department', attribute_value: 'sales' },
          })
        )
      ).status
    ).toBe(500);
  });

  it('returns internal_error for malformed create JSON', async () => {
    expect((await adminAttributeCreateHandler(context({ bodyError: true }))).status).toBe(500);
  });

  it('returns not found when updating a tenant-external attribute', async () => {
    expect((await adminAttributeUpdateHandler(context({ body: { attribute_value: 'x' } }))).status).toBe(
      404
    );
  });

  it('treats an empty update as a successful no-op', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ tenant_id: 'tenant-a', source_type: 'manual' }]);
    await expect((await adminAttributeUpdateHandler(context({ body: {} }))).json()).resolves.toEqual({
      success: true,
    });
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it.each([
    [{ attribute_value: 'new' }, "source_type = 'manual'"],
    [{ expires_at: null }, 'expires_at = ?'],
    [{ attribute_value: '', expires_at: 1_800_000_000 }, 'verified_at = ?'],
  ])('updates allowed fields and audits changes %#', async (body, sqlFragment) => {
    mocks.adapter.query.mockResolvedValueOnce([{ tenant_id: 'tenant-a', source_type: 'oidc' }]);
    expect((await adminAttributeUpdateHandler(context({ body }))).status).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining(sqlFragment),
      expect.any(Array)
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'update',
      'user_attribute',
      'attr-1',
      { changes: Object.keys(body) }
    );
  });

  it('returns internal_error when update parsing fails', async () => {
    expect((await adminAttributeUpdateHandler(context({ bodyError: true }))).status).toBe(500);
  });

  it('does not delete a missing attribute', async () => {
    expect((await adminAttributeDeleteHandler(context())).status).toBe(404);
  });

  it('deletes the tenant-scoped attribute and records its identity', async () => {
    mocks.adapter.query.mockResolvedValueOnce([
      { tenant_id: 'tenant-a', user_id: 'user-1', attribute_name: 'department' },
    ]);
    expect((await adminAttributeDeleteHandler(context())).status).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), [
      'attr-1',
      'tenant-a',
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'delete',
      'user_attribute',
      'attr-1',
      { user_id: 'user-1', attribute_name: 'department' }
    );
  });

  it('handles delete failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAttributeDeleteHandler(context())).status).toBe(500);
  });

  it('lists verification history with boolean and mapped-ID normalization', async () => {
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([
        {
          id: 'verification-1',
          holder_binding_verified: 1,
          issuer_trusted: 0,
          status_valid: 1,
          mapped_attribute_ids: '["attr-1"]',
        },
        {
          id: 'verification-2',
          holder_binding_verified: 0,
          issuer_trusted: 1,
          status_valid: 0,
          mapped_attribute_ids: null,
        },
      ]);
    const body = (await (
      await adminVerificationsListHandler(
        context({ query: { page: '2', limit: '1', user_id: 'user-1', result: 'verified' } })
      )
    ).json()) as { verifications: Array<Record<string, unknown>>; pagination: unknown };
    expect(body.verifications).toEqual([
      expect.objectContaining({
        holder_binding_verified: true,
        issuer_trusted: false,
        status_valid: true,
        mapped_attribute_ids: ['attr-1'],
      }),
      expect.objectContaining({ mapped_attribute_ids: [] }),
    ]);
    expect(body.pagination).toMatchObject({ page: 2, total_pages: 2 });
  });

  it('defaults missing verification counts and handles malformed stored JSON', async () => {
    mocks.adapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect((await adminVerificationsListHandler(context())).json()).resolves.toMatchObject({
      pagination: { total: 0 },
    });
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ mapped_attribute_ids: '{' }]);
    expect((await adminVerificationsListHandler(context())).status).toBe(500);
  });

  it('returns complete attribute statistics and defaults absent aggregates', async () => {
    mocks.adapter.query
      .mockResolvedValueOnce([{ count: 8 }])
      .mockResolvedValueOnce([{ count: 5 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ source_type: 'manual', count: 5 }])
      .mockResolvedValueOnce([{ attribute_name: 'department', count: 4 }])
      .mockResolvedValueOnce([{ count: 3 }])
      .mockResolvedValueOnce([{ verification_result: 'verified', count: 2 }]);
    await expect((await adminAttributeStatsHandler(context())).json()).resolves.toMatchObject({
      total: 8,
      active: 5,
      expired: 0,
      unique_users: 3,
      by_source: [{ source_type: 'manual', count: 5 }],
    });
  });

  it('handles stats failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAttributeStatsHandler(context())).status).toBe(500);
  });

  it.each([0, 3])('deletes expired attributes only when present (count=%s)', async (count) => {
    mocks.adapter.query.mockResolvedValueOnce(count ? [{ count }] : []);
    const body = (await (await adminDeleteExpiredAttributesHandler(context())).json()) as {
      deleted_count: number;
    };
    expect(body.deleted_count).toBe(count);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(count ? 1 : 0);
    expect(mocks.audit).toHaveBeenCalledTimes(count ? 1 : 0);
  });

  it('handles expired-attribute deletion failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminDeleteExpiredAttributesHandler(context())).status).toBe(500);
  });

  it('lists unique attribute names and handles failures', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ attribute_name: 'department', count: 3 }]);
    await expect((await adminAttributeNamesHandler(context())).json()).resolves.toEqual({
      attribute_names: [{ attribute_name: 'department', count: 3 }],
    });
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAttributeNamesHandler(context())).status).toBe(500);
  });
});
