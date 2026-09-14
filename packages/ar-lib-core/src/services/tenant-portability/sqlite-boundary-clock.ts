/** One bound caller timestamp, optionally advanced by SQLite's statement execution clock.
 * The database mode prevents queued statements from admitting an expired boundary.
 * Keep this SQL implementation-owned; never accept expressions from requests or bundles.
 */
export function sqliteBoundaryClockParameter(databaseClock: boolean): string {
  return databaseClock
    ? "MAX(?, CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER))"
    : '?';
}
