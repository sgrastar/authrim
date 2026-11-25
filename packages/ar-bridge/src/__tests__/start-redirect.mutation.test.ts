/**
 * External start: redirect validation, invitation, re-authentication and the stored state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T0, mocks, setupStartMocks } from './helpers/start-mocks';
import { argRec, rec } from './helpers/mock-args';
import {
  FIXED_NONCE,
  FIXED_STATE,
  IDP_AUTHORIZE,
  SIGN_IN,
  baseProvider,
  makeEnv,
  makeKv,
  must,
  start,
} from './helpers/start-harness';

beforeEach(() => {
  setupStartMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const stateArg = () => argRec(mocks.storeAuthState, 0, 1);
const nothingStarted = () => {
  expect(mocks.storeAuthState).not.toHaveBeenCalled();
  expect(mocks.fromProvider).not.toHaveBeenCalled();
};

describe('client and redirect_uri validation', () => {
  const env = () => makeEnv(makeKv());
  const redirectOf = async (query: string) => {
    mocks.storeAuthState.mockClear();
    await start(`${SIGN_IN}&${query}`, env());
    return stateArg().redirectUri;
  };

  it('looks the client up and refuses a disabled one', async () => {
    mocks.findByClientId.mockResolvedValue({ enabled: false });
    const response = await start(SIGN_IN, env());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_client' });
    expect(mocks.findByClientId).toHaveBeenCalledWith('client-a');
    nothingStarted();
  });

  it('survives a failing client lookup and falls back to the default redirect', async () => {
    mocks.findByClientId.mockRejectedValue(new Error('db'));
    expect((await start(SIGN_IN, env())).status).toBe(302);
    expect(stateArg().redirectUri).toBe('https://login.example.com/');
  });

  it('defaults to the UI base URL root', async () => {
    expect(await redirectOf('')).toBe('https://login.example.com/');
  });

  it('accepts allow-listed paths on the UI and issuer origins and keeps the query', async () => {
    for (const path of ['/', '/callback', '/consent', '/reauth', '/device', '/ciba']) {
      mocks.storeAuthState.mockClear();
      expect(
        await redirectOf(
          `redirect_uri=${encodeURIComponent(`https://login.example.com${path}?x=1`)}`
        )
      ).toBe(`https://login.example.com${path}?x=1`);
    }
    expect(
      await redirectOf(`redirect_uri=${encodeURIComponent('https://auth.example.com/callback')}`)
    ).toBe('https://auth.example.com/callback');
  });

  it('resolves a relative path against the UI base URL', async () => {
    expect(await redirectOf('redirect_uri=%2Fcallback%3Fa%3D1')).toBe(
      'https://login.example.com/callback?a=1'
    );
    expect(await redirectOf('redirect_uri=%2Fevil')).toBe('https://login.example.com/');
  });

  it('rejects other paths, foreign origins, malformed values and a subdomain trick', async () => {
    for (const bad of [
      'https://login.example.com/admin',
      'https://login.example.com/callback/',
      'https://evil.example/callback',
      'https://login.example.com.evil.example/callback',
      'http://login.example.com/callback',
      'not a url',
    ]) {
      mocks.storeAuthState.mockClear();
      expect(await redirectOf(`redirect_uri=${encodeURIComponent(bad)}`)).toBe(
        'https://login.example.com/'
      );
    }
  });

  it('accepts additional origins from ALLOWED_ORIGINS, ignoring invalid entries', async () => {
    const withOrigins = makeEnv(makeKv(), { ALLOWED_ORIGINS: ' https://app.example , ,garbage,' });
    await start(
      `${SIGN_IN}&redirect_uri=${encodeURIComponent('https://app.example/callback')}`,
      withOrigins
    );
    expect(stateArg().redirectUri).toBe('https://app.example/callback');
    mocks.storeAuthState.mockClear();
    await start(
      `${SIGN_IN}&redirect_uri=${encodeURIComponent('https://app.example/other')}`,
      withOrigins
    );
    expect(stateArg().redirectUri).toBe('https://login.example.com/');
  });

  it.each([
    ['a JSON array string', '["https://login.example.com/app-cb","https://login.example.com/x"]'],
    ['a plain string', 'https://login.example.com/app-cb'],
    ['an array', ['https://login.example.com/app-cb']],
  ])("accepts a client's registered redirect_uri (%s)", async (_name, redirectUris) => {
    mocks.findByClientId.mockResolvedValue({ enabled: true, redirect_uris: redirectUris });
    expect(
      await redirectOf(
        `redirect_uri=${encodeURIComponent('https://login.example.com/app-cb?extra=1')}`
      )
    ).toBe('https://login.example.com/app-cb?extra=1');
  });

  it('ignores invalid registered entries and unregistered paths', async () => {
    mocks.findByClientId.mockResolvedValue({
      enabled: true,
      redirect_uris: ['::bad::', 'https://login.example.com/app-cb'],
    });
    expect(
      await redirectOf(`redirect_uri=${encodeURIComponent('https://login.example.com/other')}`)
    ).toBe('https://login.example.com/');
  });

  it('keeps a client with no redirect_uris on the default allow-list', async () => {
    mocks.findByClientId.mockResolvedValue({ enabled: true, redirect_uris: [] });
    expect(
      await redirectOf(`redirect_uri=${encodeURIComponent('https://login.example.com/callback')}`)
    ).toBe('https://login.example.com/callback');
  });
});

describe('invitation', () => {
  const env = () => makeEnv(makeKv());

  it('reserves the invitation and stores it with the state', async () => {
    mocks.reserveInvitation.mockResolvedValue({ invitationId: 'inv-1', invitationUses: 1 });
    await start(`${SIGN_IN}&invite_token=tok-123`, env());
    expect(mocks.reserveInvitation).toHaveBeenCalledWith(expect.anything(), {
      token: 'tok-123',
      tenantId: 'default',
      flowId: stateArg().flowId,
    });
    expect(stateArg()).toMatchObject({ invitationId: 'inv-1', invitationUses: 1 });
  });

  it('rejects an empty or oversized token without reserving', async () => {
    for (const token of ['', 'x'.repeat(513)]) {
      const response = await start(`${SIGN_IN}&invite_token=${token}`, env());
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        error_description: 'invite_token is invalid',
      });
    }
    expect(mocks.reserveInvitation).not.toHaveBeenCalled();
    mocks.reserveInvitation.mockResolvedValue({ invitationId: 'i' });
    expect((await start(`${SIGN_IN}&invite_token=${'x'.repeat(512)}`, env())).status).toBe(302);
  });

  it('answers 404 when no use is left', async () => {
    mocks.reserveInvitation.mockResolvedValue(null);
    const response = await start(`${SIGN_IN}&invite_token=tok`, env());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'The invitation is invalid, expired, or has no use left',
    });
    nothingStarted();
  });

  it('does not reserve for a silent sign-in', async () => {
    await start(`${SIGN_IN}&invite_token=tok&prompt=none`, env());
    expect(mocks.reserveInvitation).not.toHaveBeenCalled();
  });
});

describe('re-authentication and interaction', () => {
  const env = () => makeEnv(makeKv());

  it('rejects an invalid or expired authorization challenge', async () => {
    mocks.challengeKind.mockResolvedValue(null);
    const response = await start(`${SIGN_IN}&authorization_challenge_id=ch-1`, env());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Authorization challenge is invalid or expired',
    });
    expect(mocks.challengeKind).toHaveBeenCalledWith(expect.anything(), 'default', 'ch-1');
    nothingStarted();
  });

  it('records a sign-in challenge on the state', async () => {
    await start(`${SIGN_IN}&authorization_challenge_id=ch-1`, env());
    expect(stateArg().flowChallengeId).toBe('ch-1');
    expect(stateArg()).not.toHaveProperty('reauthChallengeId');
  });

  it('forces a fresh login for a re-authentication that the provider allows', async () => {
    mocks.challengeKind.mockResolvedValue('reauth');
    mocks.reauthPolicy.mockResolvedValue({ reauthEnabled: true });
    await start(`${SIGN_IN}&authorization_challenge_id=re-1&prompt=none&max_age=900`, env());
    expect(mocks.reauthPolicy).toHaveBeenCalledWith(expect.anything(), 'default', {
      providerId: 'provider-a',
      ids: ['provider-a', 'corp'],
    });
    expect(stateArg()).toMatchObject({
      prompt: 'login',
      maxAge: 0,
      reauthChallengeId: 're-1',
      reauthRequestedAt: T0,
      flowChallengeId: 're-1',
    });
    expect(mocks.usageGate).not.toHaveBeenCalled();
    expect(argRec(mocks.verifyHuman, 0, 1).action).toBe('login');
  });

  it('only filters the id list when the provider has no slug', async () => {
    mocks.challengeKind.mockResolvedValue('reauth');
    mocks.reauthPolicy.mockResolvedValue({ reauthEnabled: true });
    mocks.getProvider.mockResolvedValue({ ...baseProvider, slug: undefined });
    await start(`${SIGN_IN}&authorization_challenge_id=re-1`, env());
    expect(argRec(mocks.reauthPolicy, 0, 2).ids).toEqual(['provider-a']);
  });

  it('refuses a re-authentication for a non-OIDC provider without reading the policy', async () => {
    mocks.challengeKind.mockResolvedValue('reauth');
    mocks.getProvider.mockResolvedValue({ ...baseProvider, providerType: 'oauth2' });
    const response = await start(`${SIGN_IN}&authorization_challenge_id=re-1`, env());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'access_denied',
      error_description: 'This provider cannot be used to re-authenticate',
    });
    expect(mocks.reauthPolicy).not.toHaveBeenCalled();
  });

  it('refuses when the tenant turned re-authentication off, and 503s when unreadable', async () => {
    mocks.challengeKind.mockResolvedValue('reauth');
    mocks.reauthPolicy.mockResolvedValue({ reauthEnabled: false });
    expect((await start(`${SIGN_IN}&authorization_challenge_id=re-1`, env())).status).toBe(403);
    mocks.reauthPolicy.mockRejectedValue(new Error('kv'));
    const response = await start(`${SIGN_IN}&authorization_challenge_id=re-1`, env());
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Re-authentication settings are unavailable',
    });
    nothingStarted();
  });

  it('resolves a live interaction and records it', async () => {
    mocks.resolveInteraction.mockResolvedValue('int-1');
    await start(`${SIGN_IN}&runtime_interaction_id=int-1`, env());
    expect(mocks.resolveInteraction).toHaveBeenCalledWith(mocks.coreAdapter, {
      tenantId: 'default',
      interactionId: 'int-1',
    });
    expect(stateArg().attemptInteractionId).toBe('int-1');
    expect(mocks.assertInteraction).not.toHaveBeenCalled();
  });

  it('leaves out an interaction that is not live', async () => {
    mocks.resolveInteraction.mockResolvedValue(null);
    await start(`${SIGN_IN}&runtime_interaction_id=int-1`, env());
    expect(stateArg()).not.toHaveProperty('attemptInteractionId');
  });

  it('answers 503 when the interaction cannot be checked', async () => {
    mocks.resolveInteraction.mockRejectedValue(new Error('db'));
    const response = await start(`${SIGN_IN}&runtime_interaction_id=int-1`, env());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'The sign-in flow is unavailable.',
    });
    nothingStarted();
  });

  it('checks the interaction answers the challenge, refusing a mismatch with 403', async () => {
    mocks.resolveInteraction.mockResolvedValue('int-1');
    await start(`${SIGN_IN}&runtime_interaction_id=int-1&authorization_challenge_id=ch-1`, env());
    expect(mocks.assertInteraction).toHaveBeenCalledWith(
      mocks.coreAdapter,
      'default',
      'int-1',
      'ch-1'
    );
    expect(stateArg()).toMatchObject({ attemptInteractionId: 'int-1', flowChallengeId: 'ch-1' });

    const mismatch = new Error('mismatch');
    mocks.assertInteraction.mockRejectedValue(mismatch);
    mocks.isMismatch.mockImplementation((error: unknown) => error === mismatch);
    const denied = await start(
      `${SIGN_IN}&runtime_interaction_id=int-1&authorization_challenge_id=ch-1`,
      env()
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'authorization_challenge_mismatch',
      error_description: 'The sign-in was not started for this authorization request.',
    });
    mocks.assertInteraction.mockRejectedValue(new Error('db'));
    const unavailable = await start(
      `${SIGN_IN}&runtime_interaction_id=int-1&authorization_challenge_id=ch-1`,
      env()
    );
    expect(unavailable.status).toBe(503);
  });
});

describe('the state that is stored and the redirect that is returned', () => {
  it('stores the full sign-in state and redirects to the provider with the bound cookie', async () => {
    const response = await start(
      `${SIGN_IN}&redirect_uri=${encodeURIComponent('https://login.example.com/callback')}&login_hint=a%40b.example&acr_values=urn%3Aacr&prompt=consent&state=client-state`,
      makeEnv(makeKv())
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(IDP_AUTHORIZE);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Authrim-Diagnostic-Flow-Id')).toBe(stateArg().flowId);
    expect(stateArg().flowId).toMatch(/^[0-9a-f-]{36}$/);
    const { flowId, expiresAt, ...rest } = stateArg();
    expect(typeof expiresAt).toBe('number');
    expect(rest).toEqual({
      tenantId: 'default',
      clientId: 'client-a',
      providerId: 'provider-a',
      state: FIXED_STATE,
      nonce: FIXED_NONCE,
      codeVerifier: 'ext-verifier',
      codeChallenge: 'abc',
      redirectUri: 'https://login.example.com/callback',
      userId: undefined,
      sessionId: undefined,
      maxAge: undefined,
      acrValues: 'urn:acr',
      prompt: 'consent',
      enableSso: true,
    });
    expect(flowId).toBeTruthy();

    const { getAuthStateCookieName } = await import('../utils/state');
    const cookie = must(response.headers.get('Set-Cookie'));
    expect(cookie).toContain(`${await getAuthStateCookieName(FIXED_STATE)}=${FIXED_STATE}`);
    expect(cookie).toContain('Path=/auth/external/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Max-Age=600');
  });

  it('uses a lax non-secure cookie on an http issuer, and no sso when the provider disables it', async () => {
    mocks.getProvider.mockResolvedValue({ ...baseProvider, enableSso: false });
    const response = await start(
      SIGN_IN,
      makeEnv(makeKv(), { ISSUER_URL: 'http://localhost:8787' })
    );
    const cookie = must(response.headers.get('Set-Cookie'));
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(stateArg().enableSso).toBe(false);
  });

  it('passes the callback URL, secret and options to the OIDC client', async () => {
    mocks.getProvider.mockResolvedValue({
      ...baseProvider,
      useRequestObject: true,
      privateKeyJwkEncrypted: 'enc-key',
    });
    const { decrypt } = await import('../utils/crypto');
    vi.mocked(decrypt).mockImplementation(async (value: string) =>
      value === 'enc-key' ? '{"kty":"EC"}' : 'upstream-secret'
    );
    await start(`${SIGN_IN}&login_hint=h&max_age=30&acr_values=a&prompt=login`, makeEnv(makeKv()));
    expect(vi.mocked(decrypt)).toHaveBeenCalledWith('encrypted-secret', 'encryption-key');
    expect(mocks.fromProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'provider-a' }),
      'https://auth.example.com/auth/external/corp/callback',
      'upstream-secret',
      { kty: 'EC' }
    );
    expect(mocks.createAuthorizationUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        state: FIXED_STATE,
        nonce: FIXED_NONCE,
        codeVerifier: 'ext-verifier',
        prompt: 'login',
        loginHint: 'h',
        maxAge: 30,
        acrValues: 'a',
        responseType: 'code',
        responseMode: undefined,
        requestUri: undefined,
      })
    );
    vi.mocked(decrypt).mockReset().mockResolvedValue('upstream-secret');
  });

  it('does not decrypt a private key unless request objects are on', async () => {
    mocks.getProvider.mockResolvedValue({
      ...baseProvider,
      useRequestObject: false,
      privateKeyJwkEncrypted: 'enc-key',
    });
    await start(SIGN_IN, makeEnv(makeKv()));
    expect(mocks.fromProvider.mock.calls[0]?.[3]).toBeUndefined();
  });

  it('uses the provider id in the callback URL when it has no slug', async () => {
    mocks.getProvider.mockResolvedValue({ ...baseProvider, slug: undefined });
    await start(SIGN_IN, makeEnv(makeKv()));
    expect(mocks.fromProvider.mock.calls[0]?.[1]).toBe(
      'https://auth.example.com/auth/external/provider-a/callback'
    );
  });

  it('requests a code id_token only when the provider is configured for it', async () => {
    mocks.getProvider.mockResolvedValue({
      ...baseProvider,
      providerQuirks: { responseType: 'code id_token' },
    });
    await start(SIGN_IN, makeEnv(makeKv()));
    expect(argRec(mocks.createAuthorizationUrl, 0, 0).responseType).toBe('code id_token');
    mocks.getProvider.mockResolvedValue({
      ...baseProvider,
      providerQuirks: { responseType: 'id_token' },
    });
    await start(SIGN_IN, makeEnv(makeKv()));
    expect(argRec(mocks.createAuthorizationUrl, 1, 0).responseType).toBe('code');
  });

  it('turns an authorization-url failure into the generic 500', async () => {
    mocks.createAuthorizationUrl.mockRejectedValue(new Error('discovery failed'));
    const response = await start(SIGN_IN, makeEnv(makeKv()));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: 'Failed to start external login',
    });
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('fails when the encryption key is missing', async () => {
    const crypto = await import('../utils/crypto');
    vi.mocked(crypto.getEncryptionKeyOrUndefined).mockReturnValueOnce(undefined);
    const response = await start(SIGN_IN, makeEnv(makeKv(), { ENABLE_CONFORMANCE_MODE: 'true' }));
    expect(response.status).toBe(500);
    expect(rec(await response.json()).error_description).toBe(
      'Failed to start external login: RP_TOKEN_ENCRYPTION_KEY is not configured'
    );
  });
});
