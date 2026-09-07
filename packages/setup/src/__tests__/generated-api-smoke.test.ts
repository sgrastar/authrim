import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import {
  buildApiSmokeLoginProtocolBaseUrl,
  buildApiSmokeBaseUrl,
  buildApiSmokeTargets,
  validateAuthHealthPayload,
  validateAuthorizeInvalidRequestResponse,
  validateDiscoveryPayload,
  validateInvalidRequestPayload,
  validateJwksPayload,
  validateRouterHealthPayload,
  validateAuthenticationMethodsPayload,
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
      'authentication-methods',
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

  it('accepts a valid authentication-methods payload', () => {
    expect(
      validateAuthenticationMethodsPayload({
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

  it('reports every malformed router and auth health field', () => {
    expect(validateRouterHealthPayload(null)).toEqual(['payload is not an object']);
    expect(validateRouterHealthPayload({ status: 'down', service: 'wrong' })).toEqual([
      'status expected=ok actual=down',
      'service expected=authrim-router actual=wrong',
    ]);
    expect(validateAuthHealthPayload([])).toEqual(['payload is not an object']);
    expect(validateAuthHealthPayload({ status: 503, service: null })).toEqual([
      'status expected=ok actual=503',
      'service expected=ar-auth actual=null',
    ]);
  });

  it('reports discovery contract drift including async endpoints', () => {
    const config = createDefaultConfig('single');
    const failures = validateDiscoveryPayload(
      {
        issuer: 'wrong',
        response_types_supported: 'code',
        grant_types_supported: null,
        device_authorization_endpoint: 'wrong',
        backchannel_authentication_endpoint: 'wrong',
      },
      'https://issuer.test',
      config
    );
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('issuer expected='),
        'response_types_supported is not an array',
        'grant_types_supported is not an array',
        expect.stringContaining('device_authorization_endpoint expected='),
        expect.stringContaining('backchannel_authentication_endpoint expected='),
      ])
    );
    config.components.async = false;
    expect(
      validateDiscoveryPayload(
        {
          issuer: 'https://issuer.test',
          authorization_endpoint: 'https://issuer.test/authorize',
          token_endpoint: 'https://issuer.test/token',
          userinfo_endpoint: 'https://issuer.test/userinfo',
          jwks_uri: 'https://issuer.test/.well-known/jwks.json',
          registration_endpoint: 'https://issuer.test/register',
          response_types_supported: [],
          grant_types_supported: [],
        },
        'https://issuer.test',
        config
      )
    ).toEqual([]);
  });

  it('validates all structural JWKS failure modes', () => {
    expect(validateJwksPayload(null)).toEqual(['payload is not an object']);
    expect(validateJwksPayload({ keys: 'invalid' })).toEqual(['keys is not an array']);
    expect(validateJwksPayload({ keys: [null] })).toEqual(['keys[0] is not an object']);
    expect(validateJwksPayload({ keys: [{}] })).toEqual([
      'keys[0].kid is missing',
      'keys[0].kty is missing',
    ]);
    expect(validateJwksPayload({ keys: [{ kid: 'key-1', kty: 'RSA' }] })).toEqual([]);
  });

  it('reports malformed authentication-methods sections independently', () => {
    expect(validateAuthenticationMethodsPayload(null)).toEqual(['payload is not an object']);
    expect(validateAuthenticationMethodsPayload({ methods: null, ui: null, meta: null })).toEqual([
      'methods is not an object',
      'ui is not an object',
      'meta.cacheTTL is invalid',
    ]);
    expect(
      validateAuthenticationMethodsPayload({
        methods: { passkey: {}, emailCode: false, external: { providers: 'none' } },
        ui: { branding: {}, supportedLocales: 'en' },
        meta: { cacheTTL: '300' },
      })
    ).toEqual([
      'methods.passkey.enabled is invalid',
      'methods.emailCode.enabled is invalid',
      'methods.external.providers is invalid',
      'ui.branding.brandName is invalid',
      'ui.supportedLocales is not an array',
      'meta.cacheTTL is invalid',
    ]);
  });

  it('reports invalid-request payload and browser response omissions', () => {
    expect(validateInvalidRequestPayload([])).toEqual(['payload is not an object']);
    expect(validateInvalidRequestPayload({ error: 'server_error' })).toEqual([
      'error expected=invalid_request actual=server_error',
      'error_description is missing',
    ]);
    expect(
      validateAuthorizeInvalidRequestResponse({
        ok: false,
        status: 400,
        contentType: 'text/plain',
      })
    ).toEqual([
      'body does not include invalid_request',
      'body does not include response_type is required',
    ]);
    expect(
      validateAuthorizeInvalidRequestResponse({
        ok: false,
        status: 400,
        contentType: 'text/plain',
        bodyText: 'invalid_request: response_type is required',
      })
    ).toEqual([]);
  });
});
