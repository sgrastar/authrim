import { beforeEach, describe, expect, it } from 'vitest';
import { MockDatabaseAdapter } from './mock-adapter';
import { ClientRepository, type CreateClientInput } from '../core/client';

describe('ClientRepository tenant isolation', () => {
  let adapter: MockDatabaseAdapter;

  const seedSharedClients = () => {
    adapter.initTable('oauth_clients', 'pk');
    adapter.seed('oauth_clients', [
      {
        pk: 'tenant-a:shared-mobile',
        client_id: 'shared-mobile',
        tenant_id: 'tenant-a',
        client_name: 'Tenant A Mobile',
        redirect_uris: '["https://tenant-a.example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
        subject_type: 'public',
        token_endpoint_auth_method: 'none',
        is_trusted: 1,
        skip_consent: 0,
        allow_claims_without_scope: 0,
        asc_enabled: 1,
        asc_protected_request_required: 1,
        asc_sao_enabled: 1,
        asc_transformed_claims_enabled: 1,
        token_exchange_allowed: 0,
        delegation_mode: 'delegation',
        client_credentials_allowed: 0,
        backchannel_user_code_parameter: 0,
        backchannel_logout_session_required: 0,
        frontchannel_logout_session_required: 0,
        require_pkce: 1,
        created_at: 100,
        updated_at: 100,
      },
      {
        pk: 'tenant-b:shared-mobile',
        client_id: 'shared-mobile',
        tenant_id: 'tenant-b',
        client_name: 'Tenant B Mobile',
        redirect_uris: '["https://tenant-b.example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
        subject_type: 'public',
        token_endpoint_auth_method: 'none',
        is_trusted: 0,
        skip_consent: 1,
        allow_claims_without_scope: 0,
        asc_enabled: 1,
        asc_protected_request_required: 1,
        asc_sao_enabled: 1,
        asc_transformed_claims_enabled: 1,
        token_exchange_allowed: 0,
        delegation_mode: 'delegation',
        client_credentials_allowed: 0,
        backchannel_user_code_parameter: 0,
        backchannel_logout_session_required: 0,
        frontchannel_logout_session_required: 0,
        require_pkce: 0,
        created_at: 200,
        updated_at: 200,
      },
    ]);
  };

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
  });

  it('resolves duplicate client_id within the repository tenant only', async () => {
    seedSharedClients();

    const tenantARepository = new ClientRepository(adapter, 'tenant-a');
    const tenantBRepository = new ClientRepository(adapter, 'tenant-b');

    const tenantAClient = await tenantARepository.findByClientId('shared-mobile');
    const tenantBClient = await tenantBRepository.findByClientId('shared-mobile');

    expect(tenantAClient?.tenant_id).toBe('tenant-a');
    expect(tenantAClient?.client_name).toBe('Tenant A Mobile');
    expect(tenantAClient?.is_trusted).toBe(true);
    expect(tenantAClient?.require_pkce).toBe(true);
    expect(tenantBClient?.tenant_id).toBe('tenant-b');
    expect(tenantBClient?.client_name).toBe('Tenant B Mobile');
    expect(tenantBClient?.is_trusted).toBe(false);
    expect(tenantBClient?.require_pkce).toBe(false);

    expect(adapter.getQueryLog()).toEqual([
      expect.objectContaining({
        sql: 'SELECT * FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
        params: ['tenant-a', 'shared-mobile'],
      }),
      expect.objectContaining({
        sql: 'SELECT * FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
        params: ['tenant-b', 'shared-mobile'],
      }),
    ]);
  });

  it('updates only the matching tenant row when client_id is duplicated', async () => {
    seedSharedClients();

    const tenantARepository = new ClientRepository(adapter, 'tenant-a');
    const tenantBRepository = new ClientRepository(adapter, 'tenant-b');

    await tenantARepository.update('shared-mobile', {
      client_name: 'Tenant A Mobile Updated',
      skip_consent: true,
    });

    const tenantAClient = await tenantARepository.findByClientId('shared-mobile');
    const tenantBClient = await tenantBRepository.findByClientId('shared-mobile');

    expect(tenantAClient?.client_name).toBe('Tenant A Mobile Updated');
    expect(tenantAClient?.skip_consent).toBe(true);
    expect(tenantBClient?.client_name).toBe('Tenant B Mobile');
    expect(tenantBClient?.skip_consent).toBe(true);
  });

  it('deletes only the matching tenant row when client_id is duplicated', async () => {
    seedSharedClients();

    const tenantARepository = new ClientRepository(adapter, 'tenant-a');
    const tenantBRepository = new ClientRepository(adapter, 'tenant-b');

    await expect(tenantARepository.delete('shared-mobile')).resolves.toBe(true);

    await expect(tenantARepository.findByClientId('shared-mobile')).resolves.toBeNull();
    await expect(tenantBRepository.findByClientId('shared-mobile')).resolves.toMatchObject({
      tenant_id: 'tenant-b',
      client_name: 'Tenant B Mobile',
    });
  });

  it('rejects create input that targets another tenant', async () => {
    const repository = new ClientRepository(adapter, 'tenant-a');

    await expect(
      repository.create({
        client_id: 'shared-mobile',
        tenant_id: 'tenant-b',
        client_name: 'Tenant B Mobile',
        redirect_uris: ['https://tenant-b.example.com/callback'],
      })
    ).rejects.toThrow('ClientRepository.create tenantId does not match repository tenant');
  });

  it('rejects empty repository tenantId', () => {
    expect(() => new ClientRepository(adapter, '  ')).toThrow('ClientRepository requires tenantId');
  });
});

