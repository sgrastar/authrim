import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Context } from 'hono';
import { GuestLifecycleRepository, type DatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
const mocks = vi.hoisted(() => ({
  sources: vi.fn(),
  source: vi.fn(),
  settings: vi.fn(),
  audit: vi.fn(),
  tenantAccess: vi.fn(),
  permission: vi.fn(),
}));
vi.mock('../routes/settings-v2', () => ({
  canAccessTenant: mocks.tenantAccess,
  hasTenantSettingsPermission: mocks.permission,
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: (c: { env: { testTenant: string } }) => c.env.testTenant,
  resolveTenantAssignedDatabaseSourcesFromRegistry: mocks.sources,
  resolveTenantDatabaseSourceFromRegistry: mocks.source,
  resolveGuestSettings: mocks.settings,
  createAuditLog: mocks.audit,
  ensureDatabaseAdapter: (adapter: unknown) => adapter,
}));
import {
  previewGuestRetentionHandler,
  applyGuestRetentionHandler,
  listGuestLifecycleHandler,
} from '../admin-guest-retention';

describe('existing guest retention preview and apply', () => {
  let db: SQLiteDatabase;
  let adapter: DatabaseAdapter;
  let lifecycle: GuestLifecycleRepository;
  let store: Map<string, string>;
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(200000000);
    store = new Map();
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE identity_accounts (tenant_id TEXT, legacy_user_id TEXT, account_type TEXT, deleted_at INTEGER);
    INSERT INTO identity_accounts VALUES ('tenant', 'a', 'anonymous', NULL), ('tenant', 'b', 'anonymous', NULL), ('other', 'a', 'anonymous', NULL);`);
    db.exec(
      readFileSync(
        new URL('../../../../migrations/core/d1/002_guest_account_lifecycle.sql', import.meta.url),
        'utf8'
      )
    );
    adapter = {
      async query<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
      },
      async queryOne<T>(sql: string, params: unknown[] = []) {
        return (db.prepare(sql).get(...(params as SQLInputValue[])) ?? null) as T | null;
      },
      async execute(sql: string, params: unknown[] = []) {
        return {
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
        };
      },
    } as DatabaseAdapter;
    lifecycle = new GuestLifecycleRepository(adapter, 'tenant');
    for (const userId of ['a', 'b'])
      await lifecycle.enroll({
        userId,
        clientId: 'client',
        createdAt: 100,
        deletionAfterDays: null,
        policyVersion: 'old',
      });
    await new GuestLifecycleRepository(adapter, 'other').enroll({
      userId: 'a',
      clientId: 'client',
      createdAt: 100,
      deletionAfterDays: null,
      policyVersion: 'old',
    });
    mocks.sources.mockResolvedValue([{ bindingRef: 'CORE' }]);
    mocks.source.mockResolvedValue({ source: adapter });
    mocks.settings.mockResolvedValue({
      policyVersion: 'policy-1',
      policy: { deletionAfterDays: 1 },
    });
    mocks.tenantAccess.mockReturnValue(true);
    mocks.permission.mockReturnValue(true);
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });
  function context(body: unknown, tenant = 'tenant') {
    return {
      env: {
        testTenant: tenant,
        AUTHRIM_CONFIG: {
          get: async (key: string) => store.get(key) ?? null,
          put: async (key: string, value: string) => {
            store.set(key, value);
          },
        },
      },
      req: {
        json: async () => body,
        header: () => undefined,
        query: (key: string) => (body as Record<string, string>)[key],
      },
      header: vi.fn(),
      get: () => ({ userId: 'admin', tenantId: tenant, roles: ['org_admin'] }),
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
    } as unknown as Context<{ Bindings: Env }>;
  }
  const preview = async (body = {}) => {
    const response = await previewGuestRetentionHandler(context(body));
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      preview_token: string;
      count: number;
      due_now: number;
      next_cursor: string | null;
      items: Array<{ user_id: string; previous_due_at: number | null; new_due_at: number | null }>;
    }>;
  };
  it.each([
    'broken json',
    'null',
    '[]',
    '{"state":"unknown","attempted_at":100}',
    '{"state":"retrying","attempted_at":-1}',
    '{"state":"retrying","attempted_at":1.5}',
  ])('keeps Core progress visible with malformed optional observation %s', async (raw) => {
    store.set('guest-maintenance-status:tenant:a', raw);
    const response = await listGuestLifecycleHandler(context({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [expect.objectContaining({ user_id: 'a', maintenance: null }), expect.anything()],
    });
  });
  it('returns only the public maintenance observation fields', async () => {
    store.set(
      'guest-maintenance-status:tenant:a',
      JSON.stringify({ state: 'retrying', attempted_at: 100, internal: 'private diagnostic' })
    );
    const response = await listGuestLifecycleHandler(context({}));
    expect(await response.json()).toMatchObject({
      items: [
        expect.objectContaining({ maintenance: { state: 'retrying', attempted_at: 100 } }),
        expect.anything(),
      ],
    });
    const secondResponse = await listGuestLifecycleHandler(context({}));
    expect(await secondResponse.text()).not.toContain('private diagnostic');
  });
  it('expires an inspection cursor at the exact expiry second', async () => {
    const first = (await (await listGuestLifecycleHandler(context({ limit: '1' }))).json()) as {
      next_cursor: string;
    };
    vi.setSystemTime(200899000);
    expect((await listGuestLifecycleHandler(context({ cursor: first.next_cursor }))).status).toBe(
      200
    );
    vi.setSystemTime(200900000);
    expect((await listGuestLifecycleHandler(context({ cursor: first.next_cursor }))).status).toBe(
      409
    );
  });
  it.each([
    { index: -1 },
    { index: 99 },
    { bindings: [null] },
    { expiresAt: 'future' },
    { afterUserId: null },
  ])('rejects corrupted cursor state %j before querying storage', async (corrupt) => {
    const first = (await (await listGuestLifecycleHandler(context({ limit: '1' }))).json()) as {
      next_cursor: string;
    };
    const key = `guest-retention-v1:tenant:inspection:${first.next_cursor}`;
    store.set(key, JSON.stringify({ ...JSON.parse(store.get(key)!), ...corrupt }));
    mocks.source.mockClear();
    expect((await listGuestLifecycleHandler(context({ cursor: first.next_cursor }))).status).toBe(
      409
    );
    expect(mocks.source).not.toHaveBeenCalled();
  });
  it.each(['0', '-1', '101', '1.5', 'NaN', 'Infinity', ''])(
    'rejects out-of-range page size %s',
    async (limit) => {
      expect((await listGuestLifecycleHandler(context({ limit }))).status).toBe(400);
    }
  );
  it('inspects all phases, retry status and overdue time without changing records', async () => {
    db.exec(
      "UPDATE guest_account_lifecycle SET phase = 'deleting', deletion_due_at = 100 WHERE tenant_id = 'tenant' AND user_id = 'a'"
    );
    store.set(
      'guest-maintenance-status:tenant:a',
      JSON.stringify({ state: 'retrying', attempted_at: 150 })
    );
    const response = await listGuestLifecycleHandler(context({ limit: '1' }));
    expect(response.status).toBe(200);
    const first = (await response.json()) as {
      items: Array<{ user_id: string }>;
      next_cursor: string;
    };
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      user_id: 'a',
      phase: 'deleting',
      overdue_seconds: 199900,
      maintenance: { state: 'retrying', attempted_at: 150 },
    });
    expect(first.items[0]).not.toHaveProperty('deletion_route_json');
    const second = (await (
      await listGuestLifecycleHandler(context({ cursor: first.next_cursor }))
    ).json()) as { items: Array<{ user_id: string }> };
    expect(second.items.map((item: { user_id: string }) => item.user_id)).toEqual(['b']);
    expect((await lifecycle.get('a'))?.phase).toBe('deleting');
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(
      (await listGuestLifecycleHandler(context({ cursor: first.next_cursor }, 'other'))).status
    ).toBe(409);
  });
  it('denies inspection without view permission and rejects invalid limits', async () => {
    expect((await listGuestLifecycleHandler(context({ limit: '101' }))).status).toBe(400);
    mocks.permission.mockReturnValue(false);
    expect((await listGuestLifecycleHandler(context({}))).status).toBe(403);
  });
  it('shows creation-based deadlines without modifying any account', async () => {
    const result = await preview();
    expect(result.count).toBe(2);
    expect(result.due_now).toBe(2);
    expect(result.items[0]).toMatchObject({
      user_id: 'a',
      previous_due_at: null,
      new_due_at: 86500,
    });
    expect((await lifecycle.get('a'))?.deletion_due_at).toBeNull();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('applies only the reviewed page and never another tenant', async () => {
    const first = await preview({ limit: 1 });
    const result = await applyGuestRetentionHandler(
      context({ preview_token: first.preview_token })
    );
    expect(await result.json()).toEqual({ applied: 1, unchanged: 0, skipped: 0, total: 1 });
    expect((await lifecycle.get('a'))?.deletion_due_at).toBe(86500);
    expect((await lifecycle.get('b'))?.deletion_due_at).toBeNull();
    expect(
      (await new GuestLifecycleRepository(adapter, 'other').get('a'))?.deletion_due_at
    ).toBeNull();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant',
        userId: 'admin',
        action: 'guest.retention.applied',
      })
    );
    const second = await preview({ cursor: first.next_cursor, limit: 1 });
    expect(second.items.map((item) => item.user_id)).toEqual(['b']);
  });
  it('does not repeat mutations when the same preview is retried', async () => {
    const first = await preview();
    await applyGuestRetentionHandler(context({ preview_token: first.preview_token }));
    const revision = (await lifecycle.get('a'))?.revision;
    const result = await applyGuestRetentionHandler(
      context({ preview_token: first.preview_token })
    );
    expect(await result.json()).toEqual({ applied: 2, unchanged: 0, skipped: 0, total: 2 });
    expect((await lifecycle.get('a'))?.revision).toBe(revision);
  });
  it('skips promotion and hold changes made after the preview', async () => {
    const first = await preview();
    await lifecycle.beginUpgrade('a', 'upgrade', 200000, 200600);
    await lifecycle.acquireHold('b', 200000, 10);
    const result = await applyGuestRetentionHandler(
      context({ preview_token: first.preview_token })
    );
    expect(await result.json()).toEqual({ applied: 0, unchanged: 0, skipped: 2, total: 2 });
    expect((await lifecycle.get('b'))?.deletion_due_at).toBeNull();
  });
  it('rejects an expired preview before writes', async () => {
    const first = await preview();
    vi.advanceTimersByTime(900000);
    expect(
      (await applyGuestRetentionHandler(context({ preview_token: first.preview_token }))).status
    ).toBe(409);
    expect((await lifecycle.get('a'))?.deletion_due_at).toBeNull();
  });
  it('rejects a preview from another tenant', async () => {
    const first = await preview();
    expect(
      (await applyGuestRetentionHandler(context({ preview_token: first.preview_token }, 'other')))
        .status
    ).toBe(409);
    expect((await lifecycle.get('a'))?.deletion_due_at).toBeNull();
  });
  it('requires a new preview after policy changes', async () => {
    const first = await preview();
    mocks.settings.mockResolvedValue({
      policyVersion: 'policy-2',
      policy: { deletionAfterDays: 7 },
    });
    expect(
      (await applyGuestRetentionHandler(context({ preview_token: first.preview_token }))).status
    ).toBe(409);
    expect((await lifecycle.get('a'))?.deletion_due_at).toBeNull();
  });
  it('supports clearing deadlines and reports unchanged accounts', async () => {
    mocks.settings.mockResolvedValue({
      policyVersion: 'policy-2',
      policy: { deletionAfterDays: null },
    });
    await lifecycle.applyRetention('a', 1, 1, 'old', 100);
    const first = await preview();
    const result = await applyGuestRetentionHandler(
      context({ preview_token: first.preview_token })
    );
    expect(await result.json()).toEqual({ applied: 1, unchanged: 1, skipped: 0, total: 2 });
    expect((await lifecycle.get('a'))?.deletion_due_at).toBeNull();
  });
  it('enforces tenant access and separate edit permission', async () => {
    mocks.tenantAccess.mockReturnValue(false);
    expect((await previewGuestRetentionHandler(context({}))).status).toBe(403);
    expect(mocks.sources).not.toHaveBeenCalled();
    mocks.tenantAccess.mockReturnValue(true);
    mocks.permission.mockReturnValue(false);
    expect(
      (await applyGuestRetentionHandler(context({ preview_token: crypto.randomUUID() }))).status
    ).toBe(403);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each([null, { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { cursor: 123 }])(
    'rejects invalid preview input (%j)',
    async (body) => {
      expect((await previewGuestRetentionHandler(context(body))).status).toBe(400);
      expect(mocks.sources).not.toHaveBeenCalled();
    }
  );
});
