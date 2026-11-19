import { logError } from './log';
import type { DemoDatabase, DemoRunResult, RegistryRow, RegistryState } from './types';

export const POLL_INTERVAL_SECONDS = 2;
const DAY_SECONDS = 24 * 60 * 60;
const TENANTS_CREATED = 'tenants_created';

export interface NewStart {
  id: string;
  ticketHash: string;
  ipHash: string;
  nowSeconds: number;
  expiresAt: number;
  maxActive: number;
  maxPerIp: number;
}

/**
 * Inserts the row only while there is room, in ONE statement: the capacity count (every row that is
 * not `deleted`, failed ones included) and the per-IP count (rows of the last 24 hours) are part of
 * the INSERT, so two starts cannot both take the last place. Returns whether a row was inserted.
 */
export async function tryInsertStart(db: DemoDatabase, start: NewStart): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO demo_tenants (id, ticket_hash, ip_hash, state, created_at, expires_at, updated_at)
       SELECT ?1, ?2, ?3, 'provisioning', ?4, ?5, ?4
        WHERE (SELECT COUNT(*) FROM demo_tenants WHERE state <> 'deleted') < ?6
          AND (SELECT COUNT(*) FROM demo_tenants WHERE ip_hash = ?3 AND created_at > ?7) < ?8`
    )
    .bind(
      start.id,
      start.ticketHash,
      start.ipHash,
      start.nowSeconds,
      start.expiresAt,
      start.maxActive,
      start.nowSeconds - DAY_SECONDS,
      start.maxPerIp
    )
    .run();
  return result.meta.changes === 1;
}

/** Only to pick the message of a refused start; the decision itself was the INSERT's. */
export async function ipLimitReached(
  db: DemoDatabase,
  ipHash: string,
  nowSeconds: number,
  maxPerIp: number
): Promise<boolean> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM demo_tenants WHERE ip_hash = ?1 AND created_at > ?2')
    .bind(ipHash, nowSeconds - DAY_SECONDS)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= maxPerIp;
}

export async function findByTicketHash(
  db: DemoDatabase,
  ticketHash: string
): Promise<RegistryRow | null> {
  return db
    .prepare('SELECT * FROM demo_tenants WHERE ticket_hash = ?1')
    .bind(ticketHash)
    .first<RegistryRow>();
}

/** Moves a row from one state to another; true only for the caller that made the change. */
export async function transition(
  db: DemoDatabase,
  id: string,
  from: RegistryState[],
  to: RegistryState,
  nowSeconds: number
): Promise<boolean> {
  const placeholders = from.map((_, index) => `?${index + 4}`).join(', ');
  const result = await db
    .prepare(
      `UPDATE demo_tenants SET state = ?1, updated_at = ?2 WHERE id = ?3 AND state IN (${placeholders})`
    )
    .bind(to, nowSeconds, id, ...from)
    .run();
  return result.meta.changes === 1;
}

/**
 * The creation call is made by the /status request that wins the claim below. The lease is longer
 * than the create call's own 90 s timeout, so a claimant that is still alive has given up (or been
 * cancelled) by the time another request may take over.
 */
export const CREATE_LEASE_SECONDS = 120;
export const MAX_CREATE_ATTEMPTS = 2;

/**
 * A row that is `provisioning` with no `create_started_at` is "queued": no creation was attempted,
 * so no tenant exists for it.
 *
 * The claim is ONE guarded UPDATE, so exactly one request wins it (true). It wins when the row is
 * queued, or when the previous claimant left no acceptance record for longer than the lease and
 * fewer than MAX_CREATE_ATTEMPTS were made. Repeating the call is safe: the Admin API creates a
 * tenant at most once per `Idempotency-Key` (the tenant id), so a second call after a claimant
 * that died mid-call returns the first call's outcome instead of making a second tenant.
 */
export async function claimCreate(
  db: DemoDatabase,
  id: string,
  nowSeconds: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE demo_tenants
          SET create_started_at = ?1, create_attempts = create_attempts + 1, updated_at = ?1
        WHERE id = ?2 AND state = 'provisioning' AND create_accepted_at IS NULL
          AND (create_started_at IS NULL
               OR (create_started_at <= ?3 AND create_attempts < ?4))`
    )
    .bind(nowSeconds, id, nowSeconds - CREATE_LEASE_SECONDS, MAX_CREATE_ATTEMPTS)
    .run();
  return result.meta.changes === 1;
}

