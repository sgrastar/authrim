import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  validateAccountDirectoryPublication,
  type AccountDirectoryPublication,
} from '@authrim/ar-lib-core';

const DEFAULT_RESERVATION_LEASE_SECONDS = 2 * 60 * 60;

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
      await lookup
        .prepare(
          `INSERT OR IGNORE INTO lookup_identifier_reservations (
             virtual_bucket, tenant_id, index_kind, normalization_version,
             hmac_key_generation, identifier_blind_digest, account_id,
             reservation_state, operation_id, lease_expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`
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
