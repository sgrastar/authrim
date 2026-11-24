import { describe, expect, it, vi } from 'vitest';
import {
  evaluateMappingRule,
  evaluatePreparedMappingRule,
  strongestMappingClassification,
} from '../../core/graph-evaluator';
import type {
  FieldRef,
  MappingEvaluationValue,
  MappingGraphTransform,
  MappingRuleGraph,
  MappingValueReference,
  ProvenanceHint,
  RedactionClassification,
  SourceValueEnvelope,
  TransformOperation,
} from '../../core/types';

const sourceRef0: FieldRef = { side: 'source', namespace: 'sample', path: 'zero' };
const sourceRef1: FieldRef = { side: 'source', namespace: 'sample', path: 'one' };
const targetRef: FieldRef = { side: 'derived', namespace: 'sample', path: 'out' };

function graph(
  transforms: MappingGraphTransform[],
  output: MappingValueReference
): MappingRuleGraph {
  return {
    id: 'rule',
    targetRef,
    edges: [
      { id: 'e0', sourceRef: sourceRef0, targetRef },
      { id: 'e1', sourceRef: sourceRef1, targetRef },
    ],
    transforms,
    output,
  };
}

function step(
  id: string,
  operation: TransformOperation,
  inputs: MappingValueReference[],
  parameters?: Record<string, unknown>
): MappingGraphTransform {
  return { id, operation, inputs, ...(parameters ? { parameters } : {}) };
}

function source(ref: FieldRef, value: unknown, extra: Partial<SourceValueEnvelope> = {}) {
  return { sourceRef: ref, value, ...extra } satisfies SourceValueEnvelope;
}

function valueOf(result: { output: MappingEvaluationValue }): unknown {
  return result.output.kind === 'value' ? result.output.envelope.value : result.output.kind;
}

describe('strongestMappingClassification', () => {
  const order: RedactionClassification[] = [
    'public',
    'internal',
    'pii',
    'regulated',
    'secret',
    'credential',
    'token',
    'key_material',
  ];

  it('returns undefined without any classification', () => {
    expect(strongestMappingClassification()).toBeUndefined();
    expect(strongestMappingClassification(undefined, undefined)).toBeUndefined();
  });

  it('picks the stronger classification regardless of argument order', () => {
    for (let low = 0; low < order.length; low++) {
      for (let high = low + 1; high < order.length; high++) {
        expect(strongestMappingClassification(order[low], order[high])).toBe(order[high]);
        expect(strongestMappingClassification(order[high], order[low])).toBe(order[high]);
        expect(strongestMappingClassification(undefined, order[high], order[low])).toBe(
          order[high]
        );
      }
    }
  });

  it('keeps a classification compared with itself', () => {
    for (const classification of order) {
      expect(strongestMappingClassification(classification, classification)).toBe(classification);
    }
  });

  it('skips undefined classifications between defined ones', () => {
    expect(strongestMappingClassification('pii', undefined, 'public')).toBe('pii');
    expect(strongestMappingClassification(undefined, 'internal')).toBe('internal');
  });
});

describe('graph evaluation of source values', () => {
  it('treats a source value that is undefined like an absent one', () => {
    const rule = graph([], { edgeIndex: 0 });
    expect(
      evaluateMappingRule({ rule, sourceValues: [source(sourceRef0, undefined)] }).output
    ).toEqual({
      kind: 'absent',
    });
    expect(evaluateMappingRule({ rule, sourceValues: [] }).output).toEqual({ kind: 'absent' });
    expect(
      valueOf(evaluateMappingRule({ rule, sourceValues: [source(sourceRef0, null)] }))
    ).toBeNull();
    expect(valueOf(evaluateMappingRule({ rule, sourceValues: [source(sourceRef0, '')] }))).toBe('');
  });

  it('releases the output value under the rule target', () => {
    const rule = graph([], { edgeIndex: 0 });
    const result = evaluateMappingRule({ rule, sourceValues: [source(sourceRef0, 'a')] });
    expect(result.output).toEqual({
      kind: 'value',
      envelope: { value: 'a', sourceRef: targetRef },
    });
  });

  it('reads edge values under the edge target when requested', () => {
    const rule = graph([step('keep', 'copy', [{ edgeIndex: 0 }])], { stepIndex: 0 });
    const result = evaluateMappingRule({
      rule,
      sourceValues: [source(sourceRef0, 'a')],
      edgeValueReferences: 'target',
    });
    expect(result.steps.get(0)).toMatchObject({
      kind: 'value',
      envelope: { value: 'a', sourceRef: targetRef },
    });
  });
});

