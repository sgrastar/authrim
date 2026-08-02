import type { D1Database } from '@cloudflare/workers-types';
import {
  accountDirectoryRemovalOutboxId,
  createLookupBlindIndexes,
  ensureDatabaseAdapter,
  insertPreparedAccountDirectoryRemovals,
  markAccountDirectoryRemovalReady,
  validateAccountDirectoryPublication,
  validateAccountDirectoryRemovalPublication,
  validateAccountRouteProjection,
  type AccountDirectoryPublication,
  type AccountDirectoryRemovalPublication,
  type AccountRouteProjection,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { AccountDirectoryRemovalCoordinator } from './account-directory-removal';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

const LEASE_SECONDS = 120;
const RETRY_BUDGET_SECONDS = 2 * 60 * 60;

interface UnlinkClaim {
  operation_id: string;
  tenant_id: string;
  account_id: string;
  user_id: string;
  issuer_json: string | null;
  subject_json: string | null;
  issuer_sha256: string;
  subject_sha256: string;
  route_projection_json: string;
  state: 'pending' | 'directory_pending';
  attempt_count: number | string;
  fencing_token: number | string;
  created_at: number | string;
}

function integer(value: number | string, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function d1Binding(env: Env, bindingRef: string): D1Database {
  const value = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!value || typeof value !== 'object') {
    throw new Error('external_identifier_unlink_core_binding_unavailable');
  }
  const binding = value as Partial<D1Database>;
  if (
    typeof binding.prepare !== 'function' ||
    typeof binding.batch !== 'function' ||
    typeof binding.withSession !== 'function'
  ) {
    throw new Error('external_identifier_unlink_core_binding_unavailable');
  }
  return value as D1Database;
}

function rawString(value: string | null, code: string): string {
  if (!value) throw new Error(code);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
  if (typeof parsed !== 'string' || parsed.length < 1 || parsed.length > 4096) {
    throw new Error(code);
  }
  return parsed;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function routeProjection(value: string): AccountRouteProjection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('external_identifier_unlink_route_invalid');
  }
  return validateAccountRouteProjection(parsed as AccountRouteProjection);
}

function retryDelaySeconds(operationId: string, attemptCount: number): number {
  let jitter = 0;
  for (let index = 0; index < operationId.length; index += 1) {
    jitter = (jitter * 33 + operationId.charCodeAt(index)) % 31;
  }
  return Math.min(1800, 30 * 2 ** Math.min(6, Math.max(0, attemptCount - 1))) + jitter;
}

function permanent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /^(external_identifier_unlink_(raw|route|account|operation|core_outbox)_[a-z0-9_]+|invalid_directory_removal_|duplicate_directory_removal_index|directory_removal_(account_state_conflict|reservation_owner_conflict|outbox_payload_mismatch))$/u.test(
    message
  );
}

async function claim(
  pii: DatabaseAdapter,
  ownerId: string,
  now: number
): Promise<UnlinkClaim | null> {
  const candidate = await pii.queryOne<UnlinkClaim>(
    `SELECT operation_id, tenant_id, account_id, user_id, issuer_json, subject_json,
            issuer_sha256, subject_sha256,
            route_projection_json, state, attempt_count, fencing_token, created_at
       FROM external_identifier_unlink_operations
      WHERE state IN ('pending', 'directory_pending') AND (
        (lease_owner IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR
        (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      ) ORDER BY created_at, operation_id LIMIT 1`,
    [now, now],
    { consistencyClass: 'primary_required' }
  );
  if (!candidate) return null;
  const updated = await pii.execute(
    `UPDATE external_identifier_unlink_operations
        SET lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
            fencing_token = fencing_token + 1, next_attempt_at = NULL,
            error_code = NULL, updated_at = ?
      WHERE operation_id = ? AND state IN ('pending', 'directory_pending') AND (
        (lease_owner IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR
        (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )`,
    [ownerId, now + LEASE_SECONDS, now, candidate.operation_id, now, now]
  );
  if (updated.rowsAffected !== 1) return null;
  return {
    ...candidate,
    attempt_count: integer(candidate.attempt_count, 'external_identifier_unlink_claim_invalid') + 1,
    fencing_token: integer(candidate.fencing_token, 'external_identifier_unlink_claim_invalid') + 1,
  };
}

