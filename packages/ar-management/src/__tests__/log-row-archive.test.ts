// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { decryptLogChunkBody, deriveLogChunkEncryptionKey } from '@authrim/ar-lib-logging/chunks';

const settings = vi.hoisted(() => ({ days: 7, checkApi: 90 }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolvePlatformSettingsWithSources: vi.fn(async (_env: unknown, category: string) => ({
    values:
      category === 'log-storage'
        ? { 'log-storage.d1_retention_days': settings.days }
        : { 'audit.check_api_retention_days': settings.checkApi },
    sources: {},
  })),
}));

import { encryptValue } from '@authrim/ar-lib-core/utils/pii-encryption';
import { PHASE8_LOG_TIMESTAMP_COLUMNS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-log-window';
import {
  createLogRowArchiver,
  LOG_ROW_ARCHIVE_FORMAT,
  LOG_ROW_ARCHIVE_TABLES,
} from '../log-row-archive';

type SqlValue = string | number | bigint | null | Uint8Array;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ROOT_KEY = '45'.repeat(32);
const PII_KEY = '67'.repeat(32);
const TENANT_KEY = 'key-a';
const migration = (path: string) =>
  readFileSync(new URL(`../../../../migrations/${path}`, import.meta.url), 'utf8');

function adapter(db: DatabaseSync): DatabaseAdapter {
  const run = (sql: string, params: unknown[] = []) => {
    const result = db.prepare(sql).run(...(params as SqlValue[]));
    return { rowsAffected: Number(result.changes), success: true };
  };
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SqlValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SqlValue[])) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return run(sql, params);
    },
    async batch(statements: { sql: string; params?: unknown[] }[]) {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params }) => run(sql, params));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async transaction() {
      throw new Error('unused');
    },
    async isHealthy() {
      return true;
    },
    getType() {
      return 'd1';
    },
    async close() {},
  } as unknown as DatabaseAdapter;
}

function bucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key: string, value: Uint8Array) {
      objects.set(key, new Uint8Array(value));
      return {};
    },
  };
}

function coreDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tenants (id TEXT NOT NULL PRIMARY KEY, tenant_key TEXT);
    INSERT INTO tenants VALUES ('tenant-a', '${TENANT_KEY}');
    CREATE TABLE audit_log (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT,
      action TEXT NOT NULL, ip_address TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE event_log (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL,
      event_type TEXT NOT NULL, created_at INTEGER NOT NULL, retention_until INTEGER);
    CREATE TABLE operational_logs (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL,
      action TEXT NOT NULL, reason_detail_encrypted TEXT, encryption_key_version INTEGER NOT NULL,
      detail_object_catalog_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  `);
  for (const table of [
    'flow_audit_events',
    'provisioning_assignment_events',
    'provisioning_revocation_events',
    'service_group_audit',
    'directory_auth_migration_transaction_events',
  ])
    db.exec(
      `CREATE TABLE ${table} (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, created_at INTEGER NOT NULL)`
    );
  db.exec(`CREATE TABLE permission_change_audit (id TEXT NOT NULL PRIMARY KEY,
      tenant_id TEXT NOT NULL, timestamp INTEGER NOT NULL);
    CREATE TABLE permission_check_audit (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL,
      checked_at INTEGER NOT NULL);`);
  return db;
}

function adminDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE log_object_catalog (id TEXT PRIMARY KEY, tenant_key TEXT NOT NULL,
      log_type TEXT NOT NULL, plane TEXT NOT NULL, surface TEXT, object_key TEXT NOT NULL,
      object_kind TEXT NOT NULL, status TEXT NOT NULL, record_count INTEGER NOT NULL DEFAULT 0,
      byte_count INTEGER NOT NULL DEFAULT 0, checksum_sha256 TEXT, compression TEXT,
      encryption_scope TEXT, key_version INTEGER, created_at INTEGER NOT NULL,
      committed_at INTEGER, deleted_at INTEGER);
    CREATE TABLE log_chunk_record_index (record_id TEXT NOT NULL, object_catalog_id TEXT,
      status TEXT);
    CREATE TABLE scheduled_task_leases (task_id TEXT NOT NULL PRIMARY KEY,
      lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE admin_audit_log (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL,
      action TEXT NOT NULL, admin_email TEXT, created_at INTEGER NOT NULL);
  `);
  for (const table of [
    'federation_selected_entity_import_events',
    'key_access_events',
    'mapping_events',
  ])
    db.exec(
      `CREATE TABLE ${table} (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, created_at INTEGER NOT NULL)`
    );
  db.exec(migration('admin/d1/033_tenant_backup_r2_generation_retention.sql'));
  db.exec(migration('admin/d1/047_log_row_archive.sql'));
  return db;
}

