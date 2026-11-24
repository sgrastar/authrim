import { beforeEach, describe, expect, it, vi } from 'vitest';
import { argRec, callArg } from './helpers/mock-args';
import { encrypt } from '../utils/crypto';

const m = vi.hoisted(() => ({
  byIdentifier: vi.fn(),
  metadataCtx: vi.fn(),
  customSources: vi.fn(),
  persist: vi.fn(),
  sync: vi.fn(),
  join: vi.fn(),
  assign: vi.fn(),
  ensureDb: vi.fn(),
  findPending: vi.fn(),
  findLinked: vi.fn(),
  activate: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAccountDataContextByIdentifier: m.byIdentifier,
    resolveTenantMetadataContext: m.metadataCtx,
    resolveCustomClaimRuntimeSourcesFromEnv: m.customSources,
    persistCustomClaimWrite: m.persist,
    syncUserLifecycleState: m.sync,
    joinOrganization: m.join,
    assignScopedRoleToUser: m.assign,
    ensureDatabaseAdapter: m.ensureDb,
  };
});
vi.mock('../services/linked-identity-store', () => ({
  findLinkedIdentity: m.findLinked,
  createLinkedIdentity: vi.fn(),
  updateLinkedIdentity: vi.fn(),
  findPendingLinkedIdentityProvisioning: m.findPending,
  activatePendingLinkedIdentity: m.activate,
}));

import {
  completeExternalIdpJIT,
  completeTenantD1ExternalIdpJIT,
} from '../services/identity-stitching';

const KEY = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const ENV = { RP_TOKEN_ENCRYPTION_KEY: KEY } as never;
const INPUT = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  providerId: 'prov',
  providerUserId: 'sub-1',
};
const ACCOUNT = {
  accountId: 'account:user-a',
  legacyUserId: 'user-a',
  coreDb: { core: 1 },
  piiDb: { pii: 1 },
};
const SCHEMA_DB = { schema: 1 };
const META_DB = { meta: 1 };
const VALIDATION = {
  ok: true,
  schemas: [{ field_key: 'department', field_type: 'string' }],
  nonPiiValues: { department: 'x' },
  piiValues: { phone: '1' },
  nonPiiKeysToDelete: ['old'],
  piiKeysToDelete: [],
};

function plan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    customClaimValidation: VALIDATION,
    organizationIds: [],
    roleAssignments: [],
    defaultRoleId: null,
    matchedRules: [],
    attributesSet: [],
    ...overrides,
  };
}

async function pendingWith(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'pending-1',
    tenantId: 'tenant-a',
    userId: 'user-a',
    providerId: 'prov',
    providerUserId: 'sub-1',
    profileDataEncrypted: await encrypt(text, KEY),
    ...extra,
  };
}

async function run(value: Record<string, unknown> | string) {
  m.findPending.mockResolvedValue(
    await pendingWith(typeof value === 'string' ? value : JSON.stringify(value))
  );
  return completeExternalIdpJIT(ENV, INPUT);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.byIdentifier.mockReset().mockResolvedValue(ACCOUNT);
  m.metadataCtx.mockReset().mockResolvedValue({ coreDb: META_DB });
  m.customSources.mockReset().mockResolvedValue({ schemaDb: SCHEMA_DB });
  m.persist.mockReset().mockResolvedValue(undefined);
  m.sync.mockReset().mockResolvedValue(undefined);
  m.join.mockReset().mockResolvedValue({ success: true });
  m.assign.mockReset().mockResolvedValue({ success: true });
  m.ensureDb
    .mockReset()
    .mockImplementation((db: unknown, label: string) => ({ adapterOf: db, label }));
  m.findPending.mockReset().mockResolvedValue(null);
  m.findLinked.mockReset().mockResolvedValue(null);
  m.activate.mockReset().mockResolvedValue(undefined);
});

