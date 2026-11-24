import { describe, expect, it } from 'vitest';
import {
  executeTextTransform,
  isTextTransform,
  parseValueMap,
  textSettingsProblem,
} from '../../core/text-transforms';
import { boundedReplace } from '../../core/text-replace';
import { asciiDigits, stripAccents } from '../../core/text-fold';
import { toFullwidth, toHalfwidth } from '../../core/text-width';
import { TEXT_TRANSFORM_SCHEMAS } from '../../core/text-transform-schemas';
import { TransformFailure, TRANSFORM_LIMITS } from '../../core/transform-safety';
import type { FieldRef, MappingTransformStep, TransformOperation } from '../../core/types';

// Combining marks, spelled out so the source stays readable.
const ACUTE = '\u0301';
const VOICED = '\u3099';
const SEMI = '\u309a';

const target: FieldRef = { side: 'destination', namespace: 'oidc.claim', path: 'name' };
function step(
  operation: TransformOperation,
  parameters: Record<string, unknown> = {}
): MappingTransformStep {
  return { id: 'text', operation, parameters, inputEdgeIds: ['in'], outputTargetRef: target };
}
const run = (
  operation: TransformOperation,
  value: unknown,
  parameters: Record<string, unknown> = {}
) => executeTextTransform(step(operation, parameters), value);
function failure(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof TransformFailure) return error.code;
    throw error;
  }
  return undefined;
}
const problem = (operation: TransformOperation, parameters?: Record<string, unknown>) =>
  textSettingsProblem({ ...step(operation), parameters });

describe('isTextTransform', () => {
  it('knows exactly the text operations', () => {
    for (const schema of TEXT_TRANSFORM_SCHEMAS)
      expect(isTextTransform(schema.operation)).toBe(true);
    expect(isTextTransform('hash')).toBe(false);
    expect(isTextTransform('')).toBe(false);
  });
});

describe('parseValueMap limits', () => {
  it('reads a well-formed table', () => {
    expect(parseValueMap('[["a","b"],["c","d"]]')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseValueMap('[]')).toEqual([]);
  });

  it('accepts a table of exactly 16 KiB and refuses one more character', () => {
    const limit = TRANSFORM_LIMITS.tableBytes;
    const base = '[["a","b"]]';
    expect(parseValueMap(base + ' '.repeat(limit - base.length))).toEqual([['a', 'b']]);
    expect(parseValueMap(base + ' '.repeat(limit - base.length + 1))).toBeNull();
  });

  it('measures bytes, not characters', () => {
    const wrap = (count: number) => `[["${'あ'.repeat(count)}","b"]]`;
    const fits = wrap(5458);
    expect(new TextEncoder().encode(fits).byteLength).toBe(TRANSFORM_LIMITS.tableBytes);
    expect(parseValueMap(fits)?.[0][0]).toHaveLength(5458);
    expect(parseValueMap(wrap(5459))).toBeNull();
  });

  it('accepts 256 rows and refuses 257', () => {
    const rows = (count: number) => JSON.stringify(Array.from({ length: count }, () => ['a', 'b']));
    expect(parseValueMap(rows(TRANSFORM_LIMITS.tableRows))).toHaveLength(256);
    expect(parseValueMap(rows(TRANSFORM_LIMITS.tableRows + 1))).toBeNull();
  });

  it.each([
    undefined,
    null,
    5,
    {},
    '',
    'not json',
    '{"a":"b"}',
    '"a"',
    '[["a"]]',
    '[["a","b","c"]]',
    '[["a",1]]',
    '[[1,"b"]]',
    '[["a",null]]',
    '["ab"]',
    '[{"0":"a","1":"b"}]',
  ])('rejects %j', (entries) => {
    expect(parseValueMap(entries)).toBeNull();
  });
});

