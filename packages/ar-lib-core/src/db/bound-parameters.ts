/**
 * Bound-parameter limits
 *
 * D1 refuses a statement that binds more than 100 parameters ("too many SQL variables"), so an
 * `IN (...)` list built from a caller-sized array has to be split. These helpers size the chunks
 * from the parameters the rest of the statement binds.
 */

/** The most parameters D1 binds to one statement. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/**
 * Split values into chunks whose statement stays within D1's bound-parameter limit.
 *
 * @param values - The values bound per chunk (for example the ids of an `IN` list)
 * @param fixedParameters - The parameters the statement binds besides the values
 * @param parametersPerValue - How many parameters each value binds (an `IN` list bound twice
 *   in one statement binds 2)
 */
export function chunkForBoundParameters<T>(
  values: readonly T[],
  fixedParameters = 0,
  parametersPerValue = 1
): T[][] {
  const size = Math.floor((D1_MAX_BOUND_PARAMETERS - fixedParameters) / parametersPerValue);
  if (size < 1) {
    throw new RangeError(
      `A statement binding ${fixedParameters} fixed parameters has no room for values`
    );
  }
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

/** `?, ?, ?` for an `IN` list of the given length. */
export function sqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
