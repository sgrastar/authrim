import { buildArchiveLogRecordV1, type ArchiveLogRecordV1 } from '@authrim/ar-lib-logging/archive';
import type { AuditTarget } from '../../types/runtime-profile';
import type { AuditQueueMessage, AuditQueueMessageType, EventLogEntry, PIILogEntry } from './types';

export const AUDIT_CANONICAL_LOG_FORMAT_V1 = 'authrim.audit.v1' as const;
export type AuditCanonicalLogFormat = typeof AUDIT_CANONICAL_LOG_FORMAT_V1;

export type CanonicalAuditDeliveryChannel = 'archive' | 'logpush' | 'http' | 'firehose';

export interface CanonicalAuditRecordV1<
  TEntry extends EventLogEntry | PIILogEntry = EventLogEntry | PIILogEntry,
> {
  schema: AuditCanonicalLogFormat;
  recordType: 'audit_record';
  emittedAt: string;
  tenantId: string;
  logType: AuditQueueMessageType;
  auditProfileId?: string;
  matchedRuleNames?: string[];
  delivery: {
    channel: CanonicalAuditDeliveryChannel;
    targetType: AuditTarget['type'];
    targetRef?: string;
  };
  entry: TEntry;
}

export interface CanonicalAuditBatchV1<
  TEntry extends EventLogEntry | PIILogEntry = EventLogEntry | PIILogEntry,
> {
  schema: AuditCanonicalLogFormat;
  recordType: 'audit_batch';
  emittedAt: string;
  tenantId: string;
  logType: AuditQueueMessageType;
  auditProfileId?: string;
  matchedRuleNames?: string[];
  delivery: {
    channel: Extract<CanonicalAuditDeliveryChannel, 'http' | 'firehose'>;
    targetType: AuditTarget['type'];
    targetRef?: string;
  };
  records: CanonicalAuditRecordV1<TEntry>[];
}

function targetReferenceForCanonicalPayload(target: AuditTarget): string | undefined {
  if (target.type === 'r2') {
    return target.bucketRef;
  }
  if (target.type === 'logpush') {
    return target.destinationRef;
  }
  if (target.type === 'firehose') {
    return target.streamRef;
  }
  if (target.type === 'http') {
    return target.urlRef ?? (target.url ? 'direct_url' : undefined);
  }
  return target.connectionRef ?? target.bindingRef;
}

function buildCanonicalPayloadBase<TChannel extends CanonicalAuditDeliveryChannel>(
  target: AuditTarget,
  body: AuditQueueMessage,
  channel: TChannel
) {
  return {
    schema: AUDIT_CANONICAL_LOG_FORMAT_V1,
    emittedAt: new Date(body.timestamp).toISOString(),
    tenantId: body.tenantId,
    logType: body.type,
    ...(body.fanout?.auditProfileId ? { auditProfileId: body.fanout.auditProfileId } : {}),
    ...(body.fanout?.matchedRuleNames ? { matchedRuleNames: body.fanout.matchedRuleNames } : {}),
    delivery: {
      channel,
      targetType: target.type,
      ...(targetReferenceForCanonicalPayload(target)
        ? { targetRef: targetReferenceForCanonicalPayload(target) }
        : {}),
    },
  };
}

