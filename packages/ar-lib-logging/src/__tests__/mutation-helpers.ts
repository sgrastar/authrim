/** Narrows a value that a test has just arranged to exist, without a non-null assertion. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}
