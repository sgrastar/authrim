import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../engine';
import type { PolicyContext, PolicyRule } from '../types';

const DAY = 24 * 60 * 60 * 1000;

function decide(rule: PolicyRule, context: PolicyContext): boolean {
  const engine = new PolicyEngine({ defaultDecision: 'deny' });
  engine.addRules([rule]);
  return engine.evaluate(context).allowed;
}

function context(timestamp: number, subject: Partial<PolicyContext['subject']>): PolicyContext {
  return {
    subject: { id: 'user-1', roles: [], ...subject } as PolicyContext['subject'],
    resource: { type: 'report', id: 'r1' },
    action: { name: 'read' },
    timestamp,
  };
}

const allowWhen = (condition: PolicyRule['conditions'][number]): PolicyRule => ({
  id: 'rule',
  name: 'rule',
  priority: 1,
  effect: 'allow',
  conditions: [condition],
});

describe('expiry is judged at the request time', () => {
  const now = Date.now();
  const tomorrow = now + DAY;
  const dayAfter = now + 2 * DAY;

  it('for roles', () => {
    const rule = allowWhen({ type: 'has_role', params: { role: 'auditor' } });
    const roles = [{ name: 'auditor', scope: 'global' as const, expiresAt: tomorrow }];
    expect(decide(rule, context(now, { roles }))).toBe(true);
    // Valid now, but not at the time asked about.
    expect(decide(rule, context(dayAfter, { roles }))).toBe(false);
  });

  it('for attributes and numeric attributes', () => {
    const verifiedAttributes = [
      { name: 'tier', value: 'premium', source: 'db', expiresAt: Math.floor(tomorrow / 1000) },
      { name: 'age', value: '30', source: 'db', expiresAt: Math.floor(tomorrow / 1000) },
    ];
    const equals = allowWhen({
      type: 'attribute_equals',
      params: { name: 'tier', value: 'premium' },
    });
    const numeric = allowWhen({ type: 'numeric_gte', params: { name: 'age', value: 18 } });
    for (const rule of [equals, numeric]) {
      expect(decide(rule, context(now, { verifiedAttributes } as never))).toBe(true);
      expect(decide(rule, context(dayAfter, { verifiedAttributes } as never))).toBe(false);
    }
  });

  it('back in time too', () => {
    // A role that ended yesterday still held two days ago.
    const rule = allowWhen({ type: 'has_role', params: { role: 'auditor' } });
    const roles = [{ name: 'auditor', scope: 'global' as const, expiresAt: now - DAY }];
    expect(decide(rule, context(now, { roles }))).toBe(false);
    expect(decide(rule, context(now - 2 * DAY, { roles }))).toBe(true);
  });
});
