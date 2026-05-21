import type { AuditProfile, Env, EventLogEntry } from '@authrim/ar-lib-core';
import {
  createR2AuditAdapter,
  extractAuditEntryFromCanonicalPayload,
  readR2ObjectTextWithLimit,
  resolveTenantRuntimeProfilesFromEnv,
} from '@authrim/ar-lib-core';
import { createLoggingTenantKeyResolverFromSource } from './logging-tenant-key';

const AUDIT_ARCHIVE_OBJECT_READ_MAX_BYTES = 10 * 1024 * 1024;

export type AuditArchiveQueryStatus = 'supported' | 'not_supported' | 'pending_runtime_support';

export interface AuditArchiveQueryContext {
  adapter: ReturnType<typeof createR2AuditAdapter>;
  bucket: R2Bucket;
  prefix: string;
  auditProfileId: string;
}

export interface AuditArchiveQuerySupport {
  supported: boolean;
  status: AuditArchiveQueryStatus;
  auditProfileId: string;
  reason?: string;
  context?: AuditArchiveQueryContext;
}

export interface AuditArchiveListOptions {
  tenantId: string;
  page: number;
  limit: number;
  startTime?: number;
  endTime?: number;
  eventType?: string;
  anonymizedUserId?: string;
  resourceType?: string;
  resourceId?: string;
}

export interface AuditArchiveListResult {
  entries: EventLogEntry[];
  total: number;
  totalPages: number;
}

function getR2BucketBinding(env: Env, bucketRef: string): R2Bucket | null {
  const binding = env[bucketRef as keyof Env];
  if (!binding || typeof binding !== 'object') {
    return null;
  }
  if (!('get' in binding) || !('list' in binding)) {
    return null;
  }
  return binding as R2Bucket;
}

function normalizeArchivePrefix(prefix: string | undefined): string {
  return (prefix ?? 'audit').replace(/^\/+|\/+$/g, '') || 'audit';
}

export function getAuditArchiveQuerySupportForProfile(
  env: Env,
  auditProfile: AuditProfile
): AuditArchiveQuerySupport {
  if (auditProfile.primary) {
    return {
      supported: false,
      status: 'not_supported',
      auditProfileId: auditProfile.id,
      reason: 'primary-backed audit profiles should use hot query access instead of archive query',
    };
  }

  if (!auditProfile.archive || auditProfile.archive.type !== 'r2') {
    return {
      supported: false,
      status: 'not_supported',
      auditProfileId: auditProfile.id,
      reason: 'archive-only audit queries currently require an R2 archive target',
    };
  }

  const bucket = getR2BucketBinding(env, auditProfile.archive.bucketRef);
  if (!bucket) {
    return {
      supported: false,
      status: 'pending_runtime_support',
      auditProfileId: auditProfile.id,
      reason: `archive bucket binding was not resolved: ${auditProfile.archive.bucketRef}`,
    };
  }

  const prefix = normalizeArchivePrefix(auditProfile.archive.prefix);
  const tenantKeyResolver = createLoggingTenantKeyResolverFromSource(
    env.DB,
    'audit-archive-query-tenant-key'
  );
  return {
    supported: true,
    status: 'supported',
    auditProfileId: auditProfile.id,
    context: {
      adapter: createR2AuditAdapter(bucket, {
        id: `archive:${auditProfile.archive.bucketRef}`,
        pathPrefix: prefix,
        format: 'json',
        ...(tenantKeyResolver ? ({ tenantKeyResolver } as Record<string, unknown>) : {}),
      }),
      bucket,
      prefix,
      auditProfileId: auditProfile.id,
    },
  };
}

export async function getAuditArchiveQuerySupport(
  env: Env,
  tenantId: string
): Promise<AuditArchiveQuerySupport> {
  const resolved = await resolveTenantRuntimeProfilesFromEnv(env, tenantId);
  return getAuditArchiveQuerySupportForProfile(env, resolved.auditProfile);
}

function matchesArchiveResourceFilter(
  entry: EventLogEntry,
  resourceType?: string,
  resourceId?: string
): boolean {
  if (!resourceType && !resourceId) {
    return true;
  }

  let details: Record<string, unknown> | null = null;
  if (entry.detailsJson) {
    try {
      const parsed = JSON.parse(entry.detailsJson) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        details = parsed as Record<string, unknown>;
      }
    } catch {
      details = null;
    }
  }

  const entryResourceType =
    typeof details?.resourceType === 'string'
      ? details.resourceType
      : typeof details?.resource_type === 'string'
        ? details.resource_type
        : entry.eventCategory;
  const entryResourceId =
    typeof details?.resourceId === 'string'
      ? details.resourceId
      : typeof details?.resource_id === 'string'
        ? details.resource_id
        : (entry.clientId ?? null);

  if (resourceType && entryResourceType !== resourceType) {
    return false;
  }
  if (resourceId && entryResourceId !== resourceId) {
    return false;
  }
  return true;
}

