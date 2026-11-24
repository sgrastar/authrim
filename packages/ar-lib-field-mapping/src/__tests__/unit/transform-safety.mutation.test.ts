import { describe, expect, it } from 'vitest';
import {
  TRANSFORM_LIMITS,
  TransformFailure,
  chargeTransformInput,
  chargeTransformOutput,
  failTransform,
  jsonBuildSourceKeys,
  measureTransformValue,
  safeRegexTest,
  safeTransformPattern,
  transformWork,
} from '../../core/transform-safety';
import type {
  MappingTransformStep,
  SourceValueEnvelope,
  TransformOperation,
} from '../../core/types';

const target = { side: 'canonical' as const, namespace: 'authrim.profile', path: 'result' };

function step(
  operation: TransformOperation,
  parameters?: Record<string, unknown>,
  inputEdgeIds: string[] = ['e0'],
  inputNames?: (string | undefined)[]
): MappingTransformStep {
  return { id: 's', inputEdgeIds, inputNames, operation, parameters, outputTargetRef: target };
}

function failureCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof TransformFailure) return error.code;
    throw error;
  }
  return undefined;
}

function nested(levels: number): unknown {
  let value: unknown = [];
  for (let i = 1; i < levels; i++) value = [value];
  return value;
}

function sourceWithPath(path: string): SourceValueEnvelope {
  return { value: 'v', sourceRef: { side: 'source', namespace: 'csv', path } };
}

describe('TransformFailure', () => {
  it('carries the reason code as code and message', () => {
    const error = new TransformFailure('transform.limit_exceeded');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('transform.limit_exceeded');
    expect(error.message).toBe('transform.limit_exceeded');
    expect(failureCode(() => failTransform('transform.work_limit_exceeded'))).toBe(
      'transform.work_limit_exceeded'
    );
  });
});

describe('measureTransformValue exact sizes', () => {
  it('measures scalars', () => {
    expect(measureTransformValue('abc')).toBe(5);
    expect(measureTransformValue('é')).toBe(4);
    expect(measureTransformValue(12345)).toBe(5);
    expect(measureTransformValue(-1.5)).toBe(4);
    expect(measureTransformValue(true)).toBe(8);
    expect(measureTransformValue(false)).toBe(8);
    expect(measureTransformValue(null)).toBe(8);
    expect(measureTransformValue(undefined)).toBe(8);
  });

  it('measures arrays and objects including framing', () => {
    expect(measureTransformValue([])).toBe(2);
    expect(measureTransformValue(['abc'])).toBe(8);
    expect(measureTransformValue([1, 2])).toBe(6);
    expect(measureTransformValue({})).toBe(2);
    expect(measureTransformValue({ a: 1 })).toBe(11);
  });

  it('allows the same object to appear twice as a sibling but rejects true cycles', () => {
    const shared = [1];
    expect(measureTransformValue([shared, shared])).toBe(12);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(failureCode(() => measureTransformValue(cyclic))).toBe('transform.limit_exceeded');
  });

  it('accepts exactly the maximum byte size and rejects one more', () => {
    expect(TRANSFORM_LIMITS.valueBytes).toBe(32768);
    expect(measureTransformValue('a'.repeat(32766))).toBe(32768);
    expect(failureCode(() => measureTransformValue('a'.repeat(32767)))).toBe(
      'transform.limit_exceeded'
    );
  });

  it('counts multi-byte characters by encoded size', () => {
    expect(failureCode(() => measureTransformValue('é'.repeat(16384)))).toBe(
      'transform.limit_exceeded'
    );
    expect(measureTransformValue('é'.repeat(16383))).toBe(32768);
  });

  it('accepts exactly 500 items and rejects 501', () => {
    expect(measureTransformValue(Array.from({ length: 500 }, () => 1))).toBe(1002);
    expect(failureCode(() => measureTransformValue(Array.from({ length: 501 }, () => 1)))).toBe(
      'transform.limit_exceeded'
    );
    expect(
      failureCode(() =>
        measureTransformValue(
          Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`k${i}`, 1]))
        )
      )
    ).toBe('transform.limit_exceeded');
  });

  it('accepts exactly 1000 nodes and rejects 1001', () => {
    const ok = [Array.from({ length: 499 }, () => 1), Array.from({ length: 498 }, () => 1)];
    expect(measureTransformValue(ok)).toBe(4 + 1000 + 998);
    const tooMany = [Array.from({ length: 499 }, () => 1), Array.from({ length: 499 }, () => 1)];
    expect(failureCode(() => measureTransformValue(tooMany))).toBe('transform.limit_exceeded');
  });

  it('accepts depth 12 and rejects depth 13', () => {
    expect(measureTransformValue(nested(13))).toBe(38);
    expect(failureCode(() => measureTransformValue(nested(14)))).toBe('transform.limit_exceeded');
  });
});

