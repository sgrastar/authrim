/**
 * Resource attribute conditions (`resource_attribute_equals`, `resource_attribute_in`) with the
 * standard engine and the tenant rule evaluator: they read `resource.attributes`.
 */

import { describe, expect, it } from 'vitest';
import { CHECK_API_CONDITION_TYPES, PolicyEngine, validatePolicyConditions } from '../engine';
import { createTenantRuleEvaluator, type TenantPolicyRule } from '../tenant-rules';
import type { PolicyCondition, PolicyContext } from '../types';

function context(attributes?: Record<string, unknown>): PolicyContext {
  return {
    subject: { id: 'user-1', roles: [] },
    resource: { type: 'documents', id: 'doc_1', ...(attributes && { attributes }) },
    action: { name: 'read' },
    timestamp: Date.UTC(2026, 0, 1),
  };
}

function holds(condition: PolicyCondition, attributes?: Record<string, unknown>): boolean {
  const engine = new PolicyEngine({ defaultDecision: 'deny' });
  engine.addRule({ id: 'r', name: 'r', priority: 1, effect: 'allow', conditions: [condition] });
  return engine.evaluate(context(attributes)).allowed;
}

const equals = (attribute: string, value: unknown): PolicyCondition => ({
  type: 'resource_attribute_equals',
  params: { attribute, value },
});
const within = (attribute: string, values: unknown[]): PolicyCondition => ({
  type: 'resource_attribute_in',
  params: { attribute, values },
});

describe('resource_attribute_equals', () => {
  it('meets a string, number or boolean of the same type and value', () => {
    expect(holds(equals('classification', 'internal'), { classification: 'internal' })).toBe(true);
    expect(holds(equals('level', 2), { level: 2 })).toBe(true);
    expect(holds(equals('public', true), { public: true })).toBe(true);
  });

  it('does not meet another value, another type, an object, or a missing attribute', () => {
    expect(holds(equals('classification', 'internal'), { classification: 'secret' })).toBe(false);
    // A number rule value does not match a text attribute.
    expect(holds(equals('level', 2), { level: '2' })).toBe(false);
    expect(holds(equals('tags', 'a'), { tags: ['a'] })).toBe(false);
    expect(holds(equals('classification', 'internal'), {})).toBe(false);
    expect(holds(equals('classification', 'internal'))).toBe(false);
    // An inherited name is not an attribute.
    expect(holds(equals('constructor', 'x'), {})).toBe(false);
  });
});

describe('rule values saved as text (the Admin console forms)', () => {
  it('matches a boolean or number attribute that reads the same', () => {
    expect(holds(equals('public', 'true'), { public: true })).toBe(true);
    expect(holds(equals('public', 'false'), { public: true })).toBe(false);
    expect(holds(equals('level', '3'), { level: 3 })).toBe(true);
    expect(holds(equals('level', '3.0'), { level: 3 })).toBe(false);
    expect(holds(within('level', ['1', '3']), { level: 3 })).toBe(true);
    expect(holds(within('public', ['true']), { public: true })).toBe(true);
  });

  it('never matches a text attribute with a number or boolean rule value', () => {
    // Rule number, attribute text: no match (only a text rule value is read as text).
    expect(holds(equals('level', 3), { level: '3' })).toBe(false);
    expect(holds(equals('public', true), { public: 'true' })).toBe(false);
    expect(holds(within('level', [3]), { level: '3' })).toBe(false);
  });

  it('never matches an object, array or null attribute', () => {
    expect(holds(equals('tags', '[object Object]'), { tags: {} })).toBe(false);
    expect(holds(equals('tags', 'a'), { tags: ['a'] })).toBe(false);
    expect(holds(equals('tags', ''), { tags: [] })).toBe(false);
    expect(holds(equals('owner', 'null'), { owner: null })).toBe(false);
    expect(holds(within('tags', ['a', 'a,b']), { tags: ['a', 'b'] })).toBe(false);
  });
});

