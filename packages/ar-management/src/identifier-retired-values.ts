import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

/**
 * Values that were given to an account and then replaced, or erased with the account, stay
 * reserved: handing one to another account would make that account the identifier the first one
 * had (the identifier is made from the value, or is the value). A retired value is kept only as
 * an HMAC under a key the tenant's key manager holds (`retired_identifier_values`), so erasing an
 * account leaves no personal data behind, and a stolen table cannot be guessed against.
 *
 * kind `stored`: scope `<store>\n<audience>`, value the identifier. kind `source`: scope the
 * source's name, value the imported value.
 */

export type RetiredKind = 'stored' | 'source';

export interface ScopedValue {
  scope: string;
  value: string;
}

interface KeyManagerHmacStub {
  identifierValueHmacsRpc(
    values: string[],
    options?: { create?: boolean }
  ): Promise<{ keyId: string; hmacs: string[] }>;
}

/** The key is missing, or is not the one the retired records were made with. Nothing is retired or checked. */
export class RetiredValuesUnavailableError extends Error {
  constructor(readonly reason: 'key_manager' | 'key_missing' | 'key_mismatch') {
    super(`retired_values_${reason}`);
    this.name = 'RetiredValuesUnavailableError';
  }
}

/** What a key manager call takes at once (its limit is 1000). */
const HMAC_CHUNK = 500;
/** D1 binds at most 100 parameters: 2 fixed, 2 per value, and the kind. */
const LOOKUP_CHUNK = 45;

/**
 * The HMACs of the values, in order, with the id of the key that made them.
 *
 * The key is made only for an import into a tenant that has nothing the key could have been made
 * for: no retired record and no current stored identifier or source value (`create`). Otherwise a
 * missing key is refused (never replaced by a fresh one that no retired record matches, as after a
 * restore of the records without the key manager's state), and so is a key whose id differs from
 * that of the retired records. An erasure (`forErasure`) never makes a key, and does not check the
 * id: with the key missing it throws RetiredValuesUnavailableError('key_missing') for the caller
 * to delete without retiring.
 */
export async function hmacScopedValues(
  env: Env,
  adapter: DatabaseAdapter,
  tenantId: string,
  kind: RetiredKind,
  values: readonly ScopedValue[],
  options: { forErasure?: boolean } = {}
): Promise<{ keyId: string; hmacs: string[] }> {
  if (options.forErasure && values.length === 0) return { keyId: '', hmacs: [] };
  if (!env.KEY_MANAGER) throw new RetiredValuesUnavailableError('key_manager');
  const stub = env.KEY_MANAGER.get(
    env.KEY_MANAGER.idFromName(`${tenantId}-v3`)
  ) as unknown as KeyManagerHmacStub;
  // An erasure never makes a key: a missing one must not be replaced by one no record matches.
  let create = false;
  if (options.forErasure !== true) {
    const used = await adapter.queryOne<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM retired_identifier_values WHERE tenant_id = ?)
            + (SELECT COUNT(*) FROM mapped_identifier_values WHERE tenant_id = ?)
            + (SELECT COUNT(*) FROM identifier_source_values WHERE tenant_id = ?) AS n`,
      [tenantId, tenantId, tenantId]
    );
    create = Number(used?.n ?? 0) === 0;
  }
  const hmacs: string[] = [];
  let keyId = '';
  const chunks = Math.max(1, Math.ceil(values.length / HMAC_CHUNK));
  for (let index = 0; index < chunks; index++) {
    const chunk = values.slice(index * HMAC_CHUNK, (index + 1) * HMAC_CHUNK);
    let result: { keyId: string; hmacs: string[] };
    try {
      // The kind and scope are part of what is signed: the same value in another scope differs.
      result = await stub.identifierValueHmacsRpc(
        chunk.map((item) => `${kind}\n${item.scope}\n${item.value}`),
        { create }
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'identifier_value_key_missing') {
        throw new RetiredValuesUnavailableError('key_missing');
      }
      throw error;
    }
    keyId = result.keyId;
    hmacs.push(...result.hmacs);
  }
  if (!options.forErasure) {
    const other = await adapter.queryOne<{ key_id: string }>(
      `SELECT key_id FROM retired_identifier_values WHERE tenant_id = ? AND key_id <> ? LIMIT 1`,
      [tenantId, keyId]
    );
    if (other) throw new RetiredValuesUnavailableError('key_mismatch');
  }
  return { keyId, hmacs };
}

/**
 * The HMACs of account IDs (the same key as the values'), in order, with the key's id. An account
 * is told apart in a retired record by this, never by its ID.
 */
export async function hmacAccountIds(
  env: Env,
  adapter: DatabaseAdapter,
  tenantId: string,
  accountIds: readonly string[],
  options: { forErasure?: boolean } = {}
): Promise<{ keyId: string; hmacs: string[] }> {
  return hmacScopedValues(
    env,
    adapter,
    tenantId,
    'stored',
    accountIds.map((id) => ({ scope: 'account', value: id })),
    options
  );
}

/** Records a value as retired from an account (a no-op when it already is). */
export function retireStatement(
  tenantId: string,
  kind: RetiredKind,
  scope: string,
  hmac: string,
  accountHmac: string,
  keyId: string,
  now: number
): { sql: string; params: unknown[] } {
  return {
    sql: `INSERT OR IGNORE INTO retired_identifier_values
            (tenant_id, kind, scope, value_hmac, account_hmac, key_id, retired_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [tenantId, kind, scope, hmac, accountHmac, keyId, now],
  };
}

