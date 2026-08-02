import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  createD1ConsistencyRequest,
  createLookupBlindIndexes,
  loadVerifiedLookupBucketAssignmentProvider,
  LookupDirectoryRepository,
  mergeRotatingLookupMemberships,
  validateAccountDirectoryPublication,
  validateAccountRouteProjection,
  type AccountDirectoryPublication,
  type AccountRouteProjection,
  type ControlTenantDisasterRecoveryLookupStage,
  type ControlTenantDisasterRecoveryLookupWork,
  type ControlTenantDisasterRecoveryTarget,
  type Env,
  type LookupBlindIndex,
  type LookupShardRegistryRange,
  type ResolvedLookupMembership,
} from '@authrim/ar-lib-core';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const PAGE_SIZE = 25;
const DEADLINE_MS = 20_000;

interface SourceCursorRow {
  id: string;
  created_at: number | string;
}

interface AccountSourceRow extends SourceCursorRow {
  tenant_id: string;
  account_route_generation: number | string;
  payload_json: string;
}

interface EmailSourceRow extends SourceCursorRow {
  tenant_id: string;
  owner_id: string;
  value_json: string;
}

interface ExternalSourceRow extends SourceCursorRow {
  tenant_id: string;
  user_id: string;
  provider_id: string;
  provider_user_id: string;
}

interface LookupVerificationRow {
  row_id: number | string;
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

function integer(value: unknown, minimum: number, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code);
  return parsed;
}

function id(value: unknown, code: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function binding(env: Env, bindingRef: string, code: string): D1Database {
  if (!SAFE_BINDING.test(bindingRef)) throw new Error(code);
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalRanges(ranges: LookupShardRegistryRange[]): LookupShardRegistryRange[] {
  if (ranges.length < 1 || ranges.length > 4096) {
    throw new Error('tenant_dr_lookup_ranges_invalid');
  }
  let nextBucket = 0;
  return ranges.map((range, index) => {
    if (
      range.startBucket !== nextBucket ||
      !Number.isSafeInteger(range.endBucket) ||
      range.endBucket < range.startBucket ||
      range.endBucket > 4095 ||
      !SAFE_ID.test(range.lookupShardId) ||
      !SAFE_BINDING.test(range.bindingRef) ||
      !Number.isSafeInteger(range.assignmentGeneration) ||
      range.assignmentGeneration < 1
    ) {
      throw new Error('tenant_dr_lookup_ranges_invalid');
    }
    nextBucket = range.endBucket + 1;
    if (index === ranges.length - 1 && range.endBucket !== 4095) {
      throw new Error('tenant_dr_lookup_ranges_invalid');
    }
    return { ...range };
  });
}

function lookupShards(ranges: LookupShardRegistryRange[]) {
  const shards = new Map<string, { lookupShardId: string; bindingRef: string }>();
  for (const range of ranges) {
    const existing = shards.get(range.lookupShardId);
    if (existing && existing.bindingRef !== range.bindingRef) {
      throw new Error('tenant_dr_lookup_shard_binding_conflict');
    }
    shards.set(range.lookupShardId, {
      lookupShardId: range.lookupShardId,
      bindingRef: range.bindingRef,
    });
  }
  return [...shards.values()].sort((left, right) =>
    left.lookupShardId.localeCompare(right.lookupShardId)
  );
}

function exactPinnedRoute(
  work: ControlTenantDisasterRecoveryLookupWork,
  route: AccountRouteProjection,
  source: ControlTenantDisasterRecoveryTarget
): void {
  if (route.targets.length < 2 || route.targets.length > work.targets.length) {
    throw new Error('tenant_dr_lookup_route_mismatch');
  }
  const pinned = new Map(
    work.targets.map((target) => [
      `${target.dataRole}\0${target.residencyPartition}\0${target.shardId}`,
      target,
    ])
  );
  for (const target of route.targets) {
    const expected = pinned.get(
      `${target.dataRole}\0${target.residencyPartition}\0${target.shardId}`
    );
    if (
      !expected ||
      expected.bindingRef !== target.bindingRef ||
      expected.shardGeneration !== target.requiredBindingRouteGeneration
    ) {
      throw new Error('tenant_dr_lookup_route_mismatch');
    }
  }
  const sourceTarget = route.targets.filter(
    (target) =>
      target.dataRole === source.dataRole &&
      target.residencyPartition === source.residencyPartition &&
      target.shardId === source.shardId &&
      target.bindingRef === source.bindingRef
  );
  if (sourceTarget.length !== 1) throw new Error('tenant_dr_lookup_source_route_mismatch');
}

async function accountPublication(
  work: ControlTenantDisasterRecoveryLookupWork,
  source: ControlTenantDisasterRecoveryTarget,
  row: AccountSourceRow
): Promise<AccountDirectoryPublication> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new Error('tenant_dr_lookup_publication_invalid');
  }
  const publication = await validateAccountDirectoryPublication(
    parsed as AccountDirectoryPublication
  );
  if (
    publication.tenantId !== work.tenantId ||
    row.tenant_id !== work.tenantId ||
    publication.accountId !== row.id ||
    publication.routeProjection.accountRouteGeneration !==
      integer(row.account_route_generation, 1, 'tenant_dr_lookup_route_mismatch')
  ) {
    throw new Error('tenant_dr_lookup_publication_mismatch');
  }
  exactPinnedRoute(work, publication.routeProjection, source);
  return publication;
}

