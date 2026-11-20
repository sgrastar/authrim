import { describe, expect, it } from 'vitest';
import { canonicalizeJson, type JsonObject, type JsonValue } from '../core';
import { CLOUDFLARE_ADMIN_WRITE_ROUTES } from '../platform/cloudflare/admin-write-routes';

const context = { tenantId: 'tenant-1' };

function route(operation: string) {
  const value = CLOUDFLARE_ADMIN_WRITE_ROUTES[operation];
  if (!value) throw new Error(`missing route ${operation}`);
  return value;
}

function path(operation: string, input: JsonObject = {}): string {
  const value = route(operation).path;
  return typeof value === 'function' ? value(input, context) : value;
}

function body(operation: string, input: JsonObject): JsonValue {
  const builder = route(operation).body;
  if (!builder) throw new Error('missing body');
  return builder(input);
}

const VERSION = 'etag-0123456789abcdef';

describe('admin write routes: tenant settings patches', () => {
  it('maps each settings operation to its tenant path with PATCH', () => {
    const expected: Record<string, string> = {
      'admin.write.assurance.update': 'assurance',
      'admin.write.protocol-security.update': 'security',
      'admin.write.token-exchange.update': 'tokens',
      'admin.write.oauth.update': 'oauth',
      'admin.write.session.update': 'session',
      'admin.write.login-ui.update': 'login-ui',
    };
    for (const [operation, category] of Object.entries(expected)) {
      expect(route(operation).method).toBe('PATCH');
      expect(path(operation)).toBe(`/api/admin/tenants/tenant-1/settings/${category}`);
    }
    expect(() =>
      (
        route('admin.write.oauth.update').path as (i: JsonObject, c: { tenantId: string }) => string
      )({}, { tenantId: 'bad/tenant' })
    ).toThrow(new TypeError('Invalid tenant_id'));
  });

  it('maps every assurance field and canonicalizes JSON-valued mappings', () => {
    const mapping = { b: 'x', a: ['y'] };
    expect(
      body('admin.write.assurance.update', {
        resource_version: 'v1',
        enabled: true,
        defaultAAL: 'aal2',
        defaultFAL: 'fal1',
        defaultIAL: 'ial1',
        scopeAALRequirements: mapping,
        upstreamAcrMappings: mapping,
        outboundAcrMappings: mapping,
        includeInIdToken: true,
        includeInAccessToken: false,
        fal2RequiresDPoP: true,
        fal3RequiresPAR: false,
        unknownField: 'ignored',
      })
    ).toEqual({
      ifMatch: 'v1',
      set: {
        'assurance.enabled': true,
        'assurance.default_aal': 'aal2',
        'assurance.default_fal': 'fal1',
        'assurance.default_ial': 'ial1',
        'assurance.scope_aal_requirements': canonicalizeJson(mapping),
        'assurance.upstream_acr_mappings': canonicalizeJson(mapping),
        'assurance.outbound_acr_mappings': canonicalizeJson(mapping),
        'assurance.include_in_id_token': true,
        'assurance.include_in_access_token': false,
        'assurance.fal2_requires_dpop': true,
        'assurance.fal3_requires_par': false,
      },
    });
    expect(canonicalizeJson(mapping)).toBe('{"a":["y"],"b":"x"}');
  });

  it('omits absent fields but keeps explicit null and false values', () => {
    expect(
      body('admin.write.token-exchange.update', {
        resource_version: 'v2',
        enabled: false,
        impersonationEnabled: null,
      })
    ).toEqual({
      ifMatch: 'v2',
      set: { 'tokens.exchange_enabled': false, 'tokens.exchange_impersonation_enabled': null },
    });
    expect(
      body('admin.write.token-exchange.update', { resource_version: 'v2', delegationEnabled: true })
    ).toEqual({ ifMatch: 'v2', set: { 'tokens.exchange_delegation_enabled': true } });
  });

  it('maps oauth, session and login-ui fields exactly', () => {
    expect(
      body('admin.write.oauth.update', {
        resource_version: 'v',
        accessTokenExpiry: 1,
        idTokenExpiry: 2,
        authCodeTtl: 3,
        stateRequired: true,
        refreshTokenRotation: false,
        offlineAccessRequired: true,
      })
    ).toEqual({
      ifMatch: 'v',
      set: {
        'oauth.access_token_expiry': 1,
        'oauth.id_token_expiry': 2,
        'oauth.auth_code_ttl': 3,
        'oauth.state_required': true,
        'oauth.refresh_token_rotation': false,
        'oauth.offline_access_required': true,
      },
    });
    expect(
      body('admin.write.session.update', {
        resource_version: 'v',
        defaultTtl: 10,
        maxTtl: 20,
        refreshDefault: true,
        backchannelLogoutTokenExp: 30,
        backchannelOnFailure: 'ignore',
      })
    ).toEqual({
      ifMatch: 'v',
      set: {
        'session.default_ttl': 10,
        'session.max_ttl': 20,
        'session.refresh_default': true,
        'session.backchannel_logout_token_exp': 30,
        'session.backchannel_on_failure': 'ignore',
      },
    });
    expect(
      body('admin.write.login-ui.update', {
        resource_version: 'v',
        brandName: 'Acme',
        logoUrl: 'https://acme.example/logo.png',
        supportedLocales: ['en', 'ja'],
      })
    ).toEqual({
      ifMatch: 'v',
      set: {
        'login-ui.brand_name': 'Acme',
        'login-ui.logo_url': 'https://acme.example/logo.png',
        'login-ui.supported_locales': 'en,ja',
      },
    });
    expect(
      body('admin.write.login-ui.update', { resource_version: 'v', supportedLocales: 'en' })
    ).toEqual({ ifMatch: 'v', set: { 'login-ui.supported_locales': 'en' } });
  });

  it('flattens fapi settings and rejects non-object fapi values', () => {
    expect(
      body('admin.write.protocol-security.update', {
        resource_version: 'v3',
        fapi: { enabled: true, strictDPoP: false, allowPublicClients: true, other: 1 },
      })
    ).toEqual({
      ifMatch: 'v3',
      set: {
        'security.fapi_enabled': true,
        'security.fapi_strict_dpop': false,
        'security.fapi_allow_public_clients': true,
      },
    });
    for (const fapi of [undefined, null, [], 'on', true]) {
      expect(() =>
        body('admin.write.protocol-security.update', {
          resource_version: 'v3',
          fapi: fapi as JsonValue,
        })
      ).toThrow(new TypeError('Invalid fapi settings'));
    }
  });

  it('requires a well-formed resource_version for settings patches', () => {
    for (const resource_version of [undefined, '', 'a b', 'x'.repeat(129), ' v1', 'v1 ', 5]) {
      expect(() =>
        body('admin.write.session.update', {
          resource_version: resource_version as JsonValue,
          defaultTtl: 1,
        })
      ).toThrow(new TypeError('Invalid resource_version'));
    }
    expect(body('admin.write.session.update', { resource_version: 'x'.repeat(128) })).toEqual({
      ifMatch: 'x'.repeat(128),
      set: {},
    });
  });
});

