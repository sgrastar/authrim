import {
  CompactSign,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
  type CryptoKey,
  type JWK,
} from 'jose';

export const RUNTIME_SMOKE_JWS_TYPE = 'authrim-smoke-rpc+jws';
export const RUNTIME_SMOKE_TTL_SECONDS = 30;
export const RUNTIME_SMOKE_CLOCK_SKEW_SECONDS = 5;
export const RUNTIME_SMOKE_LOOKUP_METADATA_KEY = 'authrim.control_plane.shard';

const MAX_JWS_BYTES = 8 * 1024;
const MAX_JWKS_BYTES = 16 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_WORKER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_BINDING = /^(?:[A-Z][A-Z0-9_]*_)?TDB_[A-Z0-9_]{1,120}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DATA_ROLES = new Set([
  'tenant_core/default',
  'tenant_core/users',
  'tenant_pii',
  'lookup',
] as const);
const CLAIM_KEYS = new Set([
  'iss',
  'aud',
  'iat',
  'exp',
  'jti',
  'operationId',
  'attempt',
  'targetWorker',
  'bindingRef',
  'expectedMigrationGeneration',
  'dataRole',
  'residencyPartition',
]);
const LOOKUP_METADATA_KEYS = new Set([
  'binding_ref',
  'data_role',
  'residency_partition',
  'migration_generation',
  'release_id',
  'manifest_digest',
  'expected_file_count',
  'last_filename',
]);
const PROTECTED_HEADER_KEYS = new Set(['alg', 'typ', 'kid']);
const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

export type RuntimeSmokeDataRole =
  | 'tenant_core/default'
  | 'tenant_core/users'
  | 'tenant_pii'
  | 'lookup';

export interface RuntimeSmokeClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  operationId: string;
  attempt: number;
  targetWorker: string;
  bindingRef: string;
  expectedMigrationGeneration: number;
  dataRole: RuntimeSmokeDataRole;
  residencyPartition: string;
}

export interface RuntimeSmokeRequestInput {
  environmentId: string;
  operationId: string;
  attempt: number;
  targetWorker: string;
  bindingRef: string;
  expectedMigrationGeneration: number;
  dataRole: RuntimeSmokeDataRole;
  residencyPartition: string;
}

export interface RuntimeSmokeVerificationInput {
  environmentId: string;
  targetWorker: string;
  publicJwks: string | { keys: JWK[] };
  now?: number;
}

export interface RuntimeSmokeMetadataRow extends Record<string, unknown> {
  binding_ref: string;
  data_role: string;
  residency_partition: string;
  migration_generation: number;
  release_id: string;
  manifest_digest: string;
  expected_file_count: number;
  last_filename: string;
}

interface RuntimeSmokeLookupMetadataRow extends Record<string, unknown> {
  metadata_value: string;
}

export interface RuntimeSmokeVersionMetadata {
  id: string;
  tag: string;
  timestamp: string;
}

export interface RuntimeSmokeResult {
  bindingRef: string;
  migrationGeneration: number;
  dataRole: RuntimeSmokeDataRole;
  residencyPartition: string;
  checkedAt: number;
  observedVersionId: string;
  observedVersionTag: string;
  observedVersionTimestamp: string;
}

interface RuntimeSmokeD1Statement {
  bind(...values: unknown[]): RuntimeSmokeD1Statement;
  first<T>(): Promise<T | null>;
}

export interface RuntimeSmokeD1Database {
  prepare(query: string): RuntimeSmokeD1Statement;
}

function requiredPattern(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(code);
  return value;
}

function requiredInteger(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(code);
  }
  return value;
}

function requiredDataRole(value: unknown): RuntimeSmokeDataRole {
  if (typeof value !== 'string' || !DATA_ROLES.has(value as RuntimeSmokeDataRole)) {
    throw new Error('runtime_smoke_invalid_data_role');
  }
  return value as RuntimeSmokeDataRole;
}

function expectedIssuer(environmentId: string): string {
  return `authrim-control:${requiredPattern(
    environmentId,
    SAFE_ID,
    'runtime_smoke_invalid_environment_id'
  )}`;
}

export function runtimeSmokeJti(input: {
  operationId: string;
  attempt: number;
  targetWorker: string;
  bindingRef: string;
}): string {
  const operationId = requiredPattern(
    input.operationId,
    SAFE_ID,
    'runtime_smoke_invalid_operation_id'
  );
  const attempt = requiredInteger(input.attempt, 'runtime_smoke_invalid_attempt');
  const targetWorker = requiredPattern(
    input.targetWorker,
    SAFE_WORKER,
    'runtime_smoke_invalid_target_worker'
  );
  const bindingRef = requiredPattern(
    input.bindingRef,
    SAFE_BINDING,
    'runtime_smoke_invalid_binding_ref'
  );
  return `${operationId}:${attempt}:${targetWorker}:${bindingRef}`;
}

