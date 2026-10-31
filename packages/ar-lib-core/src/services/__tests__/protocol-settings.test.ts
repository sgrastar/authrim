import { describe, expect, it, vi } from 'vitest';
import { resolveProtocolSettings } from '../protocol-settings';

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

const ALL_SECTIONS = ['fapi', 'oidc', 'security'] as const;

describe('resolveProtocolSettings', () => {
  it('takes the client value, then the tenant value, then the platform value', async () => {
    const env = {
      SETTINGS: kv({
        'settings:client:acme:app:security': { 'security.dpop_required': 'never' },
        'settings:tenant:acme:security': {
          'security.fapi_enabled': true,
          'security.dpop_required': 'always',
        },
        'settings:platform:oauth': { 'oauth.par_default_ttl': 120 },
      }),
    };

    await expect(
      resolveProtocolSettings(env, 'acme', { clientId: 'app', sections: ALL_SECTIONS })
    ).resolves.toEqual({
      fapi: { enabled: true, requireDpop: false },
      oidc: { parExpiry: 120 },
      security: {},
    });
    await expect(
      resolveProtocolSettings(env, 'acme', { sections: ALL_SECTIONS })
    ).resolves.toMatchObject({ fapi: { enabled: true, requireDpop: true } });
  });

  it('leaves out what only env or the default sets, so each caller keeps its own fallback', async () => {
    const env = {
      SETTINGS: kv({}),
      ENABLE_RAR: 'true',
      HTTPS_REQUEST_URI_TIMEOUT_MS: '2500',
    } as Record<string, unknown>;

    await expect(resolveProtocolSettings(env, 'acme', { sections: ALL_SECTIONS })).resolves.toEqual(
      { fapi: {}, oidc: {}, security: {} }
    );
  });

  it('leaves the authorization response algorithms unlimited when the saved list is empty', async () => {
    // What the import saves for a profile that turned message signing on without a list.
    const env = {
      SETTINGS: kv({
        'settings:tenant:acme:security': {
          'security.fapi_message_signing_enabled': true,
          'security.authorization_signing_algs': '',
          'security.default_authorization_signing_alg': 'RS256',
        },
      }),
    };

    await expect(
      resolveProtocolSettings(env, 'acme', { sections: ['fapi'] })
    ).resolves.toMatchObject({
      fapi: { messageSigning: { enabled: true, defaultAuthorizationSigningAlgorithm: 'RS256' } },
    });
    const { fapi } = await resolveProtocolSettings(env, 'acme', { sections: ['fapi'] });
    expect(fapi.messageSigning).not.toHaveProperty('authorizationSigningAlgorithms');
  });

  it('keeps an empty request_uri domain entry, which matches no host, as env did', async () => {
    // What the import saves for a profile that left the domains to HTTPS_REQUEST_URI_ALLOWED_DOMAINS=','.
    const env = {
      SETTINGS: kv({
        'settings:tenant:acme:oauth': { 'oauth.https_request_uri_allowed_domains': ',' },
        'settings:tenant:other:oauth': { 'oauth.https_request_uri_allowed_domains': '' },
      }),
    };

    await expect(
      resolveProtocolSettings(env, 'acme', { sections: ['oidc'] })
    ).resolves.toMatchObject({ oidc: { httpsRequestUri: { allowedDomains: ['', ''] } } });
    await expect(
      resolveProtocolSettings(env, 'other', { sections: ['oidc'] })
    ).resolves.toMatchObject({ oidc: { httpsRequestUri: { allowedDomains: [] } } });
  });

  it('writes saved values in the form runtime reads', async () => {
    const env = {
      SETTINGS: kv({
        'settings:tenant:acme:security': {
          'security.dpop_required': 'with_fapi',
          'security.fapi_message_signing_enabled': true,
          'security.request_object_signing_algs': 'PS256, ES256',
        },
        'settings:tenant:acme:discovery': { 'discovery.claims_supported': '' },
        'settings:tenant:acme:oauth': {
          'oauth.https_request_uri_allowed_domains': 'A.example, b.example',
        },
      }),
    };

    await expect(resolveProtocolSettings(env, 'acme', { sections: ALL_SECTIONS })).resolves.toEqual(
      {
        fapi: {
          messageSigning: { enabled: true, requestObjectSigningAlgorithms: ['PS256', 'ES256'] },
        },
        oidc: { httpsRequestUri: { allowedDomains: ['a.example', 'b.example'] } },
        security: {},
      }
    );
  });

  it('reads only the categories of the sections asked for', async () => {
    const env = {
      SETTINGS: kv({
        'settings:platform:feature-flags': 'not json',
        'settings:tenant:acme:security': { 'security.fapi_enabled': true },
      }),
    };

    await expect(
      resolveProtocolSettings(env, 'acme', { sections: ['fapi'] })
    ).resolves.toMatchObject({ fapi: { enabled: true } });
    await expect(resolveProtocolSettings(env, 'acme', { sections: ['oidc'] })).rejects.toThrow();
    // Single settings: only their categories are read.
    await expect(
      resolveProtocolSettings(env, 'acme', {
        sections: ['fapi'],
        keys: ['security.par_required', 'oauth.par_default_ttl'],
      })
    ).resolves.toEqual({ fapi: { enabled: true }, oidc: {}, security: {} });
    await expect(
      resolveProtocolSettings(env, 'acme', { keys: ['feature.enable_rar'] })
    ).rejects.toThrow();
  });

  it('fails instead of reading as unset when a saved document cannot be read', async () => {
    // The older document is no longer read.
    await expect(
      resolveProtocolSettings({ SETTINGS: kv({ system_settings: 'not json' }) }, 'acme', {
        sections: ['fapi'],
      })
    ).resolves.toEqual({ fapi: {}, oidc: {}, security: {} });
    await expect(
      resolveProtocolSettings(
        { SETTINGS: kv({ 'settings:tenant:acme:security': 'not json' }) },
        'acme',
        {
          sections: ['fapi'],
        }
      )
    ).rejects.toThrow();
    await expect(
      resolveProtocolSettings(
        { SETTINGS: kv({ 'settings:client:acme:app:security': '[]' }) },
        'acme',
        { clientId: 'app', sections: ['fapi'] }
      )
    ).rejects.toThrow();
  });
});
