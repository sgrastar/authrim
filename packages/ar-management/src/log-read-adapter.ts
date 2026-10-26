import type { DatabaseAdapter, Env, QueryOptions } from '@authrim/ar-lib-core';
import type { Context } from 'hono';
import { ensureDatabaseAdapter, resolvePlatformSettingsWithSources } from '@authrim/ar-lib-core';
import { encryptValue } from '@authrim/ar-lib-core/utils/pii-encryption';
import { portableOperationalLogDetail } from '@authrim/ar-lib-core/services/tenant-portability/portable-operational-log-detail';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import {
  LogQueryIncompleteError,
  LogQueryInvalidRequestError,
  logRowTime,
  logRowUnexpired,
  readArchivedLogRows,
  type LogDataset,
  type LogReadWindow,
  type LogSqlRow,
} from './log-archive-query';
import { createLoggingTenantKeyResolverFromSource } from './logging-tenant-key';

const MAX_ROWS = 10_000;
const MAX_VIEW_BYTES = 4 * 1024 * 1024;
const MAX_BIND_BYTES = 1_000_000;
const HEAD_PAGE = 250;

const COLUMNS: Record<LogDataset, string> = {
  'core.event_log':
    'id tenant_id event_type event_category result severity error_code error_message anonymized_user_id client_id session_id request_id duration_ms details_r2_key details_json retention_until created_at',
  'core.audit_log':
    'id tenant_id user_id action resource_type resource_id ip_address user_agent metadata_json created_at severity',
  'core.operational_logs':
    'id tenant_id subject_type subject_id actor_id action reason_detail_encrypted encryption_key_version detail_object_catalog_id request_id created_at expires_at',
  'core.permission_check_audit':
    'id tenant_id subject_id permission permission_json allowed resolved_via_json final_decision reason api_key_id client_id checked_at',
  'admin.admin_audit_log':
    'id tenant_id admin_user_id admin_email action resource_type resource_id result error_code error_message severity ip_address user_agent request_id session_id before_json after_json metadata_json created_at detail_object_catalog_id actor_type actor_sub actor_mode actor_assurance token_binding act_client_id act_principal_id grant_id elevation_id mcp_tool',
};
const NUMERIC = new Set([
  'created_at',
  'checked_at',
  'duration_ms',
  'retention_until',
  'expires_at',
  'encryption_key_version',
  'allowed',
]);
function fail(): never {
  throw new LogQueryIncompleteError();
}

/** PostgreSQL returns bigint columns as strings; cursor comparisons require exact safe numbers. */
function normalizeNumericRows<T>(rows: T[]): T[] {
  for (const row of rows) {
    if (!row || typeof row !== 'object') fail();
    const values = row as Record<string, unknown>;
    for (const name of NUMERIC) {
      if (typeof values[name] !== 'string') continue;
      const value = Number(values[name]);
      if (!Number.isSafeInteger(value)) fail();
      values[name] = value;
    }
  }
  return rows;
}