describe('graph evaluation with all steps', () => {
  const rule = graph(
    [step('used', 'trim', [{ edgeIndex: 0 }]), step('spare', 'trim', [{ edgeIndex: 1 }])],
    { stepIndex: 0 }
  );
  const sourceValues = [source(sourceRef0, ' a '), source(sourceRef1, ' b ')];

  it('only traces the edges the output depends on by default', () => {
    const result = evaluateMappingRule({ rule, sourceValues });
    expect(result.steps.size).toBe(1);
    expect(
      result.trace.filter((entry) => entry.edgeId !== undefined).map((entry) => entry.edgeId)
    ).toEqual(['e0']);
  });

  it('also traces edges and steps that are not connected to the output', () => {
    const result = evaluateMappingRule({ rule, sourceValues, evaluateAllSteps: true });
    expect(result.steps.size).toBe(2);
    expect(result.steps.get(1)).toMatchObject({ kind: 'value', envelope: { value: 'b' } });
    expect(
      result.trace.filter((entry) => entry.edgeId !== undefined).map((entry) => entry.edgeId)
    ).toEqual(['e0', 'e1']);
  });

  it('traces an unreferenced edge that holds a value even without any step using it', () => {
    const lone = graph([], { edgeIndex: 0 });
    const withValues = evaluateMappingRule({ rule: lone, sourceValues, evaluateAllSteps: true });
    expect(
      withValues.trace.filter((entry) => entry.edgeId !== undefined).map((entry) => entry.edgeId)
    ).toEqual(['e0', 'e1']);
    const withoutFlag = evaluateMappingRule({ rule: lone, sourceValues });
    expect(
      withoutFlag.trace.filter((entry) => entry.edgeId !== undefined).map((entry) => entry.edgeId)
    ).toEqual(['e0']);
  });
});

describe('graph evaluation classification flow', () => {
  it('applies catalog classifications of absent edges to the step result', () => {
    const rule = graph([step('join', 'concat', [{ edgeIndex: 0 }, { edgeIndex: 1 }])], {
      stepIndex: 0,
    });
    const sourceValues = [source(sourceRef1, 'x')];
    const classify = (entries: Array<[number, RedactionClassification]>) =>
      evaluateMappingRule({
        rule,
        sourceValues,
        sourceClassifications: new Map(entries),
      });
    expect(classify([[0, 'secret']]).steps.get(0)).toMatchObject({
      kind: 'value',
      envelope: { value: 'x', classificationHint: 'secret' },
    });
    expect(classify([[1, 'pii']]).steps.get(0)).toMatchObject({
      envelope: { classificationHint: 'pii' },
    });
    expect(
      classify([
        [1, 'pii'],
        [0, 'secret'],
      ]).output
    ).toMatchObject({ kind: 'value', envelope: { classificationHint: 'secret' } });
    expect(
      classify([
        [0, 'public'],
        [1, 'token'],
      ]).output
    ).toMatchObject({ envelope: { classificationHint: 'token' } });
  });

  it('keeps the classification of an absent earlier step for later steps', () => {
    const rule = graph(
      [
        step('gone', 'trim', [{ edgeIndex: 0 }]),
        step('join', 'concat', [{ stepIndex: 0 }, { edgeIndex: 1 }]),
      ],
      { stepIndex: 1 }
    );
    const result = evaluateMappingRule({
      rule,
      sourceValues: [source(sourceRef1, 'x')],
      sourceClassifications: new Map<number, RedactionClassification>([[0, 'secret']]),
    });
    expect(result.steps.get(0)).toEqual({ kind: 'absent' });
    expect(result.output).toMatchObject({
      kind: 'value',
      envelope: { value: 'x', classificationHint: 'secret' },
    });
  });

  it('takes the strongest classification of the input values', () => {
    const rule = graph([step('join', 'concat', [{ edgeIndex: 0 }, { edgeIndex: 1 }])], {
      stepIndex: 0,
    });
    const result = evaluateMappingRule({
      rule,
      sourceValues: [
        source(sourceRef0, 'a', { classificationHint: 'secret' }),
        source(sourceRef1, 'b', { classificationHint: 'pii' }),
      ],
    });
    expect(result.output).toMatchObject({
      envelope: { value: 'ab', classificationHint: 'secret' },
    });
  });
});