describe('textSettingsProblem', () => {
  it('flags only unsafe or non-text regex_replace patterns', () => {
    expect(problem('regex_replace', { pattern: '(a+)+' })).toBe('transform.unsafe_regex');
    expect(problem('regex_replace', { pattern: 5 })).toBe('transform.unsafe_regex');
    expect(problem('regex_replace', {})).toBe('transform.unsafe_regex');
    expect(problem('regex_replace', undefined)).toBe('transform.unsafe_regex');
    expect(problem('regex_replace', { pattern: 'a+b' })).toBeNull();
  });

  it('checks the filter pattern only for the regex mode of filter_values', () => {
    expect(problem('filter_values', { how: 'regex', match: '(a+)+' })).toBe(
      'transform.unsafe_regex'
    );
    expect(problem('filter_values', { how: 'regex', match: 5 })).toBe('transform.unsafe_regex');
    expect(problem('filter_values', { how: 'regex', match: 'a+b' })).toBeNull();
    expect(problem('filter_values', { how: 'contains', match: '(a+)+' })).toBeNull();
    expect(problem('filter_values', { how: 'contains', match: 5 })).toBeNull();
    expect(problem('keep_part', { how: 'regex', match: '(a+)+' })).toBeNull();
    expect(problem('remove_text', { pattern: '(a+)+' })).toBeNull();
  });

  it('requires a readable table, and a fallback when the fallback is fixed', () => {
    expect(problem('value_map', { entries: 'nope', otherwise: 'as_is' })).toBe(
      'transform.invalid_parameter'
    );
    expect(problem('value_map', { otherwise: 'as_is' })).toBe('transform.invalid_parameter');
    expect(problem('value_map', { entries: '[["a","b"]]', otherwise: 'fixed' })).toBe(
      'transform.invalid_parameter'
    );
    expect(
      problem('value_map', { entries: '[["a","b"]]', otherwise: 'fixed', fallbackValue: 3 })
    ).toBe('transform.invalid_parameter');
    expect(
      problem('value_map', { entries: '[["a","b"]]', otherwise: 'fixed', fallbackValue: '' })
    ).toBeNull();
    expect(problem('value_map', { entries: '[["a","b"]]', otherwise: 'none' })).toBeNull();
    expect(problem('value_map', { entries: '[["a","b"]]', otherwise: 'as_is' })).toBeNull();
    expect(problem('replace_text', { entries: 'nope', otherwise: 'fixed' })).toBeNull();
  });

  it('requires an empty value when empty text is replaced by a fixed value', () => {
    expect(problem('normalize_empty', { emptyAs: 'fixed' })).toBe('transform.missing_parameter');
    expect(problem('normalize_empty', { emptyAs: 'fixed', emptyValue: 1 })).toBe(
      'transform.missing_parameter'
    );
    expect(problem('normalize_empty', { emptyAs: 'fixed', emptyValue: '' })).toBeNull();
    expect(problem('normalize_empty', { emptyAs: 'empty' })).toBeNull();
    expect(problem('normalize_empty', { emptyAs: 'none' })).toBeNull();
    expect(problem('default_if_empty', { emptyAs: 'fixed' })).toBeNull();
  });

  it('checks the time zone only for date_format', () => {
    expect(problem('date_format', { timeZone: 'Mars/Phobos' })).toBe('transform.invalid_parameter');
    expect(problem('date_format', { timeZone: '' })).toBe('transform.invalid_parameter');
    expect(problem('date_format', { timeZone: 9 })).toBe('transform.invalid_parameter');
    expect(problem('date_format', { timeZone: 'Asia/Tokyo' })).toBeNull();
    expect(problem('date_format', {})).toBeNull();
    expect(problem('date_format', undefined)).toBeNull();
    expect(problem('text_to_number', { timeZone: 'Mars/Phobos' })).toBeNull();
  });

  it('reports no problem for operations without settings to check', () => {
    expect(problem('strip_accents')).toBeNull();
  });
});

