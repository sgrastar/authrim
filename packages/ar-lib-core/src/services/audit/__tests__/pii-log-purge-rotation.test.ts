import { readMigrationSource } from '../../../../../../test/helpers/migration-source.mjs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, PreparedStatement } from '../../../db/adapter';
import { AuditService } from '../audit-service';
import { eraseLogIcebergSubject } from '../../log-iceberg-subject-erasure';
import type { Env } from '../../../types/env';
import { AnonymizationService } from '../anonymization';

vi.mock('../../log-iceberg-subject-erasure', () => ({
  eraseLogIcebergSubject: vi.fn(async () => ({ complete: true, removed: 1 })),
}));
function store() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE user_anonymization_map (id TEXT PRIMARY KEY,tenant_id TEXT,user_id TEXT,anonymized_user_id TEXT,created_at INTEGER,UNIQUE(tenant_id,user_id));
    CREATE TABLE users_pii_tombstone (id TEXT,tenant_id TEXT,PRIMARY KEY(tenant_id,id));`);
  db.exec(
    readMigrationSource(
      new URL('../../../../../../migrations/pii/d1/', import.meta.url),
      '013_pii_log_purge_operations.sql'
    )
  );
  const run = ({ sql, params }: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(sql).run(...((params ?? []) as SQLInputValue[])).changes),
  });
  const adapter = {
    getType: () => 'd1',
    close: async () => {},
    isHealthy: async () => ({ healthy: true }),
    transaction: async () => {
      throw new Error('unused');
    },
    async query(sql: string, params: SQLInputValue[] = []) {
      return db.prepare(sql).all(...params);
    },
    async queryOne(sql: string, params: SQLInputValue[] = []) {
      return db.prepare(sql).get(...params) ?? null;
    },
    async execute(sql: string, params: SQLInputValue[] = []) {
      return run({ sql, params });
    },
    async batch(statements: PreparedStatement[]) {
      db.exec('BEGIN');
      try {
        const result = statements.map(run);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DatabaseAdapter;
  const service = new AnonymizationService(adapter);
  return { db, service, adapter };
}
const A = '3a28112c-6276-46d4-8845-021e88617d27';
const seed = (db: DatabaseSync) =>
  db
    .prepare('INSERT INTO user_anonymization_map VALUES (?,?,?,?,?)')
    .run('mapping', 'tenant', 'account', A, 1);

describe('PII purge mapping rotation', () => {
  it('atomically fixes old A, rotates live changes to B, and resumes A without another rotation', async () => {
    const { db, service } = store();
    seed(db);
    const operation = await service.preparePIILogPurge('tenant', 'account');
    expect(operation.old_anonymized_user_id).toBe(A);
    expect(operation.new_anonymized_user_id).not.toBe(A);
    expect(await service.getAnonymizedUserIdUnlessErased('tenant', 'account')).toBe(
      operation.new_anonymized_user_id
    );
    expect(await service.preparePIILogPurge('tenant', 'account')).toEqual(operation);
    await service.completePIILogPurge('tenant', 'account', operation.id);
    expect(db.prepare('SELECT * FROM pii_log_purge_operations').all()).toEqual([]);
    expect(await service.getAnonymizedUserIdUnlessErased('tenant', 'account')).toBe(
      operation.new_anonymized_user_id
    );
  });
  it('does not create B for an already deleted account or recreate a removed mapping', async () => {
    const { db, service } = store();
    seed(db);
    db.prepare('INSERT INTO users_pii_tombstone VALUES (?,?)').run('account', 'tenant');
    const operation = await service.preparePIILogPurge('tenant', 'account');
    expect(operation.new_anonymized_user_id).toBeNull();
    expect(await service.findAnonymizedUserId('tenant', 'account')).toBe(A);
    db.prepare('DELETE FROM user_anonymization_map').run();
    expect(await service.getAnonymizedUserIdUnlessErased('tenant', 'account')).toBeNull();
    expect(await service.preparePIILogPurge('tenant', 'account')).toEqual(operation);
  });
  it('keeps scopes and operation identity strict and does not manufacture missing A', async () => {
    const { db, service } = store();
    seed(db);
    await expect(service.preparePIILogPurge('other', 'account')).rejects.toThrow('mapping_missing');
    const operation = await service.preparePIILogPurge('tenant', 'account');
    await service.completePIILogPurge('tenant', 'account', 'wrong-op');
    expect(await service.preparePIILogPurge('tenant', 'account')).toEqual(operation);
  });
});

describe('resuming only a durable PII purge operation', () => {
  function audit(adapter: DatabaseAdapter) {
    const service = new AuditService({
      piiSource: adapter,
      env: {
        LOG_ARCHIVE_WRITER: { registerPiiPurgeScope: async () => {} },
        CONTROL: {
          acquireTenantBackupMutationPermit: async () => ({ admitted: true }),
          completeTenantBackupMutationPermit: async () => {},
        },
      } as unknown as Env,
    });
    const events = vi.spyOn(service, 'logEvent').mockResolvedValue(undefined);
    return { service, events };
  }
  it('removes A intent after completion audit and preserves current B', async () => {
    vi.mocked(eraseLogIcebergSubject).mockClear();
    const f = store();
    seed(f.db);
    const operation = await f.service.preparePIILogPurge('tenant', 'account');
    const a = audit(f.adapter);
    const result = await a.service.resumePendingPIIPurge('tenant', 'account', operation.id);
    expect(result).toMatchObject({ success: true, purgeJobId: operation.id });
    expect(eraseLogIcebergSubject).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant',
      sourceDataset: 'pii.pii_log',
      subjectId: A,
    });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM pii_log_purge_operations').get()?.n).toBe(0);
    expect(await f.service.findAnonymizedUserId('tenant', 'account')).toBe(
      operation.new_anonymized_user_id
    );
    expect(a.events.mock.calls.at(-1)?.[1]).toMatchObject({
      eventType: 'user.pii_purge_completed',
      details: { purgeJobId: operation.id, deletionReason: 'durable_intent_resume' },
    });
    f.db.close();
  });
  it('skips a stale cron item after another worker completed A, rather than creating a purge for B', async () => {
    vi.mocked(eraseLogIcebergSubject).mockClear();
    const f = store();
    seed(f.db);
    const operation = await f.service.preparePIILogPurge('tenant', 'account');
    await f.service.completePIILogPurge('tenant', 'account', operation.id);
    const a = audit(f.adapter);
    expect(await a.service.resumePendingPIIPurge('tenant', 'account', operation.id)).toMatchObject({
      success: true,
      skipped: true,
      purgeJobId: operation.id,
    });
    expect(eraseLogIcebergSubject).not.toHaveBeenCalled();
    expect(a.events).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM pii_log_purge_operations').get()?.n).toBe(0);
    expect(await f.service.findAnonymizedUserId('tenant', 'account')).toBe(
      operation.new_anonymized_user_id
    );
    f.db.close();
  });
});
