import { describe, expect, it } from 'vitest';
import { SubjectIdentifierRepository } from '../pii/subject-identifier';
import { MockDatabaseAdapter } from './mock-adapter';

describe('SubjectIdentifierRepository outbound identifiers', () => {
  it('rejects unscoped identifier writes and reads', async () => {
    const adapter = new MockDatabaseAdapter();
    adapter.initTable('subject_identifiers', 'id');
    const repository = new SubjectIdentifierRepository(adapter);

    await expect(
      repository.createSubjectIdentifier({
        tenant_id: '',
        subject_id: 'subject-1',
        identifier_type: 'email',
        identifier_value: 'user@example.test',
      })
    ).rejects.toThrow('SubjectIdentifierRepository create requires tenantId');
    await expect(repository.findBySubjectId('', 'subject-1')).rejects.toThrow(
      'SubjectIdentifierRepository lookup requires tenantId'
    );
  });

  it('stores destination-scoped subject identifiers and resolves active values', async () => {
    const adapter = new MockDatabaseAdapter();
    adapter.initTable('subject_identifiers', 'id');
    const repository = new SubjectIdentifierRepository(adapter);

    const identifier = await repository.createOutboundSubjectIdentifier({
      id: 'subject-identifier-1',
      tenant_id: 'tenant-a',
      subject_id: 'subject-1',
      identifier_type: 'oidc_sub',
      identifier_value: 'opaque-subject',
      is_primary: true,
      destination_type: 'oidc_client',
      destination_id: 'client-1',
      identifier_value_hash: 'blind-index-subject',
      verification_method: 'strategy:opaque_pairwise',
    });

    expect(identifier.lifecycle_state).toBe('active');
    await expect(
      repository.findByDestination('tenant-a', 'subject-1', 'oidc_client', 'client-1', 'oidc_sub')
    ).resolves.toMatchObject({
      id: 'subject-identifier-1',
      identifier_value: 'opaque-subject',
    });
    await expect(
      repository.findByIdentifierHash('tenant-a', 'oidc_sub', 'blind-index-subject')
    ).resolves.toMatchObject({
      id: 'subject-identifier-1',
    });
  });

  it('does not return deleted destination identifiers as active', async () => {
    const adapter = new MockDatabaseAdapter();
    adapter.initTable('subject_identifiers', 'id');
    adapter.seed('subject_identifiers', [
      {
        id: 'deleted-subject-identifier',
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        identifier_type: 'oidc_sub',
        identifier_value: 'old-subject',
        is_primary: 1,
        destination_type: 'oidc_client',
        destination_id: 'client-1',
        identifier_value_hash: 'old-hash',
        lifecycle_state: 'deleted',
        created_at: 1000,
        updated_at: 1000,
      },
    ]);
    const repository = new SubjectIdentifierRepository(adapter);

    await expect(
      repository.findByDestination('tenant-a', 'subject-1', 'oidc_client', 'client-1', 'oidc_sub')
    ).resolves.toBeNull();
  });
});