const FAIL_COLUMNS = `(tenant_id, kind, scope, value_hmac, account_hmac, key_id, retired_at)
            SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL`;

/**
 * A guard for a batch: fails the whole batch (a NOT NULL violation, so every statement of it rolls
 * back) unless a row of `table` matching `where` is there. How a batch checks what it read is
 * still true when it writes.
 */
export function guardRowExists(
  table: string,
  where: string,
  params: unknown[]
): { sql: string; params: unknown[] } {
  return {
    sql: `INSERT INTO retired_identifier_values ${FAIL_COLUMNS}
           WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${where})`,
    params,
  };
}

/** The same, failing when a row of `table` matching `where` is there. */
export function guardRowAbsent(
  table: string,
  where: string,
  params: unknown[]
): { sql: string; params: unknown[] } {
  return {
    sql: `INSERT INTO retired_identifier_values ${FAIL_COLUMNS}
           WHERE EXISTS (SELECT 1 FROM ${table} WHERE ${where})`,
    params,
  };
}

/**
 * The retired records among `entries`, by `scope\nvalue_hmac`, each with the account HMACs it was
 * retired from. A value may be given to an account only when every record of it is that account's.
 */
export async function findRetired(
  adapter: DatabaseAdapter,
  tenantId: string,
  kind: RetiredKind,
  entries: ReadonlyArray<{ scope: string; hmac: string }>
): Promise<Map<string, Set<string>>> {
  const retired = new Map<string, Set<string>>();
  for (let start = 0; start < entries.length; start += LOOKUP_CHUNK) {
    const chunk = entries.slice(start, start + LOOKUP_CHUNK);
    const rows = await adapter.query<{
      scope: string;
      value_hmac: string;
      account_hmac: string;
    }>(
      `SELECT scope, value_hmac, account_hmac FROM retired_identifier_values
        WHERE tenant_id = ? AND kind = ?
          AND (${chunk.map(() => '(scope = ? AND value_hmac = ?)').join(' OR ')})`,
      [tenantId, kind, ...chunk.flatMap((entry) => [entry.scope, entry.hmac])]
    );
    for (const row of rows) {
      const key = `${row.scope}\n${row.value_hmac}`;
      const accounts = retired.get(key) ?? new Set<string>();
      accounts.add(row.account_hmac);
      retired.set(key, accounts);
    }
  }
  return retired;
}

/** Whether a retired value is refused to the account: some record of it is another account's. */
export function retiredAgainst(
  retired: ReadonlyMap<string, ReadonlySet<string>>,
  key: string,
  accountHmac: string
): boolean {
  const accounts = retired.get(key);
  if (!accounts) return false;
  return [...accounts].some((account) => account !== accountHmac);
}

/**
 * The answer when the retired records cannot be checked or kept: 503 when the key is missing or is
 * not the one they were made with (or no key manager is there), so an import is never run against
 * the wrong key; otherwise 500.
 */
export function retiredValuesFailure(
  c: { json(body: unknown, status: 500 | 503): Response },
  error: unknown
): Response {
  if (error instanceof RetiredValuesUnavailableError) {
    return c.json(
      {
        error: 'unavailable',
        error_description:
          error.reason === 'key_mismatch'
            ? 'The retired values were made with another key; the import is refused'
            : 'The key the retired values are made with is not available; the import is refused',
      },
      503
    );
  }
  return c.json(
    { error: 'server_error', error_description: 'The retired values could not be checked' },
    500
  );
}
