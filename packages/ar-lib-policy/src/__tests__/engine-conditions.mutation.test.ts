import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolicyEngine } from '../engine';
import type {
  PolicyCondition,
  PolicyContext,
  PolicyEnvironment,
  PolicyRule,
  SubjectRole,
  VerifiedAttribute,
} from '../types';

afterEach(() => {
  vi.useRealTimers();
});

const T0 = Date.UTC(2025, 0, 1, 20, 0, 0); // Wednesday 20:00 UTC, Thursday 05:00 in Tokyo

interface Options {
  timestamp?: number;
  roles?: SubjectRole[];
  attributes?: VerifiedAttribute[] | undefined;
  environment?: PolicyEnvironment;
  userType?: string;
  plan?: string;
  orgId?: string;
  resourceOrgId?: string;
  ownerId?: string;
  relationships?: Array<{ relatedSubjectId: string; relationshipType: string; expiresAt?: number }>;
}

function context(options: Options = {}): PolicyContext {
  return {
    subject: {
      id: 'user-1',
      roles: options.roles ?? [],
      orgId: options.orgId,
      userType: options.userType,
      plan: options.plan,
      relationships: options.relationships,
      verifiedAttributes: options.attributes,
    } as unknown as PolicyContext['subject'],
    resource: { type: 'doc', id: 'doc-1', ownerId: options.ownerId, orgId: options.resourceOrgId },
    action: { name: 'read' },
    timestamp: options.timestamp ?? T0,
    environment: options.environment,
  };
}

function holds(type: string, params: Record<string, unknown>, options: Options = {}): boolean {
  const engine = new PolicyEngine({ defaultDecision: 'deny' });
  engine.addRule({
    id: 'r',
    name: 'r',
    priority: 1,
    effect: 'allow',
    conditions: [{ type, params } as unknown as PolicyCondition],
  });
  return engine.evaluate(context(options)).allowed;
}

function attr(name: string, value: string | null, expiresAt?: number): VerifiedAttribute {
  return { name, value, source: 'manual', expiresAt };
}

describe('evaluate', () => {
  it('never meets a condition of an unknown type', () => {
    const rule: PolicyRule = {
      id: 'deny_unknown',
      name: 'n',
      priority: 1,
      effect: 'deny',
      conditions: [{ type: 'nope', params: {} } as unknown as PolicyCondition],
    };
    const engine = new PolicyEngine({ defaultDecision: 'allow' });
    engine.addRule(rule);
    expect(engine.evaluate(context())).toMatchObject({ allowed: true, decidedBy: 'default' });
  });

  it('reports the rule name, effect and priority only when verbose', () => {
    const rule: PolicyRule = {
      id: 'rule_1',
      name: 'Rule one',
      priority: 7,
      effect: 'deny',
      conditions: [],
    };
    const quiet = new PolicyEngine();
    quiet.addRule(rule);
    expect(quiet.evaluate(context())).toStrictEqual({
      allowed: false,
      reason: "Rule 'Rule one' matched",
      decidedBy: 'rule_1',
      details: undefined,
    });
    const verbose = new PolicyEngine({ verbose: true });
    verbose.addRule(rule);
    expect(verbose.evaluate(context()).details).toStrictEqual({
      ruleName: 'Rule one',
      effect: 'deny',
      priority: 7,
    });
  });

  it('can clear its rules', () => {
    const engine = new PolicyEngine({ defaultDecision: 'allow' });
    engine.addRule({ id: 'd', name: 'd', priority: 1, effect: 'deny', conditions: [] });
    expect(engine.evaluate(context()).allowed).toBe(false);
    engine.clearRules();
    expect(engine.evaluate(context())).toMatchObject({ allowed: true, decidedBy: 'default' });
  });
});

