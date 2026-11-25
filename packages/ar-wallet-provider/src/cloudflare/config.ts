/** Builds the provider config from Worker bindings; returns null when it is not usable. */

import { fromBase64, sha256, toHex, type Bytes } from '../domain/bytes';
import { parseCertificate } from '../domain/x509';
import { DEFAULT_LIMITS, profileFor, type WalletProviderConfig } from '../service/config';
import type { WalletProviderEnv } from './env';

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export async function buildConfig(env: WalletProviderEnv): Promise<WalletProviderConfig | null> {
  if (env.ENVIRONMENT !== 'staging' && env.ENVIRONMENT !== 'production') return null;
  const secrets: Bytes[] = [];
  for (const value of [env.CHALLENGE_HMAC_KEY, env.CHALLENGE_HMAC_KEY_PREVIOUS]) {
    if (!value) continue;
    const bytes = fromBase64(value);
    if (!bytes || bytes.length < 32) return null;
    secrets.push(bytes);
  }
  const root = fromBase64(env.APPLE_ROOT_DER_B64 ?? '');
  const appIds = list(env.APP_IDS);
  if (
    secrets.length === 0 ||
    !root ||
    appIds.length === 0 ||
    !env.PROVIDER_ISSUER ||
    !env.WALLET_CLIENT_ID
  ) {
    return null;
  }
  if (toHex(await sha256(root)) !== (env.APPLE_ROOT_SHA256 ?? '').toLowerCase()) return null;
  // The pinned root must really be a usable CA certificate (P-384, valid now); otherwise every
  // registration would fail as `invalid_attestation` and clients would drop good keys.
  try {
    const cert = parseCertificate(root);
    const at = Math.floor(Date.now() / 1000);
    if (!cert.isCA || cert.curve !== 'P-384' || at < cert.notBefore || at > cert.notAfter) {
      return null;
    }
  } catch {
    return null;
  }
  const revoked = list(env.REVOKED_BUNDLE_VERSIONS);
  return {
    environment: env.ENVIRONMENT,
    challengeLabel: env.ENVIRONMENT,
    challengeSecrets: secrets,
    challengeTtlSeconds: 300,
    issuer: env.PROVIDER_ISSUER,
    clientId: env.WALLET_CLIENT_ID,
    walletTtlSeconds: 3600,
    keyTtlSeconds: 600,
    keyStorage: ['iso_18045_high'],
    policy: {
      ...profileFor(env.ENVIRONMENT),
      appIds,
      minBundleVersion: env.MIN_BUNDLE_VERSION || undefined,
      revokedBundleVersions: revoked.length > 0 ? revoked : undefined,
      appleRootDer: root,
      appleRootSha256: env.APPLE_ROOT_SHA256.toLowerCase(),
    },
    limits: DEFAULT_LIMITS,
    maxBodyBytes: 32 * 1024,
  };
}
