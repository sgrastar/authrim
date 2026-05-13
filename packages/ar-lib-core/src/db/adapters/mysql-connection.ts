import type { Connection as MysqlConnection } from 'mysql2/promise';

export interface MysqlConnectionConfig {
  host: string;
  user: string;
  password: string;
  database: string;
  port: number;
  disableEval: true;
}

export interface MysqlQueryResult<T = unknown> {
  rows: T[];
  affectedRows?: number;
  insertId?: number;
}

export interface MysqlConnectionLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<MysqlQueryResult<T>>;
  execute<T = unknown>(sql: string, params?: unknown[]): Promise<MysqlQueryResult<T>>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  end(): Promise<void>;
}

export interface MysqlConnectionFactoryInput {
  connectionString?: string;
  hyperdrive?: Hyperdrive;
}

export type MysqlConnectionFactory = (
  config: MysqlConnectionConfig
) => Promise<MysqlConnectionLike> | MysqlConnectionLike;

function buildConfigFromConnectionString(connectionString: string): MysqlConnectionConfig {
  const url = new URL(connectionString);
  const port = url.port ? Number(url.port) : 3306;

  if (!url.hostname || !url.username || !url.pathname || Number.isNaN(port)) {
    throw new Error('mysql_connection_string_invalid');
  }

  return {
    host: url.hostname,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    port,
    disableEval: true,
  };
}

export function buildMysqlConnectionConfig(
  input: MysqlConnectionFactoryInput
): MysqlConnectionConfig {
  if (input.hyperdrive) {
    return {
      host: input.hyperdrive.host,
      user: input.hyperdrive.user,
      password: input.hyperdrive.password,
      database: input.hyperdrive.database,
      port: input.hyperdrive.port,
      disableEval: true,
    };
  }

  if (input.connectionString) {
    return buildConfigFromConnectionString(input.connectionString);
  }

  throw new Error('mysql_connection_config_required');
}

export async function openMysqlConnection(
  input: MysqlConnectionFactoryInput,
  factory?: MysqlConnectionFactory
): Promise<MysqlConnectionLike> {
  const config = buildMysqlConnectionConfig(input);

  if (factory) {
    return factory(config);
  }

  const { createConnection } = await import('mysql2/promise');
  const rawConnection: MysqlConnection = await createConnection(config);

  return {
    query: async <T = unknown>(sql: string, params?: unknown[]): Promise<MysqlQueryResult<T>> => {
      const [rows] = await rawConnection.query(sql, params as any);

      if (Array.isArray(rows)) {
        return { rows: rows as T[] };
      }

      return {
        rows: [],
        affectedRows: (rows as { affectedRows?: number }).affectedRows,
        insertId: (rows as { insertId?: number }).insertId,
      };
    },
    execute: async <T = unknown>(sql: string, params?: unknown[]): Promise<MysqlQueryResult<T>> => {
      const [rows] = await rawConnection.execute(sql, params as any);

      if (Array.isArray(rows)) {
        return { rows: rows as T[] };
      }

      return {
        rows: [],
        affectedRows: (rows as { affectedRows?: number }).affectedRows,
        insertId: (rows as { insertId?: number }).insertId,
      };
    },
    beginTransaction: async () => {
      await rawConnection.beginTransaction();
    },
    commit: async () => {
      await rawConnection.commit();
    },
    rollback: async () => {
      await rawConnection.rollback();
    },
    end: async () => {
      await rawConnection.end();
    },
  };
}