describe('admin write routes: client and user writes', () => {
  it('builds client metadata writes with a strict if-match header', () => {
    const metadata = route('admin.write.clients.metadata');
    expect(metadata.method).toBe('PUT');
    expect(path('admin.write.clients.metadata', { client_id: 'client-1' })).toBe(
      '/api/admin/agent-write/clients/client-1/metadata'
    );
    expect(
      metadata.body?.({ client_id: 'client-1', resource_version: VERSION, client_name: 'App' })
    ).toEqual({ client_name: 'App' });
    expect(metadata.headers?.({ resource_version: VERSION })).toEqual({ 'if-match': VERSION });
    expect(metadata.headers?.({ resource_version: 'a'.repeat(128) })).toEqual({
      'if-match': 'a'.repeat(128),
    });
    for (const resource_version of [
      undefined,
      1234567890123456,
      'a'.repeat(15),
      'a'.repeat(129),
      `${'a'.repeat(16)}.`,
      `.${'a'.repeat(16)}`,
      `${'a'.repeat(8)}~${'a'.repeat(8)}`,
    ]) {
      expect(
        () => metadata.headers?.({ resource_version: resource_version as JsonValue }),
        String(resource_version)
      ).toThrow(new TypeError('Invalid resource_version'));
    }
  });

  it('projects client metadata write responses to the public contract', () => {
    const respond = route('admin.write.clients.metadata').response;
    if (!respond) throw new Error('missing response');
    expect(
      respond({
        client: {
          client_id: 'client-1',
          client_name: 'App',
          description: 'Desc',
          logo_uri: 'https://a.example/l.png',
          client_uri: 'https://a.example',
          client_secret: 'never',
          redirect_uris: ['https://a.example/cb'],
          updated_at: 10,
        },
        extra: true,
      })
    ).toEqual({
      client: {
        client_id: 'client-1',
        client_name: 'App',
        description: 'Desc',
        logo_uri: 'https://a.example/l.png',
        client_uri: 'https://a.example',
        updated_at: 10,
      },
    });
    expect(respond({ client: { client_id: 'client-1', client_name: 5, updated_at: 1.5 } })).toEqual(
      { client: { client_id: 'client-1' } }
    );
    expect(respond({ client: { client_id: 'client-1', updated_at: '10' } })).toEqual({
      client: { client_id: 'client-1' },
    });
    for (const passthrough of [
      null,
      'text',
      [1],
      { other: 1 },
      { client: [1] },
      { client: { client_id: 7, client_secret: 's' } },
    ] as JsonValue[]) {
      expect(respond(passthrough)).toEqual(passthrough);
    }
  });

  it('builds protocol-security and suspend writes without path-only fields', () => {
    const protocol = route('admin.write.clients.protocol-security');
    expect(protocol.method).toBe('PUT');
    expect(path('admin.write.clients.protocol-security', { client_id: 'c.1' })).toBe(
      '/api/admin/agent-write/clients/c.1/protocol-security'
    );
    expect(protocol.body?.({ client_id: 'c', resource_version: 'v', require_dpop: true })).toEqual({
      require_dpop: true,
    });
    expect(protocol.headers?.({ resource_version: 'v.1' })).toEqual({ 'if-match': 'v.1' });
    expect(() => protocol.headers?.({})).toThrow(new TypeError('Invalid resource_version'));

    const suspend = route('admin.write.users.suspend');
    expect(suspend.method).toBe('POST');
    expect(path('admin.write.users.suspend', { user_id: 'user-1' })).toBe(
      '/api/admin/agent-write/users/user-1/suspend'
    );
    expect(suspend.body?.({ user_id: 'user-1', reason_code: 'x' })).toEqual({ reason_code: 'x' });
    expect(() => path('admin.write.users.suspend', { user_id: 7 })).toThrow(
      new TypeError('Invalid user_id')
    );
    expect(() => path('admin.write.clients.metadata', { client_id: 'a/b' })).toThrow(
      new TypeError('Invalid client_id')
    );
  });

  it('forces a safe public client profile regardless of caller input', () => {
    const create = route('admin.write.clients.public-create');
    expect(create.method).toBe('POST');
    expect(create.path).toBe('/api/admin/agent-write/clients/public');
    expect(
      create.body?.({
        client_name: 'Public',
        grant_types: ['client_credentials'],
        token_endpoint_auth_method: 'client_secret_basic',
        is_trusted: true,
        skip_consent: true,
      })
    ).toEqual({
      client_name: 'Public',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      client_credentials_allowed: false,
      token_exchange_allowed: false,
      is_trusted: false,
      skip_consent: false,
    });
  });
});
