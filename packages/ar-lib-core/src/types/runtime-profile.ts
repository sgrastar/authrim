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

export type StorageDeploymentProfile = 'shared-d1' | 'tenant-d1' | 'external-durable';
export type StorageDriver = 'd1' | 'postgres' | 'mysql';
export type StorageLogicalSource =
  | 'control'
  | 'users_core'
  | 'users_pii'
  | 'transient_auth'
  | 'audit'
  | 'custom_claims'
  | 'policy'
  | 'passkeys'
  | 'linked_identities'
  | 'consent'
  | 'authorization';
export type StorageSlice =
  | 'users_core'
  | 'users_pii'
  | 'custom_claims'
  | 'registration_fields'
  | 'custom_pii'
  | 'passkeys'
  | 'linked_identities'
  | 'consent'
  | 'authorization';

export type TransientSessionColdPersistenceMode = 'enabled' | 'disabled';
export type TransientSessionClientMirrorMode = 'sync' | 'async' | 'disabled';
export type TransientExternalDurableMirrorMode = 'disabled' | 'future';

export interface TransientAuthStoragePolicy {
  sessionColdPersistence: TransientSessionColdPersistenceMode;
  sessionClientMirror: TransientSessionClientMirrorMode;
  deviceCibaColdPersistence: TransientSessionColdPersistenceMode;
  externalDurableMirror: TransientExternalDurableMirrorMode;
}

/**
 * Points at an existing binding / adapter reference. Raw DSNs or secrets do not
 * belong in tenant settings or runtime profiles.
 */
export interface StorageTarget {
  driver: StorageDriver;
  bindingRef?: string;
  connectionRef?: string;
  resolverRef?: string;
  logicalSource?: StorageLogicalSource;
  role?:
    | 'core'
    | 'pii'
    | 'admin'
    | 'custom'
    | 'control'
    | 'transient_auth'
    | 'audit'
    | 'policy'
    | 'tenant_core'
    | 'tenant_pii'
    | 'tenant_audit'
    | 'tenant_custom';
}

export interface StorageProfile extends RuntimeProfileBase {
  kind: 'storage';
  deploymentProfile?: StorageDeploymentProfile;
  scope?: 'deployment';
  logicalSources?: Partial<Record<StorageLogicalSource, StorageTarget>>;
  slices: Partial<Record<StorageSlice, StorageTarget>>;
  transientAuth?: TransientAuthStoragePolicy;
  residencyProfileId?: string;
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
  /**
   * Request-path behavior when audit delivery is degraded.
   *
   * - event_class: use the explicit audit event catalog
   * - fail_closed_all: block or strongly retry every audit event before success
   */
  mode: AuditBackpressureFailureMode;
  /**
   * Whether tenant-level policy may make this stricter or looser.
   */
  allowTenantOverride?: boolean;
  /**
   * Reserved for future event-category overrides. The first implementation uses
   * the shared event catalog instead of per-category runtime overrides.
   */
  eventCategoryOverrides?: Record<string, 'inherit' | 'fail_open' | 'fail_closed'>;
}

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

export type RuntimeProfile = StorageProfile | AuditProfile | ResidencyProfile;

export type StorageProfileOperatorGuidanceLevel = 'info' | 'warning';

export interface StorageProfileOperatorGuidance {
  profileId: string;
  deploymentProfile: StorageDeploymentProfile | 'legacy-custom';
  selectionScope: 'deployment';
  recommendedScale: 'small' | 'medium_large' | 'regulated_or_large' | 'custom';
  warnings: string[];
  requirements: string[];
  upgradeTargets: string[];
}

