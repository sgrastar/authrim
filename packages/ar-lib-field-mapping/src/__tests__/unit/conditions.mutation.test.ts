import { describe, expect, it } from 'vitest';
import {
  conditionFields,
  conditionRegexWork,
  mappingConditionHolds,
  readMappingCondition,
  type MappingCondition,
} from '../../core/conditions';
import { TransformFailure } from '../../core/transform-safety';

function rule(operator: string, value: unknown, field = 'f'): MappingCondition {
  return { kind: 'rule', field, operator, value };
}

function read(node: unknown): MappingCondition | undefined {
  return readMappingCondition(JSON.stringify(node));
}

function holds(node: MappingCondition, actual?: unknown): boolean {
  return mappingConditionHolds(node, new Map<string, unknown>([['field:f', actual]]));
}

function nested(levels: number): unknown {
  let node: unknown = rule('eq', 'x');
  for (let i = 0; i < levels; i++) node = { kind: 'group', match: 'all', children: [node] };
  return node;
}

describe('readMappingCondition input contract', () => {
  it('rejects non-string input', () => {
    expect(readMappingCondition(undefined)).toBeUndefined();
    expect(readMappingCondition(5)).toBeUndefined();
    expect(readMappingCondition({ kind: 'rule' })).toBeUndefined();
  });

  it('rejects non-object roots and malformed JSON', () => {
    for (const text of ['[]', 'null', '1', '"x"', 'true', '{', '', '[{"kind":"rule"}]']) {
      expect(readMappingCondition(text)).toBeUndefined();
    }
  });

  it('bounds the serialized text at exactly the table byte limit', () => {
    const base = JSON.stringify(rule('eq', ''));
    const fill = (bytes: number): string =>
      JSON.stringify(rule('eq', 'x'.repeat(bytes - base.length)));
    const atLimit = fill(16 * 1024);
    expect(new TextEncoder().encode(atLimit).length).toBe(16 * 1024);
    expect(readMappingCondition(atLimit)).toEqual(rule('eq', 'x'.repeat(16 * 1024 - base.length)));
    const overLimit = fill(16 * 1024 + 1);
    expect(new TextEncoder().encode(overLimit).length).toBe(16 * 1024 + 1);
    expect(readMappingCondition(overLimit)).toBeUndefined();
  });

  it('counts UTF-8 bytes rather than characters for the size limit', () => {
    const base = JSON.stringify(rule('eq', ''));
    const chars = Math.floor((16 * 1024 - base.length) / 2) + 1;
    const text = JSON.stringify(rule('eq', 'é'.repeat(chars)));
    expect(text.length).toBeLessThanOrEqual(16 * 1024);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(16 * 1024);
    expect(readMappingCondition(text)).toBeUndefined();
  });

  it('measures the whole parsed value, including properties the validator ignores', () => {
    const oversized = { ...rule('eq', 'x'), extra: new Array<number>(501).fill(0) };
    expect(read(oversized)).toBeUndefined();
    const bounded = { ...rule('eq', 'x'), extra: new Array<number>(500).fill(0) };
    expect(read(bounded)).toEqual(bounded);
  });
});

describe('readMappingCondition tree bounds', () => {
  it('allows 64 nodes and rejects 65', () => {
    const group = (count: number) => ({
      kind: 'group',
      match: 'all',
      children: Array.from({ length: count }, () => rule('eq', 'x')),
    });
    expect(read(group(63))).toEqual(group(63));
    expect(read(group(64))).toBeUndefined();
  });

  it('allows four levels (depth 3) and rejects five', () => {
    expect(read(nested(3))).toEqual(nested(3));
    expect(read(nested(4))).toBeUndefined();
  });

  it('rejects empty and non-array group children', () => {
    expect(read({ kind: 'group', match: 'all', children: [] })).toBeUndefined();
    expect(read({ kind: 'group', match: 'all', children: {} })).toBeUndefined();
    expect(read({ kind: 'group', match: 'all' })).toBeUndefined();
  });

  it('rejects groups with a single invalid child', () => {
    expect(read({ kind: 'group', match: 'all', children: [rule('eq', 'x'), 1] })).toBeUndefined();
    expect(read({ kind: 'group', match: 'all', children: [[]] })).toBeUndefined();
    expect(read({ kind: 'group', match: 'all', children: [null] })).toBeUndefined();
  });

  it('accepts all three group match modes', () => {
    for (const match of ['all', 'any', 'none']) {
      const node = { kind: 'group', match, children: [rule('eq', 'x')] };
      expect(read(node)).toEqual(node);
    }
  });
});

