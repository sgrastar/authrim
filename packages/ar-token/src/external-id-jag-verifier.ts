import { safeFetchJson } from '@authrim/ar-lib-core';
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload } from 'jose';

const DISCOVERY_RESPONSE_LIMIT = 64 * 1024;
const JWKS_RESPONSE_LIMIT = 256 * 1024;
const EXTERNAL_JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const ALLOWED_SIGNING_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

interface OpenIdProviderMetadata {
  issuer?: unknown;
  jwks_uri?: unknown;
}

interface JwksResponse {
  keys?: unknown;
}

interface CachedExternalIssuerKeys {
  expiresAt: number;
  jwksUri: string;
  keys: JWK[];
}

const externalIssuerKeysCache = new Map<string, CachedExternalIssuerKeys>();

function getDiscoveryUrl(issuer: string): string {
  const parsed = new URL(issuer);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'External ID-JAG issuer must be an HTTPS URL without credentials, query, or fragment'
    );
  }

  return `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
}

function isJwk(value: unknown): value is JWK {
  return typeof value === 'object' && value !== null && typeof (value as JWK).kty === 'string';
}

async function fetchExternalIssuerKeys(issuer: string): Promise<CachedExternalIssuerKeys> {
  const discovery = await safeFetchJson<OpenIdProviderMetadata>(getDiscoveryUrl(issuer), {
    maxResponseSize: DISCOVERY_RESPONSE_LIMIT,
    timeoutMs: 5000,
  });

  if (discovery.issuer !== issuer) {
    throw new Error('External ID-JAG discovery issuer does not match the configured issuer');
  }
  if (typeof discovery.jwks_uri !== 'string' || discovery.jwks_uri.length === 0) {
    throw new Error('External ID-JAG discovery metadata is missing jwks_uri');
  }

  const jwks = await safeFetchJson<JwksResponse>(discovery.jwks_uri, {
    maxResponseSize: JWKS_RESPONSE_LIMIT,
    timeoutMs: 5000,
  });
  if (!Array.isArray(jwks.keys)) {
    throw new Error('External ID-JAG JWKS response is missing keys');
  }

  const keys = jwks.keys.filter(isJwk);
  if (keys.length === 0) {
    throw new Error('External ID-JAG JWKS contains no usable keys');
  }

  const cached = {
    expiresAt: Date.now() + EXTERNAL_JWKS_CACHE_TTL_MS,
    jwksUri: discovery.jwks_uri,
    keys,
  };
  externalIssuerKeysCache.set(issuer, cached);
  return cached;
}

async function getExternalIssuerKeys(
  issuer: string,
  forceRefresh = false
): Promise<CachedExternalIssuerKeys> {
  const cached = externalIssuerKeysCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  return fetchExternalIssuerKeys(issuer);
}

function selectVerificationKey(keys: JWK[], kid: string, algorithm: string): JWK | null {
  const matchingKeys = keys.filter(
    (key) =>
      key.kid === kid &&
      (key.use === undefined || key.use === 'sig') &&
      (key.key_ops === undefined || key.key_ops.includes('verify')) &&
      (key.alg === undefined || key.alg === algorithm)
  );
  return matchingKeys.length === 1 ? matchingKeys[0]! : null;
}

export interface VerifyExternalIdJagSubjectTokenOptions {
  token: string;
  issuer: string;
  audiences: string[];
}

export async function verifyExternalIdJagSubjectToken(
  options: VerifyExternalIdJagSubjectTokenOptions
): Promise<JWTPayload> {
  const { token, issuer, audiences } = options;
  if (audiences.length === 0) {
    throw new Error('External ID-JAG verification requires an expected audience');
  }

  const header = decodeProtectedHeader(token);
  if (!header.kid) {
    throw new Error('External ID-JAG subject token is missing kid');
  }
  if (
    typeof header.alg !== 'string' ||
    !ALLOWED_SIGNING_ALGORITHMS.includes(header.alg as (typeof ALLOWED_SIGNING_ALGORITHMS)[number])
  ) {
    throw new Error('External ID-JAG subject token uses an unsupported signing algorithm');
  }

  let issuerKeys = await getExternalIssuerKeys(issuer);
  let jwk = selectVerificationKey(issuerKeys.keys, header.kid, header.alg);
  if (!jwk) {
    issuerKeys = await getExternalIssuerKeys(issuer, true);
    jwk = selectVerificationKey(issuerKeys.keys, header.kid, header.alg);
  }
  if (!jwk) {
    throw new Error('External ID-JAG signing key was not found');
  }

  const publicKey = await importJWK(jwk, header.alg);
  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience: audiences,
    algorithms: [...ALLOWED_SIGNING_ALGORITHMS],
    requiredClaims: ['iss', 'sub', 'aud', 'exp'],
    clockTolerance: 60,
  });
  return payload;
}

export function clearExternalIdJagVerifierCacheForTests(): void {
  externalIssuerKeysCache.clear();
}
