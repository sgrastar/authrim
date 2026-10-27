import type { AwsRuntimeUiConfig } from '../ui/runtime-ui-config';
import type { AwsBoundAuthState } from './selected-auth-state';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import type { LookupBlindIndexKey } from '@authrim/ar-lib-core/services/lookup-directory/blind-index';
import type { AuditRuntimePorts } from '@authrim/ar-lib-core/types/audit-runtime-ports';
import type { VerifiedTenantBackupV2 } from './backup-reader';
import type { PostgresFamilyRestoreReceipt } from './postgres-restore';
import type { VerifiedAwsStateSupplement, AwsStateRestoreReceipt } from './state-restore';
import type { PostgresQueryClient } from '../storage/postgres-transient-state';
import type { SamlDrSnapshotPayload } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-snapshot';

/**
 * Operator-protected evidence for values intentionally absent from a tenant bundle. The caller
 * verifies its separate receipt before passing it here; assembly also checks the pinned identity.
 */
export interface VerifiedAwsSamlSupplement extends Omit<SamlDrSnapshotPayload, 'state'> {
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
  /** Complete state with its independently checked restore receipt. */
  state: VerifiedAwsStateSupplement;
}

/** Databases stay in staging until both family restores and all supplement imports have succeeded. */
export interface AwsSamlRestoredDatabases {
  metadataCoreDb: DatabaseAdapter;
  accountCoreByBindingRef: Readonly<Record<string, DatabaseAdapter>>;
  accountPiiByBindingRef: Readonly<Record<string, DatabaseAdapter>>;
  stateDb: PostgresQueryClient;
  authenticationState?: AwsBoundAuthState;
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
  destinationUi?: AwsRuntimeUiConfig;
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
