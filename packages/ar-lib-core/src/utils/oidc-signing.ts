import type { JWK } from 'jose';

export const OIDC_SIGNING_ALGORITHMS = ['RS256', 'ES256'] as const;
export type OIDCSigningAlgorithm = (typeof OIDC_SIGNING_ALGORITHMS)[number];

export const DEFAULT_ID_TOKEN_SIGNING_ALGORITHM: OIDCSigningAlgorithm = 'RS256';
export const DEFAULT_USERINFO_SIGNING_ALGORITHM = 'none' as const;
export const DEFAULT_AUTHORIZATION_RESPONSE_SIGNING_ALGORITHM: OIDCSigningAlgorithm = 'RS256';

export function isOIDCSigningAlgorithm(value: unknown): value is OIDCSigningAlgorithm {
  return (
    typeof value === 'string' && (OIDC_SIGNING_ALGORITHMS as readonly string[]).includes(value)
  );
}

export function resolveIDTokenSigningAlgorithm(metadata: {
  id_token_signed_response_alg?: unknown;
}): OIDCSigningAlgorithm {
  const configured = metadata.id_token_signed_response_alg;
  if (configured === undefined || configured === null || configured === '') {
    return DEFAULT_ID_TOKEN_SIGNING_ALGORITHM;
  }
  if (!isOIDCSigningAlgorithm(configured)) {
    throw new Error('Unsupported ID Token signing algorithm');
  }
  return configured;
}

export function resolveUserInfoSigningAlgorithm(
  metadata: { userinfo_signed_response_alg?: unknown },
  encrypted: boolean
): OIDCSigningAlgorithm | typeof DEFAULT_USERINFO_SIGNING_ALGORITHM {
  const configured = metadata.userinfo_signed_response_alg;
  if (configured === undefined || configured === null || configured === '') {
    return encrypted ? DEFAULT_ID_TOKEN_SIGNING_ALGORITHM : DEFAULT_USERINFO_SIGNING_ALGORITHM;
  }
  if (configured === DEFAULT_USERINFO_SIGNING_ALGORITHM) {
    return encrypted ? DEFAULT_ID_TOKEN_SIGNING_ALGORITHM : DEFAULT_USERINFO_SIGNING_ALGORITHM;
  }
  if (!isOIDCSigningAlgorithm(configured)) {
    throw new Error('Unsupported UserInfo signing algorithm');
  }
  return configured;
}

export function resolveAuthorizationResponseSigningAlgorithm(
  metadata: { authorization_signed_response_alg?: unknown },
  defaultAlgorithm: OIDCSigningAlgorithm = DEFAULT_AUTHORIZATION_RESPONSE_SIGNING_ALGORITHM
): OIDCSigningAlgorithm {
  const configured = metadata.authorization_signed_response_alg;
  if (configured === undefined || configured === null || configured === '') {
    return defaultAlgorithm;
  }
  if (!isOIDCSigningAlgorithm(configured)) {
    throw new Error('Unsupported authorization response signing algorithm');
  }
  return configured;
}

export function getPublishedOIDCSigningAlgorithms(keys: readonly JWK[]): OIDCSigningAlgorithm[] {
  const published = new Set<OIDCSigningAlgorithm>();
  for (const key of keys) {
    if (key.use !== undefined && key.use !== 'sig') continue;
    if (key.alg === 'RS256' && key.kty === 'RSA' && key.n && key.e) published.add('RS256');
    if (key.alg === 'ES256' && key.kty === 'EC' && key.crv === 'P-256' && key.x && key.y) {
      published.add('ES256');
    }
  }
  return OIDC_SIGNING_ALGORITHMS.filter((algorithm) => published.has(algorithm));
}
