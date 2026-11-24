import { describe, expect, it } from 'vitest';
import { resolveEffectiveFieldMappingSet } from '../../core/field-mapping-set';
import { reason } from '../../core/reason-registry';
import type { FieldMappingRule, FieldRef, PolicyScopeKind } from '../../core/types';

function rule(
  id: string,
  action: FieldMappingRule['action'] = 'allow',
  kind: PolicyScopeKind = 'tenant',
  extra: Partial<FieldMappingRule> = {}
): FieldMappingRule {
  return { id, action, scope: { kind, id: `${kind}-scope` }, ...extra };
}

function resolve(...rules: FieldMappingRule[]) {
  return resolveEffectiveFieldMappingSet({ sets: [{ id: 'set', rules }] });
}

function selectedIds(rules: FieldMappingRule[]): string[] {
  return resolve(...rules).mergedSet.rules.map((item) => item.id);
}

function discardedIds(rules: FieldMappingRule[]): string[] {
  return resolve(...rules).discardedRuleSummary.map((item) => item.ruleId);
}

describe('effective field mapping set winner selection', () => {
  it('names the merged set effective', () => {
    expect(resolve().mergedSet).toEqual({ id: 'effective', rules: [] });
    expect(resolve().mergeTrace).toEqual([]);
  });

  it.each(['deny', 'lock'] as const)('prefers %s over an allow from a higher scope', (action) => {
    const blocking = rule('blocking', action, 'platform');
    const allow = rule('allow', 'allow', 'job');
    for (const order of [
      [blocking, allow],
      [allow, blocking],
    ]) {
      expect(selectedIds(order)).toEqual(['blocking']);
      expect(discardedIds(order)).toEqual(['allow']);
    }
  });

  it('ranks scope kinds job > destination > source > tenant > platform', () => {
    const rules = (['tenant', 'job', 'platform', 'source', 'destination'] as const).map((kind) =>
      rule(kind, 'allow', kind)
    );
    expect(selectedIds(rules)).toEqual(['job']);
    expect(discardedIds(rules)).toEqual(['destination', 'source', 'tenant', 'platform']);
    expect(discardedIds([...rules].reverse())).toEqual([
      'destination',
      'source',
      'tenant',
      'platform',
    ]);
  });

  it('breaks scope ties by higher specificity with a missing value counting as zero', () => {
    const rules = [
      rule('none', 'allow', 'tenant'),
      rule('low', 'allow', 'tenant', { specificity: 1 }),
      rule('high', 'allow', 'tenant', { specificity: 5 }),
      rule('negative', 'allow', 'tenant', { specificity: -1 }),
    ];
    expect(selectedIds(rules)).toEqual(['high']);
    expect(discardedIds(rules)).toEqual(['low', 'none', 'negative']);
    expect(discardedIds([...rules].reverse())).toEqual(['low', 'none', 'negative']);
  });

  it('lets scope outrank specificity and specificity outrank priority', () => {
    expect(
      selectedIds([
        rule('narrow-tenant', 'allow', 'tenant', { specificity: 9 }),
        rule('plain-job', 'allow', 'job'),
      ])
    ).toEqual(['plain-job']);
    expect(
      selectedIds([
        rule('priority', 'allow', 'tenant', { priority: 9 }),
        rule('specific', 'allow', 'tenant', { specificity: 1 }),
      ])
    ).toEqual(['specific']);
  });

  it('breaks specificity ties by higher priority with a missing value counting as zero', () => {
    const rules = [
      rule('none', 'allow', 'source'),
      rule('low', 'allow', 'source', { priority: 1 }),
      rule('high', 'allow', 'source', { priority: 5 }),
      rule('negative', 'allow', 'source', { priority: -1 }),
    ];
    expect(selectedIds(rules)).toEqual(['high']);
    expect(discardedIds(rules)).toEqual(['low', 'none', 'negative']);
    expect(discardedIds([...rules].reverse())).toEqual(['low', 'none', 'negative']);
  });

  it('finally orders by ascending rule id', () => {
    const rules = [rule('b'), rule('c'), rule('a')];
    expect(selectedIds(rules)).toEqual(['a']);
    expect(discardedIds(rules)).toEqual(['b', 'c']);
    expect(discardedIds([...rules].reverse())).toEqual(['b', 'c']);
  });

  it('orders competing deny and lock rules like any other rules', () => {
    const rules = [rule('deny', 'deny', 'tenant'), rule('lock', 'lock', 'job')];
    expect(selectedIds(rules)).toEqual(['lock']);
    expect(discardedIds(rules)).toEqual(['deny']);
    expect(selectedIds([...rules].reverse())).toEqual(['lock']);
  });

  it('merges rules from every set', () => {
    const result = resolveEffectiveFieldMappingSet({
      sets: [
        { id: 'one', rules: [rule('x', 'allow', 'platform')] },
        { id: 'two', rules: [rule('y', 'allow', 'job')] },
      ],
    });
    expect(result.mergedSet.rules.map((item) => item.id)).toEqual(['y']);
    expect(result.discardedRuleSummary.map((item) => item.ruleId)).toEqual(['x']);
  });
});

