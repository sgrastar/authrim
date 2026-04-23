import type { DatabaseAdapter } from '../../db';

export interface UpsertUserCustomFieldValueParams {
  adapter: DatabaseAdapter;
  userId: string;
  tenantId: string;
  fieldName: string;
  fieldValue: string;
  fieldType: string;
}

const SELECT_EXISTING_USER_CUSTOM_FIELD_SQL =
  'SELECT user_id FROM user_custom_fields WHERE user_id = ? AND field_name = ?';
const UPDATE_USER_CUSTOM_FIELD_SQL =
  'UPDATE user_custom_fields SET field_value = ?, field_type = ?, tenant_id = ? WHERE user_id = ? AND field_name = ?';
const INSERT_USER_CUSTOM_FIELD_SQL =
  'INSERT INTO user_custom_fields (user_id, field_name, field_value, field_type, tenant_id) VALUES (?, ?, ?, ?, ?)';

/**
 * Portable write path for user_custom_fields.
 *
 * We intentionally avoid dialect-specific UPSERT syntax here so the custom-claims
 * slice can run unchanged across D1/SQLite, PostgreSQL, and MySQL adapters.
 * The table's canonical key is `(user_id, field_name)`, so existence checks and
 * updates follow that key and then rewrite `tenant_id` as part of the mutation.
 */
export async function upsertUserCustomFieldValue(
  params: UpsertUserCustomFieldValueParams
): Promise<void> {
  const { adapter, userId, tenantId, fieldName, fieldValue, fieldType } = params;

  const existing = await adapter.queryOne<{ user_id: string }>(SELECT_EXISTING_USER_CUSTOM_FIELD_SQL, [
    userId,
    fieldName,
  ]);

  if (existing) {
    await adapter.execute(UPDATE_USER_CUSTOM_FIELD_SQL, [
      fieldValue,
      fieldType,
      tenantId,
      userId,
      fieldName,
    ]);
    return;
  }

  try {
    await adapter.execute(INSERT_USER_CUSTOM_FIELD_SQL, [
      userId,
      fieldName,
      fieldValue,
      fieldType,
      tenantId,
    ]);
  } catch (error) {
    const existingAfterInsertFailure = await adapter.queryOne<{ user_id: string }>(
      SELECT_EXISTING_USER_CUSTOM_FIELD_SQL,
      [userId, fieldName]
    );

    if (!existingAfterInsertFailure) {
      throw error;
    }

    await adapter.execute(UPDATE_USER_CUSTOM_FIELD_SQL, [
      fieldValue,
      fieldType,
      tenantId,
      userId,
      fieldName,
    ]);
  }
}