describe('has_value / default_if_empty / normalize_empty', () => {
  it.each([null, undefined, '', []])('treats %j as empty', (value) => {
    expect(run('has_value', value)).toBe(false);
    expect(run('has_value', value, { invert: true })).toBe(true);
  });

  it.each(['x', ' ', 0, false, [''], [null], {}])('treats %j as present', (value) => {
    expect(run('has_value', value)).toBe(true);
    expect(run('has_value', value, { invert: true })).toBe(false);
  });

  it('only a literal true inverts has_value', () => {
    expect(run('has_value', '', { invert: 'true' })).toBe(false);
    expect(run('has_value', 'x', { invert: 1 })).toBe(true);
  });

  it('fills the default only for empty values', () => {
    expect(run('default_if_empty', '', { value: 'dflt' })).toBe('dflt');
    expect(run('default_if_empty', null, { value: 'dflt' })).toBe('dflt');
    expect(run('default_if_empty', [], { value: 'dflt' })).toBe('dflt');
    expect(run('default_if_empty', 'x', { value: 'dflt' })).toBe('x');
    expect(run('default_if_empty', 0, { value: 'dflt' })).toBe(0);
    expect(run('default_if_empty', '', {})).toBe('');
    expect(run('default_if_empty', '', { value: 5 })).toBe('');
  });

  it('rewrites empty values according to emptyAs', () => {
    expect(run('normalize_empty', '', { emptyAs: 'empty' })).toBe('');
    expect(run('normalize_empty', null, { emptyAs: 'empty' })).toBe('');
    expect(run('normalize_empty', '', { emptyAs: 'none' })).toBeNull();
    expect(run('normalize_empty', undefined, { emptyAs: 'fixed', emptyValue: 'n/a' })).toBe('n/a');
    expect(run('normalize_empty', '', { emptyAs: 'fixed' })).toBe('');
    expect(run('normalize_empty', [], { emptyAs: 'bogus' })).toBeNull();
    expect(run('normalize_empty', 'kept', { emptyAs: 'none' })).toBe('kept');
  });

  it('treats blank text as empty only when spaces is set to true', () => {
    expect(run('normalize_empty', ' \t\n ', { spaces: true, emptyAs: 'none' })).toBeNull();
    expect(run('normalize_empty', ' \t\n ', { emptyAs: 'none' })).toBe(' \t\n ');
    expect(run('normalize_empty', ' \t\n ', { spaces: 'true', emptyAs: 'none' })).toBe(' \t\n ');
    expect(run('normalize_empty', ' a ', { spaces: true, emptyAs: 'none' })).toBe(' a ');
    expect(run('normalize_empty', 'a ', { spaces: true, emptyAs: 'none' })).toBe('a ');
    expect(run('normalize_empty', ' a', { spaces: true, emptyAs: 'none' })).toBe(' a');
    expect(run('normalize_empty', 7, { spaces: true, emptyAs: 'none' })).toBe(7);
  });
});

describe('list handling', () => {
  it('applies text_to_number and date_format to each list item', () => {
    expect(run('text_to_number', ['1', ' 2.5 ', 3])).toEqual([1, 2.5, 3]);
    expect(run('text_to_number', '7')).toBe(7);
    expect(failure(() => run('text_to_number', ['1', 'x']))).toBe('transform.invalid_output');
    expect(run('date_format', ['2024-01-15', '2024-01-16'], { from: 'iso', to: 'date' })).toEqual([
      '2024-01-15',
      '2024-01-16',
    ]);
    expect(run('date_format', '2024-01-15', { from: 'iso', to: 'date' })).toBe('2024-01-15');
  });

  it('leaves non-text items untouched and transforms text items', () => {
    expect(run('strip_accents', ['é', 5, null, 'ü'])).toEqual(['e', 5, null, 'u']);
    expect(run('strip_accents', 5)).toBe(5);
    expect(
      run('keep_part', [1, 'a-b'], { delimiter: '-', keep: 'before', occurrence: 'first' })
    ).toEqual([1, 'a']);
  });

  it('refuses an operation that is not a text operation', () => {
    expect(failure(() => run('hash', 'abc'))).toBe('transform.unsupported_operation');
    expect(run('hash', 5)).toBe(5);
  });
});

