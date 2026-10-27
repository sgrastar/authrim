import { describe, expect, it, vi } from 'vitest';
import type { TransactionContext } from '@authrim/ar-lib-core';
import { runDsqlProbe, type DsqlProbeDatabase } from './probe';

function database() {
  const db = {
    getType: () => 'aurora-dsql',
    queryOne: vi
      .fn()
      .mockResolvedValueOnce({ database: 'postgres' })
      .mockResolvedValueOnce({ transaction_isolation: 'repeatable read' }),
    query: vi.fn(),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 0 }),
    transaction: vi.fn(),
    retryableTransaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    close: vi.fn(),
  } satisfies DsqlProbeDatabase;
  return db;
}

describe('DSQL capability probe safety', () => {
  it('defaults to a read-only probe and never claims serving readiness', async () => {
    const db = database();
    const report = await runDsqlProbe(db);
    expect(report).toMatchObject({
      passed: true,
      fullRuntimeReady: false,
      mode: 'read-only',
      cleanup: 'not-needed',
    });
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.retryableTransaction).not.toHaveBeenCalled();
    expect(report.schema).toBeUndefined();
  });

  it('refuses PostgreSQL admission and wrong database/isolation before writing', async () => {
    const postgres = database();
    postgres.getType = () => 'postgres';
    await expect(runDsqlProbe(postgres, { writeProbe: true })).rejects.toThrow(
      'dsql_probe_adapter_required'
    );
    expect(postgres.queryOne).not.toHaveBeenCalled();
    for (const rows of [
      [{ database: 'customer' }],
      [{ database: 'postgres' }, { transaction_isolation: 'read committed' }],
    ]) {
      const db = database();
      db.queryOne.mockReset();
      for (const row of rows) db.queryOne.mockResolvedValueOnce(row);
      expect((await runDsqlProbe(db, { writeProbe: true })).passed).toBe(false);
      expect(db.execute).not.toHaveBeenCalled();
    }
  });

  it('redacts connection errors, without echoing hostname, credentials, or SQL', async () => {
    const db = database();
    db.queryOne
      .mockReset()
      .mockRejectedValue(
        Object.assign(new Error('password=secret SELECT customer_record'), { code: '08006' })
      );
    const report = await runDsqlProbe(db);
    expect(report.checks).toEqual([
      { name: 'connection-and-database', passed: false, sqlState: '08006' },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/secret|customer_record|password/);
  });

  it('does not delete an unconfirmed schema after an ambiguous CREATE failure', async () => {
    const db = database();
    db.execute.mockRejectedValueOnce(new Error('connection_lost_after_commit'));
    const report = await runDsqlProbe(db, { writeProbe: true });
    expect(report).toMatchObject({ passed: false, cleanup: 'creation-unconfirmed' });
    expect(report.schema).toMatch(/^authrim_dsql_probe_[a-f0-9]{32}$/);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.execute.mock.calls[0][0]).toBe(`CREATE SCHEMA "${report.schema}"`);
  });

  it('leaves a known namespace for inspection if CREATE TABLE outcome is uncertain', async () => {
    const db = database();
    db.execute
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockRejectedValueOnce(new Error('query_timeout'));
    const report = await runDsqlProbe(db, { writeProbe: true });
    expect(report).toMatchObject({ passed: false, cleanup: 'creation-unconfirmed' });
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('cleans up only its confirmed synthetic table and schema on a failed check', async () => {
    const db = database();
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const report = await runDsqlProbe(db, { writeProbe: true });
    expect(report).toMatchObject({ passed: false, cleanup: 'complete' });
    expect(db.execute.mock.calls.slice(-2).map(([sql]) => String(sql))).toEqual([
      `DROP TABLE "${report.schema}"."accounts"`,
      `DROP SCHEMA "${report.schema}"`,
    ]);
    expect(db.execute.mock.calls.flat().join(' ')).not.toContain('CASCADE');
  });

  it('reports cleanup failure without returning raw database details', async () => {
    const db = database();
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    db.execute
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 0 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 1 })
      .mockRejectedValueOnce(new Error('secret_cleanup_failure'));
    const report = await runDsqlProbe(db, { writeProbe: true });
    expect(report).toMatchObject({ passed: false, cleanup: 'failed' });
    expect(JSON.stringify(report)).not.toContain('secret_cleanup_failure');
  });

  it('does not mistake an INSERT failure for a successful rollback', async () => {
    const db = database();
    db.queryOne
      .mockResolvedValueOnce({ profile: { label: 'synthetic' }, counter: '0' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    db.transaction.mockRejectedValueOnce(new Error('insert_permission_denied'));
    const report = await runDsqlProbe(db, { writeProbe: true });
    expect(report).toMatchObject({ passed: false, cleanup: 'complete' });
    expect(report.checks.at(-1)).toEqual({ name: 'transaction-rollback', passed: false });
    expect(db.retryableTransaction).not.toHaveBeenCalled();
  });

  it.each(['consume', 'counter'] as const)(
    'waits for the pending %s transaction after a sibling fails before cleanup',
    async (stage) => {
      const db = database();
      db.queryOne
        .mockResolvedValueOnce({ profile: { label: 'synthetic' }, counter: '0' })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      db.transaction.mockImplementation(async (fn: (tx: TransactionContext) => Promise<unknown>) =>
        fn({
          query: async () => [],
          queryOne: async () => null,
          execute: async () => ({ success: true, rowsAffected: 1 }),
        })
      );
      if (stage === 'counter') {
        // Complete consumption, replay, expiry, and tenant checks before reaching counters.
        for (const value of [{ id: 'challenge' }, null, null, null, null, { id: 'private' }]) {
          db.retryableTransaction.mockResolvedValueOnce(value);
        }
      }
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      db.retryableTransaction
        .mockRejectedValueOnce(
          Object.assign(new Error('password=private-token SQL private-payload'), { code: '40001' })
        )
        .mockImplementationOnce(() => {
          entered();
          return pending;
        });
      const completion = runDsqlProbe(db, { writeProbe: true });
      await started;
      // Drain the rejection's promise chain while its sibling remains deliberately pending.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const cleanupStarted = db.execute.mock.calls.some(([sql]) => String(sql).startsWith('DROP '));
      release();
      const report = await completion;
      expect(cleanupStarted).toBe(false);
      expect(report).toMatchObject({ passed: false, cleanup: 'complete' });
      expect(report.checks.at(-1)).toEqual({
        name: stage === 'consume' ? 'concurrent-consume-and-replay' : 'concurrent-counter-updates',
        passed: false,
        sqlState: '40001',
      });
      expect(db.execute.mock.calls.slice(-2).map(([sql]) => String(sql))).toEqual([
        `DROP TABLE "${report.schema}"."accounts"`,
        `DROP SCHEMA "${report.schema}"`,
      ]);
      expect(JSON.stringify(report)).not.toMatch(/private-token|private-payload|password/);
    }
  );
});
