import {
  DynamicGroupStore,
  SavedGroupInputReader,
  ensureDatabaseAdapter,
  publishDynamicMemberships,
  removeDynamicGroup,
  syncDynamicGroupCatalog,
  expireDynamicMembershipsAfterFailure,
  resolveDynamicFreshnessSeconds,
  selfWritableRoleGroups,
  retryPendingDynamicInvalidations,
  loadGroupFields,
  type Catalog,
  type DynamicPublicationOptions,
  resolveAccountDataContext,
  resolveTenantMetadataContext,
  type DatabaseAdapter,
  type AccountDataContext,
  type Env,
} from '@authrim/ar-lib-core';
import type { GuestMaintenanceTarget } from './guest-lifecycle-scheduled';
import { coreLogPublicationSource } from '@authrim/ar-lib-core/services/log-iceberg-core-publication';
function routeStamp(account: AccountDataContext): string {
  return JSON.stringify([
    account.coreBindingRef,
    account.piiBindingRef,
    account.accountRouteGeneration,
    account.userCacheScope,
  ]);
}
export async function serviceGroupRuntime(env: Env, tenantId: string, userId?: string) {
  const context = await resolveTenantMetadataContext(env, tenantId);
  if (context.tenantId !== tenantId) throw new Error('group_tenant_mismatch');
  const metadata = ensureDatabaseAdapter(context.coreDb, 'service-group-metadata');
  const store = new DynamicGroupStore(metadata, tenantId, {
    env,
    source: coreLogPublicationSource(env, context.route),
  });
  if (!userId) return { store, reader: null };
  const account = await resolveAccountDataContext(env, { tenantId, accountId: userId });
  if (account.legacyUserId !== userId) throw new Error('group_subject_invalid');
  return {
    store,
    reader: new SavedGroupInputReader(
      metadata,
      ensureDatabaseAdapter(account.coreDb, 'service-group-core'),
      ensureDatabaseAdapter(account.piiDb, 'service-group-pii'),
      tenantId,
      account.legacyUserId,
      {
        stamp: routeStamp(account),
        verify: async () => {
          const current = await resolveAccountDataContext(env, { tenantId, accountId: userId });
          if (routeStamp(current) !== routeStamp(account))
            throw new Error('group_input_route_changed');
        },
      },
      env
    ),
  };
}
interface Scan {
  cursor_id: string;
  rule_version: number;
  processed: number;
  failures: number;
}
/** One bounded page per assigned shard; cursor and lease survive process exit. Failed subjects remain visible and retry on the next sweep. */
export async function processServiceGroupShard(
  store: DynamicGroupStore,
  source: DatabaseAdapter,
  bindingRef: string,
  evaluate: (userId: string) => Promise<void>,
  pageSize = 20
): Promise<void> {
  const catalog = await store.catalog();
  if (!catalog) return;
  const { db, tenantId } = store;
  const now = Date.now();
  const lease = crypto.randomUUID();
  await db.execute(
    `INSERT INTO service_group_scans(tenant_id, binding_ref, rule_version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, binding_ref) DO NOTHING`,
    [tenantId, bindingRef, catalog.revision, now]
  );
  const claim = await db.execute(
    `UPDATE service_group_scans SET lease_token = ?, lease_until = ?, status = 'processing' WHERE tenant_id = ? AND binding_ref = ? AND lease_until <= ?`,
    [lease, now + 120_000, tenantId, bindingRef, now]
  );
  if (claim.rowsAffected !== 1) return;
  try {
    const row = await db.queryOne<Scan>(
      'SELECT cursor_id, rule_version, processed, failures FROM service_group_scans WHERE tenant_id = ? AND binding_ref = ?',
      [tenantId, bindingRef],
      { consistencyClass: 'primary_required' }
    );
    if (!row) throw new Error('group_scan_missing');
    const reset = Number(row.rule_version) !== catalog.revision;
    const cursor = reset ? '' : row.cursor_id;
    const users = await source.query<{ legacy_user_id: string }>(
      `SELECT legacy_user_id FROM identity_accounts WHERE tenant_id = ? AND account_type = 'user' AND legacy_user_id > ? ORDER BY legacy_user_id LIMIT ?`,
      [tenantId, cursor, Math.min(50, Math.max(1, pageSize))],
      { consistencyClass: 'primary_required' }
    );
    let failures = reset || !cursor ? 0 : Number(row.failures);
    for (const user of users) {
      try {
        await evaluate(user.legacy_user_id);
      } catch {
        failures++;
      }
    }
    const complete = users.length < pageSize;
    await db.execute(
      `UPDATE service_group_scans SET cursor_id = ?, rule_version = ?, processed = ?, failures = ?, status = ?, lease_until = 0, updated_at = ? WHERE tenant_id = ? AND binding_ref = ? AND lease_token = ? AND lease_until > ?`,
      [
        complete ? '' : users[users.length - 1].legacy_user_id,
        catalog.revision,
        (reset || !cursor ? 0 : Number(row.processed)) + users.length,
        failures,
        complete ? (failures ? 'failed' : 'completed') : 'processing',
        Date.now(),
        tenantId,
        bindingRef,
        lease,
        Date.now(),
      ]
    );
  } catch {
    await db.execute(
      `UPDATE service_group_scans SET status = 'failed', failures = failures + 1, lease_until = 0, updated_at = ? WHERE tenant_id = ? AND binding_ref = ? AND lease_token = ?`,
      [Date.now(), tenantId, bindingRef, lease]
    );
  }
}
/**
 * One subject of a reconcile pass: evaluated when its result is not fresh, then published (a new
 * result, a failed publication retried, rows renewed or restored). An evaluation (or its account
 * routing) that fails makes the subject's dynamic rows stale at once, on the shard being scanned.
 */
