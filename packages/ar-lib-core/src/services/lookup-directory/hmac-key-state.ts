import { CompactSign, compactVerify, decodeProtectedHeader, importJWK, type JWK } from 'jose';
import type { LookupBlindIndexKey } from './blind-index';

export const LOOKUP_HMAC_KEY_STATE_JWS_TYPE = 'authrim-lookup-hmac-key-state+jws';
export const LOOKUP_HMAC_KEY_STATE_AUDIENCE = 'authrim-lookup-directory';
export const LOOKUP_HMAC_KEY_STATE_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 32 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const HEADER_KEYS = new Set(['alg', 'typ', 'kid']);
const CLAIM_KEYS = new Set([
  'iss',
  'aud',
  'iat',
  'exp',
  'environmentId',
  'generation',
  'rotationState',
  'writeMode',
  'current',
  'previous',
]);
const KEY_CLAIM_KEYS = new Set(['generation', 'keyId', 'slot', 'fingerprint']);
const PRIVATE_JWK_KEYS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
const encoder = new TextEncoder();

export type LookupHmacKeySlot = 'A' | 'B';
export type LookupHmacWriteMode = 'current_only' | 'dual_write';
export type LookupHmacRotationState =
  | 'stable'
  | 'activation_dual_write'
  | 'dual_read'
  | 'reindexing'
  | 'verifying'
  | 'grace'
  | 'blocked';

export interface LookupHmacKeyClaim {
  generation: number;
  keyId: string;
  slot: LookupHmacKeySlot;
  fingerprint: string;
}

export interface LookupHmacKeyStateInput {
  environmentId: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  rotationState: LookupHmacRotationState;
  writeMode: LookupHmacWriteMode;
  current: LookupHmacKeyClaim;
  previous: LookupHmacKeyClaim | null;
}

export interface LookupHmacKeyStateClaims {
  iss: string;
  aud: typeof LOOKUP_HMAC_KEY_STATE_AUDIENCE;
  iat: number;
  exp: number;
  environmentId: string;
  generation: number;
  rotationState: LookupHmacRotationState;
  writeMode: LookupHmacWriteMode;
  current: LookupHmacKeyClaim;
  previous: LookupHmacKeyClaim | null;
}

export interface LookupHmacKeyStateStore {
  get(key: string): Promise<string | null>;
}

export interface ResolvedLookupHmacKeys {
  state: LookupHmacKeyStateClaims;
  readKeys: LookupBlindIndexKey[];
  writeKeys: LookupBlindIndexKey[];
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

function keyClaim(value: unknown): LookupHmacKeyClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('lookup_hmac_key_claim_invalid');
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !KEY_CLAIM_KEYS.has(key))) {
    throw new Error('lookup_hmac_key_claim_unknown');
  }
  if (candidate.slot !== 'A' && candidate.slot !== 'B') {
    throw new Error('lookup_hmac_key_slot_invalid');
  }
  if (typeof candidate.fingerprint !== 'string' || !HEX_DIGEST.test(candidate.fingerprint)) {
    throw new Error('lookup_hmac_key_fingerprint_invalid');
  }
  return {
    generation: integer(
      candidate.generation,
      1,
      Number.MAX_SAFE_INTEGER,
      'lookup_hmac_key_generation_invalid'
    ),
    keyId: safeId(candidate.keyId, 'lookup_hmac_key_id_invalid'),
    slot: candidate.slot,
    fingerprint: candidate.fingerprint,
  };
}