function normalizeRequest(input: RuntimeSmokeRequestInput, issuedAt: number): RuntimeSmokeClaims {
  const targetWorker = requiredPattern(
    input.targetWorker,
    SAFE_WORKER,
    'runtime_smoke_invalid_target_worker'
  );
  const bindingRef = requiredPattern(
    input.bindingRef,
    SAFE_BINDING,
    'runtime_smoke_invalid_binding_ref'
  );
  const operationId = requiredPattern(
    input.operationId,
    SAFE_ID,
    'runtime_smoke_invalid_operation_id'
  );
  const attempt = requiredInteger(input.attempt, 'runtime_smoke_invalid_attempt');
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 1) {
    throw new Error('runtime_smoke_invalid_issued_at');
  }
  return {
    iss: expectedIssuer(input.environmentId),
    aud: targetWorker,
    iat: issuedAt,
    exp: issuedAt + RUNTIME_SMOKE_TTL_SECONDS,
    jti: runtimeSmokeJti({ operationId, attempt, targetWorker, bindingRef }),
    operationId,
    attempt,
    targetWorker,
    bindingRef,
    expectedMigrationGeneration: requiredInteger(
      input.expectedMigrationGeneration,
      'runtime_smoke_invalid_migration_generation'
    ),
    dataRole: requiredDataRole(input.dataRole),
    residencyPartition: requiredPattern(
      input.residencyPartition,
      SAFE_PARTITION,
      'runtime_smoke_invalid_residency_partition'
    ),
  };
}

function assertEd25519Jwk(jwk: JWK, requirePrivate: boolean): void {
  const record = jwk as Record<string, unknown>;
  if (
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x) ||
    typeof jwk.kid !== 'string' ||
    !SAFE_ID.test(jwk.kid) ||
    (jwk.alg !== undefined && jwk.alg !== 'EdDSA') ||
    (jwk.use !== undefined && jwk.use !== 'sig')
  ) {
    throw new Error('runtime_smoke_invalid_ed25519_jwk');
  }
  if (requirePrivate) {
    if (typeof jwk.d !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.d)) {
      throw new Error('runtime_smoke_private_jwk_required');
    }
    return;
  }
  if (PRIVATE_JWK_FIELDS.some((field) => record[field] !== undefined)) {
    throw new Error('runtime_smoke_public_jwks_contains_private_material');
  }
}

function parsePublicJwks(input: string | { keys: JWK[] }): Map<string, JWK> {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_JWKS_BYTES) {
      throw new Error('runtime_smoke_public_jwks_too_large');
    }
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new Error('runtime_smoke_public_jwks_invalid_json');
    }
  } else if (new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_JWKS_BYTES) {
    throw new Error('runtime_smoke_public_jwks_too_large');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('runtime_smoke_public_jwks_invalid');
  }
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) {
    throw new Error('runtime_smoke_public_jwks_key_count_invalid');
  }
  const byId = new Map<string, JWK>();
  for (const candidate of keys) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('runtime_smoke_public_jwks_invalid_key');
    }
    const jwk = candidate as JWK;
    assertEd25519Jwk(jwk, false);
    if (byId.has(jwk.kid!)) throw new Error('runtime_smoke_public_jwks_duplicate_kid');
    byId.set(jwk.kid!, jwk);
  }
  return byId;
}

export async function signRuntimeSmokeRequest(input: {
  request: RuntimeSmokeRequestInput;
  privateJwk: JWK;
  keyId: string;
  now?: number;
}): Promise<string> {
  const keyId = requiredPattern(input.keyId, SAFE_ID, 'runtime_smoke_invalid_key_id');
  if (input.privateJwk.kid !== undefined && input.privateJwk.kid !== keyId) {
    throw new Error('runtime_smoke_private_jwk_kid_mismatch');
  }
  const privateJwk = { ...input.privateJwk, kid: keyId, alg: 'EdDSA', use: 'sig' };
  assertEd25519Jwk(privateJwk, true);
  const issuedAt = input.now ?? Math.floor(Date.now() / 1000);
  const claims = normalizeRequest(input.request, issuedAt);
  let key: CryptoKey;
  try {
    key = (await importJWK(privateJwk, 'EdDSA')) as CryptoKey;
  } catch {
    throw new Error('runtime_smoke_private_jwk_import_failed');
  }
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'EdDSA', typ: RUNTIME_SMOKE_JWS_TYPE, kid: keyId })
    .sign(key);
}

