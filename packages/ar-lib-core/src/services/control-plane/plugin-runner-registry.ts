import { CompactSign, compactVerify, decodeProtectedHeader, importJWK, type JWK } from 'jose';

export const PLUGIN_RUNNER_REGISTRY_JWS_TYPE = 'authrim-plugin-runner-registry+jws';
export const PLUGIN_RUNNER_REGISTRY_AUDIENCE = 'authrim-plugin-runner';
export const PLUGIN_RUNNER_REGISTRY_MAX_TTL_SECONDS = 24 * 60 * 60;

const MAX_TOKEN_BYTES = 1024 * 1024;
const MAX_JWKS_BYTES = 32 * 1024;
const MAX_SHARDS = 5_000;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_BINDING = /^(?:[A-Z][A-Z0-9_]*_)?TDB_[A-Z0-9_]{1,120}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HEADER_KEYS = new Set(['alg', 'typ', 'kid']);
const CLAIM_KEYS = new Set(['iss', 'aud', 'iat', 'exp', 'environmentId', 'generation', 'shards']);
const SHARD_KEYS = new Set([
  'shardId',
  'bindingRef',
  'dataRole',
  'residencyPartition',
  'routeGeneration',
]);
const PRIVATE_JWK_KEYS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
const DATA_ROLES = new Set(['tenant_core/default', 'tenant_core/users'] as const);

export type PluginRunnerRegistryDataRole = 'tenant_core/default' | 'tenant_core/users';

export interface PluginRunnerRegistryShard {
  shardId: string;
  bindingRef: string;
  dataRole: PluginRunnerRegistryDataRole;
  residencyPartition: string;
  routeGeneration: number;
}

export interface PluginRunnerRegistryInput {
  environmentId: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  shards: PluginRunnerRegistryShard[];
}

export interface PluginRunnerRegistryClaims {
  iss: string;
  aud: typeof PLUGIN_RUNNER_REGISTRY_AUDIENCE;
  iat: number;
  exp: number;
  environmentId: string;
  generation: number;
  shards: PluginRunnerRegistryShard[];
}

export interface PluginRunnerRegistryStore {
  get(key: string): Promise<string | null>;
}

function integer(value: unknown, minimum: number, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(code);
  }
  return value;
}

function safeId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function safePartition(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_PARTITION.test(value)) {
    throw new Error('plugin_runner_registry_residency_partition_invalid');
  }
  return value;
}

function normalizeShards(value: unknown): PluginRunnerRegistryShard[] {
  if (!Array.isArray(value) || value.length > MAX_SHARDS) {
    throw new Error('plugin_runner_registry_shards_invalid');
  }
  const bindingRefs = new Set<string>();
  const shardIds = new Set<string>();
  const shards = value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('plugin_runner_registry_shard_invalid');
    }
    const row = candidate as Record<string, unknown>;
    if (Object.keys(row).some((key) => !SHARD_KEYS.has(key))) {
      throw new Error('plugin_runner_registry_shard_unknown_claim');
    }
    const shardId = safeId(row.shardId, 'plugin_runner_registry_shard_id_invalid');
    const bindingRef = row.bindingRef;
    const dataRole = row.dataRole;
    if (
      typeof bindingRef !== 'string' ||
      !SAFE_BINDING.test(bindingRef) ||
      typeof dataRole !== 'string' ||
      !DATA_ROLES.has(dataRole as PluginRunnerRegistryDataRole) ||
      shardIds.has(shardId) ||
      bindingRefs.has(bindingRef)
    ) {
      throw new Error('plugin_runner_registry_shard_invalid');
    }
    shardIds.add(shardId);
    bindingRefs.add(bindingRef);
    return {
      shardId,
      bindingRef,
      dataRole: dataRole as PluginRunnerRegistryDataRole,
      residencyPartition: safePartition(row.residencyPartition),
      routeGeneration: integer(
        row.routeGeneration,
        1,
        'plugin_runner_registry_route_generation_invalid'
      ),
    };
  });
  for (let index = 1; index < shards.length; index += 1) {
    if (shards[index - 1].shardId.localeCompare(shards[index].shardId) >= 0) {
      throw new Error('plugin_runner_registry_shards_not_sorted');
    }
  }
  return shards;
}

function normalizeClaims(input: PluginRunnerRegistryInput): PluginRunnerRegistryClaims {
  const environmentId = safeId(
    input.environmentId,
    'plugin_runner_registry_environment_id_invalid'
  );
  const issuedAt = integer(input.issuedAt, 1, 'plugin_runner_registry_iat_invalid');
  const expiresAt = integer(input.expiresAt, 1, 'plugin_runner_registry_exp_invalid');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > PLUGIN_RUNNER_REGISTRY_MAX_TTL_SECONDS) {
    throw new Error('plugin_runner_registry_ttl_invalid');
  }
  return {
    iss: `authrim-control:${environmentId}`,
    aud: PLUGIN_RUNNER_REGISTRY_AUDIENCE,
    iat: issuedAt,
    exp: expiresAt,
    environmentId,
    generation: integer(input.generation, 1, 'plugin_runner_registry_generation_invalid'),
    shards: normalizeShards(input.shards),
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
    throw new Error('plugin_runner_registry_jwk_invalid');
  }
  if (privateRequired) {
    if (typeof jwk.d !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.d)) {
      throw new Error('plugin_runner_registry_private_jwk_required');
    }
  } else if (PRIVATE_JWK_KEYS.some((key) => record[key] !== undefined)) {
    throw new Error('plugin_runner_registry_public_jwks_private_material');
  }
}

