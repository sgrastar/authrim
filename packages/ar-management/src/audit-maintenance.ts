import type {
  AuditProfile,
  AuditTarget,
  Env,
  EventLogEntry,
  IAuditStorageAdapter,
  Logger,
  PIILogEntry,
} from '@authrim/ar-lib-core';
import {
  buildCanonicalAuditArchiveRecordFromEntry,
  createAuditPrimaryStorageAdapter,
  createR2AuditAdapter,
  createLogger,
  ensureDatabaseAdapter,
  resolveTenantRuntimeProfilesFromEnv,
} from '@authrim/ar-lib-core';

export interface AuditPrimaryCleanupSummary {
  tenantCount: number;
  processedTenants: number;
  archiveOnlyTenants: number;
  pendingSupportTenants: number;
  archiveCopyFailures: number;
  eventArchived: number;
  piiArchived: number;
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
  createArchiveAdapter?: (
    target: AuditTarget,
    logType: 'event' | 'pii',
    profile: AuditProfile
  ) => Promise<IAuditStorageAdapter | null>;
}

async function listTenantIds(env: Env): Promise<string[]> {
  const adapter = ensureDatabaseAdapter(env.DB, 'audit-maintenance');
  const rows = await adapter.query<{ id: string }>('SELECT id FROM tenants ORDER BY id ASC');
  return rows.map((row) => row.id);
}

function getR2BucketBinding(env: Env, bucketRef: string): R2Bucket | null {
  const binding = (env as unknown as Record<string, unknown>)[bucketRef];
  return binding && typeof binding === 'object' ? (binding as R2Bucket) : null;
}

async function copyRetentionCandidatesToArchive(input: {
  primaryAdapter: IAuditStorageAdapter;
  archiveAdapter: IAuditStorageAdapter;
  logType: 'event' | 'pii';
  beforeTime: number;
  tenantId: string;
  batchSize: number;
}): Promise<{ archived: number; deleted: number; failed: boolean }> {
  const { primaryAdapter, archiveAdapter, logType, beforeTime, tenantId, batchSize } = input;
  if (logType === 'event') {
    const candidates = await primaryAdapter.listTenantRetentionCandidates(
      'event',
      beforeTime,
      tenantId,
      batchSize
    );
    if (candidates.length === 0) {
      return { archived: 0, deleted: 0, failed: false };
    }

    const writeResult = await archiveAdapter.writeEventLogBatch(candidates as EventLogEntry[]);
    if (!writeResult.success || writeResult.entriesWritten < candidates.length) {
      return { archived: 0, deleted: 0, failed: true };
    }

    const deleted = await primaryAdapter.deleteTenantByRetention(
      'event',
      beforeTime,
      tenantId,
      batchSize
    );
    return {
      archived: candidates.length,
      deleted,
      failed: false,
    };
  }

  const candidates = await primaryAdapter.listTenantRetentionCandidates(
    'pii',
    beforeTime,
    tenantId,
    batchSize
  );
  if (candidates.length === 0) {
    return { archived: 0, deleted: 0, failed: false };
  }

  const writeResult = await archiveAdapter.writePIILogBatch(candidates as PIILogEntry[]);
  if (!writeResult.success || writeResult.entriesWritten < candidates.length) {
    return { archived: 0, deleted: 0, failed: true };
  }

  const deleted = await primaryAdapter.deleteTenantByRetention(
    'pii',
    beforeTime,
    tenantId,
    batchSize
  );
  return {
    archived: candidates.length,
    deleted,
    failed: false,
  };
}

