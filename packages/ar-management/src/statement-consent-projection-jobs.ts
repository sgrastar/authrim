/** Metadata-owned projection jobs use durable per-shard acknowledgements and bounded fan-out. */
import {
  ensureDatabaseAdapter,
  listEnvironmentTenantDefaultStores,
  projectStatementConsentGeneration,
  type DatabaseAdapter,
  type Env,
  type StatementConsentProjection,
} from '@authrim/ar-lib-core';
import { tenantCoreStores } from './compliance/tenant-stores';

const DEFAULT_PAGE_SIZE = 4;
const DEFAULT_TENANT_PAGE_SIZE = 32;
const CURSOR_KEY = 'jobs:statement-consent-projection:tenant-cursor';

interface ProjectionStore {
  bindingRef: string;
  adapter: DatabaseAdapter;
  /** Trusted registry identity, including physical route generations. */
  identity?: unknown;
}

interface ProjectionJob extends StatementConsentProjection {
  targets_json: string | null;
  cursor_binding_ref: string | null;
}

/** Exposed for real multi-database fault tests; callers resolve stores from the trusted registry. */
export async function projectStatementConsentJobPage(
  metadata: DatabaseAdapter,
  tenantId: string,
  stores: readonly ProjectionStore[],
  pageSize: number
): Promise<void> {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > DEFAULT_TENANT_PAGE_SIZE ||
    !stores.length
  )
    throw new Error('statement_consent_projection_page_invalid');
  const ordered = [...stores].sort((a, b) => a.bindingRef.localeCompare(b.bindingRef));
  if (new Set(ordered.map((store) => store.bindingRef)).size !== ordered.length)
    throw new Error('statement_consent_projection_targets_invalid');
  const targets = JSON.stringify(
    ordered.map((store) => [store.bindingRef, store.identity ?? null])
  );
  const jobs = await metadata.query<ProjectionJob>(
    'SELECT * FROM statement_consent_projection_jobs WHERE tenant_id=? ORDER BY updated_at,statement_id LIMIT ?',
    [tenantId, pageSize]
  );
  for (const raw of jobs) {
    const job = {
      ...raw,
      definition_generation: Number(raw.definition_generation),
      closed_generation: Number(raw.closed_generation),
    };
    const key = [tenantId, job.statement_id, job.definition_generation, job.closed_generation];
    // Rotate pending work even when one shard fails, so it cannot starve later statements.
    const touched = await metadata.execute(
      'UPDATE statement_consent_projection_jobs SET updated_at=? WHERE tenant_id=? AND statement_id=? AND definition_generation=? AND closed_generation=?',
      [Date.now(), ...key]
    );
    if (touched.rowsAffected !== 1) continue;
    let cursor = job.cursor_binding_ref;
    if (job.targets_json !== targets) {
      const reset = await metadata.execute(
        `UPDATE statement_consent_projection_jobs SET targets_json=?,cursor_binding_ref=NULL
         WHERE tenant_id=? AND statement_id=? AND definition_generation=? AND closed_generation=? AND COALESCE(targets_json,'')=?`,
        [targets, ...key, job.targets_json ?? '']
      );
      if (reset.rowsAffected !== 1) continue;
      cursor = null;
    }
    const pending = ordered.filter(
      (store) => cursor === null || store.bindingRef.localeCompare(cursor) > 0
    );
    for (const store of pending.slice(0, pageSize)) {
      await projectStatementConsentGeneration(store.adapter, tenantId, job);
      const acknowledged = await metadata.execute(
        `UPDATE statement_consent_projection_jobs SET cursor_binding_ref=?,updated_at=?
         WHERE tenant_id=? AND statement_id=? AND definition_generation=? AND closed_generation=? AND targets_json=? AND COALESCE(cursor_binding_ref,'')=?`,
        [store.bindingRef, Date.now(), ...key, targets, cursor ?? '']
      );
      if (acknowledged.rowsAffected !== 1) return;
      cursor = store.bindingRef;
    }
    if (pending.length <= pageSize) {
      await metadata.execute(
        `DELETE FROM statement_consent_projection_jobs WHERE tenant_id=? AND statement_id=? AND definition_generation=? AND closed_generation=?
         AND targets_json=? AND COALESCE(cursor_binding_ref,'')=?`,
        [...key, targets, cursor ?? '']
      );
    }
  }
}

async function pageSize(env: Env, name: string, fallback: number): Promise<number> {
  const raw: unknown =
    Reflect.get(env, name) ?? (await env.KV?.get(name.toLowerCase())) ?? fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_TENANT_PAGE_SIZE)
    throw new Error('statement_consent_projection_page_invalid');
  return value;
}

export async function processStatementConsentProjectionJobs(
  env: Env,
  log: { warn(message: string, meta?: Record<string, unknown>): void }
): Promise<void> {
  const size = await pageSize(env, 'STATEMENT_CONSENT_PROJECTION_PAGE_SIZE', DEFAULT_PAGE_SIZE);
  const run = async (metadata: DatabaseAdapter, tenantId: string, stores: ProjectionStore[]) => {
    try {
      await projectStatementConsentJobPage(metadata, tenantId, stores, size);
    } catch (error) {
      log.warn('Statement consent projection remains pending', {
        tenantId,
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    }
  };
  const tenantPageSize = await pageSize(
    env,
    'STATEMENT_CONSENT_PROJECTION_TENANT_PAGE_SIZE',
    DEFAULT_TENANT_PAGE_SIZE
  );
  const cursorStore = env.AUTHRIM_CONFIG ?? env.KV;
  if (!cursorStore) throw new Error('statement_consent_projection_directory_unavailable');
  const afterTenantId = (await cursorStore.get(CURSOR_KEY)) ?? '';
  // Explicit nonrouted deployments keep every tenant in the one Core binding.
  if (!env.TENANT_RUNTIME_REGISTRY) {
    const metadata = ensureDatabaseAdapter(env.DB, 'statement-consent-projection-metadata');
    const tenants = await metadata.query<{ tenant_id: string }>(
      'SELECT DISTINCT tenant_id FROM statement_consent_projection_jobs WHERE tenant_id>? ORDER BY tenant_id LIMIT ?',
      [afterTenantId, tenantPageSize]
    );
    for (const tenant of tenants)
      await run(metadata, tenant.tenant_id, [{ bindingRef: 'tenant-default', adapter: metadata }]);
    await cursorStore.put(
      CURSOR_KEY,
      tenants.length === tenantPageSize ? tenants[tenants.length - 1].tenant_id : ''
    );
    return;
  }
  const tenants = await listEnvironmentTenantDefaultStores(env, {
    limit: tenantPageSize,
    afterTenantId,
  });
  for (const tenant of tenants) {
    const metadata = ensureDatabaseAdapter(
      tenant.store.source,
      'statement-consent-projection-metadata'
    );
    try {
      const stores = await tenantCoreStores(env, tenant.tenantId, {
        accountsOfRoutedTenant: true,
        purpose: 'statement-consent-projection',
      });
      await run(metadata, tenant.tenantId, stores);
    } catch (error) {
      log.warn('Statement consent projection store resolution remains pending', {
        tenantId: tenant.tenantId,
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
    }
  }
  await cursorStore.put(
    CURSOR_KEY,
    tenants.length === tenantPageSize ? tenants[tenants.length - 1].tenantId : ''
  );
}
