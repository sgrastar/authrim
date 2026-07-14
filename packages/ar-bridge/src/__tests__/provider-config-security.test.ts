import { describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core', () => ({
  createLogger: () => ({ module: () => ({ warn: vi.fn() }) }),
}));
import { validateGoogleConfig } from '../providers/google';
import { validateLinkedInConfig } from '../providers/linkedin';
import { createAppleConfig, isAppleProvider, validateAppleConfig } from '../providers/apple';
import {
  createFacebookConfig,
  generateAppSecretProof,
  getFacebookEffectiveEndpoints,
  validateFacebookConfig,
} from '../providers/facebook';
import {
  createTwitterConfig,
  getTwitterUserInfoUrl,
  validateTwitterConfig,
} from '../providers/twitter';

describe('built-in provider configuration security', () => {
  it.each([
    ['Google', validateGoogleConfig],
    ['LinkedIn', validateLinkedInConfig],
  ])('%s requires credentials and the OIDC openid scope', (_name, validate) => {
    expect(validate({ scopes: 'email profile' })).toEqual(
      expect.arrayContaining([
        'clientId is required',
        'clientSecret is required',
        'openid scope is required for OIDC',
      ])
    );
    expect(
      validate({ clientId: 'id', clientSecretEncrypted: 'enc', scopes: 'openid,email' })
    ).toEqual([]);
  });

  it('does not classify lookalike Apple domains as Apple providers', () => {
    expect(
      isAppleProvider({ authorizationEndpoint: 'https://appleid.apple.com.example.net/auth' })
    ).toBe(false);
    expect(isAppleProvider({ authorizationEndpoint: 'https://evilappleid.apple.com/auth' })).toBe(
      false
    );
    expect(isAppleProvider({ authorizationEndpoint: 'https://login.appleid.apple.com/auth' })).toBe(
      true
    );
    expect(isAppleProvider({ issuer: 'https://appleid.apple.com' })).toBe(true);
  });

  it('validates all Apple signing material and client-secret lifetime bounds', () => {
    expect(
      validateAppleConfig({
        clientId: 'service',
        scopes: 'email',
        providerQuirks: {
          teamId: 'short',
          keyId: 'short',
          privateKeyEncrypted: '',
          clientSecretTtl: 15_552_001,
        },
      })
    ).toEqual(
      expect.arrayContaining([
        'providerQuirks.teamId must be exactly 10 characters',
        'providerQuirks.keyId must be exactly 10 characters',
        'providerQuirks.privateKeyEncrypted (encrypted P-256 private key) is required',
        'providerQuirks.clientSecretTtl cannot exceed 15552000 (6 months)',
      ])
    );

    const config = createAppleConfig({
      teamId: 'TEAMID1234',
      keyId: 'KEYID12345',
      privateKeyEncrypted: 'encrypted',
      overrides: { clientId: 'com.example.web' },
    });
    expect(validateAppleConfig(config)).toEqual([]);
  });

  it('creates Facebook app_secret_proof as a deterministic secret-bound HMAC', async () => {
    const first = await generateAppSecretProof('access-token', 'app-secret');
    const second = await generateAppSecretProof('access-token', 'app-secret');
    const different = await generateAppSecretProof('access-token', 'other-secret');

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });

  it('rejects malformed Facebook API versions and constructs version-pinned endpoints', () => {
    expect(
      validateFacebookConfig({
        clientId: 'id',
        clientSecretEncrypted: 'secret',
        scopes: 'public_profile',
        providerQuirks: { apiVersion: 'v20.0.evil' },
      })
    ).toContain('apiVersion must be in format "vX.Y" (e.g., "v20.0")');
    expect(getFacebookEffectiveEndpoints({ apiVersion: 'v21.0' }).tokenEndpoint).toBe(
      'https://graph.facebook.com/v21.0/oauth/access_token'
    );
    expect(createFacebookConfig({ apiVersion: 'v21.0' }).userinfoEndpoint).toBe(
      'https://graph.facebook.com/v21.0/me'
    );
  });

  it('rejects unsupported Twitter fields and safely encodes query parameters', () => {
    expect(
      validateTwitterConfig({
        clientId: 'id',
        clientSecretEncrypted: 'secret',
        scopes: 'users.read tweet.read',
        providerQuirks: { userFields: 'id,unknown_field' },
      })
    ).toContain('Invalid user.fields: unknown_field');

    const url = new URL(
      getTwitterUserInfoUrl({
        userFields: 'id,name',
        expansions: 'pinned_tweet_id&admin=true',
      })
    );
    expect(url.searchParams.get('user.fields')).toBe('id,name');
    expect(url.searchParams.get('expansions')).toBe('pinned_tweet_id&admin=true');
    expect(url.searchParams.get('admin')).toBeNull();
    expect(createTwitterConfig({ userFields: 'id,name' }).userinfoEndpoint).toContain(
      'user.fields='
    );
  });
});
