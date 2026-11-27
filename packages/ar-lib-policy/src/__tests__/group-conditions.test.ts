import type { PolicyEvaluationContext } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import {
  CHECK_API_CONDITION_TYPES,
  GROUP_CONDITION_TYPES,
  PolicyEngine,
  validatePolicyConditions,
} from '../engine';
import {
  createTenantRuleEvaluator,
  dynamicGroupConditionProblem,
  evaluateTenantRules,
  tenantRulesUnusableReason,
  toTenantPolicyContext,
  type TenantPolicyRule,
} from '../tenant-rules';
import type { PolicyCondition, PolicyContext } from '../types';

function context(subjectGroups?: string[], resourceGroups?: string[]): PolicyContext {
  return {
    subject: { id: 'user_1', roles: [], groupIds: subjectGroups },
    resource: { type: 'reports', id: 'r1', groupIds: resourceGroups },
    action: { name: 'read' },
    timestamp: Date.UTC(2025, 0, 1),
  };
}

/** Whether a single allow rule with the condition grants. */
function meets(
  condition: PolicyCondition,
  subjectGroups?: string[],
  resourceGroups?: string[]
): boolean {
  const engine = new PolicyEngine({ defaultDecision: 'deny' });
  engine.addRule({ id: 'r', name: 'r', priority: 1, effect: 'allow', conditions: [condition] });
  return engine.evaluate(context(subjectGroups, resourceGroups)).allowed;
}

function rule(overrides: Partial<TenantPolicyRule> = {}): TenantPolicyRule {
  return {
    id: 'allow_all',
    name: 'Allow all',
    priority: 10,
    effect: 'allow',
    conditions: [],
    resourceTypes: [],
    actions: [],
    ...overrides,
  };
}

describe('group conditions', () => {
  it('in_group: the subject is in the group', () => {
    const condition: PolicyCondition = { type: 'in_group', params: { group_id: 'g1' } };
    expect(meets(condition, ['g0', 'g1'])).toBe(true);
    expect(meets(condition, ['g2'])).toBe(false);
    expect(meets(condition, [])).toBe(false);
    expect(meets(condition, undefined)).toBe(false);
  });

  it('in_any_group: the subject is in at least one of the groups', () => {
    const condition: PolicyCondition = {
      type: 'in_any_group',
      params: { group_ids: ['g1', 'g2'] },
    };
    expect(meets(condition, ['g2'])).toBe(true);
    expect(meets(condition, ['g3'])).toBe(false);
    expect(meets(condition, undefined)).toBe(false);
  });

  it('in_all_groups: the subject is in every one of the groups', () => {
    const condition: PolicyCondition = {
      type: 'in_all_groups',
      params: { group_ids: ['g1', 'g2'] },
    };
    expect(meets(condition, ['g1', 'g2', 'g3'])).toBe(true);
    expect(meets(condition, ['g1'])).toBe(false);
    expect(meets(condition, undefined)).toBe(false);
  });

  it('not_in_any_group: the subject is in none of the groups, and unknown is not none', () => {
    const condition: PolicyCondition = {
      type: 'not_in_any_group',
      params: { group_ids: ['g1', 'g2'] },
    };
    expect(meets(condition, ['g3'])).toBe(true);
    expect(meets(condition, [])).toBe(true);
    expect(meets(condition, ['g2'])).toBe(false);
    // Unknown memberships must not pass a negative condition.
    expect(meets(condition, undefined)).toBe(false);
  });

  it('same_group: the subject shares a group with the resource', () => {
    const condition: PolicyCondition = { type: 'same_group', params: {} };
    expect(meets(condition, ['g1', 'g2'], ['g2'])).toBe(true);
    expect(meets(condition, ['g1'], ['g2'])).toBe(false);
    expect(meets(condition, ['g1'], [])).toBe(false);
    expect(meets(condition, ['g1'], undefined)).toBe(false);
    expect(meets(condition, undefined, ['g1'])).toBe(false);
  });

  it('are all group conditions the Check API can evaluate', () => {
    expect([...GROUP_CONDITION_TYPES].sort()).toEqual(
      ['in_all_groups', 'in_any_group', 'in_group', 'not_in_any_group', 'same_group'].sort()
    );
    for (const type of GROUP_CONDITION_TYPES) {
      expect(CHECK_API_CONDITION_TYPES.has(type), type).toBe(true);
    }
  });
});