describe('readMappingCondition rule contract', () => {
  it('rejects unknown kinds even when the rest looks like a rule', () => {
    expect(read({ kind: 'other', field: 'a', operator: 'eq', value: 'x' })).toBeUndefined();
    expect(read({ field: 'a', operator: 'eq', value: 'x' })).toBeUndefined();
  });

  it('bounds field names to 1..512 characters', () => {
    expect(read(rule('eq', 'x', 'a'.repeat(512)))).toEqual(rule('eq', 'x', 'a'.repeat(512)));
    expect(read(rule('eq', 'x', 'a'.repeat(513)))).toBeUndefined();
    expect(read(rule('eq', 'x', ''))).toBeUndefined();
    expect(read({ kind: 'rule', field: 1, operator: 'eq', value: 'x' })).toBeUndefined();
  });

  it('rejects unknown or non-string operators', () => {
    expect(read(rule('between', 'x'))).toBeUndefined();
    expect(read(rule('', 'x'))).toBeUndefined();
    expect(read({ kind: 'rule', field: 'f', operator: 1, value: 'x' })).toBeUndefined();
  });

  it.each([
    ['eq', 'x'],
    ['ne', 'x'],
    ['contains', 'x'],
    ['not_contains', 'x'],
    ['in', ['a']],
    ['not_in', ['a']],
    ['lt', 1],
    ['lte', 1],
    ['gt', 1],
    ['gte', 1],
    ['exists', null],
    ['not_exists', null],
    ['regex', '^a$'],
  ])('accepts operator %s with a well-formed value', (operator, value) => {
    expect(read(rule(operator, value))).toEqual(rule(operator, value));
  });

  it.each(['exists', 'not_exists'])('requires %s to carry a null value', (operator) => {
    expect(read(rule(operator, 'x'))).toBeUndefined();
    expect(read(rule(operator, ''))).toBeUndefined();
    expect(read(rule(operator, 0))).toBeUndefined();
    expect(read(rule(operator, false))).toBeUndefined();
    expect(read({ kind: 'rule', field: 'f', operator })).toBeUndefined();
  });

  it('requires regex values to be safe string patterns', () => {
    expect(read(rule('regex', 1))).toBeUndefined();
    expect(read(rule('regex', null))).toBeUndefined();
    expect(read(rule('regex', '(a+)+'))).toBeUndefined();
    expect(read(rule('regex', ''))).toBeUndefined();
  });

  it.each(['in', 'not_in'])('requires %s to carry a bounded non-empty string array', (operator) => {
    expect(read(rule(operator, []))).toBeUndefined();
    expect(read(rule(operator, 'a'))).toBeUndefined();
    expect(read(rule(operator, null))).toBeUndefined();
    expect(read(rule(operator, ['a', 1]))).toBeUndefined();
    expect(read(rule(operator, [1]))).toBeUndefined();
    expect(read(rule(operator, [null]))).toBeUndefined();
    const full = Array.from({ length: 256 }, (_, index) => `v${index}`);
    expect(read(rule(operator, full))).toEqual(rule(operator, full));
    expect(read(rule(operator, [...full, 'extra']))).toBeUndefined();
  });

  it.each(['lt', 'lte', 'gt', 'gte'])('requires %s to carry a finite number', (operator) => {
    expect(read(rule(operator, 0))).toEqual(rule(operator, 0));
    expect(read(rule(operator, -1.5))).toEqual(rule(operator, -1.5));
    expect(read(rule(operator, '1'))).toBeUndefined();
    expect(read(rule(operator, true))).toBeUndefined();
    expect(read(rule(operator, null))).toBeUndefined();
    expect(read(rule(operator, [1]))).toBeUndefined();
    expect(
      readMappingCondition(`{"kind":"rule","field":"f","operator":"${operator}","value":1e999}`)
    ).toBeUndefined();
  });

  it.each(['eq', 'ne', 'contains', 'not_contains'])(
    'restricts %s values to string, boolean or finite number',
    (operator) => {
      expect(read(rule(operator, ''))).toEqual(rule(operator, ''));
      expect(read(rule(operator, false))).toEqual(rule(operator, false));
      expect(read(rule(operator, true))).toEqual(rule(operator, true));
      expect(read(rule(operator, 0))).toEqual(rule(operator, 0));
      expect(read(rule(operator, null))).toBeUndefined();
      expect(read(rule(operator, ['a']))).toBeUndefined();
      expect(read(rule(operator, { a: 1 }))).toBeUndefined();
      expect(read({ kind: 'rule', field: 'f', operator })).toBeUndefined();
      expect(
        readMappingCondition(`{"kind":"rule","field":"f","operator":"${operator}","value":1e999}`)
      ).toBeUndefined();
    }
  );
});

