/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  createLookupBlindIndex,
  type LookupIdentifierRow,
} from '@authrim/ar-lib-core/services/lookup-directory/index';
import { createAwsRuntimeDataPorts, type AwsDataTenantInventory } from './data-runtime';

const READ_KEY = { generation: 1, secret: 'lookup-secret-with-at-least-thirty-two-bytes' };
const OLD_KEY = { generation: 2, secret: 'another-lookup-secret-with-at-least-32-bytes' };
const ACCOUNT_ID = 'account:user-1';
const target = (dataRole: string, bindingRef: string, generation = 2, partition = 'global') => ({
  dataRole,
  residencyPartition: partition,
  shardId: `${bindingRef}-shard`,
  bindingRef,
  requiredBindingRouteGeneration: generation,
});
const route = (targets: unknown[], over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  accountRouteGeneration: 3,
  residencyPolicyId: 'default',
  targets,
  ...over,
});
const ROUTE = route([
  target('tenant_core/users', 'CORE', 2, 'core-region'),
  target('tenant_pii', 'PII', 5, 'pii-region'),
]);

async function lookupRow(
  tenantId: string,
  kind: 'account_id' | 'external_subject',
  identifier: string | { issuer: string; subject: string },
  projection: unknown = ROUTE,
  accountId = ACCOUNT_ID,
  key = READ_KEY
): Promise<LookupIdentifierRow> {
  const index = await createLookupBlindIndex(kind, identifier, key);
  return {
    virtual_bucket: index.virtualBucket,
    index_kind: index.indexKind,
    normalization_version: index.normalizationVersion,
    hmac_key_generation: index.hmacKeyGeneration,
    identifier_blind_digest: index.digest,
    tenant_id: tenantId,
    account_id: accountId,
    route_schema_version: 1,
    account_route_generation: 3,
    required_binding_route_generation: Math.max(
      ...(projection as { targets: Array<{ requiredBindingRouteGeneration: number }> }).targets.map(
        (t) => t.requiredBindingRouteGeneration
      )
    ),
    residency_policy_id: 'default',
    route_projection_json: JSON.stringify(projection),
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
  };
}

const goodAccount = {
  id: ACCOUNT_ID,
  legacy_user_id: 'user-1',
  lifecycle_state: 'active',
  directory_publication_state: 'active',
};
function pg(account: unknown = null, type = 'postgres') {
  const queryOne = vi.fn(async () => account);
  return { db: { getType: () => type, queryOne } as unknown as DatabaseAdapter, queryOne };
}
async function inventory(
  over: Partial<AwsDataTenantInventory> = {},
  account: unknown = goodAccount
) {
  const metadata = pg();
  const core = pg(account);
  const pii = pg();
  const subject = { issuer: 'passkey:example.org', subject: 'credential-1' };
  const value: AwsDataTenantInventory = {
    tenantId: 'alpha',
    allocationScope: 'tenant_exclusive',
    metadataCoreDb: metadata.db,
    accountCoreByBindingRef: { CORE: core.db },
    accountPiiByBindingRef: { PII: pii.db },
    lookupRows: [
      await lookupRow('alpha', 'account_id', ACCOUNT_ID),
      await lookupRow('alpha', 'external_subject', subject),
    ],
    coreAccountRouteGenerations: { [ACCOUNT_ID]: 3 },
    lookupReadKeys: [READ_KEY],
    ...over,
  };
  return { value, metadata, core, pii, subject };
}