interface Token {
  word: string;
  at: number;
  end: number;
  depth: number;
}
/** Only trusted, static SELECT statements enter here. Skip quoted values and nested clauses. */
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
    } else if (ch === '(') {
      depth++;
      i++;
    } else if (ch === ')') {
      depth--;
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
  from: string;
  where: string;
  params: unknown[];
  alias: string;
  end: number;
  beforeBinds: number;
  hasWhere: boolean;
}
function selectSource(sql: string, params: unknown[], table: string): SelectSource | null {
  const words = tokens(sql).filter((t) => t.depth === 0);
  if (words[0]?.word.toUpperCase() !== 'SELECT') return null;
  const index = words.findIndex((t) => t.word.toUpperCase() === 'FROM');
  if (index < 0 || words[index + 1]?.word !== table) return null;
  const start = words[index];
  const where = words.find((t) => t.at > start.at && t.word.toUpperCase() === 'WHERE');
  const end =
    words.find(
      (t) =>
        t.at > start.at &&
        ['GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'UNION'].includes(t.word.toUpperCase())
    )?.at ?? sql.length;
  const after = words[index + 2];
  const alias =
    after?.word.toUpperCase() === 'AS'
      ? words[index + 3]?.word
      : after &&
          !['WHERE', 'LEFT', 'INNER', 'JOIN', 'GROUP', 'ORDER', 'LIMIT'].includes(
            after.word.toUpperCase()
          )
        ? after.word
        : table;
  if (!alias || !/^[a-z][a-z0-9_]*$/.test(alias)) return fail();
  const prefixBinds = (sql.slice(0, start.at).match(/\?/g) ?? []).length;
  // The shipped log queries bind predicates, pagination, and occasionally SELECT expressions.
  const sourceBinds = (sql.slice(start.at, end).match(/\?/g) ?? []).length;
  return {
    from: sql.slice(start.end, where?.at ?? end).trim(),
    where: where && where.at < end ? sql.slice(where.end, end).trim() : '1 = 1',
    params: params.slice(prefixBinds, prefixBinds + sourceBinds),
    alias,
    end,
    beforeBinds: prefixBinds,
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

export function logDetailWindow(c: Context): { hotOnly: boolean; window: LogReadWindow } {
  const hint = c.req.query('event_at');
  if (!hint) return { hotOnly: true, window: {} };
  const ms = Number(hint);
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new LogQueryInvalidRequestError('event_at must be a Unix timestamp in milliseconds.');
  return { hotOnly: false, window: { fromMs: ms, toMs: ms } };
}

/**
 * Preserve existing SELECT predicates/aggregates over a bounded, request-local read view.
 * Every negative catalog probe follows the original hot SELECT, including the first archive.
 * Positive reads snapshot matching hot rows before selecting fresh committed R2 chunks.
 */
export function createLogReadAdapter(input: {
  env: Env;
  tenantId: string;
  adapter: DatabaseAdapter;
  dataset: LogDataset;
  window?: LogReadWindow;
  /** Details without a timestamp hint intentionally consult the hot store only. */
  hotOnly?: boolean;
  page?: LogPageRequest;
}): {
  adapter: DatabaseAdapter;
  hasArchive: () => boolean;
  pagination: () => LogCursorPagination | undefined;
} {
  const { env, tenantId, adapter, dataset, window = {} } = input;
  const hasExpiry = [
    'core.event_log',
    'core.operational_logs',
    'core.permission_check_audit',
  ].includes(dataset);
  if ((!hasExpiry && input.hotOnly) || !env?.DB_ADMIN)
    return { adapter, hasArchive: () => false, pagination: () => undefined };
  const table = dataset.split('.')[1];
  const columns = COLUMNS[dataset].split(' ');
  const timeColumn = dataset === 'core.permission_check_audit' ? 'checked_at' : 'created_at';
  const seconds = [
    'core.audit_log',
    'core.operational_logs',
    'core.permission_check_audit',
  ].includes(dataset);
  const dialect = adapter.getType?.() ?? 'sqlite';
  const pg = ['postgres', 'postgresql'].includes(dialect);
  const mysql = dialect === 'mysql';
  const quote = (s: string) => (mysql ? '`' + s + '`' : '"' + s + '"');
  const deadline = Date.now() + 10_000;
  const readNow = Date.now();
  let checkRetentionPromise: Promise<number> | undefined;
  const checkRetention = () =>
    (checkRetentionPromise ??= (async () => {
      const { values } = await resolvePlatformSettingsWithSources(env, 'check-api-audit');
      const days = values['audit.check_api_retention_days'];
      if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1) fail();
      return days * 86_400_000;
    })());
  let archived = false;
  const pageCursor = decodeCursor(input.page?.cursor, input.page?.scope ?? '');
  let pagination: LogCursorPagination | undefined;
  let tenantKeyPromise: Promise<string | null | undefined> | undefined;
  const views = new Map<string, Promise<LogSqlRow[]>>();
  const tenantKey = () =>
    (tenantKeyPromise ??= (async () =>
      (await createLoggingTenantKeyResolverFromSource(env.DB, 'log-read-tenant-key')?.(tenantId)) ??
      (await deriveTenantKeyFromTenantId(tenantId, env.LOGGING_TENANT_KEY_SALT)))());
  const inWindow = (row: LogSqlRow) => {
    const at = logRowTime(dataset, row);
    return (
      (window.fromMs === undefined || at >= window.fromMs) &&
      (window.toMs === undefined || at <= window.toMs)
    );
  };

  async function snapshot(source: SelectSource): Promise<LogSqlRow[]> {
    const hot = new Map<string, LogSqlRow>();
    const hotIds = new Set<string>();
    const checkedIds = new Set<string>();
    const now = readNow;
    let checkRetentionMs: number | undefined;
    if (dataset === 'core.permission_check_audit') {
      checkRetentionMs = await checkRetention();
    }
    let totalBytes = 0;
    let cursor: { at: number; id: string } | undefined;
    const alias = quote(source.alias);
    const fields = columns.map((column) => `'${column}',${alias}.${quote(column)}`).join(',');
    const json = pg
      ? `row_to_json(${alias})::text`
      : mysql
        ? `JSON_OBJECT(${fields})`
        : `json_object(${fields})`;
    const size = pg
      ? `octet_length(${json})`
      : mysql
        ? `OCTET_LENGTH(${json})`
        : `length(CAST(${json} AS BLOB))`;
    const queryWindow = { ...window };
    if (input.page && pageCursor)
      queryWindow.toMs = Math.min(queryWindow.toMs ?? Number.MAX_SAFE_INTEGER, pageCursor.at);
    const words = tokens(source.where).filter((t) => t.depth === 0);
    // Only conjunctive, top-level time predicates bound the catalog; cursor ORs stay in SQL.
    if (!words.some((t) => t.word.toUpperCase() === 'OR'))
      for (const word of words) {
        if (word.word !== timeColumn) continue;
        const comparison = /^\s*(>=|<=|>|<|=)\s*\?/.exec(source.where.slice(word.end));
        if (!comparison) continue;
        const bindIndex =
          (source.from.match(/\?/g) ?? []).length +
          (source.where.slice(0, word.end).match(/\?/g) ?? []).length;
        const value = source.params[bindIndex];
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const ms = value * (seconds ? 1000 : 1);
        if (['>=', '>', '='].includes(comparison[1]))
          queryWindow.fromMs = Math.max(
            queryWindow.fromMs ?? 0,
            ms + (comparison[1] === '>' ? (seconds ? 1000 : 1) : 0)
          );
        if (['<=', '<', '='].includes(comparison[1]))
          queryWindow.toMs = Math.min(
            queryWindow.toMs ?? Number.MAX_SAFE_INTEGER,
            ms - (comparison[1] === '<' ? 1 : 0)
          );
      }
    let where = `${alias}.tenant_id = ? AND (${source.where})`;
    const baseParams: unknown[] = [tenantId, ...source.params];
    if (dataset === 'core.event_log') {
      where += ` AND (${alias}.retention_until IS NULL OR ${alias}.retention_until > ?)`;
      baseParams.push(now);
    }
    if (dataset === 'core.operational_logs') {
      where += ` AND ${alias}.expires_at > ?`;
      baseParams.push(now / 1000);
    }
    if (dataset === 'core.permission_check_audit') {
      where += ` AND ${alias}.checked_at > ?`;
      baseParams.push((now - (checkRetentionMs ?? fail())) / 1000);
    }
    if (window.fromMs !== undefined) {
      where += ` AND ${alias}.${timeColumn} >= ?`;
      baseParams.push(window.fromMs / (seconds ? 1000 : 1));
    }
    if (window.toMs !== undefined) {
      where += ` AND ${alias}.${timeColumn} <= ?`;
      baseParams.push(window.toMs / (seconds ? 1000 : 1));
    }
    async function pageCandidates(archivedRows: readonly LogSqlRow[]): Promise<LogSqlRow[]> {
      const page = input.page;
      if (!page) return [];
      const combined = new Map(hot);
      for (const row of archivedRows)
        if (!hotIds.has(String(row.id)) && !combined.has(String(row.id)))
          combined.set(String(row.id), row);
      const bound = cte([...combined.values()]);
      const fromBinds = (source.from.match(/\?/g) ?? []).length;
      return normalizeNumericRows(
        await adapter.query<LogSqlRow>(
          bound.sql +
            `SELECT ${alias}.id, ${alias}.${timeColumn} AS ${quote(timeColumn)} FROM ${source.from}
          WHERE ${alias}.tenant_id = ? AND (${source.where})
          ORDER BY ${alias}.${timeColumn} DESC, ${alias}.id DESC LIMIT ?`,
          [
            ...bound.params,
            ...source.params.slice(0, fromBinds),
            tenantId,
            ...source.params.slice(fromBinds),
            page.limit + 1,
          ]
        )
      );
    }
    // Read small heads first so a page of large details cannot exhaust Worker memory.
    for (;;) {
      if (Date.now() > deadline) fail();
      const boundary = cursor
        ? ` AND (${alias}.${timeColumn} < ? OR (${alias}.${timeColumn} = ? AND ${alias}.id < ?))`
        : '';
      const args = cursor ? [cursor.at, cursor.at, cursor.id] : [];
      const heads = await adapter.query<{ id: string; at: number; bytes: number }>(
        `SELECT ${alias}.id, ${alias}.${timeColumn} AS at, ${size} AS bytes
         FROM ${source.from} WHERE ${where}${boundary}
         ORDER BY ${alias}.${timeColumn} DESC, ${alias}.id DESC LIMIT ?`,
        [...baseParams, ...args, input.page ? Math.min(HEAD_PAGE, input.page.limit + 1) : HEAD_PAGE]
      );
      if (!heads.length) break;
      for (const head of heads) {
        head.at = Number(head.at);
        head.bytes = Number(head.bytes);
        if (!Number.isSafeInteger(head.at) || head.at < 0 || typeof head.id !== 'string') fail();
        totalBytes += Number(head.bytes);
        if (
          !Number.isSafeInteger(head.bytes) ||
          head.bytes < 1 ||
          head.bytes > MAX_BIND_BYTES ||
          totalBytes > MAX_VIEW_BYTES ||
          hot.size + heads.length > MAX_ROWS
        )
          fail();
      }
      // At most one MiB of bodies per read, encoded as ID arrays below the bind limit.
      for (let start = 0; start < heads.length; ) {
        let end = start,
          bytes = 0;
        while (end < heads.length && bytes + heads[end].bytes <= 1024 * 1024)
          bytes += heads[end++].bytes;
        const ids = heads.slice(start, end).map(({ id }) => id);
        const placeholders = ids.map(() => '?').join(',');
        // Keep well under D1's bind limit even when every log row is small.
        for (let i = 0; i < ids.length; i += 64) {
          const group = ids.slice(i, i + 64);
          const rows = await adapter.query<LogSqlRow>(
            `SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}
             WHERE tenant_id = ? AND id IN (${placeholders.split(',').slice(0, group.length).join(',')})`,
            [tenantId, ...group]
          );
          for (const row of rows) {
            for (const name of NUMERIC)
              if (typeof row[name] === 'string') {
                const value = Number(row[name]);
                if (!Number.isSafeInteger(value)) fail();
                row[name] = value;
              }
            if (row.tenant_id !== tenantId || typeof row.id !== 'string') fail();
            hotIds.add(String(row.id));
            checkedIds.add(String(row.id));
            if (inWindow(row)) hot.set(String(row.id), row);
          }
        }
        start = end;
      }
      const last = heads[heads.length - 1];
      cursor = { at: last.at, id: last.id };
      if (input.page && (await pageCandidates([])).length >= input.page.limit + 1) break;
      if (heads.length < (input.page ? Math.min(HEAD_PAGE, input.page.limit + 1) : HEAD_PAGE))
        break;
    }
    // Resolve ownership of each cold candidate before using it to prove a top-N boundary.
    async function syncHotRows(archivedRows: readonly LogSqlRow[]) {
      const unseen = [
        ...new Set(archivedRows.map((row) => String(row.id)).filter((id) => !checkedIds.has(id))),
      ];
      for (let index = 0; index < unseen.length; index += 64) {
        if (Date.now() > deadline) fail();
        const ids = unseen.slice(index, index + 64);
        const current = await adapter.query<LogSqlRow>(
          `SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
          [tenantId, ...ids]
        );
        for (const id of ids) checkedIds.add(id);
        for (const row of current) {
          for (const name of NUMERIC)
            if (typeof row[name] === 'string') row[name] = Number(row[name]);
          if (row.tenant_id !== tenantId || typeof row.id !== 'string') fail();
          hotIds.add(row.id);
          if (logRowUnexpired(dataset, row, now, checkRetentionMs)) hot.set(row.id, row);
        }
      }
    }
    const archive = await readArchivedLogRows({
      env,
      tenantId,
      dataset,
      window: queryWindow,
      canStop: input.page
        ? async (rows, nextUpperBound) => {
            await syncHotRows(rows);
            const candidates = await pageCandidates(rows);
            const last = candidates.at(input.page!.limit);
            return (
              !!last && (nextUpperBound === null || nextUpperBound < logRowTime(dataset, last))
            );
          }
        : undefined,
    });
    await syncHotRows(archive);
    for (const row of archive) {
      if (hotIds.has(String(row.id)) || hot.has(String(row.id))) continue;
      if (dataset === 'core.operational_logs' && row.reason_detail_encrypted !== null) {
        const portable: PortableSqliteRow = Object.fromEntries(
          Object.entries(row).map(([name, value]) => [
            name,
            value === null
              ? ['null', null]
              : [typeof value === 'number' ? 'integer' : 'text', String(value)],
          ])
        );
        const detail = portableOperationalLogDetail(portable);
        if (detail.mode !== 'inline' || !env.PII_ENCRYPTION_KEY) fail();
        // This transient value keeps the existing detail loader/authorization contract intact.
        row.reason_detail_encrypted = (
          await encryptValue(
            detail.plaintext,
            env.PII_ENCRYPTION_KEY,
            'AES-256-GCM',
            detail.sourceKeyVersion
          )
        ).encrypted;
      }
      hot.set(String(row.id), row);
      if (hot.size > MAX_ROWS) fail();
    }
    return [...hot.values()];
  }

  function cte(rows: LogSqlRow[]): { sql: string; params: string[] } {
    const groups: string[] = [];
    let parts: string[] = [],
      size = 2,
      total = 0;
    for (const row of rows) {
      const json = JSON.stringify(row);
      const length = new TextEncoder().encode(json).length + 1;
      total += length;
      if (length > MAX_BIND_BYTES - 2 || total > MAX_VIEW_BYTES) fail();
      if (size + length > MAX_BIND_BYTES) {
        groups.push(`[${parts.join(',')}]`);
        parts = [];
        size = 2;
      }
      parts.push(json);
      size += length;
    }
    groups.push(`[${parts.join(',')}]`);
    const projection = columns
      .map((column) => `json_extract(value,'$.${column}') AS ${quote(column)}`)
      .join(',');
    const declarations = columns
      .map((column) => `${quote(column)} ${NUMERIC.has(column) ? 'bigint' : 'text'}`)
      .join(',');
    const mysqlColumns = columns
      .map(
        (column) =>
          `\`${column}\` ${NUMERIC.has(column) ? 'BIGINT' : 'LONGTEXT'} PATH '$.${column}' NULL ON EMPTY`
      )
      .join(',');
    const sources = groups.map(() =>
      pg
        ? `SELECT * FROM jsonb_to_recordset(CAST(? AS jsonb)) AS log_rows(${declarations})`
        : mysql
          ? `SELECT * FROM JSON_TABLE(?, '$[*]' COLUMNS(${mysqlColumns})) AS log_rows`
          : `SELECT ${projection} FROM json_each(?)`
    );
    return { sql: `WITH ${quote(table)} AS (${sources.join(' UNION ALL ')}) `, params: groups };
  }

  async function query<T>(
    sql: string,
    params: unknown[] = [],
    options?: QueryOptions,
    originalRead?: (statement: string, values: unknown[]) => Promise<T[]>
  ): Promise<T[]> {
    const originalQuery = () =>
      options ? adapter.query<T>(sql, params, options) : adapter.query<T>(sql, params);
    let source = selectSource(sql, params, table);
    if (!source) return originalRead ? originalRead(sql, params) : originalQuery();
    if (hasExpiry) {
      const alias = quote(source.alias);
      const predicate =
        dataset === 'core.event_log'
          ? `(${alias}.retention_until IS NULL OR ${alias}.retention_until > ?)`
          : dataset === 'core.operational_logs'
            ? `${alias}.expires_at > ?`
            : `${alias}.checked_at > ?`;
      const expiryAt =
        dataset === 'core.event_log'
          ? readNow
          : dataset === 'core.operational_logs'
            ? readNow / 1000
            : (readNow - (await checkRetention())) / 1000;
      const bindAt = source.beforeBinds + source.params.length;
      sql =
        sql.slice(0, source.end) +
        `${source.hasWhere ? ' AND' : ' WHERE'} ${predicate} ` +
        sql.slice(source.end);
      params = [...params.slice(0, bindAt), expiryAt, ...params.slice(bindAt)];
      source = selectSource(sql, params, table) ?? fail();
    }
    if (input.hotOnly || !env.DB_ADMIN)
      return originalRead ? originalRead(sql, params) : originalQuery();
    // No negative probe can precede the hot SELECT: an initial commit/delete cannot cause a gap.
    const original = await (originalRead ? originalRead(sql, params) : originalQuery());
    let exists: { id: string } | null;
    try {
      const key = await tenantKey();
      if (!key) fail();
      const catalog = ensureDatabaseAdapter(env.DB_ADMIN, 'log-read-catalog');
      exists = await catalog.queryOne<{ id: string }>(
        `SELECT id FROM log_object_catalog WHERE tenant_key = ? AND source_table = ?
         AND plane = 'archive' AND status = 'committed' LIMIT 1`,
        [key, dataset]
      );
    } catch {
      return fail();
    }
    const foundArchive = typeof exists?.id === 'string';
    if (!foundArchive && !pageCursor) return original;
    if (foundArchive) archived = true;
    const page = input.page;
    const isDataPage =
      page && tokens(sql).some((t) => t.depth === 0 && t.word.toUpperCase() === 'LIMIT');
    // The hot count is discarded by cursor responses. It must not force an all-history scan.
    if (page && !isDataPage) return original;
    if (isDataPage) {
      if (
        !Number.isSafeInteger(page.limit) ||
        page.limit < 1 ||
        page.limit > 200 ||
        (page.page !== undefined && page.page !== 1)
      )
        throw new LogQueryInvalidRequestError('Archived log lists use cursors; start with page 1.');
      const qualified = `${quote(source.alias)}.${quote(timeColumn)}`;
      const id = `${quote(source.alias)}.id`;
      sql =
        sql.slice(0, source.end) +
        (pageCursor
          ? `${source.hasWhere ? ' AND' : ' WHERE'} (${qualified} < ? OR (${qualified} = ? AND ${id} < ?))`
          : '') +
        ` ORDER BY ${qualified} DESC, ${id} DESC LIMIT ?`;
      params = [
        ...params.slice(0, source.beforeBinds + source.params.length),
        ...(pageCursor
          ? [
              pageCursor.at / (seconds ? 1000 : 1),
              pageCursor.at / (seconds ? 1000 : 1),
              pageCursor.id,
            ]
          : []),
        page.limit + 1,
      ];
      source = selectSource(sql, params, table) ?? fail();
    }
    const cacheKey = JSON.stringify([source.from, source.where, source.params]);
    let view = views.get(cacheKey);
    if (!view) {
      view = snapshot(source).catch(() => fail());
      views.set(cacheKey, view);
    }
    const bound = cte(await view);
    const rows = normalizeNumericRows(
      await adapter.query<T>(bound.sql + sql, [...bound.params, ...params], options)
    );
    if (isDataPage) {
      const selected = rows.slice(0, page.limit);
      const last = selected.at(-1);
      const hasMore = rows.length > page.limit;
      if (
        hasMore &&
        (!last || typeof last !== 'object' || !(timeColumn in last) || !('id' in last))
      )
        fail();
      const tail = last as LogSqlRow | undefined;
      pagination = {
        mode: 'cursor',
        limit: page.limit,
        has_more: hasMore,
        next_cursor:
          hasMore && tail
            ? cursorText({ v: 1, scope: page.scope, at: logRowTime(dataset, tail), id: tail.id })
            : null,
      };
      return selected;
    }
    return rows;
  }
  const wrapped: DatabaseAdapter = {
    query,
    async queryOne<T>(sql: string, params?: unknown[], options?: QueryOptions) {
      return (
        (
          await query<T>(sql, params, options, async (statement, values) => {
            const row = await (options
              ? adapter.queryOne<T>(statement, values, options)
              : adapter.queryOne<T>(statement, values));
            return row === null ? [] : [row];
          })
        )[0] ?? null
      );
    },
    execute: (sql, params) => adapter.execute(sql, params),
    batch: (statements) => adapter.batch(statements),
    transaction: (fn) => adapter.transaction(fn),
    isHealthy: () => adapter.isHealthy(),
    getType: () => adapter.getType(),
    close: () => adapter.close(),
  };
  return { adapter: wrapped, hasArchive: () => archived, pagination: () => pagination };
}
