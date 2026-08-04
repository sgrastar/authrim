import type { Context } from 'hono';
import { z } from 'zod';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  ADMIN_PERMISSIONS,
  AR_ERROR_CODES,
  createAuditLogFromContext,
  createLookupAliasIndex,
  createErrorResponse,
  ensureDatabaseAdapter,
  getLogger,
  getTenantIdFromContext,
  hasAdminPermission,
  invalidateTenantVanityDomainCache,
  loadVerifiedLookupBucketAssignmentProvider,
  LookupRouteResolver,
  resolveOptionalCoreAdapterFromHono,
  readResponseTextWithLimit,
  resolveTenantDatabaseSourceFromRegistry,
  safeFetch,
  type DatabaseSource,
} from '@authrim/ar-lib-core';
import {
  disableTenantDiscoveryAliasDirectory,
  ensureActiveTenantDiscoveryAliasDirectory,
  prepareTenantDiscoveryAliasDirectory,
  resolveTenantDiscoveryAliasDirectoryInput,
  type TenantDiscoveryAliasDirectoryInput,
} from './tenant-alias-directory';

const HOSTNAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_PLATFORM_TENANTS = 64;
const PLATFORM_FANOUT_CONCURRENCY = 4;

type DomainStatus = 'pending' | 'pending_manual' | 'active' | 'failed' | 'deleted';

interface TenantVanityDomainRow {
  id: string;
  tenant_id: string;
  hostname: string;
  is_active: number;
  is_primary: number;
  status: DomainStatus;
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

interface CloudflareCustomHostname {
  id: string;
  hostname: string;
  status?: string;
  ownership_verification?: unknown;
  ownership_verification_http?: unknown;
  ssl?: {
    status?: string;
    method?: string;
    validation_records?: unknown;
  };
}

interface CloudflareResponse<T> {
  success: boolean;
  errors?: Array<{ message?: string }>;
  result: T;
}

const CreateSchema = z.object({
  hostname: z.string().min(1).max(MAX_HOSTNAME_LENGTH),
  tenant_id: z.string().min(1).max(63).optional(),
  is_primary: z.boolean().optional().default(true),
  cloudflare_zone_id: z.string().min(1).optional(),
});

const UpdateSchema = z.object({
  is_active: z.boolean().optional(),
});

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

function validateHostname(hostname: string): string | null {
  if (!hostname) return 'hostname is required';
  if (hostname.length > MAX_HOSTNAME_LENGTH) return 'hostname is too long';
  if (!HOSTNAME_REGEX.test(hostname)) return 'hostname must be a valid ASCII DNS hostname';
  return null;
}

function getAdminAuth(c: Context<{ Bindings: Env }>): AdminAuthContext | null {
  return (c as unknown as { get(name: 'adminAuth'): AdminAuthContext | null }).get('adminAuth');
}

function isSystemAdmin(auth: AdminAuthContext | null): boolean {
  return !!auth?.roles?.some((role) => role === 'system_admin' || role === 'super_admin');
}

function hasPermission(c: Context<{ Bindings: Env }>, permission: string): boolean {
  const auth = getAdminAuth(c);
  return isSystemAdmin(auth) || hasAdminPermission(auth?.permissions ?? [], permission);
}

function permissionDenied(c: Context<{ Bindings: Env }>) {
  return createErrorResponse(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS);
}

function getCoreAdapter(c: Context<{ Bindings: Env }>) {
  const adapter = resolveOptionalCoreAdapterFromHono(c, 'tenant-vanity-domains');
  if (!adapter) {
    throw new Error('Core database is not configured');
  }
  return adapter;
}

async function resolveDomainAliasInput(
  env: Env,
  tenantId: string,
  hostname: string
): Promise<TenantDiscoveryAliasDirectoryInput> {
  return resolveTenantDiscoveryAliasDirectoryInput(env, {
    tenantId,
    aliasKind: 'custom_domain',
    aliasValue: hostname,
  });
}

async function prepareDomainAlias(env: Env, tenantId: string, hostname: string) {
  const input = await resolveDomainAliasInput(env, tenantId, hostname);
  await prepareTenantDiscoveryAliasDirectory(env, input);
  return input;
}

async function disableDomainAlias(env: Env, tenantId: string, hostname: string): Promise<void> {
  const input = await resolveDomainAliasInput(env, tenantId, hostname);
  await disableTenantDiscoveryAliasDirectory(env, input);
}

async function mapBounded<T, R>(
  values: readonly T[],
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(PLATFORM_FANOUT_CONCURRENCY, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await operation(values[index]!);
      }
    })
  );
  return results;
}

