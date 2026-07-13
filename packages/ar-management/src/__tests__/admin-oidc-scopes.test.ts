import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { queryOne: vi.fn(), query: vi.fn(), execute: vi.fn() },
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  };
});

import {
  adminOidcScopeCreateHandler,
  adminOidcScopeDeleteHandler,
  adminOidcScopeUpdateHandler,
  adminOidcScopesListHandler,
} from '../admin-oidc-scopes';

function context(body: unknown = {}, id = 'scope-1') {
  return {
    req: {
      json: vi.fn().mockResolvedValue(body),
      param: vi.fn((name: string) => (name === 'id' ? id : undefined)),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'scope-1',
    tenant_id: 'tenant-a',
    name: 'department:read',
    display_name: 'Read department',
    description: null,
    scope_type: 'custom',
    enabled: 1,
    localizations_json: null,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

describe('admin OIDC scope management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  });

  it('idempotently creates only missing system scopes before listing', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce({ id: 'openid' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mocks.adapter.query.mockResolvedValueOnce([
      row({
        id: 'openid',
        name: 'openid',
        scope_type: 'system',
        localizations_json: JSON.stringify({ ja: { display_name: 'OpenID' } }),
      }),
    ]);
    const response = await adminOidcScopesListHandler(context());
    const body = (await response.json()) as { scopes: Array<Record<string, unknown>> };
    expect(body.scopes[0]).toMatchObject({
      id: 'openid',
      enabled: 1,
      localizations: { ja: { display_name: 'OpenID' } },
    });
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(2);
  });

  it.each([
    [null, {}],
    [undefined, {}],
    ['', {}],
    ['{', {}],
    [42, {}],
    [{ en: { display_name: 'Name' } }, { en: { display_name: 'Name' } }],
  ])('normalizes stored localization value=%o', async (stored, expected) => {
    mocks.adapter.queryOne.mockResolvedValue({ id: 'existing' });
    mocks.adapter.query.mockResolvedValueOnce([row({ localizations_json: stored })]);
    const body = (await (await adminOidcScopesListHandler(context())).json()) as {
      scopes: Array<{ localizations: unknown }>;
    };
    expect(body.scopes[0]?.localizations).toEqual(expected);
  });

  it('returns server_error when default scope initialization fails', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('D1 unavailable'));
    expect((await adminOidcScopesListHandler(context())).status).toBe(500);
  });

  it.each([
    [{}, 'Invalid scope name'],
    [{ name: 'bad scope', display_name: 'Bad' }, 'Invalid scope name'],
    [{ name: '-bad', display_name: 'Bad' }, 'Invalid scope name'],
    [{ name: 'x'.repeat(129), display_name: 'Bad' }, 'Invalid scope name'],
    [{ name: 'custom' }, 'display_name is required'],
    [{ name: 'custom', display_name: ' ', scope_type: 'custom' }, 'display_name is required'],
    [{ name: 'custom', display_name: 'Custom', scope_type: 'other' }, 'Invalid scope_type'],
  ])('rejects invalid custom scope %#', async (input, error) => {
    const response = await adminOidcScopeCreateHandler(context(input));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error_description: error });
  });

  it.each([
    [undefined, true, 'custom'],
    [false, false, 'system'],
    [0, false, 'custom'],
    [1, true, 'custom'],
    ['unexpected', true, 'custom'],
  ])('creates enabled=%o scope_type=%s', async (enabled, expected, scopeType) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(
      row({ enabled: expected, scope_type: scopeType, description: 'Description' })
    );
    const response = await adminOidcScopeCreateHandler(
      context({
        name: ' department:read ',
        display_name: ' Read department ',
        description: ' Description ',
        scope_type: scopeType,
        enabled,
        localizations: { ja: { display_name: '部署の参照' } },
      })
    );
    expect(response.status).toBe(201);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oidc_scopes'),
      expect.arrayContaining([
        'tenant-a',
        'department:read',
        'Read department',
        'Description',
        scopeType,
        expected ? 1 : 0,
      ])
    );
  });

  it('accepts only object localization input and returns null if refresh misses', async () => {
    const response = await adminOidcScopeCreateHandler(
      context({ name: 'custom', display_name: 'Custom', localizations: [] })
    );
    await expect(response.json()).resolves.toEqual({ scope: null });
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([JSON.stringify({})])
    );
  });

  it('returns server_error for create persistence failure', async () => {
    mocks.adapter.execute.mockRejectedValueOnce(new Error('insert failed'));
    expect(
      (await adminOidcScopeCreateHandler(context({ name: 'custom', display_name: 'Custom' })))
        .status
    ).toBe(500);
  });

  it('does not update a missing or cross-tenant scope', async () => {
    expect((await adminOidcScopeUpdateHandler(context({ display_name: 'New' }))).status).toBe(404);
  });

  it.each([
    [{}, 'No fields to update'],
    [{ display_name: '' }, 'display_name is required'],
  ])('rejects invalid update %#', async (body, error) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'scope-1' });
    const response = await adminOidcScopeUpdateHandler(context(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error_description: error });
  });

  it('updates all mutable fields and normalizes values', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce({ id: 'scope-1' })
      .mockResolvedValueOnce(row({ display_name: 'Updated', enabled: 0 }));
    const response = await adminOidcScopeUpdateHandler(
      context({
        display_name: ' Updated ',
        description: 42,
        enabled: 0,
        localizations: null,
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('localizations_json = ?'),
      expect.arrayContaining(['Updated', null, 0, JSON.stringify({}), 'tenant-a', 'scope-1'])
    );
  });

  it('returns null when updated row disappears and server_error for query failures', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ id: 'scope-1' }).mockResolvedValueOnce(null);
    await expect(
      (await adminOidcScopeUpdateHandler(context({ enabled: true }))).json()
    ).resolves.toEqual({ scope: null });
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('query failed'));
    expect((await adminOidcScopeUpdateHandler(context({ enabled: true }))).status).toBe(500);
  });

  it('returns not_found for missing scope and protects system scopes', async () => {
    expect((await adminOidcScopeDeleteHandler(context())).status).toBe(404);
    mocks.adapter.queryOne.mockResolvedValueOnce({ scope_type: 'system' });
    expect((await adminOidcScopeDeleteHandler(context())).status).toBe(400);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('deletes a custom scope only inside the tenant', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ scope_type: 'custom' });
    const response = await adminOidcScopeDeleteHandler(context());
    expect(response.status).toBe(200);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      'DELETE FROM oidc_scopes WHERE tenant_id = ? AND id = ?',
      ['tenant-a', 'scope-1']
    );
  });

  it('returns server_error for delete failures', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('query failed'));
    expect((await adminOidcScopeDeleteHandler(context())).status).toBe(500);
  });
});
