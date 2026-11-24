/**
 * External callback: linking from the account page, and the proof a re-authentication needs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { argRec } from './helpers/mock-args';
import {
  M,
  REQUEST_CONTEXT,
  T0,
  TOKENS,
  ready,
  setupCallbackMocks,
} from './helpers/callback-mocks';
import { ExternalIdPError, ExternalIdPErrorCode } from '../types';
import { provenUpstreamReauthentication } from '../handlers/callback';
import {
  ENV,
  authState,
  callback,
  locationOf,
  oauthProvider,
  oidcProvider,
  paramsOf,
} from './helpers/callback-harness';

beforeEach(setupCallbackMocks);

const linkState = (overrides = {}) =>
  authState({ userId: 'user-1', sessionId: 'sess-1', enableSso: true, ...overrides });
const account = (overrides = {}) => ({ sessionId: 'sess-1', userId: 'user-1', ...overrides });
const linked = () => ({ social_link: 'linked' });
const failed = (reason: string) => ({ social_link: 'error', reason });

describe('linking an external account', () => {
  beforeEach(() => {
    M.consumeAuthState.mockResolvedValue(linkState());
    M.readAccountSession.mockResolvedValue(account());
    M.handleIdentity.mockResolvedValue(ready({ userId: 'user-1', linkedIdentityId: 'li-9' }));
  });

  it('links to the account that asked, signs nobody in and returns to the account page', async () => {
    const response = await callback();
    expect(response.status).toBe(302);
    const location = locationOf(response);
    expect(location.origin + location.pathname).toBe('https://login.example.com/account');
    expect(paramsOf(response)).toEqual(linked());
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(M.readAccountSession).toHaveBeenCalledWith(ENV, 'default', 'sess-1');
    expect(M.handleIdentity).toHaveBeenCalledTimes(1);
    expect(M.handleIdentity).toHaveBeenCalledWith(ENV, {
      provider: oauthProvider,
      userInfo: { sub: 'ext-sub', email: 'new@example.com', name: 'New Person' },
      upstreamClaims: undefined,
      tokens: TOKENS,
      linkingUserId: 'user-1',
      tenantId: 'default',
    });
    expect(M.recordActivity).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'account.social_account.linked',
      { linkedIdentityId: 'li-9', providerId: 'provider-a' }
    );
    expect(M.createSession).not.toHaveBeenCalled();
    expect(M.getSessionStore).not.toHaveBeenCalled();
    expect(response.headers.get('Set-Cookie')).not.toContain('authrim_session');
    expect(M.usageGate).not.toHaveBeenCalled();
  });

  it('passes the upstream claims through when an inbound mapping applied', async () => {
    M.inbound.mockResolvedValue({ userInfo: { sub: 'mapped' }, customClaims: { a: 1 } });
    await callback();
    expect(argRec(M.handleIdentity, 0, 1)).toMatchObject({
      userInfo: { sub: 'mapped' },
      upstreamClaims: { sub: 'ext-sub', email: 'new@example.com', name: 'New Person' },
    });
  });

  it('adds the tenant hint to the account page for a non-default tenant', async () => {
    M.consumeAuthState.mockResolvedValue(linkState({ tenantId: 'acme' }));
    const response = await callback();
    expect(paramsOf(response)).toEqual({ ...linked(), tenant_hint: 'acme' });
    expect(M.readAccountSession).toHaveBeenCalledWith(ENV, 'acme', 'sess-1');
  });

  it('reports an expired session when the account session is gone or belongs to someone else', async () => {
    M.readAccountSession.mockResolvedValue(null);
    expect(paramsOf(await callback())).toEqual(failed('session_expired'));
    M.readAccountSession.mockResolvedValue(account({ userId: 'user-2' }));
    expect(paramsOf(await callback())).toEqual(failed('session_expired'));
    M.consumeAuthState.mockResolvedValue(linkState({ sessionId: undefined }));
    M.readAccountSession.mockClear();
    expect(paramsOf(await callback())).toEqual(failed('session_expired'));
    expect(M.readAccountSession).not.toHaveBeenCalled();
    expect(M.handleIdentity).not.toHaveBeenCalled();
  });

  describe('the browser that brings the answer back', () => {
    const cookie = (value: string) => ({ Cookie: `authrim_session=${value}` });

    it('accepts the same session and user', async () => {
      const response = await callback({ headers: cookie('sess-1') });
      expect(paramsOf(response)).toEqual(linked());
      expect(M.readAccountSession).toHaveBeenCalledTimes(2);
      expect(M.readAccountSession).toHaveBeenLastCalledWith(ENV, 'default', 'sess-1');
    });

    it('finds the session cookie after a semicolon without a space, and ignores lookalike names', async () => {
      expect(
        paramsOf(await callback({ headers: { Cookie: 'a=1;authrim_session=sess-1' } }))
      ).toEqual(linked());
      M.readAccountSession.mockClear();
      expect(paramsOf(await callback({ headers: { Cookie: 'xauthrim_session=other' } }))).toEqual(
        linked()
      );
      expect(M.readAccountSession).toHaveBeenCalledTimes(1);
    });

    it('decodes a percent-encoded cookie value', async () => {
      M.consumeAuthState.mockResolvedValue(linkState({ sessionId: 'sess/1' }));
      M.readAccountSession.mockResolvedValue(account({ sessionId: 'sess/1' }));
      const response = await callback({ headers: cookie('sess%2F1') });
      expect(paramsOf(response)).toEqual(linked());
      expect(M.readAccountSession).toHaveBeenLastCalledWith(ENV, 'default', 'sess/1');
    });

    it('refuses a browser signed in as another session or another user', async () => {
      M.readAccountSession.mockImplementation(async (_env: unknown, _t: unknown, id: string) =>
        id === 'sess-1' ? account() : account({ sessionId: 'other' })
      );
      expect(paramsOf(await callback({ headers: cookie('other') }))).toEqual(
        failed('session_expired')
      );
      M.readAccountSession.mockImplementation(async (_env: unknown, _t: unknown, id: string) =>
        id === 'sess-1' ? account() : account({ userId: 'user-2' })
      );
      expect(paramsOf(await callback({ headers: cookie('other') }))).toEqual(
        failed('session_expired')
      );
      expect(M.handleIdentity).not.toHaveBeenCalled();
    });

    it('refuses a browser session that cannot be read or decoded, or is gone', async () => {
      M.readAccountSession.mockImplementation(async (_env: unknown, _t: unknown, id: string) => {
        if (id === 'sess-1') return account();
        throw new Error('store down');
      });
      expect(paramsOf(await callback({ headers: cookie('x') }))).toEqual(failed('session_expired'));
      M.readAccountSession.mockResolvedValueOnce(account()).mockResolvedValueOnce(null);
      expect(paramsOf(await callback({ headers: cookie('x') }))).toEqual(failed('session_expired'));
      M.readAccountSession.mockReset();
      M.readAccountSession.mockResolvedValue(account());
      M.readAccountSession.mockClear();
      expect(paramsOf(await callback({ headers: cookie('%E0%A4%A') }))).toEqual(
        failed('session_expired')
      );
      expect(M.readAccountSession).toHaveBeenCalledTimes(1);
    });
  });

  it('fails the link when identity resolution did not complete for this account', async () => {
    for (const result of [
      ready({ status: 'pending', userId: 'user-1', linkedIdentityId: 'li' }),
      ready({ userId: 'user-2', linkedIdentityId: 'li' }),
      ready({ userId: 'user-1', linkedIdentityId: undefined }),
    ]) {
      M.handleIdentity.mockResolvedValue(result);
      expect(paramsOf(await callback())).toEqual(failed('failed'));
    }
    expect(M.recordActivity).not.toHaveBeenCalled();
  });

  it('names an already-linked or unverified-email failure on the account page', async () => {
    M.handleIdentity.mockRejectedValue(
      new ExternalIdPError(ExternalIdPErrorCode.ACCOUNT_ALREADY_LINKED, 'x')
    );
    expect(paramsOf(await callback())).toEqual(failed('already_linked'));
    M.handleIdentity.mockRejectedValue(
      new ExternalIdPError(ExternalIdPErrorCode.EMAIL_NOT_VERIFIED, 'x')
    );
    expect(paramsOf(await callback())).toEqual(failed('email_not_verified'));
    M.handleIdentity.mockRejectedValue(
      new ExternalIdPError(ExternalIdPErrorCode.NO_ACCOUNT_FOUND, 'x')
    );
    expect(paramsOf(await callback())).toEqual(failed('failed'));
    M.handleIdentity.mockRejectedValue(new Error('boom'));
    expect(paramsOf(await callback())).toEqual(failed('failed'));
  });

  it('fails a link whose provider returned no subject', async () => {
    M.fetchUserInfo.mockResolvedValue({
      userInfo: { email: 'x' },
      endpoint: 'e',
      signedResponse: false,
    });
    expect(paramsOf(await callback())).toEqual(failed('failed'));
    expect(M.handleIdentity).not.toHaveBeenCalled();
  });
});

describe('a re-authentication through an OIDC provider', () => {
  const requestedAt = T0 - 5_000;
  beforeEach(() => {
    M.getProvider.mockResolvedValue(oidcProvider);
    M.consumeAuthState.mockResolvedValue(
      authState({ enableSso: true, reauthRequestedAt: requestedAt })
    );
    M.exchangeCode.mockResolvedValue({
      tokens: { ...TOKENS, id_token: 'id.token.jwt' },
      requestContext: REQUEST_CONTEXT,
    });
    M.reauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: false });
  });

  it('completes with the proof stamped at the time the login was asked for', async () => {
    M.validateIdToken.mockResolvedValue({
      sub: 'ext-sub',
      auth_time: Math.floor(T0 / 1000),
      acr: 'urn:acr:1',
    });
    const response = await callback();
    expect(response.status).toBe(302);
    expect(M.handleIdentity.mock.calls[0]?.[1]).toMatchObject({ reauthentication: true });
    expect(M.createSession.mock.calls[0]?.[3]).toMatchObject({
      reauth_proven_amr: ['external_idp'],
      reauth_proven_at: requestedAt,
      upstream_acr: 'urn:acr:1',
    });
  });

  it('refuses an id_token that is not dated after the request', async () => {
    M.validateIdToken.mockResolvedValue({
      sub: 'ext-sub',
      auth_time: Math.floor(T0 / 1000) - 3600,
    });
    const response = await callback();
    expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.REAUTH_NOT_PROVEN);
    expect(M.handleIdentity).not.toHaveBeenCalled();
  });

  it('ignores a non-finite auth_time and then needs the provider to be trusted without one', async () => {
    M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', auth_time: 'yesterday' });
    expect(paramsOf(await callback()).error).toBe(ExternalIdPErrorCode.REAUTH_NOT_PROVEN);
    M.reauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: true });
    expect((await callback()).status).toBe(302);
  });

  it('does not take a NaN auth_time as a date', async () => {
    M.validateIdToken.mockResolvedValue({ sub: 'ext-sub', auth_time: Number.NaN });
    expect(paramsOf(await callback()).error).toBe(ExternalIdPErrorCode.REAUTH_NOT_PROVEN);
  });

  it('is refused outright when the provider returns no id_token', async () => {
    M.exchangeCode.mockResolvedValue({ tokens: TOKENS, requestContext: REQUEST_CONTEXT });
    const response = await callback();
    expect(paramsOf(response).error).toBe(ExternalIdPErrorCode.CALLBACK_FAILED);
    expect(M.reauthPolicy).not.toHaveBeenCalled();
    expect(M.handleIdentity).not.toHaveBeenCalled();
  });
});

describe('provenUpstreamReauthentication', () => {
  const requestedAt = 1_800_000_000_000;
  const input = (overrides: Record<string, unknown> = {}) => ({
    tenantId: 'tenant-1',
    provider: oidcProvider,
    requestedAt,
    idTokenValidated: true,
    idTokenAuthTime: Math.floor(requestedAt / 1000),
    ...overrides,
  });
  const run = (overrides: Record<string, unknown> = {}) =>
    provenUpstreamReauthentication(ENV, input(overrides));
  const rejection = async (overrides: Record<string, unknown>) => {
    const error = await run(overrides).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ExternalIdPError);
    expect((error as ExternalIdPError).code).toBe(ExternalIdPErrorCode.REAUTH_NOT_PROVEN);
    return (error as ExternalIdPError).message;
  };

  beforeEach(() => M.reauthPolicy.mockResolvedValue({ reauthEnabled: true }));

  it('requires a validated id_token before reading any policy', async () => {
    expect(await rejection({ idTokenValidated: false })).toBe(
      'No validated ID token dates the new login'
    );
    expect(M.reauthPolicy).not.toHaveBeenCalled();
  });

  it('reads the provider policy by id and slug', async () => {
    await run();
    expect(M.reauthPolicy).toHaveBeenCalledWith(ENV, 'tenant-1', {
      providerId: 'provider-a',
      ids: ['provider-a', 'corp'],
    });
    await run({ provider: { ...oidcProvider, slug: undefined } });
    expect(M.reauthPolicy).toHaveBeenLastCalledWith(ENV, 'tenant-1', {
      providerId: 'provider-a',
      ids: ['provider-a'],
    });
  });

  it('refuses when the policy cannot be read or turns re-authentication off', async () => {
    M.reauthPolicy.mockRejectedValue(new Error('kv'));
    expect(await rejection({})).toBe('Re-authentication settings are unavailable');
    M.reauthPolicy.mockResolvedValue({ reauthEnabled: false });
    expect(await rejection({})).toBe('This provider cannot be used to re-authenticate');
  });

  it('allows the provider clock to lag by exactly 60 seconds and no more', async () => {
    const seconds = Math.floor(requestedAt / 1000);
    expect(await run({ idTokenAuthTime: seconds - 60 })).toBe(requestedAt);
    expect(await rejection({ idTokenAuthTime: seconds - 61 })).toBe(
      'The provider answered with a login made before it was asked for one'
    );
    expect(await run({ idTokenAuthTime: seconds + 3600 })).toBe(requestedAt);
  });

  it('floors the request time to seconds before comparing', async () => {
    const odd = 1_800_000_000_999;
    const seconds = Math.floor(odd / 1000);
    expect(await run({ requestedAt: odd, idTokenAuthTime: seconds - 60 })).toBe(odd);
    expect(await rejection({ requestedAt: odd, idTokenAuthTime: seconds - 61 })).toContain(
      'before'
    );
  });

  it('treats auth_time 0 as a real date, which is too old', async () => {
    expect(await rejection({ idTokenAuthTime: 0 })).toContain('before');
  });

  it('needs the provider to be trusted without auth_time', async () => {
    expect(await rejection({ idTokenAuthTime: undefined })).toBe(
      'The provider did not date the new login'
    );
    M.reauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: true });
    expect(await run({ idTokenAuthTime: undefined })).toBe(requestedAt);
  });
});
