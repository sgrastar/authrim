import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  accountDirectoryRemovalOutboxId,
  validateAccountDirectoryRemovalPublication,
  type AccountDirectoryPublishResult,
  type AccountDirectoryRemovalPublication,
  type LookupBlindIndex,
} from '@authrim/ar-lib-core';
import type { AccountDirectoryOutboxClaim } from './account-directory-coordinator';

interface AccountStateRow {
  lifecycle_state: string;
  directory_publication_state: string;
  account_route_generation: number | string;
}

interface RemovalOutboxRow {
  payload_json: string;
  status: string;
  attempt_count: number | string;
  lease_owner: string | null;
  event_kind: string;
}

interface ReservationRow {
  account_id: string;
  reservation_state: string;
}

export interface AccountDirectoryRemovalCoordinatorDependencies {
  tenantCore: D1Database;
  lookupForBucket(virtualBucket: number): Promise<D1Database>;
  now: () => number;
}

function primary(database: D1Database): D1DatabaseSession {
  if (typeof database.withSession !== 'function') throw new Error('d1_sessions_api_required');
  return database.withSession('first-primary');
}

async function first<T>(
  session: D1DatabaseSession,
  sql: string,
  params: unknown[]
): Promise<T | null> {
  return session
    .prepare(sql)
    .bind(...params)
    .first<T>();
}

function indexParams(index: LookupBlindIndex): unknown[] {
  return [
    index.virtualBucket,
    index.indexKind,
    index.normalizationVersion,
    index.hmacKeyGeneration,
    index.digest,
  ];
}

function expectedEventKind(scope: AccountDirectoryRemovalPublication['scope']): string {
  return scope === 'account' ? 'account_deleted' : 'identifier_removed';
}

function publicationIdentity(value: AccountDirectoryRemovalPublication): string {
  return JSON.stringify({
    ...value,
    indexes: [...value.indexes].sort(
      (left, right) =>
        left.indexKind.localeCompare(right.indexKind) ||
        left.hmacKeyGeneration - right.hmacKeyGeneration ||
        left.digest.localeCompare(right.digest)
    ),
  });
}

export class AccountDirectoryRemovalCoordinator {
  constructor(private readonly dependencies: AccountDirectoryRemovalCoordinatorDependencies) {}

