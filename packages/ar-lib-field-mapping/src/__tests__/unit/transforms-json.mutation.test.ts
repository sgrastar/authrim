import { describe, expect, it } from 'vitest';
import { validateTransformStep } from '../../core/transforms';
import type { SourceValueEnvelope } from '../../core/types';
import { run, target } from './transforms-run.helper';

const value = (...args: Parameters<typeof run>) => run(...args).value?.value;
const codes = (...args: Parameters<typeof run>) => run(...args).reasons.map((item) => item.code);

const DOC = '{"a":{"b":[10,{"c":"deep","n":null,"t":true,"f":1.5}],"s":" 42 "},"top":"x"}';

describe('json paths', () => {
  it.each([
    ['a.b[0]', 10],
    ['a.b[1].c', 'deep'],
    ['top', 'x'],
    ['a.s', ' 42 '],
    [' top ', 'x'],
  ])('reads %s', (path, expected) => {
    expect(value('json_extract_or', [DOC], { path, defaultValue: 'D' })).toBe(
      typeof expected === 'number' ? String(expected) : expected
    );
  });

  it('reads from the root of an array and through nested indexes', () => {
    expect(value('json_extract_text', ['[[1,2],[3,4]]'], { path: '[1][0]' })).toBe('3');
    expect(value('json_extract_text', ['[[1,2],[3,4]]'], { path: '[0]' })).toBe('[1,2]');
    expect(value('json_extract_text', ['[{"a":7}]'], { path: '[0].a' })).toBe('7');
  });

  it('returns nothing for steps that do not exist or have the wrong shape', () => {
    for (const path of [
      'zzz',
      'a.zzz',
      'a.b[5]',
      'a.b.c',
      'top.x',
      'a[0]',
      'a.b[0].x',
      'a.b[0][0]',
    ]) {
      expect(value('json_extract_or', [DOC], { path, defaultValue: 'D' })).toBe('D');
    }
    expect(value('json_extract_or', ['[1,2]'], { path: 'a', defaultValue: 'D' })).toBe('D');
    expect(value('json_extract_or', ['{"a":1}'], { path: '[0]', defaultValue: 'D' })).toBe('D');
    expect(value('json_extract_or', ['{"a":null}'], { path: 'a.b', defaultValue: 'D' })).toBe('D');
  });

  it('does not read properties of text or arrays', () => {
    expect(value('json_extract_or', [DOC], { path: 'top.length', defaultValue: 'D' })).toBe('D');
    expect(value('json_extract_or', [DOC], { path: 'a.b.length', defaultValue: 'D' })).toBe('D');
    expect(value('json_extract_or', [DOC], { path: 'a.b[0].length', defaultValue: 'D' })).toBe('D');
  });

  it('only follows own properties', () => {
    expect(value('json_extract_or', ['{"a":1}'], { path: 'toString', defaultValue: 'D' })).toBe(
      'D'
    );
    expect(
      value('json_extract_or', ['{"a":1}'], { path: 'hasOwnProperty', defaultValue: 'D' })
    ).toBe('D');
  });

  it('accepts objects as well as JSON text and ignores everything else', () => {
    expect(value('json_extract_text', [{ a: { b: 1 } }], { path: 'a.b' })).toBe('1');
    expect(value('json_extract_text', [[{ a: 'x' }]], { path: '[0].a' })).toBe('x');
    expect(value('json_extract_text', ['  {"a":"y"}  '], { path: 'a' })).toBe('y');
    expect(value('json_extract_text', ['  ["y"]  '], { path: '[0]' })).toBe('y');
    for (const text of [
      'plain',
      '5',
      '"s"',
      'null',
      '{bad',
      '[bad',
      '',
      'true',
      '{"a":"x"} trailing',
    ]) {
      expect(value('json_extract_text', [text], { path: 'a' })).toBeNull();
    }
    expect(value('json_extract_text', [5], { path: 'a' })).toBeNull();
    expect(value('json_extract_text', [true], { path: 'a' })).toBeNull();
  });

  const pathReasons = (path: string) =>
    validateTransformStep({
      id: 's',
      inputEdgeIds: ['e'],
      operation: 'json_extract_text',
      parameters: { path },
      outputTargetRef: target,
    }).reasons.map((item) => item.code);

  it.each([
    'a',
    'a.b',
    'a[0]',
    'a[0][1]',
    'a[0].b',
    '[0]',
    '[0].a',
    '[12][3]',
    'a.b.c.d',
    ' a ',
    'a-b',
    'a_b$',
    '[499]',
    'a.b[10]',
    'a.b[12][34]',
    'a[1].b[22].c[333]',
    Array.from({ length: 32 }, () => 'a').join('.'),
    'a'.repeat(512),
  ])('accepts the path %j', (path) => {
    expect(pathReasons(path)).toEqual([]);
  });

  it.each([
    '',
    '   ',
    'a.',
    'a..b',
    'a b',
    'a[x]',
    'a[]',
    'a[-1]',
    'a[1',
    'a]1[',
    '[0',
    'a[0]b',
    '__proto__',
    'a.__proto__',
    'prototype',
    'a.prototype.b',
    'constructor',
    'a.constructor',
    '[500]',
    'a[99999999999999999999999]',
    Array.from({ length: 33 }, () => 'a').join('.'),
    'a'.repeat(513),
  ])('rejects the path %j', (path) => {
    expect(pathReasons(path)).toEqual(['transform.invalid_parameter']);
  });

  it('counts index segments toward the segment limit', () => {
    expect(pathReasons(`${'[0]'.repeat(32)}`)).toEqual([]);
    expect(pathReasons(`${'[0]'.repeat(33)}`)).toEqual(['transform.invalid_parameter']);
    expect(pathReasons(`a${'[0]'.repeat(31)}`)).toEqual([]);
    expect(pathReasons(`a${'[0]'.repeat(32)}`)).toEqual(['transform.invalid_parameter']);
  });
});

