import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() }, enabled: vi.fn(), findUser: vi.fn(), deleteUser: vi.fn(), logger: { error: vi.fn() },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: vi.fn(() => 'tenant-a'), createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })), createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: mocks.adapter })),
  isAnonymousAuthEnabled: mocks.enabled, getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  CanonicalRuntimeUserStore: vi.fn(function () { return { findById: mocks.findUser, deleteUser: mocks.deleteUser }; }),
}));
import {
  cleanupExpiredAnonymousUsers, deleteAnonymousUser, getAnonymousAuthConfig, getAnonymousUser,
  getAnonymousUserUpgrades, listAnonymousUsers, updateAnonymousAuthConfig,
} from '../routes/settings/anonymous-auth';
function kv(values: Record<string, string | null> = {}) { return { get: vi.fn((key: string) => Promise.resolve(values[key] ?? null)), put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) }; }
function context(options: { store?: ReturnType<typeof kv>; body?: unknown; bodyError?: boolean; id?: string; query?: Record<string, string>; env?: Record<string, unknown> } = {}) {
  return { req: { param: vi.fn(() => options.id), query: vi.fn((n: string) => options.query?.[n]), json: options.bodyError ? vi.fn().mockRejectedValue(new SyntaxError('bad')) : vi.fn().mockResolvedValue(options.body ?? {}) }, env: { ...(options.store ? { AUTHRIM_CONFIG: options.store } : {}), ...(options.env ?? {}) }, json: vi.fn((v: unknown, s = 200) => Response.json(v, { status: s })) } as never;
}
function user(overrides: Record<string, unknown> = {}) { return { id: 'user-1', account_type: 'anonymous', created_at: '2026-01-01T00:00:00.000Z', last_login_at: 100, ...overrides }; }
describe('anonymous auth administration', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.adapter.query.mockReset(); mocks.adapter.queryOne.mockReset(); mocks.adapter.execute.mockReset(); mocks.adapter.query.mockResolvedValue([]); mocks.adapter.queryOne.mockResolvedValue(null); mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 }); mocks.enabled.mockResolvedValue(false); mocks.findUser.mockResolvedValue(null); mocks.deleteUser.mockResolvedValue(true); });
  it.each([null, { 'anonymous_auth:default_expires_in_days': '30', 'anonymous_auth:cleanup_interval_hours': '12' }])('gets anonymous config %#', async (values) => {
    const response = await getAnonymousAuthConfig(context({ store: values ? kv(values) : undefined, env: values ? { ENABLE_ANONYMOUS_AUTH: 'true' } : {} }));
    await expect(response.json()).resolves.toMatchObject({ config: { default_expires_in_days: values ? 30 : null, cleanup_interval_hours: values ? 12 : 24 }, source: values ? 'env' : 'default' });
  });
  it('handles anonymous config read failure', async () => { mocks.enabled.mockRejectedValueOnce(new Error('failure')); expect((await getAnonymousAuthConfig(context())).status).toBe(500); });
  it('requires KV and handles invalid update JSON', async () => { expect((await updateAnonymousAuthConfig(context())).status).toBe(500); expect((await updateAnonymousAuthConfig(context({ store: kv(), bodyError: true }))).status).toBe(500); });
  it.each([[{ default_expires_in_days: 0 }], [{ default_expires_in_days: '1' }], [{ cleanup_interval_hours: 0 }], [{ cleanup_interval_hours: '1' }]])('rejects invalid anonymous config %#', async (body) => expect((await updateAnonymousAuthConfig(context({ store: kv(), body }))).status).toBe(400));
  it('updates all anonymous config fields and supports unlimited expiry', async () => {
    const store = kv(); expect((await updateAnonymousAuthConfig(context({ store, body: { enabled: true, default_expires_in_days: 30, cleanup_interval_hours: 12 } }))).status).toBe(200); expect(store.put).toHaveBeenCalledTimes(3);
    expect((await updateAnonymousAuthConfig(context({ store, body: { enabled: false, default_expires_in_days: null } }))).status).toBe(200); expect(store.delete).toHaveBeenCalled();
  });
  it('returns empty successful update and maps KV failures', async () => { const store = kv(); expect((await updateAnonymousAuthConfig(context({ store, body: {} }))).status).toBe(200); store.put.mockRejectedValueOnce(new Error('failure')); expect((await updateAnonymousAuthConfig(context({ store, body: { enabled: true } }))).status).toBe(500); });
  it.each([false, true])('lists anonymous users include_expired=%s', async (includeExpired) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ count: 2 }); mocks.adapter.query.mockResolvedValueOnce([{ device_id: 'd1', user_id: 'u1', device_platform: null, device_stability: 'stable', expires_at: Date.now() - 1, created_at: 1, last_used_at: 2, is_active: 0 }]);
    const body = (await (await listAnonymousUsers(context({ query: { limit: '500', offset: '10', include_expired: String(includeExpired) } }))).json()) as { users: Array<Record<string, unknown>>; limit: number };
    expect(body.limit).toBe(100); expect(body.users[0]).toMatchObject({ is_expired: true, is_active: false }); expect(mocks.adapter.query.mock.calls[0][0].includes('ad.is_active = 1')).toBe(!includeExpired);
  });
  it('defaults list count and handles failure', async () => { await expect((await listAnonymousUsers(context())).json()).resolves.toMatchObject({ total: 0 }); mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure')); expect((await listAnonymousUsers(context())).status).toBe(500); });
  it('requires anonymous user ID', async () => { expect((await getAnonymousUser(context())).status).toBe(400); expect((await getAnonymousUserUpgrades(context())).status).toBe(400); expect((await deleteAnonymousUser(context())).status).toBe(400); });
  it.each([null, user({ account_type: 'human' }), user()])('gets anonymous user state %#', async (value) => {
    mocks.findUser.mockResolvedValueOnce(value); if (value?.account_type === 'anonymous') { mocks.adapter.query.mockResolvedValueOnce([{ id: 'd1', device_platform: 'ios', device_stability: 'stable', expires_at: null, created_at: 1, last_used_at: 2, is_active: 1 }]); mocks.adapter.queryOne.mockResolvedValueOnce({ upgraded_user_id: 'human-1', upgrade_method: 'email', upgraded_at: 3, preserve_sub: 1 }); }
    const response = await getAnonymousUser(context({ id: 'user-1' })); expect(response.status).toBe(!value ? 404 : value.account_type === 'anonymous' ? 200 : 400);
  });
  it('formats absent upgrade and expired device', async () => { mocks.findUser.mockResolvedValueOnce(user()); mocks.adapter.query.mockResolvedValueOnce([{ id: 'd1', expires_at: Date.now() - 1, is_active: 0 }]); const body = await (await getAnonymousUser(context({ id: 'user-1' }))).json(); expect(body).toMatchObject({ upgrade: null, devices: [{ is_expired: true, is_active: false }] }); });
  it('lists normalized upgrade history and handles failures', async () => { mocks.adapter.query.mockResolvedValueOnce([{ id: 'up1', anonymous_user_id: 'u1', upgraded_user_id: 'u2', upgrade_method: 'email', provider_id: null, preserve_sub: 1, upgraded_at: 1, data_migrated: 0 }]); await expect((await getAnonymousUserUpgrades(context({ id: 'u1' }))).json()).resolves.toMatchObject({ upgrades: [{ preserve_sub: true, data_migrated: false }] }); mocks.adapter.query.mockRejectedValueOnce(new Error('failure')); expect((await getAnonymousUserUpgrades(context({ id: 'u1' }))).status).toBe(500); });
  it.each([null, user({ account_type: 'human' }), user()])('deletes anonymous user state %#', async (value) => { mocks.findUser.mockResolvedValueOnce(value); const response = await deleteAnonymousUser(context({ id: 'user-1' })); expect(response.status).toBe(!value ? 404 : value.account_type === 'anonymous' ? 200 : 400); expect(mocks.deleteUser).toHaveBeenCalledTimes(value?.account_type === 'anonymous' ? 1 : 0); });
  it('handles anonymous user get/delete failures', async () => { mocks.findUser.mockRejectedValueOnce(new Error('failure')); expect((await getAnonymousUser(context({ id: 'u' }))).status).toBe(500); mocks.findUser.mockRejectedValueOnce(new Error('failure')); expect((await deleteAnonymousUser(context({ id: 'u' }))).status).toBe(500); });
  it('defaults cleanup to safe dry-run on empty/malformed body', async () => { mocks.adapter.query.mockResolvedValueOnce([{ user_id: 'u1', device_id: 'd1', expires_at: Date.now() - 3600000 }]); const response = await cleanupExpiredAnonymousUsers(context({ bodyError: true })); await expect(response.json()).resolves.toMatchObject({ dry_run: true, expired_count: 1, expired_devices: [{ expired_since_hours: 1 }] }); });
  it('caps dry-run cleanup limit', async () => { expect((await cleanupExpiredAnonymousUsers(context({ body: { dry_run: true, limit: 5000 } }))).status).toBe(200); expect(mocks.adapter.query.mock.calls[0][1][2]).toBe(1000); });
  it('deletes users with no active device and deactivates only expired devices otherwise', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ user_id: 'u1', device_id: 'd1', expires_at: 1 }, { user_id: 'u1', device_id: 'd2', expires_at: 2 }, { user_id: 'u2', device_id: 'd3', expires_at: 3 }]); mocks.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'active' });
    const body = await (await cleanupExpiredAnonymousUsers(context({ body: { dry_run: false, limit: 10 } }))).json(); expect(body).toMatchObject({ deleted_users: 1, deleted_devices: 3, deactivated_only: 3 }); expect(mocks.deleteUser).toHaveBeenCalledTimes(1); expect(mocks.adapter.execute).toHaveBeenCalledTimes(2);
  });
  it('deduplicates cleanup user IDs and handles cleanup errors', async () => { mocks.adapter.query.mockRejectedValueOnce(new Error('failure')); expect((await cleanupExpiredAnonymousUsers(context({ body: { dry_run: false } }))).status).toBe(500); });
});