function decodeClaims(payload: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(payload)
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error('runtime_smoke_invalid_payload');
  }
}

export async function verifyRuntimeSmokeRequest(
  token: unknown,
  input: RuntimeSmokeVerificationInput
): Promise<RuntimeSmokeClaims> {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    new TextEncoder().encode(token).byteLength > MAX_JWS_BYTES ||
    token.split('.').length !== 3
  ) {
    throw new Error('runtime_smoke_invalid_jws');
  }
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new Error('runtime_smoke_invalid_protected_header');
  }
  if (
    header.alg !== 'EdDSA' ||
    header.typ !== RUNTIME_SMOKE_JWS_TYPE ||
    typeof header.kid !== 'string' ||
    Object.keys(header).some((keyName) => !PROTECTED_HEADER_KEYS.has(keyName))
  ) {
    throw new Error('runtime_smoke_invalid_protected_header');
  }
  const jwk = parsePublicJwks(input.publicJwks).get(header.kid);
  if (!jwk) throw new Error('runtime_smoke_unknown_key');
  let key: CryptoKey;
  try {
    key = (await importJWK(jwk, 'EdDSA')) as CryptoKey;
  } catch {
    throw new Error('runtime_smoke_public_jwk_import_failed');
  }
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(token, key, { algorithms: ['EdDSA'] }));
  } catch {
    throw new Error('runtime_smoke_signature_invalid');
  }
  const raw = decodeClaims(payload);
  if (Object.keys(raw).some((keyName) => !CLAIM_KEYS.has(keyName))) {
    throw new Error('runtime_smoke_unknown_claim');
  }
  const targetWorker = requiredPattern(
    raw.targetWorker,
    SAFE_WORKER,
    'runtime_smoke_invalid_target_worker'
  );
  const expectedTarget = requiredPattern(
    input.targetWorker,
    SAFE_WORKER,
    'runtime_smoke_invalid_expected_target_worker'
  );
  if (targetWorker !== expectedTarget || raw.aud !== expectedTarget) {
    throw new Error('runtime_smoke_target_mismatch');
  }
  const operationId = requiredPattern(
    raw.operationId,
    SAFE_ID,
    'runtime_smoke_invalid_operation_id'
  );
  const attempt = requiredInteger(raw.attempt, 'runtime_smoke_invalid_attempt');
  const bindingRef = requiredPattern(
    raw.bindingRef,
    SAFE_BINDING,
    'runtime_smoke_invalid_binding_ref'
  );
  const expectedJti = runtimeSmokeJti({ operationId, attempt, targetWorker, bindingRef });
  if (raw.jti !== expectedJti) throw new Error('runtime_smoke_jti_mismatch');
  if (raw.iss !== expectedIssuer(input.environmentId)) {
    throw new Error('runtime_smoke_issuer_mismatch');
  }
  const iat = requiredInteger(raw.iat, 'runtime_smoke_invalid_iat');
  const exp = requiredInteger(raw.exp, 'runtime_smoke_invalid_exp');
  if (exp - iat !== RUNTIME_SMOKE_TTL_SECONDS) {
    throw new Error('runtime_smoke_ttl_invalid');
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('runtime_smoke_invalid_now');
  if (iat > now + RUNTIME_SMOKE_CLOCK_SKEW_SECONDS) {
    throw new Error('runtime_smoke_not_yet_valid');
  }
  if (exp < now - RUNTIME_SMOKE_CLOCK_SKEW_SECONDS) {
    throw new Error('runtime_smoke_expired');
  }
  return {
    iss: raw.iss,
    aud: raw.aud,
    iat,
    exp,
    jti: expectedJti,
    operationId,
    attempt,
    targetWorker,
    bindingRef,
    expectedMigrationGeneration: requiredInteger(
      raw.expectedMigrationGeneration,
      'runtime_smoke_invalid_migration_generation'
    ),
    dataRole: requiredDataRole(raw.dataRole),
    residencyPartition: requiredPattern(
      raw.residencyPartition,
      SAFE_PARTITION,
      'runtime_smoke_invalid_residency_partition'
    ),
  };
}

function validVersionMetadata(value: unknown): value is RuntimeSmokeVersionMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    SAFE_ID.test(record.id) &&
    typeof record.tag === 'string' &&
    record.tag.length <= 100 &&
    typeof record.timestamp === 'string' &&
    Number.isFinite(Date.parse(record.timestamp))
  );
}

