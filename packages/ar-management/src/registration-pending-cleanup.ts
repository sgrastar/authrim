/**
 * The clean-up of unfinished sign-ups (lite plan PR6b-2): the accounts a sign-up made before the
 * person proved anything (an email code sent, a passkey ceremony begun) and never finished,
 * marked in `account_registration_pending` (PR6b-1), are deleted once their mark's time is up.
 * Scheduled maintenance runs it every 6 hours for the page of tenants it visits, on each of their
 * core shards.
 *
 * - Each account is checked again first, on its own stores: one that has since been proven (a
 *   verified email, a passkey, an active authenticator, a sign-in, a linked provider), or that is
 *   no longer a registered person's, keeps its account and loses only its mark (the sign-up's own
 *   clear may have failed).
 * - It is then deleted by the shared saga (account-deletion.ts): its tombstone keeps no keyed
 *   fingerprint of the address (the person may sign up again), and the audit records the system
 *   with the reason, never the address.
 * - An account whose route was never published (its creation stopped before the directory
 *   published it, so no Lookup search finds it) is deleted on its creation's route once that
 *   creation has stood still for 3 hours: its operation is given up first, its removal releases
 *   what the creation reserved, and its Control allocation goes back while still only reserved (a
 *   committed one is counted in the run's log). One still moving is moved later (24 h).
 * - A held account and a failed attempt keep their mark, moved later (24 h, 6 h): the rows
 *   behind them get their turn, and nothing is retried in a loop. Each is counted, by reason, in
 *   the run's log.
 * - Per tenant: an off switch (on by default), at most so many deletions and so many seconds per
 *   run (KV, env, then conservative defaults).
 *
 * A sign-up finishing between the check and the deletion is not excluded by a lock: once the
 * deletion has moved the account to `deleting`, nothing writes it back (#758); the window is the
 * few milliseconds between them, 72 hours after the sign-up began.
 */
import {
  createAuditLog,
  ensureDatabaseAdapter,
  isDatabaseSource,
  resolveEffectiveSettings,
  type DatabaseAdapter,
  type Env,
  type Logger,
} from '@authrim/ar-lib-core';
import {
  resolveAuthCorePersistenceAdapterFromEnv,
  validateAccountDirectoryPublication,
  type AccountDirectoryPublication,
} from '@authrim/ar-lib-core';
import { AccountCreationOperationRepository } from './account-creation-operation';
import { findActiveAccountLegalHold } from './account-legal-hold-guard';
import { deleteAccount, type AccountDeletionSessionEnd } from './account-deletion';
import { releaseAbandonedAccountRouteAllocation } from './account-directory-producer';
import {
  AccountDeletionHeldError,
  hasUnfinishedAccountDeletion,
  prepareUnpublishedAccountDirectoryRemoval,
} from './account-directory-removal-producer';
import { CrossShardAccountExactSearchService } from './cross-shard-account-list';
import { auditSessionEndLogoutStarted, enqueueSessionEndLogout } from './session-end-logout';

const SETTINGS_ENABLED = 'account-lifecycle.registration.cleanup_enabled';
const SETTINGS_MAX = 'account-lifecycle.registration.cleanup_max_per_run';
const SETTINGS_BUDGET = 'account-lifecycle.registration.cleanup_time_budget_seconds';
/** Expired marks read per shard at a time. */
const PAGE_SIZE = 20;
/** Deletions this clean-up began (and must finish) read per shard at a time. */
const OWNED_PAGE_SIZE = 5;
const RETRY_FAILED_SECONDS = 6 * 3600;
const RETRY_HELD_SECONDS = 24 * 3600;
const RETRY_UNPUBLISHED_SECONDS = 24 * 3600;
/**
 * How long an unpublished account's creation must have stood still before it is given up: well
 * past the Lookup reservation's lease and the directory worker's retry budget (2 h each), and so
 * past any provisioning token's resume (5 min) and any re-send that moved it.
 */
const UNPUBLISHED_IDLE_SECONDS = 3 * 3600;
/** The whole run's time, whatever the tenants' own budgets (maintenance does other work too). */
const RUN_BUDGET_MS = 10_000;

