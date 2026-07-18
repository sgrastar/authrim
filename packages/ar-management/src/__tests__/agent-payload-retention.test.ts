import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import { purgeExpiredAgentPayloads } from '../agent-payload-retention';

class RetentionDatabaseAdapter implements DatabaseAdapter {
  readonly executions: Array<{ sql: string; params?: unknown[] }> = [];

  async query<T>(_sql: string, _params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    return [];
  }

  async queryOne<T>(_sql: string, _params?: unknown[], _options?: QueryOptions): Promise<T | null> {
    return null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    this.executions.push({ sql, params });
    return { rowsAffected: sql.includes('agent_configuration_plans') ? 2 : 3, success: true };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    return Promise.all(statements.map(({ sql, params }) => this.execute(sql, params)));
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'retention-test' };
  }

  getType(): string {
    return 'retention-test';
  }

  async close(): Promise<void> {}
}

describe('Agent payload retention', () => {
  it('purges expired Plan payloads without deleting their audit metadata', async () => {
    const adapter = new RetentionDatabaseAdapter();
    await expect(purgeExpiredAgentPayloads(adapter, 1234, 25)).resolves.toEqual({
      configurationPlansPurged: 2,
      bulkPlansPurged: 3,
    });
    expect(adapter.executions).toHaveLength(2);
    expect(adapter.executions[0]).toMatchObject({ params: [1234, 1234, 1234, 25] });
    expect(adapter.executions[0].sql).toContain('definition_json = NULL');
    expect(adapter.executions[1].sql).toContain('target_snapshot_json = NULL');
    expect(adapter.executions.every(({ sql }) => !sql.includes('DELETE'))).toBe(true);
  });
});
