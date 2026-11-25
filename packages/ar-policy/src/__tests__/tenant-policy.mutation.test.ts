import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  clearTenantPolicyRulesCache,
  createTenantRuleEvaluator,
  loadTenantPolicyRules,
  toTenantPolicyRule,
} from '../tenant-policy';

const row = {
  id: 'rule_1',
  name: 'Premium reports',
  description: null,
  priority: 100,
  effect: 'allow',
  resource_types: JSON.stringify(['reports']),
  actions: JSON.stringify(['read']),
  conditions: '[]',
};

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

function database(rows: unknown[] = [row]) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => rows);
  return { adapter: { query } as unknown as DatabaseAdapter, query };
}

describe('loadTenantPolicyRules', () => {
  beforeEach(() => {
    clearTenantPolicyRulesCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads only the enabled rules of the tenant, highest priority first', async () => {
    const { adapter, query } = database();
    await loadTenantPolicyRules(adapter, 'acme');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = must(query.mock.calls[0]);
    expect(sql).toContain('FROM policy_rules');
    expect(sql).toContain('tenant_id = ?');
    expect(sql).toContain('enabled = 1');
    expect(sql).toContain('ORDER BY priority DESC');
    expect(params).toEqual(['acme']);
  });

  it('names the stored rule that cannot be evaluated', async () => {
    const { adapter } = database([{ ...row, id: 'broken_rule', effect: 'maybe' }]);
    await expect(loadTenantPolicyRules(adapter, 'acme')).rejects.toThrow(
      'Policy rule broken_rule cannot be evaluated as stored'
    );
  });

  it('does not cache a failed load', async () => {
    const { adapter, query } = database([{ ...row, effect: 'maybe' }]);
    await expect(loadTenantPolicyRules(adapter, 'acme')).rejects.toThrow();
    await expect(loadTenantPolicyRules(adapter, 'acme')).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('serves the cache for just under a minute and reloads from exactly a minute', async () => {
    const { adapter, query } = database();
    await loadTenantPolicyRules(adapter, 'acme');

    vi.advanceTimersByTime(59_999);
    await loadTenantPolicyRules(adapter, 'acme');
    expect(query).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await loadTenantPolicyRules(adapter, 'acme');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('caches each tenant separately, with its own rules', async () => {
    const byTenant: Record<string, unknown[]> = {
      acme: [{ ...row, id: 'acme_rule' }],
      globex: [{ ...row, id: 'globex_rule' }],
    };
    const query = vi.fn(async (_sql: string, params?: unknown[]) => byTenant[String(params?.[0])]);
    const adapter = { query } as unknown as DatabaseAdapter;

    const acme = await loadTenantPolicyRules(adapter, 'acme');
    const globex = await loadTenantPolicyRules(adapter, 'globex');
    const acmeAgain = await loadTenantPolicyRules(adapter, 'acme');
    const globexAgain = await loadTenantPolicyRules(adapter, 'globex');

    expect(query).toHaveBeenCalledTimes(2);
    expect(acme.map((rule) => rule.id)).toEqual(['acme_rule']);
    expect(globex.map((rule) => rule.id)).toEqual(['globex_rule']);
    expect(acmeAgain).toBe(acme);
    expect(globexAgain).toBe(globex);
  });

  it('returns the changed rules once the cached ones expire', async () => {
    let stored = [{ ...row, id: 'rule_v1' }];
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => stored);
    const adapter = { query } as unknown as DatabaseAdapter;

    expect((await loadTenantPolicyRules(adapter, 'acme')).map((rule) => rule.id)).toEqual([
      'rule_v1',
    ]);
    stored = [{ ...row, id: 'rule_v2' }];
    vi.advanceTimersByTime(59_999);
    expect((await loadTenantPolicyRules(adapter, 'acme')).map((rule) => rule.id)).toEqual([
      'rule_v1',
    ]);
    vi.advanceTimersByTime(1);
    expect((await loadTenantPolicyRules(adapter, 'acme')).map((rule) => rule.id)).toEqual([
      'rule_v2',
    ]);
  });

  it('evicts the oldest tenant once 1000 tenants are cached', async () => {
    const { adapter, query } = database();
    for (let i = 0; i < 1000; i++) {
      await loadTenantPolicyRules(adapter, `tenant-${i}`);
    }
    expect(query).toHaveBeenCalledTimes(1000);

    // All 1000 are still cached: the limit is not reached early.
    await loadTenantPolicyRules(adapter, 'tenant-0');
    await loadTenantPolicyRules(adapter, 'tenant-999');
    expect(query).toHaveBeenCalledTimes(1000);

    // The 1001st tenant pushes out the oldest one only.
    await loadTenantPolicyRules(adapter, 'tenant-1000');
    expect(query).toHaveBeenCalledTimes(1001);
    await loadTenantPolicyRules(adapter, 'tenant-999');
    await loadTenantPolicyRules(adapter, 'tenant-1000');
    expect(query).toHaveBeenCalledTimes(1001);
    await loadTenantPolicyRules(adapter, 'tenant-0');
    expect(query).toHaveBeenCalledTimes(1002);
  });

  it('moves a reloaded tenant to the newest position, so the least recently loaded one goes', async () => {
    const { adapter, query } = database();
    await loadTenantPolicyRules(adapter, 'old-0');
    await loadTenantPolicyRules(adapter, 'old-1');
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 998; i++) {
      await loadTenantPolicyRules(adapter, `fresh-${i}`);
    }
    vi.advanceTimersByTime(30_000);
    expect(query).toHaveBeenCalledTimes(1000);

    // old-1 expired and is reloaded; the cache is full, but its own slot is reused.
    await loadTenantPolicyRules(adapter, 'old-1');
    expect(query).toHaveBeenCalledTimes(1001);

    // Two new tenants: the first displaces old-0, the second the least recently loaded fresh-0.
    await loadTenantPolicyRules(adapter, 'new-1');
    await loadTenantPolicyRules(adapter, 'new-2');
    expect(query).toHaveBeenCalledTimes(1003);

    await loadTenantPolicyRules(adapter, 'fresh-0');
    expect(query).toHaveBeenCalledTimes(1004);
  });
});

describe('createTenantRuleEvaluator', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const context = {
    subjectId: 'user_1',
    verifiedAttributes: [],
    resourceType: 'reports',
    action: 'read',
    timestamp: Date.parse('2025-01-01T00:00:00.000Z'),
  };

  it('treats a check without a resource id as one that gives no resource target', () => {
    const evaluator = createTenantRuleEvaluator([
      must(
        toTenantPolicyRule({
          ...row,
          id: 'deny_resource_auditors',
          priority: 1000,
          effect: 'deny',
          conditions: JSON.stringify([
            { type: 'has_role', params: { role: 'auditor', scope: 'resource' } },
          ]),
        })
      ),
      must(toTenantPolicyRule(row)),
    ]);

    const withoutId = evaluator.evaluate(context);
    expect(withoutId.allowed).toBe(false);
    expect(withoutId.decidedBy).toBe('deny_resource_auditors');

    expect(evaluator.evaluate({ ...context, resourceId: 'r1' }).allowed).toBe(true);
  });
});
