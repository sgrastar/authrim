import {
  executeSql,
  extractTables,
  parseSql,
  planSql,
  type AsyncBatch,
  type AsyncDataSource,
  type AsyncRow,
  type ExprNode,
  type QueryPlan,
  type RelationSchema,
  type SqlPrimitive,
  type Statement,
  type UserDefinedFunction,
} from 'squirreling';

export type LogQueryValue = string | number | boolean | null;
export type LogQueryRow = Record<string, LogQueryValue>;
export interface LogQueryTable {
  /** Supply the schema even when the authorized table contains no rows. */
  columns: readonly string[];
  rows: readonly Readonly<LogQueryRow>[];
}
export interface LogQueryLimits {
  inputRows: number;
  inputBytes: number;
  intermediateRows: number;
  intermediateBytes: number;
  groups: number;
  outputRows: number;
  outputBytes: number;
  scannedRows: number;
  operations: number;
  milliseconds: number;
}
export interface ExecuteLogQueryOptions {
  /** Internal, fixed SELECT only. Never pass a request-supplied SQL statement. */
  sql: string;
  params?: readonly LogQueryValue[];
  /** Tenant and detail permissions must be enforced before constructing these tables. */
  tables: Readonly<Record<string, LogQueryTable>>;
  /** A frozen UTC instant for the supported SQLite `now` date expression. */
  now?: number;
  /** Overrides can only lower the hard ceilings. Exceeding any limit rejects the whole query. */
  limits?: Partial<LogQueryLimits>;
  signal?: AbortSignal;
}

export class LogQueryEngineError extends Error {
  constructor(public readonly code: 'unsupported' | 'invalid' | 'budget') {
    // Do not include SQL, bound values, or decrypted source rows in an error.
    super(`Log query ${code}.`);
    this.name = 'LogQueryEngineError';
  }
}

const CEILINGS: Readonly<LogQueryLimits> = Object.freeze({
  inputRows: 10_000,
  inputBytes: 4 * 1024 * 1024,
  intermediateRows: 20_000,
  intermediateBytes: 16 * 1024 * 1024,
  groups: 10_000,
  outputRows: 10_000,
  outputBytes: 4 * 1024 * 1024,
  scannedRows: 100_000,
  operations: 1_000_000,
  milliseconds: 5_000,
});
const PARAMETER_BASE = 9_007_199_254_670_000;
const MAX_PARAMETERS = 256;
const SQL_FUNCTIONS = new Set([
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COALESCE',
  'NULLIF',
  'FLOOR',
  'AUTHRIM_JSON_EXTRACT',
  'AUTHRIM_JSON_TYPE',
  'AUTHRIM_JSON_VALID',
  'AUTHRIM_DATETIME',
  'AUTHRIM_STRFTIME',
  'AUTHRIM_LIKE',
]);
const REWRITE_FUNCTIONS = new Set([
  'JSON_EXTRACT',
  'JSON_TYPE',
  'JSON_VALID',
  'DATETIME',
  'STRFTIME',
]);
const AST_TYPES = new Set([
  'select',
  'compound',
  'with',
  'table',
  'subquery',
  'star',
  'derived',
  'literal',
  'identifier',
  'unary',
  'binary',
  'function',
  'in valuelist',
  'case',
]);
function fail(code: 'unsupported' | 'invalid' | 'budget'): never {
  throw new LogQueryEngineError(code);
}
function safeName(name: string): void {
  if (
    name.length > 128 ||
    !/^[a-z_][a-z0-9_]*$/i.test(name) ||
    Object.hasOwn(Object.prototype, name)
  ) {
    fail('unsupported');
  }
}
function scalar(value: unknown): string | number | null {
  if (typeof value === 'string') {
    if (value.length > CEILINGS.inputBytes) fail('budget');
    return value;
  }
  if (value === null) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return value;
  return fail('invalid');
}
function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Rewrite SQL structure only. Parameter values are subsequently installed into the public AST. */
function prepareSql(sql: string, params: readonly LogQueryValue[]): string {
  if (!sql || sql.length > 16_384 || params.length > MAX_PARAMETERS || bytes(params) > 1_000_000) {
    fail('budget');
  }
  let output = '';
  let index = 0;
  let depth = 0;
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i++] !== ch) continue;
        if (sql[i] === ch) {
          i++;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed) fail('unsupported');
      output += sql.slice(start, i);
    } else if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end;
      output += ' ';
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) fail('unsupported');
      i = end + 2;
      output += ' ';
    } else if (ch === '?') {
      if (/\d/.test(sql[i + 1] ?? '') || index >= params.length) fail('invalid');
      output += String(PARAMETER_BASE + index++);
      i++;
    } else if (/[a-z_]/i.test(ch)) {
      const start = i++;
      while (i < sql.length && /[a-z_0-9]/i.test(sql[i])) i++;
      const word = sql.slice(start, i);
      if (word.toUpperCase().startsWith('AUTHRIM_')) fail('unsupported');
      output +=
        REWRITE_FUNCTIONS.has(word.toUpperCase()) && /^\s*\(/.test(sql.slice(i))
          ? `AUTHRIM_${word.toUpperCase()}`
          : word;
    } else if (/\d/.test(ch)) {
      const numeric = /^\d+(?:\.\d*)?(?:[Ee][+-]?\d+)?/.exec(sql.slice(i))?.[0];
      if (!numeric) fail('unsupported');
      const n = Number(numeric);
      if (n >= PARAMETER_BASE && n < PARAMETER_BASE + MAX_PARAMETERS) fail('unsupported');
      output += numeric;
      i += numeric.length;
    } else {
      if (ch === '(' && ++depth > 32) fail('budget');
      if (ch === ')' && --depth < 0) fail('unsupported');
      output += ch;
      i++;
    }
  }
  if (depth !== 0) fail('unsupported');
  if (index !== params.length) fail('invalid');
  return output;
}

