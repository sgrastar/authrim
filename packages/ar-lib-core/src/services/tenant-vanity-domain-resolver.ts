import { ensureDatabaseAdapter, type DatabaseSource } from '../db/adapter-source';
import type { Env } from '../types/env';
import { createLookupAliasIndex } from './lookup-directory/blind-index';
import { LookupRouteResolver } from './lookup-directory/resolver';
import { loadVerifiedLookupBucketAssignmentProvider } from './lookup-directory/shard-registry';
import { resolveTenantDatabaseSourceFromRegistry } from './tenant-database-resolver';
import { createLogger } from '../utils/logger';

const log = createLogger().module('TENANT-VANITY-DOMAINS');
const CACHE_TTL_SECONDS = 300;
const NEGATIVE_CACHE_TTL_SECONDS = 60;
const NO_PRIMARY_VANITY_DOMAIN = '__authrim_no_primary_vanity_domain__';

export interface TenantVanityDomain {
  id: string;
  tenant_id: string;
  hostname: string;
  is_active: boolean;
  is_primary: boolean;
  status: string;
  cloudflare_zone_id: string | null;
  cloudflare_custom_hostname_id: string | null;
  ssl_status: string | null;
  ownership_status: string | null;
  validation_method: string | null;
  validation_records_json: string | null;
  last_sync_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

interface TenantVanityDomainRow {
  id: string;
  tenant_id: string;
  hostname: string;
  is_active: number;
  is_primary: number;
  status: string;
  cloudflare_zone_id: string | null;
  cloudflare_custom_hostname_id: string | null;
  ssl_status: string | null;
  ownership_status: string | null;
  validation_method: string | null;
  validation_records_json: string | null;
  last_sync_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

function normalizeHostname(hostname: string | null | undefined): string | null {
  const value = hostname?.split(',')[0]?.split(':')[0]?.trim().toLowerCase();
  if (!value) return null;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value)
    ? value
    : null;
}

function mapRow(row: TenantVanityDomainRow): TenantVanityDomain {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    hostname: row.hostname,
    is_active: row.is_active === 1,
    is_primary: row.is_primary === 1,
    status: row.status,
    cloudflare_zone_id: row.cloudflare_zone_id,
    cloudflare_custom_hostname_id: row.cloudflare_custom_hostname_id,
    ssl_status: row.ssl_status,
    ownership_status: row.ownership_status,
    validation_method: row.validation_method,
    validation_records_json: row.validation_records_json,
    last_sync_at: row.last_sync_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isVanityDomainRow(row: unknown): row is TenantVanityDomainRow {
  if (!row || typeof row !== 'object') {
    return false;
  }

  const candidate = row as Partial<TenantVanityDomainRow>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.tenant_id === 'string' &&
    typeof candidate.hostname === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.is_active === 'number' &&
    typeof candidate.is_primary === 'number' &&
    typeof candidate.created_at === 'number' &&
    typeof candidate.updated_at === 'number'
  );
}

function isTenantVanityDomain(value: unknown): value is TenantVanityDomain {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<TenantVanityDomain>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.tenant_id === 'string' &&
    typeof candidate.hostname === 'string' &&
    typeof candidate.status === 'string' &&
    typeof candidate.is_active === 'boolean' &&
    typeof candidate.is_primary === 'boolean' &&
    typeof candidate.created_at === 'number' &&
    typeof candidate.updated_at === 'number'
  );
}

function isUsableVanityDomain(row: Pick<TenantVanityDomainRow, 'status' | 'is_active'>): boolean {
  return row.is_active === 1 && row.status === 'active';
}

export function tenantVanityDomainCacheKey(hostname: string): string {
  return `v1:tenant-vanity-domain:${hostname}`;
}

export function tenantPrimaryVanityDomainCacheKey(tenantId: string): string {
  return `v1:tenant-primary-vanity-domain:${tenantId}`;
}

export async function invalidateTenantVanityDomainCache(
  kv: KVNamespace | undefined,
  options: { hostname?: string | null; tenantId?: string | null }
): Promise<void> {
  await Promise.all([
    options.hostname
      ? kv?.delete(tenantVanityDomainCacheKey(options.hostname.toLowerCase())).catch(() => {})
      : Promise.resolve(),
    options.tenantId
      ? kv?.delete(tenantPrimaryVanityDomainCacheKey(options.tenantId)).catch(() => {})
      : Promise.resolve(),
  ]);
}

async function resolveTenantDefaultStore(env: Partial<Env>, tenantId: string) {
  if (
    !env.AUTHRIM_ENVIRONMENT_NAME ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
  ) {
    throw new Error('tenant_vanity_runtime_registry_unavailable');
  }
  return resolveTenantDatabaseSourceFromRegistry(env as Env, {
    tenantId,
    role: 'tenant_core',
    dataRole: 'tenant_core/default',
    shardGroup: 'default',
    shardIndex: 0,
  });
}

async function queryActiveVanityTenant(
  source: DatabaseSource,
  hostname: string,
  tenantId: string
): Promise<string | null> {
  const row = await ensureDatabaseAdapter(source, 'tenant-vanity-domain-resolver').queryOne<{
    tenant_id: string;
    status: string;
    is_active: number;
  }>(
    `SELECT tenant_vanity_domains.tenant_id, tenant_vanity_domains.status, tenant_vanity_domains.is_active
       FROM tenant_vanity_domains
       INNER JOIN tenants ON tenants.id = tenant_vanity_domains.tenant_id
       WHERE tenant_vanity_domains.active_hostname = ?
         AND tenant_vanity_domains.tenant_id = ?
         AND tenant_vanity_domains.is_active = 1
         AND tenant_vanity_domains.status = 'active'
         AND tenants.lifecycle_state = 'active'
       LIMIT 1`,
    [hostname, tenantId]
  );
  return row && isUsableVanityDomain(row) ? row.tenant_id : null;
}

