/**
 * Preset configurations and validators of the social providers (Apple, Twitter/X, Facebook,
 * LinkedIn, Google).
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  createLogger: () => ({ module: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }),
}));

import {
  APPLE_DEFAULT_CONFIG,
  createAppleConfig,
  isAppleProvider,
  validateAppleConfig,
} from '../providers/apple';
import {
  FACEBOOK_DEFAULT_CONFIG,
  createFacebookConfig,
  generateAppSecretProof,
  getFacebookEffectiveEndpoints,
  getFacebookEndpoints,
  isFacebookLoginProvider,
  validateFacebookConfig,
} from '../providers/facebook';
import { GOOGLE_DEFAULT_CONFIG, validateGoogleConfig } from '../providers/google';
import { LINKEDIN_DEFAULT_CONFIG, validateLinkedInConfig } from '../providers/linkedin';
import {
  TWITTER_DEFAULT_CONFIG,
  createTwitterConfig,
  TWITTER_CLAIM_MAPPINGS,
  TWITTER_REVOCATION_ENDPOINT,
  getTwitterEffectiveEndpoints,
  getTwitterUserInfoUrl,
  validateTwitterConfig,
} from '../providers/twitter';
import type { UpstreamProvider } from '../types';
import { rec } from './helpers/mock-args';

type Partial_ = Partial<UpstreamProvider>;

describe('Apple', () => {
  const quirks = { teamId: 'ABCDE12345', keyId: 'ZYXWV98765', privateKeyEncrypted: 'enc' };
  const valid = (): Partial_ => ({
    clientId: 'com.example.app',
    scopes: 'openid name email',
    providerQuirks: { ...quirks },
  });

  it('presets the Apple endpoints, form post and a 30 day client secret', () => {
    expect(APPLE_DEFAULT_CONFIG).toMatchObject({
      name: 'Apple',
      providerType: 'oidc',
      issuer: 'https://appleid.apple.com',
      authorizationEndpoint: 'https://appleid.apple.com/auth/authorize',
      tokenEndpoint: 'https://appleid.apple.com/auth/token',
      jwksUri: 'https://appleid.apple.com/auth/keys',
      userinfoEndpoint: undefined,
      scopes: 'openid name email',
      autoLinkEmail: true,
      requireEmailVerified: true,
      buttonText: 'Continue with Apple',
      providerQuirks: { clientSecretTtl: 2592000, useFormPost: true },
    });
  });

  it('accepts a complete configuration', () => {
    expect(validateAppleConfig(valid())).toEqual([]);
  });

  it('names each missing or malformed part', () => {
    expect(validateAppleConfig({})).toEqual([
      'clientId (Service ID or Bundle ID) is required',
      'providerQuirks.teamId (Apple Developer Team ID) is required',
      'providerQuirks.keyId (Sign in with Apple Key ID) is required',
      'providerQuirks.privateKeyEncrypted (encrypted P-256 private key) is required',
      'At least one scope (name, email) is required',
    ]);
    const bad = validateAppleConfig({
      ...valid(),
      providerQuirks: { ...quirks, teamId: 'SHORT', keyId: 'ALSOSHORTX1' },
    });
    expect(bad).toEqual([
      'providerQuirks.teamId must be exactly 10 characters',
      'providerQuirks.keyId must be exactly 10 characters',
    ]);
  });

  it('bounds the client secret lifetime to 1..15552000 seconds', () => {
    const withTtl = (clientSecretTtl: number) =>
      validateAppleConfig({ ...valid(), providerQuirks: { ...quirks, clientSecretTtl } });
    expect(withTtl(1)).toEqual([]);
    expect(withTtl(15552000)).toEqual([]);
    expect(withTtl(0)).toEqual(['providerQuirks.clientSecretTtl must be positive']);
    expect(withTtl(-5)).toEqual(['providerQuirks.clientSecretTtl must be positive']);
    expect(withTtl(15552001)).toEqual([
      'providerQuirks.clientSecretTtl cannot exceed 15552000 (6 months)',
    ]);
  });

  it('needs one of the name, email or openid scopes, separated by spaces or commas', () => {
    for (const scopes of ['name', 'email', 'openid', 'x,email', 'x  name']) {
      expect(validateAppleConfig({ ...valid(), scopes })).toEqual([]);
    }
    for (const scopes of ['profile', '', undefined]) {
      expect(validateAppleConfig({ ...valid(), scopes })).toEqual([
        'At least one scope (name, email) is required',
      ]);
    }
  });

  it('recognises Apple by issuer, endpoint host or name only', () => {
    expect(isAppleProvider({ issuer: 'https://appleid.apple.com' })).toBe(true);
    expect(
      isAppleProvider({ authorizationEndpoint: 'https://appleid.apple.com/auth/authorize' })
    ).toBe(true);
    expect(isAppleProvider({ tokenEndpoint: 'https://sub.appleid.apple.com/token' })).toBe(true);
    expect(isAppleProvider({ name: 'APPLE' })).toBe(true);
    expect(isAppleProvider({ issuer: 'https://appleid.apple.com.evil.example' })).toBe(false);
    expect(
      isAppleProvider({ authorizationEndpoint: 'https://evil.example/appleid.apple.com' })
    ).toBe(false);
    expect(isAppleProvider({ authorizationEndpoint: 'https://notappleid.apple.com/x' })).toBe(
      false
    );
    expect(isAppleProvider({ tokenEndpoint: 'not a url' })).toBe(false);
    expect(isAppleProvider({ name: 'Apple Inc' })).toBe(false);
    expect(isAppleProvider({})).toBe(false);
  });

  it('creates a configuration with the credentials and a default lifetime', () => {
    const config = createAppleConfig({ ...quirks });
    expect(config.providerQuirks).toEqual({
      ...quirks,
      clientSecretTtl: 2592000,
      useFormPost: true,
    });
    expect(createAppleConfig({ ...quirks, clientSecretTtl: 60 }).providerQuirks).toMatchObject({
      clientSecretTtl: 60,
    });
    expect(createAppleConfig({ ...quirks, clientSecretTtl: 0 }).providerQuirks).toMatchObject({
      clientSecretTtl: 2592000,
    });
    expect(
      createAppleConfig({ ...quirks, overrides: { name: 'Mine', enabled: false } })
    ).toMatchObject({
      name: 'Mine',
      enabled: false,
      issuer: 'https://appleid.apple.com',
    });
    expect(APPLE_DEFAULT_CONFIG.providerQuirks).toMatchObject({ teamId: '' });
  });
});

describe('Twitter / X', () => {
  const valid = (): Partial_ => ({
    clientId: 'cid',
    clientSecretEncrypted: 'enc',
    scopes: 'users.read tweet.read offline.access',
  });

  it('presets the OAuth 2.0 endpoints and nested attribute mapping', () => {
    expect(TWITTER_DEFAULT_CONFIG).toMatchObject({
      name: 'Twitter',
      providerType: 'oauth2',
      issuer: undefined,
      authorizationEndpoint: 'https://twitter.com/i/oauth2/authorize',
      tokenEndpoint: 'https://api.twitter.com/2/oauth2/token',
      userinfoEndpoint: 'https://api.twitter.com/2/users/me',
      scopes: 'users.read tweet.read offline.access',
      attributeMapping: {
        sub: 'data.id',
        name: 'data.name',
        preferred_username: 'data.username',
        picture: 'data.profile_image_url',
      },
      autoLinkEmail: false,
      requireEmailVerified: false,
      providerQuirks: {
        useBasicAuth: true,
        pkceRequired: true,
        userFields: 'id,name,username,profile_image_url',
        includeEmail: false,
      },
    });
  });

  it('keeps its constants, claim mappings and presentation exact', () => {
    expect(TWITTER_REVOCATION_ENDPOINT).toBe('https://api.twitter.com/2/oauth2/revoke');
    expect(TWITTER_DEFAULT_CONFIG).toMatchObject({
      jitProvisioning: true,
      iconUrl: 'https://abs.twimg.com/favicons/twitter.3.ico',
      buttonColor: '#000000',
      buttonText: 'Continue with X',
    });
    expect(TWITTER_CLAIM_MAPPINGS).toStrictEqual({
      sub: 'data.id',
      preferred_username: 'data.username',
      name: 'data.name',
      picture: 'data.profile_image_url',
      email: 'data.email',
      profile: 'data.url',
      description: 'data.description',
      location: 'data.location',
      verified: 'data.verified',
      verified_type: 'data.verified_type',
      created_at: 'data.created_at',
      protected: 'data.protected',
      public_metrics: 'data.public_metrics',
    });
  });

  it('reads scopes separated by any whitespace or commas, and none as missing', () => {
    expect(validateTwitterConfig({ ...valid(), scopes: 'users.read\ttweet.read' })).toEqual([]);
    expect(validateTwitterConfig({ ...valid(), scopes: 'users.read\n,tweet.read' })).toEqual([]);
    expect(validateTwitterConfig({ ...valid(), scopes: undefined })).toEqual([
      'users.read scope is required to fetch user profile',
    ]);
    expect(validateTwitterConfig({ ...valid(), scopes: 'xusers.read' })).toEqual([
      'users.read scope is required to fetch user profile',
    ]);
  });

  it('builds a configuration from the user fields alone', () => {
    const fields = createTwitterConfig({ userFields: 'id,name' });
    expect(fields.providerQuirks).toEqual({
      ...TWITTER_DEFAULT_CONFIG.providerQuirks,
      userFields: 'id,name',
    });
    expect(fields.userinfoEndpoint).toBe(
      'https://api.twitter.com/2/users/me?user.fields=id%2Cname'
    );
    const email = createTwitterConfig({ includeEmail: true });
    expect(rec(email.providerQuirks).userFields).toBe('id,name,username,profile_image_url');
  });

  it('builds the userinfo URL from the fields and expansions', () => {
    const url = new URL(getTwitterUserInfoUrl());
    expect(url.origin + url.pathname).toBe('https://api.twitter.com/2/users/me');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'user.fields': 'id,name,username,profile_image_url',
    });
    expect(
      Object.fromEntries(
        new URL(getTwitterUserInfoUrl({ userFields: 'id,name', expansions: 'pinned_tweet_id' }))
          .searchParams
      )
    ).toEqual({ 'user.fields': 'id,name', expansions: 'pinned_tweet_id' });
    expect(new URL(getTwitterUserInfoUrl({ userFields: '' })).searchParams.get('user.fields')).toBe(
      'id,name,username,profile_image_url'
    );
  });

  it('warns that email needs elevated access only when asked for', () => {
    warn.mockClear();
    getTwitterUserInfoUrl({ includeEmail: false });
    expect(warn).not.toHaveBeenCalled();
    getTwitterUserInfoUrl({ includeEmail: true });
    expect(warn).toHaveBeenCalledWith('Twitter email access requires elevated API permissions');
  });

  it('keeps the fixed endpoints and the quirk-dependent userinfo URL', () => {
    const endpoints = getTwitterEffectiveEndpoints({ userFields: 'id' });
    expect(endpoints.authorizationEndpoint).toBe('https://twitter.com/i/oauth2/authorize');
    expect(endpoints.tokenEndpoint).toBe('https://api.twitter.com/2/oauth2/token');
    expect(endpoints.userinfoEndpoint).toBe('https://api.twitter.com/2/users/me?user.fields=id');
  });

  it('validates credentials, scopes and user fields', () => {
    expect(validateTwitterConfig(valid())).toEqual([]);
    expect(validateTwitterConfig({})).toEqual([
      'clientId (OAuth 2.0 Client ID) is required',
      'clientSecret (OAuth 2.0 Client Secret) is required',
      'users.read scope is required to fetch user profile',
    ]);
    expect(validateTwitterConfig({ ...valid(), scopes: 'users.read, tweet.read' })).toEqual([]);
    expect(
      validateTwitterConfig({
        ...valid(),
        providerQuirks: { userFields: 'id, name ,bogus,other' },
      })
    ).toEqual(['Invalid user.fields: bogus, other']);
    expect(
      validateTwitterConfig({
        ...valid(),
        providerQuirks: {
          userFields:
            'id,name,username,profile_image_url,description,url,location,verified,verified_type,created_at,protected,public_metrics,withheld,pinned_tweet_id',
        },
      })
    ).toEqual([]);
  });

  it('only warns about a missing tweet.read scope', () => {
    warn.mockClear();
    expect(validateTwitterConfig({ ...valid(), scopes: 'users.read' })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      'Twitter: tweet.read scope is typically required for OAuth 2.0'
    );
    warn.mockClear();
    validateTwitterConfig(valid());
    expect(warn).not.toHaveBeenCalled();
  });

  it('creates configurations with the requested quirks', () => {
    const plain = createTwitterConfig();
    expect(plain.providerQuirks).toEqual(TWITTER_DEFAULT_CONFIG.providerQuirks);
    expect(plain.userinfoEndpoint).toBe('https://api.twitter.com/2/users/me');
    const email = createTwitterConfig({ includeEmail: true });
    expect(email.providerQuirks).toMatchObject({ includeEmail: true });
    const fields = createTwitterConfig({ userFields: 'id,name' });
    expect(fields.providerQuirks).toMatchObject({ userFields: 'id,name', includeEmail: false });
    expect(fields.userinfoEndpoint).toBe(
      'https://api.twitter.com/2/users/me?user.fields=id%2Cname'
    );
    expect(createTwitterConfig({ overrides: { name: 'X' } })).toMatchObject({
      name: 'X',
      providerType: 'oauth2',
    });
    expect(TWITTER_DEFAULT_CONFIG.providerQuirks).toMatchObject({ includeEmail: false });
  });
});

describe('Facebook', () => {
  const valid = (): Partial_ => ({
    clientId: 'app-id',
    clientSecretEncrypted: 'enc',
    scopes: 'email public_profile',
  });

  it('presets Graph API endpoints and keeps email linking off', () => {
    expect(FACEBOOK_DEFAULT_CONFIG).toMatchObject({
      name: 'Facebook',
      providerType: 'oauth2',
      authorizationEndpoint: 'https://www.facebook.com/v20.0/dialog/oauth',
      tokenEndpoint: 'https://graph.facebook.com/v20.0/oauth/access_token',
      userinfoEndpoint: 'https://graph.facebook.com/v20.0/me',
      scopes: 'email public_profile',
      autoLinkEmail: false,
      requireEmailVerified: false,
      providerQuirks: { apiVersion: 'v20.0', useAppSecretProof: true },
    });
  });

  it('builds endpoints for a given version', () => {
    expect(getFacebookEndpoints('v18.0')).toEqual({
      authorizationEndpoint: 'https://www.facebook.com/v18.0/dialog/oauth',
      tokenEndpoint: 'https://graph.facebook.com/v18.0/oauth/access_token',
      userinfoEndpoint: 'https://graph.facebook.com/v18.0/me',
    });
    expect(getFacebookEndpoints().userinfoEndpoint).toBe('https://graph.facebook.com/v20.0/me');
    expect(getFacebookEffectiveEndpoints({ apiVersion: 'v19.0' }).tokenEndpoint).toBe(
      'https://graph.facebook.com/v19.0/oauth/access_token'
    );
    expect(getFacebookEffectiveEndpoints().tokenEndpoint).toBe(
      'https://graph.facebook.com/v20.0/oauth/access_token'
    );
    expect(getFacebookEffectiveEndpoints({ apiVersion: '' }).tokenEndpoint).toBe(
      'https://graph.facebook.com/v20.0/oauth/access_token'
    );
  });

  it('computes the app secret proof as a hex HMAC-SHA256 of the access token', async () => {
    const proof = await generateAppSecretProof('access-token', 'app-secret');
    expect(proof).toBe(createHmac('sha256', 'app-secret').update('access-token').digest('hex'));
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(await generateAppSecretProof('access-token', 'other-secret')).not.toBe(proof);
  });

  it('recognises Facebook Login by OAuth 2.0 type and endpoint host only', () => {
    const base = { providerType: 'oauth2' as const };
    expect(
      isFacebookLoginProvider({
        ...base,
        authorizationEndpoint: 'https://www.facebook.com/v20.0/dialog/oauth',
      })
    ).toBe(true);
    expect(
      isFacebookLoginProvider({ ...base, authorizationEndpoint: 'https://facebook.com/x' })
    ).toBe(true);
    expect(
      isFacebookLoginProvider({
        ...base,
        tokenEndpoint: 'https://graph.facebook.com/oauth/access_token',
      })
    ).toBe(true);
    expect(
      isFacebookLoginProvider({
        providerType: 'oidc',
        authorizationEndpoint: 'https://facebook.com/x',
      })
    ).toBe(false);
    expect(
      isFacebookLoginProvider({ ...base, authorizationEndpoint: 'https://evilfacebook.com/x' })
    ).toBe(false);
    expect(
      isFacebookLoginProvider({
        ...base,
        authorizationEndpoint: 'https://evil.example/facebook.com',
      })
    ).toBe(false);
    expect(
      isFacebookLoginProvider({ ...base, tokenEndpoint: 'https://www.facebook.com/token' })
    ).toBe(false);
    expect(isFacebookLoginProvider({ ...base, authorizationEndpoint: 'not a url' })).toBe(false);
    expect(isFacebookLoginProvider({ ...base })).toBe(false);
  });

  it('validates credentials, scopes and the API version format', () => {
    expect(validateFacebookConfig(valid())).toEqual([]);
    for (const scopes of ['', '   ', ',', ' , ']) {
      expect(validateFacebookConfig({ ...valid(), scopes })).toEqual([
        'At least one scope is required (e.g., public_profile)',
      ]);
    }
    expect(validateFacebookConfig({ ...valid(), scopes: 'email' })).toEqual([]);
    expect(validateFacebookConfig({ ...valid(), scopes: ' email,' })).toEqual([]);
    expect(validateFacebookConfig({})).toEqual([
      'clientId (App ID) is required',
      'clientSecret (App Secret) is required',
      'At least one scope is required (e.g., public_profile)',
    ]);
    for (const apiVersion of ['v20.0', 'v1.12']) {
      expect(validateFacebookConfig({ ...valid(), providerQuirks: { apiVersion } })).toEqual([]);
    }
    for (const apiVersion of ['20.0', 'v20', 'v20.0.1', 'v20.x', 'xv20.0', 'v20.0 ']) {
      expect(validateFacebookConfig({ ...valid(), providerQuirks: { apiVersion } })).toEqual([
        'apiVersion must be in format "vX.Y" (e.g., "v20.0")',
      ]);
    }
  });

  it('creates configurations for another API version', () => {
    const config = createFacebookConfig({ apiVersion: 'v18.0' });
    expect(config).toMatchObject({
      authorizationEndpoint: 'https://www.facebook.com/v18.0/dialog/oauth',
      tokenEndpoint: 'https://graph.facebook.com/v18.0/oauth/access_token',
      userinfoEndpoint: 'https://graph.facebook.com/v18.0/me',
      providerQuirks: { apiVersion: 'v18.0', useAppSecretProof: true },
    });
    expect(createFacebookConfig().userinfoEndpoint).toBe('https://graph.facebook.com/v20.0/me');
    expect(createFacebookConfig({ overrides: { enabled: false } })).toMatchObject({
      enabled: false,
      name: 'Facebook',
    });
    expect(FACEBOOK_DEFAULT_CONFIG.providerQuirks).toMatchObject({ apiVersion: 'v20.0' });
  });
});

describe('Google and LinkedIn', () => {
  const valid = (): Partial_ => ({
    clientId: 'cid',
    clientSecretEncrypted: 'enc',
    scopes: 'openid email',
  });

  it('preset the OIDC issuers and branding', () => {
    expect(GOOGLE_DEFAULT_CONFIG).toMatchObject({
      name: 'Google',
      providerType: 'oidc',
      issuer: 'https://accounts.google.com',
      buttonColor: '#4285F4',
      buttonText: 'Continue with Google',
      providerQuirks: {},
    });
    expect(LINKEDIN_DEFAULT_CONFIG).toMatchObject({
      name: 'LinkedIn',
      providerType: 'oidc',
      issuer: 'https://www.linkedin.com/oauth',
      authorizationEndpoint: 'https://www.linkedin.com/oauth/v2/authorization',
      tokenEndpoint: 'https://www.linkedin.com/oauth/v2/accessToken',
      userinfoEndpoint: 'https://api.linkedin.com/v2/userinfo',
      jwksUri: 'https://www.linkedin.com/oauth/openid/jwks',
      scopes: 'openid profile email',
      buttonColor: '#0A66C2',
      buttonText: 'Continue with LinkedIn',
    });
  });

  it.each([
    ['Google', validateGoogleConfig],
    ['LinkedIn', validateLinkedInConfig],
  ])('%s requires credentials and the openid scope', (_name, validate) => {
    expect(validate(valid())).toEqual([]);
    expect(validate({ ...valid(), scopes: 'a,openid' })).toEqual([]);
    expect(validate({})).toEqual([
      'clientId is required',
      'clientSecret is required',
      'openid scope is required for OIDC',
    ]);
    expect(validate({ ...valid(), scopes: 'email profile' })).toEqual([
      'openid scope is required for OIDC',
    ]);
    expect(validate({ ...valid(), scopes: 'openidx' })).toEqual([
      'openid scope is required for OIDC',
    ]);
  });
});
