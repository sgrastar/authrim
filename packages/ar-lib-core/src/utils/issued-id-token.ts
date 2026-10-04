/**
 * Verifying an ID token this tenant issued (an id_token_hint, a Native SSO or Token Exchange
 * subject): it may be signed with any algorithm Authrim signs ID tokens with (the tenant's, or
 * the app's id_token_signed_response_alg), each with its own key in the tenant's OIDC JWKS.
 */

import { decodeProtectedHeader, importJWK, type JWK } from 'jose';
import type { Env } from '../types/env';
import {
  isOIDCSigningAlgorithm,
  OIDC_SIGNING_ALGORITHMS,
  type OIDCSigningAlgorithm,
} from './oidc-signing';

/** The algorithms an ID token Authrim issued can be signed with. */
export const ISSUED_ID_TOKEN_ALGORITHMS: readonly OIDCSigningAlgorithm[] = OIDC_SIGNING_ALGORITHMS;

/** The public keys this tenant signs ID tokens with: RS256, and the ES256 and PS256 keys. */
export async function getIssuedIDTokenKeys(
  env: Pick<Env, 'KEY_MANAGER'>,
  tenantId: string
): Promise<JWK[]> {
  if (!env.KEY_MANAGER) throw new Error('KEY_MANAGER binding not available');
  const keyManager = env.KEY_MANAGER.get(env.KEY_MANAGER.idFromName(`${tenantId}-v3`));
  return (await keyManager.getAllOIDCPublicKeysRpc()) as JWK[];
}

/**
 * The key that signed a token this tenant issued, chosen by the token's header: its algorithm
 * must be one Authrim signs ID tokens with, and the key the one its kid names (without a kid,
 * the first key of that algorithm). A key without `alg` counts only as an RS256 RSA key.
 */
export async function importIssuedTokenKey(
  keys: readonly JWK[],
  token: string
): Promise<{ key: CryptoKey; algorithm: OIDCSigningAlgorithm }> {
  const header = decodeProtectedHeader(token);
  const algorithm = header.alg;
  if (!isOIDCSigningAlgorithm(algorithm)) {
    throw new Error('Unsupported token signing algorithm');
  }
  const jwk = keys.find(
    (candidate) =>
      (header.kid === undefined || candidate.kid === header.kid) &&
      (candidate.alg === algorithm ||
        (candidate.alg === undefined && algorithm === 'RS256' && candidate.kty === 'RSA'))
  );
  if (!jwk) {
    // SECURITY: Do not expose the kid, to prevent key enumeration.
    throw new Error('Key verification failed');
  }
  return { key: (await importJWK(jwk, algorithm)) as CryptoKey, algorithm };
}
