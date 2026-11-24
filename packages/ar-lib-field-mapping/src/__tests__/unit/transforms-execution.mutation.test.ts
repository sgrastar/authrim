import { describe, expect, it } from 'vitest';
import { executeTransformStep, validateTransformStep } from '../../core/transforms';
import type { MappingTransformStep, ReasonCode, TransformOperation } from '../../core/types';
import { run, target } from './transforms-run.helper';

const codes = (reasons: ReasonCode[]) => reasons.map((item) => item.code);

describe('persistent_identifier execution', () => {
  const settings = { input: 'account', format: 'plain', algorithm: 'authrim_sha256' };
  const runPid = (
    runtimeContext?: Record<string, unknown>,
    parameters: Record<string, unknown> = settings
  ) => run('persistent_identifier', [], parameters, { id: 'pid', runtimeContext });

  it('releases the identifier prepared for the step', () => {
    const result = runPid({ identifiers: { pid: 'abc123', other: 'zzz' } });
    expect(result.status).toBe('success');
    expect(result.reasons).toEqual([]);
    expect(result.value?.value).toBe('abc123');
    expect(result.value?.sourceRef).toEqual(target);
    expect(result.trace.map((entry) => entry.reason.code)).toEqual(['trace.transform_evaluated']);
  });

  it.each([
    ['no runtime context', undefined],
    ['no identifiers', {}],
    ['another step id', { identifiers: { other: 'x' } }],
    ['an empty identifier', { identifiers: { pid: '' } }],
    ['a non-string identifier', { identifiers: { pid: 5 } }],
    ['an array of identifiers', { identifiers: Object.assign(['x'], { pid: 'x' }) }],
    ['a text collection', { identifiers: 'pid' }],
  ])('stops the release with %s', (_label, runtimeContext) => {
    const result = runPid(runtimeContext);
    expect(codes(result.reasons)).toEqual(['transform.identifier_unavailable']);
    expect(result.status).toBe('failed');
    expect(result.value).toBeUndefined();
    expect(result.trace.map((entry) => entry.reason.code)).toEqual([
      'transform.identifier_unavailable',
    ]);
    expect(result.trace[0]?.transformStepId).toBe('pid');
  });

  it('releases nothing, without an error, when an exception suppressed the identifier', () => {
    const result = runPid({
      identifiers: { pid: 'abc123' },
      suppressedIdentifiers: { pid: true },
    });
    expect(result.status).toBe('success');
    expect(result.reasons).toEqual([]);
    expect(result.trace).toEqual([]);
    expect(result.value).toBeUndefined();
  });

  it('suppresses only on an exact true flag for this step in a plain object', () => {
    const identifiers = { pid: 'abc123' };
    for (const flag of [false, 'true', 1, null, undefined]) {
      const result = runPid({ identifiers, suppressedIdentifiers: { pid: flag } });
      expect(result.value?.value).toBe('abc123');
    }
    expect(runPid({ identifiers, suppressedIdentifiers: { other: true } }).value?.value).toBe(
      'abc123'
    );
    expect(
      runPid({ identifiers, suppressedIdentifiers: Object.assign([true], { pid: true }) }).value
        ?.value
    ).toBe('abc123');
    expect(runPid({ identifiers, suppressedIdentifiers: 'pid' }).value?.value).toBe('abc123');
  });

  it('stops the release when the settings can never make an identifier', () => {
    const result = runPid(
      { identifiers: { pid: 'abc123' } },
      { ...settings, format: 'saml_subject_id' }
    );
    expect(codes(result.reasons)).toEqual(['transform.identifier_unavailable']);
    expect(result.status).toBe('failed');
    expect(result.value).toBeUndefined();
  });

  it('adds the identifier failure to schema errors of the step', () => {
    const missing = runPid({ identifiers: { pid: 'abc123' } }, { format: 'plain' });
    expect(codes(missing.reasons)).toEqual([
      'transform.missing_parameter',
      'transform.missing_parameter',
      'transform.identifier_unavailable',
    ]);
    const step: MappingTransformStep = {
      id: 'pid',
      inputEdgeIds: ['edge-0'],
      operation: 'persistent_identifier',
      parameters: settings,
      outputTargetRef: target,
    };
    const withEdge = executeTransformStep({
      step,
      edgeValues: new Map([['edge-0', { value: 'x', sourceRef: target }]]),
      runtimeContext: { identifiers: { pid: 'abc123' } },
    });
    expect(codes(withEdge.reasons)).toEqual([
      'transform.invalid_arity',
      'transform.identifier_unavailable',
    ]);
    expect(withEdge.value).toBeUndefined();
  });

  it('does not add the identifier failure to other operations', () => {
    const result = run('case', ['A'], {});
    expect(codes(result.reasons)).toEqual(['transform.missing_parameter']);
    expect(result.status).toBe('partial');
  });
});

