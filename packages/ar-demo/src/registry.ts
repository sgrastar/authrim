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
