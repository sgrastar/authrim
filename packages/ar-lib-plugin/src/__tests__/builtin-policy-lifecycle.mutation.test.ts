import { describe, expect, it, vi } from 'vitest';
import { BuiltinPolicyInfra } from '../infra/policy/builtin';
import type { IStorageInfra, InfraEnv, RuleEvaluationContext } from '../infra/types';

const request = { subject: 'user:alice', relation: 'viewer', object: 'document:report' };
const cacheKey = 'rebac:user:alice#viewer@document:report';

function storage(options: { direct?: boolean; inherited?: boolean } = {}) {
  const queryOne = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT COUNT(*)')) return { count: options.direct ? 1 : 0 };
    if (sql.includes('FROM role_assignments ra')) return options.inherited ? { found: 1 } : null;
    throw new Error('unexpected query');
  });
  const query = vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown[]> => []);
  return { adapter: { queryOne, query } } as unknown as IStorageInfra & {
    adapter: { queryOne: typeof queryOne; query: typeof query };
  };
}

function kv(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  } as unknown as KVNamespace & { values: Map<string, string> };
}

async function ready(env: Record<string, unknown> = {}, db = storage()) {
  const policy = new BuiltinPolicyInfra();
  await policy.initialize(env as unknown as InfraEnv, db);
  return { policy, db };
}

describe('BuiltinPolicyInfra lifecycle', () => {
  it('reports its state with fixed messages', async () => {
    const policy = new BuiltinPolicyInfra();
    expect(policy.provider).toBe('builtin');
    await expect(policy.healthCheck()).resolves.toEqual({
      status: 'unhealthy',
      provider: 'builtin',
      message: 'Policy infrastructure not initialized',
    });
    await policy.initialize({} as InfraEnv, storage());
    await expect(policy.healthCheck()).resolves.toEqual({
      status: 'healthy',
      provider: 'builtin',
      message: 'Built-in ReBAC engine ready',
    });
  });

  it('refuses every operation before initialization', async () => {
    const policy = new BuiltinPolicyInfra();
    const context = { tenant_id: 't', idp_claims: {} } as unknown as RuleEvaluationContext;
    await expect(policy.check(request)).rejects.toThrow('Not initialized');
    await expect(
      policy.listObjects({ subject: 'user:a', relation: 'r', objectType: 'o' })
    ).rejects.toThrow('Not initialized');
    await expect(policy.listUsers({ object: 'o:1', relation: 'r' })).rejects.toThrow(
      'Not initialized'
    );
    await expect(policy.evaluateRules(context)).rejects.toThrow('Not initialized');
    await expect(policy.batchCheck({ checks: [] })).rejects.toThrow('Not initialized');
  });

  it('ignores a second initialization', async () => {
    const first = kv();
    const second = kv();
    const policy = new BuiltinPolicyInfra();
    await policy.initialize(
      { REBAC_CACHE: first } as unknown as InfraEnv,
      storage({ direct: true })
    );
    await policy.initialize(
      { REBAC_CACHE: second } as unknown as InfraEnv,
      storage({ direct: false })
    );
    await expect(policy.check(request)).resolves.toMatchObject({ allowed: true });
    expect(first.put).toHaveBeenCalledTimes(1);
    expect(second.put).not.toHaveBeenCalled();
  });

  it.each([
    ['3600', 3600],
    ['3601', 60],
    ['1', 1],
    ['-5', 60],
    [120, 120],
  ])('takes the cache TTL %s from the environment as %s', async (configured, expected) => {
    const cache = kv();
    const { policy } = await ready(
      { REBAC_CACHE: cache, REBAC_CACHE_TTL_SECONDS: configured },
      storage({ direct: true })
    );
    await policy.check(request);
    expect(cache.put).toHaveBeenCalledWith(cacheKey, 'true', { expirationTtl: expected });
  });
});

