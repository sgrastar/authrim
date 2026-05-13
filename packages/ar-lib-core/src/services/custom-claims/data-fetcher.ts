/**
 * User Custom Data Fetcher
 *
 * Fetches user custom field values from both PII and non-PII databases.
 * - Non-PII: user_custom_fields table (D1_CORE)
 * - PII: users_pii.custom_attributes_json (D1_PII)
 */

import type { DatabaseAdapter, DatabaseSource } from '../../db';
import { ensureDatabaseAdapter, ensureOptionalDatabaseAdapter } from '../../db';
import { createLogger } from '../../utils/logger';
import type { CustomClaimSchema } from './resolver';

const log = createLogger().module('CUSTOM-CLAIMS-DATA-FETCHER');

/** Maximum non-PII field keys per query (D1 bind parameter limit defense) */
const MAX_NON_PII_FIELDS = 200;

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
        nonPiiKeys.length > MAX_NON_PII_FIELDS
          ? (log.info('Non-PII field keys truncated', {
              total: nonPiiKeys.length,
              max: MAX_NON_PII_FIELDS,
              tenantId,
            }),
            nonPiiKeys.slice(0, MAX_NON_PII_FIELDS))
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
      try {
        const row = await this.piiAdapter.queryOne<{ custom_attributes_json: string | null }>(
          'SELECT custom_attributes_json FROM users_pii WHERE id = ? AND tenant_id = ?',
          [userId, tenantId]
        );
        if (row?.custom_attributes_json) {
          const attrs = JSON.parse(row.custom_attributes_json) as Record<string, unknown>;
          const piiKeySet = new Set(piiKeys);
          for (const [key, value] of Object.entries(attrs)) {
            if (piiKeySet.has(key) && value !== null && value !== undefined) {
              result.set(key, String(value));
            }
          }
        }
      } catch (error) {
        log.error('Failed to fetch PII custom data', { tenantId }, error as Error);
      }
    }

    return result;
  }
}