describe('group condition parameters', () => {
  const valid = (conditions: unknown) =>
    validatePolicyConditions(conditions, CHECK_API_CONDITION_TYPES);

  it('accepts the documented parameters', () => {
    expect(valid([{ type: 'in_group', params: { group_id: 'g1' } }])).toBeNull();
    for (const type of ['in_any_group', 'in_all_groups', 'not_in_any_group']) {
      expect(valid([{ type, params: { group_ids: ['g1', 'g2'] } }]), type).toBeNull();
    }
    expect(valid([{ type: 'same_group', params: {} }])).toBeNull();
  });

  it('refuses missing, mistyped or unknown parameters', () => {
    expect(valid([{ type: 'in_group', params: {} }])).toMatch(/group_id/);
    expect(valid([{ type: 'in_group', params: { group_id: '' } }])).toMatch(/group_id/);
    expect(valid([{ type: 'in_group', params: { group_ids: ['g1'] } }])).toMatch(/group_ids/);
    for (const type of ['in_any_group', 'in_all_groups', 'not_in_any_group']) {
      expect(valid([{ type, params: { group_ids: [] } }]), type).toMatch(/group_ids/);
      expect(valid([{ type, params: { group_ids: 'g1' } }]), type).toMatch(/group_ids/);
      expect(valid([{ type, params: { group_ids: ['g1', 2] } }]), type).toMatch(/group_ids/);
    }
    expect(valid([{ type: 'same_group', params: { group_id: 'g1' } }])).toMatch(/group_id/);
  });
});

describe('tenant rules with group conditions', () => {
  const denyMembers = rule({
    id: 'deny_contractors',
    priority: 100,
    effect: 'deny',
    conditions: [{ type: 'in_group', params: { group_id: 'contractors' } }],
  });

  const noServiceGroups = { affected: new Set<string>(), any: false };

  it('report that they need the subject groups when those are unknown', () => {
    expect(
      tenantRulesUnusableReason([denyMembers], {
        verifiedAttributes: true,
        serviceGroupDecided: noServiceGroups,
      })
    ).toBeNull();
    // Without what service groups decide, rules with group conditions are not used.
    expect(tenantRulesUnusableReason([denyMembers], { verifiedAttributes: true })).toMatch(
      /service groups/
    );
    expect(
      tenantRulesUnusableReason([denyMembers], {
        verifiedAttributes: true,
        subjectGroupsUnknown: true,
      })
    ).toMatch(/group conditions/);
    // Rules that read no group are usable without them.
    expect(
      tenantRulesUnusableReason([rule()], { verifiedAttributes: true, subjectGroupsUnknown: true })
    ).toBeNull();
  });

  it('grant nothing when a deny needs the subject groups and they are unknown', () => {
    const rules = [denyMembers, rule()];
    expect(evaluateTenantRules(rules, context(['staff'])).allowed).toBe(true);
    expect(evaluateTenantRules(rules, context(['contractors'])).allowed).toBe(false);
    const unknown = evaluateTenantRules(rules, context(undefined));
    expect(unknown).toMatchObject({ allowed: false, decidedBy: 'deny_contractors' });
    expect(unknown.reason).toContain("the subject's groups");
  });

  it('grant nothing when a same_group deny meets a resource without groups', () => {
    const rules = [
      rule({
        id: 'deny_same',
        priority: 100,
        effect: 'deny',
        conditions: [{ type: 'same_group', params: {} }],
      }),
      rule(),
    ];
    expect(evaluateTenantRules(rules, context(['g1'], ['g2'])).allowed).toBe(true);
    expect(evaluateTenantRules(rules, context(['g1'], ['g1'])).allowed).toBe(false);
    const withoutGroups = evaluateTenantRules(rules, context(['g1'], undefined));
    expect(withoutGroups.allowed).toBe(false);
    expect(withoutGroups.reason).toContain("the resource's groups");
  });
});