function parseAffectedFields(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function buildEventArchiveSummary(
  entry: EventLogEntry,
  options?: {
    auditProfileId?: string;
    matchedRuleNames?: string[];
  }
): Record<string, unknown> {
  return {
    audit_record_schema: AUDIT_CANONICAL_LOG_FORMAT_V1,
    audit_log_type: 'event_log',
    event_category: entry.eventCategory,
    event_type: entry.eventType,
    result: entry.result,
    severity: entry.severity,
    ...(entry.errorCode ? { error_code: entry.errorCode } : {}),
    ...(entry.errorMessage ? { error_message: entry.errorMessage } : {}),
    ...(entry.durationMs !== undefined ? { duration_ms: entry.durationMs } : {}),
    ...(entry.clientId ? { client_id: entry.clientId } : {}),
    ...(entry.anonymizedUserId ? { anonymized_user_id: entry.anonymizedUserId } : {}),
    has_inline_detail: Boolean(entry.detailsJson),
    has_sensitive_detail: Boolean(entry.detailsR2Key),
    ...(options?.auditProfileId ? { audit_profile_id: options.auditProfileId } : {}),
    ...(options?.matchedRuleNames ? { matched_rule_names: options.matchedRuleNames } : {}),
  };
}

function buildPiiArchiveSummary(
  entry: PIILogEntry,
  options?: {
    auditProfileId?: string;
    matchedRuleNames?: string[];
  }
): Record<string, unknown> {
  return {
    audit_record_schema: AUDIT_CANONICAL_LOG_FORMAT_V1,
    audit_log_type: 'pii_log',
    anonymized_user_id: entry.anonymizedUserId,
    change_type: entry.changeType,
    affected_fields: parseAffectedFields(entry.affectedFields),
    actor_type: entry.actorType,
    ...(entry.actorUserId ? { actor_user_id: entry.actorUserId } : {}),
    ...(entry.legalBasis ? { legal_basis: entry.legalBasis } : {}),
    ...(entry.consentReference ? { consent_reference: entry.consentReference } : {}),
    has_inline_encrypted_values: Boolean(entry.valuesEncrypted),
    has_sensitive_detail: Boolean(entry.valuesR2Key),
    ...(options?.auditProfileId ? { audit_profile_id: options.auditProfileId } : {}),
    ...(options?.matchedRuleNames ? { matched_rule_names: options.matchedRuleNames } : {}),
  };
}

export function buildCanonicalAuditRecord(
  target: AuditTarget,
  body: AuditQueueMessage,
  entry: EventLogEntry | PIILogEntry,
  channel: CanonicalAuditDeliveryChannel
): CanonicalAuditRecordV1 {
  return {
    ...buildCanonicalPayloadBase(target, body, channel),
    recordType: 'audit_record',
    entry,
  };
}

export function buildCanonicalAuditArchiveRecordFromEntry(
  target: AuditTarget,
  logType: AuditQueueMessageType,
  entry: EventLogEntry | PIILogEntry,
  tenantKey: string,
  options?: {
    emittedAt?: number;
    auditProfileId?: string;
    matchedRuleNames?: string[];
  }
): ArchiveLogRecordV1 {
  const isEvent = logType === 'event_log';
  return buildArchiveLogRecordV1({
    id: entry.id,
    tenantKey,
    logType: isEvent ? 'audit' : 'pii',
    plane: 'archive',
    eventAt: entry.createdAt,
    severity: isEvent ? (entry as EventLogEntry).severity : 'info',
    type: isEvent ? (entry as EventLogEntry).eventType : `pii.${(entry as PIILogEntry).changeType}`,
    source: 'authrim/audit',
    subject: isEvent
      ? ((entry as EventLogEntry).clientId ?? (entry as EventLogEntry).anonymizedUserId ?? null)
      : (entry as PIILogEntry).anonymizedUserId,
    correlationId: isEvent
      ? ((entry as EventLogEntry).requestId ?? (entry as EventLogEntry).sessionId ?? null)
      : ((entry as PIILogEntry).requestId ?? null),
    result: isEvent ? (entry as EventLogEntry).result : (entry as PIILogEntry).changeType,
    summary: isEvent
      ? buildEventArchiveSummary(entry as EventLogEntry, options)
      : buildPiiArchiveSummary(entry as PIILogEntry, options),
    detailRef: isEvent
      ? catalogDetailRef((entry as EventLogEntry).detailsR2Key, 'event_log_detail')
      : catalogDetailRef((entry as PIILogEntry).valuesR2Key, 'pii_log_values'),
    delivery: {
      targetType: target.type,
      targetRef: targetReferenceForCanonicalPayload(target) ?? null,
    },
  });
}

export function buildCanonicalAuditBatch(
  target: Extract<AuditTarget, { type: 'http' | 'firehose' }>,
  body: AuditQueueMessage,
  channel: Extract<CanonicalAuditDeliveryChannel, 'http' | 'firehose'>
): CanonicalAuditBatchV1 {
  return {
    ...buildCanonicalPayloadBase(target, body, channel),
    recordType: 'audit_batch',
    records: body.entries.map((entry) => buildCanonicalAuditRecord(target, body, entry, channel)),
  };
}

export function extractAuditEntryFromCanonicalPayload(
  payload: unknown
): EventLogEntry | PIILogEntry | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  if (
    candidate.schema === AUDIT_CANONICAL_LOG_FORMAT_V1 &&
    candidate.recordType === 'audit_record'
  ) {
    const entry = candidate.entry;
    if (entry && typeof entry === 'object') {
      return entry as EventLogEntry | PIILogEntry;
    }
  }

  if (
    candidate.schema === AUDIT_CANONICAL_LOG_FORMAT_V1 &&
    candidate.recordType === 'audit_batch' &&
    Array.isArray(candidate.records)
  ) {
    const firstRecord = candidate.records[0];
    if (firstRecord && typeof firstRecord === 'object' && 'entry' in firstRecord) {
      const entry = (firstRecord as Record<string, unknown>).entry;
      if (entry && typeof entry === 'object') {
        return entry as EventLogEntry | PIILogEntry;
      }
    }
  }

  if (
    candidate.schema_version === 'authrim.log.archive.v1' &&
    candidate.record_type === 'log_record'
  ) {
    const summary = candidate.summary;
    if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
      const entry = (summary as Record<string, unknown>).entry;
      if (entry && typeof entry === 'object') {
        return entry as EventLogEntry | PIILogEntry;
      }
    }
  }

  return null;
}

function catalogDetailRef(
  ref: string | null | undefined,
  objectClass: string
): ArchiveLogRecordV1['detail_ref'] {
  if (!ref?.startsWith('sensitive-detail-catalog:')) {
    return null;
  }
  const objectCatalogId = ref.slice('sensitive-detail-catalog:'.length);
  return objectCatalogId
    ? {
        object_catalog_id: objectCatalogId,
        class: objectClass,
      }
    : null;
}
