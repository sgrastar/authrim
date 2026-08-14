import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';

export interface FixedSigningKeySet {
  kid: string;
  privatePem: string;
  publicJwk: Record<string, unknown>;
  publicJwkJson: string;
}

let cachedKeySet: FixedSigningKeySet | null = null;

/**
 * Generate (once per process) a fixed RSA-2048 signing key pair. JWT byte snapshots are
 * unnecessary for these deterministic tests; semantic verification is what matters, so a process-local
 * key generated from a stable input is sufficient.
 */
export async function getFixedSigningKeySet(
  kid = 'security-matrix-fixed-kid-001'
): Promise<FixedSigningKeySet> {
  if (cachedKeySet) {
    return cachedKeySet;
  }
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
    modulusLength: 2048,
  });
  const [privatePem, publicJwk] = await Promise.all([
    exportPKCS8(privateKey),
    exportJWK(publicKey),
  ]);
  const jwk = { ...publicJwk, kid, use: 'sig', alg: 'RS256' };
  cachedKeySet = {
    kid,
    privatePem,
    publicJwk: jwk,
    publicJwkJson: JSON.stringify(jwk),
  };
  return cachedKeySet;
}