describe('graph evaluation of absent inputs', () => {
  it.each([
    ['concat', undefined, 'x'],
    ['join', undefined, 'x'],
    ['array_build', undefined, ['x']],
  ] as const)('lets %s combine an absent input with a value', (operation, parameters, expected) => {
    const rule = graph(
      [step('combine', operation, [{ edgeIndex: 0 }, { edgeIndex: 1 }], parameters)],
      {
        stepIndex: 0,
      }
    );
    const result = evaluateMappingRule({ rule, sourceValues: [source(sourceRef1, 'x')] });
    expect(result.reasons).toEqual([]);
    expect(valueOf(result)).toEqual(expected);
  });

  it.each(['trim', 'case', 'copy'] as const)('propagates absence through %s', (operation) => {
    const parameters = operation === 'case' ? { mode: 'upper' } : undefined;
    const rule = graph([step('single', operation, [{ edgeIndex: 0 }], parameters)], {
      stepIndex: 0,
    });
    const result = evaluateMappingRule({ rule, sourceValues: [] });
    expect(result.output).toEqual({ kind: 'absent' });
    expect(result.trace.filter((entry) => entry.transformStepId === 'single')).toEqual([]);
  });

  it.each(['fallback', 'first'] as const)(
    'leaves %s absent without evaluating it when every input is absent',
    (operation) => {
      const rule = graph([step('pick', operation, [{ edgeIndex: 0 }, { edgeIndex: 1 }])], {
        stepIndex: 0,
      });
      const result = evaluateMappingRule({ rule, sourceValues: [] });
      expect(result.output).toEqual({ kind: 'absent' });
      expect(result.steps.get(0)).toEqual({ kind: 'absent' });
      expect(result.trace.filter((entry) => entry.transformStepId === 'pick')).toEqual([]);
      expect(result.reasons).toEqual([]);
    }
  );

  it.each(['fallback', 'first'] as const)(
    'still evaluates %s when one input has a value',
    (operation) => {
      const rule = graph([step('pick', operation, [{ edgeIndex: 0 }, { edgeIndex: 1 }])], {
        stepIndex: 0,
      });
      const result = evaluateMappingRule({ rule, sourceValues: [source(sourceRef1, 'v')] });
      expect(valueOf(result)).toBe('v');
      expect(result.trace.filter((entry) => entry.transformStepId === 'pick')).not.toEqual([]);
    }
  );
});

