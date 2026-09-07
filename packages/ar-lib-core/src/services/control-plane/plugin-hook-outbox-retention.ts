import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';

export const PLUGIN_HOOK_SUCCEEDED_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const PLUGIN_HOOK_DEAD_LETTER_RETENTION_SECONDS = 90 * 24 * 60 * 60;

interface ExpiredPluginHookOutboxRow {
  outbox_id: string;
  status: 'succeeded' | 'dead_letter';
  delete_after: number | string;
}

export interface PluginHookOutboxRetentionResult {
  scanned: number;
  deleted: number;
  succeededDeleted: number;
  deadLetterDeleted: number;
}

function safeEpochSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('plugin_outbox_retention_now_invalid');
  }
  return value;
}

function safeLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error('plugin_outbox_retention_limit_invalid');
  }
  return value;
}

function validateCandidate(
  row: ExpiredPluginHookOutboxRow,
  now: number
): ExpiredPluginHookOutboxRow {
  const deleteAfter = Number(row.delete_after);
  if (
    typeof row.outbox_id !== 'string' ||
    row.outbox_id.length === 0 ||
    row.outbox_id.length > 255 ||
    (row.status !== 'succeeded' && row.status !== 'dead_letter') ||
    !Number.isSafeInteger(deleteAfter) ||
    deleteAfter < 0 ||
    deleteAfter > now
  ) {
    throw new Error('plugin_outbox_retention_candidate_invalid');
  }
  return row;
}

export async function cleanupExpiredPluginHookOutbox(
  adapter: DatabaseAdapter,
  options: { now: number; limit?: number }
): Promise<PluginHookOutboxRetentionResult> {
  const now = safeEpochSeconds(options.now);
  const limit = safeLimit(options.limit ?? 100);
  const candidates = (
    await adapter.query<ExpiredPluginHookOutboxRow>(
      `SELECT outbox_id, status, delete_after
         FROM plugin_hook_outbox
        WHERE status IN ('succeeded', 'dead_letter')
          AND delete_after IS NOT NULL AND delete_after <= ?
        ORDER BY delete_after, outbox_id
        LIMIT ?`,
      [now, limit]
    )
  ).map((row) => validateCandidate(row, now));

  if (candidates.length === 0) {
    return { scanned: 0, deleted: 0, succeededDeleted: 0, deadLetterDeleted: 0 };
  }

  const statements: PreparedStatement[] = candidates.map((candidate) => ({
    sql: `DELETE FROM plugin_hook_outbox
           WHERE outbox_id = ? AND status = ?
             AND delete_after IS NOT NULL AND delete_after <= ?`,
    params: [candidate.outbox_id, candidate.status, now],
  }));
  const results = await adapter.batch(statements);
  if (results.length !== candidates.length) {
    throw new Error('plugin_outbox_retention_batch_incomplete');
  }

  let deleted = 0;
  let succeededDeleted = 0;
  let deadLetterDeleted = 0;
  results.forEach((result, index) => {
    const rowsAffected = result.rowsAffected ?? 0;
    if (
      !result.success ||
      !Number.isSafeInteger(rowsAffected) ||
      rowsAffected < 0 ||
      rowsAffected > 1
    ) {
      throw new Error('plugin_outbox_retention_delete_result_invalid');
    }
    if (rowsAffected === 0) return;
    deleted += 1;
    if (candidates[index]?.status === 'succeeded') succeededDeleted += 1;
    if (candidates[index]?.status === 'dead_letter') deadLetterDeleted += 1;
  });

  return { scanned: candidates.length, deleted, succeededDeleted, deadLetterDeleted };
}
