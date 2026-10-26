import type { AccountAuthenticationLifecycle } from '../../durable-objects/SessionRevocationStore';
import type { AccountRouteProjection } from '../control-plane/control-plane-contracts';
import type { TenantBundleManifest } from './bundle-manifest';
import type { TenantPortableDataset } from './module-contract';
import type { PortableSqliteRow } from './sqlite-dataset-inspector';

/** The logical state contract is shared by exporters and restorers on every backend. */
export const SAML_DR_RUNTIME_STATE_DATASET = {
  id: 'federation.saml_runtime_state',
  module: 'federation',
  kind: 'settings',
  store: 'environment',
  schemaVersion: 1,
  disposition: 'include',
} as const satisfies TenantPortableDataset;

export interface SamlDrAccountAuthState {
  tenantId: string;
  userId: string;
  accountId: string;
  lifecycle: AccountAuthenticationLifecycle;
  lifecycleVersionMs: number;
  lifecycleOperationId: string | null;
  revokedAfterMs: number | null;
  lastLoginAtMs: number | null;
}

export interface SamlDrPasskeyCounter {
  tenantId: string;
  passkeyId: string;
  userId: string;
  /** Public WebAuthn credential identifier, distinct from the passkey storage row ID. */
  credentialId: string;
  /** Canonical decimal, independent of database integer encoding. */
  counter: string;
  updatedAtMs: number;
}

export interface SamlDrPersistentNameId {
  tenantId: string;
  registryKey: string;
  valueJson: string;
  createdAtMs: number;
}

export interface SamlDrSnapshotPayload {
  sourceLoginUi: { client: PortableSqliteRow; origins: readonly PortableSqliteRow[] };
  platformDestinationProfiles: {
    profiles: readonly PortableSqliteRow[];
    versions: readonly PortableSqliteRow[];
  };
  state: {
    accountAuthStates: readonly SamlDrAccountAuthState[];
    passkeyCounters: readonly SamlDrPasskeyCounter[];
    persistentNameIdsComplete: true;
    persistentNameIds: readonly SamlDrPersistentNameId[];
  };
  accountRoutes: Readonly<Record<string, AccountRouteProjection>>;
  platformSettings: Readonly<Record<string, { documentJson: string; version: string }>>;
  sourceFlowRuntimeEnabled: boolean;
  consentIpSalt: string;
  sourcePairwiseFallbackSecret?: string;
}

/**
 * Captured by an installed exporter under the bundle's coordinated source boundary.
 * The shape alone is not proof: readers must authenticate the containing backup and
 * match its complete source identity. Session and pending interaction state is excluded.
 * Neither backend nor primary/secondary role is encoded in logical authentication data.
 */
export interface SamlDrFrozenSourceCapture {
  formatVersion: 1;
  source: Pick<
    TenantBundleManifest,
    'bundleId' | 'snapshotId' | 'boundaryUnixMs' | 'inventoryDigestSha256' | 'source'
  >;
  completeness: {
    accountAuthStates: true;
    passkeyCounters: true;
    persistentNameIds: true;
    sourceLoginUi: true;
    platformDestinationProfiles: true;
    accountRoutes: true;
    platformSettings: true;
    sourceRuntimeSettings: true;
  };
  payload: SamlDrSnapshotPayload;
}
