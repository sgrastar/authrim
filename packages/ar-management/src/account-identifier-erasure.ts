import {
  createAuditLog,
  requireDedicatedAdminDatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  hmacAccountIds,
  hmacScopedValues,
  RetiredValuesUnavailableError,
  retireStatement,
} from './identifier-retired-values';

/**
 * The identifier material kept for an account in the tenant's Admin database, erased with the
 * account: the identifiers imported from another identity provider (mapped_identifier_values)
 * the values imported into identifier sources (identifier_source_values) and the account's rows of
 * the lists of exceptions (mapped_identifier_exceptions; no value: salt names). All are bound to
 * the account's runtime ID (the user ID the Admin API shows as `id`), so a later account that
 * is given the same ID, or a person whose value changed hands, never inherits them.
 *
 * What was erased is not given to anyone else: each value is moved to a retired record (an HMAC
 * only, see identifier-retired-values.ts) in the same batch that deletes it, so a value freed by
 * the erasure cannot be imported for another account (which would make it the identifier the
 * erased account had).
 *
 * Run by a full deletion (the routed saga and the unrouted admin path) and by a PII-only
 * deletion: the values are personal data the account does not keep. Idempotent. A row written
 * by an import between the read and the delete is read again (up to a few rounds).
 */
const MAX_ROUNDS = 5;

export async function eraseAccountIdentifierValues(
  env: Env,
  input: { tenantId: string; userId: string }
): Promise<void> {
  const admin = requireDedicatedAdminDatabaseAdapter(env, 'account-identifier-erasure');
  const { tenantId, userId } = input;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stored = await admin.query<{
      store_name: string;
      audience: string;
      identifier: string;
    }>(
      `SELECT store_name, audience, identifier FROM mapped_identifier_values
        WHERE tenant_id = ? AND account_id = ?`,
      [tenantId, userId]
    );
    const sources = await admin.query<{ source_name: string; value: string }>(
      `SELECT source_name, value FROM identifier_source_values
        WHERE tenant_id = ? AND account_id = ?`,
      [tenantId, userId]
    );
    // The account's rows of the lists of exceptions (no value of the account's: names only).
    const exceptions = await admin.query<{ list_name: string; audience: string }>(
      `SELECT list_name, audience FROM mapped_identifier_exceptions
        WHERE tenant_id = ? AND account_id = ?`,
      [tenantId, userId]
    );
    if (stored.length === 0 && sources.length === 0 && exceptions.length === 0) return;
    const storedScopes = stored.map((row) => `${row.store_name}\n${row.audience}`);
    // What is retired is retired from this account (its HMAC): nobody else may take it, and the
    // account is gone. With the value key missing (a restore that brought the rows without the key
    // manager's state) nothing can be retired: the rows are still erased (a PII erasure is never
    // held up), no key is made in its place, and the audit log says retirement was skipped.
    let retire: Array<{ sql: string; params: unknown[] }> = [];
    try {
      const forErasure = { forErasure: true };
      const account = (await hmacAccountIds(env, admin, tenantId, [userId], forErasure)).hmacs[0];
      const storedMade = await hmacScopedValues(
        env,
        admin,
        tenantId,
        'stored',
        stored.map((row, index) => ({ scope: storedScopes[index], value: row.identifier })),
        forErasure
      );
      const sourceMade = await hmacScopedValues(
        env,
        admin,
        tenantId,
        'source',
        sources.map((row) => ({ scope: row.source_name, value: row.value })),
        forErasure
      );
      const now = Date.now();
      retire = [
        ...stored.map((_, index) =>
          retireStatement(
            tenantId,
            'stored',
            storedScopes[index],
            storedMade.hmacs[index],
            account,
            storedMade.keyId,
            now
          )
        ),
        ...sources.map((row, index) =>
          retireStatement(
            tenantId,
            'source',
            row.source_name,
            sourceMade.hmacs[index],
            account,
            sourceMade.keyId,
            now
          )
        ),
      ];
    } catch (error) {
      if (!(error instanceof RetiredValuesUnavailableError)) throw error;
      // Never held up by the audit log either.
      try {
        await createAuditLog(env, {
          tenantId,
          userId: 'system',
          action: 'identifier_values.retirement_skipped',
          resource: 'identifier_values',
          resourceId: userId,
          severity: 'warning',
          ipAddress: 'unknown',
          userAgent: 'unknown',
          metadata: JSON.stringify({
            reason: error.reason,
            stored_identifiers: stored.length,
            source_values: sources.length,
          }),
        });
      } catch {
        // The rows are erased all the same.
      }
    }
    const results = await admin.batch([
      ...retire,
      // Exactly the rows read above: one an import wrote since is found by the next round.
      ...stored.map((row) => ({
        sql: `DELETE FROM mapped_identifier_values
               WHERE tenant_id = ? AND account_id = ? AND store_name = ? AND audience = ?
                 AND identifier = ?`,
        params: [tenantId, userId, row.store_name, row.audience, row.identifier],
      })),
      ...sources.map((row) => ({
        sql: `DELETE FROM identifier_source_values
               WHERE tenant_id = ? AND account_id = ? AND source_name = ? AND value = ?`,
        params: [tenantId, userId, row.source_name, row.value],
      })),
      ...exceptions.map((row) => ({
        sql: `DELETE FROM mapped_identifier_exceptions
               WHERE tenant_id = ? AND account_id = ? AND list_name = ? AND audience = ?`,
        params: [tenantId, userId, row.list_name, row.audience],
      })),
    ]);
    if (results.some((result) => result.success === false)) {
      throw new Error('account_identifier_erasure_failed');
    }
  }
  throw new Error('account_identifier_erasure_incomplete');
}