describe('conditionFields', () => {
  it('lists unique fields in first-seen order across nested groups', () => {
    const node = read({
      kind: 'group',
      match: 'any',
      children: [
        rule('eq', 'x', 'b'),
        { kind: 'group', match: 'all', children: [rule('eq', 'x', 'a'), rule('ne', 'y', 'b')] },
      ],
    });
    expect(node).toBeDefined();
    expect(conditionFields(node as MappingCondition)).toEqual(['b', 'a']);
  });
});

describe('mappingConditionHolds', () => {
  it.each([
    [undefined, false],
    [null, false],
    ['', false],
    [[], false],
    ['x', true],
    [0, true],
    [false, true],
    [[''], true],
    [{}, true],
  ])('exists/not_exists on %p', (actual, present) => {
    expect(holds(rule('exists', null), actual)).toBe(present);
    expect(holds(rule('not_exists', null), actual)).toBe(!present);
  });

  it('treats an absent input like an undefined value', () => {
    expect(mappingConditionHolds(rule('exists', null), new Map())).toBe(false);
    expect(mappingConditionHolds(rule('not_exists', null), new Map())).toBe(true);
  });

  it('reads the field-prefixed input of the rule', () => {
    const inputs = new Map<string, unknown>([
      ['f', 'wrong'],
      ['field:g', 'wrong'],
      ['field:f', 'right'],
    ]);
    expect(mappingConditionHolds(rule('eq', 'right'), inputs)).toBe(true);
    expect(mappingConditionHolds(rule('eq', 'wrong', 'g'), inputs)).toBe(true);
  });

  it.each([
    ['a', 'a', true],
    ['a', 'b', false],
    [5, '5', true],
    [5, 5, true],
    [true, 'true', true],
    [false, 'true', false],
    [10n, '10', true],
    [undefined, '', true],
    [null, '', true],
    [[1, 'a'], '1,a', true],
    [[[1], [2, null]], '1,2,', true],
    [{}, '[object Object]', true],
    [{ a: 1 }, '[object Object]', true],
    [Symbol.for('s'), 'Symbol(s)', true],
    ['a', '', false],
  ])('eq/ne compare text of %p with %p', (actual, expected, equal) => {
    expect(holds(rule('eq', expected), actual)).toBe(equal);
    expect(holds(rule('ne', expected), actual)).toBe(!equal);
  });

  it('matches in/not_in by text and requires an array expectation', () => {
    expect(holds(rule('in', ['a', 'b']), 'a')).toBe(true);
    expect(holds(rule('in', ['a', 'b']), 'c')).toBe(false);
    expect(holds(rule('in', ['5']), 5)).toBe(true);
    expect(holds(rule('in', ['']), undefined)).toBe(true);
    expect(holds(rule('not_in', ['a', 'b']), 'a')).toBe(false);
    expect(holds(rule('not_in', ['a', 'b']), 'c')).toBe(true);
    expect(holds(rule('not_in', ['5']), 5)).toBe(false);
    expect(holds(rule('in', 'a'), 'a')).toBe(false);
    expect(holds(rule('in', null), '')).toBe(false);
    expect(holds(rule('not_in', 'a'), 'b')).toBe(false);
    expect(holds(rule('not_in', null), '')).toBe(false);
  });

  it('matches contains/not_contains only against array actuals', () => {
    expect(holds(rule('contains', 'b'), ['a', 'b'])).toBe(true);
    expect(holds(rule('contains', 'c'), ['a', 'b'])).toBe(false);
    expect(holds(rule('contains', 2), [1, 2])).toBe(true);
    expect(holds(rule('contains', '2'), [1, 2])).toBe(true);
    expect(holds(rule('contains', 'a'), 'abc')).toBe(false);
    expect(holds(rule('contains', ''), '')).toBe(false);
    expect(holds(rule('contains', 'a'), undefined)).toBe(false);
    expect(holds(rule('not_contains', 'b'), ['a', 'b'])).toBe(false);
    expect(holds(rule('not_contains', 'c'), ['a', 'b'])).toBe(true);
    expect(holds(rule('not_contains', 'a'), 'abc')).toBe(true);
    expect(holds(rule('not_contains', 'a'), undefined)).toBe(true);
  });

  it.each([
    ['lt', 4, 5, true],
    ['lt', 5, 5, false],
    ['lt', 6, 5, false],
    ['lte', 4, 5, true],
    ['lte', 5, 5, true],
    ['lte', 6, 5, false],
    ['gt', 4, 5, false],
    ['gt', 5, 5, false],
    ['gt', 6, 5, true],
    ['gte', 4, 5, false],
    ['gte', 5, 5, true],
    ['gte', 6, 5, true],
  ])('%s with actual %p against %p', (operator, actual, expected, result) => {
    expect(holds(rule(operator, expected), actual)).toBe(result);
    expect(holds(rule(operator, expected), String(actual))).toBe(result);
  });

  it.each(['lt', 'lte', 'gt', 'gte'])(
    '%s never matches empty, blank or non-numeric actuals',
    (operator) => {
      for (const actual of [undefined, null, '', '   ', 'abc', [], {}]) {
        expect(holds(rule(operator, 1), actual)).toBe(false);
        expect(holds(rule(operator, -1), actual)).toBe(false);
        expect(holds(rule(operator, 0), actual)).toBe(false);
      }
    }
  );

  it('trims numeric text before comparing', () => {
    expect(holds(rule('gte', 5), ' 5 ')).toBe(true);
    expect(holds(rule('lt', 6), '\t5\n')).toBe(true);
  });

  it('compares numeric operators against the numeric value of the expectation', () => {
    expect(holds(rule('lt', -2), -3)).toBe(true);
    expect(holds(rule('gt', 0.5), 0.75)).toBe(true);
  });

  it('applies regex expectations with unicode semantics', () => {
    expect(holds(rule('regex', '^a+$'), 'aaa')).toBe(true);
    expect(holds(rule('regex', '^a+$'), 'aab')).toBe(false);
    expect(holds(rule('regex', 'b'), 'abc')).toBe(true);
    expect(holds(rule('regex', '^.$'), '\u{1F600}')).toBe(true);
    expect(holds(rule('regex', '^5$'), 5)).toBe(true);
    expect(holds(rule('regex', '^$'), undefined)).toBe(true);
  });

  it('fails regex evaluation when the input exceeds 1024 characters', () => {
    expect(holds(rule('regex', '^a+$'), 'a'.repeat(1024))).toBe(true);
    expect(() => holds(rule('regex', '^a+$'), 'a'.repeat(1025))).toThrow(TransformFailure);
    try {
      holds(rule('regex', 'a'), 'a'.repeat(1025));
      expect.unreachable('expected a transform failure');
    } catch (error) {
      expect(error).toBeInstanceOf(TransformFailure);
      expect((error as TransformFailure).code).toBe('transform.limit_exceeded');
    }
  });

  it('does not match a regex rule whose expectation is not a string', () => {
    expect(holds(rule('regex', 5), 'a')).toBe(false);
    expect(holds(rule('regex', null), '')).toBe(false);
  });

  it('does not match unknown operators', () => {
    expect(holds(rule('unknown', 'a'), 'a')).toBe(false);
    expect(holds(rule('', ''), '')).toBe(false);
  });

  it.each([
    ['all', [true, true], true],
    ['all', [true, false], false],
    ['any', [false, true], true],
    ['any', [false, false], false],
    ['none', [false, false], true],
    ['none', [true, false], false],
  ] as const)('group %s over %p', (match, flags, result) => {
    const node: MappingCondition = {
      kind: 'group',
      match,
      children: flags.map((flag) => rule('eq', flag ? 'x' : 'y')),
    };
    expect(holds(node, 'x')).toBe(result);
  });
});

