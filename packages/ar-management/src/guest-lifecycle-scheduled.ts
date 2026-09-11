import {
  CanonicalIdentityRepository,
  CanonicalRuntimeUserWriter,
  GuestLifecycleRepository,
  GuestUpgradeRepository,
  validateAccountDirectoryPublication,
  createAuditLog,
  ensureDatabaseAdapter,
  invalidateUserCache,
  getSessionRevocationStore,
  resolveAccountDataContext,
  resolveTenantDatabaseSourceFromRegistry,
  transitionAccountAuthenticationState,
  type AccountDirectoryPublication,
  type AccountRouteProjection,
  type DatabaseAdapter,
  type Env,
  type GuestLifecycleRow,
  type GuestUpgradeOperation,
} from '@authrim/ar-lib-core';
import { recoverAccountGuestUpgrade } from './account-guest-upgrade';
import { findActiveAccountLegalHold } from './account-legal-hold-guard';
import {
  prepareAccountDirectoryRemoval,
  eraseAccountPiiAfterDirectoryRemovalPrepared,
  markAccountDirectoryRemovalsReady,
  attemptImmediateAccountDirectoryRemovals,
} from './account-directory-removal-producer';
import { InitialAccountIdentifierReservationService } from './account-directory-reservation';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';

export interface GuestDeletionRoute {
  schemaVersion: 1;
  tenantId: string;
  userId: string;
  coreBindingRef: string;
  piiBindingRef: string;
  piiResidencyPartition: string;
  routeProjection: AccountRouteProjection;
  completionAuditMode?: 'outbox';
}
export interface GuestMaintenanceTarget {
  tenantId: string;
  adapters: Array<{ adapter: DatabaseAdapter; bindingRef: string }>;
}
interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

function maintenanceErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9][a-z0-9_.:-]{0,127}$/u.test(message)
    ? message
    : 'guest_maintenance_internal_error';
}

function readRoute(
  json: string | null,
  tenantId: string,
  userId: string,
  coreBindingRef: string
): GuestDeletionRoute {
  const route = JSON.parse(json ?? 'null') as GuestDeletionRoute | null;
  if (
    !route ||
    route.schemaVersion !== 1 ||
    route.tenantId !== tenantId ||
    route.userId !== userId ||
    route.coreBindingRef !== coreBindingRef ||
    typeof route.piiBindingRef !== 'string' ||
    !route.piiBindingRef ||
    typeof route.piiResidencyPartition !== 'string' ||
    (route.completionAuditMode !== undefined && route.completionAuditMode !== 'outbox') ||
    !route.routeProjection
  )
    throw new Error('guest_deletion_route_invalid');
  return route;
}

export async function createGuestDeletionRoute(
  env: Env,
  input: {
    tenantId: string;
    userId: string;
    completionAuditMode?: 'outbox';
  }
): Promise<GuestDeletionRoute> {
  const account = await resolveAccountDataContext(env, {
    tenantId: input.tenantId,
    accountId: input.userId,
  });
  if (account.tenantId !== input.tenantId || account.legacyUserId !== input.userId)
    throw new Error('guest_deletion_account_route_changed');
  return {
    schemaVersion: 1,
    tenantId: input.tenantId,
    userId: input.userId,
    coreBindingRef: account.coreBindingRef,
    piiBindingRef: account.piiBindingRef,
    piiResidencyPartition: account.piiResidencyPartition,
    routeProjection: account.membership.routeProjection,
    ...(input.completionAuditMode ? { completionAuditMode: input.completionAuditMode } : {}),
  };
}

/** Remove reservations made by verified attempts that lost to deletion; never remove another owner. */
async function releaseUncommittedReservations(
  env: Env,
  pii: DatabaseAdapter,
  route: GuestDeletionRoute
): Promise<void> {
  const operations = await pii.query<GuestUpgradeOperation>(
    `SELECT * FROM guest_upgrade_operations WHERE tenant_id = ? AND user_id = ? AND state = 'verified'`,
    [route.tenantId, route.userId],
    { consistencyClass: 'primary_required' }
  );
  if (!operations.length) return;
  const reservations = new InitialAccountIdentifierReservationService({
    lookupForBucket: await createLookupBucketWriteResolver(env),
    now: () => Math.floor(Date.now() / 1000),
  });
  for (const operation of operations) {
    if (operation.reservation_publication_json)
      await reservations.release(
        await validateAccountDirectoryPublication(
          JSON.parse(operation.reservation_publication_json) as AccountDirectoryPublication
        )
      );
  }
}

