import type { DemoDatabase, RegistryRow, RegistryState } from './types';

export const POLL_INTERVAL_SECONDS = 2;
const DAY_SECONDS = 24 * 60 * 60;

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

/** Takes the right to ask the Admin API about a row, at most once per interval. */
export async function acquirePoll(
  db: DemoDatabase,
  id: string,
  nowSeconds: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE demo_tenants SET last_polled_at = ?1
        WHERE id = ?2 AND state = 'provisioning'
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
 */
export async function markCreateAccepted(
  db: DemoDatabase,
  id: string,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE demo_tenants SET create_accepted_at = ?1 WHERE id = ?2 AND state = 'provisioning'`
    )
    .bind(now, id)
    .run();
  return result.meta.changes === 1;
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
