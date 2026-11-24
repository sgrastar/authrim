/**
 * Admin API for external providers: create and update.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV, app, mocks, send } from './helpers/admin-providers-mocks';
import { argRec, callArg, rec } from './helpers/mock-args';

const stored = (overrides: Record<string, unknown> = {}) => ({
  id: 'prov-1',
  tenantId: 'tenant-a',
  name: 'Corp',
  clientId: 'client-1',
  clientSecretEncrypted: 'enc-secret',
  privateKeyJwkEncrypted: 'enc-jwk',
  providerQuirks: {},
  updatedAt: 1000,
  ...overrides,
});

const created = () => argRec(mocks.createProvider, 0, 1);
const updated = () => argRec(mocks.updateProvider, 0, 3);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAll.mockResolvedValue([]);
  mocks.getProvider.mockResolvedValue(stored());
  mocks.createProvider.mockImplementation(async (_env: unknown, input: Record<string, unknown>) =>
    stored({ ...input, id: 'prov-new' })
  );
  mocks.updateProvider.mockResolvedValue(stored());
  mocks.deleteProvider.mockResolvedValue(true);
  mocks.createDiag.mockResolvedValue(null);
  mocks.logAuthDecision.mockResolvedValue(undefined);
  mocks.cleanup.mockResolvedValue(undefined);
});

const BASE_CREATE = { name: 'Corp', client_id: 'cid', client_secret: 'csecret' };

describe('create', () => {
  it('stores the provider with its defaults and an encrypted secret', async () => {
    const response = await send('POST', '/providers', BASE_CREATE);
    expect(response.status).toBe(201);
    expect(created()).toEqual({
      tenantId: 'tenant-a',
      slug: undefined,
      name: 'Corp',
      providerType: 'oidc',
      enabled: true,
      priority: 0,
      issuer: undefined,
      clientId: 'cid',
      clientSecretEncrypted: 'enc(csecret)',
      authorizationEndpoint: undefined,
      tokenEndpoint: undefined,
      userinfoEndpoint: undefined,
      jwksUri: undefined,
      scopes: 'openid email profile',
      tokenEndpointAuthMethod: undefined,
      attributeMapping: {},
      profileUpdateFields: null,
      autoLinkEmail: true,
      jitProvisioning: true,
      requireEmailVerified: true,
      trustEmail: false,
      alwaysFetchUserinfo: false,
      enableSso: true,
      providerQuirks: {},
      iconUrl: undefined,
      iconName: undefined,
      buttonColor: undefined,
      buttonColorDark: undefined,
      buttonText: undefined,
      useRequestObject: undefined,
      requestObjectSigningAlg: undefined,
      privateKeyJwkEncrypted: undefined,
      publicKeyJwk: undefined,
    });
    const body = rec(await response.json());
    expect(body.id).toBe('prov-new');
    expect(body).not.toHaveProperty('clientSecretEncrypted', 'enc(csecret)');
    expect(body.hasSecret).toBe(true);
  });

  it('takes every explicit value from the body', async () => {
    await send('POST', '/providers', {
      ...BASE_CREATE,
      slug: 'corp',
      provider_type: 'oauth2',
      enabled: false,
      priority: 7,
      issuer: 'https://idp.example.com',
      authorization_endpoint: 'https://idp.example.com/authorize',
      token_endpoint: 'https://idp.example.com/token',
      userinfo_endpoint: 'https://idp.example.com/userinfo',
      jwks_uri: 'https://idp.example.com/jwks',
      scopes: 'a b',
      token_endpoint_auth_method: 'client_secret_post',
      attribute_mapping: { sub: 'id' },
      profile_update_fields: ['name'],
      auto_link_email: false,
      jit_provisioning: false,
      require_email_verified: false,
      trust_email: true,
      always_fetch_userinfo: true,
      enable_sso: false,
      provider_quirks: { x: 1 },
      icon_url: 'https://cdn.example.com/i.png',
      icon_name: '  Globe ',
      button_color: '#112233',
      button_color_dark: '#445566',
      button_text: 'Sign in',
      use_request_object: true,
      request_object_signing_alg: 'ES256',
      private_key_jwk: { kty: 'EC' },
      public_key_jwk: { kty: 'EC', x: 'x' },
    });
    expect(created()).toMatchObject({
      slug: 'corp',
      providerType: 'oauth2',
      enabled: false,
      priority: 7,
      issuer: 'https://idp.example.com',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      userinfoEndpoint: 'https://idp.example.com/userinfo',
      jwksUri: 'https://idp.example.com/jwks',
      scopes: 'a b',
      tokenEndpointAuthMethod: 'client_secret_post',
      attributeMapping: { sub: 'id' },
      profileUpdateFields: ['name'],
      autoLinkEmail: false,
      jitProvisioning: false,
      requireEmailVerified: false,
      trustEmail: true,
      alwaysFetchUserinfo: true,
      enableSso: false,
      providerQuirks: { x: 1 },
      iconUrl: 'https://cdn.example.com/i.png',
      iconName: 'globe',
      buttonColor: '#112233',
      buttonColorDark: '#445566',
      buttonText: 'Sign in',
      useRequestObject: true,
      requestObjectSigningAlg: 'ES256',
      privateKeyJwkEncrypted: 'enc({"kty":"EC"})',
      publicKeyJwk: { kty: 'EC', x: 'x' },
    });
  });

  it('only treats the exact booleans as switches', async () => {
    await send('POST', '/providers', {
      ...BASE_CREATE,
      trust_email: 'yes',
      always_fetch_userinfo: 1,
    });
    expect(created()).toMatchObject({ trustEmail: false, alwaysFetchUserinfo: false });
  });

  it('accepts exactly the listed login icon names', async () => {
    const names = [
      'buildings',
      'house',
      'house-simple',
      'bank',
      'building',
      'city',
      'graduation-cap',
      'student',
      'books',
      'chalkboard-teacher',
      'globe',
      'globe-hemisphere-east',
      'shield-check',
      'seal-check',
      'certificate',
      'identification-card',
      'fingerprint',
      'key',
      'briefcase',
      'users-three',
      'network',
      'share-network',
      'tree-structure',
      'handshake',
      'cloud',
      'cloud-check',
      'database',
      'hard-drives',
      'devices',
      'terminal-window',
      'book-open',
      'presentation-chart',
      'rocket-launch',
      'compass',
      'none',
    ];
    for (const name of names) {
      mocks.createProvider.mockClear();
      await send('POST', '/providers', { ...BASE_CREATE, icon_name: name });
      expect(created().iconName).toBe(name);
    }
    mocks.createProvider.mockClear();
    await send('POST', '/providers', { ...BASE_CREATE, icon_name: 'GLOBE-HEMISPHERE-EAST' });
    expect(created().iconName).toBe('globe-hemisphere-east');
  });

  it('ignores an unknown icon name, and keeps only listed ones', async () => {
    for (const name of ['nope', 5, '', null]) {
      mocks.createProvider.mockClear();
      await send('POST', '/providers', { ...BASE_CREATE, icon_name: name });
      expect(created().iconName).toBeUndefined();
    }
  });

  it.each([[{ name: '' }], [{ client_id: '' }], [{ client_secret: '' }]])(
    'requires name, client_id and client_secret (%j)',
    async (change) => {
      const response = await send('POST', '/providers', { ...BASE_CREATE, ...change });
      expect(response.status).toBe(400);
      expect(mocks.createProvider).not.toHaveBeenCalled();
    }
  );

  it('refuses the inbound identity mapping selector and client supplied encrypted secrets', async () => {
    for (const quirks of [
      { inboundIdentityMapping: {} },
      { dynamicClientRegistration: { initialAccessTokenEncrypted: 'x' } },
      { fapi2: { clientAssertionPrivateJwkEncrypted: 'x' } },
      { fapi2: { dpopPrivateJwkEncrypted: 'x' } },
    ]) {
      const response = await send('POST', '/providers', {
        ...BASE_CREATE,
        provider_quirks: quirks,
      });
      expect(response.status).toBe(400);
    }
    expect(mocks.createProvider).not.toHaveBeenCalled();
  });

  it('accepts harmless dynamic registration and fapi2 settings', async () => {
    const response = await send('POST', '/providers', {
      ...BASE_CREATE,
      provider_quirks: {
        dynamicClientRegistration: { enabled: true, hasInitialAccessToken: true },
        fapi2: { enabled: true, hasClientAssertionKey: true, hasDpopKey: false },
      },
    });
    expect(response.status).toBe(201);
    expect(rec(created().providerQuirks)).toEqual({
      dynamicClientRegistration: { enabled: true },
      fapi2: { enabled: true },
    });
  });

  it('encrypts a private key and FAPI keys given in plaintext', async () => {
    await send('POST', '/providers', {
      ...BASE_CREATE,
      provider_quirks: {
        privateKeyEncrypted: 'pem',
        fapi2: {
          enabled: true,
          clientAssertionPrivateJwk: { kty: 'EC', d: 'a' },
          dpopPrivateJwk: { kty: 'EC', d: 'd' },
          dpopPrivateJwkEncrypted: undefined,
        },
      },
    });
    expect(rec(created().providerQuirks)).toEqual({
      privateKeyEncrypted: 'enc(pem)',
      fapi2: {
        enabled: true,
        clientAssertionPrivateJwkEncrypted: 'enc({"kty":"EC","d":"a"})',
        dpopPrivateJwkEncrypted: 'enc({"kty":"EC","d":"d"})',
      },
    });
  });

  it('rejects profile_update_fields that are not standard claims', async () => {
    const response = await send('POST', '/providers', {
      ...BASE_CREATE,
      profile_update_fields: ['not_a_claim'],
    });
    expect(response.status).toBe(400);
    const ok = await send('POST', '/providers', { ...BASE_CREATE, profile_update_fields: null });
    expect(ok.status).toBe(201);
    expect(created().profileUpdateFields).toBeNull();
  });

  describe('URL validation', () => {
    it.each([
      ['issuer', 'http://idp.example.com'],
      ['authorization_endpoint', 'http://127.0.0.1/authorize'],
      ['token_endpoint', 'https://169.254.169.254/token'],
      ['userinfo_endpoint', 'ftp://idp.example.com/u'],
      ['jwks_uri', 'https://localhost/jwks'],
    ])('refuses an unsafe %s', async (field, value) => {
      const response = await send('POST', '/providers', { ...BASE_CREATE, [field]: value });
      expect(response.status).toBe(400);
      expect(mocks.createProvider).not.toHaveBeenCalled();
    });

    it('refuses a non-string URL and accepts an empty one as absent', async () => {
      expect((await send('POST', '/providers', { ...BASE_CREATE, issuer: 5 })).status).toBe(400);
      expect((await send('POST', '/providers', { ...BASE_CREATE, issuer: '' })).status).toBe(201);
    });
  });

  describe('templates', () => {
    it('applies the Google defaults, which an explicit value overrides', async () => {
      await send('POST', '/providers', { ...BASE_CREATE, template: 'google' });
      expect(created()).toMatchObject({
        issuer: 'https://accounts.google.com',
        scopes: 'openid email profile',
        iconUrl: 'https://www.google.com/favicon.ico',
        autoLinkEmail: true,
      });
      expect(rec(created().attributeMapping).email).toBe('email');
      mocks.createProvider.mockClear();
      await send('POST', '/providers', {
        ...BASE_CREATE,
        template: 'google',
        scopes: 'openid',
        auto_link_email: false,
        icon_url: 'https://cdn.example.com/g.png',
      });
      expect(created()).toMatchObject({
        scopes: 'openid',
        autoLinkEmail: false,
        iconUrl: 'https://cdn.example.com/g.png',
      });
    });

    it('applies Microsoft with its tenant type, validating it', async () => {
      await send('POST', '/providers', {
        ...BASE_CREATE,
        template: 'microsoft',
        provider_quirks: { tenantType: 'organizations' },
      });
      expect(created().issuer).toBe('https://login.microsoftonline.com/organizations/v2.0');
      mocks.createProvider.mockClear();
      await send('POST', '/providers', { ...BASE_CREATE, template: 'microsoft' });
      expect(created().issuer).toBe('https://login.microsoftonline.com/common/v2.0');
      const bad = await send('POST', '/providers', {
        ...BASE_CREATE,
        template: 'microsoft',
        provider_quirks: { tenantType: 'evil/../x' },
      });
      expect(bad.status).toBe(400);
    });

    it('applies GitHub, including an Enterprise Server and its validation', async () => {
      await send('POST', '/providers', { ...BASE_CREATE, template: 'github' });
      expect(created()).toMatchObject({
        authorizationEndpoint: 'https://github.com/login/oauth/authorize',
        tokenEndpoint: 'https://github.com/login/oauth/access_token',
        userinfoEndpoint: 'https://api.github.com/user',
      });
      const bad = await send('POST', '/providers', {
        ...BASE_CREATE,
        template: 'github',
        provider_quirks: {
          allowEnterpriseServer: true,
          enterpriseServerUrl: 'http://ghe.example.com',
        },
      });
      expect(bad.status).toBe(400);
    });

    it('applies LinkedIn, Facebook, Twitter and Apple defaults', async () => {
      for (const template of ['linkedin', 'facebook', 'twitter', 'apple']) {
        mocks.createProvider.mockClear();
        const quirks =
          template === 'apple'
            ? { teamId: 'ABCDE12345', keyId: 'ZYXWV98765', privateKeyEncrypted: 'pem' }
            : undefined;
        const response = await send('POST', '/providers', {
          ...BASE_CREATE,
          template,
          ...(quirks ? { provider_quirks: quirks } : {}),
        });
        expect(response.status).toBe(201);
        expect(mocks.createProvider).toHaveBeenCalledTimes(1);
      }
      expect(created().scopes).toBeTruthy();
    });

    it('uses the template default scopes when none are given', async () => {
      await send('POST', '/providers', { ...BASE_CREATE, template: 'twitter' });
      expect(rec(created()).scopes).toBeTruthy();
      expect(created().tokenEndpoint).toBe('https://api.twitter.com/2/oauth2/token');
    });
  });

  it('answers 500 and logs when the store fails, or the body is not JSON', async () => {
    mocks.createProvider.mockRejectedValue(new Error('db'));
    expect((await send('POST', '/providers', BASE_CREATE)).status).toBe(500);
    expect(mocks.error).toHaveBeenCalledWith('Failed to create provider', {}, expect.any(Error));
    const response = await app().request(
      'https://admin.example.com/providers',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' },
      ENV
    );
    expect(response.status).toBe(500);
  });
});

describe('update', () => {
  const put = (body: unknown) => send('PUT', '/providers/prov-1', body);

  it('applies each given field under its stored name and nothing else', async () => {
    const response = await put({
      slug: 's',
      name: 'N',
      provider_type: 'oauth2',
      client_id: 'c2',
      client_secret: 'secret2',
      issuer: 'https://idp.example.com',
      scopes: 'a',
      enabled: false,
      priority: 3,
      auto_link_email: false,
      jit_provisioning: false,
      require_email_verified: false,
      trust_email: true,
      always_fetch_userinfo: true,
      enable_sso: false,
      icon_url: null,
      icon_name: 'Cloud',
      button_color: '#aabbcc',
      button_color_dark: 'dark',
      button_text: 'Go',
      authorization_endpoint: 'https://idp.example.com/a',
      token_endpoint: 'https://idp.example.com/t',
      userinfo_endpoint: 'https://idp.example.com/u',
      jwks_uri: 'https://idp.example.com/j',
      token_endpoint_auth_method: 'client_secret_post',
      attribute_mapping: { sub: 'id' },
      profile_update_fields: ['name'],
      use_request_object: true,
      request_object_signing_alg: 'ES256',
      private_key_jwk: { kty: 'EC' },
      public_key_jwk: { kty: 'EC', x: 'x' },
    });
    expect(response.status).toBe(200);
    expect(callArg(mocks.updateProvider, 0, 0)).toBe(ENV);
    expect(callArg(mocks.updateProvider, 0, 1)).toBe('tenant-a');
    expect(callArg(mocks.updateProvider, 0, 2)).toBe('prov-1');
    expect(updated()).toEqual({
      slug: 's',
      name: 'N',
      providerType: 'oauth2',
      clientId: 'c2',
      clientSecretEncrypted: 'enc(secret2)',
      issuer: 'https://idp.example.com',
      scopes: 'a',
      enabled: false,
      priority: 3,
      autoLinkEmail: false,
      jitProvisioning: false,
      requireEmailVerified: false,
      trustEmail: true,
      alwaysFetchUserinfo: true,
      enableSso: false,
      iconUrl: null,
      iconName: 'cloud',
      buttonColor: '#aabbcc',
      buttonColorDark: 'dark',
      buttonText: 'Go',
      authorizationEndpoint: 'https://idp.example.com/a',
      tokenEndpoint: 'https://idp.example.com/t',
      userinfoEndpoint: 'https://idp.example.com/u',
      jwksUri: 'https://idp.example.com/j',
      tokenEndpointAuthMethod: 'client_secret_post',
      attributeMapping: { sub: 'id' },
      profileUpdateFields: ['name'],
      useRequestObject: true,
      requestObjectSigningAlg: 'ES256',
      privateKeyJwkEncrypted: 'enc({"kty":"EC"})',
      publicKeyJwk: { kty: 'EC', x: 'x' },
    });
    expect(mocks.updateProvider.mock.calls[0]).toHaveLength(4);
  });

  it('updates nothing it was not given', async () => {
    await put({});
    expect(updated()).toEqual({});
  });

  it('accepts false values as values', async () => {
    await put({ trust_email: false, enabled: false, priority: 0 });
    expect(updated()).toEqual({ trustEmail: false, enabled: false, priority: 0 });
  });

  it('answers 404 when there is no such provider', async () => {
    mocks.updateProvider.mockResolvedValue(null);
    expect((await put({ name: 'x' })).status).toBe(404);
  });

  it.each([
    ['always_fetch_userinfo', 'yes'],
    ['enable_sso', 1],
    ['jit_provisioning', 'true'],
    ['trust_email', 'true'],
    ['priority', '5'],
    ['priority', 1.5],
    ['priority', 100001],
    ['priority', -100001],
    ['expected_updated_at', -1],
    ['expected_updated_at', 1.5],
    ['expected_updated_at', '1'],
    ['token_endpoint_auth_method', 'private_key_jwt'],
    ['button_text', 5],
    ['button_text', 'x'.repeat(257)],
    ['button_color', 'red'],
    ['button_color', '#12345'],
    ['button_color', '#1234567'],
    ['button_color', 5],
  ])('rejects %s = %j before touching the store', async (key, value) => {
    const response = await put({ [key]: value });
    expect(response.status).toBe(400);
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });

  it.each([
    ['priority', 100000],
    ['priority', -100000],
    ['expected_updated_at', 0],
    ['button_text', 'x'.repeat(256)],
    ['button_color', '#aBcDeF'],
    ['token_endpoint_auth_method', 'client_secret_basic'],
  ])('accepts the boundary %s = %j', async (key, value) => {
    mocks.getProvider.mockResolvedValue(stored({ updatedAt: 0 }));
    expect((await put({ [key]: value })).status).toBe(200);
  });

  describe('optimistic concurrency', () => {
    it('updates against the expected version', async () => {
      const response = await put({ name: 'x', expected_updated_at: 1000 });
      expect(response.status).toBe(200);
      expect(mocks.updateProvider.mock.calls[0]).toHaveLength(5);
      expect(callArg(mocks.updateProvider, 0, 4)).toBe(1000);
      expect(updated()).toEqual({ name: 'x' });
    });

    it('answers 404 when the provider is gone and 409 when it moved on', async () => {
      mocks.getProvider.mockResolvedValue(null);
      expect((await put({ expected_updated_at: 1000 })).status).toBe(404);
      mocks.getProvider.mockResolvedValue(stored({ updatedAt: 2000 }));
      const stale = await put({ expected_updated_at: 1000 });
      expect(stale.status).toBe(409);
      expect(mocks.updateProvider).not.toHaveBeenCalled();
    });

    it('answers 409 when the store refuses the expected version', async () => {
      mocks.updateProvider.mockResolvedValue(null);
      expect((await put({ expected_updated_at: 1000 })).status).toBe(409);
    });
  });

  it('validates outbound URLs and the profile fields', async () => {
    expect((await put({ issuer: 'http://idp.example.com' })).status).toBe(400);
    expect((await put({ jwks_uri: 5 })).status).toBe(400);
    expect((await put({ token_endpoint: 'https://127.0.0.1/t' })).status).toBe(400);
    expect((await put({ profile_update_fields: ['bogus'] })).status).toBe(400);
    expect((await put({ profile_update_fields: null })).status).toBe(200);
    expect(updated()).toEqual({ profileUpdateFields: null });
    expect(mocks.updateProvider).toHaveBeenCalledTimes(1);
  });

  describe('provider quirks', () => {
    it('refuses client supplied encrypted secrets', async () => {
      const response = await put({
        provider_quirks: { dynamicClientRegistration: { initialAccessTokenEncrypted: 'x' } },
      });
      expect(response.status).toBe(400);
      expect(mocks.updateProvider).not.toHaveBeenCalled();
    });

    it.each([
      ['common', true],
      ['organizations', true],
      ['consumers', true],
      ['0b3ad78d-6f1b-4a4f-9d51-1c1f3d7a2b10', true],
      ['0B3AD78D-6F1B-4A4F-9D51-1C1F3D7A2B10', true],
      ['contoso.onmicrosoft.com', true],
      ['not valid', false],
      ['x', false],
      ['0b3ad78d-6f1b-4a4f-9d51-1c1f3d7a2b1', false],
    ])('validates the tenant type %s', async (tenantType, valid) => {
      const response = await put({ provider_quirks: { tenantType } });
      expect(response.status).toBe(valid ? 200 : 400);
    });

    it('keeps the stored secrets when the sanitized quirks are sent back', async () => {
      mocks.getProvider.mockResolvedValue(
        stored({
          providerQuirks: {
            privateKeyEncrypted: 'enc-pem',
            dynamicClientRegistration: { initialAccessTokenEncrypted: 'enc-iat', enabled: true },
            fapi2: {
              clientAssertionPrivateJwkEncrypted: 'enc-a',
              dpopPrivateJwkEncrypted: 'enc-d',
            },
          },
        })
      );
      await put({
        provider_quirks: {
          dynamicClientRegistration: { enabled: false, hasInitialAccessToken: true },
          fapi2: { enabled: true, hasClientAssertionKey: true, hasDpopKey: true },
        },
      });
      expect(updated().providerQuirks).toEqual({
        privateKeyEncrypted: 'enc-pem',
        dynamicClientRegistration: { enabled: false, initialAccessTokenEncrypted: 'enc-iat' },
        fapi2: {
          enabled: true,
          clientAssertionPrivateJwkEncrypted: 'enc-a',
          dpopPrivateJwkEncrypted: 'enc-d',
        },
      });
    });

    it('does not carry over secrets that are not strings, nor override a new private key', async () => {
      mocks.getProvider.mockResolvedValue(
        stored({
          providerQuirks: {
            privateKeyEncrypted: 'enc-pem',
            dynamicClientRegistration: { initialAccessTokenEncrypted: 5 },
            fapi2: { clientAssertionPrivateJwkEncrypted: 5 },
          },
        })
      );
      await put({
        provider_quirks: {
          privateKeyEncrypted: 'new-pem',
          dynamicClientRegistration: { enabled: true },
          fapi2: { enabled: true },
        },
      });
      expect(updated().providerQuirks).toEqual({
        privateKeyEncrypted: 'enc(new-pem)',
        dynamicClientRegistration: { enabled: true },
        fapi2: { enabled: true },
      });
    });

    it('does not carry over a secret the update names itself, and tolerates no stored provider', async () => {
      mocks.getProvider.mockResolvedValue(null);
      await put({ provider_quirks: { fapi2: { enabled: true } } });
      expect(updated().providerQuirks).toEqual({ fapi2: { enabled: true } });
    });

    it('stores plain quirks as given when there is no secret in them', async () => {
      await put({ provider_quirks: { useFormPost: false } });
      expect(updated().providerQuirks).toEqual({ useFormPost: false });
    });
  });

  it('answers 500 and logs when the store fails', async () => {
    mocks.updateProvider.mockRejectedValue(new Error('db'));
    expect((await put({ name: 'x' })).status).toBe(500);
    expect(mocks.error).toHaveBeenCalledWith('Failed to update provider', {}, expect.any(Error));
  });
});
