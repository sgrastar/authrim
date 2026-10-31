export type MigrationSqlDialect = 'sqlite' | 'postgres' | 'mysql';

export const PORTABLE_SQL_NOW_EPOCH_SECONDS = '__AUTHRIM_NOW_EPOCH_SECONDS__';
export const PORTABLE_SQL_NOW_EPOCH_MILLISECONDS = '__AUTHRIM_NOW_EPOCH_MILLISECONDS__';

type PortableSqlExpressions = {
  nowEpochSeconds: string;
  nowEpochMilliseconds: string;
};

const DIALECT_EXPRESSIONS: Record<MigrationSqlDialect, PortableSqlExpressions> = {
  sqlite: {
    nowEpochSeconds: 'unixepoch()',
    nowEpochMilliseconds: '(unixepoch() * 1000)',
  },
  postgres: {
    nowEpochSeconds: 'CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) AS BIGINT)',
    nowEpochMilliseconds: 'CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS BIGINT)',
  },
  mysql: {
    nowEpochSeconds: 'CAST(UNIX_TIMESTAMP() AS SIGNED)',
    nowEpochMilliseconds: 'CAST(UNIX_TIMESTAMP() * 1000 AS SIGNED)',
  },
};

export function getPortableSqlExpressions(dialect: MigrationSqlDialect): PortableSqlExpressions {
  return DIALECT_EXPRESSIONS[dialect];
}

export function renderPortableMigrationSql(sql: string, dialect: MigrationSqlDialect): string {
  const expressions = getPortableSqlExpressions(dialect);

  // Keep the legacy token's rendering immutable for existing migration artifacts.
  const preciseMilliseconds =
    dialect === 'sqlite'
      ? "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))"
      : expressions.nowEpochMilliseconds;
  return sql
    .replaceAll('__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__', preciseMilliseconds)
    .replaceAll(PORTABLE_SQL_NOW_EPOCH_MILLISECONDS, expressions.nowEpochMilliseconds)
    .replaceAll(PORTABLE_SQL_NOW_EPOCH_SECONDS, expressions.nowEpochSeconds);
}
