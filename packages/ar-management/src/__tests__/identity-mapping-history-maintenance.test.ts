import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env, PreparedStatement } from '@authrim/ar-lib-core';
import {
  identityMappingClientHistoryReceiptStatement,
  UNACKNOWLEDGED_EXPIRES_AT,
} from '@authrim/ar-lib-core/services/identity-mapping-client-history-receipt';
import { prepareIdentityMappingLevelHistory } from '@authrim/ar-lib-core/services/identity-mapping-level-history';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';

const stores = vi.hoisted(() => ({
  admin: null as DatabaseAdapter | null,
  core: null as DatabaseAdapter | null,
  resolve: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  requireDedicatedAdminDatabaseAdapter: () => stores.admin,
  resolveTenantMetadataContext: stores.resolve,
}));

import {
  assertIdentityMappingHistoryBoundaryReady,
  processPendingIdentityMappingHistory,
} from '../identity-mapping-history-maintenance';

function adapter(db: SQLiteDatabase): DatabaseAdapter {
  const values = (params: unknown[] = []) => params.map((value) => value as SQLInputValue);
  const execute = async (sql: string, params?: unknown[]) => ({
    success: true,
    rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
  });
  return {
    query: async <T>(sql: string, params?: unknown[]) =>
      db.prepare(sql).all(...values(params)) as T[],
    queryOne: async <T>(sql: string, params?: unknown[]) =>
      (db.prepare(sql).get(...values(params)) as T | undefined) ?? null,
    execute,
    batch: async (statements: PreparedStatement[]) => {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const { sql, params } of statements) results.push(await execute(sql, params));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    transaction: async () => {
      throw new Error('unused');
    },
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    getType: () => 'd1',
    close: async () => undefined,
  };
}

function store(name: 'admin' | 'core'): DatabaseAdapter {
  const database = stores[name];
  if (!database) throw new Error('test_database_unavailable');
  return database;
}

