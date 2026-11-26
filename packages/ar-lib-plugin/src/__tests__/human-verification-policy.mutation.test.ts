import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyHumanVerificationToken, verifyTurnstileToken } from '../builtin/security';
import { deriveEncryptionKey, encryptSecretFields } from '../core/security';
import {
  HCAPTCHA,
  RECAPTCHA,
  TURNSTILE,
  humanVerificationEnv,
  kv,
  stubSiteverify,
  type EnvSpec,
} from './helpers/human-verification-env';

const MISSING = { ok: false, reason: 'missing_or_invalid_token', required: true } as const;
const FAILED = { ok: false, reason: 'verification_failed', required: true } as const;
const NOT_REQUIRED = { ok: true, action: null, required: false } as const;

async function verify(
  spec: EnvSpec,
  options: { response?: unknown; actions?: Array<'login' | 'signup' | 'reauth'> } = {}
) {
  return verifyHumanVerificationToken({
    env: humanVerificationEnv(spec),
    tenantId: 't1',
    actions: options.actions ?? ['login'],
    response: 'response' in options ? options.response : 'token',
  });
}

describe('human verification policy', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    stubSiteverify({ success: true, hostname: 'h', action: 'authrim-login' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('which actions are protected', () => {
    it('requires nothing when no settings are stored, or no store is bound', async () => {
      const bare = await verifyHumanVerificationToken({
        env: {},
        tenantId: 't1',
        actions: 'login',
        response: 'token',
      });
      expect(bare).toEqual(NOT_REQUIRED);
      const empty = await verifyHumanVerificationToken({
        env: { SETTINGS: kv({}) },
        tenantId: 't1',
        actions: 'login',
        response: 'token',
      });
      expect(empty).toEqual(NOT_REQUIRED);
    });

    it.each([
      ['login', 'authentication-methods.human_verification.login_enabled'],
      ['signup', 'authentication-methods.human_verification.signup_enabled'],
      ['reauth', 'authentication-methods.human_verification.reauth_enabled'],
    ] as const)('protects %s only when its own switch is on', async (action, key) => {
      const settings = {
        'authentication-methods.human_verification.login_enabled': false,
        [key]: true,
      };
      const on = await verify({ settings }, { actions: [action] });
      expect(on.required).toBe(true);
      const others = (['login', 'signup', 'reauth'] as const).filter((other) => other !== action);
      for (const other of others) {
        expect(await verify({ settings }, { actions: [other] })).toEqual(NOT_REQUIRED);
      }
    });

    it.each([
      [true, true],
      ['true', true],
      [' TRUE ', true],
      [false, false],
      ['false', false],
      ['yes', false],
      [1, false],
      [null, false],
    ])('reads the switch %j as %s', async (value, required) => {
      const result = await verify({
        settings: { 'authentication-methods.human_verification.login_enabled': value },
      });
      expect(result.required).toBe(required);
    });

    it('protects a request that names several actions when any of them is enabled', async () => {
      const result = await verify({}, { actions: ['signup', 'login'] });
      expect(result.required).toBe(true);
    });
  });

  describe('provider and plugin switches', () => {
    it('treats an unknown provider as a verification that can never succeed', async () => {
      const fetchMock = stubSiteverify({ success: true });
      const result = await verify({ plugin: 'unknown-plugin', settings: {} });
      expect(result).toEqual(MISSING);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to Turnstile when the provider is not a string', async () => {
      const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
      const result = await verify({
        settings: { 'authentication-methods.human_verification.provider': 123 },
      });
      expect(result).toEqual({ ok: true, action: 'login', required: true });
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify'
      );
    });

    it('uses the provider the tenant selected', async () => {
      const fetchMock = stubSiteverify({ success: true });
      await verify({ plugin: HCAPTCHA });
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.hcaptcha.com/siteverify');
      fetchMock.mockClear();
      await verify({ plugin: RECAPTCHA });
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://www.google.com/recaptcha/api/siteverify');
    });

    it.each([
      [
        'a tenant switch that is off',
        { 'plugins:enabled:human-verification-cloudflare-turnstile:tenant:t1': 'false' },
        false,
      ],
      [
        'a tenant switch that is on over a global one that is off',
        {
          'plugins:enabled:human-verification-cloudflare-turnstile:tenant:t1': 'true',
          'plugins:enabled:human-verification-cloudflare-turnstile': 'false',
        },
        true,
      ],
      [
        'a global switch that is off',
        { 'plugins:enabled:human-verification-cloudflare-turnstile': 'false' },
        false,
      ],
      [
        'a global switch that is on',
        { 'plugins:enabled:human-verification-cloudflare-turnstile': 'true' },
        true,
      ],
      [
        'a switch that is not "true"',
        { 'plugins:enabled:human-verification-cloudflare-turnstile:tenant:t1': 'yes' },
        false,
      ],
      ['no switch at all', {}, true],
    ])('honours %s', async (_label, extra, required) => {
      const result = await verify({ extra });
      expect(result.required).toBe(required);
    });
  });

  describe('provider settings', () => {
    it('lets the tenant configuration override the global one', async () => {
      const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
      await verify({
        globalConfig: { siteKey: 'global-site', secretKey: 'global-secret' },
        config: { secretKey: 'tenant-secret' },
      });
      const body = JSON.parse(
        String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)
      ) as {
        secret: string;
      };
      expect(body.secret).toBe('tenant-secret');
    });

    it('uses the global configuration when the tenant has none', async () => {
      const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
      const env = humanVerificationEnv({
        globalConfig: { siteKey: 'g-site', secretKey: 'g-secret' },
      });
      (env.SETTINGS as unknown as { get: ReturnType<typeof vi.fn> }).get.mockImplementation(
        async (key: string) =>
          key === `plugins:config:${TURNSTILE}:tenant:t1`
            ? null
            : key === `plugins:config:${TURNSTILE}`
              ? JSON.stringify({ siteKey: 'g-site', secretKey: 'g-secret' })
              : key === 'settings:tenant:t1:authentication-methods'
                ? JSON.stringify({
                    'authentication-methods.human_verification.login_enabled': true,
                  })
                : null
      );
      await verifyHumanVerificationToken({ env, tenantId: 't1', actions: 'login', response: 't' });
      const body = JSON.parse(
        String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)
      ) as {
        secret: string;
      };
      expect(body.secret).toBe('g-secret');
    });

    it.each([
      ['a missing site key', { siteKey: undefined }],
      ['a blank site key', { siteKey: '   ' }],
      ['a numeric site key', { siteKey: 5 }],
      ['a missing secret key', { secretKey: undefined }],
      ['a blank secret key', { secretKey: '  ' }],
      ['a numeric secret key', { secretKey: 5 }],
    ])('refuses to verify with %s', async (_label, config) => {
      const fetchMock = stubSiteverify({ success: true });
      expect(await verify({ config })).toEqual(MISSING);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('trims the keys before use', async () => {
      const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
      await verify({ config: { siteKey: '  site  ', secretKey: '  secret  ' } });
      const body = JSON.parse(
        String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)
      ) as {
        secret: string;
      };
      expect(body.secret).toBe('secret');
    });

    it.each([
      ['not JSON', 'not json'],
      ['null', 'null'],
      ['an array', '[{"siteKey":"a","secretKey":"b"}]'],
      ['empty', ''],
    ])('ignores a stored configuration that is %s', async (_label, raw) => {
      const fetchMock = stubSiteverify({ success: true });
      const result = await verify({ extra: { [`plugins:config:${TURNSTILE}:tenant:t1`]: raw } });
      expect(result).toEqual(MISSING);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('encrypted secrets', () => {
    const KEY = 'k'.repeat(32);

    async function encrypted(extra: Record<string, unknown> = {}) {
      const key = await deriveEncryptionKey(KEY);
      return encryptSecretFields(
        { siteKey: 'site', secretKey: 'real-secret', ...extra },
        ['secretKey'],
        key
      );
    }

    it('decrypts the secret with the plugin encryption key', async () => {
      const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
      const config = await encrypted();
      const env = humanVerificationEnv({
        extra: { [`plugins:config:${TURNSTILE}:tenant:t1`]: JSON.stringify(config) },
        pluginEnvironment: { PLUGIN_ENCRYPTION_KEY: KEY },
      });
      const result = await verifyHumanVerificationToken({
        env,
        tenantId: 't1',
        actions: 'login',
        response: 't',
      });
      expect(result).toMatchObject({ ok: true });
      const body = JSON.parse(
        String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)
      ) as {
        secret: string;
      };
      expect(body.secret).toBe('real-secret');
    });

    it('leaves a configuration with an empty encrypted list as it is', async () => {
      const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
      const env = humanVerificationEnv({
        extra: {
          [`plugins:config:${TURNSTILE}:tenant:t1`]: JSON.stringify({
            _encrypted: [],
            siteKey: 'site',
            secretKey: 'plain-secret',
          }),
        },
      });
      await verifyHumanVerificationToken({ env, tenantId: 't1', actions: 'login', response: 't' });
      const body = JSON.parse(
        String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)
      ) as {
        secret: string;
      };
      expect(body.secret).toBe('plain-secret');
    });

    it('drops only the encrypted fields when they cannot be decrypted', async () => {
      const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
      const config = await encrypted();
      const env = humanVerificationEnv({
        extra: { [`plugins:config:${TURNSTILE}:tenant:t1`]: JSON.stringify(config) },
        globalConfig: { secretKey: 'global-secret' },
      });
      const result = await verifyHumanVerificationToken({
        env,
        tenantId: 't1',
        actions: 'login',
        response: 't',
      });
      // The tenant's unreadable secret is dropped, so the global one is what remains.
      expect(result).toMatchObject({ ok: true });
      const body = JSON.parse(
        String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)
      ) as {
        secret: string;
      };
      expect(body.secret).toBe('global-secret');
    });
  });

  describe('response token', () => {
    it.each([
      ['a missing token', undefined],
      ['a non-string token', 42],
      ['an empty token', ''],
      ['a blank token', '   '],
      ['a token over 4096 characters', 'x'.repeat(4097)],
    ])('refuses %s without calling siteverify', async (_label, response) => {
      const fetchMock = stubSiteverify({ success: true });
      expect(await verify({}, { response })).toEqual(MISSING);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts a token of exactly 4096 characters and sends it trimmed', async () => {
      const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
      const token = 'x'.repeat(4096);
      expect(await verify({}, { response: `  ${token}  ` })).toMatchObject({ ok: true });
      const body = JSON.parse(
        String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)
      ) as {
        response: string;
      };
      expect(body.response).toBe(token);
    });
  });

  it('exposes the Turnstile entry point as the same check with the token as response', async () => {
    const fetchMock = stubSiteverify({ success: true, action: 'authrim-login' });
    const result = await verifyTurnstileToken({
      env: humanVerificationEnv({}),
      tenantId: 't1',
      actions: 'login',
      token: 'abc',
      remoteIp: '203.0.113.9',
    });
    expect(result).toEqual({ ok: true, action: 'login', required: true });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      response: string;
      remoteip: string;
    };
    expect(body).toMatchObject({ response: 'abc', remoteip: '203.0.113.9' });
  });
});