async function resolvePlatformTenantCoreSources(env: Env, tenantId?: string) {
  if (tenantId) {
    return [
      await resolveTenantDatabaseSourceFromRegistry(env, {
        tenantId,
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        shardGroup: 'default',
        shardIndex: 0,
      }),
    ];
  }
  if (
    !env.AUTHRIM_ENVIRONMENT_NAME ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
  ) {
    throw new Error('tenant_vanity_platform_registry_unavailable');
  }
  const aliases = await new LookupRouteResolver(
    env as unknown as Record<string, unknown>,
    await loadVerifiedLookupBucketAssignmentProvider({
      store: env.TENANT_RUNTIME_REGISTRY,
      environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
      publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
    })
  ).resolveAliases({
    index: await createLookupAliasIndex('environment_tenant', env.AUTHRIM_ENVIRONMENT_NAME),
    maximumResults: MAX_PLATFORM_TENANTS,
  });
  const tenantIds = [...new Set(aliases.map((alias) => alias.tenantId))];
  return mapBounded(tenantIds, (candidateTenantId) =>
    resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId: candidateTenantId,
      role: 'tenant_core',
      dataRole: 'tenant_core/default',
      shardGroup: 'default',
      shardIndex: 0,
    })
  );
}

async function findPlatformDomainById(env: Env, id: string) {
  const matches = (
    await mapBounded(await resolvePlatformTenantCoreSources(env), async (store) => ({
      store,
      row: await getDomainById(store.source, id),
    }))
  ).filter((entry): entry is typeof entry & { row: TenantVanityDomainRow } => entry.row !== null);
  if (matches.length > 1) throw new Error('tenant_vanity_domain_id_ambiguous');
  return matches[0] ?? null;
}

function formatDomain(row: TenantVanityDomainRow) {
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
    validation_records: row.validation_records_json
      ? (JSON.parse(row.validation_records_json) as unknown)
      : null,
    last_sync_at: row.last_sync_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getActiveHostname(hostname: string, isActive: boolean): string | null {
  return isActive ? hostname : null;
}

function getPrimaryActiveTenantKey(
  tenantId: string,
  isPrimary: boolean,
  isActive: boolean
): string | null {
  return isPrimary && isActive ? tenantId : null;
}

function getCloudflareZoneId(env: Env, override?: string): string | null {
  return (
    override ||
    (env as Env & { CLOUDFLARE_ZONE_ID?: string; CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_ID?: string })
      .CLOUDFLARE_CUSTOM_HOSTNAME_ZONE_ID ||
    (env as Env & { CLOUDFLARE_ZONE_ID?: string }).CLOUDFLARE_ZONE_ID ||
    null
  );
}

async function callCloudflare<T>(
  env: Env,
  zoneId: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new Error('CLOUDFLARE_API_TOKEN is not configured');
  }

  const response = await safeFetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/custom_hostnames${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      requireHttps: true,
      timeoutMs: 10000,
      maxResponseSize: 128 * 1024,
    }
  );
  const body = (await readResponseTextWithLimit(response, 128 * 1024)
    .then((text) => JSON.parse(text))
    .catch(() => null)) as CloudflareResponse<T> | null;
  if (!response.ok || !body?.success) {
    const message = body?.errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join(', ');
    throw new Error(message || `Cloudflare API failed with HTTP ${response.status}`);
  }
  return body.result;
}

