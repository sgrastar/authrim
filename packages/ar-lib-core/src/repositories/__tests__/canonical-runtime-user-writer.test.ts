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
  let piiAdapter: MockDatabaseAdapter;
  let identityRepository: CanonicalIdentityRepository;
  let writer: CanonicalRuntimeUserWriter;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    for (const tableName of CANONICAL_TABLES) {
      adapter.initTable(tableName, 'id');
    }
    piiAdapter = new MockDatabaseAdapter();
    piiAdapter.initTable('identity_sensitive_values', 'id');
    identityRepository = new CanonicalIdentityRepository(adapter, 'tenant-a');
    writer = new CanonicalRuntimeUserWriter(identityRepository, piiAdapter);
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
      sensitiveValues: {
        email: 'person@example.test',
        phone_number: '+819012345678',
        name: 'Example Person',
        given_name: 'Example',
        family_name: 'Person',
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
      value_storage_ref: 'canonical-sensitive://tenant-a/user-1/email',
      verification_state: 'verified',
    });
    expect(
      adapter.getById('profile_attribute_values', 'profile-attribute:user-1:name')
    ).toMatchObject({
      value_storage_ref: 'canonical-sensitive://tenant-a/user-1/name',
      classification: 'sensitive',
    });
    expect(
      piiAdapter.getById('identity_sensitive_values', 'sensitive-value:user-1:email')
    ).toMatchObject({
      tenant_id: 'tenant-a',
      owner_type: 'runtime_user',
      owner_id: 'user-1',
      value_key: 'email',
      value_json: JSON.stringify('person@example.test'),
      lifecycle_state: 'active',
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
      sensitiveValues: {
        email: 'person@example.test',
        name: 'Example Person',
      },
    });
    adapter.seed('identity_accounts', [
      {
        ...adapter.getById('identity_accounts', 'account:user-1'),
        id: 'account:user-1',
        directory_publication_state: 'active',
      },
    ]);
    const resolver: CanonicalRuntimeValueResolver = {
      async resolveValue(valueStorageRef) {
        const values: Record<string, unknown> = {
          'canonical-sensitive://tenant-a/user-1/email': 'person@example.test',
          'canonical-sensitive://tenant-a/user-1/name': 'Example Person',
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
      locale: null,
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
      piiFields: { email: true, phone_number: true },
      sensitiveValues: {
        email: 'person@example.test',
        phone_number: '+819012345678',
      },
      inlineProfileFields: {
        'field.custom.employee_number': 'E-001',
      },
      addressJson: JSON.stringify({ formatted: 'old address', country: 'JP' }),
      customAttributesJson: JSON.stringify({ department: 'Engineering' }),
    });

    const result = await writer.syncFromRuntimeUser({
      userId: 'user-1',
      tenantId: 'tenant-a',
      active: false,
      emailVerified: false,
      phoneNumberVerified: true,
      displayName: 'Updated Person',
      locale: 'en-US',
      zoneinfo: 'America/Los_Angeles',
      piiFields: { email: true, phone_number: true },
      sensitiveValues: {
        email: 'updated@example.test',
        phone_number: '+14155550123',
      },
      inlineProfileFields: {
        'field.custom.employee_number': 'E-002',
      },
      addressJson: JSON.stringify({ formatted: 'new address', country: 'US' }),
      customAttributesJson: JSON.stringify({ department: 'Product' }),
    });

    expect(result).toMatchObject({
      created: false,
      profileAttributeCount: 3,
      contactPointCount: 2,
    });
    expect(adapter.getById('identity_accounts', 'account:user-1')).toMatchObject({
      lifecycle_state: 'deprovisioned',
      display_label: null,
    });
    expect(adapter.getById('identity_subjects', 'subject:user-1')).toMatchObject({
      lifecycle_state: 'deprovisioned',
      display_label: null,
    });
    expect(adapter.getById('profiles', 'profile:user-1')).toMatchObject({
      lifecycle_state: 'deprovisioned',
      locale: null,
      zoneinfo: null,
    });
    expect(adapter.getById('contact_points', 'contact:user-1:email')).toMatchObject({
      verification_state: 'unverified',
    });
    expect(adapter.getById('contact_points', 'contact:user-1:phone')).toMatchObject({
      verification_state: 'verified',
    });
    expect(
      adapter.getById(
        'profile_attribute_values',
        'profile-attribute:user-1:field.custom.employee_number'
      )
    ).toMatchObject({
      value_json: JSON.stringify('E-002'),
    });
    expect(
      adapter.getById('profile_attribute_values', 'profile-attribute:user-1:custom_attributes')
    ).toMatchObject({
      value_storage_ref: 'canonical-sensitive://tenant-a/user-1/custom_attributes_json',
      classification: 'sensitive',
    });
    expect(
      adapter.getById('profile_attribute_values', 'profile-attribute:user-1:address')
    ).toMatchObject({
      value_storage_ref: 'canonical-sensitive://tenant-a/user-1/address_json',
      classification: 'sensitive',
    });

    await writer.syncFromRuntimeUser({
      userId: 'user-1',
      tenantId: 'tenant-a',
      active: true,
      emailVerified: true,
      phoneNumberVerified: false,
      displayName: 'Updated Person',
      piiFields: { email: true, phone_number: true },
      sensitiveValues: { email: null, phone_number: '+14155550123' },
      addressJson: null,
      customAttributesJson: null,
    });

    expect(
      adapter.getById('profile_attribute_values', 'profile-attribute:user-1:custom_attributes')
    ).toMatchObject({
      lifecycle_state: 'deleted',
    });
    expect(
      adapter.getById('profile_attribute_values', 'profile-attribute:user-1:address')
    ).toMatchObject({
      lifecycle_state: 'deleted',
    });
    expect(
      piiAdapter.getById('identity_sensitive_values', 'sensitive-value:user-1:email')
    ).toMatchObject({
      lifecycle_state: 'deleted',
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
      sensitiveValues: { email: 'person@example.test' },
    });

    await expect(writer.deleteRuntimeUser('user-1')).resolves.toBe(true);
    expect(adapter.getById('identity_accounts', 'account:user-1')).toMatchObject({
      lifecycle_state: 'deleted',
    });
    expect(adapter.getById('identity_subjects', 'subject:user-1')).toMatchObject({
      lifecycle_state: 'deleted',
    });
    expect(
      piiAdapter.getById('identity_sensitive_values', 'sensitive-value:user-1:email')
    ).toMatchObject({
      lifecycle_state: 'deleted',
    });
  });
});
