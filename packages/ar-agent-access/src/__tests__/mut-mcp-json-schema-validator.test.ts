import { describe, expect, it } from 'vitest';
import { McpSdkJsonSchemaValidator } from '../protocol/mcp/json-schema-validator';

const validator = new McpSdkJsonSchemaValidator();

describe('McpSdkJsonSchemaValidator', () => {
  it('evaluates Draft 2020-12 keywords such as prefixItems', () => {
    const schema = { type: 'array', prefixItems: [{ type: 'string' }], items: false };
    expect(validator.validate(schema, ['a'])).toEqual({ valid: true });
    expect(validator.validate(schema, [1]).valid).toBe(false);
    expect(validator.validate(schema, ['a', 'b']).valid).toBe(false);
  });

  it('reports every violation instead of stopping at the first one', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
    };
    const result = validator.validate(schema, { a: 1, b: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('#/a:');
    expect(result.errorMessage).toContain('#/b:');
  });

  it('never mutates a frozen catalog schema', () => {
    const schema = Object.freeze({
      type: 'object',
      properties: Object.freeze({ a: Object.freeze({ $ref: '#/$defs/s' }) }),
      $defs: Object.freeze({ s: Object.freeze({ type: 'string' }) }),
    });
    expect(validator.validate(schema, { a: 'ok' })).toEqual({ valid: true });
    expect(validator.validate(schema, { a: 2 }).valid).toBe(false);
  });
});
