import type { Context } from 'hono';
import { isValidPersistedUserId, type Env } from '@authrim/ar-lib-core';
import { CrossShardAccountExactSearchService } from './cross-shard-account-list';
import { eraseAccountIdentifierValues } from './account-identifier-erasure';

/**
 * What the CSV imports of identifier material share (stored identifiers, identifier sources): the
 * request body, the CSV reading, the checks every cell passes, and the check that an account
 * exists. Nothing imported is ever echoed back: a row is named by its line and column only.
 */

export type AdminImportContext = Context<{ Bindings: Env }>;

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 5000;
/** Row errors reported at most (the import is refused whole either way). */
const MAX_REPORTED_ROW_ERRORS = 100;
/** What the lookup of accounts takes at once (findAdminContacts). */
const ACCOUNT_LOOKUP_CHUNK = 500;

export const MAX_ACCOUNT_ID = 128;

export interface ImportRowError {
  /** The CSV line (the header is line 1). */
  row: number;
  column: string;
  code: string;
}

export const importInvalid = (
  c: AdminImportContext,
  description: string,
  rowErrors?: readonly ImportRowError[]
) =>
  c.json(
    {
      error: 'invalid_request',
      error_description: description,
      ...(rowErrors && rowErrors.length > 0
        ? {
            row_errors: rowErrors.slice(0, MAX_REPORTED_ROW_ERRORS),
            ...(rowErrors.length > MAX_REPORTED_ROW_ERRORS ? { row_errors_truncated: true } : {}),
          }
        : {}),
    },
    400
  );

/**
 * Why a cell is refused, or null: a control character (a line break inside a quoted field, a
 * NUL, an escape code) or whitespace at either end. The value must be what it looks like when it
 * is shown, compared and used as a key.
 */
export function cellProblem(value: string): 'control_characters' | 'surrounding_whitespace' | null {
  // C0 and C1 controls, and the Unicode line and paragraph separators.
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return 'control_characters';
    }
  }
  if (value !== value.trim()) return 'surrounding_whitespace';
  return null;
}

/** The import's JSON body: the CSV text and whether existing rows may be replaced. */
export async function readImportBody(
  c: AdminImportContext
): Promise<{ csv: string; replace: boolean } | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return importInvalid(c, 'Request body must be valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return importInvalid(c, 'Request body must be an object');
  }
  const { csv, replace } = body as Record<string, unknown>;
  if (typeof csv !== 'string' || csv.length === 0) return importInvalid(c, 'csv is required');
  if (new TextEncoder().encode(csv).length > MAX_CSV_BYTES) {
    return importInvalid(c, 'csv is too large');
  }
  if (replace !== undefined && typeof replace !== 'boolean') {
    return importInvalid(c, 'replace must be a boolean');
  }
  return { csv, replace: replace === true };
}

/**
 * The CSV's header and records, each with its line. A Response when the CSV cannot be read, has
 * another header, no rows or too many.
 */
export function readImportRecords(
  c: AdminImportContext,
  csv: string,
  header: string
): Array<{ line: number; fields: string[] }> | Response {
  const parsed = parseCsv(csv);
  if (!parsed) return importInvalid(c, 'csv is not valid');
  const lines = parsed.filter((row) => !(row.length === 1 && row[0] === ''));
  const [first, ...records] = lines;
  if (!first || first.join(',') !== header) {
    return importInvalid(c, `csv header must be ${header}`);
  }
  if (records.length === 0) return importInvalid(c, 'csv has no rows');
  if (records.length > MAX_ROWS) return importInvalid(c, `csv has more than ${MAX_ROWS} rows`);
  return records.map((fields, index) => ({ line: index + 2, fields }));
}

/**
 * The accounts among `accountIds` that exist in the tenant (a current, signed inventory: an
 * unknown account is absent, never guessed). Throws when the inventory cannot be read.
 */
export async function findExistingAccountIds(
  env: Env,
  tenantId: string,
  accountIds: readonly string[]
): Promise<Set<string>> {
  const unique = [...new Set(accountIds)].filter((id) => isValidPersistedUserId(id));
  const service = new CrossShardAccountExactSearchService(env);
  const existing = new Set<string>();
  for (let start = 0; start < unique.length; start += ACCOUNT_LOOKUP_CHUNK) {
    const found = await service.findAdminContacts({
      tenantId,
      userIds: unique.slice(start, start + ACCOUNT_LOOKUP_CHUNK),
    });
    for (const id of found.keys()) existing.add(id);
  }
  return existing;
}

/**
 * After an import has written its rows: the accounts among `accountIds` that no longer exist (one
 * deleted since the check made before the write) lose what the import gave them, which is retired
 * like any erasure, and are returned. The window that remains is the one between this check and a
 * deletion that begins after it: that deletion erases the rows itself (it runs after this read).
 */
export async function removeVanishedAccounts(
  env: Env,
  tenantId: string,
  accountIds: readonly string[]
): Promise<Set<string>> {
  const existing = await findExistingAccountIds(env, tenantId, accountIds);
  const gone = new Set<string>();
  for (const accountId of new Set(accountIds)) {
    if (existing.has(accountId)) continue;
    await eraseAccountIdentifierValues(env, { tenantId, userId: accountId });
    gone.add(accountId);
  }
  return gone;
}

/** The account cell's syntax; unknown accounts are told apart by `findExistingAccountIds`. */
export function accountCellProblem(account: string): string | null {
  if (!account) return 'required';
  if (account.length > MAX_ACCOUNT_ID) return 'too_long';
  if (!isValidPersistedUserId(account)) return 'invalid_account';
  return null;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Null when a quote is left open. */
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) return null;
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