describe('identity mapping history maintenance', () => {
  let admin: SQLiteDatabase;
  let core: SQLiteDatabase;
  const env = {} as Env;
  const log = { warn: vi.fn() };
  const before = { setId: 'set-a' };
  const after = { setId: 'set-b' };
  const history = (id: string) =>
    admin.prepare('SELECT * FROM identity_mapping_level_history WHERE id=?').get(id) as {
      status: string;
      last_reconciled_at: number;
      receipt_acknowledged_at: number | null;
    };
  const expiry = (id: string) =>
    (
      core.prepare('SELECT expires_at FROM idempotency_keys WHERE idempotency_key=?').get(id) as {
        expires_at: number;
      }
    ).expires_at;

  async function seed(id: string, receipt = true, tenantId = 'tenant-a') {
    const prepared = await prepareIdentityMappingLevelHistory(store('admin'), {
      id,
      tenantId,
      tier: 'client',
      clientId: id,
      before,
      after,
      actorId: 'admin-a',
      actorType: 'admin',
      via: 'client',
      sourceVersion: '1',
      now: 1000,
    });
    if (!receipt) return;
    core.prepare('INSERT INTO oauth_clients VALUES (?,?,1)').run(tenantId, id);
    const statement = await identityMappingClientHistoryReceiptStatement(
      {
        historyId: id,
        tenantId,
        clientId: id,
        beforeJson: JSON.stringify(before),
        afterJson: JSON.stringify(after),
        actorId: 'admin-a',
        actorType: 'admin',
        via: 'client',
        bulkId: null,
        createdAt: prepared.created_at,
      },
      1,
      2
    );
    await store('core').execute(statement.sql, statement.params);
    core
      .prepare('UPDATE oauth_clients SET updated_at=2 WHERE tenant_id=? AND client_id=?')
      .run(tenantId, id);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    admin = new DatabaseSync(':memory:');
    admin.exec(
      readFileSync(
        new URL(
          '../../../../migrations/admin/d1/050_identity_mapping_level_history.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    core = new DatabaseSync(':memory:');
    core.exec(`CREATE TABLE oauth_clients (tenant_id TEXT,client_id TEXT,updated_at INTEGER);
      CREATE TABLE idempotency_keys (id TEXT PRIMARY KEY,tenant_id TEXT,actor_id TEXT,method TEXT,
        path TEXT,resource_id TEXT,idempotency_key TEXT,body_hash TEXT,response_status INTEGER,
        response_body TEXT,created_at INTEGER,expires_at INTEGER);`);
    stores.admin = adapter(admin);
    stores.core = adapter(core);
    stores.resolve.mockImplementation(async (_env: unknown, tenantId: string) => ({
      tenantId,
      coreDb: stores.core,
    }));
  });
  afterEach(() => {
    admin.close();
    core.close();
  });

  it('finalizes from the routed receipt and gives it a TTL only after Admin commits', async () => {
    await seed('history-a');
    const execute = store('core').execute.bind(store('core'));
    const writes = vi.spyOn(store('core'), 'execute').mockImplementation(async (sql, params) => {
      expect(history('history-a').status).toBe('committed');
      return execute(sql, params);
    });
    await expect(
      processPendingIdentityMappingHistory(env, log, { now: () => 2000 })
    ).resolves.toEqual({ scanned: 1, committed: 1, acknowledged: 1, failed: 0 });
    expect(stores.resolve).toHaveBeenCalledWith(env, 'tenant-a');
    expect(expiry('history-a')).toBe(86_402);
    expect(history('history-a').receipt_acknowledged_at).toBe(2000);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(core.prepare('SELECT updated_at FROM oauth_clients').get()).toEqual({ updated_at: 2 });
  });

  it('rotates missing receipts so a later committed update is not starved', async () => {
    await seed('history-a', false);
    await seed('history-b');
    await processPendingIdentityMappingHistory(env, log, { limit: 1, now: () => 2000 });
    expect(history('history-a').status).toBe('pending');
    await processPendingIdentityMappingHistory(env, log, { limit: 1, now: () => 3000 });
    expect(history('history-b').status).toBe('committed');
    expect(history('history-a').last_reconciled_at).toBe(2000);
  });

  it('keeps receipts protected when Admin commit fails and retries ACK after its failure', async () => {
    await seed('history-a');
    const execute = store('admin').execute.bind(store('admin'));
    vi.spyOn(store('admin'), 'execute').mockImplementationOnce(async () => {
      throw new Error('admin unavailable');
    });
    await processPendingIdentityMappingHistory(env, log);
    expect(expiry('history-a')).toBe(UNACKNOWLEDGED_EXPIRES_AT);
    store('admin').execute = execute;
    const coreExecute = store('core').execute.bind(store('core'));
    vi.spyOn(store('core'), 'execute').mockRejectedValueOnce(new Error('ack unavailable'));
    await processPendingIdentityMappingHistory(env, log);
    expect(history('history-a')).toMatchObject({
      status: 'committed',
      receipt_acknowledged_at: null,
    });
    expect(expiry('history-a')).toBe(UNACKNOWLEDGED_EXPIRES_AT);
    store('core').execute = coreExecute;
    await processPendingIdentityMappingHistory(env, log, { now: () => 3000 });
    expect(history('history-a').receipt_acknowledged_at).toBe(3000);
  });

  it('does not recreate source history after restore or replay a client mutation', async () => {
    await seed('history-a');
    admin.exec(
      "UPDATE identity_mapping_level_history SET status='committed',source_version='2',committed_at=1000"
    );
    core.exec('DELETE FROM idempotency_keys');
    await processPendingIdentityMappingHistory(env, log, { now: () => 3000 });
    expect(history('history-a').receipt_acknowledged_at).toBe(3000);
    expect(admin.prepare('SELECT count(*) AS n FROM identity_mapping_level_history').get()).toEqual(
      { n: 1 }
    );
    expect(core.prepare('SELECT updated_at FROM oauth_clients').get()).toEqual({ updated_at: 2 });
    // A source receipt without an Admin intent is never enough to create one.
    await seed('history-b');
    admin.prepare('DELETE FROM identity_mapping_level_history WHERE id=?').run('history-b');
    await processPendingIdentityMappingHistory(env, log);
    expect(history('history-b')).toBeUndefined();
  });

  it('distinguishes a Core primary read error from an absent receipt', async () => {
    await seed('history-a');
    admin.exec(
      "UPDATE identity_mapping_level_history SET status='committed',source_version='2',committed_at=1000"
    );
    vi.spyOn(store('core'), 'queryOne').mockRejectedValueOnce(new Error('primary unavailable'));
    await processPendingIdentityMappingHistory(env, log);
    expect(history('history-a').receipt_acknowledged_at).toBeNull();
  });

  it('does not commit or acknowledge a receipt for a different actor or tenant', async () => {
    await seed('history-a');
    admin
      .prepare('UPDATE identity_mapping_level_history SET actor_id=? WHERE id=?')
      .run('different-admin', 'history-a');
    await seed('history-b', true, 'tenant-b');
    stores.resolve.mockImplementation(async () => ({ tenantId: 'tenant-a', coreDb: stores.core }));
    await processPendingIdentityMappingHistory(env, log);
    expect(history('history-a').status).toBe('pending');
    expect(history('history-b').status).toBe('pending');
    expect(expiry('history-a')).toBe(UNACKNOWLEDGED_EXPIRES_AT);
    expect(expiry('history-b')).toBe(UNACKNOWLEDGED_EXPIRES_AT);
  });

  it('blocks a snapshot until every unacknowledged source commit has matching Admin history', async () => {
    await seed('history-a');
    await expect(assertIdentityMappingHistoryBoundaryReady(env, 'tenant-a')).rejects.toThrow(
      'backup_identity_mapping_history_unsettled'
    );
    await processPendingIdentityMappingHistory(env, log);
    await expect(
      assertIdentityMappingHistoryBoundaryReady(env, 'tenant-a')
    ).resolves.toBeUndefined();
  });

  it('fails closed when the bounded snapshot receipt inspection cannot cover the whole set', async () => {
    for (let i = 0; i < 101; i++) await seed(`history-${String(i).padStart(3, '0')}`);
    await expect(assertIdentityMappingHistoryBoundaryReady(env, 'tenant-a')).rejects.toThrow(
      'backup_identity_mapping_history_unsettled'
    );
  });
});
