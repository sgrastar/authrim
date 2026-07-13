import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn() },
  config: vi.fn(),
  validate: vi.fn(),
  mappingCounts: vi.fn(),
  logger: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getEmailDomainHashConfig: mocks.config,
  validateDomainHashConfig: mocks.validate,
  getMappingCountByVersion: mocks.mappingCounts,
  ensureDatabaseAdapter: vi.fn((db) => db),
  createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
  getTenantIdFromContext: vi.fn(() => 'tenant-a'),
  getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
}));
import {
  completeDomainHashKeyRotation,
  deleteDomainHashKeyVersion,
  getDomainHashKeysConfig,
  getDomainHashKeyStatus,
  rotateDomainHashKey,
} from '../routes/settings/domain-hash-keys';
function kv() {
  return { put: vi.fn().mockResolvedValue(undefined) };
}
function context(
  o: {
    store?: ReturnType<typeof kv>;
    body?: unknown;
    version?: string;
    env?: Record<string, unknown>;
  } = {}
) {
  return {
    req: { json: vi.fn().mockResolvedValue(o.body ?? {}), param: vi.fn(() => o.version) },
    env: { ...(o.store ? { SETTINGS: o.store } : {}), ...(o.env ?? {}) },
    json: vi.fn((v: unknown, s = 200) => Response.json(v, { status: s })),
  } as never;
}
function config(overrides: Record<string, unknown> = {}) {
  return {
    current_version: 2,
    secrets: { 1: '1234567890abcdef', 2: 'abcdefghijklmnop' },
    migration_in_progress: true,
    deprecated_versions: [1],
    version: '1',
    ...overrides,
  };
}
describe('domain hash key rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.config.mockReset();
    mocks.config.mockResolvedValue(config());
    mocks.validate.mockReturnValue([]);
    mocks.mappingCounts.mockResolvedValue({ 1: 2, 2: 3 });
  });
  it('masks secrets and reports source', async () => {
    const b = (await (await getDomainHashKeysConfig(context({ store: kv() }))).json()) as any;
    expect(b.secrets).toEqual({ 1: '1234...cdef', 2: 'abcd...mnop' });
    expect(b.source).toBe('kv');
    mocks.config.mockResolvedValueOnce(config({ secrets: { 1: 'short' } }));
    expect(((await (await getDomainHashKeysConfig(context())).json()) as any).secrets[1]).toBe(
      '****'
    );
  });
  it('returns unconfigured status when config loading fails', async () => {
    mocks.config.mockRejectedValueOnce(new Error('missing'));
    await expect((await getDomainHashKeysConfig(context())).json()).resolves.toMatchObject({
      source: 'none',
      current_version: 1,
    });
  });
  it.each(['', 'short'])('validates rotation secret %s', async (new_secret) =>
    expect((await rotateDomainHashKey(context({ body: { new_secret }, store: kv() }))).status).toBe(
      400
    )
  );
  it('requires KV for rotation', async () =>
    expect(
      (await rotateDomainHashKey(context({ body: { new_secret: '1234567890abcdef' } }))).status
    ).toBe(500));
  it('rotates existing key and starts migration', async () => {
    const store = kv();
    const r = await rotateDomainHashKey(
      context({ store, body: { new_secret: 'new-secret-123456' } })
    );
    await expect(r.json()).resolves.toMatchObject({ new_version: 3, migration_in_progress: true });
    const saved = JSON.parse(store.put.mock.calls[0][1]);
    expect(saved.secrets[3]).toBe('new-secret-123456');
  });
  it.each([undefined, 'env-secret-123456'])(
    'creates first key without migration env=%s',
    async (secret) => {
      mocks.config.mockRejectedValueOnce(new Error('none'));
      const store = kv();
      const r = await rotateDomainHashKey(
        context({
          store,
          body: { new_secret: 'new-secret-123456' },
          env: { EMAIL_DOMAIN_HASH_SECRET: secret },
        })
      );
      const b = (await r.json()) as any;
      expect(b.new_version).toBe(secret ? 2 : 1);
      expect(b.migration_in_progress).toBe(Boolean(secret));
    }
  );
  it('rejects invalid generated config and sanitizes write failure', async () => {
    mocks.validate.mockReturnValueOnce(['invalid']);
    expect(
      (
        await rotateDomainHashKey(
          context({ store: kv(), body: { new_secret: 'new-secret-123456' } })
        )
      ).status
    ).toBe(400);
    const store = kv();
    store.put.mockRejectedValueOnce(new Error('secret'));
    const r = await rotateDomainHashKey(
      context({ store, body: { new_secret: 'new-secret-123456' } })
    );
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain('secret');
  });
  it('requires KV/active migration for completion', async () => {
    expect((await completeDomainHashKeyRotation(context({ body: {} }))).status).toBe(500);
    mocks.config.mockResolvedValueOnce(config({ migration_in_progress: false }));
    expect((await completeDomainHashKeyRotation(context({ store: kv(), body: {} }))).status).toBe(
      400
    );
  });
  it('completes rotation with deduplicated old versions excluding current', async () => {
    const store = kv();
    const r = await completeDomainHashKeyRotation(
      context({ store, body: { deprecate_versions: [1, 1, 2] } })
    );
    await expect(r.json()).resolves.toMatchObject({ current_version: 2, deprecated_versions: [1] });
    expect(JSON.parse(store.put.mock.calls[0][1]).migration_in_progress).toBe(false);
  });
  it('handles completion failure', async () => {
    mocks.config.mockRejectedValueOnce(new Error('failure'));
    expect((await completeDomainHashKeyRotation(context({ store: kv(), body: {} }))).status).toBe(
      500
    );
  });
  it('reports no-config status', async () => {
    mocks.config.mockRejectedValueOnce(new Error('none'));
    await expect((await getDomainHashKeyStatus(context())).json()).resolves.toMatchObject({
      current_version: 0,
      migration_in_progress: false,
    });
  });
  it('reports counts and migration estimate', async () => {
    mocks.adapter.query.mockResolvedValueOnce([
      { email_domain_hash_version: null, count: 4 },
      { email_domain_hash_version: 2, count: 6 },
    ]);
    const b = (await (await getDomainHashKeyStatus(context())).json()) as any;
    expect(b.users_by_version).toEqual({ 1: 4, 2: 6 });
    expect(b.estimated_completion).toEqual(expect.any(String));
    expect(b.org_mappings_by_version).toEqual({ 1: 2, 2: 3 });
  });
  it.each([
    config({ migration_in_progress: false }),
    config({ migration_in_progress: true, current_version: 2 }),
  ])('omits estimate when complete/all migrated %#', async (cfg) => {
    mocks.config.mockResolvedValueOnce(cfg);
    mocks.adapter.query.mockResolvedValueOnce([{ email_domain_hash_version: 2, count: 5 }]);
    expect(
      ((await (await getDomainHashKeyStatus(context())).json()) as any).estimated_completion
    ).toBeUndefined();
  });
  it('handles status DB failure', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect((await getDomainHashKeyStatus(context())).status).toBe(500);
  });
  it.each(['bad', '2', '3'])('validates deletion version %s', async (version) => {
    if (version === '2') mocks.config.mockResolvedValueOnce(config());
    if (version === '3') mocks.config.mockResolvedValueOnce(config());
    const r = await deleteDomainHashKeyVersion(context({ store: kv(), version }));
    expect(r.status).toBe(400);
  });
  it('requires KV for deletion', async () =>
    expect((await deleteDomainHashKeyVersion(context({ version: '1' }))).status).toBe(500));
  it('does not delete version still used by users or expose count', async () => {
    mocks.adapter.query.mockResolvedValueOnce([{ email_domain_hash_version: 1, count: 7 }]);
    const r = await deleteDomainHashKeyVersion(context({ store: kv(), version: '1' }));
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).not.toContain('7');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userCount: 7 })
    );
  });
  it('deletes unused deprecated version', async () => {
    const store = kv();
    const r = await deleteDomainHashKeyVersion(context({ store, version: '1' }));
    await expect(r.json()).resolves.toMatchObject({ remaining_versions: [2] });
    expect(JSON.parse(store.put.mock.calls[0][1])).toMatchObject({
      deprecated_versions: [],
      secrets: { 2: 'abcdefghijklmnop' },
    });
  });
  it('handles deletion failure', async () => {
    mocks.config.mockRejectedValueOnce(new Error('failure'));
    expect((await deleteDomainHashKeyVersion(context({ store: kv(), version: '1' }))).status).toBe(
      500
    );
  });
});
