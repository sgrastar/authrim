import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { clearLookupRouteMemoryCache, createLookupBlindIndexes } from '../lookup-directory';
import { clearTenantDatabaseResolverMemoryCache } from '../tenant-database-resolver';
import { signTenantRuntimeRegistrySnapshot } from '../tenant-runtime-registry-snapshot';
import {
  probeAccountForProviderDataDeletion,
  resolveAccountDataContext,
  resolveAccountDataContextByIdentifierFromHono,
  resolveAccountDataContextFromHono,
  resolveAccountCoreDataContext,
  resolveAccountPiiSourceForAudit,
  resolveOtpAccountCoreDataContextByIdentifier,
  resolveAccountRouteForSamlDrSnapshot,
} from '../runtime-data-context';

const mocks = vi.hoisted(() => ({
  tenantId: 'tenant-a',
}));

let signedRuntimeRegistrySnapshot = '';
let runtimeRegistryPublicJwks = '';

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
  legacyUserId?: string;
  accountId?: string;
  subjectLifecycleState?: string;
  emailVerified?: number;
  /** The account row's lifecycle state, or null for no row (deleted at the destination). */
  accountLifecycleState?: string | null;
  /** The shard metadata's binding (default: the one routed to). */
  metadataBindingRef?: string;
  /** Rows the provider data deletion probe reads (legal hold, linked identity, unlink op). */
  probeRows?: { legalHold?: boolean; linkedIdentity?: boolean; rawUnlinkOperation?: boolean };
}): D1Database {
  const session = {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind: vi.fn(),
        all: vi.fn(async () => ({ success: true, results: input.lookupRows ?? [], meta: {} })),
        first: vi.fn(async () => {
          if (sql.includes('authrim_control_plane_shard_metadata')) {
            return {
              binding_ref:
                input.metadataBindingRef ??
                (input.role === 'tenant_pii' ? 'TDB_PII_A' : 'TDB_USERS_A'),
              data_role: input.role,
              residency_partition: 'default',
            };
          }
          if (sql.includes('FROM legal_holds')) {
            return input.probeRows?.legalHold ? { id: 'hold-1' } : null;
          }
          if (sql.includes('FROM linked_identities')) {
            return input.probeRows?.linkedIdentity ? { id: 'link-1' } : null;
          }
          if (sql.includes('FROM external_identifier_unlink_operations')) {
            return input.probeRows?.rawUnlinkOperation ? { operation_id: 'op-1' } : null;
          }
          if (sql.includes('FROM identity_accounts')) {
            if (input.accountLifecycleState === null) return null;
            return {
              id: input.accountId ?? 'account:user-a',
              legacy_user_id: input.legacyUserId ?? 'user-a',
              lifecycle_state: input.accountLifecycleState ?? 'active',
              directory_publication_state: 'active',
              account_route_generation: input.accountRouteGeneration ?? 3,
              account_type: 'end_user',
              subject_lifecycle_state: input.subjectLifecycleState ?? 'active',
              display_name: 'OTP User',
              email_verified: input.emailVerified ?? 1,
              created_at: 1_700_000_000_000,
            };
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

type ProbeSqlValue = string | number | null;
interface ProbeSqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: ProbeSqlValue[]): unknown;
    get(...values: ProbeSqlValue[]): Record<string, ProbeSqlValue> | undefined;
  };
}
// The runtime is Node22+, while Core's supported Node ambient types predate node:sqlite.
const { DatabaseSync: ProbeDatabase } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (filename: string) => ProbeSqlite;
};

/** A fresh database with a family's 0.5.0 baseline, for the probe's own SQL. */
function probeSchema(family: 'core' | 'pii'): ProbeSqlite {
  const database = new ProbeDatabase(':memory:');
  const file = path.resolve(
    __dirname,
    `../../../../../migrations/${family}/d1/001_0_5_0_${family}_baseline.sql`
  );
  database.exec(renderPortableMigrationSql(readFileSync(file, 'utf8'), 'sqlite'));
  return database;
}

/**
 * As d1(), but every statement other than the route revalidation (shard metadata, the account
 * row) runs, with its bound values, on a real database: the probe's legal hold, linked identity
 * and unlink operation queries.
 */
function realSqlD1(input: {
  role: 'tenant_core/users' | 'tenant_pii';
  database: ProbeSqlite;
  accountLifecycleState: string;
}) {
  const session = {
    prepare: vi.fn((sql: string) => {
      let values: ProbeSqlValue[] = [];
      const statement = {
        bind: vi.fn((...bound: ProbeSqlValue[]) => {
          values = bound;
          return statement;
        }),
        all: vi.fn(async () => ({ success: true, results: [], meta: {} })),
        first: vi.fn(async () => {
          if (sql.includes('authrim_control_plane_shard_metadata')) {
            return {
              binding_ref: input.role === 'tenant_pii' ? 'TDB_PII_A' : 'TDB_USERS_A',
              data_role: input.role,
              residency_partition: 'default',
            };
          }
          if (sql.includes('FROM identity_accounts') && !sql.includes('legal_holds')) {
            return {
              id: 'account:user-a',
              legacy_user_id: 'user-a',
              lifecycle_state: input.accountLifecycleState,
              directory_publication_state: 'disabled',
              account_route_generation: 3,
            };
          }
          return input.database.prepare(sql).get(...values) ?? null;
        }),
      };
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
  } as unknown as D1Database;
}

function env(accountRouteGeneration = 3, userId = 'user-a'): Env {
  return {
    AUTHRIM_ENVIRONMENT_NAME: 'test',
    TENANT_RUNTIME_REGISTRY: {
      get: vi.fn(async (key: string) =>
        key.includes(':runtime-registry:generation:')
          ? JSON.stringify({
              runtimeGeneration: 7,
              routeStatus: 'active',
              quarantineDenyGeneration: 0,
              publishedAt: '2026-05-16T00:00:00.000Z',
              expiresAt: '2099-05-23T00:00:00.000Z',
            })
          : signedRuntimeRegistrySnapshot
      ),
    },
    TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS: runtimeRegistryPublicJwks,
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
  beforeAll(async () => {
    const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const privateJwk = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;
    const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
    privateJwk.kid = 'runtime-registry-key-1';
    privateJwk.alg = 'EdDSA';
    privateJwk.use = 'sig';
    publicJwk.kid = 'runtime-registry-key-1';
    publicJwk.alg = 'EdDSA';
    publicJwk.use = 'sig';
    const snapshot = await signTenantRuntimeRegistrySnapshot(
      {
        version: 4,
        tenantId: 'tenant-a',
        snapshotScope: 'tenant',
        deploymentTarget: 'default',
        runtimeGeneration: 7,
        routeStatus: 'active',
        quarantineDenyGeneration: 0,
        backend: { provider: 'd1', resolver: 'control-plane' },
        placement: { isolationPolicy: 'tenant_exclusive', policyGeneration: 1 },
        publishedAt: '2026-05-16T00:00:00.000Z',
        expiresAt: '2099-05-16T00:30:00.000Z',
        stores: [
          {
            tenantId: 'tenant-a',
            role: 'tenant_core',
            dataRole: 'tenant_core/users',
            residencyPolicyId: 'default-policy',
            residencyPartition: 'default',
            shardId: 'users-a',
            assignmentGeneration: 1,
            bindingRouteGeneration: 8,
            placementPolicyGeneration: 1,
            allocationScope: 'tenant_exclusive',
            ownerTenantId: 'tenant-a',
            generation: 8,
            runtimeGeneration: 7,
            schemaVersion: 1,
            shardGroup: 'default',
            shardIndex: 0,
            shardCount: 1,
            shardKeyStrategy: 'none',
            provider: 'd1',
            driver: 'd1',
            bindingRef: 'TDB_USERS_A',
            connectionRef: null,
            deploymentTarget: null,
            status: 'active',
            healthStatus: 'active',
            databaseId: 'users-a-db',
            databaseName: 'users-a',
            regionHint: null,
            jurisdiction: null,
          },
          {
            tenantId: 'tenant-a',
            role: 'tenant_pii',
            dataRole: 'tenant_pii',
            residencyPolicyId: 'default-policy',
            residencyPartition: 'default',
            shardId: 'pii-a',
            assignmentGeneration: 1,
            bindingRouteGeneration: 9,
            placementPolicyGeneration: 1,
            allocationScope: 'tenant_exclusive',
            ownerTenantId: 'tenant-a',
            generation: 9,
            runtimeGeneration: 7,
            schemaVersion: 1,
            shardGroup: 'default',
            shardIndex: 0,
            shardCount: 1,
            shardKeyStrategy: 'none',
            provider: 'd1',
            driver: 'd1',
            bindingRef: 'TDB_PII_A',
            connectionRef: null,
            deploymentTarget: null,
            status: 'active',
            healthStatus: 'active',
            databaseId: 'pii-a-db',
            databaseName: 'pii-a',
            regionHint: null,
            jurisdiction: null,
          },
        ],
        metadata: {
          storeCount: 2,
          roles: ['tenant_core', 'tenant_pii'],
          signature: null,
          signatureKeyId: null,
          signatureAlgorithm: null,
          signedAt: null,
        },
      },
      { privateJwk, keyId: 'runtime-registry-key-1' },
      '2026-05-16T00:00:00.000Z'
    );
    signedRuntimeRegistrySnapshot = JSON.stringify(snapshot);
    runtimeRegistryPublicJwks = JSON.stringify({ keys: [publicJwk] });
  });

  beforeEach(() => {
    clearLookupRouteMemoryCache();
    clearTenantDatabaseResolverMemoryCache();
    mocks.tenantId = 'tenant-a';
  });

  it('reads a held DR route from primary even after normal runtime cached an older route', async () => {
    const bindings = env();
    await resolveAccountDataContext(bindings, { tenantId: 'tenant-a', accountId: 'user-a' });
    const replacement = d1({ lookupRows: [lookupRow()] });
    const updated = { ...bindings, ENABLE_SAML_DR_EXPORT: 'true', LOOKUP_A: replacement } as Env;
    const route = await resolveAccountRouteForSamlDrSnapshot(updated, {
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
      accountRouteGeneration: 3,
      nowMs: Date.now(),
    });
    expect(route.accountRouteGeneration).toBe(3);
    expect(
      (replacement as unknown as { withSession: ReturnType<typeof vi.fn> }).withSession
    ).toHaveBeenCalledWith('first-primary');
    expect(
      (replacement as unknown as { withSession: ReturnType<typeof vi.fn> }).withSession
    ).not.toHaveBeenCalledWith('first-unconstrained');
  });

  it('does not require an active Core account while capturing its primary DR route', async () => {
    const bindings = {
      ...env(),
      ENABLE_SAML_DR_EXPORT: 'true',
      TDB_USERS_A: d1({ role: 'tenant_core/users', accountLifecycleState: 'suspended' }),
    } as Env;
    await expect(
      resolveAccountRouteForSamlDrSnapshot(bindings, {
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        accountRouteGeneration: 3,
        nowMs: Date.now(),
      })
    ).resolves.toMatchObject({ accountRouteGeneration: 3 });
    expect(
      (bindings as unknown as { TDB_USERS_A: { withSession: ReturnType<typeof vi.fn> } })
        .TDB_USERS_A.withSession
    ).not.toHaveBeenCalled();
  });

  it.each(['stale', 'foreign', 'disabled'])(
    'rejects invalid primary DR membership: %s',
    async (kind) => {
      const row = lookupRow();
      if (kind === 'foreign') row.tenant_id = 'tenant-other';
      if (kind === 'disabled') row.lifecycle_state = 'disabled';
      const bindings = {
        ...env(),
        ENABLE_SAML_DR_EXPORT: 'true',
        LOOKUP_A: d1({ lookupRows: [row] }),
      } as Env;
      await expect(
        resolveAccountRouteForSamlDrSnapshot(bindings, {
          tenantId: 'tenant-a',
          accountId: 'account:user-a',
          accountRouteGeneration: kind === 'stale' ? 4 : 3,
          nowMs: Date.now(),
        })
      ).rejects.toThrow();
    }
  );

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
    expect(context.userCacheScope).toEqual({
      routeGeneration: 'account:3',
      bindingGeneration: 'core:8:pii:9',
      schemaGeneration: 'route:1',
    });
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

  it('resolves the account Core route with one primary batch and no PII round trip', async () => {
    const bindings = env();
    const usersD1 = d1({
      role: 'tenant_core/users',
      accountRouteGeneration: 3,
    }) as D1Database & { _session: { batch: ReturnType<typeof vi.fn> } };
    (bindings as unknown as Record<string, unknown>).TDB_USERS_A = usersD1;
    const piiD1 = (bindings as unknown as Record<string, D1Database>).TDB_PII_A;

    const context = await resolveAccountCoreDataContext(bindings, {
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
    });

    expect(context.coreDb).toBe(usersD1);
    expect(usersD1._session.batch).toHaveBeenCalledTimes(1);
    expect(usersD1._session.batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(piiD1.withSession).not.toHaveBeenCalled();
  });

  it('resolves the account Core route without resolving its PII destination', async () => {
    // A Core-only reader (the status-only investigation read) must not depend on the PII
    // store's binding: with it gone, the Core context still resolves, the full context does not.
    const bindings = env() as unknown as Record<string, unknown>;
    delete bindings.TDB_PII_A;
    const context = await resolveAccountCoreDataContext(bindings as unknown as Env, {
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
    });
    expect(context.coreDb).toBe(bindings.TDB_USERS_A);
    await expect(
      resolveAccountDataContext(bindings as unknown as Env, {
        tenantId: 'tenant-a',
        accountId: 'user-a',
      })
    ).rejects.toThrow();
  });

  it('still refuses a Core route whose projection names no PII destination', async () => {
    // Skipping the PII binding is not skipping the route's completeness check.
    const row = lookupRow();
    const projection = JSON.parse(row.route_projection_json) as {
      targets: Array<{ dataRole: string }>;
    };
    projection.targets = projection.targets.filter((target) => target.dataRole !== 'tenant_pii');
    const bindings = env() as unknown as Record<string, unknown>;
    bindings.LOOKUP_A = d1({
      lookupRows: [
        {
          ...row,
          // The row's generation is its targets' highest: the Core target's alone now.
          required_binding_route_generation: 8,
          route_projection_json: JSON.stringify(projection),
        },
      ],
    });
    await expect(
      resolveAccountCoreDataContext(bindings as unknown as Env, {
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
      })
    ).rejects.toThrow('account_data_route_incomplete');
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

  it('resolves the OTP Core context without resolving the PII destination', async () => {
    // The OTP path promises not to touch tenant PII: it must not need the PII binding either.
    const bindings = env() as unknown as Record<string, unknown>;
    delete bindings.TDB_PII_A;
    const context = await resolveOtpAccountCoreDataContextByIdentifier(bindings as unknown as Env, {
      tenantId: 'tenant-a',
      indexKind: 'email_exact',
      identifier: 'User-A@Example.com',
      trustedEmail: 'User-A@Example.com',
    });
    expect(context.coreDb).toBe(bindings.TDB_USERS_A);
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

  it('rejects a Core route whose authoritative account differs', async () => {
    const bindings = env();
    (bindings as unknown as Record<string, unknown>).TDB_USERS_A = d1({
      role: 'tenant_core/users',
      accountId: 'account:user-b',
    });
    await expect(
      resolveAccountCoreDataContext(bindings, {
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
      })
    ).rejects.toThrow('lookup_destination_revalidation_failed');
  });

  it.each([
    ['deleted', 'deleted'],
    ['gone from the destination', null],
  ])(
    'tells a cached route to an account %s apart from a mismatched destination',
    async (_case, accountLifecycleState) => {
      const inactive = env();
      (inactive as unknown as Record<string, unknown>).TDB_USERS_A = d1({
        role: 'tenant_core/users',
        accountLifecycleState,
      });
      const failure = await resolveAccountDataContext(inactive, {
        tenantId: 'tenant-a',
        accountId: 'user-a',
      }).catch((error: unknown) => error as Error);
      expect(failure).toMatchObject({
        message: 'lookup_destination_revalidation_failed',
        cause: 'account_inactive',
      });

      // Another shard answering for the route: an integrity failure, not an inactive account.
      const mismatched = env();
      (mismatched as unknown as Record<string, unknown>).TDB_USERS_A = d1({
        role: 'tenant_core/users',
        accountLifecycleState,
        metadataBindingRef: 'TDB_USERS_B',
      });
      const integrity = await resolveAccountDataContext(mismatched, {
        tenantId: 'tenant-a',
        accountId: 'user-a',
      }).catch((error: unknown) => error as Error);
      expect(integrity).toMatchObject({ message: 'lookup_destination_revalidation_failed' });
      expect(integrity.cause).toBeUndefined();

      // A mismatched PII destination is reported first, even with the core account inactive.
      const piiMismatch = env();
      (piiMismatch as unknown as Record<string, unknown>).TDB_USERS_A = d1({
        role: 'tenant_core/users',
        accountLifecycleState,
      });
      (piiMismatch as unknown as Record<string, unknown>).TDB_PII_A = d1({
        role: 'tenant_pii',
        metadataBindingRef: 'TDB_PII_B',
      });
      const pii = await resolveAccountDataContext(piiMismatch, {
        tenantId: 'tenant-a',
        accountId: 'user-a',
      }).catch((error: unknown) => error as Error);
      expect(pii).toMatchObject({ message: 'lookup_destination_revalidation_failed' });
      expect(pii.cause).toBeUndefined();
    }
  );

  it.each([
    ['suspended', undefined, false],
    ['suspended', 'restricted', true],
    ['locked', 'restricted', true],
    ['deleting', 'restricted', false],
    ['deleted', 'restricted', false],
    ['active', undefined, true],
  ] as const)(
    'resolves a %s account with acceptLifecycle %s only when accepted (%s)',
    async (accountLifecycleState, acceptLifecycle, resolves) => {
      const bindings = env();
      (bindings as unknown as Record<string, unknown>).TDB_USERS_A = d1({
        role: 'tenant_core/users',
        accountLifecycleState,
      });
      const outcome = await resolveAccountDataContext(bindings, {
        tenantId: 'tenant-a',
        accountId: 'user-a',
        ...(acceptLifecycle ? { acceptLifecycle } : {}),
      }).catch((error: unknown) => error as Error);
      if (resolves) {
        expect(outcome).toMatchObject({
          accountId: 'account:user-a',
          lifecycleState: accountLifecycleState,
        });
      } else {
        expect(outcome).toMatchObject({
          message: 'lookup_destination_revalidation_failed',
          cause: 'account_inactive',
        });
      }
    }
  );

  it('accepts no lifecycle acceptance beyond restricted, even through a cast', async () => {
    await expect(
      resolveAccountDataContext(env(), {
        tenantId: 'tenant-a',
        accountId: 'user-a',
        acceptLifecycle: 'any' as unknown as 'restricted',
      })
    ).rejects.toThrow('account_data_lifecycle_acceptance_invalid');
  });

  it('refuses a fresh route through the runtime ports rather than serving a cached one', async () => {
    const resolveAccount = vi.fn();
    const ports = { ...env(), RUNTIME_DATA_PORTS: { resolveAccount } } as unknown as Env;
    await expect(
      resolveAccountDataContext(ports, {
        tenantId: 'tenant-a',
        accountId: 'user-a',
        freshRoute: true,
      })
    ).rejects.toThrow('account_data_fresh_route_unsupported');
    await expect(
      probeAccountForProviderDataDeletion(ports, {
        tenantId: 'tenant-a',
        account: { accountId: 'user-a' },
        remains: { unlinkOperationId: 'op-1' },
      })
    ).rejects.toThrow('account_data_fresh_route_unsupported');
    expect(resolveAccount).not.toHaveBeenCalled();
  });

  it.each([
    [
      'deleted',
      {},
      { lifecycleState: 'deleted', legalHoldActive: false, providerDataRemains: false },
    ],
    ['deleted', { linkedIdentity: true }, { lifecycleState: 'deleted', providerDataRemains: true }],
    [
      'deleted',
      { rawUnlinkOperation: true },
      { lifecycleState: 'deleted', providerDataRemains: true },
    ],
    ['deleting', { legalHold: true }, { lifecycleState: 'deleting', legalHoldActive: true }],
  ] as const)(
    'probes a %s account read-only (%o)',
    async (accountLifecycleState, probeRows, expected) => {
      const bindings = env();
      (bindings as unknown as Record<string, unknown>).TDB_USERS_A = d1({
        role: 'tenant_core/users',
        accountLifecycleState,
        probeRows,
      });
      (bindings as unknown as Record<string, unknown>).TDB_PII_A = d1({
        role: 'tenant_pii',
        probeRows,
      });
      const probe = await probeAccountForProviderDataDeletion(bindings, {
        tenantId: 'tenant-a',
        account: { accountId: 'user-a' },
        remains: { issuer: 'provider-a', subject: 'subject-a' },
      });
      expect(probe).toMatchObject({ accountId: 'account:user-a', ...expected });
      // No database handle leaves the probe.
      expect(Object.keys(probe).sort()).toEqual(
        [
          'accountId',
          'legacyUserId',
          'lifecycleState',
          'legalHoldActive',
          'providerDataRemains',
        ].sort()
      );
    }
  );

  describe('provider data deletion probe on the real schemas', () => {
    const digest = async (value: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');
    let core: ProbeSqlite;
    let pii: ProbeSqlite;

    function probeEnv(): Env {
      const bindings = env();
      (bindings as unknown as Record<string, unknown>).TDB_USERS_A = realSqlD1({
        role: 'tenant_core/users',
        database: core,
        accountLifecycleState: 'deleted',
      });
      (bindings as unknown as Record<string, unknown>).TDB_PII_A = realSqlD1({
        role: 'tenant_pii',
        database: pii,
        accountLifecycleState: 'deleted',
      });
      return bindings;
    }

    function link(tenantId: string, userId: string, providerId: string, subject: string) {
      pii
        .prepare(
          `INSERT INTO linked_identities (id, tenant_id, user_id, provider_id, provider_user_id,
                                          linked_at, provisioning_state)
           VALUES (?, ?, ?, ?, ?, 1, 'pending')`
        )
        .run(`${tenantId}:${userId}:${subject}`, tenantId, userId, providerId, subject);
    }

    /** As the saga writes one: the operation (its link must exist then), then the link goes. */
    async function operation(input: {
      id: string;
      tenantId?: string;
      accountId?: string;
      subject?: string;
      erased?: boolean;
    }) {
      const tenantId = input.tenantId ?? 'tenant-a';
      const subject = input.subject ?? 'subject-a';
      link(tenantId, 'user-a', 'provider-a', subject);
      pii
        .prepare(
          `INSERT INTO external_identifier_unlink_operations (
             operation_id, tenant_id, account_id, user_id, issuer_json, subject_json,
             issuer_sha256, subject_sha256, route_projection_json, state, created_at, updated_at
           ) VALUES (?, ?, ?, 'user-a', ?, ?, ?, ?, '{}', 'pending', 1, 1)`
        )
        .run(
          input.id,
          tenantId,
          input.accountId ?? 'account:user-a',
          JSON.stringify('provider-a'),
          JSON.stringify(subject),
          await digest('provider-a'),
          await digest(subject)
        );
      pii
        .prepare(
          'DELETE FROM linked_identities WHERE tenant_id = ? AND user_id = ? AND provider_user_id = ?'
        )
        .run(tenantId, 'user-a', subject);
      if (input.erased) {
        // As the account's deletion leaves it (account-directory-removal-producer).
        pii
          .prepare(
            `UPDATE external_identifier_unlink_operations
                SET state = 'blocked', issuer_json = NULL, subject_json = NULL,
                    raw_values_erased_at = 1, error_code = 'account_deleted'
              WHERE operation_id = ?`
          )
          .run(input.id);
      }
    }

    const bySubject = (env: Env) =>
      probeAccountForProviderDataDeletion(env, {
        tenantId: 'tenant-a',
        account: { accountId: 'user-a' },
        remains: { issuer: 'provider-a', subject: 'subject-a' },
      });
    const byOperation = (env: Env, unlinkOperationId: string) =>
      probeAccountForProviderDataDeletion(env, {
        tenantId: 'tenant-a',
        account: { accountId: 'user-a' },
        remains: { unlinkOperationId },
      });

    beforeEach(() => {
      core = probeSchema('core');
      pii = probeSchema('pii');
      core.exec(
        `INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state,
                                        legacy_user_id, created_at, updated_at)
         VALUES ('account:user-a', 'tenant-a', 'person', 'deleted', 'user-a', 1, 1),
                ('account:user-b', 'tenant-a', 'person', 'active', 'user-b', 1, 1)`
      );
    });

    it('finds nothing left when nothing for the subject or operation is held', async () => {
      // Rows of another tenant, account or subject do not count.
      await operation({ id: 'op-tenant', tenantId: 'tenant-b' });
      await operation({ id: 'op-account', accountId: 'account:user-b' });
      await operation({ id: 'op-subject', subject: 'subject-other' });
      await operation({ id: 'op-erased', erased: true });
      link('tenant-b', 'user-a', 'provider-a', 'subject-a');
      link('tenant-a', 'user-b', 'provider-a', 'subject-a');
      link('tenant-a', 'user-a', 'provider-a', 'subject-other');
      link('tenant-a', 'user-a', 'provider-other', 'subject-a');
      core.exec(
        `INSERT INTO legal_holds (id, tenant_id, subject_type, subject_id, state, reason_code,
                                  created_by, created_at, updated_at)
         VALUES ('hold-b', 'tenant-a', 'account', 'account:user-b', 'active', 'litigation',
                 'admin', 1, 1)`
      );
      await expect(bySubject(probeEnv())).resolves.toEqual({
        accountId: 'account:user-a',
        legacyUserId: 'user-a',
        lifecycleState: 'deleted',
        legalHoldActive: false,
        providerDataRemains: false,
      });
      await expect(byOperation(probeEnv(), 'op-erased')).resolves.toMatchObject({
        providerDataRemains: false,
      });
      // Another tenant's or account's operation of the same id is not this one.
      await expect(byOperation(probeEnv(), 'op-tenant')).resolves.toMatchObject({
        providerDataRemains: false,
      });
      await expect(byOperation(probeEnv(), 'op-account')).resolves.toMatchObject({
        providerDataRemains: false,
      });
    });

    it('finds the linked identity of the subject, in any provisioning state', async () => {
      link('tenant-a', 'user-a', 'provider-a', 'subject-a');
      await expect(bySubject(probeEnv())).resolves.toMatchObject({ providerDataRemains: true });
    });

    it('finds an unlink operation of the subject that still holds its raw values', async () => {
      await operation({ id: 'op-raw' });
      await expect(bySubject(probeEnv())).resolves.toMatchObject({ providerDataRemains: true });
      await expect(byOperation(probeEnv(), 'op-raw')).resolves.toMatchObject({
        providerDataRemains: true,
      });
    });

    it("reports the account's active legal hold only", async () => {
      core.exec(
        `INSERT INTO legal_holds (id, tenant_id, subject_type, subject_id, state, reason_code,
                                  created_by, created_at, released_by, released_at,
                                  release_reason, updated_at)
         VALUES ('hold-released', 'tenant-a', 'account', 'account:user-a', 'released',
                 'litigation', 'admin', 1, 'admin', 2, 'closed', 2)`
      );
      await expect(bySubject(probeEnv())).resolves.toMatchObject({ legalHoldActive: false });
      core.exec(
        `INSERT INTO legal_holds (id, tenant_id, subject_type, subject_id, state, reason_code,
                                  created_by, created_at, updated_at)
         VALUES ('hold-a', 'tenant-a', 'account', 'account:user-a', 'active', 'litigation',
                 'admin', 1, 1)`
      );
      await expect(bySubject(probeEnv())).resolves.toMatchObject({ legalHoldActive: true });
    });
  });

  it.each(['suspended', 'locked', 'deleted'])(
    'resolves the PII store of a %s account for its audit pseudonym, verified there',
    async (accountLifecycleState) => {
      const inactive = env();
      (inactive as unknown as Record<string, unknown>).TDB_USERS_A = d1({
        role: 'tenant_core/users',
        accountLifecycleState,
      });
      await expect(
        resolveAccountDataContext(inactive, { tenantId: 'tenant-a', accountId: 'user-a' })
      ).rejects.toThrow('lookup_destination_revalidation_failed');
      expect(
        await resolveAccountPiiSourceForAudit(inactive, {
          tenantId: 'tenant-a',
          accountId: 'user-a',
        })
      ).toBe((inactive as unknown as Record<string, unknown>).TDB_PII_A);

      const piiMismatch = env();
      (piiMismatch as unknown as Record<string, unknown>).TDB_PII_A = d1({
        role: 'tenant_pii',
        metadataBindingRef: 'TDB_PII_B',
      });
      await expect(
        resolveAccountPiiSourceForAudit(piiMismatch, { tenantId: 'tenant-a', accountId: 'user-a' })
      ).rejects.toThrow('lookup_destination_revalidation_failed');
      clearLookupRouteMemoryCache();
      mocks.tenantId = 'tenant-b';
      await expect(
        resolveAccountPiiSourceForAudit(env(), { tenantId: 'tenant-a', accountId: 'user-a' })
      ).rejects.toThrow('account_data_route_not_found');
      mocks.tenantId = 'tenant-a';
    }
  );

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
    ).rejects.toThrow('missing_binding');
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
