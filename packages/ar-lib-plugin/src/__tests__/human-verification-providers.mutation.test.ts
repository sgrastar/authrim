import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyHumanVerificationToken } from '../builtin/security';
import {
  HCAPTCHA,
  RECAPTCHA,
  firstJsonBody,
  firstRequest,
  humanVerificationEnv,
  stubSiteverify,
  type EnvSpec,
} from './helpers/human-verification-env';

const FAILED = { ok: false, reason: 'verification_failed', required: true } as const;
const PASSED_NO_ACTION = { ok: true, action: null, required: true } as const;

type Action = 'login' | 'signup' | 'reauth';

async function verify(spec: EnvSpec, options: { actions?: Action[]; remoteIp?: string } = {}) {
  return verifyHumanVerificationToken({
    env: humanVerificationEnv(spec),
    tenantId: 't1',
    actions: options.actions ?? ['login'],
    response: 'token',
    remoteIp: options.remoteIp,
  });
}

function stubFailure(error: Error = new Error('network down')) {
  const fetchMock = vi.fn(async () => {
    throw error;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Turnstile siteverify', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const allEnabled = {
    'authentication-methods.human_verification.signup_enabled': true,
    'authentication-methods.human_verification.reauth_enabled': true,
  };

  it('posts a JSON request with the secret, token, client address and a fresh idempotency key', async () => {
    const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
    await verify({}, { remoteIp: '203.0.113.7' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = firstJsonBody<{ idempotency_key: string }>(fetchMock);
    expect(body).toMatchObject({ secret: 'secret', response: 'token', remoteip: '203.0.113.7' });
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('uses a different idempotency key for every request', async () => {
    const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
    await verify({});
    await verify({});
    const keys = fetchMock.mock.calls.map(
      (call) =>
        (JSON.parse(String((call[1] as RequestInit).body)) as { idempotency_key: string })
          .idempotency_key
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('sends no client address when none is known', async () => {
    const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
    await verify({});
    expect(firstJsonBody(fetchMock)).not.toHaveProperty('remoteip');
  });

  it.each([
    ['authrim-login', 'login'],
    ['authrim-signup', 'signup'],
    ['authrim-reauth', 'reauth'],
  ] as const)('reports the %s widget action as %s', async (widgetAction, expected) => {
    stubSiteverify({ success: true, action: widgetAction });
    const result = await verify(
      { settings: allEnabled },
      { actions: ['login', 'signup', 'reauth'] }
    );
    expect(result).toEqual({ ok: true, action: expected, required: true });
  });

  it.each([
    ['an action that is not enabled', { success: true, action: 'authrim-signup' }],
    ['an action with underscores', { success: true, action: 'authrim_login' }],
    ['no action', { success: true }],
    ['an unknown action', { success: true, action: 'other' }],
    ['a failure', { success: false, action: 'authrim-login' }],
  ])('rejects %s', async (_label, body) => {
    stubSiteverify(body);
    expect(await verify({})).toEqual(FAILED);
  });

  it('only accepts the actions that are both requested and enabled', async () => {
    stubSiteverify({ success: true, action: 'authrim-reauth' });
    expect(await verify({}, { actions: ['login', 'reauth'] })).toEqual(FAILED);
    expect(await verify({ settings: allEnabled }, { actions: ['login', 'reauth'] })).toEqual({
      ok: true,
      action: 'reauth',
      required: true,
    });
  });

  it('checks the hostname when one is configured', async () => {
    stubSiteverify({ success: true, action: 'authrim-login', hostname: 'login.example.com' });
    expect(await verify({ config: { expectedHostname: ' login.example.com ' } })).toMatchObject({
      ok: true,
    });
    expect(await verify({ config: { expectedHostname: 'other.example.com' } })).toEqual(FAILED);
    expect(await verify({ config: { expectedHostname: '   ' } })).toMatchObject({ ok: true });
    expect(await verify({ config: { expectedHostname: 5 } })).toMatchObject({ ok: true });
  });

  describe('failure policy', () => {
    // The published configuration allows only fail_closed, so only the refusing outcomes are
    // asserted here: what a legacy `fail_open` value does is not part of the contract.
    it('refuses a verification that failed because of an internal Siteverify error', async () => {
      stubSiteverify({ success: false, 'error-codes': ['internal-error'] });
      expect(await verify({ config: { failurePolicy: 'fail_closed' } })).toEqual(FAILED);
      expect(await verify({ config: { failurePolicy: 'unknown' } })).toEqual(FAILED);
      expect(await verify({})).toEqual(FAILED);
    });

    it('does not pass other failures whatever the failure policy', async () => {
      stubSiteverify({ success: false, 'error-codes': ['invalid-input-response'] });
      expect(await verify({ config: { failurePolicy: 'fail_closed' } })).toEqual(FAILED);
      expect(await verify({ config: { failurePolicy: 'fail_open' } })).toEqual(FAILED);
      stubSiteverify({ success: false });
      expect(await verify({ config: { failurePolicy: 'fail_open' } })).toEqual(FAILED);
    });

    it('refuses an unavailable service', async () => {
      stubSiteverify({ success: false }, { status: 503 });
      expect(await verify({ config: { failurePolicy: 'fail_closed' } })).toEqual(FAILED);
      stubFailure();
      expect(await verify({ config: { failurePolicy: 'fail_closed' } })).toEqual(FAILED);
    });

    it('refuses an unreadable answer', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('<html>', { status: 200 }))
      );
      expect(await verify({})).toEqual(FAILED);
    });
  });

  describe('timeout', () => {
    async function timeoutFor(config: Record<string, unknown>): Promise<unknown> {
      stubSiteverify({ success: true, action: 'authrim-login' });
      const spy = vi.spyOn(globalThis, 'setTimeout');
      await verify({ config });
      const call = spy.mock.calls.find(
        (entry) => typeof entry[1] === 'number' && entry[1] >= 1000 && entry[1] <= 10000
      );
      return call?.[1];
    }

    it.each([
      [undefined, 5000],
      [1000, 1000],
      [999, 5000],
      [10000, 10000],
      [10001, 5000],
      [2500.9, 2500],
      ['3000', 5000],
    ])('uses %j as a %s ms timeout', async (configured, expected) => {
      expect(await timeoutFor({ timeoutMs: configured })).toBe(expected);
    });

    it('clears the timer once the answer is in', async () => {
      stubSiteverify({ success: true, action: 'authrim-login' });
      const clear = vi.spyOn(globalThis, 'clearTimeout');
      await verify({});
      expect(clear).toHaveBeenCalled();
    });
  });
});

describe('hCaptcha siteverify', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('posts a form with the secret, token and site key, and the client address when known', async () => {
    const fetchMock = stubSiteverify({ success: true });
    await verify({ plugin: HCAPTCHA }, { remoteIp: '203.0.113.7' });
    const init = firstRequest(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      secret: 'secret',
      response: 'token',
      sitekey: 'site',
      remoteip: '203.0.113.7',
    });
  });

  it('leaves out the client address when none is known', async () => {
    const fetchMock = stubSiteverify({ success: true });
    await verify({ plugin: HCAPTCHA });
    expect((firstRequest(fetchMock).body as URLSearchParams).has('remoteip')).toBe(false);
  });

  it('accepts a success without an action, and rejects failures and hostname mismatches', async () => {
    stubSiteverify({ success: true, hostname: 'login.example.com' });
    expect(await verify({ plugin: HCAPTCHA })).toEqual(PASSED_NO_ACTION);
    expect(
      await verify({ plugin: HCAPTCHA, config: { expectedHostname: 'login.example.com' } })
    ).toEqual(PASSED_NO_ACTION);
    expect(await verify({ plugin: HCAPTCHA, config: { expectedHostname: 'x.example' } })).toEqual(
      FAILED
    );
    stubSiteverify({ success: false });
    expect(await verify({ plugin: HCAPTCHA })).toEqual(FAILED);
  });

  it('refuses service errors and an unreachable service', async () => {
    stubSiteverify({ success: false, 'error-codes': ['internal-error'] });
    expect(await verify({ plugin: HCAPTCHA })).toEqual(FAILED);
    stubSiteverify({ success: false }, { status: 500 });
    expect(await verify({ plugin: HCAPTCHA })).toEqual(FAILED);
    stubFailure();
    expect(await verify({ plugin: HCAPTCHA })).toEqual(FAILED);
  });
});

describe('reCAPTCHA siteverify', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const score = (config: Record<string, unknown> = {}) => ({
    plugin: RECAPTCHA,
    config: { widgetMode: 'score', ...config },
  });

  it('posts a form with the secret and token only, and the client address when known', async () => {
    const fetchMock = stubSiteverify({ success: true });
    await verify({ plugin: RECAPTCHA }, { remoteIp: '203.0.113.7' });
    const init = firstRequest(fetchMock);
    expect(init.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      secret: 'secret',
      response: 'token',
      remoteip: '203.0.113.7',
    });
    fetchMock.mockClear();
    await verify({ plugin: RECAPTCHA });
    expect((firstRequest(fetchMock).body as URLSearchParams).has('remoteip')).toBe(false);
  });

  it('accepts a checkbox success without looking at the action or score', async () => {
    stubSiteverify({ success: true, action: 'whatever', score: 0 });
    expect(await verify({ plugin: RECAPTCHA })).toEqual(PASSED_NO_ACTION);
    expect(await verify({ plugin: RECAPTCHA, config: { widgetMode: 5 } })).toEqual(
      PASSED_NO_ACTION
    );
  });

  it.each([
    ['authrim_login', 'login'],
    ['authrim_signup', 'signup'],
    ['authrim_reauth', 'reauth'],
  ] as const)('reports the %s score action as %s', async (widgetAction, expected) => {
    stubSiteverify({ success: true, action: widgetAction, score: 0.9 });
    const result = await verify(
      {
        ...score(),
        settings: {
          'authentication-methods.human_verification.signup_enabled': true,
          'authentication-methods.human_verification.reauth_enabled': true,
        },
      },
      { actions: ['login', 'signup', 'reauth'] }
    );
    expect(result).toEqual({ ok: true, action: expected, required: true });
  });

  it.each([
    ['an action with hyphens', { success: true, action: 'authrim-login', score: 0.9 }],
    ['an action that is not enabled', { success: true, action: 'authrim_signup', score: 0.9 }],
    ['no action', { success: true, score: 0.9 }],
    ['no score', { success: true, action: 'authrim_login' }],
    [
      'a score under the default threshold',
      { success: true, action: 'authrim_login', score: 0.49 },
    ],
  ])('rejects %s in score mode', async (_label, body) => {
    stubSiteverify(body);
    expect(await verify(score())).toEqual(FAILED);
  });

  it.each([
    [undefined, 0.5, true],
    [0.5, 0.5, true],
    [0.7, 0.69, false],
    [0, 0, true],
    [1, 1, true],
    [1, 0.99, false],
    [-0.1, 0.4, false],
    [1.1, 0.9, true],
    ['0.9', 0.6, true],
  ])('with threshold %j a score of %s passes: %s', async (threshold, value, passes) => {
    stubSiteverify({ success: true, action: 'authrim_login', score: value });
    const result = await verify(score({ scoreThreshold: threshold }));
    expect(result.ok).toBe(passes);
  });

  it('checks hostname before the score, and refuses service errors', async () => {
    stubSiteverify({ success: true, action: 'authrim_login', score: 0.9, hostname: 'a.example' });
    expect(await verify(score({ expectedHostname: 'b.example' }))).toEqual(FAILED);
    stubSiteverify({ success: false, 'error-codes': ['internal-error'] });
    expect(await verify(score())).toEqual(FAILED);
    stubSiteverify({ success: false }, { status: 502 });
    expect(await verify(score())).toEqual(FAILED);
    stubFailure();
    expect(await verify(score())).toEqual(FAILED);
  });

  it('rejects an expired or reused token whatever the failure policy', async () => {
    stubSiteverify({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect(await verify({ plugin: RECAPTCHA, config: { failurePolicy: 'fail_open' } })).toEqual(
      FAILED
    );
  });
});
