import { describe, expect, it } from 'vitest';
import { dropSuppressedTargets } from '../../core/transforms';
import type {
  FieldRef,
  MappingGraphTransform,
  MappingRuleGraph,
  MappingTransformStep,
  SourceValueEnvelope,
} from '../../core/types';

const ref = (path: string, overrides: Partial<FieldRef> = {}): FieldRef => ({
  side: 'canonical',
  namespace: 'authrim.profile',
  path,
  ...overrides,
});
const envelope = (path: string, overrides: Partial<FieldRef> = {}): SourceValueEnvelope => ({
  value: path,
  sourceRef: ref(path, overrides),
});
const pidStep = (id: string, path: string): MappingTransformStep => ({
  id,
  inputEdgeIds: [],
  operation: 'persistent_identifier',
  outputTargetRef: ref(path),
});
const trimStep = (id: string, path: string): MappingTransformStep => ({
  id,
  inputEdgeIds: ['e'],
  operation: 'trim',
  outputTargetRef: ref(path),
});
const paths = (values: SourceValueEnvelope[]) => values.map((item) => item.sourceRef.path);

describe('dropSuppressedTargets with steps', () => {
  const values = [envelope('sub'), envelope('mail'), envelope('name')];

  it('returns the values untouched without a suppression map', () => {
    for (const context of [
      undefined,
      {},
      { suppressedIdentifiers: null },
      { suppressedIdentifiers: 'x' },
    ]) {
      expect(dropSuppressedTargets(values, [pidStep('pid', 'sub')], context)).toBe(values);
    }
  });

  it('returns the values untouched when nothing is flagged', () => {
    const noTargets = [
      { suppressedIdentifiers: {} },
      { suppressedIdentifiers: { pid: false } },
      { suppressedIdentifiers: { pid: 'true' } },
      { suppressedIdentifiers: { other: true } },
    ];
    for (const context of noTargets) {
      expect(dropSuppressedTargets(values, [pidStep('pid', 'sub')], context)).toBe(values);
    }
    expect(dropSuppressedTargets(values, undefined, { suppressedIdentifiers: { pid: true } })).toBe(
      values
    );
  });

  it('removes values written to the target of a suppressed identifier step', () => {
    const result = dropSuppressedTargets(values, [pidStep('pid', 'sub')], {
      suppressedIdentifiers: { pid: true },
    });
    expect(paths(result)).toEqual(['mail', 'name']);
  });

  it('removes the targets of every suppressed identifier step only', () => {
    const result = dropSuppressedTargets(
      values,
      [pidStep('a', 'sub'), pidStep('b', 'mail'), pidStep('c', 'name')],
      { suppressedIdentifiers: { a: true, b: true, c: false } }
    );
    expect(paths(result)).toEqual(['name']);
  });

  it('ignores flagged steps that are not identifier steps', () => {
    const result = dropSuppressedTargets(values, [trimStep('t', 'sub')], {
      suppressedIdentifiers: { t: true },
    });
    expect(result).toBe(values);
  });

  it('matches a target by side, namespace and path', () => {
    const mixed = [
      envelope('sub'),
      envelope('sub', { side: 'destination' }),
      envelope('sub', { namespace: 'other' }),
      envelope('subx'),
    ];
    const result = dropSuppressedTargets(mixed, [pidStep('pid', 'sub')], {
      suppressedIdentifiers: { pid: true },
    });
    expect(result).toEqual([mixed[1], mixed[2], mixed[3]]);
  });
});

describe('dropSuppressedTargets with graph rules', () => {
  const identifier: MappingGraphTransform = {
    id: 'pid',
    operation: 'persistent_identifier',
    inputs: [],
    parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
  };
  const trim: MappingGraphTransform = { id: 'trim', operation: 'trim', inputs: [{ stepIndex: 0 }] };
  const graph = (
    transforms: MappingGraphTransform[],
    output: MappingRuleGraph['output'],
    path = 'sub'
  ): MappingRuleGraph => ({
    id: `graph-${path}`,
    targetRef: ref(path),
    edges: [],
    transforms,
    output,
  });
  const values = [envelope('sub'), envelope('mail')];

  it('removes the target of a rule that depends on a suppressed identifier step', () => {
    const result = dropSuppressedTargets(values, [], { suppressedIdentifiers: { pid: true } }, [
      graph([identifier], { stepIndex: 0 }),
    ]);
    expect(paths(result)).toEqual(['mail']);
    const chained = dropSuppressedTargets(values, [], { suppressedIdentifiers: { pid: true } }, [
      graph([identifier, trim], { stepIndex: 1 }),
    ]);
    expect(paths(chained)).toEqual(['mail']);
  });

  it('keeps everything when the identifier is not suppressed or not part of the output', () => {
    expect(
      dropSuppressedTargets(values, [], { suppressedIdentifiers: { pid: false } }, [
        graph([identifier], { stepIndex: 0 }),
      ])
    ).toBe(values);
    expect(
      dropSuppressedTargets(values, [], { suppressedIdentifiers: { pid: true } }, [
        graph(
          [identifier, { id: 'other', operation: 'trim', inputs: [{ stepIndex: 0 }] }],
          { stepIndex: 0 },
          'sub'
        ),
      ]).map((item) => item.sourceRef.path)
    ).toEqual(['mail']);
    expect(
      dropSuppressedTargets(values, [], { suppressedIdentifiers: { pid: true } }, [
        graph([{ id: 'pid', operation: 'trim', inputs: [] }], { stepIndex: 0 }),
      ])
    ).toBe(values);
    expect(
      dropSuppressedTargets(values, [], { suppressedIdentifiers: { trim: true } }, [
        graph([identifier, trim], { stepIndex: 1 }),
      ])
    ).toBe(values);
  });

  it('combines step targets with rule targets', () => {
    const result = dropSuppressedTargets(
      [envelope('sub'), envelope('mail'), envelope('name')],
      [pidStep('step-pid', 'mail')],
      { suppressedIdentifiers: { pid: true, 'step-pid': true } },
      [graph([identifier], { stepIndex: 0 })]
    );
    expect(paths(result)).toEqual(['name']);
  });

  it('fails closed on an invalid graph', () => {
    const broken = graph([{ id: 'trim', operation: 'trim', inputs: [{ stepIndex: 3 }] }], {
      stepIndex: 0,
    });
    expect(
      dropSuppressedTargets(values, [], { suppressedIdentifiers: { pid: true } }, [broken])
    ).toEqual([]);
    expect(
      dropSuppressedTargets(values, [], { suppressedIdentifiers: { other: false } }, [broken])
    ).toEqual([]);
  });
});
