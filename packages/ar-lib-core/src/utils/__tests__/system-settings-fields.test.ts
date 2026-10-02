import { describe, expect, it, vi } from 'vitest';
import { StoredLegacyValue, systemSettingsFieldValues } from '../system-settings-fields';

import { getConformanceConfig } from '../conformance-config';
import { resolveEffectiveSettings } from '../../services/effective-settings';

const stored = (value: unknown) => new StoredLegacyValue(value);

function kv(values: Record<string, unknown>): KVNamespace {
  return {
    get: vi.fn(async (key: string) =>
      key in values
        ? typeof values[key] === 'string'
          ? (values[key] as string)
          : JSON.stringify(values[key])
        : null
    ),
  } as unknown as KVNamespace;
}

describe('systemSettingsFieldValues', () => {
  it('reads the document values back in Settings API form', () => {
    expect(
      systemSettingsFieldValues(
        {
          oidc: { httpsRequestUri: { enabled: true, allowedDomains: ['a.example', 'b.example'] } },
        },
        'oauth'
      )
    ).toEqual({
      'oauth.https_request_uri_enabled': true,
      'oauth.https_request_uri_allowed_domains': 'a.example,b.example',
    });
  });

  it.each([
    [true, 'always'],
    ['yes', 'always'],
    [false, 'never'],
    [null, undefined],
    [0, undefined],
  ])('reads fapi.requireDpop %j as security.dpop_required %j', (stored, expected) => {
    expect(
      systemSettingsFieldValues({ fapi: { requireDpop: stored } }, 'security')[
        'security.dpop_required'
      ]
    ).toBe(expected);
  });

  it('reads the FAPI and request object fields as runtime applied them', () => {
    expect(
      systemSettingsFieldValues(
        {
          fapi: {
            requirePrivateKeyJwt: null,
            clientAssertionAudience: 'endpoint',
            messageSigning: {
              enabled: 'true',
              requireJarm: 1,
              requestObjectSigningAlgorithms: ['PS256', 'ES256'],
              defaultAuthorizationSigningAlgorithm: '',
              clockSkewSeconds: '5',
            },
          },
          oidc: { requirePar: 'yes', allowNoneAlgorithm: null },
        },
        'security'
      )
    ).toEqual({
      // Required unless false.
      'security.fapi_require_private_key_jwt': true,
      'security.fapi_client_assertion_audience': 'endpoint_or_issuer',
      // Passed on as stored: JARM responses took it for truth, PAR only as true.
      'security.fapi_message_signing_enabled': stored('true'),
      'security.require_jarm': true,
      'security.request_object_signing_algs': 'PS256,ES256',
      'security.par_required': true,
      'security.allow_unsigned_request_object': false,
      // Passed on as stored: jose refused a clock tolerance string without a unit.
      'security.request_object_clock_skew_seconds': stored('5'),
    });
  });

  it('reads a numeric string as the number runtime compared it as', () => {
    expect(
      systemSettingsFieldValues(
        {
          fapi: {
            maxRequestUriExpiry: '90',
            messageSigning: {
              maxRequestObjectAgeSeconds: '60',
              maxRequestObjectLifetimeSeconds: ' 120 ',
            },
          },
          oidc: {
            parExpiry: '300',
            httpsRequestUri: { timeoutMs: '2500', maxSizeBytes: 'lots' },
          },
        },
        'security'
      )
    ).toMatchObject({
      'security.request_object_max_age_seconds': 60,
      'security.request_object_max_lifetime_seconds': 120,
    });
    expect(
      systemSettingsFieldValues(
        {
          fapi: { maxRequestUriExpiry: '90' },
          oidc: {
            parExpiry: '300',
            httpsRequestUri: { timeoutMs: '2500', maxSizeBytes: 'lots' },
          },
        },
        'oauth'
      )
    ).toEqual({
      'oauth.par_fapi_ttl': 60,
      'oauth.par_default_ttl': 300,
      'oauth.https_request_uri_timeout_ms': 2500,
      // Not a number: kept as stored, as runtime used it.
      'oauth.https_request_uri_max_size': stored('lots'),
    });
  });

  it('caps the FAPI request_uri lifetime at 60 seconds and keeps what runtime applied', () => {
    expect(
      systemSettingsFieldValues(
        { fapi: { maxRequestUriExpiry: 90 }, oidc: { parExpiry: 120 } },
        'oauth'
      )
    ).toEqual({ 'oauth.par_fapi_ttl': 60, 'oauth.par_default_ttl': 120 });
    // Falsy: never applied.
    expect(
      systemSettingsFieldValues(
        { fapi: { maxRequestUriExpiry: 0 }, oidc: { parExpiry: '' } },
        'oauth'
      )
    ).toEqual({});
    // Truthy: applied as runtime computed with it, so a request_uri that expired at once still does.
    expect(
      systemSettingsFieldValues(
        { fapi: { maxRequestUriExpiry: -1 }, oidc: { parExpiry: '0' } },
        'oauth'
      )
    ).toEqual({ 'oauth.par_fapi_ttl': -1, 'oauth.par_default_ttl': stored('0') });
    expect(
      systemSettingsFieldValues(
        { fapi: { maxRequestUriExpiry: 'soon' }, oidc: { parExpiry: true } },
        'oauth'
      )
    ).toEqual({ 'oauth.par_fapi_ttl': stored('soon'), 'oauth.par_default_ttl': stored(true) });
  });

  it('leaves the flags runtime took from env to env when the document did not turn them on', () => {
    expect(
      systemSettingsFieldValues(
        {
          oidc: {
            rar: { enabled: null },
            aiScopes: { enabled: false },
            aiEphemeralAuth: { enabled: false },
          },
        },
        'feature-flags'
      )
    ).toEqual({ 'feature.enable_ai_scopes': false });
  });

  it('reads the DPoP nonce choices from the top-level keys first, then the security section', () => {
    expect(
      systemSettingsFieldValues(
        {
          'security.dpop_nonce_enabled': false,
          'security.dpop_nonce_resource_overrides': 'not a map',
          security: {
            dpop_nonce_enabled: true,
            dpop_nonce_resource_overrides: { 'https://api.example': false, other: 'no' },
          },
        },
        'security'
      )
    ).toMatchObject({
      'security.dpop_nonce_enabled': false,
      'security.dpop_nonce_resource_overrides': { 'https://api.example': false },
    });
  });

  it.each([
    [['PS256', 7], 'PS256'],
    [['ES256', ' ES256 ', 'ES256,PS256', 'ES256'], 'ES256'],
    [['HS256', 'RS256'], 'RS256'],
  ])('keeps only the usable algorithms of the list %j: %s', (stored, expected) => {
    const values = systemSettingsFieldValues(
      {
        fapi: {
          messageSigning: {
            requestObjectSigningAlgorithms: stored,
            authorizationSigningAlgorithms: stored,
          },
        },
      },
      'security'
    );
    // Entries runtime never matched are left out, so no algorithm it refused becomes allowed.
    expect(values['security.request_object_signing_algs']).toBe(expected);
    expect(values['security.authorization_signing_algs']).toBe(expected);
  });

  it.each([[['ES256,PS256']], [[' ES256 ']], [[]], [['HS256']], ['ES256']])(
    'keeps an algorithm list %j that refused every algorithm as stored',
    (stored) => {
      const values = systemSettingsFieldValues(
        {
          fapi: {
            messageSigning: {
              requestObjectSigningAlgorithms: stored,
              authorizationSigningAlgorithms: stored,
            },
          },
        },
        'security'
      );
      // No Settings API value refuses every algorithm: the import rejects it.
      expect(values['security.request_object_signing_algs']).toEqual(new StoredLegacyValue(stored));
      expect(values['security.authorization_signing_algs']).toEqual(new StoredLegacyValue(stored));
    }
  );

  it.each([
    [['trusted.example', ''], 'trusted.example'],
    [['Trusted.example', 'b.example', ' c.example', 'a.example,b.example', 7], 'b.example'],
    [[''], ','],
    [['Trusted.example'], ','],
    [['a.example,b.example'], ','],
    [[], ''],
  ])('keeps only the request_uri domains of %j a host could match: %j', (stored, expected) => {
    expect(
      systemSettingsFieldValues({ oidc: { httpsRequestUri: { allowedDomains: stored } } }, 'oauth')[
        'oauth.https_request_uri_allowed_domains'
      ]
    ).toBe(expected);
  });

  it('leaves a request_uri domain value that is not a list to env, as runtime did', () => {
    expect(
      systemSettingsFieldValues(
        { oidc: { httpsRequestUri: { allowedDomains: 'a.example' } } },
        'oauth'
      )
    ).toEqual({});
  });

  it('keeps an empty claims list, which discovery advertised as empty', () => {
    expect(systemSettingsFieldValues({ oidc: { claimsSupported: [] } }, 'discovery')).toEqual({
      'discovery.claims_supported': stored([]),
    });
  });

  it.each([
    ['security.fapi_enabled', { fapi: { enabled: '__DISABLED__' } }],
    ['security.fapi_strict_dpop', { fapi: { strictDPoP: '__LEGACY_UNSET__' } }],
  ])('keeps a stored %s that spells a Settings API marker as stored', (key, document) => {
    const value = systemSettingsFieldValues(document, 'security')[key];
    expect(value).toBeInstanceOf(StoredLegacyValue);
  });

  it.each([
    ['ES256', 'security'],
    [true, 'security'],
  ])('keeps an algorithm value %j that is not a list as stored', (value) => {
    expect(
      systemSettingsFieldValues(
        { fapi: { messageSigning: { requestObjectSigningAlgorithms: value } } },
        'security'
      )['security.request_object_signing_algs']
    ).toEqual(stored(value));
  });

  it.each([true, 123, []])(
    'keeps a truthy default authorization algorithm %j that is not a string as stored',
    (value) => {
      expect(
        systemSettingsFieldValues(
          { fapi: { messageSigning: { defaultAuthorizationSigningAlgorithm: value } } },
          'security'
        )['security.default_authorization_signing_alg']
      ).toEqual(stored(value));
    }
  );

  it('reads the claims discovery advertised as a comma-separated list', () => {
    expect(
      systemSettingsFieldValues({ oidc: { claimsSupported: ['sub', 'email'] } }, 'discovery')
    ).toEqual({ 'discovery.claims_supported': 'sub,email' });
  });
});