describe('filter_values', () => {
  const filter = (value: unknown, parameters: Record<string, unknown>) =>
    run('filter_values', value, parameters);

  it('wraps a single value and drops empty or non-text input', () => {
    expect(filter('abc', { how: 'contains', match: 'b' })).toEqual(['abc']);
    expect(filter('abc', { how: 'contains', match: 'z' })).toEqual([]);
    expect(filter(null, { how: 'contains', match: '' })).toEqual([]);
    expect(filter('', { how: 'contains', match: '' })).toEqual([]);
    expect(filter(5, { how: 'contains', match: '5' })).toEqual([]);
    expect(filter(['a', 5, null, 'ab'], { how: 'contains', match: 'a' })).toEqual(['a', 'ab']);
  });

  it('matches each mode on its own terms', () => {
    const list = ['abc', 'xabc', 'abcx', 'ab', 'bc'];
    expect(filter(list, { how: 'starts_with', match: 'ab' })).toEqual(['abc', 'abcx', 'ab']);
    expect(filter(list, { how: 'ends_with', match: 'bc' })).toEqual(['abc', 'xabc', 'bc']);
    expect(filter(list, { how: 'equals', match: 'abc' })).toEqual(['abc']);
    expect(filter(list, { how: 'contains', match: 'bc' })).toEqual(['abc', 'xabc', 'abcx', 'bc']);
    expect(filter(list, { how: 'regex', match: '^ab.?$' })).toEqual(['abc', 'ab']);
  });

  it('treats an unknown mode as contains', () => {
    expect(filter(['abc', 'x'], { how: 'whatever', match: 'b' })).toEqual(['abc']);
    expect(filter(['abc', 'x'], { match: 'b' })).toEqual(['abc']);
  });

  it('inverts the choice with exclude', () => {
    const list = ['abc', 'xyz'];
    expect(filter(list, { how: 'starts_with', match: 'ab', exclude: true })).toEqual(['xyz']);
    expect(filter(list, { how: 'regex', match: '^ab', exclude: true })).toEqual(['xyz']);
    expect(filter(list, { how: 'equals', match: 'abc', exclude: 'true' })).toEqual(['abc']);
    expect(filter([5, 'abc'], { how: 'contains', match: 'z', exclude: true })).toEqual(['abc']);
  });

  it('folds case on both sides only when ignoreCase is true', () => {
    const list = ['ABC', 'abc'];
    expect(filter(list, { how: 'equals', match: 'aBc', ignoreCase: true })).toEqual(['ABC', 'abc']);
    expect(filter(list, { how: 'equals', match: 'aBc' })).toEqual([]);
    expect(filter(list, { how: 'equals', match: 'abc' })).toEqual(['abc']);
    expect(filter(list, { how: 'equals', match: 'ABC', ignoreCase: 'yes' })).toEqual(['ABC']);
    expect(filter(['ABCD'], { how: 'starts_with', match: 'ab', ignoreCase: true })).toEqual([
      'ABCD',
    ]);
    expect(filter(['abcd'], { how: 'starts_with', match: 'AB', ignoreCase: true })).toEqual([
      'abcd',
    ]);
    expect(filter(['abcd'], { how: 'starts_with', match: 'AB' })).toEqual([]);
    expect(filter(['xABC'], { how: 'ends_with', match: 'abc', ignoreCase: true })).toEqual([
      'xABC',
    ]);
    expect(filter(['xabc'], { how: 'ends_with', match: 'ABC', ignoreCase: true })).toEqual([
      'xabc',
    ]);
    expect(filter(['xabc'], { how: 'ends_with', match: 'ABC' })).toEqual([]);
    expect(filter(['xabcx'], { how: 'contains', match: 'ABC', ignoreCase: true })).toEqual([
      'xabcx',
    ]);
    expect(filter(['xabcx'], { how: 'contains', match: 'ABC' })).toEqual([]);
  });

  it('keeps the regex mode unicode-aware and case-sensitive unless asked', () => {
    expect(filter(['😀', 'u'], { how: 'regex', match: '\\u{1F600}' })).toEqual(['😀']);
    expect(filter(['a', 'A'], { how: 'regex', match: '^\\p{Lu}$' })).toEqual(['A']);
    expect(filter(['a', 'A'], { how: 'regex', match: '^\\p{Lu}$', ignoreCase: true })).toEqual([
      'a',
      'A',
    ]);
    expect(filter(['ABC'], { how: 'regex', match: 'abc' })).toEqual([]);
    expect(filter(['ABC'], { how: 'regex', match: 'abc', ignoreCase: true })).toEqual(['ABC']);
  });

  it('does not read a literal match as a pattern outside the regex mode', () => {
    expect(filter(['a(b', 'ab'], { how: 'contains', match: '(' })).toEqual(['a(b']);
    expect(filter(['a(b', 'ab'], { how: 'starts_with', match: 'a(' })).toEqual(['a(b']);
  });
});

