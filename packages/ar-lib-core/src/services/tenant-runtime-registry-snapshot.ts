import type {
  TenantDatabaseActivePointer,
  TenantDatabaseRegistryKey,
  TenantDatabaseRegistryRepository,
  TenantDatabaseRegistryRow,
} from '../repositories/admin/tenant-database-registry';

export const RUNTIME_REGISTRY_SNAPSHOT_VERSION = 1;
export const DEFAULT_RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_RUNTIME_REGISTRY_GENERATION_TTL_SECONDS =
  DEFAULT_RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS;
export const TENANT_RUNTIME_REGISTRY_EMERGENCY_PURGE_CONFIRMATION =
  'PURGE_TENANT_RUNTIME_REGISTRY_SNAPSHOT';
export const RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM = 'Ed25519';

export interface RuntimeRegistrySnapshotStore {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

export interface RuntimeRegistryPurgeStore {
  delete(key: string): Promise<unknown>;
}

export interface TenantRuntimeRegistryStoreSnapshot {
  tenantId: string;
  role: TenantDatabaseRegistryRow['role'];
  generation: number;
  runtimeGeneration: number;
  schemaVersion: number;
  shardGroup: string;
  shardIndex: number;
  shardCount: number;
  shardKeyStrategy: string;
  provider: TenantDatabaseRegistryRow['provider'];
  driver: TenantDatabaseRegistryRow['provider'];
  bindingRef: string | null;
  connectionRef: string | null;
  deploymentTarget: string | null;
  status: TenantDatabaseRegistryRow['status'];
  healthStatus: 'active' | 'degraded' | 'degraded_pending_snapshot';
  databaseId: string | null;
  databaseName: string | null;
  regionHint: string | null;
  jurisdiction: string | null;
}

export interface TenantRuntimeRegistrySnapshot {
  version: number;
  tenantId: string;
  snapshotScope: 'tenant';
  deploymentTarget: string;
  runtimeGeneration: number;
  storageProfileId: string;
  publishedAt: string;
  expiresAt: string;
  stores: TenantRuntimeRegistryStoreSnapshot[];
  metadata: {
    storeCount: number;
    roles: string[];
    signature: string | null;
    signatureKeyId: string | null;
    signatureAlgorithm?: typeof RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM | null;
    signedAt?: string | null;
  };
}

export interface RuntimeRegistrySnapshotSigningKey {
  privateJwk: JsonWebKey | string;
  keyId?: string | null;
}

export interface RuntimeRegistrySnapshotExternalSigner {
  keyId: string;
  algorithm: typeof RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM;
  sign(payload: Uint8Array): Promise<string | ArrayBuffer | Uint8Array>;
}

export interface RuntimeRegistrySnapshotVerificationKey {
  publicJwk: JsonWebKey;
  keyId?: string | null;
}

export interface RuntimeRegistrySnapshotVerificationEnv {
  TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWK?: string;
  TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS?: string;
  TENANT_RUNTIME_REGISTRY_PREVIOUS_VERIFYING_PUBLIC_JWK?: string;
}

export interface PublishTenantRuntimeRegistrySnapshotOptions {
  tenantId: string;
  storageProfileId: string;
  repository: TenantDatabaseRegistryRepository;
  snapshotStore?: RuntimeRegistrySnapshotStore | null;
  deploymentTarget?: string | null;
  now?: Date;
  snapshotTtlSeconds?: number;
  generationTtlSeconds?: number;
  actorId?: string | null;
  signingKey?: RuntimeRegistrySnapshotSigningKey | null;
  externalSigner?: RuntimeRegistrySnapshotExternalSigner | null;
}

export interface PublishTenantRuntimeRegistrySnapshotResult {
  snapshot: TenantRuntimeRegistrySnapshot;
  snapshotKey: string;
  generationKey: string;
}

export interface PurgeTenantRuntimeRegistrySnapshotOptions {
  tenantId: string;
  snapshotStore: RuntimeRegistryPurgeStore;
  deploymentTarget?: string | null;
  actorId: string;
  actorRoles: string[];
  breakGlassConfirmation: string;
  reason: string;
  now?: Date;
}

export interface PurgeTenantRuntimeRegistrySnapshotResult {
  tenantId: string;
  deploymentTarget: string;
  snapshotKey: string;
  generationKey: string;
  purgedAt: string;
  auditEvent: {
    action: 'tenant_runtime_registry_snapshot.emergency_purge';
    resourceType: 'tenant_runtime_registry_snapshot';
    resourceId: string;
    result: 'success';
    metadata: Record<string, unknown>;
  };
}

export function buildTenantRuntimeRegistrySnapshotKey(
  tenantId: string,
  deploymentTarget: string = 'default'
): string {
  return `tenant:${tenantId}:runtime-registry:snapshot:tenant:${deploymentTarget}`;
}

export function buildTenantRuntimeRegistryGenerationKey(
  tenantId: string,
  deploymentTarget: string = 'default'
): string {
  return `tenant:${tenantId}:runtime-registry:generation:tenant:${deploymentTarget}`;
}

export async function purgeTenantRuntimeRegistrySnapshot(
  options: PurgeTenantRuntimeRegistrySnapshotOptions
): Promise<PurgeTenantRuntimeRegistrySnapshotResult> {
  const deploymentTarget = options.deploymentTarget?.trim() || 'default';
  const reason = options.reason.trim();
  if (!options.actorRoles.includes('system_admin')) {
    throw new Error('tenant_runtime_registry_purge_requires_system_admin');
  }
  if (options.breakGlassConfirmation !== TENANT_RUNTIME_REGISTRY_EMERGENCY_PURGE_CONFIRMATION) {
    throw new Error('tenant_runtime_registry_purge_requires_break_glass_confirmation');
  }
  if (!reason) {
    throw new Error('tenant_runtime_registry_purge_requires_reason');
  }

  const snapshotKey = buildTenantRuntimeRegistrySnapshotKey(options.tenantId, deploymentTarget);
  const generationKey = buildTenantRuntimeRegistryGenerationKey(options.tenantId, deploymentTarget);
  await options.snapshotStore.delete(snapshotKey);
  await options.snapshotStore.delete(generationKey);

  const purgedAt = (options.now ?? new Date()).toISOString();
  return {
    tenantId: options.tenantId,
    deploymentTarget,
    snapshotKey,
    generationKey,
    purgedAt,
    auditEvent: {
      action: 'tenant_runtime_registry_snapshot.emergency_purge',
      resourceType: 'tenant_runtime_registry_snapshot',
      resourceId: snapshotKey,
      result: 'success',
      metadata: {
        tenant_id: options.tenantId,
        deployment_target: deploymentTarget,
        generation_key: generationKey,
        actor_id: options.actorId,
        reason,
        break_glass: true,
      },
    },
  };
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function parseJsonWebKey(input: JsonWebKey | string): JsonWebKey {
  if (typeof input === 'string') {
    const parsed = JSON.parse(input) as JsonWebKey;
    return parsed;
  }
  return input;
}

function isEd25519Jwk(jwk: JsonWebKey): boolean {
  return jwk.kty === 'OKP' && jwk.crv === 'Ed25519';
}

function getJwkKeyId(jwk: JsonWebKey): string | null {
  const kid = (jwk as unknown as Record<string, unknown>).kid;
  return typeof kid === 'string' && kid.length > 0 ? kid : null;
}

function base64UrlEncode(bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function canonicalizeJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('runtime_registry_snapshot_unsupported_canonical_json_value');
}

function createSnapshotSigningPayload(snapshot: TenantRuntimeRegistrySnapshot): Uint8Array {
  const signingSnapshot: TenantRuntimeRegistrySnapshot = {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      signature: null,
      signatureKeyId: null,
      signatureAlgorithm: null,
      signedAt: null,
    },
  };
  return new TextEncoder().encode(canonicalizeJson(signingSnapshot));
}

async function importEd25519PrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  if (!isEd25519Jwk(jwk) || typeof jwk.d !== 'string') {
    throw new Error('runtime_registry_snapshot_signing_key_must_be_ed25519_private_jwk');
  }
  return crypto.subtle.importKey('jwk', jwk, RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM, false, [
    'sign',
  ]);
}

