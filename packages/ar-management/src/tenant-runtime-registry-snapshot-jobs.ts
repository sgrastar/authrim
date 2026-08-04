import {
  ensureDatabaseAdapter,
  publishTenantRuntimeRegistrySnapshot,
  TenantDatabaseRegistryRepository,
  type Env,
  type TenantDatabaseRegistryRow,
} from '@authrim/ar-lib-core';
import { createControlRuntimeRegistrySigner } from './control-runtime-registry-signer';
import { resolveTenantRuntimePlacementSnapshot } from './tenant-runtime-placement';

interface TenantRuntimeRegistrySnapshotJobLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export interface TenantRuntimeRegistrySnapshotRefreshSummary {
  scanned: number;
  published: number;
  skipped: number;
  failed: number;
}

export interface TenantRuntimeRegistrySnapshotRefreshOptions {
  limit?: number;
  now?: Date;
  actorId?: string;
}

const DEFAULT_TENANT_RUNTIME_REGISTRY_SNAPSHOT_LIMIT = 25;
const DEFAULT_SNAPSHOT_REFRESH_WINDOW_MS = 10 * 60 * 1000;
export const TENANT_RUNTIME_REGISTRY_REFRESH_CRON = '*/2 * * * *';

export function isTenantRuntimeRegistryRefreshCron(cron: string): boolean {
  return cron === TENANT_RUNTIME_REGISTRY_REFRESH_CRON;
}

function getDeploymentTarget(env: Env): string | null {
  return (env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string }).AUTHRIM_DEPLOYMENT_TARGET ?? null;
}

function createEmptySummary(): TenantRuntimeRegistrySnapshotRefreshSummary {
  return {
    scanned: 0,
    published: 0,
    skipped: 0,
    failed: 0,
  };
}

async function listAllActiveCoreRows(
  repository: TenantDatabaseRegistryRepository,
  batchSize: number
): Promise<TenantDatabaseRegistryRow[]> {
  const rows: TenantDatabaseRegistryRow[] = [];
  for (let offset = 0; ; offset += batchSize) {
    const page = await repository.listActiveRegistryRowsForRole('tenant_core', batchSize, offset);
    rows.push(...page);
    if (page.length < batchSize) {
      break;
    }
  }
  return rows;
}

async function shouldPublishSnapshot(input: {
  repository: TenantDatabaseRegistryRepository;
  tenantId: string;
  deploymentTarget: string | null;
  now: Date;
  rows: Array<{ tenant_id: string; status: string }>;
}): Promise<boolean> {
  if (input.rows.some((row) => row.status === 'degraded_pending_snapshot')) {
    return true;
  }

  const snapshot = await input.repository.getLatestRuntimeRegistrySnapshot(
    input.tenantId,
    input.deploymentTarget?.trim() || 'default'
  );
  if (!snapshot) {
    return true;
  }

  const expiresAt = Date.parse(snapshot.expires_at);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }

  return expiresAt - input.now.getTime() <= DEFAULT_SNAPSHOT_REFRESH_WINDOW_MS;
}

export async function refreshTenantRuntimeRegistrySnapshots(
  env: Env,
  logger: TenantRuntimeRegistrySnapshotJobLogger,
  options: TenantRuntimeRegistrySnapshotRefreshOptions = {}
): Promise<TenantRuntimeRegistrySnapshotRefreshSummary> {
  const summary = createEmptySummary();
  if (!env.DB_ADMIN) {
    logger.warn(
      'Tenant runtime registry snapshot refresh skipped because DB_ADMIN is not configured'
    );
    return summary;
  }
  if (!env.TENANT_RUNTIME_REGISTRY) {
    logger.warn(
      'Tenant runtime registry snapshot refresh skipped because TENANT_RUNTIME_REGISTRY is not configured'
    );
    return summary;
  }

  const repository = new TenantDatabaseRegistryRepository(
    ensureDatabaseAdapter(env.DB_ADMIN, 'tenant-runtime-registry-snapshot-control')
  );
  const rows = await listAllActiveCoreRows(
    repository,
    options.limit ?? DEFAULT_TENANT_RUNTIME_REGISTRY_SNAPSHOT_LIMIT
  );
  const tenantIds = Array.from(new Set(rows.map((row) => row.tenant_id))).sort();
  const deploymentTarget = getDeploymentTarget(env);
  const now = options.now ?? new Date();
  summary.scanned = tenantIds.length;

  for (const tenantId of tenantIds) {
    try {
      const tenantRows = rows.filter((row) => row.tenant_id === tenantId);
      const shouldPublish = await shouldPublishSnapshot({
        repository,
        tenantId,
        deploymentTarget,
        now,
        rows: tenantRows,
      });
      if (!shouldPublish) {
        summary.skipped += 1;
        continue;
      }

      await publishTenantRuntimeRegistrySnapshot({
        tenantId,
        placement: await resolveTenantRuntimePlacementSnapshot(env, tenantId),
        repository,
        snapshotStore: env.TENANT_RUNTIME_REGISTRY,
        deploymentTarget,
        now,
        actorId: options.actorId ?? 'tenant-runtime-registry-snapshot',
        externalSigner: await createControlRuntimeRegistrySigner(env),
      });
      summary.published += 1;
    } catch (error) {
      summary.failed += 1;
      logger.warn('Tenant runtime registry snapshot refresh failed', {
        tenant_id: tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (summary.scanned > 0) {
    logger.info('Tenant runtime registry snapshot refresh completed', { ...summary });
  }

  return summary;
}
