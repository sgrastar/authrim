import { describe, expect, it } from 'vitest';
import { formatFatalError } from '../core/fatal-error.js';

describe('formatFatalError', () => {
  it('preserves Error stack text without passing the object to console inspection', () => {
    const error = new Error('update failed');

    expect(formatFatalError(error)).toContain('Error: update failed');
  });

  it('does not throw for hostile values', () => {
    const hostile = Object.create(null) as { toJSON: () => string };
    hostile.toJSON = () => {
      throw new Error('inspect failed');
    };

    expect(formatFatalError(hostile)).toBe('Unknown fatal error');
  });
});
