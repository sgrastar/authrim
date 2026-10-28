import { ensureDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import {
  assertLogIcebergActivated,
  resolveLogIcebergConfig,
} from '@authrim/ar-lib-core/services/log-iceberg-config';
import { runLogIcebergDelivery } from '@authrim/ar-lib-core/services/log-iceberg-delivery';
import { runLogIcebergExport } from '@authrim/ar-lib-core/services/log-iceberg-export';
import { runLogIcebergRetryCleanup } from '@authrim/ar-lib-core/services/log-iceberg-retry-cleanup';
import {
  runLogIcebergRetention,
  runLogIcebergSnapshotMaintenance,
} from '@authrim/ar-lib-core/services/log-iceberg-retention';
import { eraseLogIcebergSubject } from '@authrim/ar-lib-core/services/log-iceberg-subject-erasure';
import { resolveTenantAssignedDatabaseSourcesFromRegistry } from '@authrim/ar-lib-core';
import { createAuditService } from '@authrim/ar-lib-core/services/audit/index';

const PAGE_SIZE = 8;
const STEPS = 4;
interface Scope {
  id: string;
  tenant_id: string;
  source_dataset: string;
}

/** The existing minute tick owns recovery and lifecycle for both modes. Only
 * scheduled mode may reread DB log bodies and export them to Iceberg. */
export async function runLogIcebergScheduledMaintenance(
  event: { cron: string; scheduledTime: number },
  env: Env
): Promise<{ ran: boolean; mode?: 'pipeline' | 'scheduled' }> {
  if (event.cron !== '* * * * *') return { ran: false };
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  if (!Number.isSafeInteger(event.scheduledTime) || event.scheduledTime < 0)
    throw new Error('log_iceberg_schedule_invalid');
  const writer = env.LOG_ARCHIVE_WRITER;
  if (!writer) throw new Error('log_iceberg_writer_unavailable');
  if (!env.DB_ADMIN || !env.AUTHRIM_CONFIG)
    throw new Error('log_iceberg_maintenance_metadata_unavailable');
  const admin = ensureDatabaseAdapter(env.DB_ADMIN, 'log-iceberg-maintenance');
  let failed = false;
  const attempt = async (run: () => Promise<unknown>) => {
    try {
      const result = await run();
      if (
        result !== null &&
        typeof result === 'object' &&
        'failed' in result &&
        typeof result.failed === 'number' &&
        result.failed > 0
      )
        failed = true;
    } catch {
      failed = true;
    }
  };
  // Prepared publications must be reconciled even when this is not an export tick.
  await attempt(() => writer.reconcileCorePublications({ limit: 16 }));
  if (config.localStagingOnly) {
    // Local dev deliberately has no remote Catalog or proof. Keep its encrypted
    // hot source; never report a successful cold export or delete on hot age.
    if (failed) throw new Error('log_iceberg_maintenance_deferred');
    return { ran: true, mode: config.mode };
  }
  if (config.mode === 'pipeline') {
    await attempt(() => runLogIcebergDelivery(env));
    await attempt(() => runLogIcebergRetryCleanup(env));
  } else {
    if (config.exportIntervalMinutes === null) throw new Error('log_iceberg_schedule_invalid');
    if (Math.floor(event.scheduledTime / 60000) % config.exportIntervalMinutes === 0)
      await attempt(() => runLogIcebergExport(env));
  }
  const key = `jobs:log-iceberg:retention-cursor:${config.generation}`;
  const after = (await env.AUTHRIM_CONFIG.get(key)) ?? '';
  if (after !== '' && !/^[a-f0-9]{64}$/.test(after))
    throw new Error('log_iceberg_maintenance_cursor_invalid');
  const scopes = await admin.query<Scope>(
    `SELECT id,tenant_id,source_dataset FROM log_iceberg_retention_jobs WHERE table_uuid=? AND storage_generation=? AND source_dataset!='system.snapshot_gc' AND id>? ORDER BY id LIMIT ?`,
    [config.tableUuid, config.generation, after, PAGE_SIZE],
    { consistencyClass: 'primary_required' }
  );
  const deadline = Date.now() + 10000;
  let visited = 0;
  let nextCursor = after;
  for (const scope of scopes) {
    if (Date.now() >= deadline) break;
    await attempt(async () => {
      for (let step = 0; step < STEPS && Date.now() < deadline; step++) {
        const result = await runLogIcebergRetention(env, {
          tenantId: scope.tenant_id,
          sourceDataset: scope.source_dataset,
        });
        if (result.complete || !result.progressed) break;
      }
    });
    // A frozen or failing tenant must not starve all later scopes.
    visited++;
    nextCursor = scope.id;
  }
  if (visited === scopes.length && scopes.length < PAGE_SIZE) nextCursor = '';
  // Workers KV allows one write per key per second; checkpoint this idempotent
  // page once, rather than writing the cursor after every fast scope.
  await env.AUTHRIM_CONFIG.put(key, nextCursor);
  // Resume physical erasure independently of a caller keeping an HTTP request open.
  const erasureKey = `jobs:log-iceberg:erasure-cursor:${config.generation}`;
  const erasureAfter = (await env.AUTHRIM_CONFIG.get(erasureKey)) ?? '';
  if (erasureAfter !== '' && !/^[a-f0-9]{64}$/.test(erasureAfter))
    throw new Error('log_iceberg_maintenance_cursor_invalid');
  const erasures = await admin.query<{ id: string; tenant_id: string; subject_id: string }>(
    `SELECT id,tenant_id,subject_id FROM log_iceberg_subject_erasures WHERE source_dataset='pii.pii_log' AND state!='completed' AND id>? ORDER BY id LIMIT ?`,
    [erasureAfter, PAGE_SIZE],
    { consistencyClass: 'primary_required' }
  );
  const erasureDeadline = Date.now() + 10_000;
  let erasedVisited = 0;
  let nextErasureCursor = erasureAfter;
  for (const row of erasures) {
    if (Date.now() >= erasureDeadline) break;
    await attempt(() =>
      eraseLogIcebergSubject(env, {
        tenantId: row.tenant_id,
        sourceDataset: 'pii.pii_log',
        subjectId: row.subject_id,
      })
    );
    erasedVisited++;
    nextErasureCursor = row.id;
  }
  if (erasedVisited === erasures.length && erasures.length < PAGE_SIZE) nextErasureCursor = '';
  await env.AUTHRIM_CONFIG.put(erasureKey, nextErasureCursor);
  await attempt(async () => {
    const snapshotDeadline = Date.now() + 10_000;
    for (let step = 0; step < STEPS && Date.now() < snapshotDeadline; step++) {
      const result = await runLogIcebergSnapshotMaintenance(env);
      if (result.complete || !result.progressed) break;
    }
  });
  // Purge completion has an independent cursor and time budget: a long TTL
  // rewrite must not prevent approved PII intents from ever being resumed.
  const purgeKey = `jobs:log-iceberg:pii-scope-cursor:${config.generation}`;
  const purgeAfter = (await env.AUTHRIM_CONFIG.get(purgeKey)) ?? '';
  if (purgeAfter !== '' && !/^[a-f0-9]{64}$/.test(purgeAfter))
    throw new Error('log_iceberg_maintenance_cursor_invalid');
  const purgeScopes = await admin.query<Scope>(
    "SELECT id,tenant_id,source_dataset FROM log_iceberg_retention_jobs WHERE table_uuid=? AND storage_generation=? AND source_dataset='pii.pii_log' AND id>? ORDER BY id LIMIT ?",
    [config.tableUuid, config.generation, purgeAfter, PAGE_SIZE],
    { consistencyClass: 'primary_required' }
  );
  const purgeDeadline = Date.now() + 10000;
  let purgeVisited = 0,
    nextPurge = purgeAfter;
  for (const scope of purgeScopes) {
    if (Date.now() >= purgeDeadline) break;
    await attempt(() =>
      resumePendingPiiPurges(env, config.generation, scope.tenant_id, purgeDeadline)
    );
    nextPurge = scope.id;
    purgeVisited++;
  }
  if (purgeVisited === purgeScopes.length && purgeScopes.length < PAGE_SIZE) nextPurge = '';
  await env.AUTHRIM_CONFIG.put(purgeKey, nextPurge);
  if (failed) throw new Error('log_iceberg_maintenance_deferred');
  return { ran: true, mode: config.mode };
}

/** Keyset checkpoints advance past pending/failed operations and rotate stores;
 * an old compaction/DR pin must not starve the fifth purge or a later shard. */
export async function resumePendingPiiPurges(
  env: Env,
  generation: string,
  tenantId: string,
  deadline: number
): Promise<{ failed: number }> {
  const kv = env.AUTHRIM_CONFIG;
  if (!kv) throw new Error('log_iceberg_maintenance_metadata_unavailable');
  const stores = (
    await resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
      tenantId,
      role: 'tenant_pii',
      dataRole: 'tenant_pii',
      maxStores: 32,
      concurrency: 4,
    })
  ).sort((a, b) => (a.bindingRef < b.bindingRef ? -1 : a.bindingRef > b.bindingRef ? 1 : 0));
  if (!stores.length) return { failed: 0 };
  const storeKey = `jobs:log-iceberg:pii-purge-store:${generation}:${tenantId}`;
  const afterStore = (await kv.get(storeKey)) ?? '';
  if (afterStore.length > 256) throw new Error('log_iceberg_maintenance_cursor_invalid');
  const store = stores.find((value) => value.bindingRef > afterStore) ?? stores[0];
  const key = `jobs:log-iceberg:pii-purge-cursor:${generation}:${tenantId}:${store.bindingRef}`;
  const raw = await kv.get(key);
  let afterTime = 0,
    afterId = '';
  if (raw) {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      !('at' in value) ||
      typeof value.at !== 'number' ||
      !Number.isSafeInteger(value.at) ||
      value.at < 0 ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !/^([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})?$/.test(value.id) ||
      Object.keys(value).length !== 2
    )
      throw new Error('log_iceberg_maintenance_cursor_invalid');
    afterTime = value.at;
    afterId = value.id;
  }
  const pii = ensureDatabaseAdapter(store.source, 'log-iceberg-pii-purge-resume');
  const rows = await pii.query<{ id: string; user_id: string; created_at: number }>(
    'SELECT id,user_id,created_at FROM pii_log_purge_operations WHERE tenant_id=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 4',
    [tenantId, afterTime, afterTime, afterId],
    { consistencyClass: 'primary_required' }
  );
  const service = createAuditService({ env, piiSource: store.source });
  let visited = 0,
    failed = 0;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    try {
      const result = await service.resumePendingPIIPurge(tenantId, row.user_id, row.id);
      if (!result.success && !result.pending) failed++;
    } catch {
      failed++;
    }
    visited++;
    afterTime = row.created_at;
    afterId = row.id;
  }
  if (visited === rows.length && rows.length < 4) {
    afterTime = 0;
    afterId = '';
  }
  await kv.put(key, JSON.stringify({ at: afterTime, id: afterId }));
  await kv.put(storeKey, store.bindingRef);
  return { failed };
}
