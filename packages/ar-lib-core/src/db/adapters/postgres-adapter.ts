import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '../adapter';
import type { Client as NodePgClient } from 'pg';
import type { StatementConsentAtomicCapability } from '../statement-consent-atomic';

interface PgQueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

interface PgClientLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  end(): Promise<void>;
}

/** Private lease: the caller owns termination and cannot lend it to normal adapter queries. */
interface StatementConsentOwnedReadTransaction {
  readonly ownership: 'statement_consent_read';
  read<T>(sql: string, params: unknown[]): Promise<T | null>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresAdapterConfig {
  connectionString?: string;
  hyperdrive?: Hyperdrive;
  partition?: string;
  clientFactory?: (connectionString: string) => Promise<PgClientLike> | PgClientLike;
  /** Test seam: must return a fresh, owned connection for each consent transaction. */
  statementConsentClientFactory?: (
    connectionString: string
  ) => Promise<PgClientLike> | PgClientLike;
}

function toPostgresSql(sql: string): string {
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let result = '';

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (!inSingleQuote && !inDoubleQuote && !inBlockComment && char === '-' && next === '-') {
      inLineComment = true;
    } else if (inLineComment && char === '\n') {
      inLineComment = false;
    } else if (!inSingleQuote && !inDoubleQuote && !inLineComment && char === '/' && next === '*') {
      inBlockComment = true;
    } else if (inBlockComment && char === '*' && next === '/') {
      inBlockComment = false;
      result += '*/';
      i += 1;
      continue;
    } else if (!inLineComment && !inBlockComment && char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (!inLineComment && !inBlockComment && char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    if (char === '?' && !inSingleQuote && !inDoubleQuote && !inLineComment && !inBlockComment) {
      index += 1;
      result += `$${index}`;
      continue;
    }

    result += char;
  }

  return result;
}

export class PostgresAdapter implements DatabaseAdapter {
  private readonly connectionString: string;
  private readonly partition: string;
  private readonly clientFactory?: PostgresAdapterConfig['clientFactory'];
  private client: PgClientLike | null = null;
  private ordinaryAdmission: Promise<void> | undefined;
  private readonly statementConsentClientFactory?: PostgresAdapterConfig['statementConsentClientFactory'];
  private readonly usedStatementConsentClients = new WeakSet<PgClientLike>();
  private readonly ordinaryStatementConsentExclusions = new WeakSet<PgClientLike>();

  constructor(config: PostgresAdapterConfig) {
    this.connectionString = config.connectionString ?? config.hyperdrive?.connectionString ?? '';
    if (!this.connectionString) {
      throw new Error('postgres_connection_string_required');
    }
    this.partition = config.partition ?? 'postgres';
    const ordinaryFactory = config.clientFactory;
    this.clientFactory = ordinaryFactory
      ? async (connectionString) => {
          const client = await ordinaryFactory.call(this, connectionString);
          // Reserve before returning across getClient's await/cache gap.
          this.reserveStatementConsentClient(client, 'ordinary');
          return client;
        }
      : undefined;
    this.statementConsentClientFactory = config.statementConsentClientFactory;
  }

  private async getClient(): Promise<PgClientLike> {
    if (this.client) {
      return this.client;
    }

    if (this.clientFactory) {
      this.client = await this.clientFactory(this.connectionString);
      return this.client;
    }

    const { Client } = await import('pg');
    const rawClient: NodePgClient = new Client({
      connectionString: this.connectionString,
      application_name: 'authrim-postgres-adapter',
    });
    await rawClient.connect();
    this.client = {
      query: async <T = unknown>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>> => {
        const result = await rawClient.query(sql, params);
        return {
          rows: result.rows as T[],
          rowCount: result.rowCount ?? result.rows.length,
        };
      },
      end: async () => {
        await rawClient.end();
      },
    };

    return this.client;
  }

  /** The cached connection belongs to one operation, or one whole transaction, at a time. */
  private async withOrdinaryAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.ordinaryAdmission;
    let release!: () => void;
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.ordinaryAdmission = admission;
    // Preserve synchronous factory reservation when there is no preceding operation.
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      if (this.ordinaryAdmission === admission) this.ordinaryAdmission = undefined;
      release();
    }
  }

