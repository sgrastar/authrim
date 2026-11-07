import type { DatabaseAdapter } from '../../db';

export interface UpsertUserCustomFieldValueParams {
  adapter: DatabaseAdapter;
  userId: string;
  tenantId: string;
  fieldName: string;
  fieldValue: string;
  fieldType: string;
}

const UPDATE_USER_CUSTOM_FIELD_SQL =
  'UPDATE user_custom_fields SET field_value = ?, field_type = ? WHERE tenant_id = ? AND user_id = ? AND field_name = ?';

/** The account of the attribute, when it is being deleted (or deleted). */
const REMOVED_ACCOUNT_SQL = `SELECT 1 FROM identity_accounts removed
  WHERE removed.tenant_id = ? AND removed.legacy_user_id = ?
    AND removed.lifecycle_state IN ('deleting', 'deleted')`;
/** The update, refused (no row) for an account being deleted. */
const GUARDED_UPDATE_USER_CUSTOM_FIELD_SQL = `${UPDATE_USER_CUSTOM_FIELD_SQL}
  AND NOT EXISTS (${REMOVED_ACCOUNT_SQL})`;
/** The insert, refused (no row) for an account being deleted. */
const GUARDED_INSERT_USER_CUSTOM_FIELD_SQL = `INSERT INTO user_custom_fields
  (tenant_id, user_id, field_name, field_value, field_type)
  SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (${REMOVED_ACCOUNT_SQL})`;

/** Raised instead of writing a custom attribute of an account being deleted, or deleted. */
export class CustomFieldAccountRemovedError extends Error {
  constructor() {
    super('custom_field_account_removed');
    this.name = 'CustomFieldAccountRemovedError';
  }
}

type Writer = Pick<DatabaseAdapter, 'execute' | 'queryOne'>;

async function accountRemoved(writer: Writer, tenantId: string, userId: string) {
  const account = await writer.queryOne<{ lifecycle_state?: string | null }>(
    'SELECT lifecycle_state FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?',
    [tenantId, userId]
  );
  return account?.lifecycle_state === 'deleting' || account?.lifecycle_state === 'deleted';
}

/**
 * Portable write path for user_custom_fields.
 *
 * We intentionally avoid dialect-specific UPSERT syntax here so the custom-claims
 * slice can run unchanged across D1/SQLite, PostgreSQL, and MySQL adapters.
 * The table's canonical key is `(tenant_id, user_id, field_name)`, so duplicated
 * user IDs across tenants do not collide.
 *
 * An account being deleted (or deleted) gets no attribute again (a concurrent update that read
 * the user before the deletion): the deletion removes its rows, and a write that comes after
 * would bring them back (CustomFieldAccountRemovedError). On D1 each statement carries the check
 * (D1 runs one statement at a time). On PostgreSQL the account row is locked for the write first,
 * so a deletion that moves the account to `deleting` waits for it, and one already moved is seen.
 */
export async function upsertUserCustomFieldValue(
  params: UpsertUserCustomFieldValueParams
): Promise<void> {
  const { adapter, userId, tenantId } = params;
  if (adapter.getType?.() === 'postgres') {
    await adapter.transaction(async (tx) => {
      const account = await tx.queryOne<{ lifecycle_state: string }>(
        `SELECT lifecycle_state FROM identity_accounts
          WHERE tenant_id = ? AND legacy_user_id = ? FOR SHARE`,
        [tenantId, userId]
      );
      if (account?.lifecycle_state === 'deleting' || account?.lifecycle_state === 'deleted') {
        throw new CustomFieldAccountRemovedError();
      }
      // One statement: a duplicate key would leave the transaction failed (no retry inside it).
      await tx.execute(
        `INSERT INTO user_custom_fields (tenant_id, user_id, field_name, field_value, field_type)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, user_id, field_name)
         DO UPDATE SET field_value = EXCLUDED.field_value, field_type = EXCLUDED.field_type`,
        [tenantId, userId, params.fieldName, params.fieldValue, params.fieldType]
      );
    });
    return;
  }
  await writeUserCustomFieldValue(adapter, params);
}

async function writeUserCustomFieldValue(
  writer: Writer,
  params: UpsertUserCustomFieldValueParams
): Promise<void> {
  const { userId, tenantId, fieldName, fieldValue, fieldType } = params;
  const removedParams = [tenantId, userId];
  const updateSql = GUARDED_UPDATE_USER_CUSTOM_FIELD_SQL;
  const updateParams = [fieldValue, fieldType, tenantId, userId, fieldName, ...removedParams];
  const updateResult = await writer.execute(updateSql, updateParams);

  if (updateResult.rowsAffected > 0) {
    return;
  }

  try {
    const inserted = await writer.execute(GUARDED_INSERT_USER_CUSTOM_FIELD_SQL, [
      tenantId,
      userId,
      fieldName,
      fieldValue,
      fieldType,
      ...removedParams,
    ]);
    // The guarded insert writes nothing for an account being deleted.
    if (inserted.rowsAffected === 0 && (await accountRemoved(writer, tenantId, userId))) {
      throw new CustomFieldAccountRemovedError();
    }
  } catch (error) {
    if (error instanceof CustomFieldAccountRemovedError) throw error;
    const retryUpdateResult = await writer.execute(updateSql, updateParams);
    if (retryUpdateResult.rowsAffected > 0) {
      return;
    }

    throw error;
  }
}
