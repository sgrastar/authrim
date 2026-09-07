import type { DatabaseAdapter } from '../../../packages/ar-lib-core/src/db/adapter';
import type { CallLedger } from './call-ledger';

export interface ExecuteResult {
  rowsAffected: number;
  lastInsertRowid?: number | bigint;
  success: boolean;
  durationMs?: number;
}

export interface PreparedStatement {
  sql: string;
  params?: unknown[];
}

export interface TransactionContext {
  query<T>(sql: string, params?: unknown[], options?: { timeoutMs?: number }): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[], options?: { timeoutMs?: number }): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
}

export interface MemoryDatabaseRow {
  [column: string]: unknown;
}

export interface QueryBehavior {
  match: (sql: string, params: unknown[]) => boolean;
  result?: () => MemoryDatabaseRow[] | null;
  execute?: () => ExecuteResult;
}

/**
 * In-memory `DatabaseAdapter` fake. Every read/write is recorded in the call ledger so tests
 * can assert durable side effects and their absence. Behaviors are matched in order; a row of
 * `null` from a `queryOne` returns no row, and an empty array from `query` returns no rows.
 */
export class MemoryDatabaseAdapter implements DatabaseAdapter {
  private behaviors: QueryBehavior[] = [];

  constructor(
    private readonly ledger?: CallLedger,
    private readonly label = 'd1',
    private readonly type = 'memory-d1'
  ) {}

  addBehavior(behavior: QueryBehavior): void {
    this.behaviors.push(behavior);
  }

  private findBehavior(sql: string, params: unknown[]): QueryBehavior | null {
    return this.behaviors.find((behavior) => behavior.match(sql, params)) ?? null;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.ledger?.record('d1.query', `${this.label}:${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
    const behavior = this.findBehavior(sql, params);
    return (behavior?.result?.() ?? []) as T[];
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.ledger?.record('d1.queryOne', `${this.label}:${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
    const behavior = this.findBehavior(sql, params);
    const result = behavior?.result?.();
    return (result && result.length > 0 ? result[0] : null) as T | null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    this.ledger?.record('d1.execute', `${this.label}:${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
    const behavior = this.findBehavior(sql, params);
    if (behavior?.execute) {
      return behavior.execute();
    }
    return { rowsAffected: 1, success: true };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx: TransactionContext = {
      query: (sql, params) => this.query(sql, params),
      queryOne: (sql, params) => this.queryOne(sql, params),
      execute: (sql, params) => this.execute(sql, params),
    };
    return fn(tx);
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    const results: ExecuteResult[] = [];
    for (const statement of statements) {
      results.push(await this.execute(statement.sql, statement.params ?? []));
    }
    return results;
  }

  async isHealthy(): Promise<{ healthy: boolean; latencyMs: number; type: string }> {
    return { healthy: true, latencyMs: 0, type: this.type };
  }

  getType(): string {
    return this.type;
  }

  async close(): Promise<void> {
    return undefined;
  }
}

export function sqlContains(needle: string): (sql: string) => boolean {
  return (sql) => sql.includes(needle);
}