export type RegistrationCleanupOutcome =
  | 'deleted'
  | 'deleted_unpublished'
  | 'completed'
  | 'not_registered'
  | 'already_deleted'
  | 'orphaned'
  | 'held'
  | 'route_unpublished'
  | 'route_unavailable'
  | 'failed';

export interface RegistrationCleanupTarget {
  tenantId: string;
  adapters: Array<{ adapter: DatabaseAdapter; bindingRef: string }>;
}

interface PendingRow {
  user_id: string;
  flow: string;
  /** 0 once this clean-up has begun the account's deletion (see beginDeletion). */
  created_at: number;
  expires_at: number;
}

interface AccountRow {
  id: string;
  registration_state: string | null;
  lifecycle_state: string | null;
  directory_publication_state: string | null;
  metadata_json: string | null;
  account_route_generation: number;
  /** Epoch milliseconds. */
  updated_at: number;
}

/** What a run counts besides its outcomes. */
interface RegistrationCleanupStats {
  /** Deleted unpublished accounts whose Control allocation stays (committed: never released). */
  allocationsCommitted: number;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // A code, never the message of a failure that might carry a value.
  return /^[a-z0-9_]{1,80}$/u.test(message) ? message : 'error';
}

function lastLoginAt(metadataJson: string | null): number | null {
  if (!metadataJson) return null;
  try {
    const value = (JSON.parse(metadataJson) as Record<string, unknown>).last_login_at;
    return typeof value === 'number' && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function exists(adapter: DatabaseAdapter, sql: string, params: unknown[]): Promise<boolean> {
  return (await adapter.queryOne<{ found: number }>(sql, params)) !== null;
}

/** Whether the account has been proven since its sign-up began (it is a person's now). */
async function proven(
  core: DatabaseAdapter,
  pii: DatabaseAdapter,
  tenantId: string,
  userId: string,
  account: AccountRow
): Promise<boolean> {
  if (lastLoginAt(account.metadata_json) !== null) return true;
  const checks = await Promise.all([
    exists(
      core,
      `SELECT 1 AS found FROM contact_points
        WHERE tenant_id = ? AND account_id = ? AND contact_type = 'email'
          AND verification_state = 'verified' LIMIT 1`,
      [tenantId, account.id]
    ),
    exists(core, 'SELECT 1 AS found FROM passkeys WHERE tenant_id = ? AND user_id = ? LIMIT 1', [
      tenantId,
      userId,
    ]),
    exists(
      core,
      `SELECT 1 AS found FROM totp_credentials
        WHERE tenant_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
      [tenantId, userId]
    ),
    exists(
      pii,
      'SELECT 1 AS found FROM linked_identities WHERE tenant_id = ? AND user_id = ? LIMIT 1',
      [tenantId, userId]
    ),
  ]);
  return checks.some(Boolean);
}

/**
 * The mark dropped, only as it was read: one another run has made its own meanwhile (its deletion
 * begun) is left to that run.
 */
async function dropMark(core: DatabaseAdapter, tenantId: string, row: PendingRow): Promise<void> {
  await core.execute(
    `DELETE FROM account_registration_pending
      WHERE tenant_id = ? AND user_id = ? AND created_at = ? AND expires_at = ?`,
    [tenantId, row.user_id, row.created_at, row.expires_at]
  );
}

/** Moves the mark later (its turn comes after the rows behind it), as long as it is the same. */
async function postpone(
  core: DatabaseAdapter,
  tenantId: string,
  row: PendingRow,
  nowSeconds: number,
  bySeconds: number
): Promise<void> {
  await core.execute(
    // Never one this clean-up's deletion owns (its decision time is its audit's).
    `UPDATE account_registration_pending SET expires_at = ?
      WHERE tenant_id = ? AND user_id = ? AND expires_at = ? AND created_at = ? AND created_at <> 0`,
    [nowSeconds + bySeconds, tenantId, row.user_id, row.expires_at, row.created_at]
  );
}

/** Ends the deleted account's sessions downstream (an unfinished sign-up normally has none). */
function systemSessionEnd(env: Env, tenantId: string, log: Logger): AccountDeletionSessionEnd {
  return async (operationId, work) => {
    const ended: Parameters<Parameters<AccountDeletionSessionEnd>[1]>[0] = [];
    try {
      return await work(ended);
    } finally {
      if (ended.length > 0) {
        const trigger = {
          action: 'user.deleted' as const,
          operationId,
          actorId: 'system:registration_cleanup',
        };
        try {
          const jobIds = await enqueueSessionEndLogout(env, {
            tenantId,
            sessions: ended,
            trigger,
          });
          await auditSessionEndLogoutStarted(env, {
            tenantId,
            sessions: ended,
            trigger,
            jobIds,
            log,
          });
        } catch (error) {
          log.error('Downstream logout of a cleaned-up sign-up not started', {
            error: errorCode(error),
          });
        }
      }
    }
  };
}

function routeAdapter(env: Env, bindingRef: string, partition: 'core' | 'pii'): DatabaseAdapter {
  const source = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!isDatabaseSource(source)) throw new Error('registration_cleanup_route_binding_unavailable');
  return ensureDatabaseAdapter(source, `registration-cleanup-${partition}`);
}

/** The audit of one unfinished sign-up's deletion: the system, the reason, never the address. */
async function auditDeletion(
  env: Env,
  tenantId: string,
  row: PendingRow,
  decidedAtSeconds: number
): Promise<void> {
  await createAuditLog(env, {
    // One per account, the same each time it is sent again after a failure (its time is when the
    // deletion was decided, kept in the mark).
    id: `registration-cleanup:${row.user_id}`.slice(0, 200),
    createdAt: decidedAtSeconds * 1000,
    tenantId,
    userId: 'system',
    action: 'user.deleted',
    resource: 'user',
    resourceId: row.user_id,
    severity: 'info',
    ipAddress: 'system',
    userAgent: 'Authrim registration clean-up',
    metadata: JSON.stringify({
      actor: 'system',
      reason: 'registration_abandoned',
      flow: row.flow,
    }),
  });
}

/**
 * Marks the account's deletion as this clean-up's, before it begins: `created_at` 0 (a mark is
 * never made at 0), `expires_at` the time it was decided (kept: its audit's time). From then on
 * the deletion is resumed and audited by this clean-up only; another's (an administrator's,
 * SCIM's) is never taken over. Whether the mark was still the one read.
 */
async function beginDeletion(
  core: DatabaseAdapter,
  tenantId: string,
  row: PendingRow,
  nowSeconds: number
): Promise<boolean> {
  const result = await core.execute(
    `UPDATE account_registration_pending SET created_at = 0, expires_at = ?
      WHERE tenant_id = ? AND user_id = ? AND created_at = ? AND expires_at = ?`,
    [nowSeconds, tenantId, row.user_id, row.created_at, row.expires_at]
  );
  return result.rowsAffected === 1;
}

/** A deletion refused before anything changed (a hold): no longer this clean-up's, moved later. */
async function abandonDeletion(
  core: DatabaseAdapter,
  tenantId: string,
  row: PendingRow,
  nowSeconds: number,
  bySeconds: number
): Promise<void> {
  await core.execute(
    `UPDATE account_registration_pending SET created_at = ?, expires_at = ?
      WHERE tenant_id = ? AND user_id = ? AND created_at = 0`,
    [nowSeconds, nowSeconds + bySeconds, tenantId, row.user_id]
  );
}

/**
 * One expired mark: the account checked again, then deleted, kept or postponed. `startDeletion`
 * takes one of the run's deletions when the saga starts (a deletion that fails after it has
 * begun counts all the same).
 */
async function cleanUpOne(
  env: Env,
  tenantId: string,
  shard: { adapter: DatabaseAdapter; bindingRef: string },
  row: PendingRow,
  nowSeconds: number,
  log: Logger,
  startDeletion: () => boolean,
  stats: RegistrationCleanupStats
): Promise<RegistrationCleanupOutcome | 'limit'> {
  const core = shard.adapter;
  const account = await core.queryOne<AccountRow>(
    `SELECT id, registration_state, lifecycle_state, directory_publication_state, metadata_json,
            account_route_generation, updated_at
       FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ?`,
    [tenantId, row.user_id]
  );
  if (!account) {
    await dropMark(core, tenantId, row);
    return 'orphaned';
  }
  const ours = row.created_at === 0;
  const removed = account.lifecycle_state === 'deleting' || account.lifecycle_state === 'deleted';
  if (removed && !ours) {
    // Another deletion's (an administrator's, SCIM's): its own owner and reason, its own retry.
    await dropMark(core, tenantId, row);
    return 'already_deleted';
  }
  const unfinished =
    account.lifecycle_state === 'deleting' ||
    (account.lifecycle_state === 'deleted' &&
      (await hasUnfinishedAccountDeletion(core, { tenantId, userId: row.user_id })));
  if (ours && account.lifecycle_state === 'deleted' && !unfinished) {
    // This clean-up's, finished before its audit was written (or its mark dropped): both now,
    // with an unpublished one's allocation.
    const creation = await unpublishedCreation(core, tenantId, account);
    if (creation) await releaseDeletedCreationAllocation(env, creation.publication, stats);
    await auditDeletion(env, tenantId, row, row.expires_at);
    await dropMark(core, tenantId, row);
    return 'deleted';
  }
  // This clean-up's deletion begun before is resumed as it was (nothing checked again).
  const resuming = ours && unfinished;
  if (!resuming && account.registration_state !== 'registered') {
    await dropMark(core, tenantId, row);
    return 'not_registered';
  }
  // A creation never published (the directory never had its route): deleted on its creation's
  // route, which no Lookup search can find, once it has stood still long enough.
  const creation = await unpublishedCreation(core, tenantId, account);
  if (
    creation &&
    (resuming ||
      account.directory_publication_state === 'pending' ||
      account.directory_publication_state === 'active_pending_directory')
  ) {
    return cleanUpUnpublished(env, {
      tenantId,
      shard,
      row,
      account,
      creation,
      resuming,
      nowSeconds,
      log,
      startDeletion,
      stats,
    });
  }
  const routes = await new CrossShardAccountExactSearchService(env).find({
    tenantId,
    identifier: row.user_id,
    purpose: 'account_delete_retry',
  });
  const route = routes.length === 1 && routes[0].legacyUserId === row.user_id ? routes[0] : null;
  if (!route || route.coreBindingRef !== shard.bindingRef) {
    if (!ours) await postpone(core, tenantId, row, nowSeconds, RETRY_UNPUBLISHED_SECONDS);
    return 'route_unavailable';
  }
  const pii = routeAdapter(env, route.piiBindingRef, 'pii');
  if (!resuming && account.directory_publication_state !== 'active') {
    if (ours) await abandonDeletion(core, tenantId, row, nowSeconds, RETRY_UNPUBLISHED_SECONDS);
    else await postpone(core, tenantId, row, nowSeconds, RETRY_UNPUBLISHED_SECONDS);
    return 'route_unpublished';
  }
  if (!resuming && (await proven(core, pii, tenantId, row.user_id, account))) {
    await dropMark(core, tenantId, row);
    return 'completed';
  }
  if (!startDeletion()) return 'limit';
  // The deletion is this clean-up's from here (its time decided now, kept for its audit).
  const decidedAt = ours ? row.expires_at : nowSeconds;
  if (!ours && !(await beginDeletion(core, tenantId, row, nowSeconds))) return 'route_unavailable';
  let deleted: Awaited<ReturnType<typeof deleteAccount>>;
  try {
    deleted = await deleteAccount(env, {
      tenantId,
      userId: row.user_id,
      core,
      pii,
      // No keyed fingerprint of the address: the person may sign up again with it.
      email: null,
      tombstone: {
        deletedBy: 'system',
        reason: 'registration_abandoned',
        metadata: { source: 'registration_cleanup', flow: row.flow },
      },
      endSessions: systemSessionEnd(env, tenantId, log),
    });
  } catch (error) {
    // A hold placed after the first check: refused by the prepared move, the account as it was.
    if (error instanceof AccountDeletionHeldError) deleted = { status: 'held', holdId: '' };
    else throw error;
  }
  if (deleted.status === 'held') {
    await abandonDeletion(core, tenantId, row, nowSeconds, RETRY_HELD_SECONDS);
    return 'held';
  }
  // The audit before the mark goes: a failure keeps the mark (this clean-up's), and the next run
  // writes the same audit.
  await auditDeletion(env, tenantId, row, decidedAt);
  await dropMark(core, tenantId, { ...row, created_at: 0, expires_at: decidedAt });
  return 'deleted';
}

/**
 * The account's creation, when its route was never published: its account_created publication
 * (on the account's own shard, for its route generation) that has not succeeded. Null when the
 * creation was published, or when there is no such row.
 */
async function unpublishedCreation(
  core: DatabaseAdapter,
  tenantId: string,
  account: AccountRow
): Promise<{ publication: AccountDirectoryPublication; leasedUntil: number | null } | null> {
  const row = await core.queryOne<{
    payload_json: string;
    status: string;
    lease_expires_at: number | null;
  }>(
    `SELECT payload_json, status, lease_expires_at FROM account_routing_outbox
      WHERE tenant_id = ? AND account_id = ? AND event_kind = 'account_created'
        AND route_generation = ?
      ORDER BY CASE status WHEN 'succeeded' THEN 0 ELSE 1 END, outbox_id
      LIMIT 1`,
    [tenantId, account.id, account.account_route_generation]
  );
  if (!row || row.status === 'succeeded') return null;
  const publication = await validateAccountDirectoryPublication(
    JSON.parse(row.payload_json) as AccountDirectoryPublication
  );
  if (publication.tenantId !== tenantId || publication.accountId !== account.id) {
    throw new Error('registration_cleanup_creation_mismatch');
  }
  return {
    publication,
    leasedUntil:
      row.status === 'leased' ? Number(row.lease_expires_at ?? Number.MAX_SAFE_INTEGER) : null,
  };
}

/**
 * An unfinished sign-up's account whose route was never published. Taken only when its creation
 * has stood still (its operation unmoved, or none, for UNPUBLISHED_IDLE_SECONDS, and not a
 * succeeded one): its operation is given up first (only as it was read, so a re-send that moved it
 * keeps it), then the account is deleted by the shared saga on its creation's route (the removal
 * prepared with the move to `deleting`, and only while no worker's live lease or a success stands
 * on its publication). Its Control allocation is released when still only reserved; a committed
 * one is counted.
 */
async function cleanUpUnpublished(
  env: Env,
  input: {
    tenantId: string;
    shard: { adapter: DatabaseAdapter; bindingRef: string };
    row: PendingRow;
    account: AccountRow;
    creation: { publication: AccountDirectoryPublication; leasedUntil: number | null };
    resuming: boolean;
    nowSeconds: number;
    log: Logger;
    startDeletion: () => boolean;
    stats: RegistrationCleanupStats;
  }
): Promise<RegistrationCleanupOutcome | 'limit'> {
  const { tenantId, shard, row, account, nowSeconds } = input;
  const creation = input.creation.publication;
  const core = shard.adapter;
  const ours = row.created_at === 0;
  const coreTarget = creation.routeProjection.targets.find(
    (target) => target.dataRole === 'tenant_core/users'
  );
  const piiTarget = creation.routeProjection.targets.find(
    (target) => target.dataRole === 'tenant_pii'
  );
  if (!coreTarget || !piiTarget || coreTarget.bindingRef !== shard.bindingRef) {
    if (!ours) await postpone(core, tenantId, row, nowSeconds, RETRY_UNPUBLISHED_SECONDS);
    return 'route_unavailable';
  }
  const pii = routeAdapter(env, piiTarget.bindingRef, 'pii');
  const operations = new AccountCreationOperationRepository(
    await resolveAuthCorePersistenceAdapterFromEnv(env, 'registration-cleanup-operation', {
      tenantId,
    })
  );
  if (!input.resuming) {
    const found = await operations.findByAccountId({ tenantId, accountId: account.id });
    const lastMoved = found ? found.updatedAt : Math.floor(Number(account.updated_at) / 1000);
    // This clean-up's deletion whose creation it already gave up (this run before, or another
    // run now): carried on, never handed back (another run may be in the middle of it).
    const givenUp =
      ours &&
      found?.operation.status === 'blocked' &&
      found.operation.lastErrorCode === 'registration_abandoned';
    if (
      !givenUp &&
      (found?.operation.status === 'succeeded' ||
        !Number.isSafeInteger(lastMoved) ||
        lastMoved > nowSeconds - UNPUBLISHED_IDLE_SECONDS ||
        // A worker publishing it now (its lease still running).
        (input.creation.leasedUntil !== null && input.creation.leasedUntil > nowSeconds))
    ) {
      // Still moving (or finished): the published path, or a later run, takes it. A deletion this
      // clean-up began is never handed back here (another run may be in the middle of it, having
      // given the creation up after this one read it): kept as it is, tried again.
      if (!ours) await postpone(core, tenantId, row, nowSeconds, RETRY_UNPUBLISHED_SECONDS);
      return 'route_unpublished';
    }
    if (!givenUp && (await proven(core, pii, tenantId, row.user_id, account))) {
      await dropMark(core, tenantId, row);
      return 'completed';
    }
    // A standing hold: nothing is given up (the saga checks again, for one placed later).
    if (await findActiveAccountLegalHold(core, tenantId, row.user_id)) {
      if (ours) await abandonDeletion(core, tenantId, row, nowSeconds, RETRY_HELD_SECONDS);
      else await postpone(core, tenantId, row, nowSeconds, RETRY_HELD_SECONDS);
      return 'held';
    }
    if (!input.startDeletion()) return 'limit';
    if (!ours && !(await beginDeletion(core, tenantId, row, nowSeconds))) {
      return 'route_unavailable';
    }
    // Given up before the account changes: a re-send acquiring it from now on is refused.
    if (
      found &&
      !(await operations.abandon({
        operation: found.operation,
        updatedAt: found.updatedAt,
        now: nowSeconds,
      }))
    ) {
      await abandonDeletion(core, tenantId, row, nowSeconds, RETRY_UNPUBLISHED_SECONDS);
      return 'route_unpublished';
    }
  } else if (!input.startDeletion()) {
    return 'limit';
  }
  const decidedAt = ours ? row.expires_at : nowSeconds;
  let deleted: Awaited<ReturnType<typeof deleteAccount>>;
  try {
    deleted = await deleteAccount(env, {
      tenantId,
      userId: row.user_id,
      core,
      pii,
      email: null,
      tombstone: {
        deletedBy: 'system',
        reason: 'registration_abandoned',
        metadata: { source: 'registration_cleanup', flow: row.flow, route: 'unpublished' },
      },
      endSessions: systemSessionEnd(env, tenantId, input.log),
      prepareRemoval: (removal) =>
        prepareUnpublishedAccountDirectoryRemoval(env, { ...removal, creation }, nowSeconds),
    });
  } catch (error) {
    if (error instanceof AccountDeletionHeldError) deleted = { status: 'held', holdId: '' };
    else throw error;
  }
  if (deleted.status === 'held') {
    // A hold placed since the check: the account stays, as the hold requires; its creation stays
    // given up (a creation under a hold is not resumed).
    await abandonDeletion(core, tenantId, row, nowSeconds, RETRY_HELD_SECONDS);
    return 'held';
  }
  await releaseDeletedCreationAllocation(env, creation, input.stats);
  await auditDeletion(env, tenantId, row, decidedAt);
  await dropMark(core, tenantId, { ...row, created_at: 0, expires_at: decidedAt });
  return 'deleted_unpublished';
}

/**
 * A deleted unpublished account's Control allocation, released while still only reserved (a
 * release is idempotent: a deletion finished again releases nothing more); a committed one, which
 * Control never releases, is counted.
 */
async function releaseDeletedCreationAllocation(
  env: Env,
  creation: AccountDirectoryPublication,
  stats: RegistrationCleanupStats
): Promise<void> {
  if ((await releaseAbandonedAccountRouteAllocation(env, creation)) === 'committed') {
    stats.allocationsCommitted++;
  }
}

async function tenantPolicy(
  env: Env,
  tenantId: string
): Promise<{ enabled: boolean; maxPerRun: number; budgetMs: number }> {
  const values = await resolveEffectiveSettings(env, 'account-lifecycle', {
    tenantId,
    fresh: true,
  });
  const max = values[SETTINGS_MAX];
  const budget = values[SETTINGS_BUDGET];
  return {
    enabled: values[SETTINGS_ENABLED] === true,
    maxPerRun:
      typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= 200 ? max : 20,
    budgetMs:
      (typeof budget === 'number' && Number.isInteger(budget) && budget >= 1 && budget <= 20
        ? budget
        : 5) * 1000,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * One run over the tenants maintenance visits now, on each of their core shards. Each run over
 * the same shards begins one further on (a cursor of its own, kept before the work), so the first
 * ones never take every run's time. Never throws: a tenant, a shard or a
 * row that fails is counted and the rest go on.
 */
export async function processRegistrationPendingCleanup(
  env: Env,
  targets: RegistrationCleanupTarget[],
  log: Logger,
  now: () => number = Date.now
): Promise<Record<RegistrationCleanupOutcome, number> & { skippedTenants: number }> {
  const counts = {
    deleted: 0,
    deleted_unpublished: 0,
    completed: 0,
    not_registered: 0,
    already_deleted: 0,
    orphaned: 0,
    held: 0,
    route_unpublished: 0,
    route_unavailable: 0,
    failed: 0,
    skippedTenants: 0,
  };
  const stats: RegistrationCleanupStats = { allocationsCommitted: 0 };
  const runDeadline = now() + RUN_BUDGET_MS;
  const shards = targets.flatMap((target) =>
    target.adapters.map((shard) => ({ tenantId: target.tenantId, shard }))
  );
  if (shards.length === 0) return counts;
  // Where to begin: the shard after the last one a run over the same ones reached.
  const cursorKey = `jobs:registration-cleanup:shard-cursor:${await sha256Hex(
    shards.map(({ tenantId, shard }) => `${tenantId}\u0000${shard.bindingRef}`).join('\u0001')
  )}`;
  // The runs over these shards, counted: each begins one shard on, its own begun deletions one
  // further on, and the two kinds of marks take turns to come first. Kept before the work: a slow
  // or failing shard or row never holds every run on itself.
  let runIndex = 0;
  try {
    const stored = Number.parseInt((await env.AUTHRIM_CONFIG?.get(cursorKey)) ?? '', 10);
    if (Number.isSafeInteger(stored) && stored >= 0) runIndex = stored;
  } catch {
    runIndex = 0;
  }
  const start = runIndex % shards.length;
  await env.AUTHRIM_CONFIG?.put(cursorKey, String((runIndex + 1) % Number.MAX_SAFE_INTEGER), {
    // Kept well past the longest round of the tenants (a page is visited again only after it).
    expirationTtl: 180 * 24 * 3600,
  }).catch(() => undefined);
  const policies = new Map<string, Awaited<ReturnType<typeof tenantPolicy>> | null>();
  const tenantDeadlines = new Map<string, number>();
  const deletions = new Map<string, number>();
  for (let step = 0; step < shards.length; step++) {
    if (now() >= runDeadline) break;
    const index = (start + step) % shards.length;
    const { tenantId, shard } = shards[index];
    if (!policies.has(tenantId)) {
      try {
        const policy = await tenantPolicy(env, tenantId);
        policies.set(tenantId, policy.enabled ? policy : null);
        if (!policy.enabled) counts.skippedTenants++;
        else tenantDeadlines.set(tenantId, Math.min(now() + policy.budgetMs, runDeadline));
      } catch (error) {
        policies.set(tenantId, null);
        counts.skippedTenants++;
        log.warn('Unfinished sign-up clean-up policy unreadable', { error: errorCode(error) });
      }
    }
    const policy = policies.get(tenantId);
    if (!policy) continue;
    const deadline = tenantDeadlines.get(tenantId) ?? runDeadline;
    const startDeletion = () => {
      const used = deletions.get(tenantId) ?? 0;
      // No deletion begins past the tenant's or the run's time, however long the checks took.
      if (used >= policy.maxPerRun || now() >= deadline) return false;
      deletions.set(tenantId, used + 1);
      return true;
    };
    if ((deletions.get(tenantId) ?? 0) >= policy.maxPerRun || now() >= deadline) continue;
    const nowSeconds = Math.floor(now() / 1000);
    let rows: PendingRow[];
    try {
      // Deletions this clean-up began first (they must be finished; their order never moves, so
      // a few at a time, from a place that moves on each run), then the expired marks apart from
      // them: one that keeps failing never keeps the rest from their turn.
      const owned = await shard.adapter.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM account_registration_pending
          WHERE tenant_id = ? AND created_at = 0`,
        [tenantId]
      );
      const ownedCount = Number(owned?.n ?? 0);
      const ownedRows =
        ownedCount > 0
          ? await shard.adapter.query<PendingRow>(
              `SELECT user_id, flow, created_at, expires_at FROM account_registration_pending
                WHERE tenant_id = ? AND created_at = 0
                ORDER BY expires_at, user_id LIMIT ? OFFSET ?`,
              [
                tenantId,
                OWNED_PAGE_SIZE,
                // One further on each time this shard's turn with them first comes round (once in
                // two rounds of the shards), so each is tried in turn however small the limit.
                Math.floor(runIndex / (2 * shards.length)) % ownedCount,
              ]
            )
          : [];
      const expired = await shard.adapter.query<PendingRow>(
        `SELECT user_id, flow, created_at, expires_at FROM account_registration_pending
          WHERE tenant_id = ? AND created_at <> 0 AND expires_at <= ?
          ORDER BY expires_at, user_id LIMIT ?`,
        [tenantId, nowSeconds, PAGE_SIZE]
      );
      // Taking turns, once per round of the shards (so a shard that comes first in a round comes
      // first with each kind in turn): a per-run limit too small for both still gives each its
      // turn.
      rows =
        Math.floor(runIndex / shards.length) % 2 === 0
          ? [...ownedRows, ...expired]
          : [...expired, ...ownedRows];
    } catch (error) {
      counts.failed++;
      log.warn('Unfinished sign-up marks unreadable', { error: errorCode(error) });
      continue;
    }
    for (const row of rows) {
      if ((deletions.get(tenantId) ?? 0) >= policy.maxPerRun || now() >= deadline) break;
      let outcome: RegistrationCleanupOutcome | 'limit';
      try {
        outcome = await cleanUpOne(
          env,
          tenantId,
          shard,
          row,
          nowSeconds,
          log,
          startDeletion,
          stats
        );
      } catch (error) {
        outcome = 'failed';
        log.warn('Unfinished sign-up not cleaned up', { error: errorCode(error) });
        await postpone(shard.adapter, tenantId, row, nowSeconds, RETRY_FAILED_SECONDS).catch(
          () => undefined
        );
      }
      if (outcome === 'limit') break;
      counts[outcome]++;
    }
  }
  if (Object.values(counts).some((count) => count > 0)) {
    log.info('Unfinished sign-up clean-up run', counts);
  }
  if (stats.allocationsCommitted > 0) {
    // Their capacity stays counted in Control: no release exists for a committed allocation.
    log.warn('Unpublished sign-up accounts deleted with their Control allocation kept', {
      allocationsCommitted: stats.allocationsCommitted,
    });
  }
  return counts;
}
