import { describe, expect, it, vi } from 'vitest';
import { resolveEffectiveSettings } from '../effective-settings';

function kv(values: Record<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
  } as unknown as KVNamespace;
}

describe('resolveEffectiveSettings', () => {
  it('takes client, then tenant, then the platform, then env, then the default', async () => {
    const env = {
      SETTINGS: kv({
        'settings:tenant:acme:oauth': JSON.stringify({ 'oauth.refresh_token_expiry': 86400 }),
        'settings:client:acme:app:oauth': JSON.stringify({ 'oauth.access_token_expiry': 300 }),
        'settings:platform:oauth': JSON.stringify({
          'oauth.access_token_expiry': 900,
          'oauth.refresh_token_expiry': 172800,
          'oauth.auth_code_ttl': 120,
        }),
      }),
      // The older stores are no longer read at runtime.
      AUTHRIM_CONFIG: kv({ 'oauth:config:STATE_REQUIRED': 'false' }),
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

  it('lets the platform set the re-authentication window but not the account page placement', async () => {
    const env = {
      SETTINGS: kv({
        'settings:platform:self-service': JSON.stringify({
          'self-service.reauth_ttl_seconds': 120,
          'self-service.account_page_path': '/platform-account',
        }),
      }),
    };

    const values = await resolveEffectiveSettings(env, 'self-service', { tenantId: 'acme' });

    expect(values['self-service.reauth_ttl_seconds']).toBe(120);
    // Tenant-only: a value stored at the platform is ignored.
    expect(values['self-service.account_page_path']).toBe('/account');
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