function normalizeClaims(input: LookupHmacKeyStateInput): LookupHmacKeyStateClaims {
  const environmentId = safeId(input.environmentId, 'lookup_hmac_key_state_environment_invalid');
  const issuedAt = integer(
    input.issuedAt,
    1,
    Number.MAX_SAFE_INTEGER,
    'lookup_hmac_key_state_iat_invalid'
  );
  const expiresAt = integer(
    input.expiresAt,
    1,
    Number.MAX_SAFE_INTEGER,
    'lookup_hmac_key_state_exp_invalid'
  );
  if (expiresAt <= issuedAt || expiresAt - issuedAt > LOOKUP_HMAC_KEY_STATE_MAX_TTL_SECONDS) {
    throw new Error('lookup_hmac_key_state_ttl_invalid');
  }
  if (
    ![
      'stable',
      'activation_dual_write',
      'dual_read',
      'reindexing',
      'verifying',
      'grace',
      'blocked',
    ].includes(input.rotationState)
  ) {
    throw new Error('lookup_hmac_key_state_rotation_state_invalid');
  }
  if (input.writeMode !== 'current_only' && input.writeMode !== 'dual_write') {
    throw new Error('lookup_hmac_key_state_write_mode_invalid');
  }
  const current = keyClaim(input.current);
  const previous = input.previous === null ? null : keyClaim(input.previous);
  if (
    (input.writeMode === 'dual_write' && previous === null) ||
    (input.rotationState === 'activation_dual_write' && input.writeMode !== 'dual_write') ||
    (input.rotationState === 'stable' && previous !== null) ||
    (previous &&
      (previous.slot === current.slot ||
        previous.generation === current.generation ||
        previous.keyId === current.keyId ||
        previous.fingerprint === current.fingerprint))
  ) {
    throw new Error('lookup_hmac_key_state_key_set_invalid');
  }
  return {
    iss: `authrim-control:${environmentId}`,
    aud: LOOKUP_HMAC_KEY_STATE_AUDIENCE,
    iat: issuedAt,
    exp: expiresAt,
    environmentId,
    generation: integer(
      input.generation,
      1,
      Number.MAX_SAFE_INTEGER,
      'lookup_hmac_key_state_generation_invalid'
    ),
    rotationState: input.rotationState,
    writeMode: input.writeMode,
    current,
    previous,
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
    throw new Error('lookup_hmac_key_state_jwk_invalid');
  }
  if (privateRequired) {
    if (typeof jwk.d !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(jwk.d)) {
      throw new Error('lookup_hmac_key_state_private_jwk_required');
    }
  } else if (PRIVATE_JWK_KEYS.some((key) => record[key] !== undefined)) {
    throw new Error('lookup_hmac_key_state_public_jwks_private_material');
  }
}

function publicKeys(input: string | { keys: JWK[] }): Map<string, JWK> {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    if (encoder.encode(input).byteLength > MAX_JWKS_BYTES) {
      throw new Error('lookup_hmac_key_state_public_jwks_too_large');
    }
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new Error('lookup_hmac_key_state_public_jwks_invalid');
    }
  }
  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) {
    throw new Error('lookup_hmac_key_state_public_jwks_invalid');
  }
  const result = new Map<string, JWK>();
  for (const candidate of keys) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('lookup_hmac_key_state_public_jwks_invalid');
    }
    const jwk = candidate as JWK;
    validateJwk(jwk, false);
    if (result.has(jwk.kid!)) throw new Error('lookup_hmac_key_state_public_jwks_duplicate_kid');
    result.set(jwk.kid!, jwk);
  }
  return result;
}

export function buildLookupHmacKeyStateSnapshotKey(environmentId: string): string {
  return `environment:${safeId(
    environmentId,
    'lookup_hmac_key_state_environment_invalid'
  )}:lookup-hmac-key-state:snapshot`;
}

export function buildLookupHmacKeyStateGenerationKey(environmentId: string): string {
  return `environment:${safeId(
    environmentId,
    'lookup_hmac_key_state_environment_invalid'
  )}:lookup-hmac-key-state:generation`;
}

