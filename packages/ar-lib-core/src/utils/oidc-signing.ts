import type { JWK } from 'jose';

export const OIDC_SIGNING_ALGORITHMS = ['RS256', 'ES256', 'PS256'] as const;
export type OIDCSigningAlgorithm = (typeof OIDC_SIGNING_ALGORITHMS)[number];

export const DEFAULT_ID_TOKEN_SIGNING_ALGORITHM: OIDCSigningAlgorithm = 'RS256';
export const DEFAULT_USERINFO_SIGNING_ALGORITHM = 'none' as const;
export const DEFAULT_AUTHORIZATION_RESPONSE_SIGNING_ALGORITHM: OIDCSigningAlgorithm = 'RS256';

export function isOIDCSigningAlgorithm(value: unknown): value is OIDCSigningAlgorithm {
  return (
    typeof value === 'string' && (OIDC_SIGNING_ALGORITHMS as readonly string[]).includes(value)
  );
}

/** A tenant's ID token signing: its algorithm, and whether an app may choose another. */
export interface IDTokenSigningPolicy {
  algorithm: OIDCSigningAlgorithm;
  appsMayChoose: boolean;
}

/** Authrim's policy without tenant settings: RS256, and apps choose their own. */
export const DEFAULT_ID_TOKEN_SIGNING_POLICY: IDTokenSigningPolicy = {
  algorithm: DEFAULT_ID_TOKEN_SIGNING_ALGORITHM,
  appsMayChoose: true,
};

/**
 * The algorithm an app's ID tokens are signed with: its id_token_signed_response_alg while the
 * tenant lets apps choose, else the tenant's algorithm.
 */
export function resolveIDTokenSigningAlgorithm(
  metadata: { id_token_signed_response_alg?: unknown },
  policy: IDTokenSigningPolicy = DEFAULT_ID_TOKEN_SIGNING_POLICY
): OIDCSigningAlgorithm {
  const configured = metadata.id_token_signed_response_alg;
  if (configured === undefined || configured === null || configured === '') {
    return policy.algorithm;
  }
  if (!isOIDCSigningAlgorithm(configured)) {
    throw new Error('Unsupported ID Token signing algorithm');
  }
  return policy.appsMayChoose ? configured : policy.algorithm;
}

/**
 * Why an app's id_token_signed_response_alg cannot be registered under a tenant's policy, or
 * null when it can (unset, or allowed).
 */
export function idTokenSigningAlgorithmRefusal(
  value: unknown,
  policy: IDTokenSigningPolicy
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isOIDCSigningAlgorithm(value)) {
    return `id_token_signed_response_alg must be one of: ${OIDC_SIGNING_ALGORITHMS.join(', ')}`;
  }
  if (!policy.appsMayChoose && value !== policy.algorithm) {
    return `id_token_signed_response_alg must be ${policy.algorithm}: this tenant signs every ID token with it`;
  }
  return null;
}

/**
 * The algorithm a UserInfo response is signed with: the app's userinfo_signed_response_alg; when
 * unset (or none) and the response is encrypted, `signedDefault` (the app's ID token algorithm),
 * as an encrypted response is signed first.
 */
export function resolveUserInfoSigningAlgorithm(
  metadata: { userinfo_signed_response_alg?: unknown },
  encrypted: boolean,
  signedDefault: OIDCSigningAlgorithm = DEFAULT_ID_TOKEN_SIGNING_ALGORITHM
): OIDCSigningAlgorithm | typeof DEFAULT_USERINFO_SIGNING_ALGORITHM {
  const configured = metadata.userinfo_signed_response_alg;
  if (configured === undefined || configured === null || configured === '') {
    return encrypted ? signedDefault : DEFAULT_USERINFO_SIGNING_ALGORITHM;
  }
  if (configured === DEFAULT_USERINFO_SIGNING_ALGORITHM) {
    return encrypted ? signedDefault : DEFAULT_USERINFO_SIGNING_ALGORITHM;
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
    if (key.alg === 'PS256' && key.kty === 'RSA' && key.n && key.e) published.add('PS256');
  }
  return OIDC_SIGNING_ALGORITHMS.filter((algorithm) => published.has(algorithm));
}