async function createCloudflareHostname(
  env: Env,
  zoneId: string,
  hostname: string
): Promise<CloudflareCustomHostname> {
  return callCloudflare<CloudflareCustomHostname>(env, zoneId, '', {
    method: 'POST',
    body: JSON.stringify({
      hostname,
      ssl: {
        method: 'http',
        type: 'dv',
        settings: {
          http2: 'on',
          min_tls_version: '1.2',
          tls_1_3: 'on',
        },
      },
    }),
  });
}

async function getCloudflareHostname(
  env: Env,
  zoneId: string,
  customHostnameId: string
): Promise<CloudflareCustomHostname> {
  return callCloudflare<CloudflareCustomHostname>(env, zoneId, `/${customHostnameId}`);
}

async function deleteCloudflareHostname(
  env: Env,
  zoneId: string,
  customHostnameId: string
): Promise<void> {
  await callCloudflare<unknown>(env, zoneId, `/${customHostnameId}`, { method: 'DELETE' });
}

function collectValidationRecords(result: CloudflareCustomHostname): unknown {
  return {
    ownership_verification: result.ownership_verification ?? null,
    ownership_verification_http: result.ownership_verification_http ?? null,
    ssl_validation_records: result.ssl?.validation_records ?? null,
  };
}

function cloudflareStatus(result: CloudflareCustomHostname): DomainStatus {
  return result.status === 'active' && result.ssl?.status === 'active' ? 'active' : 'pending';
}

async function getDomainById(
  db: DatabaseSource,
  id: string,
  tenantId?: string
): Promise<TenantVanityDomainRow | null> {
  const adapter = ensureDatabaseAdapter(db, 'tenant-vanity-domains');
  const tenantClause = tenantId ? ' AND tenant_id = ?' : '';
  const params = tenantId ? [id, tenantId] : [id];
  return adapter.queryOne<TenantVanityDomainRow>(
    `SELECT * FROM tenant_vanity_domains WHERE id = ?${tenantClause}`,
    params
  );
}

async function setPrimary(
  db: DatabaseSource,
  env: Env,
  id: string,
  tenantId: string
): Promise<TenantVanityDomainRow> {
  const adapter = ensureDatabaseAdapter(db, 'tenant-vanity-domains');
  const now = Math.floor(Date.now() / 1000);
  await adapter.transaction(async (tx) => {
    await tx.execute(
      'UPDATE tenant_vanity_domains SET is_primary = 0, primary_active_tenant_key = NULL, updated_at = ? WHERE tenant_id = ?',
      [now, tenantId]
    );
    await tx.execute(
      `UPDATE tenant_vanity_domains
       SET is_primary = 1, primary_active_tenant_key = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND is_active = 1 AND status = 'active'`,
      [getPrimaryActiveTenantKey(tenantId, true, true), now, id, tenantId]
    );
  });
  const updated = await getDomainById(adapter, id, tenantId);
  if (!updated || updated.is_primary !== 1) {
    throw new Error('Primary vanity domain must be active before it can become canonical');
  }
  await invalidateTenantVanityDomainCache(env.AUTHRIM_CONFIG, {
    hostname: updated.hostname,
    tenantId: updated.tenant_id,
  });
  return updated;
}