describe('BuiltinPolicyInfra decision caching', () => {
  it('caches each outcome with its own value', async () => {
    const direct = kv();
    await (await ready({ REBAC_CACHE: direct }, storage({ direct: true }))).policy.check(request);
    expect(direct.put).toHaveBeenCalledWith(cacheKey, 'true', expect.anything());

    const inherited = kv();
    await (
      await ready({ REBAC_CACHE: inherited }, storage({ inherited: true }))
    ).policy.check(request);
    expect(inherited.put).toHaveBeenCalledWith(cacheKey, 'true', expect.anything());

    const denied = kv();
    await (await ready({ REBAC_CACHE: denied }, storage())).policy.check(request);
    expect(denied.put).toHaveBeenCalledWith(cacheKey, 'false', expect.anything());
  });

  it('serves a cached true as a direct, cached decision', async () => {
    const { policy, db } = await ready({ REBAC_CACHE: kv({ [cacheKey]: 'true' }) });
    await expect(policy.check(request)).resolves.toEqual({
      allowed: true,
      resolution_method: 'direct',
      cached: true,
    });
    expect(db.adapter.queryOne).not.toHaveBeenCalled();
  });

  it('serves a cached false without asking the database', async () => {
    const { policy, db } = await ready(
      { REBAC_CACHE: kv({ [cacheKey]: 'false' }) },
      storage({ direct: true })
    );
    await expect(policy.check(request)).resolves.toEqual({
      allowed: false,
      resolution_method: 'direct',
      cached: true,
    });
    expect(db.adapter.queryOne).not.toHaveBeenCalled();
  });

  it('works without a cache binding', async () => {
    const { policy } = await ready({}, storage({ inherited: true }));
    await expect(policy.check(request)).resolves.toEqual({
      allowed: true,
      resolution_method: 'inherited',
      cached: false,
    });
  });

  it('removes only the requested keys, and nothing at all for a bulk request', async () => {
    const cache = kv({ 'rebac:a': 'true', 'rebac:b': 'true' });
    const { policy } = await ready({ REBAC_CACHE: cache });
    await policy.invalidateCache({ all: true, keys: ['a'] });
    expect(cache.delete).not.toHaveBeenCalled();
    await policy.invalidateCache({ keys: ['a'] });
    expect(cache.delete).toHaveBeenCalledWith('rebac:a');
    expect(cache.values.has('rebac:b')).toBe(true);
  });

  it('does nothing to invalidate when there is no cache', async () => {
    const { policy } = await ready({});
    await expect(policy.invalidateCache({ keys: ['a'] })).resolves.toBeUndefined();
  });
});

describe('BuiltinPolicyInfra pagination', () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      to_type: 'doc',
      to_id: String(i),
      from_type: 'user',
      from_id: String(i),
    }));

  it('gives no cursor when the page is exactly full and nothing follows', async () => {
    const db = storage();
    db.adapter.query.mockResolvedValue(rows(2));
    const { policy } = await ready({}, db);
    await expect(
      policy.listObjects({ subject: 'user:a', relation: 'r', objectType: 'doc', limit: 2 })
    ).resolves.toEqual({ objects: ['doc:0', 'doc:1'], cursor: undefined });
    await expect(policy.listUsers({ object: 'doc:1', relation: 'r', limit: 2 })).resolves.toEqual({
      users: ['user:0', 'user:1'],
      cursor: undefined,
    });
  });

  it('continues from the cursor and defaults to a limit of 100', async () => {
    const db = storage();
    db.adapter.query.mockResolvedValue(rows(101));
    const { policy } = await ready({}, db);
    const objects = await policy.listObjects({
      subject: 'user:a',
      relation: 'r',
      objectType: 'doc',
      cursor: '200',
    });
    expect(objects.objects).toHaveLength(100);
    expect(objects.cursor).toBe('300');
    expect(db.adapter.query).toHaveBeenLastCalledWith(expect.any(String), [
      'user',
      'a',
      'r',
      'doc',
      101,
      200,
    ]);
    const users = await policy.listUsers({ object: 'doc:1', relation: 'r', cursor: '50' });
    expect(users.users).toHaveLength(100);
    expect(users.cursor).toBe('150');
    expect(db.adapter.query).toHaveBeenLastCalledWith(expect.any(String), [
      'doc',
      '1',
      'r',
      101,
      50,
    ]);
  });
});

