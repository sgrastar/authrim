import { describe, expect, it, vi } from 'vitest';
import { readLegacyStore } from '../legacy-settings';

function kv(values: Record<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
  } as unknown as KVNamespace;
}

describe('the older stores, read for the import', () => {
  it('reads values saved through the older oauth-config under Settings API keys', async () => {
    const env = {
      AUTHRIM_CONFIG: kv({
        'oauth:config:TOKEN_EXPIRY': '900',
        'oauth:config:STATE_REQUIRED': 'true',
        'oauth:config:USERINFO_REQUIRE_OPENID_SCOPE': '0',
      }),
    };

    await expect(readLegacyStore(env, 'AUTHRIM_CONFIG oauth:config:*')).resolves.toEqual({
      'oauth.access_token_expiry': 900,
      'oauth.state_required': true,
      'oauth.userinfo_require_openid': false,
    });
  });

  it('reads the error settings saved through the older error-config API', async () => {
    const env = {
      AUTHRIM_CONFIG: kv({ error_response_format: 'problem_details', error_id_mode: 'verbose' }),
    };

    // A value the error middleware did not know is left out, as the middleware ignored it.
    await expect(readLegacyStore(env, 'AUTHRIM_CONFIG error_*')).resolves.toEqual({
      'oauth.error_response_format': 'problem_details',
    });
  });

  it('reads the Check API audit settings as the Check API read them', async () => {
    const saved = {
      AUTHRIM_CONFIG: kv({
        CHECK_API_AUDIT_ENABLED: 'true',
        CHECK_API_AUDIT_MODE: 'sync',
        CHECK_API_AUDIT_LOG_ALLOW: 'always',
        CHECK_API_AUDIT_SAMPLE_RATE: '0.5',
        CHECK_API_AUDIT_RETENTION_DAYS: '30',
      }),
    };
    await expect(readLegacyStore(saved, 'AUTHRIM_CONFIG CHECK_API_AUDIT_*')).resolves.toEqual({
      'audit.check_api_enabled': true,
      'audit.check_api_mode': 'sync',
      'audit.check_api_log_allow': 'always',
      'audit.check_api_sample_rate': 0.5,
      'audit.check_api_retention_days': 30,
    });

    const unusable = {
      AUTHRIM_CONFIG: kv({
        CHECK_API_AUDIT_ENABLED: 'yes',
        CHECK_API_AUDIT_MODE: 'later',
        CHECK_API_AUDIT_LOG_ALLOW: 'some',
        CHECK_API_AUDIT_SAMPLE_RATE: '2',
        CHECK_API_AUDIT_RETENTION_DAYS: '0',
      }),
    };
    // A switch not 'true' was off; an unknown mode or policy left env to decide; a rate or a
    // retention it could not use kept the default, not env.
    await expect(readLegacyStore(unusable, 'AUTHRIM_CONFIG CHECK_API_AUDIT_*')).resolves.toEqual({
      'audit.check_api_enabled': false,
      'audit.check_api_sample_rate': 0.01,
      'audit.check_api_retention_days': 90,
    });
  });

  it('reads the sign-in defaults of system_settings that differ from the Settings API defaults', async () => {
    const saved = {
      SETTINGS: kv({
        system_settings: JSON.stringify({
          advanced: { passkeyEnabled: false, magicLinkEnabled: true },
          loginUI: { theme: 'dark', variant: 'slate', supportedLocales: ['en'] },
          general: { siteName: 'Example', logoUrl: 'https://example.com/logo.png' },
        }),
      }),
    };
    await expect(readLegacyStore(saved, 'SETTINGS system_settings.advanced')).resolves.toEqual({
      'authentication-methods.passkey.login_enabled': false,
      'authentication-methods.passkey.signup_enabled': false,
      'authentication-methods.passkey.reauth_enabled': false,
      'authentication-methods.passkey.account_link_enabled': false,
      'authentication-methods.email_otp.login_enabled': true,
      'authentication-methods.email_otp.signup_enabled': true,
      'authentication-methods.email_otp.reauth_enabled': true,
      'authentication-methods.email_otp.account_link_enabled': true,
    });
    await expect(readLegacyStore(saved, 'SETTINGS system_settings.loginUI')).resolves.toEqual({
      'login-ui.theme': 'dark',
      // The older colour variant is no longer a setting: it is not imported.
      'login-ui.supported_locales': ['en'],
      'login-ui.brand_name': 'Example',
      'login-ui.logo_url': 'https://example.com/logo.png',
    });

    // The Settings API defaults (passkeys on, email codes off) need nothing.
    const defaults = {
      SETTINGS: kv({
        system_settings: JSON.stringify({
          advanced: { passkeyEnabled: true, magicLinkEnabled: false },
        }),
      }),
    };
    await expect(readLegacyStore(defaults, 'SETTINGS system_settings.advanced')).resolves.toEqual(
      {}
    );
    await expect(readLegacyStore(defaults, 'SETTINGS system_settings.loginUI')).resolves.toEqual(
      {}
    );
    await expect(
      readLegacyStore(
        { SETTINGS: kv({ system_settings: '[]' }) },
        'SETTINGS system_settings.loginUI'
      )
    ).rejects.toThrow();
  });

  it('fails when a value cannot be read, so a store is never taken for an empty one', async () => {
    const env = {
      AUTHRIM_CONFIG: {
        get: vi.fn(async (key: string) => {
          if (key === 'oauth:config:TOKEN_EXPIRY') throw new Error('kv unavailable');
          return null;
        }),
      } as unknown as KVNamespace,
    };

    await expect(readLegacyStore(env, 'AUTHRIM_CONFIG oauth:config:*')).rejects.toThrow();
  });

  it('reads the JIT provisioning document as the bridge used it, as it is', async () => {
    const read = (stored: string | undefined) =>
      readLegacyStore(
        { SETTINGS: kv(stored === undefined ? {} : { jit_provisioning_config: stored }) },
        'SETTINGS jit_provisioning_config'
      );
    await expect(read(undefined)).resolves.toEqual({});
    await expect(
      read(
        JSON.stringify({
          enabled: true,
          require_verified_email: true,
          default_role_id: 'role_member',
          allowed_provider_ids: ['idp-a', 'idp-b'],
        })
      )
    ).resolves.toEqual({
      'external_idp.jit_provisioning_enabled': true,
      'external_idp.jit_require_verified_email': true,
      // Fields left out were off.
      'external_idp.jit_join_all_matching_orgs': false,
      'external_idp.jit_allow_user_without_org': false,
      'external_idp.jit_allow_unverified_domain_mappings': false,
      'external_idp.jit_default_role_id': 'role_member',
      'external_idp.jit_allowed_provider_ids': 'idp-a,idp-b',
    });
    // Without enabled: true the bridge refused JIT; not a JSON object, only that.
    await expect(read(JSON.stringify({ default_role_id: 'r' }))).resolves.toMatchObject({
      'external_idp.jit_provisioning_enabled': false,
      'external_idp.jit_default_role_id': 'r',
    });
    for (const stored of ['[]', '{']) {
      await expect(read(stored)).resolves.toEqual({
        'external_idp.jit_provisioning_enabled': false,
      });
    }
  });

  it('reads the UI base URL, and its paths only with it, as the login redirects used them', async () => {
    const read = (ui: unknown) =>
      readLegacyStore(
        { SETTINGS: kv({ system_settings: JSON.stringify({ ui }) }) },
        'SETTINGS system_settings.ui'
      );

    await expect(
      read({ baseUrl: 'https://login.example.com/', paths: { login: '/sign-in', device: '/d' } })
    ).resolves.toEqual({
      'tenant.ui_base_url': 'https://login.example.com',
      'tenant.ui_login_path': '/sign-in',
      'tenant.ui_device_path': '/d',
    });
    // Without a saved base URL, UI_URL applied with the default paths.
    await expect(read({ paths: { login: '/sign-in' } })).resolves.toEqual({});
  });

  it("reads every rate limit profile's limit and window", async () => {
    const saved = {
      AUTHRIM_CONFIG: kv({
        rate_limit_strict_max_requests: '25',
        rate_limit_strict_window_seconds: '30',
        rate_limit_public_read_max_requests: '900',
        rate_limit_loadtest_window_seconds: '120',
      }),
    };
    await expect(readLegacyStore(saved, 'AUTHRIM_CONFIG rate_limit_*')).resolves.toEqual({
      'rate_limit.strict': 25,
      'rate_limit.strict_window_seconds': 30,
      'rate_limit.public_read': 900,
      'rate_limit.loadtest_window_seconds': 120,
    });

    // A value the rate limiter would not use (not a positive integer) is left out.
    const invalid = { AUTHRIM_CONFIG: kv({ rate_limit_lenient_max_requests: '0' }) };
    await expect(readLegacyStore(invalid, 'AUTHRIM_CONFIG rate_limit_*')).resolves.toEqual({});
  });

  it('reads Token Exchange and introspection values of system_settings as runtime took them', async () => {
    const env = {
      SETTINGS: kv({
        system_settings: JSON.stringify({
          oidc: {
            tokenExchange: {
              enabled: 'yes',
              allowedSubjectTokenTypes: [
                'access_token,jwt',
                ' id_token ',
                'urn:ietf:params:oauth:token-type:jwt',
                'refresh_token',
              ],
              maxResourceParams: 150,
              maxAudienceParams: 5.5,
              idJag: { enabled: false, allowedIssuers: ['https://idp.example.com/t,a'] },
            },
            introspectionValidation: { expectedAudience: null },
            // The retired introspection cache: left in an older document, never imported.
            introspectionCache: { ttlSeconds: 60, enabled: true },
          },
        }),
      }),
    };

    await expect(readLegacyStore(env, 'SETTINGS system_settings (tokens)')).resolves.toEqual({
      // Runtime took it as true only when it was true.
      'tokens.exchange_enabled': false,
      // Runtime matched each entry exactly: only the jwt URN ever matched.
      'tokens.exchange_allowed_subject_token_types': 'jwt',
      // An issuer is kept whole, commas included.
      'tokens.id_jag_allowed_issuers': ['https://idp.example.com/t,a'],
      'tokens.introspection_expected_audience': '',
    });
    // Out of the range runtime took: its default applied (5.5 counted as 5).
    await expect(readLegacyStore(env, 'SETTINGS system_settings (limits)')).resolves.toEqual({
      'limits.token_exchange_max_audience_params': 5,
    });
    // The retired introspection cache left in the document is not imported.
    await expect(readLegacyStore(env, 'SETTINGS system_settings (feature-flags)')).resolves.toEqual(
      {}
    );
  });
});
