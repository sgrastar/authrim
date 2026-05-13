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
const INSERT_USER_CUSTOM_FIELD_SQL =
  'INSERT INTO user_custom_fields (tenant_id, user_id, field_name, field_value, field_type) VALUES (?, ?, ?, ?, ?)';

/**
 * Portable write path for user_custom_fields.
 *
 * We intentionally avoid dialect-specific UPSERT syntax here so the custom-claims
 * slice can run unchanged across D1/SQLite, PostgreSQL, and MySQL adapters.
 * The table's canonical key is `(tenant_id, user_id, field_name)`, so duplicated
 * user IDs across tenants do not collide.
 */
export async function upsertUserCustomFieldValue(
  params: UpsertUserCustomFieldValueParams
): Promise<void> {
  const { adapter, userId, tenantId, fieldName, fieldValue, fieldType } = params;

  const updateParams = [fieldValue, fieldType, tenantId, userId, fieldName];
  const updateResult = await adapter.execute(UPDATE_USER_CUSTOM_FIELD_SQL, updateParams);

  if (updateResult.rowsAffected > 0) {
    return;
  }

  try {
    await adapter.execute(INSERT_USER_CUSTOM_FIELD_SQL, [
      tenantId,
      userId,
      fieldName,
      fieldValue,
      fieldType,
    ]);
  } catch (error) {
    const retryUpdateResult = await adapter.execute(UPDATE_USER_CUSTOM_FIELD_SQL, updateParams);
    if (retryUpdateResult.rowsAffected > 0) {
      return;
    }

    throw error;
  }
}