describe('resource_attribute_in', () => {
  it('meets a value in the list', () => {
    expect(holds(within('region', ['jp', 'us']), { region: 'jp' })).toBe(true);
    expect(holds(within('level', [1, 2]), { level: 2 })).toBe(true);
  });

  it('does not meet a value outside the list or a missing attribute', () => {
    expect(holds(within('region', ['jp', 'us']), { region: 'eu' })).toBe(false);
    expect(holds(within('level', [1, 2]), { level: '2' })).toBe(false);
    expect(holds(within('region', ['jp']))).toBe(false);
  });
});

describe('validation', () => {
  it('accepts the conditions in Check API rules', () => {
    expect(CHECK_API_CONDITION_TYPES.has('resource_attribute_equals')).toBe(true);
    expect(CHECK_API_CONDITION_TYPES.has('resource_attribute_in')).toBe(true);
    expect(
      validatePolicyConditions(
        [equals('classification', 'internal'), within('level', [1, true, 'x'])],
        CHECK_API_CONDITION_TYPES
      )
    ).toBeNull();
  });

  it.each([
    [{ type: 'resource_attribute_equals', params: { attribute: '', value: 'x' } }, 'attribute'],
    [{ type: 'resource_attribute_equals', params: { attribute: 'a' } }, 'value'],
    [{ type: 'resource_attribute_equals', params: { attribute: 'a', value: { x: 1 } } }, 'value'],
    [{ type: 'resource_attribute_equals', params: { attribute: 'a', value: Number.NaN } }, 'value'],
    [{ type: 'resource_attribute_equals', params: { name: 'a', value: 'x' } }, 'name'],
    [{ type: 'resource_attribute_in', params: { attribute: 'a', values: [] } }, 'values'],
    [{ type: 'resource_attribute_in', params: { attribute: 'a', values: 'x' } }, 'values'],
    [{ type: 'resource_attribute_in', params: { attribute: 'a', values: [null] } }, 'values'],
  ])('refuses %j (%s)', (condition, field) => {
    expect(validatePolicyConditions([condition], CHECK_API_CONDITION_TYPES)).toContain(field);
  });
});

describe('in tenant rules (the evaluator the Check API uses)', () => {
  const rule = (overrides: Partial<TenantPolicyRule>): TenantPolicyRule => ({
    id: 'r',
    name: 'r',
    priority: 10,
    effect: 'allow',
    conditions: [],
    resourceTypes: ['documents'],
    actions: ['read'],
    ...overrides,
  });
  const evaluate = (rules: TenantPolicyRule[], attributes?: Record<string, unknown>) =>
    createTenantRuleEvaluator(rules).evaluate({
      subjectId: 'user-1',
      subjectRoles: [],
      subjectGroupIds: [],
      verifiedAttributes: [],
      resourceType: 'documents',
      resourceId: 'doc_1',
      ...(attributes && { resourceAttributes: attributes }),
      action: 'read',
      timestamp: Date.UTC(2026, 0, 1),
    });

  const allowInternal = rule({
    id: 'allow_internal',
    conditions: [equals('classification', 'internal')],
  });
  const denySecret = rule({
    id: 'deny_secret',
    effect: 'deny',
    priority: 100,
    conditions: [within('classification', ['secret', 'top_secret'])],
  });
  const allowAll = rule({ id: 'allow_all', priority: 1 });

  it('allows and denies on the resource attributes', () => {
    expect(evaluate([allowInternal], { classification: 'internal' }).allowed).toBe(true);
    expect(evaluate([allowInternal], { classification: 'secret' }).allowed).toBe(false);
    expect(evaluate([denySecret, allowAll], { classification: 'internal' }).allowed).toBe(true);
    expect(evaluate([denySecret, allowAll], { classification: 'secret' })).toMatchObject({
      allowed: false,
      decidedBy: 'deny_secret',
    });
  });

  it('grants nothing when a deny needs an attribute the resource does not carry (fail closed)', () => {
    for (const attributes of [undefined, {}, { other: 'x' }]) {
      const decision = evaluate([denySecret, allowAll], attributes);
      expect(decision).toMatchObject({ allowed: false, decidedBy: 'deny_secret' });
      expect(decision.reason).toContain('the resource attribute classification');
    }
  });
});
