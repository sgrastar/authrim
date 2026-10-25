import type { DatabaseAdapter, PreparedStatement } from './adapter';

/** This capability is for statement-consent plans, not a shared callback transaction. */
export interface StatementConsentAtomicCapability {
  readonly dialect: 'd1' | 'postgres';
  /** PG owns a fresh read-only transaction; D1 requests primary. Only null means absent. */
  readOperation(sql: string, params: unknown[]): Promise<unknown>;
  executeStatementConsentBatch(statements: readonly PreparedStatement[]): Promise<void>;
}

/** PG must provide a fresh connection; generic adapter.transaction() is not sufficient. */
export interface StatementConsentPostgresProvider {
  statementConsentAtomicCapability(): StatementConsentAtomicCapability;
}

export function createStatementConsentD1Capability(
  adapter: DatabaseAdapter
): StatementConsentAtomicCapability {
  if (adapter.getType() !== 'd1') throw new Error('statement_consent_atomic_backend_unsupported');
  return {
    dialect: 'd1',
    readOperation: (sql, params) =>
      adapter.queryOne<unknown>(sql, params, { consistencyClass: 'primary_required' }),
    async executeStatementConsentBatch(statements) {
      const result = await adapter.batch([...statements]);
      if (result.length !== statements.length || result.some((entry) => !entry.success)) {
        throw new Error('statement_consent_atomic_result_unknown');
      }
    },
  };
}
