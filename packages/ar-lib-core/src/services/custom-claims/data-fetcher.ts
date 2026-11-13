/**
 * User Custom Data Fetcher
 *
 * Fetches user custom field values from both PII and non-PII databases.
 * - Non-PII: user_custom_fields table (D1_CORE)
 * - PII: field-level identity_sensitive_values rows (D1_PII)
 */

import type { DatabaseAdapter, DatabaseSource } from '../../db';
import {
  chunkForBoundParameters,
  ensureDatabaseAdapter,
  ensureOptionalDatabaseAdapter,
  sqlPlaceholders,
} from '../../db';
import { createLogger } from '../../utils/logger';
import type { CustomClaimSchema } from './resolver';
import {
  customAttributeFieldKey,
  customAttributeValueKey,
  deserializeCustomAttributeValue,
} from './pii-field-storage';

const log = createLogger().module('CUSTOM-CLAIMS-DATA-FETCHER');

/** Maximum field keys fetched per kind (each query is chunked within D1's 100 parameters) */
const MAX_FIELDS_PER_QUERY = 200;

export class UserCustomDataFetcher {
  private coreAdapter: DatabaseAdapter;
  private piiAdapter: DatabaseAdapter | null;

  private strict: boolean;

  /**
   * `strict`: a value that cannot be read throws (for a caller that must not decide without it),
   * rather than being left out.
   */
  constructor(
    db: DatabaseSource,
    dbPii: DatabaseSource | null,
    options: { strict?: boolean } = {}
  ) {
    this.coreAdapter = ensureDatabaseAdapter(db, 'custom-claims-data-core');
    this.piiAdapter = ensureOptionalDatabaseAdapter(dbPii, 'custom-claims-data-pii');
    this.strict = options.strict === true;
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
    // A strict reader is not left with part of what it asked for.
    if (this.strict) {
      if (nonPiiKeys.length > MAX_FIELDS_PER_QUERY || piiKeys.length > MAX_FIELDS_PER_QUERY) {
        throw new Error('custom_data_too_many_fields');
      }
      if (piiKeys.length > 0 && !this.piiAdapter) throw new Error('custom_data_pii_unavailable');
    }

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
        const pages = await Promise.all(
          chunkForBoundParameters(keysToFetch, 2).map((chunk) =>
            this.coreAdapter.query<{
              field_name: string;
              field_value: string | null;
            }>(
              `SELECT field_name, field_value FROM user_custom_fields
               WHERE tenant_id = ? AND user_id = ? AND field_name IN (${sqlPlaceholders(chunk.length)})`,
              [tenantId, userId, ...chunk]
            )
          )
        );
        const rows = pages.flat();
        for (const row of rows) {
          if (row.field_value !== null) {
            result.set(row.field_name, row.field_value);
          }
        }
      } catch (error) {
        log.error('Failed to fetch non-PII custom data', { tenantId, userId }, error as Error);
        if (this.strict) throw error;
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
        const piiAdapter = this.piiAdapter;
        // PostgreSQL returns JSONB decoded: read it as the JSON text D1 stores, as the profile's
        // sensitive values are read.
        const valueColumn =
          piiAdapter.getType?.() === 'postgres' ? 'value_json::text AS value_json' : 'value_json';
        const pages = await Promise.all(
          chunkForBoundParameters(valueKeys, 2).map((chunk) =>
            piiAdapter.query<{
              value_key: string;
              value_json: unknown;
            }>(
              `SELECT value_key, ${valueColumn}
                 FROM identity_sensitive_values
                WHERE tenant_id = ?
                  AND owner_type = 'runtime_user'
                  AND owner_id = ?
                  AND value_key IN (${sqlPlaceholders(chunk.length)})
                  AND lifecycle_state = 'active'
                ORDER BY value_key ASC`,
              [tenantId, userId, ...chunk]
            )
          )
        );
        const rows = pages.flat();
        for (const row of rows) {
          const fieldKey = customAttributeFieldKey(row.value_key);
          const value = deserializeCustomAttributeValue(row.value_json);
          if (this.strict && fieldKey && value === null && row.value_json !== null) {
            throw new Error('custom_data_unreadable');
          }
          if (fieldKey && value !== null) result.set(fieldKey, value);
        }
      } catch (error) {
        log.error('Failed to fetch PII custom data', { tenantId }, error as Error);
        if (this.strict) throw error;
      }
    }

    return result;
  }
}