export const SHARED_D1_STORAGE_PROFILE_ID = 'builtin:storage:shared-d1';
export const TENANT_D1_STORAGE_PROFILE_ID = 'builtin:storage:tenant-d1';
export const EXTERNAL_DURABLE_STORAGE_PROFILE_ID = 'builtin:storage:external-durable';
export const LEGACY_STANDARD_STORAGE_PROFILE_ID = 'builtin:storage:standard';
export const DEFAULT_STORAGE_PROFILE_ID = SHARED_D1_STORAGE_PROFILE_ID;
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
    label: 'Shared D1',
    description: 'Deployment-wide shared D1 split for small installations. PII data uses DB_PII.',
    builtin: true,
    version: 1,
    deploymentProfile: 'shared-d1',
    scope: 'deployment',
    residencyProfileId: DEFAULT_RESIDENCY_PROFILE_ID,
    logicalSources: {
      control: { driver: 'd1', bindingRef: 'DB_ADMIN', role: 'control', logicalSource: 'control' },
      users_core: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'users_core' },
      users_pii: { driver: 'd1', bindingRef: 'DB_PII', role: 'pii', logicalSource: 'users_pii' },
      transient_auth: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'transient_auth',
        logicalSource: 'transient_auth',
      },
      audit: { driver: 'd1', bindingRef: 'DB', role: 'audit', logicalSource: 'audit' },
      custom_claims: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'custom',
        logicalSource: 'custom_claims',
      },
      policy: { driver: 'd1', bindingRef: 'DB', role: 'policy', logicalSource: 'policy' },
      passkeys: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'passkeys' },
      linked_identities: {
        driver: 'd1',
        bindingRef: 'DB_PII',
        role: 'pii',
        logicalSource: 'linked_identities',
      },
      consent: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'consent' },
      authorization: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'policy',
        logicalSource: 'authorization',
      },
    },
    transientAuth: {
      sessionColdPersistence: 'enabled',
      sessionClientMirror: 'async',
      deviceCibaColdPersistence: 'enabled',
      externalDurableMirror: 'disabled',
    },
    slices: {
      users_core: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      users_pii: { driver: 'd1', bindingRef: 'DB_PII', role: 'pii' },
      custom_claims: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      registration_fields: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      custom_pii: { driver: 'd1', bindingRef: 'DB_PII', role: 'pii' },
      passkeys: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'passkeys' },
      linked_identities: {
        driver: 'd1',
        bindingRef: 'DB_PII',
        role: 'pii',
        logicalSource: 'linked_identities',
      },
      consent: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'consent' },
      authorization: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'policy',
        logicalSource: 'authorization',
      },
    },
  },
  {
    id: LEGACY_STANDARD_STORAGE_PROFILE_ID,
    kind: 'storage',
    label: 'Standard D1 Split',
    description:
      'Legacy ID for the shared D1 split. Prefer builtin:storage:shared-d1 in new deployments.',
    builtin: true,
    version: 1,
    deploymentProfile: 'shared-d1',
    scope: 'deployment',
    residencyProfileId: DEFAULT_RESIDENCY_PROFILE_ID,
    logicalSources: {
      control: { driver: 'd1', bindingRef: 'DB_ADMIN', role: 'control', logicalSource: 'control' },
      users_core: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'users_core' },
      users_pii: { driver: 'd1', bindingRef: 'DB_PII', role: 'pii', logicalSource: 'users_pii' },
      transient_auth: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'transient_auth',
        logicalSource: 'transient_auth',
      },
      audit: { driver: 'd1', bindingRef: 'DB', role: 'audit', logicalSource: 'audit' },
      custom_claims: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'custom',
        logicalSource: 'custom_claims',
      },
      policy: { driver: 'd1', bindingRef: 'DB', role: 'policy', logicalSource: 'policy' },
      passkeys: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'passkeys' },
      linked_identities: {
        driver: 'd1',
        bindingRef: 'DB_PII',
        role: 'pii',
        logicalSource: 'linked_identities',
      },
      consent: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'consent' },
      authorization: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'policy',
        logicalSource: 'authorization',
      },
    },
    transientAuth: {
      sessionColdPersistence: 'enabled',
      sessionClientMirror: 'async',
      deviceCibaColdPersistence: 'enabled',
      externalDurableMirror: 'disabled',
    },
    slices: {
      users_core: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      users_pii: { driver: 'd1', bindingRef: 'DB_PII', role: 'pii' },
      custom_claims: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      registration_fields: { driver: 'd1', bindingRef: 'DB', role: 'core' },
      custom_pii: { driver: 'd1', bindingRef: 'DB_PII', role: 'pii' },
      passkeys: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'passkeys' },
      linked_identities: {
        driver: 'd1',
        bindingRef: 'DB_PII',
        role: 'pii',
        logicalSource: 'linked_identities',
      },
      consent: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'consent' },
      authorization: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'policy',
        logicalSource: 'authorization',
      },
    },
  },
  {
    id: TENANT_D1_STORAGE_PROFILE_ID,
    kind: 'storage',
    label: 'Tenant D1',
    description:
      'Control data stays shared while tenant-owned core and PII data resolve through the tenant database registry.',
    builtin: true,
    version: 1,
    deploymentProfile: 'tenant-d1',
    scope: 'deployment',
    residencyProfileId: DEFAULT_RESIDENCY_PROFILE_ID,
    logicalSources: {
      control: { driver: 'd1', bindingRef: 'DB_ADMIN', role: 'control', logicalSource: 'control' },
      users_core: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'users_core',
      },
      users_pii: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_pii',
        logicalSource: 'users_pii',
      },
      transient_auth: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'transient_auth',
        logicalSource: 'transient_auth',
      },
      audit: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_audit',
        logicalSource: 'audit',
      },
      custom_claims: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'custom_claims',
      },
      policy: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'policy',
      },
      passkeys: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'passkeys',
      },
      linked_identities: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_pii',
        logicalSource: 'linked_identities',
      },
      consent: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'consent',
      },
      authorization: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'authorization',
      },
    },
    transientAuth: {
      sessionColdPersistence: 'disabled',
      sessionClientMirror: 'async',
      deviceCibaColdPersistence: 'disabled',
      externalDurableMirror: 'disabled',
    },
    slices: {
      users_core: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'users_core',
      },
      users_pii: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_pii',
        logicalSource: 'users_pii',
      },
      custom_claims: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'custom_claims',
      },
      registration_fields: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'custom_claims',
      },
      custom_pii: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_pii',
        logicalSource: 'users_pii',
      },
      passkeys: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'passkeys',
      },
      linked_identities: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_pii',
        logicalSource: 'linked_identities',
      },
      consent: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'consent',
      },
      authorization: {
        driver: 'd1',
        resolverRef: 'tenant-database-registry',
        role: 'tenant_core',
        logicalSource: 'authorization',
      },
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
      passkeys: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'passkeys' },
      linked_identities: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'pii',
        logicalSource: 'linked_identities',
      },
      consent: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'consent' },
      authorization: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'policy',
        logicalSource: 'authorization',
      },
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
      passkeys: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'passkeys' },
      linked_identities: {
        driver: 'd1',
        bindingRef: 'DB_PII',
        role: 'pii',
        logicalSource: 'linked_identities',
      },
      consent: { driver: 'd1', bindingRef: 'DB', role: 'core', logicalSource: 'consent' },
      authorization: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'policy',
        logicalSource: 'authorization',
      },
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
      passkeys: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'core',
        logicalSource: 'passkeys',
      },
      linked_identities: {
        driver: 'postgres',
        connectionRef: 'pii-primary',
        role: 'pii',
        logicalSource: 'linked_identities',
      },
      consent: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'core',
        logicalSource: 'consent',
      },
      authorization: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'policy',
        logicalSource: 'authorization',
      },
    },
  },
  {
    id: EXTERNAL_DURABLE_STORAGE_PROFILE_ID,
    kind: 'storage',
    label: 'External Durable',
    description:
      'Core durable data and PII resolve through external database adapters while transient auth state remains Cloudflare-native.',
    builtin: true,
    version: 1,
    deploymentProfile: 'external-durable',
    scope: 'deployment',
    residencyProfileId: DEFAULT_RESIDENCY_PROFILE_ID,
    logicalSources: {
      control: { driver: 'd1', bindingRef: 'DB_ADMIN', role: 'control', logicalSource: 'control' },
      users_core: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'core',
        logicalSource: 'users_core',
      },
      users_pii: {
        driver: 'postgres',
        connectionRef: 'pii-primary',
        role: 'pii',
        logicalSource: 'users_pii',
      },
      transient_auth: {
        driver: 'd1',
        bindingRef: 'DB',
        role: 'transient_auth',
        logicalSource: 'transient_auth',
      },
      audit: {
        driver: 'postgres',
        connectionRef: 'audit-primary',
        role: 'audit',
        logicalSource: 'audit',
      },
      custom_claims: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'custom',
        logicalSource: 'custom_claims',
      },
      policy: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'policy',
        logicalSource: 'policy',
      },
      passkeys: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'core',
        logicalSource: 'passkeys',
      },
      linked_identities: {
        driver: 'postgres',
        connectionRef: 'pii-primary',
        role: 'pii',
        logicalSource: 'linked_identities',
      },
      consent: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'core',
        logicalSource: 'consent',
      },
      authorization: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'policy',
        logicalSource: 'authorization',
      },
    },
    transientAuth: {
      sessionColdPersistence: 'disabled',
      sessionClientMirror: 'async',
      deviceCibaColdPersistence: 'disabled',
      externalDurableMirror: 'future',
    },
    slices: {
      users_core: { driver: 'postgres', connectionRef: 'core-primary', role: 'core' },
      users_pii: { driver: 'postgres', connectionRef: 'pii-primary', role: 'pii' },
      custom_claims: { driver: 'postgres', connectionRef: 'core-primary', role: 'custom' },
      registration_fields: { driver: 'postgres', connectionRef: 'core-primary', role: 'custom' },
      custom_pii: { driver: 'postgres', connectionRef: 'pii-primary', role: 'pii' },
      passkeys: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'core',
        logicalSource: 'passkeys',
      },
      linked_identities: {
        driver: 'postgres',
        connectionRef: 'pii-primary',
        role: 'pii',
        logicalSource: 'linked_identities',
      },
      consent: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'core',
        logicalSource: 'consent',
      },
      authorization: {
        driver: 'postgres',
        connectionRef: 'core-primary',
        role: 'policy',
        logicalSource: 'authorization',
      },
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
    backpressure: {
      mode: 'event_class',
      allowTenantOverride: true,
    },
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

