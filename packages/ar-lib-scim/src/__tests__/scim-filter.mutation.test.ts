/**
 * SCIM Filter Parser - mutation-hardening tests
 *
 * Exact-value assertions on tokenizer edge cases, error messages and SQL output.
 */

import { describe, it, expect } from 'vitest';
import { parseScimFilter, validateScimFilter, filterToSql } from '../utils/scim-filter';
import type { ScimFilterNode } from '../types/scim';

describe('parseScimFilter tokenizer details', () => {
  it('unescapes an escaped quote inside a string literal', () => {
    expect(parseScimFilter('displayName eq "say \\"hi\\" now"')).toEqual({
      type: 'comparison',
      operator: 'eq',
      attribute: 'displayName',
      value: 'say "hi" now',
    });
  });

  it('parses a sub-attribute after a value path', () => {
    expect(parseScimFilter('emails[type eq "work"].value')).toEqual({
      type: 'valuePath',
      attribute: 'emails',
      expression: { type: 'comparison', operator: 'eq', attribute: 'type', value: 'work' },
      value: 'value',
    });
  });

  it('continues parsing after a value path sub-attribute', () => {
    expect(parseScimFilter('emails[type eq "work"].value and active eq true')).toEqual({
      type: 'logical',
      operator: 'and',
      left: {
        type: 'valuePath',
        attribute: 'emails',
        expression: { type: 'comparison', operator: 'eq', attribute: 'type', value: 'work' },
        value: 'value',
      },
      right: { type: 'comparison', operator: 'eq', attribute: 'active', value: true },
    });
  });

  it('continues parsing after a value path without sub-attribute', () => {
    const ast = parseScimFilter('emails[type eq "work"] or active eq true');
    expect(ast).toEqual({
      type: 'logical',
      operator: 'or',
      left: {
        type: 'valuePath',
        attribute: 'emails',
        expression: { type: 'comparison', operator: 'eq', attribute: 'type', value: 'work' },
        value: undefined,
      },
      right: { type: 'comparison', operator: 'eq', attribute: 'active', value: true },
    });
  });

  it('rejects a dot that is not followed by an attribute', () => {
    expect(() => parseScimFilter('emails[type eq "work"].')).toThrow(
      'Invalid SCIM filter: Expected ATTRIBUTE but got EOF'
    );
  });

  it('treats identifiers ending in digits as attributes, not numbers', () => {
    expect(parseScimFilter('user2 eq "x"')).toEqual({
      type: 'comparison',
      operator: 'eq',
      attribute: 'user2',
      value: 'x',
    });
  });

  it('treats identifiers starting with digits as attributes, not numbers', () => {
    expect(parseScimFilter('2fa eq "x"')).toEqual({
      type: 'comparison',
      operator: 'eq',
      attribute: '2fa',
      value: 'x',
    });
  });

  it('rejects a malformed number value', () => {
    expect(() => parseScimFilter('age eq 1abc')).toThrow(
      'Invalid SCIM filter: Expected value but got ATTRIBUTE'
    );
  });

  it.each([
    ['age eq 42', 42],
    ['age eq -7', -7],
    ['age gt 1.5', 1.5],
    ['age lt 1.55', 1.55],
    ['age le 0.125', 0.125],
  ])('parses numeric value in "%s"', (filter, expected) => {
    const ast = parseScimFilter(filter);
    expect(ast.value).toBe(expected);
  });

  it('rejects a number with a non-digit fraction', () => {
    expect(() => parseScimFilter('age eq 1.x')).toThrow(
      'Invalid SCIM filter: Expected value but got ATTRIBUTE'
    );
  });

  it.each([
    ['active eq true', true],
    ['active eq TRUE', true],
    ['active eq false', false],
    ['active eq False', false],
  ])('parses boolean value in "%s"', (filter, expected) => {
    expect(parseScimFilter(filter).value).toBe(expected);
  });

  it('parses a null value', () => {
    expect(parseScimFilter('manager eq null')).toEqual({
      type: 'comparison',
      operator: 'eq',
      attribute: 'manager',
      value: null,
    });
  });

  it('handles leading and trailing whitespace', () => {
    expect(parseScimFilter('  \t userName pr \n ')).toEqual({
      type: 'comparison',
      operator: 'pr',
      attribute: 'userName',
    });
  });

  it('handles an attribute immediately followed by a bracket', () => {
    expect(parseScimFilter('emails[type pr]')).toEqual({
      type: 'valuePath',
      attribute: 'emails',
      expression: { type: 'comparison', operator: 'pr', attribute: 'type' },
      value: undefined,
    });
  });
});