export async function refreshServiceGroupSubject(
  env: Env,
  store: DynamicGroupStore,
  shard: DatabaseAdapter,
  userId: string,
  options: DynamicPublicationOptions
): Promise<void> {
  let account = shard;
  try {
    const { reader } = await serviceGroupRuntime(env, store.tenantId, userId);
    if (!reader) throw new Error('group_input_unavailable');
    account = reader.core;
    const result = await store.snapshot(userId, reader);
    if (result.freshness !== 'fresh') await store.evaluate(userId, reader);
    await publishDynamicMemberships(store, reader, reader.core, options);
  } catch (error) {
    await expireDynamicMembershipsAfterFailure(store, account, userId, options);
    throw error;
  }
}
/**
 * The refresh pass: the subjects of the shard whose published dynamic rows expire within
 * `renewBeforeSeconds` (and have not yet expired), soonest first, up to `budget` per run. It
 * keeps fresh results' rows from lapsing on large shards, where the full scan (20 subjects per
 * run) comes round too rarely; rows already expired are left to the full scan.
 */
export async function refreshExpiringDynamicMemberships(
  store: DynamicGroupStore,
  source: DatabaseAdapter,
  refresh: (userId: string) => Promise<void>,
  options: { renewBeforeSeconds: number; budget?: number }
): Promise<{ visited: string[]; failures: number }> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await source.query<{ subject_id: string }>(
    `SELECT subject_id, MIN(stale_after) AS soonest FROM group_memberships
      WHERE tenant_id = ? AND assignment_source = 'dynamic' AND lifecycle_state = 'active'
        AND stale_after > ? AND stale_after <= ?
      GROUP BY subject_id ORDER BY soonest, subject_id LIMIT ?`,
    [store.tenantId, now, now + options.renewBeforeSeconds, options.budget ?? 100],
    { consistencyClass: 'primary_required' }
  );
  let failures = 0;
  for (const row of rows) {
    try {
      await refresh(row.subject_id);
    } catch {
      failures++;
    }
  }
  return { visited: rows.map((row) => row.subject_id), failures };
}
/**
 * Once per catalog revision: the groups whose result depends on a field the person writes
 * themselves while they carry roles (saved before the check existed, or a role granted since).
 * They are left out of publication; this names them for an administrator.
 */
async function reportSelfWritableRoleGroups(
  env: Env,
  store: DynamicGroupStore,
  catalog: Catalog,
  log: { warn(message: string, metadata?: Record<string, unknown>): void }
) {
  const offending = await selfWritableRoleGroups(
    store.db,
    store.tenantId,
    catalog.plan,
    await loadGroupFields(store.db, store.tenantId, { cachedScreens: true })
  );
  if (!offending.size) return;
  const key = `jobs:service-groups:self-writable-check:${store.tenantId}:${catalog.revision}`;
  if (env.AUTHRIM_CONFIG && (await env.AUTHRIM_CONFIG.get(key))) return;
  log.warn('Service groups decided by self-writable attributes carry roles; not published', {
    tenantId: store.tenantId,
    ruleVersion: catalog.revision,
    groupIds: [...offending].sort(),
  });
  await env.AUTHRIM_CONFIG?.put(key, '1', { expirationTtl: 30 * 86_400 });
}
export async function processScheduledServiceGroups(
  env: Env,
  targets: GuestMaintenanceTarget[],
  log: { warn(message: string, metadata?: Record<string, unknown>): void }
): Promise<void> {
  for (const target of targets) {
    try {
      const { store } = await serviceGroupRuntime(env, target.tenantId);
      const catalog = await store.catalog();
      // Canonical `groups` rows of the catalog (older catalogs, an interrupted save), and the
      // removal of groups the catalog no longer has, finished on every account shard.
      const { orphanIds, awaitingCatalog } = await syncDynamicGroupCatalog(
        store.db,
        store.tenantId,
        catalog,
        env.REBAC_CACHE
      );
      // A tenant restored without its catalog yet: its groups wait for it, untouched.
      if (awaitingCatalog.length)
        log.warn('Service-owned groups await their catalog; left as they are', {
          tenantId: store.tenantId,
          groupCount: awaitingCatalog.length,
        });
      const accounts = [store.db, ...target.adapters.map(({ adapter }) => adapter)];
      for (const groupId of orphanIds)
        await removeDynamicGroup(store.db, accounts, store.tenantId, groupId, env.REBAC_CACHE);
      const options = {
        cache: env.REBAC_CACHE,
        freshnessSeconds: await resolveDynamicFreshnessSeconds(env, store.tenantId, log),
        log,
      };
      // Cached claims still to be invalidated after an earlier publication or expiry, whatever
      // the rows or their expiry.
      for (const { adapter } of target.adapters)
        await retryPendingDynamicInvalidations(adapter, store.tenantId, options);
      if (!catalog) continue;
      await reportSelfWritableRoleGroups(env, store, catalog, log);
      for (const { adapter, bindingRef } of target.adapters) {
        const refresh = (userId: string) =>
          refreshServiceGroupSubject(env, store, adapter, userId, options);
        // Rows that expire soonest first, independent of the full scan's cursor.
        await refreshExpiringDynamicMemberships(store, adapter, refresh, {
          renewBeforeSeconds: Math.floor(options.freshnessSeconds / 2),
        });
        await processServiceGroupShard(store, adapter, bindingRef, refresh);
      }
    } catch {
      log.warn('Service group reconciliation deferred', { tenantId: target.tenantId });
    }
  }
}
