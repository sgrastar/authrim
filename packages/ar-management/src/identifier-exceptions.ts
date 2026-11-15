import {
  createAuditLog,
  getTenantIdFromContext,
  readImportedIdentifierSalt,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import {
  accountCellProblem,
  cellProblem,
  findExistingAccountIds,
  importInvalid,
  MAX_ROWS,
  parseCsv,
  readImportBody,
  removeVanishedAccounts,
  type AdminImportContext as AdminContext,
  type ImportRowError,
} from './identifier-import';

/**
 * Exceptions to a persistent_identifier step (Shibboleth's exceptionMap): per account and
 * recipient, another imported salt for the identifier, or no identifier at all. A step reads a
 * list by name (`exceptions`). An import replaces the whole list, all rows or none.
 *
 * The CSV has a header `account,audience,action,salt`. `account` is the Authrim account's ID as the
 * Admin API shows it (it must exist in the tenant) or `*` for every account without an entry of
 * its own; `audience` is the recipient (the OIDC sector, or the SAML SP's entity ID) or `*`;
 * `action` is `salt` (then `salt` names an imported salt, which must exist) or `block` (then
 * `salt` is empty). The API never returns an account: the list shows names and counts.
 */

const LIST_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const MAX_AUDIENCE = 1024;
const ANY = '*';

function adapterOf(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'identifier-exceptions');
}

export async function adminIdentifierExceptionsListHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const rows = await adapterOf(c).query<{ list_name: string; count: number; updated_at: number }>(
    `SELECT list_name, COUNT(*) AS count, MAX(created_at) AS updated_at
       FROM mapped_identifier_exceptions
      WHERE tenant_id = ?
      GROUP BY list_name
      ORDER BY list_name`,
    [tenantId]
  );
  return c.json({
    lists: rows.map((row) => ({
      name: row.list_name,
      count: Number(row.count),
      updatedAt: Number(row.updated_at),
    })),
  });
}

const HEADER = 'account,audience,action,salt';

/**
 * The CSV's records, each with its line. Unlike the other imports, a header-only CSV is read: it
 * replaces the list with an empty one (the way to empty a list).
 */
function readExceptionRecords(
  c: AdminContext,
  csv: string
): Array<{ line: number; fields: string[] }> | Response {
  const parsed = parseCsv(csv);
  if (!parsed) return importInvalid(c, 'csv is not valid');
  const lines = parsed.filter((row) => !(row.length === 1 && row[0] === ''));
  const [first, ...records] = lines;
  if (!first || first.join(',') !== HEADER) {
    return importInvalid(c, `csv header must be ${HEADER}`);
  }
  if (records.length > MAX_ROWS) return importInvalid(c, `csv has more than ${MAX_ROWS} rows`);
  return records.map((fields, index) => ({ line: index + 2, fields }));
}

interface ExceptionRow {
  line: number;
  accountId: string;
  audience: string;
  action: 'salt' | 'block';
  salt: string | null;
}