describe('json_extract_text', () => {
  const text = (path: string) => value('json_extract_text', [DOC], { path });

  it('renders scalars and serialises containers', () => {
    expect(text('a.b[1].c')).toBe('deep');
    expect(text('a.b[0]')).toBe('10');
    expect(text('a.b[1].t')).toBe('true');
    expect(text('a.b[1].f')).toBe('1.5');
    expect(text('a.b[1]')).toBe('{"c":"deep","n":null,"t":true,"f":1.5}');
    expect(text('a.b')).toBe('[10,{"c":"deep","n":null,"t":true,"f":1.5}]');
  });

  it('renders non-finite numbers of object inputs by their name', () => {
    expect(value('json_extract_text', [{ a: Number.NaN }], { path: 'a' })).toBe('NaN');
    expect(value('json_extract_text', [{ a: Number.NEGATIVE_INFINITY }], { path: 'a' })).toBe(
      '-Infinity'
    );
  });

  it('returns null for null, missing and oversized containers', () => {
    expect(text('a.b[1].n')).toBeNull();
    expect(text('nope')).toBeNull();
  });

  it('limits the serialised size to 2048 characters', () => {
    const fit = JSON.stringify({ a: { v: 'x'.repeat(2040) } });
    expect(value('json_extract_text', [fit], { path: 'a' })).toBe(`{"v":"${'x'.repeat(2040)}"}`);
    const exact = { v: 'x'.repeat(2040) };
    expect(JSON.stringify(exact)).toHaveLength(2048);
    const over = JSON.stringify({ a: { v: 'x'.repeat(2041) } });
    expect(value('json_extract_text', [over], { path: 'a' })).toBeNull();
  });

  it('refuses containers with more than 200 keys', () => {
    const many = (count: number) =>
      JSON.stringify({
        a: Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, 1])),
      });
    expect(String(value('json_extract_text', [many(200)], { path: 'a' }))).toContain('"k199":1');
    expect(value('json_extract_text', [many(201)], { path: 'a' })).toBeNull();
  });

  it('refuses parsed documents that exceed the value limits', () => {
    const deep = `${'['.repeat(14)}${']'.repeat(14)}`;
    expect(codes('json_extract_text', [deep], { path: '[0]' })).toEqual([
      'transform.limit_exceeded',
    ]);
    const items = `[${Array.from({ length: 501 }, () => '1').join(',')}]`;
    expect(codes('json_extract_text', [items], { path: '[0]' })).toEqual([
      'transform.limit_exceeded',
    ]);
    const shallow = `${'['.repeat(12)}${']'.repeat(12)}`;
    expect(codes('json_extract_text', [shallow], { path: '[0]' })).toEqual([]);
  });
});

