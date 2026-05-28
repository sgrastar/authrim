import { beforeEach, describe, expect, it } from 'vitest';
import {
  CanonicalIdentityRepository,
  CanonicalRuntimeUserProjectionRepository,
  CanonicalRuntimeUserWriter,
  type CanonicalRuntimeValueResolver,
} from '../identity';
import { MockDatabaseAdapter } from './mock-adapter';

const CANONICAL_TABLES = [
  'identity_subjects',
  'identity_accounts',
  'subject_account_links',
  'profiles',
  'profile_attribute_values',
  'structured_attribute_values',
  'contact_points',
  'contact_verifications',
  'identity_bindings',
  'identity_resolution_events',
  'identity_resolution_candidates',
  'assurance_evidence',
];

describe('CanonicalRuntimeUserWriter', () => {
  let adapter: MockDatabaseAdapter;
  let identityRepository: CanonicalIdentityRepository;
  let writer: CanonicalRuntimeUserWriter;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    for (const tableName of CANONICAL_TABLES) {
      adapter.initTable(tableName, 'id');
    }
    identityRepository = new CanonicalIdentityRepository(adapter, 'tenant-a');
    writer = new CanonicalRuntimeUserWriter(identityRepository);
  });

  it('creates a canonical graph and storage refs for a runtime user write', async () => {
    const result = await writer.createFromRuntimeUser({
      userId: 'user-1',
      tenantId: 'tenant-a',
      active: true,
      emailVerified: true,
      phoneNumberVerified: false,
      userType: 'end_user',
      displayName: 'Example Person',
      locale: 'ja-JP',
      zoneinfo: 'Asia/Tokyo',
      sourceRef: 'scim:/Users',
      piiFields: {
        email: true,
        phone_number: true,
        name: true,
        given_name: true,
        family_name: true,
      },
      inlineProfileFields: {
        'field.custom.employee_number': 'E-001',
      },
    });

    expect(result.graph).not.toBeNull();
    const graph = result.graph!;
    expect(graph.subject).toMatchObject({
      id: 'subject:user-1',
      subject_type: 'person',
      primary_account_id: 'account:user-1',
    });
    expect(graph.account).toMatchObject({
      id: 'account:user-1',
      account_type: 'user',
      legacy_user_id: 'user-1',
      primary_subject_id: 'subject:user-1',
    });
    expect(result.profileAttributeCount).toBe(4);
    expect(result.contactPointCount).toBe(2);

    expect(adapter.getById('contact_points', 'contact:user-1:email')).toMatchObject({
      value_storage_ref: 'legacy-users-pii://tenant-a/user-1/email',
      verification_state: 'verified',
    });
    expect(
      adapter.getById('profile_attribute_values', 'profile-attribute:user-1:name')
    ).toMatchObject({
      value_storage_ref: 'legacy-users-pii://tenant-a/user-1/name',
      classification: 'sensitive',
    });
  });

  it('round-trips a written graph through the runtime projection boundary', async () => {
    await writer.createFromRuntimeUser({
      userId: 'user-1',
      tenantId: 'tenant-a',
      active: true,
      emailVerified: true,
      displayName: 'Example Person',
      locale: 'ja-JP',
      piiFields: {
        email: true,
        name: true,
      },
    });
    const resolver: CanonicalRuntimeValueResolver = {
      async resolveValue(valueStorageRef) {
        const values: Record<string, unknown> = {
          'legacy-users-pii://tenant-a/user-1/email': 'person@example.test',
          'legacy-users-pii://tenant-a/user-1/name': 'Example Person',
        };
        return values[valueStorageRef] ?? null;
      },
    };
    const projectionRepository = new CanonicalRuntimeUserProjectionRepository(
      adapter,
      'tenant-a',
      resolver
    );

    const projection = await projectionRepository.findByLegacyUserId('user-1');

    expect(projection).toMatchObject({
      id: 'user-1',
      email: 'person@example.test',
      email_verified: 1,
      name: 'Example Person',
      locale: 'ja-JP',
      active: 1,
    });
    const queriedSql = adapter
      .getQueryLog()
      .map((entry) => entry.sql)
      .join('\n');
    expect(queriedSql).not.toContain('users_core');
    expect(queriedSql).not.toContain('users_pii');
  });

  it('syncs lifecycle for an existing canonical runtime user without recreating the graph', async () => {
    await writer.createFromRuntimeUser({
      userId: 'user-1',
      tenantId: 'tenant-a',
      active: true,
      emailVerified: true,
      displayName: 'Example Person',
      piiFields: { email: true },
    });

    const result = await writer.syncFromRuntimeUser({
      userId: 'user-1',
      tenantId: 'tenant-a',
      active: false,
      displayName: 'Example Person',
      piiFields: { email: true },
    });

    expect(result).toMatchObject({ created: false });
    expect(adapter.getById('identity_accounts', 'account:user-1')).toMatchObject({
      lifecycle_state: 'deprovisioned',
    });
    expect(adapter.getById('identity_subjects', 'subject:user-1')).toMatchObject({
      lifecycle_state: 'deprovisioned',
    });
  });

  it('marks canonical runtime users deleted for SCIM delete cutover', async () => {
    await writer.createFromRuntimeUser({
      userId: 'user-1',
      tenantId: 'tenant-a',
      active: true,
      emailVerified: true,
      displayName: 'Example Person',
      piiFields: { email: true },
    });

    await expect(writer.deleteRuntimeUser('user-1')).resolves.toBe(true);
    expect(adapter.getById('identity_accounts', 'account:user-1')).toMatchObject({
      lifecycle_state: 'deleted',
    });
    expect(adapter.getById('identity_subjects', 'subject:user-1')).toMatchObject({
      lifecycle_state: 'deleted',
    });
  });
});