describe('keep_part', () => {
  const keep = (item: unknown, parameters: Record<string, unknown>) =>
    run('keep_part', item, parameters);

  it('keeps the text before or after the first or last delimiter', () => {
    const text = 'a-b-c';
    expect(keep(text, { delimiter: '-', keep: 'before', occurrence: 'first' })).toBe('a');
    expect(keep(text, { delimiter: '-', keep: 'after', occurrence: 'first' })).toBe('b-c');
    expect(keep(text, { delimiter: '-', keep: 'before', occurrence: 'last' })).toBe('a-b');
    expect(keep(text, { delimiter: '-', keep: 'after', occurrence: 'last' })).toBe('c');
    expect(keep(text, { delimiter: '-' })).toBe('a');
    expect(keep(text, { delimiter: '--', keep: 'after', occurrence: 'first' })).toBe(text);
  });

  it('handles a delimiter at either end and a multi-character delimiter', () => {
    expect(keep('abc', { delimiter: 'a', keep: 'before', occurrence: 'first' })).toBe('');
    expect(keep('abc', { delimiter: 'a', keep: 'after', occurrence: 'first' })).toBe('bc');
    expect(keep('abc', { delimiter: 'c', keep: 'after', occurrence: 'last' })).toBe('');
    expect(keep('a::b::c', { delimiter: '::', keep: 'after', occurrence: 'last' })).toBe('c');
    expect(keep('a::b::c', { delimiter: '::', keep: 'after', occurrence: 'first' })).toBe('b::c');
  });

  it('leaves the text alone without a usable delimiter', () => {
    expect(keep('abc', { delimiter: '', keep: 'after', occurrence: 'first' })).toBe('abc');
    expect(keep('abc', { keep: 'after', occurrence: 'first' })).toBe('abc');
    expect(keep('abc', { delimiter: 5, keep: 'after', occurrence: 'first' })).toBe('abc');
    expect(keep('abc', { delimiter: 'z', keep: 'after', occurrence: 'first' })).toBe('abc');
  });
});

describe('remove_text / replace_text / regex_replace', () => {
  it('removes every occurrence of the text', () => {
    expect(run('remove_text', 'a-b-c', { text: '-' })).toBe('abc');
    expect(run('remove_text', 'a-b-c', { text: '' })).toBe('a-b-c');
    expect(run('remove_text', 'a-b-c', {})).toBe('a-b-c');
    expect(run('remove_text', 'a.b', { text: '.' })).toBe('ab');
    expect(run('remove_text', 'axb', { text: '.' })).toBe('axb');
  });

  it('replaces literally, case-sensitively unless asked', () => {
    expect(run('replace_text', 'a.c a.c', { find: 'a.c', replacement: 'X' })).toBe('X X');
    expect(run('replace_text', 'abc', { find: 'a.c', replacement: 'X' })).toBe('abc');
    expect(run('replace_text', 'Abc abc', { find: 'abc', replacement: 'X' })).toBe('Abc X');
    expect(
      run('replace_text', 'Abc abc', { find: 'abc', replacement: 'X', ignoreCase: true })
    ).toBe('X X');
    expect(run('replace_text', 'Abc', { find: 'abc', replacement: 'X', ignoreCase: 'yes' })).toBe(
      'Abc'
    );
    expect(run('replace_text', 'abc', { find: 'b' })).toBe('ac');
    expect(run('replace_text', 'abc', { find: '', replacement: 'X' })).toBe('abc');
    expect(run('replace_text', 'abc', { replacement: 'X' })).toBe('abc');
    expect(run('replace_text', 'abc', { find: 'b', replacement: '$&$1$$' })).toBe('a$&$1$$c');
    expect(run('replace_text', 'a+b', { find: '+', replacement: '-' })).toBe('a-b');
    expect(run('replace_text', '[x]', { find: '[x]', replacement: 'y' })).toBe('y');
  });

  it('replaces by pattern with group references, case-sensitively unless asked', () => {
    expect(run('regex_replace', 'ab12', { pattern: '(\\d)(\\d)', replacement: '$2$1' })).toBe(
      'ab21'
    );
    expect(run('regex_replace', 'a1b2', { pattern: '\\d', replacement: '#' })).toBe('a#b#');
    expect(run('regex_replace', 'Abc', { pattern: 'abc', replacement: 'X' })).toBe('Abc');
    expect(
      run('regex_replace', 'Abc', { pattern: 'abc', replacement: 'X', ignoreCase: true })
    ).toBe('X');
    expect(run('regex_replace', 'Abc', { pattern: 'abc', replacement: 'X', ignoreCase: 1 })).toBe(
      'Abc'
    );
    expect(run('regex_replace', 'abc', { pattern: 'b' })).toBe('ac');
    expect(run('regex_replace', '😀', { pattern: '\\u{1F600}', replacement: 'X' })).toBe('X');
    expect(run('regex_replace', 'ab', { replacement: 'X' })).toBe('Xa' + 'Xb' + 'X');
  });
});

