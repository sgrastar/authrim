import { CHECK_API_CONDITION_TYPES, validatePolicyConditions } from '@authrim/ar-lib-policy';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  audit: vi.fn(),
  generateId: vi.fn(() => 'generated-id'),
  addRules: vi.fn(),
  evaluate: vi.fn(),
  logger: { error: vi.fn() },
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
    mocks.audit.mockResolvedValue(undefined);
    mocks.evaluate.mockReturnValue({
      allowed: true,
      reason: 'matched',
      decidedBy: 'rule-1',
      details: { priority: 100 },
    });
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
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(row ? 1 : 0);
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
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(expect.arrayContaining([0, null, null]));
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
      if (name === 'scope') return 'org';
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
