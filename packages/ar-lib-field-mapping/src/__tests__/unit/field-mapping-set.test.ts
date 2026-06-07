import { describe, expect, it } from 'vitest';
import { resolveEffectiveFieldMappingSet } from '../../core/field-mapping-set';

describe('effective field mapping set resolver', () => {
  it('orders deny and lock before lower-scope allow', () => {
    const result = resolveEffectiveFieldMappingSet({
      sets: [
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

    expect(result.mergedSet.rules[0]?.id).toBe('deny.tenant');
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
    const result = resolveEffectiveFieldMappingSet({
      sets: [
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

    expect(result.mergedSet.rules.map((rule) => rule.id).sort()).toEqual([
      'allow.email',
      'allow.name',
    ]);
    expect(result.discardedRuleSummary).toEqual([]);
  });
});
