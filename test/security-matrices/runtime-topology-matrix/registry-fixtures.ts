/**
 * Runtime-topology suite fixtures: FIXED Ed25519 fixed test keys (embedded constants, not
 * generated at runtime), signed runtime-registry snapshot builder (production signing
 * helper used for INPUT construction only, never as the expectation oracle),
 * runtime-generation document builder, and snapshot tamper helpers.
 *
 * The signed snapshot contract is documented in
 * packages/ar-lib-core/src/services/tenant-runtime-registry-snapshot.ts and parsed by
 * parseRuntimeRegistrySnapshot in tenant-database-resolver.ts; every field below matches
 * the production parse contract so the resolver can be exercised through its real path.
 */
import {
  signTenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistryPlacementSnapshot,
  type TenantRuntimeRegistrySnapshot,
  type TenantRuntimeRegistryStoreSnapshot,
} from '../../../packages/ar-lib-core/src/services/tenant-runtime-registry-snapshot';

/**
 * Fixed Ed25519 fixed test key pair #1 (the only key in the verification JWKS).
 * `kid` is fixed; the public JWK satisfies every constraint of
 * loadTenantRuntimeRegistryVerificationKeysFromEnv (kid, crv=Ed25519, alg=EdDSA,
 * use=sig, key_ops=[verify], no private fields).
 */
const FIXED_KEY_KID = 'security-matrix-runtime-registry-kid-001';
const FIXED_PRIVATE_JWK = {
  crv: 'Ed25519',
  d: '65cKh7f-rhvf6OLJo-46SdSRK1GosAKVUq3TxHtd_D4',
  x: 'NcKXeEZf8eGg_pSjUaFHRaBihhuMfkX3GUlj_HOSAWI',
  kty: 'OKP',
} as const;

/** Fixed second key pair, never present in the verification JWKS (unknown-kid cases). */
const UNKNOWN_KID = 'security-matrix-runtime-registry-kid-002';
const UNKNOWN_KID_PRIVATE_JWK = {
  crv: 'Ed25519',
  d: 'Cz0lXRG0QFi4cigu4NgQbd5nAGuIFXYpWxlHpxnyk1g',
  x: 'cVmh61GlaRZSrU4BqdQ2_7gVtBHq7G1InN7BSzgVNq0',
  kty: 'OKP',
} as const;

export interface RuntimeRegistryKeyMaterial {
  kid: string;
  privateJwk: JsonWebKey & { kid?: string };
  publicJwk: JsonWebKey & { kid?: string };
  publicJwksJson: string;
}

export interface RuntimeRegistryKeyMaterialSet {
  primary: RuntimeRegistryKeyMaterial;
  unknownKid: RuntimeRegistryKeyMaterial;
}

function materialize(keyId: string, privateJwk: JsonWebKey): RuntimeRegistryKeyMaterial {
  const publicJwk: JsonWebKey & { kid?: string } = {
    crv: privateJwk.crv,
    x: privateJwk.x as string,
    kty: privateJwk.kty,
    kid: keyId,
    alg: 'EdDSA',
    use: 'sig',
    key_ops: ['verify'],
  };
  const privateWithKid: JsonWebKey & { kid?: string } = {
    ...privateJwk,
    kid: keyId,
    alg: 'EdDSA',
  };
  return {
    kid: keyId,
    privateJwk: privateWithKid,
    publicJwk,
    publicJwksJson: JSON.stringify({ keys: [publicJwk] }),
  };
}

const cachedKeys: RuntimeRegistryKeyMaterialSet = {
  primary: materialize(FIXED_KEY_KID, FIXED_PRIVATE_JWK as unknown as JsonWebKey),
  unknownKid: materialize(UNKNOWN_KID, UNKNOWN_KID_PRIVATE_JWK as unknown as JsonWebKey),
};

/** Fixed fixed test keys; identical in every process. */
export async function getRuntimeRegistryKeys(): Promise<RuntimeRegistryKeyMaterialSet> {
  return cachedKeys;
}

export type SnapshotDataRole = 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';

export interface SnapshotStoreSpec {
  tenantId: string;
  dataRole: SnapshotDataRole;
  bindingRef: string;
  generation: number;
  runtimeGeneration: number;
  allocationScope: 'shared_pool' | 'tenant_exclusive';
  ownerTenantId: string | null;
  provider: string;
  databaseId: string;
  schemaVersion?: number;
  shardIndex?: number;
  shardCount?: number;
  status?: 'active' | 'degraded';
  deploymentTarget?: string | null;
}

function buildStore(
  spec: SnapshotStoreSpec,
  runtimeGeneration: number
): TenantRuntimeRegistryStoreSnapshot {
  const role = spec.dataRole === 'tenant_pii' ? 'tenant_pii' : 'tenant_core';
  return {
    tenantId: spec.tenantId,
    role,
    dataRole: spec.dataRole,
    residencyPolicyId: 'matrix-residency-policy-001',
    residencyPartition: 'default',
    shardId: `shard-${spec.shardIndex ?? 0}`,
    assignmentGeneration: 1,
    bindingRouteGeneration: spec.generation,
    placementPolicyGeneration: 1,
    allocationScope: spec.allocationScope,
    ownerTenantId: spec.ownerTenantId,
    generation: spec.generation,
    runtimeGeneration,
    schemaVersion: spec.schemaVersion ?? 4,
    shardGroup: 'default',
    shardIndex: spec.shardIndex ?? 0,
    shardCount: spec.shardCount ?? 1,
    shardKeyStrategy: 'fixed',
    provider: (spec.provider === 'd1' ? 'd1' : spec.provider) as 'd1',
    driver: (spec.provider === 'd1' ? 'd1' : spec.provider) as 'd1',
    bindingRef: spec.bindingRef,
    connectionRef: null,
    deploymentTarget: spec.deploymentTarget ?? 'default',
    status: spec.status ?? 'active',
    healthStatus: 'active',
    databaseId: spec.databaseId,
    databaseName: `db-${spec.databaseId}`,
    regionHint: null,
    jurisdiction: null,
  };
}

