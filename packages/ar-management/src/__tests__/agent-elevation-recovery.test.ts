import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import {
  AGENT_ELEVATION_RECOVERY_CRON,
  isAgentElevationRecoveryCron,
  recoverStaleAgentElevations,
} from '../agent-elevation-recovery';

class RecoveryDatabaseAdapter implements DatabaseAdapter {
  readonly executions: Array<{ sql: string; params?: unknown[] }> = [];

  async query<T>(sql: string, _params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    if (sql.includes('FROM agent_elevation_challenges')) {
      return [
        {
          id: 'challenge-1',
          tenant_id: 'tenant-1',
          grant_id: 'grant-1',
          status: 'executing',
          execution_attempt: 2,
          execution_fence: 4,
          execution_owner_id: 'worker-1',
          execution_lease_expires_at: 90,
          retry_count: 0,
        },
      ] as T[];
    }
    return [];
  }

  async queryOne<T>(sql: string, _params?: unknown[], _options?: QueryOptions): Promise<T | null> {
    if (sql.includes('FROM agent_management_executions')) return null;
    return null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    this.executions.push({ sql, params });
    return { rowsAffected: 1, success: true };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return fn({
      query: (sql, params) => this.query(sql, params),
      queryOne: (sql, params) => this.queryOne(sql, params),
      execute: (sql, params) => this.execute(sql, params),
    });
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    return Promise.all(statements.map(({ sql, params }) => this.execute(sql, params)));
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'recovery-test' };
  }

  getType(): string {
    return 'recovery-test';
  }

  async close(): Promise<void> {}
}

describe('Agent elevation scheduled recovery', () => {
  it('dispatches only the dedicated minute cron', () => {
    expect(AGENT_ELEVATION_RECOVERY_CRON).toBe('* * * * *');
    expect(isAgentElevationRecoveryCron('* * * * *')).toBe(true);
    expect(isAgentElevationRecoveryCron('0 */6 * * *')).toBe(false);
  });

  it('moves a missing target execution record to indeterminate with one audit transaction', async () => {
    const adapter = new RecoveryDatabaseAdapter();
    const summary = await recoverStaleAgentElevations(adapter, {
      now: () => 100,
      createId: () => 'audit-1',
      reconcilerId: 'test-reconciler',
    });

    expect(summary.indeterminate).toBe(1);
    expect(adapter.executions[0].sql).toContain('UPDATE agent_elevation_challenges');
    expect(adapter.executions[0].params).toContain('indeterminate');
    expect(adapter.executions[1].sql).toContain('INSERT INTO admin_audit_log');
    expect(adapter.executions[1].params).toContain('agent.elevation.indeterminate');
  });
});
