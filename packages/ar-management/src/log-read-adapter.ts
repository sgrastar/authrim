import type { DatabaseAdapter, Env, QueryOptions } from '@authrim/ar-lib-core';
import type { Context } from 'hono';
import {
  readLogIcebergDataset,
  loadLogIcebergProtectedDetail,
  type LogIcebergDatasetReadResult,
} from '@authrim/ar-lib-core/services/log-iceberg-read';
import type { LogIcebergSqlRow } from '@authrim/ar-lib-core/services/log-iceberg-row-codec';
import {
  LogQueryIncompleteError,
  LogQueryInvalidRequestError,
  type LogReadWindow,
} from './log-archive-query';
import { executeLogQuery, type LogQueryValue } from './log-iceberg-query-engine';

const COLUMNS: Readonly<Record<string, string>> = {
  'core.event_log':
    'id tenant_id event_type event_category result severity error_code error_message anonymized_user_id client_id session_id request_id duration_ms details_json retention_until created_at ip_address user_agent',
  'core.audit_log':
    'id tenant_id user_id action resource_type resource_id ip_address user_agent metadata_json created_at severity',
  'core.operational_logs':
    'id tenant_id subject_type subject_id actor_id action reason_detail_encrypted encryption_key_version detail_object_catalog_id request_id created_at expires_at',
  'core.permission_check_audit':
    'id tenant_id subject_id permission permission_json allowed resolved_via_json final_decision reason api_key_id client_id checked_at',
  'admin.admin_audit_log':
    'id tenant_id admin_user_id admin_email action resource_type resource_id result error_code error_message severity ip_address user_agent request_id session_id before_json after_json metadata_json created_at detail_object_catalog_id actor_type actor_sub actor_mode actor_assurance token_binding act_client_id act_principal_id grant_id elevation_id mcp_tool',
};
function fail(): never {
  throw new LogQueryIncompleteError();
}
interface Token {
  word: string;
  at: number;
  end: number;
  depth: number;
}
/** Internal fixed SQL only; quoted text and comments cannot add clauses or parameters. */
function tokens(sql: string): Token[] {
  const out: Token[] = [];
  let depth = 0;
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i++;
      while (i < sql.length) {
        if (sql[i++] !== ch) continue;
        if (sql[i] === ch) {
          i++;
          continue;
        }
        break;
      }
      if (ch !== "'") out.push({ word: sql.slice(start + 1, i - 1), at: start, end: i, depth });
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) fail();
      i = end + 2;
    } else if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth--;
      i++;
    } else if (ch === '?') {
      out.push({ word: '?', at: i, end: i + 1, depth });
      i++;
    } else if (/[a-z_]/i.test(ch)) {
      const at = i++;
      while (i < sql.length && /[a-z_0-9]/i.test(sql[i])) i++;
      out.push({ word: sql.slice(at, i), at, end: i, depth });
    } else i++;
  }
  return out;
}
interface SelectSource {
  where: string;
  alias: string;
  end: number;
  beforeBinds: number;
  sourceBinds: number;
  hasWhere: boolean;
  whereAt: number;
}
function selectSource(sql: string, table: string): SelectSource | null {
  const words = tokens(sql).filter((t) => t.depth === 0 && t.word !== '?');
  if (words[0]?.word.toUpperCase() !== 'SELECT') return null;
  const index = words.findIndex((t) => t.word.toUpperCase() === 'FROM');
  if (index < 0 || words[index + 1]?.word !== table) return null;
  const from = words[index];
  const where = words.find((t) => t.at > from.at && t.word.toUpperCase() === 'WHERE');
  const end =
    words.find(
      (t) =>
        t.at > from.at &&
        ['GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'UNION'].includes(t.word.toUpperCase())
    )?.at ?? sql.length;
  const next = words[index + 2];
  const alias =
    next?.word.toUpperCase() === 'AS'
      ? words[index + 3]?.word
      : next &&
          !['WHERE', 'LEFT', 'INNER', 'JOIN', 'GROUP', 'ORDER', 'LIMIT'].includes(
            next.word.toUpperCase()
          )
        ? next.word
        : table;
  if (!alias || !/^[a-z_][a-z_0-9]*$/i.test(alias)) fail();
  const binds = tokens(sql).filter((t) => t.word === '?');
  return {
    alias,
    end,
    where: where && where.at < end ? sql.slice(where.end, end) : '',
    whereAt: where?.end ?? from.end,
    beforeBinds: binds.filter((t) => t.at < from.at).length,
    sourceBinds: binds.filter((t) => t.at >= from.at && t.at < end).length,
    hasWhere: !!where && where.at < end,
  };
}

export interface LogCursorPagination {
  mode: 'cursor';
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}
export interface LogPageRequest {
  limit: number;
  cursor?: string;
  scope: string;
  page?: number;
}
export function cursorText(value: unknown): string {
  return btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(value)), (b) => String.fromCharCode(b)).join(
      ''
    )
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export function decodeCursor(
  value: string | undefined,
  scope: string
): { at: number; id: string } | undefined {
  if (!value) return;
  try {
    if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
          c.charCodeAt(0)
        )
      )
    );
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      !('v' in decoded) ||
      decoded.v !== 1 ||
      !('scope' in decoded) ||
      decoded.scope !== scope ||
      !('at' in decoded) ||
      typeof decoded.at !== 'number' ||
      !Number.isSafeInteger(decoded.at) ||
      decoded.at < 0 ||
      !('id' in decoded) ||
      typeof decoded.id !== 'string' ||
      !decoded.id ||
      decoded.id.length > 256
    )
      throw new Error();
    return { at: decoded.at, id: decoded.id };
  } catch {
    throw new LogQueryInvalidRequestError('Invalid log cursor for this query.');
  }
}