async function resolveAccountMembership(
  env: Env,
  work: ControlTenantDisasterRecoveryLookupWork,
  accountId: string,
  keys: Awaited<ReturnType<typeof loadLookupHmacRuntimeKeys>>,
  lookupForBucket: (virtualBucket: number) => Promise<D1Database>
): Promise<ResolvedLookupMembership> {
  const indexes = await createLookupBlindIndexes('account_id', accountId, keys.writeKeys);
  const resultSets = await Promise.all(
    indexes.map(
      async (index) =>
        (
          await new LookupDirectoryRepository(
            await lookupForBucket(index.virtualBucket)
          ).findActiveMemberships(index, createD1ConsistencyRequest('primary_required'))
        ).memberships
    )
  );
  const memberships = mergeRotatingLookupMemberships(resultSets).filter(
    (membership) => membership.tenantId === work.tenantId && membership.accountId === accountId
  );
  if (memberships.length !== 1) throw new Error('tenant_dr_lookup_account_route_missing');
  return memberships[0]!;
}

async function upsertIdentifier(input: {
  lookupForBucket: (virtualBucket: number) => Promise<D1Database>;
  operationId: string;
  index: LookupBlindIndex;
  tenantId: string;
  accountId: string;
  route: AccountRouteProjection;
  now: number;
}): Promise<boolean> {
  const session = primary(await input.lookupForBucket(input.index.virtualBucket));
  const existing = await session
    .prepare(
      `SELECT route_projection_json, lifecycle_state FROM lookup_identifiers
        WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
          AND hmac_key_generation = ? AND identifier_blind_digest = ?
          AND tenant_id = ? AND account_id = ?`
    )
    .bind(
      input.index.virtualBucket,
      input.index.indexKind,
      input.index.normalizationVersion,
      input.index.hmacKeyGeneration,
      input.index.digest,
      input.tenantId,
      input.accountId
    )
    .first<{ route_projection_json: string; lifecycle_state: string }>();
  const routeJson = JSON.stringify(input.route);
  if (existing) {
    if (existing.route_projection_json !== routeJson || existing.lifecycle_state !== 'active') {
      throw new Error('tenant_dr_lookup_existing_row_conflict');
    }
    return false;
  }
  if (input.index.indexKind !== 'account_id') {
    await session
      .prepare(
        `INSERT INTO lookup_identifier_reservations (
           virtual_bucket, tenant_id, index_kind, normalization_version,
           hmac_key_generation, identifier_blind_digest, account_id,
           reservation_state, operation_id, committed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?)
         ON CONFLICT (
           virtual_bucket, tenant_id, index_kind, normalization_version,
           hmac_key_generation, identifier_blind_digest
         ) DO NOTHING`
      )
      .bind(
        input.index.virtualBucket,
        input.tenantId,
        input.index.indexKind,
        input.index.normalizationVersion,
        input.index.hmacKeyGeneration,
        input.index.digest,
        input.accountId,
        `tenant-dr:${input.operationId}`,
        input.now,
        input.now,
        input.now
      )
      .run();
    const reservation = await session
      .prepare(
        `SELECT account_id, operation_id, reservation_state
           FROM lookup_identifier_reservations
          WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
            AND normalization_version = ? AND hmac_key_generation = ?
            AND identifier_blind_digest = ?`
      )
      .bind(
        input.index.virtualBucket,
        input.tenantId,
        input.index.indexKind,
        input.index.normalizationVersion,
        input.index.hmacKeyGeneration,
        input.index.digest
      )
      .first<{ account_id: string; operation_id: string; reservation_state: string }>();
    if (
      reservation?.account_id !== input.accountId ||
      reservation.operation_id !== `tenant-dr:${input.operationId}` ||
      reservation.reservation_state !== 'committed'
    ) {
      throw new Error('tenant_dr_lookup_reservation_conflict');
    }
  }
  await session
    .prepare(
      `INSERT INTO lookup_identifiers (
         virtual_bucket, index_kind, normalization_version, hmac_key_generation,
         identifier_blind_digest, tenant_id, account_id, route_schema_version,
         account_route_generation, required_binding_route_generation, residency_policy_id,
         route_projection_json, tenant_lifecycle_state, runtime_route_status,
         lifecycle_state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'active', 'active', ?, ?)`
    )
    .bind(
      input.index.virtualBucket,
      input.index.indexKind,
      input.index.normalizationVersion,
      input.index.hmacKeyGeneration,
      input.index.digest,
      input.tenantId,
      input.accountId,
      input.route.schemaVersion,
      input.route.accountRouteGeneration,
      Math.max(...input.route.targets.map((target) => target.requiredBindingRouteGeneration)),
      input.route.residencyPolicyId,
      routeJson,
      input.now,
      input.now
    )
    .run();
  const reflected = await session
    .prepare(
      `SELECT route_projection_json, lifecycle_state FROM lookup_identifiers
        WHERE virtual_bucket = ? AND index_kind = ? AND normalization_version = ?
          AND hmac_key_generation = ? AND identifier_blind_digest = ?
          AND tenant_id = ? AND account_id = ?`
    )
    .bind(
      input.index.virtualBucket,
      input.index.indexKind,
      input.index.normalizationVersion,
      input.index.hmacKeyGeneration,
      input.index.digest,
      input.tenantId,
      input.accountId
    )
    .first<{ route_projection_json: string; lifecycle_state: string }>();
  if (reflected?.route_projection_json !== routeJson || reflected.lifecycle_state !== 'active') {
    throw new Error('tenant_dr_lookup_reflection_failed');
  }
  return true;
}

