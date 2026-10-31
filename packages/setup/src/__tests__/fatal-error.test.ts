import { describe, expect, it } from 'vitest';
import { formatFatalError } from '../core/fatal-error.js';

describe('formatFatalError', () => {
  it('preserves Error stack text without passing the object to console inspection', () => {
    const error = new Error('update failed');

    expect(formatFatalError(error)).toContain('Error: update failed');
  });

  it('explains a Control target set mismatch without overstating what was left untouched', () => {
    const text = formatFatalError(new Error('release_rollout_blocked:release_target_set_mismatch'));

    expect(text).toContain('release_rollout_blocked:release_target_set_mismatch');
    // What did not run: only the Control-managed targets' migration SQL.
    expect(text).toMatch(/before running any migration SQL on the Control-managed/u);
    // What may have run: setup-owned databases.
    expect(text).toMatch(
      /Databases that setup owns itself.*may already have had this release applied/u
    );
    expect(text).not.toMatch(/Nothing was applied|without changing any database/u);
    // How to recover, and why the re-run can still stop.
    expect(text).toContain('run update again');
    expect(text).toMatch(/still stops with control_target_set_mismatch \/ unknown_to_lock/u);
    expect(formatFatalError(new Error('release_rollout_blocked:other'))).not.toContain(
      'run update again'
    );
  });

  it('does not throw for hostile values', () => {
    const hostile = Object.create(null) as { toJSON: () => string };
    hostile.toJSON = () => {
      throw new Error('inspect failed');
    };

    expect(formatFatalError(hostile)).toBe('Unknown fatal error');
  });
});