async function createDomain(
  c: Context<{ Bindings: Env }>,
  db: DatabaseSource,
  tenantId: string,
  hostname: string,
  options: { isPrimary: boolean; cloudflareZoneId?: string }
) {
  const adapter = ensureDatabaseAdapter(db, 'tenant-vanity-domains');
  const tenant = await adapter.queryOne<{ id: string }>(
    "SELECT id FROM tenants WHERE id = ? AND lifecycle_state = 'active'",
    [tenantId]
  );
  if (!tenant) {
    return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND, {
      variables: { resource: 'tenant' },
    });
  }

  const existing = await adapter.queryOne<{ id: string }>(
    'SELECT id FROM tenant_vanity_domains WHERE active_hostname = ?',
    [hostname]
  );
  if (existing) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'hostname', reason: 'An active vanity domain already exists' },
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const auth = getAdminAuth(c);
  const zoneId = getCloudflareZoneId(c.env, options.cloudflareZoneId);
  let cloudflare: CloudflareCustomHostname | null = null;
  let status: DomainStatus = 'pending_manual';
  let errorMessage: string | null = null;

  if (c.env.CLOUDFLARE_API_TOKEN && zoneId) {
    try {
      cloudflare = await createCloudflareHostname(c.env, zoneId, hostname);
      status = cloudflareStatus(cloudflare);
    } catch (error) {
      status = 'failed';
      errorMessage = error instanceof Error ? error.message : 'Cloudflare API failed';
    }
  }

  const aliasInput =
    status === 'active' ? await prepareDomainAlias(c.env, tenantId, hostname) : null;

  await adapter.execute(
    `INSERT INTO tenant_vanity_domains (
       id, tenant_id, hostname, is_active, active_hostname, is_primary, primary_active_tenant_key, status, cloudflare_zone_id,
       cloudflare_custom_hostname_id, ssl_status, ownership_status, validation_method,
       validation_records_json, last_sync_at, created_by, created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenantId,
      hostname,
      getActiveHostname(hostname, true),
      getPrimaryActiveTenantKey(tenantId, false, true),
      status,
      zoneId,
      cloudflare?.id ?? null,
      cloudflare?.ssl?.status ?? null,
      cloudflare?.status ?? null,
      cloudflare?.ssl?.method ?? 'http',
      JSON.stringify(collectValidationRecords(cloudflare ?? ({ hostname, id: '' } as never))),
      cloudflare ? now : null,
      auth?.userId ?? null,
      now,
      now,
    ]
  );

  let row = await getDomainById(adapter, id, tenantId);
  if (aliasInput) {
    await ensureActiveTenantDiscoveryAliasDirectory(c.env, aliasInput);
  }
  if (row && options.isPrimary && row.status === 'active') {
    row = await setPrimary(adapter, c.env, id, tenantId);
  }

  await createAuditLogFromContext(c, 'tenant_vanity_domain.created', 'tenant_vanity_domain', id, {
    tenant_id: tenantId,
    hostname,
    status,
  });

  return c.json(
    {
      domain: formatDomain(row!),
      cloudflare_configured: !!c.env.CLOUDFLARE_API_TOKEN && !!zoneId,
      manual_setup_required: !c.env.CLOUDFLARE_API_TOKEN || !zoneId,
      cloudflare_error: errorMessage,
    },
    201
  );
}

export async function listTenantVanityDomainsHandler(c: Context<{ Bindings: Env }>) {
  if (!hasPermission(c, ADMIN_PERMISSIONS.TENANT_DOMAINS_READ)) return permissionDenied(c);

  const tenantId = getTenantIdFromContext(c);
  const rows = await getCoreAdapter(c).query<TenantVanityDomainRow>(
    'SELECT * FROM tenant_vanity_domains WHERE tenant_id = ? ORDER BY is_primary DESC, created_at DESC',
    [tenantId]
  );
  return c.json({
    domains: rows.map(formatDomain),
    cloudflare_configured: !!c.env.CLOUDFLARE_API_TOKEN && !!getCloudflareZoneId(c.env),
  });
}

export async function createTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!hasPermission(c, ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE)) return permissionDenied(c);

  const body = await c.req.json<unknown>().catch(() => null);
  const parsed = CreateSchema.omit({ tenant_id: true }).safeParse(body);
  if (!parsed.success) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
  const hostname = normalizeHostname(parsed.data.hostname);
  const validationError = validateHostname(hostname);
  if (validationError) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'hostname', reason: validationError },
    });
  }
  return createDomain(c, getCoreAdapter(c), getTenantIdFromContext(c), hostname, {
    isPrimary: parsed.data.is_primary,
    cloudflareZoneId: parsed.data.cloudflare_zone_id,
  });
}

export async function getTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!hasPermission(c, ADMIN_PERMISSIONS.TENANT_DOMAINS_READ)) return permissionDenied(c);

  const tenantId = getTenantIdFromContext(c);
  const row = await getDomainById(getCoreAdapter(c), c.req.param('id')!, tenantId);
  if (!row) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  return c.json({ domain: formatDomain(row) });
}

export async function listPlatformTenantVanityDomainsHandler(c: Context<{ Bindings: Env }>) {
  if (!isSystemAdmin(getAdminAuth(c))) return permissionDenied(c);

  const tenantId = c.req.query('tenant_id');
  const rows = (
    await mapBounded(await resolvePlatformTenantCoreSources(c.env, tenantId), (store) =>
      ensureDatabaseAdapter(store.source, 'tenant-vanity-domains').query<TenantVanityDomainRow>(
        `SELECT * FROM tenant_vanity_domains
          ${tenantId ? 'WHERE tenant_id = ?' : ''}
          ORDER BY tenant_id ASC, is_primary DESC, created_at DESC`,
        tenantId ? [tenantId] : []
      )
    )
  )
    .flat()
    .sort(
      (left, right) =>
        left.tenant_id.localeCompare(right.tenant_id) ||
        right.is_primary - left.is_primary ||
        right.created_at - left.created_at
    );
  return c.json({
    domains: rows.map(formatDomain),
    cloudflare_configured: !!c.env.CLOUDFLARE_API_TOKEN && !!getCloudflareZoneId(c.env),
  });
}

export async function createPlatformTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!isSystemAdmin(getAdminAuth(c))) return permissionDenied(c);

  const body = await c.req.json<unknown>().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success || !parsed.data.tenant_id) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
  }
  const hostname = normalizeHostname(parsed.data.hostname);
  const validationError = validateHostname(hostname);
  if (validationError) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: { field: 'hostname', reason: validationError },
    });
  }
  const [store] = await resolvePlatformTenantCoreSources(c.env, parsed.data.tenant_id);
  if (!store) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  return createDomain(c, store.source, parsed.data.tenant_id, hostname, {
    isPrimary: parsed.data.is_primary,
    cloudflareZoneId: parsed.data.cloudflare_zone_id,
  });
}

export async function getPlatformTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!isSystemAdmin(getAdminAuth(c))) return permissionDenied(c);

  const match = await findPlatformDomainById(c.env, c.req.param('id')!);
  if (!match) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  return c.json({ domain: formatDomain(match.row) });
}

export async function updateTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!hasPermission(c, ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE)) return permissionDenied(c);

  const tenantId = getTenantIdFromContext(c);
  const id = c.req.param('id')!;
  const parsed = UpdateSchema.safeParse(await c.req.json<unknown>().catch(() => null));
  if (!parsed.success) return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE);

  const adapter = getCoreAdapter(c);
  const existing = await getDomainById(adapter, id, tenantId);
  if (!existing) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);

  if (parsed.data.is_active !== undefined) {
    if (parsed.data.is_active && existing.is_active === 0) {
      const collision = await adapter.queryOne<{ id: string }>(
        'SELECT id FROM tenant_vanity_domains WHERE active_hostname = ? AND id != ?',
        [existing.hostname, id]
      );
      if (collision) {
        return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
          variables: { field: 'hostname', reason: 'An active vanity domain already exists' },
        });
      }
    }
    const aliasInput =
      parsed.data.is_active && existing.is_active === 0 && existing.status === 'active'
        ? await prepareDomainAlias(c.env, tenantId, existing.hostname)
        : null;
    if (!parsed.data.is_active && existing.is_active === 1 && existing.status === 'active') {
      await disableDomainAlias(c.env, tenantId, existing.hostname);
    }
    const now = Math.floor(Date.now() / 1000);
    await adapter.execute(
      `UPDATE tenant_vanity_domains
       SET is_active = ?,
           active_hostname = ?,
           is_primary = CASE WHEN ? = 0 THEN 0 ELSE is_primary END,
           primary_active_tenant_key = CASE WHEN ? = 1 AND is_primary = 1 THEN ? ELSE NULL END,
           updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        parsed.data.is_active ? 1 : 0,
        getActiveHostname(existing.hostname, parsed.data.is_active),
        parsed.data.is_active ? 1 : 0,
        parsed.data.is_active ? 1 : 0,
        getPrimaryActiveTenantKey(tenantId, true, true),
        now,
        id,
        tenantId,
      ]
    );
    if (aliasInput) {
      await ensureActiveTenantDiscoveryAliasDirectory(c.env, aliasInput);
    }
  }

  const updated = await getDomainById(adapter, id, tenantId);
  await invalidateTenantVanityDomainCache(c.env.AUTHRIM_CONFIG, {
    hostname: existing.hostname,
    tenantId,
  });
  return c.json(formatDomain(updated!));
}