function sourceTargets(
  work: ControlTenantDisasterRecoveryLookupWork,
  stage: Exclude<ControlTenantDisasterRecoveryLookupStage, 'cleanup' | 'verify'>
) {
  const role =
    stage === 'email_exact' || stage === 'external_pii' ? 'tenant_pii' : 'tenant_core/users';
  return work.targets.filter((target) => target.dataRole === role);
}

function nextStage(stage: Exclude<ControlTenantDisasterRecoveryLookupStage, 'cleanup' | 'verify'>) {
  const transitions = {
    account_id: 'email_exact',
    email_exact: 'external_core',
    external_core: 'external_pii',
    external_pii: 'verify',
  } as const;
  return transitions[stage];
}

function sourceSql(stage: Exclude<ControlTenantDisasterRecoveryLookupStage, 'cleanup' | 'verify'>) {
  if (stage === 'account_id') {
    return `SELECT account.id, account.tenant_id, account.created_at,
                   account.account_route_generation, outbox.payload_json
              FROM identity_accounts account
              JOIN account_routing_outbox outbox
                ON outbox.tenant_id = account.tenant_id
               AND outbox.account_id = account.id
               AND outbox.event_kind = 'account_created'
               AND outbox.route_generation = account.account_route_generation
             WHERE account.tenant_id = ? AND account.lifecycle_state = 'active'
               AND account.directory_publication_state = 'active'
               AND outbox.status = 'succeeded'
               AND (account.created_at > ? OR (account.created_at = ? AND account.id > ?))
             ORDER BY account.created_at, account.id LIMIT ?`;
  }
  if (stage === 'email_exact') {
    return `SELECT id, tenant_id, owner_id, value_json, created_at
              FROM identity_sensitive_values
             WHERE tenant_id = ? AND owner_type = 'runtime_user' AND value_key = 'email'
               AND lifecycle_state = 'active'
               AND (created_at > ? OR (created_at = ? AND id > ?))
             ORDER BY created_at, id LIMIT ?`;
  }
  if (stage === 'external_core') {
    return `SELECT id, tenant_id, user_id, provider_id, provider_user_id, created_at
              FROM (
                SELECT 'passkey:' || id AS id, tenant_id, user_id,
                       'urn:authrim:passkey:' || lower(rp_id) AS provider_id,
                       credential_id AS provider_user_id, created_at
                  FROM passkeys WHERE rp_id IS NOT NULL AND rp_id <> ''
                UNION ALL
                SELECT 'anonymous:' || id AS id, tenant_id, user_id,
                       'urn:authrim:anonymous-device:v1' AS provider_id,
                       device_id_hash AS provider_user_id, created_at
                  FROM anonymous_devices WHERE is_active = 1
              ) authority
             WHERE tenant_id = ?
               AND (created_at > ? OR (created_at = ? AND id > ?))
             ORDER BY created_at, id LIMIT ?`;
  }
  return `SELECT 'linked:' || id AS id, tenant_id, user_id, provider_id,
                 provider_user_id, linked_at AS created_at
            FROM linked_identities
           WHERE tenant_id = ?
             AND (linked_at > ? OR (linked_at = ? AND 'linked:' || id > ?))
           ORDER BY linked_at, 'linked:' || id LIMIT ?`;
}

