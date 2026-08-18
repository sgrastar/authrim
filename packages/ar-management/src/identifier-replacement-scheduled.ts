import {
  createAuditLog,
  ensureDatabaseAdapter,
  produceNotificationDelivery,
  resolveAuthCorePersistenceAdapterFromEnv,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import type { D1Database } from '@cloudflare/workers-types';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import {
  IdentifierReplacementCoordinator,
  isPermanentIdentifierReplacementFailure,
} from './identifier-replacement-coordinator';
import { revokeIdentifierReplacementCredentials } from './identifier-replacement-credential-revocation';
import { processOneScheduledExternalIdentifierUnlink } from './external-identifier-unlink-scheduled';

const LEASE_SECONDS = 120;
const SOURCE_PAGE_SIZE = 100;
const MAX_OPERATIONS = 25;
const WALL_CLOCK_MS = 18_000;

interface SchedulerStateRow {
  after_shard_id: string | null;
  fencing_token: number | string;
}

interface OutboxClaimRow {
  outbox_id: string;
  operation_id: string;
  tenant_id: string;
  account_id: string;
  attempt_count: number | string;
  retry_budget_expires_at: number | string;
}

export interface IdentifierReplacementScheduledLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface IdentifierReplacementScheduledSummary {
  skipped: boolean;
  scannedShards: number;
  processedOperations: number;
  nextShardId: string | null;
}

function d1Binding(env: Env, bindingRef: string): D1Database {
  const binding = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!binding || typeof binding !== 'object') {
    throw new Error('identifier_replacement_source_binding_unavailable');
  }
  const candidate = binding as Partial<D1Database>;
  if (
    typeof candidate.prepare !== 'function' ||
    typeof candidate.batch !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error('identifier_replacement_source_binding_unavailable');
  }
  return binding as D1Database;
}