describe('json_extract_integer', () => {
  const int = (v: unknown) => value('json_extract_integer', [{ a: v }], { path: 'a' });

  it('accepts integers and integer text', () => {
    expect(int(7)).toBe(7);
    expect(int(-7)).toBe(-7);
    expect(int(0)).toBe(0);
    expect(int('42')).toBe(42);
    expect(int(' -42 ')).toBe(-42);
    expect(int('007')).toBe(7);
  });

  it('rejects everything else', () => {
    for (const bad of [
      1.5,
      '1.5',
      '4x',
      'x4',
      '',
      ' ',
      '+5',
      '--5',
      '1e3',
      true,
      null,
      [1],
      { a: 1 },
    ]) {
      expect(int(bad)).toBeNull();
    }
    expect(value('json_extract_integer', [{}], { path: 'a' })).toBeNull();
    expect(value('json_extract_integer', ['not json'], { path: 'a' })).toBeNull();
  });
});

describe('json_extract_boolean', () => {
  const bool = (v: unknown) => value('json_extract_boolean', [{ a: v }], { path: 'a' });

  it('reads booleans and boolean-like text with the default vocabulary', () => {
    expect(bool(true)).toBe(true);
    expect(bool(false)).toBe(false);
    expect(bool('Yes')).toBe(true);
    expect(bool(' off ')).toBe(false);
    expect(bool(1)).toBe(true);
    expect(bool(0)).toBe(false);
    expect(bool('maybe')).toBeNull();
    expect(bool(null)).toBeNull();
    expect(value('json_extract_boolean', [{}], { path: 'a' })).toBeNull();
  });
});

describe('json_extract_array', () => {
  const arr = (document: unknown, path = 'a') => run('json_extract_array', [document], { path });

  it('returns arrays as they are', () => {
    expect(arr({ a: [1, 'x', [2]] }).value?.value).toEqual([1, 'x', [2]]);
    expect(arr({ a: [] }).value?.value).toEqual([]);
  });

  it('returns null for scalars and nothing for missing values', () => {
    expect(arr({ a: 'x' }).value?.value).toBeNull();
    expect(arr({ a: 5 }).value?.value).toBeNull();
    expect(arr({ a: null }).value?.value).toBeNull();
    expect(arr({ a: { b: 1 } }).value?.value).toBeNull();
    expect(arr({ b: 1 }).value?.value).toBeUndefined();
    expect(arr({ b: 1 }).status).toBe('success');
    expect(arr('not json').value?.value).toBeUndefined();
  });
});

describe('json_extract_or', () => {
  const or = (document: unknown, extra: Record<string, unknown> = {}) =>
    value('json_extract_or', [document], { path: 'a', defaultValue: 'D', ...extra });

  it('renders the extracted value as text', () => {
    expect(or({ a: 'x' })).toBe('x');
    expect(or({ a: '' })).toBe('');
    expect(or({ a: 5 })).toBe('5');
    expect(or({ a: 0 })).toBe('0');
    expect(or({ a: false })).toBe('false');
    expect(or({ a: true })).toBe('true');
    expect(or({ a: { b: 1 } })).toBe('{"b":1}');
    expect(or({ a: [1, 'x'] })).toBe('[1,"x"]');
  });

  it('renders non-finite numbers of object inputs by their name', () => {
    expect(or({ a: Number.NaN })).toBe('NaN');
    expect(or({ a: Number.POSITIVE_INFINITY })).toBe('Infinity');
    expect(or({ a: Number.NEGATIVE_INFINITY })).toBe('-Infinity');
    expect(or({ a: -0 })).toBe('0');
    expect(or({ a: 1e21 })).toBe('1e+21');
  });

  it('uses the default for missing values and keeps null unless it counts as missing', () => {
    expect(or({ b: 1 })).toBe('D');
    expect(or('not json')).toBe('D');
    expect(or({ a: null })).toBeNull();
    expect(or({ a: null }, { nullAsMissing: false })).toBeNull();
    expect(or({ a: null }, { nullAsMissing: true })).toBe('D');
    expect(or({ a: 'x' }, { nullAsMissing: true })).toBe('x');
  });
});

