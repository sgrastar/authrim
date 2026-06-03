import { beforeEach, describe, expect, it } from 'vitest';
import {
  CanonicalRuntimeUserProjectionRepository,
  CanonicalSensitiveValueResolver,
  decodeCanonicalSensitiveValueRef,
  encodeCanonicalSensitiveValueRef,
  type CanonicalRuntimeValueResolver,
} from '../identity';
import { MockDatabaseAdapter } from './mock-adapter';

const CANONICAL_TABLES = [
  'identity_subjects',
  'identity_accounts',
  'profiles',
  'profile_attribute_values',
  'structured_attribute_values',
  'contact_points',
];

describe('CanonicalRuntimeUserProjectionRepository', () => {
  let adapter: MockDatabaseAdapter;
  let valueResolver: CanonicalRuntimeValueResolver;
  let repository: CanonicalRuntimeUserProjectionRepository;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    for (const tableName of CANONICAL_TABLES) {
      adapter.initTable(tableName, 'id');
    }
    valueResolver = {
      async resolveValue(valueStorageRef) {
        const values: Record<string, unknown> = {
          'pii://tenant-a/email/user-1': 'person@example.test',
          'pii://tenant-a/phone/user-1': '+819012345678',
          'pii://tenant-a/name/user-1': 'Example Person',
          'pii://tenant-a/address/user-1': {
            formatted: '1-1 Chiyoda',
            country: 'JP',
          },
        };
        return values[valueStorageRef] ?? null;
      },
    };
    repository = new CanonicalRuntimeUserProjectionRepository(adapter, 'tenant-a', valueResolver);
  });

  it('projects an active canonical identity graph into the runtime user shape', async () => {
    seedActiveCanonicalUser();

    const projection = await repository.findByLegacyUserId('user-1');

    expect(projection).toMatchObject({
      id: 'user-1',
      tenant_id: 'tenant-a',
      subject_id: 'subject-1',
      account_id: 'account-1',
      email: 'person@example.test',
      email_verified: 1,
      phone_number: '+819012345678',
      phone_number_verified: 0,
      name: 'Example Person',
      given_name: 'Example',
      family_name: 'Person',
      locale: 'ja-JP',
      zoneinfo: 'Asia/Tokyo',
      active: 1,
      address_json: JSON.stringify({
        formatted: '1-1 Chiyoda',
        country: 'JP',
      }),
    });
    expect(projection?.custom_attributes_json).toBe(
      JSON.stringify({ 'field.custom.employee_number': 'E-001' })
    );
  });

  it('does not read legacy users_core or users_pii tables', async () => {
    seedActiveCanonicalUser();

    await repository.findByLegacyUserId('user-1');

    const queriedSql = adapter
      .getQueryLog()
      .map((entry) => entry.sql)
      .join('\n');
    expect(queriedSql).toContain('identity_accounts');
    expect(queriedSql).toContain('identity_subjects');
    expect(queriedSql).not.toContain('users_core');
    expect(queriedSql).not.toContain('users_pii');
  });

  it('returns null for inactive accounts unless explicitly requested', async () => {
    seedActiveCanonicalUser({ accountLifecycleState: 'suspended' });

    await expect(repository.findByLegacyUserId('user-1')).resolves.toBeNull();

    const projection = await repository.findByLegacyUserId('user-1', { includeInactive: true });
    expect(projection).toMatchObject({
      id: 'user-1',
      active: 0,
    });
  });

  it('encodes and resolves canonical sensitive value storage refs through an explicit resolver', async () => {
    const piiAdapter = new MockDatabaseAdapter();
    piiAdapter.initTable('identity_sensitive_values', 'id');
    piiAdapter.seed('identity_sensitive_values', [
      {
        id: 'sensitive-value:user-1:email',
        tenant_id: 'tenant-a',
        owner_type: 'runtime_user',
        owner_id: 'user-1',
        value_key: 'email',
        value_json: JSON.stringify('resolved@example.test'),
        lifecycle_state: 'active',
      },
    ]);
    const ref = encodeCanonicalSensitiveValueRef({
      tenantId: 'tenant-a',
      userId: 'user-1',
      field: 'email',
    });
    const resolver = new CanonicalSensitiveValueResolver(piiAdapter);

    expect(decodeCanonicalSensitiveValueRef(ref)).toEqual({
      tenantId: 'tenant-a',
      userId: 'user-1',
      field: 'email',
    });
    await expect(
      resolver.resolveValue(ref, {
        tenantId: 'tenant-a',
        subjectId: 'subject-1',
        accountId: 'account-1',
      })
    ).resolves.toBe('resolved@example.test');
    await expect(
      resolver.resolveValue(ref, {
        tenantId: 'tenant-b',
        subjectId: 'subject-1',
        accountId: 'account-1',
      })
    ).rejects.toThrow(/tenant mismatch/);
  });

  function seedActiveCanonicalUser(
    options: { accountLifecycleState?: string; subjectLifecycleState?: string } = {}
  ): void {
    adapter.seed('identity_subjects', [
      {
        id: 'subject-1',
        tenant_id: 'tenant-a',
        subject_type: 'person',
        lifecycle_state: options.subjectLifecycleState ?? 'active',
        display_label: 'Fallback Name',
        primary_account_id: 'account-1',
        risk_tier: null,
        assurance_level: null,
        metadata_json: null,
        created_at: 1_700_000_000,
        updated_at: 1_700_000_010,
        deleted_at: null,
      },
    ]);
    adapter.seed('identity_accounts', [
      {
        id: 'account-1',
        tenant_id: 'tenant-a',
        account_type: 'user',
        lifecycle_state: options.accountLifecycleState ?? 'active',
        legacy_user_id: 'user-1',
        primary_subject_id: 'subject-1',
        display_label: null,
        metadata_json: null,
        created_at: 1_700_000_000,
        updated_at: 1_700_000_020,
        deleted_at: null,
      },
    ]);
    adapter.seed('profiles', [
      {
        id: 'profile-1',
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        profile_type: 'person',
        lifecycle_state: 'active',
        locale: 'ja-JP',
        zoneinfo: 'Asia/Tokyo',
        display_name_ref: null,
        metadata_json: null,
        created_at: 1_700_000_000,
        updated_at: 1_700_000_000,
        deleted_at: null,
      },
    ]);
    adapter.seed('profile_attribute_values', [
      {
        id: 'profile-attribute-name',
        tenant_id: 'tenant-a',
        profile_id: 'profile-1',
        catalog_entry_id: 'field.canonical.name',
        value_type: 'reference',
        value_json: null,
        value_storage_ref: 'pii://tenant-a/name/user-1',
        value_hash: 'hash-name',
        classification: 'sensitive',
        purpose: 'profile',
        is_primary: 1,
        display_order: 0,
        lifecycle_state: 'active',
        created_at: 1_700_000_000,
        updated_at: 1_700_000_000,
        deleted_at: null,
      },
      {
        id: 'profile-attribute-given-name',
        tenant_id: 'tenant-a',
        profile_id: 'profile-1',
        catalog_entry_id: 'field.canonical.given_name',
        value_type: 'string',
        value_json: JSON.stringify('Example'),
        value_storage_ref: null,
        value_hash: null,
        classification: 'internal',
        purpose: 'profile',
        is_primary: 0,
        display_order: 1,
        lifecycle_state: 'active',
        created_at: 1_700_000_001,
        updated_at: 1_700_000_001,
        deleted_at: null,
      },
      {
        id: 'profile-attribute-family-name',
        tenant_id: 'tenant-a',
        profile_id: 'profile-1',
        catalog_entry_id: 'field.canonical.family_name',
        value_type: 'string',
        value_json: JSON.stringify('Person'),
        value_storage_ref: null,
        value_hash: null,
        classification: 'internal',
        purpose: 'profile',
        is_primary: 0,
        display_order: 2,
        lifecycle_state: 'active',
        created_at: 1_700_000_002,
        updated_at: 1_700_000_002,
        deleted_at: null,
      },
      {
        id: 'profile-attribute-custom',
        tenant_id: 'tenant-a',
        profile_id: 'profile-1',
        catalog_entry_id: 'field.custom.employee_number',
        value_type: 'string',
        value_json: JSON.stringify('E-001'),
        value_storage_ref: null,
        value_hash: null,
        classification: 'internal',
        purpose: 'profile',
        is_primary: 0,
        display_order: 3,
        lifecycle_state: 'active',
        created_at: 1_700_000_003,
        updated_at: 1_700_000_003,
        deleted_at: null,
      },
      {
        id: 'profile-attribute-address',
        tenant_id: 'tenant-a',
        profile_id: 'profile-1',
        catalog_entry_id: 'field.canonical.address',
        value_type: 'reference',
        value_json: null,
        value_storage_ref: 'pii://tenant-a/address/user-1',
        value_hash: 'hash-address',
        classification: 'sensitive',
        purpose: 'profile',
        is_primary: 0,
        display_order: 4,
        lifecycle_state: 'active',
        created_at: 1_700_000_004,
        updated_at: 1_700_000_004,
        deleted_at: null,
      },
    ]);
    adapter.seed('contact_points', [
      {
        id: 'contact-email-other-account',
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        account_id: 'account-2',
        contact_type: 'email',
        purpose: 'primary',
        normalized_hash: 'hash-email-other-account',
        value_storage_ref: 'pii://tenant-a/email/other-account',
        display_label: 'other@example.test',
        is_primary: 1,
        verification_state: 'verified',
        lifecycle_state: 'active',
        created_at: 1_699_999_999,
        updated_at: 1_699_999_999,
        deleted_at: null,
      },
      {
        id: 'contact-email',
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        account_id: 'account-1',
        contact_type: 'email',
        purpose: 'primary',
        normalized_hash: 'hash-email',
        value_storage_ref: 'pii://tenant-a/email/user-1',
        display_label: 'p***@example.test',
        is_primary: 1,
        verification_state: 'verified',
        lifecycle_state: 'active',
        created_at: 1_700_000_000,
        updated_at: 1_700_000_000,
        deleted_at: null,
      },
      {
        id: 'contact-phone',
        tenant_id: 'tenant-a',
        subject_id: 'subject-1',
        account_id: 'account-1',
        contact_type: 'phone',
        purpose: 'primary',
        normalized_hash: 'hash-phone',
        value_storage_ref: 'pii://tenant-a/phone/user-1',
        display_label: '+81********78',
        is_primary: 1,
        verification_state: 'unverified',
        lifecycle_state: 'active',
        created_at: 1_700_000_001,
        updated_at: 1_700_000_001,
        deleted_at: null,
      },
    ]);
  }
});
