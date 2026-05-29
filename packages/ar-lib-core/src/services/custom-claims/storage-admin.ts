import type { DatabaseSource } from '../../db';
import { ensureDatabaseAdapter } from '../../db';

const DEFAULT_PII_BATCH_SIZE = 500;

export interface NonPiiFieldUsageRow {
  fieldName: string;
  count: number;
}

export interface DeleteStoredCustomClaimDataParams {
  db: DatabaseSource;
  dbPii?: DatabaseSource | null;
  tenantId: string;
  fieldKey: string;
  isPii: boolean;
  updatedAt?: number;
  piiBatchSize?: number;
}

export interface RenameStoredCustomClaimDataParams {
  db: DatabaseSource;
  dbPii?: DatabaseSource | null;
  tenantId: string;
  oldKey: string;
  newKey: string;
  isPii: boolean;
  updatedAt?: number;
  piiBatchSize?: number;
}

export interface StoredCustomClaimMutationResult {
  affectedUsers: number;
  processedUsers: number;
  failedUsers: number;
}

export async function countUsersWithNonPiiCustomClaimData(
  db: DatabaseSource,
  tenantId: string
): Promise<number> {
  const adapter = ensureDatabaseAdapter(db, 'custom-claims-storage-admin-core');
  const result = await adapter.query<{ count: number }>(
    'SELECT COUNT(DISTINCT user_id) as count FROM user_custom_fields WHERE tenant_id = ?',
    [tenantId]
  );
  return result[0]?.count || 0;
}

export async function countUsersWithPiiCustomClaimData(
  dbPii: DatabaseSource,
  tenantId: string
): Promise<number> {
  const piiAdapter = ensureDatabaseAdapter(dbPii, 'custom-claims-storage-admin-pii');
  const result = await piiAdapter.query<{ count: number }>(
    `SELECT COUNT(*) as count
       FROM identity_sensitive_values
      WHERE tenant_id = ?
        AND owner_type = 'runtime_user'
        AND value_key = 'custom_attributes_json'
        AND lifecycle_state = 'active'
        AND value_json IS NOT NULL
        AND value_json != '{}'`,
    [tenantId]
  );
  return result[0]?.count || 0;
}

export async function listNonPiiFieldUsage(
  db: DatabaseSource,
  tenantId: string
): Promise<NonPiiFieldUsageRow[]> {
  const adapter = ensureDatabaseAdapter(db, 'custom-claims-storage-admin-core');
  const rows = await adapter.query<{ field_name: string; count: number }>(
    'SELECT field_name, COUNT(DISTINCT user_id) as count FROM user_custom_fields WHERE tenant_id = ? GROUP BY field_name',
    [tenantId]
  );

  return rows.map((row) => ({
    fieldName: row.field_name,
    count: row.count,
  }));
}

export async function countUsersWithNonPiiFieldData(
  db: DatabaseSource,
  tenantId: string,
  fieldKey: string
): Promise<number> {
  const adapter = ensureDatabaseAdapter(db, 'custom-claims-storage-admin-core');
  const result = await adapter.query<{ count: number }>(
    'SELECT COUNT(DISTINCT user_id) as count FROM user_custom_fields WHERE tenant_id = ? AND field_name = ?',
    [tenantId, fieldKey]
  );
  return result[0]?.count || 0;
}