export async function inspectRuntimeSmokeBinding(input: {
  claims: RuntimeSmokeClaims;
  binding: unknown;
  versionMetadata: unknown;
  now?: number;
}): Promise<RuntimeSmokeResult> {
  if (!input.binding || typeof input.binding !== 'object') {
    throw new Error('runtime_smoke_binding_unavailable');
  }
  const database = input.binding as RuntimeSmokeD1Database;
  if (typeof database.prepare !== 'function') throw new Error('runtime_smoke_binding_not_d1');
  if (!validVersionMetadata(input.versionMetadata)) {
    throw new Error('runtime_smoke_version_metadata_invalid');
  }
  let metadata: RuntimeSmokeMetadataRow | null;
  if (input.claims.dataRole === 'lookup') {
    let row: RuntimeSmokeLookupMetadataRow | null;
    try {
      row = await database
        .prepare(
          `SELECT metadata_value
             FROM lookup_schema_metadata
            WHERE metadata_key = ?`
        )
        .bind(RUNTIME_SMOKE_LOOKUP_METADATA_KEY)
        .first<RuntimeSmokeLookupMetadataRow>();
    } catch {
      throw new Error('runtime_smoke_metadata_query_failed');
    }
    if (!row) throw new Error('runtime_smoke_metadata_missing');
    try {
      const parsed = JSON.parse(row.metadata_value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('runtime_smoke_metadata_invalid');
      }
      const keys = Object.keys(parsed);
      if (
        keys.length !== LOOKUP_METADATA_KEYS.size ||
        keys.some((key) => !LOOKUP_METADATA_KEYS.has(key))
      ) {
        throw new Error('runtime_smoke_metadata_invalid');
      }
      metadata = parsed as RuntimeSmokeMetadataRow;
    } catch {
      throw new Error('runtime_smoke_metadata_invalid');
    }
  } else {
    try {
      metadata = await database
        .prepare(
          `SELECT binding_ref, data_role, residency_partition, migration_generation,
                  release_id, manifest_digest, expected_file_count, last_filename
             FROM authrim_control_plane_shard_metadata
            WHERE singleton_id = 1`
        )
        .first<RuntimeSmokeMetadataRow>();
    } catch {
      throw new Error('runtime_smoke_metadata_query_failed');
    }
  }
  if (!metadata) throw new Error('runtime_smoke_metadata_missing');
  if (
    metadata.binding_ref !== input.claims.bindingRef ||
    metadata.data_role !== input.claims.dataRole ||
    metadata.residency_partition !== input.claims.residencyPartition ||
    metadata.migration_generation !== input.claims.expectedMigrationGeneration
  ) {
    throw new Error('runtime_smoke_metadata_mismatch');
  }
  if (
    typeof metadata.release_id !== 'string' ||
    !SAFE_ID.test(metadata.release_id) ||
    typeof metadata.manifest_digest !== 'string' ||
    !SHA256.test(metadata.manifest_digest) ||
    !Number.isSafeInteger(metadata.expected_file_count) ||
    metadata.expected_file_count < 1 ||
    typeof metadata.last_filename !== 'string' ||
    metadata.last_filename.length === 0 ||
    metadata.last_filename.length > 255
  ) {
    throw new Error('runtime_smoke_metadata_invalid');
  }
  let migration: { applied_count: number; last_filename_present: number } | null;
  try {
    migration = await database
      .prepare(
        `SELECT COUNT(*) AS applied_count,
                MAX(CASE WHEN filename = ? THEN 1 ELSE 0 END) AS last_filename_present
           FROM authrim_migrations`
      )
      .bind(metadata.last_filename)
      .first<{ applied_count: number; last_filename_present: number }>();
  } catch {
    throw new Error('runtime_smoke_migration_query_failed');
  }
  if (
    !migration ||
    !Number.isSafeInteger(migration.applied_count) ||
    migration.applied_count < metadata.expected_file_count ||
    migration.last_filename_present !== 1
  ) {
    throw new Error('runtime_smoke_migration_state_mismatch');
  }
  return {
    bindingRef: input.claims.bindingRef,
    migrationGeneration: input.claims.expectedMigrationGeneration,
    dataRole: input.claims.dataRole,
    residencyPartition: input.claims.residencyPartition,
    checkedAt: input.now ?? Math.floor(Date.now() / 1000),
    observedVersionId: input.versionMetadata.id,
    observedVersionTag: input.versionMetadata.tag,
    observedVersionTimestamp: input.versionMetadata.timestamp,
  };
}
