/**
 * Runtime Audit / Residency Profile Types
 *
 * Runtime profiles configure audit delivery and residency policy without
 * storing backend credentials directly on tenant settings. D1 placement and
 * routing are owned by the Control Plane and are deliberately not profiles.
 */

export type RuntimeProfileKind = 'audit' | 'residency';

export interface RuntimeProfileBase {
  id: string;
  kind: RuntimeProfileKind;
  label: string;
  description?: string;
  builtin?: boolean;
  version?: number;
  metadata?: Record<string, unknown>;
}

export type AuditTarget =
  | {
      type: 'd1' | 'postgres' | 'mysql';
      destinationId?: string;
      bindingRef?: string;
      connectionRef?: string;
      dataset?: string;
    }
  | {
      type: 'r2';
      destinationId?: string;
      bucketRef: string;
      prefix?: string;
    }
  | {
      type: 'logpush';
      destinationId?: string;
      destinationRef: string;
      dataset?: string;
    }
  | {
      type: 'firehose';
      destinationId?: string;
      streamRef: string;
    }
  | {
      type: 'http';
      destinationId?: string;
      url?: string;
      urlRef?: string;
      authTokenRef?: string;
      method?: 'POST';
      headers?: Record<string, string>;
      format?: 'json';
    };

export interface AuditRetentionPolicy {
  eventLogRetentionDays?: number | null;
  piiLogRetentionDays?: number | null;
  archiveBeforeDelete?: boolean;
  minimumRetentionDays?: number | null;
  primaryDays?: number | null;
  archiveDays?: number | null;
}

export type AuditArchiveFailureMode = 'best_effort' | 'gate_cleanup';
export type AuditSinkFailureMode = 'best_effort' | 'retry_until_ttl';
export type AuditBackpressureFailureMode = 'event_class' | 'fail_closed_all';

export interface AuditBackpressurePolicy {
  /** Request-path behavior when audit delivery is degraded. */
  mode: AuditBackpressureFailureMode;
  /** Whether tenant-level policy may make this stricter or looser. */
  allowTenantOverride?: boolean;
  /** Reserved for future event-category overrides. */
  eventCategoryOverrides?: Record<string, 'inherit' | 'fail_open' | 'fail_closed'>;
}

export interface AuditProfile extends RuntimeProfileBase {
  kind: 'audit';
  primary: AuditTarget | null;
  archive?: AuditTarget | null;
  sinks: AuditTarget[];
  retention?: AuditRetentionPolicy;
  archiveFailureMode?: AuditArchiveFailureMode;
  sinkFailureMode?: AuditSinkFailureMode;
  backpressure?: AuditBackpressurePolicy;
}

export type ResidencyLocationHint = 'auto' | 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc';
export type ResidencyJurisdiction = 'none' | 'eu' | 'jp' | 'us';

export interface ResidencyProfile extends RuntimeProfileBase {
  kind: 'residency';
  locationHint: ResidencyLocationHint;
  jurisdiction: ResidencyJurisdiction;
  allowedRegions?: string[];
}

export type RuntimeProfile = AuditProfile | ResidencyProfile;

export const DEFAULT_AUDIT_PROFILE_ID = 'builtin:audit:standard';
export const DEFAULT_RESIDENCY_PROFILE_ID = 'builtin:residency:default';
export const EU_RESIDENCY_PROFILE_ID = 'builtin:residency:eu';

export const BUILTIN_RUNTIME_PROFILES: RuntimeProfile[] = [
  {
    id: DEFAULT_AUDIT_PROFILE_ID,
    kind: 'audit',
    label: 'Standard Audit',
    description:
      'Primary searchable store with optional archive/sink expansion. Small installs can stay on D1.',
    builtin: true,
    version: 1,
    primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
    archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' },
    sinks: [],
    retention: {
      eventLogRetentionDays: 90,
      piiLogRetentionDays: 365,
      archiveBeforeDelete: false,
      primaryDays: 90,
      archiveDays: null,
    },
    archiveFailureMode: 'gate_cleanup',
    sinkFailureMode: 'best_effort',
    backpressure: {
      mode: 'event_class',
      allowTenantOverride: true,
    },
  },
  {
    id: 'builtin:audit:archive-only-logpush',
    kind: 'audit',
    label: 'Archive Only + Logpush',
    description:
      'Archive-only audit profile for large-volume installs. No hot query store; archive to R2 and forward to Workers Logpush-compatible structured logs.',
    builtin: true,
    version: 1,
    primary: null,
    archive: { type: 'r2', bucketRef: 'AUDIT_ARCHIVE', prefix: 'logs/v1' },
    sinks: [{ type: 'logpush', destinationRef: 'workers-logpush', dataset: 'authrim_audit' }],
    retention: {
      eventLogRetentionDays: 30,
      piiLogRetentionDays: 30,
      archiveBeforeDelete: false,
      primaryDays: null,
      archiveDays: 30,
    },
    archiveFailureMode: 'gate_cleanup',
    sinkFailureMode: 'retry_until_ttl',
    backpressure: {
      mode: 'event_class',
      allowTenantOverride: true,
    },
  },
  {
    id: DEFAULT_RESIDENCY_PROFILE_ID,
    kind: 'residency',
    label: 'Default Residency',
    description:
      'No explicit jurisdiction restriction. Use the nearest or deployment-chosen region.',
    builtin: true,
    version: 1,
    locationHint: 'auto',
    jurisdiction: 'none',
  },
  {
    id: EU_RESIDENCY_PROFILE_ID,
    kind: 'residency',
    label: 'EU Residency',
    description:
      'Prefer EU jurisdiction for storage backends that support legal location constraints.',
    builtin: true,
    version: 1,
    locationHint: 'weur',
    jurisdiction: 'eu',
    allowedRegions: ['weur', 'eeur'],
  },
];