async function importEd25519PublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  if (!isEd25519Jwk(jwk) || typeof jwk.x !== 'string') {
    throw new Error('runtime_registry_snapshot_verification_key_must_be_ed25519_public_jwk');
  }
  return crypto.subtle.importKey(
    'jwk',
    { ...jwk, d: undefined },
    RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM,
    false,
    ['verify']
  );
}

export async function signTenantRuntimeRegistrySnapshot(
  snapshot: TenantRuntimeRegistrySnapshot,
  key: RuntimeRegistrySnapshotSigningKey,
  signedAt: string
): Promise<TenantRuntimeRegistrySnapshot> {
  const privateJwk = parseJsonWebKey(key.privateJwk);
  const cryptoKey = await importEd25519PrivateKey(privateJwk);
  const signature = await crypto.subtle.sign(
    RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM,
    cryptoKey,
    createSnapshotSigningPayload(snapshot)
  );
  const keyId = key.keyId ?? getJwkKeyId(privateJwk);
  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      signature: base64UrlEncode(signature),
      signatureKeyId: keyId,
      signatureAlgorithm: RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM,
      signedAt,
    },
  };
}

export async function signTenantRuntimeRegistrySnapshotWithExternalSigner(
  snapshot: TenantRuntimeRegistrySnapshot,
  signer: RuntimeRegistrySnapshotExternalSigner,
  signedAt: string
): Promise<TenantRuntimeRegistrySnapshot> {
  const signature = await signer.sign(createSnapshotSigningPayload(snapshot));
  let encodedSignature: string;
  if (typeof signature === 'string') {
    encodedSignature = signature;
  } else {
    let signatureBuffer: ArrayBuffer;
    if (signature instanceof Uint8Array) {
      const copy = new Uint8Array(signature.byteLength);
      copy.set(signature);
      signatureBuffer = copy.buffer;
    } else {
      signatureBuffer = signature;
    }
    encodedSignature = base64UrlEncode(signatureBuffer);
  }
  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      signature: encodedSignature,
      signatureKeyId: signer.keyId,
      signatureAlgorithm: signer.algorithm,
      signedAt,
    },
  };
}