function bindAndValidate(statement: Statement, params: readonly LogQueryValue[]): number {
  let nodes = 0;
  let constantBytes = 0;
  function visit(value: unknown, depth = 0): void {
    if (!value || typeof value !== 'object') return;
    if (++nodes > 2048 || depth > 48) fail('budget');
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const node = value as Record<string, unknown>;
    const type = node.type;
    if (typeof type === 'string') {
      if (!AST_TYPES.has(type)) fail('unsupported');
      if (type === 'subquery' && 'subquery' in node) fail('unsupported');
      if (type === 'function') {
        if (typeof node.funcName !== 'string' || !SQL_FUNCTIONS.has(node.funcName.toUpperCase())) {
          fail('unsupported');
        }
        // Table functions and window expansions have no bounded cardinality contract here.
        if ('columnAliases' in node || 'partitionBy' in node) fail('unsupported');
      }
      if (type === 'literal') {
        if (
          typeof node.value === 'number' &&
          node.value >= PARAMETER_BASE &&
          node.value < PARAMETER_BASE + params.length
        ) {
          node.value = scalar(params[node.value - PARAMETER_BASE]);
        } else scalar(node.value);
        if (typeof node.value === 'string') constantBytes += bytes(node.value);
      }
      // The fixed log queries do not concatenate arbitrary bodies into stateful grouping/sort keys.
      if (type === 'binary' && node.op === '||') fail('unsupported');
      if (type === 'binary' && node.op === 'LIKE') {
        node.type = 'function';
        node.funcName = 'AUTHRIM_LIKE';
        node.args = [node.left, node.right];
        delete node.op;
        delete node.left;
        delete node.right;
      }
    }
    for (const [key, item] of Object.entries(node)) {
      if (['name', 'alias', 'table', 'prefix'].includes(key) && typeof item === 'string')
        safeName(item);
      if ((key === 'limit' || key === 'offset') && item !== undefined) {
        const bound =
          typeof item === 'number' &&
          item >= PARAMETER_BASE &&
          item < PARAMETER_BASE + params.length
            ? scalar(params[item - PARAMETER_BASE])
            : item;
        if (
          typeof bound !== 'number' ||
          !Number.isSafeInteger(bound) ||
          bound < 0 ||
          bound > CEILINGS.intermediateRows
        ) {
          fail('invalid');
        }
        node[key] = bound;
      } else visit(item, depth + 1);
    }
  }
  visit(statement);
  return constantBytes;
}