describe('role conditions', () => {
  const org: SubjectRole = { name: 'admin', scope: 'org', scopeTarget: 'org:o1' };
  const resource: SubjectRole = { name: 'admin', scope: 'resource', scopeTarget: 'resource:d1' };

  it('treats a global role as holding everywhere', () => {
    const roles: SubjectRole[] = [{ name: 'admin', scope: 'global' }];
    expect(holds('has_role', { role: 'admin' }, { roles })).toBe(true);
    expect(
      holds('has_role', { role: 'admin', scope: 'org', scopeTarget: 'org:x' }, { roles })
    ).toBe(true);
    expect(holds('has_role', { role: 'other' }, { roles })).toBe(false);
  });

  it('matches a scoped role on its scope, and on its target when one is asked for', () => {
    const roles = [org];
    expect(holds('has_role', { role: 'admin', scope: 'org' }, { roles })).toBe(true);
    expect(
      holds('has_role', { role: 'admin', scope: 'org', scopeTarget: 'org:o1' }, { roles })
    ).toBe(true);
    expect(
      holds('has_role', { role: 'admin', scope: 'org', scopeTarget: 'org:o2' }, { roles })
    ).toBe(false);
    expect(holds('has_role', { role: 'admin', scope: 'resource' }, { roles })).toBe(false);
    expect(holds('has_role', { role: 'admin' }, { roles })).toBe(false);
    expect(holds('has_role', { role: 'admin', scope: 'org' }, { roles: [resource] })).toBe(false);
    const untargeted: SubjectRole[] = [{ name: 'admin', scope: 'org' }];
    expect(
      holds(
        'has_role',
        { role: 'admin', scope: 'org', scopeTarget: 'org:o1' },
        { roles: untargeted }
      )
    ).toBe(false);
  });

  it('applies the same scope rules to any-of and all-of', () => {
    const roles: SubjectRole[] = [org, { name: 'viewer', scope: 'org', scopeTarget: 'org:o1' }];
    for (const type of ['has_any_role', 'has_all_roles']) {
      expect(holds(type, { roles: ['admin', 'viewer'], scope: 'org' }, { roles })).toBe(true);
      expect(
        holds(type, { roles: ['admin', 'viewer'], scope: 'org', scopeTarget: 'org:o1' }, { roles })
      ).toBe(true);
      expect(
        holds(type, { roles: ['admin', 'viewer'], scope: 'org', scopeTarget: 'org:o2' }, { roles })
      ).toBe(false);
      expect(holds(type, { roles: ['admin', 'viewer'] }, { roles })).toBe(false);
      expect(holds(type, { roles: ['admin', 'viewer'], scope: 'global' }, { roles })).toBe(false);
    }
    expect(holds('has_any_role', { roles: ['admin', 'ghost'], scope: 'org' }, { roles })).toBe(
      true
    );
    expect(holds('has_all_roles', { roles: ['admin', 'ghost'], scope: 'org' }, { roles })).toBe(
      false
    );
    expect(holds('has_any_role', { roles: ['ghost'], scope: 'org' }, { roles })).toBe(false);
  });

  it('ends a role at its expiry, exactly', () => {
    const until = (expiresAt: number): SubjectRole[] => [
      { name: 'admin', scope: 'global', expiresAt },
    ];
    expect(holds('has_role', { role: 'admin' }, { roles: until(T0 + 1) })).toBe(true);
    expect(holds('has_role', { role: 'admin' }, { roles: until(T0) })).toBe(false);
    expect(holds('has_role', { role: 'admin' }, { roles: until(T0 - 1) })).toBe(false);
  });
});