export function loadTenantRuntimeRegistryVerificationKeysFromEnv(
  env: RuntimeRegistrySnapshotVerificationEnv
): RuntimeRegistrySnapshotVerificationKey[] {
  const keys: RuntimeRegistrySnapshotVerificationKey[] = [];
  const addKey = (input: string | undefined) => {
    if (!input) return;
    const parsed = JSON.parse(input) as JsonWebKey | { keys?: JsonWebKey[] };
    const jwks =
      'keys' in parsed && Array.isArray(parsed.keys) ? parsed.keys : [parsed as JsonWebKey];
    for (const jwk of jwks) {
      if (isEd25519Jwk(jwk)) {
        keys.push({ publicJwk: { ...jwk, d: undefined }, keyId: getJwkKeyId(jwk) });
      }
    }
  };

  addKey(env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS);
  addKey(env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWK);
  addKey(env.TENANT_RUNTIME_REGISTRY_PREVIOUS_VERIFYING_PUBLIC_JWK);
  return keys;
}

export async function verifyTenantRuntimeRegistrySnapshotSignature(
  snapshot: TenantRuntimeRegistrySnapshot,
  keys: RuntimeRegistrySnapshotVerificationKey[]
): Promise<'valid' | 'unsigned' | 'invalid' | 'not_configured'> {
  if (keys.length === 0) return 'not_configured';
  const signature = snapshot.metadata.signature;
  const signatureKeyId = snapshot.metadata.signatureKeyId;
  if (
    !signature ||
    !signatureKeyId ||
    snapshot.metadata.signatureAlgorithm !== RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM
  ) {
    return 'unsigned';
  }

  const matchingKeys = keys.filter(
    (key) => (key.keyId ?? getJwkKeyId(key.publicJwk)) === signatureKeyId
  );
  if (matchingKeys.length === 0) return 'invalid';
  const payload = createSnapshotSigningPayload(snapshot);
  const signatureBytes = base64UrlDecode(signature);
  for (const key of matchingKeys) {
    const cryptoKey = await importEd25519PublicKey(key.publicJwk);
    if (
      await crypto.subtle.verify(
        RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM,
        cryptoKey,
        signatureBytes,
        payload
      )
    ) {
      return 'valid';
    }
  }
  return 'invalid';
}

function getHealthStatus(
  row: TenantDatabaseRegistryRow
): TenantRuntimeRegistryStoreSnapshot['healthStatus'] {
  if (row.status === 'degraded_pending_snapshot') return 'degraded_pending_snapshot';
  if (row.status === 'degraded') return 'degraded';
  return 'active';
}

function isSnapshotPublishableRegistryStatus(status: TenantDatabaseRegistryRow['status']): boolean {
  return ['ready', 'active', 'degraded', 'degraded_pending_snapshot'].includes(status);
}

