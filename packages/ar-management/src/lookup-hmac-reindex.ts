import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  createD1ConsistencyRequest,
  createLookupBlindIndex,
  loadVerifiedLookupBucketAssignmentProvider,
  lookupVirtualBucket,
  LookupRouteResolver,
  validateAccountRouteProjection,
  validateAccountDirectoryPublication,
  type AccountDirectoryPublication,
  type ControlLookupHmacRotationSourceShardView,
  type ControlLookupHmacRotationVerificationShardView,
  type ControlLookupHmacRotationView,
  type Env,
  type LookupBlindIndex,
  type LookupBlindIndexKey,
  type ResolvedLookupMembership,
  type AccountRouteProjection,
} from '@authrim/ar-lib-core';
import type { DirectoryJobProcessor } from './directory-scheduled';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

interface SourceCursor {
  afterCreatedAt: number;
  afterId: string;
}

interface VerificationCursor {
  afterRowId: number;
}

interface CoreSourceRow {
  id: string;
  tenant_id: string;
  legacy_user_id: string;
  created_at: number | string;
  account_route_generation: number | string;
  payload_json: string;
}

interface EmailSourceRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  value_json: string;
  created_at: number | string;
}

interface ExternalSubjectSourceRow {
  id: string;
  authority_id: string;
  authority_kind: 'linked_identity' | 'passkey' | 'anonymous_device';
  tenant_id: string;
  user_id: string;
  provider_id: string;
  provider_user_id: string;
  linked_at: number | string;
}

type SourceRow = CoreSourceRow | EmailSourceRow | ExternalSubjectSourceRow;

interface LookupReflectionRow {
  tenant_id: string;
  account_id: string;
  route_projection_json: string;
  lifecycle_state: string;
}

interface ReservationReflectionRow {
  account_id: string;
  reservation_state: string;
}

interface VerificationRow {
  verification_rowid: number | string;
  virtual_bucket: number | string;
  index_kind: 'account_id' | 'email_exact' | 'external_subject';
  normalization_version: number | string;
  hmac_key_generation: number | string;
  identifier_blind_digest: string;
  tenant_id: string;
  account_id: string;
  route_schema_version: number | string;
  account_route_generation: number | string;
  required_binding_route_generation: number | string;
  residency_policy_id: string;
  route_projection_json: string;
  tenant_lifecycle_state: string;
  runtime_route_status: string;
  lifecycle_state: string;
}

interface VerificationFlags {
  currentRowsValid: boolean;
  reservationsValid: boolean;
  routeReferencesValid: boolean;
}

function integer(value: unknown, minimum: number, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code);
  return parsed;
}

function identifier(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function binding(env: Env, bindingRef: string, code: string): D1Database {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(bindingRef)) throw new Error(code);
  const value = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!value || typeof value !== 'object') throw new Error(code);
  const candidate = value as Partial<D1Database>;
  if (
    typeof candidate.prepare !== 'function' ||
    typeof candidate.batch !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error(code);
  }
  return value as D1Database;
}

function primary(database: D1Database): D1DatabaseSession {
  if (typeof database.withSession !== 'function') throw new Error('d1_sessions_api_required');
  return database.withSession('first-primary');
}

function cursor(value: Record<string, unknown>): SourceCursor {
  if (Object.keys(value).length === 0) return { afterCreatedAt: 0, afterId: '' };
  if (
    Object.keys(value).length !== 2 ||
    Object.keys(value).some((key) => !['after_created_at', 'after_id'].includes(key))
  ) {
    throw new Error('lookup_hmac_reindex_cursor_invalid');
  }
  const afterCreatedAt = integer(value.after_created_at, 0, 'lookup_hmac_reindex_cursor_invalid');
  const afterId = value.after_id;
  if (typeof afterId !== 'string' || (afterId !== '' && !SAFE_ID.test(afterId))) {
    throw new Error('lookup_hmac_reindex_cursor_invalid');
  }
  return { afterCreatedAt, afterId };
}

function encodedCursor(value: SourceCursor): Record<string, unknown> {
  return { after_created_at: value.afterCreatedAt, after_id: value.afterId };
}

function verificationCursor(value: Record<string, unknown>): VerificationCursor {
  if (Object.keys(value).length === 0) return { afterRowId: 0 };
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, 'after_row_id')) {
    throw new Error('lookup_hmac_verification_cursor_invalid');
  }
  return {
    afterRowId: integer(value.after_row_id, 0, 'lookup_hmac_verification_cursor_invalid'),
  };
}

function encodedVerificationCursor(value: VerificationCursor): Record<string, unknown> {
  return { after_row_id: value.afterRowId };
}

function accountId(userId: string): string {
  return `account:${identifier(userId, 'lookup_hmac_reindex_user_invalid')}`;
}

function sourceTimestamp(row: SourceRow, sourceKind: string): number {
  return integer(
    sourceKind === 'external_subject'
      ? (row as ExternalSubjectSourceRow).linked_at
      : (row as CoreSourceRow | EmailSourceRow).created_at,
    1,
    'lookup_hmac_reindex_source_time_invalid'
  );
}

