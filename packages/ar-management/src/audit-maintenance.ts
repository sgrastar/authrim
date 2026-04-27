import type { AuditProfile, AuditTarget, Env, IAuditStorageAdapter, Logger } from '@authrim/ar-lib-core';
import {
  createAuditPrimaryStorageAdapter,
  createLogger,
  resolveTenantRuntimeProfilesFromEnv,
  ensureDatabaseAdapter,
} from '@authrim/ar-lib-core';

export interface AuditPrimaryCleanupSummary {
  tenantCount: number;
  processedTenants: number;
  archiveOnlyTenants: number;
  pendingSupportTenants: number;
  eventDeleted: number;
  piiDeleted: number;
}

export interface CleanupResolvedAuditPrimariesOptions {
  tenantIds?: string[];
  batchSize?: number;
  logger?: Logger;
  resolveAuditProfile?: (tenantId: string) => Promise<AuditProfile>;
  d1EventAdapter?: IAuditStorageAdapter;
  d1PiiAdapter?: IAuditStorageAdapter;
  createPrimaryAdapter?: (
    target: AuditTarget,
    logType: 'event' | 'pii'
  ) => Promise<IAuditStorageAdapter | null>;
}

async function listTenantIds(env: Env): Promise<string[]> {
  const adapter = ensureDatabaseAdapter(env.DB, 'audit-maintenance');
  const rows = await adapter.query<{ id: string }>('SELECT id FROM tenants ORDER BY id ASC');
  return rows.map((row) => row.id);
}

export async function cleanupResolvedAuditPrimaries(
  env: Env,
  options: CleanupResolvedAuditPrimariesOptions = {}
): Promise<AuditPrimaryCleanupSummary> {
  const logger = options.logger ?? createLogger().module('AUDIT-MAINTENANCE');
  const batchSize = options.batchSize ?? 1000;
  const tenantIds = options.tenantIds ?? (await listTenantIds(env));

  const externalAdapterCache = new Map<string, IAuditStorageAdapter | null>();

  const resolveAuditProfile =
    options.resolveAuditProfile ??
    (async (tenantId: string) => {
      const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
      return resolved.auditProfile;
    });

  const createPrimaryAdapter =
    options.createPrimaryAdapter ??
    (async (target: AuditTarget, logType: 'event' | 'pii'): Promise<IAuditStorageAdapter | null> => {
      const cacheKey = JSON.stringify({ target, logType });
      if (externalAdapterCache.has(cacheKey)) {
        return externalAdapterCache.get(cacheKey) ?? null;
      }

      const adapter = createAuditPrimaryStorageAdapter(
        env as unknown as Record<string, unknown>,
        target,
        logType,
        {
          id:
            ('connectionRef' in target ? target.connectionRef : undefined) ??
            ('bindingRef' in target ? target.bindingRef : undefined) ??
            `scheduled-${logType}-${target.type}`,
        }
      );
      if (!adapter) {
        externalAdapterCache.set(cacheKey, null);
        return null;
      }
      externalAdapterCache.set(cacheKey, adapter);
      return adapter;
    });

  const summary: AuditPrimaryCleanupSummary = {
    tenantCount: tenantIds.length,
    processedTenants: 0,
    archiveOnlyTenants: 0,
    pendingSupportTenants: 0,
    eventDeleted: 0,
    piiDeleted: 0,
  };

  try {
    for (const tenantId of tenantIds) {
      let profile: AuditProfile;
      try {
        profile = await resolveAuditProfile(tenantId);
      } catch (error) {
        summary.pendingSupportTenants += 1;
        logger.warn('audit_profile_resolve_failed_for_cleanup', {
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (!profile.primary) {
        summary.archiveOnlyTenants += 1;
        continue;
      }

      let eventAdapter: IAuditStorageAdapter | null;
      let piiAdapter: IAuditStorageAdapter | null;

      if (profile.primary.type === 'd1') {
        eventAdapter =
          options.d1EventAdapter ??
          createAuditPrimaryStorageAdapter(
            env as unknown as Record<string, unknown>,
            profile.primary,
            'event',
            { id: 'scheduled-d1-event-cleanup' }
          );
        piiAdapter =
          options.d1PiiAdapter ??
          createAuditPrimaryStorageAdapter(
            env as unknown as Record<string, unknown>,
            profile.primary,
            'pii',
            { id: 'scheduled-d1-pii-cleanup' }
          );
      } else {
        eventAdapter = await createPrimaryAdapter(profile.primary, 'event');
        piiAdapter = await createPrimaryAdapter(profile.primary, 'pii');
      }

      if (!eventAdapter || !piiAdapter) {
        summary.pendingSupportTenants += 1;
        logger.warn('audit_primary_cleanup_not_supported', {
          tenantId,
          auditProfileId: profile.id,
          primaryType: profile.primary.type,
        });
        continue;
      }

      summary.eventDeleted += await eventAdapter.deleteByRetention(
        'event',
        Date.now(),
        tenantId,
        batchSize
      );
      summary.piiDeleted += await piiAdapter.deleteByRetention(
        'pii',
        Date.now(),
        tenantId,
        batchSize
      );
      summary.processedTenants += 1;
    }
  } finally {
    await Promise.all(
      Array.from(externalAdapterCache.values()).map(async (adapter) => {
        if (adapter) {
          await adapter.close();
        }
      })
    );
  }

  return summary;
}