export async function cleanupResolvedAuditPrimaries(
  env: Env,
  options: CleanupResolvedAuditPrimariesOptions = {}
): Promise<AuditPrimaryCleanupSummary> {
  const logger = options.logger ?? createLogger().module('AUDIT-MAINTENANCE');
  const batchSize = options.batchSize ?? 1000;
  const tenantIds = options.tenantIds ?? (await listTenantIds(env));

  const externalAdapterCache = new Map<string, IAuditStorageAdapter | null>();
  const archiveAdapterCache = new Map<string, IAuditStorageAdapter | null>();

  const resolveAuditProfile =
    options.resolveAuditProfile ??
    (async (tenantId: string) => {
      const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
      return resolved.auditProfile;
    });

  const createPrimaryAdapter =
    options.createPrimaryAdapter ??
    (async (
      target: AuditTarget,
      logType: 'event' | 'pii'
    ): Promise<IAuditStorageAdapter | null> => {
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

  const createArchiveAdapter =
    options.createArchiveAdapter ??
    (async (target: AuditTarget, logType: 'event' | 'pii', profile: AuditProfile) => {
      const cacheKey = JSON.stringify({
        target,
        logType,
        profileId: profile.id,
        usage: 'archive-retention',
      });
      if (archiveAdapterCache.has(cacheKey)) {
        return archiveAdapterCache.get(cacheKey) ?? null;
      }

      if (target.type !== 'r2') {
        archiveAdapterCache.set(cacheKey, null);
        return null;
      }

      const bucket = getR2BucketBinding(env, target.bucketRef);
      if (!bucket) {
        archiveAdapterCache.set(cacheKey, null);
        return null;
      }

      const emittedAt = Date.now();
      const adapter = createR2AuditAdapter(bucket, {
        id: `retention-archive:${target.bucketRef}:${logType}`,
        pathPrefix: target.prefix ?? 'audit',
        format: 'json',
        eventSerializer: (entry) =>
          buildCanonicalAuditArchiveRecordFromEntry(target, 'event_log', entry, {
            emittedAt,
            auditProfileId: profile.id,
          }),
        piiSerializer: (entry) =>
          buildCanonicalAuditArchiveRecordFromEntry(target, 'pii_log', entry, {
            emittedAt,
            auditProfileId: profile.id,
          }),
      });
      archiveAdapterCache.set(cacheKey, adapter);
      return adapter;
    });

  const summary: AuditPrimaryCleanupSummary = {
    tenantCount: tenantIds.length,
    processedTenants: 0,
    archiveOnlyTenants: 0,
    pendingSupportTenants: 0,
    archiveCopyFailures: 0,
    eventArchived: 0,
    piiArchived: 0,
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
      const now = Date.now();

      if (profile.retention?.archiveBeforeDelete && profile.archive) {
        const eventArchiveAdapter = await createArchiveAdapter(profile.archive, 'event', profile);
        const piiArchiveAdapter = await createArchiveAdapter(profile.archive, 'pii', profile);

        if (!eventArchiveAdapter || !piiArchiveAdapter) {
          summary.pendingSupportTenants += 1;
          logger.warn('audit_archive_cleanup_not_supported', {
            tenantId,
            auditProfileId: profile.id,
            archiveType: profile.archive.type,
          });
          continue;
        }

        const eventResult = await copyRetentionCandidatesToArchive({
          primaryAdapter: eventAdapter,
          archiveAdapter: eventArchiveAdapter,
          logType: 'event',
          beforeTime: now,
          tenantId,
          batchSize,
        });
        if (eventResult.failed) {
          summary.archiveCopyFailures += 1;
          logger.warn('audit_archive_copy_failed_before_delete', {
            tenantId,
            auditProfileId: profile.id,
            logType: 'event',
          });
        } else {
          summary.eventArchived += eventResult.archived;
          summary.eventDeleted += eventResult.deleted;
        }

        const piiResult = await copyRetentionCandidatesToArchive({
          primaryAdapter: piiAdapter,
          archiveAdapter: piiArchiveAdapter,
          logType: 'pii',
          beforeTime: now,
          tenantId,
          batchSize,
        });
        if (piiResult.failed) {
          summary.archiveCopyFailures += 1;
          logger.warn('audit_archive_copy_failed_before_delete', {
            tenantId,
            auditProfileId: profile.id,
            logType: 'pii',
          });
        } else {
          summary.piiArchived += piiResult.archived;
          summary.piiDeleted += piiResult.deleted;
        }
      } else {
        summary.eventDeleted += await eventAdapter.deleteTenantByRetention(
          'event',
          now,
          tenantId,
          batchSize
        );
        summary.piiDeleted += await piiAdapter.deleteTenantByRetention(
          'pii',
          now,
          tenantId,
          batchSize
        );
      }
      summary.processedTenants += 1;
    }
  } finally {
    await Promise.all(
      [
        ...Array.from(externalAdapterCache.values()),
        ...Array.from(archiveAdapterCache.values()),
      ].map(async (adapter) => {
        if (adapter) {
          await adapter.close();
        }
      })
    );
  }

  return summary;
}
