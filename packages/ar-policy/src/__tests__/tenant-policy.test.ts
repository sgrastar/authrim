import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  clearTenantPolicyRulesCache,
  createTenantRuleEvaluator,
  loadTenantPolicyRules,
  resolveTenantPolicy,
  toTenantPolicyRule,
} from '../tenant-policy';

const baseRow = {
  id: 'rule_1',
  name: 'Premium reports',
  description: null,
  priority: 100,
  effect: 'allow',
  resource_types: JSON.stringify(['reports']),
  actions: JSON.stringify(['read']),
  conditions: JSON.stringify([
    { type: 'attribute_equals', params: { name: 'tier', value: 'premium' } },
  ]),
};

const context = {
  subjectId: 'user_1',
  verifiedAttributes: [{ name: 'tier', value: 'premium', source: 'db' as const }],
  resourceType: 'reports',
  action: 'read',
  timestamp: Date.now(),
};

function db(rows: unknown[]): DatabaseAdapter {
  return { query: vi.fn(async () => rows) } as unknown as DatabaseAdapter;
}

describe('tenant custom rules', () => {
  beforeEach(() => clearTenantPolicyRulesCache());

  it('skips a stored rule it cannot use', () => {
    expect(toTenantPolicyRule({ ...baseRow, effect: 'maybe' })).toBeNull();
    expect(toTenantPolicyRule({ ...baseRow, conditions: '{' })).toBeNull();
    expect(toTenantPolicyRule({ ...baseRow, actions: JSON.stringify([1]) })).toBeNull();
    expect(toTenantPolicyRule({ ...baseRow, conditions: '{}' })).toBeNull();
    // Checks never see expired attributes: a deny counting them could not apply.
    expect(
      toTenantPolicyRule({
        ...baseRow,
        conditions: JSON.stringify([
          {
            type: 'attribute_equals',
            params: { name: 'blocked', value: 'true', checkExpiry: false },
          },
        ]),
      })
    ).toBeNull();
    // Not stored by the Admin API: an empty or missing condition list is not "no conditions".
    expect(toTenantPolicyRule({ ...baseRow, conditions: '' })).toBeNull();
    expect(toTenantPolicyRule({ ...baseRow, conditions: null })).toBeNull();
    expect(toTenantPolicyRule({ ...baseRow, actions: '' })).toBeNull();
    expect(toTenantPolicyRule({ ...baseRow, priority: 'invalid' })).toBeNull();
    expect(toTenantPolicyRule({ ...baseRow, priority: '200' })).toMatchObject({ priority: 200 });
    expect(toTenantPolicyRule({ ...baseRow, actions: null })).toMatchObject({ actions: [] });
    expect(
      toTenantPolicyRule({
        ...baseRow,
        conditions: JSON.stringify([{ type: 'no_such_condition', params: {} }]),
      })
    ).toBeNull();
    expect(
      toTenantPolicyRule({ ...baseRow, conditions: JSON.stringify([{ type: 'has_role' }]) })
    ).toBeNull();
    expect(toTenantPolicyRule(baseRow)).toMatchObject({ resourceTypes: ['reports'] });
  });

  it('grants only what a rule for the resource and action allows', () => {
    const evaluator = createTenantRuleEvaluator([toTenantPolicyRule(baseRow)!]);

    expect(evaluator.evaluate(context)).toMatchObject({ allowed: true, decidedBy: 'rule_1' });
    expect(evaluator.evaluate({ ...context, action: 'write' }).allowed).toBe(false);
    expect(evaluator.evaluate({ ...context, verifiedAttributes: [] }).allowed).toBe(false);
  });

  it('evaluates role conditions with the subject roles', () => {
    const evaluator = createTenantRuleEvaluator([
      toTenantPolicyRule({
        ...baseRow,
        conditions: JSON.stringify([{ type: 'has_role', params: { role: 'auditor' } }]),
      })!,
    ]);
    const role = (name: string) => ({ name, scope: 'global' as const });
    expect(evaluator.evaluate({ ...context, subjectRoles: [role('auditor')] }).allowed).toBe(true);
    expect(evaluator.evaluate({ ...context, subjectRoles: [role('viewer')] }).allowed).toBe(false);
  });

  it('does not match a role limited to another organization, or one that ended', () => {
    const evaluator = createTenantRuleEvaluator([
      toTenantPolicyRule({
        ...baseRow,
        conditions: JSON.stringify([
          { type: 'has_role', params: { role: 'auditor', scope: 'org', scopeTarget: 'org:b' } },
        ]),
      })!,
    ]);
    const auditor = (scopeTarget: string, expiresAt?: number) => ({
      name: 'auditor',
      scope: 'org' as const,
      scopeTarget,
      expiresAt,
    });
    const inOrgB = { ...context, resourceOrgId: 'b' };
    expect(evaluator.evaluate({ ...inOrgB, subjectRoles: [auditor('org:b')] }).allowed).toBe(true);
    expect(evaluator.evaluate({ ...inOrgB, subjectRoles: [auditor('org:a')] }).allowed).toBe(false);
    expect(
      evaluator.evaluate({ ...inOrgB, subjectRoles: [auditor('org:b', Date.now() - 1000)] }).allowed
    ).toBe(false);
  });

  it('counts a scoped role only for its own organization or resource', () => {
    // The rule names no target: the assignment must hold for the checked resource itself.
    const byOrg = createTenantRuleEvaluator([
      toTenantPolicyRule({
        ...baseRow,
        conditions: JSON.stringify([
          { type: 'has_role', params: { role: 'auditor', scope: 'org' } },
        ]),
      })!,
    ]);
    const orgA = [{ name: 'auditor', scope: 'org' as const, scopeTarget: 'org:a' }];
    expect(byOrg.evaluate({ ...context, resourceOrgId: 'a', subjectRoles: orgA }).allowed).toBe(
      true
    );
    expect(byOrg.evaluate({ ...context, resourceOrgId: 'b', subjectRoles: orgA }).allowed).toBe(
      false
    );
    expect(byOrg.evaluate({ ...context, subjectRoles: orgA }).allowed).toBe(false);

    const byResource = createTenantRuleEvaluator([
      toTenantPolicyRule({
        ...baseRow,
        conditions: JSON.stringify([
          { type: 'has_role', params: { role: 'auditor', scope: 'resource' } },
        ]),
      })!,
    ]);
    const onR1 = [
      { name: 'auditor', scope: 'resource' as const, scopeTarget: 'resource:reports:r1' },
    ];
    expect(byResource.evaluate({ ...context, resourceId: 'r1', subjectRoles: onR1 }).allowed).toBe(
      true
    );
    expect(byResource.evaluate({ ...context, resourceId: 'r2', subjectRoles: onR1 }).allowed).toBe(
      false
    );
  });

  it('grants nothing when a scoped-role deny meets a check without its target', () => {
    const evaluator = createTenantRuleEvaluator([
      toTenantPolicyRule({
        ...baseRow,
        id: 'deny_org_auditors',
        priority: 1000,
        effect: 'deny',
        conditions: JSON.stringify([
          { type: 'has_role', params: { role: 'auditor', scope: 'org' } },
        ]),
      })!,
      toTenantPolicyRule({ ...baseRow, conditions: '[]' })!,
    ]);
    expect(evaluator.evaluate(context).allowed).toBe(false);
    expect(evaluator.evaluate({ ...context, resourceOrgId: 'a' }).allowed).toBe(true);
  });

  it('grants nothing when a deny on the owner meets a check without one', () => {
    const evaluator = createTenantRuleEvaluator([
      toTenantPolicyRule({
        ...baseRow,
        id: 'rule_not_owner',
        priority: 1000,
        effect: 'deny',
        conditions: JSON.stringify([{ type: 'is_resource_owner', params: {} }]),
      })!,
      toTenantPolicyRule({ ...baseRow, conditions: '[]' })!,
    ]);

    expect(evaluator.evaluate(context).allowed).toBe(false);
    // With the owner given, the deny applies to the owner and the allow to anyone else.
    expect(evaluator.evaluate({ ...context, resourceOwnerId: 'user_1' }).allowed).toBe(false);
    expect(evaluator.evaluate({ ...context, resourceOwnerId: 'user_2' }).allowed).toBe(true);
  });

  it('caches the rules of a tenant', async () => {
    const database = db([baseRow]);
    await loadTenantPolicyRules(database, 'acme');
    await loadTenantPolicyRules(database, 'acme');
    expect(database.query).toHaveBeenCalledTimes(1);
  });
});

