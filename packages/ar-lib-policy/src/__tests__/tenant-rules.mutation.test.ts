import { describe, expect, it } from 'vitest';
import {
  evaluateTenantRules,
  tenantRulesUnusableReason,
  toTenantPolicyRule,
  type TenantPolicyRule,
  type TenantPolicyRuleRow,
} from '../tenant-rules';
import type { PolicyContext, PolicyCondition, SubjectRole } from '../types';
import { must } from './mutation-helpers';

const row: TenantPolicyRuleRow = {
  id: 'rule_1',
  name: 'Rule one',
  description: 'Rule one description',
  priority: 100,
  effect: 'allow',
  resource_types: JSON.stringify(['reports']),
  actions: JSON.stringify(['read']),
  conditions: JSON.stringify([{ type: 'has_role', params: { role: 'admin' } }]),
};

function parsed(overrides: Partial<TenantPolicyRuleRow>): TenantPolicyRule | null {
  return toTenantPolicyRule({ ...row, ...overrides });
}

function rule(overrides: Partial<TenantPolicyRule> = {}): TenantPolicyRule {
  return {
    id: 'allow_admin',
    name: 'Allow admin',
    priority: 10,
    effect: 'allow',
    conditions: [{ type: 'has_role', params: { role: 'admin' } }],
    resourceTypes: [],
    actions: [],
    ...overrides,
  };
}

function context(options: {
  roles?: SubjectRole[];
  type?: string;
  id?: string;
  groupIds?: string[];
  ownerId?: string;
  action?: string;
}): PolicyContext {
  return {
    subject: { id: 'user_1', roles: options.roles ?? [] },
    resource: {
      type: options.type ?? 'reports',
      id: options.id ?? 'r1',
      groupIds: options.groupIds,
      ownerId: options.ownerId,
    },
    action: { name: options.action ?? 'read' },
    timestamp: Date.UTC(2025, 0, 1),
  };
}

const admin: SubjectRole = { name: 'admin', scope: 'global' };