describe('graph evaluation of suppressed identifiers', () => {
  const identifier = step('pid', 'persistent_identifier', [], {
    input: 'account',
    format: 'plain',
    algorithm: 'authrim_sha256',
  });
  const evaluate = (suppressedIdentifiers: unknown, transforms: MappingGraphTransform[]) =>
    evaluateMappingRule({
      rule: { ...graph(transforms, { stepIndex: 0 }), edges: [] },
      sourceValues: [],
      runtimeContext: { identifiers: { pid: 'id-value' }, suppressedIdentifiers },
    });

  it('suppresses an identifier step flagged true', () => {
    expect(evaluate({ pid: true }, [identifier]).output).toEqual({ kind: 'suppressed' });
  });

  it.each([{ pid: false }, { pid: 'true' }, { pid: 1 }, { other: true }, null, 'pid', undefined])(
    'keeps the identifier when the suppression context is %j',
    (suppressed) => {
      expect(valueOf(evaluate(suppressed, [identifier]))).toBe('id-value');
    }
  );

  it('never suppresses a step that is not a persistent identifier', () => {
    const constant = step('pid', 'constant_text', [], { value: 'fixed' });
    expect(valueOf(evaluate({ pid: true }, [constant]))).toBe('fixed');
  });
});

describe('graph evaluation of failing steps', () => {
  it('marks a step that produces no value as failed and records the reason', () => {
    const rule = graph([step('number', 'text_to_number', [{ edgeIndex: 0 }], {})], {
      stepIndex: 0,
    });
    const result = evaluateMappingRule({
      rule,
      sourceValues: [source(sourceRef0, 'not a number')],
    });
    expect(result.output).toEqual({ kind: 'failed' });
    expect(result.steps.get(0)).toEqual({ kind: 'failed' });
    expect(result.reasons.map(({ code }) => code)).toEqual(['transform.invalid_output']);
  });
});