describe('ownership, organization, relationship, user type and plan', () => {
  it('is_resource_owner compares the subject with the owner', () => {
    expect(holds('is_resource_owner', {}, { ownerId: 'user-1' })).toBe(true);
    expect(holds('is_resource_owner', {}, { ownerId: 'user-2' })).toBe(false);
    expect(holds('is_resource_owner', {}, {})).toBe(false);
  });

  it('same_organization needs both organizations and that they are equal', () => {
    expect(holds('same_organization', {}, { orgId: 'o1', resourceOrgId: 'o1' })).toBe(true);
    expect(holds('same_organization', {}, { orgId: 'o1', resourceOrgId: 'o2' })).toBe(false);
    expect(holds('same_organization', {}, { orgId: 'o1' })).toBe(false);
    expect(holds('same_organization', {}, { resourceOrgId: 'o1' })).toBe(false);
    expect(holds('same_organization', {}, {})).toBe(false);
  });

  it('has_relationship needs a live relationship of a listed type with the owner', () => {
    const types = { types: ['parent_of', 'guardian_of'] };
    const rel = (over: Record<string, unknown> = {}) => ({
      relatedSubjectId: 'owner-1',
      relationshipType: 'parent_of',
      ...over,
    });
    const base = { ownerId: 'owner-1' };
    expect(holds('has_relationship', types, { ...base, relationships: [rel()] })).toBe(true);
    expect(
      holds('has_relationship', types, {
        ...base,
        relationships: [rel({ relationshipType: 'guardian_of' })],
      })
    ).toBe(true);
    expect(
      holds('has_relationship', types, {
        ...base,
        relationships: [rel({ relationshipType: 'manager_of' })],
      })
    ).toBe(false);
    expect(
      holds('has_relationship', types, {
        ...base,
        relationships: [rel({ relatedSubjectId: 'other' })],
      })
    ).toBe(false);
    expect(holds('has_relationship', types, { ...base, relationships: [] })).toBe(false);
    expect(holds('has_relationship', types, { relationships: [rel()] })).toBe(false);
    expect(holds('has_relationship', types, base)).toBe(false);
  });

  it('has_relationship accepts any one matching relationship and judges expiry at the request time', () => {
    const types = { types: ['parent_of'] };
    const rel = (over: Record<string, unknown>) => ({
      relatedSubjectId: 'owner-1',
      relationshipType: 'parent_of',
      ...over,
    });
    const base = { ownerId: 'owner-1' };
    expect(
      holds('has_relationship', types, {
        ...base,
        relationships: [rel({ relatedSubjectId: 'x' }), rel({})],
      })
    ).toBe(true);
    expect(
      holds('has_relationship', types, { ...base, relationships: [rel({ expiresAt: T0 + 1 })] })
    ).toBe(true);
    expect(
      holds('has_relationship', types, { ...base, relationships: [rel({ expiresAt: T0 })] })
    ).toBe(false);
    expect(
      holds('has_relationship', types, { ...base, relationships: [rel({ expiresAt: T0 - 1 })] })
    ).toBe(false);
  });

  it('user_type_is and plan_allows need a known value in the list', () => {
    expect(holds('user_type_is', { types: ['end_user', 'admin'] }, { userType: 'end_user' })).toBe(
      true
    );
    expect(holds('user_type_is', { types: ['admin'] }, { userType: 'end_user' })).toBe(false);
    expect(holds('user_type_is', { types: ['admin'] }, {})).toBe(false);
    expect(holds('plan_allows', { plans: ['pro', 'free'] }, { plan: 'pro' })).toBe(true);
    expect(holds('plan_allows', { plans: ['pro'] }, { plan: 'free' })).toBe(false);
    expect(holds('plan_allows', { plans: ['pro'] }, {})).toBe(false);
  });
});

describe('attribute conditions', () => {
  const nowSeconds = T0 / 1000;

  it('need verified attributes to be given', () => {
    expect(
      holds('attribute_equals', { name: 'tier', value: 'gold' }, { attributes: undefined })
    ).toBe(false);
    expect(holds('attribute_exists', { name: 'tier' }, { attributes: undefined })).toBe(false);
    expect(
      holds('attribute_in', { name: 'tier', values: ['gold'] }, { attributes: undefined })
    ).toBe(false);
    expect(holds('numeric_gte', { name: 'age', value: -1 }, { attributes: undefined })).toBe(false);
  });

  it('attribute_equals matches the name and the value', () => {
    const attributes = [attr('tier', 'silver'), attr('tier', 'gold')];
    expect(holds('attribute_equals', { name: 'tier', value: 'gold' }, { attributes })).toBe(true);
    expect(holds('attribute_equals', { name: 'tier', value: 'bronze' }, { attributes })).toBe(
      false
    );
    expect(holds('attribute_equals', { name: 'other', value: 'gold' }, { attributes })).toBe(false);
  });

  it('attribute_exists matches the name', () => {
    expect(holds('attribute_exists', { name: 'tier' }, { attributes: [attr('tier', null)] })).toBe(
      true
    );
    expect(holds('attribute_exists', { name: 'tier' }, { attributes: [attr('other', 'x')] })).toBe(
      false
    );
  });

  it('attribute_in matches a non-null value in the list', () => {
    const attributes = [attr('tier', 'gold')];
    expect(
      holds('attribute_in', { name: 'tier', values: ['silver', 'gold'] }, { attributes })
    ).toBe(true);
    expect(holds('attribute_in', { name: 'tier', values: ['silver'] }, { attributes })).toBe(false);
    expect(holds('attribute_in', { name: 'other', values: ['gold'] }, { attributes })).toBe(false);
    expect(
      holds(
        'attribute_in',
        { name: 'tier', values: ['gold'] },
        { attributes: [attr('tier', null)] }
      )
    ).toBe(false);
  });

  it('end at the expiry second, exactly, unless expiry is not checked', () => {
    const at = (expiresAt: number) => ({ attributes: [attr('tier', 'gold', expiresAt)] });
    const checks: Array<[string, Record<string, unknown>]> = [
      ['attribute_equals', { name: 'tier', value: 'gold' }],
      ['attribute_exists', { name: 'tier' }],
      ['attribute_in', { name: 'tier', values: ['gold'] }],
    ];
    for (const [type, params] of checks) {
      expect(holds(type, params, at(nowSeconds + 1))).toBe(true);
      expect(holds(type, params, at(nowSeconds))).toBe(false);
      expect(holds(type, params, at(nowSeconds - 1))).toBe(false);
      expect(holds(type, { ...params, checkExpiry: false }, at(nowSeconds - 1))).toBe(true);
      expect(holds(type, { ...params, checkExpiry: true }, at(nowSeconds - 1))).toBe(false);
    }
  });
});