describe('toTenantPolicyRule', () => {
  it('reads a valid row as the rule the engine uses', () => {
    expect(toTenantPolicyRule(row)).toStrictEqual({
      id: 'rule_1',
      name: 'Rule one',
      description: 'Rule one description',
      priority: 100,
      effect: 'allow',
      conditions: [{ type: 'has_role', params: { role: 'admin' } }],
      resourceTypes: ['reports'],
      actions: ['read'],
    });
  });

  it('keeps a deny effect and drops a missing description', () => {
    const result = must(parsed({ effect: 'deny', description: null }));
    expect(result.effect).toBe('deny');
    expect(result.description).toBeUndefined();
  });

  it('refuses an effect that is neither allow nor deny', () => {
    expect(parsed({ effect: 'maybe' })).toBeNull();
    expect(parsed({ effect: '' })).toBeNull();
    expect(parsed({ effect: 'ALLOW' })).toBeNull();
  });

  it('reads a missing target list as any, and a stored array as it is', () => {
    expect(must(parsed({ resource_types: null, actions: null }))).toMatchObject({
      resourceTypes: [],
      actions: [],
    });
    const missing = { ...row } as Record<string, unknown>;
    delete missing.resource_types;
    delete missing.actions;
    expect(toTenantPolicyRule(missing as unknown as TenantPolicyRuleRow)).toMatchObject({
      resourceTypes: [],
      actions: [],
    });
    expect(must(parsed({ resource_types: '["a","b"]', actions: '[]' }))).toMatchObject({
      resourceTypes: ['a', 'b'],
      actions: [],
    });
  });

  it('refuses a target list that is not an array of strings', () => {
    for (const bad of ['', 'not json', '{"a":1}', '"reports"', '[1]', '["a",2]', 'null']) {
      expect(parsed({ resource_types: bad })).toBeNull();
      expect(parsed({ actions: bad })).toBeNull();
    }
  });

  it('refuses conditions that are not stored as a non-empty JSON text', () => {
    expect(parsed({ conditions: null })).toBeNull();
    expect(parsed({ conditions: '' })).toBeNull();
    expect(parsed({ conditions: 5 as unknown as string })).toBeNull();
    expect(parsed({ conditions: 'not json' })).toBeNull();
    expect(parsed({ conditions: '{}' })).toBeNull();
  });

  it('accepts an empty list of conditions', () => {
    expect(must(parsed({ conditions: '[]' })).conditions).toEqual([]);
  });

  it('refuses conditions the Check API cannot evaluate', () => {
    const country = JSON.stringify([{ type: 'country_in', params: { countries: ['JP'] } }]);
    expect(parsed({ conditions: country })).toBeNull();
    const unknown = JSON.stringify([{ type: 'nope', params: {} }]);
    expect(parsed({ conditions: unknown })).toBeNull();
    const missingParam = JSON.stringify([{ type: 'has_role', params: {} }]);
    expect(parsed({ conditions: missingParam })).toBeNull();
  });

  it('refuses checkExpiry false, which expired attributes could not honour', () => {
    const condition = (checkExpiry: boolean): string =>
      JSON.stringify([{ type: 'attribute_exists', params: { name: 'tier', checkExpiry } }]);
    expect(parsed({ conditions: condition(false) })).toBeNull();
    expect(must(parsed({ conditions: condition(true) })).conditions).toHaveLength(1);
  });

  it('reads an integer priority, from a number or from its text', () => {
    expect(must(parsed({ priority: 0 })).priority).toBe(0);
    expect(must(parsed({ priority: -7 })).priority).toBe(-7);
    expect(must(parsed({ priority: '42' })).priority).toBe(42);
    expect(must(parsed({ priority: '-5' })).priority).toBe(-5);
    expect(must(parsed({ priority: '0' })).priority).toBe(0);
    expect(must(parsed({ priority: Number.MAX_SAFE_INTEGER })).priority).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it('refuses a priority that is not a safe integer', () => {
    for (const bad of ['', 'abc', '1.5', '10x', 'x10', ' 10', '10 ', '+5', '1e3', '--5']) {
      expect(parsed({ priority: bad })).toBeNull();
    }
    expect(parsed({ priority: 1.5 })).toBeNull();
    expect(parsed({ priority: Number.NaN })).toBeNull();
    expect(parsed({ priority: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parsed({ priority: 2 ** 53 })).toBeNull();
    expect(parsed({ priority: '9007199254740993' })).toBeNull();
  });
});

describe('tenantRulesUnusableReason', () => {
  const attributeDeny = rule({
    effect: 'deny',
    conditions: [{ type: 'attribute_exists', params: { name: 'tier' } }],
  });
  const reason = 'A deny rule uses verified attributes, which the settings keep out of the checks';

  it('is null when there are no rules', () => {
    expect(tenantRulesUnusableReason([], { verifiedAttributes: false })).toBeNull();
  });

  it('explains a deny on attributes when the settings keep them out', () => {
    expect(tenantRulesUnusableReason([attributeDeny], { verifiedAttributes: false })).toBe(reason);
    expect(tenantRulesUnusableReason([rule(), attributeDeny], { verifiedAttributes: false })).toBe(
      reason
    );
  });

  it('is null when the settings give the attributes', () => {
    expect(tenantRulesUnusableReason([attributeDeny], { verifiedAttributes: true })).toBeNull();
  });

  it('ignores allow rules on attributes and denies that use none', () => {
    const attributeAllow = rule({ conditions: attributeDeny.conditions });
    const roleDeny = rule({ effect: 'deny' });
    expect(
      tenantRulesUnusableReason([attributeAllow, roleDeny], { verifiedAttributes: false })
    ).toBeNull();
  });

  it('looks at every condition of a deny rule', () => {
    const second = rule({
      effect: 'deny',
      conditions: [
        { type: 'has_role', params: { role: 'admin' } },
        { type: 'numeric_gt', params: { name: 'age', value: 1 } },
      ],
    });
    expect(tenantRulesUnusableReason([second], { verifiedAttributes: false })).toBe(reason);
  });
});

describe('evaluateTenantRules', () => {
  it('does not grant when no rule matches', () => {
    expect(evaluateTenantRules([], context({ roles: [admin] }))).toStrictEqual({
      allowed: false,
      reason: 'No matching rules found, using default decision: deny',
      decidedBy: 'default',
    });
    expect(evaluateTenantRules([rule()], context({}))).toMatchObject({
      allowed: false,
      decidedBy: 'default',
    });
  });

  it('grants through a matching allow rule and names it', () => {
    expect(evaluateTenantRules([rule()], context({ roles: [admin] }))).toMatchObject({
      allowed: true,
      reason: "Rule 'Allow admin' matched",
      decidedBy: 'allow_admin',
    });
    const described = rule({ description: 'Admins may do it' });
    expect(evaluateTenantRules([described], context({ roles: [admin] })).reason).toBe(
      'Admins may do it'
    );
  });

  it('applies a rule only to its resource types and actions', () => {
    const typed = rule({ resourceTypes: ['reports'] });
    const acted = rule({ actions: ['read'] });
    const both = rule({ resourceTypes: ['reports'], actions: ['read'] });
    const ctx = context({ roles: [admin] });
    for (const candidate of [typed, acted, both]) {
      expect(evaluateTenantRules([candidate], ctx).allowed).toBe(true);
    }
    const otherType = context({ roles: [admin], type: 'invoices' });
    const otherAction = context({ roles: [admin], action: 'delete' });
    expect(evaluateTenantRules([typed], otherType).allowed).toBe(false);
    expect(evaluateTenantRules([acted], otherAction).allowed).toBe(false);
    expect(evaluateTenantRules([both], otherType).allowed).toBe(false);
    expect(evaluateTenantRules([both], otherAction).allowed).toBe(false);
    expect(evaluateTenantRules([typed], otherAction).allowed).toBe(true);
    expect(evaluateTenantRules([acted], otherType).allowed).toBe(true);
    const listed = rule({ resourceTypes: ['invoices', 'reports'], actions: ['x', 'read'] });
    expect(evaluateTenantRules([listed], ctx).allowed).toBe(true);
  });

  it('lets a higher priority deny win over an allow', () => {
    const deny = rule({
      id: 'deny_admin',
      name: 'Deny admin',
      effect: 'deny',
      priority: 50,
    });
    const decision = evaluateTenantRules([rule(), deny], context({ roles: [admin] }));
    expect(decision).toMatchObject({ allowed: false, decidedBy: 'deny_admin' });
  });

  it('keeps the rest of the request: attributes and the evaluation time', () => {
    const attribute = rule({
      conditions: [{ type: 'attribute_equals', params: { name: 'tier', value: 'gold' } }],
    });
    const ctx = context({});
    const withAttribute: PolicyContext = {
      ...ctx,
      subject: {
        ...ctx.subject,
        verifiedAttributes: [{ name: 'tier', value: 'gold', source: 'manual' }],
      } as PolicyContext['subject'],
    };
    expect(evaluateTenantRules([attribute], withAttribute).allowed).toBe(true);
    const expired: PolicyContext = {
      ...withAttribute,
      subject: {
        ...ctx.subject,
        verifiedAttributes: [
          { name: 'tier', value: 'gold', source: 'manual', expiresAt: Date.UTC(2025, 0, 1) / 1000 },
        ],
      } as PolicyContext['subject'],
    };
    expect(evaluateTenantRules([attribute], expired).allowed).toBe(false);
  });

  it('copes with a subject that has no roles', () => {
    const base = context({});
    const subject = { id: 'user_1' } as unknown as PolicyContext['subject'];
    expect(evaluateTenantRules([rule()], { ...base, subject })).toMatchObject({
      allowed: false,
      decidedBy: 'default',
    });
  });
});

describe('evaluateTenantRules: role assignments that hold for the target', () => {
  const groupRule = rule({
    conditions: [{ type: 'has_role', params: { role: 'admin', scope: 'group' } }],
  });
  const resourceRule = rule({
    conditions: [{ type: 'has_role', params: { role: 'admin', scope: 'resource' } }],
  });
  const groupRole: SubjectRole = { name: 'admin', scope: 'group', scopeTarget: 'group:o1' };

  it('counts a group assignment only for a resource of that group', () => {
    expect(
      evaluateTenantRules([groupRule], context({ roles: [groupRole], groupIds: ['o1'] })).allowed
    ).toBe(true);
    expect(
      evaluateTenantRules([groupRule], context({ roles: [groupRole], groupIds: ['o2'] })).allowed
    ).toBe(false);
    expect(evaluateTenantRules([groupRule], context({ roles: [groupRole] })).allowed).toBe(false);
  });

  it('counts a resource assignment for the resource, typed or not', () => {
    const typed: SubjectRole = {
      name: 'admin',
      scope: 'resource',
      scopeTarget: 'resource:reports:r1',
    };
    const untyped: SubjectRole = { name: 'admin', scope: 'resource', scopeTarget: 'resource:r1' };
    const other: SubjectRole = { name: 'admin', scope: 'resource', scopeTarget: 'resource:r2' };
    const otherType: SubjectRole = {
      name: 'admin',
      scope: 'resource',
      scopeTarget: 'resource:invoices:r1',
    };
    expect(evaluateTenantRules([resourceRule], context({ roles: [typed] })).allowed).toBe(true);
    expect(evaluateTenantRules([resourceRule], context({ roles: [untyped] })).allowed).toBe(true);
    expect(evaluateTenantRules([resourceRule], context({ roles: [other] })).allowed).toBe(false);
    expect(evaluateTenantRules([resourceRule], context({ roles: [otherType] })).allowed).toBe(
      false
    );
  });

  it('always counts a global assignment', () => {
    expect(
      evaluateTenantRules([rule()], context({ roles: [admin], groupIds: ['o9'] })).allowed
    ).toBe(true);
  });
});

describe('evaluateTenantRules: a deny that needs a target the request does not give', () => {
  const ownerDeny = rule({
    id: 'deny_owner',
    effect: 'deny',
    conditions: [{ type: 'is_resource_owner', params: {} }],
  });

  function roleDeny(type: PolicyCondition['type'], scope: string | undefined): TenantPolicyRule {
    const params: Record<string, unknown> =
      type === 'has_role' ? { role: 'admin' } : { roles: ['admin'] };
    if (scope !== undefined) params.scope = scope;
    return rule({ id: 'deny_role', effect: 'deny', conditions: [{ type, params }] });
  }

  it('does not grant when a deny needs the resource owner and there is none', () => {
    expect(evaluateTenantRules([ownerDeny, rule()], context({ roles: [admin] }))).toStrictEqual({
      allowed: false,
      reason: 'A deny rule needs the resource owner, which the check did not give',
      decidedBy: 'deny_owner',
    });
  });

  it('evaluates the rules as usual when the owner is given', () => {
    const decision = evaluateTenantRules(
      [ownerDeny, rule()],
      context({ roles: [admin], ownerId: 'someone_else' })
    );
    expect(decision).toMatchObject({ allowed: true, decidedBy: 'allow_admin' });
  });

  it('does not stop an allow that needs the owner', () => {
    const ownerAllow = rule({ conditions: [{ type: 'is_resource_owner', params: {} }] });
    expect(evaluateTenantRules([ownerAllow], context({}))).toMatchObject({
      allowed: false,
      decidedBy: 'default',
    });
  });

  it('does not grant when a role deny needs the groups the resource lacks', () => {
    for (const type of ['has_role', 'has_any_role', 'has_all_roles'] as const) {
      expect(evaluateTenantRules([roleDeny(type, 'group')], context({}))).toStrictEqual({
        allowed: false,
        reason: "A deny rule needs the resource's groups, which the check did not give",
        decidedBy: 'deny_role',
      });
      expect(
        evaluateTenantRules([roleDeny(type, 'group')], context({ groupIds: ['o1'] })).reason
      ).toBe('No matching rules found, using default decision: deny');
    }
  });

  it('does not grant when a role deny needs a resource the request lacks', () => {
    for (const type of ['has_role', 'has_any_role', 'has_all_roles'] as const) {
      expect(evaluateTenantRules([roleDeny(type, 'resource')], context({ id: '' }))).toStrictEqual({
        allowed: false,
        reason: 'A deny rule needs the resource, which the check did not give',
        decidedBy: 'deny_role',
      });
      expect(evaluateTenantRules([roleDeny(type, 'resource')], context({})).reason).toBe(
        'No matching rules found, using default decision: deny'
      );
    }
  });

  it('is not stopped by a global or unscoped role deny', () => {
    for (const scope of ['global', undefined]) {
      const decision = evaluateTenantRules([roleDeny('has_role', scope)], context({ id: '' }));
      expect(decision.decidedBy).toBe('default');
    }
  });

  it('is not stopped by a condition type that has no role scope', () => {
    const attributeDeny = rule({
      effect: 'deny',
      conditions: [{ type: 'attribute_exists', params: { name: 'tier', scope: 'group' } }],
    });
    expect(evaluateTenantRules([attributeDeny], context({})).decidedBy).toBe('default');
  });

  it('checks every condition of the deny, not only the first', () => {
    const deny = rule({
      id: 'deny_second',
      effect: 'deny',
      conditions: [
        { type: 'has_role', params: { role: 'admin' } },
        { type: 'is_resource_owner', params: {} },
      ],
    });
    expect(evaluateTenantRules([deny], context({})).decidedBy).toBe('deny_second');
  });

  it('checks every applicable deny, and skips rules for another type or action', () => {
    const harmless = rule({ id: 'deny_harmless', effect: 'deny', priority: 1 });
    expect(evaluateTenantRules([harmless, ownerDeny], context({})).decidedBy).toBe('deny_owner');
    const elsewhere = rule({
      id: 'deny_elsewhere',
      effect: 'deny',
      conditions: ownerDeny.conditions,
      resourceTypes: ['invoices'],
    });
    const otherAction = rule({
      id: 'deny_other_action',
      effect: 'deny',
      conditions: ownerDeny.conditions,
      actions: ['delete'],
    });
    expect(evaluateTenantRules([elsewhere, otherAction], context({})).decidedBy).toBe('default');
  });
});
