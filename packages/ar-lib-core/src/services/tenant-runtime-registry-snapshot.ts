import type {
  TenantDatabaseActivePointer,
  TenantDatabaseRegistryKey,
  TenantDatabaseRegistryRepository,
  TenantDatabaseRegistryRow,
  TenantRuntimeCacheGenerationRow,
} from '../repositories/admin/tenant-database-registry';
import { CompactSign, compactVerify, decodeProtectedHeader, importJWK, type JWK } from 'jose';

export const RUNTIME_REGISTRY_SNAPSHOT_VERSION = 4;
export const DEFAULT_RUNTIME_REGISTRY_SNAPSHOT_TTL_SECONDS = 30 * 60;
export const DEFAULT_RUNTIME_REGISTRY_GENERATION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const TENANT_RUNTIME_REGISTRY_EMERGENCY_PURGE_CONFIRMATION =
  'PURGE_TENANT_RUNTIME_REGISTRY_SNAPSHOT';
export const RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM = 'EdDSA';
export const RUNTIME_REGISTRY_SNAPSHOT_JWS_TYPE = 'authrim-runtime-registry+jws';

const MAX_RUNTIME_REGISTRY_SNAPSHOT_JWS_BYTES = 512 * 1024;
const MAX_RUNTIME_REGISTRY_VERIFICATION_JWKS_BYTES = 16 * 1024;
const SAFE_KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

export interface RuntimeRegistrySnapshotStore {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
}

export interface RuntimeRegistryPurgeStore {
  delete(key: string): Promise<unknown>;
}