describe('numeric conditions', () => {
  const age = (value: string | null, expiresAt?: number) => ({
    attributes: [attr('age', value, expiresAt)],
  });

  it('compare strictly or inclusively against the threshold', () => {
    const results = (type: string, value: number): boolean[] =>
      ['17', '18', '19'].map((v) => holds(type, { name: 'age', value }, age(v)));
    expect(results('numeric_gt', 18)).toEqual([false, false, true]);
    expect(results('numeric_gte', 18)).toEqual([false, true, true]);
    expect(results('numeric_lt', 18)).toEqual([true, false, false]);
    expect(results('numeric_lte', 18)).toEqual([true, true, false]);
    expect(results('numeric_eq', 18)).toEqual([false, true, false]);
  });

  it('numeric_between is inclusive on both ends', () => {
    const between = (value: string): boolean =>
      holds('numeric_between', { name: 'age', min: 18, max: 65 }, age(value));
    expect(['17', '18', '40', '65', '66'].map(between)).toEqual([false, true, true, true, false]);
  });

  it('are never met by a missing, null, non-numeric or expired attribute', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['numeric_gt', { name: 'age', value: -5 }],
      ['numeric_gte', { name: 'age', value: -5 }],
      ['numeric_lt', { name: 'age', value: 5 }],
      ['numeric_lte', { name: 'age', value: 5 }],
      ['numeric_eq', { name: 'age', value: 0 }],
      ['numeric_between', { name: 'age', min: -5, max: 5 }],
    ];
    for (const [type, params] of cases) {
      expect(holds(type, params, { attributes: [] })).toBe(false);
      expect(holds(type, params, { attributes: [attr('other', '0')] })).toBe(false);
      expect(holds(type, params, age(null))).toBe(false);
      expect(holds(type, params, age('abc'))).toBe(false);
      expect(holds(type, params, age('0', T0 / 1000 - 1))).toBe(false);
      expect(holds(type, params, age('0', T0 / 1000))).toBe(false);
      expect(holds(type, params, age('0', T0 / 1000 + 1))).toBe(true);
    }
  });

  it('read the first live attribute of the name, and a null one ends the search', () => {
    const live = [attr('age', '10', T0 / 1000 - 1), attr('age', '30')];
    expect(holds('numeric_eq', { name: 'age', value: 30 }, { attributes: live })).toBe(true);
    expect(holds('numeric_eq', { name: 'age', value: 10 }, { attributes: live })).toBe(false);
    const nullFirst = [attr('age', null), attr('age', '30')];
    expect(holds('numeric_eq', { name: 'age', value: 30 }, { attributes: nullFirst })).toBe(false);
  });
});