describe('AWS runtime data ports (mutation hardening)', () => {
  it('rejects invalid inventories with exact codes', async () => {
    const { value } = await inventory();
    expect(() => createAwsRuntimeDataPorts([])).toThrow('aws_data_inventory_required');
    for (const tenantId of ['', 'Alpha', '-a', 'a-', 'a_b', 'a b', 'a.b'])
      expect(
        () => createAwsRuntimeDataPorts([{ ...value, tenantId, lookupRows: [] }]),
        tenantId
      ).toThrow('aws_data_tenant_inventory_invalid');
    for (const tenantId of ['a', 'a1', 'a-b', '0a'])
      expect(() =>
        createAwsRuntimeDataPorts([{ ...value, tenantId, lookupRows: [] }])
      ).not.toThrow();
    expect(() =>
      createAwsRuntimeDataPorts([
        { ...value, lookupRows: [] },
        { ...value, lookupRows: [] },
      ])
    ).toThrow('aws_data_tenant_inventory_invalid');
    expect(() =>
      createAwsRuntimeDataPorts([
        { ...value, lookupRows: [] },
        { ...value, tenantId: 'beta', lookupRows: [] },
      ])
    ).not.toThrow();
    for (const lookupReadKeys of [
      [],
      [READ_KEY, OLD_KEY, { generation: 3, secret: 'x'.repeat(40) }],
    ])
      expect(() => createAwsRuntimeDataPorts([{ ...value, lookupReadKeys }])).toThrow(
        'aws_data_lookup_key_inventory_invalid'
      );
    expect(() =>
      createAwsRuntimeDataPorts([{ ...value, lookupReadKeys: [READ_KEY, OLD_KEY] }])
    ).not.toThrow();
  });

  it('requires PostgreSQL adapters everywhere', async () => {
    const { value } = await inventory();
    const mysql = pg(null, 'd1').db;
    for (const patch of [
      { metadataCoreDb: mysql },
      { accountCoreByBindingRef: { CORE: mysql } },
      { accountPiiByBindingRef: { PII: mysql } },
    ])
      expect(() => createAwsRuntimeDataPorts([{ ...value, ...patch }])).toThrow(
        'aws_data_postgres_required'
      );
  });

  it('validates Core route generations by account id shape and positive safe integers', async () => {
    const { value } = await inventory();
    for (const generations of <Array<Record<string, number>>>[
      { 'user-1': 3 },
      { 'account:': 3 },
      { [ACCOUNT_ID]: 0 },
      { [ACCOUNT_ID]: -1 },
      { [ACCOUNT_ID]: 1.5 },
      { [ACCOUNT_ID]: Number.MAX_SAFE_INTEGER + 1 },
      { [ACCOUNT_ID]: Number.NaN },
    ])
      expect(() =>
        createAwsRuntimeDataPorts([
          { ...value, lookupRows: [], coreAccountRouteGenerations: generations },
        ])
      ).toThrow('aws_data_core_route_generation_invalid');
    expect(() =>
      createAwsRuntimeDataPorts([
        {
          ...value,
          lookupRows: [],
          coreAccountRouteGenerations: { [ACCOUNT_ID]: 1, 'account:b': 7 },
        },
      ])
    ).not.toThrow();
    expect(() =>
      createAwsRuntimeDataPorts([
        {
          ...value,
          lookupRows: [],
          coreAccountRouteGenerations: { [`account:${'a'.repeat(248)}`]: 1 },
        },
      ])
    ).not.toThrow();
    expect(() =>
      createAwsRuntimeDataPorts([
        {
          ...value,
          lookupRows: [],
          coreAccountRouteGenerations: { [`account:${'a'.repeat(249)}`]: 1 },
        },
      ])
    ).toThrow('aws_data_core_route_generation_invalid');
  });

  it('rejects Lookup rows of another tenant or with a mismatching Core generation', async () => {
    const { value } = await inventory();
    const row = value.lookupRows[0];
    expect(() =>
      createAwsRuntimeDataPorts([{ ...value, lookupRows: [{ ...row, tenant_id: 'beta' }] }])
    ).toThrow('aws_data_lookup_tenant_mismatch');
    expect(() =>
      createAwsRuntimeDataPorts([
        { ...value, lookupRows: [{ ...row, account_id: 'account:other' }] },
      ])
    ).toThrow('aws_data_core_route_generation_mismatch');
    expect(() =>
      createAwsRuntimeDataPorts([{ ...value, coreAccountRouteGenerations: { [ACCOUNT_ID]: 4 } }])
    ).toThrow('aws_data_core_route_generation_mismatch');
    expect(() =>
      createAwsRuntimeDataPorts([
        { ...value, lookupRows: [{ ...row, account_route_generation: '3' }] },
      ])
    ).not.toThrow();
  });

  it('resolves the tenant, account and account-core views with exact shapes', async () => {
    const { value, metadata, core, pii, subject } = await inventory();
    const ports = createAwsRuntimeDataPorts([value]);
    expect(await ports.resolveTenant('alpha')).toEqual({
      runtimeKind: 'portable',
      tenantId: 'alpha',
      coreDb: metadata.db,
      route: { allocationScope: 'tenant_exclusive' },
    });
    await expect(ports.resolveTenant('missing')).rejects.toThrow('aws_data_tenant_not_found');
    const account = await ports.resolveAccount({
      tenantId: 'alpha',
      indexKind: 'external_subject',
      identifier: subject,
    });
    expect(account).toMatchObject({
      tenantId: 'alpha',
      accountId: ACCOUNT_ID,
      legacyUserId: 'user-1',
      coreDb: core.db,
      piiDb: pii.db,
      coreBindingRef: 'CORE',
      piiBindingRef: 'PII',
      coreResidencyPartition: 'core-region',
      piiResidencyPartition: 'pii-region',
      accountRouteGeneration: 3,
      userCacheScope: {
        routeGeneration: 'account:3',
        bindingGeneration: 'core:2:pii:5',
        schemaGeneration: 'route:1',
      },
      piiCacheMode: 'no_cross_request_pii',
    });
    expect(account.membership.accountId).toBe(ACCOUNT_ID);
    const coreOnly = await ports.resolveAccountCore({
      tenantId: 'alpha',
      accountId: ACCOUNT_ID,
      nowMs: 1,
    });
    expect(coreOnly).toEqual({
      tenantId: 'alpha',
      accountId: ACCOUNT_ID,
      legacyUserId: 'user-1',
      membership: expect.objectContaining({ accountId: ACCOUNT_ID }),
      coreDb: core.db,
      coreBindingRef: 'CORE',
      coreResidencyPartition: 'core-region',
      accountRouteGeneration: 3,
    });
    expect(
      await ports.resolveAccountPiiForAudit({ tenantId: 'alpha', accountId: ACCOUNT_ID, nowMs: 1 })
    ).toBe(pii.db);
  });

  it('accepts an account id with or without the account: prefix and rejects malformed ones', async () => {
    const { value, subject } = await inventory();
    const ports = createAwsRuntimeDataPorts([value]);
    const base = { tenantId: 'alpha', indexKind: 'external_subject' as const, identifier: subject };
    await expect(
      ports.resolveAccount({ ...base, expectedAccountId: 'user-1' })
    ).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
    });
    await expect(
      ports.resolveAccount({ ...base, expectedAccountId: ACCOUNT_ID })
    ).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
    });
    for (const bad of ['', 'account:', '-user', 'user 1', 'a'.repeat(249), 'account:-x'])
      await expect(ports.resolveAccount({ ...base, expectedAccountId: bad }), bad).rejects.toThrow(
        'account_data_account_id_invalid'
      );
    await expect(
      ports.resolveAccount({ ...base, expectedAccountId: 'other-user' })
    ).rejects.toThrow('account_data_route_not_found');
    await expect(
      ports.resolveAccount({ ...base, expectedAccountId: 'account:other-user' })
    ).rejects.toThrow('account_data_route_not_found');
  });

  it('reports unknown identifiers as not found', async () => {
    const { value } = await inventory();
    const ports = createAwsRuntimeDataPorts([value]);
    await expect(
      ports.resolveAccount({
        tenantId: 'alpha',
        indexKind: 'external_subject',
        identifier: { issuer: 'passkey:example.org', subject: 'unknown' },
      })
    ).rejects.toThrow('account_data_route_not_found');
    await expect(
      ports.resolveAccountCore({ tenantId: 'alpha', accountId: 'account:none' })
    ).rejects.toThrow('account_data_route_not_found');
  });

  it('treats identical duplicates as one route and different projections or accounts as ambiguous', async () => {
    const subject = { issuer: 'passkey:example.org', subject: 'credential-1' };
    const duplicate = await lookupRow('alpha', 'external_subject', subject);
    const base = await inventory();
    // identical route: still a single membership
    let ports = createAwsRuntimeDataPorts([
      { ...base.value, lookupRows: [...base.value.lookupRows, duplicate] },
    ]);
    await expect(
      ports.resolveAccount({
        tenantId: 'alpha',
        indexKind: 'external_subject',
        identifier: subject,
      })
    ).resolves.toMatchObject({ accountId: ACCOUNT_ID });
    // same account, diverging route projections
    const diverging = await lookupRow(
      'alpha',
      'external_subject',
      subject,
      route([target('tenant_core/users', 'CORE', 9), target('tenant_pii', 'PII', 5)])
    );
    ports = createAwsRuntimeDataPorts([
      { ...base.value, lookupRows: [...base.value.lookupRows, diverging] },
    ]);
    await expect(
      ports.resolveAccount({
        tenantId: 'alpha',
        indexKind: 'external_subject',
        identifier: subject,
      })
    ).rejects.toThrow('account_data_route_ambiguous');
    // the same identifier mapped to two accounts
    const other = await lookupRow('alpha', 'external_subject', subject, ROUTE, 'account:user-2');
    const perAccount = {
      getType: () => 'postgres',
      queryOne: async (_sql: string, params: string[]) => ({
        ...goodAccount,
        id: params[1],
        legacy_user_id: params[1].slice('account:'.length),
      }),
    } as unknown as DatabaseAdapter;
    ports = createAwsRuntimeDataPorts([
      {
        ...base.value,
        accountCoreByBindingRef: { CORE: perAccount },
        lookupRows: [...base.value.lookupRows, other],
        coreAccountRouteGenerations: { [ACCOUNT_ID]: 3, 'account:user-2': 3 },
      },
    ]);
    await expect(
      ports.resolveAccount({
        tenantId: 'alpha',
        indexKind: 'external_subject',
        identifier: subject,
      })
    ).rejects.toThrow('account_data_route_ambiguous');
    // an expected account id disambiguates
    await expect(
      ports.resolveAccount({
        tenantId: 'alpha',
        indexKind: 'external_subject',
        identifier: subject,
        expectedAccountId: 'user-2',
      })
    ).resolves.toMatchObject({ accountId: 'account:user-2' });
  });

  it('resolves identifiers indexed under an older read key during rotation', async () => {
    const subject = { issuer: 'passkey:example.org', subject: 'credential-1' };
    const base = await inventory({ lookupReadKeys: [READ_KEY, OLD_KEY] });
    const rotated = await lookupRow(
      'alpha',
      'external_subject',
      subject,
      ROUTE,
      ACCOUNT_ID,
      OLD_KEY
    );
    const ports = createAwsRuntimeDataPorts([{ ...base.value, lookupRows: [rotated] }]);
    await expect(
      ports.resolveAccount({
        tenantId: 'alpha',
        indexKind: 'external_subject',
        identifier: subject,
      })
    ).resolves.toMatchObject({ accountId: ACCOUNT_ID });
  });

  it('re-checks tenant and generation pins when resolving after construction', async () => {
    const { value, subject } = await inventory();
    const ports = createAwsRuntimeDataPorts([value]);
    const input = {
      tenantId: 'alpha',
      indexKind: 'external_subject' as const,
      identifier: subject,
    };
    const generations = value.coreAccountRouteGenerations as Record<string, number>;
    generations[ACCOUNT_ID] = 4;
    await expect(ports.resolveAccount(input)).rejects.toThrow(
      'aws_data_core_route_generation_mismatch'
    );
    generations[ACCOUNT_ID] = 3;
    await expect(ports.resolveAccount(input)).resolves.toBeDefined();
    const row = value.lookupRows.find((r) => r.index_kind === 'external_subject')!;
    (row as { tenant_id: string }).tenant_id = 'beta';
    await expect(ports.resolveAccount(input)).rejects.toThrow();
  });

  it('requires exactly one route target for each data role', async () => {
    const subject = { issuer: 'passkey:example.org', subject: 'credential-1' };
    const cases: Array<[string, unknown[]]> = [
      ['no core target', [target('tenant_pii', 'PII')]],
      ['no pii target', [target('tenant_core/users', 'CORE')]],
      [
        'two core targets',
        [
          target('tenant_core/users', 'CORE'),
          target('tenant_core/users', 'CORE2', 2, 'other-region'),
          target('tenant_pii', 'PII'),
        ],
      ],
      [
        'two pii targets',
        [
          target('tenant_core/users', 'CORE'),
          target('tenant_pii', 'PII'),
          target('tenant_pii', 'PII2', 2, 'other-region'),
        ],
      ],
    ];
    for (const [name, targets] of cases) {
      const base = await inventory({
        accountCoreByBindingRef: { CORE: pg(goodAccount).db, CORE2: pg(goodAccount).db },
        accountPiiByBindingRef: { PII: pg().db, PII2: pg().db },
      });
      const row = await lookupRow('alpha', 'external_subject', subject, route(targets));
      const ports = createAwsRuntimeDataPorts([{ ...base.value, lookupRows: [row] }]);
      await expect(
        ports.resolveAccount({
          tenantId: 'alpha',
          indexKind: 'external_subject',
          identifier: subject,
        }),
        name
      ).rejects.toThrow('aws_data_route_target_unsupported');
    }
  });

  it('fails closed when a restored database mapping is missing', async () => {
    const { value, subject } = await inventory();
    const input = {
      tenantId: 'alpha',
      indexKind: 'external_subject' as const,
      identifier: subject,
    };
    await expect(
      createAwsRuntimeDataPorts([{ ...value, accountCoreByBindingRef: {} }]).resolveAccount(input)
    ).rejects.toThrow('aws_data_core_route_missing');
    await expect(
      createAwsRuntimeDataPorts([{ ...value, accountPiiByBindingRef: {} }]).resolveAccount(input)
    ).rejects.toThrow('aws_data_pii_route_missing');
    await expect(
      createAwsRuntimeDataPorts([
        { ...value, accountPiiByBindingRef: {} },
      ]).resolveAccountPiiForAudit({
        tenantId: 'alpha',
        accountId: ACCOUNT_ID,
      })
    ).rejects.toThrow('aws_data_pii_route_missing');
    // Core-only resolution does not need the PII mapping
    await expect(
      createAwsRuntimeDataPorts([{ ...value, accountPiiByBindingRef: {} }]).resolveAccountCore({
        tenantId: 'alpha',
        accountId: ACCOUNT_ID,
      })
    ).resolves.toBeDefined();
  });

  it.each([
    ['missing row', null],
    ['other id', { ...goodAccount, id: 'account:other' }],
    ['suspended', { ...goodAccount, lifecycle_state: 'suspended' }],
    ['unpublished', { ...goodAccount, directory_publication_state: 'pending' }],
    ['no legacy user', { ...goodAccount, legacy_user_id: null }],
    ['invalid legacy user', { ...goodAccount, legacy_user_id: '' }],
    ['legacy user mismatch', { ...goodAccount, legacy_user_id: 'user-2' }],
  ])('rejects an inactive or inconsistent Core account: %s', async (_name, account) => {
    const { value } = await inventory({}, account);
    const ports = createAwsRuntimeDataPorts([value]);
    await expect(
      ports.resolveAccountCore({ tenantId: 'alpha', accountId: ACCOUNT_ID })
    ).rejects.toThrow('account_data_destination_account_inactive');
  });
});