  async remove(
    input: AccountDirectoryRemovalPublication,
    claim?: AccountDirectoryOutboxClaim
  ): Promise<AccountDirectoryPublishResult> {
    const publication = await validateAccountDirectoryRemovalPublication(input);
    const tenant = primary(this.dependencies.tenantCore);
    const account = await first<AccountStateRow>(
      tenant,
      `SELECT lifecycle_state, directory_publication_state, account_route_generation
         FROM identity_accounts WHERE tenant_id = ? AND id = ?`,
      [publication.tenantId, publication.accountId]
    );
    if (!account) throw new Error('directory_removal_account_not_found');
    if (
      Number(account.account_route_generation) !==
        publication.routeProjection.accountRouteGeneration ||
      (publication.scope === 'account'
        ? account.directory_publication_state !== 'disabled' ||
          !['deleting', 'deleted'].includes(account.lifecycle_state)
        : account.directory_publication_state !== 'active' || account.lifecycle_state !== 'active')
    ) {
      throw new Error('directory_removal_account_state_conflict');
    }

    const outboxId = accountDirectoryRemovalOutboxId(publication.operationId);
    const outbox = await first<RemovalOutboxRow>(
      tenant,
      `SELECT payload_json, status, attempt_count, lease_owner, event_kind
         FROM account_routing_outbox
        WHERE outbox_id = ? AND tenant_id = ? AND account_id = ?`,
      [outboxId, publication.tenantId, publication.accountId]
    );
    if (
      !outbox ||
      outbox.event_kind !== expectedEventKind(publication.scope) ||
      !['pending', 'leased', 'retry', 'succeeded'].includes(outbox.status)
    ) {
      throw new Error('directory_removal_outbox_not_runnable');
    }
    if (
      claim &&
      (outbox.status !== 'leased' ||
        outbox.lease_owner !== claim.ownerId ||
        Number(outbox.attempt_count) !== claim.fencingToken)
    ) {
      throw new Error('directory_removal_outbox_stale_lease');
    }
    let persisted: AccountDirectoryRemovalPublication;
    try {
      persisted = await validateAccountDirectoryRemovalPublication(
        JSON.parse(outbox.payload_json) as AccountDirectoryRemovalPublication
      );
    } catch {
      throw new Error('directory_removal_outbox_payload_invalid');
    }
    if (publicationIdentity(persisted) !== publicationIdentity(publication)) {
      throw new Error('directory_removal_outbox_payload_mismatch');
    }

    const now = this.dependencies.now();
    const lookupByBucket = new Map<number, Promise<D1Database>>();
    const lookupForBucket = (virtualBucket: number): Promise<D1Database> => {
      let lookup = lookupByBucket.get(virtualBucket);
      if (!lookup) {
        lookup = this.dependencies.lookupForBucket(virtualBucket);
        lookupByBucket.set(virtualBucket, lookup);
      }
      return lookup;
    };

    for (const index of publication.indexes) {
      const lookup = primary(await lookupForBucket(index.virtualBucket));
      if (index.indexKind !== 'account_id') {
        const reservation = await first<ReservationRow>(
          lookup,
          `SELECT account_id, reservation_state
             FROM lookup_identifier_reservations
            WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ?`,
          [
            index.virtualBucket,
            publication.tenantId,
            index.indexKind,
            index.normalizationVersion,
            index.hmacKeyGeneration,
            index.digest,
          ]
        );
        if (reservation && reservation.account_id !== publication.accountId) {
          throw new Error('directory_removal_reservation_owner_conflict');
        }
      }

      await lookup
        .prepare(
          `UPDATE lookup_identifiers
              SET lifecycle_state = 'disabled', runtime_route_status = 'disabled',
                  disabled_at = COALESCE(disabled_at, ?), updated_at = ?
            WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
              AND hmac_key_generation = ? AND identifier_blind_digest = ?
              AND tenant_id = ? AND account_id = ? AND lifecycle_state <> 'disabled'`
        )
        .bind(now, now, ...indexParams(index), publication.tenantId, publication.accountId)
        .run();
      const active = await first<{ count: number | string }>(
        lookup,
        `SELECT COUNT(*) AS count FROM lookup_identifiers
          WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
            AND hmac_key_generation = ? AND identifier_blind_digest = ?
            AND tenant_id = ? AND account_id = ? AND lifecycle_state <> 'disabled'`,
        [...indexParams(index), publication.tenantId, publication.accountId]
      );
      if (Number(active?.count ?? 0) !== 0) {
        throw new Error('directory_removal_lookup_reflection_failed');
      }

      if (index.indexKind !== 'account_id') {
        await lookup
          .prepare(
            `UPDATE lookup_identifier_reservations
                SET reservation_state = 'released', lease_expires_at = NULL,
                    released_at = COALESCE(released_at, ?), updated_at = ?
              WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
                AND normalization_version = ? AND hmac_key_generation = ?
                AND identifier_blind_digest = ? AND account_id = ?
                AND reservation_state IN ('reserved', 'committed', 'releasing', 'repair_required')`
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
            publication.accountId
          )
          .run();
        const reservation = await first<ReservationRow>(
          lookup,
          `SELECT account_id, reservation_state
             FROM lookup_identifier_reservations
            WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ?`,
          [
            index.virtualBucket,
            publication.tenantId,
            index.indexKind,
            index.normalizationVersion,
            index.hmacKeyGeneration,
            index.digest,
          ]
        );
        if (
          reservation &&
          (reservation.account_id !== publication.accountId ||
            reservation.reservation_state !== 'released')
        ) {
          throw new Error('directory_removal_reservation_release_failed');
        }
      }
    }

    if (outbox.status !== 'succeeded') {
      const completed = await tenant
        .prepare(
          `UPDATE account_routing_outbox
              SET status = 'succeeded', succeeded_at = COALESCE(succeeded_at, ?),
                  lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
                  last_error_code = NULL, updated_at = ?
            WHERE outbox_id = ? AND status IN ('pending', 'leased', 'retry')
              AND (? IS NULL OR (lease_owner = ? AND attempt_count = ?))`
        )
        .bind(
          now,
          now,
          outboxId,
          claim?.ownerId ?? null,
          claim?.ownerId ?? null,
          claim?.fencingToken ?? 0
        )
        .run();
      if ((completed.meta.changes ?? 0) !== 1) {
        throw new Error('directory_removal_outbox_completion_failed');
      }
    }
    return { status: 201, accountId: publication.accountId, operationId: publication.operationId };
  }
}
