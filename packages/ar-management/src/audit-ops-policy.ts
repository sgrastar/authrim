import type { AuditProfile, AuditRetentionConfig, AuditStorageConfig } from '@authrim/ar-lib-core';
import {
  AUDIT_FAIL_CLOSED_CATEGORIES,
  AUDIT_FAIL_OPEN_CATEGORIES,
  DEFAULT_AUDIT_WRITE_CONFIG,
} from '@authrim/ar-lib-core';
import type { AuditHotQuerySupport } from './audit-hot-query';

export type AuditFanoutDeliveryMode = 'none' | 'best_effort' | 'queue_retry_until_dlq';
export type AuditPrimaryWriteMode = 'none' | 'sync_request_path';
export type AuditBackpressureMode =
  | 'primary_only'
  | 'queue_fanout'
  | 'fanout_degraded_without_queue';
export type AuditArchiveBeforeDeleteStatus =
  | 'inactive'
  | 'missing_archive_target'
  | 'unsupported_archive_target'
  | 'enforced';
export type AuditCleanupMode =
  | 'archive_only'
  | 'archive_copy_before_delete'
  | 'primary_delete_by_retention'
  | 'pending_runtime_support';

export interface AuditOperationalPolicy {
  retention: {
    source: 'audit_profile';
    eventLogRetentionDays: number;
    piiLogRetentionDays: number;
    minimumRetentionDays: number | null;
    archiveBeforeDelete: boolean;
    archiveBeforeDeleteStatus: AuditArchiveBeforeDeleteStatus;
    note?: string;
  };
  cleanup: {
    mode: AuditCleanupMode;
    primaryRetentionDeleteSupported: boolean;
    archiveOnly: boolean;
    scheduledEventCleanup: boolean;
    scheduledPiiCleanup: boolean;
  };
  retry: {
    primaryWrite: AuditPrimaryWriteMode;
    archiveDelivery: AuditFanoutDeliveryMode;
    sinkDelivery: AuditFanoutDeliveryMode;
    queueConfigured: boolean;
    note?: string;
  };
  backpressure: {
    mode: AuditBackpressureMode;
    queueConfigured: boolean;
    fanoutTargetsConfigured: boolean;
    batchConfig: AuditStorageConfig['batchConfig'];
    note: string;
  };
  eventFailurePolicy: {
    mode: NonNullable<AuditProfile['backpressure']>['mode'];
    tenantOverrideSupported: boolean;
    eventCategoryOverrideStatus: 'reserved';
    failOpenCategories: readonly string[];
    failClosedCategories: readonly string[];
    unknownEventBehavior: 'fail_closed_or_strong_retry';
    note: string;
  };
  queue: {
    binding: string;
    status: 'configured' | 'not_configured';
    transportMaxBatchSize: number;
    retryLimit: number;
    dlqBehavior: 'cloudflare_managed';
    archiveBackupStatus: 'configured' | 'not_configured';
    introspection: 'partial';
    note: string;
  };
  health: {
    primaryTargetConfigured: boolean;
    archiveTargetConfigured: boolean;
    forwardingSinkCount: number;
    queueConfigured: boolean;
    queueArchiveConfigured: boolean;
    hotQuerySupported: boolean;
    healthCheckMode: 'configuration_only';
    note: string;
  };
  deliveryGuarantee: {
    primary: AuditPrimaryWriteMode;
    archive: AuditFanoutDeliveryMode;
    sink: AuditFanoutDeliveryMode;
  };
  warnings: string[];
}

export interface AuditOperationalValidationOptions {
  queueConfigured: boolean;
}

function supportsArchiveRetentionCopy(profile: AuditProfile): boolean {
  return profile.archive?.type === 'r2';
}

export function validateAuditOperationalConstraints(
  profile: AuditProfile,
  options: AuditOperationalValidationOptions
): string[] {
  const { queueConfigured } = options;
  const errors: string[] = [];
  const hasPrimary = Boolean(profile.primary);
  const hasArchiveTarget = Boolean(profile.archive);
  const hasSinkTargets = profile.sinks.length > 0;
  const hasFanoutTargets = hasArchiveTarget || hasSinkTargets;

  if (!hasPrimary && !hasArchiveTarget && !hasSinkTargets) {
    errors.push(
      'Audit profiles must configure at least one delivery target (primary, archive, or sink).'
    );
  }

  if (hasFanoutTargets && !queueConfigured) {
    errors.push('AUDIT_QUEUE must be configured when archive or sink targets are enabled.');
  }

  if (profile.archive && !supportsArchiveRetentionCopy(profile)) {
    errors.push('Only R2 archive targets are currently supported.');
  }

  if (profile.retention?.archiveBeforeDelete) {
    if (!hasPrimary) {
      errors.push('archiveBeforeDelete requires a primary audit store.');
    }
    if (!hasArchiveTarget) {
      errors.push('archiveBeforeDelete requires an archive target.');
    } else if (!supportsArchiveRetentionCopy(profile)) {
      errors.push('archiveBeforeDelete currently requires an R2 archive target.');
    }
  }

  return errors;
}

