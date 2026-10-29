import { ACCOUNT_WEBHOOK_SNAPSHOT_RETENTION_MS } from '@authrim/ar-lib-core/services/account-webhook-snapshots';
import {
  GuestLifecycleRepository,
  GUEST_DELETION_STAGES,
  createAuditLog,
  createGuestDeletionProgress,
  getSessionRevocationStore,
  guestDirectoryRemovalOperationPrefix,
  forgetCachedAnonymizedUserId,
  invalidateUserCache,
  parseGuestDeletionProgress,
  transitionAccountAuthenticationState,
  type DatabaseAdapter,
  type Env,
  type GuestDeletionProgress,
  type GuestLifecycleRow,
} from '@authrim/ar-lib-core';
import { createGuestPiiErasurePort } from '@authrim/ar-lib-core/services/guest-pii-erasure';
import { requireCurrentGuestAccountProjection, sameGuestProjection } from './guest-account-lookup';
import { findActiveAccountLegalHold } from './account-legal-hold-guard';
import {
  findGuestCoreOwner,
  guestCoreStores,
  makeGuestDeletionRoute,
} from './guest-account-storage';
import {
  guestErasureBoundaryId,
  parseGuestDeletionRoute,
  verifyGuestDeletionPins,
  type GuestDeletionRouteV2,
} from './guest-deletion-route';
import {
  requireGuestErasureSourceReceipt,
  requireGuestErasureDrainReceipt,
  requireGuestErasureCompletionReceipt,
} from './guest-deletion-source-receipt';
import {
  captureGuestDirectoryPage,
  guestDirectoryCaptureKeys,
  releaseGuestReservationPage,
} from './account-directory-removal-producer';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';
import { requireGuestDeletionAuditTask } from './guest-deletion-audit-outbox';