export function logPageRequest(c: Context, tenantId: string, limit: number): LogPageRequest {
  const url = new URL(c.req.url);
  const filters = [...url.searchParams.entries()]
    .filter(([key]) => !['page', 'cursor', 'limit'].includes(key))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  return {
    limit,
    cursor: c.req.query('cursor'),
    page: Number(c.req.query('page') ?? 1),
    scope: JSON.stringify([tenantId, url.pathname, filters]),
  };
}

/** The timestamp hint narrows a lookup; absence always includes the current Iceberg snapshot. */
export function logDetailWindow(c: Context): { window: LogReadWindow } {
  const hint = c.req.query('event_at');
  if (!hint) return { window: {} };
  const ms = Number(hint);
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new LogQueryInvalidRequestError('event_at must be a Unix timestamp in milliseconds.');
  return { window: { fromMs: ms, toMs: ms } };
}
export interface LogReadCoverage {
  consistency: 'eventual' | 'snapshot' | 'local_hot_only';
  pending_deliveries: number | null;
  complete: boolean;
}
export function logCoverageHeaders(c: Context): (coverage: LogReadCoverage) => void {
  return (coverage) => {
    c.header('X-Authrim-Log-Consistency', coverage.consistency);
    if (coverage.pending_deliveries !== null)
      c.header('X-Authrim-Log-Pending-Deliveries', String(coverage.pending_deliveries));
    c.header('X-Authrim-Log-Complete', String(coverage.complete));
  };
}