describe('finding the pending identity', () => {
  it('is exported under both names', () => {
    expect(completeExternalIdpJIT).toBe(completeTenantD1ExternalIdpJIT);
  });

  it('resolves the account by its external subject and reads the pending link there', async () => {
    await run(plan());
    expect(callArg(m.byIdentifier, 0, 1)).toEqual({
      tenantId: 'tenant-a',
      indexKind: 'external_subject',
      identifier: { issuer: 'prov', subject: 'sub-1' },
    });
    expect(m.findPending).toHaveBeenCalledWith(ENV, 'tenant-a', 'prov', 'sub-1', ACCOUNT.piiDb);
  });

  it('refuses a route that names another user', async () => {
    m.byIdentifier.mockResolvedValue({ ...ACCOUNT, legacyUserId: 'user-b' });
    await expect(completeExternalIdpJIT(ENV, INPUT)).rejects.toThrow(
      'external_idp_jit_account_route_mismatch'
    );
    expect(m.findPending).not.toHaveBeenCalled();
  });

  it('returns an identity already active for the user, without applying anything', async () => {
    m.findLinked.mockResolvedValue({ id: 'active-1', userId: 'user-a' });
    await expect(completeExternalIdpJIT(ENV, INPUT)).resolves.toEqual({
      linkedIdentityId: 'active-1',
      roles_assigned: [],
      orgs_joined: [],
    });
    expect(m.findLinked).toHaveBeenCalledWith(ENV, 'tenant-a', 'prov', 'sub-1', ACCOUNT.piiDb);
    expect(m.persist).not.toHaveBeenCalled();
    expect(m.activate).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing pending or active', null, null],
    ['an active identity of another user', null, { id: 'a', userId: 'user-b' }],
    ['a pending identity of another user', { userId: 'user-b' }, null],
  ])('refuses with %s', async (_n, pendingExtra, active) => {
    m.findPending.mockResolvedValue(pendingExtra ? await pendingWith('{}', pendingExtra) : null);
    m.findLinked.mockResolvedValue(active);
    await expect(completeExternalIdpJIT(ENV, INPUT)).rejects.toThrow(
      'external_idp_jit_pending_identity_not_found'
    );
    expect(m.persist).not.toHaveBeenCalled();
  });

  it('does not look for an active identity while one is pending', async () => {
    await run(plan());
    expect(m.findLinked).not.toHaveBeenCalled();
  });
});

describe('identity ids the service hands on', () => {
  it('refuses an active identity whose stored id is empty', async () => {
    m.findLinked.mockResolvedValue({ id: '', userId: 'user-a' });
    await expect(completeExternalIdpJIT(ENV, INPUT)).rejects.toThrow(
      'external_idp_jit_identity_id_invalid'
    );
  });

  it('refuses a pending identity whose stored id is empty, before writing anything', async () => {
    m.findPending.mockResolvedValue(await pendingWith(JSON.stringify(plan()), { id: '' }));
    await expect(completeExternalIdpJIT(ENV, INPUT)).rejects.toThrow(
      'external_idp_jit_identity_id_invalid'
    );
    expect(m.persist).not.toHaveBeenCalled();
    expect(m.sync).not.toHaveBeenCalled();
    expect(m.activate).not.toHaveBeenCalled();
  });

  it('refuses ids that are not text, in both places', async () => {
    m.findLinked.mockResolvedValue({ id: 5, userId: 'user-a' });
    await expect(completeExternalIdpJIT(ENV, INPUT)).rejects.toThrow(
      'external_idp_jit_identity_id_invalid'
    );
    m.findLinked.mockResolvedValue(null);
    m.findPending.mockResolvedValue(await pendingWith(JSON.stringify(plan()), { id: undefined }));
    await expect(completeExternalIdpJIT(ENV, INPUT)).rejects.toThrow(
      'external_idp_jit_identity_id_invalid'
    );
  });
});