export type GuestDeletionStepResult = 'deleted' | 'pending' | 'skipped' | 'held';
function requireAuthenticationProof(
  snapshot: Awaited<ReturnType<typeof transitionAccountAuthenticationState>>,
  route: GuestDeletionRouteV2,
  lifecycle: 'deleting' | 'deleted'
): void {
  const startedAt = route.execution.erasureStartedAtMs;
  if (
    startedAt === null ||
    snapshot?.lifecycle !== lifecycle ||
    snapshot.lifecycleOperationId !==
      `${route.operationId}:${lifecycle === 'deleted' ? 'complete' : 'begin'}` ||
    snapshot.lifecycleVersionMs !== startedAt + (lifecycle === 'deleted' ? 1 : 0)
  )
    throw new Error('guest_deletion_authentication_unverified');
}
function next(
  progress: GuestDeletionProgress,
  values: Partial<GuestDeletionProgress> = {},
  revisions = 1
): GuestDeletionProgress {
  return { ...progress, revision: progress.revision + revisions, ...values, corePermit: null };
}
function advance(progress: GuestDeletionProgress, revisions = 1): GuestDeletionProgress {
  const ordinal = GUEST_DELETION_STAGES.indexOf(progress.stage);
  if (ordinal < 0 || ordinal >= GUEST_DELETION_STAGES.length - 1)
    throw new Error('guest_deletion_progress_invalid');
  return next(
    progress,
    { stage: GUEST_DELETION_STAGES[ordinal + 1], sourceOrdinal: 0, cursor: null, highWater: null },
    revisions
  );
}
/** Existing webhook retention is fixed to B; a retry never creates a later seven-day window. */
async function captureGuestWebhook(
  pii: DatabaseAdapter,
  route: GuestDeletionRouteV2
): Promise<void> {
  const at = route.execution.erasureStartedAtMs;
  if (at === null) throw new Error('guest_deletion_source_unverified');
  const id = `account-deletion:${route.tenantId}:${route.userId}`;
  if (Date.now() >= at + ACCOUNT_WEBHOOK_SNAPSHOT_RETENTION_MS) {
    // The original event payload's window has elapsed. Never fetch or copy fresh PII to renew it.
    const prior = await pii.queryOne<{
      tenant_id: string;
      user_id: string;
      account_id: string;
      event_type: string;
      registration_state: string;
      created_at: number | string;
      expires_at: number | string;
    }>(
      `SELECT tenant_id,user_id,account_id,event_type,registration_state,created_at,expires_at FROM account_webhook_snapshots WHERE id=?`,
      [id],
      { consistencyClass: 'primary_required' }
    );
    if (
      prior &&
      (prior.tenant_id !== route.tenantId ||
        prior.user_id !== route.userId ||
        prior.account_id !== route.accountId ||
        prior.event_type !== 'account.deleted' ||
        prior.registration_state !== 'guest' ||
        Number(prior.created_at) !== at ||
        Number(prior.expires_at) !== at + ACCOUNT_WEBHOOK_SNAPSHOT_RETENTION_MS)
    )
      throw new Error('guest_deletion_snapshot_unverified');
    return;
  }
  await pii.execute(
    `INSERT INTO account_webhook_snapshots(id,tenant_id,user_id,account_id,event_type,registration_state,email_before_json,email_after_json,created_at,expires_at)
    SELECT ?,?,?,?,'account.deleted','guest',COALESCE((SELECT CAST(value_json AS TEXT) FROM identity_sensitive_values WHERE tenant_id=? AND owner_type='runtime_user' AND owner_id=? AND value_key='email' AND lifecycle_state='active'),'null'),'null',?,?
    ON CONFLICT(id) DO NOTHING`,
    [
      id,
      route.tenantId,
      route.userId,
      route.accountId,
      route.tenantId,
      route.userId,
      at,
      at + ACCOUNT_WEBHOOK_SNAPSHOT_RETENTION_MS,
    ]
  );
  const row = await pii.queryOne<{
    tenant_id: string;
    user_id: string;
    account_id: string;
    event_type: string;
    registration_state: string;
    created_at: number | string;
    expires_at: number | string;
    email_before_json: string | null;
    email_after_json: string | null;
    expected_before: string | null;
    before_bytes: number | string;
    after_bytes: number | string;
    expected_bytes: number | string;
  }>(
    `SELECT tenant_id,user_id,account_id,event_type,registration_state,created_at,expires_at,
    CASE WHEN length(CAST(email_before_json AS BLOB))<=4096 THEN email_before_json ELSE NULL END AS email_before_json,
    CASE WHEN length(CAST(email_after_json AS BLOB))<=4096 THEN email_after_json ELSE NULL END AS email_after_json,
    length(CAST(email_before_json AS BLOB)) AS before_bytes,length(CAST(email_after_json AS BLOB)) AS after_bytes,
    (SELECT CASE WHEN length(CAST(COALESCE(value_json,'null') AS BLOB))<=4096 THEN COALESCE(value_json,'null') ELSE NULL END
      FROM identity_sensitive_values WHERE tenant_id=? AND owner_type='runtime_user' AND owner_id=? AND value_key='email' AND lifecycle_state='active') AS expected_before,
    COALESCE((SELECT length(CAST(COALESCE(value_json,'null') AS BLOB)) FROM identity_sensitive_values WHERE tenant_id=? AND owner_type='runtime_user' AND owner_id=? AND value_key='email' AND lifecycle_state='active'),4) AS expected_bytes
    FROM account_webhook_snapshots WHERE id=?`,
    [route.tenantId, route.userId, route.tenantId, route.userId, id],
    { consistencyClass: 'primary_required' }
  );
  if (
    !row ||
    row.tenant_id !== route.tenantId ||
    row.user_id !== route.userId ||
    row.account_id !== route.accountId ||
    row.event_type !== 'account.deleted' ||
    row.registration_state !== 'guest' ||
    Number(row.created_at) !== at ||
    Number(row.expires_at) !== at + ACCOUNT_WEBHOOK_SNAPSHOT_RETENTION_MS ||
    Number(row.before_bytes) > 4096 ||
    Number(row.after_bytes) > 4096 ||
    Number(row.expected_bytes) > 4096 ||
    row.email_before_json !== (row.expected_before ?? 'null') ||
    row.email_after_json !== 'null'
  )
    throw new Error('guest_deletion_snapshot_unverified');
}