function toStoreSnapshot(
  row: TenantDatabaseRegistryRow,
  pointer: TenantDatabaseActivePointer
): TenantRuntimeRegistryStoreSnapshot {
  return {
    tenantId: row.tenant_id,
    role: row.role,
    generation: row.generation,
    runtimeGeneration: pointer.runtime_generation,
    schemaVersion: row.schema_version,
    shardGroup: row.shard_group,
    shardIndex: row.shard_index,
    shardCount: row.shard_count,
    shardKeyStrategy: row.shard_key_strategy,
    provider: row.provider,
    driver: row.provider,
    bindingRef: row.binding_ref,
    connectionRef: row.connection_ref,
    deploymentTarget: row.deployment_target,
    status: row.status,
    healthStatus: getHealthStatus(row),
    databaseId: row.database_id,
    databaseName: row.database_name,
    regionHint: row.region_hint,
    jurisdiction: row.jurisdiction,
  };
}

function rowKey(row: TenantDatabaseRegistryRow): TenantDatabaseRegistryKey {
  return {
    tenant_id: row.tenant_id,
    role: row.role,
    generation: row.generation,
    shard_group: row.shard_group,
    shard_index: row.shard_index,
  };
}

async function loadActiveRegistryRows(
  repository: TenantDatabaseRegistryRepository,
  tenantId: string
): Promise<Array<{ pointer: TenantDatabaseActivePointer; row: TenantDatabaseRegistryRow }>> {
  const pointers = await repository.listActivePointersForTenant(tenantId);
  const pairs: Array<{ pointer: TenantDatabaseActivePointer; row: TenantDatabaseRegistryRow }> = [];

  for (const pointer of pointers) {
    for (let shardIndex = 0; shardIndex < pointer.shard_count; shardIndex += 1) {
      const row = await repository.getRegistryRow({
        tenant_id: tenantId,
        role: pointer.role,
        generation: pointer.generation,
        shard_group: pointer.shard_group,
        shard_index: shardIndex,
      });
      if (!row) {
        throw new Error(
          `tenant_runtime_registry_snapshot_missing_registry_row:${tenantId}:${pointer.role}:${pointer.generation}:${pointer.shard_group}:${shardIndex}`
        );
      }
      if (!isSnapshotPublishableRegistryStatus(row.status)) {
        throw new Error(
          `tenant_runtime_registry_snapshot_inactive_registry_row:${tenantId}:${pointer.role}:${pointer.generation}:${pointer.shard_group}:${shardIndex}:${row.status}`
        );
      }
      pairs.push({ pointer, row });
    }
  }

  return pairs;
}

async function markSnapshotPublishFailure(
  repository: TenantDatabaseRegistryRepository,
  pairs: Array<{ pointer: TenantDatabaseActivePointer; row: TenantDatabaseRegistryRow }>,
  actorId: string | null,
  error: unknown
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const markedPointers = new Set<string>();

  for (const { pointer, row } of pairs) {
    const metadata = JSON.stringify({
      snapshot_publish_error: errorMessage,
      snapshot_publish_failed_at: new Date().toISOString(),
    });
    const pointerKey = `${pointer.tenant_id}:${pointer.role}:${pointer.shard_group}`;
    if (!markedPointers.has(pointerKey)) {
      markedPointers.add(pointerKey);
      await repository.updateActivePointerStatus(
        pointer.tenant_id,
        pointer.role,
        pointer.shard_group,
        'degraded_pending_snapshot',
        actorId,
        metadata
      );
    }
    await repository.updateRegistryStatusAndMetadata(
      rowKey(row),
      'degraded_pending_snapshot',
      metadata,
      actorId
    );
  }
}

async function markSnapshotPublishSuccess(
  repository: TenantDatabaseRegistryRepository,
  pairs: Array<{ pointer: TenantDatabaseActivePointer; row: TenantDatabaseRegistryRow }>,
  actorId: string | null
): Promise<void> {
  const markedPointers = new Set<string>();

  for (const { pointer, row } of pairs) {
    const pointerKey = `${pointer.tenant_id}:${pointer.role}:${pointer.shard_group}`;
    if (pointer.status === 'degraded_pending_snapshot' && !markedPointers.has(pointerKey)) {
      markedPointers.add(pointerKey);
      await repository.updateActivePointerStatus(
        pointer.tenant_id,
        pointer.role,
        pointer.shard_group,
        'active',
        actorId,
        null
      );
    }
    if (row.status === 'degraded_pending_snapshot') {
      await repository.updateRegistryStatusAndMetadata(rowKey(row), 'active', null, actorId);
    }
  }
}

