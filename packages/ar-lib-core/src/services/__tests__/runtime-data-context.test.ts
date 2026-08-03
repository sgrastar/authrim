import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { clearLookupRouteMemoryCache, createLookupBlindIndexes } from '../lookup-directory';
import {
  resolveAccountDataContext,
  resolveAccountDataContextByIdentifierFromHono,
  resolveAccountDataContextFromHono,
  resolveOtpAccountCoreDataContextByIdentifier,
  resolveSessionAccountCoreDataContext,
} from '../runtime-data-context';

const mocks = vi.hoisted(() => ({
  tenantId: 'tenant-a',
}));

vi.mock('../auth-core-persistence-context', () => ({
  getCachedAuthCorePersistenceContextFromEnv: vi.fn(async () => ({
    storageProfileId: 'builtin:storage:tenant-d1',
  })),
  resolveAuthCorePersistenceSourceFromEnv: vi.fn(async (env: Env) => env.DB),
}));

vi.mock('../lookup-directory', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lookup-directory')>();
  return {
    ...original,
    createLookupBlindIndexes: vi.fn(async () => [
      {
        indexKind: 'account_id',
        normalizationVersion: 1,
        hmacKeyGeneration: 1,
        digest: 'a'.repeat(64),
        virtualBucket: 42,
      },
    ]),
    loadVerifiedLookupHmacKeyState: vi.fn(async () => ({})),
    resolveLookupHmacKeys: vi.fn(async () => ({ readKeys: [{}], writeKeys: [{}] })),
    loadVerifiedLookupBucketAssignmentProvider: vi.fn(async () => ({
      resolveActiveAssignment: vi.fn(async () => ({
        virtualBucket: 42,
        assignmentGeneration: 1,
        lookupShardId: 'lookup-a',
        bindingRef: 'LOOKUP_A',
        state: 'active',
      })),
    })),
  };
});

function lookupRow(userId = 'user-a') {
  const projection = {
    schemaVersion: 1,
    accountRouteGeneration: 3,
    residencyPolicyId: 'default-policy',
    targets: [
      {
        dataRole: 'tenant_core/users',
        residencyPartition: 'default',
        shardId: 'users-a',
        bindingRef: 'TDB_USERS_A',
        requiredBindingRouteGeneration: 8,
      },
      {
        dataRole: 'tenant_pii',
        residencyPartition: 'default',
        shardId: 'pii-a',
        bindingRef: 'TDB_PII_A',
        requiredBindingRouteGeneration: 9,
      },
    ],
  };
  return {
    virtual_bucket: 42,
    index_kind: 'account_id',
    normalization_version: 1,
    hmac_key_generation: 1,
    identifier_blind_digest: 'a'.repeat(64),
    tenant_id: mocks.tenantId,
    account_id: `account:${userId}`,
    route_schema_version: 1,
    account_route_generation: 3,
    required_binding_route_generation: 9,
    residency_policy_id: 'default-policy',
    route_projection_json: JSON.stringify(projection),
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
  };
}

function d1(input: {
  lookupRows?: unknown[];
  role?: 'tenant_core/users' | 'tenant_pii';
  accountRouteGeneration?: number;
  revokedAfterMs?: number;
  legacyUserId?: string;
  accountId?: string;
  subjectLifecycleState?: string;
  emailVerified?: number;
}): D1Database {
  const session = {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(),
        all: vi.fn(async () => ({ success: true, results: input.lookupRows ?? [], meta: {} })),
        first: vi.fn(async () => {
          if (sql.includes('authrim_control_plane_shard_metadata')) {
            return {
              binding_ref: input.role === 'tenant_pii' ? 'TDB_PII_A' : 'TDB_USERS_A',
              data_role: input.role,
              residency_partition: 'default',
            };
          }
          if (sql.includes('FROM identity_accounts')) {
            return {
              id: input.accountId ?? 'account:user-a',
              legacy_user_id: input.legacyUserId ?? 'user-a',
              lifecycle_state: 'active',
              directory_publication_state: 'active',
              account_route_generation: input.accountRouteGeneration ?? 3,
              account_type: 'end_user',
              subject_lifecycle_state: input.subjectLifecycleState ?? 'active',
              display_name: 'OTP User',
              email_verified: input.emailVerified ?? 1,
              created_at: 1_700_000_000_000,
            };
          }
          if (sql.includes('FROM session_revocation_epochs')) {
            return input.revokedAfterMs === undefined
              ? null
              : { revoked_after_ms: input.revokedAfterMs };
          }
          return null;
        }),
      };
      statement.bind.mockImplementation(() => statement);
      return statement;
    }),
    batch: vi.fn(async (statements: Array<{ first(): Promise<unknown> }>) =>
      Promise.all(
        statements.map(async (statement) => {
          const row = await statement.first();
          return { success: true, results: row === null ? [] : [row], meta: {} };
        })
      )
    ),
    getBookmark: vi.fn(() => 'bookmark'),
  } as unknown as D1DatabaseSession;
  return {
    prepare: vi.fn(),
    batch: vi.fn(),
    exec: vi.fn(),
    dump: vi.fn(),
    withSession: vi.fn(() => session),
    _session: session,
  } as unknown as D1Database;
}