describe('json_build', () => {
  const sources = (
    ...items: Array<[unknown, Partial<SourceValueEnvelope>]>
  ): { values: unknown[]; envelopes: SourceValueEnvelope[] } => ({
    values: items.map(([v]) => v),
    envelopes: items.map(([v, extra], index) => ({
      value: v,
      sourceRef: { side: 'source', namespace: 'csv', path: `field-${index}` },
      ...extra,
    })),
  });
  const build = (
    items: Array<[unknown, Partial<SourceValueEnvelope>]>,
    parameters: Record<string, unknown> = { nullHandling: 'omit' }
  ) => {
    const { values, envelopes } = sources(...items);
    return run('json_build', values, parameters, { envelopes });
  };
  const path = (p: string): Partial<SourceValueEnvelope> => ({
    sourceRef: { side: 'source', namespace: 'csv', path: p },
  });

  it('returns a single JSON document as it is', () => {
    expect(build([['{"a":1}', {}]]).value?.value).toEqual({ a: 1 });
    expect(build([[' [1,2] ', {}]]).value?.value).toEqual([1, 2]);
    expect(build([[{ a: 1 }, {}]]).value?.value).toEqual({ a: 1 });
    expect(build([[[1], {}]]).value?.value).toEqual([1]);
  });

  it('builds an object from several values and parses embedded JSON', () => {
    expect(
      build([
        ['{"x":1}', path('a')],
        ['b', path('b')],
        [3, path('c')],
        ['[1]', path('d')],
      ]).value?.value
    ).toEqual({ a: { x: 1 }, b: 'b', c: 3, d: [1] });
    expect(
      build([
        [{ x: 1 }, path('a')],
        [{ y: 2 }, path('b')],
      ]).value?.value
    ).toEqual({ a: { x: 1 }, b: { y: 2 } });
  });

  it('wraps a single plain value under its key', () => {
    expect(build([['abc', path('name')]]).value?.value).toEqual({ name: 'abc' });
    expect(build([['{bad', path('name')]]).value?.value).toEqual({ name: '{bad' });
    expect(build([['5', path('name')]]).value?.value).toEqual({ name: '5' });
  });

  it('omits or includes null-like values depending on the null handling', () => {
    const items: Array<[unknown, Partial<SourceValueEnvelope>]> = [
      [null, path('n')],
      ['', path('e')],
      [undefined, path('u')],
      [0, path('z')],
      [false, path('f')],
      ['v', path('v')],
    ];
    expect(build(items).value?.value).toEqual({ z: 0, f: false, v: 'v' });
    expect(build(items, { nullHandling: 'include_null' }).value?.value).toEqual({
      n: null,
      e: '',
      z: 0,
      f: false,
      v: 'v',
    });
    expect(build(items, { nullHandling: 'other' }).reasons.map((r) => r.code)).toEqual([
      'transform.invalid_parameter',
    ]);
  });

  it('does not reserve keys for skipped values', () => {
    const items: Array<[unknown, Partial<SourceValueEnvelope>]> = [
      [undefined, path('k')],
      ['x', path('k')],
    ];
    expect(build(items).value?.value).toEqual({ k: 'x' });
    expect(
      Object.keys(build(items, { nullHandling: 'include_null' }).value?.value as object)
    ).toEqual(['k']);
    const nulls: Array<[unknown, Partial<SourceValueEnvelope>]> = [
      [null, path('k')],
      ['x', path('k')],
    ];
    expect(Object.keys(build(nulls).value?.value as object)).toEqual(['k']);
    expect(
      Object.keys(build(nulls, { nullHandling: 'include_null' }).value?.value as object)
    ).toEqual(['k', 'k_2']);
  });

  it('treats a lone null value as an empty object', () => {
    expect(build([[null, path('n')]]).value?.value).toEqual({});
    expect(build([[null, path('n')]], { nullHandling: 'include_null' }).value?.value).toEqual({
      n: null,
    });
  });

  describe('keys', () => {
    const keyOf = (extra: Partial<SourceValueEnvelope>, keyMap?: unknown) =>
      Object.keys(
        build(
          [['v', extra]],
          keyMap === undefined ? { nullHandling: 'omit' } : { nullHandling: 'omit', keyMap }
        ).value?.value as Record<string, unknown>
      )[0];

    it('prefers the column name and otherwise the last path segment', () => {
      expect(
        keyOf({ ...path('a.b.c'), metadata: { sourceType: 'csv', columnName: 'First Name' } })
      ).toBe('First_Name');
      expect(keyOf(path('a.b.c'))).toBe('c');
      expect(keyOf(path('plain'))).toBe('plain');
      expect(keyOf(path('a.'))).toBe('a');
      expect(keyOf({ ...path('p'), metadata: { sourceType: 'csv', columnName: 5 as never } })).toBe(
        'p'
      );
    });

    it('sanitises keys', () => {
      expect(keyOf(path(' Name '))).toBe('Name');
      expect(keyOf(path('a-b c'))).toBe('a_b_c');
      expect(keyOf(path('__x__y__'))).toBe('x__y');
      expect(keyOf(path('$id'))).toBe('$id');
      expect(keyOf(path('!!!'))).toBe('value');
      expect(keyOf(path('___'))).toBe('value');
      expect(keyOf(path('é'))).toBe('value');
      expect(keyOf(path('a!!b'))).toBe('a_b');
      expect(keyOf(path('_'))).toBe('value');
    });

    it('maps keys through the key map using every source key in priority order', () => {
      const meta = (extra: Record<string, string>) => ({
        sourceType: 'csv',
        ...extra,
      });
      const keyMap = JSON.stringify({
        'field.id': 'by_id',
        col: 'by_col',
        hdr: 'by_hdr',
        fp: 'by_fp',
        pth: 'by_path',
      });
      const full: Partial<SourceValueEnvelope> = {
        sourceRef: { side: 'source', namespace: 'csv', path: 'pth', catalogEntryId: 'field.id' },
        metadata: meta({ columnName: 'col', csvHeaderName: 'hdr', fieldPath: 'fp' }),
      };
      expect(keyOf(full, keyMap)).toBe('by_id');
      expect(
        keyOf({ ...full, sourceRef: { side: 'source', namespace: 'csv', path: 'pth' } }, keyMap)
      ).toBe('by_col');
      expect(
        keyOf(
          {
            ...full,
            sourceRef: { side: 'source', namespace: 'csv', path: 'pth' },
            metadata: meta({ csvHeaderName: 'hdr', fieldPath: 'fp' }),
          },
          keyMap
        )
      ).toBe('by_hdr');
      expect(
        keyOf(
          {
            ...full,
            sourceRef: { side: 'source', namespace: 'csv', path: 'pth' },
            metadata: meta({ fieldPath: 'fp' }),
          },
          keyMap
        )
      ).toBe('by_fp');
      expect(keyOf(path('pth'), keyMap)).toBe('by_path');
      expect(keyOf(path('other'), keyMap)).toBe('other');
    });

    it('trims mapped names and ignores unusable entries', () => {
      expect(keyOf(path('p'), JSON.stringify({ p: '  mapped  ' }))).toBe('mapped');
      expect(keyOf(path('p'), JSON.stringify({ p: '   ' }))).toBe('p');
      expect(keyOf(path('p'), JSON.stringify({ p: '' }))).toBe('p');
      expect(keyOf(path('p'), JSON.stringify({ p: 5 }))).toBe('p');
      expect(keyOf(path('p'), JSON.stringify({ p: null }))).toBe('p');
      expect(keyOf(path('p'), JSON.stringify({ p: 'ok!' }))).toBe('ok!');
    });

    it('ignores key maps that are blank, malformed or not objects', () => {
      expect(keyOf(path('p'), '')).toBe('p');
      expect(keyOf(path('p'), '   ')).toBe('p');
      expect(keyOf(path('p'), '{bad')).toBe('p');
      expect(keyOf(path('p'), 'null')).toBe('p');
      expect(keyOf(path('p'), '5')).toBe('p');
      expect(keyOf(path('p'), '"p"')).toBe('p');
      expect(keyOf(path('p'), '["p"]')).toBe('p');
      expect(keyOf(path('0'), '"xyz"')).toBe('0');
      expect(keyOf(path('p'), '[{"p":"x"}]')).toBe('p');
    });

    it('ignores key maps that exceed the size limits', () => {
      const entry = JSON.stringify({ p: 'mapped' }).slice(0, -1);
      const withExtra = (extra: string) => `${entry},${extra}}`;
      expect(keyOf(path('p'), withExtra('"x":"y"'))).toBe('mapped');
      const manyKeys = Array.from({ length: 200 }, (_, i) => `"k${i}":"v"`).join(',');
      expect(keyOf(path('p'), withExtra(manyKeys))).toBe('p');
      const exactKeys = Array.from({ length: 199 }, (_, i) => `"k${i}":"v"`).join(',');
      expect(keyOf(path('p'), withExtra(exactKeys))).toBe('mapped');
      const manyNodes = `"a":[${Array.from({ length: 1000 }, () => '0').join(',')}]`;
      expect(keyOf(path('p'), withExtra(manyNodes))).toBe('p');
      const threeArrays = (last: number) =>
        [400, 400, last]
          .map((count, i) => `"a${i}":[${Array.from({ length: count }, () => '0').join(',')}]`)
          .join(',');
      // 1 object + 1 mapped string + 3 arrays + 995 items = 1000 nodes, one more is too many.
      expect(keyOf(path('p'), withExtra(threeArrays(195)))).toBe('mapped');
      expect(keyOf(path('p'), withExtra(threeArrays(196)))).toBe('p');
      const longText = 'x'.repeat(2049);
      expect(keyOf(path('p'), withExtra(`"a":[0,"${longText}"]`))).toBe('p');
      expect(keyOf(path('p'), withExtra(`"a":["${longText}",0]`))).toBe('p');
      expect(keyOf(path('p'), `{"s":"${longText}","p":"mapped"}`)).toBe('p');
      expect(keyOf(path('p'), `{"p":"mapped","s":"${longText}"}`)).toBe('p');
      const deep = `"d":${'['.repeat(13)}0${']'.repeat(13)}`;
      expect(keyOf(path('p'), withExtra(deep))).toBe('p');
      const shallow = `"d":${'['.repeat(11)}0${']'.repeat(11)}`;
      expect(keyOf(path('p'), withExtra(shallow))).toBe('mapped');
      const longItems = `"a":[${Array.from({ length: 501 }, () => '0').join(',')}]`;
      expect(keyOf(path('p'), withExtra(longItems))).toBe('p');
      const okItems = `"a":[${Array.from({ length: 500 }, () => '0').join(',')}]`;
      expect(keyOf(path('p'), withExtra(okItems))).toBe('mapped');
      expect(keyOf(path('p'), withExtra(`"s":"${'x'.repeat(2049)}"`))).toBe('p');
      expect(keyOf(path('p'), withExtra(`"s":"${'x'.repeat(2048)}"`))).toBe('mapped');
    });

    it('makes duplicate keys unique', () => {
      const result = build([
        ['1', path('k')],
        ['2', path('k')],
        ['3', path('k_2')],
        ['4', path('k')],
      ]).value?.value;
      expect(result).toEqual({ k: '1', k_2: '2', k_2_2: '3', k_3: '4' });
      expect(Object.keys(result as object)).toEqual(['k', 'k_2', 'k_2_2', 'k_3']);
    });
  });

  it('does not turn two values into one when the first is a document', () => {
    expect(
      build([
        ['{"a":1}', path('x')],
        ['{"b":2}', path('y')],
      ]).value?.value
    ).toEqual({ x: { a: 1 }, y: { b: 2 } });
  });

  it('refuses values that would exceed the output limits', () => {
    expect(build([['x'.repeat(2049), path('k')]]).reasons.map((item) => item.code)).toEqual([
      'transform.invalid_output',
    ]);
  });

  it('limits the serialised output to 32768 bytes', () => {
    // Control characters serialise to six bytes each (\u0001). With keys a, b and c the output is
    // 22 bytes of framing plus the three escaped contents.
    const escaped = (count: number, plain: number) => '\u0001'.repeat(count) + 'x'.repeat(plain);
    const items = (plain: number): Array<[unknown, Partial<SourceValueEnvelope>]> => [
      [escaped(2048, 0), path('a')],
      [escaped(2048, 0), path('b')],
      [escaped(1361, plain), path('c')],
    ];
    const ok = build(items(4));
    expect(ok.reasons).toEqual([]);
    expect(JSON.stringify(ok.value?.value)).toHaveLength(32768);
    expect(build(items(5)).reasons.map((item) => item.code)).toEqual(['transform.invalid_output']);
  });
});