export async function deleteStoredCustomClaimData(
  params: DeleteStoredCustomClaimDataParams
): Promise<StoredCustomClaimMutationResult> {
  const {
    db,
    dbPii = null,
    tenantId,
    fieldKey,
    isPii,
    updatedAt = Math.floor(Date.now() / 1000),
    piiBatchSize = DEFAULT_PII_BATCH_SIZE,
  } = params;

  if (!isPii) {
    const adapter = ensureDatabaseAdapter(db, 'custom-claims-storage-admin-core');
    const result = await adapter.execute(
      'DELETE FROM user_custom_fields WHERE tenant_id = ? AND field_name = ?',
      [tenantId, fieldKey]
    );
    return {
      affectedUsers: result.rowsAffected,
      processedUsers: result.rowsAffected,
      failedUsers: 0,
    };
  }

  if (!dbPii) {
    throw new Error('PII storage is not available');
  }

  const piiAdapter = ensureDatabaseAdapter(dbPii, 'custom-claims-storage-admin-pii');
  let affectedUsers = 0;
  let processedUsers = 0;
  let failedUsers = 0;
  let lastProcessedId = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await piiAdapter.query<{
      owner_id: string;
      value_json: string;
    }>(
      `SELECT owner_id, value_json
         FROM identity_sensitive_values
        WHERE tenant_id = ?
          AND owner_type = 'runtime_user'
          AND value_key = 'custom_attributes_json'
          AND lifecycle_state = 'active'
          AND value_json IS NOT NULL
          AND value_json != '{}'
          AND owner_id > ?
        ORDER BY owner_id
        LIMIT ?`,
      [tenantId, lastProcessedId, piiBatchSize]
    );

    if (batch.length === 0) {
      break;
    }

    for (const user of batch) {
      try {
        const attrs = JSON.parse(user.value_json) as Record<string, unknown>;
        if (fieldKey in attrs) {
          delete attrs[fieldKey];
          await piiAdapter.execute(
            `UPDATE identity_sensitive_values
                SET value_json = ?, updated_at = ?
              WHERE tenant_id = ?
                AND owner_type = 'runtime_user'
                AND owner_id = ?
                AND value_key = 'custom_attributes_json'`,
            [JSON.stringify(attrs), updatedAt, tenantId, user.owner_id]
          );
          affectedUsers++;
        }
      } catch {
        failedUsers++;
      }
    }

    processedUsers += batch.length;
    lastProcessedId = batch[batch.length - 1].owner_id;
    if (batch.length < piiBatchSize) {
      break;
    }
  }

  return {
    affectedUsers,
    processedUsers,
    failedUsers,
  };
}

export async function renameStoredCustomClaimData(
  params: RenameStoredCustomClaimDataParams
): Promise<StoredCustomClaimMutationResult> {
  const {
    db,
    dbPii = null,
    tenantId,
    oldKey,
    newKey,
    isPii,
    updatedAt = Math.floor(Date.now() / 1000),
    piiBatchSize = DEFAULT_PII_BATCH_SIZE,
  } = params;

  if (!isPii) {
    const adapter = ensureDatabaseAdapter(db, 'custom-claims-storage-admin-core');
    const result = await adapter.execute(
      'UPDATE user_custom_fields SET field_name = ? WHERE tenant_id = ? AND field_name = ?',
      [newKey, tenantId, oldKey]
    );
    return {
      affectedUsers: result.rowsAffected,
      processedUsers: result.rowsAffected,
      failedUsers: 0,
    };
  }

  if (!dbPii) {
    throw new Error('PII storage is not available');
  }

  const piiAdapter = ensureDatabaseAdapter(dbPii, 'custom-claims-storage-admin-pii');
  let affectedUsers = 0;
  let processedUsers = 0;
  let failedUsers = 0;
  let lastProcessedId = '';

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await piiAdapter.query<{
      owner_id: string;
      value_json: string;
    }>(
      `SELECT owner_id, value_json
         FROM identity_sensitive_values
        WHERE tenant_id = ?
          AND owner_type = 'runtime_user'
          AND value_key = 'custom_attributes_json'
          AND lifecycle_state = 'active'
          AND value_json IS NOT NULL
          AND value_json != '{}'
          AND owner_id > ?
        ORDER BY owner_id
        LIMIT ?`,
      [tenantId, lastProcessedId, piiBatchSize]
    );

    if (batch.length === 0) {
      break;
    }

    for (const user of batch) {
      try {
        const attrs = JSON.parse(user.value_json) as Record<string, unknown>;
        if (oldKey in attrs && !(newKey in attrs)) {
          attrs[newKey] = attrs[oldKey];
          delete attrs[oldKey];
          await piiAdapter.execute(
            `UPDATE identity_sensitive_values
                SET value_json = ?, updated_at = ?
              WHERE tenant_id = ?
                AND owner_type = 'runtime_user'
                AND owner_id = ?
                AND value_key = 'custom_attributes_json'`,
            [JSON.stringify(attrs), updatedAt, tenantId, user.owner_id]
          );
          affectedUsers++;
        }
      } catch {
        failedUsers++;
      }
    }

    processedUsers += batch.length;
    lastProcessedId = batch[batch.length - 1].owner_id;
    if (batch.length < piiBatchSize) {
      break;
    }
  }

  return {
    affectedUsers,
    processedUsers,
    failedUsers,
  };
}