export async function fingerprintLookupHmacKey(secret: string | Uint8Array): Promise<string> {
  const bytes = typeof secret === 'string' ? encoder.encode(secret) : secret;
  if (bytes.byteLength < 32) throw new Error('lookup_hmac_key_material_invalid');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signLookupHmacKeyState(input: {
  state: LookupHmacKeyStateInput;
  privateJwk: JWK;
}): Promise<string> {
  validateJwk(input.privateJwk, true);
  const claims = normalizeClaims(input.state);
  const key = await importJWK(input.privateJwk, 'EdDSA');
  return new CompactSign(encoder.encode(JSON.stringify(claims)))
    .setProtectedHeader({
      alg: 'EdDSA',
      typ: LOOKUP_HMAC_KEY_STATE_JWS_TYPE,
      kid: input.privateJwk.kid,
    })
    .sign(key);
}

export async function verifyLookupHmacKeyState(input: {
  token: string;
  environmentId: string;
  publicJwks: string | { keys: JWK[] };
  now?: number;
}): Promise<LookupHmacKeyStateClaims> {
  if (encoder.encode(input.token).byteLength > MAX_TOKEN_BYTES) {
    throw new Error('lookup_hmac_key_state_token_too_large');
  }
  const environmentId = safeId(input.environmentId, 'lookup_hmac_key_state_environment_invalid');
  let header;
  try {
    header = decodeProtectedHeader(input.token);
  } catch {
    throw new Error('lookup_hmac_key_state_header_invalid');
  }
  if (
    header.alg !== 'EdDSA' ||
    header.typ !== LOOKUP_HMAC_KEY_STATE_JWS_TYPE ||
    typeof header.kid !== 'string' ||
    !SAFE_ID.test(header.kid) ||
    Object.keys(header).some((key) => !HEADER_KEYS.has(key))
  ) {
    throw new Error('lookup_hmac_key_state_header_invalid');
  }
  const jwk = publicKeys(input.publicJwks).get(header.kid);
  if (!jwk) throw new Error('lookup_hmac_key_state_unknown_key');
  let payload: Uint8Array;
  try {
    payload = (await compactVerify(input.token, await importJWK(jwk, 'EdDSA'))).payload;
  } catch {
    throw new Error('lookup_hmac_key_state_signature_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload)) as unknown;
  } catch {
    throw new Error('lookup_hmac_key_state_claims_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('lookup_hmac_key_state_claims_invalid');
  }
  const claims = parsed as Record<string, unknown>;
  if (Object.keys(claims).some((key) => !CLAIM_KEYS.has(key))) {
    throw new Error('lookup_hmac_key_state_unknown_claim');
  }
  const normalized = normalizeClaims({
    environmentId: claims.environmentId as string,
    generation: claims.generation as number,
    issuedAt: claims.iat as number,
    expiresAt: claims.exp as number,
    rotationState: claims.rotationState as LookupHmacRotationState,
    writeMode: claims.writeMode as LookupHmacWriteMode,
    current: claims.current as LookupHmacKeyClaim,
    previous: claims.previous as LookupHmacKeyClaim | null,
  });
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (
    normalized.environmentId !== environmentId ||
    claims.iss !== normalized.iss ||
    claims.aud !== LOOKUP_HMAC_KEY_STATE_AUDIENCE ||
    normalized.iat > now + 5 ||
    normalized.exp <= now - 5
  ) {
    throw new Error('lookup_hmac_key_state_claims_invalid');
  }
  return normalized;
}

export async function loadVerifiedLookupHmacKeyState(input: {
  store: LookupHmacKeyStateStore;
  environmentId: string;
  publicJwks: string | { keys: JWK[] };
  now?: number;
}): Promise<LookupHmacKeyStateClaims> {
  const [token, generationValue] = await Promise.all([
    input.store.get(buildLookupHmacKeyStateSnapshotKey(input.environmentId)),
    input.store.get(buildLookupHmacKeyStateGenerationKey(input.environmentId)),
  ]);
  if (!token || !generationValue || !/^[1-9]\d{0,15}$/u.test(generationValue)) {
    throw new Error('lookup_hmac_key_state_snapshot_unavailable');
  }
  const expectedGeneration = Number(generationValue);
  if (!Number.isSafeInteger(expectedGeneration)) {
    throw new Error('lookup_hmac_key_state_generation_pointer_invalid');
  }
  const state = await verifyLookupHmacKeyState({
    token,
    environmentId: input.environmentId,
    publicJwks: input.publicJwks,
    now: input.now,
  });
  if (state.generation !== expectedGeneration) {
    throw new Error('lookup_hmac_key_state_generation_mismatch');
  }
  return state;
}

export async function resolveLookupHmacKeys(input: {
  state: LookupHmacKeyStateClaims;
  slotA?: string | Uint8Array;
  slotB?: string | Uint8Array;
}): Promise<ResolvedLookupHmacKeys> {
  const resolve = async (claim: LookupHmacKeyClaim): Promise<LookupBlindIndexKey> => {
    const secret = claim.slot === 'A' ? input.slotA : input.slotB;
    if (!secret || (await fingerprintLookupHmacKey(secret)) !== claim.fingerprint) {
      throw new Error('lookup_hmac_key_state_local_key_mismatch');
    }
    return { generation: claim.generation, secret };
  };
  const current = await resolve(input.state.current);
  const previous = input.state.previous ? await resolve(input.state.previous) : null;
  return {
    state: input.state,
    readKeys: previous ? [current, previous] : [current],
    writeKeys: input.state.writeMode === 'dual_write' && previous ? [current, previous] : [current],
  };
}
