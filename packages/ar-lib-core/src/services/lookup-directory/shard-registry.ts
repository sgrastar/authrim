import { CompactSign, compactVerify, decodeProtectedHeader, importJWK, type JWK } from 'jose';
import { LOOKUP_MAX_VIRTUAL_BUCKET, LOOKUP_VIRTUAL_BUCKET_COUNT } from './contract.js';
import type { ActiveLookupBucketAssignment, LookupBucketAssignmentProvider } from './resolver';

export const LOOKUP_SHARD_REGISTRY_JWS_TYPE = 'authrim-lookup-shard-registry+jws';
export const LOOKUP_SHARD_REGISTRY_AUDIENCE = 'authrim-lookup-directory';
export const LOOKUP_SHARD_REGISTRY_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

const MAX_TOKEN_BYTES = 512 * 1024;
const MAX_JWKS_BYTES = 32 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const HEADER_KEYS = new Set(['alg', 'typ', 'kid']);
const CLAIM_KEYS = new Set(['iss', 'aud', 'iat', 'exp', 'environmentId', 'generation', 'ranges']);
const PRIVATE_JWK_KEYS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

export interface LookupShardRegistryRange {
  startBucket: number;
  endBucket: number;
  assignmentGeneration: number;
  lookupShardId: string;
  bindingRef: string;
}

export interface LookupShardRegistryClaims {
  iss: string;
  aud: typeof LOOKUP_SHARD_REGISTRY_AUDIENCE;
  iat: number;
  exp: number;
  environmentId: string;
  generation: number;
  ranges: LookupShardRegistryRange[];
}

export interface LookupShardRegistryInput {
  environmentId: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  ranges: LookupShardRegistryRange[];
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(code);
  }
  return value;
}

function safeId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function validateRanges(value: unknown): LookupShardRegistryRange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > LOOKUP_VIRTUAL_BUCKET_COUNT) {
    throw new Error('lookup_registry_ranges_invalid');
  }
  let expectedStart = 0;
  return value
    .map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('lookup_registry_range_invalid');
      }
      const range = candidate as Record<string, unknown>;
      if (
        Object.keys(range).some(
          (key) =>
            ![
              'startBucket',
              'endBucket',
              'assignmentGeneration',
              'lookupShardId',
              'bindingRef',
            ].includes(key)
        )
      ) {
        throw new Error('lookup_registry_range_unknown_claim');
      }
      const startBucket = integer(
        range.startBucket,
        0,
        LOOKUP_MAX_VIRTUAL_BUCKET,
        'lookup_registry_bucket_invalid'
      );
      const endBucket = integer(
        range.endBucket,
        0,
        LOOKUP_MAX_VIRTUAL_BUCKET,
        'lookup_registry_bucket_invalid'
      );
      if (startBucket !== expectedStart || endBucket < startBucket) {
        throw new Error('lookup_registry_bucket_coverage_invalid');
      }
      expectedStart = endBucket + 1;
      const bindingRef = range.bindingRef;
      if (typeof bindingRef !== 'string' || !SAFE_BINDING.test(bindingRef)) {
        throw new Error('lookup_registry_binding_ref_invalid');
      }
      return {
        startBucket,
        endBucket,
        assignmentGeneration: integer(
          range.assignmentGeneration,
          1,
          Number.MAX_SAFE_INTEGER,
          'lookup_registry_assignment_generation_invalid'
        ),
        lookupShardId: safeId(range.lookupShardId, 'lookup_registry_shard_id_invalid'),
        bindingRef,
      };
    })
    .map((range, index, ranges) => {
      if (index === ranges.length - 1 && range.endBucket !== LOOKUP_MAX_VIRTUAL_BUCKET) {
        throw new Error('lookup_registry_bucket_coverage_invalid');
      }
      return range;
    });
}

