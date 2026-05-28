import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocked = vi.hoisted(() => ({
  resolveUserStoreRuntimeSourcesFromEnv: vi.fn(),
  resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    resolveUserStoreRuntimeSourcesFromEnv: mocked.resolveUserStoreRuntimeSourcesFromEnv,
    resolveCustomClaimRuntimeSourcesFromEnv: mocked.resolveCustomClaimRuntimeSourcesFromEnv,
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
      storageProfile: {
        id: 'builtin:storage:single-db',
        kind: 'storage',
        label: 'Single DB',
        slices: {},
      },
      schemaDb: createMockAdapter(),
      nonPiiDb: createMockAdapter(),
      piiDb: null,
    });
  });

  it('finds active users by email from the runtime-resolved pii store', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1')) {
          expect(params).toEqual(['user-1', 'tenant-a']);
          return { id: 'user-1' };
        }
        return null;
      },
    });
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM users_pii WHERE tenant_id = ? AND email = ?')) {
          expect(params).toEqual(['tenant-a', 'user@example.com']);
          return { id: 'user-1' };
        }
        return null;
      },
    });

    mocked.resolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: {
        id: 'builtin:storage:single-db',
        kind: 'storage',
        label: 'Single DB',
        slices: {},
      },
      coreDb: coreAdapter,
      piiDb: piiAdapter,
    });

    await expect(
      findActiveSamlUserByEmail({ DB: {} } as Env, 'tenant-a', 'user@example.com')
    ).resolves.toEqual({ id: 'user-1' });
  });

  it('reads NameID email from the runtime-resolved pii store', async () => {
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('SELECT email FROM users_pii WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['user-2', 'tenant-b']);
          return { email: 'nameid@example.com' };
        }
        return null;
      },
    });

    mocked.resolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: {
        id: 'builtin:storage:single-db',
        kind: 'storage',
        label: 'Single DB',
        slices: {},
      },
      coreDb: createMockAdapter(),
      piiDb: piiAdapter,
    });

    await expect(getSamlUserNameIdById({ DB: {} } as Env, 'tenant-b', 'user-2')).resolves.toBe(
      'nameid@example.com'
    );
  });

  it('returns complete SAML user info from runtime-resolved core and pii stores', async () => {
    const coreAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (sql.includes('FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1')) {
          expect(params).toEqual(['user-3', 'tenant-c']);
          return { id: 'user-3' };
        }
        return null;
      },
    });
    const piiAdapter = createMockAdapter({
      queryOne: (sql, params) => {
        if (
          sql.includes(
            'SELECT email, name, custom_attributes_json FROM users_pii WHERE id = ? AND tenant_id = ?'
          )
        ) {
          expect(params).toEqual(['user-3', 'tenant-c']);
          return {
            email: 'full@example.com',
            name: 'Full User',
            custom_attributes_json: JSON.stringify({
              libraryMemberId: 'member-a',
              piiEntitlement: ['premium'],
            }),
          };
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

    mocked.resolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: {
        id: 'builtin:storage:single-db',
        kind: 'storage',
        label: 'Single DB',
        slices: {},
      },
      coreDb: coreAdapter,
      piiDb: piiAdapter,
    });
    mocked.resolveCustomClaimRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: {
        id: 'builtin:storage:single-db',
        kind: 'storage',
        label: 'Single DB',
        slices: {},
      },
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
              value_storage_ref: 'legacy-users-pii://tenant-d/user-4/name',
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
              value_storage_ref: 'legacy-users-pii://tenant-d/user-4/email',
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
        if (sql.includes('SELECT email FROM users_pii WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['user-4', 'tenant-d']);
          return { email: 'canonical@example.com' };
        }
        if (sql.includes('SELECT name FROM users_pii WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['user-4', 'tenant-d']);
          return { name: 'Canonical User' };
        }
        return null;
      },
    });

    mocked.resolveUserStoreRuntimeSourcesFromEnv.mockResolvedValue({
      storageProfile: {
        id: 'builtin:storage:single-db',
        kind: 'storage',
        label: 'Single DB',
        slices: {},
      },
      coreDb: coreAdapter,
      piiDb: piiAdapter,
    });

    await expect(
      getSamlUserInfoById(
        { DB: {}, ENABLE_CANONICAL_IDENTITY_RUNTIME: 'true' } as Env,
        'tenant-d',
        'user-4'
      )
    ).resolves.toEqual({
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
