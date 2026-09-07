import {
  createEventDispatcherFromEnv,
  ensureDatabaseAdapter,
  isCanonicalAccountIdForUser,
  resolveAuthCorePersistenceAdapterFromEnv,
  validateAccountDirectoryPublication,
  validateAccountDirectoryRemovalPublication,
  type AccountDirectoryPublication,
  type AccountDirectoryRemovalPublication,
  type DatabaseAdapter,
  type Env,
  type PreparedStatement,
  USER_EVENTS,
} from '@authrim/ar-lib-core';
import { LOOKUP_VIRTUAL_BUCKET_COUNT } from '@authrim/ar-lib-core/services/lookup-directory/contract';
import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import { AccountDirectoryCoordinator } from './account-directory-coordinator';
import { activatePublishedAccountAuthenticationState } from './account-authentication-activation';
import { AccountDirectoryRemovalCoordinator } from './account-directory-removal';
import { AccountCreationOperationRepository } from './account-creation-operation';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import { createLookupHmacReindexProcessor } from './lookup-hmac-reindex';

export const DIRECTORY_SCHEDULED_CRON = '*/2 * * * *';

const DIRECTORY_INVOCATION_WALL_CLOCK_MS = 20_000;
const DIRECTORY_LEASE_SECONDS = 120;

export const DIRECTORY_JOB_CLASSES = [
  'routing_outbox',
  'hmac_reindex',
  'bucket_counter_reconciliation',
] as const;

export type DirectoryJobClass = (typeof DIRECTORY_JOB_CLASSES)[number];

interface DirectoryJobCursorRow {
  job_class: DirectoryJobClass;
  owner_id: string | null;
  fencing_token: number | string;
  lease_expires_at: number | string | null;
  cursor_json: string;
  budget_remaining: number | string;
}

export interface DirectoryJobProcessorInput {
  adapter: DatabaseAdapter;
  jobClass: DirectoryJobClass;
  cursor: Record<string, unknown>;
  rowLimit: number;
  deadlineMs: number;
  ownerId: string;
  fencingToken: number;
  nowMs: () => number;
}

export interface DirectoryJobProcessorResult {
  cursor: Record<string, unknown>;
  processedRows: number;
}

export type DirectoryJobProcessor = (
  input: DirectoryJobProcessorInput
) => Promise<DirectoryJobProcessorResult>;

export type DirectoryJobProcessors = Partial<Record<DirectoryJobClass, DirectoryJobProcessor>>;

export interface DirectoryScheduledLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>, error?: Error): void;
}

export interface DirectoryScheduledSummary {
  skipped: boolean;
  processedRows: number;
  classes: Array<{
    jobClass: DirectoryJobClass;
    status: 'completed' | 'lease_unavailable' | 'failed' | 'budget_exhausted';
    processedRows: number;
    errorCode?: string;
  }>;
}

interface DirectoryJobPolicy {
  rowLimit: number;
  wallClockMs: number;
}

const DIRECTORY_JOB_POLICIES: Readonly<Record<DirectoryJobClass, DirectoryJobPolicy>> = {
  routing_outbox: { rowLimit: 100, wallClockMs: 7_000 },
  hmac_reindex: { rowLimit: 50, wallClockMs: 6_000 },
  bucket_counter_reconciliation: { rowLimit: 32, wallClockMs: 4_000 },
};

function safeInteger(value: number | string | null, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function safeDirectoryJobErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    (/^lookup_hmac_[a-z0-9_]{1,100}$/u.test(error.message) ||
      error.message === 'd1_sessions_api_required')
  ) {
    return error.message;
  }
  return 'directory_job_failed';
}

function strictNonNegativeInteger(value: unknown, errorCode: string): number {
  if (
    (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  ) {
    throw new Error(errorCode);
  }
  return Number(value);
}

function initialCursor(jobClass: DirectoryJobClass): Record<string, unknown> {
  return jobClass === 'bucket_counter_reconciliation' ? { next_bucket: 0 } : {};
}

function parseCursor(value: string): Record<string, unknown> {
  if (value.length > 4096) throw new Error('directory_cursor_invalid');
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('directory_cursor_invalid');
  }
  return parsed as Record<string, unknown>;
}

function validateProcessorResult(
  result: DirectoryJobProcessorResult,
  rowLimit: number
): DirectoryJobProcessorResult {
  if (
    !result ||
    typeof result !== 'object' ||
    !result.cursor ||
    typeof result.cursor !== 'object' ||
    Array.isArray(result.cursor) ||
    !Number.isSafeInteger(result.processedRows) ||
    result.processedRows < 0 ||
    result.processedRows > rowLimit
  ) {
    throw new Error('directory_processor_result_invalid');
  }
  const encodedCursor = JSON.stringify(result.cursor);
  if (encodedCursor.length > 4096) throw new Error('directory_cursor_invalid');
  return result;
}

