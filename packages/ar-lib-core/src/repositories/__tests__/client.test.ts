import { beforeEach, describe, expect, it } from 'vitest';
import { MockDatabaseAdapter } from './mock-adapter';
import { ClientRepository } from '../core/client';

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
