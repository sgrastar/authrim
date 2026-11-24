/**
 * SCIM mapper PATCH handling - mutation-hardening tests
 *
 * Pins path splitting, extension URN matching, filtered multi-valued attributes, property
 * attributes of created values and prototype-pollution guards.
 */

import { describe, it, expect } from 'vitest';
import {
  applyPatchOperations,
  selectPrimaryScimObject,
  selectPrimaryScimValue,
} from '../utils/scim-mapper';

type Doc = Record<string, unknown>;
type Op = { op: 'add' | 'remove' | 'replace'; path?: string; value?: never };

function patch(resource: Doc, ops: Array<{ op: unknown; path?: string; value?: unknown }>): Doc {
  return applyPatchOperations<Doc>(resource, ops as unknown as Op[]);
}

describe('selectPrimaryScimObject', () => {
  it('returns undefined for a value that is not an array', () => {
    expect(selectPrimaryScimObject(undefined)).toBeUndefined();
    expect(selectPrimaryScimObject({ value: 'a' })).toBeUndefined();
    expect(selectPrimaryScimObject('a')).toBeUndefined();
  });

  it('ignores entries that are not plain objects', () => {
    expect(selectPrimaryScimObject([null, 'x', 7, ['nested'], { value: 'a' }])).toEqual({
      value: 'a',
    });
    expect(selectPrimaryScimObject([null, 'x', ['nested']])).toBeUndefined();
  });

  it('prefers the entry flagged primary, wherever it is', () => {
    const list = [{ value: 'a' }, { value: 'b', primary: true }, { value: 'c', primary: true }];
    expect(selectPrimaryScimObject(list)).toEqual({ value: 'b', primary: true });
    expect(selectPrimaryScimValue(list)).toBe('b');
  });

  it('does not take a primary flag that is not boolean true', () => {
    expect(selectPrimaryScimObject([{ value: 'a' }, { value: 'b', primary: 'true' }])).toEqual({
      value: 'a',
    });
  });

  it('gives no value for an empty list', () => {
    expect(selectPrimaryScimValue([])).toBeUndefined();
  });
});

