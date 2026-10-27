import { createDsqlGroupInputMutations } from './group-input-mutations';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
  ProtectedIdentityMutationCapability,
  AccountGovernanceMutationCapability,
  GroupInputMutationCapability,
} from '@authrim/ar-lib-core/db/adapter';
import {
  createDsqlPool,
  validateDsqlConnectionConfig,
  type DsqlConnectionConfig,
} from './connection';
import { toDsqlSql } from './sql-parameters';
import { createDsqlProtectedIdentityMutations } from './protected-identity-mutations';
import { createDsqlGovernanceMutations } from './governance-mutations';

export interface DsqlQueryResult {
  rows: unknown[];
  rowCount: number | null;
}

export interface DsqlClient {
  query(sql: string, params?: unknown[]): Promise<DsqlQueryResult>;
  release(destroy?: boolean): void;
}

export interface DsqlPool {
  connect(): Promise<DsqlClient>;
  end(): Promise<void>;
}

export interface DsqlAdapterDependencies {
  poolFactory?: (config: DsqlConnectionConfig) => DsqlPool;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  /** Explicit native Core schema with the reviewed protection tables installed. */
  protectedIdentitySchema?: string;
  groupInputSchema?: string;
  accountGovernanceSchemas?: { core: string; events: string };
}

/** Only this redacted error crosses the database boundary. Never attach a raw cause. */
export class DsqlOperationError extends Error {
  readonly code?: string;
  constructor(code?: string) {
    super('aurora_dsql_operation_failed');
    this.name = 'DsqlOperationError';
    this.code = code;
  }
}

const confirmedConflicts = new WeakSet<DsqlOperationError>();

