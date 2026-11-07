/**
 * The choices a Flow screen step sends to the Flow are kept with the interaction
 * (`flow_interactions.context_json.screen_answers`) for the steps still to come. They are taken
 * out when the interaction ends, wherever it ends, so none outlives it (the interaction row stays,
 * and outlives the person's account):
 * - a submit that completes it writes its context without them (ar-auth);
 * - one found expired when it is used is expired with them removed (`contextWithoutScreenAnswers`);
 * - the scheduled maintenance expires the rest, removing them in the same write
 *   (`expireFlowInteractions`);
 * - a context read before the interaction ended is not written back after (ar-auth writes it back
 *   only while the interaction is open).
 * Removing them at the moment the state changes needs no later sweep of past interactions.
 */
import type { DatabaseAdapter } from '../db/adapter';

/** The context as JSON without its screen answers, or null when it has none to remove. */
export function contextWithoutScreenAnswers(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let context: unknown;
  try {
    context = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  if (!Object.prototype.hasOwnProperty.call(context, 'screen_answers')) return null;
  const { screen_answers: _answers, ...rest } = context as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** The SQLite (D1) value of `context_json` without its screen answers (none, or not JSON: as is). */
export const CONTEXT_WITHOUT_SCREEN_ANSWERS_SQLITE = `CASE
    WHEN json_valid(context_json) AND json_type(context_json, '$.screen_answers') IS NOT NULL
    THEN json_remove(context_json, '$.screen_answers') ELSE context_json END`;

/** At most this many interactions are expired per call on PostgreSQL (the rest on the next). */
export const POSTGRES_EXPIRY_BATCH = 500;

/**
 * Expires the tenant's interactions past their expiry that are still open, removing their screen
 * answers in the same write. Answers how many it expired.
 *
 * On SQLite (D1) one statement does both. On PostgreSQL the context is read and written back here,
 * not cast in SQL: one context that is not JSON would fail the whole statement (and the JSON the
 * database offers is not relied on). Each row is written only if it is still open and its context
 * is still the one read.
 */
export async function expireFlowInteractions(
  adapter: DatabaseAdapter,
  tenantId: string,
  now: number
): Promise<number> {
  if (adapter.getType() !== 'postgres') {
    const result = await adapter.execute(
      `UPDATE flow_interactions
          SET state = 'expired', updated_at = ?, context_json = ${CONTEXT_WITHOUT_SCREEN_ANSWERS_SQLITE}
        WHERE tenant_id = ?
          AND state IN ('created', 'active')
          AND expires_at <= ?`,
      [now, tenantId, now]
    );
    return result.rowsAffected ?? 0;
  }
  const rows = await adapter.query<{ id: string; context_json: string | null }>(
    `SELECT id, context_json
       FROM flow_interactions
      WHERE tenant_id = ? AND state IN ('created', 'active') AND expires_at <= ?
      ORDER BY expires_at, id
      LIMIT ?`,
    [tenantId, now, POSTGRES_EXPIRY_BATCH]
  );
  if (rows.length === 0) return 0;
  const results = await adapter.batch(
    rows.map((row) => ({
      // Only over the context read: one changed since waits for the next run (still open).
      sql: `UPDATE flow_interactions
               SET state = 'expired', updated_at = ?, context_json = COALESCE(?, context_json)
             WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active') AND expires_at <= ?
               AND context_json IS NOT DISTINCT FROM ?`,
      params: [
        now,
        contextWithoutScreenAnswers(row.context_json),
        tenantId,
        row.id,
        now,
        row.context_json,
      ],
    }))
  );
  return results.reduce((expired, result) => expired + (result.rowsAffected ?? 0), 0);
}
