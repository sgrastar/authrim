import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
  getTenantMetadataContextFromHono: vi.fn((c) => c.get('tenantMetadataContext')),
  getTenantIdFromContext: vi.fn(() => 'fallback-tenant'),
  getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
}));
import {
  createCheckApiKey,
  deleteCheckApiKey,
  getCheckApiKey,
  listCheckApiKeys,
  rotateCheckApiKey,
} from '../routes/settings/check-api-keys';
function context(
  options: {
    body?: unknown;
    id?: string;
    query?: Record<string, string>;
    tenantId?: string;
    adminId?: string;
    configured?: boolean;
  } = {}
) {
  const store = new Map<string, unknown>();
  if (options.tenantId) store.set('tenant_id', options.tenantId);
  if (options.adminId) store.set('admin_user_id', options.adminId);
  if (options.configured !== false) {
    store.set('tenantMetadataContext', {
      tenantId: options.tenantId ?? 'fallback-tenant',
      coreDb: {},
    });
  }
  return {
    get: vi.fn((k: string) => store.get(k)),
    req: {
      param: vi.fn(() => options.id ?? 'key-1'),
      query: vi.fn((n: string) => options.query?.[n]),
      json: vi.fn().mockResolvedValue(options.body ?? {}),
    },
    env: {},
    json: vi.fn((v: unknown, s = 200) => Response.json(v, { status: s })),
  } as never;
}
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    tenant_id: 'tenant-a',
    client_id: 'client-1',
    name: 'Primary',
    key_prefix: 'chk_abcd',
    allowed_operations: '["check"]',
    rate_limit_tier: 'moderate',
    is_active: 1,
    expires_at: null,
    created_by: null,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}
describe('check API key CRUD', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  });
  it.each([
    createCheckApiKey,
    listCheckApiKeys,
    getCheckApiKey,
    deleteCheckApiKey,
    rotateCheckApiKey,
  ])('requires configured core DB %#', async (handler) => {
    expect((await handler(context({ configured: false, tenantId: 'tenant-a' }))).status).toBe(503);
    const c: any = context({ configured: true });
    expect((await handler(c)).status).not.toBe(503);
    c.env = {};
    c.get.mockImplementation(() => undefined);
    expect((await handler(c)).status).toBe(503);
  });
  it.each([[{}], [{ client_id: 'c', name: '', allowed_operations: ['check'] }]])(
    'requires create fields %#',
    async (body) =>
      expect((await createCheckApiKey(context({ body, tenantId: 'tenant-a' }))).status).toBe(400)
  );
  it.each([[['bad']], [['check', 'bad']]])(
    'rejects invalid operations %#',
    async (allowed_operations) =>
      expect(
        (
          await createCheckApiKey(
            context({ body: { client_id: 'c', name: 'Key', allowed_operations } })
          )
        ).status
      ).toBe(400)
  );
  it.each(['bad', 'loadTest'])('rejects rate tier %s', async (rate_limit_tier) =>
    expect(
      (await createCheckApiKey(context({ body: { client_id: 'c', name: 'Key', rate_limit_tier } })))
        .status
    ).toBe(400)
  );
  it('rejects expired key', async () => {
    expect(
      (await createCheckApiKey(context({ body: { client_id: 'c', name: 'Key', expires_at: 1 } })))
        .status
    ).toBe(400);
  });
  it.each([false, true])('creates cryptographic key with explicit options=%s', async (explicit) => {
    const response = await createCheckApiKey(
      context({
        tenantId: 'tenant-a',
        adminId: explicit ? 'admin-1' : undefined,
        body: {
          client_id: 'client-1',
          name: ' Primary ',
          ...(explicit
            ? {
                allowed_operations: ['check', 'batch', 'subscribe'],
                rate_limit_tier: 'strict',
                expires_at: Math.floor(Date.now() / 1000) + 3600,
              }
            : {}),
        },
      })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.api_key).toMatch(/^chk_[0-9a-f]{64}$/);
    expect(body.key_prefix).toHaveLength(8);
    expect(JSON.stringify(mocks.adapter.execute.mock.calls)).not.toContain(body.api_key);
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['tenant-a', 'client-1', 'Primary'])
    );
  });
  it('handles create persistence failure without exposing details', async () => {
    mocks.adapter.execute.mockRejectedValueOnce(new Error('secret detail'));
    const r = await createCheckApiKey(context({ body: { client_id: 'c', name: 'Key' } }));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('secret detail');
  });
  it.each([
    [{}, 1, 20],
    [{ page: '0', limit: '0', client_id: 'c', is_active: 'true' }, 1, 1],
    [{ page: '2', limit: '999', is_active: 'false' }, 2, 100],
  ])('lists keys %#', async (query, page, limit) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ total: 2 });
    mocks.adapter.query.mockResolvedValueOnce([
      row(),
      row({ id: 'key-2', is_active: 0, expires_at: 200, created_by: 'admin' }),
    ]);
    const b = (await (
      await listCheckApiKeys(context({ query, tenantId: 'tenant-a' }))
    ).json()) as any;
    expect(b).toMatchObject({ total: 2, page, limit });
    expect(b.keys[0]).not.toHaveProperty('key_hash');
    expect(b.keys[1]).toMatchObject({ is_active: false, expires_at: 200, created_by: 'admin' });
  });
  it('defaults list total and handles malformed stored operations/error', async () => {
    await expect((await listCheckApiKeys(context())).json()).resolves.toMatchObject({ total: 0 });
    mocks.adapter.query.mockResolvedValueOnce([row({ allowed_operations: '{' })]);
    expect((await listCheckApiKeys(context())).status).toBe(500);
  });
  it.each([null, row()])('gets key result %#', async (value) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(value);
    const r = await getCheckApiKey(context());
    expect(r.status).toBe(value ? 200 : 404);
  });
  it('handles get error', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await getCheckApiKey(context())).status).toBe(500);
  });
  it.each([0, 1])('revokes key rowsAffected=%s', async (rowsAffected) => {
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected });
    const r = await deleteCheckApiKey(context());
    expect(r.status).toBe(rowsAffected ? 200 : 404);
  });
  it('handles revoke error', async () => {
    mocks.adapter.execute.mockRejectedValueOnce(new Error('failure'));
    expect((await deleteCheckApiKey(context())).status).toBe(500);
  });
  it('returns 404 for missing/inactive rotation source', async () => {
    expect((await rotateCheckApiKey(context())).status).toBe(404);
  });
  it('rotates key with expiry/admin and returns plaintext once', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({
      id: 'key-1',
      client_id: 'c',
      name: 'Primary',
      allowed_operations: '["check"]',
      rate_limit_tier: 'lenient',
      expires_at: 200,
    });
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    const r = await rotateCheckApiKey(context({ adminId: 'admin-1' }));
    expect(r.status).toBe(201);
    const b = (await r.json()) as any;
    expect(b).toMatchObject({ name: 'Primary (rotated)', expires_at: 200 });
    expect(JSON.stringify(mocks.adapter.execute.mock.calls)).not.toContain(b.api_key);
  });
  it('rolls back replacement on rotation race and handles errors', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({
      id: 'key-1',
      client_id: 'c',
      name: 'Primary',
      allowed_operations: '["check"]',
      rate_limit_tier: 'moderate',
      expires_at: null,
    });
    mocks.adapter.execute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockResolvedValueOnce({ rowsAffected: 0 })
      .mockResolvedValueOnce({ rowsAffected: 1 });
    expect((await rotateCheckApiKey(context())).status).toBe(409);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(3);
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await rotateCheckApiKey(context())).status).toBe(500);
  });
});