function matchesArchiveListFilters(entry: EventLogEntry, options: AuditArchiveListOptions): boolean {
  if (options.startTime !== undefined && entry.createdAt < options.startTime) {
    return false;
  }
  if (options.endTime !== undefined && entry.createdAt >= options.endTime) {
    return false;
  }
  if (options.eventType && entry.eventType !== options.eventType) {
    return false;
  }
  if (
    options.anonymizedUserId &&
    'anonymizedUserId' in entry &&
    entry.anonymizedUserId !== options.anonymizedUserId
  ) {
    return false;
  }
  return matchesArchiveResourceFilter(entry, options.resourceType, options.resourceId);
}

function parseArchiveEventLogEntries(text: string): EventLogEntry[] {
  const lines = text.trim().split('\n').filter(Boolean);
  const payloads = lines.length > 1 ? lines : [text];
  const entries: EventLogEntry[] = [];

  for (const payload of payloads) {
    const entry = parseArchiveEventLogEntry(payload);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

async function scanRawTenantArchivePath(
  context: AuditArchiveQueryContext,
  options: AuditArchiveListOptions
): Promise<EventLogEntry[]> {
  const prefix = `${context.prefix.replace(/\/$/, '')}/event/${options.tenantId}/`;
  const entries: EventLogEntry[] = [];
  let cursor: string | undefined;

  for (;;) {
    const listed = await context.bucket.list({
      prefix,
      cursor,
      limit: 1000,
    });

    for (const object of listed.objects) {
      const candidate = await context.bucket.get(object.key);
      if (!candidate) {
        continue;
      }
      entries.push(
        ...parseArchiveEventLogEntries(
          await readR2ObjectTextWithLimit(candidate, AUDIT_ARCHIVE_OBJECT_READ_MAX_BYTES)
        )
      );
    }

    if (!listed.truncated || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return entries;
}

export async function listArchiveAuditEvents(
  context: AuditArchiveQueryContext,
  options: AuditArchiveListOptions
): Promise<AuditArchiveListResult> {
  const scanLimit = Math.max(options.page * options.limit, 200);
  const result = await context.adapter.query({
    tenantId: options.tenantId,
    logType: 'event',
    startTime: options.startTime,
    endTime: options.endTime,
    eventType: options.eventType,
    anonymizedUserId: options.anonymizedUserId,
    limit: scanLimit,
    offset: 0,
    sortOrder: 'desc',
  });

  const rawTenantEntries = await scanRawTenantArchivePath(context, options);
  const byId = new Map<string, EventLogEntry>();

  for (const entry of [...(result.eventEntries ?? []), ...rawTenantEntries]) {
    if (!matchesArchiveListFilters(entry, options)) {
      continue;
    }
    byId.set(entry.id, entry);
  }

  const filtered = Array.from(byId.values())
    .sort((left, right) => right.createdAt - left.createdAt);

  const offset = (options.page - 1) * options.limit;
  const paged = filtered.slice(offset, offset + options.limit);
  return {
    entries: paged,
    total: filtered.length,
    totalPages: Math.ceil(filtered.length / options.limit),
  };
}

function parseArchiveEventLogEntry(text: string): EventLogEntry | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const extracted = extractAuditEntryFromCanonicalPayload(parsed) ?? parsed;
    if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) {
      return null;
    }
    if (!('id' in extracted) || !('tenantId' in extracted) || !('eventType' in extracted)) {
      return null;
    }
    return extracted as EventLogEntry;
  } catch {
    return null;
  }
}

export async function getArchiveAuditEventById(
  context: AuditArchiveQueryContext,
  tenantId: string,
  entryId: string
): Promise<EventLogEntry | null> {
  const prefix = `${context.prefix.replace(/\/$/, '')}/event/${tenantId}/`;
  let cursor: string | undefined;

  for (;;) {
    const listed = await context.bucket.list({
      prefix,
      cursor,
      limit: 1000,
    });

    for (const object of listed.objects) {
      const candidate = await context.bucket.get(object.key);
      if (!candidate) {
        continue;
      }
      const entry = parseArchiveEventLogEntry(
        await readR2ObjectTextWithLimit(candidate, AUDIT_ARCHIVE_OBJECT_READ_MAX_BYTES)
      );
      if (entry?.id === entryId) {
        return entry;
      }
    }

    if (!listed.truncated || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return null;
}
