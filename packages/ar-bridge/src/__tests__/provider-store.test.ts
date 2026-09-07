import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  resolve: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', () => ({
  resolveAuthCorePersistenceAdapterFromEnv: mocks.resolve,
}));
import {
  createProvider,
  deleteProvider,
  getProvider,
  getProviderByIdOrSlug,
  getProviderByName,
  listAllProviders,
  listEnabledProviders,
  updateProvider,
} from '../services/provider-store';
import type { UpstreamProvider } from '../types';

type ProviderInput = Omit<UpstreamProvider, 'id' | 'createdAt' | 'updatedAt'>;
function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-1',
    tenant_id: 'tenant-a',
    slug: 'google',
    name: 'Google',
    provider_type: 'oidc',
    enabled: 1,
    priority: 0,
    issuer: 'https://accounts.example',
    client_id: 'client',
    client_secret_encrypted: 'encrypted',
    authorization_endpoint: 'https://accounts.example/auth',
    token_endpoint: 'https://accounts.example/token',
    userinfo_endpoint: 'https://accounts.example/userinfo',
    jwks_uri: 'https://accounts.example/jwks',
    scopes: 'openid email',
    token_endpoint_auth_method: 'client_secret_post',
    attribute_mapping: '{"email":"email"}',
    auto_link_email: 1,
    jit_provisioning: 1,
    require_email_verified: 1,
    always_fetch_userinfo: 1,
    enable_sso: 1,
    provider_quirks: '{"requiresPrompt":true}',
    icon_url: 'https://example/icon',
    icon_name: 'google',
    button_color: '#fff',
    button_color_dark: '#000',
    button_text: 'Continue',
    use_request_object: 1,
    request_object_signing_alg: 'RS256',
    private_key_jwk_encrypted: 'private',
    public_key_jwk: '{"kty":"RSA"}',
    created_at: 100,
    updated_at: 200,
    ...overrides,
  };
}
function provider(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    tenantId: 'tenant-a',
    slug: 'google',
    name: 'Google',
    providerType: 'oidc',
    enabled: true,
    priority: 0,
    issuer: 'https://accounts.example',
    clientId: 'client',
    clientSecretEncrypted: 'encrypted',
    authorizationEndpoint: 'https://accounts.example/auth',
    tokenEndpoint: 'https://accounts.example/token',
    userinfoEndpoint: 'https://accounts.example/userinfo',
    jwksUri: 'https://accounts.example/jwks',
    scopes: 'openid email',
    tokenEndpointAuthMethod: 'client_secret_post',
    attributeMapping: { email: 'email' },
    autoLinkEmail: true,
    jitProvisioning: true,
    requireEmailVerified: true,
    alwaysFetchUserinfo: true,
    enableSso: true,
    providerQuirks: { requiresPrompt: true },
    iconUrl: 'https://example/icon',
    iconName: 'google',
    buttonColor: '#fff',
    buttonColorDark: '#000',
    buttonText: 'Continue',
    useRequestObject: true,
    requestObjectSigningAlg: 'RS256',
    privateKeyJwkEncrypted: 'private',
    publicKeyJwk: { kty: 'RSA' },
    ...overrides,
  };
}
describe('upstream provider store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.resolve.mockResolvedValue(mocks.adapter);
  });
  it.each([null, dbRow()])('gets tenant-scoped provider %#', async (row) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(row);
    const result = await getProvider({} as never, 'tenant-a', 'provider-1');
    expect(result?.id ?? null).toBe(row ? 'provider-1' : null);
    expect(mocks.adapter.queryOne).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'provider-1',
      'tenant-a',
    ]);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), 'bridge-provider-store:get', {
      tenantId: 'tenant-a',
    });
  });
  it('maps all provider fields and booleans', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(dbRow());
    await expect(getProvider({} as never, 'tenant-a', 'provider-1')).resolves.toMatchObject({
      ...provider(),
      id: 'provider-1',
      createdAt: 100,
      updatedAt: 200,
    });
  });
  it('maps nullable/default database fields safely', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(
      dbRow({
        slug: null,
        enabled: 0,
        issuer: null,
        authorization_endpoint: null,
        token_endpoint: null,
        userinfo_endpoint: null,
        jwks_uri: null,
        token_endpoint_auth_method: null,
        attribute_mapping: null,
        auto_link_email: 0,
        jit_provisioning: 0,
        require_email_verified: 0,
        always_fetch_userinfo: 0,
        enable_sso: 0,
        provider_quirks: null,
        icon_url: null,
        icon_name: null,
        button_color: null,
        button_color_dark: null,
        button_text: null,
        use_request_object: null,
        request_object_signing_alg: null,
        private_key_jwk_encrypted: null,
        public_key_jwk: null,
      })
    );
    const result = await getProvider({} as never, 'tenant-a', 'provider-1');
    expect(result).toMatchObject({
      enabled: false,
      attributeMapping: {},
      providerQuirks: {},
      autoLinkEmail: false,
      jitProvisioning: false,
      requireEmailVerified: false,
      alwaysFetchUserinfo: false,
      enableSso: false,
      useRequestObject: false,
    });
    expect(result?.slug).toBeUndefined();
  });
  it('looks up slug first without unnecessary ID query', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(dbRow());
    expect((await getProviderByIdOrSlug({} as never, 'GOOGLE', 'tenant-a'))?.id).toBe('provider-1');
    expect(mocks.adapter.queryOne).toHaveBeenCalledTimes(1);
    expect(mocks.adapter.queryOne).toHaveBeenCalledWith(expect.stringContaining('LOWER(slug)'), [
      'GOOGLE',
      'tenant-a',
    ]);
  });
  it.each([null, dbRow()])('falls back from slug to ID result %#', async (row) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    expect((await getProviderByIdOrSlug({} as never, 'provider-1', 'tenant-a'))?.id ?? null).toBe(
      row ? 'provider-1' : null
    );
    expect(mocks.adapter.queryOne).toHaveBeenCalledTimes(2);
  });
  it.each([null, dbRow()])('gets enabled provider by exact name %#', async (row) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(row);
    expect((await getProviderByName({} as never, 'Google', 'tenant-a'))?.id ?? null).toBe(
      row ? 'provider-1' : null
    );
    expect(mocks.adapter.queryOne).toHaveBeenCalledWith(expect.stringContaining('enabled = 1'), [
      'Google',
      'tenant-a',
    ]);
  });
  it.each([listEnabledProviders, listAllProviders])(
    'lists and maps providers %#',
    async (handler) => {
      mocks.adapter.query.mockResolvedValueOnce([dbRow(), dbRow({ id: 'provider-2', enabled: 0 })]);
      const result = await handler({} as never, 'tenant-a');
      expect(result).toHaveLength(2);
      expect(result[1]).toMatchObject({ id: 'provider-2', enabled: false });
      expect(mocks.adapter.query.mock.calls[0][1]).toEqual(['tenant-a']);
    }
  );
  it('creates provider using secure and interoperable defaults', async () => {
    const result = await createProvider(
      {} as never,
      provider({
        slug: undefined,
        priority: undefined,
        issuer: undefined,
        authorizationEndpoint: undefined,
        tokenEndpoint: undefined,
        userinfoEndpoint: undefined,
        jwksUri: undefined,
        tokenEndpointAuthMethod: undefined,
        attributeMapping: undefined,
        autoLinkEmail: false,
        jitProvisioning: false,
        requireEmailVerified: false,
        alwaysFetchUserinfo: false,
        enableSso: undefined,
        providerQuirks: undefined,
        iconUrl: undefined,
        iconName: undefined,
        buttonColor: undefined,
        buttonColorDark: undefined,
        buttonText: undefined,
        useRequestObject: false,
        requestObjectSigningAlg: undefined,
        privateKeyJwkEncrypted: undefined,
        publicKeyJwk: undefined,
      })
    );
    expect(result).toMatchObject({
      id: expect.any(String),
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    const values = mocks.adapter.execute.mock.calls[0][1] as unknown[];
    expect(values).toEqual(
      expect.arrayContaining([
        'tenant-a',
        'Google',
        'client',
        'encrypted',
        'client_secret_post',
        '{}',
      ])
    );
    expect(values[21]).toBe(1);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), 'bridge-provider-store:create', {
      tenantId: 'tenant-a',
    });
  });
  it('creates fully configured JAR provider', async () => {
    const result = await createProvider({} as never, provider());
    expect(result).toMatchObject({ publicKeyJwk: { kty: 'RSA' }, enableSso: true });
    const values = mocks.adapter.execute.mock.calls[0][1] as unknown[];
    expect(values).toEqual(expect.arrayContaining(['{"kty":"RSA"}', 'RS256', 'private']));
  });
  it('returns null instead of updating a missing provider', async () => {
    await expect(
      updateProvider({} as never, 'tenant-a', 'missing', { name: 'New' })
    ).resolves.toBeNull();
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });
  it('merges partial update while retaining security settings', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(dbRow());
    const result = await updateProvider({} as never, 'tenant-a', 'provider-1', {
      name: 'Updated',
      enabled: false,
      priority: 5,
      enableSso: false,
      publicKeyJwk: null,
    } as never);
    expect(result).toMatchObject({
      name: 'Updated',
      enabled: false,
      priority: 5,
      enableSso: false,
      publicKeyJwk: null,
      clientId: 'client',
    });
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = ? AND tenant_id = ?'),
      expect.arrayContaining(['Updated', 0, 5, 'provider-1', 'tenant-a'])
    );
    expect(mocks.resolve).toHaveBeenLastCalledWith(
      expect.anything(),
      'bridge-provider-store:update',
      { tenantId: 'tenant-a' }
    );
  });
  it.each([0, 1])('deletes provider rowsAffected=%s', async (rowsAffected) => {
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected });
    await expect(deleteProvider({} as never, 'tenant-a', 'provider-1')).resolves.toBe(
      Boolean(rowsAffected)
    );
    expect(mocks.adapter.execute).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'provider-1',
      'tenant-a',
    ]);
  });
  it('propagates corrupt stored JSON instead of silently changing provider semantics', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(dbRow({ attribute_mapping: '{' }));
    await expect(getProvider({} as never, 'tenant-a', 'provider-1')).rejects.toThrow();
  });
});
