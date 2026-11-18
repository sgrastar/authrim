import { describe, expect, it } from 'vitest';
import { clientRowForCreate, type CreateClientInput } from '@authrim/ar-lib-core';
import {
  classifyClientTrustTransition,
  clientTrustDigest,
  clientTrustSettings,
} from '../client-trust';
import {
  clientEnableBlockers,
  requiresClientConfigurationValidation,
} from '../client-configuration';

const client = {
  enabled: false,
  redirect_uris: ['https://app.example/cb'],
  jwks: null,
  scope: 'openid',
};
describe('client trust transitions', () => {
  it.each([
    [undefined, false, {}, 'L0'],
    [undefined, true, {}, 'L2'],
    [false, false, { scope: 'openid email' }, 'L0'],
    [false, true, {}, 'L2'],
    [true, true, { scope: 'openid email' }, 'L2'],
    [true, true, { client_name: 'Rename' }, 'L0'],
    [true, false, {}, 'L1'],
    [true, false, { scope: 'openid email' }, 'L2'],
    ...[
      'post_logout_redirect_uris',
      'frontchannel_logout_uri',
      'backchannel_logout_uri',
      'frontchannel_logout_session_required',
      'backchannel_logout_session_required',
    ].map((field) => [false, false, { [field]: true }, 'L2']),
  ] as Array<[boolean | undefined, boolean, Record<string, unknown>, string]>)(
    '%s → %s with %j is %s',
    (before, enabled, patch, level) => {
      expect(
        classifyClientTrustTransition({
          before: before === undefined ? undefined : { ...client, enabled: before },
          after: { ...client, enabled, ...(patch as object) },
        })
      ).toBe(level);
    }
  );
  it('preserves null versus empty arrays and redirect order while ignoring JWKS property order', () => {
    const classify = (before: object, after: object) =>
      classifyClientTrustTransition({
        before: { ...client, enabled: true, ...before },
        after: { ...client, enabled: true, ...after },
      });
    expect(classify({ post_logout_redirect_uris: null }, { post_logout_redirect_uris: [] })).toBe(
      'L2'
    );
    expect(classify({ redirect_uris: ['a', 'b'] }, { redirect_uris: ['b', 'a'] })).toBe('L2');
    expect(
      classify(
        { jwks: '{"keys":[{"kid":"a","kty":"RSA"}]}' },
        { jwks: { keys: [{ kty: 'RSA', kid: 'a' }] } }
      )
    ).toBe('L0');
  });
  it.each([
    'scope',
    'default_scope',
    'default_audience',
    'default_resource',
    'future_security_policy',
  ])('compares and hashes JSON-looking %s as a scalar string', async (field) => {
    for (const [beforeValue, afterValue] of [
      ['["read"]', '[ "read" ]'],
      ['{"scope":"read"}', '{ "scope": "read" }'],
    ]) {
      const before = { ...client, enabled: true, [field]: beforeValue };
      const after = { ...before, [field]: afterValue };
      expect(clientTrustSettings(before)[field]).toBe(beforeValue);
      expect(classifyClientTrustTransition({ before, after })).toBe('L2');
      expect(await clientTrustDigest(clientTrustSettings(before))).not.toBe(
        await clientTrustDigest(clientTrustSettings(after))
      );
    }
  });
  it('decodes the JSON fields serialized by ClientRepository without changing trust', async () => {
    const input = {
      client_name: 'App',
      redirect_uris: ['https://app.example/cb'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      contacts: ['admin@example.test'],
      post_logout_redirect_uris: ['https://app.example/logout'],
      jwks: { keys: [{ kid: 'a', kty: 'RSA' }] },
      claims_parameter_policy: { email: 'scope_required' },
      identity_mapping: { fieldMappingSetId: 'mapping' },
      information_release_consent: {
        enabled: true,
        ask: 'once',
        show_values: true,
        purpose_statement_id: null,
      },
      asc_allowed_transformed_claims: ['email'],
      allowed_subject_token_clients: ['other'],
      allowed_token_exchange_resources: ['https://api.example'],
      allowed_scopes: ['read'],
      requestable_scopes: ['read'],
      allowed_redirect_origins: ['https://app.example'],
      allowed_channels: ['browser'],
      device_secret_revoke_trust_groups: ['group'],
      device_secret_introspection_trust_groups: ['group'],
    } satisfies CreateClientInput;
    const stored = clientRowForCreate(input, 'tenant-a', 'app', 1000);
    const decoded = { ...stored, ...input };
    expect(clientTrustSettings(stored)).toEqual(clientTrustSettings(decoded));
    expect(classifyClientTrustTransition({ before: { ...stored }, after: decoded })).toBe('L0');
    expect(await clientTrustDigest(clientTrustSettings(stored))).toBe(
      await clientTrustDigest(clientTrustSettings(decoded))
    );
  });
  it('preserves malformed JSON column values for comparison', () => {
    expect(clientTrustSettings({ jwks: '[malformed' })).toEqual({ jwks: '[malformed' });
  });
  it('binds every non-display setting, including previously unknown extensions', () => {
    expect(
      classifyClientTrustTransition({
        before: { ...client, enabled: true },
        after: { ...client, enabled: true, future_security_policy: 'changed' },
      })
    ).toBe('L2');
  });
  it('hashes canonical objects but keeps key array order and excludes display settings', async () => {
    expect(await clientTrustDigest({ b: 2, a: 1 })).toBe(await clientTrustDigest({ a: 1, b: 2 }));
    expect(await clientTrustDigest({ keys: ['a', 'b'] })).not.toBe(
      await clientTrustDigest({ keys: ['b', 'a'] })
    );
    expect(
      clientTrustSettings({
        client_name: 'Name',
        description: 'Note',
        enabled: true,
        scope: 'openid',
      })
    ).toEqual({ scope: 'openid' });
  });
});
describe('effective enabled configuration', () => {
  it.each([
    [true, 'L0', false],
    [true, 'L1', false],
    [true, 'L2', true],
    [false, 'L0', false],
    [false, 'L1', false],
    [false, 'L2', false],
  ] as const)('validates enabled=%s at %s: %s', (enabled, level, expected) => {
    expect(requiresClientConfigurationValidation(enabled, level)).toBe(expected);
  });
  const complete = {
    redirect_uris: ['https://app.example/cb'],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    require_pkce: true,
  };
  it('reports missing callbacks, signing keys, secret hashes and PKCE without secret values', () => {
    expect(clientEnableBlockers({ ...complete, redirect_uris: [], require_pkce: false })).toEqual([
      'redirect_uris',
      'require_pkce',
    ]);
    expect(
      clientEnableBlockers({ ...complete, token_endpoint_auth_method: 'private_key_jwt' })
    ).toEqual(['jwks']);
    expect(
      clientEnableBlockers({ ...complete, token_endpoint_auth_method: 'client_secret_basic' })
    ).toEqual(['client_secret']);
  });
  it('allows CIBA polling without redirects and requires notification only for ping/push', () => {
    const ciba = {
      redirect_uris: [],
      grant_types: ['urn:openid:params:grant-type:ciba'],
      response_types: [],
      token_endpoint_auth_method: 'client_secret_basic',
      client_secret_hash: 'synthetic-hash',
      backchannel_token_delivery_mode: 'poll',
    };
    expect(clientEnableBlockers(ciba)).toEqual([]);
    expect(clientEnableBlockers({ ...ciba, token_endpoint_auth_method: 'none' })).toEqual([
      'token_endpoint_auth_method',
    ]);
    expect(clientEnableBlockers({ ...ciba, backchannel_token_delivery_mode: 'ping' })).toEqual([
      'backchannel_client_notification_endpoint',
    ]);
  });
});
