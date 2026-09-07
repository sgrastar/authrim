import { describe, it, expect } from 'vitest';
import { ClaimValueCaster } from '../value-caster';

describe('ClaimValueCaster', () => {
  const caster = new ClaimValueCaster();

  describe('string type', () => {
    it('returns string as-is', () => {
      expect(caster.cast('hello', 'string')).toEqual({ value: 'hello', valid: true });
    });
  });

  describe('number type', () => {
    it('casts valid number', () => {
      expect(caster.cast('42', 'number')).toEqual({ value: 42, valid: true });
    });

    it('casts decimal number', () => {
      expect(caster.cast('3.14', 'number')).toEqual({ value: 3.14, valid: true });
    });

    it('rejects NaN', () => {
      expect(caster.cast('abc', 'number')).toEqual({ value: undefined, valid: false });
    });

    it('rejects Infinity', () => {
      expect(caster.cast('Infinity', 'number')).toEqual({ value: undefined, valid: false });
    });

    it('rejects -Infinity', () => {
      expect(caster.cast('-Infinity', 'number')).toEqual({ value: undefined, valid: false });
    });
  });

  describe('boolean type', () => {
    it('casts "true" to true', () => {
      expect(caster.cast('true', 'boolean')).toEqual({ value: true, valid: true });
    });

    it('casts "1" to true', () => {
      expect(caster.cast('1', 'boolean')).toEqual({ value: true, valid: true });
    });

    it('casts "false" to false', () => {
      expect(caster.cast('false', 'boolean')).toEqual({ value: false, valid: true });
    });

    it('casts other strings to false', () => {
      expect(caster.cast('0', 'boolean')).toEqual({ value: false, valid: true });
    });
  });

  describe('date type', () => {
    it('returns date string as-is', () => {
      expect(caster.cast('2025-01-01', 'date')).toEqual({ value: '2025-01-01', valid: true });
    });
  });

  describe('enum type', () => {
    it('returns enum value as-is', () => {
      expect(caster.cast('active', 'enum')).toEqual({ value: 'active', valid: true });
    });
  });

  describe('null/undefined values', () => {
    it('rejects null', () => {
      expect(caster.cast(null, 'string')).toEqual({ value: undefined, valid: false });
    });

    it('rejects undefined', () => {
      expect(caster.cast(undefined, 'string')).toEqual({ value: undefined, valid: false });
    });
  });

  describe('multi-valued fields', () => {
    it('casts each JSON array item using the scalar field type', () => {
      expect(caster.cast('["1","2"]', 'number', 'multi')).toEqual({
        value: [1, 2],
        valid: true,
      });
    });

    it('rejects malformed or complex arrays', () => {
      expect(caster.cast('not-json', 'string', 'multi').valid).toBe(false);
      expect(caster.cast('[{"value":"admin"}]', 'string', 'multi').valid).toBe(false);
    });
  });
});
