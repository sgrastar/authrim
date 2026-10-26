import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import type { AccountRouteProjection } from '@authrim/ar-lib-core/services/control-plane/control-plane-contracts';
import type { LookupBlindIndexKey } from '@authrim/ar-lib-core/services/lookup-directory/blind-index';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { AuditRuntimePorts } from '@authrim/ar-lib-core/types/audit-runtime-ports';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import type { PostgresFamilyRestoreReceipt } from './postgres-restore';
import type { VerifiedAwsStateSupplement, AwsStateRestoreReceipt } from './state-restore';
import type { PostgresQueryClient } from '../storage/postgres-transient-state';

/**
 * Operator-protected evidence for values intentionally absent from a tenant bundle. The caller
 * verifies its separate receipt before passing it here; assembly also checks the pinned identity.
 */
export interface VerifiedAwsSamlSupplement {
  receipt: {
    tenantId: string;
    issuer: string;
    productVersion: string;
    bundleId: string;
    snapshotId: string;
    inventoryDigestSha256: string;
    /** Digest of the canonical, separately authenticated supplement payload. */
    supplementSha256: string;
  };
  /** Setup-managed source client and origin are excluded from the portable tenant SQL datasets. */
  sourceLoginUi: {
    client: PortableSqliteRow;
    origins: readonly PortableSqliteRow[];
  };
  /** Platform-owned destination profiles referenced by an imported tenant mapping. */
  platformDestinationProfiles: {
    profiles: readonly PortableSqliteRow[];
    versions: readonly PortableSqliteRow[];
  };
  /** Independently authenticated, complete state inventory restored by the coordinator. */
  state: VerifiedAwsStateSupplement;
  /** An independently pinned route for each active account in the source Core snapshot. */
  accountRoutes: Readonly<Record<string, AccountRouteProjection>>;
  /** Platform-owned settings inherited by the source tenant, keyed by category. */
  platformSettings: Readonly<Record<string, { documentJson: string; version: string }>>;
  /** The source deployment flag must be captured explicitly, even when tenant settings allow Flow. */
  sourceFlowRuntimeEnabled: boolean;
  /** Source KV secret; do not manufacture a new salt from the tenant ID. */
  consentIpSalt: string;
  /** Only for a source deployment that used PAIRWISE_SALT instead of KeyManager. */
  sourcePairwiseFallbackSecret?: string;
}

/** Databases stay in staging until both family restores and all supplement imports have succeeded. */
export interface AwsSamlRestoredDatabases {
  metadataCoreDb: DatabaseAdapter;
  accountCoreByBindingRef: Readonly<Record<string, DatabaseAdapter>>;
  accountPiiByBindingRef: Readonly<Record<string, DatabaseAdapter>>;
  stateDb: PostgresQueryClient;
  /** Exact source manifest hashes pinned to the committed Core and PII restore receipts. */
  committed: {
    core: PostgresFamilyRestoreReceipt;
    pii: PostgresFamilyRestoreReceipt;
    state: AwsStateRestoreReceipt;
  };
}

export interface AssembleAwsSamlTenantInput {
  backup: VerifiedTenantBackupV2;
  restored: AwsSamlRestoredDatabases;
  supplement: VerifiedAwsSamlSupplement;
  environmentName: string;
  /** Explicit operator-approved SP entity IDs; an empty list never means all SPs. */
  spEntityIds: readonly string[];
  allocationScope: 'shared_pool' | 'tenant_exclusive';
  auditPorts: AuditRuntimePorts;
  /** Newly provisioned AWS-only Flow contract HMAC secret; old interactions are discarded. */
  awsFlowRuntimeHmacSecret: string;
  /** Newly provisioned AWS-only keys used to rebuild Lookup indexes from source identifiers. */
  awsLookupReadKeys: readonly LookupBlindIndexKey[];
  /** Rechecks source/supplement provenance, freshness and staged state on each readiness probe. */
  assertSnapshotReady(): Promise<void>;
}