async function cleanupPage(
  env: Env,
  work: ControlTenantDisasterRecoveryLookupWork,
  shards: ReturnType<typeof lookupShards>
) {
  const index = work.progress.targetIndex;
  if (index >= shards.length) {
    return checkpoint(env, work, {
      nextStage: 'account_id',
      targetIndex: 0,
      afterCreatedAt: 0,
      afterId: '',
      afterRowId: 0,
    });
  }
  const shard = shards[index]!;
  const session = primary(binding(env, shard.bindingRef, 'tenant_dr_lookup_binding_unavailable'));
  await session.batch([
    session
      .prepare(`DELETE FROM lookup_identifier_replacements WHERE tenant_id = ?`)
      .bind(work.tenantId),
    session.prepare(`DELETE FROM lookup_identifiers WHERE tenant_id = ?`).bind(work.tenantId),
    session
      .prepare(`DELETE FROM lookup_identifier_reservations WHERE tenant_id = ?`)
      .bind(work.tenantId),
  ]);
  const remaining = await session
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM lookup_identifier_replacements WHERE tenant_id = ?) AS replacements,
         (SELECT COUNT(*) FROM lookup_identifiers WHERE tenant_id = ?) AS identifiers,
         (SELECT COUNT(*) FROM lookup_identifier_reservations WHERE tenant_id = ?) AS reservations`
    )
    .bind(work.tenantId, work.tenantId, work.tenantId)
    .first<{
      replacements: number | string;
      identifiers: number | string;
      reservations: number | string;
    }>();
  if (
    !remaining ||
    Number(remaining.replacements) !== 0 ||
    Number(remaining.identifiers) !== 0 ||
    Number(remaining.reservations) !== 0
  ) {
    throw new Error('tenant_dr_lookup_cleanup_not_reflected');
  }
  return checkpoint(env, work, {
    nextStage: 'cleanup',
    targetIndex: index + 1,
    afterCreatedAt: 0,
    afterId: '',
    afterRowId: 0,
  });
}

async function sourcePage(
  env: Env,
  work: ControlTenantDisasterRecoveryLookupWork,
  stage: Exclude<ControlTenantDisasterRecoveryLookupStage, 'cleanup' | 'verify'>,
  startedAt: number
) {
  const targets = sourceTargets(work, stage);
  const index = work.progress.targetIndex;
  if (index >= targets.length) {
    return checkpoint(env, work, {
      nextStage: nextStage(stage),
      targetIndex: 0,
      afterCreatedAt: 0,
      afterId: '',
      afterRowId: 0,
    });
  }
  const source = targets[index]!;
  const session = primary(binding(env, source.bindingRef, 'tenant_dr_lookup_source_unavailable'));
  const rows = await session
    .prepare(sourceSql(stage))
    .bind(
      work.tenantId,
      work.progress.afterCreatedAt,
      work.progress.afterCreatedAt,
      work.progress.afterId,
      PAGE_SIZE
    )
    .all<AccountSourceRow | EmailSourceRow | ExternalSourceRow>();
  if (rows.results.length === 0) {
    return checkpoint(env, work, {
      nextStage: stage,
      targetIndex: index + 1,
      afterCreatedAt: 0,
      afterId: '',
      afterRowId: 0,
    });
  }
  const keys = await loadLookupHmacRuntimeKeys(env, { bypassCache: true });
  const lookupForBucket = await createLookupBucketWriteResolver(env);
  let projectedRowsDelta = 0;
  let afterCreatedAt = work.progress.afterCreatedAt;
  let afterId = work.progress.afterId;
  for (const candidate of rows.results) {
    if (Date.now() - startedAt >= DEADLINE_MS) break;
    const createdAt = integer(candidate.created_at, 1, 'tenant_dr_lookup_source_row_invalid');
    const rowId = id(candidate.id, 'tenant_dr_lookup_source_row_invalid');
    let accountId: string;
    let route: AccountRouteProjection;
    let identifierValue: string | { issuer: string; subject: string };
    if (stage === 'account_id') {
      const account = candidate as AccountSourceRow;
      const publication = await accountPublication(work, source, account);
      accountId = publication.accountId;
      route = publication.routeProjection;
      identifierValue = accountId;
    } else {
      const value = candidate as EmailSourceRow | ExternalSourceRow;
      accountId = `account:${id(
        stage === 'email_exact'
          ? (value as EmailSourceRow).owner_id
          : (value as ExternalSourceRow).user_id,
        'tenant_dr_lookup_source_account_invalid'
      )}`;
      const membership = await resolveAccountMembership(
        env,
        work,
        accountId,
        keys,
        lookupForBucket
      );
      route = membership.routeProjection;
      exactPinnedRoute(work, route, source);
      if (stage === 'email_exact') {
        let raw: unknown;
        try {
          raw = JSON.parse((value as EmailSourceRow).value_json) as unknown;
        } catch {
          throw new Error('tenant_dr_lookup_email_invalid');
        }
        if (typeof raw !== 'string') throw new Error('tenant_dr_lookup_email_invalid');
        identifierValue = raw;
      } else {
        const external = value as ExternalSourceRow;
        identifierValue = {
          issuer: external.provider_id,
          subject: external.provider_user_id,
        };
      }
    }
    const indexKind =
      stage === 'account_id'
        ? 'account_id'
        : stage === 'email_exact'
          ? 'email_exact'
          : 'external_subject';
    const indexes = await createLookupBlindIndexes(indexKind, identifierValue, keys.writeKeys);
    for (const lookupIndex of indexes) {
      if (
        await upsertIdentifier({
          lookupForBucket,
          operationId: work.operationId,
          index: lookupIndex,
          tenantId: work.tenantId,
          accountId,
          route,
          now: Math.floor(Date.now() / 1000),
        })
      ) {
        projectedRowsDelta += 1;
      }
    }
    afterCreatedAt = createdAt;
    afterId = rowId;
  }
  return checkpoint(env, work, {
    nextStage: stage,
    targetIndex: index,
    afterCreatedAt,
    afterId,
    afterRowId: 0,
    projectedRowsDelta,
  });
}

function validateVerificationRow(
  work: ControlTenantDisasterRecoveryLookupWork,
  row: LookupVerificationRow
): AccountRouteProjection {
  const rowId = integer(row.row_id, 1, 'tenant_dr_lookup_verification_row_invalid');
  void rowId;
  if (
    row.tenant_id !== work.tenantId ||
    !/^[a-f0-9]{64}$/u.test(row.identifier_blind_digest) ||
    integer(row.virtual_bucket, 0, 'tenant_dr_lookup_verification_row_invalid') > 4095 ||
    integer(row.normalization_version, 1, 'tenant_dr_lookup_verification_row_invalid') < 1 ||
    integer(row.hmac_key_generation, 1, 'tenant_dr_lookup_verification_row_invalid') < 1 ||
    row.tenant_lifecycle_state !== 'active' ||
    row.runtime_route_status !== 'active' ||
    row.lifecycle_state !== 'active'
  ) {
    throw new Error('tenant_dr_lookup_verification_failed');
  }
  let route: AccountRouteProjection;
  try {
    route = validateAccountRouteProjection(
      JSON.parse(row.route_projection_json) as AccountRouteProjection
    );
  } catch {
    throw new Error('tenant_dr_lookup_verification_failed');
  }
  if (
    route.schemaVersion !==
      integer(row.route_schema_version, 1, 'tenant_dr_lookup_verification_failed') ||
    route.accountRouteGeneration !==
      integer(row.account_route_generation, 1, 'tenant_dr_lookup_verification_failed') ||
    route.residencyPolicyId !== row.residency_policy_id ||
    Math.max(...route.targets.map((target) => target.requiredBindingRouteGeneration)) !==
      integer(row.required_binding_route_generation, 1, 'tenant_dr_lookup_verification_failed')
  ) {
    throw new Error('tenant_dr_lookup_verification_failed');
  }
  const source = work.targets.find((target) =>
    route.targets.some((candidate) => candidate.shardId === target.shardId)
  );
  if (!source) throw new Error('tenant_dr_lookup_verification_failed');
  exactPinnedRoute(work, route, source);
  return route;
}

async function verifyPage(
  env: Env,
  work: ControlTenantDisasterRecoveryLookupWork,
  shards: ReturnType<typeof lookupShards>
) {
  const index = work.progress.targetIndex;
  if (index >= shards.length) {
    if (
      !env.CONTROL?.completeTenantDisasterRecoveryLookupReprojection ||
      work.progress.projectedRows !== work.progress.verifiedRows
    ) {
      throw new Error('tenant_dr_lookup_completion_invalid');
    }
    return env.CONTROL.completeTenantDisasterRecoveryLookupReprojection({
      operationId: work.operationId,
      ownerId: work.ownerId,
      fencingToken: work.fencingToken,
      registryDigest: work.registryDigest,
    });
  }
  const shard = shards[index]!;
  const session = primary(binding(env, shard.bindingRef, 'tenant_dr_lookup_binding_unavailable'));
  const rows = await session
    .prepare(
      `SELECT rowid AS row_id, virtual_bucket, index_kind, normalization_version,
              hmac_key_generation, identifier_blind_digest, tenant_id, account_id,
              route_schema_version, account_route_generation,
              required_binding_route_generation, residency_policy_id,
              route_projection_json, tenant_lifecycle_state, runtime_route_status,
              lifecycle_state
         FROM lookup_identifiers
        WHERE tenant_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`
    )
    .bind(work.tenantId, work.progress.afterRowId, PAGE_SIZE)
    .all<LookupVerificationRow>();
  if (rows.results.length === 0) {
    return checkpoint(env, work, {
      nextStage: 'verify',
      targetIndex: index + 1,
      afterCreatedAt: 0,
      afterId: '',
      afterRowId: 0,
    });
  }
  let afterRowId = work.progress.afterRowId;
  for (const row of rows.results) {
    validateVerificationRow(work, row);
    if (row.index_kind !== 'account_id') {
      const reservation = await session
        .prepare(
          `SELECT account_id, operation_id, reservation_state
             FROM lookup_identifier_reservations
            WHERE virtual_bucket = ? AND tenant_id = ? AND index_kind = ?
              AND normalization_version = ? AND hmac_key_generation = ?
              AND identifier_blind_digest = ?`
        )
        .bind(
          row.virtual_bucket,
          work.tenantId,
          row.index_kind,
          row.normalization_version,
          row.hmac_key_generation,
          row.identifier_blind_digest
        )
        .first<{ account_id: string; operation_id: string; reservation_state: string }>();
      if (
        reservation?.account_id !== row.account_id ||
        reservation.operation_id !== `tenant-dr:${work.operationId}` ||
        reservation.reservation_state !== 'committed'
      ) {
        throw new Error('tenant_dr_lookup_verification_failed');
      }
    }
    afterRowId = integer(row.row_id, 1, 'tenant_dr_lookup_verification_row_invalid');
  }
  return checkpoint(env, work, {
    nextStage: 'verify',
    targetIndex: index,
    afterCreatedAt: 0,
    afterId: '',
    afterRowId,
    verifiedRowsDelta: rows.results.length,
  });
}

async function checkpoint(
  env: Env,
  work: ControlTenantDisasterRecoveryLookupWork,
  input: {
    nextStage: ControlTenantDisasterRecoveryLookupStage;
    targetIndex: number;
    afterCreatedAt: number;
    afterId: string;
    afterRowId: number;
    projectedRowsDelta?: number;
    verifiedRowsDelta?: number;
  }
) {
  if (!env.CONTROL?.checkpointTenantDisasterRecoveryLookupReprojection) {
    throw new Error('tenant_dr_lookup_control_unavailable');
  }
  return env.CONTROL.checkpointTenantDisasterRecoveryLookupReprojection({
    operationId: work.operationId,
    ownerId: work.ownerId,
    fencingToken: work.fencingToken,
    registryDigest: work.registryDigest,
    lookupShardCount: work.lookupShardCount,
    stage: work.progress.stage,
    nextStage: input.nextStage,
    targetIndex: input.targetIndex,
    afterCreatedAt: input.afterCreatedAt,
    afterId: input.afterId,
    afterRowId: input.afterRowId,
    projectedRowsDelta: input.projectedRowsDelta ?? 0,
    verifiedRowsDelta: input.verifiedRowsDelta ?? 0,
  });
}

export async function processTenantDisasterRecoveryLookupReprojection(
  env: Env
): Promise<{ processed: boolean; operationId: string | null; stage: string | null }> {
  if (
    !env.CONTROL?.claimNextTenantDisasterRecoveryLookupReprojection ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS ||
    !env.AUTHRIM_ENVIRONMENT_NAME
  ) {
    return { processed: false, operationId: null, stage: null };
  }
  const assignments = await loadVerifiedLookupBucketAssignmentProvider({
    store: env.TENANT_RUNTIME_REGISTRY,
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
    publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
  });
  const ranges = canonicalRanges(assignments.listActiveRanges());
  const shards = lookupShards(ranges);
  const registryDigest = await sha256(JSON.stringify(ranges));
  const ownerId = `tenant-dr-lookup:${crypto.randomUUID()}`;
  const work = await env.CONTROL.claimNextTenantDisasterRecoveryLookupReprojection({
    ownerId,
    registryDigest,
    lookupShardCount: shards.length,
  });
  if (!work) return { processed: false, operationId: null, stage: null };
  if (
    work.registryDigest !== registryDigest ||
    work.lookupShardCount !== shards.length ||
    work.environmentId !== env.AUTHRIM_ENVIRONMENT_NAME
  ) {
    throw new Error('tenant_dr_lookup_claim_mismatch');
  }
  const startedAt = Date.now();
  if (work.progress.stage === 'cleanup') {
    await cleanupPage(env, work, shards);
  } else if (work.progress.stage === 'verify') {
    await verifyPage(env, work, shards);
  } else {
    await sourcePage(env, work, work.progress.stage, startedAt);
  }
  return { processed: true, operationId: work.operationId, stage: work.progress.stage };
}
