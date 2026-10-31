import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DatabaseAdapter, Env, ResolvedTenantDatabaseSource } from '@authrim/ar-lib-core';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';

const registry = vi.hoisted(() => ({ assigned: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  resolveTenantAssignedDatabaseSourcesFromRegistry: registry.assigned,
}));
import { GUEST_READ_CURSOR_TTL_SECONDS } from '../guest-read-pagination';
import { getGuestUser, getGuestUserUpgrades, listGuestUsers } from '../routes/guest-users';

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const databases: SQLiteDatabase[] = [];
function database() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(`
    CREATE TABLE identity_accounts (
      id TEXT, tenant_id TEXT, legacy_user_id TEXT, account_type TEXT,
      registration_state TEXT, lifecycle_state TEXT, directory_publication_state TEXT,
      account_route_generation INTEGER, created_at INTEGER, deleted_at INTEGER,
      metadata_json TEXT, primary_subject_id TEXT
    );
    CREATE TABLE guest_devices (
      id TEXT, tenant_id TEXT, user_id TEXT, expires_at INTEGER,
      created_at INTEGER, last_used_at INTEGER, is_active INTEGER
    );
    CREATE TABLE guest_account_upgrades (
      id TEXT, tenant_id TEXT, guest_user_id TEXT, upgraded_user_id TEXT,
      upgrade_method TEXT, provider_id TEXT, preserve_sub INTEGER,
      upgraded_at INTEGER, data_migrated INTEGER
    );
  `);
  const bind = (params: unknown[] = []) => params as SQLInputValue[];
  const adapter = {
    query: vi.fn(async (sql: string, params?: unknown[]) => db.prepare(sql).all(...bind(params))),
    queryOne: vi.fn(
      async (sql: string, params?: unknown[]) => db.prepare(sql).get(...bind(params)) ?? null
    ),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    getType: () => 'sqlite',
    isHealthy: vi.fn(),
    close: vi.fn(),
  };
  return { db, adapter, source: adapter as unknown as DatabaseAdapter };
}
function seed(db: SQLiteDatabase, tenantId: string, id: string, at = 10) {
  db.prepare(
    `INSERT INTO identity_accounts VALUES
    (?, ?, ?, 'user', 'guest', 'active', 'published', 1, ?, NULL, ?, NULL)`
  ).run(`account:${id}`, tenantId, id, at, JSON.stringify({ last_login_at: at * 1000 }));
  db.prepare('INSERT INTO guest_devices VALUES (?, ?, ?, NULL, ?, ?, 1)').run(
    `credential:${id}`,
    tenantId,
    id,
    at * 1000,
    at * 1000
  );
  db.prepare("INSERT INTO guest_account_upgrades VALUES (?, ?, ?, ?, 'email', NULL, 1, ?, 0)").run(
    `upgrade:${id}`,
    tenantId,
    id,
    'registered-target',
    at
  );
}
function source(bindingRef: string, db: DatabaseAdapter): ResolvedTenantDatabaseSource {
  return {
    source: db,
    bindingRef,
    dataRole: 'tenant_core/users',
    residencyPartition: 'default',
    shardId: bindingRef,
    assignmentGeneration: 1,
    bindingRouteGeneration: 1,
    registryRow: { database_id: `database:${bindingRef}` },
  } as ResolvedTenantDatabaseSource;
}
function fixture(routed = true) {
  const metadata = database(),
    account = database(),
    second = database();
  const kv = new Map<string, string>();
  const tenant = { id: 'tenant-a' };
  registry.assigned.mockResolvedValue([
    source('ACCOUNT_A', account.source),
    source('ACCOUNT_B', second.source),
  ]);
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    const ctx = c as unknown as { set(name: string, value: unknown): void };
    ctx.set('tenantId', tenant.id);
    ctx.set('tenantMetadataContext', {
      tenantId: tenant.id,
      coreDb: metadata.source,
      route: { bindingRef: 'METADATA', ...(routed ? { allocationScope: 'shared_pool' } : {}) },
    });
    await next();
  });
  app.get('/guests', listGuestUsers);
  app.get('/guests/:id', getGuestUser);
  app.get('/guests/:id/upgrades', getGuestUserUpgrades);
  const env = {
    AUTHRIM_CONFIG: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kv.set(key, value);
      }),
    },
  } as unknown as Env;
  const request = (path: string) => app.request(`https://example.test${path}`, {}, env);
  return { metadata, account, second, kv, env, config: env.AUTHRIM_CONFIG, tenant, request };
}

