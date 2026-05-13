import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '../adapter';
import {
  openMysqlConnection,
  type MysqlConnectionFactory,
  type MysqlConnectionLike,
} from './mysql-connection';

export interface MysqlAdapterConfig {
  connectionString?: string;
  hyperdrive?: Hyperdrive;
  partition?: string;
  clientFactory?: MysqlConnectionFactory;
}

export class MysqlAdapter implements DatabaseAdapter {
  private readonly connectionString?: string;
  private readonly hyperdrive?: Hyperdrive;
  private readonly partition: string;
  private readonly clientFactory?: MysqlAdapterConfig['clientFactory'];
  private client: MysqlConnectionLike | null = null;

  constructor(config: MysqlAdapterConfig) {
    if (!config.connectionString && !config.hyperdrive) {
      throw new Error('mysql_connection_config_required');
    }
    this.connectionString = config.connectionString;
    this.hyperdrive = config.hyperdrive;
    this.partition = config.partition ?? 'mysql';
    this.clientFactory = config.clientFactory;
  }

  private async getClient(): Promise<MysqlConnectionLike> {
    if (this.client) {
      return this.client;
    }

    this.client = await openMysqlConnection(
      {
        connectionString: this.connectionString,
        hyperdrive: this.hyperdrive,
      },
      this.clientFactory
    );
    return this.client;
  }

  async query<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    const client = await this.getClient();
    const result = await client.query<T>(sql, params);
    return result.rows;
  }

  async queryOne<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const startTime = Date.now();
    const client = await this.getClient();
    const result = await client.execute(sql, params);
    return {
      rowsAffected: result.affectedRows ?? 0,
      lastInsertRowid: result.insertId,
      success: true,
      durationMs: Date.now() - startTime,
    };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    await client.beginTransaction();

    const txContext: TransactionContext = {
      query: async <R>(sql: string, params?: unknown[]) => {
        const result = await client.query<R>(sql, params);
        return result.rows;
      },
      queryOne: async <R>(sql: string, params?: unknown[]) => {
        const result = await client.query<R>(sql, params);
        return result.rows[0] ?? null;
      },
      execute: async (sql: string, params?: unknown[]) => {
        const result = await client.execute(sql, params);
        return {
          rowsAffected: result.affectedRows ?? 0,
          lastInsertRowid: result.insertId,
          success: true,
        };
      },
    };

    try {
      const result = await fn(txContext);
      await client.commit();
      return result;
    } catch (error) {
      await client.rollback();
      throw error;
    }
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

  async isHealthy(): Promise<HealthStatus> {
    const startTime = Date.now();

    try {
      const client = await this.getClient();
      await client.query('SELECT 1');
      return {
        healthy: true,
        latencyMs: Date.now() - startTime,
        type: 'mysql',
        partition: this.partition,
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
        type: 'mysql',
        partition: this.partition,
        error: String(error),
      };
    }
  }

  getType(): string {
    return 'mysql';
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
}

export function createMysqlAdapter(config: MysqlAdapterConfig): MysqlAdapter {
  return new MysqlAdapter(config);
}