  async query<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    return this.withOrdinaryAdmission(async () => {
      const client = await this.getClient();
      const result = await client.query<T>(toPostgresSql(sql), params);
      return result.rows;
    });
  }

  async queryOne<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const startTime = Date.now();
    const result = await this.withOrdinaryAdmission(async () => {
      const client = await this.getClient();
      return client.query(toPostgresSql(sql), params);
    });
    return {
      rowsAffected: result.rowCount,
      success: true,
      durationMs: Date.now() - startTime,
    };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return this.withOrdinaryAdmission(async () => {
      const client = await this.getClient();
      let active = false;
      let started = false;
      let committing = false;
      let failed = false;
      let failure: unknown;
      const pending = new Set<Promise<unknown>>();
      // Callers must use this context inside the callback. Queries on the outer adapter
      // wait for this exclusive lease and cannot accidentally join its transaction.
      const query = async <R>(sql: string, params?: unknown[]): Promise<PgQueryResult<R>> => {
        if (!active) throw new Error('postgres_transaction_context_closed');
        if (failed) throw failure;
        let operation: Promise<PgQueryResult<R>> | undefined;
        try {
          operation = client.query<R>(toPostgresSql(sql), params);
          pending.add(operation);
          return await operation;
        } catch (error) {
          failed = true;
          failure = error;
          throw error;
        } finally {
          if (operation) pending.delete(operation);
        }
      };
      const txContext: TransactionContext = {
        query: async <R>(sql: string, params?: unknown[]) => (await query<R>(sql, params)).rows,
        queryOne: async <R>(sql: string, params?: unknown[]) =>
          (await query<R>(sql, params)).rows[0] ?? null,
        execute: async (sql, params) => {
          const result = await query(sql, params);
          return { rowsAffected: result.rowCount, success: true };
        },
      };
      try {
        // BEGIN itself can succeed before its acknowledgement is lost.
        await client.query('BEGIN');
        started = true;
        active = true;
        let result: T;
        try {
          result = await fn(txContext);
        } finally {
          active = false;
          await Promise.allSettled(pending);
        }
        if (failed) throw failure;
        committing = true;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        active = false;
        let rollbackFailed = false;
        try {
          await client.query('ROLLBACK');
        } catch {
          // An uncertain connection is discarded even when rollback also fails.
          rollbackFailed = true;
        }
        if (!started || committing || rollbackFailed) {
          this.client = null;
          try {
            await client.end();
          } catch {
            // Preserve the original error; never retry a possibly committed operation.
          }
        }
        throw error;
      }
    });
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    return this.transaction(async (tx) => {
      const results: ExecuteResult[] = [];
      for (const statement of statements) {
        results.push(await tx.execute(statement.sql, statement.params));
      }
      return results;
    });
  }

  /** Synchronous admission keeps both factory resolution orders mutually exclusive. */
  private reserveStatementConsentClient(
    client: PgClientLike,
    ownership: 'ordinary' | 'owned'
  ): void {
    if (ownership === 'ordinary') {
      if (this.usedStatementConsentClients.has(client)) {
        throw new Error('statement_consent_pg_connection_not_dedicated');
      }
      this.ordinaryStatementConsentExclusions.add(client);
      return;
    }
    if (
      client === this.client ||
      this.ordinaryStatementConsentExclusions.has(client) ||
      this.usedStatementConsentClients.has(client)
    ) {
      throw new Error('statement_consent_pg_connection_not_dedicated');
    }
    this.usedStatementConsentClients.add(client);
  }

  private async openStatementConsentReadTransaction(): Promise<StatementConsentOwnedReadTransaction> {
    let owned: PgClientLike;
    if (this.statementConsentClientFactory) {
      owned = await this.statementConsentClientFactory(this.connectionString);
    } else {
      const { Client } = await import('pg');
      const raw: NodePgClient = new Client({
        connectionString: this.connectionString,
        application_name: 'authrim-statement-consent-read',
      });
      try {
        await raw.connect();
      } catch (error) {
        try {
          await raw.end();
        } catch {
          /* Preserve the connection failure. */
        }
        throw error;
      }
      owned = {
        query: async <T = unknown>(sql: string, params?: unknown[]) => {
          const result = await raw.query(sql, params);
          return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
        },
        end: () => raw.end(),
      };
    }
    // Refuse a borrowed/reused object before BEGIN, without closing somebody else's connection.
    this.reserveStatementConsentClient(owned, 'owned');
    try {
      await owned.query('BEGIN TRANSACTION READ ONLY');
      const role = await owned.query<{ in_recovery: boolean; read_only: string }>(
        `SELECT pg_is_in_recovery() AS in_recovery, current_setting('transaction_read_only') AS read_only`
      );
      if (role.rows[0]?.in_recovery !== false || role.rows[0]?.read_only !== 'on') {
        throw new Error('statement_consent_pg_authoritative_reader_unavailable');
      }
    } catch (error) {
      // BEGIN may have succeeded before its response was lost. Always attempt rollback and close.
      try {
        await owned.query('ROLLBACK');
      } catch {
        /* Preserve the original/unknown result. */
      }
      try {
        await owned.end();
      } catch {
        /* Preserve the original/unknown result. */
      }
      throw error;
    }
    let active = true;
    let closed = false;
    const requireActive = () => {
      if (closed || !active) throw new Error('statement_consent_pg_read_lease_closed');
    };
    return {
      ownership: 'statement_consent_read',
      async read<T>(sql: string, params: unknown[]): Promise<T | null> {
        requireActive();
        const result = await owned.query<T>(toPostgresSql(sql), params);
        return result.rows[0] ?? null;
      },
      async commit() {
        requireActive();
        await owned.query('COMMIT');
        active = false;
      },
      async rollback() {
        if (closed || !active) return;
        await owned.query('ROLLBACK');
        active = false;
      },
      async close() {
        if (closed) return;
        closed = true;
        await owned.end();
      },
    };
  }

  /** Statement consent alone requires an owned connection, never the adapter's shared client. */
  statementConsentAtomicCapability(): StatementConsentAtomicCapability {
    return {
      dialect: 'postgres',
      readOperation: async (sql: string, params: unknown[]): Promise<unknown> => {
        const transaction = await this.openStatementConsentReadTransaction();
        let row: unknown;
        try {
          row = await transaction.read<unknown>(sql, params);
          await transaction.commit();
        } catch (error) {
          try {
            await transaction.rollback();
          } catch {
            /* Preserve the original/unknown result. */
          }
          try {
            await transaction.close();
          } catch {
            /* Preserve the original/unknown result. */
          }
          throw error;
        }
        await transaction.close();
        return row;
      },
      executeStatementConsentBatch: async (statements) => {
        if (statements.length === 0 || statements.length > 16) {
          throw new Error('statement_consent_atomic_plan_invalid');
        }
        let owned: PgClientLike;
        if (this.statementConsentClientFactory) {
          owned = await this.statementConsentClientFactory(this.connectionString);
        } else {
          const { Client } = await import('pg');
          const raw: NodePgClient = new Client({
            connectionString: this.connectionString,
            application_name: 'authrim-statement-consent',
          });
          try {
            await raw.connect();
          } catch (error) {
            try {
              await raw.end();
            } catch {
              /* Preserve the connection failure. */
            }
            throw error;
          }
          owned = {
            query: async <T = unknown>(sql: string, params?: unknown[]) => {
              const result = await raw.query(sql, params);
              return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
            },
            end: () => raw.end(),
          };
        }
        // A factory cannot lend the cached connection, an active connection, or an ended lease.
        this.reserveStatementConsentClient(owned, 'owned');
        let started = false;
        try {
          // BEGIN may succeed before its response is lost. Roll back before closing either way.
          started = true;
          await owned.query('BEGIN');
          for (const statement of statements) {
            await owned.query(toPostgresSql(statement.sql), statement.params);
          }
          await owned.query('COMMIT');
          started = false;
        } catch (error) {
          if (started) {
            try {
              await owned.query('ROLLBACK');
            } catch {
              /* Preserve the original/unknown result. */
            }
          }
          try {
            await owned.end();
          } catch {
            /* Preserve the original/unknown result. */
          }
          throw error;
        }
        await owned.end();
      },
    };
  }

  async isHealthy(): Promise<HealthStatus> {
    const startTime = Date.now();

    try {
      await this.query('SELECT 1');
      return {
        healthy: true,
        latencyMs: Date.now() - startTime,
        type: 'postgres',
        partition: this.partition,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
        type: 'postgres',
        partition: this.partition,
        error: String(error),
      };
    }
  }

  getType(): string {
    return 'postgres';
  }

  async close(): Promise<void> {
    await this.withOrdinaryAdmission(async () => {
      const client = this.client;
      this.client = null;
      await client?.end();
    });
  }
}

export function createPostgresAdapter(config: PostgresAdapterConfig): PostgresAdapter {
  return new PostgresAdapter(config);
}
