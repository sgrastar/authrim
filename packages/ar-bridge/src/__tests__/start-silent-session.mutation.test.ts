/**
 * External start: a silent sign-in (prompt=none) answers from the browser's own session cookie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mocks, setupStartMocks } from './helpers/start-mocks';
import { argRec, callArg, rec } from './helpers/mock-args';
import {
  FIXED_STATE,
  SIGN_IN,
  baseProvider,
  makeEnv,
  makeKv,
  must,
  start,
} from './helpers/start-harness';

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const NOW_S = Math.floor(T0 / 1000);
const liveSession = (overrides: Record<string, unknown> = {}) => ({
  id: '0_sess-1',
  userId: 'user-1',
  tenantId: 'default',
  createdAt: T0 - 600_000,
  expiresAt: T0 + 3_600_000,
  data: { authTime: NOW_S - 100 },
  ...overrides,
});

beforeEach(() => {
  setupStartMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mocks.getSessionRpc.mockResolvedValue(liveSession());
});
afterEach(() => vi.useRealTimers());

const COOKIE = { Cookie: 'authrim_session=0_sess-1' };
const REDIRECT = 'https://login.example.com/callback';
const silent = (headers: Record<string, string> = COOKIE, extra = '&state=client-state') =>
  start(
    `${SIGN_IN}&prompt=none&redirect_uri=${encodeURIComponent(REDIRECT)}${extra}`,
    makeEnv(makeKv()),
    headers
  );
const params = (response: Response) =>
  Object.fromEntries(new URL(must(response.headers.get('Location'))).searchParams);

describe('without a usable session', () => {
  it.each([
    ['no cookie', {}],
    ['an unsharded session id', { Cookie: 'authrim_session=plain-session' }],
    ['an undecodable cookie', { Cookie: 'authrim_session=%E0%A4%A' }],
    ['a lookalike cookie name', { Cookie: 'xauthrim_session=0_sess-1' }],
  ])('answers login_required for %s, asking no session store', async (_name, headers) => {
    const response = await silent(headers);
    expect(response.status).toBe(302);
    expect(params(response)).toEqual({
      error: 'login_required',
      error_description: 'Authentication required',
      state: 'client-state',
    });
    expect(mocks.getSessionStore).not.toHaveBeenCalled();
    expect(mocks.consumeAuthState).not.toHaveBeenCalled();
  });

  it('answers login_required when the session is gone or expired, leaving the state unconsumed', async () => {
    mocks.getSessionRpc.mockResolvedValue(null);
    const response = await silent();
    expect(params(response)).toEqual({
      error: 'login_required',
      error_description: 'Authentication required',
      state: 'client-state',
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(callArg(mocks.getSessionStore, 0, 1)).toBe('0_sess-1');
    expect(callArg(mocks.getSessionStore, 0, 2)).toBe('default');
    expect(callArg(mocks.getSessionRpc, 0, 0)).toBe('0_sess-1');
    expect(mocks.consumeAuthState).not.toHaveBeenCalled();
  });

  it('keeps the session out of the stored state: only a link names one', async () => {
    await silent();
    expect(argRec(mocks.storeAuthState, 0, 1).sessionId).toBeUndefined();
    expect(argRec(mocks.storeAuthState, 0, 1).userId).toBeUndefined();
  });
});

describe('with a session', () => {
  it('refuses a request whose state cannot be consumed (replayed or expired)', async () => {
    mocks.consumeAuthState.mockResolvedValue(null);
    const response = await silent();
    expect(params(response)).toEqual({
      error: 'invalid_request',
      error_description: 'Authentication request expired',
      state: 'client-state',
    });
    expect(callArg(mocks.consumeAuthState, 0, 1)).toBe('default');
    // The internal state is what was stored, whatever the client called its own.
    expect(callArg(mocks.consumeAuthState, 0, 2)).toBe(FIXED_STATE);
    expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('hands over a 30 second handoff token when single sign-on is on', async () => {
    const response = await silent();
    expect(response.status).toBe(302);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const location = new URL(must(response.headers.get('Location')));
    expect(location.origin + location.pathname).toBe(REDIRECT);
    const token = must(location.searchParams.get('handoff_token'));
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(callArg(mocks.getChallengeStore, 0, 1)).toBe(token);
    const stored = argRec(mocks.storeChallengeRpc);
    const { metadata, ...rest } = stored;
    expect(rest).toEqual({
      id: `handoff:${token}`,
      tenantId: 'default',
      type: 'handoff',
      userId: 'user-1',
      challenge: '0_sess-1',
      ttl: 30,
    });
    expect(rec(metadata)).toMatchObject({
      client_id: 'client-a',
      state: 'client-state',
      aud: 'handoff',
    });
    expect(typeof rec(metadata).created_at).toBe('number');
    expect(response.headers.get('X-Authrim-Diagnostic-Flow-Id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('issues a one-use authorization code bound to the client challenge when the provider takes none', async () => {
    mocks.getProvider.mockResolvedValue({ ...baseProvider, enableSso: false });
    mocks.profileSso.mockResolvedValue(true);
    const response = await silent();
    expect(response.status).toBe(302);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const location = new URL(must(response.headers.get('Location')));
    expect(location.origin + location.pathname).toBe(REDIRECT);
    const code = must(location.searchParams.get('code'));
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.has('handoff_token')).toBe(false);
    const { metadata, ...rest } = argRec(mocks.storeChallengeRpc);
    expect(rest).toEqual({
      id: `direct_auth:${code}`,
      tenantId: 'default',
      type: 'direct_auth_code',
      userId: 'user-1',
      challenge: 'abc',
      ttl: 60,
    });
    expect(rec(metadata)).toMatchObject({
      method: 'silent_auth',
      provider: 'provider-a',
      provider_id: 'provider-a',
      provider_slug: 'corp',
      client_id: 'client-a',
      is_new_user: false,
      stitched_from_existing: false,
    });
  });

  it('names the provider id as the slug when it has none', async () => {
    mocks.getProvider.mockResolvedValue({ ...baseProvider, slug: undefined, enableSso: false });
    mocks.profileSso.mockResolvedValue(true);
    await silent();
    expect(rec(argRec(mocks.storeChallengeRpc).metadata).provider_slug).toBe('provider-a');
  });

  it('still answers SSO-disabled before looking at the session', async () => {
    mocks.profileSso.mockResolvedValue(false);
    const response = await silent();
    expect(params(response).error_description).toBe('SSO is disabled for this client');
    expect(mocks.getSessionStore).not.toHaveBeenCalled();
  });

  it('falls back to the internal state, in the redirect and the handoff, for a client that sent none', async () => {
    const response = await silent(COOKIE, '');
    expect(new URL(must(response.headers.get('Location'))).searchParams.get('state')).toBe(
      FIXED_STATE
    );
    expect(rec(argRec(mocks.storeChallengeRpc).metadata).state).toBe(FIXED_STATE);
  });

  it('answers errors without a state when the client sent none', async () => {
    mocks.getSessionRpc.mockResolvedValue(null);
    expect(params(await silent(COOKIE, ''))).toEqual({
      error: 'login_required',
      error_description: 'Authentication required',
    });
  });
});

describe('a session that cannot answer silently', () => {
  const refused = async (extra = '&state=client-state') => {
    const response = await silent(COOKIE, extra);
    expect(response.status).toBe(302);
    expect(params(response)).toEqual({
      error: 'login_required',
      error_description: 'Authentication required',
      ...(extra.includes('state=') ? { state: 'client-state' } : {}),
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.consumeAuthState).not.toHaveBeenCalled();
    expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
  };

  it('is refused for a guest session', async () => {
    mocks.getSessionRpc.mockResolvedValue(
      liveSession({ data: { is_guest_session: true, authTime: NOW_S } })
    );
    await refused();
  });

  it.each([T0, T0 - 1])('is refused for a session that expired at %d', async (expiresAt) => {
    mocks.getSessionRpc.mockResolvedValue(liveSession({ expiresAt }));
    await refused();
  });

  it('is refused when its authentication is older than max_age, and accepted at the limit', async () => {
    mocks.getSessionRpc.mockResolvedValue(liveSession({ data: { authTime: NOW_S - 301 } }));
    await refused('&state=client-state&max_age=300');
    mocks.getSessionRpc.mockResolvedValue(liveSession({ data: { authTime: NOW_S - 300 } }));
    expect((await silent(COOKIE, '&state=client-state&max_age=300')).status).toBe(302);
    expect(mocks.storeChallengeRpc).toHaveBeenCalledTimes(1);
  });

  it('is refused for max_age=0, which always asks for a new login', async () => {
    mocks.getSessionRpc.mockResolvedValue(liveSession({ data: { authTime: NOW_S } }));
    await refused('&state=client-state&max_age=0');
  });

  it('dates a session without an authTime by when it was created', async () => {
    mocks.getSessionRpc.mockResolvedValue(liveSession({ createdAt: T0 - 400_000, data: {} }));
    await refused('&state=client-state&max_age=300');
    mocks.getSessionRpc.mockResolvedValue(liveSession({ createdAt: T0 - 200_000, data: {} }));
    expect(
      params(await silent(COOKIE, '&state=client-state&max_age=300')).handoff_token
    ).toBeTruthy();
  });

  it('ignores the session age without max_age', async () => {
    mocks.getSessionRpc.mockResolvedValue(liveSession({ data: { authTime: NOW_S - 100_000 } }));
    expect(params(await silent()).handoff_token).toBeTruthy();
  });
});
