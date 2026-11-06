import type { DatabaseSource } from '../../db';
import { ensureDatabaseAdapter } from '../../db';
import {
  customAttributeSensitiveValueId,
  customAttributeValueKey,
  serializeCustomAttributeValue,
} from './pii-field-storage';

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
  const result = await piiAdapter.query<{ count: number | string }>(
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
  // PostgreSQL answers COUNT as text.
  return Number(result[0]?.count) || 0;
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
  const result = await adapter.query<{ count: number | string }>(
    'SELECT COUNT(DISTINCT user_id) as count FROM user_custom_fields WHERE tenant_id = ? AND field_name = ?',
    [tenantId, fieldKey]
  );
  // PostgreSQL answers COUNT as text.
  return Number(result[0]?.count) || 0;
}

/** Rows read per page while looking for held values (bounded statements, bounded memory). */
const HELD_PAGE = 500;

/**
 * The values users hold in a non-PII attribute that `allowed` does not contain, with how many
 * users hold each: at most `limit` values, or exactly the values in `only` (to count values found
 * elsewhere, such as in another store). A single value is stored as it is, several as a JSON
 * array (write-validator); a user has one row per attribute, so a value counts once per row. Reads
 * page by page and keeps one number per value, so memory stays bounded.
 */
export async function findHeldNonPiiValuesOutside(
  db: DatabaseSource,
  tenantId: string,
  fieldKey: string,
  allowed: readonly string[],
  cardinality: 'single' | 'multi',
  options: { limit?: number; only?: readonly string[] } = {}
): Promise<Map<string, number>> {
  const adapter = ensureDatabaseAdapter(db, 'custom-claims-storage-admin-core');
  const allowedSet = new Set(allowed);
  const only = options.only ? new Set(options.only) : null;
  const limit = only ? Number.POSITIVE_INFINITY : (options.limit ?? 20);
  const counts = new Map<string, number>();
  const take = (value: unknown, users: number) => {
    if (typeof value !== 'string' || value === '' || allowedSet.has(value)) return;
    if (only && !only.has(value)) return;
    if (!counts.has(value) && counts.size >= limit) return;
    counts.set(value, (counts.get(value) ?? 0) + users);
  };
  if (cardinality === 'single') {
    let after = '';
    for (;;) {
      const rows = await adapter.query<{ field_value: string | null; count: number | string }>(
        `SELECT field_value, COUNT(DISTINCT user_id) AS count
           FROM user_custom_fields
          WHERE tenant_id = ? AND field_name = ? AND field_value > ?
          GROUP BY field_value
          ORDER BY field_value
          LIMIT ${HELD_PAGE}`,
        [tenantId, fieldKey, after]
      );
      // PostgreSQL answers COUNT as text.
      for (const row of rows) take(row.field_value, Number(row.count) || 0);
      if (rows.length < HELD_PAGE || (!only && counts.size >= limit)) break;
      after = rows[rows.length - 1].field_value ?? '';
    }
    return counts;
  }
  let afterUser = '';
  for (;;) {
    const rows = await adapter.query<{ user_id: string; field_value: string | null }>(
      `SELECT user_id, field_value
         FROM user_custom_fields
        WHERE tenant_id = ? AND field_name = ? AND user_id > ?
        ORDER BY user_id
        LIMIT ${HELD_PAGE}`,
      [tenantId, fieldKey, afterUser]
    );
    for (const row of rows) {
      let held: unknown;
      try {
        held = JSON.parse(row.field_value ?? '');
      } catch {
        held = row.field_value;
      }
      for (const value of new Set(Array.isArray(held) ? held : [held])) take(value, 1);
    }
    if (rows.length < HELD_PAGE) break;
    afterUser = rows[rows.length - 1].user_id;
  }
  return counts;
}

export async function countUsersWithPiiFieldData(
  dbPii: DatabaseSource,
  tenantId: string,
  fieldKey: string
): Promise<number> {
  const piiAdapter = ensureDatabaseAdapter(dbPii, 'custom-claims-storage-admin-pii');
  const result = await piiAdapter.query<{ count: number | string }>(
    `SELECT COUNT(DISTINCT owner_id) as count
       FROM identity_sensitive_values
      WHERE tenant_id = ?
        AND owner_type = 'runtime_user'
        AND value_key = ?
        AND lifecycle_state = 'active'
        AND value_json IS NOT NULL`,
    [tenantId, customAttributeValueKey(fieldKey)]
  );
  // PostgreSQL answers COUNT as text.
  return Number(result[0]?.count) || 0;
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
          await piiAdapter.batch([
            {
              sql: `DELETE FROM identity_sensitive_values
                     WHERE tenant_id = ?
                       AND owner_type = 'runtime_user'
                       AND owner_id = ?
                       AND value_key = ?`,
              params: [tenantId, user.owner_id, customAttributeValueKey(fieldKey)],
            },
            {
              sql: `UPDATE identity_sensitive_values
                SET value_json = ?, updated_at = ?
              WHERE tenant_id = ?
                AND owner_type = 'runtime_user'
                AND owner_id = ?
                AND value_key = 'custom_attributes_json'`,
              params: [JSON.stringify(attrs), updatedAt, tenantId, user.owner_id],
            },
          ]);
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
          await piiAdapter.batch([
            {
              sql: `DELETE FROM identity_sensitive_values
                     WHERE tenant_id = ?
                       AND owner_type = 'runtime_user'
                       AND owner_id = ?
                       AND value_key = ?`,
              params: [tenantId, user.owner_id, customAttributeValueKey(oldKey)],
            },
            {
              sql: `INSERT INTO identity_sensitive_values (
                      id, tenant_id, owner_type, owner_id, value_key, value_json, value_hash,
                      classification, lifecycle_state, created_at, updated_at
                    ) VALUES (?, ?, 'runtime_user', ?, ?, ?, NULL, 'sensitive', 'active', ?, ?)
                    ON CONFLICT(tenant_id, owner_type, owner_id, value_key) DO UPDATE SET
                      value_json = excluded.value_json,
                      classification = excluded.classification,
                      lifecycle_state = excluded.lifecycle_state,
                      updated_at = excluded.updated_at`,
              params: [
                customAttributeSensitiveValueId(user.owner_id, newKey),
                tenantId,
                user.owner_id,
                customAttributeValueKey(newKey),
                serializeCustomAttributeValue(attrs[newKey]),
                updatedAt,
                updatedAt,
              ],
            },
            {
              sql: `UPDATE identity_sensitive_values
                SET value_json = ?, updated_at = ?
              WHERE tenant_id = ?
                AND owner_type = 'runtime_user'
                AND owner_id = ?
                AND value_key = 'custom_attributes_json'`,
              params: [JSON.stringify(attrs), updatedAt, tenantId, user.owner_id],
            },
          ]);
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
