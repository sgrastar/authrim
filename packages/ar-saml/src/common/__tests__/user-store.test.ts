import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(),
  resolveAccountDataContext: vi.fn(),
  resolveAccountDataContextByIdentifier: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    resolveCustomClaimRuntimeSourcesFromEnv: mocked.resolveCustomClaimRuntimeSourcesFromEnv,
    resolveAccountDataContext: mocked.resolveAccountDataContext,
    resolveAccountDataContextByIdentifier: mocked.resolveAccountDataContextByIdentifier,
  };
});

import {
  findActiveSamlUserByEmail,
  getSamlUserInfoById,
  getSamlUserNameIdById,
} from '../user-store';

function createMockAdapter(
  options: {
    query?: (sql: string, params: unknown[]) => unknown[] | Promise<unknown[]>;
    queryOne?: (sql: string, params: unknown[]) => unknown | Promise<unknown>;
  } = {}
): DatabaseAdapter {
  const queryImpl: DatabaseAdapter['query'] = async <T>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> => ((await options.query?.(sql, params)) ?? []) as T[];
  const queryOneImpl: DatabaseAdapter['queryOne'] = async <T>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | null> => ((await options.queryOne?.(sql, params)) ?? null) as T | null;
  return {
    query: vi.fn(queryImpl) as unknown as DatabaseAdapter['query'],
    queryOne: vi.fn(queryOneImpl) as unknown as DatabaseAdapter['queryOne'],
    execute: vi.fn().mockResolvedValue({ rowsAffected: 1, insertId: undefined }),
    transaction: vi.fn(async (fn: any) => fn()),
    batch: vi.fn().mockResolvedValue([]),
    isHealthy: vi.fn().mockResolvedValue(true),
    getType: vi.fn().mockReturnValue('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SAML user-store helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.resolveCustomClaimRuntimeSourcesFromEnv.mockResolvedValue({
      schemaDb: createMockAdapter(),
      nonPiiDb: createMockAdapter(),
      piiDb: null,
    });
  });

  function createCanonicalCoreAdapter(
    tenantId: string,
    userId: string,
    options: { emailRef?: string; nameRef?: string; customAttributesJson?: string | null } = {}
  ): DatabaseAdapter {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM identity_accounts')) {
          expect(params).toEqual([userId, tenantId]);
          return {
            id: `account:${userId}`,
            tenant_id: tenantId,
            account_type: 'user',
            lifecycle_state: 'active',
            legacy_user_id: userId,
            primary_subject_id: `subject:${userId}`,
            display_label: null,
            metadata_json: null,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_010,
            deleted_at: null,
          };
        }
        if (sql.includes('FROM identity_subjects')) {
          expect(params).toEqual([`subject:${userId}`, tenantId]);
          return {
            id: `subject:${userId}`,
            tenant_id: tenantId,
            subject_type: 'person',
            lifecycle_state: 'active',
            display_label: null,
            primary_account_id: `account:${userId}`,
            risk_tier: null,
            assurance_level: null,
            metadata_json: null,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_010,
            deleted_at: null,
          };
        }
        if (sql.includes('FROM profiles')) {
          return {
            id: `profile:${userId}`,
            tenant_id: tenantId,
            subject_id: `subject:${userId}`,
            profile_type: 'person',
            lifecycle_state: 'active',
            locale: null,
            zoneinfo: null,
            display_name_ref: null,
            metadata_json: null,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
            deleted_at: null,
          };
        }
        return null;
      },
      query: (sql) => {
        if (sql.includes('FROM profile_attribute_values')) {
          const rows = [];
          if (options.nameRef) {
            rows.push({
              id: `profile-attribute:${userId}:name`,
              tenant_id: tenantId,
              profile_id: `profile:${userId}`,
              catalog_entry_id: 'field.canonical.name',
              value_type: 'reference',
              value_json: null,
              value_storage_ref: options.nameRef,
              value_hash: null,
              classification: 'sensitive',
              purpose: 'profile',
              is_primary: 1,
              display_order: 0,
              lifecycle_state: 'active',
              created_at: 1_700_000_000,
              updated_at: 1_700_000_000,
              deleted_at: null,
            });
          }
          if (options.customAttributesJson) {
            rows.push({
              id: `profile-attribute:${userId}:custom_attributes`,
              tenant_id: tenantId,
              profile_id: `profile:${userId}`,
              catalog_entry_id: 'field.canonical.custom_attributes',
              value_type: 'reference',
              value_json: null,
              value_storage_ref: `canonical-sensitive://${tenantId}/${userId}/custom_attributes_json`,
              value_hash: null,
              classification: 'sensitive',
              purpose: 'profile',
              is_primary: 0,
              display_order: 1,
              lifecycle_state: 'active',
              created_at: 1_700_000_001,
              updated_at: 1_700_000_001,
              deleted_at: null,
            });
          }
          return rows;
        }
        if (sql.includes('FROM contact_points')) {
          return options.emailRef
            ? [
                {
                  id: `contact:${userId}:email`,
                  tenant_id: tenantId,
                  subject_id: `subject:${userId}`,
                  account_id: `account:${userId}`,
                  contact_type: 'email',
                  purpose: 'primary',
                  normalized_hash: 'hash-email',
                  value_storage_ref: options.emailRef,
                  display_label: null,
                  is_primary: 1,
                  verification_state: 'verified',
                  lifecycle_state: 'active',
                  created_at: 1_700_000_000,
                  updated_at: 1_700_000_000,
                  deleted_at: null,
                },
              ]
            : [];
        }
        return [];
      },
    });
    return coreAdapter;
  }

  function mockAccountRoute(coreDb: DatabaseAdapter, piiDb: DatabaseAdapter): void {
    const route = { coreDb, piiDb };
    mocked.resolveAccountDataContext.mockResolvedValue(route);
    mocked.resolveAccountDataContextByIdentifier.mockResolvedValue(route);
  }

  it('finds active users by email from canonical sensitive PII storage', async () => {
    const coreAdapter = createCanonicalCoreAdapter('tenant-a', 'user-1');
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM identity_sensitive_values')) {
          expect(params).toEqual(['tenant-a', JSON.stringify('user@example.com')]);
          return { owner_id: 'user-1' };
        }
        return null;
      },
    });

    mockAccountRoute(coreAdapter, piiAdapter);

    await expect(
      findActiveSamlUserByEmail({ DB: {} } as Env, 'tenant-a', 'user@example.com')
    ).resolves.toEqual({ id: 'user-1' });
  });

  it('reads NameID email from canonical projection and PII sensitive storage', async () => {
    const coreAdapter = createCanonicalCoreAdapter('tenant-b', 'user-2', {
      emailRef: 'canonical-sensitive://tenant-b/user-2/email',
    });
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM identity_sensitive_values')) {
          expect(params).toEqual(['tenant-b', 'user-2', 'email']);
          return { value_json: JSON.stringify('nameid@example.com') };
        }
        return null;
      },
    });

    mockAccountRoute(coreAdapter, piiAdapter);

    await expect(getSamlUserNameIdById({ DB: {} } as Env, 'tenant-b', 'user-2')).resolves.toBe(
      'nameid@example.com'
    );
  });

  it('returns complete SAML user info from canonical projection stores', async () => {
    const coreAdapter = createCanonicalCoreAdapter('tenant-c', 'user-3', {
      emailRef: 'canonical-sensitive://tenant-c/user-3/email',
      nameRef: 'canonical-sensitive://tenant-c/user-3/name',
      customAttributesJson: JSON.stringify({
        libraryMemberId: 'member-a',
        piiEntitlement: ['premium'],
      }),
    });
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM identity_sensitive_values')) {
          const [, , field] = params;
          const values: Record<string, string> = {
            email: JSON.stringify('full@example.com'),
            name: JSON.stringify('Full User'),
            custom_attributes_json: JSON.stringify({
              libraryMemberId: 'member-a',
              piiEntitlement: ['premium'],
            }),
          };
          return { value_json: values[field as string] ?? null };
        }
        return null;
      },
    });
    const customAdapter = createMockAdapter({
      query: (sql, params) => {
        if (sql.includes('FROM user_custom_fields WHERE user_id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['user-3', 'tenant-c']);
          return [
            { field_name: 'affiliation', field_value: JSON.stringify(['member@example.edu']) },
            { field_name: 'entitlement', field_value: 'urn:mace:dir:entitlement:common-lib-terms' },
            { field_name: 'empty', field_value: null },
          ];
        }
        return [];
      },
    });

    mockAccountRoute(coreAdapter, piiAdapter);
    mocked.resolveCustomClaimRuntimeSourcesFromEnv.mockResolvedValue({
      schemaDb: customAdapter,
      nonPiiDb: customAdapter,
      piiDb: null,
    });

    await expect(getSamlUserInfoById({ DB: {} } as Env, 'tenant-c', 'user-3')).resolves.toEqual({
      id: 'user-3',
      email: 'full@example.com',
      name: 'Full User',
      customClaims: {
        affiliation: ['member@example.edu'],
        entitlement: 'urn:mace:dir:entitlement:common-lib-terms',
      },
      customFields: {
        libraryMemberId: 'member-a',
        piiEntitlement: ['premium'],
      },
    });
  });

  it('returns active SAML users without an email address', async () => {
    const coreAdapter = createCanonicalCoreAdapter('tenant-no-email', 'user-no-email');
    const piiAdapter = createMockAdapter();

    mockAccountRoute(coreAdapter, piiAdapter);

    await expect(
      getSamlUserInfoById({ DB: {} } as Env, 'tenant-no-email', 'user-no-email')
    ).resolves.toEqual({
      id: 'user-no-email',
      customClaims: {},
      customFields: {},
    });
  });

  it('prefers canonical runtime projection for SAML user info when cutover flag is enabled', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM identity_accounts')) {
          expect(params).toEqual(['user-4', 'tenant-d']);
          return {
            id: 'account:user-4',
            tenant_id: 'tenant-d',
            account_type: 'user',
            lifecycle_state: 'active',
            legacy_user_id: 'user-4',
            primary_subject_id: 'subject:user-4',
            display_label: null,
            metadata_json: null,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_010,
            deleted_at: null,
          };
        }
        if (sql.includes('FROM identity_subjects')) {
          expect(params).toEqual(['subject:user-4', 'tenant-d']);
          return {
            id: 'subject:user-4',
            tenant_id: 'tenant-d',
            subject_type: 'person',
            lifecycle_state: 'active',
            display_label: 'Canonical User',
            primary_account_id: 'account:user-4',
            risk_tier: null,
            assurance_level: null,
            metadata_json: null,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_010,
            deleted_at: null,
          };
        }
        if (sql.includes('FROM profiles')) {
          return {
            id: 'profile:user-4',
            tenant_id: 'tenant-d',
            subject_id: 'subject:user-4',
            profile_type: 'person',
            lifecycle_state: 'active',
            locale: 'ja-JP',
            zoneinfo: 'Asia/Tokyo',
            display_name_ref: null,
            metadata_json: null,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
            deleted_at: null,
          };
        }
        return null;
      },
      query: (sql) => {
        if (sql.includes('FROM profile_attribute_values')) {
          return [
            {
              id: 'profile-attribute:name',
              tenant_id: 'tenant-d',
              profile_id: 'profile:user-4',
              catalog_entry_id: 'field.canonical.name',
              value_type: 'reference',
              value_json: null,
              value_storage_ref: 'canonical-sensitive://tenant-d/user-4/name',
              value_hash: null,
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
              id: 'profile-attribute:custom',
              tenant_id: 'tenant-d',
              profile_id: 'profile:user-4',
              catalog_entry_id: 'eduPersonAffiliation',
              value_type: 'string',
              value_json: JSON.stringify('member'),
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
          ];
        }
        if (sql.includes('FROM contact_points')) {
          return [
            {
              id: 'contact:user-4:email',
              tenant_id: 'tenant-d',
              subject_id: 'subject:user-4',
              account_id: 'account:user-4',
              contact_type: 'email',
              purpose: 'primary',
              normalized_hash: 'hash-email',
              value_storage_ref: 'canonical-sensitive://tenant-d/user-4/email',
              display_label: null,
              is_primary: 1,
              verification_state: 'verified',
              lifecycle_state: 'active',
              created_at: 1_700_000_000,
              updated_at: 1_700_000_000,
              deleted_at: null,
            },
          ];
        }
        return [];
      },
    });
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM identity_sensitive_values')) {
          const [, , field] = params;
          const values: Record<string, string> = {
            email: JSON.stringify('canonical@example.com'),
            name: JSON.stringify('Canonical User'),
          };
          return { value_json: values[field as string] ?? null };
        }
        return null;
      },
    });

    mockAccountRoute(coreAdapter, piiAdapter);

    await expect(getSamlUserInfoById({ DB: {} } as Env, 'tenant-d', 'user-4')).resolves.toEqual({
      id: 'user-4',
      email: 'canonical@example.com',
      name: 'Canonical User',
      customClaims: {},
      customFields: {
        eduPersonAffiliation: 'member',
      },
    });

    expect(coreAdapter.queryOne).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM users_core'),
      expect.anything()
    );
  });
});
