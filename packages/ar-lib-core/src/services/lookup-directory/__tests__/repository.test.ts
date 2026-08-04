import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedLookupMembership } from '../repository';
import { LookupDirectoryRepository, mergeRotatingLookupMemberships } from '../repository';

const INDEX = {
  indexKind: 'account_id' as const,
  normalizationVersion: 1,
  hmacKeyGeneration: 4,
  digest: 'a'.repeat(64),
  virtualBucket: 123,
};

const PROJECTION = {
  schemaVersion: 1,
  accountRouteGeneration: 9,
  residencyPolicyId: 'residency-default',
  targets: [
    {
      dataRole: 'tenant_core/users' as const,
      residencyPartition: 'default',
      shardId: 'users-1',
      bindingRef: 'TDB_USERS_0001_CORE',
      requiredBindingRouteGeneration: 12,
    },
    {
      dataRole: 'tenant_pii' as const,
      residencyPartition: 'default',
      shardId: 'pii-1',
      bindingRef: 'TDB_PII_0001',
      requiredBindingRouteGeneration: 12,
    },
  ],
};

const ALIAS_INDEX = {
  aliasKind: 'tenant_code' as const,
  digest: 'b'.repeat(64),
  virtualBucket: 321,
};

const ALIAS_PROJECTION = {
  schemaVersion: 1,
  tenantRouteGeneration: 7,
  residencyPolicyId: 'residency-default',
  target: {
    dataRole: 'tenant_core/default' as const,
    residencyPartition: 'default',
    shardId: 'tenant-default-1',
    bindingRef: 'TDB_TENANT_DEFAULT_0001',
    requiredBindingRouteGeneration: 7,
  },
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    virtual_bucket: 123,
    index_kind: 'account_id',
    normalization_version: 1,
    hmac_key_generation: 4,
    identifier_blind_digest: 'a'.repeat(64),
    tenant_id: 'tenant-a',
    account_id: 'account-a',
    route_schema_version: 1,
    account_route_generation: 9,
    required_binding_route_generation: 12,
    residency_policy_id: 'residency-default',
    route_projection_json: JSON.stringify(PROJECTION),
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
    ...overrides,
  };
}

function aliasRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    virtual_bucket: ALIAS_INDEX.virtualBucket,
    alias_kind: ALIAS_INDEX.aliasKind,
    alias_sha256_digest: ALIAS_INDEX.digest,
    tenant_id: 'tenant-a',
    route_schema_version: 1,
    route_projection_json: JSON.stringify(ALIAS_PROJECTION),
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
    ...overrides,
  };
}

function session(rows: unknown[], bookmark: string): D1DatabaseSession {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn(async () => ({ success: true, results: rows, meta: {} })),
    })),
    batch: vi.fn(),
    getBookmark: vi.fn(() => bookmark),
  } as unknown as D1DatabaseSession;
}

function db(...sessions: D1DatabaseSession[]): Pick<D1Database, 'withSession'> {
  const withSession = vi.fn();
  for (const value of sessions) withSession.mockReturnValueOnce(value);
  return { withSession } as Pick<D1Database, 'withSession'>;
}

function membership(overrides: Partial<ResolvedLookupMembership> = {}): ResolvedLookupMembership {
  return {
    tenantId: 'tenant-a',
    accountId: 'account-a',
    routeProjection: PROJECTION,
    accountRouteGeneration: 9,
    hmacKeyGeneration: 4,
    normalizationVersion: 1,
    ...overrides,
  };
}

