import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter, TransactionContext } from '@authrim/ar-lib-core';

export interface DsqlProbeDatabase extends DatabaseAdapter {
  retryableTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface DsqlProbeResult {
  formatVersion: 1;
  mode: 'read-only' | 'synthetic-writes';
  fullRuntimeReady: false;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; sqlState?: string }>;
  cleanup: 'not-needed' | 'complete' | 'failed' | 'creation-unconfirmed';
  /** Only a newly generated probe namespace; never a customer schema. */
  schema?: string;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' && /^[0-9A-Z]{5}$/u.test(error.code)
    ? error.code
    : undefined;
}

function requireResult(condition: boolean): void {
  if (!condition) throw new Error('dsql_probe_assertion_failed');
}

/** Wait for every started transaction before allowing the probe's cleanup to begin. */
async function completeConcurrent<T>(operations: readonly Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(operations);
  const values: T[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      const code = sqlState(outcome.reason);
      throw Object.assign(new Error('dsql_probe_parallel_check_failed'), code ? { code } : {});
    }
    values.push(outcome.value);
  }
  return values;
}

/**
 * This is a capability experiment, not schema initialization or SAML readiness.
 * Each DDL statement has its own transaction. Writes require an explicit opt-in
 * and touch only a new UUID namespace, which is removed without CASCADE.
 */
export async function runDsqlProbe(
  db: DsqlProbeDatabase,
  options: { writeProbe?: boolean } = {}
): Promise<DsqlProbeResult> {
  if (db.getType() !== 'aurora-dsql') throw new Error('dsql_probe_adapter_required');
  const result: DsqlProbeResult = {
    formatVersion: 1,
    mode: options.writeProbe ? 'synthetic-writes' : 'read-only',
    fullRuntimeReady: false,
    passed: false,
    checks: [],
    cleanup: 'not-needed',
  };
  async function check(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      result.checks.push({ name, passed: true });
    } catch (error) {
      const code = sqlState(error);
      result.checks.push({ name, passed: false, ...(code ? { sqlState: code } : {}) });
      throw new Error('dsql_probe_check_failed');
    }
  }
  let schemaCreated = false;
  let tableCreated = false;
  let tableCreationAttempted = false;
  let table = '';
  try {
    await check('connection-and-database', async () => {
      const row = await db.queryOne<{ database: string }>('SELECT current_database() AS database');
      requireResult(row?.database === 'postgres');
    });
    await check('repeatable-read', async () => {
      const row = await db.queryOne<{ transaction_isolation: string }>(
        'SHOW transaction_isolation'
      );
      requireResult(row?.transaction_isolation === 'repeatable read');
    });
    if (options.writeProbe) {
      result.schema = `authrim_dsql_probe_${randomUUID().replaceAll('-', '')}`;
      table = `"${result.schema}"."accounts"`;
      result.cleanup = 'creation-unconfirmed';
      await check('isolated-schema', async () => {
        await db.execute(`CREATE SCHEMA "${result.schema}"`);
        schemaCreated = true;
      });
      await check('table-ddl', async () => {
        tableCreationAttempted = true;
        await db.execute(`CREATE TABLE ${table} (
          tenant_id TEXT NOT NULL,
          id TEXT NOT NULL,
          profile JSONB NOT NULL,
          counter BIGINT NOT NULL DEFAULT 0,
          expires_at BIGINT NOT NULL,
          consumed INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (tenant_id, id)
        )`);
        tableCreated = true;
      });
      const insert = `INSERT INTO ${table}
        (tenant_id, id, profile, expires_at) VALUES ($1, $2, $3::jsonb, $4)`;
      const now = Date.now();
      await check('json-and-tenant-scoping', async () => {
        await db.execute(insert, [
          'synthetic-a',
          'challenge',
          '{"label":"synthetic"}',
          now + 60_000,
        ]);
        const own = await db.queryOne<{ profile: { label: string }; counter: string }>(
          `SELECT profile, counter FROM ${table} WHERE tenant_id = ? AND id = ?`,
          ['synthetic-a', 'challenge']
        );
        const other = await db.queryOne(
          `SELECT id FROM ${table} WHERE tenant_id = $1 AND id = $2`,
          ['synthetic-b', 'challenge']
        );
        requireResult(
          own?.profile.label === 'synthetic' && Number(own.counter) === 0 && other === null
        );
      });
      await check('transaction-rollback', async () => {
        let rejected = false;
        let inserted = false;
        try {
          await db.transaction(async (tx) => {
            await tx.execute(insert, ['synthetic-a', 'rollback', '{}', now + 60_000]);
            inserted = true;
            throw new Error('synthetic_rollback');
          });
        } catch {
          rejected = true;
        }
        const row = await db.queryOne(`SELECT id FROM ${table} WHERE tenant_id = $1 AND id = $2`, [
          'synthetic-a',
          'rollback',
        ]);
        requireResult(inserted && rejected && row === null);
      });
      const consume = (tenant: string, id: string) =>
        db.retryableTransaction((tx) =>
          tx.queryOne<{ id: string }>(
            `UPDATE ${table} SET consumed = 1
             WHERE tenant_id = $1 AND id = $2 AND consumed = 0 AND expires_at > $3
             RETURNING id`,
            [tenant, id, now]
          )
        );
      await check('concurrent-consume-and-replay', async () => {
        const winners = await completeConcurrent([
          consume('synthetic-a', 'challenge'),
          consume('synthetic-a', 'challenge'),
        ]);
        requireResult(winners.filter(Boolean).length === 1);
        requireResult((await consume('synthetic-a', 'challenge')) === null);
      });
      await check('expiry-and-cross-tenant-rejection', async () => {
        await db.execute(insert, ['synthetic-a', 'expired', '{}', now - 1]);
        requireResult((await consume('synthetic-a', 'expired')) === null);
        await db.execute(insert, ['synthetic-a', 'private', '{}', now + 60_000]);
        requireResult((await consume('synthetic-b', 'private')) === null);
        requireResult((await consume('synthetic-a', 'private')) !== null);
      });
      await check('concurrent-counter-updates', async () => {
        await completeConcurrent(
          [1, 2].map(() =>
            db.retryableTransaction(async (tx) => {
              await tx.execute(
                `UPDATE ${table} SET counter = counter + 1 WHERE tenant_id = $1 AND id = $2`,
                ['synthetic-a', 'challenge']
              );
            })
          )
        );
        const row = await db.queryOne<{ counter: string }>(
          `SELECT counter FROM ${table} WHERE tenant_id = $1 AND id = $2`,
          ['synthetic-a', 'challenge']
        );
        requireResult(Number(row?.counter) === 2);
      });
    }
    result.passed = true;
  } catch {
    // Only check names and allow-listed SQLSTATEs are returned, never server messages.
  } finally {
    if (schemaCreated) {
      try {
        // A failed CREATE TABLE may have committed before a connection interruption.
        // In that case leave the known probe namespace for inspection rather than
        // dropping an object whose creation was not confirmed.
        if (tableCreationAttempted && !tableCreated) {
          result.cleanup = 'creation-unconfirmed';
        } else {
          if (tableCreated) await db.execute(`DROP TABLE ${table}`);
          await db.execute(`DROP SCHEMA "${result.schema}"`);
          result.cleanup = 'complete';
        }
      } catch {
        result.cleanup = 'failed';
        result.passed = false;
      }
    }
  }
  return result;
}
