/**
 * Admin API for external providers: the exact refusals, the secret handling and the field-by-field
 * update, with the error answer made visible (its code and variables).
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { argRec, rec } from './helpers/mock-args';
import { GITHUB_DEFAULT_CONFIG } from '../providers/github';
import { FACEBOOK_DEFAULT_CONFIG } from '../providers/facebook';
import { TWITTER_DEFAULT_CONFIG } from '../providers/twitter';

const m = vi.hoisted(() => ({
  getProvider: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  moduleNames: [] as string[],
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-a',
  createErrorResponse: (
    c: { json: (b: unknown, s: number) => Response },
    code: string,
    options?: unknown
  ) => c.json({ code, options }, 400),
  getLogger: () => ({
    module: (name: string) => {
      m.moduleNames.push(name);
      return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    },
  }),
}));
vi.mock('../services/provider-store', () => ({
  listAllProviders: vi.fn(),
  getProvider: m.getProvider,
  createProvider: m.createProvider,
  updateProvider: m.updateProvider,
  deleteProvider: m.deleteProvider,
}));
vi.mock('../services/dynamic-registration', () => ({ ensureDynamicClientRegistration: vi.fn() }));
vi.mock('../utils/crypto', () => ({
  encrypt: vi.fn(async (value: string) => `enc(${value})`),
  getEncryptionKey: vi.fn(() => 'key'),
}));

import {
  handleAdminCreateProvider,
  handleAdminDeleteProvider,
  handleAdminGetProvider,
  handleAdminListProviders,
  handleAdminUpdateProvider,
} from '../admin/providers';

function send(
  method: string,
  path: string,
  body?: unknown,
  adminAuth: unknown = { permissions: ['*'] },
  env: Record<string, unknown> = {}
) {
  const app = new Hono<{ Bindings: Env; Variables: { adminAuth?: unknown } }>();
  app.use('*', async (c, next) => {
    if (adminAuth) c.set('adminAuth', adminAuth);
    await next();
  });
  app.get('/providers', handleAdminListProviders);
  app.post('/providers', handleAdminCreateProvider);
  app.get('/providers/:id', handleAdminGetProvider);
  app.put('/providers/:id', handleAdminUpdateProvider);
  app.delete('/providers/:id', handleAdminDeleteProvider);
  return Promise.resolve(
    app.request(
      `https://admin.example.com${path}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env as unknown as Env
    )
  );
}

const BASE = { name: 'Corp', client_id: 'cid', client_secret: 'csecret' };
const post = (extra: Record<string, unknown> = {}, env: Record<string, unknown> = {}) =>
  send('POST', '/providers', { ...BASE, ...extra }, { permissions: ['*'] }, env);
const put = (body: Record<string, unknown>) => send('PUT', '/providers/prov-1', body);
const created = () => argRec(m.createProvider, m.createProvider.mock.calls.length - 1, 1);
const updated = () => argRec(m.updateProvider, m.updateProvider.mock.calls.length - 1, 3);
const refusal = async (response: Response) => {
  expect(response.status).toBe(400);
  return rec(await response.json());
};

beforeEach(() => {
  vi.clearAllMocks();
  m.moduleNames.length = 0;
  m.getProvider.mockResolvedValue({ id: 'prov-1', providerQuirks: {}, updatedAt: 1 });
  m.createProvider.mockImplementation(async (_e: unknown, input: Record<string, unknown>) => ({
    ...input,
    id: 'prov-new',
  }));
  m.updateProvider.mockResolvedValue({ id: 'prov-1' });
  m.deleteProvider.mockResolvedValue(true);
});

describe('permissions and logging', () => {
  it('refuses an admin whose permissions are missing', async () => {
    expect((await send('GET', '/providers', undefined, {})).status).toBe(400);
    expect(m.createProvider).not.toHaveBeenCalled();
  });

  it('logs every handler under ADMIN-PROVIDERS', async () => {
    await post();
    await put({});
    await send('DELETE', '/providers/prov-1');
    await send('GET', '/providers/prov-1');
    await send('GET', '/providers');
    expect(m.moduleNames.length).toBeGreaterThanOrEqual(5);
    expect(new Set(m.moduleNames)).toEqual(new Set(['ADMIN-PROVIDERS']));
  });

  it('looks the provider up by the id of the path', async () => {
    await send('GET', '/providers/prov-9');
    expect(m.getProvider).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'prov-9');
    await send('DELETE', '/providers/prov-9');
    expect(m.deleteProvider).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'prov-9');
  });
});

describe('what a refusal names', () => {
  it('names the inbound mapping, the required fields and the unusable profile fields', async () => {
    expect(
      await refusal(await post({ provider_quirks: { inboundIdentityMapping: {} } }))
    ).toMatchObject({
      options: { variables: { field: 'provider_quirks.inboundIdentityMapping' } },
    });
    expect(await refusal(await post({ name: '' }))).toMatchObject({
      options: { variables: { field: 'name, client_id, client_secret' } },
    });
    const profile = await refusal(await post({ profile_update_fields: ['email'] }));
    expect(rec(rec(profile.options).variables).field).toBe('profile_update_fields');
    expect(typeof rec(rec(profile.options).variables).reason).toBe('string');
  });

  it.each([
    ['issuer', 'http://idp.example.com'],
    ['authorization_endpoint', 'http://127.0.0.1/a'],
    ['token_endpoint', 'https://169.254.169.254/t'],
    ['userinfo_endpoint', 'ftp://idp.example.com/u'],
    ['jwks_uri', 'https://localhost/jwks'],
  ])('names the unsafe %s on create and on update', async (field, value) => {
    const expected = {
      options: { variables: { field, reason: 'must be an external HTTPS URL' } },
    };
    expect(await refusal(await post({ [field]: value }))).toMatchObject(expected);
    expect(await refusal(await put({ [field]: value }))).toMatchObject(expected);
    const notText = { options: { variables: { field, reason: 'must be a string' } } };
    expect(await refusal(await post({ [field]: 5 }))).toMatchObject(notText);
    expect(await refusal(await put({ [field]: 5 }))).toMatchObject(notText);
  });

  it('accepts an empty or null URL as absent, and a local one only in development', async () => {
    for (const value of ['', null]) {
      expect((await post({ issuer: value })).status).toBe(201);
      expect((await put({ issuer: value })).status).toBe(200);
    }
    expect((await post({ issuer: 'https://localhost/x' })).status).toBe(400);
    expect(
      (await post({ issuer: 'https://localhost/x' }, { ENVIRONMENT: 'development' })).status
    ).toBe(201);
    expect(
      (await post({ issuer: 'https://localhost/x' }, { ENVIRONMENT: 'production' })).status
    ).toBe(400);
  });

  it.each([
    ['always_fetch_userinfo', 'yes'],
    ['enable_sso', 1],
    ['jit_provisioning', 'true'],
    ['trust_email', 'true'],
    ['priority', 1.5],
    ['priority', 100001],
    ['priority', -100001],
    ['expected_updated_at', -1],
    ['expected_updated_at', '1'],
    ['token_endpoint_auth_method', 'private_key_jwt'],
    ['button_text', 'x'.repeat(257)],
    ['button_text', 5],
    ['button_color', '#12345'],
    ['button_color', '#1234567'],
    ['button_color', 'x#123456'],
    ['button_color', '#12345g'],
    ['button_color', 5],
  ])('names %s when its value %j is out of bounds', async (key, value) => {
    expect(await refusal(await put({ [key]: value }))).toMatchObject({
      options: { variables: { field: key } },
    });
    expect(m.updateProvider).not.toHaveBeenCalled();
  });

  it('accepts the bounds themselves', async () => {
    const response = await put({
      priority: 100000,
      expected_updated_at: 1,
      button_text: 'x'.repeat(256),
      button_color: '#aBc123',
      token_endpoint_auth_method: 'client_secret_basic',
      trust_email: true,
    });
    expect(response.status).toBe(200);
    expect((await put({ priority: -100000 })).status).toBe(200);
  });

  it('names client supplied encrypted secrets on create and on update', async () => {
    const expected = {
      options: {
        variables: {
          field: 'provider_quirks encrypted secret',
          reason: 'encrypted secret fields cannot be supplied through this API',
        },
      },
    };
    const quirks = { dynamicClientRegistration: { initialAccessTokenEncrypted: 'x' } };
    expect(await refusal(await post({ provider_quirks: quirks }))).toMatchObject(expected);
    expect(await refusal(await put({ provider_quirks: quirks }))).toMatchObject(expected);
  });

  it.each([
    [
      'a dynamic registration list',
      { dynamicClientRegistration: [{ initialAccessTokenEncrypted: 'x' }] },
    ],
    ['a dynamic registration text', { dynamicClientRegistration: 'initialAccessTokenEncrypted' }],
    ['a fapi2 list', { fapi2: [{ dpopPrivateJwkEncrypted: 'x' }] }],
    ['fapi2 text', { fapi2: 'x' }],
    ['null values', { dynamicClientRegistration: null, fapi2: null }],
  ])('does not take %s for a supplied secret', async (_n, quirks) => {
    expect((await post({ provider_quirks: quirks })).status).toBe(201);
    expect((await put({ provider_quirks: quirks })).status).toBe(200);
  });

  it('refuses either encrypted FAPI field alone', async () => {
    for (const field of ['clientAssertionPrivateJwkEncrypted', 'dpopPrivateJwkEncrypted']) {
      expect((await post({ provider_quirks: { fapi2: { [field]: 'x' } } })).status).toBe(400);
      expect((await put({ provider_quirks: { fapi2: { [field]: 'x' } } })).status).toBe(400);
    }
  });
});

describe('the update, field by field', () => {
  it('carries nothing that was not sent, not even as undefined', async () => {
    await put({});
    expect(Object.keys(updated())).toEqual([]);
  });

  it('carries each field under its stored name', async () => {
    await put({
      slug: 's',
      name: 'n',
      provider_type: 'oauth2',
      client_id: 'c',
      issuer: 'https://i.example.com',
      scopes: 'a b',
      enabled: false,
      priority: 3,
      auto_link_email: false,
      jit_provisioning: false,
      require_email_verified: false,
      trust_email: true,
      always_fetch_userinfo: true,
      enable_sso: false,
      icon_url: 'https://i.example.com/i.png',
      icon_name: ' House ',
      button_color: '#112233',
      button_color_dark: '#445566',
      button_text: 'Go',
      authorization_endpoint: 'https://i.example.com/a',
      token_endpoint: 'https://i.example.com/t',
      userinfo_endpoint: 'https://i.example.com/u',
      jwks_uri: 'https://i.example.com/j',
      token_endpoint_auth_method: 'client_secret_post',
      attribute_mapping: { sub: 'id' },
      profile_update_fields: ['name'],
      use_request_object: true,
      request_object_signing_alg: 'ES256',
      public_key_jwk: { kty: 'EC' },
    });
    expect(updated()).toStrictEqual({
      slug: 's',
      name: 'n',
      providerType: 'oauth2',
      clientId: 'c',
      issuer: 'https://i.example.com',
      scopes: 'a b',
      enabled: false,
      priority: 3,
      autoLinkEmail: false,
      jitProvisioning: false,
      requireEmailVerified: false,
      trustEmail: true,
      alwaysFetchUserinfo: true,
      enableSso: false,
      iconUrl: 'https://i.example.com/i.png',
      iconName: 'house',
      buttonColor: '#112233',
      buttonColorDark: '#445566',
      buttonText: 'Go',
      authorizationEndpoint: 'https://i.example.com/a',
      tokenEndpoint: 'https://i.example.com/t',
      userinfoEndpoint: 'https://i.example.com/u',
      jwksUri: 'https://i.example.com/j',
      tokenEndpointAuthMethod: 'client_secret_post',
      attributeMapping: { sub: 'id' },
      profileUpdateFields: ['name'],
      useRequestObject: true,
      requestObjectSigningAlg: 'ES256',
      publicKeyJwk: { kty: 'EC' },
    });
  });

  it('encrypts a new client secret and a new private key', async () => {
    await put({ client_secret: 's2', private_key_jwk: { kty: 'EC', d: 'x' } });
    expect(updated()).toStrictEqual({
      clientSecretEncrypted: 'enc(s2)',
      privateKeyJwkEncrypted: 'enc({"kty":"EC","d":"x"})',
    });
  });

  it('stores an unusable or null icon name as none, and a profile field list of null', async () => {
    await put({ icon_name: null, profile_update_fields: null });
    expect(updated()).toStrictEqual({ iconName: undefined, profileUpdateFields: null });
    await put({ icon_name: 'unknown-icon' });
    expect(updated()).toStrictEqual({ iconName: undefined });
    await put({ icon_name: 5 });
    expect(updated()).toStrictEqual({ iconName: undefined });
  });

  it.each([
    ['a domain', 'contoso.com', 200],
    ['a domain with junk before it', 'bad name.contoso.com', 400],
    ['a domain with junk after it', 'contoso.com!', 400],
    ['a guid with junk before it', 'zz0b3ad78d-6f1b-4a4f-9d51-1c1f3d7a2b10', 400],
    ['a guid with junk after it', '0b3ad78d-6f1b-4a4f-9d51-1c1f3d7a2b10-x', 400],
    ['a guid', '0b3ad78d-6f1b-4a4f-9d51-1c1f3d7a2b10', 200],
  ])('validates the Microsoft tenant type as %s', async (_n, tenantType, status) => {
    expect((await put({ provider_quirks: { tenantType } })).status).toBe(status);
  });
});

describe('protecting secrets in quirks', () => {
  it('encrypts a private key and plaintext FAPI keys, dropping the plaintext and the flags', async () => {
    await post({
      provider_quirks: {
        privateKeyEncrypted: 'pem',
        fapi2: {
          profile: 'plain_oauth',
          clientAssertionPrivateJwk: { kty: 'EC', d: 'a' },
          dpopPrivateJwk: { kty: 'EC', d: 'b' },
          hasClientAssertionKey: true,
          hasDpopKey: true,
        },
      },
    });
    expect(created().providerQuirks).toStrictEqual({
      privateKeyEncrypted: 'enc(pem)',
      fapi2: {
        profile: 'plain_oauth',
        clientAssertionPrivateJwkEncrypted: 'enc({"kty":"EC","d":"a"})',
        dpopPrivateJwkEncrypted: 'enc({"kty":"EC","d":"b"})',
      },
    });
  });

  it('drops the flag of a key that was not given and keeps the other one separate', async () => {
    await post({
      provider_quirks: {
        fapi2: { dpopPrivateJwk: { kty: 'EC' }, hasClientAssertionKey: true, hasDpopKey: true },
      },
    });
    expect(created().providerQuirks).toStrictEqual({
      fapi2: { dpopPrivateJwkEncrypted: 'enc({"kty":"EC"})' },
    });
  });

  it.each([
    ['an empty private key', { privateKeyEncrypted: '' }],
    ['a private key that is not text', { privateKeyEncrypted: 5 }],
    ['a plaintext key that is a list', { fapi2: { dpopPrivateJwk: [1] } }],
    ['a plaintext key that is text', { fapi2: { dpopPrivateJwk: 'x' } }],
    ['a plaintext key that is null', { fapi2: { dpopPrivateJwk: null } }],
  ])('does not encrypt %s', async (_n, quirks) => {
    await post({ provider_quirks: quirks });
    const stored = JSON.stringify(created().providerQuirks);
    expect(stored).not.toContain('enc(');
  });

  it('encrypts a plaintext key on update when only one of the two is given', async () => {
    await put({ provider_quirks: { fapi2: { clientAssertionPrivateJwk: { kty: 'EC' } } } });
    expect(rec(updated().providerQuirks).fapi2).toStrictEqual({
      clientAssertionPrivateJwkEncrypted: 'enc({"kty":"EC"})',
    });
    await put({ provider_quirks: { fapi2: { dpopPrivateJwk: { kty: 'EC' } } } });
    expect(rec(updated().providerQuirks).fapi2).toStrictEqual({
      dpopPrivateJwkEncrypted: 'enc({"kty":"EC"})',
    });
  });

  it('does not encrypt on update when the plaintext fields are not objects or lists', async () => {
    await put({
      provider_quirks: { fapi2: { dpopPrivateJwk: ['x'], clientAssertionPrivateJwk: 'x' } },
    });
    expect(JSON.stringify(updated().providerQuirks)).not.toContain('enc(');
    await put({ provider_quirks: { fapi2: 'x', privateKeyEncrypted: '' } });
    expect(JSON.stringify(updated().providerQuirks)).not.toContain('enc(');
    await put({ provider_quirks: { privateKeyEncrypted: 'pem' } });
    expect(rec(updated().providerQuirks).privateKeyEncrypted).toBe('enc(pem)');
  });

  it('keeps the stored secrets and only those, when sanitized quirks come back', async () => {
    m.getProvider.mockResolvedValue({
      id: 'prov-1',
      providerQuirks: {
        privateKeyEncrypted: 'enc-pem',
        dynamicClientRegistration: { initialAccessTokenEncrypted: 'enc-iat', other: 1 },
        fapi2: { clientAssertionPrivateJwkEncrypted: 'enc-ca', dpopPrivateJwkEncrypted: 'enc-dp' },
      },
    });
    await put({
      provider_quirks: {
        dynamicClientRegistration: { hasInitialAccessToken: true, enabled: true },
        fapi2: { hasClientAssertionKey: true, hasDpopKey: true, profile: 'p' },
      },
    });
    expect(updated().providerQuirks).toStrictEqual({
      privateKeyEncrypted: 'enc-pem',
      dynamicClientRegistration: { enabled: true, initialAccessTokenEncrypted: 'enc-iat' },
      fapi2: {
        profile: 'p',
        clientAssertionPrivateJwkEncrypted: 'enc-ca',
        dpopPrivateJwkEncrypted: 'enc-dp',
      },
    });
  });

  it('does not carry over stored secrets that are not text, or from a stored list', async () => {
    m.getProvider.mockResolvedValue({
      id: 'prov-1',
      providerQuirks: {
        dynamicClientRegistration: { initialAccessTokenEncrypted: 5 },
        fapi2: [{ dpopPrivateJwkEncrypted: 'x' }],
      },
    });
    await put({ provider_quirks: { dynamicClientRegistration: { a: 1 }, fapi2: { b: 2 } } });
    expect(updated().providerQuirks).toStrictEqual({
      dynamicClientRegistration: { a: 1 },
      fapi2: { b: 2 },
    });
    m.getProvider.mockResolvedValue({
      id: 'prov-1',
      providerQuirks: { dynamicClientRegistration: [{ initialAccessTokenEncrypted: 'x' }] },
    });
    await put({ provider_quirks: { dynamicClientRegistration: { a: 1 } } });
    expect(updated().providerQuirks).toStrictEqual({ dynamicClientRegistration: { a: 1 } });
  });

  it('does not take a non-object registration or fapi2 in the incoming quirks for one', async () => {
    m.getProvider.mockResolvedValue({
      id: 'prov-1',
      providerQuirks: { dynamicClientRegistration: { initialAccessTokenEncrypted: 'x' } },
    });
    await put({ provider_quirks: { dynamicClientRegistration: ['a'], fapi2: ['b'] } });
    expect(updated().providerQuirks).toStrictEqual({
      dynamicClientRegistration: ['a'],
      fapi2: ['b'],
    });
  });
});

describe('create templates', () => {
  it('refuses a LinkedIn or Apple sign-in whose configuration is invalid', async () => {
    expect((await post({ template: 'linkedin', scopes: 'email' })).status).toBe(400);
    expect((await post({ template: 'apple', provider_quirks: {} })).status).toBe(400);
    expect(m.createProvider).not.toHaveBeenCalled();
  });

  it('takes the quirks of the request over the template ones, and the template ones otherwise', async () => {
    for (const template of ['github', 'facebook', 'twitter']) {
      m.createProvider.mockClear();
      await post({ template, provider_quirks: { custom: template } });
      expect(created().providerQuirks).toStrictEqual({ custom: template });
    }
    const defaults = {
      github: GITHUB_DEFAULT_CONFIG,
      facebook: FACEBOOK_DEFAULT_CONFIG,
      twitter: TWITTER_DEFAULT_CONFIG,
    };
    for (const [template, config] of Object.entries(defaults)) {
      m.createProvider.mockClear();
      await post({ template });
      const stored = rec(created().providerQuirks);
      expect(Object.keys(stored).length).toBeGreaterThan(0);
      expect(stored).toStrictEqual(config.providerQuirks);
    }
  });

  it('stores Apple quirks as sent and a LinkedIn default without extras', async () => {
    const apple = { teamId: 'ABCDE12345', keyId: 'ZYXWV98765', privateKeyEncrypted: 'pem' };
    const response = await post({ template: 'apple', provider_quirks: apple });
    expect(response.status).toBe(201);
    expect(created().providerQuirks).toStrictEqual({ ...apple, privateKeyEncrypted: 'enc(pem)' });
    m.createProvider.mockClear();
    expect((await post({ template: 'linkedin' })).status).toBe(201);
    expect(created().providerType).toBe('oidc');
  });
});
