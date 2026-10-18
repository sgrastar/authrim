import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  validateAccountDirectoryPublication,
  type AccountDirectoryPublication,
} from '@authrim/ar-lib-core';

const DEFAULT_RESERVATION_LEASE_SECONDS = 2 * 60 * 60;

/*
 * Known limitations
 *
 * A reservation carries no persisted per-link generation: it records the account, the operation
 * that holds it and when it was acquired, nothing that names the link it belongs to. Two things
 * remain because of that (docs/operations/lookup-directory-known-limits.md describes the symptoms,
 * the diagnosis and the repair, and the design that closes them).
 *  (a) A replay of an old add can re-acquire a released reservation once two removal cycles have
 *      passed: only the operation that released the row is refused, not the operations that held
 *      it before. The identifier addition path no longer replays a finished add (it answers from
 *      the add's succeeded outbox row before it reserves anything, see
 *      publishAccountIdentifierAddition); the producers that reserve directly (account creation,
 *      guest upgrade and the guest lifecycle) are not covered by that.
 *  (b) A removal that is prepared, completed and followed by a re-add of the same identifier all
 *      within one second, while a second, slow executor of that same removal is still running,
 *      cannot be told apart from the original add by the created_at fence (it compares whole
 *      seconds with <=): the stale run can disable the new route and release the new reservation.
 * Closed since: an HMAC reindex used to stamp the new generation's reservation with the time of
 * the reindex, so a removal prepared earlier took it for a later add and left it; and when the
 * reindex then found the link gone it left the row in 'releasing', which nothing advances. The
 * reindex now carries the source reservation's created_at over and releases what it created
 * (unless an unfinished email replacement owns the identifier, which then releases it itself).
 * Rows an older build already left in 'releasing' are not taken over by reserve(): they are repaired
 * by an operator.
 * Mitigations in place: the pending-unlink guard of the account provisioning entrypoint (an
 * identifier is not published again while an unlink of it is running) and the created_at fence of
 * AccountDirectoryRemovalCoordinator (a removal only touches what existed when it was prepared)
 * narrow these. Closing the gaps needs a persisted per-link generation, which is a schema change.
 */

interface ReservationRow {
  tenant_id: string;
  account_id: string;
  operation_id: string;
  reservation_state: string;
}

export interface InitialAccountIdentifierReservationDependencies {
  lookupForBucket(virtualBucket: number): Promise<D1Database>;
  now: () => number;
  leaseSeconds?: number;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') throw new Error('d1_sessions_api_required');
  return db.withSession('first-primary');
}

export class InitialAccountIdentifierReservationService {
  constructor(private readonly dependencies: InitialAccountIdentifierReservationDependencies) {}