describe('boundedReplace', () => {
  const g = (source: string) => new RegExp(source, 'gu');
  const same = (text: string, pattern: string, replacement: string) =>
    expect(boundedReplace(text, g(pattern), replacement)).toBe(
      text.replace(g(pattern), replacement)
    );

  it.each([
    ['abc', 'b', '[$&]'],
    ['abc', 'b', '[$`]'],
    ['abc', 'b', "[$']"],
    ['abc', 'b', '$$'],
    ['abc', 'b', '$'],
    ['abc', 'b', 'x$'],
    ['abc', 'b', '$x'],
    ['abc', 'b', '$0'],
    ['abc', 'b', '$00'],
    ['abc', 'b', '$1'],
    ['abc', '(b)', '$1$1'],
    ['abc', '(b)', '$2'],
    ['abc', '(b)', '$01'],
    ['abc', '(b)', '$10'],
    ['abc', '(b)', '$11'],
    ['abc', '(b)(c)', '$2$1'],
    ['abc', '(b)(c)', '$3'],
    ['abc', '(b)(c)', '$12'],
    ['abc', '(b)(c)(z)?', '[$3]'],
    ['abcdefghijkl', '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)', '$10|$1|$01|$11'],
    ['abcdefghijkl', '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)', '$11|$12|$10|$110'],
    ['abcdefghijkl', '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)', '$12|$13|$120'],
    ['abcdefghij', '(a)(b)(c)(d)(e)(f)(g)(h)(i)', '$9|$90|$09|$10'],
    ['aXbXc', 'X', '$&$&'],
    ['aXbXc', 'X', "[$`|$']"],
    ['', 'x', 'y'],
    ['abc', 'x', 'y'],
    ['abc', '', '-'],
  ])('matches String.replace for %j /%s/ -> %j', (text, pattern, replacement) => {
    same(text, pattern, replacement);
  });

  it('inserts the replacement text literally when asked', () => {
    expect(boundedReplace('abab', g('b'), '$&$1', true)).toBe('a$&$1a$&$1');
  });

  it('accepts output of exactly 32 KiB and refuses one byte more', () => {
    const limit = TRANSFORM_LIMITS.valueBytes;
    const fits = boundedReplace('a'.repeat(limit - 2), g('x'), '');
    expect(fits).toHaveLength(limit - 2);
    expect(failure(() => boundedReplace('a'.repeat(limit - 1), g('x'), ''))).toBe(
      'transform.limit_exceeded'
    );
  });

  it('counts replacement bytes before building the result', () => {
    expect(
      failure(() => boundedReplace('aaaa', g('a'), 'b'.repeat(TRANSFORM_LIMITS.valueBytes / 2)))
    ).toBe('transform.limit_exceeded');
    expect(
      failure(() => boundedReplace('aaaa', g('a'), 'b'.repeat(TRANSFORM_LIMITS.valueBytes), true))
    ).toBe('transform.limit_exceeded');
    expect(
      failure(() => boundedReplace('a', g('a'), '$&'.repeat(TRANSFORM_LIMITS.valueBytes)))
    ).toBe('transform.limit_exceeded');
  });
});

