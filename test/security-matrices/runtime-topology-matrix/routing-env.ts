/**
 * Runtime-topology routing environment: reassembles the shared matrix-test fakes
 * (call ledger, KV, D1 adapters) into a topology Env carrying the production
 * request-context chain (BASE_DOMAIN, signed runtime registry, vanity, bindings),
 * plus the probe Hono app that runs `requestContextMiddleware` and observes the
 * established tenant context and canonical issuer through the exported
 * `getRequestContext` / `getRequestIssuer` helpers.
 *
 * The D1 bindings are wrapped in the tenant-aware adapter so every tenant-routing label
 * used as a bind parameter is recorded as a safe `tenant-access` ledger entry (raw
 * parameters and secrets are never logged).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../../packages/ar-lib-core/src/types/env';
import {
  requestContextMiddleware,
  getRequestContext,
} from '../../../packages/ar-lib-core/src/middleware/request-context';
import { getRequestIssuer } from '../../../packages/ar-token/src/issuer';
import { createSecurityMatrixEnv, type SecurityMatrixEnvKit } from '../fixtures/env';
import { CallLedger, LedgerExecutionContext } from '../fixtures/call-ledger';
import { MemoryKVNamespace } from '../fixtures/kv';
import type { TenantRuntimeRegistrySnapshot } from '../../../packages/ar-lib-core/src/services/tenant-runtime-registry-snapshot';
import { TenantLedgerDatabaseAdapter, TENANT_ACCESS_LABELS } from './tenant-ledger-adapter';
import {
  buildGenerationDocument,
  RUNTIME_REGISTRY_GENERATION_KEY,
  RUNTIME_REGISTRY_SNAPSHOT_KEY,
  getRuntimeRegistryKeys,
  buildSnapshot,
  signSnapshot,
  corruptSnapshotSignature,
} from './registry-fixtures';

export const BASE_DOMAIN = 'authrim.example';
export const TENANT_ALPHA = 'alpha';
export const TENANT_BETA = 'beta';
export const TENANT_DEFAULT = 'default';
export const PRIMARY_VANITY_ALPHA = 'vanity.alpha.example';
export const NON_PRIMARY_VANITY_ALPHA = 'alias.alpha.example';
export const INACTIVE_VANITY_ALPHA = 'vanity-inactive.example';
export const PRIMARY_VANITY_BETA = 'beta-vanity.example';
export const UI_HOST = 'login.authrim.example';

export interface TopologyEnvKit {
  ledger: CallLedger;
  env: Env;
  authrimConfig: MemoryKVNamespace;
  settings: MemoryKVNamespace;
  runtimeRegistry: MemoryKVNamespace;
  coreAdapter: SecurityMatrixEnvKit['coreAdapter'];
  piiAdapter: SecurityMatrixEnvKit['piiAdapter'];
  adminAdapter: SecurityMatrixEnvKit['adminAdapter'];
}

export interface RoutingEnvConfig {
  deploymentMode: 'single' | 'multi';
  forwardedPolicy: 'disabled' | 'enabled';
  registryState: 'valid' | 'bad-signature' | 'missing' | 'quarantined' | 'not-configured';
  bindingState?: 'present' | 'missing' | 'wrong-type';
  /** Keyed by tenant id: snapshot for that tenant (alpha/beta/default). */
  snapshots?: Record<string, TenantRuntimeRegistrySnapshot | null>;
  generations?: Record<string, string>;
  uiUrl?: string;
  extraEnv?: Record<string, unknown>;
}

export interface ProbeResult {
  status: number;
  error: string | null;
  errorDescription: string | null;
  location: string | null;
  body: { tenantId?: string; issuer?: string } | null;
  bodyText: string;
  response: Response;
}

const probeHandler = async (c: Context<{ Bindings: Env }>) => {
  const ctx = getRequestContext(c);
  // getRequestIssuer is typed against the package-root Env; the test app is typed
  // against the source Env, which are structurally identical.
  const issuer = getRequestIssuer(c as unknown as Parameters<typeof getRequestIssuer>[0]);
  return c.json({ tenantId: ctx.tenantId, issuer });
};

export function createProbeApp(
  env: Env,
  options: { requireTenant?: boolean } = {}
): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', requestContextMiddleware({ requireTenant: options.requireTenant ?? true }));
  app.get('/probe', probeHandler);
  app.post('/probe', probeHandler);
  app.get('/.well-known/openid-configuration', probeHandler);
  app.get('/internal/health', probeHandler);
  app.post('/api/v1/login/interactions/start', probeHandler);
  app.post('/token', probeHandler);
  app.get('/api/admin/settings/logging/tenant/alpha', probeHandler);
  app.get('/api/admin/settings/logging/tenant/beta', probeHandler);
  return app;
}