describe('extension URN paths', () => {
  const add = (path: string): Doc => patch({}, [{ op: 'add', path, value: 'v' }]);

  it.each([
    ['urn:x:2.0:Aname:attr', 'urn:x:2.0:Aname'],
    ['urn:x:2.0:Zname:attr', 'urn:x:2.0:Zname'],
    ['urn:x:2.0:aname:attr', 'urn:x:2.0:aname'],
    ['urn:x:2.0:zname:attr', 'urn:x:2.0:zname'],
    ['urn:x:2.0:xAZaz09:attr', 'urn:x:2.0:xAZaz09'],
    ['urn:x:9.9:User:attr', 'urn:x:9.9:User'],
    ['urn:x:10.25:User:attr', 'urn:x:10.25:User'],
    ['urn:x:0.0:User:attr', 'urn:x:0.0:User'],
  ])('reads the extension out of %s', (path, urn) => {
    expect(add(path)).toEqual({ [urn]: { attr: 'v' } });
  });

  it('splits what follows the extension at its dots', () => {
    expect(add('urn:x:2.0:User:a.b')).toEqual({ 'urn:x:2.0:User': { a: { b: 'v' } } });
  });

  it('takes a path that is only the extension as the extension itself', () => {
    expect(add('urn:x:2.0:User')).toEqual({ 'urn:x:2.0:User': 'v' });
  });

  it.each([
    [
      'a schema name starting with a digit',
      'urn:x:2.0:9abc:attr',
      { 'urn:x:2': { '0:9abc:attr': 'v' } },
    ],
    [
      'a schema name starting with an underscore',
      'urn:x:2.0:_abc:attr',
      { 'urn:x:2': { '0:_abc:attr': 'v' } },
    ],
    [
      'a schema name starting with a backtick',
      'urn:x:2.0:`abc:attr',
      { 'urn:x:2': { '0:`abc:attr': 'v' } },
    ],
    [
      'a schema name starting with an at sign',
      'urn:x:2.0:@abc:attr',
      { 'urn:x:2': { '0:@abc:attr': 'v' } },
    ],
    ['a major version followed by a letter', 'urn:x:2x0:User:attr', { 'urn:x:2x0:User:attr': 'v' }],
    [
      'a minor version followed by a letter',
      'urn:x:2.0xUser:attr',
      { 'urn:x:2': { '0xUser:attr': 'v' } },
    ],
    ['no major version', 'urn:x:.0:User:attr', { 'urn:x:': { '0:User:attr': 'v' } }],
    ['no minor version', 'urn:x:2.:User:attr', { 'urn:x:2': { ':User:attr': 'v' } }],
    [
      'a schema name followed by a dash',
      'urn:x:2.0:User-attr',
      { 'urn:x:2': { '0:User-attr': 'v' } },
    ],
    [
      'nothing after the colon that ends the schema name',
      'urn:x:2.0:User:',
      { 'urn:x:2': { '0:User:': 'v' } },
    ],
    ['no schema name', 'urn:x:2.0:', { 'urn:x:2': { '0:': 'v' } }],
    ['whitespace in the prefix', 'urn:a b:2.0:User:attr', { 'urn:a b:2': { '0:User:attr': 'v' } }],
    ['a tab in the prefix', 'urn:a\tb:2.0:User:attr', { 'urn:a\tb:2': { '0:User:attr': 'v' } }],
    ['an opening bracket in the prefix', 'urn:a[b:2.0:User:attr', { 'urn:a[b:2.0:User:attr': 'v' }],
    [
      'a closing bracket in the prefix',
      'urn:a]b:2.0:User:attr',
      { 'urn:a]b:2': { '0:User:attr': 'v' } },
    ],
    [
      'a schema name starting with a left brace',
      'urn:x:2.0:{abc:attr',
      { 'urn:x:2': { '0:{abc:attr': 'v' } },
    ],
    [
      'a version that is not preceded by a colon',
      'urn:ab2.0:User:attr',
      { 'urn:ab2': { '0:User:attr': 'v' } },
    ],
    ['no urn: prefix', 'xrn:x:2.0:User:attr', { 'xrn:x:2': { '0:User:attr': 'v' } }],
  ])('does not take %s as an extension', (_label, path, expected) => {
    expect(add(path)).toEqual(expected);
  });
});

describe('path splitting', () => {
  const add = (path: string, resource: Doc = {}): Doc =>
    patch(resource, [{ op: 'add', path, value: 'v' }]);

  it('skips empty segments', () => {
    expect(add('a..b')).toEqual({ a: { b: 'v' } });
    expect(add('.a')).toEqual({ a: 'v' });
    expect(add('a.')).toEqual({ a: 'v' });
  });

  it('keeps dots inside a filter bracket', () => {
    expect(
      add('emails[value eq "a.b"].type', { emails: [{ value: 'a.b' }, { value: 'c' }] })
    ).toEqual({ emails: [{ value: 'a.b', type: 'v' }, { value: 'c' }] });
  });

  it('keeps nested brackets together until the outer one closes', () => {
    expect(add('a[b[c].d]')).toEqual({ 'a[b[c].d]': 'v' });
  });

  it('splits at dots after the bracket closed', () => {
    expect(add('emails[type eq "work"].value')).toEqual({
      emails: [{ type: 'work', value: 'v' }],
    });
  });

  it('treats a stray closing bracket as depth zero', () => {
    expect(add('a].b')).toEqual({ 'a]': { b: 'v' } });
  });

  it('accepts several spaces around eq and single quotes', () => {
    expect(add("emails[type   eq   'work'].value")).toEqual({
      emails: [{ type: 'work', value: 'v' }],
    });
  });

  it('does not read a filter without whitespace around eq', () => {
    expect(add('emails[typeeq"work"].value')).toEqual({ 'emails[typeeq"work"]': { value: 'v' } });
  });

  it('only reads a filter that spans the whole segment', () => {
    expect(add('a[b]c[type eq "w"]')).toEqual({ 'a[b]c[type eq "w"]': 'v' });
    expect(add('emails[type eq "w"]x')).toEqual({ 'emails[type eq "w"]x': 'v' });
  });

  it('does not read a filter whose attribute has a space', () => {
    expect(add('emails[ty pe eq "w"]')).toEqual({ 'emails[ty pe eq "w"]': 'v' });
  });
});