export async function publishTenantRuntimeRegistrySnapshot(
  options: PublishTenantRuntimeRegistrySnapshotOptions
): Promise<PublishTenantRuntimeRegistrySnapshotResult> {
  const deploymentTarget = options.deploymentTarget?.trim() || 'default';
  const now = options.now ?? new Date();
  const publishedAt = now.toISOString();
  const snapshotTtlSeconds =
    options.snapshotTtlSeconds ?? DEFAULT_RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS;
  const generationTtlSeconds =
    options.generationTtlSeconds ?? DEFAULT_RUNTIME_REGISTRY_GENERATION_TTL_SECONDS;
  const expiresAt = addSeconds(now, snapshotTtlSeconds).toISOString();
  const pairs = await loadActiveRegistryRows(options.repository, options.tenantId);

  if (pairs.length === 0) {
    throw new Error(`tenant_runtime_registry_snapshot_no_active_stores:${options.tenantId}`);
  }

  const runtimeGeneration = Math.max(...pairs.map(({ pointer }) => pointer.runtime_generation), 1);
  const stores = pairs.map(({ pointer, row }) => toStoreSnapshot(row, pointer));
  const snapshot: TenantRuntimeRegistrySnapshot = {
    version: RUNTIME_REGISTRY_SNAPSHOT_VERSION,
    tenantId: options.tenantId,
    snapshotScope: 'tenant',
    deploymentTarget,
    runtimeGeneration,
    storageProfileId: options.storageProfileId,
    publishedAt,
    expiresAt,
    stores,
    metadata: {
      storeCount: stores.length,
      roles: Array.from(new Set(stores.map((store) => store.role))).sort(),
      signature: null,
      signatureKeyId: null,
      signatureAlgorithm: null,
      signedAt: null,
    },
  };
  const snapshotKey = buildTenantRuntimeRegistrySnapshotKey(options.tenantId, deploymentTarget);
  const generationKey = buildTenantRuntimeRegistryGenerationKey(options.tenantId, deploymentTarget);
  let publishSnapshot = snapshot;

  try {
    if (options.signingKey && options.externalSigner) {
      throw new Error('runtime_registry_snapshot_multiple_signers_configured');
    }
    if (options.snapshotStore && !options.signingKey && !options.externalSigner) {
      throw new Error('runtime_registry_snapshot_signer_required');
    }

    publishSnapshot = options.externalSigner
      ? await signTenantRuntimeRegistrySnapshotWithExternalSigner(
          snapshot,
          options.externalSigner,
          publishedAt
        )
      : options.signingKey
        ? await signTenantRuntimeRegistrySnapshot(snapshot, options.signingKey, publishedAt)
        : snapshot;

    if (options.snapshotStore) {
      await options.snapshotStore.put(snapshotKey, JSON.stringify(publishSnapshot), {
        expirationTtl: snapshotTtlSeconds,
      });
      await options.snapshotStore.put(
        generationKey,
        JSON.stringify({ runtimeGeneration, publishedAt, expiresAt }),
        { expirationTtl: generationTtlSeconds }
      );
    }
  } catch (error) {
    await markSnapshotPublishFailure(options.repository, pairs, options.actorId ?? null, error);
    throw error;
  }

  await options.repository.upsertRuntimeCacheGeneration({
    tenant_id: options.tenantId,
    cache_namespace: 'runtime_registry',
    generation: runtimeGeneration,
    updated_by: options.actorId ?? null,
    metadata_json: JSON.stringify({
      snapshot_key: snapshotKey,
      generation_key: generationKey,
      deployment_target: deploymentTarget,
      signature_key_id: publishSnapshot.metadata.signatureKeyId,
    }),
  });
  await options.repository.upsertRuntimeRegistrySnapshot({
    tenant_id: options.tenantId,
    snapshot_scope: 'tenant',
    deployment_target: deploymentTarget,
    runtime_generation: runtimeGeneration,
    storage_profile_id: options.storageProfileId,
    object_ref: snapshotKey,
    published_at: publishedAt,
    expires_at: expiresAt,
    signature: publishSnapshot.metadata.signature,
    signature_key_id: publishSnapshot.metadata.signatureKeyId,
    metadata_json: JSON.stringify({
      generation_key: generationKey,
      store_count: stores.length,
      roles: publishSnapshot.metadata.roles,
      signature_key_id: publishSnapshot.metadata.signatureKeyId,
    }),
  });
  await markSnapshotPublishSuccess(options.repository, pairs, options.actorId ?? null);

  return {
    snapshot: publishSnapshot,
    snapshotKey,
    generationKey,
  };
}
