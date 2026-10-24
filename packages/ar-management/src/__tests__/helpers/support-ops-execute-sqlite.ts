/** Real Admin/Core schemas and actual DO RPCs; only routing/Workers transport are test seams. */
import { readdirSync, readFileSync } from 'node:fs';
import type { DatabaseAdapter, Env, PreparedStatement } from '@authrim/ar-lib-core';
import { SessionRevocationStore } from '@authrim/ar-lib-core/durable-objects/SessionRevocationStore';
import { renderPortableMigrationSql } from '../../../../ar-lib-core/dist/migrations/sql-portability';
import {
  createSupportOpsExecuteJob,
  processSupportOpsExecuteJobInline,
} from '../../support-ops-execute-job';
import type { SupportOpsStores, SupportOpsStoreIdentity } from '../../support-ops-stores';
import { openCoreStore } from './core-schema-sqlite';
import { DatabaseSync, type SQLInputValue, type SQLiteDatabase } from '../test-sqlite';
import { vi } from 'vitest';

export const TENANT = 'tenant-a';
export const METADATA_IDENTITY: SupportOpsStoreIdentity = {
  databaseId: 'physical-metadata',
  bindingRouteGeneration: 1,
  shardId: 'metadata-shard',
  assignmentGeneration: 1,
};
export const ACCOUNT_IDENTITY: SupportOpsStoreIdentity = {
  databaseId: 'physical-accounts',
  bindingRouteGeneration: 1,
  shardId: 'accounts-shard',
  assignmentGeneration: 1,
};