describe('createTenantRuleEvaluator', () => {
  const checkContext: PolicyEvaluationContext = {
    subjectId: 'user_1',
    subjectRoles: [{ name: 'viewer', scope: 'global' }],
    verifiedAttributes: [{ name: 'tier', value: 'gold', source: 'db' }],
    resourceType: 'reports',
    resourceId: 'r1',
    resourceOwnerId: 'user_2',
    resourceGroupIds: ['g9'],
    action: 'read',
    timestamp: Date.UTC(2025, 0, 1),
  };

  it('passes the subject groups through, leaving unknown as unknown', () => {
    expect(
      toTenantPolicyContext({ ...checkContext, subjectGroupIds: ['g1'] }).subject.groupIds
    ).toEqual(['g1']);
    expect(toTenantPolicyContext(checkContext).subject.groupIds).toBeUndefined();
    expect(toTenantPolicyContext(checkContext)).toMatchObject({
      subject: {
        id: 'user_1',
        roles: [{ name: 'viewer', scope: 'global' }],
        verifiedAttributes: [{ name: 'tier', value: 'gold', source: 'db' }],
      },
      resource: { type: 'reports', id: 'r1', ownerId: 'user_2', groupIds: ['g9'] },
      action: { name: 'read' },
      timestamp: checkContext.timestamp,
    });
  });

  it('says whether the rules read the subject groups, and evaluates with them', () => {
    const allowMembers = rule({
      id: 'allow_members',
      conditions: [{ type: 'in_any_group', params: { group_ids: ['g1'] } }],
    });
    const evaluator = createTenantRuleEvaluator([allowMembers]);
    expect(evaluator.usesSubjectGroups).toBe(true);
    expect(createTenantRuleEvaluator([rule()]).usesSubjectGroups).toBe(false);
    expect(evaluator.evaluate({ ...checkContext, subjectGroupIds: ['g1'] })).toMatchObject({
      allowed: true,
      decidedBy: 'allow_members',
    });
    expect(evaluator.evaluate({ ...checkContext, subjectGroupIds: ['g2'] }).allowed).toBe(false);
    expect(evaluator.evaluate(checkContext).allowed).toBe(false);
  });

  it('grants nothing on unknown groups, even through a later rule that reads none', () => {
    const evaluator = createTenantRuleEvaluator([
      rule({
        id: 'allow_members',
        priority: 100,
        conditions: [{ type: 'in_group', params: { group_id: 'g1' } }],
      }),
      rule({ id: 'allow_everyone', priority: 1 }),
    ]);
    const unknown = evaluator.evaluate(checkContext);
    expect(unknown.allowed).toBe(false);
    expect(unknown.reason).toContain('group conditions');
    // Known (even empty) groups: the unconditional rule grants as usual.
    expect(evaluator.evaluate({ ...checkContext, subjectGroupIds: [] })).toMatchObject({
      allowed: true,
      decidedBy: 'allow_everyone',
    });
  });
});

describe('rules on groups that service groups decide', () => {
  const decided = { affected: new Set(['dyn', 'dyn_parent']), any: true };
  const ruleWith = (effect: 'allow' | 'deny', conditions: PolicyCondition[]) =>
    rule({ id: `${effect}_rule`, effect, conditions });

  it('refuses relying on their non-membership; allows positive allow conditions', () => {
    const negative = ruleWith('allow', [
      { type: 'not_in_any_group', params: { group_ids: ['static', 'dyn_parent'] } },
    ]);
    expect(dynamicGroupConditionProblem(negative, decided)).toMatch(/dyn_parent/);
    const denyMembers = ruleWith('deny', [{ type: 'in_group', params: { group_id: 'dyn' } }]);
    expect(dynamicGroupConditionProblem(denyMembers, decided)).toMatch(/deny/);
    const denySame = ruleWith('deny', [{ type: 'same_group', params: {} }]);
    expect(dynamicGroupConditionProblem(denySame, decided)).toMatch(/same_group/);
    expect(
      dynamicGroupConditionProblem(denySame, { affected: new Set<string>(), any: false })
    ).toBeNull();
    // A wrong "not a member" merely loses access here.
    const allowMembers = ruleWith('allow', [
      { type: 'in_any_group', params: { group_ids: ['dyn', 'static'] } },
    ]);
    expect(dynamicGroupConditionProblem(allowMembers, decided)).toBeNull();
    expect(
      dynamicGroupConditionProblem(
        ruleWith('deny', [{ type: 'in_group', params: { group_id: 'static' } }]),
        decided
      )
    ).toBeNull();
  });

  it('refuses a deny on a role granted through a service group (or a group above one)', () => {
    const withRoles = { ...decided, roles: new Set(['member']) };
    const denyRole = ruleWith('deny', [
      { type: 'has_any_role', params: { roles: ['x', 'member'] } },
    ]);
    expect(dynamicGroupConditionProblem(denyRole, withRoles)).toMatch(/member/);
    expect(
      dynamicGroupConditionProblem(
        ruleWith('deny', [{ type: 'has_role', params: { role: 'other' } }]),
        withRoles
      )
    ).toBeNull();
    // An allow on the role merely loses access on a stale "not a member".
    expect(
      dynamicGroupConditionProblem(
        ruleWith('allow', [{ type: 'has_role', params: { role: 'member' } }]),
        withRoles
      )
    ).toBeNull();
    expect(
      tenantRulesUnusableReason([denyRole, rule()], {
        verifiedAttributes: true,
        serviceGroupDecided: withRoles,
      })
    ).toMatch(/deny_rule/);
  });

  it('makes stored rules that rely on it unusable (no grant from the rules)', () => {
    const stored = [
      ruleWith('allow', [{ type: 'not_in_any_group', params: { group_ids: ['dyn'] } }]),
    ];
    expect(
      tenantRulesUnusableReason(stored, { verifiedAttributes: true, serviceGroupDecided: decided })
    ).toMatch(/allow_rule/);
  });
});