export async function setPrimaryTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!hasPermission(c, ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE)) return permissionDenied(c);

  try {
    const updated = await setPrimary(
      getCoreAdapter(c),
      c.env,
      c.req.param('id')!,
      getTenantIdFromContext(c)
    );
    return c.json(formatDomain(updated));
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'id',
        reason: error instanceof Error ? error.message : 'invalid primary',
      },
    });
  }
}

export async function syncTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!hasPermission(c, ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE)) return permissionDenied(c);

  const tenantId = getTenantIdFromContext(c);
  const id = c.req.param('id')!;
  const adapter = getCoreAdapter(c);
  const existing = await getDomainById(adapter, id, tenantId);
  if (!existing) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  if (!existing.cloudflare_zone_id || !existing.cloudflare_custom_hostname_id) {
    return c.json({ domain: formatDomain(existing), cloudflare_configured: false });
  }

  try {
    const result = await getCloudflareHostname(
      c.env,
      existing.cloudflare_zone_id,
      existing.cloudflare_custom_hostname_id
    );
    const now = Math.floor(Date.now() / 1000);
    const status = cloudflareStatus(result);
    const aliasInput =
      status === 'active' && (existing.status !== 'active' || existing.is_active !== 1)
        ? await prepareDomainAlias(c.env, tenantId, existing.hostname)
        : null;
    if (status !== 'active' && existing.status === 'active' && existing.is_active === 1) {
      await disableDomainAlias(c.env, tenantId, existing.hostname);
    }
    await adapter.execute(
      `UPDATE tenant_vanity_domains
       SET status = ?, ssl_status = ?, ownership_status = ?, validation_method = ?,
           validation_records_json = ?, last_sync_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
      [
        status,
        result.ssl?.status ?? null,
        result.status ?? null,
        result.ssl?.method ?? 'http',
        JSON.stringify(collectValidationRecords(result)),
        now,
        now,
        id,
        tenantId,
      ]
    );
    if (aliasInput) {
      await ensureActiveTenantDiscoveryAliasDirectory(c.env, aliasInput);
    }
    await invalidateTenantVanityDomainCache(c.env.AUTHRIM_CONFIG, {
      hostname: existing.hostname,
      tenantId,
    });
    const updated = await getDomainById(adapter, id, tenantId);
    return c.json({ domain: formatDomain(updated!), cloudflare_configured: true });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR, {
      variables: { reason: error instanceof Error ? error.message : 'Cloudflare sync failed' },
    });
  }
}

export async function verifyTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!hasPermission(c, ADMIN_PERMISSIONS.TENANT_DOMAINS_WRITE)) return permissionDenied(c);

  const tenantId = getTenantIdFromContext(c);
  const id = c.req.param('id')!;
  const adapter = getCoreAdapter(c);
  const existing = await getDomainById(adapter, id, tenantId);
  if (!existing) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);

  if (existing.cloudflare_zone_id && existing.cloudflare_custom_hostname_id) {
    return syncTenantVanityDomainHandler(c);
  }

  const now = Math.floor(Date.now() / 1000);
  const aliasInput =
    existing.status !== 'active' || existing.is_active !== 1
      ? await prepareDomainAlias(c.env, tenantId, existing.hostname)
      : null;
  await adapter.execute(
    `UPDATE tenant_vanity_domains
     SET status = 'active', ssl_status = 'active', ownership_status = 'active',
         validation_method = 'manual', last_sync_at = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`,
    [now, now, id, tenantId]
  );
  if (aliasInput) {
    await ensureActiveTenantDiscoveryAliasDirectory(c.env, aliasInput);
  }
  await invalidateTenantVanityDomainCache(c.env.AUTHRIM_CONFIG, {
    hostname: existing.hostname,
    tenantId,
  });
  const updated = await getDomainById(adapter, id, tenantId);
  return c.json({ domain: formatDomain(updated!), cloudflare_configured: false });
}

export async function deleteTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!hasPermission(c, ADMIN_PERMISSIONS.TENANT_DOMAINS_DELETE)) return permissionDenied(c);

  const tenantId = getTenantIdFromContext(c);
  const id = c.req.param('id')!;
  const adapter = getCoreAdapter(c);
  const existing = await getDomainById(adapter, id, tenantId);
  if (!existing) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);

  if (
    existing.cloudflare_zone_id &&
    existing.cloudflare_custom_hostname_id &&
    c.env.CLOUDFLARE_API_TOKEN
  ) {
    await deleteCloudflareHostname(
      c.env,
      existing.cloudflare_zone_id,
      existing.cloudflare_custom_hostname_id
    ).catch(() => {});
  }

  const now = Math.floor(Date.now() / 1000);
  if (existing.is_active === 1 && existing.status === 'active') {
    await disableDomainAlias(c.env, tenantId, existing.hostname);
  }
  await adapter.execute(
    "UPDATE tenant_vanity_domains SET is_active = 0, active_hostname = NULL, is_primary = 0, primary_active_tenant_key = NULL, status = 'deleted', updated_at = ? WHERE id = ? AND tenant_id = ?",
    [now, id, tenantId]
  );
  await invalidateTenantVanityDomainCache(c.env.AUTHRIM_CONFIG, {
    hostname: existing.hostname,
    tenantId,
  });
  return c.json({ success: true });
}

export async function setPrimaryPlatformTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!isSystemAdmin(getAdminAuth(c))) return permissionDenied(c);

  const id = c.req.param('id')!;
  const match = await findPlatformDomainById(c.env, id);
  if (!match) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  const adapter = ensureDatabaseAdapter(match.store.source, 'tenant-vanity-domains');
  const existing = match.row;

  try {
    const updated = await setPrimary(adapter, c.env, id, existing.tenant_id);
    return c.json(formatDomain(updated));
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
      variables: {
        field: 'id',
        reason: error instanceof Error ? error.message : 'invalid primary',
      },
    });
  }
}

export async function syncPlatformTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!isSystemAdmin(getAdminAuth(c))) return permissionDenied(c);

  const id = c.req.param('id')!;
  const match = await findPlatformDomainById(c.env, id);
  if (!match) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  const adapter = ensureDatabaseAdapter(match.store.source, 'tenant-vanity-domains');
  const existing = match.row;
  if (!existing.cloudflare_zone_id || !existing.cloudflare_custom_hostname_id) {
    return c.json({ domain: formatDomain(existing), cloudflare_configured: false });
  }

  try {
    const result = await getCloudflareHostname(
      c.env,
      existing.cloudflare_zone_id,
      existing.cloudflare_custom_hostname_id
    );
    const now = Math.floor(Date.now() / 1000);
    const status = cloudflareStatus(result);
    const aliasInput =
      status === 'active' && (existing.status !== 'active' || existing.is_active !== 1)
        ? await prepareDomainAlias(c.env, existing.tenant_id, existing.hostname)
        : null;
    if (status !== 'active' && existing.status === 'active' && existing.is_active === 1) {
      await disableDomainAlias(c.env, existing.tenant_id, existing.hostname);
    }
    await adapter.execute(
      `UPDATE tenant_vanity_domains
       SET status = ?, ssl_status = ?, ownership_status = ?, validation_method = ?,
           validation_records_json = ?, last_sync_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        status,
        result.ssl?.status ?? null,
        result.status ?? null,
        result.ssl?.method ?? 'http',
        JSON.stringify(collectValidationRecords(result)),
        now,
        now,
        id,
      ]
    );
    if (aliasInput) {
      await ensureActiveTenantDiscoveryAliasDirectory(c.env, aliasInput);
    }
    await invalidateTenantVanityDomainCache(c.env.AUTHRIM_CONFIG, {
      hostname: existing.hostname,
      tenantId: existing.tenant_id,
    });
    const updated = await getDomainById(adapter, id);
    return c.json({ domain: formatDomain(updated!), cloudflare_configured: true });
  } catch (error) {
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR, {
      variables: { reason: error instanceof Error ? error.message : 'Cloudflare sync failed' },
    });
  }
}