describe('value_map', () => {
  const entries = JSON.stringify([
    ['Male', 'M'],
    ['female', 'F'],
  ]);
  const map = (item: unknown, parameters: Record<string, unknown> = {}) =>
    run('value_map', item, { entries, otherwise: 'as_is', ...parameters });

  it('maps exact matches and applies the fallback to the rest', () => {
    expect(map('Male')).toBe('M');
    expect(map('female')).toBe('F');
    expect(map('male')).toBe('male');
    expect(map('other', { otherwise: 'none' })).toBeNull();
    expect(map('other', { otherwise: 'fixed', fallbackValue: 'U' })).toBe('U');
    expect(map('other', { otherwise: 'fixed' })).toBe('');
    expect(map('other', { otherwise: 'bogus' })).toBe('other');
  });

  it('matches case-insensitively only when ignoreCase is true', () => {
    expect(map('MALE', { ignoreCase: true })).toBe('M');
    expect(map('FEMALE', { ignoreCase: true })).toBe('F');
    expect(map('MALE')).toBe('MALE');
    expect(map('MALE', { ignoreCase: 'true' })).toBe('MALE');
  });

  it('keeps the first of repeated keys, maps a list and leaves non-text alone', () => {
    const repeated = JSON.stringify([
      ['a', '1'],
      ['a', '2'],
    ]);
    expect(map('a', { entries: repeated })).toBe('1');
    expect(map(['Male', 'x', 'female'])).toEqual(['M', 'x', 'F']);
    expect(map(5, { otherwise: 'none' })).toBe(5);
    expect(map(null, { otherwise: 'none' })).toBeNull();
  });

  it('falls back when the table cannot be read', () => {
    expect(map('Male', { entries: 'nope' })).toBe('Male');
    expect(map('Male', { entries: 'nope', otherwise: 'none' })).toBeNull();
  });
});

describe('width conversion', () => {
  it('converts full-width ASCII and ideographic space to half-width', () => {
    expect(toHalfwidth('ＡＢＣ１２３！～　ｘ', false)).toBe('ABC123!~ x');
    expect(toHalfwidth('！', false)).toBe('!');
    expect(toHalfwidth('～', false)).toBe('~');
    expect(toHalfwidth('ガ', false)).toBe('ガ');
  });

  it('converts half-width ASCII and space to full-width', () => {
    expect(toFullwidth('ABC123!~ x', false)).toBe('ＡＢＣ１２３！～　ｘ');
    expect(toFullwidth('!', false)).toBe('！');
    expect(toFullwidth('~', false)).toBe('～');
    expect(toFullwidth('ｶﾞ', false)).toBe('ｶﾞ');
  });

  it('converts katakana to half-width only when asked', () => {
    expect(toHalfwidth('アイウエオ', true)).toBe('ｱｲｳｴｵ');
    expect(toHalfwidth('ガギグゲゴ', true)).toBe('ｶﾞｷﾞｸﾞｹﾞｺﾞ');
    expect(toHalfwidth('パピプペポ', true)).toBe('ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ');
    expect(toHalfwidth('ヴ', true)).toBe('ｳﾞ');
    expect(toHalfwidth('ー、。「」・ヲン', true)).toBe('ｰ､｡｢｣･ｦﾝ');
    expect(toHalfwidth('゛゜', true)).toBe('ﾞﾟ');
    expect(toHalfwidth(`${VOICED}${SEMI}`, true)).toBe('ﾞﾟ');
    expect(toHalfwidth(`カ${VOICED}`, true)).toBe('ｶﾞ');
    expect(toHalfwidth(`ハ${SEMI}`, true)).toBe('ﾊﾟ');
    expect(toHalfwidth(`ア${VOICED}`, true)).toBe('ｱﾞ');
    expect(toHalfwidth('アイウエオ', false)).toBe('アイウエオ');
    expect(toHalfwidth('ＡガＢ', true)).toBe('AｶﾞB');
  });

  it('does not compose or alter text that is not katakana', () => {
    expect(toHalfwidth(`e${ACUTE}`, true)).toBe(`e${ACUTE}`);
  });

  it('converts half-width katakana to full-width only when asked', () => {
    expect(toFullwidth('ｱｲｳｴｵ', true)).toBe('アイウエオ');
    expect(toFullwidth('ｶﾞｷﾞｸﾞｹﾞｺﾞ', true)).toBe('ガギグゲゴ');
    expect(toFullwidth('ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ', true)).toBe('パピプペポ');
    expect(toFullwidth('ｳﾞ', true)).toBe('ヴ');
    expect(toFullwidth('ｰ､｡｢｣･ｦﾝ', true)).toBe('ー、。「」・ヲン');
    expect(toFullwidth('ｱｲｳｴｵ', false)).toBe('ｱｲｳｴｵ');
    expect(toFullwidth('Aｶﾞ B', true)).toBe('Ａガ　Ｂ');
  });
});

