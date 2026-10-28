/** Bounded Support Ops coordinator. Admin ownership is checked before every remote effect. */
import {
  getSessionRevocationStore,
  getSupportOpsResource,
  requireDedicatedAdminDatabaseAdapter,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import {
  accountsByStore,
  SupportOpsAmbiguousAccountError,
  supportOpsStoresFromEnv,
  type SupportOpsStoreIdentity,
} from './support-ops-stores';
import {
  assertSupportOpsStoreUnchanged,
  assertSupportOpsStoreIdentity,
  preflightSupportOpsExecutionStores,
} from './support-ops-execution-stores';
import {
  acknowledgeSupportOpsAccountResult,
  assertSupportOpsAccountReceiptStore,
  readSupportOpsAccountResult,
  suspendSupportOpsAccountOnce,
  cleanupSupportOpsAccountResultReceipts,
  type SupportOpsAccountMutation,
} from './support-ops-execute';
import {
  keepSupportOpsFinalAudit,
  keepSupportOpsLogoutPage,
  supportOpsEvidenceId,
  SUPPORT_OPS_LOGOUT_JOB_TYPE,
  type SupportOpsAuditActor,
} from './support-ops-job-evidence';
import { redactResultSummary } from './support-ops-redaction';

export const SUPPORT_OPS_EXECUTE_JOB_TYPE = 'support-ops/action-execute';
export const SUPPORT_OPS_EXECUTE_LOGOUT_JOB_TYPE = SUPPORT_OPS_LOGOUT_JOB_TYPE;
const LEASE_SECONDS = 900;
const RESERVE = 8;
interface Config {
  action_id: string;
  cohort_id: string;
  executor: string;
  source_version_ms: number;
  actor: SupportOpsAuditActor;
  matched_count: number;
  actionable_count: number;
  blocked_count: number;
  metadata_identity: SupportOpsStoreIdentity;
}
interface Active {
  target_id: string;
  account_id: string;
  store_key: string;
  store_identity: SupportOpsStoreIdentity;
  operation_id: string;
  account_result?: 0 | 1;
  transferred?: { sequence: number };
  receipt_completed?: true;
}
interface Progress {
  run_id?: string;
  stage: 'verifying' | 'executing' | 'finalizing' | 'completed' | 'failed';
  total: number;
  processed: number;
  succeeded: number;
  last_target_id: string;
  active?: Active;
  outcome?: { status: 'completed' | 'failed'; error?: string; decided_at: number };
}
export interface SupportOpsExecuteRunLimits {
  pageSize?: number;
  maxTargetsPerRun?: number;
  maxCallsPerRun?: number;
  deadlineMs?: number;
}
export interface SupportOpsRunBudget {
  remaining: number;
}
interface Logger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>, error?: Error): void;
}
class YieldRun extends Error {}
class LostClaim extends Error {}