function normalizeClaims(input: LookupShardRegistryInput): LookupShardRegistryClaims {
  const environmentId = safeId(input.environmentId, 'lookup_registry_environment_id_invalid');
  const issuedAt = integer(
    input.issuedAt,
    1,
    Number.MAX_SAFE_INTEGER,
    'lookup_registry_iat_invalid'
  );
  const expiresAt = integer(
    input.expiresAt,
    1,
    Number.MAX_SAFE_INTEGER,
    'lookup_registry_exp_invalid'
  );
  if (expiresAt <= issuedAt || expiresAt - issuedAt > LOOKUP_SHARD_REGISTRY_MAX_TTL_SECONDS) {
    throw new Error('lookup_registry_ttl_invalid');
  }
  return {
    iss: `authrim-control:${environmentId}`,
    aud: LOOKUP_SHARD_REGISTRY_AUDIENCE,
    iat: issuedAt,
    exp: expiresAt,
    environmentId,
    generation: integer(
      input.generation,
      1,
      Number.MAX_SAFE_INTEGER,
      'lookup_registry_generation_invalid'
    ),
    ranges: validateRanges(input.ranges),
  };
}

function validateJwk(jwk: JWK, privateRequired: boolean): void {
  const record = jwk as Record<string, unknown>;
  if (
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(jwk.x) ||
    typeof jwk.kid !== 'string' ||
    !SAFE_ID.test(jwk.kid) ||
    (jwk.alg !== undefined && jwk.alg !== 'EdDSA')
  ) {
    throw new Error('lookup_registry_jwk_invalid');
  }
  if (privateRequired) {
    if (typeof jwk.d !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.d)) {
      throw new Error('lookup_registry_private_jwk_required');
    }
  } else if (PRIVATE_JWK_KEYS.some((key) => record[key] !== undefined)) {
    throw new Error('lookup_registry_public_jwks_private_material');
  }
}

function publicKeys(input: string | { keys: JWK[] }): Map<string, JWK> {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_JWKS_BYTES) {
      throw new Error('lookup_registry_public_jwks_too_large');
    }
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new Error('lookup_registry_public_jwks_invalid');
    }
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) {
    throw new Error('lookup_registry_public_jwks_invalid');
  }
  const result = new Map<string, JWK>();
  for (const candidate of keys) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('lookup_registry_public_jwks_invalid');
    }
    const jwk = candidate as JWK;
    validateJwk(jwk, false);
    if (result.has(jwk.kid!)) throw new Error('lookup_registry_public_jwks_duplicate_kid');
    result.set(jwk.kid!, jwk);
  }
  return result;
}

export function buildLookupShardRegistrySnapshotKey(environmentId: string): string {
  return `environment:${safeId(
    environmentId,
    'lookup_registry_environment_id_invalid'
  )}:lookup-shard-registry:snapshot`;
}

export function buildLookupShardRegistryGenerationKey(environmentId: string): string {
  return `environment:${safeId(
    environmentId,
    'lookup_registry_environment_id_invalid'
  )}:lookup-shard-registry:generation`;
}

export interface LookupShardRegistryStore {
  get(key: string): Promise<string | null>;
}

export async function loadVerifiedLookupBucketAssignmentProvider(input: {
  store: LookupShardRegistryStore;
  environmentId: string;
  publicJwks: string | { keys: JWK[] };
  now?: number;
}): Promise<VerifiedLookupBucketAssignmentProvider> {
  const [token, generationValue] = await Promise.all([
    input.store.get(buildLookupShardRegistrySnapshotKey(input.environmentId)),
    input.store.get(buildLookupShardRegistryGenerationKey(input.environmentId)),
  ]);
  if (!token || !generationValue || !/^[1-9]\d{0,15}$/u.test(generationValue)) {
    throw new Error('lookup_registry_snapshot_unavailable');
  }
  const expectedGeneration = Number(generationValue);
  if (!Number.isSafeInteger(expectedGeneration)) {
    throw new Error('lookup_registry_generation_pointer_invalid');
  }
  const registry = await verifyLookupShardRegistry({
    token,
    environmentId: input.environmentId,
    publicJwks: input.publicJwks,
    now: input.now,
  });
  if (registry.generation !== expectedGeneration) {
    throw new Error('lookup_registry_generation_mismatch');
  }
  return new VerifiedLookupBucketAssignmentProvider(registry);
}

