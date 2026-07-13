import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  audit: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
  createAuditLog: mocks.audit,
  createLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
}));

import {
  adminAIGrantCreateHandler,
  adminAIGrantGetHandler,
  adminAIGrantRevokeHandler,
  adminAIGrantsListHandler,
  adminAIGrantUpdateHandler,
} from '../ai-grants';

function context(
  options: { query?: Record<string, string>; id?: string; body?: unknown; userId?: string } = {}
) {
  return {
    get: vi.fn((name: string) =>
      name === 'adminAuth' && options.userId ? { userId: options.userId } : null
    ),
    req: {
      query: vi.fn((name: string) => options.query?.[name]),
      param: vi.fn(() => options.id ?? 'grant-1'),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn((name: string) =>
        name === 'CF-Connecting-IP'
          ? '203.0.113.1'
          : name === 'User-Agent'
            ? 'test-agent'
            : undefined
      ),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant-1',
    tenant_id: 'tenant-a',
    client_id: 'client-1',
    ai_principal: 'agent:assistant',
    scopes: 'ai:read',
    scope_targets: '{"resource":"documents"}',
    is_active: 1,
    expires_at: null,
    created_by: 'admin-1',
    created_at: 100,
    updated_at: 100,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}

describe('AI grants admin APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.audit.mockResolvedValue(undefined);
  });

  it.each([
    [{}, [20, 0]],
    [
      {
        page: '2',
        limit: '500',
        client_id: 'client-1',
        ai_principal: '100%_agent',
        is_active: 'true',
      },
      [100, 100],
    ],
    [{ is_active: 'false' }, [20, 0]],
  ])('lists grants with tenant filters %#', async (query, pageTail) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ count: 21 });
    mocks.adapter.query.mockResolvedValueOnce([
      grant(),
      grant({ id: 'grant-2', scope_targets: '{', is_active: 0 }),
    ]);
    const body = (await (await adminAIGrantsListHandler(context({ query }))).json()) as {
      grants: Array<Record<string, unknown>>;
    };
    expect(body.grants).toEqual([
      expect.objectContaining({ scope_targets: { resource: 'documents' }, is_active: true }),
      expect.objectContaining({ scope_targets: null, is_active: false }),
    ]);
    expect(mocks.adapter.query.mock.calls[0][1]).toEqual(expect.arrayContaining(pageTail));
  });

  it('defaults missing grant count and handles list errors', async () => {
    await expect((await adminAIGrantsListHandler(context())).json()).resolves.toMatchObject({
      pagination: { total: 0 },
    });
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAIGrantsListHandler(context())).status).toBe(500);
  });

  it.each([null, grant({ scope_targets: null })])('gets grant result %#', async (row) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(row);
    const response = await adminAIGrantGetHandler(context());
    expect(response.status).toBe(row ? 200 : 404);
  });

  it('handles grant get errors', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAIGrantGetHandler(context())).status).toBe(500);
  });

  it.each([
    [{}],
    [{ client_id: 'client-1', ai_principal: 'agent', scopes: '' }],
    [{ client_id: 'x'.repeat(257), ai_principal: 'agent', scopes: 'ai:read' }],
    [{ client_id: 'client', ai_principal: 'x'.repeat(513), scopes: 'ai:read' }],
  ])('validates required and bounded create fields %#', async (body) => {
    expect((await adminAIGrantCreateHandler(context({ body }))).status).toBe(400);
  });

  it('validates grant expiry range', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const expires_at of [now, now + 366 * 24 * 60 * 60]) {
      expect(
        (
          await adminAIGrantCreateHandler(
            context({
              body: { client_id: 'client', ai_principal: 'agent', scopes: 'ai:read', expires_at },
            })
          )
        ).status
      ).toBe(400);
    }
  });

  it.each([' ', 'openid', 'ai:read bad', 'ai:Read'])(
    'rejects invalid scopes %s',
    async (scopes) => {
      expect(
        (
          await adminAIGrantCreateHandler(
            context({ body: { client_id: 'client', ai_principal: 'agent', scopes } })
          )
        ).status
      ).toBe(400);
    }
  );

  it.each([false, true])('creates grant with optional targets/expiry=%s', async (explicit) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(grant());
    const body = {
      client_id: 'client-1',
      ai_principal: 'agent:assistant',
      scopes: 'ai:read ai:execute',
      ...(explicit
        ? {
            scope_targets: { resource: 'documents' },
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }
        : {}),
    };
    const response = await adminAIGrantCreateHandler(
      context({ body, userId: explicit ? 'admin-1' : undefined })
    );
    expect(response.status).toBe(201);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        userId: explicit ? 'admin-1' : 'unknown',
        action: 'ai_grant.create',
        ipAddress: '203.0.113.1',
      })
    );
  });

  it.each([
    [new Error('UNIQUE constraint failed'), 409],
    [new Error('D1 unavailable'), 500],
  ])('maps create race/error %#', async (error, status) => {
    mocks.adapter.execute.mockRejectedValueOnce(error);
    expect(
      (
        await adminAIGrantCreateHandler(
          context({ body: { client_id: 'client', ai_principal: 'agent', scopes: 'ai:read' } })
        )
      ).status
    ).toBe(status);
  });

  it('does not update a missing grant', async () => {
    expect((await adminAIGrantUpdateHandler(context({ body: {} }))).status).toBe(404);
  });

  it.each([
    [{ scopes: 'bad' }],
    [{ expires_at: Math.floor(Date.now() / 1000) }],
    [{ expires_at: Math.floor(Date.now() / 1000) + 366 * 24 * 60 * 60 }],
  ])('rejects invalid grant update %#', async (body) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(grant());
    expect((await adminAIGrantUpdateHandler(context({ body }))).status).toBe(400);
  });

  it('updates all grant fields including null expiry/targets and inactive state', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce(grant())
      .mockResolvedValueOnce(
        grant({ scopes: 'ai:write', scope_targets: null, expires_at: null, is_active: 0 })
      );
    const response = await adminAIGrantUpdateHandler(
      context({
        body: { scopes: 'ai:write', scope_targets: null, expires_at: null, is_active: false },
        userId: 'admin-1',
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['ai:write', null, null, 0, 'grant-1', 'tenant-a'])
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'ai_grant.update' })
    );
  });

  it('supports timestamp-only no-op update and handles persistence errors', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(grant()).mockResolvedValueOnce(grant());
    expect((await adminAIGrantUpdateHandler(context({ body: {} }))).status).toBe(200);
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAIGrantUpdateHandler(context({ body: {} }))).status).toBe(500);
  });

  it.each([
    [null, 404],
    [grant({ revoked_at: 100 }), 400],
    [grant(), 200],
  ])('revokes grant result %#', async (existing, status) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(existing);
    const response = await adminAIGrantRevokeHandler(context({ userId: 'admin-1' }));
    expect(response.status).toBe(status);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
    expect(mocks.audit).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });

  it('uses null revoker without admin context and handles revoke errors', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(grant());
    expect((await adminAIGrantRevokeHandler(context())).status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][1][1]).toBe(null);
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminAIGrantRevokeHandler(context())).status).toBe(500);
  });
});
