import { describe, expect, it, vi } from 'vitest';
import { resolveEffectiveSettings } from '../effective-settings';
import { readLegacySettings } from '../legacy-settings';

function kv(values: Record<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
  } as unknown as KVNamespace;
}

describe('readLegacySettings', () => {
  it('reads values saved through the older oauth-config under Settings API keys', async () => {
    const env = {
      AUTHRIM_CONFIG: kv({
        'oauth:config:TOKEN_EXPIRY': '900',
        'oauth:config:STATE_REQUIRED': 'true',
        'oauth:config:USERINFO_REQUIRE_OPENID_SCOPE': '0',
      }),
    };

    await expect(readLegacySettings(env, 'oauth', { fresh: true })).resolves.toEqual({
      'oauth.access_token_expiry': 900,
      'oauth.state_required': true,
      'oauth.userinfo_require_openid': false,
    });
    await expect(readLegacySettings(env, 'client')).resolves.toEqual({});
  });

  it('reads the error settings saved through the older error-config API', async () => {
    const env = {
      AUTHRIM_CONFIG: kv({ error_response_format: 'problem_details', error_id_mode: 'verbose' }),
    };

    // A value the error middleware does not know is ignored, as the middleware ignored it.
    await expect(readLegacySettings(env, 'oauth', { fresh: true })).resolves.toEqual({
      'oauth.error_response_format': 'problem_details',
    });
  });

  it('skips values it cannot read, as the older config manager fell back to env', async () => {
    const env = {
      AUTHRIM_CONFIG: {
        get: vi.fn(async (key: string) => {
          if (key === 'oauth:config:TOKEN_EXPIRY') throw new Error('kv unavailable');
          return key === 'oauth:config:AUTH_CODE_TTL' ? '120' : null;
        }),
      } as unknown as KVNamespace,
    };

    // Runtime skips it; an admin view (fresh) fails instead of showing it as unset.
    await expect(readLegacySettings(env, 'oauth')).resolves.toEqual({
      'oauth.auth_code_ttl': 120,
    });
    await expect(readLegacySettings(env, 'oauth', { fresh: true })).rejects.toThrow();
  });

  it('reads only the stores that can hold the requested keys', async () => {
    const settings = { get: vi.fn(async () => 'not json') } as unknown as KVNamespace;
    const env = { SETTINGS: settings, AUTHRIM_CONFIG: kv({ error_id_mode: 'none' }) };

    // system_settings is broken, but it holds no error setting, so it is not read.
    await expect(
      readLegacySettings(env, 'oauth', {
        fresh: true,
        keys: ['oauth.error_response_format', 'oauth.error_id_mode'],
      })
    ).resolves.toEqual({ 'oauth.error_id_mode': 'none' });
    expect(settings.get).not.toHaveBeenCalled();
  });
});

describe('older JIT provisioning value', () => {
  it("reads the saved document's enabled, as the bridge uses it", async () => {
    const read = (stored: string | undefined) =>
      readLegacySettings(
        { SETTINGS: kv(stored === undefined ? {} : { jit_provisioning_config: stored }) },
        'external-idp',
        { fresh: true }
      );
    await expect(read(undefined)).resolves.toEqual({});
    await expect(read(JSON.stringify({ enabled: true }))).resolves.toEqual({
      'external_idp.jit_provisioning_enabled': true,
    });
    // Without enabled: true, or not a JSON object, the bridge refuses JIT.
    for (const stored of [JSON.stringify({ default_role_id: 'r' }), '[]', '{']) {
      await expect(read(stored)).resolves.toEqual({
        'external_idp.jit_provisioning_enabled': false,
      });
    }
  });
});

describe('older UI settings', () => {
  it('reads the base URL, and its paths only with it, as the login redirects use them', async () => {
    const read = (ui: unknown) =>
      readLegacySettings({ SETTINGS: kv({ system_settings: JSON.stringify({ ui }) }) }, 'tenant', {
        fresh: true,
      });

    await expect(
      read({ baseUrl: 'https://login.example.com/', paths: { login: '/sign-in', device: '/d' } })
    ).resolves.toEqual({
      'tenant.ui_base_url': 'https://login.example.com',
      'tenant.ui_login_path': '/sign-in',
    });
    // Without a saved base URL, UI_URL applies with the default paths.
    await expect(read({ paths: { login: '/sign-in' } })).resolves.toEqual({});
  });
});

