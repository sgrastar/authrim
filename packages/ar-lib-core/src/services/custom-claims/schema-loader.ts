/**
 * Schema Loader
 *
 * Loads active custom claim schemas with KV caching.
 * Falls back to D1 database when cache is unavailable or corrupted.
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { DatabaseAdapter, DatabaseSource } from '../../db';
import { ensureDatabaseAdapter } from '../../db';
import { createLogger } from '../../utils/logger';
import type { CustomClaimSchema } from './resolver';

const log = createLogger().module('CUSTOM-CLAIMS-SCHEMA-LOADER');

const DEFAULT_CACHE_TTL_SECONDS = 300; // 5 minutes
const CACHE_KEY_PREFIX = 'custom_claim_schemas:';

interface CachedSchemaData {
  schemas: CustomClaimSchema[];
  fetched_at: number;
  schema_version_max: number;
}

const BOOLEAN_SCHEMA_FIELDS = [
  'is_pii',
  'is_required',
  'is_active',
  'include_in_id_token',
  'include_in_userinfo',
  'include_in_introspection',
  'is_searchable',
  'is_exportable',
  'is_vc_claim',
] as const;

function normalizeSchemaFlags(schema: CustomClaimSchema): CustomClaimSchema {
  const normalized = { ...schema };
  for (const field of BOOLEAN_SCHEMA_FIELDS) {
    const value = normalized[field] as unknown;
    if (value === true) normalized[field] = 1;
    if (value === false) normalized[field] = 0;
  }
  return normalized;
}

export class SchemaLoader {
  private adapter: DatabaseAdapter;
  private cache: KVNamespace | null;
  private cacheTtl: number;

  constructor(db: DatabaseSource, cache: KVNamespace | null, cacheTtlSeconds?: number) {
    this.adapter = ensureDatabaseAdapter(db, 'custom-claims-schema');
    this.cache = cache;
    this.cacheTtl = cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  }

  async loadActiveSchemas(tenantId: string): Promise<CustomClaimSchema[]> {
    const cacheKey = `${CACHE_KEY_PREFIX}${tenantId}`;

    // Try KV cache first
    if (this.cache) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          const data: CachedSchemaData = JSON.parse(cached);
          if (data && Array.isArray(data.schemas)) {
            return data.schemas.map(normalizeSchemaFlags);
          }
          log.warn('Schema cache corrupted, falling back to DB', { tenantId });
        }
      } catch {
        log.warn('Schema cache corrupted, falling back to DB', { tenantId });
      }
    }

    // Load from DB
    const schemas = await this.loadFromDb(tenantId);

    // Update cache (including empty results to avoid repeated D1 queries)
    if (this.cache) {
      try {
        const maxVersion =
          schemas.length > 0 ? Math.max(...schemas.map((s) => s.schema_version ?? 1)) : 0;
        const cacheData: CachedSchemaData = {
          schemas,
          fetched_at: Date.now(),
          schema_version_max: maxVersion,
        };
        await this.cache.put(cacheKey, JSON.stringify(cacheData), {
          expirationTtl: this.cacheTtl,
        });
      } catch {
        // Cache write failure is non-critical
      }
    }

    return schemas;
  }

  async invalidateCache(tenantId: string): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.delete(`${CACHE_KEY_PREFIX}${tenantId}`);
    } catch {
      // Best-effort
    }
  }

  private async loadFromDb(tenantId: string): Promise<CustomClaimSchema[]> {
    const rows = await this.adapter.query<CustomClaimSchema>(
      `SELECT * FROM custom_claim_schemas
       WHERE tenant_id = ? AND is_active = TRUE AND operation_status = 'active'
       ORDER BY ui_group_order ASC, ui_field_order ASC, display_order ASC`,
      [tenantId]
    );
    return rows.map(normalizeSchemaFlags);
  }
}