describe('getConformanceConfig with Settings API values', () => {
  it('lets the platform value set through the Settings API win', async () => {
    const store = kv({
      system_settings: { conformance: { enabled: true, useBuiltinForms: true } },
      'settings:platform:feature-flags': { 'feature.conformance_enabled': false },
    });

    await expect(getConformanceConfig({ SETTINGS: store })).resolves.toEqual({
      enabled: false,
      useBuiltinForms: true,
    });
  });
  it('ignores conformance values stored for a tenant, which only the platform can set', async () => {
    const store = kv({
      'settings:tenant:acme:feature-flags': { 'feature.conformance_enabled': true },
      'settings:platform:feature-flags': { 'feature.conformance_enabled': false },
    });

    await expect(
      resolveEffectiveSettings({ SETTINGS: store }, 'feature-flags', { tenantId: 'acme' })
    ).resolves.toMatchObject({ 'feature.conformance_enabled': false });
  });

  it('turns built-in forms on when the Settings API enables the mode while env has it off', async () => {
    const store = kv({
      'settings:platform:feature-flags': { 'feature.conformance_enabled': true },
    });

    await expect(
      getConformanceConfig({ SETTINGS: store, ENABLE_CONFORMANCE_MODE: 'false' })
    ).resolves.toEqual({ enabled: true, useBuiltinForms: true });
  });
});

describe('the fallback shown for a section present without the field', () => {
  it('uses the default runtime applies', () => {
    expect(systemSettingsFieldValues({ conformance: {} }, 'feature-flags')).toEqual({
      'feature.conformance_enabled': false,
      'feature.conformance_use_builtin_forms': true,
    });
    expect(systemSettingsFieldValues({}, 'feature-flags')).toEqual({});
  });
});
