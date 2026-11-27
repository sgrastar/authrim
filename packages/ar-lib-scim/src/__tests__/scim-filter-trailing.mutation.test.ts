/**
 * SCIM Filter Parser - complete-consumption tests
 *
 * RFC 7644 3.4.2.2: a filter that is not a single well-formed expression is invalid. Tokens
 * left over after the expression, or an unterminated string, must be rejected rather than
 * silently dropped (which would change what the filter selects).
 */

import { describe, it, expect } from 'vitest';
import { filterToSql, parseScimFilter, validateScimFilter } from '../utils/scim-filter';

describe('parseScimFilter rejects incomplete consumption', () => {
  it.each([
    ['trailing identifier', 'userName eq "a" garbage', 'Unexpected token: ATTRIBUTE'],
    [
      'second comparison without logical operator',
      'userName eq "a" active eq true',
      'Unexpected token: ATTRIBUTE',
    ],
    ['stray closing parenthesis', 'userName eq "a")', 'Unexpected token: )'],
    ['stray closing bracket', 'userName eq "a"]', 'Unexpected token: ]'],
    ['trailing not operator', 'userName eq "a" not active eq true', 'Unexpected token: LOGICAL'],
    ['trailing literal', 'userName eq "a" "b"', 'Unexpected token: STRING'],
    [
      'trailing operator after value path',
      'emails[type eq "work"].value eq "x"',
      'Unexpected token: OPERATOR',
    ],
  ])('%s', (_label, filter, message) => {
    expect(() => parseScimFilter(filter)).toThrow(`Invalid SCIM filter: ${message}`);
    expect(validateScimFilter(filter)).toEqual({
      valid: false,
      error: `Invalid SCIM filter: ${message}`,
    });
  });

  it('rejects an unterminated string literal', () => {
    expect(() => parseScimFilter('userName eq "abc')).toThrow(
      'Invalid SCIM filter: Unterminated string literal'
    );
    expect(() => parseScimFilter('userName eq "abc\\"')).toThrow('Unterminated string literal');
  });

  it('still accepts a string literal that ends exactly at end of input', () => {
    expect(parseScimFilter('userName eq "abc"')).toEqual({
      type: 'comparison',
      operator: 'eq',
      attribute: 'userName',
      value: 'abc',
    });
  });

  it('decodes JSON string escapes in comparison values (RFC 7644 3.4.2.2 / RFC 8259)', () => {
    const value = (filter: string) => (parseScimFilter(filter) as { value: unknown }).value;
    expect(value('userName eq "a\\\\b\\n"')).toBe('a\\b\n');
    expect(value('userName eq "say \\"hi\\""')).toBe('say "hi"');
    expect(value('userName eq "folder\\\\"')).toBe('folder\\');
    expect(value('userName eq "\\u0041\\/"')).toBe('A/');
  });

  it('handles escape edge cases', () => {
    const value = (filter: string) => (parseScimFilter(filter) as { value: unknown }).value;
    expect(value('userName eq "\\b\\f\\r\\t"')).toBe('\b\f\r\t');
    expect(value('userName eq "\\u12"')).toBe('\\u12');
    expect(value('userName eq "\\u12G4"')).toBe('\\u12G4');
    expect(value('userName eq "\\uD83D\\uDE00"')).toBe('\u{1F600}');
    expect(() => parseScimFilter('userName eq "abc\\')).toThrow('Unterminated string literal');
    expect(() => parseScimFilter('userName eq "a\\u0000b"')).toThrow('NUL');
  });

  it('keeps the backslash of an unknown escape', () => {
    expect(parseScimFilter('userName eq "domain\\user"')).toMatchObject({ value: 'domain\\user' });
  });

  it('escapes LIKE wildcards in co/sw/ew so they compare literally', () => {
    const cases: Array<[string, string, string]> = [
      ['co', '100%_x', '%100\\%\\_x%'],
      ['sw', 'a\\b', 'a\\\\b%'],
      ['ew', '50%', '%50\\%'],
    ];
    for (const [op, raw, expected] of cases) {
      const lit = raw.replace(/\\/g, '\\\\');
      const { sql, params } = filterToSql(parseScimFilter(`displayName ${op} "${lit}"`));
      expect(sql).toContain("ESCAPE '\\'");
      expect(params[0]).toBe(expected);
    }
  });

  it('does not treat a not operator as an or between comparisons', () => {
    expect(() => parseScimFilter('a eq 1 not b eq 2')).toThrow('Unexpected token: LOGICAL');
  });
});
