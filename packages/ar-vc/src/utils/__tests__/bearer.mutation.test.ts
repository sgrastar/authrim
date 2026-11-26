import { describe, expect, it } from 'vitest';
import { extractBearerToken } from '../bearer';

describe('extractBearerToken', () => {
  it.each(['Bearer', 'bearer', 'BEARER', 'BeArEr'])('accepts the scheme spelled %s', (scheme) => {
    expect(extractBearerToken(`${scheme} abc.def`)).toBe('abc.def');
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['Bearer'],
    ['Bearer '],
    ['Bearer    '],
    ['Basic abc'],
    ['DPoP abc'],
    ['Token abc'],
    ['Bearerabc'],
    ['Bearer\tabc'],
    [' Bearer abc'],
  ])('refuses %j', (header) => {
    expect(extractBearerToken(header)).toBeNull();
  });
});

describe('extractBearerToken separators', () => {
  it.each([
    ['Bearer  abc', 'abc'],
    ['Bearer     abc.def', 'abc.def'],
    ['bearer   abc', 'abc'],
  ])('accepts one or more spaces: %j', (header, token) => {
    expect(extractBearerToken(header)).toBe(token);
  });
});
