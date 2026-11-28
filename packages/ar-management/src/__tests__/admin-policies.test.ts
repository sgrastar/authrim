import { CHECK_API_CONDITION_TYPES, validatePolicyConditions } from '@authrim/ar-lib-policy';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), batch: vi.fn() },
  audit: vi.fn(),
  generateId: vi.fn(() => 'generated-id'),
  addRules: vi.fn(),
  evaluate: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn() },
  subjectAccountOf: vi.fn(),
  readSubjectGroupState: vi.fn(),
  subtreeHasSelfWritableDynamicGroup: vi.fn(),
  tenantHasSelfWritableDynamicGroup: vi.fn(),
}));

vi.mock('../admin-access-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../admin-access-check')>()),
  subjectAccountOf: mocks.subjectAccountOf,
  readSubjectGroupState: mocks.readSubjectGroupState,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.adapter })),
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuditLogFromContext: mocks.audit,
    generateId: mocks.generateId,
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
    subtreeHasSelfWritableDynamicGroup: mocks.subtreeHasSelfWritableDynamicGroup,
    tenantHasSelfWritableDynamicGroup: mocks.tenantHasSelfWritableDynamicGroup,
  };
});

vi.mock('@authrim/ar-lib-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-policy')>();
  return {
    ...actual,
    PolicyEngine: vi.fn(function () {
      return { addRules: mocks.addRules, evaluate: mocks.evaluate };
    }),
  };
});

import {
  adminConditionTypesHandler,
  adminPoliciesListHandler,
  adminPolicyCreateHandler,
  adminPolicyDeleteHandler,
  adminPolicyGetHandler,
  adminPolicySimulateHandler,
  adminPolicySimulationsHandler,
  adminPolicyUpdateHandler,
} from '../admin-policies';

// Admin operations are recorded through the forwarding shim (see the helper).
vi.mock('../admin-operation-audit', () => import('./helpers/legacy-admin-audit-shim'));

function context(
  options: {
    query?: Record<string, string | undefined>;
    id?: string;
    body?: unknown;
    bodyError?: boolean;
    userId?: string;
    /** The tenant's policy flags (Settings API feature-flags), or unreadable settings. */
    flags?: Record<string, boolean> | 'unreadable';
  } = {}
) {
  const flags = options.flags ?? {
    'feature.enable_abac': true,
    'feature.enable_verified_attributes': true,
  };
  return {
    env: {
      SETTINGS: {
        get: vi.fn(async (key: string) => {
          if (flags === 'unreadable') throw new Error('kv unavailable');
          return key === 'settings:tenant:tenant-a:feature-flags' ? JSON.stringify(flags) : null;
        }),
      },
    },
    get: vi.fn((name: string) =>
      name === 'adminAuth' && options.userId ? { userId: options.userId } : undefined
    ),
    req: {
      query: vi.fn((name?: string) => (name ? options.query?.[name] : (options.query ?? {}))),
      param: vi.fn(() => options.id ?? 'rule-1'),
      json: options.bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad json'))
        : vi.fn().mockResolvedValue(options.body ?? {}),
    },
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    tenant_id: 'tenant-a',
    name: 'Allow readers',
    description: null,
    priority: 100,
    effect: 'allow',
    resource_types: '["document"]',
    actions: '["read"]',
    conditions: '[]',
    enabled: 1,
    created_by: null,
    created_at: 100,
    updated_by: null,
    updated_at: 100,
    ...overrides,
  };
}