describe('execution outcome', () => {
  it('reports a missing input edge value', () => {
    const step: MappingTransformStep = {
      id: 's',
      inputEdgeIds: ['edge-0', 'edge-1'],
      operation: 'concat',
      outputTargetRef: target,
    };
    const result = executeTransformStep({
      step,
      edgeValues: new Map([['edge-0', { value: 'a', sourceRef: target }]]),
    });
    expect(codes(result.reasons)).toEqual(['transform.missing_input']);
    expect(result.status).toBe('partial');
    expect(result.value).toBeUndefined();
    expect(result.trace.map((entry) => entry.transformStepId)).toEqual(['s']);
  });

  it('does not run steps that fail validation', () => {
    const result = run('concat', [], undefined);
    expect(codes(result.reasons)).toEqual(['transform.invalid_arity']);
    expect(result.value).toBeUndefined();
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]?.transformStepId).toBe('transform.concat');
    expect(result.trace[0]?.reason.code).toBe('transform.invalid_arity');
  });

  it('keeps running through warnings and reports them as a partial result', () => {
    const result = run('trim', [' a '], { bogus: 1 });
    expect(codes(result.reasons)).toEqual(['transform.unknown_parameter']);
    expect(result.status).toBe('partial');
    expect(result.value?.value).toBe('a');
    expect(result.trace.map((entry) => entry.reason.code)).toEqual([
      'transform.unknown_parameter',
      'trace.transform_evaluated',
    ]);
  });

  it('carries the first source metadata and describes the evaluation in the trace', () => {
    const result = run('concat', ['a', 'b'], undefined, {
      envelopes: [
        {
          value: 'a',
          sourceRef: { side: 'source', namespace: 'csv', path: 'first' },
          metadata: { sourceType: 'csv', fieldPath: 'first' },
          classificationHint: 'pii',
          provenanceHint: { sourceId: 'first-source', trustHint: 'high' },
        },
        {
          value: 'b',
          sourceRef: { side: 'source', namespace: 'csv', path: 'second' },
          metadata: { sourceType: 'csv', fieldPath: 'second' },
          classificationHint: 'public',
        },
      ],
    });
    expect(result.status).toBe('success');
    expect(result.value).toEqual({
      value: 'ab',
      sourceRef: target,
      metadata: { sourceType: 'csv', fieldPath: 'first' },
      classificationHint: 'pii',
      provenanceHint: { sourceId: 'first-source', trustHint: 'high' },
    });
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      action: 'transformed',
      transformStepId: 'transform.concat',
      fieldRef: target,
      reason: { code: 'trace.transform_evaluated' },
    });
  });

  it('spends the work budget it is given', () => {
    const budget = { remaining: 1000 };
    const result = run('trim', ['abc'], undefined, { workBudget: budget });
    expect(result.status).toBe('success');
    // input: bytes 8 -> (8 + 1) * (2 + 1) = 27; output 'abc': 5
    expect(budget.remaining).toBe(1000 - 27 - 5);
  });

  it('fails with the work-limit reason when the budget cannot cover the step', () => {
    const budget = { remaining: 26 };
    const result = run('trim', ['abc'], undefined, { workBudget: budget });
    expect(codes(result.reasons)).toEqual(['transform.work_limit_exceeded']);
    expect(result.value).toBeUndefined();
    expect(budget.remaining).toBe(26);
    const tight = { remaining: 32 };
    expect(codes(run('trim', ['abc'], undefined, { workBudget: tight }).reasons)).toEqual([]);
    expect(tight.remaining).toBe(0);
    expect(
      codes(run('trim', ['abc'], undefined, { workBudget: { remaining: 31 } }).reasons)
    ).toEqual(['transform.work_limit_exceeded']);
  });

  it('maps unexpected errors to an invalid output', () => {
    const result = run('json_build', [1n, 2n], { nullHandling: 'omit' });
    expect(codes(result.reasons)).toEqual(['transform.invalid_output']);
    expect(result.status).toBe('partial');
    expect(result.value).toBeUndefined();
  });

  it('refuses the hash operation', () => {
    const result = run('hash', ['abc'], { encoding: 'hex' });
    expect(codes(result.reasons)).toEqual(['transform.hash_unavailable']);
  });
});