describe('accent folding', () => {
  it('removes combining marks from Latin, Greek and Cyrillic letters', () => {
    expect(stripAccents('José Müller Ångström')).toBe('Jose Muller Angstrom');
    expect(stripAccents(`e${ACUTE}`)).toBe('e');
    expect(stripAccents('Ελληνικά')).toBe('Ελληνικα');
    expect(stripAccents('ё')).toBe('е');
  });

  it('keeps Japanese voiced marks and other non-Latin signs', () => {
    expect(stripAccents('ガ')).toBe('ガ');
    expect(stripAccents('パ')).toBe('パ');
    expect(stripAccents('שָׁלוֹם')).toBe('שָׁלוֹם');
  });

  it.each([
    ['ß', 'ss'],
    ['ẞ', 'SS'],
    ['æ', 'ae'],
    ['Æ', 'AE'],
    ['œ', 'oe'],
    ['Œ', 'OE'],
    ['ø', 'o'],
    ['Ø', 'O'],
    ['ł', 'l'],
    ['Ł', 'L'],
    ['đ', 'd'],
    ['Đ', 'D'],
    ['ð', 'd'],
    ['Ð', 'D'],
    ['þ', 'th'],
    ['Þ', 'TH'],
    ['ı', 'i'],
  ])('folds the letter %s to %s', (letter, folded) => {
    expect(stripAccents(letter)).toBe(folded);
    expect(stripAccents(`a${letter}b`)).toBe(`a${folded}b`);
  });

  it('leaves other letters alone', () => {
    expect(stripAccents('Straße ok 123 日本語')).toBe('Strasse ok 123 日本語');
  });

  it.each([
    [0x0300, 0x036f],
    [0x1ab0, 0x1aff],
    [0x1dc0, 0x1dff],
    [0x20d0, 0x20ff],
    [0xfe20, 0xfe2f],
  ])('removes marks from code point %d through %d and no others', (from, to) => {
    const mark = (code: number) => String.fromCodePoint(code);
    expect(stripAccents(`a${mark(from)}`)).toBe('a');
    expect(stripAccents(`a${mark(to)}`)).toBe('a');
    // Neighbours that are not marks stay, unless they are precomposed letters that decompose.
    for (const near of [mark(from - 1), mark(to + 1)]) {
      if (near.normalize('NFD') === near) expect(stripAccents(`a${near}`)).toBe(`a${near}`);
    }
  });
});

describe('ascii digits', () => {
  it.each([
    ['٠١٢٣٤٥٦٧٨٩', '0123456789'],
    ['۴۵۶', '456'],
    ['१२३', '123'],
    ['０１２３４５６７８９', '0123456789'],
    ['𝟎𝟏𝟗', '019'],
    ['𝟘𝟙𝟡', '019'],
    ['𝟬𝟭𝟵', '019'],
    ['𝟶𝟷𝟿', '019'],
    ['0123456789', '0123456789'],
    ['a1٢b３', 'a12b3'],
    ['no digits ./:', 'no digits ./:'],
  ])('folds %s to %s', (input, output) => {
    expect(asciiDigits(input)).toBe(output);
  });
});
