import { describe, expect, it } from 'vitest';
import {
  executeTransformStep,
  validateTransformStep,
  TRANSFORM_OPERATION_SCHEMAS,
} from '../../core/transforms';
import { evaluateMappingRule } from '../../core/graph-evaluator';
import { IDENTIFIER_POST_TRANSFORM_OPERATIONS } from '../../core/graph';
import { safeTransformPattern, TRANSFORM_LIMITS } from '../../core/transform-safety';
import { TEXT_TRANSFORM_CASES } from '../../test-support/text-transform-cases';
import type {
  FieldRef,
  MappingGraphTransform,
  MappingRuleGraph,
  MappingTransformStep,
  TransformOperation,
} from '../../core/types';

const ref: FieldRef = { side: 'source', namespace: 'csv', path: 'value' };
const target: FieldRef = { side: 'destination', namespace: 'oidc.claim', path: 'name' };
function step(
  operation: TransformOperation,
  parameters: Record<string, unknown> = {}
): MappingTransformStep {
  return { id: 'text', operation, parameters, inputEdgeIds: ['in'], outputTargetRef: target };
}
function run(
  operation: TransformOperation,
  value: unknown,
  parameters: Record<string, unknown> = {}
) {
  return executeTransformStep({
    step: step(operation, parameters),
    edgeValues: new Map([['in', { value, sourceRef: ref }]]),
  });
}
function graph(transforms: MappingGraphTransform[]): MappingRuleGraph {
  return {
    id: 'rule',
    targetRef: target,
    edges: [{ id: 'in', sourceRef: ref, targetRef: target }],
    transforms,
    output: { stepIndex: transforms.length - 1 },
  };
}
const codes = (result: ReturnType<typeof run>) => result.reasons.map((reason) => reason.code);

