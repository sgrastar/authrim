import { describe, expect, it } from 'vitest';
import { run } from './transforms-run.helper';

const value = (...args: Parameters<typeof run>) => run(...args).value?.value;

describe('split', () => {
  it('splits on a comma by default and keeps item whitespace', () => {
    expect(value('split', ['a, b ,c'])).toEqual(['a', ' b ', 'c']);
  });

  it('uses the configured delimiter and falls back to a comma for an empty one', () => {
    expect(value('split', ['a;b,c'], { delimiter: ';' })).toEqual(['a', 'b,c']);
    expect(value('split', ['a;b,c'], { delimiter: '' })).toEqual(['a;b', 'c']);
    expect(value('split', ['a b'], { delimiter: ' ' })).toEqual(['a', 'b']);
  });

  it('trims, omits empty items and removes duplicates when asked', () => {
    expect(value('split', [' a , ,b, a '], { trimItems: true })).toEqual(['a', '', 'b', 'a']);
    expect(value('split', ['a,,b,'], { omitEmpty: true })).toEqual(['a', 'b']);
    expect(value('split', ['a,b,a,b'], { unique: true })).toEqual(['a', 'b']);
    expect(
      value('split', [' a , ,b, a '], { trimItems: true, omitEmpty: true, unique: true })
    ).toEqual(['a', 'b']);
  });

  it('applies flags only for an exact boolean true', () => {
    expect(value('split', ['a,,a'], { omitEmpty: false, unique: false })).toEqual(['a', '', 'a']);
  });

  it('handles values that are not text', () => {
    expect(value('split', [5])).toEqual([5]);
    expect(value('split', [true])).toEqual([true]);
    expect(value('split', [null])).toEqual([]);
    expect(value('split', [undefined])).toEqual([]);
    expect(value('split', [['a', ['b', 'c'], 'd']])).toEqual(['a', 'b', 'c', 'd']);
    expect(value('split', [[' a ', '', null]], { trimItems: true, omitEmpty: true })).toEqual([
      'a',
    ]);
  });
});

describe('as_array', () => {
  it('wraps a single value and flattens one level', () => {
    expect(value('as_array', ['a'])).toEqual(['a']);
    expect(value('as_array', [['a', ['b']]])).toEqual(['a', ['b']]);
    expect(value('as_array', [null])).toEqual([null]);
  });

  it('removes empty items and duplicates', () => {
    expect(
      value('as_array', [[' a ', '', null, undefined, 'a', ' a ']], {
        trimItems: true,
        omitEmpty: true,
        unique: true,
      })
    ).toEqual(['a']);
    expect(value('as_array', [['', 0, false, null]], { omitEmpty: true })).toEqual([0, false]);
  });

  it('treats values of different types and null-like values as distinct when unique', () => {
    expect(value('as_array', [[1, '1', 1, '1', true, 'true']], { unique: true })).toEqual([
      1,
      '1',
      true,
      'true',
    ]);
    expect(
      value('as_array', [[null, null, undefined, undefined, 'null', 'undefined']], { unique: true })
    ).toEqual([null, undefined, 'null', 'undefined']);
    expect(value('as_array', [[{ a: 1 }, { a: 1 }, { a: 2 }, [1], [1]]], { unique: true })).toEqual(
      [{ a: 1 }, { a: 2 }, [1]]
    );
  });

  it('falls back to a text key for objects that cannot be serialised', () => {
    expect(value('as_array', [[{ a: 1n }, { b: 2n }]], { unique: true })).toEqual([{ a: 1n }]);
  });
});

describe('join', () => {
  it('joins inputs with a comma by default and the configured delimiter otherwise', () => {
    expect(value('join', ['a', 'b'])).toBe('a,b');
    expect(value('join', ['a', 'b', 'c'], { delimiter: ' | ' })).toBe('a | b | c');
    expect(value('join', ['a', 'b'], { delimiter: '' })).toBe('ab');
  });

  it('flattens array inputs and applies the array flags', () => {
    expect(value('join', [['a', 'b'], 'c'], { delimiter: '-' })).toBe('a-b-c');
    expect(
      value('join', [[' a ', ''], ' a '], {
        delimiter: '-',
        trimItems: true,
        omitEmpty: true,
        unique: true,
      })
    ).toBe('a');
  });

  it('skips undefined inputs but keeps null ones as empty text', () => {
    expect(value('join', ['a', undefined, 'b'])).toBe('a,b');
    expect(value('join', ['a', null, 'b'])).toBe('a,,b');
  });
});

