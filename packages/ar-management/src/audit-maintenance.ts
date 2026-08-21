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
  createLogger,
  ensureDatabaseAdapter,
  resolveTenantRuntimeProfilesFromEnv,
  SqlLogChunkCatalogStore,
} from '@authrim/ar-lib-core';
import {
  deriveLogChunkEncryptionKey,
  writeLogChunkToR2,
  type LogChunkRecord,
} from '@authrim/ar-lib-logging/chunks';
import { deriveTenantKeyFromTenantId, type LogType } from '@authrim/ar-lib-logging/contract';
import { createLoggingTenantKeyResolverFromSource } from './logging-tenant-key';

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

async function stableArchiveChunkId(entries: Array<EventLogEntry | PIILogEntry>): Promise<string> {
  const value = entries
    .map((entry) => entry.id)
    .sort()
    .join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `ret_${hex.slice(0, 40)}`;
}

function createEncryptedArchiveAdapter(input: {
  env: Env;
  bucket: R2Bucket;
  target: Extract<AuditTarget, { type: 'r2' }>;
  logType: 'event' | 'pii';
  profile: AuditProfile;
  tenantKeyResolver?: (
    tenantId: string
  ) => string | null | undefined | Promise<string | null | undefined>;
}): IAuditStorageAdapter {
  const writeBatch = async (entries: Array<EventLogEntry | PIILogEntry>) => {
    const startedAt = Date.now();
    if (entries.length === 0) {
      return { success: true, entriesWritten: 0, backend: 'r2-encrypted-chunk', durationMs: 0 };
    }
    if (!input.env.OBJECT_ENCRYPTION_ROOT_KEY) {
      throw new Error('audit_archive_encryption_key_unavailable');
    }
    const tenantId = entries[0].tenantId;
    if (entries.some((entry) => entry.tenantId !== tenantId)) {
      throw new Error('audit_archive_mixed_tenant_batch');
    }
    const tenantKey =
      (await input.tenantKeyResolver?.(tenantId)) ??
      (await deriveTenantKeyFromTenantId(tenantId, input.env.LOGGING_TENANT_KEY_SALT));
    const logType: LogType = input.logType === 'event' ? 'audit' : 'pii';
    const keyVersionText = Number.parseInt(input.env.OBJECT_ENCRYPTION_KEY_VERSION ?? '1', 10);
    const keyVersion =
      Number.isSafeInteger(keyVersionText) && keyVersionText > 0 ? keyVersionText : 1;
    const chunkId = await stableArchiveChunkId(entries);
    const records: LogChunkRecord[] = entries.map((entry) => ({
      id: entry.id,
      eventAt: entry.createdAt,
      payload: buildCanonicalAuditArchiveRecordFromEntry(
        input.target,
        input.logType === 'event' ? 'event_log' : 'pii_log',
        entry,
        tenantKey,
        { emittedAt: Date.now(), auditProfileId: input.profile.id }
      ),
      indexedFields:
        input.logType === 'event'
          ? {
              eventType: (entry as EventLogEntry).eventType,
              eventCategory: (entry as EventLogEntry).eventCategory,
              result: (entry as EventLogEntry).result,
              severity: (entry as EventLogEntry).severity,
            }
          : {
              changeType: (entry as PIILogEntry).changeType,
              actorType: (entry as PIILogEntry).actorType,
            },
    }));
    await writeLogChunkToR2({
      bucket: input.bucket,
      tenantKey,
      logType,
      plane: 'archive',
      prefix: input.target.prefix ?? 'audit',
      indexProfile: logType,
      catalogStore: input.env.DB_ADMIN
        ? new SqlLogChunkCatalogStore(input.env.DB_ADMIN)
        : undefined,
      compression: 'gzip_block',
      chunkId,
      objectCatalogId: `obj_${chunkId}`,
      now: Math.min(...entries.map((entry) => entry.createdAt)),
      encryption: {
        keyBytes: await deriveLogChunkEncryptionKey({
          rootKeyHex: input.env.OBJECT_ENCRYPTION_ROOT_KEY,
          tenantKey,
          logType,
          plane: 'archive',
          keyVersion,
        }),
        encryptionScope: `tenant:${tenantKey}:${logType}:archive`,
        keyVersion,
      },
      records,
    });
    return {
      success: true,
      entriesWritten: entries.length,
      backend: 'r2-encrypted-chunk',
      durationMs: Date.now() - startedAt,
    };
  };

  return {
    writeEventLog: (entry: EventLogEntry) => writeBatch([entry]),
    writeEventLogBatch: (entries: EventLogEntry[]) => writeBatch(entries),
    writePIILog: (entry: PIILogEntry) => writeBatch([entry]),
    writePIILogBatch: (entries: PIILogEntry[]) => writeBatch(entries),
    close: async () => {},
  } as unknown as IAuditStorageAdapter;
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

      if (target.type !== 'r2' || target.bucketRef !== 'AUDIT_ARCHIVE') {
        archiveAdapterCache.set(cacheKey, null);
        return null;
      }

      const bucket = getR2BucketBinding(env, target.bucketRef);
      if (!bucket) {
        archiveAdapterCache.set(cacheKey, null);
        return null;
      }

      const tenantKeyResolver = createLoggingTenantKeyResolverFromSource(
        env.DB,
        'audit-maintenance-tenant-key'
      );
      const adapter = createEncryptedArchiveAdapter({
        env,
        bucket,
        target,
        logType,
        profile,
        tenantKeyResolver,
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