function env(accountRouteGeneration = 3, userId = 'user-a'): Env {
  return {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    TENANT_RUNTIME_REGISTRY: { get: vi.fn() },
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: '{}',
    LOOKUP_HMAC_KEY_SLOT_A: 'secret-a',
    LOOKUP_A: d1({ lookupRows: [lookupRow(userId)] }),
    TDB_USERS_A: d1({
      role: 'tenant_core/users',
      accountRouteGeneration,
      legacyUserId: userId,
      accountId: `account:${userId}`,
    }),
    TDB_PII_A: d1({ role: 'tenant_pii' }),
    DB: d1({}),
  } as unknown as Env;
}

describe('runtime account data context', () => {
  beforeEach(() => {
    clearLookupRouteMemoryCache();
    mocks.tenantId = 'tenant-a';
  });

  it('fixes one account to its verified core and PII shard route', async () => {
    const bindings = env();
    const context = await resolveAccountDataContext(bindings, {
      tenantId: 'tenant-a',
      accountId: 'user-a',
    });

    expect(context.accountId).toBe('account:user-a');
    expect(context.legacyUserId).toBe('user-a');
    expect(context.coreDb).toBe((bindings as unknown as Record<string, unknown>).TDB_USERS_A);
    expect(context.piiDb).toBe((bindings as unknown as Record<string, unknown>).TDB_PII_A);
    expect(context.userCacheScope.sourceGeneration).toBe('account:3:core:8:pii:9');
  });

  it.each(['_'.repeat(21), `-${'a'.repeat(20)}`])(
    'resolves a canonical NanoID beginning with a URL-safe symbol: %s',
    async (userId) => {
      const context = await resolveAccountDataContext(env(3, userId), {
        tenantId: 'tenant-a',
        accountId: userId,
      });

      expect(context.accountId).toBe(`account:${userId}`);
      expect(context.legacyUserId).toBe(userId);
    }
  );

  it('resolves session revocation state with one primary Core batch and no PII round trip', async () => {
    const bindings = env();
    const usersD1 = d1({
      role: 'tenant_core/users',
      accountRouteGeneration: 3,
      revokedAfterMs: 1234,
    }) as D1Database & { _session: { batch: ReturnType<typeof vi.fn> } };
    (bindings as unknown as Record<string, unknown>).TDB_USERS_A = usersD1;
    const piiD1 = (bindings as unknown as Record<string, D1Database>).TDB_PII_A;

    const context = await resolveSessionAccountCoreDataContext(bindings, {
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      userId: 'user-a',
    });

    expect(context.coreDb).toBe(usersD1);
    expect(context.revokedAfterMs).toBe(1234);
    expect(usersD1._session.batch).toHaveBeenCalledTimes(1);
    expect(usersD1._session.batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(piiD1.withSession).not.toHaveBeenCalled();
  });

  it('resolves the minimal OTP user in the Core revalidation batch without touching PII', async () => {
    const bindings = env();
    const usersD1 = (bindings as unknown as Record<string, D1Database>)
      .TDB_USERS_A as D1Database & {
      _session: { batch: ReturnType<typeof vi.fn>; prepare: ReturnType<typeof vi.fn> };
    };
    const piiD1 = (bindings as unknown as Record<string, D1Database>).TDB_PII_A;

    const context = await resolveOtpAccountCoreDataContextByIdentifier(bindings, {
      tenantId: 'tenant-a',
      indexKind: 'email_exact',
      identifier: 'User-A@Example.com',
      trustedEmail: 'User-A@Example.com',
    });

    expect(context.accountId).toBe('account:user-a');
    expect(context.user).toEqual({
      id: 'user-a',
      email: 'user-a@example.com',
      name: 'OTP User',
      active: 1,
      email_verified: 1,
      account_type: 'end_user',
      created_at: '2023-11-14T22:13:20.000Z',
    });
    expect(usersD1._session.batch).toHaveBeenCalledTimes(1);
    expect(usersD1._session.batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(
      usersD1._session.prepare.mock.calls.some(([sql]) =>
        String(sql).includes('JOIN identity_subjects subject')
      )
    ).toBe(true);
    const otpSql = usersD1._session.prepare.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('JOIN identity_subjects subject'));
    expect(otpSql).toContain('contact.subject_id = subject.id');
    expect(otpSql).toContain('contact.account_id = account.id');
    expect(otpSql).not.toContain('contact.account_id = account.id OR');
    expect(piiD1.withSession).not.toHaveBeenCalled();
  });

  it('rejects an OTP email projection that is not bound to the routed identifier', async () => {
    await expect(
      resolveOtpAccountCoreDataContextByIdentifier(env(), {
        tenantId: 'tenant-a',
        indexKind: 'email_exact',
        identifier: 'routed@example.com',
        trustedEmail: 'different@example.com',
      })
    ).rejects.toThrow('account_data_otp_email_route_mismatch');
  });

  it('rejects an OTP account route whose legacy user differs from the challenge user', async () => {
    const bindings = env();
    (bindings as unknown as Record<string, unknown>).TDB_USERS_A = d1({
      role: 'tenant_core/users',
      legacyUserId: 'user-b',
    });

    await expect(
      resolveOtpAccountCoreDataContextByIdentifier(bindings, {
        tenantId: 'tenant-a',
        indexKind: 'account_id',
        identifier: 'account:user-a',
        expectedAccountId: 'account:user-a',
        expectedLegacyUserId: 'user-a',
        trustedEmail: 'user-a@example.com',
      })
    ).rejects.toThrow('account_data_otp_route_mismatch');
  });

  it('rejects a session route whose account or authoritative legacy user differs', async () => {
    await expect(
      resolveSessionAccountCoreDataContext(env(), {
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        userId: 'user-b',
      })
    ).rejects.toThrow('account_data_session_route_mismatch');

    const bindings = env();
    (bindings as unknown as Record<string, unknown>).TDB_USERS_A = d1({
      role: 'tenant_core/users',
      legacyUserId: 'user-b',
    });
    await expect(
      resolveSessionAccountCoreDataContext(bindings, {
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        userId: 'user-a',
      })
    ).rejects.toThrow('lookup_destination_revalidation_failed');
  });

  it('rejects a Lookup membership owned by another tenant', async () => {
    mocks.tenantId = 'tenant-b';
    await expect(
      resolveAccountDataContext(env(), { tenantId: 'tenant-a', accountId: 'user-a' })
    ).rejects.toThrow('account_data_route_not_found');
  });

  it('rejects a route whose physical binding is unavailable', async () => {
    const bindings = env() as unknown as Record<string, unknown>;
    delete bindings.TDB_PII_A;
    await expect(
      resolveAccountDataContext(bindings as unknown as Env, {
        tenantId: 'tenant-a',
        accountId: 'user-a',
      })
    ).rejects.toThrow('lookup_route_binding_unavailable');
  });

  it('rejects a destination account with a stale route generation', async () => {
    await expect(
      resolveAccountDataContext(env(2), { tenantId: 'tenant-a', accountId: 'user-a' })
    ).rejects.toThrow('lookup_destination_revalidation_failed');
  });

  it('rejects replacing a request account context with another account', async () => {
    const context = {
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
    };
    const hono = {
      env: env(),
      get(key: string) {
        if (key === 'tenantId') return 'tenant-a';
        if (key === 'accountDataContext') return context;
        return undefined;
      },
      set: vi.fn(),
    } as unknown as Parameters<typeof resolveAccountDataContextFromHono>[0];

    await expect(resolveAccountDataContextFromHono(hono, 'user-b')).rejects.toThrow(
      'account_data_context_conflict'
    );
  });

  it('resolves an email identifier to the membership account and stores the request context', async () => {
    const values = new Map<string, unknown>([['tenantId', 'tenant-a']]);
    const hono = {
      env: env(),
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => values.set(key, value),
    } as unknown as Parameters<typeof resolveAccountDataContextByIdentifierFromHono>[0];

    const context = await resolveAccountDataContextByIdentifierFromHono(hono, {
      indexKind: 'email_exact',
      identifier: 'User-A@Example.com',
    });

    expect(context.accountId).toBe('account:user-a');
    expect(values.get('accountDataContext')).toBe(context);
    expect(createLookupBlindIndexes).toHaveBeenCalledWith('email_exact', 'User-A@Example.com', [
      {},
    ]);
  });
});