/** A read-only, request-local SQL view. Neither SQL nor plaintext rows are sent to a database. */
export function createLogReadAdapter(input: {
  env: Env;
  tenantId: string;
  dataset: string;
  /** Metadata belongs to the caller; this adapter never invokes this connection. */
  adapter?: DatabaseAdapter;
  columns?: readonly string[];
  timestamp?: { column: string; unit: 'seconds' | 'milliseconds' };
  window?: LogReadWindow;
  page?: LogPageRequest;
  onCoverage?: (coverage: LogReadCoverage) => void;
  /** Self-service subjects may see their view's latency, never the tenant's delivery volume. */
  includePendingDeliveries?: boolean;
}): {
  adapter: DatabaseAdapter;
  hasArchive: () => boolean;
  pagination: () => LogCursorPagination | undefined;
  coverage: () => LogReadCoverage | undefined;
} {
  input = {
    ...input,
    window: { ...input.window },
    page: input.page ? { ...input.page } : undefined,
    columns: input.columns ? [...input.columns] : undefined,
    timestamp: input.timestamp ? { ...input.timestamp } : undefined,
  };
  if (!input.tenantId || !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/.test(input.dataset)) fail();
  const table = input.dataset.split('.')[1];
  const timestamp = input.timestamp ?? {
    column: input.dataset === 'core.permission_check_audit' ? 'checked_at' : 'created_at',
    unit: ['core.audit_log', 'core.operational_logs', 'core.permission_check_audit'].includes(
      input.dataset
    )
      ? 'seconds'
      : 'milliseconds',
  };
  const factor = timestamp.unit === 'seconds' ? 1000 : 1;
  const now = Date.now();
  let archived = false;
  let coverage: LogReadCoverage | undefined;
  let pagination: LogCursorPagination | undefined;
  const cursor = decodeCursor(input.page?.cursor, input.page?.scope ?? '');
  if (
    input.page &&
    (!Number.isSafeInteger(input.page.limit) ||
      input.page.limit < 1 ||
      input.page.limit > 201 ||
      (input.page.page !== undefined && input.page.page !== 1))
  ) {
    throw new LogQueryInvalidRequestError('Log lists use cursors; start with page 1.');
  }
  const snapshots = new Map<string, Promise<LogIcebergDatasetReadResult>>();
  let failed = false;
  function queryScope(sql: string, params: unknown[]) {
    const scope = { ...input.window };
    if (cursor) scope.toMs = Math.min(scope.toMs ?? Number.MAX_SAFE_INTEGER, cursor.at);
    let eventId: string | undefined;
    const source = selectSource(sql, table);
    if (
      source &&
      !tokens(source.where).some((t) => t.depth === 0 && t.word.toUpperCase() === 'OR')
    ) {
      const binds = tokens(sql).filter((t) => t.word === '?');
      for (const token of tokens(source.where).filter((t) => t.depth === 0)) {
        if (![timestamp.column, 'id'].includes(token.word)) continue;
        const comparison = /^\s*(>=|<=|>|<|=)\s*\?/.exec(source.where.slice(token.end));
        if (!comparison) continue;
        const at = source.whereAt + token.end + comparison[0].lastIndexOf('?');
        const index = binds.findIndex((t) => t.at === at);
        if (index < 0) fail();
        const value = params[index];
        if (token.word === 'id') {
          if (comparison[1] === '=' && typeof value === 'string') eventId = value;
          continue;
        }
        if (typeof value !== 'number' || !Number.isSafeInteger(value * factor) || value < 0) fail();
        const ms = value * factor;
        if (['>', '>=', '='].includes(comparison[1]))
          scope.fromMs = Math.max(scope.fromMs ?? 0, ms);
        if (['<', '<=', '='].includes(comparison[1]))
          scope.toMs = Math.min(scope.toMs ?? Number.MAX_SAFE_INTEGER, ms);
      }
    }
    return { ...scope, eventId };
  }
  async function runQuery<T>(
    sql: string,
    params: unknown[] = [],
    options?: QueryOptions
  ): Promise<T[]> {
    try {
      if (failed) fail();
      const scope = queryScope(sql, params);
      if (scope.fromMs !== undefined && scope.toMs !== undefined && scope.fromMs > scope.toMs)
        throw new LogQueryInvalidRequestError('Invalid log time range.');
      const key = JSON.stringify(scope);
      let loading = snapshots.get(key);
      if (!loading) {
        // Only one prepared source view is retained; the SQL executor is also serialized below.
        snapshots.clear();
        loading = readLogIcebergDataset(input.env, {
          tenantId: input.tenantId,
          sourceDataset: input.dataset,
          ...scope,
          now,
        });
        snapshots.set(key, loading);
      }
      const result = await loading;
      if (
        !Array.isArray(result.rows) ||
        typeof result.hasArchive !== 'boolean' ||
        !['eventual', 'snapshot', 'local_hot_only'].includes(result.consistency) ||
        !Number.isSafeInteger(result.pendingDeliveries) ||
        result.pendingDeliveries < 0
      )
        fail();
      archived ||= result.hasArchive;
      coverage = {
        consistency: result.consistency,
        pending_deliveries:
          input.includePendingDeliveries === false ? null : result.pendingDeliveries,
        complete: result.consistency === 'snapshot',
      };
      const names = new Set(input.columns ?? COLUMNS[input.dataset]?.split(' ') ?? []);
      const prepared = result.rows.map((original) => {
        if (original.tenant_id !== input.tenantId || typeof original.id !== 'string') fail();
        const row: LogIcebergSqlRow = { ...original };
        if (
          input.dataset === 'admin.admin_audit_log' &&
          (row.before_json != null || row.after_json != null)
        )
          fail();
        if (input.dataset === 'core.operational_logs' && row.reason_detail_encrypted != null)
          fail();
        if (input.dataset === 'core.event_log') {
          const json: unknown = row.details_json ? JSON.parse(String(row.details_json)) : null;
          const details =
            json && typeof json === 'object' && !Array.isArray(json)
              ? (json as Record<string, unknown>)
              : {};
          for (const [column, camel] of [
            ['ip_address', 'ipAddress'],
            ['user_agent', 'userAgent'],
          ]) {
            const value = row[column] ?? details[camel] ?? details[column];
            row[column] = typeof value === 'string' ? value : null;
          }
        }
        for (const name of Object.keys(row)) names.add(name);
        return row;
      });
      if (!names.size) fail();
      const columns = [...names];
      for (const row of prepared) for (const name of columns) row[name] ??= null;
      const source = selectSource(sql, table);
      const page = input.page;
      const dataPage =
        !!page &&
        !!source &&
        tokens(sql).some((t) => t.depth === 0 && t.word.toUpperCase() === 'LIMIT');
      if (dataPage && source && page) {
        const qualified = `${source.alias}.${timestamp.column}`;
        const id = `${source.alias}.id`;
        sql =
          sql.slice(0, source.end) +
          (cursor
            ? `${source.hasWhere ? ' AND' : ' WHERE'} (${qualified} < ? OR (${qualified} = ? AND ${id} < ?))`
            : '') +
          ` ORDER BY ${qualified} DESC, ${id} DESC LIMIT ?`;
        params = [
          ...params.slice(0, source.beforeBinds + source.sourceBinds),
          ...(cursor ? [cursor.at / factor, cursor.at / factor, cursor.id] : []),
          page.limit + 1,
        ];
      }
      const values = params.map((value) => {
        if (
          value === null ||
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          typeof value === 'number'
        )
          return value;
        return fail();
      });
      const rows = await executeLogQuery({
        sql,
        params: values as LogQueryValue[],
        tables: { [table]: { columns, rows: prepared } },
        now,
        ...(options?.timeoutMs
          ? { limits: { milliseconds: Math.min(5000, options.timeoutMs) } }
          : {}),
      });
      input.onCoverage?.(coverage);
      if (dataPage && page) {
        const selected = rows.slice(0, page.limit);
        const last = selected.at(-1);
        const more = rows.length > page.limit;
        let next: string | null = null;
        if (more) {
          if (!last || typeof last.id !== 'string' || typeof last[timestamp.column] !== 'number')
            fail();
          const at = Number(last[timestamp.column]) * factor;
          if (!Number.isSafeInteger(at) || at < 0) fail();
          next = cursorText({ v: 1, scope: page.scope, at, id: last.id });
        }
        pagination = { mode: 'cursor', limit: page.limit, has_more: more, next_cursor: next };
        return selected as T[];
      }
      return rows as T[];
    } catch (error) {
      failed = true;
      if (error instanceof LogQueryInvalidRequestError) throw error;
      if (coverage) input.onCoverage?.({ ...coverage, complete: false });
      return fail();
    }
  }
  let pending: Promise<void> = Promise.resolve();
  async function query<T>(
    sql: string,
    params: unknown[] = [],
    options?: QueryOptions
  ): Promise<T[]> {
    const captured = [...params];
    const previous = pending;
    let release = () => {};
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await runQuery<T>(sql, captured, options);
    } finally {
      release();
    }
  }
  const adapter: DatabaseAdapter = {
    query,
    async queryOne<T>(sql: string, params?: unknown[], options?: QueryOptions) {
      return (await query<T>(sql, params, options))[0] ?? null;
    },
    async execute() {
      return fail();
    },
    async batch() {
      return fail();
    },
    async transaction() {
      return fail();
    },
    async isHealthy() {
      try {
        await query(`SELECT COUNT(*) AS count FROM ${table}`);
        return { healthy: true, latencyMs: 0, type: 'log-iceberg' };
      } catch {
        return { healthy: false, latencyMs: 0, type: 'log-iceberg', error: 'log_query_incomplete' };
      }
    },
    getType: () => 'sqlite',
    async close() {},
  };
  return {
    adapter,
    hasArchive: () => archived,
    pagination: () => pagination,
    coverage: () => coverage,
  };
}

/** Additional detail permission/elevation must be checked by the endpoint before this call. */
export async function readLogProtectedDetail(
  env: Env,
  input: { tenantId: string; sourceDataset: string; eventId: string; now?: number }
): Promise<Record<string, unknown> | null> {
  try {
    return await loadLogIcebergProtectedDetail(env, input);
  } catch {
    return fail();
  }
}