describe('admin policies APIs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adapter.query.mockReset();
    mocks.adapter.queryOne.mockReset();
    mocks.adapter.execute.mockReset();
    mocks.adapter.query.mockResolvedValue([]);
    mocks.adapter.queryOne.mockResolvedValue(null);
    mocks.adapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    // A batch runs its statements in order through execute (so its results are execute's).
    mocks.adapter.batch.mockReset();
    mocks.adapter.batch.mockImplementation(
      async (statements: Array<{ sql: string; params: unknown[] }>) => {
        const results: unknown[] = [];
        for (const statement of statements)
          results.push(await mocks.adapter.execute(statement.sql, statement.params));
        return results;
      }
    );
    mocks.audit.mockResolvedValue(undefined);
    mocks.evaluate.mockReturnValue({
      allowed: true,
      reason: 'matched',
      decidedBy: 'rule-1',
      details: { priority: 100 },
    });
    mocks.subjectAccountOf.mockReset();
    mocks.subjectAccountOf.mockImplementation(
      async (_env: unknown, _tenant: string, subjectId: string) => ({
        db: { name: 'account-db' },
        subjectId,
      })
    );
    mocks.readSubjectGroupState.mockReset();
    mocks.readSubjectGroupState.mockResolvedValue({
      groupIds: [],
      unknownGroupIds: [],
      rolesComplete: true,
    });
    mocks.subtreeHasSelfWritableDynamicGroup.mockReset();
    mocks.subtreeHasSelfWritableDynamicGroup.mockResolvedValue(false);
    mocks.tenantHasSelfWritableDynamicGroup.mockReset();
    mocks.tenantHasSelfWritableDynamicGroup.mockResolvedValue(false);
  });

  it('reads a PostgreSQL COUNT(*) string as a number in the list totals', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ count: '21' });
    mocks.adapter.query.mockResolvedValueOnce([]);
    const body = await (
      await adminPoliciesListHandler(context())
    ).json<{
      pagination: { total: unknown; total_pages: unknown };
    }>();
    expect(body.pagination).toMatchObject({ total: 21, total_pages: 2 });
  });

  /** The tenant's groups, as the group-existence check reads them. */
  const tenantGroups = (ids: string[]) =>
    mocks.adapter.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
      sql.includes('FROM "groups"')
        ? params
            .slice(1)
            .filter((id) => ids.includes(id as string))
            .map((id) => ({ id }))
        : []
    );

  it('refuses a group condition naming a group decided by a self-writable attribute', async () => {
    const tainted = (_db: unknown, _tenant: string, groupId: string) =>
      Promise.resolve(groupId === 'grp-self');
    mocks.subtreeHasSelfWritableDynamicGroup.mockImplementation(tainted);
    tenantGroups(['grp-ok', 'grp-self']);
    const conditions = [{ type: 'in_any_group', params: { group_ids: ['grp-ok', 'grp-self'] } }];

    const created = await adminPolicyCreateHandler(
      context({ body: { name: 'Members', effect: 'allow', conditions } })
    );
    expect(created.status).toBe(400);
    await expect(created.json()).resolves.toMatchObject({
      error: 'group_self_writable_attribute',
    });

    // An update: the conditions it sends, or the stored ones when it changes something else.
    mocks.adapter.queryOne.mockResolvedValueOnce(rule());
    expect((await adminPolicyUpdateHandler(context({ body: { conditions } }))).status).toBe(400);
    mocks.adapter.queryOne.mockResolvedValueOnce(
      rule({ conditions: JSON.stringify([{ type: 'in_group', params: { group_id: 'grp-self' } }]) })
    );
    expect((await adminPolicyUpdateHandler(context({ body: { enabled: true } }))).status).toBe(400);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();

    // A group decided only by trusted inputs is accepted.
    const accepted = await adminPolicyCreateHandler(
      context({
        body: {
          name: 'Members',
          effect: 'allow',
          conditions: [{ type: 'in_group', params: { group_id: 'grp-ok' } }],
        },
      })
    );
    expect(accepted.status).toBe(201);

    // Turning the rule off is always allowed: no check, so a problem rule can be stopped.
    mocks.adapter.queryOne.mockResolvedValueOnce(
      rule({ conditions: JSON.stringify([{ type: 'in_group', params: { group_id: 'grp-self' } }]) })
    );
    expect((await adminPolicyUpdateHandler(context({ body: { enabled: false } }))).status).toBe(
      200
    );
    expect(mocks.adapter.execute.mock.calls.at(-1)?.[0]).not.toContain('service_group_catalog');
  });

  it('refuses a same_group rule while any enabled service group is decided by a self-writable field', async () => {
    const conditions = [{ type: 'same_group', params: {} }];
    mocks.tenantHasSelfWritableDynamicGroup.mockResolvedValue(true);
    const created = await adminPolicyCreateHandler(
      context({ body: { name: 'Same group', effect: 'allow', conditions } })
    );
    expect(created.status).toBe(400);
    await expect(created.json()).resolves.toMatchObject({
      error: 'group_self_writable_attribute',
    });
    // Enabling a stored one is checked the same way.
    mocks.adapter.queryOne.mockResolvedValueOnce(
      rule({ enabled: 0, conditions: JSON.stringify(conditions) })
    );
    expect((await adminPolicyUpdateHandler(context({ body: { enabled: true } }))).status).toBe(400);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();

    mocks.tenantHasSelfWritableDynamicGroup.mockResolvedValue(false);
    const accepted = await adminPolicyCreateHandler(
      context({ body: { name: 'Same group', effect: 'allow', conditions } })
    );
    expect(accepted.status).toBe(201);
  });

  it('raises the rules version in the same batch as every create, update and delete', async () => {
    await adminPolicyCreateHandler(
      context({ body: { name: 'R', effect: 'allow', conditions: [] } })
    );
    mocks.adapter.queryOne.mockResolvedValueOnce(rule());
    await adminPolicyUpdateHandler(context({ body: { name: 'Renamed' } }));
    mocks.adapter.queryOne.mockResolvedValueOnce(rule());
    await adminPolicyDeleteHandler(context());
    const batches = mocks.adapter.batch.mock.calls as Array<
      [Array<{ sql: string; params: unknown[] }>]
    >;
    expect(batches).toHaveLength(3);
    const [create, update, remove] = batches.map(([statements]) => statements);
    expect(create[0].sql).toContain('INSERT INTO policy_rules');
    expect(update[0].sql).toContain('UPDATE policy_rules');
    expect(remove[0].sql).toContain('DELETE FROM policy_rules');
    for (const [statements] of batches) {
      expect(statements).toHaveLength(2);
      expect(statements[1].sql).toContain('INSERT INTO policy_rules_version');
      expect(statements[1].sql).toContain('version = policy_rules_version.version + 1');
      expect(statements[1].params).toEqual(['tenant-a']);
    }
  });

  it('makes no rule change when its batch fails (the version with it)', async () => {
    mocks.adapter.batch.mockRejectedValueOnce(new Error('batch failed'));
    const created = await adminPolicyCreateHandler(
      context({ body: { name: 'R', effect: 'allow', conditions: [] } })
    );
    expect(created.status).toBe(500);
  });

  it('refuses relying on non-membership of a group a service group decides', async () => {
    // grp-dyn is a service group; grp-parent is above it; grp-static is neither.
    mocks.adapter.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('WITH RECURSIVE up'))
        return [
          { id: 'grp-dyn', owned: 1 },
          { id: 'grp-parent', owned: 0 },
        ];
      if (sql.includes('FROM "groups"')) return params.slice(1).map((id) => ({ id }));
      return [];
    });
    const create = (effect: string, conditions: unknown[]) =>
      adminPolicyCreateHandler(context({ body: { name: 'R', effect, conditions } }));
    for (const [effect, conditions] of [
      ['allow', [{ type: 'not_in_any_group', params: { group_ids: ['grp-parent'] } }]],
      ['deny', [{ type: 'in_group', params: { group_id: 'grp-dyn' } }]],
      ['deny', [{ type: 'same_group', params: {} }]],
    ] as const) {
      const response = await create(effect, [...conditions]);
      expect(response.status, JSON.stringify(conditions)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'dynamic_group_negative_condition',
      });
    }
    // Re-enabling a stored one, or turning an allow into a deny, is checked the same way.
    mocks.adapter.queryOne.mockResolvedValueOnce(
      rule({
        enabled: 0,
        conditions: JSON.stringify([
          { type: 'not_in_any_group', params: { group_ids: ['grp-dyn'] } },
        ]),
      })
    );
    expect((await adminPolicyUpdateHandler(context({ body: { enabled: true } }))).status).toBe(400);
    mocks.adapter.queryOne.mockResolvedValueOnce(
      rule({ conditions: JSON.stringify([{ type: 'in_group', params: { group_id: 'grp-dyn' } }]) })
    );
    expect((await adminPolicyUpdateHandler(context({ body: { effect: 'deny' } }))).status).toBe(
      400
    );
    expect(mocks.adapter.batch).not.toHaveBeenCalled();
    // An allow on membership, and a negative condition on a group no service group decides: fine.
    expect(
      (await create('allow', [{ type: 'in_group', params: { group_id: 'grp-dyn' } }])).status
    ).toBe(201);
    expect(
      (await create('allow', [{ type: 'not_in_any_group', params: { group_ids: ['grp-static'] } }]))
        .status
    ).toBe(201);
  });

  it('refuses a deny on a role granted through a service group (role granted first)', async () => {
    mocks.adapter.query.mockImplementation(async (sql: string) =>
      sql.includes('WITH RECURSIVE up') ? [{ id: 'grp-dyn', owned: 1, role_name: 'member' }] : []
    );
    const deny = await adminPolicyCreateHandler(
      context({
        body: {
          name: 'R',
          effect: 'deny',
          conditions: [{ type: 'has_role', params: { role: 'member' } }],
        },
      })
    );
    expect(deny.status).toBe(400);
    await expect(deny.json()).resolves.toMatchObject({
      error: 'dynamic_group_negative_condition',
    });
    // An allow on it, and a deny on another role: fine.
    for (const body of [
      { effect: 'allow', conditions: [{ type: 'has_role', params: { role: 'member' } }] },
      { effect: 'deny', conditions: [{ type: 'has_role', params: { role: 'other' } }] },
    ])
      expect(
        (await adminPolicyCreateHandler(context({ body: { name: 'R', ...body } }))).status
      ).toBe(201);
  });

  it('checks an update that disables the rule and changes anything else', async () => {
    mocks.adapter.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('WITH RECURSIVE up')) return [{ id: 'grp-dyn', owned: 1 }];
      if (sql.includes('FROM "groups"')) return params.slice(1).map((id) => ({ id }));
      return [];
    });
    mocks.adapter.queryOne.mockResolvedValueOnce(
      rule({ conditions: JSON.stringify([{ type: 'in_group', params: { group_id: 'grp-dyn' } }]) })
    );
    const response = await adminPolicyUpdateHandler(
      context({ body: { enabled: false, effect: 'deny' } })
    );
    expect(response.status).toBe(400);
    expect(mocks.adapter.batch).not.toHaveBeenCalled();
  });

  it('checks a disabling update that carries any other key, even one that changes nothing', async () => {
    mocks.adapter.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('WITH RECURSIVE up')) return [{ id: 'grp-dyn', owned: 1 }];
      if (sql.includes('FROM "groups"')) return params.slice(1).map((id) => ({ id }));
      return [];
    });
    const denyOnDynamic = () =>
      rule({
        effect: 'deny',
        conditions: JSON.stringify([{ type: 'in_group', params: { group_id: 'grp-dyn' } }]),
      });
    for (const body of [
      { enabled: false, priority: 0 },
      { enabled: false, description: null },
      { enabled: false, metadata: {} },
    ]) {
      mocks.adapter.queryOne.mockResolvedValueOnce(denyOnDynamic());
      const response = await adminPolicyUpdateHandler(context({ body }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'dynamic_group_negative_condition',
      });
    }
    expect(mocks.adapter.batch).not.toHaveBeenCalled();
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('writes an update only on the rule as it was read and checked', async () => {
    mocks.adapter.queryOne
      .mockResolvedValueOnce(rule())
      // Re-read after the write did not apply: another edit changed the effect meanwhile.
      .mockResolvedValueOnce(rule({ effect: 'deny', updated_at: 200 }));
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const response = await adminPolicyUpdateHandler(context({ body: { name: 'Renamed' } }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'policy_version_conflict' });
    const [sql, params] = mocks.adapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('AND updated_at = ? AND enabled = ? AND effect = ? AND conditions = ?');
    expect(params).toEqual(expect.arrayContaining([100, 1, 'allow', '[]']));
  });

  it('refuses a group condition naming an ID that is not a group of the tenant', async () => {
    tenantGroups(['grp-ok']);
    const conditions = [{ type: 'in_any_group', params: { group_ids: ['grp-ok', 'grp-key'] } }];
    const created = await adminPolicyCreateHandler(
      context({ body: { name: 'Members', effect: 'allow', conditions } })
    );
    expect(created.status).toBe(400);
    await expect(created.json()).resolves.toMatchObject({ error: 'group_not_found' });
    mocks.adapter.queryOne.mockResolvedValueOnce(rule());
    const updated = await adminPolicyUpdateHandler(context({ body: { conditions } }));
    expect(updated.status).toBe(400);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('writes a rule with group conditions only at the service-group revision it checked', async () => {
    tenantGroups(['grp-ok']);
    mocks.adapter.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('service_group_catalog') ? { revision: 7 } : null
    );
    const conditions = [{ type: 'in_group', params: { group_id: 'grp-ok' } }];
    const created = await adminPolicyCreateHandler(
      context({ body: { name: 'Members', effect: 'allow', conditions } })
    );
    expect(created.status).toBe(201);
    const [sql, params] = mocks.adapter.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO policy_rules');
    expect(sql).toContain('FROM service_group_catalog WHERE tenant_id = ? AND revision = ?');
    expect(params.slice(-2)).toEqual(['tenant-a', 7]);

    // A service-group rule saved in between: the write does not apply.
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const conflict = await adminPolicyCreateHandler(
      context({ body: { name: 'Members', effect: 'allow', conditions } })
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ error: 'group_version_conflict' });

    mocks.adapter.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('service_group_catalog') ? { revision: 7 } : rule()
    );
    mocks.adapter.execute.mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const updated = await adminPolicyUpdateHandler(context({ body: { conditions } }));
    expect(updated.status).toBe(409);
    // The rule statement (the batch's first; the second raises the rules version).
    expect(mocks.adapter.execute.mock.calls.at(-2)?.[0]).toContain('AND EXISTS');
  });

  it('evaluates no rule when the roles and groups cannot be read for the account', async () => {
    mocks.subjectAccountOf.mockResolvedValueOnce({ db: {}, subjectId: 'user-1' });
    mocks.readSubjectGroupState.mockRejectedValueOnce(new Error('memberships unreadable'));
    mocks.adapter.query.mockResolvedValueOnce([rule()]);
    const response = await adminPolicySimulateHandler(
      context({ body: { context: checkContext({ subject: { id: 'account:user-1', roles: [] } }) } })
    );
    const body = await response.json<{ allowed: boolean; reason: string }>();
    // As the Check decides: no rule is evaluated (an unconditional allow included).
    expect(body.allowed).toBe(false);
    expect(body.reason).toContain('roles');
  });

  it('names the subject by its canonical account id in the simulation', async () => {
    mocks.subjectAccountOf.mockResolvedValueOnce({ db: {}, subjectId: 'user-1' });
    // An owner rule: it compares the canonical id with the resource's owner.
    mocks.adapter.query.mockResolvedValueOnce([
      rule({ conditions: JSON.stringify([{ type: 'is_resource_owner', params: {} }]) }),
    ]);
    const response = await adminPolicySimulateHandler(
      context({
        body: {
          context: checkContext({
            subject: { id: 'account:user-1', roles: [] },
            resource: { type: 'document', id: 'doc-1', ownerId: 'user-1' },
          }),
        },
      })
    );
    await expect(response.json()).resolves.toMatchObject({ allowed: true });
  });

  it("resolves the subject's groups at the instant the simulation evaluates", async () => {
    mocks.adapter.query.mockResolvedValueOnce([rule()]);
    await adminPolicySimulateHandler(
      context({ body: { context: checkContext({ timestamp: 1_700_000_123_456 }) } })
    );
    expect(mocks.readSubjectGroupState).toHaveBeenCalledWith(
      mocks.adapter,
      expect.objectContaining({ subjectId: 'user-1' }),
      'tenant-a',
      1_700_000_123
    );
  });

  it.each([
    [{}, [20, 0]],
    [
      { enabled: 'true', search: 'reader', page: '2', limit: '200' },
      [1, '%reader%', '%reader%', 100, 100],
    ],
    [{ enabled: 'false', page: '0', limit: '0' }, [0, 1, 0]],
  ])('lists tenant rules with bounded pagination %#', async (query, expectedTail) => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ count: 21 });
    mocks.adapter.query.mockResolvedValueOnce([
      rule(),
      rule({
        id: 'rule-2',
        description: 'deny',
        resource_types: null,
        actions: '{',
        conditions: '{',
        enabled: 0,
      }),
    ]);
    const body = (await (await adminPoliciesListHandler(context({ query }))).json()) as {
      rules: Array<Record<string, unknown>>;
      pagination: Record<string, unknown>;
    };
    expect(body.rules[0]).toMatchObject({
      resource_types: ['document'],
      actions: ['read'],
      enabled: true,
    });
    expect(body.rules[1]).toMatchObject({ resource_types: [], actions: [], conditions: [] });
    expect(mocks.adapter.query.mock.calls[0][1]).toEqual(expect.arrayContaining(expectedTail));
  });

  it('defaults missing list totals and handles DB failures', async () => {
    await expect((await adminPoliciesListHandler(context())).json()).resolves.toMatchObject({
      pagination: { total: 0 },
    });
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminPoliciesListHandler(context())).status).toBe(500);
  });

  it.each([null, rule()])('gets policy result %#', async (row) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(row);
    const response = await adminPolicyGetHandler(context());
    expect(response.status).toBe(row ? 200 : 404);
  });

  it('normalizes malformed arrays when getting a policy and handles errors', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(rule({ resource_types: '{', actions: null }));
    await expect((await adminPolicyGetHandler(context())).json()).resolves.toMatchObject({
      rule: { resource_types: [], actions: [] },
    });
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminPolicyGetHandler(context())).status).toBe(500);
  });

  it.each([
    [{}, 'Name is required'],
    [{ name: 'Rule' }, 'Valid effect is required'],
    [{ name: 'Rule', effect: 'invalid' }, 'Valid effect is required'],
    [{ name: 'Rule', effect: 'deny', conditions: {} }, 'conditions must be an array'],
    [
      { name: 'Rule', effect: 'deny', conditions: [{ type: 'no_such_condition', params: {} }] },
      'not a known condition type',
    ],
    [
      { name: 'Rule', effect: 'deny', conditions: [{ type: 'has_role' }] },
      'params must be an object',
    ],
    [{ name: 'Rule', effect: 'allow', actions: [1] }, 'actions must be an array of strings'],
    [
      { name: 'Rule', effect: 'allow', actions: ['Read'] },
      'actions entries must match [a-z][a-z0-9_]*',
    ],
    [
      { name: 'Rule', effect: 'deny', resource_types: ['my-docs'] },
      'resource_types entries must match [a-z][a-z0-9_]*',
    ],
    [{ name: 'Rule', effect: 'deny', priority: 'high' }, 'priority must be an integer'],
    [{ name: 'Rule', effect: 'allow', conditions: null }, 'conditions must be an array'],
    [
      {
        name: 'Rule',
        effect: 'deny',
        conditions: [
          {
            type: 'attribute_equals',
            params: { name: 'blocked', value: 'true', checkExpiry: false },
          },
        ],
      },
      'checkExpiry cannot be false',
    ],
    [{ name: 'Rule', effect: 'deny', priority: 1.5 }, 'priority must be an integer'],
    [
      {
        name: 'Rule',
        effect: 'deny',
        conditions: [{ type: 'numeric_gte', params: { name: 'age' } }],
      },
      'params.value',
    ],
    [
      {
        name: 'Rule',
        effect: 'deny',
        conditions: [{ type: 'user_type_is', params: { types: ['contractor'] } }],
      },
      'cannot be evaluated here',
    ],
  ])('validates create request %#', async (body, message) => {
    const response = await adminPolicyCreateHandler(context({ body }));
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(message);
  });

  it.each([
    [{ name: 'Default rule', effect: 'allow', conditions: [] }, null],
    [
      {
        name: 'Explicit rule',
        description: 'description',
        priority: 0,
        effect: 'deny',
        resource_types: [],
        actions: ['write'],
        conditions: undefined,
        enabled: false,
      },
      'admin-1',
    ],
  ])('creates and audits a policy %#', async (body, userId) => {
    const response = await adminPolicyCreateHandler(context({ body, userId: userId ?? undefined }));
    expect(response.status).toBe(201);
    expect(mocks.adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO policy_rules'),
      expect.arrayContaining(['generated-id', 'tenant-a', body.name, body.effect])
    );
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('handles create failures', async () => {
    mocks.adapter.execute.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await adminPolicyCreateHandler(
          context({ body: { name: 'Rule', effect: 'allow', conditions: [] } })
        )
      ).status
    ).toBe(500);
  });

  it('does not update a missing policy', async () => {
    expect((await adminPolicyUpdateHandler(context({ body: {} }))).status).toBe(404);
  });

  it('refuses an update the Check API could not evaluate', async () => {
    for (const body of [
      { conditions: [{ type: 'attribute_equals' }] },
      { effect: 'block' },
      { conditions: null },
      { resource_types: 'documents' },
    ]) {
      mocks.adapter.queryOne.mockResolvedValueOnce(rule());
      const response = await adminPolicyUpdateHandler(context({ body }));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('treats an empty policy update as a successful no-op', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(rule());
    expect((await adminPolicyUpdateHandler(context({ body: {} }))).status).toBe(200);
    expect(mocks.adapter.execute).not.toHaveBeenCalled();
  });

  it('updates every supported field, including false and zero values', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce(rule());
    const body = {
      name: '',
      description: '',
      priority: 0,
      effect: 'deny' as const,
      resource_types: [],
      actions: [],
      conditions: [],
      enabled: false,
    };
    const response = await adminPolicyUpdateHandler(context({ body, userId: 'admin-1' }));
    expect(response.status).toBe(200);
    expect(mocks.adapter.execute.mock.calls[0][0]).toContain('enabled = ?');
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['', null, 0, 'deny', '[]', '[]', 0, 'admin-1', 'tenant-a', 'rule-1'])
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'policy_rule_update',
      'policy_rule',
      'rule-1',
      { updates: Object.keys(body) }
    );
  });

  it('handles update failures', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminPolicyUpdateHandler(context({ body: {} }))).status).toBe(500);
  });

  it.each([null, rule()])('deletes policy result %#', async (row) => {
    mocks.adapter.queryOne.mockResolvedValueOnce(row);
    const response = await adminPolicyDeleteHandler(context());
    expect(response.status).toBe(row ? 200 : 404);
    // The delete and the rules version, in one batch.
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(row ? 2 : 0);
    expect(mocks.audit).toHaveBeenCalledTimes(row ? 1 : 0);
  });

  it('handles delete failures', async () => {
    mocks.adapter.queryOne.mockRejectedValueOnce(new Error('failure'));
    expect((await adminPolicyDeleteHandler(context())).status).toBe(500);
  });

  it('requires a simulation context', async () => {
    expect((await adminPolicySimulateHandler(context({ body: {} }))).status).toBe(400);
  });

  const checkContext = (overrides: Record<string, unknown> = {}) => ({
    subject: { id: 'user-1', roles: [] },
    resource: { type: 'document', id: 'doc-1' },
    action: { name: 'read' },
    timestamp: Date.now(),
    ...overrides,
  });

  it.each([false, true])(
    'simulates enabled policies as checks do (save=%s)',
    async (save_history) => {
      mocks.adapter.query.mockResolvedValueOnce([rule()]);
      const response = await adminPolicySimulateHandler(
        context({ body: { context: checkContext(), save_history }, userId: 'admin-1' })
      );
      await expect(response.json()).resolves.toMatchObject({
        allowed: true,
        decided_by: 'rule-1',
        evaluated_rules: 1,
      });
      expect(mocks.adapter.execute).toHaveBeenCalledTimes(save_history ? 1 : 0);
    }
  );

  it('applies a rule only to its resource types and actions', async () => {
    mocks.adapter.query.mockResolvedValueOnce([rule()]);
    const response = await adminPolicySimulateHandler(
      context({ body: { context: checkContext({ action: { name: 'write' } }) } })
    );
    await expect(response.json()).resolves.toMatchObject({ allowed: false });
  });

  it('grants nothing when a deny on the owner meets a request without one', async () => {
    const rows = () => [
      rule({
        id: 'not-owner',
        priority: 1000,
        effect: 'deny',
        conditions: JSON.stringify([{ type: 'is_resource_owner', params: {} }]),
      }),
      rule(),
    ];
    mocks.adapter.query.mockResolvedValueOnce(rows());
    const withoutOwner = await adminPolicySimulateHandler(
      context({ body: { context: checkContext() } })
    );
    await expect(withoutOwner.json()).resolves.toMatchObject({ allowed: false });

    mocks.adapter.query.mockResolvedValueOnce(rows());
    const otherOwner = await adminPolicySimulateHandler(
      context({
        body: { context: checkContext({ resource: { type: 'document', id: 'd', ownerId: 'u2' } }) },
      })
    );
    await expect(otherOwner.json()).resolves.toMatchObject({ allowed: true });
  });

  it('grants nothing while a stored rule cannot be evaluated', async () => {
    mocks.adapter.query.mockResolvedValueOnce([rule(), rule({ id: 'bad-json', conditions: '{' })]);
    const response = await adminPolicySimulateHandler(
      context({ body: { context: checkContext() } })
    );
    await expect(response.json()).resolves.toMatchObject({
      allowed: false,
      details: { unusable_rules: ['bad-json'] },
      evaluated_rules: 2,
    });
  });

  it('shows what checks decide under the tenant settings', async () => {
    mocks.adapter.query.mockResolvedValueOnce([rule()]);
    const off = await adminPolicySimulateHandler(
      context({ body: { context: checkContext() }, flags: { 'feature.enable_abac': false } })
    );
    await expect(off.json()).resolves.toMatchObject({
      allowed: false,
      details: { abac: false },
    });

    mocks.adapter.query.mockResolvedValueOnce([rule()]);
    const unreadable = await adminPolicySimulateHandler(
      context({ body: { context: checkContext() }, flags: 'unreadable' })
    );
    expect(unreadable.status).toBe(503);

    // Verified attributes off: a deny on one could never apply, so the rules grant nothing.
    mocks.adapter.query.mockResolvedValueOnce([
      rule({
        id: 'blocked',
        priority: 1000,
        effect: 'deny',
        conditions: JSON.stringify([
          { type: 'attribute_equals', params: { name: 'blocked', value: 'true' } },
        ]),
      }),
      rule(),
    ]);
    const withoutAttributes = await adminPolicySimulateHandler(
      context({ body: { context: checkContext() }, flags: { 'feature.enable_abac': true } })
    );
    await expect(withoutAttributes.json()).resolves.toMatchObject({ allowed: false });
  });

  it("evaluates the spec's simulation example as documented", async () => {
    const spec = parseYaml(
      readFileSync(new URL('../../openapi/admin.openapi.yaml', import.meta.url), 'utf8')
    ) as {
      components: { schemas: { AdminPolicySimulationRequest: { example: { context: unknown } } } };
    };
    const example = spec.components.schemas.AdminPolicySimulationRequest.example;
    mocks.adapter.query.mockResolvedValueOnce([
      rule({ resource_types: '["user"]', actions: '["read"]' }),
    ]);

    const response = await adminPolicySimulateHandler(
      context({ body: { context: example.context } })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ allowed: true });
  });

  it('persists nullable simulation decision details correctly', async () => {
    mocks.adapter.query.mockResolvedValueOnce([]);
    await adminPolicySimulateHandler(
      context({ body: { context: checkContext(), save_history: true } })
    );
    const binds = mocks.adapter.execute.mock.calls[0][1] as unknown[];
    // Not allowed (no rule), no administrator (stored as null); the details always say how the
    // subject's groups were known.
    expect(binds[3]).toBe(0);
    expect(binds[8]).toBeNull();
    expect(JSON.parse(binds[6] as string)).toMatchObject({ subject_groups: 'resolved' });
  });

  it("uses the subject's groups as given, resolved for the user, or unknown", async () => {
    const denyContractors = () => [
      rule({
        id: 'deny-contractors',
        priority: 1000,
        effect: 'deny',
        conditions: JSON.stringify([{ type: 'in_group', params: { group_id: 'contractors' } }]),
      }),
      rule(),
    ];

    const simulate = async (subject: Record<string, unknown>) => {
      const response = await adminPolicySimulateHandler(
        context({ body: { context: checkContext({ subject: { roles: [], ...subject } }) } })
      );
      return response.json<{ reason?: string } & Record<string, unknown>>();
    };

    // Given: used as they are, and not resolved.
    mocks.adapter.query.mockResolvedValueOnce(denyContractors());
    await expect(simulate({ id: 'user-1', groupIds: ['g1'] })).resolves.toMatchObject({
      allowed: true,
      details: { subject_groups: 'given' },
    });
    mocks.adapter.query.mockResolvedValueOnce(denyContractors());
    await expect(simulate({ id: 'user-1', groupIds: ['contractors'] })).resolves.toMatchObject({
      allowed: false,
      decided_by: 'deny-contractors',
      details: { subject_groups: 'given' },
    });
    // Resolved: the effective groups of the user the context names.
    mocks.readSubjectGroupState.mockResolvedValueOnce({
      groupIds: ['team', 'contractors'],
      unknownGroupIds: [],
      rolesComplete: true,
    });
    mocks.adapter.query.mockResolvedValueOnce(denyContractors());
    await expect(simulate({ id: 'user-1' })).resolves.toMatchObject({
      allowed: false,
      decided_by: 'deny-contractors',
      details: { subject_groups: 'resolved' },
    });
    expect(mocks.subjectAccountOf).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'user-1');

    // Partially unknown: a rule naming the unknown group is not evaluated; one naming only known
    // groups is.
    mocks.readSubjectGroupState.mockResolvedValueOnce({
      groupIds: ['team'],
      unknownGroupIds: ['contractors'],
      rolesComplete: true,
    });
    mocks.adapter.query.mockResolvedValueOnce(denyContractors());
    const partial = await simulate({ id: 'user-1' });
    expect(partial).toMatchObject({
      allowed: false,
      details: { subject_groups: 'partially_unknown' },
    });
    expect(partial.reason).toContain('unknown');
    mocks.readSubjectGroupState.mockResolvedValueOnce({
      groupIds: ['team'],
      unknownGroupIds: ['other'],
      rolesComplete: true,
    });
    mocks.adapter.query.mockResolvedValueOnce(denyContractors());
    await expect(simulate({ id: 'user-1' })).resolves.toMatchObject({
      allowed: true,
      details: { subject_groups: 'partially_unknown' },
    });
    // Roles incomplete (an unknown group carries a role): no rule is evaluated, as in checks.
    mocks.readSubjectGroupState.mockResolvedValueOnce({
      groupIds: [],
      unknownGroupIds: ['other'],
      rolesComplete: false,
    });
    mocks.adapter.query.mockResolvedValueOnce([rule()]);
    const incomplete = await simulate({ id: 'user-1' });
    expect(incomplete).toMatchObject({ allowed: false });
    expect(incomplete.reason).toContain('roles');

    // Unknown: rules with group conditions are not evaluated (unknown is not "no groups"),
    // whether the memberships cannot be read or the account does not resolve.
    mocks.readSubjectGroupState.mockRejectedValueOnce(new Error('memberships unreadable'));
    mocks.adapter.query.mockResolvedValueOnce(denyContractors());
    await expect(simulate({ id: 'user-1' })).resolves.toMatchObject({
      allowed: false,
      details: { subject_groups: 'unknown' },
    });
    mocks.subjectAccountOf.mockRejectedValueOnce(new Error('no such account'));
    mocks.adapter.query.mockResolvedValueOnce(denyContractors());
    const unknown = await simulate({ id: 'user-1' });
    expect(unknown).toMatchObject({ allowed: false, details: { subject_groups: 'unknown' } });
    expect(unknown.reason).toContain('group conditions');

    // Rules without group conditions are evaluated as before when the groups are unknown.
    mocks.subjectAccountOf.mockRejectedValueOnce(new Error('no such account'));
    mocks.adapter.query.mockResolvedValueOnce([rule()]);
    await expect(simulate({ id: 'user-1' })).resolves.toMatchObject({
      allowed: true,
      details: { subject_groups: 'unknown' },
    });
  });

  it('refuses subject groups that are not a list of ids', async () => {
    const response = await adminPolicySimulateHandler(
      context({
        body: { context: checkContext({ subject: { id: 'user-1', roles: [], groupIds: 'g1' } }) },
      })
    );
    expect(response.status).toBe(400);
  });

  it('evaluates the rules with feature.enable_abac alone (no separate custom-rules switch)', async () => {
    mocks.adapter.query.mockResolvedValueOnce([rule()]);
    const response = await adminPolicySimulateHandler(
      context({
        body: { context: checkContext() },
        flags: { 'feature.enable_abac': true, 'feature.enable_custom_rules': false },
      })
    );
    await expect(response.json()).resolves.toMatchObject({ allowed: true, decided_by: 'rule-1' });
  });

  it('handles simulation failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect(
      (await adminPolicySimulateHandler(context({ body: { context: checkContext() } }))).status
    ).toBe(500);
  });

  it('lists normalized simulation history with bounded pagination', async () => {
    mocks.adapter.queryOne.mockResolvedValueOnce({ count: 1 });
    mocks.adapter.query.mockResolvedValueOnce([
      {
        id: 'sim-1',
        tenant_id: 'tenant-a',
        context: '{"subject":{"id":"user-1"}}',
        allowed: 1,
        reason: 'matched',
        decided_by: 'rule-1',
        details: '{"priority":100}',
        matched_rules: '["rule-1"]',
        simulated_by: null,
        simulated_at: 100,
      },
      {
        id: 'sim-2',
        context: '{}',
        allowed: 0,
        reason: 'deny',
        decided_by: null,
        details: null,
        simulated_by: null,
        simulated_at: 101,
      },
    ]);
    const body = (await (
      await adminPolicySimulationsHandler(context({ query: { page: '0', limit: '200' } }))
    ).json()) as { simulations: Array<Record<string, unknown>>; pagination: unknown };
    expect(body.simulations).toEqual([
      expect.objectContaining({ allowed: true, details: { priority: 100 } }),
      expect.objectContaining({ allowed: false, details: null }),
    ]);
    expect(body.pagination).toMatchObject({ page: 1, limit: 100, total: 1 });
  });

  it('defaults missing simulation totals and rejects malformed stored JSON', async () => {
    await expect((await adminPolicySimulationsHandler(context())).json()).resolves.toMatchObject({
      pagination: { total: 0 },
    });
    mocks.adapter.query.mockResolvedValueOnce([{ context: '{' }]);
    expect((await adminPolicySimulationsHandler(context())).status).toBe(500);
  });

  it('describes exactly the conditions a saved rule may use, with the names it must use', async () => {
    const body = (await (await adminConditionTypesHandler(context())).json()) as {
      condition_types: Array<{
        type: string;
        category: string;
        params: Array<{ name: string; type: string; required: boolean }>;
      }>;
      categories: Array<{ id: string }>;
    };
    expect(new Set(body.condition_types.map((item) => item.type))).toEqual(
      new Set(CHECK_API_CONDITION_TYPES)
    );
    const categories = new Set(body.categories.map((category) => category.id));
    // Sample values a form would send for each parameter.
    const sample = (name: string, type: string): unknown => {
      if (name === 'scope') return 'group';
      if (name === 'timezone') return 'Asia/Tokyo';
      if (name === 'startHour') return 9;
      if (name === 'endHour') return 17;
      if (name === 'allowedDays') return [1, 2];
      if (type === 'string[]') return ['a'];
      if (type === 'number[]') return [1];
      if (type === 'number') return 5;
      if (type === 'boolean') return true;
      return 'a';
    };
    for (const item of body.condition_types) {
      expect(categories.has(item.category), item.type).toBe(true);
      const all = Object.fromEntries(item.params.map((p) => [p.name, sample(p.name, p.type)]));
      const required = Object.fromEntries(
        item.params.filter((p) => p.required).map((p) => [p.name, sample(p.name, p.type)])
      );
      // What the legacy form sends when only the required fields are filled in: optional ones
      // left at their starting values (empty text, empty lists, unset numbers) are left out.
      const fromForm = Object.fromEntries(
        item.params.filter((p) => p.required).map((p) => [p.name, sample(p.name, p.type)])
      );
      expect(fromForm).toEqual(required);
      for (const params of [all, required]) {
        expect(
          validatePolicyConditions([{ type: item.type, params }], CHECK_API_CONDITION_TYPES, {
            expiredAttributesKnown: false,
          }),
          `${item.type}: ${JSON.stringify(params)}`
        ).toBeNull();
      }
    }
  });
});