function jsonValue(
  input: SqlPrimitive,
  path: SqlPrimitive | undefined,
  decode: (text: string) => unknown
): { found: boolean; value: unknown } {
  if (path === undefined) path = '$';
  if (input === null || path === null) return { found: false, value: null };
  if (
    typeof path !== 'string' ||
    path.length > 256 ||
    !/^\$(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d+\])*$/.test(path)
  ) {
    fail('unsupported');
  }
  let value = decode(String(scalar(input)));
  const parts = [...path.slice(1).matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\d+)\]/g)];
  if (parts.length > 16) fail('budget');
  for (const part of parts) {
    const key = part[1] ?? part[2];
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) !== (part[2] !== undefined) ||
      !Object.hasOwn(value, key)
    ) {
      return { found: false, value: null };
    }
    value = (value as Record<string, unknown>)[key];
  }
  return { found: true, value };
}
function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'real';
  return 'text';
}
function dateText(date: Date): string {
  const iso = date.toISOString();
  if (!/^\d{4}-/.test(iso)) fail('unsupported');
  return iso.slice(0, 19).replace('T', ' ');
}
function dateValue(
  input: SqlPrimitive,
  modifier: SqlPrimitive | undefined,
  now: number
): Date | null {
  if (input === null) return null;
  let time: number;
  if (modifier === 'unixepoch') {
    if (typeof input !== 'number' && typeof input !== 'string') fail('unsupported');
    if (typeof input === 'string' && !/^-?\d+(?:\.\d+)?$/.test(input)) fail('unsupported');
    time = Number(input) * 1000;
  } else if (modifier !== undefined) return fail('unsupported');
  else if (input === 'now') time = now;
  else if (
    typeof input === 'string' &&
    /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,3})?Z?$/.test(input)
  ) {
    time = Date.parse(input.replace(' ', 'T').replace(/Z?$/, 'Z'));
  } else return fail('unsupported');
  if (!Number.isFinite(time) || Math.abs(time) > 8.64e15) fail('invalid');
  return new Date(time);
}