describe('first', () => {
  it('returns the first value', () => {
    expect(value('first', ['x', 'y'])).toBe('x');
    expect(value('first', [['p', 'q']])).toBe('p');
    expect(value('first', [''])).toBe('');
    expect(value('first', [0])).toBe(0);
  });

  it('skips undefined inputs and honours trimming and omitting empty items', () => {
    expect(value('first', [undefined, 'y'])).toBe('y');
    expect(value('first', ['', ' y '], { omitEmpty: true, trimItems: true })).toBe('y');
    expect(value('first', ['  ', 'y'], { trimItems: true, omitEmpty: true })).toBe('y');
    expect(value('first', ['  ', 'y'], { trimItems: true })).toBe('');
  });

  it('returns null when nothing is left', () => {
    expect(value('first', [[]])).toBeNull();
    expect(value('first', ['', null], { omitEmpty: true })).toBeNull();
    expect(value('first', [undefined])).toBeNull();
    expect(value('first', [null])).toBeNull();
  });
});

describe('concat and fallback', () => {
  it('concatenates without a delimiter by default and drops null-like inputs', () => {
    expect(value('concat', ['a', 'b'])).toBe('ab');
    expect(value('concat', ['a', null, undefined, 'b'], { delimiter: '-' })).toBe('a-b');
    expect(value('concat', ['a', '', 'b'], { delimiter: '-' })).toBe('a--b');
    expect(value('concat', [1, 2], { delimiter: '+' })).toBe('1+2');
  });

  it('picks the first non-empty input for fallback', () => {
    expect(value('fallback', [undefined, null, '', 'x', 'y'])).toBe('x');
    expect(value('fallback', [0, 'x'])).toBe(0);
    expect(value('fallback', [false, 'x'])).toBe(false);
    expect(value('fallback', [undefined, null, ''])).toBeUndefined();
    expect(run('fallback', [null, '']).status).toBe('success');
  });
});

describe('copy and constants', () => {
  it('copies the first value and returns constant parameters', () => {
    expect(value('copy', ['x'])).toBe('x');
    expect(value('constant_text', [], { value: 'fixed' })).toBe('fixed');
    expect(value('constant_boolean', [], { value: false })).toBe(false);
    expect(value('constant_number', [], { value: -3.5 })).toBe(-3.5);
  });
});

describe('text shaping', () => {
  it('normalizes whitespace or unicode', () => {
    expect(value('normalize', ['  a \t b\n\nc  '], { mode: 'whitespace' })).toBe('a b c');
    expect(value('normalize', ['  a  '], { mode: 'unicode' })).toBe('  a  ');
    expect(value('normalize', ['ＡＢＣ１㌀'], { mode: 'unicode' })).toBe('ABC1アパート');
    expect(value('normalize', [null], { mode: 'whitespace' })).toBeNull();
  });

  it('changes case', () => {
    expect(value('case', ['Hello'], { mode: 'lower' })).toBe('hello');
    expect(value('case', ['Hello'], { mode: 'upper' })).toBe('HELLO');
    expect(value('case', ["hello wORLD-foo 2nd o'neil"], { mode: 'title' })).toBe(
      "Hello WORLD-Foo 2nd O'Neil"
    );
    expect(value('case', [null], { mode: 'upper' })).toBeNull();
  });

  it('trims only text', () => {
    expect(value('trim', [' \t a b \n'])).toBe('a b');
    expect(value('trim', [''])).toBe('');
    expect(value('trim', [null])).toBeNull();
  });

  it('wraps trimmed text with an affix and returns null for blank values', () => {
    expect(value('affix_text', [' x '], { prefix: '[', suffix: ']' })).toBe('[x]');
    expect(value('affix_text', ['x'], { suffix: '!' })).toBe('x!');
    expect(value('affix_text', ['x'], { prefix: '>' })).toBe('>x');
    expect(value('affix_text', ['x'])).toBe('x');
    expect(value('affix_text', [5], { prefix: '#' })).toBe('#5');
    expect(value('affix_text', [0])).toBe('0');
    expect(value('affix_text', [''], { prefix: '[' })).toBeNull();
    expect(value('affix_text', ['   '], { prefix: '[' })).toBeNull();
    expect(value('affix_text', [null], { prefix: '[' })).toBeNull();
    expect(value('affix_text', [undefined], { prefix: '[' })).toBeNull();
  });
});