describe('safeTransformPattern', () => {
  const accepted = [
    'abc',
    '^a+$',
    'a|b',
    '[a-z]+',
    '(ab)',
    '(a)b*',
    '\\.',
    '\\d+',
    '\\\\',
    '[(]',
    '[{}]',
    'a?',
    'a*',
    'a+',
    'a+b',
    '^abc$',
  ];
  const rejected = [
    '',
    'a\\',
    '\\1',
    '\\k',
    '\\p',
    '\\P',
    '\\0',
    '\\u0041',
    '\\x41',
    '\\cJ',
    '\\-',
    'a]',
    '(?:a)',
    '(a',
    'a)',
    '(a|b)',
    '(a)*',
    '(a)+',
    'a{2}',
    'a{2,3}',
    '*a',
    'a**',
    'a+b*',
    'a+b+',
    'a*b*',
    'a?b?',
    'a+?',
    '[a',
    'a|b)(',
  ];

  it.each(accepted)('accepts %s', (pattern) => {
    expect(safeTransformPattern(pattern)).toBe(true);
  });

  it.each(rejected)('rejects %s', (pattern) => {
    expect(safeTransformPattern(pattern)).toBe(false);
  });

  it('allows up to 512 characters and rejects 513', () => {
    expect(safeTransformPattern('a'.repeat(512))).toBe(true);
    expect(safeTransformPattern('a'.repeat(513))).toBe(false);
  });
});

describe('safeRegexTest', () => {
  it('matches safe patterns and returns exactly false for non-matches', () => {
    expect(safeRegexTest('a+', 'baab')).toBe(true);
    expect(safeRegexTest('^a+$', 'baab')).toBe(false);
  });

  it('honours the ignoreCase flag', () => {
    expect(safeRegexTest('abc', 'ABC')).toBe(false);
    expect(safeRegexTest('abc', 'ABC', false)).toBe(false);
    expect(safeRegexTest('abc', 'ABC', true)).toBe(true);
  });

  it('refuses unsafe patterns without evaluating them', () => {
    expect(safeRegexTest('(a)*', 'aaa')).toBe(false);
    expect(safeRegexTest('a+b+', 'aab')).toBe(false);
  });

  it('refuses inputs longer than 1024 characters but accepts exactly 1024', () => {
    expect(safeRegexTest('a+', 'a'.repeat(1024))).toBe(true);
    expect(safeRegexTest('a+', 'a'.repeat(1025))).toBe(false);
  });

  it('uses unicode mode', () => {
    expect(safeRegexTest('^.$', '😀')).toBe(true);
  });
});