describe('parseScimFilter error messages', () => {
  it.each([
    ['', 'Invalid SCIM filter: Unexpected token: undefined'],
    ['   ', 'Invalid SCIM filter: Unexpected token: undefined'],
    ['"abc" eq 1', 'Invalid SCIM filter: Unexpected token: STRING'],
    ['or userName pr', 'Invalid SCIM filter: Unexpected token: LOGICAL'],
    ['and userName pr', 'Invalid SCIM filter: Unexpected token: LOGICAL'],
    ['eq', 'Invalid SCIM filter: Unexpected token: OPERATOR'],
    ['userName eq', 'Invalid SCIM filter: Expected value but got undefined'],
    ['userName eq pr', 'Invalid SCIM filter: Expected value but got OPERATOR'],
    ['userName eq (', 'Invalid SCIM filter: Expected value but got ('],
    ['userName', 'Invalid SCIM filter: Expected operator but got undefined'],
    ['userName "x"', 'Invalid SCIM filter: Expected operator but got STRING'],
    ['userName and active pr', 'Invalid SCIM filter: Expected operator but got LOGICAL'],
    ['(userName pr', 'Invalid SCIM filter: Expected ) but got EOF'],
    ['(userName pr active pr', 'Invalid SCIM filter: Expected ) but got ATTRIBUTE'],
    ['emails[type pr', 'Invalid SCIM filter: Expected ] but got EOF'],
    ['emails[type pr active', 'Invalid SCIM filter: Expected ] but got ATTRIBUTE'],
    ['userName eq 1 and', 'Invalid SCIM filter: Unexpected token: undefined'],
    ['userName eq 1 or', 'Invalid SCIM filter: Unexpected token: undefined'],
    ['not', 'Invalid SCIM filter: Unexpected token: undefined'],
  ])('rejects %j', (filter, message) => {
    expect(() => parseScimFilter(filter)).toThrow(message);
  });

  it('reports the same message through validateScimFilter', () => {
    expect(validateScimFilter('userName eq')).toEqual({
      valid: false,
      error: 'Invalid SCIM filter: Expected value but got undefined',
    });
    expect(validateScimFilter('userName pr')).toEqual({ valid: true });
  });
});

describe('parseScimFilter structure', () => {
  it('parses not with a grouped expression', () => {
    expect(parseScimFilter('not (userName pr)')).toEqual({
      type: 'logical',
      operator: 'not',
      expression: {
        type: 'grouping',
        expression: { type: 'comparison', operator: 'pr', attribute: 'userName' },
      },
    });
  });

  it('binds and tighter than or', () => {
    expect(parseScimFilter('a pr or b pr and c pr')).toEqual({
      type: 'logical',
      operator: 'or',
      left: { type: 'comparison', operator: 'pr', attribute: 'a' },
      right: {
        type: 'logical',
        operator: 'and',
        left: { type: 'comparison', operator: 'pr', attribute: 'b' },
        right: { type: 'comparison', operator: 'pr', attribute: 'c' },
      },
    });
  });

  it('parses operators case-insensitively and normalises them', () => {
    expect(parseScimFilter('userName EQ "x" AND active Eq TRUE')).toEqual({
      type: 'logical',
      operator: 'and',
      left: { type: 'comparison', operator: 'eq', attribute: 'userName', value: 'x' },
      right: { type: 'comparison', operator: 'eq', attribute: 'active', value: true },
    });
  });

  it('left-associates chained or expressions', () => {
    const ast = parseScimFilter('a pr or b pr or c pr');
    expect(ast.operator).toBe('or');
    expect(ast.left?.type).toBe('logical');
    expect(ast.right).toEqual({ type: 'comparison', operator: 'pr', attribute: 'c' });
  });
});

describe('filterToSql details', () => {
  it('renders a grouping with parentheses', () => {
    expect(filterToSql(parseScimFilter('(userName eq "a")'))).toEqual({
      sql: '(userName = ?1)',
      params: ['a'],
    });
  });

  it('renders not around a grouped comparison', () => {
    expect(filterToSql(parseScimFilter('not (active eq true)'))).toEqual({
      sql: 'NOT ((active = ?1))',
      params: [true],
    });
  });

  it('numbers placeholders sequentially across a logical expression', () => {
    expect(filterToSql(parseScimFilter('a eq 1 and b pr and c sw "x"'))).toEqual({
      sql: '((a = ?1 AND b IS NOT NULL) AND c LIKE ?2)',
      params: [1, 'x%'],
    });
  });

  it('renders or with the OR keyword', () => {
    expect(filterToSql(parseScimFilter('a eq 1 or b eq 2'))).toEqual({
      sql: '(a = ?1 OR b = ?2)',
      params: [1, 2],
    });
  });

  it('throws for an unsupported operator', () => {
    const node = { type: 'comparison', operator: 'xx', attribute: 'a', value: 1 };
    expect(() => filterToSql(node as unknown as ScimFilterNode)).toThrow(
      'Unsupported operator: xx'
    );
  });

  it('throws for an unsupported node type', () => {
    const node = { type: 'bogus' };
    expect(() => filterToSql(node as unknown as ScimFilterNode)).toThrow(
      'Unsupported node type: bogus'
    );
  });
});