describe('text and value shaping', () => {
  it.each(TEXT_TRANSFORM_CASES)(
    'accepts the console demo for $operation',
    ({ operation, parameters, input, output }) => {
      expect(validateTransformStep(step(operation, parameters)).reasons).toEqual([]);
      expect(run(operation, input, parameters)).toMatchObject({
        status: 'success',
        value: { value: output },
      });
    }
  );

  it.each(TEXT_TRANSFORM_CASES)(
    'handles null, empty and array input for $operation without throwing',
    ({ operation, parameters }) => {
      for (const value of [undefined, null, '', [], ['abc', null, 2]]) {
        expect(() => run(operation, value, parameters)).not.toThrow();
        if (['text_to_number', 'date_format'].includes(operation) && !Array.isArray(value))
          expect(codes(run(operation, value, parameters))).toContain('transform.invalid_output');
      }
      expect(
        codes(executeTransformStep({ step: step(operation, parameters), edgeValues: new Map() }))
      ).toContain('transform.missing_input');
    }
  );

  it.each(
    TEXT_TRANSFORM_CASES.filter((c) => !['default_if_empty', 'has_value'].includes(c.operation))
  )('propagates graph absence for $operation', ({ operation, parameters }) => {
    const result = evaluateMappingRule({
      rule: graph([{ id: 'absent', operation, parameters, inputs: [{ edgeIndex: 0 }] }]),
      sourceValues: [],
    });
    expect(result.output).toEqual({ kind: 'absent' });
    expect(result.reasons).toEqual([]);
  });

  it.each(TEXT_TRANSFORM_CASES)(
    'caps input bytes and arrays for $operation',
    ({ operation, parameters }) => {
      expect(codes(run(operation, 'é'.repeat(17000), parameters))).toContain(
        'transform.limit_exceeded'
      );
      expect(codes(run(operation, Array(501).fill('x'), parameters))).toContain(
        'transform.limit_exceeded'
      );
    }
  );

  it('fails malformed loaded parameter containers without crashing', () => {
    for (const parameters of [false, 42, 'pattern', []]) {
      const malformed = step('regex_replace', { pattern: 'x' });
      Reflect.set(malformed, 'parameters', parameters);
      const result = executeTransformStep({
        step: malformed,
        edgeValues: new Map([['in', { value: 'x', sourceRef: ref }]]),
      });
      expect(result.value).toBeUndefined();
      expect(codes(result)).toContain('transform.invalid_parameter');
    }
  });

  it('cuts at first/last delimiter; absent or empty delimiter preserves the string', () => {
    const p = { delimiter: '/', keep: 'after', occurrence: 'last' };
    expect(run('keep_part', ['a/b/c', 'abc', null, 4], p).value?.value).toEqual([
      'c',
      'abc',
      null,
      4,
    ]);
    expect(run('keep_part', 'a/b/c', { ...p, occurrence: 'first' }).value?.value).toBe('b/c');
    expect(run('keep_part', 'abc', { ...p, delimiter: '' }).value?.value).toBe('abc');
    expect(run('keep_part', 'a/b/c', { ...p, keep: 'before' }).value?.value).toBe('a/b');
  });

  it('replaces all literal occurrences without interpreting replacement dollars or metacharacters', () => {
    expect(
      run('replace_text', ['A.Ba.b', 2], { find: 'a.b', ignoreCase: true, replacement: '$&' }).value
        ?.value
    ).toEqual(['$&$&', 2]);
    expect(run('replace_text', 'aaa', { find: '', replacement: 'x' }).value?.value).toBe('aaa');
    expect(run('remove_text', 'abab', { text: 'ab' }).value?.value).toBe('');
    expect(
      run('regex_replace', 'Abab', { pattern: '(ab)', replacement: '[$1]', ignoreCase: true }).value
        ?.value
    ).toBe('[Ab][ab]');
  });

  it('bounds capture, prefix and suffix expansion before allocating oversized output', () => {
    expect(
      run('regex_replace', 'abc', { pattern: '(b)', replacement: "$$:$&:$`:$':$1:$2:$01:$10" })
        .value?.value
    ).toBe('a$:b:a:c:b:$2:b:b0c');
    expect(run('regex_replace', 'ab', { pattern: '^', replacement: 'x' }).value?.value).toBe('xab');
    expect(
      codes(
        run('regex_replace', 'a'.repeat(1000), { pattern: 'a', replacement: '$`'.repeat(1000) })
      )
    ).toContain('transform.limit_exceeded');
  });

  it('uses explicit kana mapping and preserves non-width compatibility characters', () => {
    expect(run('to_halfwidth', 'Ａ　ガパヴ①', { katakana: true }).value?.value).toBe('A ｶﾞﾊﾟｳﾞ①');
    expect(run('to_halfwidth', 'ガ', { katakana: false }).value?.value).toBe('ガ');
    expect(run('to_halfwidth', 'カ\u3099ハ\u309a', { katakana: true }).value?.value).toBe('ｶﾞﾊﾟ');
    expect(run('to_fullwidth', 'A ｶﾞﾊﾟｳﾞ①', { katakana: true }).value?.value).toBe('Ａ　ガパヴ①');
    expect(run('to_fullwidth', 'ｶﾞ', { katakana: false }).value?.value).toBe('ｶﾞ');
    expect(run('strip_accents', 'Straße Ærø Łódź ガ كَ').value?.value).toBe(
      'Strasse AEro Lodz ガ كَ'
    );
    expect(run('ascii_digits', '٠١٢٣ ۴۵۶ １２３ १२३ 𝟡').value?.value).toBe('0123 456 123 123 9');
  });

  it.each([
    ['ﾞ', '\u3099'],
    ['ﾟ', '\u309a'],
    ['ﾞﾟ', '\u3099\u309a'],
    ['ｱﾞ', 'ア\u3099'],
    ['ｱﾟ', 'ア\u309a'],
    ['ｶﾟ', 'カ\u309a'],
    ['ｶﾞﾊﾟ', 'ガパ'],
  ])('round-trips standalone kana marks and non-composing sequences: %s', (half, full) => {
    expect(run('to_fullwidth', half, { katakana: true }).value?.value).toBe(full);
    expect(run('to_halfwidth', full, { katakana: true }).value?.value).toBe(half);
    expect(run('to_halfwidth', full, { katakana: false }).value?.value).toBe(full);
  });

  it('maps the first matching string row, with typed flags and each unmatched policy', () => {
    const p = {
      entries: '[["sls","Sales"],["sls","Ignored"]]',
      otherwise: 'as_is',
      ignoreCase: true,
    };
    expect(run('value_map', ['SLS', 'other', 3, null], p).value?.value).toEqual([
      'Sales',
      'other',
      3,
      null,
    ]);
    expect(run('value_map', 'other', { ...p, otherwise: 'none' }).value?.value).toBeNull();
    expect(
      run('value_map', 'other', { ...p, otherwise: 'fixed', fallbackValue: 'Unknown' }).value?.value
    ).toBe('Unknown');
    for (const entries of [
      '{',
      '{}',
      '[[1,"a"]]',
      '[["a"]]',
      '[["a","b","c"]]',
      JSON.stringify(Array.from({ length: TRANSFORM_LIMITS.tableRows + 1 }, () => ['a', 'b'])),
    ]) {
      expect(codes(run('value_map', 'a', { ...p, entries }))).toContain(
        'transform.invalid_parameter'
      );
    }
  });

  it('accepts decimal and integer syntax and rejects non-finite/unsafe integers', () => {
    expect(run('text_to_number', [' -3.5 ', '0042', 1.5, '0']).value?.value).toEqual([
      -3.5, 42, 1.5, 0,
    ]);
    for (const value of [
      'NaN',
      'Infinity',
      '1e4',
      '0x10',
      '+2',
      '.5',
      '',
      '9'.repeat(400),
      '9007199254740993',
      Infinity,
      NaN,
      true,
      {},
      null,
    ])
      expect(codes(run('text_to_number', value))).toContain('transform.invalid_output');
  });

  it('parses dates strictly, assumes UTC without offset, and preserves epoch milliseconds', () => {
    const p = { from: 'iso', to: 'unix_ms' };
    expect(run('date_format', '2024-02-29T12:34:56.789', p).value?.value).toBe(1709210096789);
    expect(run('date_format', '2024-02-29T21:34:56.789+09:00', p).value?.value).toBe(1709210096789);
    expect(run('date_format', '0099-01-01', { from: 'iso', to: 'date' }).value?.value).toBe(
      '0099-01-01'
    );
    expect(run('date_format', '1700000000001', { from: 'auto', to: 'unix_ms' }).value?.value).toBe(
      1700000000001
    );
    expect(run('date_format', '-0.001', { from: 'unix_s', to: 'unix_s' }).value?.value).toBe(-1);
    expect(run('date_format', 0.5, { from: 'unix_ms', to: 'iso' }).value).toBeUndefined();
    for (const value of [
      '2023-02-29',
      '2024-02-30',
      '2024-13-01',
      '2024-01-00',
      '2024-01-01T24:00:00Z',
      '2024-01-01T00:00:60Z',
      '2024-01-01T00:00:00+24:00',
      '2024-01-01T00:00:00+00:60',
      'Jan 1 2024',
      '2024-1-1',
      '0000-01-01',
      0,
    ])
      expect(codes(run('date_format', value, p))).toContain('transform.invalid_output');
    expect(codes(run('date_format', 1e100, { from: 'unix_s', to: 'date' }))).toContain(
      'transform.invalid_output'
    );
    expect(codes(run('date_format', '2024-01-01', { ...p, timeZone: 'Bad/Zone' }))).toContain(
      'transform.invalid_parameter'
    );
  });

  it('uses IANA DST rules for output and input offsets for repeated local times', () => {
    const p = { from: 'iso', to: 'iso', timeZone: 'America/New_York' };
    for (const [input, output] of [
      ['2024-03-10T06:59:59Z', '2024-03-10T01:59:59-05:00'],
      ['2024-03-10T07:00:00Z', '2024-03-10T03:00:00-04:00'],
      ['2024-11-03T05:30:00Z', '2024-11-03T01:30:00-04:00'],
      ['2024-11-03T06:30:00Z', '2024-11-03T01:30:00-05:00'],
    ])
      expect(run('date_format', input, p).value?.value).toBe(output);
    expect(run('date_format', '2024-01-01T00:00:00Z', { ...p, to: 'date' }).value?.value).toBe(
      '2023-12-31'
    );
  });

  it('refuses ISO output with historical second-based zone offsets', () => {
    const parameters = { from: 'iso', to: 'iso', timeZone: 'Europe/Paris' };
    expect(codes(run('date_format', '1900-01-01T00:00:00Z', parameters))).toContain(
      'transform.invalid_output'
    );
    expect(
      run('date_format', '1900-01-01T00:00:00Z', { ...parameters, to: 'date' }).value?.value
    ).toBe('1900-01-01');
  });

  it('filters string items, preserving order and duplicates in every matching mode', () => {
    for (const how of ['starts_with', 'ends_with', 'contains', 'equals', 'regex']) {
      const match = how === 'regex' ? '^app$' : 'app';
      const p = { how, match, ignoreCase: true };
      expect(run('filter_values', ['App', null, 'other', 'App', 2], p).value?.value).toEqual([
        'App',
        'App',
      ]);
      expect(
        run('filter_values', ['App', null, 'other', 2], { ...p, exclude: true }).value?.value
      ).toEqual(['other']);
      expect(run('filter_values', 'App', p).value?.value).toEqual(['App']);
      expect(run('filter_values', null, p).value?.value).toEqual([]);
    }
  });

  it('distinguishes empty from whitespace, false, zero, and nonempty arrays', () => {
    for (const v of [undefined, null, '', []]) {
      expect(run('has_value', v).value?.value).toBe(false);
      expect(run('has_value', v, { invert: true }).value?.value).toBe(true);
      expect(run('default_if_empty', v, { value: 'en' }).value?.value).toBe('en');
      expect(run('normalize_empty', v, { emptyAs: 'fixed', emptyValue: 'x' }).value?.value).toBe(
        'x'
      );
    }
    for (const v of [false, 0, ' ', ['']]) {
      expect(run('has_value', v).value?.value).toBe(true);
      expect(run('default_if_empty', v, { value: 'en' }).value?.value).toEqual(v);
    }
    expect(run('normalize_empty', '　 ', { spaces: true, emptyAs: 'empty' }).value?.value).toBe('');
    expect(run('normalize_empty', ' ', { spaces: false, emptyAs: 'none' }).value?.value).toBe(' ');
  });

  it.each(['default_if_empty', 'has_value'])('consumes graph absence for %s', (operation) => {
    const op: TransformOperation = operation === 'has_value' ? 'has_value' : 'default_if_empty';
    const result = evaluateMappingRule({
      rule: graph([
        {
          id: 'empty',
          operation: op,
          inputs: [{ edgeIndex: 0 }],
          parameters: op === 'default_if_empty' ? { value: 'en' } : {},
        },
      ]),
      sourceValues: [],
    });
    expect(result.output).toMatchObject({
      kind: 'value',
      envelope: { value: op === 'default_if_empty' ? 'en' : false },
    });
  });

  it.each(TEXT_TRANSFORM_CASES)(
    'validates arity and typed parameters for $operation',
    ({ operation, parameters }) => {
      expect(
        validateTransformStep({ ...step(operation, parameters), inputEdgeIds: [] }).reasons.map(
          (r) => r.code
        )
      ).toContain('transform.invalid_arity');
      expect(
        validateTransformStep({
          ...step(operation, parameters),
          inputEdgeIds: ['a', 'b'],
        }).reasons.map((r) => r.code)
      ).toContain('transform.invalid_arity');
      for (const param of TRANSFORM_OPERATION_SCHEMAS.find(
        (schema) => schema.operation === operation
      )?.parameters ?? []) {
        expect(run(operation, 'x', { ...parameters, [param.name]: [] }).value).toBeUndefined();
      }
    }
  );
});

