import type { AuditProfile, AuditTarget } from '../../types/runtime-profile';
import type { AuditBackendConfig, AuditRetentionConfig, AuditStorageConfig } from './storage';
import { DEFAULT_AUDIT_STORAGE_CONFIG } from './storage';

function targetDatasetForBinding(bindingRef: string | undefined): string {
  if (bindingRef === 'DB_PII') {
    return 'pii_log';
  }
  if (bindingRef === 'DB_ADMIN') {
    return 'admin_audit_log';
  }
  return 'event_log';
}

export function targetToBackendId(target: AuditTarget | null | undefined): string | null {
  if (!target) {
    return null;
  }

  if (target.type === 'd1') {
    if (target.bindingRef === 'DB') {
      return 'd1-core';
    }
    if (target.bindingRef === 'DB_PII') {
      return 'd1-pii';
    }
    if (target.bindingRef === 'DB_ADMIN') {
      return 'd1-admin';
    }
    return 'd1';
  }

  if (target.type === 'postgres' || target.type === 'mysql') {
    return target.connectionRef ?? `${target.type}-primary`;
  }

  if (target.type === 'r2') {
    return `r2:${target.bucketRef}`;
  }

  if (target.type === 'logpush') {
    return `logpush:${target.destinationRef}`;
  }

  if (target.type === 'firehose') {
    return `firehose:${target.streamRef}`;
  }

  if (target.type === 'http') {
    return `http:${target.urlRef ?? target.url ?? 'sink'}`;
  }

  return null;
}

export function auditTargetFromBackendConfig(backend: AuditBackendConfig): AuditTarget | null {
  if (!backend.enabled) {
    return null;
  }

  if (backend.type === 'D1') {
    const bindingRef = backend.d1Config?.binding;
    if (!bindingRef) {
      return null;
    }
    return {
      type: 'd1',
      bindingRef,
      dataset: targetDatasetForBinding(bindingRef),
    };
  }

  if (backend.type === 'HYPERDRIVE') {
    return {
      type: backend.hyperdriveConfig?.driver ?? 'postgres',
      connectionRef: backend.hyperdriveConfig?.binding || backend.id,
      dataset: 'event_log',
    };
  }

  if (backend.type === 'R2') {
    const binding = backend.r2Config?.binding;
    if (!binding) {
      return null;
    }
    return {
      type: 'r2',
      bucketRef: binding,
      prefix: backend.r2Config?.pathPrefix,
    };
  }

  if (backend.type === 'LOGPUSH') {
    const destinationRef = backend.logpushConfig?.destinationRef;
    if (!destinationRef) {
      return null;
    }
    return {
      type: 'logpush',
      destinationRef,
      ...(backend.logpushConfig?.dataset ? { dataset: backend.logpushConfig.dataset } : {}),
    };
  }

  const streamRef = backend.firehoseConfig?.streamRef;
  if (backend.type === 'FIREHOSE') {
    if (!streamRef) {
      return null;
    }
    return {
      type: 'firehose',
      streamRef,
    };
  }

  if (backend.type === 'HTTP') {
    const url = backend.httpConfig?.url;
    const urlRef = backend.httpConfig?.urlRef;
    if (!url && !urlRef) {
      return null;
    }
    return {
      type: 'http',
      ...(url ? { url } : {}),
      ...(urlRef ? { urlRef } : {}),
      ...(backend.httpConfig?.authTokenRef
        ? { authTokenRef: backend.httpConfig.authTokenRef }
        : {}),
      ...(backend.httpConfig?.headers ? { headers: backend.httpConfig.headers } : {}),
      ...(backend.httpConfig?.method ? { method: backend.httpConfig.method } : {}),
      ...(backend.httpConfig?.format ? { format: backend.httpConfig.format } : {}),
    };
  }

  return null;
}

