/**
 * Custom Claim Schema Resolver (Orchestrator)
 *
 * Resolves custom claims for a given target (id_token, userinfo, introspection, vc)
 * by orchestrating: SchemaLoader, ClaimScopeEvaluator, UserCustomDataFetcher,
 * ClaimValueCaster, and ClaimNameResolver.
 *
 * Design: Thin orchestrator (~100 lines) delegating to focused components.
 * Graceful degradation: errors return empty claims, never block the caller.
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { DatabaseSource } from '../../db';
import { createLogger } from '../../utils/logger';
import { SchemaLoader } from './schema-loader';
import { ClaimScopeEvaluator } from './scope-evaluator';
import { UserCustomDataFetcher } from './data-fetcher';
import { ClaimValueCaster } from './value-caster';
import { ClaimNameResolver } from './name-resolver';

const log = createLogger().module('CUSTOM-CLAIMS-RESOLVER');

// =============================================================================
// Types
// =============================================================================

export type ClaimTarget = 'id_token' | 'userinfo' | 'introspection' | 'vc';

export interface CustomClaimSchema {
  id: string;
  tenant_id: string;
  field_key: string;
  display_label: string;
  field_type: string;
  is_pii: number;
  is_required: number;
  is_active: number;
  validation_rules: string | null;
  include_in_id_token: number;
  include_in_userinfo: number;
  include_in_introspection: number;
  required_scopes: string | null;
  scope_mode: string;
  is_searchable: number;
  is_exportable: number;
  is_vc_claim: number;
  claim_namespace: string | null;
  description: string | null;
  display_order: number;
  schema_version: number;
  operation_status: string;
  operation_detail: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ResolvedCustomClaims {
  claims: Record<string, unknown>;
  schemas_evaluated: number;
  schemas_matched: number;
  pii_accessed: boolean;
  truncated: boolean;
}

export interface CustomClaimsFeatureConfig {
  enabled: boolean;
  introspectionEnabled: boolean;
  maxClaimsPerTarget: number;
}

// =============================================================================
// Feature Config
// =============================================================================

const DEFAULT_MAX_CLAIMS_PER_TARGET = 50;
const FEATURE_CONFIG_CACHE_KEY = 'custom_claims:feature_config';

export async function loadFeatureConfig(
  cache: KVNamespace | null
): Promise<CustomClaimsFeatureConfig> {
  const config: CustomClaimsFeatureConfig = {
    enabled: false,
    introspectionEnabled: false,
    maxClaimsPerTarget: DEFAULT_MAX_CLAIMS_PER_TARGET,
  };

  if (!cache) return config;

  try {
    const [enabled, introspection, maxClaims] = await Promise.all([
      cache.get('policy:flags:ENABLE_CUSTOM_CLAIMS'),
      cache.get('policy:flags:ENABLE_CUSTOM_CLAIMS_INTROSPECTION'),
      cache.get('policy:flags:CUSTOM_CLAIMS_MAX_PER_TOKEN'),
    ]);

    config.enabled = enabled?.toLowerCase() === 'true' || enabled === '1';
    config.introspectionEnabled = introspection?.toLowerCase() === 'true' || introspection === '1';
    if (maxClaims) {
      const n = parseInt(maxClaims, 10);
      if (Number.isFinite(n) && n > 0) {
        config.maxClaimsPerTarget = n;
      }
    }
  } catch {
    // KV read failure: return defaults (disabled)
  }

  return config;
}

// =============================================================================
// Target filter helpers
// =============================================================================

const TARGET_FILTERS: Record<ClaimTarget, (s: CustomClaimSchema) => boolean> = {
  id_token: (s) => s.include_in_id_token === 1,
  userinfo: (s) => s.include_in_userinfo === 1,
  introspection: (s) => s.include_in_introspection === 1,
  vc: (s) => s.is_vc_claim === 1,
};

// =============================================================================
// Resolver
// =============================================================================

export class CustomClaimSchemaResolver {
  private schemaLoader: SchemaLoader;
  private scopeEvaluator: ClaimScopeEvaluator;
  private dataFetcher: UserCustomDataFetcher;
  private valueCaster: ClaimValueCaster;
  private nameResolver: ClaimNameResolver;
  private maxClaimsPerTarget: number;

  constructor(deps: {
    schemaLoader: SchemaLoader;
    scopeEvaluator: ClaimScopeEvaluator;
    dataFetcher: UserCustomDataFetcher;
    valueCaster: ClaimValueCaster;
    nameResolver: ClaimNameResolver;
    maxClaimsPerTarget?: number;
  }) {
    this.schemaLoader = deps.schemaLoader;
    this.scopeEvaluator = deps.scopeEvaluator;
    this.dataFetcher = deps.dataFetcher;
    this.valueCaster = deps.valueCaster;
    this.nameResolver = deps.nameResolver;
    this.maxClaimsPerTarget = deps.maxClaimsPerTarget ?? DEFAULT_MAX_CLAIMS_PER_TARGET;
  }

  async resolveClaimsForTarget(
    tenantId: string,
    userId: string,
    grantedScopes: string[],
    target: ClaimTarget
  ): Promise<ResolvedCustomClaims> {
    const empty: ResolvedCustomClaims = {
      claims: {},
      schemas_evaluated: 0,
      schemas_matched: 0,
      pii_accessed: false,
      truncated: false,
    };

    try {
      return await this._resolve(tenantId, userId, grantedScopes, target);
    } catch (error) {
      log.error('Failed to resolve custom claims', { tenantId, target }, error as Error);
      return empty;
    }
  }

  private async _resolve(
    tenantId: string,
    userId: string,
    grantedScopes: string[],
    target: ClaimTarget
  ): Promise<ResolvedCustomClaims> {
    const result: ResolvedCustomClaims = {
      claims: {},
      schemas_evaluated: 0,
      schemas_matched: 0,
      pii_accessed: false,
      truncated: false,
    };

    // 1. Load schemas
    const allSchemas = await this.schemaLoader.loadActiveSchemas(tenantId);
    result.schemas_evaluated = allSchemas.length;

    // 2. Filter by target flag
    const targetFilter = TARGET_FILTERS[target];
    let matched = allSchemas.filter(targetFilter);

    // 3. Filter by scope
    matched = matched.filter((s) => this.scopeEvaluator.shouldInclude(s, grantedScopes, target));
    result.schemas_matched = matched.length;

    if (matched.length === 0) return result;

    // 4. Apply max claims limit (display_order ASC already from SQL)
    if (matched.length > this.maxClaimsPerTarget) {
      log.info('Custom claims truncated', {
        target,
        total: matched.length,
        max: this.maxClaimsPerTarget,
        tenantId,
      });
      matched = matched.slice(0, this.maxClaimsPerTarget);
      result.truncated = true;
    }

    // 5. Check if PII access needed
    result.pii_accessed = matched.some((s) => s.is_pii === 1);

    // 6. Fetch user data
    const userData = await this.dataFetcher.fetch(tenantId, userId, matched);

    // 7. Build claims
    for (const schema of matched) {
      const claimName = this.nameResolver.resolve(schema);

      // Standard claim collision check
      if (this.nameResolver.isStandardClaimCollision(claimName)) {
        log.info('Custom claim skipped due to collision', { claimName, tenantId });
        continue;
      }

      const rawValue = userData.get(schema.field_key);
      const castResult = this.valueCaster.cast(rawValue, schema.field_type);

      if (!castResult.valid) {
        if (rawValue !== undefined) {
          log.info('Custom claim dropped: invalid cast', {
            fieldKey: schema.field_key,
            fieldType: schema.field_type,
            tenantId,
          });
        }
        continue;
      }

      result.claims[claimName] = castResult.value;
    }

    return result;
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createCustomClaimSchemaResolver(
  db: DatabaseSource,
  dbPii: DatabaseSource | null,
  cache: KVNamespace | null,
  featureConfig?: CustomClaimsFeatureConfig
): CustomClaimSchemaResolver {
  return new CustomClaimSchemaResolver({
    schemaLoader: new SchemaLoader(db, cache),
    scopeEvaluator: new ClaimScopeEvaluator(),
    dataFetcher: new UserCustomDataFetcher(db, dbPii),
    valueCaster: new ClaimValueCaster(),
    nameResolver: new ClaimNameResolver(),
    maxClaimsPerTarget: featureConfig?.maxClaimsPerTarget,
  });
}
