import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  accountDirectoryOutboxId,
  validateAccountDirectoryPublication,
  type AccountDirectoryPublication,
  type AccountDirectoryPublishResult,
  type LookupBlindIndex,
} from '@authrim/ar-lib-core';

interface AccountRow {
  directory_publication_state: string;
  account_route_generation: number | string;
}

interface LookupRow {
  tenant_id: string;
  account_id: string;
  route_projection_json: string;
  lifecycle_state: string;
}

interface ReservationRow {
  tenant_id: string;
  account_id: string;
  operation_id: string;
  reservation_state: string;
}

interface RoutingOutboxRow {
  outbox_id: string;
  event_kind: 'account_created' | 'identifier_added';
  payload_json: string;
  status: string;
  attempt_count: number | string;
  lease_owner: string | null;
}

export interface AccountDirectoryOutboxClaim {
  ownerId: string;
  fencingToken: number;
}

export interface AccountDirectoryCoordinatorDependencies {
  tenantCore: D1Database;
  lookupForBucket(virtualBucket: number): Promise<D1Database>;
  now: () => number;
  onAccountActivated?(publication: AccountDirectoryPublication, now: number): Promise<void>;
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') throw new Error('d1_sessions_api_required');
  return db.withSession('first-primary');
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

function exactProjection(value: AccountDirectoryPublication): string {
  return JSON.stringify(value.routeProjection);
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

function publicationIdentity(value: AccountDirectoryPublication): string {
  return JSON.stringify({
    operationId: value.operationId,
    tenantId: value.tenantId,
    accountId: value.accountId,
    idempotencyKey: value.idempotencyKey,
    routeProjection: value.routeProjection,
    indexes: [...value.indexes].sort(
      (left, right) =>
        left.indexKind.localeCompare(right.indexKind) ||
        left.hmacKeyGeneration - right.hmacKeyGeneration ||
        left.digest.localeCompare(right.digest)
    ),
  });
}

export class AccountDirectoryCoordinator {
  constructor(private readonly dependencies: AccountDirectoryCoordinatorDependencies) {}

  async publish(
    input: AccountDirectoryPublication,
    claim?: AccountDirectoryOutboxClaim
  ): Promise<AccountDirectoryPublishResult> {
    const publication = await validateAccountDirectoryPublication(input);
    const lookupByBucket = new Map<number, Promise<D1Database>>();
    const lookupForBucket = (virtualBucket: number): Promise<D1Database> => {
      let lookup = lookupByBucket.get(virtualBucket);
      if (!lookup) {
        lookup = this.dependencies.lookupForBucket(virtualBucket);
        lookupByBucket.set(virtualBucket, lookup);
      }
      return lookup;
    };
    const now = this.dependencies.now();
    const tenant = primary(this.dependencies.tenantCore);
    const account = await first<AccountRow>(
      tenant,
      `SELECT directory_publication_state, account_route_generation
         FROM identity_accounts WHERE tenant_id = ? AND id = ?`,
      [publication.tenantId, publication.accountId]
    );
    if (!account) throw new Error('directory_account_not_found');
    if (
      Number(account.account_route_generation) !==
      publication.routeProjection.accountRouteGeneration
    ) {
      throw new Error('directory_account_state_conflict');
    }
    const outbox = await first<RoutingOutboxRow>(
      tenant,
      `SELECT outbox_id, event_kind, payload_json, status, attempt_count, lease_owner
         FROM account_routing_outbox
        WHERE outbox_id = ? AND tenant_id = ? AND account_id = ?
          AND event_kind IN ('account_created', 'identifier_added')
          AND route_generation = ?`,
      [
        accountDirectoryOutboxId(publication.operationId),
        publication.tenantId,
        publication.accountId,
        publication.routeProjection.accountRouteGeneration,
      ]
    );
    if (!outbox || !['pending', 'leased', 'retry', 'succeeded'].includes(outbox.status)) {
      throw new Error('directory_routing_outbox_not_runnable');
    }
    const accountCreation = outbox.event_kind === 'account_created';
    if (
      (accountCreation &&
        !['pending', 'active_pending_directory', 'active'].includes(
          account.directory_publication_state
        )) ||
      (!accountCreation && account.directory_publication_state !== 'active')
    ) {
      throw new Error('directory_account_state_conflict');
    }
    if (
      claim &&
      (outbox.status !== 'leased' ||
        outbox.lease_owner !== claim.ownerId ||
        Number(outbox.attempt_count) !== claim.fencingToken)
    ) {
      throw new Error('directory_routing_outbox_stale_lease');
    }
    let persisted: AccountDirectoryPublication;
    try {
      persisted = await validateAccountDirectoryPublication(
        JSON.parse(outbox.payload_json) as AccountDirectoryPublication
      );
    } catch {
      throw new Error('directory_routing_outbox_payload_invalid');
    }
    if (publicationIdentity(persisted) !== publicationIdentity(publication)) {
      throw new Error('directory_routing_outbox_payload_mismatch');
    }
    const projection = exactProjection(publication);
    if (!accountCreation) {
      for (const index of publication.indexes.filter(
        (candidate) => candidate.indexKind === 'account_id'
      )) {
        const lookup = primary(await lookupForBucket(index.virtualBucket));
        const baseRoute = await first<LookupRow>(
          lookup,
          `SELECT tenant_id, account_id, route_projection_json, lifecycle_state
             FROM lookup_identifiers
            WHERE virtual_bucket = ? AND index_kind = 'account_id'
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ? AND tenant_id = ? AND account_id = ?`,
          [
            index.virtualBucket,
            index.normalizationVersion,
            index.hmacKeyGeneration,
            index.digest,
            publication.tenantId,
            publication.accountId,
          ]
        );
        if (
          !baseRoute ||
          baseRoute.lifecycle_state !== 'active' ||
          baseRoute.route_projection_json !== projection
        ) {
          throw new Error('directory_identifier_addition_base_route_missing');
        }
      }
    }
    for (const index of publication.indexes) {
      if (index.indexKind === 'account_id') continue;
      const lookup = primary(await lookupForBucket(index.virtualBucket));
      const reservation = await first<ReservationRow>(
        lookup,
        `SELECT tenant_id, account_id, operation_id, reservation_state
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
        !reservation ||
        reservation.tenant_id !== publication.tenantId ||
        reservation.account_id !== publication.accountId ||
        reservation.operation_id !== publication.operationId ||
        !['reserved', 'committed'].includes(reservation.reservation_state)
      ) {
        throw new Error('directory_identifier_reservation_conflict');
      }
    }
    for (const index of publication.indexes) {
      const lookup = primary(await lookupForBucket(index.virtualBucket));
      await lookup
        .prepare(
          `INSERT OR IGNORE INTO lookup_identifiers (
               virtual_bucket, index_kind, normalization_version, hmac_key_generation,
               identifier_blind_digest, tenant_id, account_id, route_schema_version,
               account_route_generation, required_binding_route_generation, residency_policy_id,
               route_projection_json, tenant_lifecycle_state, runtime_route_status,
               lifecycle_state, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'active', 'pending', ?, ?)`
        )
        .bind(
          ...indexParams(index),
          publication.tenantId,
          publication.accountId,
          publication.routeProjection.schemaVersion,
          publication.routeProjection.accountRouteGeneration,
          Math.max(
            ...publication.routeProjection.targets.map(
              (target) => target.requiredBindingRouteGeneration
            )
          ),
          publication.routeProjection.residencyPolicyId,
          projection,
          now,
          now
        )
        .run();
      const reflected = await first<LookupRow>(
        lookup,
        `SELECT tenant_id, account_id, route_projection_json, lifecycle_state
           FROM lookup_identifiers
          WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
            AND hmac_key_generation = ? AND identifier_blind_digest = ?
            AND tenant_id = ? AND account_id = ?`,
        [...indexParams(index), publication.tenantId, publication.accountId]
      );
      if (
        !reflected ||
        reflected.route_projection_json !== projection ||
        !['pending', 'active'].includes(reflected.lifecycle_state)
      ) {
        throw new Error('directory_lookup_pending_reflection_failed');
      }
      if (index.indexKind !== 'account_id') {
        const reservation = await first<ReservationRow>(
          lookup,
          `SELECT tenant_id, account_id, operation_id, reservation_state
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
          !reservation ||
          reservation.account_id !== publication.accountId ||
          reservation.operation_id !== publication.operationId ||
          !['reserved', 'committed'].includes(reservation.reservation_state)
        ) {
          throw new Error('directory_identifier_reservation_conflict');
        }
      }
    }

    if (accountCreation) {
      await tenant
        .prepare(
          `UPDATE identity_accounts SET directory_publication_state = 'active_pending_directory'
            WHERE tenant_id = ? AND id = ? AND account_route_generation = ?
              AND directory_publication_state IN ('pending', 'active_pending_directory')`
        )
        .bind(
          publication.tenantId,
          publication.accountId,
          publication.routeProjection.accountRouteGeneration
        )
        .run();
      const pendingDirectory = await first<AccountRow>(
        tenant,
        `SELECT directory_publication_state, account_route_generation
           FROM identity_accounts WHERE tenant_id = ? AND id = ?`,
        [publication.tenantId, publication.accountId]
      );
      if (
        !pendingDirectory ||
        !['active_pending_directory', 'active'].includes(
          pendingDirectory.directory_publication_state
        )
      ) {
        throw new Error('directory_account_pending_reflection_failed');
      }
    }

    for (const index of publication.indexes) {
      const lookup = primary(await lookupForBucket(index.virtualBucket));
      const publicationCounter = await lookup
        .prepare(`SELECT 1 AS present FROM lookup_bucket_counters WHERE virtual_bucket = ?`)
        .bind(index.virtualBucket)
        .first<{ present: number }>();
      if (publicationCounter?.present !== 1) {
        throw new Error('directory_publication_counter_missing');
      }
      await lookup.batch([
        lookup
          .prepare(
            `UPDATE lookup_bucket_counters
                SET successful_route_publication_count = successful_route_publication_count + 1,
                    publication_counter_updated_at = MAX(publication_counter_updated_at, ?)
              WHERE virtual_bucket = ?
                AND EXISTS (
                  SELECT 1 FROM lookup_identifiers
                   WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
                     AND hmac_key_generation = ? AND identifier_blind_digest = ?
                     AND tenant_id = ? AND account_id = ? AND route_projection_json = ?
                     AND lifecycle_state = 'pending'
                )`
          )
          .bind(
            now,
            index.virtualBucket,
            ...indexParams(index),
            publication.tenantId,
            publication.accountId,
            projection
          ),
        lookup
          .prepare(
            `UPDATE lookup_identifiers SET lifecycle_state = 'active', updated_at = ?
              WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
                AND hmac_key_generation = ? AND identifier_blind_digest = ?
                AND tenant_id = ? AND account_id = ? AND route_projection_json = ?
                AND lifecycle_state IN ('pending', 'active')`
          )
          .bind(
            now,
            ...indexParams(index),
            publication.tenantId,
            publication.accountId,
            projection
          ),
        ...(index.indexKind === 'account_id'
          ? []
          : [
              lookup
                .prepare(
                  `UPDATE lookup_identifier_reservations
                      SET reservation_state = 'committed', committed_at = COALESCE(committed_at, ?),
                          updated_at = ?
                    WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
                      AND normalization_version = ? AND hmac_key_generation = ?
                      AND identifier_blind_digest = ? AND account_id = ?
                      AND operation_id = ?
                      AND reservation_state IN ('reserved', 'committed')`
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
                ),
            ]),
      ]);
      const active = await first<LookupRow>(
        lookup,
        `SELECT tenant_id, account_id, route_projection_json, lifecycle_state
           FROM lookup_identifiers
          WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
            AND hmac_key_generation = ? AND identifier_blind_digest = ?
            AND tenant_id = ? AND account_id = ?`,
        [...indexParams(index), publication.tenantId, publication.accountId]
      );
      if (
        !active ||
        active.lifecycle_state !== 'active' ||
        active.route_projection_json !== projection
      ) {
        throw new Error('directory_lookup_activation_reflection_failed');
      }
      if (index.indexKind !== 'account_id') {
        const committed = await first<ReservationRow>(
          lookup,
          `SELECT tenant_id, account_id, operation_id, reservation_state
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
          !committed ||
          committed.account_id !== publication.accountId ||
          committed.operation_id !== publication.operationId ||
          committed.reservation_state !== 'committed'
        ) {
          throw new Error('directory_identifier_reservation_commit_failed');
        }
      }
    }

    if (accountCreation) {
      const completed = await tenant
        .prepare(
          `UPDATE identity_accounts SET directory_publication_state = 'active'
            WHERE tenant_id = ? AND id = ? AND account_route_generation = ?
              AND directory_publication_state IN ('active_pending_directory', 'active')`
        )
        .bind(
          publication.tenantId,
          publication.accountId,
          publication.routeProjection.accountRouteGeneration
        )
        .run();
      if ((completed.meta.changes ?? 0) !== 1) {
        throw new Error('directory_account_activation_failed');
      }
      await this.dependencies.onAccountActivated?.(publication, now);
    }
    const completionSql = claim
      ? `UPDATE account_routing_outbox
            SET status = 'succeeded', succeeded_at = COALESCE(succeeded_at, ?),
                lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
                last_error_code = NULL, updated_at = ?
          WHERE outbox_id = ? AND status = 'leased' AND lease_owner = ? AND attempt_count = ?`
      : `UPDATE account_routing_outbox
            SET status = 'succeeded', succeeded_at = COALESCE(succeeded_at, ?),
                lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
                last_error_code = NULL, updated_at = ?
          WHERE outbox_id = ? AND status IN ('pending', 'leased', 'retry', 'succeeded')`;
    const completion = tenant.prepare(completionSql);
    const outboxCompleted = claim
      ? await completion.bind(now, now, outbox.outbox_id, claim.ownerId, claim.fencingToken).run()
      : await completion.bind(now, now, outbox.outbox_id).run();
    if ((outboxCompleted.meta.changes ?? 0) !== 1) {
      throw new Error('directory_routing_outbox_completion_failed');
    }
    return { status: 201, accountId: publication.accountId, operationId: publication.operationId };
  }
}