describe('transformWork exact charges', () => {
  it('charges bytes times parameter size for plain operations', () => {
    // measure({}) = 2, so (bytes + 1) * 3
    expect(transformWork(step('trim'), 'abc', 5)).toBe(18);
    expect(transformWork(step('trim', undefined), 'abc', 9)).toBe(30);
    // measure({a:1}) = 11
    expect(transformWork(step('trim', { a: 1 }), 'abc', 5)).toBe(72);
  });

  it('adds quadratic regex work for regex_replace string items', () => {
    const regexStep = step('regex_replace', { pattern: 'a+', replacement: 'x' });
    // measure(params) = 41 -> (5 + 1) * 42 = 252; regex: (3 + 1)^2 * (2 + 1) = 48
    expect(transformWork(regexStep, 'abc', 5)).toBe(300);
    // array values: items 'ab' and 'abcd', non strings ignored
    expect(transformWork(regexStep, ['ab', 7, 'abcd', null], 5)).toBe(252 + 27 + 75);
  });

  it('accepts a regex input of exactly 1024 characters and rejects 1025', () => {
    const regexStep = step('regex_replace', { pattern: 'a+', replacement: 'x' });
    expect(transformWork(regexStep, 'a'.repeat(1024), 0)).toBe(42 + 1025 ** 2 * 3);
    expect(failureCode(() => transformWork(regexStep, 'a'.repeat(1025), 0))).toBe(
      'transform.limit_exceeded'
    );
  });

  it('charges filter_values regex matches only for how=regex', () => {
    const regexFilter = step('filter_values', { how: 'regex', match: 'b+' });
    const params = measureTransformValue({ how: 'regex', match: 'b+' });
    expect(transformWork(regexFilter, ['abc'], 5)).toBe(6 * (params + 1) + 16 * 3);
    const equalsFilter = step('filter_values', { how: 'equals', match: 'b+' });
    const equalsParams = measureTransformValue({ how: 'equals', match: 'b+' });
    expect(transformWork(equalsFilter, ['abc'], 5)).toBe(6 * (equalsParams + 1));
  });

  it('does not treat other operations carrying how=regex or a match string as regex work', () => {
    const other = step('trim', { how: 'regex', match: 'b+' });
    const params = measureTransformValue({ how: 'regex', match: 'b+' });
    expect(transformWork(other, 'abc', 5)).toBe(6 * (params + 1));
    const nonString = step('filter_values', { how: 'regex', match: 5 });
    const nonStringParams = measureTransformValue({ how: 'regex', match: 5 });
    expect(transformWork(nonString, 'abc', 5)).toBe(6 * (nonStringParams + 1));
  });

  describe('conditional', () => {
    const condition = JSON.stringify({
      kind: 'rule',
      field: 'a',
      operator: 'regex',
      value: 'b+',
    });
    const base = (bytes: number) => (bytes + 1) * (measureTransformValue({ condition }) + 1);

    it('adds regex work of the condition using a single input as is', () => {
      const single = step('conditional', { condition }, ['e0'], ['field:a']);
      // text('abcd') has 4 chars: (4 + 1)^2 * (2 + 1) = 75
      expect(transformWork(single, 'abcd', 7)).toBe(base(7) + 75);
      // a single array input is stringified as a whole: 'xx,yy' has 5 chars
      expect(transformWork(single, ['xx', 'yy'], 7)).toBe(base(7) + 108);
    });

    it('spreads array values over several inputs', () => {
      const multi = step('conditional', { condition }, ['e0', 'e1'], ['field:b', 'field:a']);
      expect(transformWork(multi, ['abcdef', 'xyz'], 7)).toBe(base(7) + 48);
    });

    it('treats a non-array value of a multi-input step as the first input', () => {
      const multi = step('conditional', { condition }, ['e0', 'e1'], ['field:a', 'field:b']);
      expect(transformWork(multi, 'abcd', 7)).toBe(base(7) + 75);
    });

    it('charges nothing extra without a readable condition or input names', () => {
      expect(transformWork(step('conditional', { condition: 'not json' }), 'abcd', 7)).toBe(
        (7 + 1) * (measureTransformValue({ condition: 'not json' }) + 1)
      );
      const unnamed = step('conditional', { condition }, ['e0']);
      expect(transformWork(unnamed, 'abcd', 7)).toBe(base(7) + 3);
    });

    it('ignores the condition parameter of other operations', () => {
      const other = step('trim', { condition }, ['e0'], ['field:a']);
      expect(transformWork(other, 'abcd', 7)).toBe(base(7));
    });
  });
});

describe('jsonBuildSourceKeys', () => {
  it('lists every consulted key in lookup order', () => {
    const source: SourceValueEnvelope = {
      value: 1,
      sourceRef: { side: 'source', namespace: 'csv', path: 'p', catalogEntryId: 'cat' },
      metadata: { sourceType: 'csv', columnName: 'col', csvHeaderName: 'hdr', fieldPath: 'fp' },
    };
    expect(jsonBuildSourceKeys(source)).toEqual(['cat', 'col', 'hdr', 'fp', 'p']);
    expect(jsonBuildSourceKeys(sourceWithPath('only'))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      'only',
    ]);
  });
});