describe('prototype pollution guards', () => {
  it.each([
    '__proto__.polluted',
    '__PROTO__.polluted',
    'constructor.prototype.polluted',
    'prototype.polluted',
    'safe.__proto__.polluted',
    'safe.constructor.polluted',
    'safe.Prototype',
    'emails[__proto__ eq "x"].value',
    'emails[constructor eq "x"]',
  ])('skips an operation on %s', (path) => {
    const resource = { safe: {}, emails: [{ type: 'a' }] };
    expect(patch(resource, [{ op: 'add', path, value: 'v' }])).toStrictEqual(resource);
    expect(patch(resource, [{ op: 'remove', path }])).toStrictEqual(resource);
    expect(({} as Doc).polluted).toBeUndefined();
  });

  it('still applies the operations around a skipped one', () => {
    const result = patch({}, [
      { op: 'add', path: 'a', value: '1' },
      { op: 'add', path: '__proto__.x', value: '2' },
      { op: 'add', path: 'b', value: '3' },
    ]);
    expect(result).toEqual({ a: '1', b: '3' });
  });
});

describe('key resolution', () => {
  it('prefers the exact key over a key that differs in case', () => {
    expect(patch({ A: 'upper', a: 'lower' }, [{ op: 'replace', path: 'a', value: 'new' }])).toEqual(
      { A: 'upper', a: 'new' }
    );
  });

  it('falls back to a key that differs in case', () => {
    expect(patch({ userName: 'old' }, [{ op: 'replace', path: 'USERNAME', value: 'new' }])).toEqual(
      { userName: 'new' }
    );
  });

  it('resolves a filter attribute without regard to case', () => {
    const resource = {
      emails: [
        { Type: 'work', value: 'a' },
        { Type: 'home', value: 'b' },
      ],
    };
    expect(patch(resource, [{ op: 'remove', path: 'emails[type eq "work"]' }])).toEqual({
      emails: [{ Type: 'home', value: 'b' }],
    });
  });
});