export async function verifyPlatformTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!isSystemAdmin(getAdminAuth(c))) return permissionDenied(c);

  const id = c.req.param('id')!;
  const match = await findPlatformDomainById(c.env, id);
  if (!match) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  const adapter = ensureDatabaseAdapter(match.store.source, 'tenant-vanity-domains');
  const existing = match.row;

  if (existing.cloudflare_zone_id && existing.cloudflare_custom_hostname_id) {
    return syncPlatformTenantVanityDomainHandler(c);
  }

  const now = Math.floor(Date.now() / 1000);
  const aliasInput =
    existing.status !== 'active' || existing.is_active !== 1
      ? await prepareDomainAlias(c.env, existing.tenant_id, existing.hostname)
      : null;
  await adapter.execute(
    `UPDATE tenant_vanity_domains
     SET status = 'active', ssl_status = 'active', ownership_status = 'active',
         validation_method = 'manual', last_sync_at = ?, updated_at = ?
     WHERE id = ?`,
    [now, now, id]
  );
  if (aliasInput) {
    await ensureActiveTenantDiscoveryAliasDirectory(c.env, aliasInput);
  }
  await invalidateTenantVanityDomainCache(c.env.AUTHRIM_CONFIG, {
    hostname: existing.hostname,
    tenantId: existing.tenant_id,
  });
  const updated = await getDomainById(adapter, id);
  return c.json({ domain: formatDomain(updated!), cloudflare_configured: false });
}

