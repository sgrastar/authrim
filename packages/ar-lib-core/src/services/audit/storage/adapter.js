/**
 * Audit Storage Adapter Interface
 *
 * Provides a unified interface for different audit log storage backends:
 * - D1: Hot data storage for recent logs
 * - R2: Archive storage for long-term retention
 * - Hyperdrive: External PostgreSQL for enterprise deployments
 * - Logpush / Firehose: Forwarding sinks for external delivery
 */
function normalizeTargetList(values) {
    if (!Array.isArray(values)) {
        return undefined;
    }
    const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
    return normalized.length > 0 ? normalized : undefined;
}
/**
 * Normalize legacy and partial routing targets into the Phase 4 canonical shape.
 */
export function normalizeAuditStorageRoutingTargets(targets, backend) {
    const primaryStore = targets?.primaryStore?.trim() || backend?.trim() || undefined;
    const archiveStores = normalizeTargetList(targets?.archiveStores);
    const forwardingSinks = normalizeTargetList(targets?.forwardingSinks);
    return {
        ...(primaryStore ? { primaryStore } : {}),
        ...(archiveStores ? { archiveStores } : {}),
        ...(forwardingSinks ? { forwardingSinks } : {}),
    };
}
/**
 * Returns true when the routing rule has at least one effective target.
 */
export function hasAuditStorageRoutingTargets(targets) {
    return Boolean(targets.primaryStore ||
        (targets.archiveStores && targets.archiveStores.length > 0) ||
        (targets.forwardingSinks && targets.forwardingSinks.length > 0));
}
/**
 * Default storage configuration.
 */
export const DEFAULT_AUDIT_STORAGE_CONFIG = {
    backends: [
        {
            id: 'd1-core',
            type: 'D1',
            enabled: true,
            priority: 1,
            d1Config: {
                binding: 'DB',
                isPiiDb: false,
            },
        },
        {
            id: 'd1-pii',
            type: 'D1',
            enabled: true,
            priority: 1,
            d1Config: {
                binding: 'DB_PII',
                isPiiDb: true,
            },
        },
    ],
    defaultEventBackend: 'd1-core',
    defaultPiiBackend: 'd1-pii',
    defaultRetention: {
        eventLogRetentionDays: 90,
        piiLogRetentionDays: 365,
        archiveBeforeDelete: false,
    },
    routingRules: [],
    batchConfig: {
        maxBufferSize: 100,
        flushIntervalMs: 5000,
        maxBatchSize: 100,
    },
};
