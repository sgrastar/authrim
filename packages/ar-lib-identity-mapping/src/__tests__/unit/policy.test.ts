import { describe, expect, it } from 'vitest';
import { resolveEffectivePolicy } from '../../core/policy';

describe('effective policy resolver', () => {
  it('orders deny and lock before lower-scope allow', () => {
    const result = resolveEffectivePolicy({
      policies: [
        {
          id: 'tenant-policy',
          rules: [
            {
              id: 'allow.platform',
              action: 'allow',
              scope: { kind: 'platform', id: 'default' },
            },
            {
              id: 'deny.tenant',
              action: 'deny',
              scope: { kind: 'tenant', id: 'tenant-a' },
            },
          ],
        },
      ],
    });

    expect(result.mergedPolicy.rules[0]?.id).toBe('deny.tenant');
    expect(result.mergeTrace[0]?.reason.code).toBe('policy.deny_locked');
    expect(result.discardedRuleSummary).toEqual([
      {
        ruleId: 'allow.platform',
        reason: {
          category: 'policy',
          code: 'policy.rule_discarded',
          severity: 'info',
        },
      },
    ]);
  });

  it('keeps independent target rules selected', () => {
    const result = resolveEffectivePolicy({
      policies: [
        {
          id: 'tenant-policy',
          rules: [
            {
              id: 'allow.email',
              action: 'allow',
              scope: { kind: 'tenant', id: 'tenant-a' },
              targetRef: { side: 'canonical', namespace: 'authrim.profile', path: 'email' },
            },
            {
              id: 'allow.name',
              action: 'allow',
              scope: { kind: 'tenant', id: 'tenant-a' },
              targetRef: { side: 'canonical', namespace: 'authrim.profile', path: 'name' },
            },
          ],
        },
      ],
    });

    expect(result.mergedPolicy.rules.map((rule) => rule.id).sort()).toEqual([
      'allow.email',
      'allow.name',
    ]);
    expect(result.discardedRuleSummary).toEqual([]);
  });
});