function sourceId(row: SourceRow): string {
  return identifier(row.id, 'lookup_hmac_reindex_source_id_invalid');
}

function sourceQuery(source: ControlLookupHmacRotationSourceShardView): string {
  switch (source.sourceKind) {
    case 'account_id':
      return `SELECT account.id, account.tenant_id, account.legacy_user_id,
                     account.created_at, account.account_route_generation, outbox.payload_json
                FROM identity_accounts account
                JOIN account_routing_outbox outbox
                  ON outbox.tenant_id = account.tenant_id
                 AND outbox.account_id = account.id
                 AND outbox.event_kind = 'account_created'
                 AND outbox.route_generation = account.account_route_generation
               WHERE account.lifecycle_state = 'active'
                 AND account.directory_publication_state = 'active'
                 AND outbox.status = 'succeeded'
                 AND account.created_at < ?
                 AND (account.created_at > ? OR (account.created_at = ? AND account.id > ?))
               ORDER BY account.created_at, account.id LIMIT ?`;
    case 'email_exact':
      return `SELECT id, tenant_id, owner_id, value_json, created_at
                FROM identity_sensitive_values
               WHERE owner_type = 'runtime_user' AND value_key = 'email'
                 AND lifecycle_state = 'active' AND created_at < ?
                 AND (created_at > ? OR (created_at = ? AND id > ?))
               ORDER BY created_at, id LIMIT ?`;
    case 'external_subject':
      if (source.dataRole === 'tenant_pii') {
        return `SELECT 'linked:' || id AS id, id AS authority_id,
                       'linked_identity' AS authority_kind,
                       tenant_id, user_id, provider_id, provider_user_id, linked_at
                  FROM linked_identities
                 WHERE linked_at < ?
                   AND (linked_at > ? OR (linked_at = ? AND 'linked:' || id > ?))
                 ORDER BY linked_at, 'linked:' || id LIMIT ?`;
      }
      return `SELECT id, authority_id, authority_kind, tenant_id, user_id,
                     provider_id, provider_user_id, linked_at
                FROM (
                  SELECT 'passkey:' || id AS id, id AS authority_id,
                         'passkey' AS authority_kind,
                         tenant_id, user_id,
                         'urn:authrim:passkey:' || lower(rp_id) AS provider_id,
                         credential_id AS provider_user_id, created_at AS linked_at
                    FROM passkeys
                   WHERE rp_id IS NOT NULL AND rp_id <> ''
                  UNION ALL
                  SELECT 'anonymous:' || id AS id, id AS authority_id,
                         'anonymous_device' AS authority_kind,
                         tenant_id, user_id,
                         'urn:authrim:anonymous-device:v1' AS provider_id,
                         device_id_hash AS provider_user_id, created_at AS linked_at
                    FROM anonymous_devices WHERE is_active = 1
                ) authority
               WHERE linked_at < ?
                 AND (linked_at > ? OR (linked_at = ? AND id > ?))
               ORDER BY linked_at, id LIMIT ?`;
  }
}

async function sourceRows(
  source: ControlLookupHmacRotationSourceShardView,
  session: D1DatabaseSession,
  sourceCursor: SourceCursor,
  limit: number
): Promise<SourceRow[]> {
  const result = await session
    .prepare(sourceQuery(source))
    .bind(
      source.cutoffAt,
      sourceCursor.afterCreatedAt,
      sourceCursor.afterCreatedAt,
      sourceCursor.afterId,
      limit
    )
    .all<SourceRow>();
  return result.results;
}

function currentAndSourceKeys(
  operation: ControlLookupHmacRotationView,
  keys: Awaited<ReturnType<typeof loadLookupHmacRuntimeKeys>>
): { current: LookupBlindIndexKey; source: LookupBlindIndexKey } {
  const current = keys.readKeys.find((key) => key.generation === operation.candidate.generation);
  const source = keys.readKeys.find((key) => key.generation === operation.source.generation);
  if (
    !current ||
    !source ||
    keys.state.current.generation !== operation.candidate.generation ||
    keys.state.previous?.generation !== operation.source.generation ||
    !['dual_read', 'reindexing', 'verifying'].includes(keys.state.rotationState)
  ) {
    throw new Error('lookup_hmac_reindex_key_state_mismatch');
  }
  return { current, source };
}

function publicationFromCoreRow(
  row: CoreSourceRow,
  source: ControlLookupHmacRotationSourceShardView
): Promise<AccountDirectoryPublication> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new Error('lookup_hmac_reindex_publication_invalid');
  }
  return validateAccountDirectoryPublication(parsed as AccountDirectoryPublication).then(
    (publication) => {
      const target = publication.routeProjection.targets.filter(
        (candidate) => candidate.dataRole === 'tenant_core/users'
      );
      if (
        publication.tenantId !== row.tenant_id ||
        publication.accountId !== row.id ||
        row.id !== accountId(row.legacy_user_id) ||
        publication.routeProjection.accountRouteGeneration !==
          integer(row.account_route_generation, 1, 'lookup_hmac_reindex_route_invalid') ||
        target.length !== 1 ||
        target[0].shardId !== source.shardId ||
        target[0].bindingRef !== source.bindingRef ||
        target[0].requiredBindingRouteGeneration > source.routeGeneration
      ) {
        throw new Error('lookup_hmac_reindex_route_invalid');
      }
      return publication;
    }
  );
}