function resolveArchiveDeliveryMode(
  profile: AuditProfile,
  hasArchiveTarget: boolean
): AuditFanoutDeliveryMode {
  if (!hasArchiveTarget) {
    return 'none';
  }
  return profile.archiveFailureMode === 'gate_cleanup' ? 'queue_retry_until_dlq' : 'best_effort';
}

function resolveSinkDeliveryMode(
  profile: AuditProfile,
  hasSinkTargets: boolean
): AuditFanoutDeliveryMode {
  if (!hasSinkTargets) {
    return 'none';
  }
  return profile.sinkFailureMode === 'retry_until_ttl' ? 'queue_retry_until_dlq' : 'best_effort';
}

export function buildAuditOperationalPolicy(input: {
  profile: AuditProfile;
  resolvedRetention: AuditRetentionConfig;
  batchConfig: AuditStorageConfig['batchConfig'];
  queueConfigured: boolean;
  queueArchiveConfigured?: boolean;
  hotQuery: AuditHotQuerySupport;
}): AuditOperationalPolicy {
  const {
    profile,
    resolvedRetention,
    batchConfig,
    queueConfigured,
    queueArchiveConfigured = false,
    hotQuery,
  } = input;
  const hasArchiveTarget = Boolean(profile.archive);
  const hasSinkTargets = profile.sinks.length > 0;
  const hasFanoutTargets = hasArchiveTarget || hasSinkTargets;
  const archiveDelivery = resolveArchiveDeliveryMode(profile, hasArchiveTarget);
  const sinkDelivery = resolveSinkDeliveryMode(profile, hasSinkTargets);
  const warnings: string[] = [];

  let archiveBeforeDeleteStatus: AuditArchiveBeforeDeleteStatus = 'inactive';
  let archiveBeforeDeleteNote: string | undefined;

  if (resolvedRetention.archiveBeforeDelete) {
    if (!hasArchiveTarget) {
      archiveBeforeDeleteStatus = 'missing_archive_target';
      archiveBeforeDeleteNote =
        'archiveBeforeDelete is enabled, but no archive target is configured on the resolved audit profile.';
      warnings.push(archiveBeforeDeleteNote);
    } else if (!supportsArchiveRetentionCopy(profile)) {
      archiveBeforeDeleteStatus = 'unsupported_archive_target';
      archiveBeforeDeleteNote =
        'archiveBeforeDelete is enabled, but the resolved archive target is not currently supported. Use an R2 archive target.';
      warnings.push(archiveBeforeDeleteNote);
    } else {
      archiveBeforeDeleteStatus = 'enforced';
      archiveBeforeDeleteNote =
        'archiveBeforeDelete is enforced. Scheduled retention cleanup rewrites expiring records to the archive target before deleting them from the primary store.';
    }
  }

  if (hasFanoutTargets && !queueConfigured) {
    warnings.push(
      'Archive or sink fan-out targets are configured, but AUDIT_QUEUE is not bound. Request-path fan-out is skipped in the current implementation.'
    );
  }

  if (hasSinkTargets && profile.sinkFailureMode === 'retry_until_ttl') {
    warnings.push(
      'sinkFailureMode=retry_until_ttl is currently implemented through queue retry/DLQ lifetime rather than retention-time-based retries.'
    );
  }

  const backpressureMode: AuditBackpressureMode = !hasFanoutTargets
    ? 'primary_only'
    : queueConfigured
      ? 'queue_fanout'
      : 'fanout_degraded_without_queue';

  const cleanupMode: AuditCleanupMode = !profile.primary
    ? 'archive_only'
    : hotQuery.supported
      ? resolvedRetention.archiveBeforeDelete && supportsArchiveRetentionCopy(profile)
        ? 'archive_copy_before_delete'
        : 'primary_delete_by_retention'
      : 'pending_runtime_support';

  return {
    retention: {
      source: 'audit_profile',
      eventLogRetentionDays: resolvedRetention.eventLogRetentionDays,
      piiLogRetentionDays: resolvedRetention.piiLogRetentionDays,
      minimumRetentionDays: resolvedRetention.minimumRetentionDays ?? null,
      archiveBeforeDelete: resolvedRetention.archiveBeforeDelete,
      archiveBeforeDeleteStatus,
      ...(archiveBeforeDeleteNote ? { note: archiveBeforeDeleteNote } : {}),
    },
    cleanup: {
      mode: cleanupMode,
      primaryRetentionDeleteSupported: Boolean(profile.primary && hotQuery.supported),
      archiveOnly: !profile.primary,
      scheduledEventCleanup: Boolean(profile.primary && hotQuery.supported),
      scheduledPiiCleanup: Boolean(profile.primary && hotQuery.supported),
    },
    retry: {
      primaryWrite: profile.primary ? 'sync_request_path' : 'none',
      archiveDelivery,
      sinkDelivery,
      queueConfigured,
      ...(hasFanoutTargets
        ? {
            note: queueConfigured
              ? 'Fan-out delivery retries use Cloudflare Queue retry/DLQ semantics.'
              : 'Fan-out targets exist, but AUDIT_QUEUE is unavailable so retries are not possible.',
          }
        : {}),
    },
    backpressure: {
      mode: backpressureMode,
      queueConfigured,
      fanoutTargetsConfigured: hasFanoutTargets,
      batchConfig,
      note:
        backpressureMode === 'primary_only'
          ? 'No archive/sink fan-out targets are configured. Only synchronous primary writes apply.'
          : backpressureMode === 'queue_fanout'
            ? 'Archive/sink fan-out is queue-backed. batchConfig is the current operator-facing queue shaping control.'
            : 'Archive/sink fan-out targets exist, but AUDIT_QUEUE is missing so queue-based backpressure is currently unavailable.',
    },
    eventFailurePolicy: {
      mode: profile.backpressure?.mode ?? 'event_class',
      tenantOverrideSupported: profile.backpressure?.allowTenantOverride ?? true,
      eventCategoryOverrideStatus: 'reserved',
      failOpenCategories: AUDIT_FAIL_OPEN_CATEGORIES,
      failClosedCategories: AUDIT_FAIL_CLOSED_CATEGORIES,
      unknownEventBehavior: 'fail_closed_or_strong_retry',
      note:
        (profile.backpressure?.mode ?? 'event_class') === 'fail_closed_all'
          ? 'All audit events require blocking or strong-retry delivery before reporting success.'
          : 'Audit delivery behavior is selected from the explicit event classification catalog. Event-category runtime overrides are reserved for a future implementation.',
    },
    queue: {
      binding: DEFAULT_AUDIT_WRITE_CONFIG.queueConfig.binding,
      status: queueConfigured ? 'configured' : 'not_configured',
      transportMaxBatchSize: DEFAULT_AUDIT_WRITE_CONFIG.queueConfig.maxBatchSize,
      retryLimit: DEFAULT_AUDIT_WRITE_CONFIG.queueConfig.retryLimit,
      dlqBehavior: 'cloudflare_managed',
      archiveBackupStatus: queueArchiveConfigured ? 'configured' : 'not_configured',
      introspection: 'partial',
      note: queueConfigured
        ? 'Runtime can confirm the queue binding exists, but Cloudflare Queue retry/DLQ policy is not fully introspectable at request time. Reported retry values are Authrim defaults.'
        : 'AUDIT_QUEUE is not bound. Queue-backed archive/sink fan-out and retry semantics are unavailable.',
    },
    health: {
      primaryTargetConfigured: Boolean(profile.primary),
      archiveTargetConfigured: hasArchiveTarget,
      forwardingSinkCount: profile.sinks.length,
      queueConfigured,
      queueArchiveConfigured,
      hotQuerySupported: hotQuery.supported,
      healthCheckMode: 'configuration_only',
      note: 'This reports request-time configuration health. Active adapter probes are available on storage adapters and can be wired into scheduled health checks.',
    },
    deliveryGuarantee: {
      primary: profile.primary ? 'sync_request_path' : 'none',
      archive: archiveDelivery,
      sink: sinkDelivery,
    },
    warnings,
  };
}
