/**
 * External callback: details of what is read from the provider's answer and what is logged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anyOf, containing } from './helpers/matchers';
import { M, REQUEST_CONTEXT, T0, TOKENS, setupCallbackMocks } from './helpers/callback-mocks';
import { getTenantIdFromContext } from '@authrim/ar-lib-core';
import { argRec, callArg, rec } from './helpers/mock-args';
import {
  STATE,
  authState,
  callback,
  oauthProvider,
  oidcProvider,
  paramsOf,
} from './helpers/callback-harness';

beforeEach(setupCallbackMocks);

const identityInput = () => argRec(M.handleIdentity, 0, 1);
const withIdToken = () =>
  M.exchangeCode.mockResolvedValue({
    tokens: { ...TOKENS, id_token: 'id.token.jwt' },
    requestContext: REQUEST_CONTEXT,
  });
const diag = () =>
  M.createDiag.mockResolvedValue({
    logTokenValidation: M.logTokenValidation,
    logAuthDecision: M.logAuthDecision,
    cleanup: M.diagCleanup,
  });
const loggedSteps = () => M.logTokenValidation.mock.calls.map((c) => rec(c[0]));
const codeMetadata = () => rec(argRec(M.store.storeChallengeRpc).metadata);

describe('the page that relays a fragment response', () => {
  it('is sent with fresh nonce, no-store and no referrer, framed by nobody', async () => {
    const response = await callback({ query: '' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    const html = await response.text();
    const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1] ?? '';
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(response.headers.get('Content-Security-Policy')).toBe(
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'none'; img-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
    );
    const second = await (await callback({ query: '' })).text();
    expect(/<script nonce="([^"]+)">/.exec(second)?.[1]).not.toBe(nonce);
  });
});

describe('logging', () => {
  it('logs under the CALLBACK module in every flow', async () => {
    await callback();
    await callback({ query: `state=${STATE}&error=access_denied` });
    M.publishEvent.mockRejectedValue(new Error('events down'));
    await callback();
    M.getProvider.mockResolvedValue(null);
    await callback();
    M.registerProviderSession.mockRejectedValue(new Error('x'));
    M.consumeAuthState.mockResolvedValue(authState({ enableSso: true }));
    M.getProvider.mockResolvedValue(oauthProvider);
    await callback();
    expect(M.moduleNames.length).toBeGreaterThan(4);
    expect(new Set(M.moduleNames)).toEqual(new Set(['CALLBACK']));
  });

  it('reports a failure to publish the success event', async () => {
    M.publishEvent.mockRejectedValue(new Error('events down'));
    await callback();
    await Promise.resolve();
    expect(M.errorLog).toHaveBeenCalledWith(
      'Failed to publish auth.external_idp.succeeded',
      {},
      expect.any(Error)
    );
  });

  it('reports a failure to index the provider session', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ enableSso: true }));
    M.registerProviderSession.mockRejectedValue(new Error('do down'));
    await callback();
    await Promise.resolve();
    expect(M.warnLog).toHaveBeenCalledWith('Failed to record external-provider session index');
  });
});

describe('the sign-in page a failure returns to', () => {
  it('names the tenant for any tenant but the default one', async () => {
    vi.mocked(getTenantIdFromContext).mockReturnValue('tenant-x');
    const response = await callback({ query: `state=${STATE}&error=access_denied` });
    expect(paramsOf(response).tenant_hint).toBe('tenant-x');
    vi.mocked(getTenantIdFromContext).mockReturnValue('default');
    const again = await callback({ query: `state=${STATE}&error=access_denied` });
    expect(paramsOf(again).tenant_hint).toBeUndefined();
  });
});

describe('the ID token of an OpenID Connect provider', () => {
  beforeEach(() => {
    M.getProvider.mockResolvedValue(oidcProvider);
    withIdToken();
    M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', email: 'a@example.com' });
  });

  it('is asked for the max_age of the start, except for a re-authentication', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ maxAge: 300 }));
    await callback();
    expect(callArg(M.validateIdToken, 0, 1)).toMatchObject({ maxAge: 300 });
    M.validateIdToken.mockClear();
    M.reauthPolicy.mockResolvedValue({ reauthEnabled: true });
    M.consumeAuthState.mockResolvedValue(authState({ maxAge: 300, reauthRequestedAt: T0 - 1000 }));
    await callback();
    expect(callArg(M.validateIdToken, 0, 1)).toMatchObject({ maxAge: undefined });
  });

  it('hands the diagnostics context to the validation when diagnostics are on', async () => {
    diag();
    await callback();
    expect(callArg(M.validateIdToken, 0, 2)).toEqual({
      logger: containing({ cleanup: M.diagCleanup }),
      flowId: anyOf(String),
      diagnosticSessionId: undefined,
    });
  });

  it.each([
    ['a usable acr', 'urn:acr:1', 'urn:acr:1'],
    ['an acr of 1024 characters', 'a'.repeat(1024), 'a'.repeat(1024)],
    ['an acr of 1025 characters', 'a'.repeat(1025), undefined],
    ['an empty acr', '', undefined],
    ['an acr that is not text', 5, undefined],
  ])('keeps %s for the session only when it fits', async (_n, acr, kept) => {
    M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', acr });
    await callback();
    if (kept === undefined) {
      expect(codeMetadata()).not.toHaveProperty('upstream_acr');
    } else {
      expect(codeMetadata().upstream_acr).toBe(kept);
    }
  });

  it('answers a userinfo of an always-fetching provider with the diagnostics of both steps', async () => {
    diag();
    M.getProvider.mockResolvedValue({ ...oidcProvider, alwaysFetchUserinfo: true });
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'ext-sub', name: 'N' },
      endpoint: 'https://idp.example.com/userinfo',
      signedResponse: true,
    });
    await callback();
    const [request, response] = loggedSteps().filter((entry) =>
      String(entry.step).startsWith('userinfo')
    );
    expect(request).toMatchObject({
      step: 'userinfo-request',
      tokenType: 'access_token',
      token: 'upstream-access',
      result: 'pass',
      details: { endpoint: 'https://idp.example.com/userinfo' },
    });
    expect(response).toMatchObject({
      step: 'userinfo-response',
      tokenType: 'access_token',
      token: 'upstream-access',
      result: 'pass',
      details: {
        endpoint: 'https://idp.example.com/userinfo',
        claims: { sub: 'ext-sub', name: 'N' },
        signed_response: true,
      },
    });
  });

  it('records a userinfo subject that differs from the ID token before refusing it', async () => {
    diag();
    M.getProvider.mockResolvedValue({ ...oidcProvider, alwaysFetchUserinfo: true });
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'someone-else' },
      endpoint: 'e',
      signedResponse: false,
    });
    await callback();
    const mismatch = loggedSteps().at(-1);
    expect(mismatch).toMatchObject({
      step: 'userinfo-mismatch',
      tokenType: 'id_token',
      result: 'fail',
      errorMessage: 'Userinfo sub claim does not match ID token sub',
      details: { expected_sub: 'ext-sub', actual_sub: 'someone-else' },
    });
    expect(M.handleIdentity).not.toHaveBeenCalled();
  });

  it('does not take a userinfo without a subject for a mismatch', async () => {
    M.getProvider.mockResolvedValue({ ...oidcProvider, alwaysFetchUserinfo: true });
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { name: 'No Sub' },
      endpoint: 'e',
      signedResponse: false,
    });
    await callback();
    expect(identityInput().userInfo).toMatchObject({ sub: 'ext-sub', name: 'No Sub' });
  });

  it('logs the userinfo steps of an OAuth 2.0 provider', async () => {
    diag();
    M.getProvider.mockResolvedValue(oauthProvider);
    await callback();
    expect(
      loggedSteps()
        .map((entry) => String(entry.step))
        .filter((step) => step.startsWith('userinfo'))
    ).toEqual(['userinfo-request', 'userinfo-response']);
  });
});

describe('Apple name data', () => {
  const apple = {
    ...oidcProvider,
    issuer: 'https://appleid.apple.com',
    providerQuirks: { teamId: 'T', keyId: 'K', privateKeyEncrypted: 'enc' },
  };
  beforeEach(() => {
    M.getProvider.mockResolvedValue(apple);
    withIdToken();
    M.validateIdToken.mockImplementation(async () => ({ sub: 'apple-sub', name: 'Token Name' }));
  });

  it('leaves what the ID token says where the form post names no such part', async () => {
    await callback({
      method: 'POST',
      query: '',
      body: { code: 'c', state: STATE, user: JSON.stringify({ name: { lastName: 'Only' } }) },
    });
    const merged = identityInput().userInfo as Record<string, unknown>;
    expect(merged).toMatchObject({ name: 'Only', family_name: 'Only' });
    expect(merged).not.toHaveProperty('given_name');
    M.handleIdentity.mockClear();
    await callback({
      method: 'POST',
      query: '',
      body: { code: 'c', state: STATE, user: '{"name":{}}' },
    });
    expect(identityInput().userInfo).toEqual({ sub: 'apple-sub', name: 'Token Name' });
  });
});

describe('attribute mapping', () => {
  const mapped = (attributeMapping: Record<string, string>) =>
    M.getProvider.mockResolvedValue({ ...oauthProvider, attributeMapping });

  it('turns a numeric subject into text, and leaves other values as they are', async () => {
    mapped({ sub: 'id', name: 'profile.display' });
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { id: 12345, profile: { display: 'Display' } },
      endpoint: 'e',
      signedResponse: false,
    });
    await callback();
    expect(identityInput().userInfo).toMatchObject({ sub: '12345', name: 'Display' });
    M.handleIdentity.mockClear();
    mapped({ sub: 'id' });
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { id: { nested: 1 } },
      endpoint: 'e',
      signedResponse: false,
    });
    const response = await callback();
    // an object names no account: refused before identity resolution
    expect(M.handleIdentity).not.toHaveBeenCalled();
    expect(paramsOf(response)).toMatchObject({ error: 'callback_failed' });
  });

  it('refuses a subject that is empty, blank, boolean or not finite', async () => {
    for (const id of ['', '  ', true, Number.NaN, null, ['x']]) {
      mapped({ sub: 'id' });
      M.fetchUserInfo.mockResolvedValue({ userInfo: { id }, endpoint: 'e', signedResponse: false });
      const response = await callback();
      expect([id, paramsOf(response).error]).toEqual([id, 'callback_failed']);
    }
    expect(M.handleIdentity).not.toHaveBeenCalled();
  });

  it('takes a numeric subject that was not mapped as its text', async () => {
    mapped({});
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 42, name: 'N' },
      endpoint: 'e',
      signedResponse: false,
    });
    await callback();
    expect(identityInput().userInfo).toMatchObject({ sub: '42', name: 'N' });
  });

  it('survives a path that runs through a missing or non-object value', async () => {
    mapped({ sub: 'id', name: 'data.user.name', email: 'flag.deep', picture: 'text.deep' });
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { id: 'x', data: null, flag: undefined, text: 'plain' },
      endpoint: 'e',
      signedResponse: false,
    });
    const response = await callback();
    expect(response.status).toBe(302);
    const info = identityInput().userInfo as Record<string, unknown>;
    expect(info.sub).toBe('x');
    expect(info).not.toHaveProperty('name');
    expect(info).not.toHaveProperty('email');
    expect(info).not.toHaveProperty('picture');
  });

  it('refuses an answer that names no subject, telling the operator why', async () => {
    mapped({});
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { name: 'Nobody' },
      endpoint: 'e',
      signedResponse: false,
    });
    const response = await callback();
    expect(paramsOf(response)).toMatchObject({
      error: 'callback_failed',
      error_description:
        'Provider did not return a user identifier. Check attributeMapping configuration.',
    });
    expect(M.handleIdentity).not.toHaveBeenCalled();
  });
});

describe('detecting GitHub by its hosts', () => {
  const noEmail = () =>
    M.fetchUserInfo.mockImplementation(async () => ({
      userInfo: { sub: 'gh-1' },
      endpoint: 'e',
      signedResponse: false,
    }));
  const asGithub = (extra: Record<string, unknown>) => {
    M.getProvider.mockResolvedValue({
      ...oauthProvider,
      name: 'Corp',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      userinfoEndpoint: 'https://idp.example.com/userinfo',
      ...extra,
    });
    noEmail();
    M.safeFetchJson.mockResolvedValue([{ email: 'p@example.com', primary: true, verified: true }]);
  };

  it.each([
    [
      'a subdomain of github.com for authorization',
      { authorizationEndpoint: 'https://gist.github.com/login' },
    ],
    [
      'a subdomain of github.com for userinfo',
      { userinfoEndpoint: 'https://uploads.github.com/user' },
    ],
    ['the host in capitals', { authorizationEndpoint: 'https://GITHUB.COM/login' }],
  ])('recognises %s', async (_n, extra) => {
    asGithub(extra);
    await callback();
    expect(M.safeFetchJson).toHaveBeenCalledTimes(1);
    expect(identityInput().userInfo).toMatchObject({
      email: 'p@example.com',
      email_verified: true,
    });
  });

  it.each([
    ['a host that only ends like it', { authorizationEndpoint: 'https://notgithub.com/login' }],
    [
      'a host that only starts like it',
      { authorizationEndpoint: 'https://github.com.evil.example/login' },
    ],
    [
      'an address that is not a URL',
      { authorizationEndpoint: 'github.com', userinfoEndpoint: '::' },
    ],
    ['a missing address', { authorizationEndpoint: undefined, userinfoEndpoint: undefined }],
  ])('does not take %s for GitHub', async (_n, extra) => {
    asGithub(extra);
    await callback();
    expect(M.safeFetchJson).not.toHaveBeenCalled();
  });

  it('does not accept an unverified primary email by default', async () => {
    asGithub({ authorizationEndpoint: 'https://github.com/login' });
    M.safeFetchJson.mockResolvedValue([{ email: 'p@example.com', primary: true, verified: false }]);
    await callback();
    expect(identityInput().userInfo).not.toHaveProperty('email');
  });
});