describe('BuiltinPolicyInfra rule loading', () => {
  const context = {
    tenant_id: 'tenant-a',
    email_domain_hash: 'h',
    email_verified: true,
    idp_claims: { n: 0, s: '', z: null, deep: { v: 1 } },
    provider_id: 'p',
    user_type: 'u',
  } as unknown as RuleEvaluationContext;

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'r1',
      tenant_id: 'tenant-a',
      priority: 1,
      conditions: null,
      action: 'allow',
      roles_to_assign: JSON.stringify(['reader']),
      groups_to_join: JSON.stringify(['org']),
      attributes_to_set: JSON.stringify([{ key: 'k', value: 1 }]),
      deny_reason: null,
      ...overrides,
    };
  }

  async function evaluate(rows: unknown[], env: Record<string, unknown> = {}) {
    const db = storage();
    db.adapter.query.mockResolvedValue(rows);
    const { policy } = await ready(env, db);
    return policy.evaluateRules(context);
  }

  it('applies a rule without conditions to everyone and reports the full result', async () => {
    expect(await evaluate([row()])).toEqual({
      matched_rules: ['r1'],
      roles_to_assign: ['reader'],
      groups_to_join: ['org'],
      attributes_to_set: [{ key: 'k', value: 1 }],
      denied: false,
    });
  });

  it.each([[null], ['']])(
    'treats the empty conditions column %j as no conditions',
    async (conditions) => {
      expect((await evaluate([row({ conditions })])).matched_rules).toEqual(['r1']);
    }
  );

  const unreadable = [
    ['not JSON', '{oops'],
    ['not an array', '{"field":"provider_id","operator":"eq","value":"p"}'],
    [
      'an unknown operator',
      JSON.stringify([{ field: 'provider_id', operator: 'equals', value: 'p' }]),
    ],
    ['a condition without a field', JSON.stringify([{ operator: 'eq', value: 'p' }])],
    ['a condition that is not an object', JSON.stringify(['provider_id'])],
    ['a numeric field', JSON.stringify([{ field: 5, operator: 'eq', value: 'p' }])],
    ['a numeric operator', JSON.stringify([{ field: 'provider_id', operator: 5, value: 'p' }])],
  ] as const;

  it.each(unreadable)(
    'does not apply an allow rule whose conditions are %s',
    async (_label, conditions) => {
      const result = await evaluate([row({ conditions })]);
      expect(result.matched_rules).toEqual([]);
      expect(result.roles_to_assign).toEqual([]);
      expect(result.denied).toBe(false);
    }
  );

  it.each(unreadable)(
    'fails closed for a deny rule whose conditions are %s',
    async (_label, conditions) => {
      const result = await evaluate([row({ action: 'deny', deny_reason: 'blocked', conditions })]);
      expect(result).toMatchObject({
        denied: true,
        deny_reason: 'blocked',
        matched_rules: ['r1'],
        roles_to_assign: [],
      });
    }
  );

  it('denies even when an allow rule matches before an unreadable deny rule', async () => {
    const result = await evaluate([
      row({ id: 'allow' }),
      row({ id: 'deny', action: 'deny', conditions: '{oops' }),
    ]);
    expect(result.denied).toBe(true);
    expect(result.matched_rules).toEqual(['allow', 'deny']);
  });

  it('keeps other rules when an allow rule is unreadable, and does not cache the broken one', async () => {
    const cache = kv();
    const result = await evaluate(
      [row({ id: 'broken', conditions: '{oops' }), row({ id: 'ok', priority: 2 })],
      { REBAC_CACHE: cache }
    );
    expect(result.matched_rules).toEqual(['ok']);
    const cached = JSON.parse(cache.values.get('rules:tenant-a') ?? '[]') as Array<{ id: string }>;
    expect(cached.map((rule) => rule.id)).toEqual(['ok']);
  });

  it('reads the optional columns defensively', async () => {
    const result = await evaluate([
      row({
        roles_to_assign: '[1]',
        groups_to_join: 'nope',
        attributes_to_set: JSON.stringify([{ key: 'a' }, { value: 1 }, 'x']),
      }),
      row({ id: 'r2', attributes_to_set: JSON.stringify([{ key: 'k', value: null }]) }),
      row({
        id: 'r3',
        roles_to_assign: JSON.stringify(['a', 'b']),
        groups_to_join: null,
        attributes_to_set: null,
      }),
    ]);
    expect(result.roles_to_assign).toEqual(['reader', 'a', 'b']);
    expect(result.groups_to_join).toEqual(['org']);
    expect(result.attributes_to_set).toEqual([{ key: 'k', value: null }]);
  });

  it('records the reason of a deny and treats any other action as a deny', async () => {
    const reason = await evaluate([row({ action: 'deny', deny_reason: 'blocked' })]);
    expect(reason).toMatchObject({ denied: true, deny_reason: 'blocked', matched_rules: ['r1'] });
    const other = await evaluate([row({ action: 'something' })]);
    expect(other.denied).toBe(true);
    expect(other.deny_reason).toBeUndefined();
  });

  it('caches the parsed rules under the tenant key and reads them back from there', async () => {
    const cache = kv();
    const db = storage();
    db.adapter.query.mockResolvedValue([row()]);
    const { policy } = await ready({ REBAC_CACHE: cache }, db);
    const first = await policy.evaluateRules(context);
    expect(cache.put).toHaveBeenCalledWith('rules:tenant-a', expect.any(String), {
      expirationTtl: 300,
    });
    const second = await policy.evaluateRules(context);
    expect(second).toEqual(first);
    expect(second.matched_rules).toEqual(['r1']);
    expect(db.adapter.query).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenCalledWith('rules:tenant-a');
  });

  it('ignores a failing cache write when storing rules', async () => {
    const cache = kv();
    vi.mocked(cache.put).mockRejectedValue(new Error('kv down'));
    expect((await evaluate([row()], { REBAC_CACHE: cache })).matched_rules).toEqual(['r1']);
  });

  it('falls back to the database when the cached rules cannot be read', async () => {
    const cache = kv({ 'rules:tenant-a': '{oops' });
    const result = await evaluate([row()], { REBAC_CACHE: cache });
    expect(result.matched_rules).toEqual(['r1']);
  });

  it.each([
    ['starts_with', 5],
    ['ends_with', ['a']],
    ['matches', null],
    ['in', 'a,b'],
    ['in', 'a'],
  ])('treats a %s condition with the value %j as unreadable', async (operator, value) => {
    const conditions = JSON.stringify([{ field: 'provider_id', operator, value }]);
    // An allow rule with such a condition is dropped; a deny rule denies everyone (fail closed).
    expect((await evaluate([row({ conditions })])).matched_rules).toEqual([]);
    const denied = await evaluate([row({ action: 'deny', conditions })]);
    expect(denied.denied).toBe(true);
  });

  it('still reads conditions whose operator takes a value of its own type', async () => {
    const conditions = JSON.stringify([
      { field: 'provider_id', operator: 'starts_with', value: 'p' },
      { field: 'provider_id', operator: 'in', value: ['p', 'q'] },
      { field: 'idp_claims.s', operator: 'exists' },
    ]);
    expect((await evaluate([row({ conditions })])).matched_rules).toEqual(['r1']);
  });

  it.each([
    ['a rule list that is not an array', '{"id":"r1"}'],
    ['a rule of an unknown shape', JSON.stringify([{ id: 'r1', action: 'allow' }])],
    [
      'a rule with an unreadable condition',
      JSON.stringify([
        {
          id: 'old',
          tenant_id: 'tenant-a',
          priority: 1,
          conditions: [{ field: 'f', operator: 'in', value: 'not-an-array' }],
          action: 'deny',
          roles_to_assign: [],
          groups_to_join: [],
          attributes_to_set: [],
        },
      ]),
    ],
  ])('reloads from the database when the cache holds %s', async (_label, cached) => {
    const cache = kv({ 'rules:tenant-a': cached });
    const result = await evaluate([row()], { REBAC_CACHE: cache });
    expect(result.matched_rules).toEqual(['r1']);
    expect(result.denied).toBeFalsy();
  });

  it('queries only active rules of the tenant within their validity window', async () => {
    const db = storage();
    const { policy } = await ready({}, db);
    await policy.evaluateRules(context);
    const [sql, params] = db.adapter.query.mock.calls[0] ?? [];
    expect(sql).toContain('is_active = 1');
    expect(params?.[0]).toBe('tenant-a');
  });
});

