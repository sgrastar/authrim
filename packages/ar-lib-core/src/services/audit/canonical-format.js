export const AUDIT_CANONICAL_LOG_FORMAT_V1 = 'authrim.audit.v1';
function targetReferenceForCanonicalPayload(target) {
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
function buildCanonicalPayloadBase(target, body, channel) {
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
export function buildCanonicalAuditRecord(target, body, entry, channel) {
    return {
        ...buildCanonicalPayloadBase(target, body, channel),
        recordType: 'audit_record',
        entry,
    };
}
export function buildCanonicalAuditArchiveRecordFromEntry(target, logType, entry, options) {
    return {
        schema: AUDIT_CANONICAL_LOG_FORMAT_V1,
        recordType: 'audit_record',
        emittedAt: new Date(options?.emittedAt ?? Date.now()).toISOString(),
        tenantId: entry.tenantId,
        logType,
        ...(options?.auditProfileId ? { auditProfileId: options.auditProfileId } : {}),
        ...(options?.matchedRuleNames ? { matchedRuleNames: options.matchedRuleNames } : {}),
        delivery: {
            channel: 'archive',
            targetType: target.type,
            ...(targetReferenceForCanonicalPayload(target)
                ? { targetRef: targetReferenceForCanonicalPayload(target) }
                : {}),
        },
        entry,
    };
}
export function buildCanonicalAuditBatch(target, body, channel) {
    return {
        ...buildCanonicalPayloadBase(target, body, channel),
        recordType: 'audit_batch',
        records: body.entries.map((entry) => buildCanonicalAuditRecord(target, body, entry, channel)),
    };
}
export function extractAuditEntryFromCanonicalPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const candidate = payload;
    if (candidate.schema === AUDIT_CANONICAL_LOG_FORMAT_V1 && candidate.recordType === 'audit_record') {
        const entry = candidate.entry;
        if (entry && typeof entry === 'object') {
            return entry;
        }
    }
    if (candidate.schema === AUDIT_CANONICAL_LOG_FORMAT_V1 &&
        candidate.recordType === 'audit_batch' &&
        Array.isArray(candidate.records)) {
        const firstRecord = candidate.records[0];
        if (firstRecord && typeof firstRecord === 'object' && 'entry' in firstRecord) {
            const entry = firstRecord.entry;
            if (entry && typeof entry === 'object') {
                return entry;
            }
        }
    }
    return null;
}