/** One stage/page only. Both API and scheduler resume this exact original task. */
export async function runGuestDeletionStep(
  env: Env,
  input: {
    tenantId: string;
    core: DatabaseAdapter;
    coreBindingRef: string;
    candidate: GuestLifecycleRow;
    now: number;
  }
): Promise<GuestDeletionStepResult> {
  const { tenantId, now } = input;
  let repository = new GuestLifecycleRepository(input.core, tenantId);
  let row = await repository.get(input.candidate.user_id);
  if (!row || !['active', 'deleting', 'deleted'].includes(row.phase)) return 'skipped';
  if (await findActiveAccountLegalHold(input.core, tenantId, row.user_id)) return 'held';
  if (row.phase === 'active') {
    if (
      row.deletion_due_at === null ||
      row.deletion_due_at > now ||
      (row.upgrade_hold_until !== null && row.upgrade_hold_until > now)
    )
      return 'skipped';
    const owner = await findGuestCoreOwner(
      await guestCoreStores(env, tenantId),
      tenantId,
      row.user_id
    );
    if (!owner?.account || owner.bindingRef !== input.coreBindingRef)
      throw new Error('guest_deletion_account_route_changed');
    const operationId = `guest-delete:${crypto.randomUUID()}`,
      auditId = `account-guest-deleted-${operationId}`;
    const route = await makeGuestDeletionRoute(env, owner, {
      tenantId,
      operationId,
      completionAuditId: auditId,
      origin: 'retention',
    });
    const verified = await verifyGuestDeletionPins(env, route);
    await createGuestPiiErasurePort(verified.pii, route.piiPin).tables();
    repository = new GuestLifecycleRepository(verified.core, tenantId);
    const current = await repository.get(row.user_id);
    if (!current) throw new Error('guest_deletion_source_unverified');
    const metadata = {
      guestDeletionVersion: 2,
      operationId,
      registration_state: 'guest',
      reason: 'guest_retention',
      source: 'guest_lifecycle',
    };
    await createAuditLog(env, {
      id: `account-guest-delete-started-${operationId}`,
      tenantId,
      userId: 'system',
      action: 'account.guest.deletion_started',
      resource: 'user',
      resourceId: row.user_id,
      severity: 'info',
      ipAddress: 'system',
      userAgent: 'Authrim guest lifecycle',
      metadata: JSON.stringify(metadata),
    });
    row = await repository.admitDeletion({
      userId: row.user_id,
      accountId: route.accountId,
      operationId,
      routeJson: JSON.stringify(route),
      expectedRevision: current.revision,
      accountRouteGeneration: route.accountRouteGeneration,
      now,
      startedAtMs: Date.now(),
      origin: 'retention',
      task: {
        auditId,
        actorUserId: 'system',
        ipAddress: 'system',
        userAgent: 'Authrim guest lifecycle',
        metadataJson: JSON.stringify(metadata),
        createdAt: now,
      },
    });
    return row ? 'pending' : 'skipped';
  }
  if (!row.deletion_operation_id) throw new Error('guest_deletion_source_unverified');
  let route = parseGuestDeletionRoute(row.deletion_route_json, {
    tenantId,
    userId: row.user_id,
    operationId: row.deletion_operation_id,
  });
  if (route.corePin.bindingRef !== input.coreBindingRef)
    throw new Error('guest_deletion_account_route_changed');
  const { core, pii } = await verifyGuestDeletionPins(env, route);
  repository = new GuestLifecycleRepository(core, tenantId);
  const piiPort = createGuestPiiErasurePort(pii, route.piiPin);
  const tables = await piiPort.tables();
  await requireGuestDeletionAuditTask(core, route);
  if (route.execution.phase === 'accepted') {
    if (await findActiveAccountLegalHold(core, tenantId, route.userId)) return 'held';
    const currentProjection = await requireCurrentGuestAccountProjection(
      env,
      tenantId,
      route.accountId,
      route.accountRouteGeneration
    );
    if (!sameGuestProjection(currentProjection, route.routeProjection))
      throw new Error('guest_deletion_account_route_changed');
    await verifyGuestDeletionPins(env, route);
    const started = {
      ...route,
      execution: {
        phase: 'erasure_started' as const,
        boundaryId: await guestErasureBoundaryId(route.operationId),
        erasureStartedAtMs: Date.now(),
      },
    };
    row = await repository.confirmErasureStart({
      userId: route.userId,
      accountId: route.accountId,
      operationId: route.operationId,
      expectedRevision: row.revision,
      acceptedRouteJson: JSON.stringify(route),
      erasureStartedRouteJson: JSON.stringify(started),
      accountRouteGeneration: route.accountRouteGeneration,
      now,
    });
    route = parseGuestDeletionRoute(row.deletion_route_json, {
      tenantId,
      userId: route.userId,
      accountId: route.accountId,
      operationId: route.operationId,
    });
    if (route.execution.phase !== 'erasure_started')
      return (await findActiveAccountLegalHold(core, tenantId, route.userId)) ? 'held' : 'pending';
    return 'pending';
  }
  const source = await requireGuestErasureSourceReceipt(core, route);
  const authentication = await getSessionRevocationStore(
    env,
    tenantId,
    route.userId
  ).getAccountStateRpc(tenantId, route.userId, `account:${route.userId}`);
  if (source.sourceStartedAtMs >= Number.MAX_SAFE_INTEGER)
    throw new Error('guest_deletion_source_unverified');
  if (authentication.lifecycle === 'deleted')
    requireAuthenticationProof(authentication, route, 'deleted');
  else {
    const deleting = await transitionAccountAuthenticationState(env, {
      tenantId,
      userId: route.userId,
      lifecycle: 'deleting',
      operationId: `${route.operationId}:begin`,
      sourceVersionMs: source.sourceStartedAtMs,
      revokeSessions: true,
    });
    requireAuthenticationProof(deleting, route, 'deleting');
  }
  const marker = await piiPort.start(source);
  const oldJson = await repository.readExecutionProgress(JSON.stringify(route), route.userId);
  if (oldJson === null) {
    if (marker.state === 'deleted') throw new Error('guest_deletion_progress_unverified');
    const keys = await loadLookupHmacRuntimeKeys(env, { bypassCache: true });
    const progress = await createGuestDeletionProgress(
      route,
      keys.readKeys.map((key) => key.generation)
    );
    await repository.compareAndSwapExecutionProgress({
      routeJson: JSON.stringify(route),
      userId: route.userId,
      expectedProgressJson: null,
      nextProgressJson: JSON.stringify(progress),
    });
    return 'pending';
  }
  const progress = parseGuestDeletionProgress(oldJson);
  const commit = async (updated: GuestDeletionProgress) =>
    repository.compareAndSwapExecutionProgress({
      routeJson: JSON.stringify(route),
      userId: route.userId,
      expectedProgressJson: oldJson,
      nextProgressJson: JSON.stringify(updated),
    });
  if (
    ['capture_email', 'capture_linked', 'capture_passkeys', 'capture_resume'].includes(
      progress.stage
    )
  ) {
    const page = await captureGuestDirectoryPage({
      route,
      progress,
      core,
      pii,
      keys: await guestDirectoryCaptureKeys(env, progress.pinnedHmacGenerations),
    });
    if (progress.stage === 'capture_email') await captureGuestWebhook(pii, route);
    const updated = page.done
      ? advance(progress)
      : next(progress, { cursor: page.cursor, highWater: page.highWater });
    updated.preparedCount += page.publications.length;
    if (page.publications.length)
      await repository.prepareDirectoryRemovalPage({
        routeJson: JSON.stringify(route),
        userId: route.userId,
        expectedProgressJson: oldJson,
        nextProgressJson: JSON.stringify(updated),
        publications: page.publications,
        now,
      });
    else await commit(updated);
    return 'pending';
  }
  if (progress.stage === 'release_reservations') {
    const page = await releaseGuestReservationPage(env, { route, progress, pii });
    await commit(
      page.done
        ? advance(progress)
        : next(progress, { cursor: page.cursor, highWater: page.highWater })
    );
    return 'pending';
  }
  if (progress.stage === 'drain_pii') {
    const table = tables[progress.sourceOrdinal];
    if (!table) {
      await commit(advance(progress));
      return 'pending';
    }
    const receipt = await requireGuestErasureDrainReceipt(core, route);
    const page = await piiPort.listPage(receipt, {
      table,
      cursor: progress.cursor,
      ...(progress.highWater === null ? {} : { highWater: progress.highWater }),
      limit: 16,
    });
    if (page.keys.length) {
      const current = await piiPort.get(receipt);
      if (!current) throw new Error('guest_pii_marker_unverified');
      await piiPort.drainPage(receipt, {
        table,
        keys: page.keys,
        expectedRevision: current.revision,
      });
    }
    if (table === 'user_anonymization_map') forgetCachedAnonymizedUserId(tenantId, route.userId);
    await commit(
      next(
        progress,
        page.nextCursor === null
          ? { sourceOrdinal: progress.sourceOrdinal + 1, cursor: null, highWater: null }
          : { cursor: page.nextCursor, highWater: page.highWater }
      )
    );
    return 'pending';
  }
  if (
    progress.stage === 'drain_guest_devices' ||
    progress.stage === 'drain_passkeys' ||
    progress.stage === 'drain_totp_backup_codes' ||
    progress.stage === 'drain_totp_credentials'
  ) {
    const table =
      progress.stage === 'drain_passkeys'
        ? 'passkeys'
        : progress.stage === 'drain_guest_devices'
          ? 'guest_devices'
          : progress.stage === 'drain_totp_backup_codes'
            ? 'totp_backup_codes'
            : 'totp_credentials';
    const high =
      progress.highWater ??
      (
        await core.queryOne<{ high: string | null }>(
          `SELECT MAX(id) AS high FROM ${table} WHERE tenant_id=? AND user_id=?`,
          [tenantId, route.userId],
          { consistencyClass: 'primary_required' }
        )
      )?.high ??
      null;
    const ids =
      high === null
        ? []
        : (
            await core.query<{ id: string }>(
              `SELECT id FROM ${table} WHERE tenant_id=? AND user_id=? AND id>? AND id<=? ORDER BY id LIMIT 16`,
              [tenantId, route.userId, progress.cursor ?? '', high],
              { consistencyClass: 'primary_required' }
            )
          ).map((entry) => entry.id);
    if (!ids.length) {
      await commit(advance(progress));
      return 'pending';
    }
    const updated =
      ids.at(-1) === high
        ? advance(progress, 2)
        : next(progress, { cursor: ids.at(-1) ?? null, highWater: high }, 2);
    await repository.drainCorePage({
      routeJson: JSON.stringify(route),
      userId: route.userId,
      expectedProgressJson: oldJson,
      nextProgressJson: JSON.stringify(updated),
      table,
      ids,
    });
    return 'pending';
  }
  if (progress.stage === 'final_core') {
    if (source.sourceStartedAtMs >= Number.MAX_SAFE_INTEGER)
      throw new Error('guest_deletion_source_unverified');
    const deleted = await transitionAccountAuthenticationState(env, {
      tenantId,
      userId: route.userId,
      lifecycle: 'deleted',
      operationId: `${route.operationId}:complete`,
      sourceVersionMs: source.sourceStartedAtMs + 1,
      revokeSessions: true,
    });
    requireAuthenticationProof(deleted, route, 'deleted');
    await repository.finishCoreErasure({
      routeJson: JSON.stringify(route),
      userId: route.userId,
      expectedProgressJson: oldJson,
      nextProgressJson: JSON.stringify(advance(progress, 2)),
      now,
    });
    return 'pending';
  }
  if (progress.stage === 'directory_ready') {
    const prefix = `account-routing-removal:${await guestDirectoryRemovalOperationPrefix(route)}`;
    const high =
      progress.highWater ??
      (
        await core.queryOne<{ high: string | null }>(
          `SELECT MAX(outbox_id) AS high FROM account_routing_outbox WHERE tenant_id=? AND account_id=? AND event_kind='account_deleted' AND outbox_id LIKE ?`,
          [tenantId, route.accountId, `${prefix}%`],
          { consistencyClass: 'primary_required' }
        )
      )?.high ??
      null;
    const ids =
      high === null
        ? []
        : (
            await core.query<{ outbox_id: string }>(
              `SELECT outbox_id FROM account_routing_outbox WHERE tenant_id=? AND account_id=? AND event_kind='account_deleted' AND outbox_id LIKE ? AND outbox_id>? AND outbox_id<=? ORDER BY outbox_id LIMIT 8`,
              [tenantId, route.accountId, `${prefix}%`, progress.cursor ?? '', high],
              { consistencyClass: 'primary_required' }
            )
          ).map((entry) => entry.outbox_id);
    if (!ids.length) {
      if (progress.confirmedCount !== progress.preparedCount)
        throw new Error('guest_directory_page_unverified');
      await commit(advance(progress));
      return 'pending';
    }
    const updated = next(progress, {
      cursor: ids.at(-1) ?? null,
      highWater: high,
      confirmedCount: progress.confirmedCount + ids.length,
    });
    if (updated.confirmedCount > progress.preparedCount)
      throw new Error('guest_directory_page_unverified');
    await repository.markDirectoryRemovalPageReady({
      routeJson: JSON.stringify(route),
      userId: route.userId,
      expectedProgressJson: oldJson,
      nextProgressJson: JSON.stringify(updated),
      ids,
      now,
    });
    return 'pending';
  }
  if (progress.stage === 'compact_pii') {
    const receipt = await requireGuestErasureCompletionReceipt(core, route);
    const current = await piiPort.get(receipt);
    if (!current) throw new Error('guest_pii_marker_unverified');
    await piiPort.complete(receipt, { expectedRevision: current.revision });
    await commit(advance(progress));
    return 'pending';
  }
  if (progress.stage === 'terminal') {
    const current = await piiPort.get(source);
    const terminal = await repository.get(route.userId);
    if (
      current?.state !== 'deleted' ||
      terminal?.phase !== 'deleted' ||
      terminal.deletion_operation_id !== route.operationId
    )
      throw new Error('guest_deletion_terminal_unverified');
    await invalidateUserCache(env, tenantId, route.userId);
    return 'deleted';
  }
  throw new Error('guest_deletion_progress_invalid');
}
