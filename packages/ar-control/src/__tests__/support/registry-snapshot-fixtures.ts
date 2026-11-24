import {
  signTenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistrySnapshot,
} from '@authrim/ar-lib-core';
import type { JWK } from 'jose';

type TestJwk = JWK & { kty: string };

export async function signingKeys(kid = 'cleanup-key') {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('expected_ed25519_key_pair');
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as TestJwk;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as TestJwk;
  Object.assign(privateJwk, { kid, alg: 'EdDSA', use: 'sig' });
  Object.assign(publicJwk, { kid, alg: 'EdDSA', use: 'sig' });
  return { privateJwk, publicJwk, kid };
}

export interface SnapshotOptions {
  privateJwk: TestJwk;
  kid: string;
  /** Seconds since the epoch. */
  publishedAt: number;
  expiresInSeconds?: number;
  runtimeGeneration?: number;
  tenantId?: string;
  deploymentTarget?: string;
  version?: number;
  routeStatus?: string;
  quarantineDenyGeneration?: number;
  storeBindingRef?: string;
  storeDatabaseId?: string;
  /** Further stores, each with its own binding reference and database id. */
  /** Signed in place of the stores list, to exercise malformed but correctly signed payloads. */
  storesOverride?: unknown;
  extraStores?: ReadonlyArray<{ bindingRef: string; databaseId: string }>;
  publishedAtOverride?: string;
  expiresAtOverride?: string;
}

/** A signed tenant registry snapshot plus its generation document. */
export async function registryDocuments(input: SnapshotOptions) {
  const runtimeGeneration = input.runtimeGeneration ?? 10;
  const publishedAt = input.publishedAtOverride ?? new Date(input.publishedAt * 1000).toISOString();
  const expiresAt =
    input.expiresAtOverride ??
    new Date((input.publishedAt + (input.expiresInSeconds ?? 1800)) * 1000).toISOString();
  const baseStore = {
    tenantId: input.tenantId ?? 'tenant-a',
    role: 'tenant_core',
    dataRole: 'tenant_core/default',
    residencyPolicyId: 'default-policy',
    residencyPartition: 'default',
    shardId: 'replacement-default',
    assignmentGeneration: 1,
    bindingRouteGeneration: 4,
    placementPolicyGeneration: 1,
    allocationScope: 'tenant_exclusive',
    ownerTenantId: 'tenant-a',
    generation: 4,
    runtimeGeneration,
    schemaVersion: 1,
    shardGroup: 'default',
    shardIndex: 0,
    shardCount: 1,
    shardKeyStrategy: 'fixed',
    provider: 'd1',
    driver: 'd1',
    bindingRef: input.storeBindingRef ?? 'TDB_REPLACEMENT_DEFAULT',
    connectionRef: null,
    deploymentTarget: input.deploymentTarget ?? 'default',
    status: 'active',
    healthStatus: 'active',
    databaseId: input.storeDatabaseId ?? 'database-replacement',
    databaseName: 'test-replacement-default',
    regionHint: null,
    jurisdiction: null,
  };
  const snapshot = {
    version: input.version ?? 4,
    tenantId: input.tenantId ?? 'tenant-a',
    snapshotScope: 'tenant',
    deploymentTarget: input.deploymentTarget ?? 'default',
    runtimeGeneration,
    routeStatus: input.routeStatus ?? 'active',
    quarantineDenyGeneration: input.quarantineDenyGeneration ?? 0,
    backend: { provider: 'd1', resolver: 'control-plane' },
    placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
    publishedAt,
    expiresAt,
    stores:
      input.storesOverride !== undefined
        ? input.storesOverride
        : [
            baseStore,
            ...(input.extraStores ?? []).map((extra) => ({
              ...baseStore,
              bindingRef: extra.bindingRef,
              databaseId: extra.databaseId,
            })),
          ],
    metadata: { storeCount: 1, roles: ['tenant_core'], signature: null, signatureKeyId: null },
  } as unknown as TenantRuntimeRegistrySnapshot;
  const signed = await signTenantRuntimeRegistrySnapshot(
    snapshot,
    { privateJwk: input.privateJwk, keyId: input.kid },
    publishedAt
  );
  return {
    snapshot: JSON.stringify(signed),
    generation: JSON.stringify({
      runtimeGeneration,
      routeStatus: input.routeStatus ?? 'active',
      quarantineDenyGeneration: input.quarantineDenyGeneration ?? 0,
      publishedAt,
      expiresAt: new Date((input.publishedAt + 7 * 86400) * 1000).toISOString(),
    }),
  };
}
