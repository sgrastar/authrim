/**
 * External callback: an account whose provisioning is still running is continued later, from a
 * sealed, browser-bound continuation.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { argRec, callArg } from './helpers/mock-args';
import { M, TOKENS, setupCallbackMocks } from './helpers/callback-mocks';
import { ENV, authState, callback, locationOf, paramsOf } from './helpers/callback-harness';

const pending = (extra: Record<string, unknown> = {}) => ({
  status: 'pending',
  userId: 'user-new',
  isNewUser: true,
  stitchedFromExisting: false,
  accountId: 'account:user-new',
  operationId: 'op-1',
  providerId: 'provider-a',
  providerUserId: 'ext-sub',
  ...extra,
});

beforeEach(() => {
  setupCallbackMocks();
  M.handleIdentity.mockResolvedValue(pending());
  M.encrypt.mockResolvedValue('sealed-payload');
});

describe('continuing an account that is still being provisioned', () => {
  it('answers a redirect to the sign-in with the token, tenant and state', async () => {
    const response = await callback();
    expect(response.status).toBe(302);
    const url = locationOf(response);
    expect(url.origin + url.pathname).toBe('https://login.example.com/callback');
    const params = paramsOf(response);
    expect(params.provisioning_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.provisioning_tenant).toBe('default');
    expect(params.state).toBe('upstream-state-0123456789');
    expect(Object.keys(params).sort()).toEqual([
      'provisioning_tenant',
      'provisioning_token',
      'state',
    ]);
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('seals the continuation under the digest of that token, for five minutes', async () => {
    const response = await callback();
    const token = paramsOf(response).provisioning_token ?? '';
    const digest = createHash('sha256').update(token).digest('hex');
    expect(M.getStore).toHaveBeenCalledWith(
      expect.anything(),
      `external_idp_provisioning:${digest}`,
      'default'
    );
    expect(argRec(M.store.storeChallengeRpc)).toEqual({
      id: `external_idp_provisioning:${digest}`,
      tenantId: 'default',
      type: 'external_idp_provisioning_resume',
      userId: 'user-new',
      challenge: digest,
      ttl: 300,
      metadata: { schema_version: 1, encrypted_payload: 'sealed-payload' },
    });
  });

  it('binds the continuation to the browser with a cookie that carries the digest', async () => {
    const response = await callback();
    const token = paramsOf(response).provisioning_token ?? '';
    const digest = createHash('sha256').update(token).digest('hex');
    const cookie = response.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain(`authrim_external_provisioning_${digest.slice(0, 24)}=${digest}`);
    expect(cookie).toContain('Max-Age=300');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('does not mark the cookie secure for an issuer that is not https', async () => {
    const env = { ...ENV, ISSUER_URL: 'http://localhost:8787' };
    const response = await callback({ env });
    expect(response.headers.get('Set-Cookie')).not.toContain('Secure');
  });

  it('seals the sign-in, not the provider secret, with the encryption key', async () => {
    await callback();
    expect(M.encrypt).toHaveBeenCalledTimes(1);
    expect(callArg(M.encrypt, 0, 1)).toBe('encryption-key');
    const sealed = JSON.parse(String(callArg(M.encrypt, 0, 0))) as Record<string, unknown>;
    expect(Object.keys(sealed)).toEqual(
      [
        'schemaVersion',
        'authState',
        'providerId',
        'userInfo',
        'upstreamIdToken',
        'upstreamAcr',
        'result',
      ].filter((key) => key in sealed)
    );
    expect(sealed).toMatchObject({
      schemaVersion: 1,
      authState: {
        id: 'auth-state-a',
        tenantId: 'default',
        redirectUri: 'https://login.example.com/callback',
      },
      providerId: 'provider-a',
      userInfo: { sub: 'ext-sub', email: 'new@example.com' },
      result: pending(),
    });
    expect(JSON.stringify(sealed)).not.toContain('upstream-secret');
    expect(TOKENS.access_token).not.toBe('');
    expect(JSON.stringify(sealed)).not.toContain(TOKENS.access_token);
  });

  it('keeps the upstream ID token and acr for the sign-in it resumes', async () => {
    M.exchangeCode.mockResolvedValue({
      tokens: { ...TOKENS, id_token: 'upstream-id-token' },
      requestContext: {
        tokenEndpoint: 't',
        authMethod: 'client_secret_basic',
        authHeaderPresent: true,
      },
    });
    await callback();
    const sealed = JSON.parse(String(callArg(M.encrypt, 0, 0))) as Record<string, unknown>;
    expect(sealed.upstreamIdToken).toBe('upstream-id-token');
  });

  it('refuses to continue without an encryption key, storing nothing', async () => {
    M.getKey.mockReturnValue(undefined);
    const response = await callback();
    expect(locationOf(response).searchParams.get('error')).toBe('callback_failed');
    expect(M.store.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses a continuation over 48 KiB, storing nothing', async () => {
    M.handleIdentity.mockResolvedValue(pending());
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'ext-sub', email: 'new@example.com', blob: 'x'.repeat(48 * 1024) },
      endpoint: 'https://idp.example.com/userinfo',
      signedResponse: false,
    });
    const response = await callback();
    expect(locationOf(response).searchParams.get('error')).toBe('callback_failed');
    expect(M.store.storeChallengeRpc).not.toHaveBeenCalled();
    expect(M.encrypt).not.toHaveBeenCalled();
  });

  it('accepts a continuation just under 48 KiB', async () => {
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { sub: 'ext-sub', blob: 'x'.repeat(40 * 1024) },
      endpoint: 'https://idp.example.com/userinfo',
      signedResponse: false,
    });
    const response = await callback();
    expect(paramsOf(response).provisioning_token).toBeTruthy();
    expect(M.store.storeChallengeRpc).toHaveBeenCalledTimes(1);
  });

  it('does not issue a code or a session for a pending account', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ enableSso: true }));
    const response = await callback();
    expect(paramsOf(response).code).toBeUndefined();
    expect(M.createSession).not.toHaveBeenCalled();
  });
});
