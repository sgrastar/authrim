import { describe, expect, it } from 'vitest';
import { claimShapes, diffClaimShapes, NO_CATALOG } from '../identity-mapping-content-diff';
import { canonicalMappingRule } from '../identity-mapping-graph-contract';
import type { FieldMappingVersionRuleInput } from '../identity-mapping-control-plane';

function graph(): FieldMappingVersionRuleInput {
  return {
    ruleKey: 'combined',
    ruleKind: 'mapping',
    action: 'allow',
    targetRef: { namespace: 'oidc.claim', path: 'name' },
    edges: ['first', 'second', 'unused'].map((path) => ({
      sourceRef: { namespace: 'csv', path },
      targetRef: { namespace: 'oidc.claim', path: 'name' },
    })),
    transforms: [
      { operation: 'trim', inputs: [{ edgeIndex: 0 }] },
      { operation: 'trim', inputs: [{ edgeIndex: 1 }] },
      { operation: 'concat', inputs: [{ stepIndex: 0 }, { stepIndex: 1 }] },
      { operation: 'copy', inputs: [{ edgeIndex: 2 }] },
    ],
    output: { stepIndex: 2 },
  };
}

describe('dependency-based content diff', () => {
  it('includes all final-output dependencies and excludes unused sources and steps', () => {
    const [shape] = claimShapes({ rules: [graph()] }, NO_CATALOG).values();
    expect(shape.sourceKeys).toEqual(['csv:first', 'csv:second']);
    expect(shape.transforms).toContain('concat');
    expect(shape.transforms).not.toContain('copy');
    expect(shape.sourceOrder).toBe('csv:first\ncsv:second');
  });

  it('tells a change to a second chained input or input order from the original graph', () => {
    const original = graph();
    const changed = graph();
    changed.transforms = [
      { operation: 'trim', inputs: [{ edgeIndex: 1 }] },
      { operation: 'trim', inputs: [{ edgeIndex: 0 }] },
      { operation: 'concat', inputs: [{ stepIndex: 0 }, { stepIndex: 1 }] },
    ];
    const before = [...claimShapes({ rules: [original] }, NO_CATALOG).values()];
    const after = [...claimShapes({ rules: [changed] }, NO_CATALOG).values()];
    expect(after[0].sourceOrder).not.toBe(before[0].sourceOrder);
  });

  it('compares a legacy rule and its translated GET graph equally', () => {
    const legacy: FieldMappingVersionRuleInput = {
      ruleKey: 'email',
      ruleKind: 'mapping',
      action: 'allow',
      edges: [
        {
          sourceRef: { namespace: 'csv', path: 'email' },
          targetRef: { namespace: 'oidc.claim', path: 'email' },
        },
      ],
      transforms: [
        { operation: 'case', parameters: { mode: 'upper' }, edgeIndex: 0 },
        { operation: 'trim', edgeIndex: 0 },
      ],
    };
    const before = claimShapes({ rules: [canonicalMappingRule(legacy)] }, NO_CATALOG);
    const after = claimShapes({ rules: [legacy] }, NO_CATALOG);
    expect(after).toEqual(before);
    expect([...after.values()][0].transforms).not.toContain('case');
    expect(diffClaimShapes(before, after)).toEqual([]);
  });

  it('compares competing graph rules in runtime priority order, retaining saved order on ties', () => {
    const first = { ...graph(), priority: 0 };
    const second = graph();
    second.ruleKey = 'other';
    second.edges = [
      {
        sourceRef: { namespace: 'csv', path: 'other' },
        targetRef: { namespace: 'oidc.claim', path: 'name' },
      },
    ];
    second.transforms = [{ operation: 'copy', inputs: [{ edgeIndex: 0 }] }];
    second.output = { stepIndex: 0 };
    const shape = (rules: FieldMappingVersionRuleInput[]) =>
      [...claimShapes({ rules }, NO_CATALOG).values()][0];
    const before = shape([first, second]);
    const after = shape([{ ...first, priority: 1 }, second]);
    expect(before.sourceOrder).toBe('csv:first\ncsv:other\ncsv:second');
    expect(after.sourceOrder).toBe('csv:other\ncsv:first\ncsv:second');
    expect(after.transforms).not.toBe(before.transforms);
    expect(
      diffClaimShapes(
        claimShapes({ rules: [first, second] }, NO_CATALOG),
        claimShapes({ rules: [{ ...first, priority: 1 }, second] }, NO_CATALOG)
      ).map((change) => change.kind)
    ).toEqual(['source_changed', 'transform_changed']);
  });
});
