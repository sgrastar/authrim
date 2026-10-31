/**
 * A condition a write must still hold at the moment it runs.
 *
 * D1 has no interactive transaction, so "read the counts, then write" lets two requests both see
 * that one administrator remains and both go on. A guard is put in the write's own `WHERE`
 * instead, so the database decides it in the same statement as the change: the write affects no
 * row when the condition no longer holds.
 */
export interface AdminWriteGuard {
  /** A boolean SQL expression over sub-selects; `?` placeholders are filled from `params`. */
  sql: string;
  params: unknown[];
}

/**
 * The database's clock in epoch milliseconds, for a condition that is decided when the write runs
 * (the clock of the request may be older by then). `unixepoch()` alone would drop the
 * milliseconds, which lets an assignment that ended within the second still count.
 */
export const ADMIN_GUARD_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";

/** The guards that all have to hold, as one; `undefined` when there is none. */
export function allOfGuards(
  ...guards: Array<AdminWriteGuard | null | undefined>
): AdminWriteGuard | undefined {
  const present = guards.filter((guard): guard is AdminWriteGuard => !!guard);
  if (present.length === 0) {
    return undefined;
  }
  return {
    sql: present.map((guard) => `(${guard.sql})`).join(' AND '),
    params: present.flatMap((guard) => guard.params),
  };
}

/** The `WHERE` tail and parameters for `guard`: nothing at all when there is none. */
export function guardClause(guard?: AdminWriteGuard): { sql: string; params: unknown[] } {
  return guard ? { sql: ` AND (${guard.sql})`, params: guard.params } : { sql: '', params: [] };
}