export async function resolveTenantFromVanityHost(
  env: Partial<Env>,
  host: string | null | undefined
): Promise<string | null> {
  const hostname = normalizeHostname(host);
  if (!hostname) return null;

  const kv = env.AUTHRIM_CONFIG;
  const cacheKey = tenantVanityDomainCacheKey(hostname);
  if (kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) {
        const store = await resolveTenantDefaultStore(env, cached);
        if ((await queryActiveVanityTenant(store.source, hostname, cached)) === cached) {
          return cached;
        }
        await kv.delete(cacheKey).catch(() => {});
      }
    } catch {
      // KV is only a hint. Continue through the signed Lookup directory.
    }
  }

  try {
    if (
      !env.AUTHRIM_ENVIRONMENT_NAME ||
      !env.TENANT_RUNTIME_REGISTRY ||
      !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
    ) {
      throw new Error('tenant_vanity_lookup_unavailable');
    }
    const index = await createLookupAliasIndex('custom_domain', hostname);
    const assignments = await loadVerifiedLookupBucketAssignmentProvider({
      store: env.TENANT_RUNTIME_REGISTRY,
      environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
      publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
    });
    const alias = await new LookupRouteResolver(
      env as Record<string, unknown>,
      assignments
    ).resolveAlias({ index });
    if (!alias) return null;

    const store = await resolveTenantDefaultStore(env, alias.tenantId);
    const projection = alias.routeProjection;
    if (
      projection.tenantRouteGeneration > store.bindingRouteGeneration ||
      (projection.tenantRouteGeneration === store.bindingRouteGeneration &&
        (projection.residencyPolicyId !== store.residencyPolicyId ||
          projection.target.residencyPartition !== store.residencyPartition ||
          projection.target.shardId !== store.shardId ||
          projection.target.bindingRef !== store.bindingRef ||
          projection.target.requiredBindingRouteGeneration !== store.bindingRouteGeneration))
    ) {
      throw new Error('tenant_vanity_alias_route_revalidation_failed');
    }
    const tenantId = await queryActiveVanityTenant(store.source, hostname, alias.tenantId);
    if (tenantId !== alias.tenantId) {
      throw new Error('tenant_vanity_alias_destination_revalidation_failed');
    }
    await kv?.put(cacheKey, tenantId, { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {});
    return tenantId;
  } catch (error) {
    log.warn('Failed to resolve tenant from vanity host', { hostname, error: String(error) });
    return null;
  }
}

type TenantVanityLookupEnv = Partial<Env> & { tenantCoreDb?: DatabaseSource };

export async function getPrimaryTenantVanityDomain(
  env: TenantVanityLookupEnv,
  tenantId: string
): Promise<TenantVanityDomain | null> {
  const kv = env.AUTHRIM_CONFIG;
  const cacheKey = tenantPrimaryVanityDomainCacheKey(tenantId);

  if (kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached === NO_PRIMARY_VANITY_DOMAIN) {
        return null;
      }
      if (cached) {
        const parsed: unknown = JSON.parse(cached);
        if (isTenantVanityDomain(parsed)) {
          return parsed;
        }
        if (isVanityDomainRow(parsed)) {
          const mapped = mapRow(parsed);
          await kv
            .put(cacheKey, JSON.stringify(mapped), { expirationTtl: CACHE_TTL_SECONDS })
            .catch(() => {});
          return mapped;
        }
      }
    } catch {
      // Ignore cache errors and fall through to D1.
    }
  }

  try {
    const source = env.tenantCoreDb ?? (await resolveTenantDefaultStore(env, tenantId)).source;
    const adapter = ensureDatabaseAdapter(source, 'tenant-vanity-domain-resolver');
    const row = await adapter.queryOne<TenantVanityDomainRow>(
      `SELECT *
       FROM tenant_vanity_domains
       WHERE primary_active_tenant_key = ?
         AND is_active = 1
         AND status = 'active'
       LIMIT 1`,
      [tenantId]
    );

    if (!row) {
      await kv
        ?.put(cacheKey, NO_PRIMARY_VANITY_DOMAIN, {
          expirationTtl: NEGATIVE_CACHE_TTL_SECONDS,
        })
        .catch(() => {});
      return null;
    }
    if (!isVanityDomainRow(row)) return null;

    const mapped = mapRow(row);
    await kv
      ?.put(cacheKey, JSON.stringify(mapped), { expirationTtl: CACHE_TTL_SECONDS })
      .catch(() => {});
    return mapped;
  } catch (error) {
    log.warn('Failed to load primary tenant vanity domain', { tenantId, error: String(error) });
    return null;
  }
}

export async function buildCanonicalTenantIssuerUrl(
  env: TenantVanityLookupEnv,
  tenantId: string,
  fallback: string
): Promise<string> {
  const primary = await getPrimaryTenantVanityDomain(env, tenantId);
  return primary ? `https://${primary.hostname}` : fallback;
}
