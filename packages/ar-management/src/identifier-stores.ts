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
 * Identifiers people already have at another identity provider, imported so a
 * persistent_identifier step with `stored` (prefer or require) releases them unchanged: the
 * IdPs whose identifiers cannot be made again from a salt (Shibboleth stored IDs, a cloud IdP).
 *
 * The CSV has a header `audience,account,identifier`: who it was issued to (the SP entity ID,
 * the OIDC client ID or sector host, as the step resolves it), the Authrim account it belongs to
 * (the account's ID as the Admin API shows it, which must exist in the tenant), and the
 * identifier before protocol framing (no scope, no NameQualifiers). Rows are bound to the account,
 * never to a value the person controls. Nothing imported is echoed back.
 */

const STORE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const MAX_AUDIENCE = 2048;
const MAX_IDENTIFIER = 512;
/** D1 binds at most 100 parameters: 2 fixed and 4 per row. */
const LOOKUP_CHUNK = 24;

function adapterOf(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'mapped-identifier-store');
}

export async function adminIdentifierStoresListHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const rows = await adapterOf(c).query<{ store_name: string; count: number; updated_at: number }>(
    `SELECT store_name, COUNT(*) AS count, MAX(updated_at) AS updated_at
       FROM mapped_identifier_values
      WHERE tenant_id = ?
      GROUP BY store_name
      ORDER BY store_name`,
    [tenantId]
  );
  return c.json({
    stores: rows.map((row) => ({
      name: row.store_name,
      count: Number(row.count),
      updatedAt: Number(row.updated_at),
    })),
  });
}

interface ImportRow {
  line: number;
  audience: string;
  accountId: string;
  identifier: string;
}

const scopeOf = (store: string, audience: string) => `${store}\n${audience}`;

/**
 * POST `{ csv, replace? }`. All rows are written or none. A row the store already holds with the
 * same identifier is left as it is; one with another identifier is replaced only with `replace`;
 * an identifier that already belongs to another account (in the file or the store, for the same
 * audience) refuses the import. An account that does not exist in the tenant is a row error.
 */
export async function adminIdentifierStoreImportHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const store = c.req.param('name') ?? '';
  if (!STORE_NAME.test(store)) return importInvalid(c, 'name is invalid');
  const body = await readImportBody(c);
  if (body instanceof Response) return body;
  const records = readImportRecords(c, body.csv, 'audience,account,identifier');
  if (records instanceof Response) return records;

  const errors: ImportRowError[] = [];
  const byKey = new Map<string, ImportRow>();
  const ownerOf = new Map<string, string>();
  for (const { line, fields } of records) {
    if (fields.length !== 3) {
      errors.push({ row: line, column: 'row', code: 'field_count' });
      continue;
    }
    const [audience, accountId, identifier] = fields;
    const before = errors.length;
    const cell = (column: string, value: string, problem: string | null) => {
      const code = problem ?? cellProblem(value);
      if (code) errors.push({ row: line, column, code });
    };
    cell(
      'audience',
      audience,
      !audience ? 'required' : audience.length > MAX_AUDIENCE ? 'too_long' : null
    );
    cell('account', accountId, accountCellProblem(accountId));
    cell(
      'identifier',
      identifier,
      !identifier
        ? 'required'
        : identifier.length > MAX_IDENTIFIER
          ? 'too_long'
          : /\s/u.test(identifier)
            ? 'whitespace'
            : null
    );
    if (errors.length > before) continue;
    // One identifier per account and audience, and no identifier for two accounts, in the file.
    const key = `${audience}\n${accountId}`;
    const seen = byKey.get(key);
    if (seen && seen.identifier !== identifier) {
      errors.push({ row: line, column: 'identifier', code: 'another_identifier_for_account' });
      continue;
    }
    const owner = ownerOf.get(`${audience}\n${identifier}`);
    if (owner && owner !== accountId) {
      errors.push({ row: line, column: 'identifier', code: 'identifier_of_another_account' });
      continue;
    }
    byKey.set(key, { line, audience, accountId, identifier });
    ownerOf.set(`${audience}\n${identifier}`, accountId);
  }
  if (errors.length > 0) return importInvalid(c, 'csv has rows with errors', errors);

  const rows = [...byKey.values()];
  // The account must exist in this tenant: a row for an unknown account is refused.
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
    if (!existingAccounts.has(fields[1])) {
      errors.push({ row: line, column: 'account', code: 'unknown_account' });
    }
  }
  if (errors.length > 0) return importInvalid(c, 'csv has rows with errors', errors);

  const adapter = adapterOf(c);
  const existing = new Map<string, string>();
  const takenBy = new Map<string, string>();
  for (let start = 0; start < rows.length; start += LOOKUP_CHUNK) {
    const chunk = rows.slice(start, start + LOOKUP_CHUNK);
    let found: Array<{ audience: string; account_id: string; identifier: string }>;
    try {
      found = await adapter.query<{
        audience: string;
        account_id: string;
        identifier: string;
      }>(
        `SELECT audience, account_id, identifier FROM mapped_identifier_values
        WHERE tenant_id = ? AND store_name = ?
          AND ((${chunk.map(() => '(audience = ? AND account_id = ?)').join(' OR ')})
            OR (${chunk.map(() => '(audience = ? AND identifier = ?)').join(' OR ')}))`,
        [
          tenantId,
          store,
          ...chunk.flatMap((row) => [row.audience, row.accountId]),
          ...chunk.flatMap((row) => [row.audience, row.identifier]),
        ]
      );
    } catch {
      return c.json(
        { error: 'server_error', error_description: 'The store could not be read' },
        500
      );
    }
    for (const row of found) {
      existing.set(`${row.audience}\n${row.account_id}`, row.identifier);
      takenBy.set(`${row.audience}\n${row.identifier}`, row.account_id);
    }
  }

  // An identifier that was given to an account and replaced, or erased with it, stays reserved:
  // it is not handed to another account (which would make that account the first one's identifier).
  const assigning = rows.filter(
    (row) => existing.get(`${row.audience}\n${row.accountId}`) !== row.identifier
  );
  const newHmac = new Map<ImportRow, string>();
  const accountHmac = new Map<string, string>();
  let keyId = '';
  try {
    const made = await hmacScopedValues(
      c.env,
      adapter,
      tenantId,
      'stored',
      assigning.map((row) => ({ scope: scopeOf(store, row.audience), value: row.identifier }))
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
      'stored',
      assigning.map((row, index) => ({
        scope: scopeOf(store, row.audience),
        hmac: made.hmacs[index],
      }))
    );
    assigning.forEach((row, index) => {
      if (
        retiredAgainst(
          retired,
          `${scopeOf(store, row.audience)}\n${made.hmacs[index]}`,
          accountHmac.get(row.accountId) ?? ''
        )
      ) {
        errors.push({ row: row.line, column: 'identifier', code: 'value_retired' });
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
    const current = existing.get(`${row.audience}\n${row.accountId}`);
    const holder = takenBy.get(`${row.audience}\n${row.identifier}`);
    if (holder && holder !== row.accountId) {
      foreign++;
      continue;
    }
    if (current === row.identifier) {
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
            ? 'Some identifiers already belong to other accounts in this store'
            : 'Some accounts already have another identifier in this store; import with replace to change them',
        conflicts,
        identifiersOfOthers: foreign,
      },
      409
    );
  }
  if (written.length > 0) {
    // The batch checks at write time what it read: the identifier is not retired, the account
    // still holds the identifier being replaced (or none), and the replaced one is retired in the
    // same batch. Any check failing rolls the whole batch back: 409, retry.
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    try {
      const oldMade = await hmacScopedValues(
        c.env,
        adapter,
        tenantId,
        'stored',
        written.flatMap(({ row, old }) =>
          old === undefined ? [] : [{ scope: scopeOf(store, row.audience), value: old }]
        )
      );
      let oldIndex = 0;
      for (const { row, old } of written) {
        const scope = scopeOf(store, row.audience);
        const holds = [tenantId, store, row.audience, row.accountId];
        statements.push(
          guardRowAbsent(
            'retired_identifier_values',
            `tenant_id = ? AND kind = 'stored' AND scope = ? AND value_hmac = ? AND account_hmac <> ?`,
            [tenantId, scope, newHmac.get(row), accountHmac.get(row.accountId)]
          )
        );
        if (old === undefined) {
          statements.push(
            guardRowAbsent(
              'mapped_identifier_values',
              'tenant_id = ? AND store_name = ? AND audience = ? AND account_id = ?',
              holds
            ),
            {
              sql: `INSERT INTO mapped_identifier_values
                      (tenant_id, store_name, audience, account_id, identifier, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
              params: [...holds, row.identifier, now, now],
            }
          );
        } else {
          statements.push(
            guardRowExists(
              'mapped_identifier_values',
              'tenant_id = ? AND store_name = ? AND audience = ? AND account_id = ? AND identifier = ?',
              [...holds, old]
            ),
            retireStatement(
              tenantId,
              'stored',
              scope,
              oldMade.hmacs[oldIndex++],
              accountHmac.get(row.accountId) ?? '',
              keyId,
              now
            ),
            {
              sql: `UPDATE mapped_identifier_values SET identifier = ?, updated_at = ?
                     WHERE tenant_id = ? AND store_name = ? AND audience = ? AND account_id = ?
                       AND identifier = ?`,
              params: [row.identifier, now, ...holds, old],
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
      // A concurrent import took a key or an identifier, or changed what was read: nothing of
      // this one was written.
      return c.json(
        { error: 'conflict', error_description: 'The store changed during the import; retry' },
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
              'stored',
              scopeOf(store, row.audience),
              newHmac.get(row) ?? '',
              accountHmac.get(row.accountId) ?? '',
              keyId,
              Date.now()
            ),
            {
              sql: `DELETE FROM mapped_identifier_values
                     WHERE tenant_id = ? AND store_name = ? AND audience = ? AND account_id = ?
                       AND identifier = ?`,
              params: [tenantId, store, row.audience, row.accountId, row.identifier],
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
    await createAuditLog(c.env, {
      tenantId,
      userId: admin?.userId ?? 'unknown',
      action: 'identifier_store.imported',
      resource: 'identifier_store',
      resourceId: store,
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
            .filter(({ fields }) => gone.has(fields[1]))
            .map(({ line }) => ({ row: line, column: 'account', code: 'unknown_account' })),
          created,
          replaced,
          unchanged,
        },
        400
      );
    }
  }
  return c.json({ store, created, replaced, unchanged });
}