/**
 * Fails a row whose creation was attempted the maximum number of times and never recorded as
 * accepted, once the last lease ran out. Guarded in SQL, so a row that was accepted or is still
 * inside its lease is left alone. True only for the caller that made the change.
 */
export async function failExhaustedCreate(
  db: DemoDatabase,
  id: string,
  nowSeconds: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE demo_tenants SET state = 'failed', updated_at = ?1
        WHERE id = ?2 AND state = 'provisioning' AND create_accepted_at IS NULL
          AND create_started_at IS NOT NULL AND create_started_at <= ?3
          AND create_attempts >= ?4`
    )
    .bind(nowSeconds, id, nowSeconds - CREATE_LEASE_SECONDS, MAX_CREATE_ATTEMPTS)
    .run();
  return result.meta.changes === 1;
}

/** Takes the right to ask the Admin API about a row, at most once per interval. */
export async function acquirePoll(
  db: DemoDatabase,
  id: string,
  nowSeconds: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE demo_tenants SET last_polled_at = ?1
        WHERE id = ?2 AND state = 'provisioning' AND create_accepted_at IS NOT NULL
          AND (last_polled_at IS NULL OR last_polled_at <= ?3)`
    )
    .bind(nowSeconds, id, nowSeconds - POLL_INTERVAL_SECONDS)
    .run();
  return result.meta.changes === 1;
}

export const CLEANUP_BATCH = 10;
const FAILED_GRACE_SECONDS = 300;
const ABANDONED_AFTER_SECONDS = 1800 + 120;
// A little under the 600 s cron interval, so a row probed in one run is due in the next despite jitter.
const PROBE_INTERVAL_SECONDS = 540;
const PURGE_AFTER_SECONDS = 7 * DAY_SECONDS;
export const STUCK_AFTER_SECONDS = 3 * 3600;

/** Rows to start deleting, oldest first: expired, failed a while ago, or abandoned before hand-off. */
export async function selectCandidates(db: DemoDatabase, now: number): Promise<RegistryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM demo_tenants
        WHERE state NOT IN ('deleting', 'deleted')
          AND (expires_at <= ?1
               OR (state = 'failed' AND updated_at <= ?1 - ${FAILED_GRACE_SECONDS})
               OR (state IN ('provisioning', 'inviting') AND created_at <= ?1 - ${ABANDONED_AFTER_SECONDS}))
        ORDER BY created_at ASC LIMIT ${CLEANUP_BATCH}`
    )
    .bind(now)
    .all<RegistryRow>();
  return results;
}

/** Guarded claim from the exact state that was read; true for the one caller that made the change. */
export async function claimForDeletion(
  db: DemoDatabase,
  id: string,
  from: RegistryState,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE demo_tenants SET state = 'deleting', updated_at = ?1, delete_attempted_at = ?1
        WHERE id = ?2 AND state = ?3`
    )
    .bind(now, id, from)
    .run();
  return result.meta.changes === 1;
}

/**
 * Rows in `deleting` that were not asked about for 9 minutes, least recently asked first (never
 * asked first): a row that was just probed goes to the back, so the rows behind a few that never
 * finish are still reached.
 */
export async function selectProbeRows(db: DemoDatabase, now: number): Promise<RegistryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM demo_tenants
        WHERE state = 'deleting'
          AND (delete_attempted_at IS NULL OR delete_attempted_at <= ?1 - ${PROBE_INTERVAL_SECONDS})
        ORDER BY delete_attempted_at ASC, id ASC LIMIT ${CLEANUP_BATCH}`
    )
    .bind(now)
    .all<RegistryRow>();
  return results;
}

/** The claim of a probe: only the run that moves `delete_attempted_at` asks the Admin API. */
export async function claimProbe(db: DemoDatabase, id: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE demo_tenants SET delete_attempted_at = ?1
        WHERE id = ?2 AND state = 'deleting'
          AND (delete_attempted_at IS NULL OR delete_attempted_at <= ?1 - ${PROBE_INTERVAL_SECONDS})`
    )
    .bind(now, id)
    .run();
  return result.meta.changes === 1;
}