describe('time conditions', () => {
  const at = (iso: string): number => Date.parse(iso);

  it('time_in_range covers the start hour and stops before the end hour', () => {
    const hour = (h: number, params: Record<string, unknown>): boolean =>
      holds('time_in_range', params, { timestamp: Date.UTC(2025, 0, 1, h, 30) });
    const day = { startHour: 9, endHour: 17 };
    expect([8, 9, 12, 16, 17, 18].map((h) => hour(h, day))).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
    const night = { startHour: 22, endHour: 6 };
    expect([21, 22, 23, 0, 5, 6, 7, 12].map((h) => hour(h, night))).toEqual([
      false,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    const empty = { startHour: 5, endHour: 5 };
    expect([4, 5, 6].map((h) => hour(h, empty))).toEqual([false, false, false]);
    expect(hour(23, { startHour: 0, endHour: 24 })).toBe(true);
  });

  it('time_in_range reads the hour in the time zone of the condition, then of the environment, then UTC', () => {
    const params = { startHour: 5, endHour: 6 };
    const timestamp = T0; // 20:00 UTC, 05:00 in Tokyo
    expect(holds('time_in_range', { ...params, timezone: 'Asia/Tokyo' }, { timestamp })).toBe(true);
    expect(holds('time_in_range', params, { timestamp })).toBe(false);
    expect(
      holds('time_in_range', params, { timestamp, environment: { timezone: 'Asia/Tokyo' } })
    ).toBe(true);
    expect(
      holds(
        'time_in_range',
        { ...params, timezone: 'UTC' },
        { timestamp, environment: { timezone: 'Asia/Tokyo' } }
      )
    ).toBe(false);
    expect(holds('time_in_range', { startHour: 20, endHour: 21 }, { timestamp })).toBe(true);
  });

  it('time_in_range falls back to UTC for a zone the runtime does not know', () => {
    expect(
      holds(
        'time_in_range',
        { startHour: 20, endHour: 21, timezone: 'Nowhere/City' },
        { timestamp: T0 }
      )
    ).toBe(true);
    expect(
      holds(
        'time_in_range',
        { startHour: 5, endHour: 6, timezone: 'Nowhere/City' },
        { timestamp: T0 }
      )
    ).toBe(false);
  });

  it('day_of_week reads the day in the time zone of the condition, then of the environment, then UTC', () => {
    const wednesday = { allowedDays: [3] };
    const thursday = { allowedDays: [4] };
    expect(holds('day_of_week', wednesday, {})).toBe(true);
    expect(holds('day_of_week', thursday, {})).toBe(false);
    expect(holds('day_of_week', { ...thursday, timezone: 'Asia/Tokyo' }, {})).toBe(true);
    expect(holds('day_of_week', { ...wednesday, timezone: 'Asia/Tokyo' }, {})).toBe(false);
    expect(holds('day_of_week', thursday, { environment: { timezone: 'Asia/Tokyo' } })).toBe(true);
    expect(
      holds(
        'day_of_week',
        { ...wednesday, timezone: 'UTC' },
        { environment: { timezone: 'Asia/Tokyo' } }
      )
    ).toBe(true);
  });

  it('day_of_week numbers Sunday 0 to Saturday 6 and falls back to UTC for an unknown zone', () => {
    const sunday = at('2025-01-05T12:00:00Z');
    for (let day = 0; day < 7; day += 1) {
      const timestamp = sunday + day * 86_400_000;
      for (let allowed = 0; allowed < 7; allowed += 1) {
        expect(holds('day_of_week', { allowedDays: [allowed] }, { timestamp })).toBe(
          allowed === day
        );
      }
    }
    expect(holds('day_of_week', { allowedDays: [3], timezone: 'Nowhere/City' }, {})).toBe(true);
    expect(holds('day_of_week', { allowedDays: [4], timezone: 'Nowhere/City' }, {})).toBe(false);
  });

  it('valid_during is inclusive of both bounds, in seconds', () => {
    const seconds = T0 / 1000;
    const during = (params: Record<string, unknown>): boolean => holds('valid_during', params, {});
    expect(during({})).toBe(true);
    expect(during({ from: seconds, to: seconds })).toBe(true);
    expect(during({ from: seconds + 1 })).toBe(false);
    expect(during({ from: seconds - 1 })).toBe(true);
    expect(during({ to: seconds - 1 })).toBe(false);
    expect(during({ to: seconds + 1 })).toBe(true);
    expect(holds('valid_during', { from: seconds }, { timestamp: T0 + 999 })).toBe(true);
    expect(holds('valid_during', { to: seconds }, { timestamp: T0 + 999 })).toBe(true);
  });

  // valid_during with a non-numeric timestamp is intentionally unspecified here.
  it('judges role expiry from the request timestamp, or now when it is not a number', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const roles: SubjectRole[] = [{ name: 'admin', scope: 'global', expiresAt: T0 - 1000 }];
    expect(holds('has_role', { role: 'admin' }, { roles, timestamp: Number.NaN })).toBe(false);
    const future: SubjectRole[] = [{ name: 'admin', scope: 'global', expiresAt: T0 + 3_600_000 }];
    expect(holds('has_role', { role: 'admin' }, { roles: future, timestamp: Number.NaN })).toBe(
      true
    );
  });
});

describe('request conditions', () => {
  it('country_in needs a country code in the list, ignoring case', () => {
    expect(
      holds('country_in', { countries: ['US', 'JP'] }, { environment: { countryCode: 'jp' } })
    ).toBe(true);
    expect(holds('country_in', { countries: ['US'] }, { environment: { countryCode: 'JP' } })).toBe(
      false
    );
    expect(holds('country_in', { countries: ['US'] }, { environment: {} })).toBe(false);
    expect(holds('country_in', { countries: ['US'] }, {})).toBe(false);
  });

  it('country_not_in is met by a country code outside the list, and not by one inside it', () => {
    expect(
      holds('country_not_in', { countries: ['RU'] }, { environment: { countryCode: 'jp' } })
    ).toBe(true);
    expect(
      holds('country_not_in', { countries: ['RU'] }, { environment: { countryCode: 'ru' } })
    ).toBe(false);
  });

  const counts = (...entries: Array<[string, number]>): Options => ({
    environment: {
      requestCounts: entries.map(([key, count]) => ({ key, count, windowSeconds: 60, resetAt: 0 })),
    },
  });

  it('request counts compare strictly or inclusively against the limit', () => {
    const results = (type: string, param: 'limit' | 'threshold', bound: number): boolean[] =>
      [9, 10, 11].map((count) => holds(type, { key: 'k', [param]: bound }, counts(['k', count])));
    expect(results('request_count_lt', 'limit', 10)).toEqual([true, false, false]);
    expect(results('request_count_lte', 'limit', 10)).toEqual([true, true, false]);
    expect(results('request_count_gt', 'threshold', 10)).toEqual([false, false, true]);
    expect(results('request_count_gte', 'threshold', 10)).toEqual([false, true, true]);
  });

  it('request counts are never met without a matching count', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['request_count_lt', { key: 'k', limit: 5 }],
      ['request_count_lte', { key: 'k', limit: 5 }],
      ['request_count_gt', { key: 'k', threshold: -5 }],
      ['request_count_gte', { key: 'k', threshold: 0 }],
    ];
    for (const [type, params] of cases) {
      expect(holds(type, params, {})).toBe(false);
      expect(holds(type, params, { environment: {} })).toBe(false);
      expect(holds(type, params, counts())).toBe(false);
      expect(holds(type, params, counts(['other', 1]))).toBe(false);
    }
  });

  it('request count keys match whole keys, with * as a wildcard and other characters literal', () => {
    const matches = (pattern: string, key: string): boolean =>
      holds('request_count_gte', { key: pattern, threshold: 1 }, counts([key, 1]));
    expect(matches('user:1:api', 'user:1:api')).toBe(true);
    expect(matches('user:*:api', 'user:1:api')).toBe(true);
    expect(matches('user:*', 'user:1:api:read')).toBe(true);
    expect(matches('*', 'anything')).toBe(true);
    expect(matches('user:1', 'user:1:api')).toBe(false);
    expect(matches('api', 'user:1:api')).toBe(false);
    expect(matches('a.b', 'a.b')).toBe(true);
    expect(matches('a.b', 'axb')).toBe(false);
    expect(matches('a+b', 'a+b')).toBe(true);
    expect(matches('a+b', 'aab')).toBe(false);
    expect(matches('(a)|b', '(a)|b')).toBe(true);
    expect(matches('(a)|b', 'a')).toBe(false);
    expect(matches('[a]', '[a]')).toBe(true);
    expect(matches('[a]', 'a')).toBe(false);
    expect(matches('a?', 'a?')).toBe(true);
    expect(matches('a?', 'a')).toBe(false);
    expect(matches('^a$', '^a$')).toBe(true);
    expect(matches('a{1}', 'a{1}')).toBe(true);
    expect(matches('a{1}', 'a')).toBe(false);
    expect(matches('a\\b', 'a\\b')).toBe(true);
  });

  it('request counts use the first matching key', () => {
    const options = counts(['user:1', 3], ['user:*', 30]);
    expect(holds('request_count_lt', { key: 'user:*', limit: 10 }, options)).toBe(true);
    expect(holds('request_count_lt', { key: 'user:2', limit: 10 }, options)).toBe(false);
  });
});