export function describeStorageProfileOperatorGuidance(
  profile: StorageProfile
): StorageProfileOperatorGuidance {
  switch (profile.deploymentProfile) {
    case 'shared-d1':
      return {
        profileId: profile.id,
        deploymentProfile: 'shared-d1',
        selectionScope: 'deployment',
        recommendedScale: 'small',
        warnings: [
          'Shared D1 keeps infrastructure cost low but all tenants share the durable user databases.',
          'Plan tenant-d1 or external-durable before high user counts, heavy audit writes, or D1 size limits become operational risks.',
        ],
        requirements: [
          'DB, DB_PII, and DB_ADMIN D1 bindings must be configured for every runtime deployment.',
        ],
        upgradeTargets: [TENANT_D1_STORAGE_PROFILE_ID, EXTERNAL_DURABLE_STORAGE_PROFILE_ID],
      };
    case 'tenant-d1':
      return {
        profileId: profile.id,
        deploymentProfile: 'tenant-d1',
        selectionScope: 'deployment',
        recommendedScale: 'medium_large',
        warnings: [
          'Tenant D1 requires tenant database registry rows, per-tenant schema migration state, and binding or worker-shard operations.',
          'Binding limits and tenant database lifecycle automation must be monitored as tenant count grows.',
        ],
        requirements: [
          'DB_ADMIN must hold the tenant database registry and active pointers.',
          'Tenant core and PII D1 databases must be provisioned before a tenant is activated.',
        ],
        upgradeTargets: [EXTERNAL_DURABLE_STORAGE_PROFILE_ID],
      };
    case 'external-durable':
      return {
        profileId: profile.id,
        deploymentProfile: 'external-durable',
        selectionScope: 'deployment',
        recommendedScale: 'regulated_or_large',
        warnings: [
          'External durable storage adds external database cost, latency, capacity planning, and backup/DR operations.',
          'Regional and legal placement constraints must be validated before moving tenant durable data.',
        ],
        requirements: [
          'External database connections must be exposed through setup-managed connection references or Hyperdrive bindings.',
          'Schema migration and cutover jobs must be available before production activation.',
        ],
        upgradeTargets: [],
      };
    default:
      return {
        profileId: profile.id,
        deploymentProfile: 'legacy-custom',
        selectionScope: 'deployment',
        recommendedScale: 'custom',
        warnings: [
          'This storage profile does not declare a deploymentProfile. Treat it as a custom deployment-wide profile and validate upgrade behavior explicitly.',
        ],
        requirements: [
          'Custom profiles must keep tenant storage isolation compatible with deployment policy.',
        ],
        upgradeTargets: [TENANT_D1_STORAGE_PROFILE_ID, EXTERNAL_DURABLE_STORAGE_PROFILE_ID],
      };
  }
}
