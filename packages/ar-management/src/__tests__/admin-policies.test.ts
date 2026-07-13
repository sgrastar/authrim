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
  } = {}
) {
  return {
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

  it.each([false, true])('simulates enabled policies (save=%s)', async (save_history) => {
    mocks.adapter.query.mockResolvedValueOnce([
      rule(),
      rule({ id: 'bad-json', conditions: '{', description: 'fallback' }),
    ]);
    const response = await adminPolicySimulateHandler(
      context({ body: { context: { subject: { id: 'user-1' } }, save_history }, userId: 'admin-1' })
    );
    await expect(response.json()).resolves.toMatchObject({
      allowed: true,
      reason: 'matched',
      evaluated_rules: 2,
    });
    expect(mocks.addRules).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'rule-1', conditions: [] }),
      expect.objectContaining({ id: 'bad-json', conditions: [] }),
    ]);
    expect(mocks.adapter.execute).toHaveBeenCalledTimes(save_history ? 1 : 0);
  });

  it('persists nullable simulation decision details correctly', async () => {
    mocks.evaluate.mockReturnValueOnce({ allowed: false, reason: 'default deny' });
    await adminPolicySimulateHandler(
      context({ body: { context: { subject: { id: 'user-1' } }, save_history: true } })
    );
    expect(mocks.adapter.execute.mock.calls[0][1]).toEqual(
      expect.arrayContaining([0, 'default deny', null, null, null])
    );
  });

  it('handles simulation failures', async () => {
    mocks.adapter.query.mockRejectedValueOnce(new Error('failure'));
    expect(
      (
        await adminPolicySimulateHandler(
          context({ body: { context: { subject: { id: 'user-1' } } } })
        )
      ).status
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

  it('returns complete condition metadata grouped into seven categories', async () => {
    const body = (await (await adminConditionTypesHandler(context())).json()) as {
      condition_types: Array<{ type: string }>;
      categories: unknown[];
    };
    expect(body.categories).toHaveLength(7);
    expect(body.condition_types.map((item) => item.type)).toEqual(
      expect.arrayContaining(['has_role', 'attribute_equals', 'time_in_range', 'ip_in_range'])
    );
  });
});