describe('older rate limit values', () => {
  it('reads the per-profile limits, and one window only when the three profiles share it', async () => {
    const shared = {
      AUTHRIM_CONFIG: kv({
        rate_limit_strict_max_requests: '25',
        rate_limit_strict_window_seconds: '30',
        rate_limit_moderate_window_seconds: '30',
        rate_limit_lenient_window_seconds: '30',
      }),
    };
    await expect(readLegacySettings(shared, 'rate-limit', { fresh: true })).resolves.toEqual({
      'rate_limit.strict': 25,
      'rate_limit.window_ms': 30000,
    });

    // strict at 30 s, the others at their 60 s default: no single window.
    const mixed = { AUTHRIM_CONFIG: kv({ rate_limit_strict_window_seconds: '30' }) };
    await expect(readLegacySettings(mixed, 'rate-limit', { fresh: true })).resolves.toEqual({});

    // A value the rate limiter would not use (not a positive integer) is not shown.
    const invalid = { AUTHRIM_CONFIG: kv({ rate_limit_lenient_max_requests: '0' }) };
    await expect(readLegacySettings(invalid, 'rate-limit', { fresh: true })).resolves.toEqual({});
  });
});

describe('resolveEffectiveSettings', () => {
  it('takes client, then tenant, then the older store, then env, then the default', async () => {
    const env = {
      SETTINGS: kv({
        'settings:tenant:acme:oauth': JSON.stringify({ 'oauth.refresh_token_expiry': 86400 }),
        'settings:client:acme:app:oauth': JSON.stringify({ 'oauth.access_token_expiry': 300 }),
      }),
      AUTHRIM_CONFIG: kv({
        'oauth:config:TOKEN_EXPIRY': '900',
        'oauth:config:REFRESH_TOKEN_EXPIRY': '172800',
        'oauth:config:AUTH_CODE_TTL': '120',
      }),
      ENABLE_STATE_REQUIRED: 'true',
    };

    const forClient = await resolveEffectiveSettings(env, 'oauth', {
      tenantId: 'acme',
      clientId: 'app',
    });
    expect(forClient['oauth.access_token_expiry']).toBe(300);
    expect(forClient['oauth.refresh_token_expiry']).toBe(86400);
    expect(forClient['oauth.auth_code_ttl']).toBe(120);
    expect(forClient['oauth.state_required']).toBe(true);
    expect(forClient['oauth.userinfo_require_openid']).toBe(true);

    const forTenant = await resolveEffectiveSettings(env, 'oauth', { tenantId: 'acme' });
    expect(forTenant['oauth.access_token_expiry']).toBe(900);
  });

  it('reads the oauth-config booleans from env the way the older config manager did', async () => {
    for (const [raw, expected] of [
      ['yes', true],
      ['TRUE', true],
      ['1', true],
      ['false', false],
      ['0', false],
    ] as const) {
      const values = await resolveEffectiveSettings(
        { SETTINGS: kv({}), ENABLE_STATE_REQUIRED: raw, ENABLE_USERINFO_REQUIRE_OPENID_SCOPE: raw },
        'oauth',
        { tenantId: `env-${raw}` }
      );
      expect(values['oauth.state_required']).toBe(expected);
      expect(values['oauth.userinfo_require_openid']).toBe(expected);
    }
  });

  it('reads the system-settings booleans from env only as the exact string true', async () => {
    for (const [raw, expected] of [
      ['true', true],
      ['TRUE', false],
      ['1', false],
      // Defined but empty reads as false, as runtime reads it.
      ['', false],
    ] as const) {
      const values = await resolveEffectiveSettings(
        {
          SETTINGS: kv({}),
          ENABLE_TOKEN_EXCHANGE: raw,
          ENABLE_INTROSPECTION_STRICT_VALIDATION: raw,
        },
        'tokens',
        { tenantId: `exact-${raw}` }
      );
      expect(values['tokens.exchange_enabled']).toBe(expected);
      expect(values['tokens.introspection_strict_validation']).toBe(expected);
    }
  });

  it("uses the tenant's values for a client id that cannot name client settings", async () => {
    const env = {
      SETTINGS: kv({
        'settings:tenant:acme:oauth': JSON.stringify({ 'oauth.access_token_expiry': 600 }),
      }),
    };

    const values = await resolveEffectiveSettings(env, 'oauth', {
      tenantId: 'acme',
      clientId: 'https://service.example.com',
    });
    expect(values['oauth.access_token_expiry']).toBe(600);
  });

  it('fails instead of using defaults when a settings document cannot be read', async () => {
    const env = {
      SETTINGS: {
        get: vi.fn(async () => {
          throw new Error('kv unavailable');
        }),
      } as unknown as KVNamespace,
    };

    await expect(
      resolveEffectiveSettings(env, 'oauth', { tenantId: 'broken-tenant' })
    ).rejects.toThrow();
  });
});