describe('the stored plan', () => {
  const bad = 'external_idp_jit_plan_invalid';
  const str = (n: number) => 'x'.repeat(n);
  const map = (entries: number, valueLength = 1) =>
    Object.fromEntries(Array.from({ length: entries }, (_, i) => [`k${i}`, str(valueLength)]));
  const validation = (extra: Record<string, unknown>) =>
    plan({ customClaimValidation: { ...VALIDATION, ...extra } });

  const REJECTED: Array<[string, Record<string, unknown> | string]> = [
    ['text that is not JSON', '{nope'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"plan"'],
    ['another schema version', plan({ schemaVersion: 2 })],
    ['an extra key', plan({ extra: 1 })],
    [
      'a missing key',
      (() => {
        const p = plan();
        delete p.matchedRules;
        return p;
      })(),
    ],
    ['no validation', plan({ customClaimValidation: undefined })],
    ['a validation that is not ok', validation({ ok: false })],
    ['schemas that are not an array', validation({ schemas: 'x' })],
    [
      'too many schemas',
      validation({
        schemas: Array.from({ length: 65 }, () => ({ field_key: 'a', field_type: 'string' })),
      }),
    ],
    ['a null schema', validation({ schemas: [null] })],
    ['an array schema', validation({ schemas: [[]] })],
    ['a schema without a field key', validation({ schemas: [{ field_type: 'string' }] })],
    [
      'a schema with an empty field key',
      validation({ schemas: [{ field_key: '', field_type: 'string' }] }),
    ],
    [
      'a schema with a long field key',
      validation({ schemas: [{ field_key: str(129), field_type: 'string' }] }),
    ],
    ['a schema without a field type', validation({ schemas: [{ field_key: 'a' }] })],
    [
      'a schema with a long field type',
      validation({ schemas: [{ field_key: 'a', field_type: str(65) }] }),
    ],
    ['non-PII values that are an array', validation({ nonPiiValues: [] })],
    ['null non-PII values', validation({ nonPiiValues: null })],
    ['too many non-PII values', validation({ nonPiiValues: map(65) })],
    ['a non-PII value that is not text', validation({ nonPiiValues: { a: 1 } })],
    ['an empty non-PII value', validation({ nonPiiValues: { a: '' } })],
    ['a long non-PII value', validation({ nonPiiValues: { a: str(16 * 1024 + 1) } })],
    ['a long non-PII key', validation({ nonPiiValues: { [str(129)]: 'x' } })],
    ['PII values that are an array', validation({ piiValues: [] })],
    ['a long PII value', validation({ piiValues: { a: str(16 * 1024 + 1) } })],
    ['too many PII values', validation({ piiValues: map(65) })],
    ['non-PII keys to delete that are not an array', validation({ nonPiiKeysToDelete: 'x' })],
    [
      'too many non-PII keys to delete',
      validation({ nonPiiKeysToDelete: Array.from({ length: 65 }, () => 'k') }),
    ],
    ['an empty key to delete', validation({ nonPiiKeysToDelete: [''] })],
    ['a long key to delete', validation({ nonPiiKeysToDelete: [str(257)] })],
    ['PII keys to delete that are not an array', validation({ piiKeysToDelete: {} })],
    [
      'too many PII keys to delete',
      validation({ piiKeysToDelete: Array.from({ length: 65 }, () => 'k') }),
    ],
    ['a non-text PII key to delete', validation({ piiKeysToDelete: [1] })],
    ['organization ids that are not an array', plan({ organizationIds: 'o' })],
    ['too many organization ids', plan({ organizationIds: Array.from({ length: 65 }, () => 'o') })],
    ['an empty organization id', plan({ organizationIds: [''] })],
    ['a long organization id', plan({ organizationIds: [str(257)] })],
    ['role assignments that are not an array', plan({ roleAssignments: {} })],
    [
      'too many role assignments',
      plan({
        roleAssignments: Array.from({ length: 129 }, () => ({
          roleId: 'r',
          scopeType: 'org',
          scopeTarget: 'org:1',
        })),
      }),
    ],
    ['a null role assignment', plan({ roleAssignments: [null] })],
    ['an array role assignment', plan({ roleAssignments: [['r', 'org', 'org:1']] })],
    [
      'a role assignment with an extra key',
      plan({ roleAssignments: [{ roleId: 'r', scopeType: 'org', scopeTarget: 'org:1', x: 1 }] }),
    ],
    [
      'a role assignment with two keys',
      plan({ roleAssignments: [{ roleId: 'r', scopeType: 'org' }] }),
    ],
    [
      'a role assignment without a role id',
      plan({ roleAssignments: [{ roleId: '', scopeType: 'org', scopeTarget: 'org:1' }] }),
    ],
    [
      'a role assignment with a long scope type',
      plan({ roleAssignments: [{ roleId: 'r', scopeType: str(65), scopeTarget: 'org:1' }] }),
    ],
    [
      'a scoped role with an empty target',
      plan({ roleAssignments: [{ roleId: 'r', scopeType: 'org', scopeTarget: '' }] }),
    ],
    [
      'a global role with a target of the wrong type',
      plan({ roleAssignments: [{ roleId: 'r', scopeType: 'global', scopeTarget: 5 }] }),
    ],
    ['an empty default role', plan({ defaultRoleId: '' })],
    ['a default role that is not text', plan({ defaultRoleId: 5 })],
    ['a long default role', plan({ defaultRoleId: str(257) })],
    ['matched rules that are not an array', plan({ matchedRules: 'r' })],
    ['too many matched rules', plan({ matchedRules: Array.from({ length: 129 }, () => 'r') })],
    ['a non-text matched rule', plan({ matchedRules: [1] })],
    ['attributes that are not an array', plan({ attributesSet: {} })],
    [
      'too many attributes',
      plan({ attributesSet: Array.from({ length: 129 }, () => ({ name: 'n', value: 'v' })) }),
    ],
    ['a null attribute', plan({ attributesSet: [null] })],
    ['an array attribute', plan({ attributesSet: [['n', 'v']] })],
    ['an attribute with an extra key', plan({ attributesSet: [{ name: 'n', value: 'v', x: 1 }] })],
    ['an attribute with one key', plan({ attributesSet: [{ name: 'n' }] })],
    ['an attribute with an empty name', plan({ attributesSet: [{ name: '', value: 'v' }] })],
    ['an attribute with a long name', plan({ attributesSet: [{ name: str(129), value: 'v' }] })],
    ['an attribute with an empty value', plan({ attributesSet: [{ name: 'n', value: '' }] })],
    ['an attribute with a long value', plan({ attributesSet: [{ name: 'n', value: str(4097) }] })],
    ['a plan over 20 KiB', plan({ matchedRules: Array.from({ length: 128 }, () => str(200)) })],
  ];

  it.each(REJECTED)('refuses %s before writing anything', async (_n, value) => {
    await expect(run(value)).rejects.toThrow(bad);
    expect(m.persist).not.toHaveBeenCalled();
    expect(m.activate).not.toHaveBeenCalled();
  });

  const ACCEPTED: Array<[string, Record<string, unknown>]> = [
    ['an empty plan', plan()],
    ['no schemas', validation({ schemas: [] })],
    [
      '64 schemas',
      validation({
        schemas: Array.from({ length: 64 }, () => ({ field_key: str(128), field_type: str(64) })),
      }),
    ],
    [
      '64 values',
      validation({
        nonPiiValues: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, 'v'])),
        piiValues: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`p${i}`, 'v'])),
      }),
    ],
    [
      'values at the key and value size limits',
      validation({
        nonPiiValues: { [str(128)]: 'v' },
        piiValues: { k: str(16 * 1024) },
      }),
    ],
    [
      '64 keys to delete of 256 characters',
      validation({
        nonPiiKeysToDelete: Array.from({ length: 64 }, () => str(256)),
        piiKeysToDelete: [str(256)],
      }),
    ],
    [
      '64 organizations',
      plan({ organizationIds: Array.from({ length: 64 }, (_, i) => `org${i}`) }),
    ],
    [
      'a global role with an empty target',
      plan({ roleAssignments: [{ roleId: 'r', scopeType: 'global', scopeTarget: '' }] }),
    ],
    [
      'a scoped role',
      plan({ roleAssignments: [{ roleId: str(256), scopeType: str(64), scopeTarget: str(256) }] }),
    ],
    ['a default role of 256 characters', plan({ defaultRoleId: str(256) })],
    ['128 matched rules', plan({ matchedRules: Array.from({ length: 128 }, () => 'r') })],
    [
      '128 attributes',
      plan({ attributesSet: Array.from({ length: 128 }, () => ({ name: 'n', value: 'v' })) }),
    ],
    [
      'an attribute name of 128 characters',
      plan({ attributesSet: [{ name: str(128), value: 'v' }] }),
    ],
    [
      'an attribute value of 4096 characters',
      plan({ attributesSet: [{ name: 'n', value: str(4096) }] }),
    ],
  ];

  it.each(ACCEPTED)('accepts %s', async (_n, value) => {
    await expect(run(value)).resolves.toMatchObject({ linkedIdentityId: 'pending-1' });
    expect(m.activate).toHaveBeenCalledTimes(1);
  });

  it('refuses a plan that is not authenticated by the tenant key', async () => {
    m.findPending.mockResolvedValue({
      ...(await pendingWith('{}')),
      profileDataEncrypted: await encrypt(JSON.stringify(plan()), 'a'.repeat(63) + 'b'),
    });
    await expect(completeExternalIdpJIT(ENV, INPUT)).rejects.toThrow();
    expect(m.persist).not.toHaveBeenCalled();
  });
});