export interface TenantRuntimeRegistryStoreSnapshot {
  tenantId: string;
  role: TenantDatabaseRegistryRow['role'];
  dataRole: 'tenant_core/default' | 'tenant_core/users' | 'tenant_pii';
  residencyPolicyId: string;
  residencyPartition: string;
  shardId: string;
  assignmentGeneration: number;
  bindingRouteGeneration: number;
  placementPolicyGeneration: number;
  allocationScope: 'shared_pool' | 'tenant_exclusive';
  ownerTenantId: string | null;
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

export type TenantRuntimeRegistryRouteStatus =
  | 'active'
  | 'quarantining'
  | 'quarantined'
  | 'disabled';

export interface TenantRuntimeRegistryRouteState {
  routeStatus: TenantRuntimeRegistryRouteStatus;
  quarantineDenyGeneration: number;
}

export interface TenantRuntimeRegistryGenerationDocument extends TenantRuntimeRegistryRouteState {
  runtimeGeneration: number;
  publishedAt: string;
  expiresAt: string;
}

export interface TransitionTenantRuntimeRegistryRouteStateOptions {
  tenantId: string;
  routeStatus: Exclude<TenantRuntimeRegistryRouteStatus, 'active'>;
  operationId: string;
  actorId: string;
  now?: Date;
}

export interface TransitionTenantRuntimeRegistryRouteStateResult extends TenantRuntimeRegistryRouteState {
  runtimeGeneration: number;
  changed: boolean;
}

export interface ReactivateTenantRuntimeRegistryRouteStateOptions {
  tenantId: string;
  operationId: string;
  actorId: string;
  expectedQuarantineDenyGeneration: number;
  now?: Date;
}

export interface TenantRuntimeRegistrySnapshot {
  version: number;
  tenantId: string;
  snapshotScope: 'tenant';
  deploymentTarget: string;
  runtimeGeneration: number;
  routeStatus: TenantRuntimeRegistryRouteStatus;
  quarantineDenyGeneration: number;
  backend: {
    provider: 'd1';
    resolver: 'control-plane';
  };
  placement: TenantRuntimeRegistryPlacementSnapshot;
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

export function hasPhysicalCorePiiDatabaseSeparation(
  stores: readonly TenantRuntimeRegistryStoreSnapshot[]
): boolean {
  const coreDatabaseIds = new Set<string>();
  for (const store of stores) {
    if (store.provider !== 'd1' || typeof store.databaseId !== 'string' || !store.databaseId) {
      return false;
    }
    if (store.dataRole === 'tenant_core/default' || store.dataRole === 'tenant_core/users') {
      coreDatabaseIds.add(store.databaseId);
    }
  }
  return stores.every(
    (store) => store.dataRole !== 'tenant_pii' || !coreDatabaseIds.has(store.databaseId as string)
  );
}

export interface RuntimeRegistrySnapshotSigningKey {
  privateJwk: JsonWebKey | string;
  keyId?: string | null;
}

export interface RuntimeRegistrySnapshotExternalSigner {
  keyId: string;
  algorithm: typeof RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM;
  type: typeof RUNTIME_REGISTRY_SNAPSHOT_JWS_TYPE;
  sign(payload: Uint8Array): Promise<string>;
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
  placement: TenantRuntimeRegistryPlacementSnapshot;
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

export interface TenantRuntimeRegistryPlacementSnapshot {
  isolationPolicy: 'shared_pool' | 'tenant_exclusive';
  policyGeneration: number;
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

function parseMetadataObject(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) return {};
  const parsed = JSON.parse(metadataJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('runtime_registry_route_state_metadata_invalid');
  }
  return parsed as Record<string, unknown>;
}

function createRuntimeGenerationDocument(input: {
  runtimeGeneration: number;
  routeState: TenantRuntimeRegistryRouteState;
  publishedAt: string;
  expiresAt: string;
}): TenantRuntimeRegistryGenerationDocument {
  return {
    runtimeGeneration: input.runtimeGeneration,
    routeStatus: input.routeState.routeStatus,
    quarantineDenyGeneration: input.routeState.quarantineDenyGeneration,
    publishedAt: input.publishedAt,
    expiresAt: input.expiresAt,
  };
}

export function getTenantRuntimeRegistryRouteState(
  row: TenantRuntimeCacheGenerationRow | null
): TenantRuntimeRegistryRouteState {
  if (!row) {
    return { routeStatus: 'active', quarantineDenyGeneration: 0 };
  }

  const metadata = parseMetadataObject(row.metadata_json);
  const routeStatusValue = metadata.route_status;
  const routeStatus = routeStatusValue ?? 'active';
  if (
    routeStatus !== 'active' &&
    routeStatus !== 'quarantining' &&
    routeStatus !== 'quarantined' &&
    routeStatus !== 'disabled'
  ) {
    throw new Error('runtime_registry_route_status_invalid');
  }

  const denyGenerationValue = metadata.quarantine_deny_generation ?? 0;
  if (
    typeof denyGenerationValue !== 'number' ||
    !Number.isSafeInteger(denyGenerationValue) ||
    denyGenerationValue < 0 ||
    (routeStatus !== 'active' && denyGenerationValue < 1)
  ) {
    throw new Error('runtime_registry_quarantine_deny_generation_invalid');
  }

  return {
    routeStatus,
    quarantineDenyGeneration: denyGenerationValue,
  };
}

function canTransitionRuntimeRegistryRouteState(
  current: TenantRuntimeRegistryRouteStatus,
  next: TenantRuntimeRegistryRouteStatus
): boolean {
  return (
    current === next ||
    (current === 'active' && next === 'quarantining') ||
    (current === 'quarantining' && next === 'quarantined') ||
    (current === 'quarantined' && next === 'disabled')
  );
}

export async function transitionTenantRuntimeRegistryRouteState(
  repository: TenantDatabaseRegistryRepository,
  options: TransitionTenantRuntimeRegistryRouteStateOptions
): Promise<TransitionTenantRuntimeRegistryRouteStateResult> {
  if (!SAFE_KEY_ID.test(options.tenantId) || !SAFE_KEY_ID.test(options.operationId)) {
    throw new Error('runtime_registry_route_state_transition_input_invalid');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentRow = await repository.getRuntimeCacheGeneration(
      options.tenantId,
      'runtime_registry'
    );
    const currentState = getTenantRuntimeRegistryRouteState(currentRow);
    const currentMetadata = parseMetadataObject(currentRow?.metadata_json ?? null);
    if (!canTransitionRuntimeRegistryRouteState(currentState.routeStatus, options.routeStatus)) {
      throw new Error('runtime_registry_route_state_transition_invalid');
    }

    if (currentState.routeStatus === options.routeStatus) {
      if (currentMetadata.route_state_operation_id !== options.operationId) {
        throw new Error('runtime_registry_route_state_operation_conflict');
      }
      return {
        ...currentState,
        runtimeGeneration: currentRow?.generation ?? 1,
        changed: false,
      };
    }

    const runtimeGeneration = Math.max(currentRow?.generation ?? 0, 0) + 1;
    const quarantineDenyGeneration = Math.max(currentState.quarantineDenyGeneration + 1, 1);
    const metadata = JSON.stringify({
      ...currentMetadata,
      route_status: options.routeStatus,
      quarantine_deny_generation: quarantineDenyGeneration,
      route_state_operation_id: options.operationId,
      route_state_changed_at: (options.now ?? new Date()).toISOString(),
    });
    const committed = await repository.compareAndSetRuntimeCacheGeneration(
      {
        tenant_id: options.tenantId,
        cache_namespace: 'runtime_registry',
        generation: runtimeGeneration,
        updated_by: options.actorId,
        metadata_json: metadata,
      },
      currentRow
    );
    if (committed) {
      return {
        routeStatus: options.routeStatus,
        quarantineDenyGeneration,
        runtimeGeneration,
        changed: true,
      };
    }
  }

  throw new Error('runtime_registry_route_state_transition_conflict');
}

/**
 * DR-only inverse transition. Deletion and ordinary lifecycle callers must continue to use the
 * forward-only transition function above.
 */
export async function reactivateTenantRuntimeRegistryRouteState(
  repository: TenantDatabaseRegistryRepository,
  options: ReactivateTenantRuntimeRegistryRouteStateOptions
): Promise<TransitionTenantRuntimeRegistryRouteStateResult> {
  if (
    !SAFE_KEY_ID.test(options.tenantId) ||
    !SAFE_KEY_ID.test(options.operationId) ||
    !Number.isSafeInteger(options.expectedQuarantineDenyGeneration) ||
    options.expectedQuarantineDenyGeneration < 1
  ) {
    throw new Error('runtime_registry_route_state_reactivation_input_invalid');
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentRow = await repository.getRuntimeCacheGeneration(
      options.tenantId,
      'runtime_registry'
    );
    const currentState = getTenantRuntimeRegistryRouteState(currentRow);
    const currentMetadata = parseMetadataObject(currentRow?.metadata_json ?? null);
    if (
      currentState.routeStatus === 'active' &&
      currentState.quarantineDenyGeneration === options.expectedQuarantineDenyGeneration &&
      currentMetadata.route_state_operation_id === options.operationId &&
      typeof currentMetadata.route_state_reactivated_at === 'string'
    ) {
      return {
        routeStatus: 'active',
        quarantineDenyGeneration: currentState.quarantineDenyGeneration,
        runtimeGeneration: currentRow?.generation ?? 1,
        changed: false,
      };
    }
    if (
      (currentState.routeStatus !== 'quarantining' && currentState.routeStatus !== 'quarantined') ||
      currentState.quarantineDenyGeneration !== options.expectedQuarantineDenyGeneration ||
      currentMetadata.route_state_operation_id !== options.operationId
    ) {
      throw new Error('runtime_registry_route_state_reactivation_not_allowed');
    }

    const runtimeGeneration = Math.max(currentRow?.generation ?? 0, 0) + 1;
    const metadata = JSON.stringify({
      ...currentMetadata,
      route_status: 'active',
      quarantine_deny_generation: currentState.quarantineDenyGeneration,
      route_state_reactivated_at: (options.now ?? new Date()).toISOString(),
    });
    const committed = await repository.compareAndSetRuntimeCacheGeneration(
      {
        tenant_id: options.tenantId,
        cache_namespace: 'runtime_registry',
        generation: runtimeGeneration,
        updated_by: options.actorId,
        metadata_json: metadata,
      },
      currentRow
    );
    if (committed) {
      return {
        routeStatus: 'active',
        quarantineDenyGeneration: currentState.quarantineDenyGeneration,
        runtimeGeneration,
        changed: true,
      };
    }
  }

  throw new Error('runtime_registry_route_state_reactivation_conflict');
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function assertRuntimeRegistrySnapshotJwsEnvelope(
  token: string,
  payload: Uint8Array,
  expectedKeyId: string
): void {
  if (
    typeof token !== 'string' ||
    token.length < 1 ||
    new TextEncoder().encode(token).byteLength > MAX_RUNTIME_REGISTRY_SNAPSHOT_JWS_BYTES ||
    !SAFE_KEY_ID.test(expectedKeyId)
  ) {
    throw new Error('runtime_registry_snapshot_jws_invalid');
  }
  const segments = token.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new Error('runtime_registry_snapshot_jws_invalid');
  }
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new Error('runtime_registry_snapshot_jws_header_invalid');
  }
  if (
    Object.keys(header).sort().join(',') !== 'alg,kid,typ' ||
    header.alg !== RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM ||
    header.typ !== RUNTIME_REGISTRY_SNAPSHOT_JWS_TYPE ||
    header.kid !== expectedKeyId
  ) {
    throw new Error('runtime_registry_snapshot_jws_header_invalid');
  }
  try {
    if (!equalBytes(base64UrlDecode(segments[1]), payload)) {
      throw new Error('runtime_registry_snapshot_jws_payload_mismatch');
    }
    if (base64UrlDecode(segments[2]).byteLength !== 64) {
      throw new Error('runtime_registry_snapshot_jws_signature_invalid');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('runtime_registry_snapshot_jws_')) {
      throw error;
    }
    throw new Error('runtime_registry_snapshot_jws_invalid');
  }
}

export async function signRuntimeRegistrySnapshotPayloadJws(input: {
  payload: Uint8Array;
  privateJwk: JsonWebKey | string;
  keyId?: string | null;
}): Promise<string> {
  const privateJwk = parseJsonWebKey(input.privateJwk);
  if (!isEd25519Jwk(privateJwk) || typeof privateJwk.d !== 'string') {
    throw new Error('runtime_registry_snapshot_signing_key_must_be_ed25519_private_jwk');
  }
  const keyId = input.keyId ?? getJwkKeyId(privateJwk);
  if (!keyId || !SAFE_KEY_ID.test(keyId)) {
    throw new Error('runtime_registry_snapshot_signing_key_id_required');
  }
  if (getJwkKeyId(privateJwk) && getJwkKeyId(privateJwk) !== keyId) {
    throw new Error('runtime_registry_snapshot_signing_key_id_mismatch');
  }
  const key = await importJWK(
    { ...(privateJwk as JWK), kid: keyId, alg: 'EdDSA', use: 'sig' },
    'EdDSA'
  );
  return new CompactSign(input.payload)
    .setProtectedHeader({
      alg: RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM,
      typ: RUNTIME_REGISTRY_SNAPSHOT_JWS_TYPE,
      kid: keyId,
    })
    .sign(key);
}

export async function verifyRuntimeRegistrySnapshotPayloadJws(input: {
  token: string;
  payload: Uint8Array;
  keys: RuntimeRegistrySnapshotVerificationKey[];
  expectedKeyId: string;
}): Promise<boolean> {
  try {
    assertRuntimeRegistrySnapshotJwsEnvelope(input.token, input.payload, input.expectedKeyId);
  } catch {
    return false;
  }
  const matchingKeys = input.keys.filter(
    (key) => (key.keyId ?? getJwkKeyId(key.publicJwk)) === input.expectedKeyId
  );
  for (const key of matchingKeys) {
    if (!isEd25519Jwk(key.publicJwk) || typeof key.publicJwk.x !== 'string') continue;
    try {
      const verificationKey = await importJWK(
        { ...(key.publicJwk as JWK), d: undefined, alg: 'EdDSA', use: 'sig' },
        'EdDSA'
      );
      const verified = await compactVerify(input.token, verificationKey, {
        algorithms: [RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM],
      });
      if (equalBytes(verified.payload, input.payload)) return true;
    } catch {
      // Try the previous rotation key with the same kid only if one was configured.
    }
  }
  return false;
}

export async function signTenantRuntimeRegistrySnapshot(
  snapshot: TenantRuntimeRegistrySnapshot,
  key: RuntimeRegistrySnapshotSigningKey,
  signedAt: string
): Promise<TenantRuntimeRegistrySnapshot> {
  const privateJwk = parseJsonWebKey(key.privateJwk);
  const keyId = key.keyId ?? getJwkKeyId(privateJwk);
  const signature = await signRuntimeRegistrySnapshotPayloadJws({
    payload: createSnapshotSigningPayload(snapshot),
    privateJwk,
    keyId,
  });
  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      signature,
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
  if (
    signer.algorithm !== RUNTIME_REGISTRY_SNAPSHOT_SIGNATURE_ALGORITHM ||
    signer.type !== RUNTIME_REGISTRY_SNAPSHOT_JWS_TYPE
  ) {
    throw new Error('runtime_registry_snapshot_external_signer_invalid');
  }
  const payload = createSnapshotSigningPayload(snapshot);
  const signature = await signer.sign(payload);
  assertRuntimeRegistrySnapshotJwsEnvelope(signature, payload, signer.keyId);
  return {
    ...snapshot,
    metadata: {
      ...snapshot.metadata,
      signature,
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
    if (new TextEncoder().encode(input).byteLength > MAX_RUNTIME_REGISTRY_VERIFICATION_JWKS_BYTES) {
      throw new Error('runtime_registry_snapshot_verification_jwks_too_large');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new Error('runtime_registry_snapshot_verification_jwks_invalid');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('runtime_registry_snapshot_verification_jwks_invalid');
    }
    const parsedRecord = parsed as Record<string, unknown>;
    const jwks = Array.isArray(parsedRecord.keys) ? parsedRecord.keys : [parsed];
    for (const candidate of jwks) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('runtime_registry_snapshot_verification_jwk_invalid');
      }
      const jwk = candidate as JsonWebKey;
      const record = jwk as unknown as Record<string, unknown>;
      const keyId = getJwkKeyId(jwk);
      if (
        !isEd25519Jwk(jwk) ||
        typeof jwk.x !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x) ||
        !keyId ||
        !SAFE_KEY_ID.test(keyId) ||
        (jwk.alg !== undefined && jwk.alg !== 'EdDSA') ||
        (jwk.use !== undefined && jwk.use !== 'sig') ||
        (jwk.key_ops !== undefined &&
          (!Array.isArray(jwk.key_ops) ||
            jwk.key_ops.length !== 1 ||
            jwk.key_ops[0] !== 'verify')) ||
        PRIVATE_JWK_FIELDS.some((field) => record[field] !== undefined)
      ) {
        throw new Error('runtime_registry_snapshot_verification_jwk_invalid');
      }
      if (keys.some((key) => key.keyId === keyId)) {
        throw new Error('runtime_registry_snapshot_verification_jwk_duplicate');
      }
      keys.push({ publicJwk: jwk, keyId });
      if (keys.length > 2) {
        throw new Error('runtime_registry_snapshot_verification_jwk_count_invalid');
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

  return (await verifyRuntimeRegistrySnapshotPayloadJws({
    token: signature,
    payload: createSnapshotSigningPayload(snapshot),
    keys,
    expectedKeyId: signatureKeyId,
  }))
    ? 'valid'
    : 'invalid';
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

interface TenantRuntimeRegistryStoreControlMetadata {
  dataRole: TenantRuntimeRegistryStoreSnapshot['dataRole'];
  residencyPolicyId: string;
  residencyPartition: string;
  shardId: string;
  assignmentGeneration: number;
  allocationScope: TenantRuntimeRegistryStoreSnapshot['allocationScope'];
  ownerTenantId: string | null;
  placementPolicyGeneration: number;
}

function requiredPositiveGeneration(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(code);
  }
  return value;
}

function parseStoreControlMetadata(
  row: TenantDatabaseRegistryRow
): TenantRuntimeRegistryStoreControlMetadata {
  const metadata = parseMetadataObject(row.metadata_json);
  const dataRole = metadata.control_data_role;
  const expectedRole = dataRole === 'tenant_pii' ? 'tenant_pii' : 'tenant_core';
  if (
    (dataRole !== 'tenant_core/default' &&
      dataRole !== 'tenant_core/users' &&
      dataRole !== 'tenant_pii') ||
    row.role !== expectedRole
  ) {
    throw new Error('tenant_runtime_registry_store_data_role_invalid');
  }
  const residencyPartition = metadata.control_residency_partition;
  const residencyPolicyId = metadata.control_residency_policy_id;
  if (
    typeof residencyPolicyId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(residencyPolicyId)
  ) {
    throw new Error('tenant_runtime_registry_store_residency_policy_invalid');
  }
  if (
    typeof residencyPartition !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(residencyPartition)
  ) {
    throw new Error('tenant_runtime_registry_store_residency_invalid');
  }
  const shardId = metadata.control_shard_id;
  if (typeof shardId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(shardId)) {
    throw new Error('tenant_runtime_registry_store_shard_invalid');
  }
  const allocationScope = metadata.control_allocation_scope;
  const ownerTenantId = metadata.control_owner_tenant_id ?? null;
  if (
    (allocationScope !== 'shared_pool' && allocationScope !== 'tenant_exclusive') ||
    (allocationScope === 'shared_pool' && ownerTenantId !== null) ||
    (allocationScope === 'tenant_exclusive' && ownerTenantId !== row.tenant_id)
  ) {
    throw new Error('tenant_runtime_registry_store_owner_invalid');
  }
  return {
    dataRole,
    residencyPolicyId,
    residencyPartition,
    shardId,
    assignmentGeneration: requiredPositiveGeneration(
      metadata.control_assignment_generation,
      'tenant_runtime_registry_store_assignment_generation_invalid'
    ),
    allocationScope,
    ownerTenantId: ownerTenantId as string | null,
    placementPolicyGeneration: requiredPositiveGeneration(
      metadata.control_placement_policy_generation,
      'tenant_runtime_registry_store_placement_generation_invalid'
    ),
  };
}

function toStoreSnapshot(
  row: TenantDatabaseRegistryRow,
  pointer: TenantDatabaseActivePointer
): TenantRuntimeRegistryStoreSnapshot {
  const control = parseStoreControlMetadata(row);
  return {
    tenantId: row.tenant_id,
    role: row.role,
    dataRole: control.dataRole,
    residencyPolicyId: control.residencyPolicyId,
    residencyPartition: control.residencyPartition,
    shardId: control.shardId,
    assignmentGeneration: control.assignmentGeneration,
    bindingRouteGeneration: row.generation,
    placementPolicyGeneration: control.placementPolicyGeneration,
    allocationScope: control.allocationScope,
    ownerTenantId: control.ownerTenantId,
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
      if (
        row.tenant_id !== tenantId ||
        row.role !== pointer.role ||
        row.generation !== pointer.generation ||
        row.shard_group !== pointer.shard_group ||
        row.shard_index !== shardIndex
      ) {
        throw new Error(
          `tenant_runtime_registry_snapshot_registry_identity_mismatch:${tenantId}:${pointer.role}:${pointer.generation}:${pointer.shard_group}:${shardIndex}`
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
  const generationExpiresAt = addSeconds(now, generationTtlSeconds).toISOString();
  const currentCacheGeneration = await options.repository.getRuntimeCacheGeneration(
    options.tenantId,
    'runtime_registry'
  );
  const routeState = getTenantRuntimeRegistryRouteState(currentCacheGeneration);
  const pairs = await loadActiveRegistryRows(options.repository, options.tenantId);

  if (pairs.length === 0 && routeState.routeStatus === 'active') {
    throw new Error(`tenant_runtime_registry_snapshot_no_active_stores:${options.tenantId}`);
  }

  const runtimeGeneration = Math.max(
    ...pairs.map(({ pointer }) => pointer.runtime_generation),
    currentCacheGeneration?.generation ?? 1,
    1
  );
  const stores = pairs.map(({ pointer, row }) => toStoreSnapshot(row, pointer));
  if (!hasPhysicalCorePiiDatabaseSeparation(stores)) {
    throw new Error('tenant_runtime_registry_snapshot_pii_isolation_violation');
  }
  if (
    stores.some((store) => store.runtimeGeneration !== runtimeGeneration) ||
    !Number.isSafeInteger(options.placement.policyGeneration) ||
    options.placement.policyGeneration < 1 ||
    (options.placement.isolationPolicy !== 'shared_pool' &&
      options.placement.isolationPolicy !== 'tenant_exclusive') ||
    stores.some(
      (store) =>
        store.allocationScope !== options.placement.isolationPolicy ||
        (store.allocationScope === 'tenant_exclusive' &&
          store.ownerTenantId !== options.tenantId) ||
        (store.allocationScope === 'shared_pool' && store.ownerTenantId !== null) ||
        store.placementPolicyGeneration !== options.placement.policyGeneration
    )
  ) {
    throw new Error(
      stores.some((store) => store.runtimeGeneration !== runtimeGeneration)
        ? 'tenant_runtime_registry_snapshot_generation_mismatch'
        : 'tenant_runtime_registry_snapshot_placement_mismatch'
    );
  }
  const snapshot: TenantRuntimeRegistrySnapshot = {
    version: RUNTIME_REGISTRY_SNAPSHOT_VERSION,
    tenantId: options.tenantId,
    snapshotScope: 'tenant',
    deploymentTarget,
    runtimeGeneration,
    routeStatus: routeState.routeStatus,
    quarantineDenyGeneration: routeState.quarantineDenyGeneration,
    backend: {
      provider: 'd1',
      resolver: 'control-plane',
    },
    placement: options.placement,
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
      const generationDocument = createRuntimeGenerationDocument({
        runtimeGeneration,
        routeState,
        publishedAt,
        expiresAt: generationExpiresAt,
      });
      if (routeState.routeStatus === 'active') {
        await options.snapshotStore.put(snapshotKey, JSON.stringify(publishSnapshot), {
          expirationTtl: snapshotTtlSeconds,
        });
        await options.snapshotStore.put(generationKey, JSON.stringify(generationDocument), {
          expirationTtl: generationTtlSeconds,
        });
      } else {
        await options.snapshotStore.put(generationKey, JSON.stringify(generationDocument), {
          expirationTtl: generationTtlSeconds,
        });
        await options.snapshotStore.put(snapshotKey, JSON.stringify(publishSnapshot), {
          expirationTtl: snapshotTtlSeconds,
        });
      }
    }
  } catch (error) {
    await markSnapshotPublishFailure(options.repository, pairs, options.actorId ?? null, error);
    throw error;
  }

  const cacheGenerationMetadata = JSON.stringify({
    ...parseMetadataObject(currentCacheGeneration?.metadata_json ?? null),
    snapshot_key: snapshotKey,
    generation_key: generationKey,
    deployment_target: deploymentTarget,
    signature_key_id: publishSnapshot.metadata.signatureKeyId,
    route_status: routeState.routeStatus,
    quarantine_deny_generation: routeState.quarantineDenyGeneration,
  });
  let committed: boolean;
  try {
    committed = await options.repository.commitRuntimeCacheGenerationPublication(
      {
        tenant_id: options.tenantId,
        cache_namespace: 'runtime_registry',
        generation: runtimeGeneration,
        updated_by: options.actorId ?? null,
        metadata_json: cacheGenerationMetadata,
      },
      currentCacheGeneration
    );
  } catch (error) {
    await markSnapshotPublishFailure(options.repository, pairs, options.actorId ?? null, error);
    throw error;
  }
  if (!committed) {
    const latest = await options.repository.getRuntimeCacheGeneration(
      options.tenantId,
      'runtime_registry'
    );
    if (options.snapshotStore && latest) {
      const latestRouteState = getTenantRuntimeRegistryRouteState(latest);
      await options.snapshotStore.put(
        generationKey,
        JSON.stringify(
          createRuntimeGenerationDocument({
            runtimeGeneration: latest.generation,
            routeState: latestRouteState,
            publishedAt,
            expiresAt: generationExpiresAt,
          })
        ),
        { expirationTtl: generationTtlSeconds }
      );
    }
    throw new Error('tenant_runtime_registry_snapshot_stale_publication');
  }
  try {
    await options.repository.upsertRuntimeRegistrySnapshot({
      tenant_id: options.tenantId,
      snapshot_scope: 'tenant',
      deployment_target: deploymentTarget,
      runtime_generation: runtimeGeneration,
      backend_provider: 'd1',
      placement_policy: options.placement.isolationPolicy,
      placement_policy_generation: options.placement.policyGeneration,
      snapshot_version: RUNTIME_REGISTRY_SNAPSHOT_VERSION,
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
        route_status: routeState.routeStatus,
        quarantine_deny_generation: routeState.quarantineDenyGeneration,
      }),
    });
    await markSnapshotPublishSuccess(options.repository, pairs, options.actorId ?? null);
  } catch (error) {
    await markSnapshotPublishFailure(options.repository, pairs, options.actorId ?? null, error);
    throw error;
  }

  return {
    snapshot: publishSnapshot,
    snapshotKey,
    generationKey,
  };
}