describe('group conditions with some memberships unknown', () => {
  /** Whether a single allow rule with the condition grants, with `unknown` groups. */
  const meetsWith = (
    condition: PolicyCondition,
    groups: string[],
    unknown: string[],
    resourceGroups?: string[]
  ) => {
    const engine = new PolicyEngine({ defaultDecision: 'deny' });
    engine.addRule({ id: 'r', name: 'r', priority: 1, effect: 'allow', conditions: [condition] });
    const base = context(groups, resourceGroups);
    return engine.evaluate({ ...base, subject: { ...base.subject, unknownGroupIds: unknown } })
      .allowed;
  };

  it('meets no condition that names an unknown group the subject is not known to be in', () => {
    expect(meetsWith({ type: 'in_group', params: { group_id: 'A' } }, [], ['A'])).toBe(false);
    expect(meetsWith({ type: 'in_group', params: { group_id: 'A' } }, ['A'], ['A'])).toBe(true);
    expect(
      meetsWith({ type: 'in_any_group', params: { group_ids: ['A', 'B'] } }, ['B'], ['A'])
    ).toBe(false);
    expect(
      meetsWith({ type: 'in_all_groups', params: { group_ids: ['A', 'B'] } }, ['B'], ['A'])
    ).toBe(false);
    // A group that is not unknown is decided as usual.
    expect(meetsWith({ type: 'in_group', params: { group_id: 'B' } }, ['B'], ['A'])).toBe(true);
  });

  it('meets no not_in_any_group naming an unknown group (an older non-member may be one now)', () => {
    const outside = { type: 'not_in_any_group', params: { group_ids: ['A'] } } as const;
    expect(meetsWith(outside, [], [])).toBe(true);
    expect(meetsWith(outside, [], ['A'])).toBe(false);
    expect(meetsWith({ type: 'not_in_any_group', params: { group_ids: ['B'] } }, [], ['A'])).toBe(
      true
    );
  });

  it('meets no same_group while one of the resource groups is unknown', () => {
    const same = { type: 'same_group', params: {} } as const;
    expect(meetsWith(same, ['B'], ['A'], ['A', 'B'])).toBe(false);
    expect(meetsWith(same, ['B'], ['C'], ['A', 'B'])).toBe(true);
  });

  it('stops the rules for the request only when one of them names an unknown group', () => {
    const rules = [
      rule({
        id: 'deny_outsiders',
        priority: 100,
        effect: 'deny',
        conditions: [{ type: 'not_in_any_group', params: { group_ids: ['A'] } }],
      }),
      rule(),
    ];
    const withUnknown = (unknown: string[]) => {
      const base = context(['B']);
      return evaluateTenantRules(rules, {
        ...base,
        subject: { ...base.subject, unknownGroupIds: unknown },
      });
    };
    const stopped = withUnknown(['A']);
    expect(stopped).toMatchObject({ allowed: false, decidedBy: 'deny_outsiders' });
    expect(stopped.reason).toContain('unknown');
    // Another group unknown: the rules decide as usual (the subject is outside A: denied).
    expect(withUnknown(['C'])).toMatchObject({ allowed: false, decidedBy: 'deny_outsiders' });
    expect(withUnknown(['C']).reason).not.toContain('unknown');

    const evaluator = createTenantRuleEvaluator(rules);
    expect(
      evaluator.evaluate({
        ...checkContextFor(['A']),
        subjectGroupIds: ['A'],
        subjectUnknownGroupIds: ['C'],
      })
    ).toMatchObject({ allowed: true });
    expect(
      evaluator.evaluate({
        ...checkContextFor([]),
        subjectGroupIds: [],
        subjectUnknownGroupIds: ['A'],
      }).allowed
    ).toBe(false);
  });
});

function checkContextFor(groups: string[]): PolicyEvaluationContext {
  return {
    subjectId: 'user_1',
    subjectGroupIds: groups,
    verifiedAttributes: [],
    resourceType: 'reports',
    resourceId: 'r1',
    action: 'read',
    timestamp: Date.UTC(2025, 0, 1),
  };
}
