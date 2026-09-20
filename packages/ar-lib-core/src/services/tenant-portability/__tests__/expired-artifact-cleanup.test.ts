import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { cleanupExpiredTenantBackupArtifact } from '../expired-artifact-cleanup';
import type { DatabaseAdapter } from '../../../db/adapter';

it('expires only due artifacts, bounds work and resumes uncertain deletes and metadata interruption', async () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec('PRAGMA foreign_keys=ON');
    for (const name of [
      '003_tenant_backup_operations',
      '004_tenant_backup_validation_index',
      '009_tenant_backup_artifact_parts',
      '012_tenant_backup_cipher_journal',
      '020_tenant_backup_publications',
    ])
      sql.exec(
        readFileSync(
          new URL(`../../../../../../migrations/admin/d1/${name}.sql`, import.meta.url),
          'utf8'
        )
      );
    const database: Pick<DatabaseAdapter, 'queryOne' | 'execute'> = {
      async queryOne<T>(statement: string, params: unknown[] = []) {
        return (sql.prepare(statement).get(...(params as SQLInputValue[])) as T) ?? null;
      },
      async execute(statement: string, params: unknown[] = []) {
        return {
          success: true,
          rowsAffected: Number(sql.prepare(statement).run(...(params as SQLInputValue[])).changes),
        };
      },
    };
    const { TenantBackupOperationStore } = await import('../operation-store');
    const store = new TenantBackupOperationStore(database);
    for (const id of ['due', 'future', 'unpublished']) {
      await store.create({
        id,
        tenantId: 't',
        kind: 'export',
        actorId: 'a',
        idempotencyKey: id,
        requestDigest: 'ab'.repeat(32),
        now: 0,
      });
      sql
        .prepare("INSERT INTO tenant_backup_artifact_attempts VALUES (?,?,?,1,'sealed',0,33,33)")
        .run(id, 't', id);
      if (id !== 'unpublished')
        sql
          .prepare('INSERT INTO tenant_backup_publications VALUES (?,?,?,?,?,?)')
          .run(
            id,
            't',
            id,
            'ab'.repeat(32),
            id === 'due' ? 0 : 1,
            id === 'due' ? 604800000 : 604800001
          );
    }
    for (let i = 0; i < 33; i++)
      sql
        .prepare('INSERT INTO tenant_backup_artifact_parts VALUES (?,?,?,?,?,?,1)')
        .run('due', 't', i, `tenant-backup-staging/due/${i}/cipher`, 1, 'ab'.repeat(32));
    let uncertain = true;
    const deleted = new Set<string>();
    const bucket = {
      async delete(key: string) {
        deleted.add(key);
        if (uncertain) {
          uncertain = false;
          throw new Error('lost response');
        }
      },
    };
    expect(await cleanupExpiredTenantBackupArtifact({ database, bucket, now: 604799999 })).toEqual({
      objectsRemoved: 0,
    });
    await expect(
      cleanupExpiredTenantBackupArtifact({ database, bucket, now: 604800000 })
    ).rejects.toThrow('lost response');
    expect(sql.prepare('SELECT count(*) n FROM tenant_backup_artifact_parts').get()?.n).toBe(33);
    expect(await cleanupExpiredTenantBackupArtifact({ database, bucket, now: 604800000 })).toEqual({
      objectsRemoved: 32,
    });
    const interrupted = {
      ...database,
      async execute(statement: string, params?: unknown[]) {
        if (statement.startsWith('DELETE FROM tenant_backup_artifact_attempts'))
          throw new Error('interrupted');
        return database.execute(statement, params);
      },
    };
    await expect(
      cleanupExpiredTenantBackupArtifact({ database: interrupted, bucket, now: 604800000 })
    ).rejects.toThrow('interrupted');
    await cleanupExpiredTenantBackupArtifact({ database, bucket, now: 604800000 });
    expect(deleted.size).toBe(33);
    expect(
      sql
        .prepare('SELECT id FROM tenant_backup_artifact_attempts ORDER BY id')
        .all()
        .map((row) => row.id)
    ).toEqual(['future', 'unpublished']);
    expect(sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    sql.close();
  }
});