describe('ClientRepository client profile contracts', () => {
  let adapter: MockDatabaseAdapter;
  let repository: ClientRepository;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    adapter.initTable('oauth_clients', 'client_id');
    repository = new ClientRepository(adapter, 'tenant-a');
  });

  it('creates a secure baseline profile when optional settings are omitted', async () => {
    const client = await repository.create({
      client_id: 'baseline',
      client_name: 'Baseline client',
      redirect_uris: ['https://client.example/callback'],
    });

    expect(client).toMatchObject({
      tenant_id: 'tenant-a',
      application_type: 'web',
      redirect_uris: '["https://client.example/callback"]',
      grant_types: '["authorization_code"]',
      response_types: '["code"]',
      subject_type: 'public',
      token_endpoint_auth_method: 'client_secret_basic',
      browser_refresh_token_policy: 'disabled',
      is_trusted: false,
      skip_consent: false,
      require_pkce: false,
      asc_enabled: true,
      asc_protected_request_required: true,
    });
    expect(client.client_secret_hash).toBeNull();
    expect(client.allowed_channels).toBeNull();
  });

  it('preserves and serializes a fully configured client profile', async () => {
    const input: CreateClientInput = {
      client_id: 'full-client',
      client_secret_hash: 'secret-hash',
      client_name: 'Full client',
      description: 'All supported settings',
      tenant_id: 'tenant-a',
      application_type: 'native',
      trust_group: 'mobile',
      browser_public_client_mode: 'strict',
      browser_refresh_token_policy: 'dpop_bound',
      native_sso_enabled: true,
      native_channel_allowed: false,
      allowed_channels: ['native', 'server'],
      device_secret_revoke_enabled: true,
      device_secret_revoke_trust_groups: ['mobile'],
      device_secret_introspection_enabled: false,
      device_secret_introspection_trust_groups: ['support'],
      redirect_uris: ['com.example.app:/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid offline_access',
      logo_uri: 'https://client.example/logo.png',
      client_uri: 'https://client.example',
      policy_uri: 'https://client.example/policy',
      tos_uri: 'https://client.example/terms',
      contacts: ['security@client.example'],
      post_logout_redirect_uris: ['com.example.app:/logout'],
      subject_type: 'pairwise',
      sector_identifier_uri: 'https://client.example/sector.json',
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: { keys: [] },
      jwks_uri: 'https://client.example/jwks.json',
      is_trusted: true,
      skip_consent: true,
      allow_claims_without_scope: true,
      claims_parameter_policy: { email: 'claims_allowed' },
      identity_mapping: { fieldMappingSetId: 'mapping-1' },
      attribute_release_consent: { mode: 'explicit' } as never,
      asc_enabled: false,
      asc_protected_request_required: false,
      asc_sao_enabled: false,
      asc_transformed_claims_enabled: false,
      asc_allowed_transformed_claims: ['email'],
      token_exchange_allowed: true,
      allowed_subject_token_clients: ['subject-client'],
      allowed_token_exchange_resources: ['https://api.example'],
      delegation_mode: 'impersonation',
      client_credentials_allowed: true,
      allowed_scopes: ['api:read'],
      default_scope: 'api:read',
      default_audience: 'https://api.example',
      default_resource: 'https://api.example',
      backchannel_token_delivery_mode: 'ping',
      backchannel_client_notification_endpoint: 'https://client.example/ciba',
      backchannel_authentication_request_signing_alg: 'RS256',
      backchannel_user_code_parameter: true,
      userinfo_signed_response_alg: 'RS256',
      backchannel_logout_uri: 'https://client.example/backchannel-logout',
      backchannel_logout_session_required: true,
      frontchannel_logout_uri: 'https://client.example/frontchannel-logout',
      frontchannel_logout_session_required: true,
      allowed_redirect_origins: ['https://client.example'],
      software_id: 'software-1',
      software_version: '1.0.0',
      requestable_scopes: ['profile'],
      require_pkce: true,
      initiate_login_uri: 'https://client.example/login',
      login_ui_url: 'https://client.example/ui',
    };

    const client = await repository.create(input);
    expect(client).toMatchObject({
      client_id: 'full-client',
      tenant_id: 'tenant-a',
      trust_group_id: 'mobile',
      native_sso_enabled: true,
      native_channel_allowed: false,
      device_secret_revoke_enabled: true,
      device_secret_introspection_enabled: false,
      is_trusted: true,
      skip_consent: true,
      asc_enabled: false,
      token_exchange_allowed: true,
      client_credentials_allowed: true,
      require_pkce: true,
    });
    expect(client.allowed_channels).toBe('["native","server"]');
    expect(client.jwks).toBe('{"keys":[]}');
    expect(client.claims_parameter_policy).toBe('{"email":"claims_allowed"}');
    expect(client.allowed_redirect_origins).toBe('["https://client.example"]');
  });

  it('normalizes pagination and escapes wildcard searches before querying', async () => {
    await repository.create({
      client_id: 'client-1',
      client_name: '100% client_name',
      redirect_uris: ['https://client.example/callback'],
    });
    const result = await repository.listByTenant('tenant-a', {
      page: 0,
      limit: 1000,
      search: '100%_\\',
      sortBy: 'client_name; DROP TABLE oauth_clients' as never,
      sortOrder: 'invalid' as never,
    });
    expect(result).toMatchObject({ page: 1, limit: 100, hasPrev: false });
    const log = adapter.getQueryLog();
    expect(log.some(({ sql }) => sql.includes('ORDER BY created_at DESC'))).toBe(true);
    expect(log.some(({ params }) => params?.includes('%100\\%\\_\\\\%'))).toBe(true);
  });

  it('reports bulk-delete misses without failing successful deletions', async () => {
    await repository.create({
      client_id: 'present',
      client_name: 'Present',
      redirect_uris: ['https://client.example/callback'],
    });
    await expect(repository.bulkDelete(['present', 'missing'])).resolves.toEqual({
      deleted: 1,
      failed: ['missing'],
    });
    await expect(repository.exists('present')).resolves.toBe(false);
    await expect(repository.countByTenant('tenant-a')).resolves.toBe(0);
  });
});
