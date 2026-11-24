/**
 * Presence check for test fixtures: returns the value or fails the test with a
 * descriptive message (replaces non-null assertions in tests).
 */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to be present`);
  }
  return value;
}