describe('graph evaluation with prepared step values', () => {
  const rule = graph(
    [
      step('prepared', 'concat', [{ edgeIndex: 0 }, { edgeIndex: 1 }]),
      step('after', 'trim', [{ stepIndex: 0 }]),
    ],
    { stepIndex: 1 }
  );
  const hintA: ProvenanceHint = { sourceId: 'account' };
  const hintB: ProvenanceHint = { sourceId: 'user' };

  function prepared(value: unknown): MappingEvaluationValue {
    return { kind: 'value', envelope: { value, sourceRef: sourceRef0 } };
  }

  it('does not report a missing hash for other failed preparations', () => {
    const result = evaluateMappingRule({
      rule,
      sourceValues: [source(sourceRef0, 'a'), source(sourceRef1, 'b')],
      preparedSteps: new Map<string, MappingEvaluationValue>([['prepared', { kind: 'failed' }]]),
    });
    expect(result.reasons).toEqual([]);
    expect(result.steps.get(0)).toEqual({ kind: 'failed' });
    expect(result.trace.map((entry) => entry.reason.code)).not.toContain(
      'transform.hash_unavailable'
    );
    expect(result.trace.filter((entry) => entry.action === 'transformed')).toEqual([]);
  });

  it('traces a prepared step unless its preparation failed', () => {
    const result = evaluateMappingRule({
      rule,
      sourceValues: [source(sourceRef0, 'a'), source(sourceRef1, 'b')],
      preparedSteps: new Map<string, MappingEvaluationValue>([['prepared', prepared('p')]]),
    });
    expect(result.trace.filter((entry) => entry.transformStepId === 'prepared')).toHaveLength(1);
    const absent = evaluateMappingRule({
      rule,
      sourceValues: [source(sourceRef0, 'a'), source(sourceRef1, 'b')],
      preparedSteps: new Map<string, MappingEvaluationValue>([['prepared', { kind: 'absent' }]]),
    });
    expect(absent.trace.filter((entry) => entry.transformStepId === 'prepared')).toHaveLength(1);
    expect(absent.steps.get(0)).toEqual({ kind: 'absent' });
  });

  it('collects the provenance of every value input of a prepared step', () => {
    const result = evaluateMappingRule({
      rule,
      sourceValues: [
        source(sourceRef0, 'a', { provenanceHint: hintA }),
        source(sourceRef1, 'b', { provenanceHints: [hintB, hintB] }),
      ],
      preparedSteps: new Map<string, MappingEvaluationValue>([['prepared', prepared('p')]]),
    });
    expect(result.steps.get(0)).toMatchObject({
      envelope: { provenanceHints: [hintA, hintB, hintB] },
    });
  });

  it('collects no provenance from inputs without hints or without a value', () => {
    const result = evaluateMappingRule({
      rule,
      sourceValues: [source(sourceRef0, 'a')],
      preparedSteps: new Map<string, MappingEvaluationValue>([['prepared', prepared('p')]]),
    });
    const entry = result.steps.get(0);
    expect(entry?.kind).toBe('value');
    expect(entry?.kind === 'value' ? entry.envelope.provenanceHints : undefined).toEqual([]);
  });

  it('collects the provenance of ordinary steps the same way', () => {
    const plain = graph([step('join', 'concat', [{ edgeIndex: 0 }, { edgeIndex: 1 }])], {
      stepIndex: 0,
    });
    const result = evaluateMappingRule({
      rule: plain,
      sourceValues: [
        source(sourceRef0, 'a', { provenanceHint: hintA }),
        source(sourceRef1, 'b', { provenanceHints: [hintB] }),
      ],
    });
    expect(result.steps.get(0)).toMatchObject({ envelope: { provenanceHints: [hintA, hintB] } });
    const missing = evaluateMappingRule({ rule: plain, sourceValues: [source(sourceRef1, 'b')] });
    const entry = missing.steps.get(0);
    expect(entry?.kind === 'value' ? entry.envelope.provenanceHints : undefined).toEqual([]);
  });

  it('charges json_build key lookups only for inputs that carry a value', () => {
    const build = graph(
      [step('build', 'json_build', [{ edgeIndex: 0 }, { edgeIndex: 1 }], { nullHandling: 'omit' })],
      { stepIndex: 0 }
    );
    const preparer = vi.fn((): MappingEvaluationValue => prepared({ k: 'v' }));
    const result = evaluateMappingRule({
      rule: build,
      sourceValues: [source(sourceRef0, 'a')],
      stepPreparers: new Map([['build', preparer]]),
    });
    expect(result.reasons).toEqual([]);
    expect(result.steps.get(0)).toMatchObject({ kind: 'value', envelope: { value: { k: 'v' } } });
  });

  it('charges the regex work of a prepared conditional step against its named inputs', () => {
    const conditional = graph(
      [
        step(
          'branch',
          'conditional',
          [
            { edgeIndex: 0, name: 'value' },
            { edgeIndex: 0, name: 'field:f' },
          ],
          {
            condition: JSON.stringify({
              kind: 'group',
              match: 'all',
              children: [{ kind: 'rule', field: 'f', operator: 'regex', value: 'a'.repeat(100) }],
            }),
            valueType: 'as_text',
            thenValue: 'yes',
            elseMode: 'fixed',
            elseValue: 'no',
          }
        ),
      ],
      { stepIndex: 0 }
    );
    const preparer = vi.fn((): MappingEvaluationValue => prepared('yes'));
    const result = evaluateMappingRule({
      rule: conditional,
      sourceValues: [source(sourceRef0, 'a'.repeat(1000))],
      stepPreparers: new Map([['branch', preparer]]),
    });
    expect(result.reasons.map((reason) => reason.code)).toEqual(['transform.work_limit_exceeded']);
    expect(result.steps.get(0)).toEqual({ kind: 'failed' });
    expect(preparer).not.toHaveBeenCalled();
  });

  it('awaits asynchronous preparation for hash steps and keeps the prepared value', async () => {
    const hashRule = graph([step('digest', 'hash', [{ edgeIndex: 0 }], { encoding: 'hex' })], {
      stepIndex: 0,
    });
    const result = await evaluatePreparedMappingRule(
      { rule: hashRule, sourceValues: [source(sourceRef0, 'a')] },
      async ({ inputs }) => {
        const first = inputs[0];
        return first?.kind === 'value'
          ? { kind: 'value', envelope: { ...first.envelope, value: 'hashed' } }
          : { kind: 'failed' };
      }
    );
    expect(valueOf(result)).toBe('hashed');
    expect(result.reasons).toEqual([]);
  });
});