/** POST `{ csv }`: the list is replaced by the rows. A row with an error refuses the import. */
export async function adminIdentifierExceptionsImportHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const list = c.req.param('name') ?? '';
  if (!LIST_NAME.test(list)) return importInvalid(c, 'name is invalid');
  const body = await readImportBody(c);
  if (body instanceof Response) return body;
  // First, rows of accounts deleted since an earlier import of the list (one whose re-check could
  // not be made) are removed, whatever this CSV holds. Nothing is written when that cannot be done.
  try {
    const stored = await adapterOf(c).query<{ account_id: string }>(
      `SELECT DISTINCT account_id FROM mapped_identifier_exceptions
        WHERE tenant_id = ? AND list_name = ? AND account_id <> ?`,
      [tenantId, list, ANY]
    );
    await removeVanishedAccounts(
      c.env,
      tenantId,
      stored.map((row) => row.account_id)
    );
  } catch {
    return c.json(
      {
        error: 'unavailable',
        error_description: 'The accounts of the list could not be checked; run the import again',
      },
      503
    );
  }
  const records = readExceptionRecords(c, body.csv);
  if (records instanceof Response) return records;

  const errors: ImportRowError[] = [];
  const rows: ExceptionRow[] = [];
  const seen = new Set<string>();
  for (const { line, fields } of records) {
    if (fields.length !== 4) {
      errors.push({ row: line, column: 'row', code: 'field_count' });
      continue;
    }
    const [accountId, audience, action, salt] = fields;
    const before = errors.length;
    const accountProblem =
      accountId === ANY ? null : (accountCellProblem(accountId) ?? cellProblem(accountId));
    if (accountProblem) errors.push({ row: line, column: 'account', code: accountProblem });
    const audienceProblem = !audience
      ? 'required'
      : audience.length > MAX_AUDIENCE
        ? 'too_long'
        : cellProblem(audience);
    if (audienceProblem) errors.push({ row: line, column: 'audience', code: audienceProblem });
    if (action !== 'salt' && action !== 'block') {
      errors.push({ row: line, column: 'action', code: 'invalid_action' });
    } else if (action === 'salt' ? !salt : salt !== '') {
      errors.push({
        row: line,
        column: 'salt',
        code: action === 'salt' ? 'required' : 'not_allowed',
      });
    } else if (action === 'salt' && !LIST_NAME.test(salt)) {
      errors.push({ row: line, column: 'salt', code: 'invalid_salt_name' });
    }
    if (errors.length > before) continue;
    // One entry for an account and a recipient.
    const key = `${accountId}\n${audience}`;
    if (seen.has(key)) {
      errors.push({ row: line, column: 'row', code: 'duplicate' });
      continue;
    }
    seen.add(key);
    rows.push({
      line,
      accountId,
      audience,
      action: action as 'salt' | 'block',
      salt: action === 'salt' ? salt : null,
    });
  }
  if (errors.length > 0) return importInvalid(c, 'csv has rows with errors', errors);

  // The accounts exist in the tenant, and the salts were imported (a salt removed later fails the
  // identifier at run time).
  const accountIds = rows.map((row) => row.accountId).filter((id) => id !== ANY);
  let existingAccounts: Set<string>;
  try {
    existingAccounts = await findExistingAccountIds(c.env, tenantId, accountIds);
  } catch {
    return c.json(
      { error: 'server_error', error_description: 'The accounts could not be checked' },
      500
    );
  }
  const saltNames = [...new Set(rows.flatMap((row) => (row.salt ? [row.salt] : [])))];
  const knownSalts = new Set<string>();
  try {
    for (const name of saltNames) {
      if (await readImportedIdentifierSalt(c.env.KEY_MANAGER, tenantId, name)) {
        knownSalts.add(name);
      }
    }
  } catch {
    return c.json(
      { error: 'server_error', error_description: 'The salts could not be checked' },
      500
    );
  }
  for (const row of rows) {
    if (row.accountId !== ANY && !existingAccounts.has(row.accountId)) {
      errors.push({ row: row.line, column: 'account', code: 'unknown_account' });
    }
    if (row.salt && !knownSalts.has(row.salt)) {
      errors.push({ row: row.line, column: 'salt', code: 'unknown_salt' });
    }
  }
  if (errors.length > 0) return importInvalid(c, 'csv has rows with errors', errors);

  const adapter = adapterOf(c);
  const now = Date.now();
  try {
    // Replaced whole, in one batch: a failure leaves the list as it was.
    await adapter.batch([
      {
        sql: 'DELETE FROM mapped_identifier_exceptions WHERE tenant_id = ? AND list_name = ?',
        params: [tenantId, list],
      },
      ...rows.map((row) => ({
        sql: `INSERT INTO mapped_identifier_exceptions
                (tenant_id, list_name, account_id, audience, action, salt_name, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [tenantId, list, row.accountId, row.audience, row.action, row.salt, now],
      })),
    ]);
  } catch {
    return c.json(
      { error: 'conflict', error_description: 'The list could not be replaced; retry' },
      409
    );
  }

  const admin = (c as unknown as { get(key: string): unknown }).get(
    'adminAuth'
  ) as AdminAuthContext | null;
  // Counts only: never an account or a salt. Written before the re-check below, which runs
  // whatever the audit does (a failure is raised after it).
  const auditFailure: { error?: unknown } = {};
  await createAuditLog(c.env, {
    tenantId,
    userId: admin?.userId ?? 'unknown',
    action: 'identifier_exceptions.imported',
    resource: 'identifier_exceptions',
    resourceId: list,
    severity: 'warning',
    ipAddress: c.req.header('CF-Connecting-IP') ?? 'unknown',
    userAgent: c.req.header('User-Agent') ?? 'unknown',
    metadata: JSON.stringify({
      rows: rows.length,
      salts: rows.filter((row) => row.action === 'salt').length,
      blocks: rows.filter((row) => row.action === 'block').length,
    }),
  }).catch((error: unknown) => {
    auditFailure.error = error;
  });

  // An account deleted since the check keeps no row of the list (the erasure removes its rows).
  let gone: Set<string>;
  try {
    gone = await removeVanishedAccounts(c.env, tenantId, accountIds);
  } catch {
    // The list stays as written: a row of a block must never be dropped (an identifier would be
    // made where none may be). A row of a deleted account is removed by the next import of the
    // list, which looks for them first.
    return c.json(
      {
        error: 'unavailable',
        error_description: 'The accounts could not be checked again; run the import again',
      },
      503
    );
  }
  if (auditFailure.error !== undefined) {
    throw auditFailure.error instanceof Error ? auditFailure.error : new Error('audit_log_failed');
  }
  if (gone.size > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description:
          'Some accounts were deleted during the import; the rows for them were removed',
        row_errors: rows
          .filter((row) => gone.has(row.accountId))
          .map((row) => ({ row: row.line, column: 'account', code: 'unknown_account' })),
      },
      400
    );
  }
  return c.json({
    list,
    rows: rows.length,
    salts: rows.filter((row) => row.action === 'salt').length,
    blocks: rows.filter((row) => row.action === 'block').length,
  });
}