describe('applying the plan', () => {
  const org = (id: string) => ({
    roleId: `role-${id}`,
    scopeType: 'org',
    scopeTarget: `org:${id}`,
  });

  it('writes the custom claims, then the lifecycle, then activates the identity', async () => {
    const order: string[] = [];
    m.persist.mockImplementation(async () => void order.push('persist'));
    m.sync.mockImplementation(async () => void order.push('sync'));
    m.activate.mockImplementation(async () => void order.push('activate'));
    const result = await run(plan());
    expect(order).toEqual(['persist', 'sync', 'activate']);
    expect(result).toEqual({ linkedIdentityId: 'pending-1', roles_assigned: [], orgs_joined: [] });
    expect(m.customSources).toHaveBeenCalledWith(ENV, 'tenant-a');
    expect(argRec(m.persist)).toEqual({
      db: ACCOUNT.coreDb,
      dbPii: ACCOUNT.piiDb,
      schemaDb: SCHEMA_DB,
      tenantId: 'tenant-a',
      userId: 'user-a',
      validation: VALIDATION,
    });
    expect(m.ensureDb).toHaveBeenCalledWith(ACCOUNT.coreDb, 'external-idp-jit-lifecycle');
    expect(argRec(m.sync)).toEqual({
      db: ACCOUNT.coreDb,
      dbPii: ACCOUNT.piiDb,
      schemaDb: SCHEMA_DB,
      stateDb: { adapterOf: ACCOUNT.coreDb, label: 'external-idp-jit-lifecycle' },
      tenantId: 'tenant-a',
      userId: 'user-a',
      accountAuthenticationEnv: ENV,
    });
    expect(m.activate).toHaveBeenCalledWith(
      ENV,
      expect.objectContaining({ id: 'pending-1' }),
      ACCOUNT.piiDb
    );
  });

  it('joins the planned organizations in the tenant metadata and account databases', async () => {
    m.join
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true });
    const result = await run(plan({ organizationIds: ['o1', 'o2', 'o3'] }));
    expect(result.orgs_joined).toEqual(['o1', 'o3']);
    expect(m.join.mock.calls).toEqual([
      [{ metadata: META_DB, account: ACCOUNT.coreDb }, 'user-a', 'o1', 'tenant-a', 'member'],
      [{ metadata: META_DB, account: ACCOUNT.coreDb }, 'user-a', 'o2', 'tenant-a', 'member'],
      [{ metadata: META_DB, account: ACCOUNT.coreDb }, 'user-a', 'o3', 'tenant-a', 'member'],
    ]);
    expect(m.metadataCtx).toHaveBeenCalledWith(ENV, 'tenant-a');
  });

  it('assigns each grantable role and records the ones that succeeded', async () => {
    // g succeeds, role-o1 fails, x succeeds
    m.assign.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
    const result = await run(
      plan({
        organizationIds: ['o1'],
        roleAssignments: [
          { roleId: 'g', scopeType: 'global', scopeTarget: '' },
          org('o1'),
          org('o2'),
          { roleId: 'x', scopeType: 'tenant', scopeTarget: 't' },
        ],
      })
    );
    // org:o2 was not joined: never assigned. The 'x' role is not an org role: assigned.
    expect(m.assign.mock.calls.map((c): unknown[] => c.slice(1))).toEqual([
      ['user-a', 'g', 'global', '', 'tenant-a'],
      ['user-a', 'role-o1', 'org', 'org:o1', 'tenant-a'],
      ['user-a', 'x', 'tenant', 't', 'tenant-a'],
    ]);
    expect(callArg(m.assign, 0, 0)).toEqual({ metadata: META_DB, account: ACCOUNT.coreDb });
    expect(result.roles_assigned).toEqual([
      { role_id: 'g', scope_type: 'global', scope_target: '' },
      { role_id: 'x', scope_type: 'tenant', scope_target: 't' },
    ]);
  });

  it('gives the default role, scoped to the first joined organization, when no role was given', async () => {
    const result = await run(
      plan({ organizationIds: ['o1', 'o2'], defaultRoleId: 'default-role' })
    );
    expect(m.assign.mock.calls.map((c): unknown[] => c.slice(1))).toEqual([
      ['user-a', 'default-role', 'org', 'org:o1', 'tenant-a'],
    ]);
    expect(result.roles_assigned).toEqual([
      { role_id: 'default-role', scope_type: 'org', scope_target: 'org:o1' },
    ]);
  });

  it('gives the default role globally, with an empty target, when no organization was joined', async () => {
    const result = await run(plan({ defaultRoleId: 'default-role' }));
    expect(m.assign.mock.calls.map((c): unknown[] => c.slice(1))).toEqual([
      ['user-a', 'default-role', 'global', '', 'tenant-a'],
    ]);
    expect(result.roles_assigned).toEqual([
      { role_id: 'default-role', scope_type: 'global', scope_target: '' },
    ]);
  });

  it('does not record a default role that could not be assigned', async () => {
    m.assign.mockResolvedValue({ success: false });
    const result = await run(plan({ defaultRoleId: 'default-role' }));
    expect(result.roles_assigned).toEqual([]);
  });

  it('does not add the default role to a role that was assigned', async () => {
    const result = await run(
      plan({
        roleAssignments: [{ roleId: 'g', scopeType: 'global', scopeTarget: '' }],
        defaultRoleId: 'default-role',
      })
    );
    expect(m.assign).toHaveBeenCalledTimes(1);
    expect(result.roles_assigned).toHaveLength(1);
  });

  it('adds the default role when every planned role failed', async () => {
    m.assign.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
    const result = await run(
      plan({
        roleAssignments: [{ roleId: 'g', scopeType: 'global', scopeTarget: '' }],
        defaultRoleId: 'default-role',
      })
    );
    expect(result.roles_assigned.map((r) => r.role_id)).toEqual(['default-role']);
  });

  it('applies nothing when the apply step finds the identity no longer pending', async () => {
    m.findPending
      .mockResolvedValueOnce(await pendingWith(JSON.stringify(plan())))
      .mockResolvedValueOnce(null);
    m.findLinked.mockResolvedValue({ id: 'active-2', userId: 'user-a' });
    await expect(completeExternalIdpJIT(ENV, INPUT)).resolves.toEqual({
      linkedIdentityId: 'active-2',
      roles_assigned: [],
      orgs_joined: [],
    });
    expect(m.persist).not.toHaveBeenCalled();
  });

  it('refuses when the apply step finds another account for the subject', async () => {
    m.findPending.mockResolvedValue(await pendingWith(JSON.stringify(plan())));
    m.byIdentifier
      .mockResolvedValueOnce(ACCOUNT)
      .mockResolvedValueOnce({ ...ACCOUNT, legacyUserId: 'user-b' });
    await expect(completeExternalIdpJIT(ENV, INPUT)).rejects.toThrow(
      'external_idp_jit_account_route_mismatch'
    );
    expect(m.persist).not.toHaveBeenCalled();
  });

  it('refuses when the apply step finds a pending identity of another user', async () => {
    m.findPending
      .mockResolvedValueOnce(await pendingWith(JSON.stringify(plan())))
      .mockResolvedValueOnce(await pendingWith('{}', { userId: 'user-b' }));
    await expect(completeExternalIdpJIT(ENV, INPUT)).rejects.toThrow(
      'external_idp_jit_pending_identity_not_found'
    );
  });

  it('refuses when the apply step finds nothing pending or active', async () => {
    m.findPending
      .mockResolvedValueOnce(await pendingWith(JSON.stringify(plan())))
      .mockResolvedValueOnce(null);
    await expect(completeExternalIdpJIT(ENV, INPUT)).rejects.toThrow(
      'external_idp_jit_pending_identity_not_found'
    );
  });
});