async function accountMembership(
  env: Env,
  source: ControlLookupHmacRotationSourceShardView,
  tenantId: string,
  userId: string,
  sourceKey: LookupBlindIndexKey,
  resolver: LookupRouteResolver
): Promise<ResolvedLookupMembership> {
  const expectedAccountId = accountId(userId);
  const index = await createLookupBlindIndex('account_id', expectedAccountId, sourceKey);
  const memberships = (
    await resolver.resolveMemberships({
      indexes: [index],
      consistency: createD1ConsistencyRequest('primary_required'),
    })
  ).filter(
    (membership) => membership.tenantId === tenantId && membership.accountId === expectedAccountId
  );
  if (memberships.length !== 1) throw new Error('lookup_hmac_reindex_account_route_missing');
  const membership = memberships[0];
  const sourceTarget = membership.routeProjection.targets.filter(
    (target) => target.dataRole === source.dataRole
  );
  if (
    sourceTarget.length !== 1 ||
    sourceTarget[0].shardId !== source.shardId ||
    sourceTarget[0].bindingRef !== source.bindingRef ||
    sourceTarget[0].requiredBindingRouteGeneration > source.routeGeneration
  ) {
    throw new Error('lookup_hmac_reindex_source_route_mismatch');
  }
  const coreTarget = membership.routeProjection.targets.filter(
    (target) => target.dataRole === 'tenant_core/users'
  );
  if (coreTarget.length !== 1) throw new Error('lookup_hmac_reindex_core_route_invalid');
  const core = primary(
    binding(env, coreTarget[0].bindingRef, 'lookup_hmac_reindex_core_unavailable')
  );
  const row = await core
    .prepare(
      `SELECT account.id, account.tenant_id, account.legacy_user_id,
              account.created_at, account.account_route_generation, outbox.payload_json
         FROM identity_accounts account
         JOIN account_routing_outbox outbox
           ON outbox.tenant_id = account.tenant_id AND outbox.account_id = account.id
          AND outbox.event_kind = 'account_created'
          AND outbox.route_generation = account.account_route_generation
        WHERE account.tenant_id = ? AND account.id = ?
          AND account.lifecycle_state = 'active'
          AND account.directory_publication_state = 'active'
          AND outbox.status = 'succeeded'`
    )
    .bind(tenantId, expectedAccountId)
    .first<CoreSourceRow>();
  if (!row) throw new Error('lookup_hmac_reindex_core_account_missing');
  const publication = await validateAccountDirectoryPublication(
    JSON.parse(row.payload_json) as AccountDirectoryPublication
  );
  if (
    JSON.stringify(publication.routeProjection) !== JSON.stringify(membership.routeProjection) ||
    publication.accountId !== expectedAccountId ||
    publication.tenantId !== tenantId
  ) {
    throw new Error('lookup_hmac_reindex_core_route_mismatch');
  }
  return membership;
}

function rawIdentifier(
  sourceKind: ControlLookupHmacRotationSourceShardView['sourceKind'],
  row: SourceRow
): {
  tenantId: string;
  accountId: string;
  value: string | { issuer: string; subject: string };
} {
  if (sourceKind === 'account_id') {
    const core = row as CoreSourceRow;
    return { tenantId: core.tenant_id, accountId: core.id, value: core.id };
  }
  if (sourceKind === 'email_exact') {
    const email = row as EmailSourceRow;
    let value: unknown;
    try {
      value = JSON.parse(email.value_json) as unknown;
    } catch {
      throw new Error('lookup_hmac_reindex_email_invalid');
    }
    if (typeof value !== 'string') throw new Error('lookup_hmac_reindex_email_invalid');
    return { tenantId: email.tenant_id, accountId: accountId(email.owner_id), value };
  }
  const external = row as ExternalSubjectSourceRow;
  return {
    tenantId: external.tenant_id,
    accountId: accountId(external.user_id),
    value: { issuer: external.provider_id, subject: external.provider_user_id },
  };
}

async function verifySourceReservation(input: {
  lookupForBucket: (virtualBucket: number) => Promise<D1Database>;
  sourceIndex: LookupBlindIndex;
  tenantId: string;
  accountId: string;
}): Promise<void> {
  if (input.sourceIndex.indexKind === 'account_id') return;
  const row = await primary(await input.lookupForBucket(input.sourceIndex.virtualBucket))
    .prepare(
      `SELECT account_id, reservation_state FROM lookup_identifier_reservations
        WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
          AND normalization_version = ? AND hmac_key_generation = ?
          AND identifier_blind_digest = ?`
    )
    .bind(
      input.sourceIndex.virtualBucket,
      input.tenantId,
      input.sourceIndex.indexKind,
      input.sourceIndex.normalizationVersion,
      input.sourceIndex.hmacKeyGeneration,
      input.sourceIndex.digest
    )
    .first<ReservationReflectionRow>();
  if (row?.account_id !== input.accountId || row.reservation_state !== 'committed') {
    throw new Error('lookup_hmac_reindex_source_reservation_invalid');
  }
}