describe('resolveTenantPolicy', () => {
  beforeEach(() => clearTenantPolicyRulesCache());

  const settings = (flags: Record<string, boolean>) => ({
    SETTINGS: {
      get: async (key: string) =>
        key === 'settings:tenant:acme:feature-flags' ? JSON.stringify(flags) : null,
    } as unknown as KVNamespace,
  });

  it('keeps attribute-based policy off by default', async () => {
    await expect(resolveTenantPolicy(settings({}), db([baseRow]), 'acme')).resolves.toEqual({
      abac: false,
      verifiedAttributes: false,
      logDecisions: false,
    });
  });

  it("uses the tenant's rules when attribute-based policy and custom rules are on", async () => {
    const policy = await resolveTenantPolicy(
      settings({
        'feature.enable_abac': true,
        'feature.enable_verified_attributes': true,
        'feature.enable_policy_logging': true,
      }),
      db([baseRow]),
      'acme'
    );
    expect(policy).toMatchObject({ abac: true, verifiedAttributes: true, logDecisions: true });
    expect(policy.evaluator?.evaluate(context).allowed).toBe(true);

    const withoutRules = await resolveTenantPolicy(
      settings({ 'feature.enable_abac': true, 'feature.enable_custom_rules': false }),
      db([baseRow]),
      'acme'
    );
    expect(withoutRules.evaluator).toBeUndefined();
  });

  it('grants nothing from the rules while one of them cannot be evaluated', async () => {
    const brokenDeny = {
      ...baseRow,
      id: 'rule_block',
      priority: 1000,
      effect: 'deny',
      conditions: JSON.stringify({ type: 'attribute_equals' }),
    };
    const on = settings({
      'feature.enable_abac': true,
      'feature.enable_verified_attributes': true,
    });

    const policy = await resolveTenantPolicy(on, db([brokenDeny, baseRow]), 'acme');
    expect(policy).toMatchObject({ abac: false, unavailable: true });
    expect(policy.evaluator).toBeUndefined();

    // A deny whose condition misses a parameter, or needs what the Check API does not know.
    for (const conditions of [
      [{ type: 'numeric_gte', params: { name: 'age' } }],
      [{ type: 'user_type_is', params: { types: ['contractor'] } }],
    ]) {
      await expect(
        resolveTenantPolicy(
          on,
          db([{ ...brokenDeny, conditions: JSON.stringify(conditions) }, baseRow]),
          'acme'
        )
      ).resolves.toMatchObject({ abac: false, unavailable: true });
    }

    // A deny on a verified attribute while the settings keep attributes out of the checks.
    await expect(
      resolveTenantPolicy(
        settings({ 'feature.enable_abac': true }),
        db([
          {
            ...brokenDeny,
            conditions: JSON.stringify([
              { type: 'attribute_equals', params: { name: 'blocked', value: 'true' } },
            ]),
          },
          { ...baseRow, conditions: '[]' },
        ]),
        'acme'
      )
    ).resolves.toMatchObject({ abac: false, unavailable: true });

    // Not cached: once the rule is fixed, the rules apply again.
    const fixed = await resolveTenantPolicy(on, db([baseRow]), 'acme');
    expect(fixed.evaluator?.evaluate(context).allowed).toBe(true);
  });

  it('turns attribute-based policy off when the rules cannot be read', async () => {
    const failing = {
      query: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as unknown as DatabaseAdapter;
    await expect(
      resolveTenantPolicy(settings({ 'feature.enable_abac': true }), failing, 'acme')
    ).resolves.toMatchObject({ abac: false, verifiedAttributes: false, unavailable: true });

    const unreadableFlags = {
      SETTINGS: {
        get: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace,
    };
    await expect(
      resolveTenantPolicy(unreadableFlags, db([baseRow]), 'acme')
    ).resolves.toMatchObject({ abac: false, unavailable: true });
    // Readable settings are not marked.
    await expect(
      resolveTenantPolicy(settings({}), db([baseRow]), 'acme')
    ).resolves.not.toHaveProperty('unavailable');
  });
});