describe('output validity', () => {
  it('rejects values that do not match the declared output type', () => {
    expect(codes(run('trim', [5]).reasons)).toEqual(['transform.invalid_output']);
    expect(codes(run('trim', [true]).reasons)).toEqual(['transform.invalid_output']);
    expect(codes(run('case', [5], { mode: 'upper' }).reasons)).toEqual([
      'transform.invalid_output',
    ]);
    expect(codes(run('constant_boolean', [], { value: true }).reasons)).toEqual([]);
    expect(codes(run('json_extract_integer', ['9'.repeat(400)], { path: 'a' }).reasons)).toEqual(
      []
    );
    expect(
      codes(run('json_extract_integer', [`{"a":"${'9'.repeat(400)}"}`], { path: 'a' }).reasons)
    ).toEqual(['transform.invalid_output']);
  });

  it('rejects arrays for single-valued outputs but allows them for json', () => {
    expect(codes(run('trim', [['a', 'b']]).reasons)).toEqual(['transform.invalid_output']);
    expect(codes(run('case', [['a']], { mode: 'lower' }).reasons)).toEqual([
      'transform.invalid_output',
    ]);
    const result = run('json_build', ['[1,2]'], { nullHandling: 'omit' });
    expect(result.value?.value).toEqual([1, 2]);
  });

  it('accepts null for every declared type', () => {
    expect(run('trim', [null]).value?.value).toBeNull();
    expect(run('json_extract_integer', ['{"a":null}'], { path: 'a' }).value?.value).toBeNull();
    expect(run('json_extract_boolean', ['{"a":null}'], { path: 'a' }).value?.value).toBeNull();
    expect(run('json_extract_text', ['{"a":null}'], { path: 'a' }).value?.value).toBeNull();
    expect(run('json_build', [null], { nullHandling: 'omit' }).value?.value).toEqual({});
  });

  it('checks the json output shape and budget', () => {
    const tooLong = 'x'.repeat(2049);
    expect(codes(run('json_build', [tooLong], { nullHandling: 'omit' }).reasons)).toEqual([
      'transform.invalid_output',
    ]);
    const exact = 'x'.repeat(2048);
    expect(run('json_build', [exact], { nullHandling: 'omit' }).value?.value).toEqual({
      field_0: exact,
    });
  });

  it('validates the number output of text-free operations', () => {
    expect(run('constant_number', [], { value: 5 }).value?.value).toBe(5);
    expect(run('json_extract_integer', ['{"a":7}'], { path: 'a' }).value?.value).toBe(7);
  });
});