function strictInteger(value: number | string, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function retryDelaySeconds(operationId: string, attemptCount: number): number {
  let jitter = 0;
  for (let index = 0; index < operationId.length; index += 1) {
    jitter = (jitter * 33 + operationId.charCodeAt(index)) % 31;
  }
  return Math.min(1800, 30 * 2 ** Math.min(6, Math.max(0, attemptCount - 1))) + jitter;
}

async function claimScheduler(
  admin: DatabaseAdapter,
  ownerId: string,
  now: number
): Promise<SchedulerStateRow | null> {
  await admin.execute(
    `INSERT OR IGNORE INTO identifier_replacement_scheduler_state (
       singleton_id, after_shard_id, fencing_token, updated_at
     ) VALUES (1, NULL, 0, ?)`,
    [now]
  );
  const claimed = await admin.execute(
    `UPDATE identifier_replacement_scheduler_state
        SET lease_owner = ?, lease_expires_at = ?, fencing_token = fencing_token + 1,
            last_started_at = ?, last_error_code = NULL, updated_at = ?
      WHERE singleton_id = 1
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    [ownerId, now + LEASE_SECONDS, now, now, now]
  );
  if (claimed.rowsAffected !== 1) return null;
  return admin.queryOne<SchedulerStateRow>(
    `SELECT after_shard_id, fencing_token
       FROM identifier_replacement_scheduler_state
      WHERE singleton_id = 1 AND lease_owner = ?`,
    [ownerId]
  );
}

async function releaseScheduler(
  admin: DatabaseAdapter,
  input: {
    ownerId: string;
    fencingToken: number;
    afterShardId: string | null;
    now: number;
    errorCode?: string;
  }
): Promise<void> {
  const result = await admin.execute(
    `UPDATE identifier_replacement_scheduler_state
        SET after_shard_id = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_completed_at = CASE WHEN ? IS NULL THEN ? ELSE last_completed_at END,
            last_error_code = ?, updated_at = ?
      WHERE singleton_id = 1 AND lease_owner = ? AND fencing_token = ?`,
    [
      input.afterShardId,
      input.errorCode ?? null,
      input.now,
      input.errorCode ?? null,
      input.now,
      input.ownerId,
      input.fencingToken,
    ]
  );
  if (result.rowsAffected !== 1) throw new Error('identifier_replacement_scheduler_stale_lease');
}

async function claimOutbox(
  pii: DatabaseAdapter,
  ownerId: string,
  now: number
): Promise<OutboxClaimRow | null> {
  const candidate = await pii.queryOne<OutboxClaimRow>(
    `SELECT outbox.outbox_id, outbox.operation_id, outbox.tenant_id, outbox.account_id,
            outbox.attempt_count, operation.retry_budget_expires_at
       FROM identity_identifier_replacement_outbox outbox
       JOIN identity_identifier_replacement_operations operation
         ON operation.operation_id = outbox.operation_id
      WHERE (
        (outbox.status IN ('pending', 'retry') AND
         (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= ?))
        OR (outbox.status = 'leased' AND outbox.lease_expires_at IS NOT NULL AND
            outbox.lease_expires_at <= ?)
      ) AND operation.state NOT IN ('completed', 'canceled', 'blocked_forward_repair')
      ORDER BY outbox.created_at, outbox.outbox_id LIMIT 1`,
    [now, now],
    { consistencyClass: 'primary_required' }
  );
  if (!candidate) return null;
  const claimed = await pii.execute(
    `UPDATE identity_identifier_replacement_outbox
        SET status = 'leased', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL,
            error_code = NULL, updated_at = ?
      WHERE outbox_id = ? AND (
        (status IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )`,
    [ownerId, now + LEASE_SECONDS, now, candidate.outbox_id, now, now]
  );
  if (claimed.rowsAffected !== 1) return null;
  return {
    ...candidate,
    attempt_count:
      strictInteger(candidate.attempt_count, 'identifier_replacement_claim_invalid') + 1,
  };
}

async function releaseOutboxFailure(
  pii: DatabaseAdapter,
  claim: OutboxClaimRow,
  ownerId: string,
  now: number,
  error: unknown
): Promise<void> {
  const retryBudgetExpiresAt = strictInteger(
    claim.retry_budget_expires_at,
    'identifier_replacement_claim_invalid'
  );
  const attemptCount = strictInteger(claim.attempt_count, 'identifier_replacement_claim_invalid');
  const permanent = isPermanentIdentifierReplacementFailure(error);
  if (now >= retryBudgetExpiresAt || permanent) {
    const operation = await pii.queryOne<{ state: string }>(
      `SELECT state FROM identity_identifier_replacement_operations WHERE operation_id = ?`,
      [claim.operation_id],
      { consistencyClass: 'primary_required' }
    );
    const state = operation?.state;
    const nextState =
      state === 'directory_pending' || state === 'authoritative_switch_pending'
        ? 'canceled'
        : 'blocked_forward_repair';
    const errorCode = permanent
      ? 'identifier_replacement_permanent_failure'
      : 'identifier_replacement_retry_budget_exhausted';
    await pii.batch([
      {
        sql: `UPDATE identity_identifier_replacement_operations
                 SET state = ?, error_code = ?,
                     updated_at = ?
               WHERE operation_id = ? AND state NOT IN ('completed', 'canceled', 'blocked_forward_repair')`,
        params: [nextState, errorCode, now, claim.operation_id],
      },
      {
        sql: `UPDATE identity_identifier_replacement_outbox
                 SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL,
                     next_attempt_at = NULL,
                     error_code = ?, updated_at = ?
               WHERE outbox_id = ? AND status = 'leased' AND lease_owner = ?`,
        params: [errorCode, now, claim.outbox_id, ownerId],
      },
    ]);
    return;
  }
  await pii.execute(
    `UPDATE identity_identifier_replacement_outbox
        SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, error_code = 'identifier_replacement_retryable', updated_at = ?
      WHERE outbox_id = ? AND status = 'leased' AND lease_owner = ?`,
    [now + retryDelaySeconds(claim.operation_id, attemptCount), now, claim.outbox_id, ownerId]
  );
}

function coordinator(env: Env, pii: DatabaseAdapter): IdentifierReplacementCoordinator {
  let lookupForBucket: Awaited<ReturnType<typeof createLookupBucketWriteResolver>> | null = null;
  return new IdentifierReplacementCoordinator({
    pii,
    lookupForBucket: async (bucket) => {
      lookupForBucket ??= await createLookupBucketWriteResolver(env);
      return lookupForBucket(bucket);
    },
    revokeCredentials: async (input) => {
      const core = await resolveAuthCorePersistenceAdapterFromEnv(
        env,
        'identifier-replacement-scheduled',
        { tenantId: input.tenantId }
      );
      await revokeIdentifierReplacementCredentials({ env, core, ...input });
    },
    enqueueOldIdentifierNotification: async (input) => {
      await produceNotificationDelivery(env, {
        owner: { owner: 'tenant', tenantId: input.tenantId },
        intentId: `identifier-replaced:${input.operationId}`,
        outboxId: `notification:${input.operationId}`,
        notificationKind: 'account.identifier-replaced',
        accountId: input.accountId,
        idempotencyKey: `identifier-replaced:${input.operationId}`,
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        payload: {
          channel: 'email',
          to: input.oldValue,
          from: env.EMAIL_FROM || 'noreply@authrim.dev',
          subject: 'Your account email address was changed',
          body: 'The email address for your account was changed. Contact your administrator if you did not request this change.',
        },
      });
    },
  });
}

async function recordScheduledAccountEmailChange(
  env: Env,
  pii: DatabaseAdapter,
  log: IdentifierReplacementScheduledLogger,
  claim: OutboxClaimRow
): Promise<void> {
  try {
    const operation = await pii.queryOne<{
      authority: string;
      identifier_kind: string;
    }>(
      `SELECT authority, identifier_kind
         FROM identity_identifier_replacement_operations
        WHERE operation_id = ? AND tenant_id = ? AND account_id = ?`,
      [claim.operation_id, claim.tenant_id, claim.account_id],
      { consistencyClass: 'primary_required' }
    );
    if (operation?.authority !== 'self_service' || operation.identifier_kind !== 'email_exact') {
      return;
    }

    await createAuditLog(env, {
      tenantId: claim.tenant_id,
      userId: claim.account_id,
      action: 'account.email.changed',
      resource: 'email',
      resourceId: claim.operation_id,
      ipAddress: 'unknown',
      userAgent: 'identifier-replacement-scheduler',
      metadata: JSON.stringify({ completion_source: 'scheduled_retry' }),
      severity: 'info',
    });
  } catch {
    log.warn('Completed account email change audit could not be recorded', {
      operationId: claim.operation_id,
      errorCode: 'account_email_change_audit_failed',
    });
  }
}

export async function processScheduledIdentifierReplacements(
  env: Env,
  log: IdentifierReplacementScheduledLogger,
  options: { nowMs?: () => number; ownerId?: string } = {}
): Promise<IdentifierReplacementScheduledSummary> {
  if (!env.DB_ADMIN || !env.CONTROL) {
    return { skipped: true, scannedShards: 0, processedOperations: 0, nextShardId: null };
  }
  const nowMs = options.nowMs ?? (() => Date.now());
  const ownerId = options.ownerId ?? `identifier-replacement-${crypto.randomUUID()}`;
  const admin = ensureDatabaseAdapter(env.DB_ADMIN, 'identifier-replacement-scheduler');
  const state = await claimScheduler(admin, ownerId, Math.floor(nowMs() / 1000));
  if (!state) {
    return { skipped: true, scannedShards: 0, processedOperations: 0, nextShardId: null };
  }
  const fencingToken = strictInteger(
    state.fencing_token,
    'identifier_replacement_scheduler_state_invalid'
  );
  let nextShardId = state.after_shard_id;
  let scannedShards = 0;
  let processedOperations = 0;
  const deadline = nowMs() + WALL_CLOCK_MS;
  try {
    const shards = await env.CONTROL.listAccountRouteSourceShards({
      dataRole: 'tenant_pii',
      afterShardId: state.after_shard_id,
      limit: SOURCE_PAGE_SIZE,
    });
    if (shards.length === 0) nextShardId = null;
    for (const shard of shards) {
      if (nowMs() >= deadline || processedOperations >= MAX_OPERATIONS) break;
      if (!shard?.shardId || !shard.bindingRef || shard.dataRole !== 'tenant_pii') {
        throw new Error('identifier_replacement_source_invalid');
      }
      let sourceDrained = false;
      try {
        const pii = ensureDatabaseAdapter(
          d1Binding(env, shard.bindingRef),
          'identifier-replacement-scheduler-source'
        );
        while (nowMs() < deadline && processedOperations < MAX_OPERATIONS) {
          const now = Math.floor(nowMs() / 1000);
          const triedUnlinkFirst = processedOperations % 2 === 0;
          if (
            triedUnlinkFirst &&
            (await processOneScheduledExternalIdentifierUnlink(env, pii, ownerId, now))
          ) {
            processedOperations += 1;
            continue;
          }
          const claim = await claimOutbox(pii, ownerId, now);
          if (!claim) {
            if (
              !triedUnlinkFirst &&
              (await processOneScheduledExternalIdentifierUnlink(env, pii, ownerId, now))
            ) {
              processedOperations += 1;
              continue;
            }
            sourceDrained = true;
            break;
          }
          processedOperations += 1;
          try {
            const result = await coordinator(env, pii).resume({
              operationId: claim.operation_id,
              tenantId: claim.tenant_id,
              accountId: claim.account_id,
            });
            if (result.state === 'completed') {
              await recordScheduledAccountEmailChange(env, pii, log, claim);
            }
          } catch (error) {
            await releaseOutboxFailure(pii, claim, ownerId, Math.floor(nowMs() / 1000), error);
          }
        }
      } catch {
        sourceDrained = true;
        log.warn('Identifier replacement source shard scan failed', {
          shardId: shard.shardId,
          errorCode: 'identifier_replacement_source_scan_failed',
        });
      }
      scannedShards += 1;
      if (sourceDrained) {
        nextShardId = shard.shardId;
      } else {
        break;
      }
    }
    await releaseScheduler(admin, {
      ownerId,
      fencingToken,
      afterShardId: nextShardId,
      now: Math.floor(nowMs() / 1000),
    });
    log.info('Identifier replacement scheduled processing completed', {
      scannedShards,
      processedOperations,
    });
    return { skipped: false, scannedShards, processedOperations, nextShardId };
  } catch (error) {
    await releaseScheduler(admin, {
      ownerId,
      fencingToken,
      afterShardId: state.after_shard_id,
      now: Math.floor(nowMs() / 1000),
      errorCode: 'identifier_replacement_scheduler_failed',
    });
    throw error;
  }
}