function publicKeys(input: string | { keys: JWK[] }): Map<string, JWK> {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_JWKS_BYTES) {
      throw new Error('plugin_runner_registry_public_jwks_too_large');
    }
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new Error('plugin_runner_registry_public_jwks_invalid');
    }
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) {
    throw new Error('plugin_runner_registry_public_jwks_invalid');
  }
  const result = new Map<string, JWK>();
  for (const candidate of keys) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('plugin_runner_registry_public_jwks_invalid');
    }
    const jwk = candidate as JWK;
    validateJwk(jwk, false);
    if (result.has(jwk.kid!)) {
      throw new Error('plugin_runner_registry_public_jwks_duplicate_kid');
    }
    result.set(jwk.kid!, jwk);
  }
  return result;
}

export function buildPluginRunnerRegistrySnapshotKey(environmentId: string): string {
  return `environment:${safeId(
    environmentId,
    'plugin_runner_registry_environment_id_invalid'
  )}:plugin-runner-registry:snapshot`;
}

export function buildPluginRunnerRegistryGenerationKey(environmentId: string): string {
  return `environment:${safeId(
    environmentId,
    'plugin_runner_registry_environment_id_invalid'
  )}:plugin-runner-registry:generation`;
}

export async function signPluginRunnerRegistry(input: {
  registry: PluginRunnerRegistryInput;
  privateJwk: JWK;
}): Promise<string> {
  validateJwk(input.privateJwk, true);
  const claims = normalizeClaims(input.registry);
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({
      alg: 'EdDSA',
      typ: PLUGIN_RUNNER_REGISTRY_JWS_TYPE,
      kid: input.privateJwk.kid,
    })
    .sign(await importJWK(input.privateJwk, 'EdDSA'));
}

export async function verifyPluginRunnerRegistry(input: {
  token: string;
  environmentId: string;
  publicJwks: string | { keys: JWK[] };
  now?: number;
}): Promise<PluginRunnerRegistryClaims> {
  if (new TextEncoder().encode(input.token).byteLength > MAX_TOKEN_BYTES) {
    throw new Error('plugin_runner_registry_token_too_large');
  }
  const environmentId = safeId(
    input.environmentId,
    'plugin_runner_registry_environment_id_invalid'
  );
  let header;
  try {
    header = decodeProtectedHeader(input.token);
  } catch {
    throw new Error('plugin_runner_registry_header_invalid');
  }
  if (
    header.alg !== 'EdDSA' ||
    header.typ !== PLUGIN_RUNNER_REGISTRY_JWS_TYPE ||
    typeof header.kid !== 'string' ||
    !SAFE_ID.test(header.kid) ||
    Object.keys(header).some((key) => !HEADER_KEYS.has(key))
  ) {
    throw new Error('plugin_runner_registry_header_invalid');
  }
  const jwk = publicKeys(input.publicJwks).get(header.kid);
  if (!jwk) throw new Error('plugin_runner_registry_unknown_key');
  let payload: Uint8Array;
  try {
    payload = (await compactVerify(input.token, await importJWK(jwk, 'EdDSA'))).payload;
  } catch {
    throw new Error('plugin_runner_registry_signature_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload)) as unknown;
  } catch {
    throw new Error('plugin_runner_registry_claims_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('plugin_runner_registry_claims_invalid');
  }
  const claims = parsed as Record<string, unknown>;
  if (Object.keys(claims).some((key) => !CLAIM_KEYS.has(key))) {
    throw new Error('plugin_runner_registry_unknown_claim');
  }
  const normalized = normalizeClaims({
    environmentId: claims.environmentId as string,
    generation: claims.generation as number,
    issuedAt: claims.iat as number,
    expiresAt: claims.exp as number,
    shards: claims.shards as PluginRunnerRegistryShard[],
  });
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (
    normalized.environmentId !== environmentId ||
    claims.iss !== normalized.iss ||
    claims.aud !== PLUGIN_RUNNER_REGISTRY_AUDIENCE ||
    normalized.iat > now + 5 ||
    normalized.exp <= now - 5
  ) {
    throw new Error('plugin_runner_registry_claims_invalid');
  }
  return normalized;
}

export async function loadVerifiedPluginRunnerRegistry(input: {
  store: PluginRunnerRegistryStore;
  environmentId: string;
  publicJwks: string | { keys: JWK[] };
  now?: number;
}): Promise<PluginRunnerRegistryClaims> {
  const [token, generationValue] = await Promise.all([
    input.store.get(buildPluginRunnerRegistrySnapshotKey(input.environmentId)),
    input.store.get(buildPluginRunnerRegistryGenerationKey(input.environmentId)),
  ]);
  if (!token || !generationValue || !/^[1-9]\d{0,15}$/u.test(generationValue)) {
    throw new Error('plugin_runner_registry_snapshot_unavailable');
  }
  const expectedGeneration = Number(generationValue);
  if (!Number.isSafeInteger(expectedGeneration)) {
    throw new Error('plugin_runner_registry_generation_pointer_invalid');
  }
  const registry = await verifyPluginRunnerRegistry({
    token,
    environmentId: input.environmentId,
    publicJwks: input.publicJwks,
    now: input.now,
  });
  if (registry.generation !== expectedGeneration) {
    throw new Error('plugin_runner_registry_generation_mismatch');
  }
  return registry;
}