async function upsertCurrentIdentifier(input: {
  lookupForBucket: (virtualBucket: number) => Promise<D1Database>;
  operationId: string;
  currentIndex: LookupBlindIndex;
  tenantId: string;
  accountId: string;
  routeProjection: AccountDirectoryPublication['routeProjection'];
  now: number;
}): Promise<void> {
  const lookup = primary(await input.lookupForBucket(input.currentIndex.virtualBucket));
  if (input.currentIndex.indexKind !== 'account_id') {
    await lookup
      .prepare(
        `INSERT OR IGNORE INTO lookup_identifier_reservations (
           virtual_bucket, tenant_id, index_kind, normalization_version,
           hmac_key_generation, identifier_blind_digest, account_id,
           reservation_state, operation_id, committed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?)`
      )
      .bind(
        input.currentIndex.virtualBucket,
        input.tenantId,
        input.currentIndex.indexKind,
        input.currentIndex.normalizationVersion,
        input.currentIndex.hmacKeyGeneration,
        input.currentIndex.digest,
        input.accountId,
        `hmac-reindex:${input.operationId}`,
        input.now,
        input.now,
        input.now
      )
      .run();
    const reservation = await lookup
      .prepare(
        `SELECT account_id, reservation_state FROM lookup_identifier_reservations
          WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
            AND normalization_version = ? AND hmac_key_generation = ?
            AND identifier_blind_digest = ?`
      )
      .bind(
        input.currentIndex.virtualBucket,
        input.tenantId,
        input.currentIndex.indexKind,
        input.currentIndex.normalizationVersion,
        input.currentIndex.hmacKeyGeneration,
        input.currentIndex.digest
      )
      .first<ReservationReflectionRow>();
    if (
      reservation?.account_id !== input.accountId ||
      reservation.reservation_state !== 'committed'
    ) {
      throw new Error('lookup_hmac_reindex_reservation_conflict');
    }
  }
  const projection = JSON.stringify(input.routeProjection);
  await lookup
    .prepare(
      `INSERT INTO lookup_identifiers (
         virtual_bucket, index_kind, normalization_version, hmac_key_generation,
         identifier_blind_digest, tenant_id, account_id, route_schema_version,
         account_route_generation, required_binding_route_generation, residency_policy_id,
         route_projection_json, tenant_lifecycle_state, runtime_route_status,
         lifecycle_state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'active', 'active', ?, ?)
       ON CONFLICT(
         virtual_bucket, index_kind, normalization_version, hmac_key_generation,
         identifier_blind_digest, tenant_id, account_id
       ) DO UPDATE SET lifecycle_state = 'active', disabled_at = NULL, updated_at = excluded.updated_at
       WHERE lookup_identifiers.route_projection_json = excluded.route_projection_json
         AND lookup_identifiers.account_route_generation = excluded.account_route_generation`
    )
    .bind(
      input.currentIndex.virtualBucket,
      input.currentIndex.indexKind,
      input.currentIndex.normalizationVersion,
      input.currentIndex.hmacKeyGeneration,
      input.currentIndex.digest,
      input.tenantId,
      input.accountId,
      input.routeProjection.schemaVersion,
      input.routeProjection.accountRouteGeneration,
      Math.max(
        ...input.routeProjection.targets.map((target) => target.requiredBindingRouteGeneration)
      ),
      input.routeProjection.residencyPolicyId,
      projection,
      input.now,
      input.now
    )
    .run();
  const reflected = await lookup
    .prepare(
      `SELECT tenant_id, account_id, route_projection_json, lifecycle_state
         FROM lookup_identifiers
        WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
          AND hmac_key_generation = ? AND identifier_blind_digest = ?
          AND tenant_id = ? AND account_id = ?`
    )
    .bind(
      input.currentIndex.virtualBucket,
      input.currentIndex.indexKind,
      input.currentIndex.normalizationVersion,
      input.currentIndex.hmacKeyGeneration,
      input.currentIndex.digest,
      input.tenantId,
      input.accountId
    )
    .first<LookupReflectionRow>();
  if (
    reflected?.tenant_id !== input.tenantId ||
    reflected.account_id !== input.accountId ||
    reflected.route_projection_json !== projection ||
    reflected.lifecycle_state !== 'active'
  ) {
    throw new Error('lookup_hmac_reindex_reflection_failed');
  }
}

