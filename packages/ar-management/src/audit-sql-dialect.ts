import type { AuditCreatedAtUnit, AuditHotQueryDialect } from './audit-hot-query';

export function getAuditJsonTextExpr(
  column: string,
  field: string,
  dialect: AuditHotQueryDialect
): string {
  if (dialect === 'postgres') {
    return `(COALESCE(${column}, '{}')::jsonb ->> '${field}')`;
  }
  if (dialect === 'mysql') {
    return `JSON_UNQUOTE(JSON_EXTRACT(COALESCE(${column}, '{}'), '$.${field}'))`;
  }
  return `json_extract(${column}, '$.${field}')`;
}

export function getAuditTimelineGrouping(
  interval: 'hour' | 'day' | 'week',
  dialect: AuditHotQueryDialect,
  createdAtUnit: AuditCreatedAtUnit
): string {
  const createdAtExpr = createdAtUnit === 'milliseconds' ? '(created_at / 1000.0)' : 'created_at';

  if (dialect === 'postgres') {
    switch (interval) {
      case 'hour':
        return `to_char(date_trunc('hour', to_timestamp(${createdAtExpr})), 'YYYY-MM-DD HH24:00:00')`;
      case 'week':
        return `to_char(date_trunc('week', to_timestamp(${createdAtExpr})), 'IYYY-IW')`;
      case 'day':
      default:
        return `to_char(date_trunc('day', to_timestamp(${createdAtExpr})), 'YYYY-MM-DD')`;
    }
  }

  if (dialect === 'mysql') {
    switch (interval) {
      case 'hour':
        return `DATE_FORMAT(FROM_UNIXTIME(${createdAtExpr}), '%Y-%m-%d %H:00:00')`;
      case 'week':
        return `DATE_FORMAT(FROM_UNIXTIME(${createdAtExpr}), '%x-%v')`;
      case 'day':
      default:
        return `DATE_FORMAT(FROM_UNIXTIME(${createdAtExpr}), '%Y-%m-%d')`;
    }
  }

  switch (interval) {
    case 'hour':
      return `strftime('%Y-%m-%d %H:00:00', datetime(${createdAtExpr}, 'unixepoch'))`;
    case 'week':
      return `strftime('%Y-%W', datetime(${createdAtExpr}, 'unixepoch'))`;
    case 'day':
    default:
      return `strftime('%Y-%m-%d', datetime(${createdAtExpr}, 'unixepoch'))`;
  }
}
