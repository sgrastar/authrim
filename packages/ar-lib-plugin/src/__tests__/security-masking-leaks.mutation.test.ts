import { describe, expect, it } from 'vitest';
import { maskSensitiveFieldsRecursive } from '../core/security';

const SECRET = 'super-secret-value-123456';
const MASKED = 'supe****3456';

describe('maskSensitiveFieldsRecursive: no unmasked leakage', () => {
  it('replaces content beyond maxDepth with a placeholder instead of returning it raw', () => {
    const config = { a: { b: { password: SECRET } } };
    const masked = maskSensitiveFieldsRecursive(config, { maxDepth: 1 });
    expect(masked).toEqual({ a: { b: '[MAX_DEPTH_EXCEEDED]' } });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it('masks at exactly maxDepth and replaces one level deeper', () => {
    const config = { a: { password: SECRET, b: { password: SECRET } } };
    expect(maskSensitiveFieldsRecursive(config, { maxDepth: 1 })).toEqual({
      a: { password: MASKED, b: '[MAX_DEPTH_EXCEEDED]' },
    });
  });

  it('replaces too-deep arrays and arrays-in-arrays with the placeholder', () => {
    expect(maskSensitiveFieldsRecursive({ list: [{ x: 1 }] }, { maxDepth: 0 })).toEqual({
      list: '[MAX_DEPTH_EXCEEDED]',
    });
    // list is depth 1; the inner array is depth 2 > maxDepth 1.
    expect(
      maskSensitiveFieldsRecursive({ list: [[{ password: SECRET }]] }, { maxDepth: 1 })
    ).toEqual({
      list: ['[MAX_DEPTH_EXCEEDED]'],
    });
  });

  it('masks secrets inside arrays of arrays', () => {
    const masked = maskSensitiveFieldsRecursive({
      rows: [[{ password: SECRET }], [[{ token: SECRET }]]],
    });
    expect(masked).toEqual({ rows: [[{ password: MASKED }], [[{ token: MASKED }]]] });
  });

  it.each([
    ['a number', 1234567890123456, '1234****3456'],
    ['a bigint', 12345678901234567890n, '1234****7890'],
  ])('masks a secret-named field whose value is %s', (_label, value, expected) => {
    expect(maskSensitiveFieldsRecursive({ apiKey: value })).toEqual({ apiKey: expected });
  });

  it('masks every string under a secret-named object or array, keeping the structure', () => {
    const masked = maskSensitiveFieldsRecursive({
      credentials: { user: SECRET, nested: { other: SECRET }, flag: true, none: null },
      tokens: [SECRET, [SECRET], { any: SECRET }],
    });
    expect(masked).toEqual({
      credentials: { user: MASKED, nested: { other: MASKED }, flag: true, none: null },
      tokens: [MASKED, [MASKED], { any: MASKED }],
    });
  });

  it('keeps booleans, null and undefined of secret-named fields as flags', () => {
    expect(
      maskSensitiveFieldsRecursive({ password: null, token: undefined, secretEnabled: true })
    ).toEqual({ password: null, token: undefined, secretEnabled: true });
  });

  it('leaves non-secret values alone', () => {
    expect(maskSensitiveFieldsRecursive({ name: 'x', n: 3, list: [1, 'a', null] })).toEqual({
      name: 'x',
      n: 3,
      list: [1, 'a', null],
    });
  });
});