describe('log row archive', () => {
  let core: DatabaseSync;
  let admin: DatabaseSync;
  let archive: ReturnType<typeof bucket>;
  let clock: number;
  let kv: Map<string, string>;

  const env = () =>
    ({
      DB: adapter(core),
      DB_ADMIN: adapter(admin),
      SETTINGS: {},
      AUDIT_ARCHIVE: archive,
      OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
      PII_ENCRYPTION_KEY: PII_KEY,
      AUTHRIM_CONFIG: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => void kv.set(key, value),
      },
    }) as unknown as Env;
  const log = { warn: vi.fn(), debug: vi.fn() } as never;
  const run = (budgetMs = 10_000, now = () => clock) =>
    createLogRowArchiver({ env: env(), log, now }).run(
      [{ tenantId: 'tenant-a', adapters: [] }],
      budgetMs
    );
  const ids = (db: DatabaseSync, table: string) =>
    (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map(
      ({ id }) => id
    );
  const catalog = () =>
    admin
      .prepare('SELECT * FROM log_object_catalog ORDER BY source_table, first_event_at')
      .all() as Record<string, unknown>[];
  const records = async (row: Record<string, unknown>) => {
    const stored = archive.objects.get(row.object_key as string) ?? new Uint8Array();
    const { body } = await decryptLogChunkBody({
      storedBody: stored,
      keyBytes: await deriveLogChunkEncryptionKey({
        rootKeyHex: ROOT_KEY,
        tenantKey: TENANT_KEY,
        logType: row.log_type as never,
        plane: 'archive',
        keyVersion: 1,
      }),
      tenantKey: TENANT_KEY,
      logType: row.log_type as never,
      plane: 'archive',
      objectKey: row.object_key as string,
      chunkId: row.chunk_id as string,
    });
    return new TextDecoder()
      .decode(gunzipSync(body))
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line));
  };

  beforeEach(() => {
    core = coreDb();
    admin = adminDb();
    archive = bucket();
    clock = NOW;
    kv = new Map();
    settings.days = 7;
    settings.checkApi = 90;
  });
  afterEach(() => {
    core.close();
    admin.close();
  });

  it('archives only tables whose event time is an integer in milliseconds or seconds', () => {
    for (const table of LOG_ROW_ARCHIVE_TABLES)
      expect(['ms', 's']).toContain(PHASE8_LOG_TIMESTAMP_COLUMNS[table.datasetId]?.unit);
  });

  it('moves whole rows older than the D1 retention to one chunk per table, in each unit', async () => {
    const old = NOW - 8 * DAY;
    core
      .prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)')
      .run('a-old', 'tenant-a', 'user-1', 'user.login', '192.0.2.1', Math.floor(old / 1000));
    core
      .prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        'a-new',
        'tenant-a',
        'user-1',
        'user.login',
        '192.0.2.1',
        Math.floor((NOW - DAY) / 1000)
      );
    core
      .prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)')
      .run('a-other', 'tenant-b', 'user-2', 'user.login', null, Math.floor(old / 1000));
    admin
      .prepare('INSERT INTO admin_audit_log VALUES (?, ?, ?, ?, ?)')
      .run('m-old', 'tenant-a', 'admin.update', 'admin@example.test', old);

    const result = await run();
    expect(result).toMatchObject({
      enabled: true,
      leased: true,
      complete: true,
      moved: 2,
      batches: 2,
    });
    expect(ids(core, 'audit_log')).toEqual(['a-new', 'a-other']);
    expect(ids(admin, 'admin_audit_log')).toEqual([]);

    const chunks = catalog();
    expect(
      chunks.map((row) => [row.source_table, row.log_type, row.status, row.record_count])
    ).toEqual([
      ['admin.admin_audit_log', 'admin_audit', 'committed', 1],
      ['core.audit_log', 'audit', 'committed', 1],
    ]);
    const auditChunk = chunks[1];
    expect(auditChunk).toMatchObject({
      first_event_at: Math.floor(old / 1000) * 1000,
      last_event_at: Math.floor(old / 1000) * 1000,
      never_expires: 1,
      max_expires_at: null,
    });
    // Whole rows, typed, with no per-record index.
    expect(admin.prepare('SELECT count(*) AS n FROM log_chunk_record_index').get()).toEqual({
      n: 0,
    });
    expect(await records(auditChunk)).toEqual([
      {
        format: LOG_ROW_ARCHIVE_FORMAT,
        table: 'core.audit_log',
        row: {
          id: ['text', 'a-old'],
          tenant_id: ['text', 'tenant-a'],
          user_id: ['text', 'user-1'],
          action: ['text', 'user.login'],
          ip_address: ['text', '192.0.2.1'],
          created_at: ['integer', String(Math.floor(old / 1000))],
        },
      },
    ]);
    expect(
      admin.prepare("SELECT count(*) AS n FROM log_archive_batches WHERE state = 'done'").get()
    ).toEqual({ n: 2 });
  });

  it('records when the last row expires, and never for a chunk with a row without expiry', async () => {
    const old = NOW - 10 * DAY;
    core
      .prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?)')
      .run('e1', 'tenant-a', 'x', old, old + 90 * DAY);
    core
      .prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?)')
      .run('e2', 'tenant-a', 'x', old + 1, old + 30 * DAY);
    const detail = await encryptValue('locked after review', PII_KEY, 'AES-256-GCM', 1);
    core
      .prepare('INSERT INTO operational_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'o1',
        'tenant-a',
        'suspend',
        detail.encrypted,
        1,
        null,
        Math.floor(old / 1000),
        Math.floor((old + 60 * DAY) / 1000)
      );
    core
      .prepare('INSERT INTO permission_check_audit VALUES (?, ?, ?)')
      .run('p1', 'tenant-a', Math.floor(old / 1000));
    core
      .prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?)')
      .run('e3', 'tenant-a', 'x', old + 2, null);

    await run();
    const bySource = Object.fromEntries(catalog().map((row) => [row.source_table, row]));
    // e3 has no expiry, so the event_log chunk (e1..e3) never expires.
    expect(bySource['core.event_log']).toMatchObject({
      never_expires: 1,
      max_expires_at: null,
      record_count: 3,
    });
    expect(bySource['core.operational_logs']).toMatchObject({
      never_expires: 0,
      max_expires_at: Math.floor((old + 60 * DAY) / 1000) * 1000,
    });
    // The source-key ciphertext leaves as portable plaintext inside the encrypted chunk.
    const [operational] = await records(bySource['core.operational_logs']);
    expect(JSON.parse(operational.row.reason_detail_encrypted[1])).toMatchObject({
      kind: 'operational_log_detail',
      value: 'locked after review',
    });
    expect(bySource['core.permission_check_audit']).toMatchObject({
      never_expires: 0,
      max_expires_at: Math.floor(old / 1000) * 1000 + 90 * DAY,
    });
  });

  it('finishes a batch whose chunk was committed before its rows were deleted', async () => {
    core
      .prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)')
      .run('a1', 'tenant-a', null, 'x', null, Math.floor((NOW - 9 * DAY) / 1000));
    // The first run stops right after the chunk is committed.
    const original = DatabaseSync.prototype.prepare;
    const failing = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      if (sql.startsWith('DELETE FROM "audit_log"')) throw new Error('lost');
      return original.call(this, sql);
    });
    expect(await run()).toMatchObject({ failed: 1 });
    failing.mockRestore();
    expect(ids(core, 'audit_log')).toEqual(['a1']);
    const objects = archive.objects.size;

    // A newer row arrives; the open batch is finished first and never overlapped.
    core
      .prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)')
      .run('a0', 'tenant-a', null, 'x', null, Math.floor((NOW - 10 * DAY) / 1000));
    await run();
    expect(archive.objects.size).toBe(objects + 1);
    expect(ids(core, 'audit_log')).toEqual([]);
    const chunks = catalog();
    expect(chunks.map((row) => row.record_count)).toEqual([1, 1]);
  });

  it('rewrites the same chunk when the run stopped before the chunk was written', async () => {
    core
      .prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)')
      .run('a1', 'tenant-a', null, 'x', null, Math.floor((NOW - 9 * DAY) / 1000));
    const put = vi.spyOn(archive, 'put').mockRejectedValueOnce(new Error('r2 down'));
    expect(await run()).toMatchObject({ failed: 1 });
    put.mockRestore();
    const [batch] = admin.prepare('SELECT * FROM log_archive_batches').all() as {
      id: string;
      state: string;
    }[];
    expect(batch.state).toBe('pending');
    // Leases of a crashed writer expire before the chunk can be reclaimed.
    clock += 2 * 60_000;
    await run();
    expect(catalog().map((row) => [row.id, row.status])).toEqual([
      [`obj_${batch.id}`, 'committed'],
    ]);
    expect(ids(core, 'audit_log')).toEqual([]);
  });

  it('does nothing while the retention is 0 or another run holds the lease', async () => {
    core
      .prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)')
      .run('a1', 'tenant-a', null, 'x', null, Math.floor((NOW - 9 * DAY) / 1000));
    settings.days = 0;
    expect(await run()).toEqual({ enabled: false, leased: false, complete: false });
    settings.days = 7;
    admin
      .prepare('INSERT INTO scheduled_task_leases VALUES (?, ?, ?, ?)')
      .run('log_row_archive', 'other', NOW + 60_000, NOW);
    expect(await run()).toEqual({ enabled: true, leased: false, complete: false });
    expect(ids(core, 'audit_log')).toEqual(['a1']);
  });

  it('stops at its budget and reports the page incomplete', async () => {
    const insert = core.prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)');
    core.exec('BEGIN');
    for (let index = 0; index < 2500; index++)
      insert.run(
        `a${String(index).padStart(5, '0')}`,
        'tenant-a',
        null,
        'x',
        null,
        Math.floor((NOW - 9 * DAY) / 1000)
      );
    core.exec('COMMIT');
    // Writing a chunk takes 6 s here: the 10 s budget ends after the second batch.
    const put = archive.put.bind(archive);
    vi.spyOn(archive, 'put').mockImplementation(async (key: string, value: Uint8Array) => {
      clock += 6_000;
      return put(key, value);
    });
    const result = await run();
    expect(result).toMatchObject({ complete: false, moved: 2000, batches: 2 });
    expect(ids(core, 'audit_log')).toHaveLength(500);
    vi.mocked(archive.put).mockRestore();
    expect(await run()).toMatchObject({ complete: true });
    expect(ids(core, 'audit_log')).toEqual([]);
    expect(
      catalog()
        .map((row) => row.record_count)
        .sort()
    ).toEqual([1000, 1000, 500]);
  });

  it('cuts batches at 4 MiB of rows and skips a table with a row too large to move', async () => {
    const insert = core.prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)');
    const at = Math.floor((NOW - 9 * DAY) / 1000);
    const large = 'x'.repeat(200 * 1024);
    for (let index = 0; index < 25; index++)
      insert.run(`a${String(index).padStart(2, '0')}`, 'tenant-a', null, 'x', large, at);
    // Over the 256 KiB row limit: this table stops, the others still move.
    admin
      .prepare('INSERT INTO admin_audit_log VALUES (?, ?, ?, ?, ?)')
      .run('m-huge', 'tenant-a', 'x', 'y'.repeat(300 * 1024), NOW - 9 * DAY);
    admin
      .prepare('INSERT INTO key_access_events VALUES (?, ?, ?)')
      .run('k1', 'tenant-a', NOW - 9 * DAY);

    expect(await run()).toMatchObject({ failed: 1, complete: false });
    expect(ids(core, 'audit_log')).toEqual([]);
    expect(ids(admin, 'admin_audit_log')).toEqual(['m-huge']);
    expect(ids(admin, 'key_access_events')).toEqual([]);
    const counts = catalog()
      .filter((row) => row.source_table === 'core.audit_log')
      .map((row) => row.record_count as number)
      .sort((a, b) => b - a);
    expect(counts).toEqual([20, 5]);
  });

  it('moves one batch of each table in turn, so a large backlog does not starve the others', async () => {
    const at = NOW - 9 * DAY;
    const audit = core.prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)');
    const adminAudit = admin.prepare('INSERT INTO admin_audit_log VALUES (?, ?, ?, ?, ?)');
    core.exec('BEGIN');
    admin.exec('BEGIN');
    for (let index = 0; index < 3000; index++) {
      audit.run(
        `a${String(index).padStart(5, '0')}`,
        'tenant-a',
        null,
        'x',
        null,
        Math.floor(at / 1000)
      );
      adminAudit.run(`m${String(index).padStart(5, '0')}`, 'tenant-a', 'x', null, at);
    }
    core.exec('COMMIT');
    admin.exec('COMMIT');
    const put = archive.put.bind(archive);
    vi.spyOn(archive, 'put').mockImplementation(async (key: string, value: Uint8Array) => {
      clock += 6_000;
      return put(key, value);
    });
    expect(await run()).toMatchObject({ batches: 2, complete: false });
    expect(ids(core, 'audit_log')).toHaveLength(2000);
    expect(ids(admin, 'admin_audit_log')).toHaveLength(2000);
  });

  it('leaves a batch it cannot resume open and still moves the other tables', async () => {
    admin
      .prepare(
        `INSERT INTO log_archive_batches VALUES (?, 'tenant-a', 'GONE', 'core.audit_log', ?, ?, ?, ?, 'pending', ?)`
      )
      .run('arc_gone', 'obj_arc_gone', 'arc_gone', NOW - 9 * DAY, JSON.stringify(['a1']), NOW);
    core
      .prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)')
      .run('a1', 'tenant-a', null, 'x', null, Math.floor((NOW - 9 * DAY) / 1000));
    admin
      .prepare('INSERT INTO key_access_events VALUES (?, ?, ?)')
      .run('k1', 'tenant-a', NOW - 9 * DAY);

    expect(await run()).toMatchObject({ complete: false });
    // The batch for a store this run cannot reach stays open; rows of the other stores and
    // tables still move.
    expect(
      admin.prepare("SELECT state FROM log_archive_batches WHERE id = 'arc_gone'").get()
    ).toEqual({ state: 'pending' });
    expect(ids(core, 'audit_log')).toEqual([]);
    expect(ids(admin, 'key_access_events')).toEqual([]);
  });

  it('scans for at most half the budget and goes on from there when the page comes back', async () => {
    core
      .prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?)')
      .run('e1', 'tenant-a', 'x', NOW - 9 * DAY, null);
    // admin_audit_log is the 11th of 14 scans.
    admin
      .prepare('INSERT INTO admin_audit_log VALUES (?, ?, ?, ?, ?)')
      .run('m1', 'tenant-a', 'x', null, NOW - 9 * DAY);
    // Each scan takes 2 s here: a run scans 3 tables, then moves what they found.
    const original = DatabaseSync.prototype.prepare;
    const slow = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      if (sql.includes('SELECT DISTINCT tenant_id')) clock += 2_000;
      return original.call(this, sql);
    });
    try {
      expect(await run()).toMatchObject({ moved: 1, complete: false });
      expect(ids(core, 'event_log')).toEqual([]);
      expect(ids(admin, 'admin_audit_log')).toEqual(['m1']);
      // Later runs of the page scan the next tables in turn.
      let runs = 1;
      while (ids(admin, 'admin_audit_log').length && runs < 10) {
        await run();
        runs += 1;
      }
      expect(runs).toBe(4);
    } finally {
      slow.mockRestore();
    }
  });

  it('goes on with the round robin where the last run stopped, so busy tables do not starve the others', async () => {
    const at = NOW - 9 * DAY;
    const event = core.prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?)');
    const audit = core.prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)');
    core.exec('BEGIN');
    for (let index = 0; index < 20_000; index++) {
      event.run(`e${String(index).padStart(5, '0')}`, 'tenant-a', 'x', at, null);
      audit.run(
        `a${String(index).padStart(5, '0')}`,
        'tenant-a',
        null,
        'x',
        null,
        Math.floor(at / 1000)
      );
    }
    core.exec('COMMIT');
    admin.prepare('INSERT INTO key_access_events VALUES (?, ?, ?)').run('k1', 'tenant-a', at);
    // Two batches fit in a run.
    const put = archive.put.bind(archive);
    vi.spyOn(archive, 'put').mockImplementation(async (key: string, value: Uint8Array) => {
      clock += 6_000;
      return put(key, value);
    });
    let runs = 0;
    while (ids(admin, 'key_access_events').length && runs < 20) {
      await run();
      runs += 1;
    }
    // The first run moves event_log and audit_log and stops before key_access_events; the second
    // starts there, then event_log gets its second batch.
    expect(runs).toBe(2);
    expect(ids(core, 'event_log')).toHaveLength(18_000);
  }, 30_000);

  it('reaches every tenant of a busy table in turn across runs', async () => {
    const at = Math.floor((NOW - 9 * DAY) / 1000);
    const audit = core.prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)');
    core.exec('BEGIN');
    for (let index = 0; index < 20_000; index++) {
      audit.run(`a${String(index).padStart(5, '0')}`, 'tenant-a', null, 'x', null, at);
      audit.run(`b${String(index).padStart(5, '0')}`, 'tenant-b', null, 'x', null, at);
    }
    audit.run('c1', 'tenant-c', null, 'x', null, at);
    core.exec('COMMIT');
    for (const tenantId of ['tenant-b', 'tenant-c'])
      core.prepare('INSERT INTO tenants VALUES (?, ?)').run(tenantId, `key-${tenantId}`);
    const put = archive.put.bind(archive);
    vi.spyOn(archive, 'put').mockImplementation(async (key: string, value: Uint8Array) => {
      clock += 6_000;
      return put(key, value);
    });
    const page = ['tenant-a', 'tenant-b', 'tenant-c'].map((tenantId) => ({
      tenantId,
      adapters: [],
    }));
    let runs = 0;
    const left = () =>
      core.prepare("SELECT count(*) AS n FROM audit_log WHERE tenant_id = 'tenant-c'").get() as {
        n: number;
      };
    while (left().n && runs < 10) {
      await createLogRowArchiver({ env: env(), log, now: () => clock }).run(page, 10_000);
      runs += 1;
    }
    // Run 1 serves tenant-a and tenant-b; run 2 starts the page at tenant-b, then tenant-c.
    expect(runs).toBe(2);
  }, 30_000);

  it('reaches every busy table and tenant within a cycle of runs', async () => {
    const tenants = ['tenant-a', 'tenant-b', 'tenant-c'];
    for (const tenantId of tenants.slice(1))
      core.prepare('INSERT INTO tenants VALUES (?, ?)').run(tenantId, `key-${tenantId}`);
    const at = NOW - 9 * DAY;
    core.exec('BEGIN');
    admin.exec('BEGIN');
    for (const tenantId of tenants)
      for (let index = 0; index < 1500; index++) {
        const id = `${tenantId}-${String(index).padStart(4, '0')}`;
        core
          .prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?)')
          .run(id, tenantId, 'x', at, null);
        core
          .prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, tenantId, null, 'x', null, Math.floor(at / 1000));
        admin.prepare('INSERT INTO key_access_events VALUES (?, ?, ?)').run(id, tenantId, at);
      }
    core.exec('COMMIT');
    admin.exec('COMMIT');
    const put = archive.put.bind(archive);
    vi.spyOn(archive, 'put').mockImplementation(async (key: string, value: Uint8Array) => {
      clock += 6_000;
      return put(key, value);
    });
    const page = tenants.map((tenantId) => ({ tenantId, adapters: [] }));
    // Two batches a run: within five runs each of the nine (table, tenant) pairs gets a batch.
    for (let runs = 0; runs < 5; runs++)
      await createLogRowArchiver({ env: env(), log, now: () => clock }).run(page, 10_000);
    for (const [db, table] of [
      [core, 'event_log'],
      [core, 'audit_log'],
      [admin, 'key_access_events'],
    ] as const)
      for (const tenantId of tenants)
        expect(
          (
            db.prepare(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tenantId) as {
              n: number;
            }
          ).n
        ).toBeLessThanOrEqual(500);
  }, 30_000);

  it('keeps the batches a run left due while later runs scan other tables', async () => {
    const tenants = ['tenant-a', 'tenant-b', 'tenant-c'];
    for (const tenantId of tenants.slice(1))
      core.prepare('INSERT INTO tenants VALUES (?, ?)').run(tenantId, `key-${tenantId}`);
    const at = NOW - 9 * DAY;
    const insert = core.prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?)');
    core.exec('BEGIN');
    for (const tenantId of tenants)
      for (let index = 0; index < 3000; index++)
        insert.run(`${tenantId}-${String(index).padStart(4, '0')}`, tenantId, 'x', at, null);
    core.exec('COMMIT');
    // Scans take 2 s and chunks 2 s: a run scans 3 tables and moves 2 or 3 batches.
    const original = DatabaseSync.prototype.prepare;
    const slow = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      if (sql.includes('SELECT DISTINCT tenant_id')) clock += 2_000;
      return original.call(this, sql);
    });
    const put = archive.put.bind(archive);
    vi.spyOn(archive, 'put').mockImplementation(async (key: string, value: Uint8Array) => {
      clock += 2_000;
      return put(key, value);
    });
    const page = tenants.map((tenantId) => ({ tenantId, adapters: [] }));
    const left = (tenantId: string) =>
      (
        core.prepare('SELECT count(*) AS n FROM event_log WHERE tenant_id = ?').get(tenantId) as {
          n: number;
        }
      ).n;
    try {
      // The first run scans event_log and moves tenant-a and tenant-b; the second scans other
      // tables but still owes tenant-c its batch.
      await createLogRowArchiver({ env: env(), log, now: () => clock }).run(page, 10_000);
      expect(left('tenant-c')).toBe(3000);
      await createLogRowArchiver({ env: env(), log, now: () => clock }).run(page, 10_000);
      expect(left('tenant-c')).toBeLessThan(3000);
    } finally {
      slow.mockRestore();
    }
  }, 30_000);

  it('gives up a batch whose chunk was deleted by a repair and moves its rows anew', async () => {
    core
      .prepare('INSERT INTO audit_log VALUES (?, ?, ?, ?, ?, ?)')
      .run('a1', 'tenant-a', null, 'x', null, Math.floor((NOW - 9 * DAY) / 1000));
    const put = vi.spyOn(archive, 'put').mockRejectedValueOnce(new Error('r2 down'));
    expect(await run()).toMatchObject({ failed: 1 });
    put.mockRestore();
    // A catalog repair deleted the chunk that was never written.
    admin.prepare("UPDATE log_object_catalog SET status = 'deleted'").run();
    const [given] = catalog();

    await run();
    expect(ids(core, 'audit_log')).toEqual([]);
    const chunks = catalog();
    expect(chunks.map((row) => row.status).sort()).toEqual(['committed', 'deleted']);
    const written = chunks.find((row) => row.status === 'committed')!;
    expect(written.id).not.toBe(given.id);
    expect(archive.objects.has(written.object_key as string)).toBe(true);
    expect(await records(written)).toHaveLength(1);
  });

  it('does not retire an expired chunk whose rows are still being deleted', async () => {
    core
      .prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?)')
      .run('e1', 'tenant-a', 'x', NOW - 100 * DAY, NOW - DAY);
    const original = DatabaseSync.prototype.prepare;
    const failing = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql: string
    ) {
      if (sql.startsWith('DELETE FROM "event_log"')) throw new Error('lost');
      return original.call(this, sql);
    });
    expect(await run()).toMatchObject({ failed: 1, retired: 0 });
    failing.mockRestore();
    expect(catalog()[0]).toMatchObject({ status: 'committed' });

    // The next run closes the batch first; then the chunk expires.
    expect(await run()).toMatchObject({ failed: 0, retired: 1 });
    expect(ids(core, 'event_log')).toEqual([]);
    expect(catalog()[0]).toMatchObject({ status: 'deleted' });
    expect(admin.prepare('SELECT state FROM log_archive_batches').all()).toEqual([
      { state: 'done' },
    ]);
  });

  it('retires chunks whose every row has expired', async () => {
    const old = NOW - 100 * DAY;
    core
      .prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?)')
      .run('e1', 'tenant-a', 'x', old, NOW - DAY);
    core
      .prepare('INSERT INTO event_log VALUES (?, ?, ?, ?, ?)')
      .run('e2', 'tenant-b', 'x', old, null);
    await run();
    // The expired chunk is retired in the same run; its body waits for the R2 cleanup.
    const [chunk] = catalog();
    expect(chunk).toMatchObject({ status: 'deleted', source_table: 'core.event_log' });
    expect(
      admin.prepare('SELECT reason, object_key FROM tenant_backup_r2_retired_generations').all()
    ).toEqual([{ reason: 'catalog_delete', object_key: chunk.object_key }]);
  });
});
