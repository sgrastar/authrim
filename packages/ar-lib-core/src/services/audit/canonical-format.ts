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

export function buildCanonicalAuditBatch(
  target: Extract<AuditTarget, { type: 'http' | 'firehose' }>,
  body: AuditQueueMessage,
  channel: Extract<CanonicalAuditDeliveryChannel, 'http' | 'firehose'>
): CanonicalAuditBatchV1 {
  return {
    ...buildCanonicalPayloadBase(target, body, channel),
    recordType: 'audit_batch',
    records: body.entries.map((entry) =>
      buildCanonicalAuditRecord(target, body, entry, channel)
    ),
  };
}

export function extractAuditEntryFromCanonicalPayload(
  payload: unknown
): EventLogEntry | PIILogEntry | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  if (candidate.schema === AUDIT_CANONICAL_LOG_FORMAT_V1 && candidate.recordType === 'audit_record') {
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

  return null;
}
