import {
  DynamicGroupStore,
  SavedGroupInputReader,
  ensureDatabaseAdapter,
  resolveAccountDataContext,
  resolveTenantMetadataContext,
  type DatabaseAdapter,
  type AccountDataContext,
  type Env,
} from '@authrim/ar-lib-core';
import type { GuestMaintenanceTarget } from './guest-lifecycle-scheduled';
function routeStamp(account: AccountDataContext): string {
  return JSON.stringify([
    account.coreBindingRef,
    account.piiBindingRef,
    account.accountRouteGeneration,
    account.userCacheScope,
  ]);
}
export async function serviceGroupRuntime(env: Env, tenantId: string, userId?: string) {
  const metadata = ensureDatabaseAdapter(
    (await resolveTenantMetadataContext(env, tenantId)).coreDb,
    'service-group-metadata'
  );
  const store = new DynamicGroupStore(metadata, tenantId);
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
      }
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
export async function processScheduledServiceGroups(
  env: Env,
  targets: GuestMaintenanceTarget[],
  log: { warn(message: string, metadata?: Record<string, unknown>): void }
): Promise<void> {
  for (const target of targets) {
    try {
      const { store } = await serviceGroupRuntime(env, target.tenantId);
      if (!(await store.catalog())) continue;
      for (const { adapter, bindingRef } of target.adapters) {
        await processServiceGroupShard(store, adapter, bindingRef, async (userId) => {
          const { reader } = await serviceGroupRuntime(env, target.tenantId, userId);
          if (!reader) throw new Error('group_input_unavailable');
          const result = await store.snapshot(userId, reader);
          if (result.freshness !== 'fresh') await store.evaluate(userId, reader);
        });
      }
    } catch {
      log.warn('Service group reconciliation deferred', { tenantId: target.tenantId });
    }
  }
}