export async function deleteOneGuestAccount(
  env: Env,
  input: {
    tenantId: string;
    core: DatabaseAdapter;
    coreBindingRef: string;
    candidate: GuestLifecycleRow;
    now: number;
  }
): Promise<'deleted' | 'skipped' | 'held'> {
  const { tenantId, core, coreBindingRef, now } = input;
  const lifecycle = new GuestLifecycleRepository(core, tenantId);
  let row = await lifecycle.get(input.candidate.user_id);
  if (!row || !['active', 'deleting'].includes(row.phase)) return 'skipped';
  if (await findActiveAccountLegalHold(core, tenantId, row.user_id)) return 'held';
  if (row.phase === 'active') {
    const route = await createGuestDeletionRoute(env, { tenantId, userId: row.user_id });
    if (route.coreBindingRef !== coreBindingRef)
      throw new Error('guest_deletion_account_route_changed');
    const identity = await core.queryOne<{ account_type: string; registration_state: string }>(
      'SELECT account_type, registration_state FROM identity_accounts WHERE tenant_id = ? AND legacy_user_id = ? AND deleted_at IS NULL',
      [tenantId, row.user_id],
      { consistencyClass: 'primary_required' }
    );
    if (identity?.account_type !== 'user' || identity.registration_state !== 'guest')
      return 'skipped';
    const operationId = `guest-delete:${crypto.randomUUID()}`;
    if (
      !(await lifecycle.beginDeletion(
        row.user_id,
        operationId,
        now,
        JSON.stringify(route),
        Date.now()
      ))
    )
      return 'skipped';
    row = (await lifecycle.get(row.user_id))!;
  }
  if (!row.deletion_operation_id || !row.deletion_started_at_ms)
    throw new Error('guest_deletion_operation_invalid');
  const route = readRoute(row.deletion_route_json, tenantId, row.user_id, coreBindingRef);
  // Resolve the persisted PII target through the tenant registry even after account lookup removal.
  const piiSource = await resolveTenantDatabaseSourceFromRegistry(env, {
    tenantId,
    role: 'tenant_pii',
    dataRole: 'tenant_pii',
    bindingRef: route.piiBindingRef,
    residencyPartition: route.piiResidencyPartition,
  });
  const pii = ensureDatabaseAdapter(piiSource.source, `guest-deletion:${route.piiBindingRef}`);
  const authentication = await getSessionRevocationStore(
    env,
    tenantId,
    row.user_id
  ).getAccountStateRpc(tenantId, row.user_id, `account:${row.user_id}`);
  const resumesAdministrativeTransition = route.completionAuditMode === 'outbox';
  if (authentication.lifecycle !== 'deleted')
    await transitionAccountAuthenticationState(env, {
      tenantId,
      userId: row.user_id,
      lifecycle: 'deleting',
      operationId: resumesAdministrativeTransition
        ? row.deletion_operation_id
        : `${row.deletion_operation_id}:begin`,
      sourceVersionMs: row.deletion_started_at_ms,
      revokeSessions: true,
    });
  const removals = await prepareAccountDirectoryRemoval(env, {
    tenantId,
    userId: row.user_id,
    core,
    pii,
  });
  await releaseUncommittedReservations(env, pii, route);
  await pii.execute(
    `UPDATE guest_upgrade_operations SET state = 'canceled', proof_payload_json = NULL, challenge_verifier = NULL, reservation_publication_json = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE tenant_id = ? AND user_id = ? AND state <> 'completed'`,
    [now, tenantId, row.user_id]
  );
  await eraseAccountPiiAfterDirectoryRemovalPrepared(pii, { tenantId, userId: row.user_id });
  await core.execute('DELETE FROM guest_devices WHERE tenant_id = ? AND user_id = ?', [
    tenantId,
    row.user_id,
  ]);
  await core.execute('DELETE FROM passkeys WHERE tenant_id = ? AND user_id = ?', [
    tenantId,
    row.user_id,
  ]);
  await new CanonicalRuntimeUserWriter(
    new CanonicalIdentityRepository(core, tenantId),
    pii
  ).deleteRuntimeUser(row.user_id);
  if (authentication.lifecycle !== 'deleted')
    await transitionAccountAuthenticationState(env, {
      tenantId,
      userId: row.user_id,
      lifecycle: 'deleted',
      operationId: resumesAdministrativeTransition
        ? row.deletion_operation_id
        : `${row.deletion_operation_id}:complete`,
      sourceVersionMs: row.deletion_started_at_ms + 1,
      revokeSessions: true,
    });
  await markAccountDirectoryRemovalsReady(core, removals);
  await attemptImmediateAccountDirectoryRemovals(env.ACCOUNT_DIRECTORY, removals);
  await invalidateUserCache(env, tenantId, row.user_id);
  if (route.completionAuditMode !== 'outbox') {
    await createAuditLog(env, {
      tenantId,
      userId: 'system',
      action: 'user.deleted',
      resource: 'user',
      resourceId: row.user_id,
      severity: 'info',
      ipAddress: 'system',
      userAgent: 'Authrim guest lifecycle',
      metadata: JSON.stringify({
        reason: 'guest_retention',
        operationId: row.deletion_operation_id,
      }),
    });
  }
  if (!(await lifecycle.completeDeletion(row.user_id, row.deletion_operation_id, now)))
    throw new Error('guest_deletion_completion_conflict');
  return 'deleted';
}

