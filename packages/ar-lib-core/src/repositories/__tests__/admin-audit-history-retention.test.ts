import { createRequire } from 'node:module';

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: number[]): { changes: number | bigint };
    all(): unknown[];
  };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => SqliteDatabase;
};
import { expect, it } from 'vitest';
import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';
import { AdminAuditLogRepository } from '../admin/admin-audit-log';

it('uses the explicit Admin-audit millisecond cutoff only for committed mapping history', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE admin_audit_log (id TEXT,created_at INTEGER);
      CREATE TABLE identity_mapping_level_history
        (id TEXT,status TEXT,created_at INTEGER,tier TEXT,receipt_acknowledged_at INTEGER);
      INSERT INTO admin_audit_log VALUES ('old',999),('boundary',1000);
      INSERT INTO identity_mapping_level_history VALUES
        ('old','committed',999,'tenant_default',NULL),
        ('boundary','committed',1000,'tenant_default',NULL),
        ('pending','pending',1,'client',NULL),('aborted','aborted',1,'client',NULL),
        ('unacknowledged','committed',999,'client',NULL),
        ('acknowledged','committed',999,'client',2000);`);
    const adapter = {
      batch: async (statements: PreparedStatement[]) => {
        db.exec('BEGIN');
        try {
          const result = statements.map(({ sql, params }) => ({
            success: true,
            rowsAffected: Number(db.prepare(sql).run(...(params as number[])).changes),
          }));
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    } as DatabaseAdapter;
    expect(await new AdminAuditLogRepository(adapter).deleteOldLogs(1000)).toBe(1);
    expect(db.prepare('SELECT id FROM admin_audit_log ORDER BY id').all()).toEqual([
      { id: 'boundary' },
    ]);
    expect(db.prepare('SELECT id FROM identity_mapping_level_history ORDER BY id').all()).toEqual([
      { id: 'aborted' },
      { id: 'boundary' },
      { id: 'pending' },
      { id: 'unacknowledged' },
    ]);
  } finally {
    db.close();
  }
});
