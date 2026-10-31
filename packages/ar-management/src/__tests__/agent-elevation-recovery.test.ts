import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '@authrim/ar-lib-core';
import { describe, expect, it, vi } from 'vitest';
import type { AdminAgentAuditWriter } from '@authrim/ar-agent-access/core';
import {
  AGENT_ELEVATION_RECOVERY_CRON,
  isAgentElevationRecoveryCron,
  recoverStaleAgentElevations,
} from '../agent-elevation-recovery';

class RecoveryDatabaseAdapter implements DatabaseAdapter {
  readonly batches: PreparedStatement[][] = [];
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
    this.batches.push(statements);
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
    const auditWriter = vi
      .fn<AdminAgentAuditWriter>()
      .mockResolvedValue([{ sql: 'SELECT ? AS iceberg_audit_test_receipt', params: ['audit-1'] }]);
    const summary = await recoverStaleAgentElevations(adapter, {
      auditWriter,
      now: () => 100,
      createId: () => 'audit-1',
      reconcilerId: 'test-reconciler',
    });

    expect(summary.indeterminate).toBe(1);
    expect(adapter.executions[0].sql).toContain('UPDATE agent_elevation_challenges');
    expect(adapter.executions[0].params).toContain('indeterminate');
    expect(adapter.batches[0]).toHaveLength(2);
    expect(adapter.batches[0][1]).toEqual({
      sql: 'SELECT ? AS iceberg_audit_test_receipt',
      params: ['audit-1'],
    });
    expect(auditWriter).toHaveBeenCalledWith(
      adapter,
      expect.objectContaining({
        id: 'audit-1',
        tenantId: 'tenant-1',
        action: 'agent.elevation.indeterminate',
        resourceType: 'agent_elevation_challenge',
        resourceId: 'challenge-1',
        actorType: 'system',
        actorSub: 'system:test-reconciler',
        severity: 'warn',
        metadata: {
          idempotency_status: 'not_found',
          execution_attempt: 2,
          execution_fence: 4,
          execution_lease_expires_at: 90,
          reconciler_id: 'test-reconciler',
        },
      }),
      {
        from: 'agent_elevation_challenges',
        where: 'tenant_id = ? AND id = ? AND terminal_transition_id = ?',
        params: ['tenant-1', 'challenge-1', 'audit-1'],
      }
    );
  });
});