export async function createSupportOpsExecuteJob(
  db: DatabaseAdapter,
  input: {
    jobId: string;
    tenantId: string;
    actionId: string;
    cohortId: string;
    executor: string;
    sourceVersionMs: number;
    actionableCount: number;
    matchedCount?: number;
    blockedCount?: number;
    actor: SupportOpsAuditActor;
    metadataIdentity: SupportOpsStoreIdentity;
  }
): Promise<void> {
  const config: Config = {
    action_id: input.actionId,
    cohort_id: input.cohortId,
    executor: input.executor,
    source_version_ms: input.sourceVersionMs,
    actor: input.actor,
    matched_count: input.matchedCount ?? input.actionableCount,
    actionable_count: input.actionableCount,
    blocked_count: input.blockedCount ?? 0,
    metadata_identity: input.metadataIdentity,
  };
  const progress: Progress = {
    stage: 'verifying',
    total: input.actionableCount,
    processed: 0,
    succeeded: 0,
    last_target_id: '',
  };
  const now = Math.floor(Date.now() / 1000);
  await db.execute(
    `INSERT INTO admin_jobs
    (id,tenant_id,job_type,status,config,progress,created_by,created_at,updated_at)
    VALUES(?,?,?,'pending',?,?,?,?,?)`,
    [
      input.jobId,
      input.tenantId,
      SUPPORT_OPS_EXECUTE_JOB_TYPE,
      JSON.stringify(config),
      JSON.stringify(progress),
      input.executor,
      now,
      now,
    ]
  );
}
export async function deleteSupportOpsExecuteJob(
  db: DatabaseAdapter,
  tenantId: string,
  jobId: string
): Promise<void> {
  await db.execute(
    "DELETE FROM admin_jobs WHERE tenant_id=? AND id=? AND job_type=? AND status='pending'",
    [tenantId, jobId, SUPPORT_OPS_EXECUTE_JOB_TYPE]
  );
}
function parse<T>(value: string | null): T {
  const parsed: unknown = JSON.parse(value ?? 'null');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('support_ops_job_state_invalid');
  return parsed as T;
}
async function run(
  env: Env,
  db: DatabaseAdapter,
  job: { id: string; tenant_id: string },
  limits: SupportOpsExecuteRunLimits,
  budget: SupportOpsRunBudget,
  logger?: Logger
): Promise<void> {
  const now = Math.floor(Date.now() / 1000),
    owner = crypto.randomUUID();
  const startedMs = Date.now();
  const deadline = Math.min(limits.deadlineMs ?? startedMs + 20_000, startedMs + 20_000);
  const take = (cost: number, reserved = false) => {
    if (budget.remaining < cost + (reserved ? 0 : RESERVE) || (!reserved && Date.now() >= deadline))
      throw new YieldRun();
    budget.remaining -= cost;
  };
  take(1);
  const claim = await db.execute(
    `UPDATE admin_jobs SET status='processing',updated_at=MAX(updated_at,?),
    started_at=COALESCE(started_at,?),progress=json_set(progress,'$.run_id',?)
    WHERE tenant_id=? AND id=? AND job_type=? AND
      (status='pending' OR(status='processing' AND updated_at<?))
      AND(next_run_at IS NULL OR next_run_at<=?)`,
    [now, now, owner, job.tenant_id, job.id, SUPPORT_OPS_EXECUTE_JOB_TYPE, now - LEASE_SECONDS, now]
  );
  if (claim.rowsAffected !== 1) return;
  const holds =
    "tenant_id=? AND id=? AND status='processing' AND json_extract(progress,'$.run_id')=?";
  const identity = [job.tenant_id, job.id, owner];
  let progress: Progress | null = null;
  let config: Config | null = null;
  const save = async (
    status: 'pending' | 'completed' | 'failed' | 'processing' = 'processing',
    error: string | null = null,
    delay = 0
  ) => {
    take(1, true);
    const stamp = Math.floor(Date.now() / 1000);
    const result = await db.execute(
      `UPDATE admin_jobs SET progress=COALESCE(?,progress),status=?,
      updated_at=CASE WHEN updated_at>? THEN updated_at ELSE ? END,error_message=?,
      next_run_at=?,completed_at=CASE WHEN ? IN('completed','failed') THEN ? ELSE NULL END WHERE ${holds}`,
      [
        progress ? JSON.stringify(progress) : null,
        status,
        stamp,
        stamp,
        error,
        delay ? stamp + delay : null,
        status,
        stamp,
        ...identity,
      ]
    );
    if (result.rowsAffected !== 1) throw new LostClaim();
  };
  const heartbeat = async () => {
    take(1);
    const stamp = Math.floor(Date.now() / 1000);
    const result = await db.execute(
      `UPDATE admin_jobs SET updated_at=CASE WHEN updated_at>? THEN updated_at ELSE ? END WHERE ${holds}`,
      [stamp, stamp, ...identity]
    );
    if (result.rowsAffected !== 1) throw new LostClaim();
  };
  const effect = async <T>(cost: number, work: () => Promise<T>): Promise<T> => {
    take(cost + 1);
    budget.remaining += 1;
    await heartbeat();
    return work();
  };
  try {
    take(1);
    const row = await db.queryOne<{
      config: string;
      progress: string;
      created_at: number;
      attempt_count: number;
      max_attempts: number;
    }>(
      'SELECT config,progress,created_at,attempt_count,COALESCE(max_attempts,3) AS max_attempts FROM admin_jobs WHERE tenant_id=? AND id=?',
      [job.tenant_id, job.id],
      { consistencyClass: 'primary_required' }
    );
    if (!row) throw new LostClaim();
    config = parse<Config>(row.config);
    progress = parse<Progress>(row.progress);
    progress.run_id = owner;
    if (
      typeof config.action_id !== 'string' ||
      typeof config.cohort_id !== 'string' ||
      !config.actor ||
      !Number.isSafeInteger(config.source_version_ms) ||
      config.source_version_ms < 1 ||
      !Number.isSafeInteger(progress.processed) ||
      !Number.isSafeInteger(progress.succeeded)
    )
      throw new Error('support_ops_job_state_invalid');
    const jobConfig = config;
    // Resolver work has its own bounded inventory. This budget counts the explicit job SQL and DO RPCs.
    take(1);
    const stores = await supportOpsStoresFromEnv(env, job.tenant_id);
    assertSupportOpsStoreUnchanged(config.metadata_identity, stores.metadataIdentity);
    take(stores.accounts.length);
    await preflightSupportOpsExecutionStores(stores);
    take(1);
    const action = await stores.metadata.queryOne<{
      status: string;
      resource: string;
      action: string;
      result_summary_json: string | null;
    }>(
      'SELECT status,resource,action,result_summary_json FROM support_operation_actions WHERE tenant_id=? AND id=? AND cohort_id=?',
      [job.tenant_id, config.action_id, config.cohort_id],
      { consistencyClass: 'primary_required' }
    );
    const bound = action
      ? parse<Record<string, unknown>>(action.result_summary_json ?? '{}').job_id
      : null;
    // Job INSERT precedes the action CAS. A legitimate enqueue can still be between those writes.
    if (action?.status === 'approved' && !progress.active) {
      if (now - row.created_at <= 600) return await save('pending', null, 60);
      progress.outcome ??= {
        status: 'failed',
        error: 'action_not_started',
        decided_at: Date.now(),
      };
    }
    const boundAction =
      !!action && bound === job.id && action.resource === 'User' && action.action === 'suspend';
    if (!boundAction && !progress.active) {
      progress.outcome ??= { status: 'failed', error: 'job_not_bound', decided_at: Date.now() };
    }
    let targetsLeft = Math.min(limits.maxTargetsPerRun ?? 100, 1000);
    while (true) {
      if (progress.active) {
        const active = progress.active;
        const store = stores.accounts.find((candidate) => candidate.key === active.store_key);
        if (!store) throw new Error('support_ops_active_store_unavailable');
        assertSupportOpsStoreUnchanged(active.store_identity, store.identity);
        const mutation: SupportOpsAccountMutation = {
          tenantId: job.tenant_id,
          actionId: config.action_id,
          accountId: active.account_id,
          userId: active.target_id,
          operationId: active.operation_id,
          sourceVersionMs: config.source_version_ms,
          actorId: config.executor,
        };
        const rpc = getSessionRevocationStore(env, job.tenant_id, active.target_id);
        let lease: Awaited<ReturnType<typeof rpc.beginSupportOpsSuspensionRpc>> | null = null;
        if (active.account_result === undefined) {
          try {
            const recorded = await effect(1, () =>
              readSupportOpsAccountResult(store.adapter, mutation)
            );
            if (recorded !== null) {
              active.account_result = recorded;
              await save();
            }
          } catch (error) {
            if (error instanceof YieldRun || error instanceof LostClaim) throw error;
            // A read outage is unknown, never evidence that the original mutation was skipped.
          }
        }
        let lifecycleSuperseded = false;
        if (!active.transferred || active.account_result === undefined) {
          try {
            lease = await effect(1, () =>
              rpc.beginSupportOpsSuspensionRpc(
                job.tenant_id,
                active.target_id,
                `account:${active.target_id}`,
                jobConfig.source_version_ms,
                active.operation_id,
                owner,
                Date.now()
              )
            );
          } catch (error) {
            if (error instanceof YieldRun || error instanceof LostClaim) throw error;
            // Existing same-op receipts are replayed before these lifecycle checks. These errors
            // therefore prove this op did not create a receipt; unknown/missing/busy never skip.
            if (
              !(error instanceof Error) ||
              ![
                'account_authentication_lifecycle_stale',
                'account_authentication_lifecycle_conflict',
                'account_authentication_lifecycle_terminal',
              ].includes(error.message)
            )
              throw error;
            lifecycleSuperseded = true;
            active.transferred = { sequence: 0 };
            active.receipt_completed = true;
            await save();
          }
        }
        if (active.account_result === undefined) {
          // Results survive a lost DB response and later lifecycle changes, independently of DO drain.
          const current = lease?.currentState;
          if (!current && !lifecycleSuperseded)
            throw new Error('support_ops_account_lifecycle_unknown');
          const apply =
            !!current &&
            current.lifecycleVersionMs === config.source_version_ms &&
            current.lifecycleOperationId === active.operation_id &&
            current.lifecycle === 'suspended';
          try {
            active.account_result = await effect(6, () =>
              suspendSupportOpsAccountOnce(store.adapter, mutation, apply, startedMs, deadline)
            );
            await save();
          } catch (error) {
            if (error instanceof YieldRun || error instanceof LostClaim) throw error;
            // Transfer sessions even while the account DB/result is unavailable; reconcile it later.
            logger?.error('Support Ops account result deferred', { job_id: job.id });
          }
        }
        if (!active.transferred) {
          if (!lease) throw new Error('support_ops_receipt_missing');
          const boundLease = lease;
          while (true) {
            const page = await effect(1, () =>
              rpc.readSupportOpsSuspensionReceiptRpc(
                job.tenant_id,
                active.target_id,
                `account:${active.target_id}`,
                active.operation_id,
                owner,
                boundLease.fence,
                Date.now()
              )
            );
            if (page.stage === 'drained' || page.stage === 'complete') {
              active.transferred = { sequence: page.sequence };
              // Durable Admin proof precedes the completion ACK that permits receipt replacement.
              await save();
              break;
            }
            if (page.sessionIds.length === 0) continue;
            await effect(2, () =>
              keepSupportOpsLogoutPage(
                db,
                {
                  jobId: job.id,
                  tenantId: job.tenant_id,
                  actionId: jobConfig.action_id,
                  accountId: active.account_id,
                  userId: active.target_id,
                  operationId: active.operation_id,
                  sourceVersionMs: jobConfig.source_version_ms,
                  sequence: page.sequence,
                  sessionIds: page.sessionIds,
                  executor: jobConfig.executor,
                },
                heartbeat
              )
            );
            await effect(1, () =>
              rpc.acknowledgeSupportOpsSuspensionReceiptRpc(
                job.tenant_id,
                active.target_id,
                `account:${active.target_id}`,
                active.operation_id,
                owner,
                boundLease.fence,
                page.sequence,
                Date.now()
              )
            );
          }
        }
        const transferred = active.transferred;
        if (!transferred) throw new Error('support_ops_transfer_unconfirmed');
        if (active.account_result === undefined)
          throw new Error('support_ops_account_result_pending');
        // Completion permits a newer op to replace the DO receipt. Keep the current receipt
        // replayable until the exact Core outcome and its Admin copy have both been confirmed.
        take(1);
        const transferredProof = await db.queryOne<{ progress: string }>(
          `SELECT progress FROM admin_jobs WHERE ${holds}`,
          identity,
          { consistencyClass: 'primary_required' }
        );
        const transferredActive = transferredProof
          ? parse<Progress>(transferredProof.progress).active
          : undefined;
        if (
          !transferredActive ||
          transferredActive.operation_id !== active.operation_id ||
          transferredActive.account_id !== active.account_id ||
          transferredActive.target_id !== active.target_id ||
          transferredActive.account_result !== active.account_result ||
          transferredActive.transferred?.sequence !== transferred.sequence
        )
          throw new Error('support_ops_admin_result_unconfirmed');
        if (!active.receipt_completed) {
          if (!lease) {
            try {
              lease = await effect(1, () =>
                rpc.beginSupportOpsSuspensionRpc(
                  job.tenant_id,
                  active.target_id,
                  `account:${active.target_id}`,
                  jobConfig.source_version_ms,
                  active.operation_id,
                  owner,
                  Date.now()
                )
              );
            } catch (error) {
              if (error instanceof YieldRun || error instanceof LostClaim) throw error;
            }
          }
          // A replaced receipt requires no mutation; the DO verifies that replacement is newer.
          await effect(1, () =>
            rpc.completeSupportOpsSuspensionReceiptRpc(
              job.tenant_id,
              active.target_id,
              `account:${active.target_id}`,
              jobConfig.source_version_ms,
              active.operation_id,
              owner,
              lease?.fence ?? 0,
              transferred.sequence,
              Date.now()
            )
          );
          active.receipt_completed = true;
          await save();
        }
        // Confirm the exact persisted Admin outcome before allowing its Core evidence to expire.
        take(1);
        const proof = await db.queryOne<{ progress: string }>(
          `SELECT progress FROM admin_jobs WHERE ${holds}`,
          identity,
          { consistencyClass: 'primary_required' }
        );
        const durable = proof ? parse<Progress>(proof.progress).active : undefined;
        if (
          !durable ||
          durable.operation_id !== active.operation_id ||
          durable.account_id !== active.account_id ||
          durable.target_id !== active.target_id ||
          durable.account_result !== active.account_result ||
          durable.receipt_completed !== true
        )
          throw new Error('support_ops_admin_result_unconfirmed');
        await effect(2, () =>
          acknowledgeSupportOpsAccountResult(store.adapter, mutation, Date.now())
        );
        await effect(1, () =>
          cleanupSupportOpsAccountResultReceipts(store.adapter, Date.now(), 25)
        );
        progress.processed += 1;
        progress.succeeded += active.account_result;
        progress.last_target_id = active.target_id;
        delete progress.active;
        await save();
        targetsLeft -= 1;
        if (targetsLeft <= 0) return await save('pending');
        continue;
      }
      if (progress.outcome) {
        const outcome = progress.outcome;
        progress.stage = 'finalizing';
        await save();
        const summary = {
          job_id: job.id,
          matched_count: config.matched_count,
          attempted_count: config.actionable_count,
          succeeded_count: progress.succeeded,
          failed_count: Math.max(0, config.actionable_count - progress.succeeded),
          blocked_count: config.blocked_count,
          ...(progress.outcome.error ? { error: progress.outcome.error } : {}),
        };
        if (boundAction && action?.status === 'running') {
          await effect(1, () =>
            stores.metadata.execute(
              `UPDATE support_operation_actions SET status=?,result_summary_json=?,updated_at=MAX(updated_at,?)
            WHERE tenant_id=? AND id=? AND status='running' AND json_extract(result_summary_json,'$.job_id')=?`,
              [
                outcome.status,
                JSON.stringify(summary),
                Date.now(),
                job.tenant_id,
                jobConfig.action_id,
                job.id,
              ]
            )
          );
        }
        if (boundAction) {
          take(1);
          const confirmed = await stores.metadata.queryOne<{
            status: string;
            result_summary_json: string;
          }>(
            'SELECT status,result_summary_json FROM support_operation_actions WHERE tenant_id=? AND id=?',
            [job.tenant_id, config.action_id],
            { consistencyClass: 'primary_required' }
          );
          if (
            !confirmed ||
            confirmed.status !== progress.outcome.status ||
            confirmed.result_summary_json !== JSON.stringify(summary)
          )
            throw new Error('support_ops_action_completion_unconfirmed');
        }
        const resource = getSupportOpsResource('User');
        if (!resource) throw new Error('support_ops_resource_missing');
        await effect(16, () =>
          keepSupportOpsFinalAudit(
            env,
            db,
            {
              tenantId: job.tenant_id,
              actionId: jobConfig.action_id,
              jobId: job.id,
              decidedAtMs: outcome.decided_at,
              result: outcome.status === 'completed' ? 'success' : 'failure',
              actor: jobConfig.actor,
              summary: redactResultSummary(
                resource,
                summary,
                jobConfig.matched_count,
                jobConfig.actionable_count,
                jobConfig.blocked_count
              ),
            },
            heartbeat
          )
        );
        progress.stage = progress.outcome.status;
        return await save(progress.outcome.status, progress.outcome.error ?? null);
      }
      take(1);
      const size = progress.stage === 'verifying' ? Math.min(limits.pageSize ?? 100, 100) : 1;
      const page = await stores.metadata.query<{ target_id: string }>(
        `SELECT target_id FROM support_operation_cohort_targets
        WHERE tenant_id=? AND cohort_id=? AND block_reason IS NULL AND target_id>?
        ORDER BY target_id LIMIT ?`,
        [job.tenant_id, config.cohort_id, progress.last_target_id, size]
      );
      if (page.length === 0) {
        if (progress.stage === 'verifying') {
          progress.stage = 'executing';
          progress.last_target_id = '';
          await save();
          continue;
        }
        progress.outcome = { status: 'completed', decided_at: Date.now() };
        await save();
        continue;
      }
      take(stores.accounts.length);
      let holders: Map<string, string[]>;
      try {
        holders = await accountsByStore(
          stores.accounts,
          job.tenant_id,
          page.map((row) => row.target_id)
        );
      } catch (error) {
        if (!(error instanceof SupportOpsAmbiguousAccountError)) throw error;
        progress.outcome = {
          status: 'failed',
          error: 'account_store_ambiguous',
          decided_at: Date.now(),
        };
        await save();
        continue;
      }
      if (progress.stage === 'verifying') {
        progress.last_target_id = page[page.length - 1].target_id;
        await save();
        continue;
      }
      const target = page[0].target_id;
      const holder = stores.accounts.find((store) => holders.get(store.key)?.includes(target));
      if (!holder) {
        progress.processed += 1;
        progress.last_target_id = target;
        await save();
        continue;
      }
      // No DO mutation has been attempted for this target yet. Unsupported receipt stores fail closed.
      take(2);
      await assertSupportOpsAccountReceiptStore(holder.adapter);
      const found = await holder.adapter.query<{ id: string }>(
        `SELECT id FROM identity_accounts
        WHERE tenant_id=? AND legacy_user_id=? AND deleted_at IS NULL ORDER BY id LIMIT 2`,
        [job.tenant_id, target],
        { consistencyClass: 'primary_required' }
      );
      if (found.length !== 1) throw new Error('support_ops_account_identity_ambiguous');
      assertSupportOpsStoreIdentity(holder.identity);
      progress.active = {
        target_id: target,
        account_id: found[0].id,
        store_key: holder.key,
        // All identities were validated before executing any target in this run.
        store_identity: { ...holder.identity },
        operation_id: await supportOpsEvidenceId(
          'suspend',
          job.tenant_id,
          config.action_id,
          found[0].id,
          target,
          String(config.source_version_ms)
        ),
      };
      await save();
    }
  } catch (error) {
    if (error instanceof LostClaim) return;
    if (error instanceof YieldRun) {
      await save('pending');
      return;
    }
    logger?.error('Support Ops execute job deferred', { job_id: job.id });
    take(1, true);
    const current = await db.queryOne<{ attempt_count: number; max_attempts: number }>(
      `SELECT attempt_count,COALESCE(max_attempts,3) AS max_attempts FROM admin_jobs WHERE ${holds}`,
      identity
    );
    if (!current) return;
    if (progress && !progress.outcome && current.attempt_count + 1 >= current.max_attempts) {
      progress.outcome = {
        status: 'failed',
        error: 'execute_attempts_exhausted',
        decided_at: Date.now(),
      };
      // Active receipt/result reconciliation always precedes terminal failure.
      if (!progress.active) progress.stage = 'finalizing';
    }
    take(1, true);
    await db.execute(
      `UPDATE admin_jobs SET status='pending',progress=COALESCE(?,progress),attempt_count=attempt_count+1,
      next_run_at=?+MIN((attempt_count+1)*300,3600),updated_at=MAX(updated_at,?),error_message='execute_job_run_failed' WHERE ${holds}`,
      [
        progress ? JSON.stringify(progress) : null,
        Math.floor(Date.now() / 1000),
        Math.floor(Date.now() / 1000),
        ...identity,
      ]
    );
  }
}
/** Inline uses the exact durable state machine. Exhausted budget leaves a resumable 202 job. */
export async function processSupportOpsExecuteJobInline(
  env: Env,
  tenantId: string,
  jobId: string,
  limits: SupportOpsExecuteRunLimits = {}
): Promise<void> {
  const db = requireDedicatedAdminDatabaseAdapter(env, 'support-ops-execute-inline');
  await run(env, db, { id: jobId, tenant_id: tenantId }, limits, {
    remaining: limits.maxCallsPerRun ?? 100,
  });
}
export async function processPendingSupportOpsExecuteJobs(
  env: Env,
  logger?: Logger,
  limits: SupportOpsExecuteRunLimits = {},
  shared?: SupportOpsRunBudget
): Promise<void> {
  const budget = {
    remaining: Math.max(0, Math.min(limits.maxCallsPerRun ?? 600, shared?.remaining ?? Infinity)),
  };
  const started = budget.remaining;
  try {
    if (budget.remaining <= RESERVE * 2) return;
    const db = requireDedicatedAdminDatabaseAdapter(env, 'support-ops-execute-jobs');
    budget.remaining -= 1;
    const now = Math.floor(Date.now() / 1000);
    const jobs = await db.query<{ id: string; tenant_id: string }>(
      `SELECT id,tenant_id FROM admin_jobs
      WHERE job_type=? AND(status='pending' OR(status='processing' AND updated_at<?))
        AND(next_run_at IS NULL OR next_run_at<=?) ORDER BY created_at,id LIMIT 3`,
      [SUPPORT_OPS_EXECUTE_JOB_TYPE, now - LEASE_SECONDS, now]
    );
    for (const job of jobs) {
      if (budget.remaining <= RESERVE * 2) break;
      try {
        await run(env, db, job, limits, budget, logger);
      } catch {
        logger?.error('Support Ops claim deferred', { job_id: job.id });
      }
    }
  } finally {
    if (shared) shared.remaining -= started - budget.remaining;
  }
}