/** Core admission is fenced before erasing PII, including retention-disabled guests. */
export async function cleanupExpiredGuestProofs(
  env: Env,
  tenantId: string,
  core: DatabaseAdapter,
  coreBindingRef: string,
  userId: string,
  now: number
): Promise<void> {
  const account = await resolveAccountDataContext(env, { tenantId, accountId: userId });
  if (
    account.tenantId !== tenantId ||
    account.legacyUserId !== userId ||
    account.coreBindingRef !== coreBindingRef
  )
    throw new Error('guest_proof_cleanup_route_mismatch');
  const lifecycle = new GuestLifecycleRepository(core, tenantId);
  const piiSource = await resolveTenantDatabaseSourceFromRegistry(env, {
    tenantId,
    role: 'tenant_pii',
    dataRole: 'tenant_pii',
    bindingRef: account.piiBindingRef,
    residencyPartition: account.piiResidencyPartition,
  });
  const operations = new GuestUpgradeRepository(
    ensureDatabaseAdapter(piiSource.source, `guest-proof:${account.piiBindingRef}`),
    tenantId
  );
  for (const operation of await operations.listExpired(userId, now, 20)) {
    if (
      !(await lifecycle.fenceExpiredProof(
        userId,
        operation.operation_id,
        operation.expires_at,
        now
      ))
    )
      continue;
    if (operation.reservation_publication_json) {
      const publication = await validateAccountDirectoryPublication(
        JSON.parse(operation.reservation_publication_json) as AccountDirectoryPublication
      );
      if (publication.tenantId !== tenantId || publication.accountId !== account.accountId)
        throw new Error('guest_proof_cleanup_publication_mismatch');
      await new InitialAccountIdentifierReservationService({
        lookupForBucket: await createLookupBucketWriteResolver(env),
        now: () => now,
      }).release(publication);
    }
    await operations.eraseFencedProof(operation.operation_id, now);
  }
}