/** A deletion was queued upstream. `updated_at` is left alone: it dates the entry into `deleting`. */
export async function recordDeleteRequested(
  db: DemoDatabase,
  id: string,
  now: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE demo_tenants SET delete_attempts = delete_attempts + 1, delete_attempted_at = ?1
        WHERE id = ?2 AND state = 'deleting'`
    )
    .bind(now, id)
    .run();
}

export async function markDeleted(db: DemoDatabase, id: string, now: number): Promise<boolean> {
  return transition(db, id, ['deleting'], 'deleted', now);
}

/**
 * The Admin API accepted the creation: from now on the row is known to own its tenant. Guarded, so
 * a row that left `provisioning` in the meantime is not touched; true only when a row was changed.
 *
 * The total of created tenants is counted in the same transaction, BEFORE the row is marked: the
 * counter moves only for a row that is not marked yet, so a creation is counted exactly once and
 * never without its mark.
 */
export async function markCreateAccepted(
  db: DemoDatabase,
  id: string,
  now: number
): Promise<boolean> {
  const mark = `UPDATE demo_tenants SET create_accepted_at = ?1 WHERE id = ?2 AND state = 'provisioning'`;
  const counted = () =>
    db.batch([
      db
        .prepare(
          `UPDATE demo_counters SET value = value + 1
            WHERE name = '${TENANTS_CREATED}'
              AND EXISTS (SELECT 1 FROM demo_tenants
                           WHERE id = ?1 AND state = 'provisioning' AND create_accepted_at IS NULL)`
        )
        .bind(id),
      db.prepare(mark).bind(now, id),
    ]);
  let results: DemoRunResult[];
  try {
    results = await counted();
  } catch (error) {
    // The code may run before migration 0004 (or beside a Worker of the release before): the
    // acceptance must be recorded all the same. The migration counts such a row when it is applied,
    // because it starts the total from the accepted rows.
    if (!(error instanceof Error) || !/no such table: demo_counters/i.test(error.message)) {
      throw error;
    }
    logError('counter_table_missing');
    // Only while the table is still absent, checked in the statement itself: a mark written after
    // the migration ran would be in neither the migration's count nor ours.
    const plain = await db
      .prepare(
        `${mark} AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'demo_counters')`
      )
      .bind(now, id)
      .run();
    if (plain.meta.changes === 1) return true;
    // Nothing was written: the table appeared in between (count it now), or the row left
    // `provisioning` (the batch changes nothing and says so).
    results = await counted();
  }
  return results[1]?.meta.changes === 1;
}

/**
 * The start page's numbers, in one statement: the rows that take a place under the capacity limit
 * (the very count of `tryInsertStart`) and the total of accepted creations.
 */
export async function readTally(db: DemoDatabase): Promise<{ active: number; created: number }> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM demo_tenants WHERE state <> 'deleted') AS active,
              (SELECT value FROM demo_counters WHERE name = '${TENANTS_CREATED}') AS created`
    )
    .first<{ active: number; created: number | null }>();
  if (!row || row.created === null) throw new Error('tally_unavailable');
  return { active: row.active, created: row.created };
}

export async function countStuck(db: DemoDatabase, now: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM demo_tenants WHERE state = 'deleting' AND updated_at <= ?1 - ${STUCK_AFTER_SECONDS}`
    )
    .bind(now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Rows kept only because the per-IP count looks back 24 hours. */
export async function purgeDeleted(db: DemoDatabase, now: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM demo_tenants WHERE state = 'deleted' AND updated_at < ?1`)
    .bind(now - PURGE_AFTER_SECONDS)
    .run();
  return result.meta.changes;
}