describe('text_to_boolean', () => {
  it.each(['true', '1', 'yes', 'y', 'on', 'active', 'enabled', ' YES ', 'On'])(
    'treats %j as true by default',
    (text) => {
      expect(value('text_to_boolean', [text])).toBe(true);
    }
  );

  it.each(['false', '0', 'no', 'n', 'off', 'inactive', 'disabled', ' NO ', 'Off'])(
    'treats %j as false by default',
    (text) => {
      expect(value('text_to_boolean', [text])).toBe(false);
    }
  );

  it.each(['', '  ', 'null', 'none', 'n/a', 'unknown', 'maybe', '2'])(
    'treats %j as unknown by default',
    (text) => {
      expect(value('text_to_boolean', [text])).toBeNull();
    }
  );

  it('passes booleans through, maps null-like values to null and converts numbers', () => {
    expect(value('text_to_boolean', [true])).toBe(true);
    expect(value('text_to_boolean', [false])).toBe(false);
    expect(value('text_to_boolean', [null])).toBeNull();
    expect(value('text_to_boolean', [undefined])).toBeNull();
    expect(value('text_to_boolean', [1])).toBe(true);
    expect(value('text_to_boolean', [0])).toBe(false);
  });

  it('replaces the defaults with configured lists, split on commas and newlines', () => {
    const params = { trueValues: ' JA, si\nSURE ,,', falseValues: 'nein\nno-way' };
    expect(value('text_to_boolean', ['ja'], params)).toBe(true);
    expect(value('text_to_boolean', ['SI'], params)).toBe(true);
    expect(value('text_to_boolean', ['sure'], params)).toBe(true);
    expect(value('text_to_boolean', ['yes'], params)).toBeNull();
    expect(value('text_to_boolean', ['nein'], params)).toBe(false);
    expect(value('text_to_boolean', ['no-way'], params)).toBe(false);
    expect(value('text_to_boolean', ['no'], params)).toBeNull();
    expect(value('text_to_boolean', ['1'], params)).toBeNull();
  });

  it('uses the defaults for blank configured lists and ignores empty list items', () => {
    expect(value('text_to_boolean', ['yes'], { trueValues: '' })).toBe(true);
    expect(value('text_to_boolean', ['yes'], { trueValues: '   ' })).toBe(true);
    expect(value('text_to_boolean', ['no'], { falseValues: '' })).toBe(false);
    expect(value('text_to_boolean', [''], { trueValues: 'x,' })).toBeNull();
    expect(value('text_to_boolean', [''], { falseValues: ',y' })).toBeNull();
  });

  it('prefers the true list over the false list', () => {
    expect(value('text_to_boolean', ['x'], { trueValues: 'x', falseValues: 'x' })).toBe(true);
  });

  it('passes booleans and null-like values through before consulting the lists', () => {
    expect(value('text_to_boolean', [true], { trueValues: 'ja' })).toBe(true);
    expect(value('text_to_boolean', [false], { falseValues: 'nein' })).toBe(false);
    expect(value('text_to_boolean', [true], { falseValues: 'true' })).toBe(true);
    expect(value('text_to_boolean', [null], { trueValues: 'null,undefined' })).toBeNull();
    expect(value('text_to_boolean', [undefined], { trueValues: 'null,undefined' })).toBeNull();
    expect(value('text_to_boolean', ['null'], { trueValues: 'null' })).toBe(true);
  });
});

describe('unique keys for unusual items', () => {
  it('keeps values of different types apart even when they print the same', () => {
    expect(value('as_array', [[1, 1n, 1, 1n]], { unique: true })).toEqual([1, 1n]);
  });

  it('keys objects that cannot be serialised by their text form', () => {
    const named = (n: bigint, text: string) => ({ n, toString: () => text });
    const result = value('as_array', [[named(1n, 'X'), named(2n, 'Y'), named(3n, 'X')]], {
      unique: true,
    });
    expect(result).toHaveLength(2);
    expect(String((result as unknown[])[0])).toBe('X');
    expect(String((result as unknown[])[1])).toBe('Y');
  });
});
