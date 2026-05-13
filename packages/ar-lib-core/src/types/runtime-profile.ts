/**
 * Runtime Storage / Audit / Residency Profile Types
 *
 * These profiles let runtime wiring choose backend/residency behavior without
 * storing backend credentials directly on tenant settings. Tenants only point
 * at profile IDs; profile payloads live in a registry backend.
 */

export type RuntimeProfileKind = 'storage' | 'audit' | 'residency';

export interface RuntimeProfileBase {
  id: string;
  kind: RuntimeProfileKind;
  label: string;
  description?: string;
  builtin?: boolean;
  version?: number;
  metadata?: Record<string, unknown>;
}

export type StorageDriver = 'd1' | 'postgres' | 'mysql';
export type StorageSlice =
  | 'users_core'
  | 'users_pii'
  | 'custom_claims'
  | 'registration_fields'
  | 'custom_pii';

/**
 * Points at an existing binding / adapter reference. Raw DSNs or secrets do not
 * belong in tenant settings or runtime profiles.
 */
export interface StorageTarget {
  driver: StorageDriver;
  bindingRef?: string;
  connectionRef?: string;
  role?: 'core' | 'pii' | 'admin' | 'custom';
}

export interface StorageProfile extends RuntimeProfileBase {
  kind: 'storage';
  slices: Partial<Record<StorageSlice, StorageTarget>>;
  residencyProfileId?: string;
}

export type AuditTarget =
  | {
      type: 'd1' | 'postgres' | 'mysql';
      bindingRef?: string;
      connectionRef?: string;
      dataset?: string;
    }
  | {
      type: 'r2';
      bucketRef: string;
      prefix?: string;
    }
  | {
      type: 'logpush';
      destinationRef: string;
      dataset?: string;
    }
  | {
      type: 'firehose';
      streamRef: string;
    }
  | {
      type: 'http';
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

export interface AuditProfile extends RuntimeProfileBase {
  kind: 'audit';
  primary: AuditTarget | null;
  archive?: AuditTarget | null;
  sinks: AuditTarget[];
  retention?: AuditRetentionPolicy;
  /**
   * Archive delivery failure policy.
   *
   * - best_effort: log and continue
   * - gate_cleanup: keep retrying so archive delivery is not silently dropped
   */
  archiveFailureMode?: AuditArchiveFailureMode;
  /**
   * Sink delivery failure policy.
   *
   * - best_effort: log and continue
   * - retry_until_ttl: retry through the queue / DLQ lifetime
   */
  sinkFailureMode?: AuditSinkFailureMode;
}

export type ResidencyLocationHint = 'auto' | 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac' | 'oc';
export type ResidencyJurisdiction = 'none' | 'eu' | 'jp' | 'us';

export interface ResidencyProfile extends RuntimeProfileBase {
  kind: 'residency';
  locationHint: ResidencyLocationHint;
  jurisdiction: ResidencyJurisdiction;
  allowedRegions?: string[];
}

export type RuntimeProfile = StorageProfile | AuditProfile | ResidencyProfile;

export const DEFAULT_STORAGE_PROFILE_ID = 'builtin:storage:standard';
export const SINGLE_DB_STORAGE_PROFILE_ID = 'builtin:storage:single-db';
export const EU_PII_STORAGE_PROFILE_ID = 'builtin:storage:eu-pii-split';
export const EXTERNAL_POSTGRES_STORAGE_PROFILE_ID = 'builtin:storage:external-postgres';
export const DEFAULT_AUDIT_PROFILE_ID = 'builtin:audit:standard';
export const DEFAULT_RESIDENCY_PROFILE_ID = 'builtin:residency:default';
export const EU_RESIDENCY_PROFILE_ID = 'builtin:residency:eu';

export const BUILTIN_RUNTIME_PROFILES: RuntimeProfile[] = [
  {
    id: DEFAULT_STORAGE_PROFILE_ID,
    kind: 'storage',
    label: 'Standard D1 Split',
    description:
      'Default D1 split for core user data, custom claims, and registration fields. PII data uses DB_PII.',
    builtin: true,
    version: 1,
    residencyProfileId: DEFAULT_RESIDENCY_PROFILE_ID,
    slices: {
      users_core: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      users_pii: { driver: 'd1', bindingRef: 'DB_PII', role: 'pii' },
      custom_claims: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      registration_fields: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      custom_pii: { driver: 'd1', bindingRef: 'DB_PII', role: 'pii' },
    },
  },
  {
    id: SINGLE_DB_STORAGE_PROFILE_ID,
    kind: 'storage',
    label: 'Single Database',
    description:
      'Fallback profile for lightweight installs. Users and custom fields stay in the primary database.',
    builtin: true,
    version: 1,
    residencyProfileId: DEFAULT_RESIDENCY_PROFILE_ID,
    slices: {
      users_core: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      users_pii: { driver: 'd1', bindingRef: 'DB', role: 'pii' },
      custom_claims: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      registration_fields: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      custom_pii: { driver: 'd1', bindingRef: 'DB', role: 'pii' },
    },
  },
  {
    id: EU_PII_STORAGE_PROFILE_ID,
    kind: 'storage',
    label: 'EU PII Split',
    description:
      'Keep core/auth data on the primary database while routing user and custom PII slices to the EU-oriented PII backend.',
    builtin: true,
    version: 1,
    residencyProfileId: EU_RESIDENCY_PROFILE_ID,
    slices: {
      users_core: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      users_pii: { driver: 'd1', bindingRef: 'DB_PII', role: 'pii' },
      custom_claims: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      registration_fields: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      custom_pii: { driver: 'd1', bindingRef: 'DB_PII', role: 'pii' },
    },
  },
  {
    id: EXTERNAL_POSTGRES_STORAGE_PROFILE_ID,
    kind: 'storage',
    label: 'External Postgres',
    description:
      'Example external database profile for user, custom-claim, and PII slices via portable adapters.',
    builtin: true,
    version: 1,
    residencyProfileId: DEFAULT_RESIDENCY_PROFILE_ID,
    slices: {
      users_core: { driver: 'postgres', connectionRef: 'core-primary', role: 'core' },
      users_pii: { driver: 'postgres', connectionRef: 'pii-primary', role: 'pii' },
      custom_claims: { driver: 'postgres', connectionRef: 'core-primary', role: 'core' },
      registration_fields: { driver: 'postgres', connectionRef: 'core-primary', role: 'core' },
      custom_pii: { driver: 'postgres', connectionRef: 'pii-primary', role: 'pii' },
    },
  },
  {
    id: DEFAULT_AUDIT_PROFILE_ID,
    kind: 'audit',
    label: 'Standard Audit',
    description:
      'Primary searchable store with optional archive/sink expansion. Small installs can stay on D1.',
    builtin: true,
    version: 1,
    primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
    archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
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
  },
  {
    id: 'builtin:audit:minimal',
    kind: 'audit',
    label: 'Minimal Audit',
    description:
      'Keep audit logs only in the primary database without archive or forwarding sinks.',
    builtin: true,
    version: 1,
    primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
    archive: null,
    sinks: [],
    retention: {
      eventLogRetentionDays: 90,
      piiLogRetentionDays: 365,
      archiveBeforeDelete: false,
      primaryDays: 90,
      archiveDays: null,
    },
    archiveFailureMode: 'best_effort',
    sinkFailureMode: 'best_effort',
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
    archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
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