/** Uses the hourly maintenance inventory and its durable tenant cursor. Work is bounded per shard. */
export async function processGuestLifecycleMaintenance(
  env: Env,
  targets: GuestMaintenanceTarget[],
  log: Logger
): Promise<void> {
  let upgraded = 0;
  let deleted = 0;
  let failed = 0;
  const deadline = Date.now() + 20000;
  const config = env.AUTHRIM_CONFIG;
  if (!config) throw new Error('guest_maintenance_config_unavailable');
  const shards = targets.flatMap((target) =>
    target.adapters.map((source) => ({ ...source, tenantId: target.tenantId }))
  );
  if (!shards.length) return;
  const inventoryHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(shards.map((s) => `${s.tenantId}:${s.bindingRef}`).join('\n'))
      )
    ),
    (b) => b.toString(16).padStart(2, '0')
  ).join('');
  const cursorKey = `guest-maintenance-shard-cursor:${inventoryHash}`;
  const stored = Number(await config.get(cursorKey));
  const start = Number.isSafeInteger(stored) && stored >= 0 ? stored % shards.length : 0;
  for (let offset = 0; offset < shards.length && Date.now() < deadline; offset += 1) {
    const index = (start + offset) % shards.length;
    const { adapter, bindingRef, tenantId } = shards[index];
    // Persist before work so one slow or unavailable shard cannot starve the rest.
    await config.put(cursorKey, String((index + 1) % shards.length), { expirationTtl: 30 * 86400 });
    const target = { tenantId };
    try {
      const lifecycle = new GuestLifecycleRepository(adapter, target.tenantId);
      for (const row of await lifecycle.listProofCleanupCandidates(2)) {
        if (Date.now() >= deadline) break;
        try {
          const now = Math.floor(Date.now() / 1000);
          await lifecycle.recordMaintenanceAttempt(row.user_id, now);
          await cleanupExpiredGuestProofs(env, tenantId, adapter, bindingRef, row.user_id, now);
        } catch (error) {
          failed += 1;
          log.warn('Guest lifecycle proof cleanup failed', {
            tenantId,
            userId: row.user_id,
            bindingRef,
            errorCode: maintenanceErrorCode(error),
          });
        }
      }
      for (const row of await lifecycle.listUpgradeCandidates(10)) {
        if (Date.now() >= deadline) break;
        try {
          await lifecycle.recordMaintenanceAttempt(row.user_id, Math.floor(Date.now() / 1000));
          if (
            row.upgrade_operation_id &&
            (await recoverAccountGuestUpgrade(
              env,
              target.tenantId,
              row.user_id,
              row.upgrade_operation_id
            )) === 'completed'
          )
            upgraded += 1;
        } catch (error) {
          failed += 1;
          log.warn('Guest lifecycle upgrade recovery failed', {
            tenantId,
            userId: row.user_id,
            bindingRef,
            errorCode: maintenanceErrorCode(error),
          });
        }
      }
      for (const row of await lifecycle.listDeletionCandidates(Math.floor(Date.now() / 1000), 20)) {
        if (Date.now() >= deadline) break;
        const statusKey = `guest-maintenance-status:${tenantId}:${row.user_id}`;
        const status = async (state: 'processing' | 'pending' | 'completed' | 'retrying') => {
          // Observations are optional; Core state remains authoritative for retries.
          await config
            .put(
              statusKey,
              JSON.stringify({ state, attempted_at: Math.floor(Date.now() / 1000) }),
              { expirationTtl: 30 * 86400 }
            )
            .catch(() => undefined);
        };
        try {
          await status('processing');
          const now = Math.floor(Date.now() / 1000);
          await lifecycle.recordMaintenanceAttempt(row.user_id, now);
          const result = await deleteOneGuestAccount(env, {
            tenantId: target.tenantId,
            core: adapter,
            coreBindingRef: bindingRef,
            candidate: row,
            now,
          });
          if (result === 'deleted') deleted += 1;
          await status(result === 'deleted' ? 'completed' : 'pending');
        } catch (error) {
          failed += 1;
          log.warn('Guest lifecycle deletion failed', {
            tenantId,
            userId: row.user_id,
            bindingRef,
            errorCode: maintenanceErrorCode(error),
          });
          await status('retrying').catch(() => undefined);
        }
      }
    } catch (error) {
      failed += 1;
      log.warn('Guest lifecycle shard processing failed', {
        tenantId,
        bindingRef,
        errorCode: maintenanceErrorCode(error),
      });
    }
  }
  log.info('Guest lifecycle maintenance completed', { upgraded, deleted, failed });
  if (failed) log.warn('Guest lifecycle operations remain pending for retry', { failed });
}