function redacted(error: unknown): DsqlOperationError {
  if (error instanceof DsqlOperationError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return new DsqlOperationError(
    typeof code === 'string' && /^[A-Z0-9]{5}$/u.test(code) ? code : undefined
  );
}

/**
 * Isolated DSQL evaluation adapter. It deliberately does not identify as PostgreSQL or
 * expose statement-consent capabilities, so existing serving admission remains closed.
 */
export class AuroraDsqlAdapter implements DatabaseAdapter {
  readonly groupInputMutations?: GroupInputMutationCapability;
  readonly protectedIdentityMutations?: ProtectedIdentityMutationCapability;
  readonly accountGovernanceMutations?: AccountGovernanceMutationCapability;
  private readonly pool: DsqlPool;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private closed = false;

  constructor(config: DsqlConnectionConfig, dependencies: DsqlAdapterDependencies = {}) {
    validateDsqlConnectionConfig(config);
    this.pool = (dependencies.poolFactory ?? createDsqlPool)(config);
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = dependencies.random ?? Math.random;
    if (dependencies.protectedIdentitySchema !== undefined) {
      this.protectedIdentityMutations = createDsqlProtectedIdentityMutations(
        this,
        dependencies.protectedIdentitySchema
      );
    }
    if (dependencies.groupInputSchema) {
      this.groupInputMutations = createDsqlGroupInputMutations(this, dependencies.groupInputSchema);
    }
    if (dependencies.accountGovernanceSchemas) {
      this.accountGovernanceMutations = createDsqlGovernanceMutations(
        this,
        dependencies.accountGovernanceSchemas.core,
        dependencies.accountGovernanceSchemas.events
      );
    }
  }

  private async connect(): Promise<DsqlClient> {
    if (this.closed) throw new DsqlOperationError();
    try {
      const client = await this.pool.connect();
      if (this.closed) {
        client.release(true);
        throw new DsqlOperationError();
      }
      return client;
    } catch (error) {
      throw redacted(error);
    }
  }

  private async run(sql: string, params?: unknown[]): Promise<DsqlQueryResult> {
    const translated = toDsqlSql(sql);
    const client = await this.connect();
    let destroy = false;
    try {
      return await client.query(translated, params);
    } catch (error) {
      destroy = true;
      throw redacted(error);
    } finally {
      client.release(destroy);
    }
  }

  async query<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    return (await this.run(sql, params)).rows as T[];
  }

  async queryOne<T>(sql: string, params?: unknown[], options?: QueryOptions): Promise<T | null> {
    return (await this.query<T>(sql, params, options))[0] ?? null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const start = Date.now();
    const result = await this.run(sql, params);
    return {
      rowsAffected: result.rowCount ?? result.rows.length,
      success: true,
      durationMs: Date.now() - start,
    };
  }

  private async attempt<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const client = await this.connect();
    let active = true;
    let callbackActive = false;
    let failure: DsqlOperationError | undefined;
    let destroy = false;
    const pending = new Set<Promise<DsqlQueryResult>>();
    const query = async (sql: string, params?: unknown[]) => {
      if (!active || failure) throw failure ?? new DsqlOperationError();
      try {
        return await client.query(toDsqlSql(sql), params);
      } catch (error) {
        failure = redacted(error);
        if (failure.code === '40001') confirmedConflicts.add(failure);
        throw failure;
      }
    };
    const callbackQuery = async (sql: string, params?: unknown[]) => {
      if (!callbackActive) throw new DsqlOperationError();
      const operation = query(sql, params);
      pending.add(operation);
      try {
        return await operation;
      } finally {
        pending.delete(operation);
      }
    };
    const tx: TransactionContext = {
      query: async <R>(sql: string, params?: unknown[]) =>
        (await callbackQuery(sql, params)).rows as R[],
      queryOne: async <R>(sql: string, params?: unknown[]) =>
        ((await callbackQuery(sql, params)).rows[0] as R | undefined) ?? null,
      execute: async (sql, params) => {
        const result = await callbackQuery(sql, params);
        return { rowsAffected: result.rowCount ?? result.rows.length, success: true };
      },
    };
    try {
      await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      let result: T;
      callbackActive = true;
      try {
        result = await fn(tx);
      } finally {
        callbackActive = false;
        await Promise.allSettled(pending);
      }
      if (failure) throw failure;
      await query('COMMIT');
      return result;
    } catch {
      // BEGIN and COMMIT can succeed before a response is lost. Close uncertain connections.
      const original = failure ?? new DsqlOperationError();
      destroy = true;
      try {
        await client.query('ROLLBACK');
      } catch {
        // A failed rollback cannot establish a safely retryable transaction boundary.
        throw new DsqlOperationError();
      }
      throw original;
    } finally {
      active = false;
      callbackActive = false;
      client.release(destroy);
    }
  }

  /** No implicit callback replay, including on a confirmed optimistic concurrency conflict. */
  transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.attempt(fn);
  }

  /**
   * Explicit opt-in for callbacks containing only repeatable SQL work on the supplied tx.
   * Never put email, signing, queue delivery, logging or other external side effects here.
   * Only a confirmed server serialization failure is retried; ambiguous commits are not.
   */
  async retryableTransaction<T>(
    fn: (tx: TransactionContext) => Promise<T>,
    options: { maxAttempts?: number } = {}
  ): Promise<T> {
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
      throw new Error('aurora_dsql_retry_policy_invalid');
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt(fn);
      } catch (error) {
        if (
          !(error instanceof DsqlOperationError) ||
          error.code !== '40001' ||
          !confirmedConflicts.has(error) ||
          attempt >= maxAttempts
        )
          throw error;
        const jitter = Math.max(0, Math.min(1, this.random()));
        await this.sleep(Math.floor(10 * 2 ** (attempt - 1) * (0.5 + jitter)));
      }
    }
  }

  batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    return this.transaction(async (tx) => {
      const results: ExecuteResult[] = [];
      for (const statement of statements) {
        results.push(await tx.execute(statement.sql, statement.params));
      }
      return results;
    });
  }

  async isHealthy(): Promise<HealthStatus> {
    const start = Date.now();
    try {
      await this.query('SELECT 1');
      return { healthy: true, latencyMs: Date.now() - start, type: this.getType() };
    } catch {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        type: this.getType(),
        error: 'aurora_dsql_unavailable',
      };
    }
  }

  getType(): string {
    return 'aurora-dsql';
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.pool.end();
    } catch (error) {
      throw redacted(error);
    }
  }
}