async function authoritativeRoute(
  core: DatabaseAdapter,
  claim: UnlinkClaim,
  projection: AccountRouteProjection
): Promise<void> {
  const row = await core.queryOne<{
    lifecycle_state: string;
    directory_publication_state: string;
    account_route_generation: number | string;
    payload_json: string;
  }>(
    `SELECT account.lifecycle_state, account.directory_publication_state,
            account.account_route_generation, outbox.payload_json
       FROM identity_accounts account
       JOIN account_routing_outbox outbox
         ON outbox.tenant_id = account.tenant_id AND outbox.account_id = account.id
        AND outbox.event_kind = 'account_created'
        AND outbox.route_generation = account.account_route_generation
      WHERE account.tenant_id = ? AND account.id = ? AND outbox.status = 'succeeded'`,
    [claim.tenant_id, claim.account_id],
    { consistencyClass: 'primary_required' }
  );
  if (
    !row ||
    row.lifecycle_state !== 'active' ||
    row.directory_publication_state !== 'active' ||
    Number(row.account_route_generation) !== projection.accountRouteGeneration
  ) {
    throw new Error('external_identifier_unlink_account_state_invalid');
  }
  const publication = await validateAccountDirectoryPublication(
    JSON.parse(row.payload_json) as AccountDirectoryPublication
  );
  if (
    publication.tenantId !== claim.tenant_id ||
    publication.accountId !== claim.account_id ||
    JSON.stringify(publication.routeProjection) !== JSON.stringify(projection)
  ) {
    throw new Error('external_identifier_unlink_route_mismatch');
  }
}

async function prepareCoreOutbox(
  env: Env,
  pii: DatabaseAdapter,
  claim: UnlinkClaim,
  ownerId: string,
  now: number
): Promise<{ publication: AccountDirectoryRemovalPublication; coreD1: D1Database }> {
  const issuer = rawString(claim.issuer_json, 'external_identifier_unlink_raw_invalid');
  const subject = rawString(claim.subject_json, 'external_identifier_unlink_raw_invalid');
  const [issuerDigest, subjectDigest] = await Promise.all([sha256Hex(issuer), sha256Hex(subject)]);
  if (issuerDigest !== claim.issuer_sha256 || subjectDigest !== claim.subject_sha256) {
    throw new Error('external_identifier_unlink_raw_digest_mismatch');
  }
  const projection = routeProjection(claim.route_projection_json);
  const coreTargets = projection.targets.filter(
    (target) => target.dataRole === 'tenant_core/users'
  );
  if (coreTargets.length !== 1) throw new Error('external_identifier_unlink_route_invalid');
  const coreD1 = d1Binding(env, coreTargets[0].bindingRef);
  const core = ensureDatabaseAdapter(coreD1, 'external-identifier-unlink-core');
  await authoritativeRoute(core, claim, projection);
  const publication = await validateAccountDirectoryRemovalPublication({
    operationId: claim.operation_id,
    tenantId: claim.tenant_id,
    accountId: claim.account_id,
    idempotencyKey: claim.operation_id,
    routeProjection: projection,
    scope: 'identifier',
    indexes: await createLookupBlindIndexes(
      'external_subject',
      { issuer, subject },
      (await loadLookupHmacRuntimeKeys(env)).readKeys
    ),
  });
  const outboxId = accountDirectoryRemovalOutboxId(claim.operation_id);
  const existing = await core.queryOne<{ payload_json: string }>(
    `SELECT payload_json FROM account_routing_outbox
      WHERE outbox_id = ? AND tenant_id = ? AND account_id = ?
        AND event_kind = 'identifier_removed'`,
    [outboxId, claim.tenant_id, claim.account_id],
    { consistencyClass: 'primary_required' }
  );
  if (existing) {
    const reflected = await validateAccountDirectoryRemovalPublication(
      JSON.parse(existing.payload_json) as AccountDirectoryRemovalPublication
    );
    if (JSON.stringify(reflected) !== JSON.stringify(publication)) {
      throw new Error('external_identifier_unlink_core_outbox_conflict');
    }
  } else {
    await insertPreparedAccountDirectoryRemovals(core, [publication], now);
  }
  const stateChanged = await pii.execute(
    `UPDATE external_identifier_unlink_operations
        SET state = 'directory_pending', updated_at = ?
      WHERE operation_id = ? AND lease_owner = ? AND fencing_token = ?
        AND state IN ('pending', 'directory_pending')`,
    [
      now,
      claim.operation_id,
      ownerId,
      integer(claim.fencing_token, 'external_identifier_unlink_claim_invalid'),
    ]
  );
  if (stateChanged.rowsAffected !== 1) throw new Error('external_identifier_unlink_stale_lease');
  await markAccountDirectoryRemovalReady(core, publication.operationId, now);
  return { publication, coreD1 };
}

