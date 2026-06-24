import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyHumanVerificationToken } from '../builtin/security';
import { deriveEncryptionKey, encryptSecretFields } from '../core/security';

function createMockKV(data: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => data[key] ?? null),
  };
}

function createTurnstileEnv(settings: Record<string, string> = {}) {
  return {
    SETTINGS: createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
        'authentication-methods.human_verification.provider':
          'human-verification-cloudflare-turnstile',
        'authentication-methods.human_verification.login_enabled': true,
        ...settings,
      }),
      'plugins:enabled:human-verification-cloudflare-turnstile:tenant:tenant_test': 'true',
      'plugins:config:human-verification-cloudflare-turnstile:tenant:tenant_test': JSON.stringify({
        siteKey: '0x4AAAAAA_site_key',
        secretKey: '0x4AAAAAA_secret_key',
        failurePolicy: 'fail_closed',
      }),
    }) as never,
  };
}

function createProviderEnv(
  providerPluginId: string,
  config: Record<string, unknown>,
  settings: Record<string, string> = {}
) {
  return {
    SETTINGS: createMockKV({
      'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
        'authentication-methods.human_verification.provider': providerPluginId,
        'authentication-methods.human_verification.login_enabled': true,
        ...settings,
      }),
      [`plugins:enabled:${providerPluginId}:tenant:tenant_test`]: 'true',
      [`plugins:config:${providerPluginId}:tenant:tenant_test`]: JSON.stringify({
        siteKey: 'site-key',
        secretKey: 'secret-key',
        failurePolicy: 'fail_closed',
        ...config,
      }),
    }) as never,
  };
}

describe('Turnstile runtime verification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects successful Siteverify responses that omit the expected action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ success: true, hostname: 'login.example.com' }))
    );

    const result = await verifyHumanVerificationToken({
      env: createTurnstileEnv(),
      tenantId: 'tenant_test',
      actions: 'login',
      response: 'turnstile-token',
    });

    expect(result.ok).toBe(false);
  });

  it('rejects tokens whose action is not enabled for the requested start surface', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ success: true, hostname: 'login.example.com', action: 'authrim-signup' })
      )
    );

    const result = await verifyHumanVerificationToken({
      env: createTurnstileEnv({
        'authentication-methods.human_verification.signup_enabled': false,
      }),
      tenantId: 'tenant_test',
      actions: ['login', 'signup'],
      response: 'turnstile-token',
    });

    expect(result.ok).toBe(false);
  });

  it('accepts tokens whose action matches an enabled requested action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ success: true, hostname: 'login.example.com', action: 'authrim-login' })
      )
    );

    const result = await verifyHumanVerificationToken({
      env: createTurnstileEnv(),
      tenantId: 'tenant_test',
      actions: ['login', 'signup'],
      response: 'turnstile-token',
    });

    expect(result).toMatchObject({ ok: true, action: 'login', required: true });
  });

  it('verifies hCaptcha tokens with form-encoded siteverify parameters', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ success: true, hostname: 'login.example.com' })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyHumanVerificationToken({
      env: createProviderEnv('human-verification-hcaptcha', {}),
      tenantId: 'tenant_test',
      actions: 'login',
      response: 'hcaptcha-token',
    });

    expect(result).toMatchObject({ ok: true, required: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.hcaptcha.com/siteverify',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(URLSearchParams),
      })
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get('secret')).toBe('secret-key');
    expect(body.get('response')).toBe('hcaptcha-token');
    expect(body.get('sitekey')).toBe('site-key');
  });

  it('does not send encrypted hCaptcha secrets to Siteverify when decryption fails', async () => {
    const encryptionKey = await deriveEncryptionKey('a'.repeat(32));
    const encryptedConfig = await encryptSecretFields(
      {
        siteKey: 'site-key',
        secretKey: 'secret-key',
      },
      ['secretKey'],
      encryptionKey
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyHumanVerificationToken({
      env: {
        SETTINGS: createMockKV({
          'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
            'authentication-methods.human_verification.provider': 'human-verification-hcaptcha',
            'authentication-methods.human_verification.login_enabled': true,
          }),
          'plugins:enabled:human-verification-hcaptcha:tenant:tenant_test': 'true',
          'plugins:config:human-verification-hcaptcha:tenant:tenant_test':
            JSON.stringify(encryptedConfig),
        }) as never,
        PLUGIN_ENCRYPTION_KEY: 'b'.repeat(32),
      },
      tenantId: 'tenant_test',
      actions: 'login',
      response: 'hcaptcha-token',
    });

    expect(result).toEqual({ ok: false, reason: 'missing_or_invalid_token', required: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects reCAPTCHA score tokens below the configured threshold', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: true,
          hostname: 'login.example.com',
          action: 'authrim_login',
          score: 0.3,
        })
      )
    );

    const result = await verifyHumanVerificationToken({
      env: createProviderEnv('human-verification-google-recaptcha', {
        widgetMode: 'score',
        scoreThreshold: 0.7,
      }),
      tenantId: 'tenant_test',
      actions: 'login',
      response: 'recaptcha-token',
    });

    expect(result).toEqual({ ok: false, reason: 'verification_failed', required: true });
  });

  it('accepts reCAPTCHA score tokens that match action and threshold', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: true,
          hostname: 'login.example.com',
          action: 'authrim_login',
          score: 0.9,
        })
      )
    );

    const result = await verifyHumanVerificationToken({
      env: createProviderEnv('human-verification-google-recaptcha', {
        widgetMode: 'score',
        scoreThreshold: 0.7,
      }),
      tenantId: 'tenant_test',
      actions: 'login',
      response: 'recaptcha-token',
    });

    expect(result).toEqual({ ok: true, action: 'login', required: true });
  });

  it('rejects expired or reused reCAPTCHA tokens even when fail open is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: false,
          'error-codes': ['timeout-or-duplicate'],
        })
      )
    );

    const result = await verifyHumanVerificationToken({
      env: createProviderEnv('human-verification-google-recaptcha', {
        failurePolicy: 'fail_open',
      }),
      tenantId: 'tenant_test',
      actions: 'login',
      response: 'recaptcha-token',
    });

    expect(result).toEqual({ ok: false, reason: 'verification_failed', required: true });
  });
});
