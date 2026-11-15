import {
  createAuditLog,
  getTenantIdFromContext,
  requireDedicatedAdminDatabaseAdapter,
  type AdminAuthContext,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import {
  findRetired,
  guardRowAbsent,
  guardRowExists,
  hmacAccountIds,
  hmacScopedValues,
  retiredAgainst,
  retireStatement,
  retiredValuesFailure,
} from './identifier-retired-values';
import {
  accountCellProblem,
  cellProblem,
  findExistingAccountIds,
  importInvalid,
  readImportBody,
  readImportRecords,
  removeVanishedAccounts,
  type AdminImportContext as AdminContext,
  type ImportRowError,
} from './identifier-import';

/**
 * Identifier sources: values an administrator imports for accounts (an employee number, a
 * student ID, an old user name) that a persistent_identifier step with `input: source` makes its
 * identifier from, instead of the account's own ID.
 *
 * Not a profile attribute: nothing a person, a sign-up, an upstream login, SCIM or a profile
 * update does can write one. Only this import does, so the value a step reads is the one the
 * administrator put there. The CSV has a header `account,value`: the Authrim account (the
 * account's ID as the Admin API shows it, which must exist in the tenant) and the value, plain
 * text (no type, no parsing). The API never returns a value: the list shows names and counts.
 */

const SOURCE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const MAX_VALUE = 512;
/** D1 binds at most 100 parameters: 2 fixed and 4 per row. */
const LOOKUP_CHUNK = 24;

function adapterOf(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'identifier-source-values');
}

export async function adminIdentifierSourcesListHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const rows = await adapterOf(c).query<{ source_name: string; count: number; updated_at: number }>(
    `SELECT source_name, COUNT(*) AS count, MAX(updated_at) AS updated_at
       FROM identifier_source_values
      WHERE tenant_id = ?
      GROUP BY source_name
      ORDER BY source_name`,
    [tenantId]
  );
  return c.json({
    sources: rows.map((row) => ({
      name: row.source_name,
      count: Number(row.count),
      updatedAt: Number(row.updated_at),
    })),
  });
}

interface ImportRow {
  line: number;
  accountId: string;
  value: string;
}

/**
 * POST `{ csv, replace? }`. All rows are written or none. A row the source already holds with the
 * same value is left as it is; an account that has another value gets it replaced only with
 * `replace`; a value another account holds (in the file or the source) refuses the import. An
 * account that does not exist in the tenant is a row error.
 */
export async function adminIdentifierSourceImportHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const source = c.req.param('name') ?? '';
  if (!SOURCE_NAME.test(source)) return importInvalid(c, 'name is invalid');
  const body = await readImportBody(c);
  if (body instanceof Response) return body;
  const records = readImportRecords(c, body.csv, 'account,value');
  if (records instanceof Response) return records;

  const errors: ImportRowError[] = [];
  const byAccount = new Map<string, ImportRow>();
  const ownerOf = new Map<string, string>();
  for (const { line, fields } of records) {
    if (fields.length !== 2) {
      errors.push({ row: line, column: 'row', code: 'field_count' });
      continue;
    }
    const [accountId, value] = fields;
    const accountProblem = accountCellProblem(accountId) ?? cellProblem(accountId);
    if (accountProblem) errors.push({ row: line, column: 'account', code: accountProblem });
    const valueProblem = !value
      ? 'required'
      : value.length > MAX_VALUE
        ? 'too_long'
        : cellProblem(value);
    if (valueProblem) errors.push({ row: line, column: 'value', code: valueProblem });
    if (accountProblem || valueProblem) continue;
    // One value per account, and no value for two accounts, in the file.
    const seen = byAccount.get(accountId);
    if (seen && seen.value !== value) {
      errors.push({ row: line, column: 'value', code: 'another_value_for_account' });
      continue;
    }
    const owner = ownerOf.get(value);
    if (owner && owner !== accountId) {
      errors.push({ row: line, column: 'value', code: 'value_of_another_account' });
      continue;
    }
    byAccount.set(accountId, { line, accountId, value });
    ownerOf.set(value, accountId);
  }
  if (errors.length > 0) return importInvalid(c, 'csv has rows with errors', errors);

  const rows = [...byAccount.values()];
  let existingAccounts: Set<string>;
  try {
    existingAccounts = await findExistingAccountIds(
      c.env,
      tenantId,
      rows.map((row) => row.accountId)
    );
  } catch {
    return c.json(
      { error: 'server_error', error_description: 'The accounts could not be checked' },
      500
    );
  }
  for (const { line, fields } of records) {
    if (!existingAccounts.has(fields[0])) {
      errors.push({ row: line, column: 'account', code: 'unknown_account' });
    }
  }
  if (errors.length > 0) return importInvalid(c, 'csv has rows with errors', errors);

  const adapter = adapterOf(c);
  const existing = new Map<string, string>();
  const takenBy = new Map<string, string>();
  for (let start = 0; start < rows.length; start += LOOKUP_CHUNK) {
    const chunk = rows.slice(start, start + LOOKUP_CHUNK);
    let found: Array<{ account_id: string; value: string }>;
    try {
      found = await adapter.query<{ account_id: string; value: string }>(
        `SELECT account_id, value FROM identifier_source_values
        WHERE tenant_id = ? AND source_name = ?
          AND (account_id IN (${chunk.map(() => '?').join(', ')})
            OR value IN (${chunk.map(() => '?').join(', ')}))`,
        [tenantId, source, ...chunk.map((row) => row.accountId), ...chunk.map((row) => row.value)]
      );
    } catch {
      return c.json(
        { error: 'server_error', error_description: 'The source could not be read' },
        500
      );
    }
    for (const row of found) {
      existing.set(row.account_id, row.value);
      takenBy.set(row.value, row.account_id);
    }
  }

  // A value that was given to an account and replaced, or erased with it, stays reserved: it is
  // not handed to another account (which would make that account the first one's identifier).
  const assigning = rows.filter((row) => existing.get(row.accountId) !== row.value);
  const newHmac = new Map<ImportRow, string>();
  const accountHmac = new Map<string, string>();
  let keyId = '';
  try {
    const made = await hmacScopedValues(
      c.env,
      adapter,
      tenantId,
      'source',
      assigning.map((row) => ({ scope: source, value: row.value }))
    );
    keyId = made.keyId;
    assigning.forEach((row, index) => newHmac.set(row, made.hmacs[index]));
    // Whose a retired value was is told by the HMAC of the account's ID.
    const accountIds = [...new Set(rows.map((row) => row.accountId))];
    const accounts = await hmacAccountIds(c.env, adapter, tenantId, accountIds);
    accountIds.forEach((id, index) => accountHmac.set(id, accounts.hmacs[index]));
    const retired = await findRetired(
      adapter,
      tenantId,
      'source',
      assigning.map((_, index) => ({ scope: source, hmac: made.hmacs[index] }))
    );
    assigning.forEach((row, index) => {
      if (
        retiredAgainst(
          retired,
          `${source}\n${made.hmacs[index]}`,
          accountHmac.get(row.accountId) ?? ''
        )
      ) {
        errors.push({ row: row.line, column: 'value', code: 'value_retired' });
      }
    });
  } catch (error) {
    return retiredValuesFailure(c, error);
  }
  if (errors.length > 0) return importInvalid(c, 'csv has rows with errors', errors);

  let created = 0;
  let replaced = 0;
  let unchanged = 0;
  let conflicts = 0;
  let foreign = 0;
  const now = Date.now();
  const written: Array<{ row: ImportRow; old: string | undefined }> = [];
  for (const row of rows) {
    const current = existing.get(row.accountId);
    const holder = takenBy.get(row.value);
    if (holder && holder !== row.accountId) {
      foreign++;
      continue;
    }
    if (current === row.value) {
      unchanged++;
      continue;
    }
    if (current !== undefined && !body.replace) {
      conflicts++;
      continue;
    }
    written.push({ row, old: current });
    if (current === undefined) created++;
    else replaced++;
  }
  if (foreign > 0 || conflicts > 0) {
    return c.json(
      {
        error: 'conflict',
        error_description:
          foreign > 0
            ? 'Some values already belong to other accounts in this source'
            : 'Some accounts already have another value in this source; import with replace to change them',
        conflicts,
        valuesOfOthers: foreign,
      },
      409
    );
  }
  if (written.length > 0) {
    // The batch checks at write time what it read: the value is not retired, the account still
    // holds the value being replaced (or none), and the replaced one is retired in the same batch.
    // Any check failing rolls the whole batch back: 409, retry.
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    try {
      const oldMade = await hmacScopedValues(
        c.env,
        adapter,
        tenantId,
        'source',
        written.flatMap(({ old }) => (old === undefined ? [] : [{ scope: source, value: old }]))
      );
      let oldIndex = 0;
      for (const { row, old } of written) {
        const holds = [tenantId, source, row.accountId];
        statements.push(
          guardRowAbsent(
            'retired_identifier_values',
            `tenant_id = ? AND kind = 'source' AND scope = ? AND value_hmac = ? AND account_hmac <> ?`,
            [tenantId, source, newHmac.get(row), accountHmac.get(row.accountId)]
          )
        );
        if (old === undefined) {
          statements.push(
            guardRowAbsent(
              'identifier_source_values',
              'tenant_id = ? AND source_name = ? AND account_id = ?',
              holds
            ),
            {
              sql: `INSERT INTO identifier_source_values
                      (tenant_id, source_name, account_id, value, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)`,
              params: [...holds, row.value, now, now],
            }
          );
        } else {
          statements.push(
            guardRowExists(
              'identifier_source_values',
              'tenant_id = ? AND source_name = ? AND account_id = ? AND value = ?',
              [...holds, old]
            ),
            retireStatement(
              tenantId,
              'source',
              source,
              oldMade.hmacs[oldIndex++],
              accountHmac.get(row.accountId) ?? '',
              keyId,
              now
            ),
            {
              sql: `UPDATE identifier_source_values SET value = ?, updated_at = ?
                     WHERE tenant_id = ? AND source_name = ? AND account_id = ? AND value = ?`,
              params: [row.value, now, ...holds, old],
            }
          );
        }
      }
    } catch (error) {
      return retiredValuesFailure(c, error);
    }
    try {
      await adapter.batch(statements);
    } catch {
      // A concurrent import took an account or a value, or changed what was read: nothing of this
      // one was written.
      return c.json(
        { error: 'conflict', error_description: 'The source changed during the import; retry' },
        409
      );
    }
    // An account deleted since the check before the write keeps nothing the import gave it. Done
    // before (and apart from) the audit log. When it cannot be done, the rows this import wrote
    // are taken back, so no value stays for an account that may be gone: re-run the import.
    let gone: Set<string>;
    try {
      gone = await removeVanishedAccounts(
        c.env,
        tenantId,
        written.map(({ row }) => row.accountId)
      );
    } catch {
      try {
        // Taken back and retired from the account (decided before the write, so no key manager
        // call is needed now): the values may have been issued, so nobody else may be given them,
        // while a re-run for the same accounts takes them again.
        await adapter.batch(
          written.flatMap(({ row }) => [
            retireStatement(
              tenantId,
              'source',
              source,
              newHmac.get(row) ?? '',
              accountHmac.get(row.accountId) ?? '',
              keyId,
              Date.now()
            ),
            {
              sql: `DELETE FROM identifier_source_values
                     WHERE tenant_id = ? AND source_name = ? AND account_id = ? AND value = ?`,
              params: [tenantId, source, row.accountId, row.value],
            },
          ])
        );
      } catch {
        // Reported the same: the import must be run again.
      }
      return c.json(
        {
          error: 'unavailable',
          error_description: 'The accounts could not be checked again; run the import again',
        },
        503
      );
    }
    const admin = (c as unknown as { get(key: string): unknown }).get(
      'adminAuth'
    ) as AdminAuthContext | null;
    // Counts only: never an account's value.
    await createAuditLog(c.env, {
      tenantId,
      userId: admin?.userId ?? 'unknown',
      action: 'identifier_source.imported',
      resource: 'identifier_source',
      resourceId: source,
      severity: 'warning',
      ipAddress: c.req.header('CF-Connecting-IP') ?? 'unknown',
      userAgent: c.req.header('User-Agent') ?? 'unknown',
      metadata: JSON.stringify({ created, replaced, unchanged }),
    });
    if (gone.size > 0) {
      return c.json(
        {
          error: 'invalid_request',
          error_description:
            'Some accounts were deleted during the import; the rows for them were removed',
          row_errors: records
            .filter(({ fields }) => gone.has(fields[0]))
            .map(({ line }) => ({ row: line, column: 'account', code: 'unknown_account' })),
          created,
          replaced,
          unchanged,
        },
        400
      );
    }
  }
  return c.json({ source, created, replaced, unchanged });
}