describe('validateTransformStep results', () => {
  const step = (overrides: Partial<MappingTransformStep>): MappingTransformStep => ({
    id: 's',
    inputEdgeIds: ['e'],
    operation: 'trim',
    outputTargetRef: target,
    ...overrides,
  });

  it('classifies operations, arities and parameters', () => {
    expect(codes(validateTransformStep(step({ operation: 'nope' as never })).reasons)).toEqual([
      'transform.unsupported_operation',
    ]);
    expect(codes(validateTransformStep(step({ inputEdgeIds: [] })).reasons)).toEqual([
      'transform.invalid_arity',
    ]);
    expect(codes(validateTransformStep(step({ inputEdgeIds: ['a', 'b'] })).reasons)).toEqual([
      'transform.invalid_arity',
    ]);
    expect(
      codes(validateTransformStep(step({ operation: 'concat', inputEdgeIds: ['a', 'b'] })).reasons)
    ).toEqual([]);
    expect(
      codes(
        validateTransformStep(step({ parameters: [] as unknown as Record<string, unknown> }))
          .reasons
      )
    ).toEqual(['transform.invalid_parameter']);
    expect(codes(validateTransformStep(step({ parameters: { x: 1, y: 2 } })).reasons)).toEqual([
      'transform.unknown_parameter',
      'transform.unknown_parameter',
    ]);
    expect(validateTransformStep(step({ parameters: { x: 1 } })).status).toBe('partial');
    expect(validateTransformStep(step({})).status).toBe('success');
  });

  it('classifies values per parameter kind', () => {
    const constant = (operation: TransformOperation, value: unknown) =>
      codes(
        validateTransformStep(step({ operation, inputEdgeIds: [], parameters: { value } })).reasons
      );
    expect(constant('constant_text', 'a')).toEqual([]);
    expect(constant('constant_text', 5)).toEqual(['transform.invalid_parameter']);
    expect(constant('constant_text', 'x'.repeat(2048))).toEqual([]);
    expect(constant('constant_text', 'x'.repeat(2049))).toEqual(['transform.invalid_parameter']);
    expect(constant('constant_boolean', false)).toEqual([]);
    expect(constant('constant_boolean', 'true')).toEqual(['transform.invalid_parameter']);
    expect(constant('constant_number', 0)).toEqual([]);
    expect(constant('constant_number', Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(constant('constant_number', Number.MAX_SAFE_INTEGER + 2)).toEqual([
      'transform.invalid_parameter',
      'transform.invalid_parameter',
    ]);
    expect(constant('constant_number', Number.NaN)).toEqual([
      'transform.invalid_parameter',
      'transform.invalid_parameter',
    ]);
    expect(constant('constant_number', '5')).toEqual([
      'transform.invalid_parameter',
      'transform.invalid_parameter',
    ]);
    expect(constant('constant_number', 1.5)).toEqual([]);
  });

  it('classifies enum parameters', () => {
    const mode = (value: unknown) =>
      codes(
        validateTransformStep(step({ operation: 'case', parameters: { mode: value } })).reasons
      );
    expect(mode('upper')).toEqual([]);
    expect(mode('UPPER')).toEqual(['transform.invalid_parameter']);
    expect(mode(5)).toEqual(['transform.invalid_parameter']);
  });

  it('sizes the keyMap, path and generic string parameters', () => {
    const build = (keyMap: string) =>
      codes(
        validateTransformStep(
          step({ operation: 'json_build', parameters: { nullHandling: 'omit', keyMap } })
        ).reasons
      );
    expect(build('x'.repeat(4096))).toEqual([]);
    expect(build('x'.repeat(4097))).toEqual(['transform.invalid_parameter']);
    const affix = (prefix: string) =>
      codes(
        validateTransformStep(step({ operation: 'affix_text', parameters: { prefix } })).reasons
      );
    expect(affix('x'.repeat(2048))).toEqual([]);
    expect(affix('x'.repeat(2049))).toEqual(['transform.invalid_parameter']);
    const path = (value: string) =>
      codes(
        validateTransformStep(step({ operation: 'json_extract_text', parameters: { path: value } }))
          .reasons
      );
    expect(path('a'.repeat(512))).toEqual([]);
    expect(path('a'.repeat(513))).toEqual(['transform.invalid_parameter']);
  });

  it('sizes the entries table and the condition by bytes', () => {
    const entries = (size: number) => {
      const base = '[["a","b"]]';
      return base + ' '.repeat(size - base.length);
    };
    const valueMap = (text: string) =>
      codes(
        validateTransformStep(
          step({ operation: 'value_map', parameters: { entries: text, otherwise: 'as_is' } })
        ).reasons
      );
    expect(valueMap(entries(16384))).toEqual([]);
    expect(valueMap(entries(16385))).toEqual([
      'transform.invalid_parameter',
      'transform.invalid_parameter',
    ]);

    const conditionJson = JSON.stringify({ kind: 'rule', field: 'a', operator: 'eq', value: 'x' });
    const conditional = (condition: string) =>
      codes(
        validateTransformStep(
          step({
            operation: 'conditional',
            inputEdgeIds: ['a', 'b'],
            inputNames: ['value', 'field:a'],
            parameters: {
              condition,
              valueType: 'as_text',
              elseMode: 'as_is',
              thenValue: 'y',
            },
          })
        ).reasons
      );
    expect(conditional(conditionJson + ' '.repeat(16384 - conditionJson.length))).toEqual([]);
    expect(conditional(conditionJson + ' '.repeat(16385 - conditionJson.length))).toEqual([
      'transform.invalid_parameter',
      'transform.invalid_parameter',
    ]);
    const multiByte = conditionJson + 'é'.repeat(8192 - Math.ceil(conditionJson.length / 2) + 1);
    expect(new TextEncoder().encode(multiByte).length).toBeGreaterThan(16384);
    expect(multiByte.length).toBeLessThan(16384);
    expect(conditional(multiByte)).toEqual([
      'transform.invalid_parameter',
      'transform.invalid_parameter',
    ]);
  });
});