describe('effective field mapping set target grouping', () => {
  const email: FieldRef = { side: 'canonical', namespace: 'authrim.profile', path: 'email' };

  it('groups every rule without a target together', () => {
    expect(selectedIds([rule('a'), rule('b')])).toEqual(['a']);
    expect(
      selectedIds([rule('a'), rule('b', 'allow', 'tenant', { targetRef: email })]).sort()
    ).toEqual(['a', 'b']);
  });

  it('groups by side, namespace and path', () => {
    const groups = [
      { ...email },
      { ...email, side: 'destination' as const },
      { ...email, namespace: 'other' },
      { ...email, path: 'name' },
    ];
    const rules = groups.map((targetRef, index) =>
      rule(`r${index}`, 'allow', 'tenant', { targetRef })
    );
    expect(selectedIds(rules)).toEqual(['r0', 'r1', 'r2', 'r3']);
    const same = [
      rule('a', 'allow', 'tenant', { targetRef: { ...email } }),
      rule('b', 'allow', 'tenant', { targetRef: { ...email } }),
    ];
    expect(selectedIds(same)).toEqual(['a']);
  });

  it('keys targets with a catalog id by that id only', () => {
    const sameId = [
      rule('a', 'allow', 'tenant', { targetRef: { ...email, catalogEntryId: 'c1' } }),
      rule('b', 'allow', 'tenant', {
        targetRef: { side: 'destination', namespace: 'x', path: 'y', catalogEntryId: 'c1' },
      }),
    ];
    expect(selectedIds(sameId)).toEqual(['a']);
    const differentId = [
      rule('a', 'allow', 'tenant', { targetRef: { ...email, catalogEntryId: 'c1' } }),
      rule('b', 'allow', 'tenant', { targetRef: { ...email, catalogEntryId: 'c2' } }),
    ];
    expect(selectedIds(differentId)).toEqual(['a', 'b']);
  });

  it('does not confuse a catalog-id key, a path key and the untargeted key', () => {
    const rules = [
      rule('star'),
      rule('id', 'allow', 'tenant', { targetRef: { ...email, catalogEntryId: '*' } }),
      rule('path', 'allow', 'tenant', {
        targetRef: { side: 'canonical', namespace: 'id', path: 'c1' },
      }),
      rule('catalog', 'allow', 'tenant', {
        targetRef: { side: 'canonical', namespace: 'n', path: 'p', catalogEntryId: 'c1' },
      }),
    ];
    expect(selectedIds(rules)).toEqual(['catalog', 'id', 'path', 'star']);
  });
});

describe('effective field mapping set ordering and trace', () => {
  const targetA: FieldRef = { side: 'canonical', namespace: 'n', path: 'a' };
  const targetB: FieldRef = { side: 'canonical', namespace: 'n', path: 'b' };

  it('orders the merged rules with the same comparator as the winners', () => {
    const rules = [
      rule('allow-b', 'allow', 'tenant', { targetRef: targetB }),
      rule('allow-job', 'allow', 'job', { targetRef: { ...targetA, path: 'job' } }),
      rule('deny-a', 'deny', 'platform', { targetRef: targetA }),
    ];
    expect(selectedIds(rules)).toEqual(['deny-a', 'allow-job', 'allow-b']);
  });

  it('traces selected rules before discarded ones with the matching reason', () => {
    const result = resolve(
      rule('allow-b', 'allow', 'tenant', { targetRef: targetB }),
      rule('lock-a', 'lock', 'platform', { targetRef: targetA }),
      rule('allow-a', 'allow', 'job', { targetRef: targetA }),
      rule('deny-c', 'deny', 'source', { targetRef: { ...targetA, path: 'c' } })
    );
    expect(result.mergeTrace).toEqual([
      {
        ruleId: 'deny-c',
        scope: { kind: 'source', id: 'source-scope' },
        selected: true,
        reason: reason('policy.deny_locked'),
      },
      {
        ruleId: 'lock-a',
        scope: { kind: 'platform', id: 'platform-scope' },
        selected: true,
        reason: reason('policy.deny_locked'),
      },
      {
        ruleId: 'allow-b',
        scope: { kind: 'tenant', id: 'tenant-scope' },
        selected: true,
        reason: reason('policy.rule_selected'),
      },
      {
        ruleId: 'allow-a',
        scope: { kind: 'job', id: 'job-scope' },
        selected: false,
        reason: reason('policy.rule_discarded'),
      },
    ]);
    expect(result.discardedRuleSummary).toEqual([
      { ruleId: 'allow-a', reason: reason('policy.rule_discarded') },
    ]);
  });
});
