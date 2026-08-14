import {
  CompactSign,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
  type CryptoKey,
  type JWK,
} from 'jose';

export const BOOTSTRAP_ACCELERATOR_JWS_TYPE = 'authrim-bootstrap-accelerator+jws';
export const BOOTSTRAP_ACCELERATOR_TTL_SECONDS = 15;
export const BOOTSTRAP_ACCELERATOR_CLOCK_SKEW_SECONDS = 5;

const MAX_JWS_BYTES = 8 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const CLAIM_KEYS = new Set(['iss', 'aud', 'iat', 'exp', 'jti', 'purpose', 'environmentId']);
const PROTECTED_HEADER_KEYS = new Set(['alg', 'typ', 'kid']);

export interface BootstrapAcceleratorClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  purpose: 'initial_bootstrap_advance';
  environmentId: string;
}

function requiredId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function requiredEpoch(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(code);
  }
  return value;
}

function issuer(environmentId: string): string {
  return `authrim-setup:${requiredId(environmentId, 'bootstrap_accelerator_environment_invalid')}`;
}

function audience(environmentId: string): string {
  return `authrim-control:${requiredId(environmentId, 'bootstrap_accelerator_environment_invalid')}`;
}

function assertEd25519Jwk(jwk: JWK, requirePrivate: boolean): void {
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
    throw new Error('bootstrap_accelerator_jwk_invalid');
  }
  const privateValue = (jwk as Record<string, unknown>).d;
  if (requirePrivate) {
    if (typeof privateValue !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(privateValue)) {
      throw new Error('bootstrap_accelerator_private_jwk_required');
    }
  } else if (privateValue !== undefined) {
    throw new Error('bootstrap_accelerator_public_jwk_contains_private_material');
  }
}

function decodeClaims(payload: Uint8Array): Record<string, unknown> {
  try {
    const decoded = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(payload)
    );
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error();
    return decoded as Record<string, unknown>;
  } catch {
    throw new Error('bootstrap_accelerator_payload_invalid');
  }
}

export async function signBootstrapAcceleratorProof(input: {
  environmentId: string;
  jti: string;
  privateJwk: JWK;
  keyId: string;
  now?: number;
}): Promise<string> {
  const environmentId = requiredId(
    input.environmentId,
    'bootstrap_accelerator_environment_invalid'
  );
  const jti = requiredId(input.jti, 'bootstrap_accelerator_jti_invalid');
  const keyId = requiredId(input.keyId, 'bootstrap_accelerator_key_id_invalid');
  if (input.privateJwk.kid !== undefined && input.privateJwk.kid !== keyId) {
    throw new Error('bootstrap_accelerator_private_jwk_kid_mismatch');
  }
  const privateJwk = { ...input.privateJwk, kid: keyId, alg: 'EdDSA', use: 'sig' };
  assertEd25519Jwk(privateJwk, true);
  const issuedAt = input.now ?? Math.floor(Date.now() / 1000);
  const claims: BootstrapAcceleratorClaims = {
    iss: issuer(environmentId),
    aud: audience(environmentId),
    iat: requiredEpoch(issuedAt, 'bootstrap_accelerator_iat_invalid'),
    exp: issuedAt + BOOTSTRAP_ACCELERATOR_TTL_SECONDS,
    jti,
    purpose: 'initial_bootstrap_advance',
    environmentId,
  };
  let key: CryptoKey;
  try {
    key = (await importJWK(privateJwk, 'EdDSA')) as CryptoKey;
  } catch {
    throw new Error('bootstrap_accelerator_private_jwk_import_failed');
  }
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({ alg: 'EdDSA', typ: BOOTSTRAP_ACCELERATOR_JWS_TYPE, kid: keyId })
    .sign(key);
}

export async function verifyBootstrapAcceleratorProof(
  token: unknown,
  input: {
    environmentId: string;
    publicJwk: JWK;
    now?: number;
  }
): Promise<BootstrapAcceleratorClaims> {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    new TextEncoder().encode(token).byteLength > MAX_JWS_BYTES ||
    token.split('.').length !== 3
  ) {
    throw new Error('bootstrap_accelerator_jws_invalid');
  }
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new Error('bootstrap_accelerator_header_invalid');
  }
  if (
    header.alg !== 'EdDSA' ||
    header.typ !== BOOTSTRAP_ACCELERATOR_JWS_TYPE ||
    typeof header.kid !== 'string' ||
    Object.keys(header).some((key) => !PROTECTED_HEADER_KEYS.has(key))
  ) {
    throw new Error('bootstrap_accelerator_header_invalid');
  }
  assertEd25519Jwk(input.publicJwk, false);
  if (input.publicJwk.kid !== header.kid) {
    throw new Error('bootstrap_accelerator_key_unknown');
  }
  let key: CryptoKey;
  try {
    key = (await importJWK(input.publicJwk, 'EdDSA')) as CryptoKey;
  } catch {
    throw new Error('bootstrap_accelerator_public_jwk_import_failed');
  }
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(token, key, { algorithms: ['EdDSA'] }));
  } catch {
    throw new Error('bootstrap_accelerator_signature_invalid');
  }
  const claims = decodeClaims(payload);
  if (
    Object.keys(claims).length !== CLAIM_KEYS.size ||
    Object.keys(claims).some((key) => !CLAIM_KEYS.has(key))
  ) {
    throw new Error('bootstrap_accelerator_claims_invalid');
  }
  const environmentId = requiredId(
    input.environmentId,
    'bootstrap_accelerator_environment_invalid'
  );
  if (
    claims.environmentId !== environmentId ||
    claims.iss !== issuer(environmentId) ||
    claims.aud !== audience(environmentId) ||
    claims.purpose !== 'initial_bootstrap_advance'
  ) {
    throw new Error('bootstrap_accelerator_boundary_mismatch');
  }
  const iat = requiredEpoch(claims.iat, 'bootstrap_accelerator_iat_invalid');
  const exp = requiredEpoch(claims.exp, 'bootstrap_accelerator_exp_invalid');
  if (exp - iat !== BOOTSTRAP_ACCELERATOR_TTL_SECONDS) {
    throw new Error('bootstrap_accelerator_ttl_invalid');
  }
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('bootstrap_accelerator_now_invalid');
  if (iat > now + BOOTSTRAP_ACCELERATOR_CLOCK_SKEW_SECONDS) {
    throw new Error('bootstrap_accelerator_not_yet_valid');
  }
  if (exp < now - BOOTSTRAP_ACCELERATOR_CLOCK_SKEW_SECONDS) {
    throw new Error('bootstrap_accelerator_expired');
  }
  return {
    iss: claims.iss as string,
    aud: claims.aud as string,
    iat,
    exp,
    jti: requiredId(claims.jti, 'bootstrap_accelerator_jti_invalid'),
    purpose: 'initial_bootstrap_advance',
    environmentId,
  };
}