beforeEach(() => registry.assigned.mockReset());
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});

describe('Guest reads use account storage, with real separate SQLite databases', () => {
  it('lists guests held only in account shards and excludes the other tenant', async () => {
    const f = fixture();
    seed(f.account.db, 'tenant-a', 'guest-a');
    seed(f.second.db, 'tenant-a', 'guest-b', 20);
    seed(f.account.db, 'tenant-b', 'foreign');
    seed(f.metadata.db, 'tenant-a', 'metadata-decoy');
    const response = await f.request('/guests');
    expect(response.status).toBe(200);
    const body = await readJson<{ total: number; users: { user_id: string }[] }>(response);
    expect(body.total).toBe(2);
    expect(body.users.map((u) => u.user_id).sort()).toEqual(['guest-a', 'guest-b']);
    expect(f.metadata.adapter.query).not.toHaveBeenCalled();
    expect(f.metadata.adapter.queryOne).not.toHaveBeenCalled();
  });

  it('returns account details and upgrade history without a PII database', async () => {
    const f = fixture();
    seed(f.account.db, 'tenant-a', 'guest-a');
    seed(f.account.db, 'tenant-b', 'foreign');
    seed(f.account.db, 'tenant-b', 'guest-a', 99);
    const detail = await f.request('/guests/guest-a');
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      user_id: 'guest-a',
      created_at: 10000,
      last_login_at: 10000,
      resume_credentials: [{ id: 'credential:guest-a', is_active: true }],
      upgrade: { upgraded_user_id: 'registered-target', preserve_sub: true },
    });
    const history = await f.request('/guests/guest-a/upgrades');
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ upgrades: [{ id: 'upgrade:guest-a' }] });
    expect((await f.request('/guests/foreign')).status).toBe(404);
    expect(await (await f.request('/guests/foreign/upgrades')).json()).toMatchObject({
      upgrades: [],
    });
    expect(f.metadata.adapter.query).not.toHaveBeenCalled();
    expect(f.metadata.adapter.queryOne).not.toHaveBeenCalled();
  });

  it.each([1_700_000_000, 1_700_000_000_000, '1700000000', '1700000000000'])(
    'returns detail created_at in milliseconds for stored timestamp %s',
    async (timestamp) => {
      const f = fixture();
      seed(f.account.db, 'tenant-a', 'guest-a');
      f.account.db.prepare('UPDATE identity_accounts SET created_at = ?').run(timestamp);
      if (typeof timestamp === 'string') {
        // SQLite INTEGER affinity converts digits to numbers; emulate PostgreSQL's int8 result.
        const queryOne = f.account.adapter.queryOne.getMockImplementation();
        if (!queryOne) throw new Error('missing fixture adapter');
        f.account.adapter.queryOne.mockImplementation(async (...args) => {
          const row = await queryOne(...args);
          return row && typeof row === 'object' && 'created_at' in row
            ? { ...row, created_at: String(row.created_at) }
            : row;
        });
      }
      const response = await f.request('/guests/guest-a');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ created_at: 1_700_000_000_000 });
    }
  );

  it.each([
    ['finite number', '{"last_login_at":1700000000000}', 1_700_000_000_000],
    ['fractional number', '{"last_login_at":1.5}', 1.5],
    ['negative number', '{"last_login_at":-1}', -1],
    ['negative fraction', '{"last_login_at":-1.5}', -1.5],
    ['numeric string', '{"last_login_at":"1700000000000"}', null],
    ['nonnumeric string', '{"last_login_at":"invalid"}', null],
    ['null value', '{"last_login_at":null}', null],
    ['boolean value', '{"last_login_at":true}', null],
    ['object value', '{"last_login_at":{}}', null],
    ['array value', '{"last_login_at":[]}', null],
    ['nonfinite number', '{"last_login_at":1e309}', null],
    ['nonfinite negative', '{"last_login_at":-1e309}', null],
    ['missing field', '{}', null],
    ['broken JSON', '{', null],
    ['array metadata', '[{"last_login_at":1700000000000}]', null],
    ['number metadata', '1700000000000', null],
    ['string metadata', '"invalid"', null],
    ['boolean metadata', 'true', null],
    ['null metadata', 'null', null],
    ['empty metadata', '', null],
    ['SQL NULL metadata', null, null],
  ])('preserves tolerant last_login_at handling: %s', async (_name, metadata, expected) => {
    const f = fixture();
    seed(f.account.db, 'tenant-a', 'guest-a');
    f.account.db.prepare('UPDATE identity_accounts SET metadata_json = ?').run(metadata);
    const response = await f.request('/guests/guest-a');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ last_login_at: expected });
  });

  it.each(['/guests', '/guests/guest-a', '/guests/guest-a/upgrades'])(
    'fails closed when any account shard cannot be read: %s',
    async (path) => {
      const f = fixture();
      seed(f.account.db, 'tenant-a', 'guest-a');
      seed(f.metadata.db, 'tenant-a', 'guest-a');
      const unavailable = async () => {
        throw new Error('account unavailable');
      };
      f.second.adapter.query.mockImplementation(unavailable);
      f.second.adapter.queryOne.mockImplementation(unavailable);
      expect((await f.request(path)).status).toBe(503);
      expect(f.metadata.adapter.query).not.toHaveBeenCalled();
      expect(f.metadata.adapter.queryOne).not.toHaveBeenCalled();
    }
  );
  it('reads upgrade history for a target across account shards and after source deletion', async () => {
    const f = fixture();
    seed(f.account.db, 'tenant-a', 'source-a', 10);
    seed(f.second.db, 'tenant-a', 'source-b', 20);
    seed(f.second.db, 'tenant-b', 'foreign', 30);
    f.account.db.exec('DELETE FROM identity_accounts');
    const response = await f.request('/guests/registered-target/upgrades');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      upgrades: [{ id: 'upgrade:source-b' }, { id: 'upgrade:source-a' }],
    });
    expect(f.metadata.adapter.query).not.toHaveBeenCalled();
  });

  it.each(['users', 'upgrades'] as const)(
    'pages %s across tied timestamps and shard boundaries',
    async (kind) => {
      const f = fixture();
      for (const [index, id] of ['a', 'b', 'z', 'é', 'あ'].entries()) {
        seed(index % 2 === 0 ? f.account.db : f.second.db, 'tenant-a', id);
      }
      const path = kind === 'users' ? '/guests' : '/guests/registered-target/upgrades';
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let index = 0; index < 5; index++) {
        const response = await f.request(`${path}?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        expect(response.status).toBe(200);
        const body = await readJson<{
          next_cursor: string | null;
          users: { user_id: string }[];
          upgrades: { guest_user_id: string }[];
        }>(response);
        ids.push(kind === 'users' ? body.users[0].user_id : body.upgrades[0].guest_user_id);
        cursor = body.next_cursor;
        expect(cursor === null).toBe(index === 4);
        if (cursor) expect(cursor).toMatch(/^[a-f0-9-]{36}$/u);
      }
      expect(ids).toEqual(['a', 'b', 'z', 'é', 'あ']);
      for (const account of [f.account, f.second]) {
        for (const [sql, params] of account.adapter.query.mock.calls) {
          expect(sql).toMatch(/LIMIT \?/u);
          expect(params?.at(-1)).toBe(2);
        }
      }
    }
  );

  it('scopes cursors to tenant, endpoint, query, physical inventory and expiry', async () => {
    const f = fixture();
    seed(f.account.db, 'tenant-a', 'a');
    seed(f.second.db, 'tenant-a', 'b');
    const first = await readJson<{ next_cursor: string }>(await f.request('/guests?limit=1'));
    const cursor = first.next_cursor;
    expect((await f.request(`/guests?cursor=${cursor}&include_expired=true`)).status).toBe(409);
    expect((await f.request(`/guests/registered-target/upgrades?cursor=${cursor}`)).status).toBe(
      409
    );
    f.tenant.id = 'tenant-b';
    expect((await f.request(`/guests?cursor=${cursor}`)).status).toBe(409);
    f.tenant.id = 'tenant-a';
    registry.assigned.mockResolvedValueOnce([source('ACCOUNT_A', f.account.source)]);
    expect((await f.request(`/guests?cursor=${cursor}`)).status).toBe(409);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + (GUEST_READ_CURSOR_TTL_SECONDS + 1) * 1000);
    expect((await f.request(`/guests?cursor=${cursor}`)).status).toBe(409);
  });

  it('scopes history cursors to the requested user', async () => {
    const f = fixture();
    seed(f.account.db, 'tenant-a', 'a');
    seed(f.second.db, 'tenant-a', 'b');
    const first = await readJson<{ next_cursor: string }>(
      await f.request('/guests/registered-target/upgrades?limit=1')
    );
    expect((await f.request(`/guests/a/upgrades?cursor=${first.next_cursor}`)).status).toBe(409);
  });

  it('stops on registry, cursor storage, corrupt cursor and ambiguous ownership failures', async () => {
    const f = fixture();
    seed(f.account.db, 'tenant-a', 'a');
    seed(f.second.db, 'tenant-a', 'b');
    registry.assigned.mockRejectedValueOnce(new Error('registry unavailable'));
    expect((await f.request('/guests')).status).toBe(503);
    registry.assigned.mockResolvedValueOnce([]);
    expect((await f.request('/guests')).status).toBe(503);
    if (!f.config) throw new Error('missing fixture KV');
    const put = vi.spyOn(f.config, 'put').mockRejectedValueOnce(new Error('KV unavailable'));
    expect((await f.request('/guests?limit=1')).status).toBe(503);
    put.mockRestore();
    const first = await readJson<{ next_cursor: string }>(await f.request('/guests?limit=1'));
    vi.spyOn(f.config, 'get').mockRejectedValueOnce(new Error('KV unavailable'));
    expect((await f.request(`/guests?cursor=${first.next_cursor}`)).status).toBe(503);
    const key = [...f.kv.keys()].find((key) => key.endsWith(first.next_cursor));
    if (!key) throw new Error('missing fixture cursor');
    f.kv.set(key, '{');
    expect((await f.request(`/guests?cursor=${first.next_cursor}`)).status).toBe(409);
    expect((await f.request('/guests?cursor=invalid')).status).toBe(409);
    seed(f.second.db, 'tenant-a', 'a');
    expect((await f.request('/guests/a')).status).toBe(503);
  });

  it('keeps direct storage offset reads and supports details and history', async () => {
    const f = fixture(false);
    seed(f.metadata.db, 'tenant-a', 'a');
    seed(f.metadata.db, 'tenant-a', 'b', 20);
    const response = await f.request('/guests?limit=1&offset=1');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 2, offset: 1, users: [{ user_id: 'a' }] });
    expect((await f.request('/guests/a')).status).toBe(200);
    expect(await (await f.request('/guests/a/upgrades')).json()).toMatchObject({
      upgrades: [{ id: 'upgrade:a' }],
    });
    expect(registry.assigned).not.toHaveBeenCalled();
    expect(f.account.adapter.query).not.toHaveBeenCalled();
  });

  it('rejects routed offset pagination and invalid history limits', async () => {
    const f = fixture();
    expect((await f.request('/guests?offset=1')).status).toBe(400);
    expect((await f.request('/guests/a/upgrades?limit=0')).status).toBe(400);
  });

  it('normalizes PostgreSQL-style BIGINT strings and boolean values, rejecting unsafe integers', async () => {
    const f = fixture();
    seed(f.account.db, 'tenant-a', 'a');
    const normalize = (row: unknown) =>
      Object.fromEntries(
        Object.entries(row as Record<string, unknown>).map(([key, value]) => [
          key,
          ['is_active', 'preserve_sub', 'data_migrated'].includes(key)
            ? Boolean(value)
            : typeof value === 'number'
              ? String(value)
              : value,
        ])
      );
    const query = f.account.adapter.query.getMockImplementation();
    const queryOne = f.account.adapter.queryOne.getMockImplementation();
    if (!query || !queryOne) throw new Error('missing fixture adapter');
    f.account.adapter.query.mockImplementation(async (...args) =>
      (await query(...args)).map(normalize)
    );
    f.account.adapter.queryOne.mockImplementation(async (...args) => {
      const row = await queryOne(...args);
      return row ? normalize(row) : null;
    });
    expect(await (await f.request('/guests')).json()).toMatchObject({
      total: 1,
      users: [{ credential_count: 1, created_at: 10000 }],
    });
    expect(await (await f.request('/guests/a')).json()).toMatchObject({
      created_at: 10000,
      resume_credentials: [{ is_active: true }],
      upgrade: { preserve_sub: true, upgraded_at: 10 },
    });
    expect(await (await f.request('/guests/a/upgrades')).json()).toMatchObject({
      upgrades: [{ upgraded_at: 10, preserve_sub: true, data_migrated: false }],
    });
    f.account.adapter.queryOne.mockResolvedValueOnce({ count: '9007199254740992' });
    expect((await f.request('/guests')).status).toBe(503);
  });
  it('keeps the inventory order stable and invalidates a changed assignment generation', async () => {
    const f = fixture();
    seed(f.account.db, 'tenant-a', 'a');
    seed(f.second.db, 'tenant-a', 'b');
    const first = await readJson<{ next_cursor: string }>(await f.request('/guests?limit=1'));
    registry.assigned.mockResolvedValueOnce([
      source('ACCOUNT_B', f.second.source),
      source('ACCOUNT_A', f.account.source),
    ]);
    expect(
      await (await f.request(`/guests?limit=1&cursor=${first.next_cursor}`)).json()
    ).toMatchObject({ users: [{ user_id: 'b' }] });
    registry.assigned.mockResolvedValueOnce([
      { ...source('ACCOUNT_A', f.account.source), assignmentGeneration: 2 },
      source('ACCOUNT_B', f.second.source),
    ]);
    expect((await f.request(`/guests?cursor=${first.next_cursor}`)).status).toBe(409);
  });

  it('uses the first page observation time for credential expiry and totals', async () => {
    const f = fixture();
    seed(f.account.db, 'tenant-a', 'a');
    seed(f.second.db, 'tenant-a', 'b');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    f.second.db.prepare('UPDATE guest_devices SET expires_at = ?').run(now + 1000);
    const first = await readJson<{ total: number; next_cursor: string }>(
      await f.request('/guests?limit=1')
    );
    expect(first.total).toBe(2);
    vi.spyOn(Date, 'now').mockReturnValue(now + 2000);
    expect(
      await (await f.request(`/guests?limit=1&cursor=${first.next_cursor}`)).json()
    ).toMatchObject({
      total: 2,
      users: [{ user_id: 'b', has_active_resume_credential: true }],
      next_cursor: null,
    });
  });
});
