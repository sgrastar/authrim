import { createRequire } from 'node:module';
import type { D1Database } from '@cloudflare/workers-types';

interface Sqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => Sqlite;
};

/** A D1-shaped binding over a real SQLite `lookup_tenant_aliases` table. */
export function sqliteAliasD1(
  rows: Array<{
    tenantId: string;
    virtualBucket: number;
    aliasKind: string;
    digest: string;
    projectionJson: string;
  }>
): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE lookup_tenant_aliases (
    virtual_bucket INTEGER, alias_kind TEXT, alias_sha256_digest TEXT, tenant_id TEXT,
    route_schema_version INTEGER, route_projection_json TEXT, tenant_lifecycle_state TEXT,
    runtime_route_status TEXT, lifecycle_state TEXT
  )`);
  const insert = db.prepare(
    "INSERT INTO lookup_tenant_aliases VALUES (?, ?, ?, ?, 1, ?, 'active', 'active', 'active')"
  );
  for (const row of rows) {
    insert.run(row.virtualBucket, row.aliasKind, row.digest, row.tenantId, row.projectionJson);
  }
  const session = {
    prepare: (sql: string) => {
      let bound: unknown[] = [];
      const statement = {
        bind: (...params: unknown[]) => {
          bound = params;
          return statement;
        },
        all: async () => ({ success: true, results: db.prepare(sql).all(...bound), meta: {} }),
      };
      return statement;
    },
    batch: async () => [],
    getBookmark: () => 'bookmark',
  };
  return {
    withSession: () => session,
    prepare: session.prepare,
    batch: session.batch,
  } as unknown as D1Database;
}
