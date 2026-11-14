import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  adapter: undefined as Record<string, unknown> | undefined,
  audit: vi.fn(async () => undefined),
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createAuditLog: state.audit,
  getTenantIdFromContext: () => 'tenant-a',
  requireDedicatedAdminDatabaseAdapter: () => state.adapter,
}));

import { sha256Hex } from '@authrim/ar-lib-core';
import {
  adminIdentifierStoreImportHandler,
  adminIdentifierStoresListHandler,
} from '../identifier-stores';

/** The table as the migration makes it, in SQLite. */
const migration = readFileSync(
  resolve(__dirname, '../../../../migrations/admin/d1/017_mapped_identifier_values.sql'),
  'utf8'
);
/** The part of node:sqlite used here (this package has no Node types). */
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const SQLITE_MODULE = 'node:sqlite';
const { DatabaseSync } = (await import(/* @vite-ignore */ SQLITE_MODULE)) as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};
let db: SqliteDatabase;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(migration);
  state.adapter = {
    query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) ?? null,
    batch: async (statements: Array<{ sql: string; params: unknown[] }>) => {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params }) => db.prepare(sql).run(...params));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  state.audit.mockClear();
});
afterEach(() => db.close());

const app = new Hono();
app.get('/stores', adminIdentifierStoresListHandler as never);
app.post('/stores/:name/import', adminIdentifierStoreImportHandler as never);
const post = (name: string, body: unknown) =>
  app.request(`/stores/${name}/import`, { method: 'POST', body: JSON.stringify(body) });
const rows = () =>
  db
    .prepare('SELECT audience, source_hash, identifier FROM mapped_identifier_values ORDER BY 1, 3')
    .all() as Array<{ audience: string; source_hash: string; identifier: string }>;
const SP = 'https://sp.example.org';
const csv = (...lines: string[]) => ['audience,source_value,identifier', ...lines].join('\n');

describe('identifier store import', () => {
  it('keeps the source value only as its SHA-256, and echoes nothing back', async () => {
    const response = await post('shibpid', {
      csv: csv(`${SP},jdoe,AAAA`, `"${SP}","o""brien",BBBB`),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ store: 'shibpid', created: 2, replaced: 0, unchanged: 0 });
    expect(text).not.toMatch(/jdoe|AAAA/);
    expect(rows()).toEqual([
      { audience: SP, source_hash: await sha256Hex('jdoe'), identifier: 'AAAA' },
      { audience: SP, source_hash: await sha256Hex('o"brien'), identifier: 'BBBB' },
    ]);
    expect(JSON.stringify(state.audit.mock.calls)).not.toMatch(/jdoe|AAAA/);
  });

  it('leaves the same rows alone, and replaces another identifier only when asked', async () => {
    await post('s', { csv: csv(`${SP},jdoe,AAAA`) });
    expect(await (await post('s', { csv: csv(`${SP},jdoe,AAAA`) })).json()).toMatchObject({
      unchanged: 1,
    });
    expect((await post('s', { csv: csv(`${SP},jdoe,CCCC`) })).status).toBe(409);
    expect(rows()[0].identifier).toBe('AAAA');
    expect(
      await (await post('s', { csv: csv(`${SP},jdoe,CCCC`), replace: true })).json()
    ).toMatchObject({ replaced: 1 });
    expect(rows()[0].identifier).toBe('CCCC');
  });

  it('never gives one identifier to two people, in the file or against the store', async () => {
    expect((await post('s', { csv: csv(`${SP},jdoe,AAAA`, `${SP},asmith,AAAA`) })).status).toBe(
      400
    );
    await post('s', { csv: csv(`${SP},jdoe,AAAA`) });
    const taken = await post('s', { csv: csv(`${SP},asmith,AAAA`), replace: true });
    expect(taken.status).toBe(409);
    expect(rows()).toHaveLength(1);
    // The same identifier for another audience is someone else's business.
    expect((await post('s', { csv: csv(`https://other.example,asmith,AAAA`) })).status).toBe(200);
  });

  it('writes nothing when any row is refused', async () => {
    await post('s', { csv: csv(`${SP},jdoe,AAAA`) });
    const mixed = await post('s', { csv: csv(`${SP},new-person,DDDD`, `${SP},jdoe,EEEE`) });
    expect(mixed.status).toBe(409);
    expect(rows()).toHaveLength(1);
  });

  it('refuses a bad name, header, row or value', async () => {
    for (const [name, body] of [
      ['Bad Name', { csv: csv(`${SP},a,b`) }],
      ['s', { csv: 'aud,src,id\nx,y,z' }],
      ['s', { csv: csv(`${SP},a`) }],
      ['s', { csv: csv(`${SP},,b`) }],
      ['s', { csv: csv(`${SP},a,has space`) }],
      ['s', { csv: csv(`${SP},a,b`, `${SP},a,c`) }],
      ['s', { csv: csv('"unterminated,a,b') }],
      ['s', { csv: csv(`${SP},a,b`), replace: 'yes' }],
    ] as const) {
      expect((await post(name, body)).status, JSON.stringify([name, body])).toBe(400);
    }
    expect(rows()).toHaveLength(0);
  });

  it('lists the stores with counts only', async () => {
    await post('shibpid', { csv: csv(`${SP},jdoe,AAAA`, `${SP},asmith,BBBB`) });
    const listed = await (await app.request('/stores')).json();
    expect(listed).toEqual({
      stores: [{ name: 'shibpid', count: 2, updatedAt: expect.any(Number) as number }],
    });
  });
});
