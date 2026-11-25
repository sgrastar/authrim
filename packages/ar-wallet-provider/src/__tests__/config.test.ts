import { beforeAll, describe, expect, it } from 'vitest';
import { buildConfig } from '../cloudflare/config';
import type { WalletProviderEnv } from '../cloudflare/env';
import { profileFor } from '../service/config';
import { sha256, toHex } from '../domain/bytes';

import { makeAppleWorld } from './support/apple-fixture';

let root: Uint8Array = new Uint8Array();
beforeAll(async () => {
  root = new Uint8Array((await makeAppleWorld(Math.floor(Date.now() / 1000))).rootDer);
});
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

async function env(over: Partial<WalletProviderEnv> = {}): Promise<WalletProviderEnv> {
  return {
    DB: {} as D1Database,
    ENVIRONMENT: 'production',
    PROVIDER_ISSUER: 'https://wallet-provider.authrim.com',
    WALLET_CLIENT_ID: 'keyring-ios',
    APP_IDS: 'BQ23XXWDX8.com.authrim.keyring',
    APPLE_ROOT_DER_B64: b64(root),
    APPLE_ROOT_SHA256: toHex(await sha256(root)),
    CHALLENGE_HMAC_KEY: b64(new Uint8Array(32).fill(1)),
    ...over,
  };
}

describe('config from the environment', () => {
  it('builds the production profile: category required, App Store only, little-endian', async () => {
    const config = await buildConfig(await env());
    expect(config?.policy).toMatchObject({
      environments: ['production'],
      allowedCategories: [4],
      requireCategory: true,
      categoryByteOrder: 'little',
      appIds: ['BQ23XXWDX8.com.authrim.keyring'],
    });
    expect(config?.walletTtlSeconds).toBe(3600);
    expect(config?.keyTtlSeconds).toBe(600);
    expect(config?.keyStorage).toEqual(['iso_18045_high']);
  });

  it('staging accepts development and TestFlight builds', () => {
    expect(profileFor('staging')).toMatchObject({
      environments: ['development', 'production'],
      allowedCategories: [2, 3],
      requireCategory: true,
    });
  });

  it('is unusable (null) when anything required is missing or wrong', async () => {
    for (const over of [
      { ENVIRONMENT: 'prod' },
      { CHALLENGE_HMAC_KEY: b64(new Uint8Array(8)) },
      { CHALLENGE_HMAC_KEY: '' },
      { APP_IDS: ' , ' },
      { APPLE_ROOT_SHA256: 'ab'.repeat(32) },
      { APPLE_ROOT_DER_B64: '' },
      {
        APPLE_ROOT_DER_B64: b64(new Uint8Array([48, 3, 2, 1, 1])),
        APPLE_ROOT_SHA256: toHex(await sha256(new Uint8Array([48, 3, 2, 1, 1]))),
      },
      { PROVIDER_ISSUER: '' },
      { WALLET_CLIENT_ID: '' },
    ]) {
      expect(await buildConfig(await env(over))).toBeNull();
    }
  });

  it('keeps the previous challenge key and the build lists', async () => {
    const config = await buildConfig(
      await env({
        CHALLENGE_HMAC_KEY_PREVIOUS: b64(new Uint8Array(32).fill(2)),
        MIN_BUNDLE_VERSION: '1.2',
        REVOKED_BUNDLE_VERSIONS: '1.0, 1.1',
      })
    );
    expect(config?.challengeSecrets).toHaveLength(2);
    expect(config?.policy.minBundleVersion).toBe('1.2');
    expect(config?.policy.revokedBundleVersions).toEqual(['1.0', '1.1']);
  });
});
