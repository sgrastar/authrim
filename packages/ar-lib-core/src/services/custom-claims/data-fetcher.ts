/**
 * User Custom Data Fetcher
 *
 * Fetches user custom field values from both PII and non-PII databases.
 * - Non-PII: user_custom_fields table (D1_CORE)
 * - PII: users_pii.custom_attributes_json (D1_PII)
 */

import type { D1Database } from '@cloudflare/workers-types';
import { createLogger } from '../../utils/logger';
import type { CustomClaimSchema } from './resolver';

const log = createLogger().module('CUSTOM-CLAIMS-DATA-FETCHER');

/** Maximum non-PII field keys per query (D1 bind parameter limit defense) */
const MAX_NON_PII_FIELDS = 200;

export class UserCustomDataFetcher {
  private db: D1Database;
  private dbPii: D1Database | null;

  constructor(db: D1Database, dbPii: D1Database | null) {
    this.db = db;
    this.dbPii = dbPii;
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
        const stmt = this.db.prepare(
          `SELECT field_name, field_value FROM user_custom_fields
           WHERE user_id = ? AND tenant_id = ? AND field_name IN (${placeholders})`
        );
        const rows = await stmt.bind(userId, tenantId, ...keysToFetch).all();
        for (const row of rows.results ?? []) {
          const r = row as { field_name: string; field_value: string | null };
          if (r.field_value !== null) {
            result.set(r.field_name, r.field_value);
          }
        }
      } catch (error) {
        log.error('Failed to fetch non-PII custom data', { tenantId, userId }, error as Error);
      }
    }

    // Fetch PII data
    if (piiKeys.length > 0 && this.dbPii) {
      try {
        const stmt = this.dbPii.prepare(
          `SELECT custom_attributes_json FROM users_pii WHERE id = ? AND tenant_id = ?`
        );
        const row = await stmt
          .bind(userId, tenantId)
          .first<{ custom_attributes_json: string | null }>();
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