/** Executes only over the provided, already authorized in-memory rows. This function performs no I/O. */
export async function executeLogQuery(options: ExecuteLogQueryOptions): Promise<LogQueryRow[]> {
  const limits = { ...CEILINGS, ...options.limits };
  for (const key of Object.keys(CEILINGS) as (keyof LogQueryLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > CEILINGS[key])
      fail('invalid');
  }
  const started = Date.now();
  const now = options.now ?? started;
  if (!Number.isSafeInteger(now)) fail('invalid');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, limits.milliseconds);
  let operations = 0;
  let scanned = 0;
  function check(charge = 1): void {
    operations += charge;
    if (
      options.signal?.aborted ||
      controller.signal.aborted ||
      Date.now() - started >= limits.milliseconds ||
      operations > limits.operations
    ) {
      controller.abort();
      fail('budget');
    }
  }
  try {
    check();
    const params = [...(options.params ?? [])].map(scalar);
    const query = prepareSql(options.sql, params);
    const tables: Record<string, AsyncDataSource> = Object.create(null) as Record<
      string,
      AsyncDataSource
    >;
    const snapshots = new Map<string, LogQueryRow[]>();
    const sourceBytes = new Map<string, number>();
    let inputRows = 0;
    let inputBytes = 0;
    const entries = Object.entries(options.tables);
    if (entries.length > 16) fail('budget');
    for (const [name, table] of entries) {
      safeName(name);
      if (
        !table.columns.length ||
        table.columns.length > 128 ||
        new Set(table.columns).size !== table.columns.length
      )
        fail('invalid');
      const columns = [...table.columns];
      columns.forEach(safeName);
      inputBytes += bytes(columns);
      if (inputBytes > limits.inputBytes) fail('budget');
      const rows: LogQueryRow[] = [];
      let tableBytes = 0;
      for (const original of table.rows) {
        check();
        if (++inputRows > limits.inputRows) fail('budget');
        if (!original || typeof original !== 'object' || Array.isArray(original)) fail('invalid');
        if (Object.keys(original).some((key) => !columns.includes(key))) fail('invalid');
        const row: LogQueryRow = Object.create(null) as LogQueryRow;
        for (const column of columns) {
          const descriptor = Object.getOwnPropertyDescriptor(original, column);
          if (!descriptor || !('value' in descriptor)) fail('invalid');
          row[column] = scalar(descriptor.value);
        }
        const rowBytes = bytes(row);
        tableBytes += rowBytes;
        inputBytes += rowBytes;
        if (inputBytes > limits.inputBytes) fail('budget');
        rows.push(row);
      }
      snapshots.set(name, rows);
      sourceBytes.set(name, tableBytes);
      const schema: RelationSchema = {
        fields: columns.map((name, id) => ({
          id,
          name,
          dataType: { type: 'unknown' },
          nullable: true,
        })),
      };
      tables[name] = {
        columns,
        schema,
        numRows: rows.length,
        prepareScan(request) {
          const fields = request.columns.map(({ field }) => schema.fields[field]);
          if (fields.some((field) => !field)) fail('unsupported');
          return {
            schema: { fields },
            residual: { filter: request.filter, limit: request.limit, offset: request.offset },
            properties: { exactRows: rows.length, maxRows: rows.length },
            async *batches(): AsyncIterable<AsyncBatch> {
              // Bound each materialized vector batch; avoid one Promise/closure per input cell.
              for (let start = 0; start < rows.length; start += 128) {
                const chunk = rows.slice(start, start + 128);
                check(chunk.length * Math.max(1, fields.length));
                scanned += chunk.length;
                if (scanned > limits.scannedRows) fail('budget');
                yield {
                  selection: { type: 'all', length: chunk.length },
                  columns: fields.map((field) => ({
                    type: 'values',
                    values: chunk.map((row) => row[field.name]),
                    length: chunk.length,
                  })),
                };
              }
            },
          };
        },
        scan({ columns: selected = columns }) {
          return {
            appliedWhere: false,
            appliedLimitOffset: false,
            async *rows(): AsyncIterable<AsyncRow> {
              for (const row of rows) {
                check();
                if (++scanned > limits.scannedRows) fail('budget');
                const cells: AsyncRow['cells'] = Object.create(null) as AsyncRow['cells'];
                for (const column of selected)
                  cells[column] = async () => {
                    check();
                    return row[column];
                  };
                yield { columns: selected, cells };
              }
            },
          };
        },
      };
    }
    const functions: Record<string, UserDefinedFunction> = {};
    // Repeated JSON predicates share parsing within one invocation only. Decoded bodies never leave memory.
    const decoded = new Map<string, unknown>();
    let decodedBytes = 0;
    const decode = (text: string): unknown => {
      check(Math.ceil(text.length / 256));
      if (decoded.has(text)) return decoded.get(text);
      decodedBytes += bytes(text);
      if (decodedBytes > limits.inputBytes + 1_000_000 || decoded.size >= limits.inputRows)
        fail('budget');
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return fail('invalid');
      }
      const inspect = [value];
      while (inspect.length) {
        const current = inspect.pop();
        check();
        if (current && typeof current === 'object') {
          for (const child of Object.values(current)) inspect.push(child);
        } else scalar(current);
      }
      decoded.set(text, value);
      return value;
    };
    const define = (
      name: string,
      min: number,
      max: number,
      apply: UserDefinedFunction['apply']
    ) => {
      functions[name] = {
        arguments: { min, max },
        apply: (...args) => {
          check();
          return apply(...args);
        },
      };
    };
    define('AUTHRIM_JSON_EXTRACT', 2, 2, (input, path) => {
      const { value } = jsonValue(input, path, decode);
      return value && typeof value === 'object' ? JSON.stringify(value) : scalar(value);
    });
    define('AUTHRIM_JSON_TYPE', 1, 2, (input, path) => {
      const result = jsonValue(input, path, decode);
      return result.found ? jsonType(result.value) : null;
    });
    define('AUTHRIM_JSON_VALID', 1, 1, (input) => {
      if (input === null) return null;
      try {
        decode(String(scalar(input)));
        return 1;
      } catch (error) {
        if (error instanceof LogQueryEngineError && error.code === 'invalid') return 0;
        throw error;
      }
    });
    define('AUTHRIM_DATETIME', 1, 2, (input, modifier) => {
      const date = dateValue(input, modifier, now);
      return date ? dateText(date) : null;
    });
    define('AUTHRIM_STRFTIME', 2, 3, (format, input, modifier) => {
      const date = dateValue(input, modifier, now);
      if (!date || format === null) return null;
      const text = dateText(date);
      if (format === '%Y-%m-%d') return text.slice(0, 10);
      if (format === '%Y-%m-%d %H:00:00') return `${text.slice(0, 13)}:00:00`;
      if (format === '%s') return String(Math.floor(date.getTime() / 1000));
      if (format !== '%Y-%W') return fail('unsupported');
      const yearStart = new Date(`${text.slice(0, 4)}-01-01T00:00:00Z`);
      const firstMonday = (7 - ((yearStart.getUTCDay() + 6) % 7)) % 7;
      const day = Math.floor((date.getTime() - yearStart.getTime()) / 86_400_000);
      const week = day < firstMonday ? 0 : Math.floor((day - firstMonday) / 7) + 1;
      return `${text.slice(0, 4)}-${String(week).padStart(2, '0')}`;
    });
    define('AUTHRIM_LIKE', 2, 2, (value, pattern) => {
      if (value === null || pattern === null) return null;
      if (typeof value !== 'string' || typeof pattern !== 'string') fail('unsupported');
      const fold = (v: SqlPrimitive) =>
        String(scalar(v))
          .split('\0', 1)[0]
          .replace(/[A-Z]/g, (c) => c.toLowerCase());
      const text = Array.from(fold(value));
      const match = Array.from(fold(pattern));
      if (match.length > 4096) fail('budget');
      let i = 0;
      let j = 0;
      let star = -1;
      let retry = 0;
      while (i < text.length) {
        check();
        if (match[j] === '_' || match[j] === text[i]) {
          i++;
          j++;
        } else if (match[j] === '%') {
          star = j++;
          retry = i;
        } else if (star >= 0) {
          j = star + 1;
          i = ++retry;
        } else return 0;
      }
      while (match[j] === '%') j++;
      return j === match.length ? 1 : 0;
    });
    const ast = parseSql({ query, functions });
    const constantBytes = bindAndValidate(ast, params);
    for (const table of extractTables(ast)) if (!Object.hasOwn(tables, table)) fail('unsupported');
    const plan = planSql({ query: ast, tables, functions });
    const payloads = new WeakMap<QueryPlan, number>();
    // Bound state before a blocking aggregate, sort, distinct, or join can allocate it.
    const cardinality = (node: QueryPlan): number => {
      check();
      let count: number;
      let payload = 0;
      switch (node.type) {
        case 'SingleRow':
          count = 1;
          break;
        case 'Scan':
          count = snapshots.get(node.table)?.length ?? fail('unsupported');
          payload = sourceBytes.get(node.table) ?? 0;
          break;
        case 'Count':
          count = 1;
          break;
        case 'Filter':
        case 'Project':
        case 'Sort':
        case 'Distinct':
        case 'Subquery':
          count = cardinality(node.child);
          break;
        case 'Limit':
          count = Math.min(cardinality(node.child), node.limit ?? limits.intermediateRows);
          break;
        case 'ScalarAggregate':
          cardinality(node.child);
          count = 1;
          break;
        case 'HashAggregate':
          count = cardinality(node.child);
          if (count > limits.groups || node.groupBy.length > 8) fail('budget');
          break;
        case 'HashJoin':
        case 'NestedLoopJoin': {
          const left = cardinality(node.left);
          const right = cardinality(node.right);
          // Conservative payload amplification bound also covers large repeated grouping/distinct keys.
          payload = (payloads.get(node.left) ?? 0) * right + (payloads.get(node.right) ?? 0) * left;
          // Upstream creates outer NULL cells from a first row, losing the schema of an empty side.
          // A valid empty result must not accidentally resolve an absent qualified column on the other side.
          if (
            (right === 0 && ['LEFT', 'FULL'].includes(node.joinType)) ||
            (left === 0 && ['RIGHT', 'FULL'].includes(node.joinType))
          )
            fail('unsupported');
          count = left * right;
          if (node.type === 'HashJoin') {
            const unique = (child: QueryPlan, keys: ExprNode[]): boolean => {
              if (child.type === 'Filter' || child.type === 'Subquery')
                return unique(child.child, keys);
              if (child.type !== 'Scan' || keys.some((k) => k.type !== 'identifier')) return false;
              const source = snapshots.get(child.table) ?? fail('unsupported');
              const seen = new Set<string>();
              for (const row of source) {
                check();
                const values = keys.map((k) => (k.type === 'identifier' ? row[k.name] : null));
                if (values.some((v) => v === undefined)) return false;
                // SQLite-like coercing equality must not make '1' and 1 look unique.
                const key = JSON.stringify(values.map((v) => (v === null ? null : String(v))));
                if (seen.has(key)) return false;
                seen.add(key);
              }
              return true;
            };
            if (unique(node.right, node.rightKeys)) count = left;
            else if (unique(node.left, node.leftKeys)) count = right;
          }
          if (node.joinType === 'LEFT' || node.joinType === 'FULL') count += left;
          if (node.joinType === 'RIGHT' || node.joinType === 'FULL') count += right;
          break;
        }
        case 'SetOperation':
          count = cardinality(node.left) + cardinality(node.right);
          payload = (payloads.get(node.left) ?? 0) + (payloads.get(node.right) ?? 0);
          break;
        default:
          return fail('unsupported');
      }
      if ('child' in node) {
        const terms =
          node.type === 'HashAggregate'
            ? node.groupBy.length
            : node.type === 'Sort'
              ? node.orderBy.length
              : 1;
        payload = (payloads.get(node.child) ?? 0) * Math.max(1, terms);
      }
      if (payload + constantBytes * Math.max(1, count) > limits.intermediateBytes) fail('budget');
      payloads.set(node, payload);
      if (count > limits.intermediateRows) fail('budget');
      return count;
    };
    cardinality(plan);
    check();
    const result = executeSql({ query: ast, tables, functions, signal: controller.signal });
    if (result.columns.length > 128 || new Set(result.columns).size !== result.columns.length)
      fail('unsupported');
    const rows: LogQueryRow[] = [];
    let outputBytes = bytes(result.columns);
    for await (const source of result.rows()) {
      check();
      if (rows.length >= limits.outputRows) fail('budget');
      const row: LogQueryRow = Object.create(null) as LogQueryRow;
      for (const name of result.columns) row[name] = scalar(await source.cells[name]());
      outputBytes += bytes(row);
      if (outputBytes > limits.outputBytes) fail('budget');
      rows.push(row);
    }
    check();
    return rows;
  } catch (error) {
    if (error instanceof LogQueryEngineError) throw error;
    if (controller.signal.aborted || options.signal?.aborted) return fail('budget');
    return fail('unsupported');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