describe('chargeTransformInput', () => {
  it('subtracts the exact work and allows spending the budget to zero', () => {
    // bytes = measure(['abc']) = 8, work = (8 + 1) * (2 + 1) = 27
    const exact = { remaining: 27 };
    chargeTransformInput(step('trim'), ['abc'], exact);
    expect(exact.remaining).toBe(0);

    const spare = { remaining: 100 };
    chargeTransformInput(step('trim'), ['abc'], spare);
    expect(spare.remaining).toBe(73);
  });

  it('fails with the work limit code when the budget is one short', () => {
    const budget = { remaining: 26 };
    expect(failureCode(() => chargeTransformInput(step('trim'), ['abc'], budget))).toBe(
      'transform.work_limit_exceeded'
    );
    expect(budget.remaining).toBe(26);
  });

  it('passes a single value as a scalar and several values as an array to the work estimate', () => {
    const regexStep = step('regex_replace', { pattern: 'a+', replacement: 'x' });
    const single = { remaining: 1000 };
    chargeTransformInput(regexStep, ['abc'], single);
    // bytes 8: (8 + 1) * 42 = 378 + (3 + 1)^2 * 3 = 48
    expect(single.remaining).toBe(1000 - 426);
    const many = { remaining: 1000 };
    chargeTransformInput(regexStep, ['abc', 'ab'], many);
    // bytes 2 + 2 + 5 + 4 = 13: (13 + 1) * 42 = 588 + 48 + 27
    expect(many.remaining).toBe(1000 - 663);
  });

  it('adds json_build key bytes only for json_build', () => {
    const sources = [sourceWithPath('abc')];
    const build = { remaining: 10_000 };
    chargeTransformInput(step('json_build'), ['x'], build, sources);
    // bytes = 5 (value) + 2 ... measure(['x']) = 2 + 1 + 3 = 6; + key 3 + 2 = 11; work (11 + 1) * 3
    expect(build.remaining).toBe(10_000 - 36);

    const other = { remaining: 10_000 };
    chargeTransformInput(step('trim'), ['x'], other, sources);
    expect(other.remaining).toBe(10_000 - 7 * 3);
  });

  it('works without a sources argument for json_build', () => {
    const budget = { remaining: 10_000 };
    chargeTransformInput(step('json_build'), ['x'], budget);
    expect(budget.remaining).toBe(10_000 - 7 * 3);
  });

  it('skips non-string keys and counts each string key of every source', () => {
    const source: SourceValueEnvelope = {
      value: 1,
      sourceRef: { side: 'source', namespace: 'csv', path: 'ab', catalogEntryId: 'cde' },
      metadata: { sourceType: 'csv', columnName: 'f', fieldPath: 'ghij' },
    };
    const budget = { remaining: 100_000 };
    chargeTransformInput(step('json_build'), [], budget, [source, sourceWithPath('k')]);
    // keys: cde(5) f(3) ghij(6) ab(4) k(3) = 21; measure([]) = 2 -> bytes 23, work 24 * 3
    expect(budget.remaining).toBe(100_000 - 72);
  });

  it('allows a key of exactly 4096 characters and rejects 4097', () => {
    const ok = { remaining: 1e12 };
    chargeTransformInput(step('json_build'), [], ok, [sourceWithPath('k'.repeat(4096))]);
    expect(ok.remaining).toBe(1e12 - (2 + 4098 + 1) * 3);
    expect(
      failureCode(() =>
        chargeTransformInput(step('json_build'), [], { remaining: 1e12 }, [
          sourceWithPath('k'.repeat(4097)),
        ])
      )
    ).toBe('transform.limit_exceeded');
  });

  it('measures key size in encoded bytes', () => {
    const ok = { remaining: 1e12 };
    chargeTransformInput(step('json_build'), [], ok, [sourceWithPath('é'.repeat(2048))]);
    expect(ok.remaining).toBe(1e12 - (2 + 4098 + 1) * 3);
    expect(
      failureCode(() =>
        chargeTransformInput(step('json_build'), [], { remaining: 1e12 }, [
          sourceWithPath('é'.repeat(2049)),
        ])
      )
    ).toBe('transform.limit_exceeded');
  });

  it('rejects when value plus key bytes exceed 32768 but allows exactly 32768', () => {
    // measure(['x' * 16000]) = 16005; four 4096-char keys cost 4098 each; the last key costs length + 2
    const sourcesFor = (pathLength: number): SourceValueEnvelope[] => [
      {
        value: 1,
        sourceRef: {
          side: 'source',
          namespace: 'csv',
          path: 'p'.repeat(pathLength),
          catalogEntryId: 'c'.repeat(4096),
        },
        metadata: {
          sourceType: 'csv',
          columnName: 'n'.repeat(4096),
          csvHeaderName: 'h'.repeat(4096),
          fieldPath: 'f'.repeat(4096),
        },
      },
    ];
    const value = ['x'.repeat(16_000)];
    const at = { remaining: 1e15 };
    chargeTransformInput(step('json_build'), value, at, sourcesFor(369));
    expect(at.remaining).toBe(1e15 - (32_768 + 1) * 3);
    expect(
      failureCode(() =>
        chargeTransformInput(step('json_build'), value, { remaining: 1e15 }, sourcesFor(370))
      )
    ).toBe('transform.limit_exceeded');
    // the same payload is accepted for operations that do not shape keys
    expect(
      failureCode(() =>
        chargeTransformInput(step('trim'), value, { remaining: 1e15 }, sourcesFor(370))
      )
    ).toBeUndefined();
  });
});

describe('chargeTransformOutput', () => {
  it('subtracts the measured size and allows spending the budget to zero', () => {
    const exact = { remaining: 5 };
    chargeTransformOutput('abc', exact);
    expect(exact.remaining).toBe(0);
    const spare = { remaining: 20 };
    chargeTransformOutput('abc', spare);
    expect(spare.remaining).toBe(15);
  });

  it('fails when the output is larger than the remaining budget', () => {
    const budget = { remaining: 4 };
    expect(failureCode(() => chargeTransformOutput('abc', budget))).toBe(
      'transform.work_limit_exceeded'
    );
    expect(budget.remaining).toBe(4);
  });
});
