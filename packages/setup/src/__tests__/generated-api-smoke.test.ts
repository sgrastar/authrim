import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import {
  buildApiSmokeLoginProtocolBaseUrl,
  buildApiSmokeBaseUrl,
  buildApiSmokeTargets,
  validateAuthorizeInvalidRequestResponse,
  validateDiscoveryPayload,
  validateInvalidRequestPayload,
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
      'oidc-authorize-invalid-request',
      'oidc-login-challenge-invalid-request',
      'login-ui-oidc-authorize-proxy',
      'login-ui-oidc-login-challenge-proxy',
    ]);
  });

  it('resolves the separate Login UI protocol base URL for generated workers', () => {
    const config = createDefaultConfig('single');
    config.urls = {
      api: { custom: null, auto: 'https://single-ar-router.example.workers.dev' },
      loginUi: { custom: null, auto: 'https://single-login.workers.dev', sameAsApi: false },
      adminUi: { custom: null, auto: 'https://single-admin.workers.dev', sameAsApi: false },
    };

    expect(
      buildApiSmokeLoginProtocolBaseUrl(config, 'https://single-ar-router.example.workers.dev')
    ).toBe('https://single-login.workers.dev');
  });

  it('resolves the API origin as Login UI protocol base for same-origin UI', () => {
    const config = createDefaultConfig('single');
    config.urls = {
      api: { custom: null, auto: 'https://single-ar-router.example.workers.dev' },
      loginUi: { custom: null, auto: 'https://single-login.workers.dev', sameAsApi: true },
      adminUi: { custom: null, auto: 'https://single-admin.workers.dev', sameAsApi: false },
    };

    expect(
      buildApiSmokeLoginProtocolBaseUrl(config, 'https://single-ar-router.example.workers.dev')
    ).toBe('https://single-ar-router.example.workers.dev');
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
        device_authorization_endpoint: `${baseUrl}/device_authorization`,
        backchannel_authentication_endpoint: `${baseUrl}/bc-authorize`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      },
      baseUrl,
      config
    );

    expect(failures).toEqual([]);
  });

  it('rejects an empty JWKS payload', () => {
    expect(validateJwksPayload({ keys: [] })).toEqual(['keys is empty']);
  });

  it('accepts a valid login-methods payload', () => {
    expect(
      validateLoginMethodsPayload({
        methods: {
          passkey: { enabled: true, capabilities: [] },
          emailCode: { enabled: true, steps: [] },
          external: { enabled: false, providers: [] },
        },
        ui: {
          branding: { brandName: 'Authrim' },
          supportedLocales: ['en', 'ja'],
        },
        meta: { cacheTTL: 300 },
      })
    ).toEqual([]);
  });

  it('accepts expected invalid_request payloads for browser OIDC helper probes', () => {
    expect(
      validateInvalidRequestPayload({
        error: 'invalid_request',
        error_description: 'Invalid or expired challenge',
      })
    ).toEqual([]);
  });

  it('rejects router 404 bodies for browser OIDC helper probes', () => {
    expect(
      validateAuthorizeInvalidRequestResponse({
        ok: false,
        status: 404,
        contentType: 'application/json',
        bodyText: 'Authrim Router Worker',
      })
    ).toContain('request was handled by router 404 instead of OP_AUTH');
  });
});