async function claimDirectoryJob(
  adapter: DatabaseAdapter,
  jobClass: DirectoryJobClass,
  ownerId: string,
  rowLimit: number,
  nowSeconds: number
): Promise<DirectoryJobCursorRow | null> {
  await adapter.execute(
    `INSERT OR IGNORE INTO lookup_directory_job_cursors (
       job_class, cursor_json, budget_remaining, updated_at
     ) VALUES (?, ?, 0, ?)`,
    [jobClass, JSON.stringify(initialCursor(jobClass)), nowSeconds]
  );
  const claimed = await adapter.execute(
    `UPDATE lookup_directory_job_cursors
        SET owner_id = ?, fencing_token = fencing_token + 1,
            lease_expires_at = ?, budget_remaining = ?, last_started_at = ?,
            last_error_code = NULL, updated_at = ?
      WHERE job_class = ?
        AND (owner_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    [
      ownerId,
      nowSeconds + DIRECTORY_LEASE_SECONDS,
      rowLimit,
      nowSeconds,
      nowSeconds,
      jobClass,
      nowSeconds,
    ]
  );
  if (claimed.rowsAffected !== 1) return null;
  return adapter.queryOne<DirectoryJobCursorRow>(
    `SELECT job_class, owner_id, fencing_token, lease_expires_at,
            cursor_json, budget_remaining
       FROM lookup_directory_job_cursors
      WHERE job_class = ? AND owner_id = ?`,
    [jobClass, ownerId]
  );
}

async function releaseDirectoryJob(
  adapter: DatabaseAdapter,
  lease: DirectoryJobCursorRow,
  input: {
    ownerId: string;
    cursorJson: string;
    budgetRemaining: number;
    nowSeconds: number;
    errorCode: string | null;
  }
): Promise<void> {
  const result = await adapter.execute(
    `UPDATE lookup_directory_job_cursors
        SET owner_id = NULL, lease_expires_at = NULL, cursor_json = ?,
            budget_remaining = ?,
            last_completed_at = CASE WHEN ? IS NULL THEN ? ELSE last_completed_at END,
            last_error_code = ?, updated_at = ?
      WHERE job_class = ? AND owner_id = ? AND fencing_token = ?`,
    [
      input.cursorJson,
      input.budgetRemaining,
      input.errorCode,
      input.nowSeconds,
      input.errorCode,
      input.nowSeconds,
      lease.job_class,
      input.ownerId,
      safeInteger(lease.fencing_token),
    ]
  );
  if (result.rowsAffected !== 1) throw new Error('directory_job_stale_lease');
}

export async function runDirectoryScheduledJobs(
  adapter: DatabaseAdapter,
  processors: DirectoryJobProcessors,
  options: {
    nowMs?: () => number;
    ownerId?: string;
    invocationWallClockMs?: number;
  } = {}
): Promise<DirectoryScheduledSummary> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const ownerId = options.ownerId ?? `directory-${crypto.randomUUID()}`;
  const invocationDeadline =
    nowMs() + Math.max(1, options.invocationWallClockMs ?? DIRECTORY_INVOCATION_WALL_CLOCK_MS);
  const summary: DirectoryScheduledSummary = { skipped: false, processedRows: 0, classes: [] };

  for (const jobClass of DIRECTORY_JOB_CLASSES) {
    const processor = processors[jobClass];
    if (!processor) continue;
    if (nowMs() >= invocationDeadline) {
      summary.classes.push({ jobClass, status: 'budget_exhausted', processedRows: 0 });
      break;
    }
    const policy = DIRECTORY_JOB_POLICIES[jobClass];
    const nowSeconds = Math.floor(nowMs() / 1000);
    const lease = await claimDirectoryJob(adapter, jobClass, ownerId, policy.rowLimit, nowSeconds);
    if (!lease) {
      summary.classes.push({ jobClass, status: 'lease_unavailable', processedRows: 0 });
      continue;
    }
    try {
      const cursor = parseCursor(lease.cursor_json);
      const result = validateProcessorResult(
        await processor({
          adapter,
          jobClass,
          cursor,
          rowLimit: policy.rowLimit,
          deadlineMs: Math.min(invocationDeadline, nowMs() + policy.wallClockMs),
          ownerId,
          fencingToken: safeInteger(lease.fencing_token),
          nowMs,
        }),
        policy.rowLimit
      );
      await releaseDirectoryJob(adapter, lease, {
        ownerId,
        cursorJson: JSON.stringify(result.cursor),
        budgetRemaining: policy.rowLimit - result.processedRows,
        nowSeconds: Math.floor(nowMs() / 1000),
        errorCode: null,
      });
      summary.processedRows += result.processedRows;
      summary.classes.push({ jobClass, status: 'completed', processedRows: result.processedRows });
    } catch (error) {
      const errorCode = safeDirectoryJobErrorCode(error);
      await releaseDirectoryJob(adapter, lease, {
        ownerId,
        cursorJson: lease.cursor_json,
        budgetRemaining: safeInteger(lease.budget_remaining),
        nowSeconds: Math.floor(nowMs() / 1000),
        errorCode,
      });
      summary.classes.push({ jobClass, status: 'failed', processedRows: 0, errorCode });
    }
  }
  return summary;
}

interface BucketCountRow {
  virtual_bucket: number | string;
  active_identifier_count: number | string;
  active_alias_count: number | string;
}

interface RoutingOutboxClaimRow {
  outbox_id: string;
  tenant_id: string;
  account_id: string;
  event_kind: 'account_created' | 'identifier_added' | 'account_deleted' | 'identifier_removed';
  payload_json: string;
  attempt_count: number | string;
  created_at: number | string;
}

interface AccountLifecycleEventClaimRow {
  event_id: string;
  tenant_id: string;
  account_id: string;
  operation_id: string;
  event_type: string;
  event_version: number | string;
  payload_json: string;
  plugin_targets_json: string | null;
  attempt_count: number | string;
  created_at: number | string;
}

interface AccountLifecyclePayload {
  tenantId: string;
  accountId: string;
  userId: string;
  eventType: 'account.created';
  eventVersion: 1;
}

type AccountLifecyclePluginTarget = {
  installationId: string;
  capability: 'hook.account.lifecycle';
};

type AccountLifecycleTargetCache = Map<string, Promise<readonly AccountLifecyclePluginTarget[]>>;

const ROUTING_OUTBOX_LEASE_SECONDS = 120;
const ROUTING_OUTBOX_RETRY_BUDGET_SECONDS = 2 * 60 * 60;
const ACCOUNT_EVENT_LEASE_SECONDS = 120;
const ACCOUNT_EVENT_RETRY_BUDGET_SECONDS = 2 * 60 * 60;
const SAFE_RUNTIME_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function accountLifecyclePayload(row: AccountLifecycleEventClaimRow): AccountLifecyclePayload {
  if (
    row.event_type !== 'account.created' ||
    strictNonNegativeInteger(row.event_version, 'account_lifecycle_event_invalid') !== 1 ||
    row.payload_json.length > 4096
  ) {
    throw new Error('account_lifecycle_event_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new Error('account_lifecycle_event_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('account_lifecycle_event_invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !== 'accountId,eventType,eventVersion,tenantId,userId' ||
    value.tenantId !== row.tenant_id ||
    value.accountId !== row.account_id ||
    value.eventType !== 'account.created' ||
    value.eventVersion !== 1 ||
    !isCanonicalAccountIdForUser(value.accountId, value.userId) ||
    !SAFE_RUNTIME_ID.test(row.event_id) ||
    !SAFE_RUNTIME_ID.test(row.tenant_id) ||
    !SAFE_RUNTIME_ID.test(row.account_id) ||
    !SAFE_RUNTIME_ID.test(row.operation_id)
  ) {
    throw new Error('account_lifecycle_event_invalid');
  }
  return value as unknown as AccountLifecyclePayload;
}

async function claimAccountLifecycleEvent(
  session: D1DatabaseSession,
  ownerId: string,
  now: number
): Promise<AccountLifecycleEventClaimRow | null> {
  const candidate = await firstSession<{ event_id: string }>(
    session,
    `SELECT event_id FROM account_lifecycle_event_outbox
      WHERE (status IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      ORDER BY created_at, event_id LIMIT 1`,
    [now, now]
  );
  if (!candidate || !SAFE_RUNTIME_ID.test(candidate.event_id)) return null;
  const claimed = await session
    .prepare(
      `UPDATE account_lifecycle_event_outbox
          SET status = 'leased', attempt_count = attempt_count + 1,
              lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL,
              last_error_code = NULL, updated_at = ?
        WHERE event_id = ? AND (
          (status IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )`
    )
    .bind(ownerId, now + ACCOUNT_EVENT_LEASE_SECONDS, now, candidate.event_id, now, now)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return null;
  return firstSession<AccountLifecycleEventClaimRow>(
    session,
    `SELECT event_id, tenant_id, account_id, operation_id, event_type, event_version,
            payload_json, plugin_targets_json, attempt_count, created_at
       FROM account_lifecycle_event_outbox
      WHERE event_id = ? AND status = 'leased' AND lease_owner = ?`,
    [candidate.event_id, ownerId]
  );
}

async function claimAccountLifecycleEventByOperation(
  session: D1DatabaseSession,
  tenantId: string,
  operationId: string,
  ownerId: string,
  now: number
): Promise<AccountLifecycleEventClaimRow | null> {
  if (!SAFE_RUNTIME_ID.test(tenantId) || !SAFE_RUNTIME_ID.test(operationId)) {
    throw new Error('account_lifecycle_event_invalid');
  }
  const candidate = await firstSession<{ event_id: string }>(
    session,
    `SELECT event_id FROM account_lifecycle_event_outbox
      WHERE tenant_id = ? AND operation_id = ? AND (
        (status IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )
      LIMIT 1`,
    [tenantId, operationId, now, now]
  );
  if (!candidate || !SAFE_RUNTIME_ID.test(candidate.event_id)) return null;
  const claimed = await session
    .prepare(
      `UPDATE account_lifecycle_event_outbox
          SET status = 'leased', attempt_count = attempt_count + 1,
              lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL,
              last_error_code = NULL, updated_at = ?
        WHERE event_id = ? AND tenant_id = ? AND operation_id = ? AND (
          (status IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )`
    )
    .bind(
      ownerId,
      now + ACCOUNT_EVENT_LEASE_SECONDS,
      now,
      candidate.event_id,
      tenantId,
      operationId,
      now,
      now
    )
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return null;
  return firstSession<AccountLifecycleEventClaimRow>(
    session,
    `SELECT event_id, tenant_id, account_id, operation_id, event_type, event_version,
            payload_json, plugin_targets_json, attempt_count, created_at
       FROM account_lifecycle_event_outbox
      WHERE event_id = ? AND status = 'leased' AND lease_owner = ?`,
    [candidate.event_id, ownerId]
  );
}

function pluginTargets(value: string): AccountLifecyclePluginTarget[] {
  if (value.length > 4096) throw new Error('account_lifecycle_plugin_targets_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('account_lifecycle_plugin_targets_invalid');
  }
  if (!Array.isArray(parsed) || parsed.length > 32) {
    throw new Error('account_lifecycle_plugin_targets_invalid');
  }
  const seen = new Set<string>();
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('account_lifecycle_plugin_targets_invalid');
    }
    const target = entry as Record<string, unknown>;
    if (
      Object.keys(target).sort().join(',') !== 'capability,installationId' ||
      typeof target.installationId !== 'string' ||
      !SAFE_RUNTIME_ID.test(target.installationId) ||
      target.capability !== 'hook.account.lifecycle' ||
      seen.has(target.installationId)
    ) {
      throw new Error('account_lifecycle_plugin_targets_invalid');
    }
    seen.add(target.installationId);
    return {
      installationId: target.installationId,
      capability: 'hook.account.lifecycle' as const,
    };
  });
}

async function snapshotAccountEventTargets(
  env: Env,
  session: D1DatabaseSession,
  claim: AccountLifecycleEventClaimRow,
  ownerId: string,
  now: number,
  targetCache: AccountLifecycleTargetCache
) {
  if (claim.plugin_targets_json !== null) return pluginTargets(claim.plugin_targets_json);
  if (!env.PLUGIN_RUNNER) throw new Error('account_lifecycle_plugin_runner_unavailable');
  let targetPromise = targetCache.get(claim.tenant_id);
  if (!targetPromise) {
    targetPromise = env.PLUGIN_RUNNER.resolveAccountEventInstallations({
      tenantId: claim.tenant_id,
      eventType: 'account.created',
    }).then((resolved) => pluginTargets(JSON.stringify(resolved)));
    targetCache.set(claim.tenant_id, targetPromise);
  }
  const encoded = JSON.stringify(await targetPromise);
  const updated = await session
    .prepare(
      `UPDATE account_lifecycle_event_outbox SET plugin_targets_json = ?, updated_at = ?
        WHERE event_id = ? AND status = 'leased' AND lease_owner = ?
          AND attempt_count = ? AND plugin_targets_json IS NULL`
    )
    .bind(encoded, now, claim.event_id, ownerId, claim.attempt_count)
    .run();
  if ((updated.meta.changes ?? 0) !== 1) {
    throw new Error('account_lifecycle_event_stale_lease');
  }
  return pluginTargets(encoded);
}

async function completeAccountLifecycleEvent(
  env: Env,
  tenantCore: D1Database,
  session: D1DatabaseSession,
  claim: AccountLifecycleEventClaimRow,
  ownerId: string,
  now: number,
  dispatcher: Awaited<ReturnType<typeof createEventDispatcherFromEnv>>,
  targetCache: AccountLifecycleTargetCache
): Promise<void> {
  const payload = accountLifecyclePayload(claim);
  const targets = await snapshotAccountEventTargets(env, session, claim, ownerId, now, targetCache);
  await dispatcher.publish(
    {
      type: USER_EVENTS.CREATED,
      tenantId: payload.tenantId,
      data: { userId: payload.userId },
    },
    { deduplicationKey: claim.event_id, skipAuditLog: true }
  );
  const prepared: Array<{ outboxId: string; installationId: string; payload: string }> = [];
  for (const target of targets) {
    const digest = await sha256(`${claim.event_id}\0${target.installationId}`);
    prepared.push({
      outboxId: `account-hook:${digest}`,
      installationId: target.installationId,
      payload: JSON.stringify({
        tenantId: payload.tenantId,
        accountId: payload.accountId,
        eventType: payload.eventType,
        eventVersion: payload.eventVersion,
      }),
    });
  }
  if (prepared.length > 0) {
    await tenantCore.batch(
      prepared.map((target) =>
        tenantCore
          .prepare(
            `INSERT OR IGNORE INTO plugin_hook_outbox (
               outbox_id, tenant_id, plugin_installation_id, capability, event_type,
               event_version, idempotency_key, payload_json, payload_class,
               status, attempt_no, created_at, updated_at
             ) VALUES (?, ?, ?, 'hook.account.lifecycle', 'account.created', 1, ?, ?,
                       'reference_v1', 'queued', 0, ?, ?)`
          )
          .bind(
            target.outboxId,
            payload.tenantId,
            target.installationId,
            claim.event_id,
            target.payload,
            now,
            now
          )
      )
    );
    for (const target of prepared) {
      const reflected = await firstSession<{
        tenant_id: string;
        plugin_installation_id: string;
        capability: string;
        event_type: string;
        idempotency_key: string;
        payload_json: string;
      }>(
        session,
        `SELECT tenant_id, plugin_installation_id, capability, event_type,
                idempotency_key, payload_json
           FROM plugin_hook_outbox WHERE outbox_id = ?`,
        [target.outboxId]
      );
      if (
        !reflected ||
        reflected.tenant_id !== payload.tenantId ||
        reflected.plugin_installation_id !== target.installationId ||
        reflected.capability !== 'hook.account.lifecycle' ||
        reflected.event_type !== 'account.created' ||
        reflected.idempotency_key !== claim.event_id ||
        reflected.payload_json !== target.payload
      ) {
        throw new Error('account_lifecycle_plugin_outbox_conflict');
      }
    }
  }
  const completed = await session
    .prepare(
      `UPDATE account_lifecycle_event_outbox
          SET status = 'succeeded', succeeded_at = COALESCE(succeeded_at, ?),
              lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
              last_error_code = NULL, updated_at = ?
        WHERE event_id = ? AND status = 'leased' AND lease_owner = ? AND attempt_count = ?`
    )
    .bind(now, now, claim.event_id, ownerId, claim.attempt_count)
    .run();
  if ((completed.meta.changes ?? 0) !== 1) {
    throw new Error('account_lifecycle_event_stale_lease');
  }
}

async function releaseAccountLifecycleEventFailure(
  session: D1DatabaseSession,
  claim: AccountLifecycleEventClaimRow,
  ownerId: string,
  now: number
): Promise<void> {
  const attemptCount = strictNonNegativeInteger(
    claim.attempt_count,
    'account_lifecycle_event_invalid'
  );
  const createdAt = strictNonNegativeInteger(claim.created_at, 'account_lifecycle_event_invalid');
  const deadLetter = now - createdAt >= ACCOUNT_EVENT_RETRY_BUDGET_SECONDS;
  const result = await session
    .prepare(
      `UPDATE account_lifecycle_event_outbox
          SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = ?, last_error_code = ?, updated_at = ?
        WHERE event_id = ? AND status = 'leased' AND lease_owner = ? AND attempt_count = ?`
    )
    .bind(
      deadLetter ? 'dead_letter' : 'retry',
      deadLetter ? null : now + retryDelaySeconds(claim.event_id, attemptCount),
      deadLetter ? 'account_lifecycle_retry_budget_exhausted' : 'account_lifecycle_retryable',
      now,
      claim.event_id,
      ownerId,
      attemptCount
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw new Error('account_lifecycle_event_stale_lease');
}

export async function processAccountLifecycleEventForOperation(
  env: Env,
  tenantCore: D1Database,
  input: { tenantId: string; operationId: string; now?: number }
): Promise<boolean> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const ownerId = `account-event-${crypto.randomUUID()}`;
  const session = tenantCore.withSession('first-primary');
  const claim = await claimAccountLifecycleEventByOperation(
    session,
    input.tenantId,
    input.operationId,
    ownerId,
    now
  );
  if (!claim) return false;
  try {
    const dispatcher = await createEventDispatcherFromEnv(env, {
      adapter: ensureDatabaseAdapter(tenantCore, 'account-lifecycle-event'),
    });
    await completeAccountLifecycleEvent(
      env,
      tenantCore,
      session,
      claim,
      ownerId,
      now,
      dispatcher,
      new Map()
    );
    return true;
  } catch {
    await releaseAccountLifecycleEventFailure(session, claim, ownerId, now);
    return false;
  }
}

function d1Binding(env: Env, bindingRef: string, errorCode: string): D1Database {
  const binding = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!binding || typeof binding !== 'object') throw new Error(errorCode);
  const candidate = binding as Partial<D1Database>;
  if (
    typeof candidate.prepare !== 'function' ||
    typeof candidate.batch !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error(errorCode);
  }
  return binding as D1Database;
}

function routingCursor(value: Record<string, unknown>): string | null {
  const afterShardId = value.after_shard_id;
  if (afterShardId === undefined || afterShardId === null) return null;
  if (
    typeof afterShardId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(afterShardId)
  ) {
    throw new Error('directory_routing_cursor_invalid');
  }
  return afterShardId;
}

async function firstSession<T>(
  session: D1DatabaseSession,
  sql: string,
  params: unknown[]
): Promise<T | null> {
  return session
    .prepare(sql)
    .bind(...params)
    .first<T>();
}

async function claimRoutingOutboxRow(
  session: D1DatabaseSession,
  ownerId: string,
  nowSeconds: number
): Promise<RoutingOutboxClaimRow | null> {
  const candidate = await firstSession<RoutingOutboxClaimRow>(
    session,
    `SELECT outbox_id, tenant_id, account_id, event_kind, payload_json, attempt_count, created_at
       FROM account_routing_outbox
      WHERE event_kind IN ('account_created', 'identifier_added', 'account_deleted', 'identifier_removed') AND (
        (status IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )
      ORDER BY created_at, outbox_id LIMIT 1`,
    [nowSeconds, nowSeconds]
  );
  if (!candidate) return null;
  const claimed = await session
    .prepare(
      `UPDATE account_routing_outbox
          SET status = 'leased', attempt_count = attempt_count + 1,
              lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL,
              last_error_code = NULL, updated_at = ?
        WHERE outbox_id = ? AND (
          (status IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )`
    )
    .bind(
      ownerId,
      nowSeconds + ROUTING_OUTBOX_LEASE_SECONDS,
      nowSeconds,
      candidate.outbox_id,
      nowSeconds,
      nowSeconds
    )
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return null;
  return firstSession<RoutingOutboxClaimRow>(
    session,
    `SELECT outbox_id, tenant_id, account_id, event_kind, payload_json, attempt_count, created_at
       FROM account_routing_outbox
      WHERE outbox_id = ? AND status = 'leased' AND lease_owner = ?`,
    [candidate.outbox_id, ownerId]
  );
}

async function hasRunnableRoutingOutboxRow(
  session: D1DatabaseSession,
  nowSeconds: number
): Promise<boolean> {
  const candidate = await firstSession<{ outbox_id: string }>(
    session,
    `SELECT outbox_id
       FROM account_routing_outbox
      WHERE event_kind IN ('account_created', 'identifier_added', 'account_deleted', 'identifier_removed') AND (
        (status IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )
      ORDER BY created_at, outbox_id LIMIT 1`,
    [nowSeconds, nowSeconds]
  );
  return candidate !== null;
}

function retryDelaySeconds(outboxId: string, attemptCount: number): number {
  let jitter = 0;
  for (let index = 0; index < outboxId.length; index += 1) {
    jitter = (jitter * 33 + outboxId.charCodeAt(index)) % 31;
  }
  return Math.min(1800, 30 * 2 ** Math.min(6, Math.max(0, attemptCount - 1))) + jitter;
}

function routingFailureCode(error: unknown): { code: string; permanent: boolean } {
  const message = error instanceof Error ? error.message : '';
  if (
    /^(invalid_directory_(publication|removal)_|duplicate_directory_(publication|removal)_index|invalid_(identifier|account)_removal_index_set|control_plane_sensitive_|directory_(routing_outbox_payload_(invalid|mismatch)|identifier_reservation_conflict|account_(not_found|state_conflict)|removal_[a-z0-9_]+)|account_directory_source_route_invalid|account_creation_operation_(blocked|canceled|not_found|publication_mismatch))/u.test(
      message
    )
  ) {
    return { code: 'directory_routing_invalid', permanent: true };
  }
  if (/stale_lease$/u.test(message)) {
    return { code: 'directory_routing_stale_lease', permanent: false };
  }
  return { code: 'directory_routing_retryable', permanent: false };
}

function routingFailureOutcome(
  claim: RoutingOutboxClaimRow,
  nowSeconds: number,
  error: unknown
): { code: string; blocked: boolean } {
  const createdAt = strictNonNegativeInteger(claim.created_at, 'directory_routing_claim_invalid');
  const failure = routingFailureCode(error);
  const blocked =
    failure.permanent || nowSeconds - createdAt >= ROUTING_OUTBOX_RETRY_BUDGET_SECONDS;
  return {
    blocked,
    code: blocked && !failure.permanent ? 'directory_routing_retry_budget_exhausted' : failure.code,
  };
}

async function releaseRoutingOutboxFailure(
  session: D1DatabaseSession,
  claim: RoutingOutboxClaimRow,
  ownerId: string,
  nowSeconds: number,
  error: unknown
): Promise<{ blocked: boolean; errorCode: string }> {
  const attemptCount = strictNonNegativeInteger(
    claim.attempt_count,
    'directory_routing_claim_invalid'
  );
  const { blocked, code } = routingFailureOutcome(claim, nowSeconds, error);
  const result = await session
    .prepare(
      `UPDATE account_routing_outbox
          SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = ?, last_error_code = ?, updated_at = ?
        WHERE outbox_id = ? AND status = 'leased' AND lease_owner = ? AND attempt_count = ?`
    )
    .bind(
      blocked ? 'blocked' : 'retry',
      blocked ? null : nowSeconds + retryDelaySeconds(claim.outbox_id, attemptCount),
      code,
      nowSeconds,
      claim.outbox_id,
      ownerId,
      attemptCount
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw new Error('directory_routing_outbox_stale_lease');
  return { blocked, errorCode: code };
}

async function accountCreationOperationRepository(
  env: Env,
  tenantId: string
): Promise<AccountCreationOperationRepository> {
  return new AccountCreationOperationRepository(
    await resolveAuthCorePersistenceAdapterFromEnv(env, 'account-creation-operation', {
      tenantId,
    })
  );
}

export function createRoutingOutboxProcessor(
  env: Env,
  options: {
    operationRepositoryForTenant?: (
      tenantId: string
    ) => Promise<AccountCreationOperationRepository>;
  } = {}
): DirectoryJobProcessor {
  const operationRepositoryForTenant =
    options.operationRepositoryForTenant ??
    ((tenantId: string) => accountCreationOperationRepository(env, tenantId));
  return async (input) => {
    if (!env.CONTROL) throw new Error('directory_routing_control_unavailable');
    const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
    if (
      typeof environmentId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(environmentId)
    ) {
      throw new Error('directory_routing_environment_invalid');
    }
    const afterShardId = routingCursor(input.cursor);
    const shards = await env.CONTROL.listAccountDirectorySourceShards({
      afterShardId,
      limit: 1,
    });
    if (shards.length === 0) {
      return { cursor: { after_shard_id: null }, processedRows: 0 };
    }
    if (shards.length !== 1) throw new Error('directory_routing_source_page_invalid');
    const shard = shards[0];
    if (
      !shard ||
      typeof shard.shardId !== 'string' ||
      typeof shard.bindingRef !== 'string' ||
      !Number.isSafeInteger(shard.routeGeneration) ||
      shard.routeGeneration < 1
    ) {
      throw new Error('directory_routing_source_page_invalid');
    }
    const tenantCore = d1Binding(
      env,
      shard.bindingRef,
      'directory_routing_source_binding_unavailable'
    );
    const sourceSession = tenantCore.withSession('first-primary');
    let lookupResolver: Awaited<ReturnType<typeof createLookupBucketWriteResolver>> | null = null;
    const coordinator = new AccountDirectoryCoordinator({
      tenantCore,
      lookupForBucket: async (bucket) => {
        lookupResolver ??= await createLookupBucketWriteResolver(env);
        return lookupResolver(bucket);
      },
      now: () => Math.floor(input.nowMs() / 1000),
      onAccountActivated: async (publication, now) => {
        await activatePublishedAccountAuthenticationState(env, tenantCore, publication, now);
        await (
          await operationRepositoryForTenant(publication.tenantId)
        ).recordDirectoryOutcome({
          publication,
          outcome: 'succeeded',
          now,
          lifecycleEventAdapter: ensureDatabaseAdapter(
            tenantCore,
            'directory-scheduled-lifecycle-events'
          ),
        });
      },
    });
    const removalCoordinator = new AccountDirectoryRemovalCoordinator({
      tenantCore,
      lookupForBucket: async (bucket) => {
        lookupResolver ??= await createLookupBucketWriteResolver(env);
        return lookupResolver(bucket);
      },
      now: () => Math.floor(input.nowMs() / 1000),
    });
    let processedRows = 0;
    // Drain events from a previous activation pass first. Events created below are picked up on
    // the next scheduled pass, keeping account activation independent from plugin availability.
    // When routing work is also waiting, process at most one lifecycle event first. Plugin/event
    // latency must not consume the whole shard visit and starve account publication recovery.
    const routingWorkWaiting = await hasRunnableRoutingOutboxRow(
      sourceSession,
      Math.floor(input.nowMs() / 1000)
    );
    const lifecycleRowLimit = routingWorkWaiting ? 1 : input.rowLimit;
    const lifecycleTargetCache: AccountLifecycleTargetCache = new Map();
    let lifecycleDispatcher: Awaited<ReturnType<typeof createEventDispatcherFromEnv>> | null = null;
    while (processedRows < lifecycleRowLimit && input.nowMs() < input.deadlineMs) {
      const events: AccountLifecycleEventClaimRow[] = [];
      const batchSize = Math.min(8, lifecycleRowLimit - processedRows);
      for (let index = 0; index < batchSize; index += 1) {
        const event = await claimAccountLifecycleEvent(
          sourceSession,
          input.ownerId,
          Math.floor(input.nowMs() / 1000)
        );
        if (!event) break;
        events.push(event);
      }
      if (events.length === 0) break;
      try {
        lifecycleDispatcher ??= await createEventDispatcherFromEnv(env, {
          adapter: ensureDatabaseAdapter(tenantCore, 'account-lifecycle-event'),
        });
      } catch {
        await Promise.all(
          events.map((event) =>
            releaseAccountLifecycleEventFailure(
              tenantCore.withSession('first-primary'),
              event,
              input.ownerId,
              Math.floor(input.nowMs() / 1000)
            )
          )
        );
        processedRows += events.length;
        continue;
      }
      await Promise.all(
        events.map(async (event) => {
          const eventSession = tenantCore.withSession('first-primary');
          const nowSeconds = Math.floor(input.nowMs() / 1000);
          try {
            await completeAccountLifecycleEvent(
              env,
              tenantCore,
              eventSession,
              event,
              input.ownerId,
              nowSeconds,
              lifecycleDispatcher!,
              lifecycleTargetCache
            );
          } catch {
            await releaseAccountLifecycleEventFailure(
              eventSession,
              event,
              input.ownerId,
              nowSeconds
            );
          }
        })
      );
      processedRows += events.length;
    }
    while (processedRows < input.rowLimit && input.nowMs() < input.deadlineMs) {
      const nowSeconds = Math.floor(input.nowMs() / 1000);
      const claim = await claimRoutingOutboxRow(sourceSession, input.ownerId, nowSeconds);
      if (!claim) break;
      const fencingToken = strictNonNegativeInteger(
        claim.attempt_count,
        'directory_routing_claim_invalid'
      );
      const createdAt = strictNonNegativeInteger(
        claim.created_at,
        'directory_routing_claim_invalid'
      );
      if (nowSeconds - createdAt >= ROUTING_OUTBOX_RETRY_BUDGET_SECONDS) {
        if (claim.event_kind === 'account_created') {
          let publication: AccountDirectoryPublication | null = null;
          try {
            publication = await validateAccountDirectoryPublication(
              JSON.parse(claim.payload_json) as AccountDirectoryPublication
            );
          } catch {
            // The outbox transition below remains the authoritative fail-closed action.
          }
          const repository = await operationRepositoryForTenant(claim.tenant_id);
          if (publication) {
            await repository.recordDirectoryOutcome({
              publication,
              outcome: 'blocked',
              now: nowSeconds,
              errorCode: 'directory_routing_retry_budget_exhausted',
            });
          } else {
            await repository.blockDirectoryFailureByAccount({
              tenantId: claim.tenant_id,
              accountId: claim.account_id,
              now: nowSeconds,
              errorCode: 'directory_routing_retry_budget_exhausted',
            });
          }
        }
        await releaseRoutingOutboxFailure(
          sourceSession,
          claim,
          input.ownerId,
          nowSeconds,
          new Error('directory_routing_retry_budget_exhausted')
        );
        processedRows += 1;
        continue;
      }
      let publication: AccountDirectoryPublication | null = null;
      let removal: AccountDirectoryRemovalPublication | null = null;
      try {
        if (claim.event_kind === 'account_created' || claim.event_kind === 'identifier_added') {
          publication = await validateAccountDirectoryPublication(
            JSON.parse(claim.payload_json) as AccountDirectoryPublication
          );
          if (claim.event_kind === 'account_created') {
            const operationRepository = await operationRepositoryForTenant(publication.tenantId);
            const operation = await operationRepository.findForPublication(publication);
            if (!operation) throw new Error('account_creation_operation_not_found');
            if (operation.status === 'blocked' || operation.status === 'canceled') {
              throw new Error(`account_creation_operation_${operation.status}`);
            }
          }
          await coordinator.publish(publication, { ownerId: input.ownerId, fencingToken });
        } else {
          removal = await validateAccountDirectoryRemovalPublication(
            JSON.parse(claim.payload_json) as AccountDirectoryRemovalPublication
          );
          if (
            (claim.event_kind === 'account_deleted' && removal.scope !== 'account') ||
            (claim.event_kind === 'identifier_removed' && removal.scope !== 'identifier')
          ) {
            throw new Error('directory_removal_event_kind_mismatch');
          }
          await removalCoordinator.remove(removal, { ownerId: input.ownerId, fencingToken });
        }
      } catch (error) {
        const expectedOutcome = routingFailureOutcome(claim, nowSeconds, error);
        if (claim.event_kind === 'account_created' && expectedOutcome.blocked && publication) {
          const repository = await operationRepositoryForTenant(publication.tenantId);
          if (
            error instanceof Error &&
            error.message === 'account_creation_operation_publication_mismatch'
          ) {
            await repository.blockDirectoryPublicationConflict({
              publication,
              now: nowSeconds,
              errorCode: expectedOutcome.code,
            });
          } else if (
            !(error instanceof Error) ||
            ![
              'account_creation_operation_canceled',
              'account_creation_operation_not_found',
            ].includes(error.message)
          ) {
            await repository.recordDirectoryOutcome({
              publication,
              outcome: 'blocked',
              now: nowSeconds,
              errorCode: expectedOutcome.code,
            });
          }
        } else if (claim.event_kind === 'account_created' && expectedOutcome.blocked) {
          await (
            await operationRepositoryForTenant(claim.tenant_id)
          ).blockDirectoryFailureByAccount({
            tenantId: claim.tenant_id,
            accountId: claim.account_id,
            now: nowSeconds,
            errorCode: expectedOutcome.code,
          });
        }
        await releaseRoutingOutboxFailure(sourceSession, claim, input.ownerId, nowSeconds, error);
      }
      processedRows += 1;
    }
    const routingWorkRemaining = await hasRunnableRoutingOutboxRow(
      sourceSession,
      Math.floor(input.nowMs() / 1000)
    );
    return {
      cursor: { after_shard_id: routingWorkRemaining ? afterShardId : shard.shardId },
      processedRows,
    };
  };
}

export const reconcileLookupBucketCounters: DirectoryJobProcessor = async (input) => {
  if (input.nowMs() >= input.deadlineMs) {
    throw new Error('directory_counter_budget_exhausted');
  }
  if (typeof input.cursor.next_bucket !== 'number') {
    throw new Error('directory_counter_cursor_invalid');
  }
  const nextBucket = strictNonNegativeInteger(
    input.cursor.next_bucket,
    'directory_counter_cursor_invalid'
  );
  if (nextBucket < 0 || nextBucket >= LOOKUP_VIRTUAL_BUCKET_COUNT) {
    throw new Error('directory_counter_cursor_invalid');
  }
  const endBucket = Math.min(LOOKUP_VIRTUAL_BUCKET_COUNT - 1, nextBucket + input.rowLimit - 1);
  const rows = await input.adapter.query<BucketCountRow>(
    `WITH RECURSIVE buckets(virtual_bucket) AS (
       SELECT ?
       UNION ALL
       SELECT virtual_bucket + 1 FROM buckets WHERE virtual_bucket < ?
     )
     SELECT buckets.virtual_bucket,
            (SELECT COUNT(*) FROM lookup_identifiers identifier
              WHERE identifier.virtual_bucket = buckets.virtual_bucket
                AND identifier.lifecycle_state = 'active') AS active_identifier_count,
            (SELECT COUNT(*) FROM lookup_tenant_aliases alias
              WHERE alias.virtual_bucket = buckets.virtual_bucket
                AND alias.lifecycle_state = 'active') AS active_alias_count
       FROM buckets ORDER BY buckets.virtual_bucket`,
    [nextBucket, endBucket]
  );
  if (rows.length !== endBucket - nextBucket + 1) {
    throw new Error('directory_counter_scan_incomplete');
  }
  if (input.nowMs() >= input.deadlineMs) {
    throw new Error('directory_counter_budget_exhausted');
  }
  const nowSeconds = Math.floor(input.nowMs() / 1000);
  const statements: PreparedStatement[] = rows.map((row, index) => {
    const virtualBucket = strictNonNegativeInteger(
      row.virtual_bucket,
      'directory_counter_result_invalid'
    );
    const activeIdentifierCount = strictNonNegativeInteger(
      row.active_identifier_count,
      'directory_counter_result_invalid'
    );
    const activeAliasCount = strictNonNegativeInteger(
      row.active_alias_count,
      'directory_counter_result_invalid'
    );
    if (virtualBucket !== nextBucket + index || virtualBucket > endBucket) {
      throw new Error('directory_counter_result_invalid');
    }
    return {
      sql: `INSERT INTO lookup_bucket_counters (
            virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
            exact_count_checked_at, reconciliation_cursor, reconciliation_error_code, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT(virtual_bucket) DO UPDATE SET
            estimated_active_identifier_count = excluded.estimated_active_identifier_count,
            estimated_active_alias_count = excluded.estimated_active_alias_count,
            exact_count_checked_at = excluded.exact_count_checked_at,
            reconciliation_cursor = excluded.reconciliation_cursor,
            reconciliation_error_code = NULL,
            updated_at = excluded.updated_at`,
      params: [
        virtualBucket,
        activeIdentifierCount,
        activeAliasCount,
        nowSeconds,
        String(endBucket),
        nowSeconds,
      ],
    };
  });
  await input.adapter.batch(statements);
  return {
    cursor: {
      next_bucket: endBucket === LOOKUP_VIRTUAL_BUCKET_COUNT - 1 ? 0 : endBucket + 1,
    },
    processedRows: rows.length,
  };
};

export function isDirectoryScheduledCron(cron: string): boolean {
  return cron === DIRECTORY_SCHEDULED_CRON;
}

export async function processScheduledDirectoryJobs(
  env: Env,
  log: DirectoryScheduledLogger
): Promise<DirectoryScheduledSummary> {
  if (!env.LOOKUP_DB) {
    const summary: DirectoryScheduledSummary = { skipped: true, processedRows: 0, classes: [] };
    log.warn('Directory scheduled processing skipped because LOOKUP_DB is unavailable');
    return summary;
  }
  try {
    const adapter = ensureDatabaseAdapter(env.LOOKUP_DB, 'directory-scheduled');
    const summary = await runDirectoryScheduledJobs(adapter, {
      routing_outbox: createRoutingOutboxProcessor(env),
      hmac_reindex: createLookupHmacReindexProcessor(env),
      bucket_counter_reconciliation: reconcileLookupBucketCounters,
    });
    log.info('Directory scheduled processing completed', {
      processed_rows: summary.processedRows,
      classes: summary.classes,
    });
    return summary;
  } catch (error) {
    log.error('Directory scheduled processing failed', {}, error as Error);
    return { skipped: false, processedRows: 0, classes: [] };
  }
}
