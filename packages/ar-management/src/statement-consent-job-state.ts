/** Bounded maintenance state in the existing metadata admin_jobs table; no portable authority. */
import {
  ensureDatabaseAdapter,
  listEnvironmentTenantDefaultStores,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { tenantCoreStores } from './compliance/tenant-stores';

export interface ConsentJobStore {
  bindingRef: string;
  adapter: DatabaseAdapter;
  identity?: unknown;
}
export type ConsentMaintenanceKind = 'reference-audit' | 'retention';
export interface ConsentJobRow {
  config: string;
  result: string | null;
  status: string;
}
export const consentJobId = (kind: ConsentMaintenanceKind, tenantId: string) =>
  `statement-consent:${kind}:${tenantId}`;

export async function consentJobSetting(
  env: Env,
  name: string,
  fallback: number,
  max: number
): Promise<number> {
  const raw: unknown =
    Reflect.get(env, name) ?? (await env.KV?.get(name.toLowerCase())) ?? fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error('statement_consent_job_setting_invalid');
  return value;
}
export function consentJobTargets(stores: readonly ConsentJobStore[]) {
  if (!stores.length || new Set(stores.map((s) => s.bindingRef)).size !== stores.length)
    throw new Error('statement_consent_job_targets_invalid');
  const ordered = [...stores].sort((a, b) => a.bindingRef.localeCompare(b.bindingRef));
  return {
    ordered,
    targets: JSON.stringify(ordered.map((s) => [s.bindingRef, s.identity ?? null])),
  };
}
export async function readConsentJob(
  metadata: DatabaseAdapter,
  tenantId: string,
  kind: ConsentMaintenanceKind
): Promise<ConsentJobRow | null> {
  return metadata.queryOne<ConsentJobRow>(
    'SELECT config,result,status FROM admin_jobs WHERE tenant_id=? AND id=? AND job_type=?',
    [tenantId, consentJobId(kind, tenantId), `consent/${kind}`],
    { consistencyClass: 'primary_required' }
  );
}
export async function ensureConsentJob(
  metadata: DatabaseAdapter,
  tenantId: string,
  kind: ConsentMaintenanceKind
): Promise<ConsentJobRow> {
  const now = Math.floor(Date.now() / 1000);
  await metadata.execute(
    `INSERT INTO admin_jobs(id,tenant_id,job_type,status,config,created_by,created_at,updated_at)
    VALUES(?,?,?,'processing','{}','system',?,?) ON CONFLICT(id) DO NOTHING`,
    [consentJobId(kind, tenantId), tenantId, `consent/${kind}`, now, now]
  );
  const row = await readConsentJob(metadata, tenantId, kind);
  if (!row) throw new Error('statement_consent_job_state_unavailable');
  return row;
}
/** Compare the exact prior state. Duplicate workers can do idempotent work, but only one advances. */
export async function saveConsentJob(
  metadata: DatabaseAdapter,
  tenantId: string,
  kind: ConsentMaintenanceKind,
  before: ConsentJobRow,
  config: unknown,
  result?: unknown
): Promise<boolean> {
  const written = await metadata.execute(
    `UPDATE admin_jobs SET config=?,status=?,result=?,updated_at=?
    WHERE tenant_id=? AND id=? AND job_type=? AND config=? AND status=?`,
    [
      JSON.stringify(config),
      result === undefined ? 'processing' : 'completed',
      result === undefined ? before.result : JSON.stringify(result),
      Math.floor(Date.now() / 1000),
      tenantId,
      consentJobId(kind, tenantId),
      `consent/${kind}`,
      before.config,
      before.status,
    ]
  );
  return written.rowsAffected === 1;
}

export async function runConsentMaintenanceTenants(
  env: Env,
  kind: ConsentMaintenanceKind,
  log: { warn(message: string, meta?: Record<string, unknown>): void },
  run: (metadata: DatabaseAdapter, tenantId: string, stores: ConsentJobStore[]) => Promise<void>
): Promise<void> {
  const cursorStore = env.AUTHRIM_CONFIG ?? env.KV;
  if (!cursorStore) throw new Error(`consent_${kind}_directory_unavailable`);
  const key = `jobs:consent-${kind}:tenant-cursor`;
  const limit = await consentJobSetting(
    env,
    `CONSENT_${kind.replaceAll('-', '_').toUpperCase()}_TENANT_PAGE_SIZE`,
    4,
    32
  );
  const afterTenantId = (await cursorStore.get(key)) ?? '';
  const tenants = env.TENANT_RUNTIME_REGISTRY
    ? // The directory takes an absent cursor as undefined; an empty string is an invalid cursor.
      (
        await listEnvironmentTenantDefaultStores(env, {
          limit,
          afterTenantId: afterTenantId || undefined,
        })
      ).map((t) => ({
        tenantId: t.tenantId,
        metadata: ensureDatabaseAdapter(t.store.source, `consent-${kind}`),
      }))
    : (
        await ensureDatabaseAdapter(env.DB, `consent-${kind}`).query<{ tenant_id: string }>(
          'SELECT id AS tenant_id FROM tenants WHERE id>? ORDER BY id LIMIT ?',
          [afterTenantId, limit]
        )
      ).map((t) => ({
        tenantId: t.tenant_id,
        metadata: ensureDatabaseAdapter(env.DB, `consent-${kind}`),
      }));
  for (const tenant of tenants) {
    try {
      const stores = env.TENANT_RUNTIME_REGISTRY
        ? await tenantCoreStores(env, tenant.tenantId, {
            accountsOfRoutedTenant: true,
            purpose: `consent-${kind}`,
          })
        : [{ bindingRef: 'tenant-default', adapter: tenant.metadata }];
      await run(tenant.metadata, tenant.tenantId, stores);
    } catch (error) {
      log.warn(`Consent ${kind} remains pending`, {
        tenantId: tenant.tenantId,
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    }
  }
  await cursorStore.put(key, tenants.length === limit ? tenants[tenants.length - 1].tenantId : '');
}
