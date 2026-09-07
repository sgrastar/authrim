/**
 * Tenant-aware DatabaseAdapter wrapper for the runtime-topology suite.
 *
 * Every `query` / `queryOne` / `execute` call is recorded in the call ledger exactly like
 * the shared MemoryDatabaseAdapter, PLUS a safe `tenant-access` entry per tenant-routing
 * label found in the bind parameters. Only the exact labels `alpha`, `beta`, and
 * `default` are ever recorded; raw parameters, SQL values, and secrets are never logged.
 * The underlying adapter behaviors (query fixtures, security-event writes) are delegated
 * unchanged.
 */
import type { DatabaseAdapter } from '../../../packages/ar-lib-core/src/db/adapter';
import type { CallLedger } from '../fixtures/call-ledger';
import type { MemoryDatabaseAdapter, ExecuteResult } from '../fixtures/d1-adapter';

export const TENANT_ACCESS_LABELS = new Set(['alpha', 'beta', 'default']);

function tenantLabelsFromParams(params: readonly unknown[]): string[] {
  const labels: string[] = [];
  for (const param of params) {
    if (typeof param === 'string' && TENANT_ACCESS_LABELS.has(param) && !labels.includes(param)) {
      labels.push(param);
    }
  }
  return labels;
}

export class TenantLedgerDatabaseAdapter implements DatabaseAdapter {
  constructor(
    private readonly delegate: MemoryDatabaseAdapter,
    private readonly ledger: CallLedger,
    private readonly label: string
  ) {}

  private recordTenantAccess(labels: readonly string[]): void {
    for (const tenant of labels) {
      this.ledger.record('tenant-access', `${this.label}:${tenant}`);
    }
  }

  /** Record which binding actually received the operation (the wrapper's own label). */
  private recordBindingOperation(): void {
    this.ledger.record('binding-operation', this.label);
  }

  // The delegated adapter records the SQL entries; this wrapper only adds the safe
  // tenant-access and binding-operation entries so SQL targets are not duplicated.
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.recordTenantAccess(tenantLabelsFromParams(params));
    this.recordBindingOperation();
    return this.delegate.query<T>(sql, params);
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.recordTenantAccess(tenantLabelsFromParams(params));
    this.recordBindingOperation();
    return this.delegate.queryOne<T>(sql, params);
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    this.recordTenantAccess(tenantLabelsFromParams(params));
    this.recordBindingOperation();
    return this.delegate.execute(sql, params);
  }

  async transaction<T>(
    fn: (tx: {
      query<TResult>(sql: string, params?: unknown[]): Promise<TResult[]>;
      queryOne<TResult>(sql: string, params?: unknown[]): Promise<TResult | null>;
      execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;
    }) => Promise<T>
  ): Promise<T> {
    return this.delegate.transaction(fn);
  }

  async batch(statements: { sql: string; params?: unknown[] }[]): Promise<ExecuteResult[]> {
    for (const statement of statements) {
      this.recordTenantAccess(tenantLabelsFromParams(statement.params ?? []));
    }
    this.recordBindingOperation();
    return this.delegate.batch(statements);
  }

  async isHealthy(): Promise<{ healthy: boolean; latencyMs: number; type: string }> {
    return this.delegate.isHealthy();
  }

  getType(): string {
    return this.delegate.getType();
  }

  async close(): Promise<void> {
    return this.delegate.close();
  }
}