describe('LookupDirectoryRepository', () => {
  it('performs one exact Lookup D1 read and primary-rechecks replica not-found', async () => {
    const repository = new LookupDirectoryRepository(
      db(session([], 'replica'), session([row()], 'primary'))
    );
    const result = await repository.findActiveMemberships(INDEX);
    expect(result.primaryRechecked).toBe(true);
    expect(result.memberships).toEqual([membership()]);
  });

  it('fails closed for route projection or lifecycle disagreement', async () => {
    await expect(
      new LookupDirectoryRepository(
        db(session([row({ account_route_generation: 10 })], 'x'))
      ).findActiveMemberships(INDEX)
    ).rejects.toThrow('lookup_identifier_row_inconsistent');

    await expect(
      new LookupDirectoryRepository(
        db(session([row({ tenant_lifecycle_state: 'quarantined' })], 'x'))
      ).findActiveMemberships(INDEX)
    ).rejects.toThrow('lookup_identifier_row_inconsistent');
  });

  it('primary-rechecks aliases and accepts only tenant default projections', async () => {
    const repository = new LookupDirectoryRepository(
      db(session([], 'replica'), session([aliasRow()], 'primary'))
    );
    const result = await repository.findActiveAlias(ALIAS_INDEX);
    expect(result).toEqual({
      aliases: [{ tenantId: 'tenant-a', routeProjection: ALIAS_PROJECTION }],
      primaryRechecked: true,
    });

    await expect(
      new LookupDirectoryRepository(
        db(
          session(
            [
              aliasRow({
                route_projection_json: JSON.stringify({
                  ...ALIAS_PROJECTION,
                  target: { ...ALIAS_PROJECTION.target, dataRole: 'tenant_core/users' },
                }),
              }),
            ],
            'replica'
          )
        )
      ).findActiveAlias(ALIAS_INDEX)
    ).rejects.toThrow('invalid_tenant_alias_route_data_role');
  });

  it('fails closed when an alias resolves to multiple tenants', async () => {
    await expect(
      new LookupDirectoryRepository(
        db(session([aliasRow(), aliasRow({ tenant_id: 'tenant-b' })], 'replica'))
      ).findActiveAlias(ALIAS_INDEX)
    ).rejects.toThrow('lookup_alias_not_unique');
  });

  it('uses a validated tenant cursor for bounded alias pagination', async () => {
    const bound = vi.fn().mockReturnThis();
    const trackedSession = {
      prepare: vi.fn(() => ({
        bind: bound,
        all: vi.fn(async () => ({
          success: true,
          results: [aliasRow({ tenant_id: 'tenant-b' })],
          meta: {},
        })),
      })),
      batch: vi.fn(),
      getBookmark: vi.fn(() => 'bookmark'),
    } as unknown as D1DatabaseSession;
    const repository = new LookupDirectoryRepository(db(trackedSession));

    await expect(
      repository.findActiveAliases(ALIAS_INDEX, 4, undefined, 'tenant-a')
    ).resolves.toMatchObject({ aliases: [{ tenantId: 'tenant-b' }] });
    expect(bound).toHaveBeenCalledWith(
      ALIAS_INDEX.virtualBucket,
      ALIAS_INDEX.aliasKind,
      ALIAS_INDEX.digest,
      'tenant-a',
      5
    );
    expect(
      String((trackedSession.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])
    ).toContain('tenant_id > ?');

    await expect(
      repository.findActiveAliases(ALIAS_INDEX, 4, undefined, 'tenant a')
    ).rejects.toThrow('lookup_alias_cursor_invalid');
  });

  it('merges current and previous key results by membership and rejects route conflicts', () => {
    expect(
      mergeRotatingLookupMemberships([
        [membership({ hmacKeyGeneration: 4 })],
        [membership({ hmacKeyGeneration: 3 })],
      ])
    ).toEqual([membership({ hmacKeyGeneration: 4 })]);

    expect(() =>
      mergeRotatingLookupMemberships([
        [membership()],
        [
          membership({
            hmacKeyGeneration: 3,
            accountRouteGeneration: 10,
            routeProjection: { ...PROJECTION, accountRouteGeneration: 10 },
          }),
        ],
      ])
    ).toThrow('lookup_rotation_route_conflict');
  });

  it('allows at most current and previous result sets', () => {
    expect(() => mergeRotatingLookupMemberships([])).toThrow(
      'lookup_rotation_result_set_count_invalid'
    );
    expect(() => mergeRotatingLookupMemberships([[], [], []])).toThrow(
      'lookup_rotation_result_set_count_invalid'
    );
  });
});