export async function runProbe(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  request: Request,
  ledger: CallLedger
): Promise<ProbeResult> {
  // Reset after seeding so the observation covers only this request's side effects.
  ledger.reset();
  const executionCtx = new LedgerExecutionContext(ledger);
  const response = await app.fetch(request, env, executionCtx);
  await ledger.drain();
  const bodyText = await response.text();
  let body: ProbeResult['body'] = null;
  try {
    body = JSON.parse(bodyText) as ProbeResult['body'];
  } catch {
    body = null;
  }
  const parsed = body as { error?: string; error_description?: string } | null;
  return {
    status: response.status,
    error: parsed?.error ?? null,
    errorDescription: parsed?.error_description ?? null,
    location: response.headers.get('Location'),
    body,
    bodyText,
    response,
  };
}

/**
 * Build a topology env. `createSecurityMatrixEnv` provides the shared fakes; this helper assembles
 * them into the request-context chain (BASE_DOMAIN, signed runtime registry KV, binding
 * targets, verifying JWKS). The clock is pinned by the suite; the env object itself is a
 * fresh, structurally correct plain object per kit (not frozen — production bindings are
 * mutable by design, and the suite freezes time rather than the env).
 */
export async function createTopologyKit(config: RoutingEnvConfig): Promise<TopologyEnvKit> {
  const ledger = new CallLedger();
  const base = await createSecurityMatrixEnv(ledger);
  const runtimeRegistry = new MemoryKVNamespace(ledger, 'runtime_registry');
  const wrap = (
    adapter: SecurityMatrixEnvKit['coreAdapter'],
    label: string
  ): TenantLedgerDatabaseAdapter => new TenantLedgerDatabaseAdapter(adapter, ledger, label);

  const baseEnv: Record<string, unknown> = {
    DB: wrap(base.coreAdapter, 'core'),
    DB_PII: wrap(base.piiAdapter, 'pii'),
    DB_ADMIN: wrap(base.adminAdapter, 'admin'),
    DB_LOGIN: wrap(base.coreAdapter, 'core-login'),
    AUTHRIM_CONFIG: base.authrimConfig,
    SETTINGS: base.settings,
    AUTHRIM_ENVIRONMENT_NAME: 'matrix-env',
    ...config.extraEnv,
  };

  if (config.deploymentMode === 'multi') {
    baseEnv.BASE_DOMAIN = BASE_DOMAIN;
    baseEnv.NAKED_DOMAIN_AS_ISSUER = 'true';
    baseEnv.PRIMARY_TENANT_ID = TENANT_DEFAULT;
    baseEnv.DEFAULT_TENANT_ID = TENANT_DEFAULT;
  } else {
    baseEnv.ISSUER_URL = `https://single.authrim.example`;
    baseEnv.DEFAULT_TENANT_ID = TENANT_DEFAULT;
  }
  if (config.forwardedPolicy === 'enabled') {
    baseEnv.AUTHRIM_TRUST_FORWARDED_HOST = 'true';
  }
  if (config.uiUrl) {
    baseEnv.UI_URL = config.uiUrl;
  }

  if (config.registryState !== 'not-configured') {
    const keys = await getRuntimeRegistryKeys();
    baseEnv.TENANT_RUNTIME_REGISTRY = runtimeRegistry;
    baseEnv.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS = keys.primary.publicJwksJson;
  }

  // Seed registry snapshot + generation documents.
  if (config.registryState !== 'not-configured') {
    for (const [tenantId, snapshot] of Object.entries(config.snapshots ?? {})) {
      if (snapshot) {
        await runtimeRegistry.put(
          RUNTIME_REGISTRY_SNAPSHOT_KEY(tenantId),
          JSON.stringify(snapshot)
        );
      }
    }
    for (const [tenantId, generation] of Object.entries(config.generations ?? {})) {
      await runtimeRegistry.put(RUNTIME_REGISTRY_GENERATION_KEY(tenantId), generation);
    }
  }

  const env = baseEnv as unknown as Env;
  return {
    ledger,
    env,
    authrimConfig: base.authrimConfig,
    settings: base.settings,
    runtimeRegistry,
    coreAdapter: base.coreAdapter,
    piiAdapter: base.piiAdapter,
    adminAdapter: base.adminAdapter,
  };
}