  async reserve(value: AccountDirectoryPublication): Promise<{ reservedCount: number }> {
    const publication = await validateAccountDirectoryPublication(value);
    const now = this.dependencies.now();
    const leaseSeconds = this.dependencies.leaseSeconds ?? DEFAULT_RESERVATION_LEASE_SECONDS;
    if (
      !Number.isSafeInteger(now) ||
      now < 1 ||
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 60 ||
      leaseSeconds > 24 * 60 * 60
    ) {
      throw new Error('directory_identifier_reservation_time_invalid');
    }
    const leaseExpiresAt = now + leaseSeconds;
    const reservable = publication.indexes.filter((index) => index.indexKind !== 'account_id');

    for (const index of reservable) {
      const lookup = primary(await this.dependencies.lookupForBucket(index.virtualBucket));
      // A reservation is the only claim on an identifier, and it is one row per identifier whoever
      // held it before. A row that was released (the identifier was removed) or whose lease ran out
      // is free again and is taken over in this single statement, except by the operation that
      // released it: a released row of the same operation is an add that was finished and removed,
      // and replaying it must not bring the identifier back. A live reservation, a committed
      // one, and one being released or repaired are never taken over: the row stays as it is and
      // the check below refuses the caller. That includes a 'releasing' row an HMAC reindex
      // created: the email replacement also puts rows of any operation into 'releasing' (it keeps
      // the operation id) until its own completion releases them, and the two cannot be told
      // apart from this table, so a stuck one is repaired by an operator
      // (docs/operations/lookup-directory-known-limits.md).
      await lookup
        .prepare(
          `INSERT INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest, account_id,
             reservation_state, operation_id, lease_expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)
           ON CONFLICT (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest
           ) DO UPDATE SET
             account_id = excluded.account_id,
             reservation_state = 'reserved',
             operation_id = excluded.operation_id,
             lease_expires_at = excluded.lease_expires_at,
             committed_at = NULL,
             released_at = NULL,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at
           WHERE (lookup_identifier_reservations.reservation_state = 'released'
                  AND lookup_identifier_reservations.operation_id <> excluded.operation_id)
              OR (lookup_identifier_reservations.reservation_state = 'reserved'
                  AND lookup_identifier_reservations.lease_expires_at <= excluded.created_at)`
        )
        .bind(
          index.virtualBucket,
          publication.tenantId,
          index.indexKind,
          index.normalizationVersion,
          index.hmacKeyGeneration,
          index.digest,
          publication.accountId,
          publication.operationId,
          leaseExpiresAt,
          now,
          now
        )
        .run();
      await lookup
        .prepare(
          `UPDATE lookup_identifier_reservations
              SET lease_expires_at = CASE
                    WHEN lease_expires_at IS NULL OR lease_expires_at < ? THEN ?
                    ELSE lease_expires_at
                  END,
                  updated_at = ?
            WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ? AND account_id = ? AND operation_id = ?
              AND reservation_state = 'reserved'`
        )
        .bind(
          leaseExpiresAt,
          leaseExpiresAt,
          now,
          index.virtualBucket,
          publication.tenantId,
          index.indexKind,
          index.normalizationVersion,
          index.hmacKeyGeneration,
          index.digest,
          publication.accountId,
          publication.operationId
        )
        .run();
      const reflected = await lookup
        .prepare(
          `SELECT tenant_id, account_id, operation_id, reservation_state
             FROM lookup_identifier_reservations
            WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ?`
        )
        .bind(
          index.virtualBucket,
          publication.tenantId,
          index.indexKind,
          index.normalizationVersion,
          index.hmacKeyGeneration,
          index.digest
        )
        .first<ReservationRow>();
      if (
        !reflected ||
        reflected.tenant_id !== publication.tenantId ||
        reflected.account_id !== publication.accountId ||
        reflected.operation_id !== publication.operationId ||
        !['reserved', 'committed'].includes(reflected.reservation_state)
      ) {
        throw new Error('directory_identifier_reservation_conflict');
      }
    }

    return { reservedCount: reservable.length };
  }

  async release(value: AccountDirectoryPublication): Promise<{ releasedCount: number }> {
    const publication = await validateAccountDirectoryPublication(value);
    const now = this.dependencies.now();
    if (!Number.isSafeInteger(now) || now < 1) {
      throw new Error('directory_identifier_reservation_time_invalid');
    }
    let releasedCount = 0;
    for (const index of publication.indexes.filter((entry) => entry.indexKind !== 'account_id')) {
      const lookup = primary(await this.dependencies.lookupForBucket(index.virtualBucket));
      const result = await lookup
        .prepare(
          `UPDATE lookup_identifier_reservations
              SET reservation_state = 'released', lease_expires_at = NULL,
                  released_at = COALESCE(released_at, ?), updated_at = ?
            WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ? AND account_id = ? AND operation_id = ?
              AND reservation_state = 'reserved'`
        )
        .bind(
          now,
          now,
          index.virtualBucket,
          publication.tenantId,
          index.indexKind,
          index.normalizationVersion,
          index.hmacKeyGeneration,
          index.digest,
          publication.accountId,
          publication.operationId
        )
        .run();
      releasedCount += Number(result.meta?.changes ?? 0);
    }
    return { releasedCount };
  }
}