export async function deletePlatformTenantVanityDomainHandler(c: Context<{ Bindings: Env }>) {
  if (!isSystemAdmin(getAdminAuth(c))) return permissionDenied(c);

  const id = c.req.param('id')!;
  const match = await findPlatformDomainById(c.env, id);
  if (!match) return createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
  const adapter = ensureDatabaseAdapter(match.store.source, 'tenant-vanity-domains');
  const existing = match.row;

  if (
    existing.cloudflare_zone_id &&
    existing.cloudflare_custom_hostname_id &&
    c.env.CLOUDFLARE_API_TOKEN
  ) {
    await deleteCloudflareHostname(
      c.env,
      existing.cloudflare_zone_id,
      existing.cloudflare_custom_hostname_id
    ).catch(() => {});
  }

  const now = Math.floor(Date.now() / 1000);
  if (existing.is_active === 1 && existing.status === 'active') {
    await disableDomainAlias(c.env, existing.tenant_id, existing.hostname);
  }
  await adapter.execute(
    "UPDATE tenant_vanity_domains SET is_active = 0, active_hostname = NULL, is_primary = 0, primary_active_tenant_key = NULL, status = 'deleted', updated_at = ? WHERE id = ?",
    [now, id]
  );
  await invalidateTenantVanityDomainCache(c.env.AUTHRIM_CONFIG, {
    hostname: existing.hostname,
    tenantId: existing.tenant_id,
  });
  return c.json({ success: true });
}
