/**
 * User Custom Data Fetcher
 *
 * Fetches user custom field values from both PII and non-PII databases.
 * - Non-PII: user_custom_fields table (D1_CORE)
 * - PII: field-level identity_sensitive_values rows (D1_PII)
 */

import type { DatabaseAdapter, DatabaseSource } from '../../db';
import { ensureDatabaseAdapter, ensureOptionalDatabaseAdapter } from '../../db';
import { createLogger } from '../../utils/logger';
import type { CustomClaimSchema } from './resolver';
import {
  customAttributeFieldKey,
  customAttributeValueKey,
  deserializeCustomAttributeValue,
} from './pii-field-storage';

const log = createLogger().module('CUSTOM-CLAIMS-DATA-FETCHER');

/** Maximum field keys per query (D1 bind parameter limit defense) */
const MAX_FIELDS_PER_QUERY = 200;

export class UserCustomDataFetcher {
  private coreAdapter: DatabaseAdapter;
  private piiAdapter: DatabaseAdapter | null;

  constructor(db: DatabaseSource, dbPii: DatabaseSource | null) {
    this.coreAdapter = ensureDatabaseAdapter(db, 'custom-claims-data-core');
    this.piiAdapter = ensureOptionalDatabaseAdapter(dbPii, 'custom-claims-data-pii');
  }

  /**
   * Fetch user custom data for the given schemas.
   * Returns a Map of field_key -> raw string value.
   */
  async fetch(
    tenantId: string,
    userId: string,
    schemas: CustomClaimSchema[]
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();

    const nonPiiKeys = schemas.filter((s) => !s.is_pii).map((s) => s.field_key);
    const piiKeys = schemas.filter((s) => s.is_pii).map((s) => s.field_key);

    // Fetch non-PII data
    if (nonPiiKeys.length > 0) {
      const keysToFetch =
        nonPiiKeys.length > MAX_FIELDS_PER_QUERY
          ? (log.info('Non-PII field keys truncated', {
              total: nonPiiKeys.length,
              max: MAX_FIELDS_PER_QUERY,
              tenantId,
            }),
            nonPiiKeys.slice(0, MAX_FIELDS_PER_QUERY))
          : nonPiiKeys;

      try {
        const placeholders = keysToFetch.map(() => '?').join(', ');
        const rows = await this.coreAdapter.query<{
          field_name: string;
          field_value: string | null;
        }>(
          `SELECT field_name, field_value FROM user_custom_fields
           WHERE tenant_id = ? AND user_id = ? AND field_name IN (${placeholders})`,
          [tenantId, userId, ...keysToFetch]
        );
        for (const row of rows) {
          if (row.field_value !== null) {
            result.set(row.field_name, row.field_value);
          }
        }
      } catch (error) {
        log.error('Failed to fetch non-PII custom data', { tenantId, userId }, error as Error);
      }
    }

    // Fetch PII data
    if (piiKeys.length > 0 && this.piiAdapter) {
      const keysToFetch =
        piiKeys.length > MAX_FIELDS_PER_QUERY
          ? (log.info('PII field keys truncated', {
              total: piiKeys.length,
              max: MAX_FIELDS_PER_QUERY,
              tenantId,
            }),
            piiKeys.slice(0, MAX_FIELDS_PER_QUERY))
          : piiKeys;
      try {
        const valueKeys = keysToFetch.map(customAttributeValueKey);
        const placeholders = valueKeys.map(() => '?').join(', ');
        const rows = await this.piiAdapter.query<{
          value_key: string;
          value_json: unknown;
        }>(
          `SELECT value_key, value_json
             FROM identity_sensitive_values
            WHERE tenant_id = ?
              AND owner_type = 'runtime_user'
              AND owner_id = ?
              AND value_key IN (${placeholders})
              AND lifecycle_state = 'active'
            ORDER BY value_key ASC`,
          [tenantId, userId, ...valueKeys]
        );
        for (const row of rows) {
          const fieldKey = customAttributeFieldKey(row.value_key);
          const value = deserializeCustomAttributeValue(row.value_json);
          if (fieldKey && value !== null) result.set(fieldKey, value);
        }
      } catch (error) {
        log.error('Failed to fetch PII custom data', { tenantId }, error as Error);
      }
    }

    return result;
  }
}