describe('values created by add and replace stay ordinary properties', () => {
  const later = (path: string, value?: unknown): Doc =>
    patch({}, [
      { op: 'add', path, value },
      { op: 'replace', value: { x: 1 } },
    ]);

  it('lets a created leaf be overwritten, removed and listed', () => {
    expect(
      patch({}, [
        { op: 'add', path: 'title', value: 'x' },
        { op: 'replace', value: { title: 'y' } },
      ])
    ).toEqual({ title: 'y' });
    expect(
      patch({}, [
        { op: 'add', path: 'title', value: 'x' },
        { op: 'remove', path: 'title' },
      ])
    ).toStrictEqual({});
    expect(Object.keys(patch({}, [{ op: 'add', path: 'title', value: 'x' }]))).toEqual(['title']);
    expect(later('title', 'x')).toEqual({ title: 'x', x: 1 });
  });

  it('lets a created intermediate object be overwritten, removed and listed', () => {
    const created = patch({}, [{ op: 'add', path: 'a.b', value: 'v' }]);
    expect(Object.keys(created)).toEqual(['a']);
    expect(Object.getOwnPropertyDescriptor(created, 'a')).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(patch(created, [{ op: 'replace', value: { a: { c: 1 } } }])).toEqual({ a: { c: 1 } });
    expect(patch(created, [{ op: 'remove', path: 'a' }])).toStrictEqual({});
  });

  it('replaces a scalar in the way with an object', () => {
    for (const blocker of ['str', null, 5]) {
      const created = patch({ a: blocker }, [{ op: 'add', path: 'a.b', value: 'v' }]);
      expect(created).toEqual({ a: { b: 'v' } });
      expect(Object.getOwnPropertyDescriptor(created, 'a')).toMatchObject({
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  });

  it('does not replace a scalar in the way when removing', () => {
    expect(patch({ a: 'str' }, [{ op: 'remove', path: 'a.b' }])).toStrictEqual({ a: 'str' });
    expect(patch({ a: null }, [{ op: 'remove', path: 'a.b' }])).toStrictEqual({ a: null });
  });

  it('creates a collection for a filtered intermediate segment', () => {
    const created = patch({}, [{ op: 'add', path: 'emails[type eq "work"].value', value: 'x' }]);
    expect(created).toEqual({ emails: [{ type: 'work', value: 'x' }] });
    expect(Object.getOwnPropertyDescriptor(created, 'emails')).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(patch(created, [{ op: 'replace', value: { emails: [] } }])).toEqual({ emails: [] });
    expect(patch(created, [{ op: 'remove', path: 'emails' }])).toStrictEqual({});
  });

  it('creates a collection for a filtered last segment', () => {
    const created = patch({}, [
      { op: 'replace', path: 'emails[type eq "work"]', value: { type: 'work', value: 'a' } },
    ]);
    expect(created).toEqual({ emails: [{ type: 'work', value: 'a' }] });
    expect(Object.getOwnPropertyDescriptor(created, 'emails')).toMatchObject({
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(patch(created, [{ op: 'remove', path: 'emails[type eq "work"]' }])).toEqual({
      emails: [],
    });
  });

  it('replaces a non-array in place of a collection', () => {
    expect(
      patch({ emails: 'oops' }, [{ op: 'add', path: 'emails[type eq "work"].value', value: 'x' }])
    ).toEqual({ emails: [{ type: 'work', value: 'x' }] });
    expect(
      patch({ emails: { not: 'array' } }, [
        { op: 'replace', path: 'emails[type eq "work"]', value: { type: 'work' } },
      ])
    ).toEqual({ emails: [{ type: 'work' }] });
  });
});

describe('filtered multi-valued attributes', () => {
  const emails = () => ({
    emails: [
      { type: 'work', value: 'w@example.com' },
      { type: 'home', value: 'h@example.com' },
    ],
  });

  it('replaces the first matching item with an object value', () => {
    expect(
      patch(emails(), [
        {
          op: 'replace',
          path: 'emails[type eq "work"]',
          value: { type: 'work', value: 'new@example.com' },
        },
      ])
    ).toEqual({
      emails: [
        { type: 'work', value: 'new@example.com' },
        { type: 'home', value: 'h@example.com' },
      ],
    });
  });

  it('replaces a later matching item', () => {
    expect(
      patch(emails(), [
        { op: 'replace', path: 'emails[type eq "home"]', value: { type: 'home', value: 'z' } },
      ])
    ).toEqual({
      emails: [
        { type: 'work', value: 'w@example.com' },
        { type: 'home', value: 'z' },
      ],
    });
  });

  it('appends when nothing matches', () => {
    expect(
      patch(emails(), [
        { op: 'add', path: 'emails[type eq "other"]', value: { type: 'other', value: 'o' } },
      ])
    ).toEqual({
      emails: [...emails().emails, { type: 'other', value: 'o' }],
    });
  });

  it.each([
    ['a string', 'x', { type: 'work', value: 'x' }],
    ['a number', 5, { type: 'work', value: 5 }],
    ['false', false, { type: 'work', value: false }],
    ['null', null, { type: 'work', value: null }],
  ])('wraps %s into an item carrying the filter', (_label, value, item) => {
    expect(patch(emails(), [{ op: 'replace', path: 'emails[type eq "work"]', value }])).toEqual({
      emails: [item, { type: 'home', value: 'h@example.com' }],
    });
  });

  it('compares the filter value to the item as text', () => {
    expect(
      patch(
        {
          emails: [
            { primary: true, value: 'a' },
            { primary: false, value: 'b' },
          ],
        },
        [{ op: 'replace', path: 'emails[primary eq "true"]', value: { primary: true, value: 'c' } }]
      )
    ).toEqual({
      emails: [
        { primary: true, value: 'c' },
        { primary: false, value: 'b' },
      ],
    });
  });

  it('sets a sub-attribute of the matching item', () => {
    expect(
      patch(emails(), [{ op: 'replace', path: 'emails[type eq "home"].value', value: 'n@x.org' }])
    ).toEqual({
      emails: [
        { type: 'work', value: 'w@example.com' },
        { type: 'home', value: 'n@x.org' },
      ],
    });
  });

  it('creates the item for a sub-attribute when none matches', () => {
    expect(
      patch(emails(), [{ op: 'add', path: 'emails[type eq "other"].value', value: 'o@x.org' }])
    ).toEqual({
      emails: [...emails().emails, { type: 'other', value: 'o@x.org' }],
    });
  });

  it('skips null and scalar items when looking for a match', () => {
    const resource = { emails: [null, 'text', 7, { type: 'work', value: 'a' }] };
    expect(
      patch(resource, [{ op: 'replace', path: 'emails[type eq "work"].value', value: 'b' }])
    ).toEqual({ emails: [null, 'text', 7, { type: 'work', value: 'b' }] });
  });

  it('removes only the matching items and keeps scalars and null', () => {
    const resource = {
      emails: [
        null,
        'text',
        { type: 'work', value: 'a' },
        { type: 'home', value: 'b' },
        { type: 'work' },
      ],
    };
    expect(patch(resource, [{ op: 'remove', path: 'emails[type eq "work"]' }])).toEqual({
      emails: [null, 'text', { type: 'home', value: 'b' }],
    });
  });

  it('does not read the properties of string items as attributes', () => {
    expect(
      patch({ emails: ['text'] }, [
        { op: 'add', path: 'emails[type eq "undefined"].value', value: 'x' },
      ])
    ).toEqual({ emails: ['text', { type: 'undefined', value: 'x' }] });
    expect(
      patch({ emails: ['text', { type: 'a' }] }, [
        { op: 'remove', path: 'emails[type eq "undefined"]' },
      ])
    ).toEqual({ emails: ['text', { type: 'a' }] });
  });

  it('removes a sub-attribute of the matching item', () => {
    expect(patch(emails(), [{ op: 'remove', path: 'emails[type eq "work"].value' }])).toEqual({
      emails: [{ type: 'work' }, { type: 'home', value: 'h@example.com' }],
    });
  });

  it('leaves the resource alone when a removal finds no match', () => {
    expect(patch(emails(), [{ op: 'remove', path: 'emails[type eq "none"].value' }])).toEqual(
      emails()
    );
    expect(patch({}, [{ op: 'remove', path: 'emails[type eq "none"].value' }])).toStrictEqual({});
    expect(
      patch({ emails: 'x' }, [{ op: 'remove', path: 'emails[type eq "work"]' }])
    ).toStrictEqual({ emails: 'x' });
  });

  it('does not create parents for a removal', () => {
    expect(patch({}, [{ op: 'remove', path: 'a.b.c' }])).toStrictEqual({});
  });
});

describe('operations without a path', () => {
  it.each(['add', 'replace', 'ADD', 'Replace'])('merges the value for %s', (op) => {
    expect(patch({ a: 1 }, [{ op, value: { b: 2 } }])).toEqual({ a: 1, b: 2 });
  });

  it('ignores remove without a path', () => {
    expect(patch({ a: 1 }, [{ op: 'remove', value: { a: 2 } }])).toEqual({ a: 1 });
  });

  it('ignores an operation whose name is not a string', () => {
    expect(patch({ a: 1 }, [{ op: 5, value: { b: 2 } }])).toEqual({ a: 1 });
    expect(patch({ a: 1 }, [{ op: 5, path: 'a', value: 2 }])).toEqual({ a: 1 });
  });

  it('does not change the input resource', () => {
    const resource = { a: 1, nested: { b: 2 } };
    patch(resource, [{ op: 'add', path: 'c', value: 3 }]);
    expect(resource).toEqual({ a: 1, nested: { b: 2 } });
  });
});