describe('conditionRegexWork', () => {
  const inputs = (value: unknown, field = 'f') =>
    new Map<string, unknown>([[`field:${field}`, value]]);

  it('charges (input length + 1)^2 * (pattern length + 1) per regex rule', () => {
    expect(conditionRegexWork(rule('regex', 'a'), inputs('ab'))).toBe(3 ** 2 * 2);
    expect(conditionRegexWork(rule('regex', 'abc'), inputs(''))).toBe(1 * 4);
    expect(conditionRegexWork(rule('regex', 'abc'), inputs(undefined))).toBe(4);
    expect(conditionRegexWork(rule('regex', 'a'), inputs(12345))).toBe(6 ** 2 * 2);
  });

  it('charges nothing for non-regex operators and non-string patterns', () => {
    expect(conditionRegexWork(rule('eq', 'a'), inputs('abcdef'))).toBe(0);
    expect(conditionRegexWork(rule('lt', 1), inputs('abcdef'))).toBe(0);
    expect(conditionRegexWork(rule('regex', 5), inputs('abcdef'))).toBe(0);
  });

  it('sums every branch of nested groups', () => {
    const node: MappingCondition = {
      kind: 'group',
      match: 'any',
      children: [
        rule('regex', 'a', 'f'),
        rule('eq', 'zzz', 'f'),
        { kind: 'group', match: 'none', children: [rule('regex', 'abc', 'g')] },
      ],
    };
    const map = new Map<string, unknown>([
      ['field:f', 'ab'],
      ['field:g', 'x'],
    ]);
    expect(conditionRegexWork(node, map)).toBe(3 ** 2 * 2 + 2 ** 2 * 4);
  });

  it('refuses inputs longer than 1024 characters but accepts exactly 1024', () => {
    expect(conditionRegexWork(rule('regex', 'a'), inputs('a'.repeat(1024)))).toBe(1025 ** 2 * 2);
    expect(() => conditionRegexWork(rule('regex', 'a'), inputs('a'.repeat(1025)))).toThrow(
      TransformFailure
    );
    expect(conditionRegexWork(rule('eq', 'a'), inputs('a'.repeat(5000)))).toBe(0);
  });
});
