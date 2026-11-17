type AuditRepairClient = {
  query<T extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
};

const LEGACY_SESSION_PREDICATE = `payload->>'resource' = 'session'
  AND jsonb_typeof(payload->'resourceId') = 'string'
  AND payload->>'resourceId' <> ''
  AND payload->>'resourceId' !~ '^sid_[0-9a-f]{64}$'`;

export async function countLegacyAuditSessionIds(db: AuditRepairClient): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM authrim_aws_audit_events WHERE ${LEGACY_SESSION_PREDICATE}`
  );
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('aws_audit_repair_count_invalid');
  return count;
}

/** Replace only legacy session resource IDs. PostgreSQL hashes bytes, including the zero separator. */
export async function repairLegacyAuditSessionIds(
  db: AuditRepairClient,
  batchSize = 500
): Promise<{ updated: number; remaining: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error('aws_audit_repair_batch_size_invalid');
  }
  let updated = 0;
  while (true) {
    const result = await db.query(
      `WITH candidates AS (
         SELECT ctid FROM authrim_aws_audit_events
          WHERE ${LEGACY_SESSION_PREDICATE}
          LIMIT $1 FOR UPDATE
       )
       UPDATE authrim_aws_audit_events AS event
          SET payload = jsonb_set(
            event.payload,
            '{resourceId}',
            to_jsonb('sid_' || encode(sha256(
              convert_to('authrim:event_log:session', 'UTF8') || decode('00', 'hex') ||
              convert_to(event.payload->>'resourceId', 'UTF8')
            ), 'hex'))
          )
         FROM candidates
        WHERE event.ctid = candidates.ctid`,
      [batchSize]
    );
    const changed = result.rowCount;
    if (changed === null || changed < 0 || changed > batchSize) {
      throw new Error('aws_audit_repair_update_count_invalid');
    }
    updated += changed;
    if (changed === 0) break;
  }
  return { updated, remaining: await countLegacyAuditSessionIds(db) };
}