describe('text safety and identifier boundaries', () => {
  it.each([
    '(a+)+$',
    '(a|aa)+$',
    'a+a+',
    '(a)\\1',
    '(?<x>a)',
    '(?=a)',
    '(?!a)',
    '(?<=a)',
    '(?<!a)',
    'a{100000}',
    'a**',
    '[',
    'a'.repeat(513),
    '\\u0061+',
    '(a|b)',
  ])('refuses unsafe regex %s at validation and execution', (pattern) => {
    expect(safeTransformPattern(pattern)).toBe(false);
    for (const [operation, parameters] of [
      ['regex_replace', { pattern }],
      ['filter_values', { how: 'regex', match: pattern }],
    ] satisfies [TransformOperation, Record<string, unknown>][]) {
      expect(
        validateTransformStep(step(operation, parameters)).reasons.map((r) => r.code)
      ).toContain('transform.unsafe_regex');
      expect(codes(run(operation, 'a'.repeat(100), parameters))).toContain(
        'transform.unsafe_regex'
      );
    }
  });

  it('caps bytes, arrays, tables, regex input and output for new and existing operations', () => {
    for (const operation of [
      'copy',
      'trim',
      'affix_text',
      'ascii_digits',
    ] satisfies TransformOperation[]) {
      expect(codes(run(operation, 'é'.repeat(17000)))).toContain('transform.limit_exceeded');
      expect(codes(run(operation, Array(501).fill('x')))).toContain('transform.limit_exceeded');
    }
    expect(
      codes(
        run('copy', [
          ...Array.from({ length: 400 }, () => 1.2345678901234567e-200),
          'x'.repeat(24000),
        ])
      )
    ).toContain('transform.limit_exceeded');
    expect(codes(run('regex_replace', 'x'.repeat(1025), { pattern: 'x' }))).toContain(
      'transform.limit_exceeded'
    );
    expect(codes(run('filter_values', ['x'.repeat(1025)], { how: 'regex', match: 'x' }))).toContain(
      'transform.limit_exceeded'
    );
    expect(
      codes(run('replace_text', 'x'.repeat(40), { find: 'x', replacement: 'y'.repeat(1000) }))
    ).toContain('transform.limit_exceeded');
    expect(
      codes(
        run('value_map', 'x', {
          entries: JSON.stringify([['x', 'a'.repeat(17000)]]),
          otherwise: 'as_is',
        })
      )
    ).toContain('transform.invalid_parameter');
  });

  it('applies output caps to caller-prepared steps too', () => {
    const rule = graph([{ id: 'prepared', operation: 'trim', inputs: [{ edgeIndex: 0 }] }]);
    const result = evaluateMappingRule({
      rule,
      sourceValues: [{ value: 'x', sourceRef: ref }],
      preparedSteps: new Map([
        ['prepared', { kind: 'value', envelope: { value: 'x'.repeat(33000), sourceRef: target } }],
      ]),
    });
    expect(result.output.kind).toBe('failed');
    expect(result.reasons.map((r) => r.code)).toContain('transform.limit_exceeded');
  });

  it('charges work cumulatively per rule and never resets it between steps', () => {
    const transforms: MappingGraphTransform[] = Array.from({ length: 8 }, (_, index) => ({
      id: String(index),
      operation: 'regex_replace',
      parameters: { pattern: 'a+', replacement: 'a'.repeat(900) },
      inputs: index === 0 ? [{ edgeIndex: 0 }] : [{ stepIndex: index - 1 }],
    }));
    const result = evaluateMappingRule({
      rule: graph(transforms),
      sourceValues: [{ value: 'a'.repeat(900), sourceRef: ref }],
    });
    expect(result.output.kind).toBe('failed');
    expect(result.reasons.map((r) => r.code)).toContain('transform.work_limit_exceeded');
  });

  const identifier: MappingGraphTransform = {
    id: 'pid',
    operation: 'persistent_identifier',
    inputs: [],
    parameters: { input: 'account', format: 'plain', algorithm: 'authrim_sha256' },
  };
  it.each(
    TEXT_TRANSFORM_CASES.filter((c) => IDENTIFIER_POST_TRANSFORM_OPERATIONS.includes(c.operation))
  )(
    'allows registered $operation after an identifier',
    ({ operation, parameters, input, output }) => {
      const g = graph([
        identifier,
        { id: 'post', operation, parameters, inputs: [{ stepIndex: 0 }] },
      ]);
      expect(
        evaluateMappingRule({
          rule: g,
          sourceValues: [],
          runtimeContext: { identifiers: { pid: input } },
        }).output
      ).toMatchObject({ kind: 'value', envelope: { value: output } });
    }
  );
  it.each(
    TEXT_TRANSFORM_CASES.filter((c) =>
      ['default_if_empty', 'has_value', 'value_map'].includes(c.operation)
    )
  )('refuses $operation after an identifier', ({ operation, parameters }) => {
    const result = evaluateMappingRule({
      rule: graph([identifier, { id: 'bad', operation, parameters, inputs: [{ stepIndex: 0 }] }]),
      sourceValues: [],
      runtimeContext: { identifiers: { pid: 'id' } },
    });
    expect(result.output.kind).toBe('failed');
    expect(result.reasons.map((r) => r.code)).toContain(
      'transform.identifier_post_transform_not_allowed'
    );
  });
});