async function sourceStillAuthoritative(
  source: ControlLookupHmacRotationSourceShardView,
  session: D1DatabaseSession,
  row: SourceRow
): Promise<boolean> {
  if (source.sourceKind === 'account_id') {
    const core = row as CoreSourceRow;
    const reflected = await session
      .prepare(
        `SELECT account.account_route_generation, outbox.payload_json
           FROM identity_accounts account
           JOIN account_routing_outbox outbox
             ON outbox.tenant_id = account.tenant_id AND outbox.account_id = account.id
            AND outbox.event_kind = 'account_created'
            AND outbox.route_generation = account.account_route_generation
          WHERE account.tenant_id = ? AND account.id = ?
            AND account.lifecycle_state = 'active'
            AND account.directory_publication_state = 'active'
            AND outbox.status = 'succeeded'`
      )
      .bind(core.tenant_id, core.id)
      .first<{ account_route_generation: number | string; payload_json: string }>();
    return (
      reflected !== null &&
      integer(reflected.account_route_generation, 1, 'lookup_hmac_reindex_route_invalid') ===
        integer(core.account_route_generation, 1, 'lookup_hmac_reindex_route_invalid') &&
      reflected.payload_json === core.payload_json
    );
  }
  if (source.sourceKind === 'email_exact') {
    const email = row as EmailSourceRow;
    const reflected = await session
      .prepare(
        `SELECT id FROM identity_sensitive_values
          WHERE id = ? AND tenant_id = ? AND owner_id = ? AND owner_type = 'runtime_user'
            AND value_key = 'email' AND value_json = ? AND lifecycle_state = 'active'`
      )
      .bind(email.id, email.tenant_id, email.owner_id, email.value_json)
      .first<{ id: string }>();
    return reflected?.id === email.id;
  }
  const external = row as ExternalSubjectSourceRow;
  if (external.authority_kind === 'passkey') {
    const reflected = await session
      .prepare(
        `SELECT id FROM passkeys
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND credential_id = ?
            AND rp_id = ?`
      )
      .bind(
        external.authority_id,
        external.tenant_id,
        external.user_id,
        external.provider_user_id,
        external.provider_id.slice('urn:authrim:passkey:'.length)
      )
      .first<{ id: string }>();
    return reflected?.id === external.authority_id;
  }
  if (external.authority_kind === 'anonymous_device') {
    const reflected = await session
      .prepare(
        `SELECT id FROM anonymous_devices
          WHERE id = ? AND tenant_id = ? AND user_id = ? AND device_id_hash = ?
            AND is_active = 1`
      )
      .bind(external.authority_id, external.tenant_id, external.user_id, external.provider_user_id)
      .first<{ id: string }>();
    return reflected?.id === external.authority_id;
  }
  const reflected = await session
    .prepare(
      `SELECT id FROM linked_identities
        WHERE id = ? AND tenant_id = ? AND user_id = ? AND provider_id = ?
          AND provider_user_id = ?`
    )
    .bind(
      external.authority_id,
      external.tenant_id,
      external.user_id,
      external.provider_id,
      external.provider_user_id
    )
    .first<{ id: string }>();
  return reflected?.id === external.authority_id;
}

async function disableStaleCurrentIdentifier(input: {
  lookupForBucket: (virtualBucket: number) => Promise<D1Database>;
  operationId: string;
  index: LookupBlindIndex;
  tenantId: string;
  accountId: string;
  now: number;
}): Promise<void> {
  const lookup = primary(await input.lookupForBucket(input.index.virtualBucket));
  await lookup
    .prepare(
      `UPDATE lookup_identifiers
          SET lifecycle_state = 'disabled', disabled_at = ?, updated_at = ?
        WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
          AND hmac_key_generation = ? AND identifier_blind_digest = ?
          AND tenant_id = ? AND account_id = ? AND lifecycle_state = 'active'`
    )
    .bind(
      input.now,
      input.now,
      input.index.virtualBucket,
      input.index.indexKind,
      input.index.normalizationVersion,
      input.index.hmacKeyGeneration,
      input.index.digest,
      input.tenantId,
      input.accountId
    )
    .run();
  if (input.index.indexKind !== 'account_id') {
    await lookup
      .prepare(
        `UPDATE lookup_identifier_reservations
            SET reservation_state = 'releasing', updated_at = ?
          WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
            AND normalization_version = ? AND hmac_key_generation = ?
            AND identifier_blind_digest = ? AND account_id = ?
            AND operation_id = ? AND reservation_state = 'committed'`
      )
      .bind(
        input.now,
        input.index.virtualBucket,
        input.tenantId,
        input.index.indexKind,
        input.index.normalizationVersion,
        input.index.hmacKeyGeneration,
        input.index.digest,
        input.accountId,
        `hmac-reindex:${input.operationId}`
      )
      .run();
  }
}

async function publicationForRow(input: {
  env: Env;
  source: ControlLookupHmacRotationSourceShardView;
  row: SourceRow;
  sourceKey: LookupBlindIndexKey;
  resolver: LookupRouteResolver;
}): Promise<AccountDirectoryPublication> {
  if (input.source.sourceKind === 'account_id') {
    return publicationFromCoreRow(input.row as CoreSourceRow, input.source);
  }
  const raw = rawIdentifier(input.source.sourceKind, input.row);
  const membership = await accountMembership(
    input.env,
    input.source,
    raw.tenantId,
    raw.accountId.slice('account:'.length),
    input.sourceKey,
    input.resolver
  );
  return validateAccountDirectoryPublication({
    operationId: `hmac-reindex-route:${input.source.operationId}`,
    tenantId: membership.tenantId,
    accountId: membership.accountId,
    idempotencyKey: `hmac-reindex-route:${input.source.operationId}`,
    routeProjection: membership.routeProjection,
    indexes: [await createLookupBlindIndex('account_id', membership.accountId, input.sourceKey)],
  });
}

