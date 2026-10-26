import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLiteDatabase } from './test-sqlite';
import { sqliteAdapter, type AdapterHooks } from './helpers/admin-authority-fixture';
import {
  AdminAuditLogRepository,
  ensureDatabaseAdapter,
  SqlLogChunkCatalogStore,
  type Env,
} from '@authrim/ar-lib-core';
import { deriveLogChunkEncryptionKey, writeLogChunkToR2 } from '@authrim/ar-lib-logging/chunks';
import { encryptValue } from '@authrim/ar-lib-core/utils/pii-encryption';
import { getOperationalLog } from '@authrim/ar-lib-core/services/audit/operational-logs';
import { exportPortableOperationalLogDetailRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-operational-log-detail';
import {
  LogQueryIncompleteError,
  readArchivedLogRows,
  type LogDataset,
  type LogSqlRow,
} from '../log-archive-query';
import { createLogReadAdapter } from '../log-read-adapter';
import {
  adminStatsAuthHandler,
  adminStatsGeographyHandler,
  adminStatsTimelineHandler,
  adminStatsTokensHandler,
} from '../admin-stats';
import { adminAuditLogListHandler, adminAuditLogGetHandler } from '../admin';
import { listArchiveAuditEvents, getArchiveAuditEventById } from '../audit-archive-query';
import { AdminAgentAccessRepository } from '@authrim/ar-agent-access/core';
import { getAuditHotQuerySupport } from '../audit-hot-query';

// Load the runtime without leaking Miniflare's private Node ambient types into every package test.
const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.url)('miniflare') as {
  Miniflare: new (options: unknown) => {
    getD1Database(binding: string, worker: string): Promise<D1Database>;
    getR2Bucket(binding: string, worker: string): Promise<R2Bucket>;
    dispose(): Promise<void>;
  };
  convertV4MiniflareOptions: (options: Record<string, unknown>) => unknown;
};

const NOW = 1_800_000_000_000;
const OLD = NOW - 10 * 86_400_000;
const KEY = '12'.repeat(32);
const PII_KEY = '34'.repeat(32);
const TENANT_KEY = 'tenant-key-a';
const sql = (path: string) =>
  readFileSync(new URL(`../../../../migrations/${path}`, import.meta.url), 'utf8');