async function complete(
  pii: DatabaseAdapter,
  claim: UnlinkClaim,
  ownerId: string,
  now: number
): Promise<void> {
  const result = await pii.execute(
    `UPDATE external_identifier_unlink_operations
        SET state = 'completed', issuer_json = NULL, subject_json = NULL,
            raw_values_erased_at = ?, completed_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, next_attempt_at = NULL, error_code = NULL, updated_at = ?
      WHERE operation_id = ? AND state = 'directory_pending' AND lease_owner = ?
        AND fencing_token = ?`,
    [
      now,
      now,
      now,
      claim.operation_id,
      ownerId,
      integer(claim.fencing_token, 'external_identifier_unlink_claim_invalid'),
    ]
  );
  if (result.rowsAffected !== 1) throw new Error('external_identifier_unlink_stale_lease');
}

async function fail(
  pii: DatabaseAdapter,
  claim: UnlinkClaim,
  ownerId: string,
  now: number,
  error: unknown
): Promise<void> {
  const attemptCount = integer(claim.attempt_count, 'external_identifier_unlink_claim_invalid');
  const blocked =
    permanent(error) ||
    now - integer(claim.created_at, 'external_identifier_unlink_claim_invalid') >=
      RETRY_BUDGET_SECONDS;
  const result = await pii.execute(
    `UPDATE external_identifier_unlink_operations
        SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, error_code = ?, updated_at = ?
      WHERE operation_id = ? AND lease_owner = ? AND fencing_token = ?
        AND state IN ('pending', 'directory_pending')`,
    [
      blocked ? 'blocked' : claim.state,
      blocked ? null : now + retryDelaySeconds(claim.operation_id, attemptCount),
      blocked ? 'external_identifier_unlink_blocked' : 'external_identifier_unlink_retryable',
      now,
      claim.operation_id,
      ownerId,
      integer(claim.fencing_token, 'external_identifier_unlink_claim_invalid'),
    ]
  );
  if (result.rowsAffected !== 1) throw new Error('external_identifier_unlink_stale_lease');
}

export async function processOneScheduledExternalIdentifierUnlink(
  env: Env,
  pii: DatabaseAdapter,
  ownerId: string,
  now: number
): Promise<boolean> {
  const unlink = await claim(pii, ownerId, now);
  if (!unlink) return false;
  try {
    const prepared = await prepareCoreOutbox(env, pii, unlink, ownerId, now);
    let lookupForBucket: Awaited<ReturnType<typeof createLookupBucketWriteResolver>> | null = null;
    await new AccountDirectoryRemovalCoordinator({
      tenantCore: prepared.coreD1,
      lookupForBucket: async (bucket) => {
        lookupForBucket ??= await createLookupBucketWriteResolver(env);
        return lookupForBucket(bucket);
      },
      now: () => now,
    }).remove(prepared.publication);
    await complete(pii, unlink, ownerId, now);
  } catch (error) {
    await fail(pii, unlink, ownerId, now, error);
  }
  return true;
}