async function verificationRows(
  database: D1Database,
  keyGeneration: number,
  after: VerificationCursor,
  limit: number
): Promise<VerificationRow[]> {
  const result = await primary(database)
    .prepare(
      `SELECT rowid AS verification_rowid,
              virtual_bucket, index_kind, normalization_version, hmac_key_generation,
              identifier_blind_digest, tenant_id, account_id, route_schema_version,
              account_route_generation, required_binding_route_generation,
              residency_policy_id, route_projection_json, tenant_lifecycle_state,
              runtime_route_status, lifecycle_state
         FROM lookup_identifiers
        WHERE hmac_key_generation = ? AND lifecycle_state = 'active'
          AND rowid > ?
        ORDER BY rowid
        LIMIT ?`
    )
    .bind(keyGeneration, after.afterRowId, limit)
    .all<VerificationRow>();
  return result.results;
}

function routeProjection(row: VerificationRow): AccountRouteProjection | null {
  try {
    const parsed = JSON.parse(row.route_projection_json) as unknown;
    return validateAccountRouteProjection(parsed as AccountRouteProjection);
  } catch {
    return null;
  }
}

async function verifyCurrentRow(input: {
  env: Env;
  row: VerificationRow;
  shard: ControlLookupHmacRotationVerificationShardView;
  assignments: Awaited<ReturnType<typeof loadVerifiedLookupBucketAssignmentProvider>>;
}): Promise<VerificationFlags> {
  const flags: VerificationFlags = {
    currentRowsValid: true,
    reservationsValid: true,
    routeReferencesValid: true,
  };
  const rowBucket = integer(input.row.virtual_bucket, 0, 'lookup_hmac_verification_row_invalid');
  const normalizationVersion = integer(
    input.row.normalization_version,
    1,
    'lookup_hmac_verification_row_invalid'
  );
  const hmacKeyGeneration = integer(
    input.row.hmac_key_generation,
    1,
    'lookup_hmac_verification_row_invalid'
  );
  const accountRouteGeneration = integer(
    input.row.account_route_generation,
    1,
    'lookup_hmac_verification_row_invalid'
  );
  const requiredBindingGeneration = integer(
    input.row.required_binding_route_generation,
    1,
    'lookup_hmac_verification_row_invalid'
  );
  const projection = routeProjection(input.row);
  const digestValid = /^[a-f0-9]{64}$/u.test(input.row.identifier_blind_digest);
  const expectedBucket = digestValid
    ? await lookupVirtualBucket(input.row.index_kind, input.row.identifier_blind_digest)
    : -1;
  let assignmentMatches = false;
  try {
    const assignment = await input.assignments.resolveActiveAssignment(rowBucket);
    assignmentMatches =
      assignment.lookupShardId === input.shard.lookupShardId &&
      assignment.bindingRef === input.shard.bindingRef;
  } catch {
    assignmentMatches = false;
  }
  const maximumBindingGeneration = projection
    ? Math.max(...projection.targets.map((target) => target.requiredBindingRouteGeneration))
    : -1;
  if (
    rowBucket > 4095 ||
    !digestValid ||
    expectedBucket !== rowBucket ||
    !SAFE_ID.test(input.row.tenant_id) ||
    !SAFE_ID.test(input.row.account_id) ||
    normalizationVersion !== 1 ||
    input.row.tenant_lifecycle_state !== 'active' ||
    input.row.runtime_route_status !== 'active' ||
    input.row.lifecycle_state !== 'active' ||
    !projection ||
    projection.schemaVersion !== integer(input.row.route_schema_version, 1, 'invalid') ||
    projection.accountRouteGeneration !== accountRouteGeneration ||
    projection.residencyPolicyId !== input.row.residency_policy_id ||
    maximumBindingGeneration !== requiredBindingGeneration ||
    !assignmentMatches
  ) {
    flags.currentRowsValid = false;
  }
  if (input.row.index_kind !== 'account_id') {
    const reservation = await primary(
      binding(input.env, input.shard.bindingRef, 'lookup_hmac_verification_binding_unavailable')
    )
      .prepare(
        `SELECT account_id, reservation_state FROM lookup_identifier_reservations
          WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
            AND normalization_version = ? AND hmac_key_generation = ?
            AND identifier_blind_digest = ?`
      )
      .bind(
        rowBucket,
        input.row.tenant_id,
        input.row.index_kind,
        normalizationVersion,
        hmacKeyGeneration,
        input.row.identifier_blind_digest
      )
      .first<ReservationReflectionRow>();
    flags.reservationsValid =
      reservation?.account_id === input.row.account_id &&
      reservation.reservation_state === 'committed';
  }
  const coreTargets =
    projection?.targets.filter((target) => target.dataRole === 'tenant_core/users') ?? [];
  if (coreTargets.length !== 1) {
    flags.routeReferencesValid = false;
  } else {
    try {
      const core = primary(
        binding(input.env, coreTargets[0].bindingRef, 'lookup_hmac_verification_core_unavailable')
      );
      const authoritative = await core
        .prepare(
          `SELECT account.account_route_generation, outbox.payload_json
             FROM identity_accounts account
             JOIN account_routing_outbox outbox
               ON outbox.tenant_id = account.tenant_id AND outbox.account_id = account.id
              AND outbox.event_kind = 'account_created'
              AND outbox.route_generation = account.account_route_generation
            WHERE account.tenant_id = ? AND account.id = ?
              AND account.lifecycle_state = 'active'
              AND account.directory_publication_state = 'active'
              AND outbox.status = 'succeeded'`
        )
        .bind(input.row.tenant_id, input.row.account_id)
        .first<{ account_route_generation: number | string; payload_json: string }>();
      let publication: AccountDirectoryPublication | null = null;
      if (authoritative) {
        try {
          publication = await validateAccountDirectoryPublication(
            JSON.parse(authoritative.payload_json) as AccountDirectoryPublication
          );
        } catch {
          publication = null;
        }
      }
      flags.routeReferencesValid =
        publication?.tenantId === input.row.tenant_id &&
        publication.accountId === input.row.account_id &&
        integer(authoritative?.account_route_generation, 1, 'invalid') === accountRouteGeneration &&
        JSON.stringify(publication.routeProjection) === JSON.stringify(projection);
    } catch (error) {
      if (
        error instanceof Error &&
        ['lookup_hmac_verification_core_unavailable', 'd1_sessions_api_required'].includes(
          error.message
        )
      ) {
        throw error;
      }
      flags.routeReferencesValid = false;
    }
  }
  return flags;
}