export function buildAuditStorageBackendsFromProfile(
  profile: AuditProfile,
  baseBackends: AuditBackendConfig[] = DEFAULT_AUDIT_STORAGE_CONFIG.backends
): AuditBackendConfig[] {
  const backends = [...baseBackends];
  const seen = new Set(backends.map((backend) => backend.id));

  const maybePush = (backend: AuditBackendConfig) => {
    if (seen.has(backend.id)) {
      return;
    }
    seen.add(backend.id);
    backends.push(backend);
  };

  if (profile.primary) {
    const id = targetToBackendId(profile.primary);
    if (id && (profile.primary.type === 'postgres' || profile.primary.type === 'mysql')) {
      maybePush({
        id,
        type: 'HYPERDRIVE',
        enabled: true,
        priority: 1,
        hyperdriveConfig: {
          binding: profile.primary.connectionRef ?? id,
          driver: profile.primary.type,
          schema: 'public',
        },
      });
    }
  }

  if (profile.archive?.type === 'r2') {
    maybePush({
      id: targetToBackendId(profile.archive)!,
      type: 'R2',
      enabled: true,
      priority: 2,
      r2Config: {
        binding: profile.archive.bucketRef,
        pathPrefix: profile.archive.prefix ?? 'audit/',
        format: 'jsonl',
      },
    });
  }

  for (const sink of profile.sinks) {
    if (sink.type === 'logpush') {
      maybePush({
        id: targetToBackendId(sink)!,
        type: 'LOGPUSH',
        enabled: true,
        priority: 3,
        logpushConfig: {
          destinationRef: sink.destinationRef,
          dataset: sink.dataset,
        },
      });
    } else if (sink.type === 'firehose') {
      maybePush({
        id: targetToBackendId(sink)!,
        type: 'FIREHOSE',
        enabled: true,
        priority: 3,
        firehoseConfig: {
          streamRef: sink.streamRef,
        },
      });
    } else if (sink.type === 'http') {
      maybePush({
        id: targetToBackendId(sink)!,
        type: 'HTTP',
        enabled: true,
        priority: 3,
        httpConfig: {
          ...(sink.url ? { url: sink.url } : {}),
          ...(sink.urlRef ? { urlRef: sink.urlRef } : {}),
          ...(sink.authTokenRef ? { authTokenRef: sink.authTokenRef } : {}),
          ...(sink.headers ? { headers: sink.headers } : {}),
          ...(sink.method ? { method: sink.method } : {}),
          ...(sink.format ? { format: sink.format } : {}),
        },
      });
    }
  }

  return backends;
}

export function buildPrimaryBackendMap(
  profile: AuditProfile,
  requestedBackends?: AuditBackendConfig[]
): Map<string, AuditTarget | null> {
  const mapping = new Map<string, AuditTarget | null>([['archive-only', null]]);

  if (profile.primary?.type === 'd1') {
    const logicalD1Primary: AuditTarget = {
      type: 'd1',
      bindingRef: 'DB',
      dataset: 'event_log',
    };
    mapping.set('d1-core', {
      ...logicalD1Primary,
    });
    mapping.set('d1-pii', {
      ...logicalD1Primary,
    });
  }

  const addBackend = (backend: AuditBackendConfig) => {
    const target = auditTargetFromBackendConfig(backend);
    if (target && (target.type === 'd1' || target.type === 'postgres' || target.type === 'mysql')) {
      mapping.set(backend.id, target);
    }
  };

  for (const backend of buildAuditStorageBackendsFromProfile(profile)) {
    addBackend(backend);
  }
  for (const backend of requestedBackends ?? []) {
    addBackend(backend);
  }

  return mapping;
}

export function buildAuditStorageConfigFromProfile(
  profile: AuditProfile,
  options: {
    retentionConfig?: AuditRetentionConfig;
    routingRules?: AuditStorageConfig['routingRules'];
    batchConfig?: AuditStorageConfig['batchConfig'];
  } = {}
): AuditStorageConfig {
  const primaryEventBackendId =
    profile.primary?.type === 'd1'
      ? 'd1-core'
      : (targetToBackendId(profile.primary) ?? 'archive-only');
  const primaryPiiBackendId =
    profile.primary?.type === 'd1'
      ? 'd1-pii'
      : (targetToBackendId(profile.primary) ?? 'archive-only');
  const profileRetention = profile.retention;
  const retentionConfig = options.retentionConfig ?? {
    eventLogRetentionDays:
      profileRetention?.eventLogRetentionDays ??
      profileRetention?.primaryDays ??
      DEFAULT_AUDIT_STORAGE_CONFIG.defaultRetention.eventLogRetentionDays,
    piiLogRetentionDays:
      profileRetention?.piiLogRetentionDays ??
      profileRetention?.primaryDays ??
      DEFAULT_AUDIT_STORAGE_CONFIG.defaultRetention.piiLogRetentionDays,
    archiveBeforeDelete:
      profileRetention?.archiveBeforeDelete ??
      DEFAULT_AUDIT_STORAGE_CONFIG.defaultRetention.archiveBeforeDelete,
    ...(profileRetention?.minimumRetentionDays != null
      ? { minimumRetentionDays: profileRetention.minimumRetentionDays }
      : {}),
  };

  return {
    backends: buildAuditStorageBackendsFromProfile(profile),
    defaultEventBackend: primaryEventBackendId,
    defaultPiiBackend: primaryPiiBackendId,
    defaultRetention: retentionConfig,
    routingRules: options.routingRules ?? [],
    batchConfig: options.batchConfig ?? DEFAULT_AUDIT_STORAGE_CONFIG.batchConfig,
  };
}
