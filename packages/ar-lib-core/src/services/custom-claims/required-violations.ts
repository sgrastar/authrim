import type { KVNamespace } from '@cloudflare/workers-types';
import type { DatabaseSource } from '../../db';
import { ensureDatabaseAdapter, ensureOptionalDatabaseAdapter } from '../../db';
import type { UserLifecycleState } from './user-lifecycle';
import { setUserLifecycleState } from './user-lifecycle';
import { SchemaLoader } from './schema-loader';
import type { MissingRequiredCustomClaim } from './write-validator';
import { collectMissingRequiredCustomClaims } from './write-validator';

const USER_BATCH_SIZE = 25;
const NON_PII_FIELD_BATCH_SIZE = 50;

export interface RequiredCustomClaimViolationStatus {
  userId: string;
  lifecycleState: UserLifecycleState;
  missingRequiredFields: MissingRequiredCustomClaim[];
}

export interface GetRequiredCustomClaimViolationStatusesParams {
  db: DatabaseSource;
  dbPii?: DatabaseSource | null;
  cache?: KVNamespace | null;
  tenantId: string;
  userIds: string[];
  syncLifecycleState?: boolean;
}

export interface GetRequiredCustomClaimViolationStatusesResult {
  requiredSchemaCount: number;
  users: RequiredCustomClaimViolationStatus[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function createUserValueMap(userIds: string[]): Map<string, Map<string, string>> {
  return new Map(userIds.map((userId) => [userId, new Map<string, string>()] as const));
}

export async function getRequiredCustomClaimViolationStatuses(
  params: GetRequiredCustomClaimViolationStatusesParams
): Promise<GetRequiredCustomClaimViolationStatusesResult> {
  const {
    db,
    dbPii = null,
    cache = null,
    tenantId,
    userIds,
    syncLifecycleState = false,
  } = params;
  const coreAdapter = ensureDatabaseAdapter(db, 'custom-claims-violations-core');
  const piiAdapter = ensureOptionalDatabaseAdapter(dbPii, 'custom-claims-violations-pii');

  if (userIds.length === 0) {
    return { requiredSchemaCount: 0, users: [] };
  }

  const schemas = await new SchemaLoader(db, cache).loadActiveSchemas(tenantId);
  const requiredSchemas = schemas.filter((schema) => schema.is_required === 1);

  if (requiredSchemas.length === 0) {
    const users = userIds.map((userId) => ({
      userId,
      lifecycleState: 'active' as const,
      missingRequiredFields: [],
    }));

    if (syncLifecycleState) {
      for (const user of users) {
        await setUserLifecycleState({
          db,
          tenantId,
          userId: user.userId,
          lifecycleState: user.lifecycleState,
        });
      }
    }

    return {
      requiredSchemaCount: 0,
      users,
    };
  }

  const nonPiiKeys = requiredSchemas
    .filter((schema) => schema.is_pii !== 1)
    .map((schema) => schema.field_key);
  const piiKeys = requiredSchemas.filter((schema) => schema.is_pii === 1).map((schema) => schema.field_key);
  const piiKeySet = new Set(piiKeys);
  const results: RequiredCustomClaimViolationStatus[] = [];

  for (const userIdBatch of chunk(userIds, USER_BATCH_SIZE)) {
    const userValueMap = createUserValueMap(userIdBatch);

    if (nonPiiKeys.length > 0) {
      const userPlaceholders = userIdBatch.map(() => '?').join(', ');

      for (const fieldKeyBatch of chunk(nonPiiKeys, NON_PII_FIELD_BATCH_SIZE)) {
        const keyPlaceholders = fieldKeyBatch.map(() => '?').join(', ');
        const rows = await coreAdapter.query<{
          user_id: string;
          field_name: string;
          field_value: string | null;
        }>(
          `SELECT user_id, field_name, field_value
           FROM user_custom_fields
           WHERE tenant_id = ? AND user_id IN (${userPlaceholders}) AND field_name IN (${keyPlaceholders})`,
          [tenantId, ...userIdBatch, ...fieldKeyBatch]
        );

        for (const row of rows) {
          if (!row.field_value) {
            continue;
          }
          userValueMap.get(row.user_id)?.set(row.field_name, row.field_value);
        }
      }
    }

    if (piiKeys.length > 0 && piiAdapter) {
      const userPlaceholders = userIdBatch.map(() => '?').join(', ');
      const rows = await piiAdapter.query<{
        id: string;
        custom_attributes_json: string | null;
      }>(
        `SELECT id, custom_attributes_json
         FROM users_pii
         WHERE tenant_id = ? AND id IN (${userPlaceholders})`,
        [tenantId, ...userIdBatch]
      );

      for (const row of rows) {
        if (!row.custom_attributes_json) {
          continue;
        }

        try {
          const parsed = JSON.parse(row.custom_attributes_json) as Record<string, unknown>;
          const userValues = userValueMap.get(row.id);
          if (!userValues) {
            continue;
          }

          for (const [key, value] of Object.entries(parsed)) {
            if (!piiKeySet.has(key) || value === null || value === undefined) {
              continue;
            }
            userValues.set(key, String(value));
          }
        } catch {
          // Ignore malformed custom_attributes_json. The user will be treated as missing those values.
        }
      }
    }

    for (const userId of userIdBatch) {
      const values = userValueMap.get(userId) ?? new Map<string, string>();
      const missingRequiredFields = collectMissingRequiredCustomClaims(requiredSchemas, values);
      const lifecycleState: UserLifecycleState =
        missingRequiredFields.length > 0 ? 'incomplete' : 'active';

      if (syncLifecycleState) {
        await setUserLifecycleState({
          db,
          tenantId,
          userId,
          lifecycleState,
        });
      }

      results.push({
        userId,
        lifecycleState,
        missingRequiredFields,
      });
    }
  }

  return {
    requiredSchemaCount: requiredSchemas.length,
    users: results,
  };
}