export async function signLookupShardRegistry(input: {
  registry: LookupShardRegistryInput;
  privateJwk: JWK;
}): Promise<string> {
  validateJwk(input.privateJwk, true);
  const claims = normalizeClaims(input.registry);
  const key = await importJWK(input.privateJwk, 'EdDSA');
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({
      alg: 'EdDSA',
      typ: LOOKUP_SHARD_REGISTRY_JWS_TYPE,
      kid: input.privateJwk.kid,
    })
    .sign(key);
}

export async function verifyLookupShardRegistry(input: {
  token: string;
  environmentId: string;
  publicJwks: string | { keys: JWK[] };
  now?: number;
}): Promise<LookupShardRegistryClaims> {
  if (new TextEncoder().encode(input.token).byteLength > MAX_TOKEN_BYTES) {
    throw new Error('lookup_registry_token_too_large');
  }
  const environmentId = safeId(input.environmentId, 'lookup_registry_environment_id_invalid');
  let header;
  try {
    header = decodeProtectedHeader(input.token);
  } catch {
    throw new Error('lookup_registry_header_invalid');
  }
  if (
    header.alg !== 'EdDSA' ||
    header.typ !== LOOKUP_SHARD_REGISTRY_JWS_TYPE ||
    typeof header.kid !== 'string' ||
    !SAFE_ID.test(header.kid) ||
    Object.keys(header).some((key) => !HEADER_KEYS.has(key))
  ) {
    throw new Error('lookup_registry_header_invalid');
  }
  const jwk = publicKeys(input.publicJwks).get(header.kid);
  if (!jwk) throw new Error('lookup_registry_unknown_key');
  let payload: Uint8Array;
  try {
    payload = (await compactVerify(input.token, await importJWK(jwk, 'EdDSA'))).payload;
  } catch {
    throw new Error('lookup_registry_signature_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload)) as unknown;
  } catch {
    throw new Error('lookup_registry_claims_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('lookup_registry_claims_invalid');
  }
  const claims = parsed as Record<string, unknown>;
  if (Object.keys(claims).some((key) => !CLAIM_KEYS.has(key))) {
    throw new Error('lookup_registry_unknown_claim');
  }
  const normalized = normalizeClaims({
    environmentId: claims.environmentId as string,
    generation: claims.generation as number,
    issuedAt: claims.iat as number,
    expiresAt: claims.exp as number,
    ranges: claims.ranges as LookupShardRegistryRange[],
  });
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (
    normalized.environmentId !== environmentId ||
    claims.iss !== normalized.iss ||
    claims.aud !== LOOKUP_SHARD_REGISTRY_AUDIENCE ||
    normalized.iat > now + 5 ||
    normalized.exp <= now - 5
  ) {
    throw new Error('lookup_registry_claims_invalid');
  }
  return normalized;
}

export class VerifiedLookupBucketAssignmentProvider implements LookupBucketAssignmentProvider {
  constructor(private readonly registry: LookupShardRegistryClaims) {}

  listActiveRanges(): LookupShardRegistryRange[] {
    return this.registry.ranges.map((range) => ({ ...range }));
  }

  async resolveActiveAssignment(virtualBucket: number): Promise<ActiveLookupBucketAssignment> {
    integer(virtualBucket, 0, LOOKUP_MAX_VIRTUAL_BUCKET, 'lookup_registry_bucket_invalid');
    const range = this.registry.ranges.find(
      (candidate) => candidate.startBucket <= virtualBucket && candidate.endBucket >= virtualBucket
    );
    if (!range) throw new Error('lookup_registry_bucket_unassigned');
    return {
      virtualBucket,
      assignmentGeneration: range.assignmentGeneration,
      lookupShardId: range.lookupShardId,
      bindingRef: range.bindingRef,
      state: 'active',
    };
  }
}