/** Seed a tenant row for validateTenantExistsAsync (tenants.lifecycle_state = 'active'). */ export function seedTenantRow(
  kit: TopologyEnvKit,
  tenantId: string,
  lifecycle: 'active' | 'inactive'
): void {
  kit.coreAdapter.addBehavior({
    match: (sql, params) =>
      sql.includes('FROM tenants') &&
      sql.includes('lifecycle_state') &&
      params[params.length - 1] === tenantId,
    result: () => (lifecycle === 'active' ? [{ id: tenantId, lifecycle_state: lifecycle }] : null),
  });
}

export interface VanityRowSeed {
  tenantId: string;
  hostname: string;
  isActive: boolean;
  isPrimary: boolean;
}

/**
 * Seed tenant_vanity_domains rows against the tenant core DB (the adapter that the
 * signed registry resolves for `tenant_core/default`). Both the active-hostname lookup
 * (resolveTenantFromVanityHost) and the primary-active lookup
 * (getPrimaryTenantVanityDomain) are matched.
 */
export function seedVanityRows(kit: TopologyEnvKit, rows: VanityRowSeed[]): void {
  for (const row of rows) {
    const dbRow = {
      id: `vanity-${row.hostname}`,
      tenant_id: row.tenantId,
      hostname: row.hostname,
      active_hostname: row.hostname,
      primary_active_tenant_key: row.isPrimary ? row.tenantId : null,
      is_active: row.isActive ? 1 : 0,
      is_primary: row.isPrimary ? 1 : 0,
      status: row.isActive ? 'active' : 'inactive',
      cloudflare_zone_id: null,
      cloudflare_custom_hostname_id: null,
      ssl_status: null,
      ownership_status: null,
      validation_method: null,
      validation_records_json: null,
      last_sync_at: null,
      created_by: null,
      created_at: 1700000000,
      updated_at: 1700000000,
    };
    kit.coreAdapter.addBehavior({
      match: (sql, params) => {
        if (sql.includes('active_hostname')) {
          return (
            sql.includes('FROM tenant_vanity_domains') &&
            params[params.length - 2] === row.hostname &&
            params[params.length - 1] === row.tenantId
          );
        }
        if (sql.includes('primary_active_tenant_key')) {
          // Only the primary row answers the primary-active lookup; a non-primary alias
          // must not match (the resolver restricts by is_active/status in SQL, and the
          // behavior layer must mirror that ownership constraint).
          return (
            row.isPrimary &&
            sql.includes('FROM tenant_vanity_domains') &&
            params[0] === row.tenantId
          );
        }
        return false;
      },
      result: () => (row.isActive ? [dbRow] : null),
    });
  }
}

/** Seed the KV vanity cache entry used by resolveTenantFromVanityHost. */
export async function seedVanityCache(
  kit: TopologyEnvKit,
  hostname: string,
  tenantId: string
): Promise<void> {
  await kit.authrimConfig.put(`v1:tenant-vanity-domain:${hostname}`, tenantId);
}

export async function seedRegistry(
  kit: TopologyEnvKit,
  tenantId: string,
  snapshot: TenantRuntimeRegistrySnapshot,
  generation: string
): Promise<void> {
  await kit.runtimeRegistry.put(RUNTIME_REGISTRY_SNAPSHOT_KEY(tenantId), JSON.stringify(snapshot));
  await kit.runtimeRegistry.put(RUNTIME_REGISTRY_GENERATION_KEY(tenantId), generation);
}

export function makeGenerationDocument(
  runtimeGeneration: number,
  routeStatus: 'active' | 'quarantining' | 'quarantined' | 'disabled',
  quarantineDenyGeneration: number,
  nowMs: number
): string {
  return buildGenerationDocument({
    runtimeGeneration,
    routeStatus,
    quarantineDenyGeneration,
    publishedAt: new Date(nowMs - 60_000).toISOString(),
    expiresAt: new Date(nowMs + 3600_000).toISOString(),
  });
}

export interface SnapshotSeedOptions {
  registryState?: string;
  bindingState?: string;
  /** Snapshot tenantId (foreign for registryTenant=foreign rows). */
  snapshotTenantId?: string;
  generationState?: string;
  cacheState?: string;
}

/**
 * Seed a signed runtime-registry snapshot + generation document for one tenant.
 * `registryState` selects the failure shape: bad-signature corrupts the signature bytes;
 * `missing` omits the snapshot; `quarantined` marks the snapshot route; the other states
 * are the resolver states exercised by R-B/R-C directly through their own seeds.
 */