export interface BuildSnapshotInput {
  tenantId: string;
  runtimeGeneration: number;
  routeStatus: 'active' | 'quarantined';
  quarantineDenyGeneration: number;
  stores: SnapshotStoreSpec[];
  publishedAt: string;
  expiresAt: string;
  deploymentTarget?: string;
}

/**
 * Build a runtime-registry snapshot document WITHOUT signing. The resolver treats an
 * unsigned snapshot as fail-closed ('unsigned' status), which is one of the exercised
 * snapshot states.
 */
export function buildSnapshot(input: BuildSnapshotInput): TenantRuntimeRegistrySnapshot {
  const placement: TenantRuntimeRegistryPlacementSnapshot = {
    isolationPolicy: input.stores[0]?.allocationScope ?? 'shared_pool',
    policyGeneration: 1,
  };
  const stores = input.stores.map((store) => buildStore(store, input.runtimeGeneration));
  return {
    version: 4,
    tenantId: input.tenantId,
    snapshotScope: 'tenant',
    deploymentTarget: input.deploymentTarget ?? 'default',
    runtimeGeneration: input.runtimeGeneration,
    routeStatus: input.routeStatus,
    quarantineDenyGeneration: input.quarantineDenyGeneration,
    backend: { provider: 'd1', resolver: 'control-plane' },
    placement,
    publishedAt: input.publishedAt,
    expiresAt: input.expiresAt,
    stores,
    metadata: {
      storeCount: stores.length,
      roles: Array.from(new Set(stores.map((store) => store.role))).sort(),
      signature: null,
      signatureKeyId: null,
    },
  };
}

/**
 * Sign a snapshot with the fixed fixed test key. Used to build ACCEPTED fixture inputs;
 * expectations are never derived from this helper.
 */
export async function signSnapshot(
  snapshot: TenantRuntimeRegistrySnapshot,
  signedAt: string
): Promise<TenantRuntimeRegistrySnapshot> {
  const keys = await getRuntimeRegistryKeys();
  return signTenantRuntimeRegistrySnapshot(
    snapshot,
    { privateJwk: keys.primary.privateJwk, keyId: keys.primary.kid },
    signedAt
  );
}

/**
 * Sign a snapshot with the second fixed key whose kid is absent from the verification
 * JWKS. This is a DIFFERENT verification path from a tampered signature: the JWS envelope
 * is well-formed, the signature is valid, but no verification key matches the kid.
 */
export async function signSnapshotWithUnknownKid(
  snapshot: TenantRuntimeRegistrySnapshot,
  signedAt: string
): Promise<TenantRuntimeRegistrySnapshot> {
  const keys = await getRuntimeRegistryKeys();
  return signTenantRuntimeRegistrySnapshot(
    snapshot,
    { privateJwk: keys.unknownKid.privateJwk, keyId: keys.unknownKid.kid },
    signedAt
  );
}

/**
 * Corrupt the JWS signature segment in the signature field so verification must fail.
 *
 * The last base64url character of an Ed25519 signature carries only 2 data bits; replacing
 * it with a character that shares those top bits (for example 'A' -> 'B') only touches the
 * ignored padding bits and leaves the decoded signature bytes unchanged. Corrupt a middle
 * byte of the decoded signature instead so the mutation always changes the verified bytes.
 */
export function corruptSnapshotSignature(snapshot: TenantRuntimeRegistrySnapshot): void {
  const token = snapshot.metadata.signature;
  if (!token) return;
  const segments = token.split('.');
  if (segments.length !== 3) return;
  const padded = segments[2]
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(segments[2].length / 4) * 4, '=');
  const bytes = new Uint8Array(Array.from(atob(padded), (char) => char.charCodeAt(0)));
  if (bytes.length < 2) return;
  const index = Math.floor(bytes.length / 2);
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const reencoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  snapshot.metadata.signature = `${segments[0]}.${segments[1]}.${reencoded}`;
}

/**
 * Tamper a signed snapshot's payload AFTER signing (a field that the parse contract does
 * not read, so the snapshot still parses and only the signature verification fails).
 */
export function tamperSnapshotPayloadAfterSigning(snapshot: TenantRuntimeRegistrySnapshot): void {
  snapshot.publishedAt = '1970-01-01T00:00:00.000Z';
}

export interface GenerationDocumentInput {
  runtimeGeneration: number;
  routeStatus: 'active' | 'quarantining' | 'quarantined' | 'disabled';
  quarantineDenyGeneration: number;
  publishedAt: string;
  expiresAt: string;
}

/** Serialized runtime-generation document matching the production parse contract. */
export function buildGenerationDocument(input: GenerationDocumentInput): string {
  return JSON.stringify({
    runtimeGeneration: input.runtimeGeneration,
    routeStatus: input.routeStatus,
    quarantineDenyGeneration: input.quarantineDenyGeneration,
    publishedAt: input.publishedAt,
    expiresAt: input.expiresAt,
  });
}

export const RUNTIME_REGISTRY_SNAPSHOT_KEY = (
  tenantId: string,
  deploymentTarget = 'default'
): string => `tenant:${tenantId}:runtime-registry:snapshot:tenant:${deploymentTarget}`;

export const RUNTIME_REGISTRY_GENERATION_KEY = (
  tenantId: string,
  deploymentTarget = 'default'
): string => `tenant:${tenantId}:runtime-registry:generation:tenant:${deploymentTarget}`;
