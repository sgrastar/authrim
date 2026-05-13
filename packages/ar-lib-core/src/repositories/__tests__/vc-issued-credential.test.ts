import { beforeEach, describe, expect, it } from 'vitest';
import { MockDatabaseAdapter } from './mock-adapter';
import { IssuedCredentialRepository } from '../vc/issued-credential';

describe('IssuedCredentialRepository public/internal ID model', () => {
  let adapter: MockDatabaseAdapter;
  let repository: IssuedCredentialRepository;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    adapter.initTable('issued_credentials', 'internal_id');
    repository = new IssuedCredentialRepository(adapter);
  });

  it('stores public ID separately from internal ID and preserves status list internal FK', async () => {
    const credential = await repository.createCredential({
      internal_id: 'ic_internal_1',
      id: 'credential-public-1',
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      credential_type: 'UniversityDegreeCredential',
      format: 'dc+sd-jwt',
      status_list_id: 'status-public-1',
      status_list_internal_id: 'sl_internal_1',
      status_list_index: 42,
    });

    expect(credential).toMatchObject({
      internal_id: 'ic_internal_1',
      id: 'credential-public-1',
      tenant_id: 'tenant-a',
      status_list_id: 'status-public-1',
      status_list_internal_id: 'sl_internal_1',
      status_list_index: 42,
    });
    expect(adapter.getById('issued_credentials', 'ic_internal_1')).toMatchObject({
      internal_id: 'ic_internal_1',
      public_id: 'credential-public-1',
      status_list_internal_id: 'sl_internal_1',
    });
  });

  it('looks up duplicate public IDs within the requested tenant only', async () => {
    adapter.seed('issued_credentials', [
      {
        internal_id: 'ic_tenant_a',
        public_id: 'credential-shared',
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        credential_type: 'UniversityDegreeCredential',
        format: 'dc+sd-jwt',
        claims: '{}',
        status: 'active',
        status_list_id: 'status-a',
        status_list_internal_id: 'sl_internal_a',
        status_list_index: 1,
        holder_binding: null,
        expires_at: null,
        created_at: 100,
        updated_at: 100,
      },
      {
        internal_id: 'ic_tenant_b',
        public_id: 'credential-shared',
        tenant_id: 'tenant-b',
        user_id: 'user-b',
        credential_type: 'UniversityDegreeCredential',
        format: 'dc+sd-jwt',
        claims: '{}',
        status: 'active',
        status_list_id: 'status-b',
        status_list_internal_id: 'sl_internal_b',
        status_list_index: 2,
        holder_binding: null,
        expires_at: null,
        created_at: 200,
        updated_at: 200,
      },
    ]);

    const tenantA = await repository.findByIdForTenant('tenant-a', 'credential-shared');
    const tenantB = await repository.findByIdForTenant('tenant-b', 'credential-shared');
    const tenantC = await repository.findByIdForTenant('tenant-c', 'credential-shared');

    expect(tenantA?.tenant_id).toBe('tenant-a');
    expect(tenantA?.internal_id).toBe('ic_tenant_a');
    expect(tenantB?.tenant_id).toBe('tenant-b');
    expect(tenantB?.internal_id).toBe('ic_tenant_b');
    expect(tenantC).toBeNull();
  });

  it('updates credential lifecycle by tenant and public ID only', async () => {
    adapter.seed('issued_credentials', [
      {
        internal_id: 'ic_tenant_a',
        public_id: 'credential-shared',
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        credential_type: 'UniversityDegreeCredential',
        format: 'dc+sd-jwt',
        claims: '{}',
        status: 'active',
        status_list_id: 'status-a',
        status_list_internal_id: 'sl_internal_a',
        status_list_index: 1,
        holder_binding: null,
        expires_at: null,
        created_at: 100,
        updated_at: 100,
      },
      {
        internal_id: 'ic_tenant_b',
        public_id: 'credential-shared',
        tenant_id: 'tenant-b',
        user_id: 'user-b',
        credential_type: 'UniversityDegreeCredential',
        format: 'dc+sd-jwt',
        claims: '{}',
        status: 'active',
        status_list_id: 'status-b',
        status_list_internal_id: 'sl_internal_b',
        status_list_index: 2,
        holder_binding: null,
        expires_at: null,
        created_at: 200,
        updated_at: 200,
      },
    ]);

    await expect(repository.revoke('tenant-a', 'credential-shared')).resolves.toBe(true);

    expect(adapter.getById('issued_credentials', 'ic_tenant_a')).toMatchObject({
      status: 'revoked',
    });
    expect(adapter.getById('issued_credentials', 'ic_tenant_b')).toMatchObject({
      status: 'active',
    });
  });
});