export async function seedRegistryForTenant(
  kit: TopologyEnvKit,
  tenantId: string,
  registryState: string,
  bindingState: string,
  options: SnapshotSeedOptions = {}
): Promise<string[]> {
  const nowMs = Date.now();
  const bindingRef =
    bindingState === 'missing' ? 'MISSING_DB' : bindingState === 'wrong-type' ? 'DB_WRONG' : 'DB';
  const snapshotTenantId = options.snapshotTenantId ?? tenantId;
  const store: SnapshotStoreSpecLocal = {
    tenantId: snapshotTenantId,
    dataRole: 'tenant_core/default',
    bindingRef,
    generation: 5,
    runtimeGeneration: 5,
    allocationScope: 'shared_pool',
    ownerTenantId: null,
    provider: 'd1',
    databaseId: `db-core-${snapshotTenantId}`,
  };
  const snapshot = buildSnapshot({
    tenantId: snapshotTenantId,
    runtimeGeneration: 5,
    routeStatus: 'active',
    quarantineDenyGeneration: 0,
    stores: [store],
    publishedAt: new Date(nowMs - 60_000).toISOString(),
    expiresAt: new Date(nowMs + 3600_000).toISOString(),
  });
  const signed = await signSnapshot(snapshot, new Date(nowMs).toISOString());
  const secrets = [signed.metadata.signature as string];
  if (registryState === 'bad-signature') {
    // Mutate a middle signature byte (a last-character edit can touch only the ignored
    // base64url padding bits and leave the verified bytes unchanged).
    corruptSnapshotSignature(signed);
  }
  // 'missing' exercises a missing SNAPSHOT with a present, matching generation document
  // so the resolver attributes the failure to the snapshot layer (missing_snapshot).
  const generation = makeGenerationDocument(
    5,
    registryState === 'quarantined' ? 'quarantined' : 'active',
    registryState === 'quarantined' ? 1 : 0,
    nowMs
  );
  await kit.runtimeRegistry.put(RUNTIME_REGISTRY_GENERATION_KEY(tenantId), generation);
  if (registryState === 'missing') {
    return secrets;
  }
  await seedRegistry(kit, tenantId, signed, generation);
  return secrets;
}

type SnapshotStoreSpecLocal = {
  tenantId: string;
  dataRole: 'tenant_core/default';
  bindingRef: string;
  generation: number;
  runtimeGeneration: number;
  allocationScope: 'shared_pool';
  ownerTenantId: string | null;
  provider: string;
  databaseId: string;
};

// =============================================================================
// Tenant access observation
// =============================================================================

/**
 * Extract tenant-routing labels from a ledger target using ONLY safe key shapes. The
 * vanity-domain cache keys embed hostnames (which can contain a tenant-looking label),
 * so those are deliberately excluded.
 */
export function extractTenantLabelsFromTarget(target: string): string[] {
  const labels: string[] = [];
  const add = (candidate: string | undefined): void => {
    if (candidate && TENANT_ACCESS_LABELS.has(candidate) && !labels.includes(candidate)) {
      labels.push(candidate);
    }
  };
  add(target.match(/^runtime_registry:tenant:([a-z0-9-]+):runtime-registry:/)?.[1]);
  add(target.match(/^autrhm_config:settings:tenant:([a-z0-9-]+):/)?.[1]);
  add(target.match(/v1:tenant-exists:([a-z0-9-]+)$/)?.[1]);
  add(target.match(/v1:tenant-primary-vanity-domain:([a-z0-9-]+)$/)?.[1]);
  return labels;
}

/** Union of safe tenant labels observed in D1 bind parameters and KV targets. */
export function observedTenantAccessSet(ledger: CallLedger): string[] {
  const set = new Set<string>();
  for (const entry of ledger.all()) {
    if (entry.kind === 'tenant-access') {
      const label = entry.target.split(':').pop();
      if (label && TENANT_ACCESS_LABELS.has(label)) set.add(label);
      continue;
    }
    for (const label of extractTenantLabelsFromTarget(entry.target)) {
      set.add(label);
    }
  }
  return [...set].sort();
}

/** The binding that actually received an operation, derived from the D1 adapter label. */
export function observedBindingOperation(ledger: CallLedger, sqlNeedle: string): string | null {
  for (const entry of ledger.all()) {
    if (
      (entry.kind === 'd1.query' || entry.kind === 'd1.queryOne' || entry.kind === 'd1.execute') &&
      entry.target.includes(sqlNeedle)
    ) {
      const label = entry.target.split(':')[0];
      if (label) return `d1:${label}:${sqlNeedle}`;
    }
  }
  return null;
}

/**
 * The binding wrapper label that received the last operation. Unlike the SQL-target
 * derivation this preserves the wrapper identity (e.g. DB_LOGIN vs DB, which both wrap
 * the same core adapter).
 */
export function observedBindingLabel(ledger: CallLedger): string | null {
  const entries = ledger.ofKind('binding-operation');
  const last = entries[entries.length - 1];
  return last ? last.target : null;
}
