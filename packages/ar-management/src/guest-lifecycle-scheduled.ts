import {
  GuestLifecycleRepository,
  GuestUpgradeRepository,
  validateAccountDirectoryPublication,
  type AccountDirectoryPublication,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { recoverAccountGuestUpgrade } from './account-guest-upgrade';
import {
  findGuestCoreOwner,
  guestCoreStores,
  makeGuestDeletionRoute,
  resolveGuestOwnerStorage,
  type GuestCoreOwner,
} from './guest-account-storage';
import { verifyGuestDeletionPins } from './guest-deletion-route';
import { runGuestDeletionStep, type GuestDeletionStepResult } from './guest-deletion-worker';
import { createGuestPiiErasurePort } from '@authrim/ar-lib-core/services/guest-pii-erasure';
import { InitialAccountIdentifierReservationService } from './account-directory-reservation';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';

export type GuestDeletionRoute = import('./guest-deletion-route').GuestDeletionRouteV2;
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

export async function createGuestDeletionRoute(
  env: Env,
  input: {
    tenantId: string;
    userId: string;
    operationId: string;
    completionAuditId: string;
    origin: 'admin' | 'retention';
    owner?: GuestCoreOwner;
  }
): Promise<GuestDeletionRoute> {
  const owner =
    input.owner ??
    (await findGuestCoreOwner(
      await guestCoreStores(env, input.tenantId),
      input.tenantId,
      input.userId
    ));
  if (!owner || owner.userId !== input.userId) throw new Error('guest_account_owner_unverified');
  const route = await makeGuestDeletionRoute(env, owner, input);
  const verified = await verifyGuestDeletionPins(env, route);
  await createGuestPiiErasurePort(verified.pii, route.piiPin).tables();
  return route;
}

export async function deleteOneGuestAccount(
  env: Env,
  input: Parameters<typeof runGuestDeletionStep>[1]
): Promise<GuestDeletionStepResult> {
  return runGuestDeletionStep(env, input);
}

/** Core admission is fenced before erasing PII, including retention-disabled guests. */
export async function cleanupExpiredGuestProofs(
  env: Env,
  tenantId: string,
  _core: DatabaseAdapter,
  coreBindingRef: string,
  userId: string,
  now: number
): Promise<void> {
  const stores = (await guestCoreStores(env, tenantId)).filter(
    (store) => store.bindingRef === coreBindingRef
  );
  const owner = await findGuestCoreOwner(stores, tenantId, userId);
  if (!owner || owner.userId !== userId || owner.bindingRef !== coreBindingRef)
    throw new Error('guest_proof_cleanup_route_mismatch');
  const account = await resolveGuestOwnerStorage(env, owner, tenantId);
  const lifecycle = new GuestLifecycleRepository(account.core, tenantId);
  const operations = new GuestUpgradeRepository(account.pii, tenantId);
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
      if (publication.tenantId !== tenantId || publication.accountId !== account.account.id)
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
