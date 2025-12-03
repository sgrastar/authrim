/**
 * SCIM Filter Parser Tests
 */

import { describe, it, expect } from 'vitest';
import { parseScimFilter, validateScimFilter, filterToSql } from '../utils/scim-filter';

describe('SCIM Filter Parser', () => {
  describe('parseScimFilter', () => {
    it('should parse simple eq comparison', () => {
      const ast = parseScimFilter('userName eq "john@example.com"');
      expect(ast).toMatchObject({
        type: 'comparison',
        operator: 'eq',
        attribute: 'userName',
        value: 'john@example.com',
      });
    });

    it('should parse ne comparison', () => {
      const ast = parseScimFilter('active ne false');
      expect(ast).toMatchObject({
        type: 'comparison',
        operator: 'ne',
        attribute: 'active',
        value: false,
      });
    });

    it('should parse co (contains) comparison', () => {
      const ast = parseScimFilter('userName co "john"');
      expect(ast).toMatchObject({
        type: 'comparison',
        operator: 'co',
        attribute: 'userName',
        value: 'john',
      });
    });

    it('should parse sw (starts with) comparison', () => {
      const ast = parseScimFilter('userName sw "john"');
      expect(ast).toMatchObject({
        type: 'comparison',
        operator: 'sw',
        attribute: 'userName',
        value: 'john',
      });
    });

    it('should parse pr (present) operator', () => {
      const ast = parseScimFilter('phoneNumber pr');
      expect(ast).toMatchObject({
        type: 'comparison',
        operator: 'pr',
        attribute: 'phoneNumber',
      });
    });

    it('should parse gt comparison', () => {
      const ast = parseScimFilter('meta.created gt "2023-01-01"');
      expect(ast).toMatchObject({
        type: 'comparison',
        operator: 'gt',
        attribute: 'meta.created',
        value: '2023-01-01',
      });
    });

    it('should parse logical AND', () => {
      const ast = parseScimFilter('userName eq "john" and active eq true');
      expect(ast).toMatchObject({
        type: 'logical',
        operator: 'and',
        left: {
          type: 'comparison',
          operator: 'eq',
          attribute: 'userName',
          value: 'john',
        },
        right: {
          type: 'comparison',
          operator: 'eq',
          attribute: 'active',
          value: true,
        },
      });
    });

    it('should parse logical OR', () => {
      const ast = parseScimFilter('userName eq "john" or userName eq "jane"');
      expect(ast).toMatchObject({
        type: 'logical',
        operator: 'or',
      });
    });

    it('should parse logical NOT', () => {
      const ast = parseScimFilter('not (active eq false)');
      expect(ast).toMatchObject({
        type: 'logical',
        operator: 'not',
        expression: {
          type: 'grouping',
        },
      });
    });

    it('should parse complex expression with parentheses', () => {
      const ast = parseScimFilter('(userName eq "john" or userName eq "jane") and active eq true');
      expect(ast).toMatchObject({
        type: 'logical',
        operator: 'and',
      });
    });

    it('should parse null values', () => {
      const ast = parseScimFilter('manager eq null');
      expect(ast).toMatchObject({
        type: 'comparison',
        operator: 'eq',
        attribute: 'manager',
        value: null,
      });
    });

    it('should parse numeric values', () => {
      const ast = parseScimFilter('age gt 25');
      expect(ast).toMatchObject({
        type: 'comparison',
        operator: 'gt',
        attribute: 'age',
        value: 25,
      });
    });

    it('should handle case-insensitive operators', () => {
      const ast = parseScimFilter('userName EQ "john"');
      expect(ast).toMatchObject({
        type: 'comparison',
        operator: 'eq',
      });
    });

    it('should throw error on invalid syntax', () => {
      expect(() => parseScimFilter('userName')).toThrow();
      expect(() => parseScimFilter('userName eq')).toThrow();
      expect(() => parseScimFilter('eq "john"')).toThrow();
    });
  });

  describe('validateScimFilter', () => {
    it('should validate correct filter', () => {
      const result = validateScimFilter('userName eq "john@example.com"');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should invalidate incorrect filter', () => {
      const result = validateScimFilter('userName eq');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should validate complex filter', () => {
      const result = validateScimFilter(
        '(userName eq "john" or userName eq "jane") and active eq true'
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('filterToSql', () => {
    it('should convert eq to SQL', () => {
      const ast = parseScimFilter('userName eq "john"');
      const { sql, params } = filterToSql(ast);
      expect(sql).toContain('=');
      expect(params).toContain('john');
    });

    it('should convert ne to SQL', () => {
      const ast = parseScimFilter('active ne false');
      const { sql, params } = filterToSql(ast);
      expect(sql).toContain('!=');
      expect(params).toContain(false);
    });

    it('should convert co (contains) to SQL LIKE', () => {
      const ast = parseScimFilter('userName co "john"');
      const { sql, params } = filterToSql(ast);
      expect(sql).toContain('LIKE');
      expect(params[0]).toContain('%john%');
    });

    it('should convert sw (starts with) to SQL LIKE', () => {
      const ast = parseScimFilter('userName sw "john"');
      const { sql, params } = filterToSql(ast);
      expect(sql).toContain('LIKE');
      expect(params[0]).toMatch(/^john%$/);
    });

    it('should convert ew (ends with) to SQL LIKE', () => {
      const ast = parseScimFilter('userName ew "example.com"');
      const { sql, params } = filterToSql(ast);
      expect(sql).toContain('LIKE');
      expect(params[0]).toMatch(/^%example\.com$/);
    });

    it('should convert pr (present) to SQL IS NOT NULL', () => {
      const ast = parseScimFilter('phoneNumber pr');
      const { sql } = filterToSql(ast);
      expect(sql).toContain('IS NOT NULL');
    });

    it('should convert logical AND', () => {
      const ast = parseScimFilter('userName eq "john" and active eq true');
      const { sql, params } = filterToSql(ast);
      expect(sql).toContain('AND');
      expect(params).toHaveLength(2);
    });

    it('should convert logical OR', () => {
      const ast = parseScimFilter('userName eq "john" or userName eq "jane"');
      const { sql, params } = filterToSql(ast);
      expect(sql).toContain('OR');
      expect(params).toHaveLength(2);
    });

    it('should convert logical NOT', () => {
      const ast = parseScimFilter('not (active eq false)');
      const { sql } = filterToSql(ast);
      expect(sql).toContain('NOT');
    });

    it('should use attribute map for column names', () => {
      const ast = parseScimFilter('userName eq "john"');
      const attributeMap = { userName: 'preferred_username' };
      const { sql } = filterToSql(ast, attributeMap);
      expect(sql).toContain('preferred_username');
    });

    it('should handle comparison operators', () => {
      const tests = [
        { filter: 'age gt 25', operator: '>' },
        { filter: 'age ge 25', operator: '>=' },
        { filter: 'age lt 65', operator: '<' },
        { filter: 'age le 65', operator: '<=' },
      ];

      tests.forEach(({ filter, operator }) => {
        const ast = parseScimFilter(filter);
        const { sql } = filterToSql(ast);
        expect(sql).toContain(operator);
      });
    });

    it('should throw error on unsupported valuePath filters', () => {
      const ast = parseScimFilter('emails[type eq "work"].value eq "john@work.com"');
      expect(() => filterToSql(ast)).toThrow('Value path filters require custom implementation');
    });
  });
});
