/**
 * External start: rate limiting and request gates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T0, mocks, setupStartMocks } from './helpers/start-mocks';
import { argRec, rec } from './helpers/mock-args';
import { SIGN_IN, baseProvider, makeEnv, makeKv, must, start } from './helpers/start-harness';

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

describe('rate limiting', () => {
  const key = (ip: string) => `tenant:default:rate_limit:external_idp:start:${ip}`;

  it('counts the request under the client ip and stores the window with a ttl', async () => {
    const kv = makeKv();
    const response = await start(SIGN_IN, makeEnv(kv), { 'CF-Connecting-IP': '203.0.113.9' });
    expect(response.status).toBe(302);
    expect(kv.get).toHaveBeenCalledWith('external_idp_rate_limit');
    expect(kv.put).toHaveBeenCalledWith(
      key('203.0.113.9'),
      JSON.stringify({ count: 1, windowStart: T0 }),
      { expirationTtl: 120 }
    );
  });

  it.each([
    [{ 'X-Forwarded-For': ' 198.51.100.1 , 10.0.0.1' }, '198.51.100.1'],
    [{ 'X-Real-IP': '192.0.2.44' }, '192.0.2.44'],
    [{}, 'unknown'],
  ])('derives the client ip from %j', async (headers, ip) => {
    const kv = makeKv();
    await start(SIGN_IN, makeEnv(kv), headers);
    expect(kv.put.mock.calls[0]?.[0]).toBe(key(ip));
  });

  it('prefers CF-Connecting-IP over X-Forwarded-For', async () => {
    const kv = makeKv();
    await start(SIGN_IN, makeEnv(kv), {
      'CF-Connecting-IP': '1.1.1.1',
      'X-Forwarded-For': '2.2.2.2',
    });
    expect(kv.put.mock.calls[0]?.[0]).toBe(key('1.1.1.1'));
  });

  it('answers 429 with Retry-After once the limit is reached and stores nothing more', async () => {
    const kv = makeKv({
      [key('9.9.9.9')]: JSON.stringify({ count: 10, windowStart: T0 - 20_000 }),
    });
    const response = await start(SIGN_IN, makeEnv(kv), { 'CF-Connecting-IP': '9.9.9.9' });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('40');
    expect(await response.json()).toEqual({
      error: 'rate_limit_exceeded',
      error_description: 'Too many authentication requests. Please try again later.',
      retry_after: 40,
    });
    expect(kv.put).not.toHaveBeenCalled();
    nothingStarted();
  });

  it('allows the last request under the limit and rounds the retry up to at least one second', async () => {
    const kv = makeKv({
      [key('9.9.9.9')]: JSON.stringify({ count: 9, windowStart: T0 - 20_000 }),
    });
    const ok = await start(SIGN_IN, makeEnv(kv), { 'CF-Connecting-IP': '9.9.9.9' });
    expect(ok.status).toBe(302);
    expect(JSON.parse(must(kv.store.get(key('9.9.9.9'))))).toEqual({
      count: 10,
      windowStart: T0 - 20_000,
    });
    const nearEnd = makeKv({
      [key('9.9.9.9')]: JSON.stringify({ count: 10, windowStart: T0 - 59_999 }),
    });
    const limited = await start(SIGN_IN, makeEnv(nearEnd), { 'CF-Connecting-IP': '9.9.9.9' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('1');
  });

  it('restarts the window only after it has strictly expired', async () => {
    const atEdge = makeKv({
      [key('9.9.9.9')]: JSON.stringify({ count: 10, windowStart: T0 - 60_000 }),
    });
    expect((await start(SIGN_IN, makeEnv(atEdge), { 'CF-Connecting-IP': '9.9.9.9' })).status).toBe(
      429
    );
    const expired = makeKv({
      [key('9.9.9.9')]: JSON.stringify({ count: 10, windowStart: T0 - 60_001 }),
    });
    const ok = await start(SIGN_IN, makeEnv(expired), { 'CF-Connecting-IP': '9.9.9.9' });
    expect(ok.status).toBe(302);
    expect(JSON.parse(must(expired.store.get(key('9.9.9.9'))))).toEqual({
      count: 1,
      windowStart: T0,
    });
  });

  it('honours a configured limit, window and the disabled switch', async () => {
    const small = makeKv({
      external_idp_rate_limit: JSON.stringify({ maxRequests: 1, windowSeconds: 5 }),
      [key('unknown')]: JSON.stringify({ count: 1, windowStart: T0 - 1000 }),
    });
    const response = await start(SIGN_IN, makeEnv(small));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('4');

    const ttl = makeKv({ external_idp_rate_limit: JSON.stringify({ windowSeconds: 5 }) });
    await start(SIGN_IN, makeEnv(ttl));
    expect(ttl.put.mock.calls[0]?.[2]).toEqual({ expirationTtl: 65 });

    const off = makeKv({
      external_idp_rate_limit: JSON.stringify({ enabled: false }),
      [key('unknown')]: JSON.stringify({ count: 99, windowStart: T0 }),
    });
    expect((await start(SIGN_IN, makeEnv(off))).status).toBe(302);
    expect(off.put).not.toHaveBeenCalled();
  });

  it('fails open when the counter cannot be read or stored, and on a corrupt config', async () => {
    const broken = makeKv();
    broken.get.mockImplementation(async (name: string) => {
      if (name === 'external_idp_rate_limit') return '{not json';
      throw new Error('kv down');
    });
    expect((await start(SIGN_IN, makeEnv(broken))).status).toBe(302);

    const noPut = makeKv();
    noPut.put.mockRejectedValue(new Error('kv write failed'));
    expect((await start(SIGN_IN, makeEnv(noPut))).status).toBe(302);
  });

  it('runs without a KV binding', async () => {
    const response = await start(SIGN_IN, makeEnv(makeKv(), { SETTINGS: undefined }));
    expect(response.status).toBe(302);
  });
});

describe('request gates', () => {
  const env = () => makeEnv(makeKv());

  it('requires a provider segment', async () => {
    const { startApp } = await import('./helpers/start-harness');
    const response = await startApp().request(
      `https://auth.example.com/auth/external/start?${SIGN_IN}`,
      {},
      env()
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Missing provider',
    });
  });

  it('checks human verification with the usage, token and remote ip', async () => {
    await start(`${SIGN_IN}&human_verification_response=hv-token`, env(), {
      'CF-Connecting-IP': '203.0.113.2',
    });
    expect(mocks.verifyHuman).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      action: 'login',
      responseToken: 'hv-token',
      remoteIp: '203.0.113.2',
    });
  });

  it('falls back to the turnstile token and the forwarded ip, and asks sign-up to meet login too', async () => {
    await start(`${SIGN_IN}&purpose=signup&cf_turnstile_response=ts-token`, env(), {
      'X-Forwarded-For': '198.51.100.3, 10.0.0.1',
    });
    expect(mocks.verifyHuman).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      action: 'signup',
      alsoRequiredFor: ['login'],
      responseToken: 'ts-token',
      remoteIp: '198.51.100.3',
    });
  });

  it('prefers human_verification_response over cf_turnstile_response', async () => {
    await start(`${SIGN_IN}&human_verification_response=a&cf_turnstile_response=b`, env());
    expect(argRec(mocks.verifyHuman, 0, 1).responseToken).toBe('a');
  });

  it('leaves the remote ip undefined when no header names it', async () => {
    await start(SIGN_IN, env());
    expect(argRec(mocks.verifyHuman, 0, 1).remoteIp).toBeUndefined();
  });

  it('denies with 400 when verification fails or throws', async () => {
    const expected = { error: 'invalid_request', error_description: 'Human verification failed' };
    mocks.verifyHuman.mockResolvedValue({ verified: false });
    const failed = await start(SIGN_IN, env());
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual(expected);
    mocks.verifyHuman.mockRejectedValue(new Error('runner down'));
    const thrown = await start(SIGN_IN, env());
    expect(thrown.status).toBe(400);
    expect(await thrown.json()).toEqual(expected);
    nothingStarted();
  });

  it('treats a sign-up with prompt=none as a login for the verification action', async () => {
    await start(`${SIGN_IN}&purpose=signup&prompt=none`, env());
    expect(argRec(mocks.verifyHuman, 0, 1).action).toBe('login');
    expect(mocks.verifyHuman.mock.calls[0]?.[1]).not.toHaveProperty('alsoRequiredFor');
  });

  it('rejects a negative or non-numeric max_age, accepts zero and positive values', async () => {
    for (const value of ['-1', 'abc']) {
      const response = await start(`${SIGN_IN}&max_age=${value}`, env());
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        error_description: 'max_age must be a non-negative integer',
      });
    }
    nothingStarted();
    await start(`${SIGN_IN}&max_age=0`, env());
    expect(stateArg().maxAge).toBe(0);
    mocks.storeAuthState.mockClear();
    await start(`${SIGN_IN}&max_age=300`, env());
    expect(stateArg().maxAge).toBe(300);
  });

  it('requires client_id and an S256 challenge', async () => {
    const noClient = await start('code_challenge=abc&code_challenge_method=S256', env());
    expect(noClient.status).toBe(400);
    expect(await noClient.json()).toEqual({
      error: 'invalid_request',
      error_description: 'client_id is required',
    });
    const message = {
      error: 'invalid_request',
      error_description: 'code_challenge and code_challenge_method=S256 are required',
    };
    for (const query of [
      'client_id=c&code_challenge_method=S256',
      'client_id=c&code_challenge=abc',
      'client_id=c&code_challenge=abc&code_challenge_method=plain',
    ]) {
      const response = await start(query, env());
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(message);
    }
    nothingStarted();
  });

  it('answers 404 for an unknown or disabled provider, naming it', async () => {
    mocks.getProvider.mockResolvedValue(null);
    const unknown = await start(SIGN_IN, env(), {}, 'nope');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: 'unknown_provider',
      error_description: 'Provider "nope" not found or disabled',
    });
    expect(mocks.getProvider).toHaveBeenCalledWith(expect.anything(), 'nope', 'default');
    mocks.getProvider.mockResolvedValue({ ...baseProvider, enabled: false });
    expect((await start(SIGN_IN, env())).status).toBe(404);
  });

  it('answers 403 and 503 from the usage gate with the right wording', async () => {
    const { ExternalIdPError, ExternalIdPErrorCode } = await import('../types');
    mocks.usageGate.mockRejectedValue(
      new ExternalIdPError(ExternalIdPErrorCode.LOGIN_DISABLED, 'off')
    );
    const denied = await start(SIGN_IN, env());
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: 'access_denied',
      error_description: 'This provider cannot be used to sign in',
    });
    expect(mocks.usageGate).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      baseProvider,
      'login'
    );
    const signup = await start(`${SIGN_IN}&purpose=signup`, env());
    expect(rec(await signup.json()).error_description).toBe(
      'This provider cannot be used to sign up'
    );
    mocks.usageGate.mockRejectedValue(
      new ExternalIdPError(ExternalIdPErrorCode.SETTINGS_UNAVAILABLE, 'down')
    );
    const unavailable = await start(SIGN_IN, env());
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('Retry-After')).toBe('1');
    expect(await unavailable.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Provider settings are unavailable',
    });
    mocks.usageGate.mockRejectedValue(new Error('boom'));
    const unexpected = await start(SIGN_IN, env());
    expect(unexpected.status).toBe(500);
    expect(await unexpected.json()).toEqual({
      error: 'server_error',
      error_description: 'Failed to start external login',
    });
    nothingStarted();
  });

  it('shows the failure message only in conformance mode', async () => {
    mocks.usageGate.mockRejectedValue(new Error('boom'));
    const response = await start(SIGN_IN, makeEnv(makeKv(), { ENABLE_CONFORMANCE_MODE: 'true' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: 'Failed to start external login: boom',
    });
  });
});
