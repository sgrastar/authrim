import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import {
  buildApiSmokeBaseUrl,
  buildApiSmokeTargets,
  validateDiscoveryPayload,
  validateJwksPayload,
  validateLoginMethodsPayload,
} from '../core/generated-api-smoke.js';

describe('generated api smoke helpers', () => {
  it('builds issuer base URL from single-tenant generated config', () => {
    const config = createDefaultConfig('single');
    config.urls = {
      api: { custom: null, auto: 'https://single-ar-router.example.workers.dev' },
      loginUi: { custom: null, auto: 'https://single-login.workers.dev', sameAsApi: false },
      adminUi: { custom: null, auto: 'https://single-admin.workers.dev', sameAsApi: false },
    };

    expect(buildApiSmokeBaseUrl(config)).toBe('https://single-ar-router.example.workers.dev');
  });

  it('builds issuer base URL from multi-tenant naked-domain config', () => {
    const config = createDefaultConfig('mt');
    config.tenant.multiTenant = true;
    config.tenant.baseDomain = 'auth.example.com';
    config.tenant.nakedDomain = true;

    expect(buildApiSmokeBaseUrl(config)).toBe('https://auth.example.com');
  });

  it('generates the core public smoke target set', () => {
    const config = createDefaultConfig('single');

    expect(buildApiSmokeTargets(config).map((target) => target.id)).toEqual([
      'router-health',
      'oidc-discovery',
      'jwks',
      'auth-health',
      'login-methods',
    ]);
  });

  it('accepts a valid discovery payload', () => {
    const config = createDefaultConfig('single');
    const baseUrl = 'https://single-ar-router.example.workers.dev';
    const failures = validateDiscoveryPayload(
      {
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        userinfo_endpoint: `${baseUrl}/userinfo`,
        jwks_uri: `${baseUrl}/.well-known/jwks.json`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      },
      baseUrl,
      config
    );

    expect(failures).toEqual([]);
  });

  it('rejects an empty JWKS payload', () => {
    expect(validateJwksPayload({ keys: [] })).toEqual(['keys が空です']);
  });

  it('accepts a valid login-methods payload', () => {
    expect(
      validateLoginMethodsPayload({
        methods: {
          passkey: { enabled: true, capabilities: [] },
          emailCode: { enabled: true, steps: [] },
          social: { enabled: false, providers: [] },
        },
        ui: {
          branding: { brandName: 'Authrim' },
          supportedLocales: ['en', 'ja'],
        },
        meta: { cacheTTL: 300 },
      })
    ).toEqual([]);
  });
});