function createTable(db: SQLiteDatabase, path: string, table: string) {
  const statement = sql(path).match(
    new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"?${table}"? \\([\\s\\S]*?\\);`)
  )?.[0];
  if (!statement) throw new Error(`missing fixture table ${table}`);
  db.exec(statement);
}
function portable(row: LogSqlRow) {
  return Object.fromEntries(
    Object.entries(row).map(([name, value]) => [
      name,
      value === null
        ? ['null', null]
        : [typeof value === 'number' ? 'integer' : 'text', String(value)],
    ])
  );
}

describe('whole-row log archives', () => {
  let core: SQLiteDatabase, admin: SQLiteDatabase;
  let env: Env;
  let objects: Map<string, Uint8Array>;
  let hooks: AdapterHooks;

  beforeEach(() => {
    core = new DatabaseSync(':memory:');
    admin = new DatabaseSync(':memory:');
    core.exec(`CREATE TABLE tenants(id TEXT PRIMARY KEY,tenant_key TEXT);
      INSERT INTO tenants VALUES ('tenant-a','${TENANT_KEY}'),('tenant-b','tenant-key-b');`);
    for (const name of ['event_log', 'audit_log', 'operational_logs', 'permission_check_audit'])
      createTable(core, 'core/d1/001_0_4_0_core_baseline.sql', name);
    for (const name of ['log_object_catalog', 'log_chunk_record_index', 'log_archive_batches']) {
      if (name !== 'log_archive_batches')
        createTable(admin, 'admin/d1/001_0_4_0_admin_baseline.sql', name);
    }
    for (const name of [
      'federation_selected_entity_import_events',
      'key_access_events',
      'mapping_events',
    ])
      createTable(admin, 'admin/d1/001_0_4_0_admin_baseline.sql', name);
    admin.exec(sql('admin/d1/047_log_row_archive.sql'));
    createTable(admin, 'admin/d1/001_0_4_0_admin_baseline.sql', 'admin_audit_log');
    hooks = {};
    objects = new Map();
    const bucket = {
      async put(key: string, value: Uint8Array) {
        objects.set(key, new Uint8Array(value));
        return {};
      },
      async get(key: string) {
        const value = objects.get(key);
        if (!value) return null;
        return { size: value.length, body: new Blob([value]).stream() };
      },
    };
    env = {
      DB: Object.assign(sqliteAdapter(core, hooks), {
        prepare: (sql: string) => core.prepare(sql),
      }),
      DB_ADMIN: sqliteAdapter(admin),
      AUDIT_ARCHIVE: bucket,
      OBJECT_ENCRYPTION_ROOT_KEY: KEY,
      PII_ENCRYPTION_KEY: PII_KEY,
    } as unknown as Env;
  });
  afterEach(() => {
    core.close();
    admin.close();
    vi.restoreAllMocks();
  });

  it('excludes expired hot rows from counts and hintless details before any archive exists', async () => {
    const now = Date.now();
    core
      .prepare(
        `INSERT INTO event_log(id,tenant_id,event_type,event_category,result,created_at,retention_until)
      VALUES('expired-hot','tenant-a','auth.login','auth','success',?,?)`
      )
      .run(now - 10, now);
    expect(
      await read().adapter.queryOne('SELECT COUNT(*) AS n FROM event_log WHERE tenant_id=?', [
        'tenant-a',
      ])
    ).toEqual({ n: 0 });
    const detail = createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      adapter: sqliteAdapter(core),
      dataset: 'core.event_log',
      hotOnly: true,
    });
    expect(
      await detail.adapter.queryOne('SELECT id FROM event_log WHERE tenant_id=? AND id=?', [
        'tenant-a',
        'expired-hot',
      ])
    ).toBeNull();
  });

  it('reads whole-row archives after a tenant switches to an archive-only profile', async () => {
    await archive('core.event_log', [event('cold-a'), event('cold-b')]);
    const context = {
      env,
      bucket: env.AUDIT_ARCHIVE!,
      prefix: 'audit',
      auditProfileId: 'archive-only',
      tenantKeyResolver: async () => TENANT_KEY,
    };
    const first = await listArchiveAuditEvents(context, {
      tenantId: 'tenant-a',
      page: 1,
      limit: 1,
      cursorPage: { limit: 1, scope: 'archive-only' },
    });
    expect(first.entries.map((r) => r.id)).toEqual(['cold-b']);
    expect(first.pagination?.has_more).toBe(true);
    const second = await listArchiveAuditEvents(context, {
      tenantId: 'tenant-a',
      page: 1,
      limit: 1,
      cursorPage: { limit: 1, scope: 'archive-only', cursor: first.pagination!.next_cursor! },
    });
    expect(second.entries.map((r) => r.id)).toEqual(['cold-a']);
    expect(await getArchiveAuditEventById(context, 'tenant-a', 'cold-b', OLD)).toMatchObject({
      id: 'cold-b',
      detailsJson: event('cold-b').details_json,
    });
  });

  it.each([
    { resourceType: 'user', resourceId: 'u1' },
    { resource_type: 'user', resource_id: 'u1' },
    { resource: { type: 'user', id: 'u1' } },
  ])('preserves archive-only resource filters for %j', async (details) => {
    await archive('core.event_log', [
      { ...event('matching'), details_json: JSON.stringify(details) },
      { ...event('other'), details_json: '{"resourceId":"u2"}' },
    ]);
    const context = {
      env,
      bucket: env.AUDIT_ARCHIVE!,
      prefix: 'audit',
      auditProfileId: 'archive-only',
      tenantKeyResolver: async () => TENANT_KEY,
    };
    const result = await listArchiveAuditEvents(context, {
      tenantId: 'tenant-a',
      page: 1,
      limit: 20,
      resourceType: 'user',
      resourceId: 'u1',
      cursorPage: { limit: 20, scope: 'resource' },
    });
    expect(result.entries.map((e) => e.id)).toEqual(['matching']);
  });

  it('uses the stored activity cursor as a catalog upper bound beyond 64 newer chunks', async () => {
    for (let i = 0; i < 65; i++)
      await archive('core.event_log', [event(`newer-${i}`, OLD + 1000 + i)]);
    await archive('core.event_log', [event('older-page', OLD - 1000)]);
    const get = vi.spyOn(env.AUDIT_ARCHIVE!, 'get');
    const support = await getAuditHotQuerySupport(env, 'tenant-a', {
      page: { limit: 2, scope: 'activity' },
      storedCursorTime: OLD,
    });
    const rows = await support.context!.adapter.query(
      'SELECT id, created_at FROM event_log WHERE tenant_id=? AND (created_at < ? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?',
      ['tenant-a', OLD, OLD, 'z', 2]
    );
    expect(rows).toEqual([{ id: 'older-page', created_at: OLD - 1000 }]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('normalizes driver bigint timestamps before proving or generating a cursor', async () => {
    await archive('core.event_log', [event('a'), event('b'), event('c')]);
    await archive('core.event_log', [event('older', OLD - 1000)]);
    const base = sqliteAdapter(core);
    const adapter = {
      ...base,
      async query<T>(statement: string, params?: unknown[]) {
        const rows = await base.query<LogSqlRow>(statement, params);
        if (statement.startsWith('WITH'))
          for (const row of rows) {
            if (typeof row.created_at === 'number') row.created_at = String(row.created_at);
          }
        return rows as T[];
      },
    };
    const view = createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      adapter,
      dataset: 'core.event_log',
      page: { limit: 1, scope: 'bigint' },
    });
    expect(
      await view.adapter.query(
        'SELECT id,created_at FROM event_log WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT ?',
        ['tenant-a', 1]
      )
    ).toEqual([{ id: 'c', created_at: OLD }]);
    expect(view.pagination()?.next_cursor).toEqual(expect.any(String));
  });

  it('includes archived grant audit through the real grant repository and keeps its tenant/grant filter', async () => {
    await archive('admin.admin_audit_log', [
      {
        id: 'grant-a',
        tenant_id: 'tenant-a',
        created_at: OLD,
        action: 'agent_grant.created',
        result: 'success',
        severity: 'info',
        grant_id: 'g1',
        metadata_json: '{}',
      },
      {
        id: 'grant-other',
        tenant_id: 'tenant-a',
        created_at: OLD,
        action: 'agent_grant.created',
        result: 'success',
        severity: 'info',
        grant_id: 'g2',
        metadata_json: '{}',
      },
    ]);
    const view = createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      adapter: sqliteAdapter(admin),
      dataset: 'admin.admin_audit_log',
      page: { limit: 1, scope: 'grant-g1' },
    });
    const rows = await new AdminAgentAccessRepository(view.adapter).listGrantAudit(
      'tenant-a',
      'g1',
      1
    );
    expect(rows.map((r) => r.id)).toEqual(['grant-a']);
  });

  async function archive(dataset: LogDataset, rows: LogSqlRow[], extra?: { payload?: unknown }) {
    const logType = {
      'core.event_log': 'normal',
      'core.audit_log': 'audit',
      'core.operational_logs': 'operational',
      'core.permission_check_audit': 'audit',
      'admin.admin_audit_log': 'admin_audit',
    } as const;
    const seconds = [
      'core.audit_log',
      'core.operational_logs',
      'core.permission_check_audit',
    ].includes(dataset);
    const time = dataset === 'core.permission_check_audit' ? 'checked_at' : 'created_at';
    const at = (row: LogSqlRow) => Number(row[time]) * (seconds ? 1000 : 1);
    const type = logType[dataset];
    return writeLogChunkToR2({
      bucket: env.AUDIT_ARCHIVE!,
      tenantKey: TENANT_KEY,
      logType: type,
      plane: 'archive',
      prefix: 'logs/v1',
      now: OLD,
      compression: 'gzip_block',
      catalogStore: new SqlLogChunkCatalogStore(env.DB_ADMIN),
      encryption: {
        keyBytes: await deriveLogChunkEncryptionKey({
          rootKeyHex: KEY,
          tenantKey: TENANT_KEY,
          logType: type,
          plane: 'archive',
          keyVersion: 1,
        }),
        encryptionScope: `tenant:${TENANT_KEY}:${type}:archive`,
        keyVersion: 1,
      },
      records: rows.map((row) => ({
        id: String(row.id),
        eventAt: at(row),
        payload: extra?.payload ?? {
          format: 'authrim.log.row.v1',
          table: dataset,
          row: portable(row),
        },
      })),
      rowArchive: {
        sourceTable: dataset,
        firstEventAt: Math.min(...rows.map(at)),
        lastEventAt: Math.max(...rows.map(at)),
        maxExpiresAt: null,
        neverExpires: true,
      },
    });
  }
  const event = (id: string, at = OLD): LogSqlRow => ({
    id,
    tenant_id: 'tenant-a',
    event_type: 'auth.login',
    event_category: 'auth',
    result: 'success',
    severity: 'info',
    created_at: at,
    retention_until: null,
    details_json: '{"country_code":"JP"}',
  });
  const read = () =>
    createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      adapter: sqliteAdapter(core, hooks),
      dataset: 'core.event_log',
    });

  it('reads real encrypted multi-block chunks without per-record indexes and excludes expired rows', async () => {
    const rows: LogSqlRow[] = Array.from({ length: 70 }, (_, i) => ({
      ...event(`e${i}`),
      details_json: 'x'.repeat(5000),
    }));
    rows.push({ ...event('expired'), retention_until: NOW });
    await archive('core.event_log', rows);
    expect(admin.prepare('SELECT count(*) AS n FROM log_chunk_record_index').get()).toEqual({
      n: 0,
    });
    const actual = await readArchivedLogRows({
      env,
      tenantId: 'tenant-a',
      dataset: 'core.event_log',
      now: NOW,
    });
    expect(actual).toHaveLength(70);
    expect(actual[69].details_json).toBe('x'.repeat(5000));
  });

  it('combines filtered rows and SQL aggregates, giving a hot duplicate precedence', async () => {
    await archive('core.event_log', [
      event('old'),
      event('both'),
      { ...event('filtered'), event_type: 'other' },
    ]);
    core
      .prepare(
        `INSERT INTO event_log(id,tenant_id,event_type,event_category,result,created_at)
      VALUES ('both','tenant-a','auth.login','auth','failure',?)`
      )
      .run(OLD);
    core
      .prepare(
        `INSERT INTO event_log(id,tenant_id,event_type,event_category,result,created_at)
      VALUES ('new','tenant-a','auth.login','auth','success',?)`
      )
      .run(NOW);
    const view = read();
    expect(
      await view.adapter.query(
        `SELECT id,result FROM event_log WHERE tenant_id=? AND event_type=? ORDER BY created_at DESC,id DESC`,
        ['tenant-a', 'auth.login']
      )
    ).toEqual([
      { id: 'new', result: 'success' },
      { id: 'old', result: 'success' },
      { id: 'both', result: 'failure' },
    ]);
    expect(
      await view.adapter.queryOne(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN result='failure' THEN 1 ELSE 0 END) AS failures FROM event_log WHERE tenant_id=? AND event_type=?`,
        ['tenant-a', 'auth.login']
      )
    ).toEqual({ n: 3, failures: 1 });
    expect(view.hasArchive()).toBe(true);
  });

  it('does not lose the first archive committed between the hot read and the catalog probe', async () => {
    core
      .prepare(
        `INSERT INTO event_log(id,tenant_id,event_type,event_category,result,created_at)
      VALUES ('first','tenant-a','auth.login','auth','success',?)`
      )
      .run(OLD);
    const catalogAdapter = sqliteAdapter(admin);
    env = { ...env, DB_ADMIN: catalogAdapter } as unknown as Env;
    const original = catalogAdapter.queryOne.bind(catalogAdapter);
    let raced = false;
    vi.spyOn(catalogAdapter, 'queryOne').mockImplementation(async (statement, params) => {
      if (!raced && statement.includes('source_table')) {
        raced = true;
        await archive('core.event_log', [event('first')]);
        core.prepare('DELETE FROM event_log').run();
      }
      return original(statement, params);
    });
    expect(
      await read().adapter.query('SELECT id FROM event_log WHERE tenant_id=?', ['tenant-a'])
    ).toEqual([{ id: 'first' }]);
  });

  it('pushes action predicates into the hot snapshot before applying the row budget', async () => {
    await archive('core.event_log', [event('old')]);
    const insert = core.prepare(
      `INSERT INTO event_log(id,tenant_id,event_type,event_category,result,created_at) VALUES (?,'tenant-a','unrelated','auth','success',?)`
    );
    core.exec('BEGIN');
    for (let i = 0; i < 10_100; i++) insert.run(`irrelevant${i}`, NOW);
    core.exec('COMMIT');
    expect(
      await read().adapter.query('SELECT id FROM event_log WHERE tenant_id=? AND event_type=?', [
        'tenant-a',
        'auth.login',
      ])
    ).toEqual([{ id: 'old' }]);
  });

  it.each(['missing', 'checksum', 'tenant', 'format', 'pending', 'deleted'] as const)(
    'fails closed for %s bodies or ignores non-committed catalog entries',
    async (problem) => {
      const chunk = await archive(
        'core.event_log',
        [event('old')],
        problem === 'tenant'
          ? {
              payload: {
                format: 'authrim.log.row.v1',
                table: 'core.event_log',
                row: portable({ ...event('old'), tenant_id: 'tenant-b' }),
              },
            }
          : problem === 'format'
            ? { payload: { format: 'wrong' } }
            : undefined
      );
      if (problem === 'missing') objects.clear();
      if (problem === 'checksum')
        admin.prepare(`UPDATE log_object_catalog SET checksum_sha256=?`).run('0'.repeat(64));
      if (problem === 'pending' || problem === 'deleted') {
        admin.prepare('UPDATE log_object_catalog SET status=?').run(problem);
        expect(
          await read().adapter.query('SELECT id FROM event_log WHERE tenant_id=?', ['tenant-a'])
        ).toEqual([]);
      } else {
        await expect(
          read().adapter.query('SELECT id FROM event_log WHERE tenant_id=?', ['tenant-a'])
        ).rejects.toBeInstanceOf(LogQueryIncompleteError);
      }
      expect(chunk.objectCatalogId).toBeTruthy();
    }
  );

  it('retains the hot-only detail contract and tenant boundaries', async () => {
    await archive('core.event_log', [event('old')]);
    expect(
      await readArchivedLogRows({ env, tenantId: 'tenant-b', dataset: 'core.event_log' })
    ).toEqual([]);
    const view = createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      adapter: sqliteAdapter(core),
      dataset: 'core.event_log',
      hotOnly: true,
    });
    expect(await view.adapter.queryOne('SELECT * FROM event_log WHERE id=?', ['old'])).toBeNull();
  });

  it('pages through equal timestamps without duplicates and binds cursors to the query', async () => {
    await archive(
      'core.event_log',
      ['a', 'b', 'c', 'd', 'e'].map((id) => event(id))
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const view = createLogReadAdapter({
        env,
        tenantId: 'tenant-a',
        dataset: 'core.event_log',
        adapter: sqliteAdapter(core),
        page: { limit: 2, scope: 'tenant-a/query1', cursor },
      });
      const rows = await view.adapter.query<{ id: string; created_at: number }>(
        'SELECT id,created_at FROM event_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        ['tenant-a', 2, 0]
      );
      seen.push(...rows.map((row) => row.id));
      cursor = view.pagination()?.next_cursor ?? undefined;
      expect(view.pagination()?.has_more).toBe(page !== 2);
    }
    expect(seen).toEqual(['e', 'd', 'c', 'b', 'a']);
    const wrong = createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      dataset: 'core.event_log',
      adapter: sqliteAdapter(core),
      page: { limit: 2, scope: 'tenant-a/query1' },
    });
    await wrong.adapter.query(
      'SELECT id,created_at FROM event_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?',
      ['tenant-a', 2]
    );
    expect(() =>
      createLogReadAdapter({
        env,
        tenantId: 'tenant-b',
        dataset: 'core.event_log',
        adapter: sqliteAdapter(core),
        page: { limit: 2, scope: 'tenant-b/query1', cursor: wrong.pagination()!.next_cursor! },
      })
    ).toThrow('Invalid log cursor');
  });

  it('uses the requested period to skip unrelated chunks before reading R2', async () => {
    await archive('core.event_log', [event('old')]);
    objects.clear();
    const rows = await read().adapter.queryOne(
      'SELECT COUNT(*) AS n FROM event_log WHERE tenant_id=? AND created_at>=? AND created_at<=?',
      ['tenant-a', NOW, NOW + 1000]
    );
    expect(rows).toEqual({ n: 0 });
  });

  it('reads one matching second-timestamp detail with a millisecond hint', async () => {
    await archive('core.audit_log', [
      {
        id: 'a1',
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        action: 'account.login',
        created_at: OLD / 1000,
      },
    ]);
    const view = createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      adapter: sqliteAdapter(core),
      dataset: 'core.audit_log',
      window: { fromMs: OLD, toMs: OLD },
    });
    expect(
      await view.adapter.queryOne(
        'SELECT id,created_at FROM audit_log WHERE tenant_id=? AND id=?',
        ['tenant-a', 'a1']
      )
    ).toEqual({ id: 'a1', created_at: OLD / 1000 });
  });

  function api() {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('tenantMetadataContext' as never, { tenantId: 'tenant-a', coreDb: env.DB } as never);
      await next();
    });
    app.get('/api/admin/stats/auth', adminStatsAuthHandler);
    app.get('/api/admin/stats/geography', adminStatsGeographyHandler);
    app.get('/api/admin/stats/timeline', adminStatsTimelineHandler);
    app.get('/api/admin/stats/tokens', adminStatsTokensHandler);
    app.get('/api/admin/audit-logs', adminAuditLogListHandler);
    app.get('/api/admin/audit-logs/:id', adminAuditLogGetHandler);
    return app;
  }

  it('returns old rows and cursor metadata through the real audit list handler', async () => {
    await archive('core.event_log', [event('archived')]);
    const response = await api().request(
      '/api/admin/audit-logs?limit=1',
      { headers: { 'X-Tenant-Id': 'tenant-a' } },
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [{ id: 'archived', action: 'auth.login' }],
      pagination: { mode: 'cursor', has_more: false },
    });
  });

  it('returns the archived detail only with its timestamp hint through the real audit handler', async () => {
    await archive('core.event_log', [event('archived')]);
    const app = api();
    const headers = { 'X-Tenant-Id': 'tenant-a' };
    expect((await app.request('/api/admin/audit-logs/archived', { headers }, env)).status).toBe(
      404
    );
    const response = await app.request(
      `/api/admin/audit-logs/archived?event_at=${OLD}`,
      { headers },
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'archived', action: 'auth.login' });
  });

  it('aggregates archived events through the actual stats SQL and returns explicit incomplete errors on R2 loss', async () => {
    await archive('core.event_log', [event('old'), { ...event('failed'), result: 'failure' }]);
    const app = api();
    const path = `/api/admin/stats/auth?from=${encodeURIComponent(new Date(OLD - 1000).toISOString())}&to=${encodeURIComponent(new Date(OLD + 1000).toISOString())}`;
    const response = await app.request(path, { headers: { 'X-Tenant-Id': 'tenant-a' } }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total_attempts: 2,
      successful: 1,
      failed: 1,
      success_rate: 50,
    });
    objects.clear();
    const missing = await app.request(path, { headers: { 'X-Tenant-Id': 'tenant-a' } }, env);
    expect(missing.status).toBe(503);
    const body = await missing.json();
    expect(body).toMatchObject({ error: 'log_query_incomplete', complete: false });
    expect(body).not.toHaveProperty('total_attempts');
  });

  it('executes the combined SQL and cursor page on native local D1 and R2 bindings', async () => {
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        name: 'log-reader-local',
        modules: true,
        script: 'export default { fetch() { return new Response("fixture"); } };',
        host: '127.0.0.1',
        cf: false,
        compatibilityDate: '2026-07-08',
        d1Databases: ['DB', 'DB_ADMIN'],
        r2Buckets: ['AUDIT_ARCHIVE'],
      })
    );
    const previous = env;
    try {
      const db = await mf.getD1Database('DB', 'log-reader-local');
      const catalog = await mf.getD1Database('DB_ADMIN', 'log-reader-local');
      await db.prepare('CREATE TABLE tenants(id TEXT PRIMARY KEY,tenant_key TEXT)').run();
      await db.prepare('INSERT INTO tenants VALUES (?,?)').bind('tenant-a', TENANT_KEY).run();
      const tableSql = (path: string, name: string) =>
        sql(path).match(new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\);`))![0];
      await db.prepare(tableSql('core/d1/001_0_4_0_core_baseline.sql', 'event_log')).run();
      await catalog
        .prepare(tableSql('admin/d1/001_0_4_0_admin_baseline.sql', 'log_object_catalog'))
        .run();
      await catalog
        .prepare(tableSql('admin/d1/001_0_4_0_admin_baseline.sql', 'log_chunk_record_index'))
        .run();
      for (const [name, type] of [
        ['source_table', 'TEXT'],
        ['chunk_id', 'TEXT'],
        ['first_event_at', 'INTEGER'],
        ['last_event_at', 'INTEGER'],
        ['max_expires_at', 'INTEGER'],
        ['never_expires', 'INTEGER'],
      ])
        await catalog.prepare(`ALTER TABLE log_object_catalog ADD COLUMN ${name} ${type}`).run();
      env = {
        DB: db,
        DB_ADMIN: catalog,
        AUDIT_ARCHIVE: await mf.getR2Bucket('AUDIT_ARCHIVE', 'log-reader-local'),
        OBJECT_ENCRYPTION_ROOT_KEY: KEY,
      } as unknown as Env;
      await archive('core.event_log', [event('native-old'), event('native-other')]);
      const view = createLogReadAdapter({
        env,
        tenantId: 'tenant-a',
        dataset: 'core.event_log',
        adapter: ensureDatabaseAdapter(db),
        page: { limit: 1, scope: 'native' },
      });
      const result = await view.adapter.query(
        'SELECT id,created_at FROM event_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?',
        ['tenant-a', 1]
      );
      expect(result).toEqual([{ id: 'native-other', created_at: OLD }]);
      expect(view.pagination()).toMatchObject({ mode: 'cursor', has_more: true });
    } finally {
      env = previous;
      await mf.dispose();
    }
  }, 20_000);

  it.each(['geography', 'timeline'] as const)(
    'includes archived rows in the actual %s aggregation',
    async (kind) => {
      await archive('core.event_log', [
        event('success'),
        { ...event('failure'), result: 'failure' },
      ]);
      const response = await api().request(
        `/api/admin/stats/${kind}?from=${new Date(OLD - 1000).toISOString()}&to=${new Date(OLD + 1000).toISOString()}&interval=day`,
        { headers: { 'X-Tenant-Id': 'tenant-a' } },
        env
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      if (kind === 'timeline') expect(data).toMatchObject({ data: [{ success: 1, failed: 1 }] });
      else
        expect(data).toMatchObject({
          by_country: [{ country_code: 'JP', total_requests: 2, successful: 1, failed: 1 }],
        });
    }
  );

  it('includes retained rows in token count predicates without changing their date semantics', async () => {
    const now = Date.now();
    await archive('core.event_log', [
      { ...event('token', now), event_type: 'token.issued', event_category: 'token' },
    ]);
    const response = await api().request(
      `/api/admin/stats/tokens?from=${new Date(now - 1000).toISOString()}&to=${new Date(now + 1000).toISOString()}`,
      { headers: { 'X-Tenant-Id': 'tenant-a' } },
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      access_tokens: { issued_today: 1, revoked_today: 0 },
      refresh_tokens: { issued_today: 0 },
    });
  });

  it('keeps administrator actors and detail references in the repository joined cursor query', async () => {
    createTable(admin, 'admin/d1/001_0_4_0_admin_baseline.sql', 'object_catalog');
    await archive('admin.admin_audit_log', [
      {
        id: 'admin-old',
        tenant_id: 'tenant-a',
        created_at: OLD,
        action: 'policy.update',
        result: 'success',
        severity: 'info',
        admin_user_id: 'actor',
        admin_email: 'actor@example.test',
        metadata_json: '{"admin_actor_type":"agent"}',
        detail_object_catalog_id: null,
      },
    ]);
    const view = createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      adapter: sqliteAdapter(admin),
      dataset: 'admin.admin_audit_log',
      page: { limit: 1, scope: 'admin' },
    });
    const records = await new AdminAuditLogRepository(view.adapter).searchAuditLogs(
      { tenant_id: 'tenant-a', action: 'policy.update' },
      { limit: 1 }
    );
    expect(records.items).toMatchObject([
      { id: 'admin-old', admin_user_id: 'actor', metadata: { admin_actor_type: 'agent' } },
    ]);
    expect(view.pagination()).toMatchObject({ mode: 'cursor', has_more: false });
  });

  it('uses portable inline operational details with a new key through the existing real detail loader', async () => {
    const encrypted = await encryptValue('archived reason', '56'.repeat(32), 'AES-256-GCM', 3);
    const row: LogSqlRow = {
      id: 'op1',
      tenant_id: 'tenant-a',
      subject_type: 'user',
      subject_id: 'u1',
      actor_id: 'admin1',
      action: 'user.update',
      request_id: null,
      created_at: Math.floor(OLD / 1000),
      expires_at: Math.floor((Date.now() + 86_400_000) / 1000),
      detail_object_catalog_id: null,
      encryption_key_version: 3,
      reason_detail_encrypted: encrypted.encrypted,
    };
    const converted: unknown = JSON.parse(
      await exportPortableOperationalLogDetailRow(JSON.stringify(portable(row)), '56'.repeat(32))
    );
    await archive('core.operational_logs', [row], {
      payload: { format: 'authrim.log.row.v1', table: 'core.operational_logs', row: converted },
    });
    const view = createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      adapter: sqliteAdapter(core),
      dataset: 'core.operational_logs',
    });
    expect(await getOperationalLog(view.adapter, PII_KEY, 'tenant-a', 'op1')).toMatchObject({
      reason_detail: 'archived reason',
      encryption_key_version: 3,
    });
  });

  it('does not revive an archived row whose hot representation no longer matches the filter', async () => {
    await archive('core.event_log', [event('changed')]);
    core
      .prepare(
        `INSERT INTO event_log(id,tenant_id,event_type,event_category,result,created_at)
      VALUES ('changed','tenant-a','other','auth','success',?)`
      )
      .run(OLD);
    expect(
      await read().adapter.query('SELECT id FROM event_log WHERE tenant_id=? AND event_type=?', [
        'tenant-a',
        'auth.login',
      ])
    ).toEqual([]);
  });

  it('honors access-trace retention in archived rows, including its exact expiry boundary', async () => {
    const cutoff = NOW - 90 * 86_400_000;
    await archive('core.permission_check_audit', [
      { id: 'expired', tenant_id: 'tenant-a', checked_at: cutoff / 1000 },
      { id: 'live', tenant_id: 'tenant-a', checked_at: cutoff / 1000 + 1 },
    ]);
    expect(
      await readArchivedLogRows({
        env,
        tenantId: 'tenant-a',
        dataset: 'core.permission_check_audit',
        now: NOW,
      })
    ).toEqual([{ id: 'live', tenant_id: 'tenant-a', checked_at: cutoff / 1000 + 1 }]);
  });

  it('rejects object and record budgets before fetching an oversized catalog object', async () => {
    await archive('core.event_log', [event('old')]);
    const get = vi.spyOn(env.AUDIT_ARCHIVE!, 'get');
    admin.prepare('UPDATE log_object_catalog SET byte_count=?').run(8 * 1024 * 1024 + 1);
    await expect(
      readArchivedLogRows({ env, tenantId: 'tenant-a', dataset: 'core.event_log' })
    ).rejects.toBeInstanceOf(LogQueryIncompleteError);
    expect(get).not.toHaveBeenCalled();
    admin.prepare('UPDATE log_object_catalog SET byte_count=100,record_count=10001').run();
    await expect(
      readArchivedLogRows({ env, tenantId: 'tenant-a', dataset: 'core.event_log' })
    ).rejects.toBeInstanceOf(LogQueryIncompleteError);
    expect(get).not.toHaveBeenCalled();
  });

  it('serves a hot first page with over 10k hot rows and 64 older archive chunks, without fetching cold bodies', async () => {
    for (let i = 0; i < 65; i++)
      await archive('core.event_log', [event(`old${i}`, OLD - i * 1000)]);
    const insert =
      core.prepare(`INSERT INTO event_log(id,tenant_id,event_type,event_category,result,created_at)
      VALUES (?,'tenant-a','auth.login','auth','success',?)`);
    core.exec('BEGIN');
    for (let i = 0; i < 10_100; i++) insert.run(`hot${i}`, NOW + i);
    core.exec('COMMIT');
    const get = vi.spyOn(env.AUDIT_ARCHIVE!, 'get');
    const view = createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      adapter: sqliteAdapter(core),
      dataset: 'core.event_log',
      page: { limit: 20, scope: 'scale' },
    });
    const page = await view.adapter.query<{ id: string; created_at: number }>(
      'SELECT id,created_at FROM event_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?',
      ['tenant-a', 20]
    );
    expect(page).toHaveLength(20);
    expect(page[0].id).toBe('hot10099');
    expect(view.pagination()?.has_more).toBe(true);
    expect(get).not.toHaveBeenCalled();
    await expect(
      read().adapter.queryOne('SELECT COUNT(*) AS n FROM event_log WHERE tenant_id=?', ['tenant-a'])
    ).rejects.toBeInstanceOf(LogQueryIncompleteError);
  });

  it('pages through more archive chunks than one read budget by proving each filtered top-N boundary', async () => {
    for (let i = 0; i < 65; i++)
      await archive('core.event_log', [event(`old${i}`, OLD + i * 1000)]);
    const get = vi.spyOn(env.AUDIT_ARCHIVE!, 'get');
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let p = 0; p < 2; p++) {
      const view = createLogReadAdapter({
        env,
        tenantId: 'tenant-a',
        adapter: sqliteAdapter(core),
        dataset: 'core.event_log',
        page: { limit: 2, scope: 'scale-cold', cursor },
      });
      const rows = await view.adapter.query<{ id: string; created_at: number }>(
        'SELECT id,created_at FROM event_log WHERE tenant_id=? AND event_type=? ORDER BY created_at DESC LIMIT ?',
        ['tenant-a', 'auth.login', 2]
      );
      ids.push(...rows.map((row) => row.id));
      cursor = view.pagination()!.next_cursor!;
    }
    expect(ids).toEqual(['old64', 'old63', 'old62', 'old61']);
    expect(get.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('does not stop early across equal-time chunks whose IDs may precede the selected tail', async () => {
    for (const id of ['a', 'e', 'c', 'b', 'd']) await archive('core.event_log', [event(id)]);
    const get = vi.spyOn(env.AUDIT_ARCHIVE!, 'get');
    const view = createLogReadAdapter({
      env,
      tenantId: 'tenant-a',
      adapter: sqliteAdapter(core),
      dataset: 'core.event_log',
      page: { limit: 1, scope: 'ties' },
    });
    expect(
      await view.adapter.query(
        'SELECT id,created_at FROM event_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?',
        ['tenant-a', 1]
      )
    ).toEqual([{ id: 'e', created_at: OLD }]);
    expect(get).toHaveBeenCalledTimes(5);
  });
});