describe('BuiltinPolicyInfra rule conditions', () => {
  const context = {
    tenant_id: 'tenant-a',
    email_domain_hash: 'abc',
    email_verified: false,
    idp_claims: { n: 0, s: '', z: null, list: ['x', 1], deep: { v: 1 } },
    provider_id: 'p',
    user_type: 'u',
  } as unknown as RuleEvaluationContext;

  async function matches(field: string, operator: string, value: unknown, ctx = context) {
    const db = storage();
    db.adapter.query.mockResolvedValue([
      {
        id: 'r',
        tenant_id: 'tenant-a',
        priority: 1,
        conditions: JSON.stringify([{ field, operator, value }]),
        action: 'allow',
        roles_to_assign: null,
        groups_to_join: null,
        attributes_to_set: null,
        deny_reason: null,
      },
    ]);
    const { policy } = await ready({}, db);
    return (await policy.evaluateRules(ctx)).matched_rules.length === 1;
  }

  it.each([
    ['tenant_id', 'eq', 'tenant-a', true],
    ['email_verified', 'eq', false, true],
    ['user_type', 'eq', 'u', true],
    ['provider_id', 'eq', 'p', true],
    ['idp_claims', 'exists', null, true],
    ['nope', 'exists', null, false],
    ['idp_claims.n', 'exists', null, true],
    ['idp_claims.s', 'exists', null, true],
    ['idp_claims.z', 'exists', null, false],
    ['idp_claims.n', 'eq', 0, true],
    ['idp_claims.deep.v', 'eq', 1, true],
    ['idp_claims.deep.w.x', 'exists', null, false],
    ['idp_claims.n.x', 'exists', null, false],
    ['idp_claims.z.x', 'exists', null, false],
    ['idp_claims.s.length', 'exists', null, false],
    ['idp_claims.list', 'contains', 1, true],
    ['idp_claims.list', 'contains', 'y', false],
    ['idp_claims.n', 'contains', 0, false],
    ['provider_id', 'contains', 5, false],
    ['email_verified', 'starts_with', 'f', false],
    ['provider_id', 'starts_with', 5, false],
    ['provider_id', 'ends_with', 5, false],
    ['email_verified', 'ends_with', 'e', false],
    ['provider_id', 'matches', 5, false],
    ['email_verified', 'matches', 'false', false],
    ['provider_id', 'in', 'p', false],
    ['provider_id', 'in', ['p'], true],
    ['provider_id', 'neq', 'p', false],
  ])('%s %s %j -> %s', async (field, operator, value, expected) => {
    expect(await matches(field, operator, value)).toBe(expected);
  });

  it('limits regex patterns to 1000 characters and inputs to 10000', async () => {
    const pattern = (length: number) => `^${'a'.repeat(length - 1)}`;
    const longInput = (length: number) => ({ ...context, email_domain_hash: 'a'.repeat(length) });
    expect(await matches('email_domain_hash', 'matches', pattern(1000), longInput(1000))).toBe(
      true
    );
    expect(await matches('email_domain_hash', 'matches', pattern(1001), longInput(1001))).toBe(
      false
    );
    expect(await matches('email_domain_hash', 'matches', '^a', longInput(10000))).toBe(true);
    expect(await matches('email_domain_hash', 'matches', '^a', longInput(10001))).toBe(false);
  });
});