class ReceiptStorage {
  readonly db = new DatabaseSync(':memory:');
  constructor() {
    this.db.exec('CREATE TABLE kv(k TEXT PRIMARY KEY NOT NULL,v TEXT NOT NULL)');
  }
  async get<T>(key: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT v FROM kv WHERE k=?').get(key) as { v: string } | undefined;
    return row ? (JSON.parse(row.v) as T) : undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.db
      .prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
      .run(key, JSON.stringify(value));
  }
  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(input: string | string[]): Promise<number | boolean> {
    const keys = Array.isArray(input) ? input : [input];
    if (keys.length > 128) throw new Error('unbounded_delete');
    const count = keys.reduce(
      (n, key) => n + Number(this.db.prepare('DELETE FROM kv WHERE k=?').run(key).changes),
      0
    );
    return Array.isArray(input) ? count : count > 0;
  }
  async list<T>({
    prefix,
    limit,
    startAfter = '',
  }: {
    prefix: string;
    limit: number;
    startAfter?: string;
  }): Promise<Map<string, T>> {
    const rows = this.db
      .prepare('SELECT k,v FROM kv WHERE substr(k,1,?)=? AND k>? ORDER BY k LIMIT ?')
      .all(prefix.length, prefix, startAfter, limit) as Array<{ k: string; v: string }>;
    return new Map(rows.map((row) => [row.k, JSON.parse(row.v) as T]));
  }
  async transaction<T>(work: (storage: ReceiptStorage) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN');
    try {
      const result = await work(this);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function openAdminStore(): { db: SQLiteDatabase; adapter: DatabaseAdapter } {
  const db = new DatabaseSync(':memory:');
  const directory = new URL('../../../../../migrations/admin/d1/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort())
    db.exec(renderPortableMigrationSql(readFileSync(new URL(file, directory), 'utf8'), 'sqlite'));
  db.exec('PRAGMA foreign_keys=ON');
  const values = (params: unknown[] = []) =>
    params.map((value) => (value === undefined ? null : value) as SQLInputValue);
  const execute = (statement: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
  });
  const adapter = {
    query: async (sql: string, params?: unknown[]) => db.prepare(sql).all(...values(params)),
    queryOne: async (sql: string, params?: unknown[]) =>
      db.prepare(sql).get(...values(params)) ?? null,
    execute: async (sql: string, params?: unknown[]) => execute({ sql, params }),
    batch: async (statements: PreparedStatement[]) => statements.map(execute),
    getType: () => 'sqlite',
  } as unknown as DatabaseAdapter;
  return { db, adapter };
}

export async function createExecuteFixture(sessionCount = 1, targetCount = 1) {
  const core = openCoreStore(TENANT),
    admin = openAdminStore();
  const calls = { sql: 0 };
  const measured = (adapter: DatabaseAdapter): DatabaseAdapter => ({
    ...adapter,
    query: async <T>(
      sql: string,
      params?: unknown[],
      options?: Parameters<DatabaseAdapter['query']>[2]
    ) => {
      calls.sql++;
      return adapter.query<T>(sql, params, options);
    },
    queryOne: async <T>(
      sql: string,
      params?: unknown[],
      options?: Parameters<DatabaseAdapter['queryOne']>[2]
    ) => {
      calls.sql++;
      return adapter.queryOne<T>(sql, params, options);
    },
    execute: async (sql, params) => {
      calls.sql++;
      return adapter.execute(sql, params);
    },
    batch: async (statements) => {
      calls.sql += statements.length;
      return adapter.batch(statements);
    },
  });
  core.adapter = measured(core.adapter);
  admin.adapter = measured(admin.adapter);
  const receipts = new Map<string, { storage: ReceiptStorage; rpc: SessionRevocationStore }>();
  const sourceVersionMs = Date.now();
  for (let i = 0; i < targetCount; i++) {
    const user = `user-${i + 1}`;
    core.db
      .prepare(
        "INSERT INTO identity_subjects(id,tenant_id,subject_type,lifecycle_state,created_at,updated_at) VALUES(?,?,'person','active',1,1)"
      )
      .run(`subject-${user}`, TENANT);
    core.db
      .prepare(
        "INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,primary_subject_id,created_at,updated_at) VALUES(?,?,'user','active',?,?,1,1)"
      )
      .run(`account-${user}`, TENANT, user, `subject-${user}`);
    const storage = new ReceiptStorage();
    const rpc = new SessionRevocationStore({ storage } as unknown as DurableObjectState, {} as Env);
    receipts.set(user, { storage, rpc });
    for (let n = 0; n < (i === 0 ? sessionCount : 0); n++)
      await rpc.registerSessionRpc(
        TENANT,
        user,
        `account:${user}`,
        1000,
        `session-${String(n).padStart(5, '0')}`,
        Date.now() + 1000000
      );
  }
  core.db
    .prepare(
      `INSERT INTO support_operation_cohorts(id,tenant_id,resource,intended_action,selector_json,selector_hash,matched_count,actionable_count,risk_json,created_by,expires_at,created_at) VALUES('cohort-1',?,'User','suspend','{}','hash',?,?,'{}','requester',?,?)`
    )
    .run(TENANT, targetCount, targetCount, Date.now() + 1000000, Date.now());
  for (const user of receipts.keys())
    core.db
      .prepare(
        "INSERT INTO support_operation_cohort_targets(id,cohort_id,tenant_id,resource,target_id,created_at) VALUES(?,'cohort-1',?,'User',?,?)"
      )
      .run(`target-${user}`, TENANT, user, Date.now());
  core.db
    .prepare(
      "INSERT INTO support_operation_actions(id,tenant_id,cohort_id,resource,action,status,reason,result_summary_json,requested_by,created_at,updated_at) VALUES('action-1',?,'cohort-1','User','suspend','running','test',?,'requester',?,?)"
    )
    .run(TENANT, JSON.stringify({ job_id: 'job-1' }), Date.now(), Date.now());
  const stores: SupportOpsStores = {
    metadata: core.adapter,
    metadataIdentity: { ...METADATA_IDENTITY },
    accounts: [{ key: 'ACCOUNTS', identity: { ...ACCOUNT_IDENTITY }, adapter: core.adapter }],
  };
  const env = {} as Env;
  await createSupportOpsExecuteJob(admin.adapter, {
    jobId: 'job-1',
    tenantId: TENANT,
    actionId: 'action-1',
    cohortId: 'cohort-1',
    executor: 'machine-1',
    sourceVersionMs,
    actionableCount: targetCount,
    actor: {
      adminUserId: null,
      metadata: {
        admin_actor_type: 'machine',
        admin_actor_id: 'machine-1',
        admin_auth_method: 'machine_access_token',
      },
    },
    metadataIdentity: METADATA_IDENTITY,
  });
  const row = () =>
    admin.db
      .prepare(
        "SELECT status,progress,config,updated_at,error_message FROM admin_jobs WHERE id='job-1'"
      )
      .get() as {
      status: string;
      progress: string;
      config: string;
      updated_at: number;
      error_message: string | null;
    };
  interface Progress {
    stage: string;
    processed: number;
    succeeded: number;
    outcome?: { status: string };
    active?: {
      account_result?: 0 | 1;
      account_id: string;
      operation_id: string;
      store_identity: SupportOpsStoreIdentity;
      transferred?: { sequence: number };
      receipt_completed?: boolean;
    };
  }
  const progress = () => JSON.parse(row().progress) as Progress;
  const rpcSpies = [...receipts.values()].flatMap(({ rpc }) => [
    vi.spyOn(rpc, 'beginSupportOpsSuspensionRpc'),
    vi.spyOn(rpc, 'readSupportOpsSuspensionReceiptRpc'),
    vi.spyOn(rpc, 'acknowledgeSupportOpsSuspensionReceiptRpc'),
    vi.spyOn(rpc, 'completeSupportOpsSuspensionReceiptRpc'),
  ]);
  const used = () => calls.sql + rpcSpies.reduce((total, spy) => total + spy.mock.calls.length, 0);
  async function step(budget = 180) {
    // A scheduled retry is five minutes later; production's DO lease lasts only sixty seconds.
    // Separate Core tests verify that a still-live owner/fence cannot be stolen.
    for (const { storage } of receipts.values()) {
      const receipt = await storage.get<Record<string, unknown>>('support-ops-session-receipt');
      if (receipt)
        await storage.put('support-ops-session-receipt', {
          ...receipt,
          leaseUntil: Date.now() - 1,
        });
    }
    admin.db.exec("UPDATE admin_jobs SET next_run_at=NULL WHERE id='job-1'");
    const before = used();
    await processSupportOpsExecuteJobInline(env, TENANT, 'job-1', {
      maxCallsPerRun: budget,
      maxTargetsPerRun: 1000,
    });
    if (used() - before > budget) throw new Error('explicit_sql_rpc_budget_exceeded');
  }
  async function finish() {
    for (let i = 0; i < 100; i++) {
      if (['completed', 'failed'].includes(row().status)) return;
      await step();
    }
    throw new Error('unbounded_job');
  }
  const close = () => {
    core.db.close();
    admin.db.close();
    for (const { storage } of receipts.values()) storage.db.close();
  };
  return {
    core,
    admin,
    receipts,
    stores,
    env,
    row,
    progress,
    step,
    finish,
    close,
    sourceVersionMs,
  };
}
export type ExecuteFixture = Awaited<ReturnType<typeof createExecuteFixture>>;
