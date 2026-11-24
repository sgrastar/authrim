/**
 * A stateful in-memory fake of the `internal_notification_events` table for tests that mock the
 * database adapter. `InternalNotificationEventRepository.enqueue` inserts a row and then reads
 * it back (by deduplication key when it has one, otherwise by id), and looks up an existing row
 * by deduplication key first. The fake keeps what was inserted and answers those reads from that
 * state, so a lookup of an unknown id / key is `null` and the result does not depend on how many
 * reads happened before.
 */
export interface NotificationEventRow {
  id: string;
  tenant_id: string;
  category: string;
  event_type: string;
  severity: string;
  status: string;
  deduplication_key: string | null;
  payload_json: string;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

const TABLE = 'internal_notification_events';

export interface NotificationEventsFake {
  /** Rows inserted so far, in insert order. */
  readonly rows: NotificationEventRow[];
  /** Clears all state; call from `beforeEach`. */
  reset(): void;
  /** `adapter.queryOne` handler: the row for a notification lookup, `undefined` for other SQL. */
  queryOne(sql: string, params?: unknown[]): NotificationEventRow | null | undefined;
  /** `adapter.execute` handler: records an INSERT, `undefined` for other SQL. */
  execute(sql: string, params?: unknown[]): { rowsAffected: number } | undefined;
  /** Full `adapter.execute` implementation: records notification inserts, `{ rowsAffected: 1 }` otherwise. */
  executeAny(sql: string, params?: unknown[]): { rowsAffected: number };
}

export function createNotificationEventsFake(): NotificationEventsFake {
  const rows: NotificationEventRow[] = [];
  const fake: NotificationEventsFake = {
    rows,
    reset() {
      rows.length = 0;
    },
    queryOne(sql, params = []) {
      if (!sql.includes(`FROM ${TABLE}`) || !sql.includes('SELECT *')) return undefined;
      const key = params[0];
      const column = sql.includes('WHERE deduplication_key = ?') ? 'deduplication_key' : 'id';
      return rows.find((row) => row[column] === key) ?? null;
    },
    execute(sql, params = []) {
      if (!sql.includes(`INSERT INTO ${TABLE}`)) return undefined;
      const [id, tenantId, category, eventType, severity, key, payload, createdAt, updatedAt] =
        params as [string, string, string, string, string, string | null, string, string, string];
      rows.push({
        id,
        tenant_id: tenantId,
        category,
        event_type: eventType,
        severity,
        status: 'pending',
        deduplication_key: key,
        payload_json: payload,
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
        created_at: createdAt,
        updated_at: updatedAt,
        delivered_at: null,
      });
      return { rowsAffected: 1 };
    },
    executeAny(sql, params) {
      return fake.execute(sql, params) ?? { rowsAffected: 1 };
    },
  };
  return fake;
}