function andFlags(left: VerificationFlags, right: VerificationFlags): VerificationFlags {
  return {
    currentRowsValid: left.currentRowsValid && right.currentRowsValid,
    reservationsValid: left.reservationsValid && right.reservationsValid,
    routeReferencesValid: left.routeReferencesValid && right.routeReferencesValid,
  };
}

export function createLookupHmacReindexProcessor(env: Env): DirectoryJobProcessor {
  return async (input) => {
    const control = env.CONTROL;
    if (!control?.claimNextLookupHmacRotation) return { cursor: {}, processedRows: 0 };
    const operation = await control.claimNextLookupHmacRotation({ ownerId: input.ownerId });
    if (!operation) return { cursor: {}, processedRows: 0 };
    const mutation = {
      operationId: operation.operationId,
      ownerId: input.ownerId,
      fencingToken: operation.fencingToken,
    };
    if (operation.state === 'grace') {
      if (!control.completeLookupHmacRotationGrace) {
        throw new Error('lookup_hmac_reindex_control_unavailable');
      }
      if (
        operation.graceExpiresAt !== null &&
        Math.floor(input.nowMs() / 1000) >= operation.graceExpiresAt
      ) {
        await control.completeLookupHmacRotationGrace(mutation);
      }
      return { cursor: { operation_id: operation.operationId }, processedRows: 0 };
    }
    if (operation.state === 'verifying') {
      if (
        !control.getNextLookupHmacRotationVerificationShard ||
        !control.checkpointLookupHmacRotationVerificationShard ||
        !control.finalizeLookupHmacRotationVerification
      ) {
        throw new Error('lookup_hmac_reindex_control_unavailable');
      }
      const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
      if (
        !environmentId ||
        !env.TENANT_RUNTIME_REGISTRY ||
        !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
      ) {
        throw new Error('lookup_hmac_reindex_registry_unavailable');
      }
      const assignments = await loadVerifiedLookupBucketAssignmentProvider({
        store: env.TENANT_RUNTIME_REGISTRY,
        environmentId,
        publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
      });
      const shard = await control.getNextLookupHmacRotationVerificationShard(mutation);
      if (!shard) {
        await control.finalizeLookupHmacRotationVerification(mutation);
        return { cursor: { operation_id: operation.operationId }, processedRows: 0 };
      }
      const after = verificationCursor(shard.cursor);
      const lookup = binding(env, shard.bindingRef, 'lookup_hmac_verification_binding_unavailable');
      const rows = await verificationRows(
        lookup,
        operation.candidate.generation,
        after,
        input.rowLimit
      );
      let nextCursor = after;
      let processedRows = 0;
      let flags: VerificationFlags = {
        currentRowsValid: shard.currentRowsValid,
        reservationsValid: shard.reservationsValid,
        routeReferencesValid: shard.routeReferencesValid,
      };
      for (const row of rows) {
        if (processedRows >= input.rowLimit || input.nowMs() >= input.deadlineMs) break;
        let rowFlags: VerificationFlags;
        try {
          rowFlags = await verifyCurrentRow({ env, row, shard, assignments });
        } catch (error) {
          if (
            error instanceof Error &&
            [
              'lookup_hmac_verification_binding_unavailable',
              'lookup_hmac_verification_core_unavailable',
              'd1_sessions_api_required',
            ].includes(error.message)
          ) {
            throw error;
          }
          rowFlags = {
            currentRowsValid: false,
            reservationsValid: false,
            routeReferencesValid: false,
          };
        }
        flags = andFlags(flags, rowFlags);
        nextCursor = {
          afterRowId: integer(row.verification_rowid, 1, 'lookup_hmac_verification_row_invalid'),
        };
        processedRows += 1;
      }
      const complete = processedRows === rows.length && rows.length < input.rowLimit;
      await control.checkpointLookupHmacRotationVerificationShard({
        ...mutation,
        lookupShardId: shard.lookupShardId,
        cursor: encodedVerificationCursor(nextCursor),
        currentRowCount: shard.currentRowCount + processedRows,
        result: flags,
        complete,
      });
      return { cursor: { operation_id: operation.operationId }, processedRows };
    }
    if (operation.state !== 'reindexing') {
      return { cursor: { operation_id: operation.operationId }, processedRows: 0 };
    }
    if (
      !control.getNextLookupHmacRotationSource ||
      !control.checkpointLookupHmacRotationSource ||
      !control.beginLookupHmacRotationVerification
    ) {
      throw new Error('lookup_hmac_reindex_control_unavailable');
    }
    const source = await control.getNextLookupHmacRotationSource(mutation);
    if (!source) {
      await control.beginLookupHmacRotationVerification(mutation);
      return { cursor: { operation_id: operation.operationId }, processedRows: 0 };
    }
    const sourceCursor = cursor(source.cursor);
    const sourceDatabase = binding(
      env,
      source.bindingRef,
      'lookup_hmac_reindex_source_unavailable'
    );
    const sourceSession = primary(sourceDatabase);
    const rows = await sourceRows(source, sourceSession, sourceCursor, input.rowLimit);
    const runtimeKeys = await loadLookupHmacRuntimeKeys(env, { bypassCache: true });
    const keys = currentAndSourceKeys(operation, runtimeKeys);
    const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
    if (
      !environmentId ||
      !env.TENANT_RUNTIME_REGISTRY ||
      !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
    ) {
      throw new Error('lookup_hmac_reindex_registry_unavailable');
    }
    const assignments = await loadVerifiedLookupBucketAssignmentProvider({
      store: env.TENANT_RUNTIME_REGISTRY,
      environmentId,
      publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
    });
    const resolver = new LookupRouteResolver(
      env as unknown as Record<string, unknown>,
      assignments,
      { memoryCacheTtlMs: 1 }
    );
    const lookupForBucket = await createLookupBucketWriteResolver(env);
    let processedRows = 0;
    let successfulRows = 0;
    let nextCursor = sourceCursor;
    for (const row of rows) {
      if (processedRows >= input.rowLimit || input.nowMs() >= input.deadlineMs) break;
      const raw = rawIdentifier(source.sourceKind, row);
      const publication = await publicationForRow({
        env,
        source,
        row,
        sourceKey: keys.source,
        resolver,
      });
      if (publication.tenantId !== raw.tenantId || publication.accountId !== raw.accountId) {
        throw new Error('lookup_hmac_reindex_publication_mismatch');
      }
      const [sourceIndex, currentIndex] = await Promise.all([
        createLookupBlindIndex(source.sourceKind, raw.value, keys.source),
        createLookupBlindIndex(source.sourceKind, raw.value, keys.current),
      ]);
      await verifySourceReservation({
        lookupForBucket,
        sourceIndex,
        tenantId: raw.tenantId,
        accountId: raw.accountId,
      });
      await upsertCurrentIdentifier({
        lookupForBucket,
        operationId: operation.operationId,
        currentIndex,
        tenantId: raw.tenantId,
        accountId: raw.accountId,
        routeProjection: publication.routeProjection,
        now: Math.floor(input.nowMs() / 1000),
      });
      const authoritative = await sourceStillAuthoritative(source, sourceSession, row);
      if (!authoritative) {
        await disableStaleCurrentIdentifier({
          lookupForBucket,
          operationId: operation.operationId,
          index: currentIndex,
          tenantId: raw.tenantId,
          accountId: raw.accountId,
          now: Math.floor(input.nowMs() / 1000),
        });
      }
      nextCursor = {
        afterCreatedAt: sourceTimestamp(row, source.sourceKind),
        afterId: sourceId(row),
      };
      processedRows += 1;
      if (authoritative) successfulRows += 1;
    }
    const complete = processedRows === rows.length && rows.length < input.rowLimit;
    await control.checkpointLookupHmacRotationSource({
      ...mutation,
      sourceKind: source.sourceKind,
      shardId: source.shardId,
      cursor: encodedCursor(nextCursor),
      sourceRowCount: source.sourceRowCount + successfulRows,
      complete,
    });
    return {
      cursor: { operation_id: operation.operationId },
      processedRows,
    };
  };
}
