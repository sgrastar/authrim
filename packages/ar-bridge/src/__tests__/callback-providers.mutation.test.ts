/**
 * External callback: OIDC id_token validation, hybrid flow, and provider-specific userinfo
 * (Apple, GitHub, Facebook, Twitter).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { argRec, callArg } from './helpers/mock-args';
import { M, REQUEST_CONTEXT, T0, TOKENS, setupCallbackMocks } from './helpers/callback-mocks';
import { ExternalIdPErrorCode } from '../types';
import {
  authState,
  STATE,
  callback,
  oauthProvider,
  oidcProvider,
  paramsOf,
} from './helpers/callback-harness';
import { generateAppSecretProof } from '../providers/facebook';

beforeEach(setupCallbackMocks);

const withIdToken = (idToken = 'id.token.jwt') =>
  M.exchangeCode.mockResolvedValue({
    tokens: { ...TOKENS, id_token: idToken },
    requestContext: REQUEST_CONTEXT,
  });
const identityInput = () => argRec(M.handleIdentity, 0, 1);

describe('OIDC id_token validation', () => {
  beforeEach(() => {
    M.getProvider.mockResolvedValue(oidcProvider);
    withIdToken();
    M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', email: 'a@example.com' });
  });

  it('validates the id_token against the stored nonce and uses its claims', async () => {
    await callback();
    expect(M.validateIdToken).toHaveBeenCalledTimes(1);
    expect(M.validateIdToken).toHaveBeenCalledWith(
      'id.token.jwt',
      {
        nonce: 'nonce-a',
        accessToken: 'upstream-access',
        maxAge: undefined,
        acrValues: undefined,
        requireExactAudience: false,
        expectedSigningAlgorithms: undefined,
      },
      undefined
    );
    expect(M.fetchUserInfo).not.toHaveBeenCalled();
    expect(identityInput().userInfo).toEqual({ sub: 'ext-sub', email: 'a@example.com' });
  });

  it('passes the requested max_age and acr_values, but no max_age for a re-authentication', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ maxAge: 300, acrValues: 'urn:acr:1' }));
    await callback();
    expect(M.validateIdToken.mock.calls[0]?.[1]).toMatchObject({
      maxAge: 300,
      acrValues: 'urn:acr:1',
    });
    M.validateIdToken.mockClear();
    M.consumeAuthState.mockResolvedValue(
      authState({ maxAge: 0, acrValues: 'urn:acr:1', reauthRequestedAt: T0 })
    );
    M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', auth_time: Math.floor(T0 / 1000) });
    M.reauthPolicy.mockResolvedValue({ reauthEnabled: true });
    await callback();
    expect(M.validateIdToken.mock.calls[0]?.[1]).toMatchObject({
      maxAge: undefined,
      acrValues: 'urn:acr:1',
    });
  });

  it('refuses an OIDC provider that returns no id_token, without reading userinfo', async () => {
    M.exchangeCode.mockResolvedValue({ tokens: TOKENS, requestContext: REQUEST_CONTEXT });
    const response = await callback();
    expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.validateIdToken).not.toHaveBeenCalled();
    expect(M.fetchUserInfo).not.toHaveBeenCalled();
    expect(M.handleIdentity).not.toHaveBeenCalled();
    expect(M.resolveAccount).not.toHaveBeenCalled();
    expect(M.store.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses an OIDC sign-in whose stored state has no nonce, without reading userinfo', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ nonce: undefined }));
    const response = await callback();
    expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.validateIdToken).not.toHaveBeenCalled();
    expect(M.fetchUserInfo).not.toHaveBeenCalled();
    expect(M.handleIdentity).not.toHaveBeenCalled();
    expect(M.resolveAccount).not.toHaveBeenCalled();
  });

  it('still reads userinfo alone for an OAuth 2.0 provider', async () => {
    M.getProvider.mockResolvedValue(oauthProvider);
    M.exchangeCode.mockResolvedValue({ tokens: TOKENS, requestContext: REQUEST_CONTEXT });
    M.consumeAuthState.mockResolvedValue(authState({ nonce: undefined }));
    expect((await callback()).status).toBe(302);
    expect(M.fetchUserInfo).toHaveBeenCalledTimes(1);
    expect(M.validateIdToken).not.toHaveBeenCalled();
  });

  it('does not validate an id_token for a non-OIDC provider', async () => {
    M.getProvider.mockResolvedValue(oauthProvider);
    await callback();
    expect(M.validateIdToken).not.toHaveBeenCalled();
    expect(M.fetchUserInfo).toHaveBeenCalledTimes(1);
  });

  it('merges userinfo into the claims when the provider asks for it always', async () => {
    M.getProvider.mockResolvedValue({ ...oidcProvider, alwaysFetchUserinfo: true });
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'ext-sub', name: 'From Userinfo', email: 'b@example.com' },
      endpoint: 'https://idp.example.com/userinfo',
      signedResponse: true,
    });
    await callback();
    expect(M.fetchUserInfo).toHaveBeenCalledWith('upstream-access');
    expect(identityInput().userInfo).toEqual({
      sub: 'ext-sub',
      email: 'b@example.com',
      name: 'From Userinfo',
    });
  });

  it('refuses a userinfo whose subject differs from the id_token', async () => {
    M.getProvider.mockResolvedValue({ ...oidcProvider, alwaysFetchUserinfo: true });
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'someone-else' },
      endpoint: 'e',
      signedResponse: false,
    });
    const response = await callback();
    expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.handleIdentity).not.toHaveBeenCalled();
  });

  it('keeps going on the id_token claims when the userinfo fetch fails', async () => {
    M.getProvider.mockResolvedValue({ ...oidcProvider, alwaysFetchUserinfo: true });
    M.fetchUserInfo.mockRejectedValue(new Error('userinfo down'));
    const response = await callback();
    expect(response.status).toBe(302);
    expect(identityInput().userInfo).toEqual({ sub: 'ext-sub', email: 'a@example.com' });
  });

  it('ignores a userinfo without a subject, as the client refuses it', async () => {
    M.getProvider.mockResolvedValue({ ...oidcProvider, alwaysFetchUserinfo: true });
    M.fetchUserInfo.mockRejectedValue(new Error('Userinfo response missing required sub claim'));
    expect((await callback()).status).toBe(302);
    expect(identityInput().userInfo).toEqual({ sub: 'ext-sub', email: 'a@example.com' });
  });

  it('does not fetch userinfo when the provider does not ask for it', async () => {
    M.getProvider.mockResolvedValue({ ...oidcProvider, alwaysFetchUserinfo: false });
    await callback();
    expect(M.fetchUserInfo).not.toHaveBeenCalled();
  });
});

describe('hybrid flow (code id_token)', () => {
  const hybrid = { ...oidcProvider, providerQuirks: { responseType: 'code id_token' } };
  beforeEach(() => {
    M.getProvider.mockResolvedValue(hybrid);
    withIdToken('token-endpoint.id.token');
    M.validateIdToken.mockResolvedValue({
      sub: 'ext-sub',
      iss: 'https://idp.example.com',
    });
  });

  it('validates the authorization-response id_token with its code hash first', async () => {
    await callback({ query: `code=upstream-code&state=${STATE}&id_token=auth.id.token` });
    expect(M.validateIdToken).toHaveBeenCalledTimes(2);
    expect(M.validateIdToken.mock.calls[0]).toEqual([
      'auth.id.token',
      {
        nonce: 'nonce-a',
        code: 'upstream-code',
        requireCodeHash: true,
        maxAge: undefined,
        acrValues: undefined,
      },
      undefined,
    ]);
    expect(M.validateIdToken.mock.calls[1]?.[0]).toBe('token-endpoint.id.token');
  });

  it('requires the authorization-response id_token and the nonce', async () => {
    const response = await callback();
    expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.exchangeCode).not.toHaveBeenCalled();
    M.consumeAuthState.mockResolvedValue(authState({ nonce: undefined }));
    const noNonce = await callback({
      query: `code=upstream-code&state=${STATE}&id_token=auth.id.token`,
    });
    expect(paramsOf(noNonce).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.exchangeCode).not.toHaveBeenCalled();
  });

  it('passes max_age and acr_values to the first validation, but not max_age on re-authentication', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ maxAge: 60, acrValues: 'urn:a' }));
    await callback({ query: `code=c&state=${STATE}&id_token=auth.id.token` });
    expect(M.validateIdToken.mock.calls[0]?.[1]).toMatchObject({ maxAge: 60, acrValues: 'urn:a' });
  });

  it('refuses the two id_tokens when issuer or subject differ', async () => {
    M.validateIdToken
      .mockResolvedValueOnce({ sub: 'ext-sub', iss: 'https://idp.example.com' })
      .mockResolvedValueOnce({ sub: 'ext-sub', iss: 'https://other.example' });
    const issuer = await callback({ query: `code=c&state=${STATE}&id_token=a.b.c` });
    expect(paramsOf(issuer).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.handleIdentity).not.toHaveBeenCalled();
    M.validateIdToken
      .mockResolvedValueOnce({ sub: 'ext-sub', iss: 'https://idp.example.com' })
      .mockResolvedValueOnce({ sub: 'other', iss: 'https://idp.example.com' });
    const subject = await callback({ query: `code=c&state=${STATE}&id_token=a.b.c` });
    expect(paramsOf(subject).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.handleIdentity).not.toHaveBeenCalled();
  });

  it('accepts matching id_tokens', async () => {
    const response = await callback({ query: `code=c&state=${STATE}&id_token=a.b.c` });
    expect(response.status).toBe(302);
    expect(M.handleIdentity).toHaveBeenCalledTimes(1);
  });
});

describe('Apple', () => {
  const apple = {
    ...oidcProvider,
    issuer: 'https://appleid.apple.com',
    providerQuirks: {
      teamId: 'ABCDE12345',
      keyId: 'ZYXWV98765',
      privateKeyEncrypted: 'enc-private-key',
    },
  };
  beforeEach(() => {
    M.getProvider.mockResolvedValue(apple);
    withIdToken();
    M.validateIdToken.mockImplementation(async () => ({
      sub: 'apple-sub',
      email: 'relay@privaterelay.example',
    }));
    M.decrypt.mockResolvedValue('PRIVATE-KEY-PEM');
  });

  it('builds the client secret from the decrypted key with the default ttl', async () => {
    await callback();
    expect(M.decrypt).toHaveBeenCalledWith('enc-private-key', 'encryption-key');
    expect(M.appleSecret).toHaveBeenCalledWith(
      'ABCDE12345',
      'upstream-client',
      'ZYXWV98765',
      'PRIVATE-KEY-PEM',
      2592000
    );
    expect(M.fromProvider.mock.calls[0]?.[2]).toBe('apple-client-secret');
    expect(M.decrypt).not.toHaveBeenCalledWith('encrypted-secret', expect.anything());
  });

  it('uses a configured ttl and fails without an encryption key', async () => {
    M.getProvider.mockResolvedValue({
      ...apple,
      providerQuirks: { ...apple.providerQuirks, clientSecretTtl: 600 },
    });
    await callback();
    expect(M.appleSecret.mock.calls[0]?.[4]).toBe(600);
    M.getKey.mockReturnValue(undefined);
    M.appleSecret.mockClear();
    const response = await callback();
    expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.appleSecret).not.toHaveBeenCalled();
  });

  it('merges the first-authorization user data from the form post', async () => {
    const user = JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } });
    await callback({
      method: 'POST',
      query: '',
      body: { code: 'upstream-code', state: STATE, user },
    });
    expect(identityInput().userInfo).toMatchObject({
      sub: 'apple-sub',
      email: 'relay@privaterelay.example',
      name: 'Ada Lovelace',
      given_name: 'Ada',
      family_name: 'Lovelace',
    });
  });

  it('merges only the name parts that are present, and ignores an unusable user value', async () => {
    await callback({
      method: 'POST',
      query: '',
      body: {
        code: 'c',
        state: STATE,
        user: JSON.stringify({ name: { firstName: 'Solo' } }),
      },
    });
    const merged = identityInput().userInfo;
    expect(merged).toMatchObject({ name: 'Solo', given_name: 'Solo' });
    expect(merged).not.toHaveProperty('family_name');
    M.handleIdentity.mockClear();
    await callback({ method: 'POST', query: '', body: { code: 'c', state: STATE, user: '{' } });
    expect(identityInput().userInfo).toEqual({
      sub: 'apple-sub',
      email: 'relay@privaterelay.example',
    });
  });
});

describe('GitHub', () => {
  const github = { ...oauthProvider, name: 'GitHub' };
  beforeEach(() => {
    M.getProvider.mockResolvedValue(github);
    // A fresh object per call: the handler fills in the email on the one it is given.
    M.fetchUserInfo.mockImplementation(async () => ({
      userInfo: { sub: 'gh-1', name: 'Octo' },
      endpoint: 'e',
      signedResponse: false,
    }));
  });

  const emails = (list: Array<Record<string, unknown>>) => M.safeFetchJson.mockResolvedValue(list);

  it('fetches the primary verified email when userinfo has none', async () => {
    emails([
      { email: 'secondary@example.com', primary: false, verified: true },
      { email: 'primary@example.com', primary: true, verified: true },
    ]);
    await callback();
    expect(M.safeFetchJson).toHaveBeenCalledWith('https://api.github.com/user/emails', {
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
      headers: {
        Authorization: 'Bearer upstream-access',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    expect(identityInput().userInfo).toMatchObject({
      email: 'primary@example.com',
      email_verified: true,
    });
  });

  it('is detected by its endpoints too, not only by name', async () => {
    emails([{ email: 'p@example.com', primary: true, verified: true }]);
    M.getProvider.mockResolvedValue({
      ...oauthProvider,
      name: 'Dev',
      userinfoEndpoint: 'https://api.github.com/user',
    });
    await callback();
    expect(M.safeFetchJson).toHaveBeenCalledTimes(1);
    M.safeFetchJson.mockClear();
    M.getProvider.mockResolvedValue({
      ...oauthProvider,
      name: 'Dev',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      userinfoEndpoint: undefined,
    });
    await callback();
    expect(M.safeFetchJson).toHaveBeenCalledTimes(1);
  });

  it('does not treat a lookalike host as GitHub', async () => {
    M.getProvider.mockResolvedValue({
      ...oauthProvider,
      name: 'Dev',
      userinfoEndpoint: 'https://evil.example/api.github.com',
      authorizationEndpoint: 'https://notgithub.com/authorize',
    });
    await callback();
    expect(M.safeFetchJson).not.toHaveBeenCalled();
  });

  it('skips the lookup when userinfo already has an email or the quirk turns it off', async () => {
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'gh-1', email: 'has@example.com' },
      endpoint: 'e',
      signedResponse: false,
    });
    await callback();
    expect(M.safeFetchJson).not.toHaveBeenCalled();
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'gh-1' },
      endpoint: 'e',
      signedResponse: false,
    });
    M.getProvider.mockResolvedValue({ ...github, providerQuirks: { fetchPrimaryEmail: false } });
    await callback();
    expect(M.safeFetchJson).not.toHaveBeenCalled();
  });

  it('ignores an unverified primary email unless the provider allows it', async () => {
    emails([{ email: 'unverified@example.com', primary: true, verified: false }]);
    await callback();
    expect(identityInput().userInfo).not.toHaveProperty('email');
    M.handleIdentity.mockClear();
    M.getProvider.mockResolvedValue({ ...github, providerQuirks: { allowUnverifiedEmail: true } });
    await callback();
    expect(identityInput().userInfo).toMatchObject({
      email: 'unverified@example.com',
      email_verified: false,
    });
  });

  it('keeps going without an email when there is no primary one or the lookup fails', async () => {
    emails([{ email: 'x@example.com', primary: false, verified: true }]);
    expect((await callback()).status).toBe(302);
    expect(identityInput().userInfo).not.toHaveProperty('email');
    M.handleIdentity.mockClear();
    M.safeFetchJson.mockRejectedValue(new Error('github down'));
    expect((await callback()).status).toBe(302);
    expect(identityInput().userInfo).not.toHaveProperty('email');
  });
});

describe('Facebook', () => {
  const facebook = {
    ...oauthProvider,
    name: 'Facebook',
    providerQuirks: { useAppSecretProof: true },
  };
  beforeEach(() => {
    M.getProvider.mockResolvedValue(facebook);
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'fb-1', name: 'Original' },
      endpoint: 'e',
      signedResponse: false,
    });
    M.safeFetchJson.mockResolvedValue({ name: 'Refetched', picture: 'p.png' });
  });

  it('re-fetches /me with the app secret proof and merges over the userinfo', async () => {
    await callback();
    const proof = await generateAppSecretProof('upstream-access', 'upstream-secret');
    const url = String(callArg(M.safeFetchJson, 0, 0));
    const options = callArg(M.safeFetchJson, 0, 1);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://graph.facebook.com/v20.0/me');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      fields: 'id,name,email,picture.type(large)',
      access_token: 'upstream-access',
      appsecret_proof: proof,
    });
    expect(options).toEqual({ timeoutMs: 5000, maxResponseSize: 64 * 1024 });
    expect(identityInput().userInfo).toEqual({ sub: 'fb-1', name: 'Refetched', picture: 'p.png' });
  });

  it('honours the configured api version and fields', async () => {
    M.getProvider.mockResolvedValue({
      ...facebook,
      providerQuirks: { useAppSecretProof: true, apiVersion: 'v18.0', fields: ['id', 'email'] },
    });
    await callback();
    const parsed = new URL(String(callArg(M.safeFetchJson, 0, 0)));
    expect(parsed.pathname).toBe('/v18.0/me');
    expect(parsed.searchParams.get('fields')).toBe('id,email');
  });

  it('is detected by endpoints, and is left alone for OIDC or without the proof quirk', async () => {
    M.getProvider.mockResolvedValue({
      ...facebook,
      name: 'Social',
      authorizationEndpoint: 'https://www.facebook.com/dialog/oauth',
    });
    await callback();
    expect(M.safeFetchJson).toHaveBeenCalledTimes(1);
    M.safeFetchJson.mockClear();
    M.getProvider.mockResolvedValue({
      ...facebook,
      name: 'Social',
      authorizationEndpoint: undefined,
      tokenEndpoint: 'https://graph.facebook.com/oauth/access_token',
    });
    await callback();
    expect(M.safeFetchJson).toHaveBeenCalledTimes(1);
    M.safeFetchJson.mockClear();
    M.getProvider.mockResolvedValue({ ...facebook, providerQuirks: {} });
    await callback();
    expect(M.safeFetchJson).not.toHaveBeenCalled();
    M.getProvider.mockResolvedValue({ ...facebook, providerType: 'oidc', issuer: 'https://x' });
    await callback();
    expect(M.safeFetchJson).not.toHaveBeenCalled();
  });

  it('keeps the original userinfo when the re-fetch fails', async () => {
    M.safeFetchJson.mockRejectedValue(new Error('graph down'));
    expect((await callback()).status).toBe(302);
    expect(identityInput().userInfo).toEqual({ sub: 'fb-1', name: 'Original' });
  });
});

describe('Twitter', () => {
  const twitter = { ...oauthProvider, name: 'Twitter', providerQuirks: { userFields: 'id,name' } };
  beforeEach(() => {
    M.getProvider.mockResolvedValue(twitter);
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'tw-1', name: 'Original' },
      endpoint: 'e',
      signedResponse: false,
    });
    M.safeFetchJson.mockResolvedValue({ username: 'handle' });
  });

  it('re-fetches the user with the configured fields and expansions', async () => {
    M.getProvider.mockResolvedValue({
      ...twitter,
      providerQuirks: { userFields: 'id,name', expansions: 'pinned_tweet_id' },
    });
    await callback();
    const url = String(callArg(M.safeFetchJson, 0, 0));
    const options = callArg(M.safeFetchJson, 0, 1);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://api.twitter.com/2/users/me');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      'user.fields': 'id,name',
      expansions: 'pinned_tweet_id',
    });
    expect(options).toEqual({
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
      headers: { Authorization: 'Bearer upstream-access' },
    });
    expect(identityInput().userInfo).toEqual({ sub: 'tw-1', name: 'Original', username: 'handle' });
  });

  it('omits expansions when none are configured', async () => {
    await callback();
    expect(new URL(String(callArg(M.safeFetchJson, 0, 0))).searchParams.has('expansions')).toBe(
      false
    );
  });

  it.each([
    ['name x', { name: 'x' }],
    ['name containing twitter', { name: 'My Twitter' }],
    ['authorization host x.com', { name: 'S', authorizationEndpoint: 'https://x.com/i/oauth2' }],
    [
      'authorization host twitter.com',
      { name: 'S', authorizationEndpoint: 'https://twitter.com/i' },
    ],
    ['token host api.x.com', { name: 'S', tokenEndpoint: 'https://api.x.com/2/oauth2/token' }],
    [
      'token host api.twitter.com',
      { name: 'S', tokenEndpoint: 'https://api.twitter.com/2/oauth2' },
    ],
  ])('is detected by %s', async (_label, overrides) => {
    M.getProvider.mockResolvedValue({ ...twitter, ...overrides });
    await callback();
    expect(M.safeFetchJson).toHaveBeenCalledTimes(1);
  });

  it('is left alone without the userFields quirk, for OIDC, or for a similar name', async () => {
    M.getProvider.mockResolvedValue({ ...twitter, providerQuirks: {} });
    await callback();
    M.getProvider.mockResolvedValue({ ...twitter, providerType: 'oidc', issuer: 'https://x' });
    await callback();
    M.getProvider.mockResolvedValue({
      ...twitter,
      name: 'xy',
      authorizationEndpoint: 'https://notx.com/a',
    });
    await callback();
    expect(M.safeFetchJson).not.toHaveBeenCalled();
  });

  it('keeps the original userinfo when the re-fetch fails', async () => {
    M.safeFetchJson.mockRejectedValue(new Error('twitter down'));
    expect((await callback()).status).toBe(302);
    expect(identityInput().userInfo).toEqual({ sub: 'tw-1', name: 'Original' });
  });
});
