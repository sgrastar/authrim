import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  buildTenantRuntimeRegistrySnapshotKey,
  loadTenantRuntimeRegistryVerificationKeysFromEnv,
  RUNTIME_REGISTRY_SNAPSHOT_VERSION,
  verifyTenantRuntimeRegistrySnapshotSignature,
  type ControlTenantDeletionShardTarget,
  type Env,
  type TenantRuntimeRegistrySnapshot,
} from '@authrim/ar-lib-core';

const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_TABLE = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/u;
const TENANT_D1_STORAGE_PROFILE_ID = 'builtin:storage:tenant-d1';
const CLOUDFLARE_INTERNAL_TABLE_PREFIX = '_cf_';
const SCHEMA_INTROSPECTION_BATCH_SIZE = 50;
const PROTECTED_TABLES = new Set([
  'd1_migrations',
  'authrim_control_plane_shard_metadata',
  'authrim_migration_state',
  'tenant_runtime_cache_generations',
  'tenant_runtime_registry_snapshots',
]);

interface SqliteTableRow {
  name: string;
}

interface SqliteColumnRow {
  name: string;
}

interface SqliteForeignKeyRow {
  table: string;
}

async function batchSchemaIntrospection<T>(
  session: D1DatabaseSession,
  tables: string[],
  statementFor: (table: string) => string
): Promise<T[][]> {
  const rows: T[][] = [];
  for (let offset = 0; offset < tables.length; offset += SCHEMA_INTROSPECTION_BATCH_SIZE) {
    const chunk = tables.slice(offset, offset + SCHEMA_INTROSPECTION_BATCH_SIZE);
    const results = await session.batch<T>(
      chunk.map((table) => session.prepare(statementFor(table)))
    );
    if (results.length !== chunk.length || results.some((result) => result.success !== true)) {
      throw new Error('tenant_deletion_authoritative_schema_introspection_failed');
    }
    rows.push(...results.map((result) => result.results ?? []));
  }
  return rows;
}

function getDeploymentTarget(env: Env): string {
  return (
    (env as Env & { AUTHRIM_DEPLOYMENT_TARGET?: string }).AUTHRIM_DEPLOYMENT_TARGET?.trim() ||
    'default'
  );
}

function strictInventory(
  rows: ControlTenantDeletionShardTarget[],
  tenantId: string
): ControlTenantDeletionShardTarget[] {
  if (rows.length < 1) throw new Error('tenant_deletion_authoritative_shards_unavailable');
  const bindings = new Map<string, ControlTenantDeletionShardTarget>();
  for (const row of rows) {
    if (
      !SAFE_ID.test(row.shardId) ||
      !SAFE_BINDING.test(row.bindingRef) ||
      (row.dataRole !== 'tenant_core/default' &&
        row.dataRole !== 'tenant_core/users' &&
        row.dataRole !== 'tenant_pii') ||
      (row.status !== 'ready' && row.status !== 'active' && row.status !== 'degraded') ||
      (row.allocationScope === 'tenant_exclusive' && row.ownerTenantId !== tenantId) ||
      (row.allocationScope === 'shared_pool' && row.ownerTenantId !== null)
    ) {
      throw new Error('tenant_deletion_authoritative_shards_invalid');
    }
    const existing = bindings.get(row.bindingRef);
    if (existing && (existing.shardId !== row.shardId || existing.dataRole !== row.dataRole)) {
      throw new Error('tenant_deletion_authoritative_shards_invalid');
    }
    bindings.set(row.bindingRef, row);
  }
  return Array.from(bindings.values()).sort((left, right) =>
    left.bindingRef.localeCompare(right.bindingRef)
  );
}

function primarySession(env: Env, bindingRef: string): D1DatabaseSession {
  const source = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!source || typeof source !== 'object') {
    throw new Error('tenant_deletion_authoritative_binding_unavailable');
  }
  const database = source as Partial<D1Database>;
  if (typeof database.withSession !== 'function') {
    throw new Error('tenant_deletion_authoritative_binding_unavailable');
  }
  const session = database.withSession('first-primary');
  if (typeof session.prepare !== 'function' || typeof session.batch !== 'function') {
    throw new Error('tenant_deletion_authoritative_binding_unavailable');
  }
  return session;
}

async function loadQuarantinedSnapshot(
  env: Env,
  tenantId: string
): Promise<TenantRuntimeRegistrySnapshot> {
  if (!env.TENANT_RUNTIME_REGISTRY || !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS) {
    throw new Error('tenant_deletion_authoritative_registry_unavailable');
  }
  const value = await env.TENANT_RUNTIME_REGISTRY.get(
    buildTenantRuntimeRegistrySnapshotKey(tenantId, getDeploymentTarget(env))
  );
  if (!value) throw new Error('tenant_deletion_authoritative_registry_unavailable');
  let snapshot: TenantRuntimeRegistrySnapshot;
  try {
    snapshot = JSON.parse(value) as TenantRuntimeRegistrySnapshot;
  } catch {
    throw new Error('tenant_deletion_authoritative_registry_invalid');
  }
  const signature = await verifyTenantRuntimeRegistrySnapshotSignature(
    snapshot,
    loadTenantRuntimeRegistryVerificationKeysFromEnv(env)
  );
  if (
    signature !== 'valid' ||
    snapshot.version !== RUNTIME_REGISTRY_SNAPSHOT_VERSION ||
    snapshot.tenantId !== tenantId ||
    snapshot.deploymentTarget !== getDeploymentTarget(env) ||
    snapshot.routeStatus !== 'quarantined' ||
    !Number.isSafeInteger(snapshot.quarantineDenyGeneration) ||
    snapshot.quarantineDenyGeneration < 1 ||
    !Array.isArray(snapshot.stores) ||
    !Number.isFinite(Date.parse(snapshot.expiresAt)) ||
    Date.parse(snapshot.expiresAt) <= Date.now()
  ) {
    throw new Error('tenant_deletion_authoritative_registry_invalid');
  }
  return snapshot;
}

async function listTenantScopedTables(session: D1DatabaseSession): Promise<string[]> {
  const result = await session
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all<SqliteTableRow>();
  const discovered = new Set<string>();
  let hasTenantsTable = false;
  const tables = (result.results ?? [])
    .map((row) => row.name)
    .filter(
      (table) =>
        SAFE_TABLE.test(table) &&
        !table.startsWith(CLOUDFLARE_INTERNAL_TABLE_PREFIX) &&
        !PROTECTED_TABLES.has(table)
    );
  const columnRows = await batchSchemaIntrospection<SqliteColumnRow>(
    session,
    tables,
    (table) => `PRAGMA table_info("${table}")`
  );
  for (let index = 0; index < tables.length; index += 1) {
    const table = tables[index];
    if (!table) continue;
    const columnNames = new Set((columnRows[index] ?? []).map((column) => column.name));
    if (table === 'tenants' && columnNames.has('id') && columnNames.has('lifecycle_state')) {
      hasTenantsTable = true;
      continue;
    }
    if (columnNames.has('tenant_id')) {
      discovered.add(table);
    }
  }

  if (hasTenantsTable) discovered.add('tenants');
  const dependencies = new Map<string, Set<string>>();
  const incoming = new Map<string, number>();
  for (const table of discovered) {
    dependencies.set(table, new Set());
    incoming.set(table, 0);
  }
  const discoveredTables = Array.from(discovered);
  const foreignKeyRows = await batchSchemaIntrospection<SqliteForeignKeyRow>(
    session,
    discoveredTables,
    (table) => `PRAGMA foreign_key_list("${table}")`
  );
  for (let index = 0; index < discoveredTables.length; index += 1) {
    const table = discoveredTables[index];
    if (!table) continue;
    for (const foreignKey of foreignKeyRows[index] ?? []) {
      if (
        foreignKey.table === table ||
        !discovered.has(foreignKey.table) ||
        dependencies.get(table)?.has(foreignKey.table)
      ) {
        continue;
      }
      dependencies.get(table)?.add(foreignKey.table);
      incoming.set(foreignKey.table, (incoming.get(foreignKey.table) ?? 0) + 1);
    }
  }

  const ready = Array.from(discovered)
    .filter((table) => incoming.get(table) === 0)
    .sort();
  const ordered: string[] = [];
  while (ready.length > 0) {
    const table = ready.shift();
    if (!table) break;
    ordered.push(table);
    for (const parent of dependencies.get(table) ?? []) {
      const nextIncoming = (incoming.get(parent) ?? 0) - 1;
      incoming.set(parent, nextIncoming);
      if (nextIncoming === 0) {
        ready.push(parent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== discovered.size) {
    throw new Error('tenant_deletion_authoritative_foreign_key_cycle');
  }
  return ordered;
}

async function purgeTenantFromSession(
  session: D1DatabaseSession,
  tenantId: string,
  preserveJobIds: string[]
): Promise<void> {
  const tables = await listTenantScopedTables(session);
  const mutations: Array<ReturnType<typeof session.prepare>> = [];
  for (const table of tables) {
    if (table === 'tenants') continue;
    if (table === 'admin_jobs' && preserveJobIds.length > 0) {
      const placeholders = preserveJobIds.map(() => '?').join(', ');
      mutations.push(
        session
          .prepare(`DELETE FROM "admin_jobs" WHERE tenant_id = ? AND id NOT IN (${placeholders})`)
          .bind(tenantId, ...preserveJobIds)
      );
      continue;
    }
    mutations.push(session.prepare(`DELETE FROM "${table}" WHERE tenant_id = ?`).bind(tenantId));
  }
  if (tables.includes('tenants')) {
    mutations.push(
      session
        .prepare("UPDATE tenants SET lifecycle_state = 'deleted', updated_at = ? WHERE id = ?")
        .bind(Math.floor(Date.now() / 1000), tenantId)
    );
  }
  await session.batch(mutations);

  for (const table of tables) {
    if (table === 'tenants') continue;
    const statement =
      table === 'admin_jobs' && preserveJobIds.length > 0
        ? session
            .prepare(
              `SELECT COUNT(*) AS count FROM "admin_jobs" WHERE tenant_id = ? AND id NOT IN (${preserveJobIds
                .map(() => '?')
                .join(', ')})`
            )
            .bind(tenantId, ...preserveJobIds)
        : session
            .prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE tenant_id = ?`)
            .bind(tenantId);
    const remaining = await statement.first<{ count: number }>();
    if (!remaining || Number(remaining.count) !== 0) {
      throw new Error('tenant_deletion_authoritative_purge_not_reflected');
    }
  }
}

export async function purgeTenantAuthoritativeShards(
  env: Env,
  inventoryRows: ControlTenantDeletionShardTarget[],
  tenantId: string,
  preserveJobIds: string[]
): Promise<void> {
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (
    !environmentId ||
    !SAFE_ID.test(environmentId) ||
    !SAFE_ID.test(tenantId) ||
    env.DEFAULT_STORAGE_PROFILE_ID !== TENANT_D1_STORAGE_PROFILE_ID ||
    preserveJobIds.some((id) => !SAFE_ID.test(id))
  ) {
    throw new Error('tenant_deletion_authoritative_purge_unavailable');
  }

  const snapshot = await loadQuarantinedSnapshot(env, tenantId);
  const inventory = strictInventory(inventoryRows, tenantId);
  const inventoryBindings = new Set(inventory.map((row) => row.bindingRef));
  const snapshotBindings = new Set(
    snapshot.stores.filter((store) => store.provider === 'd1').map((store) => store.bindingRef)
  );
  if (
    snapshotBindings.size !== inventoryBindings.size ||
    Array.from(snapshotBindings).some(
      (bindingRef) => !bindingRef || !inventoryBindings.has(bindingRef)
    )
  ) {
    throw new Error('tenant_deletion_authoritative_registry_inventory_mismatch');
  }

  const sessions = inventory.map((row) => primarySession(env, row.bindingRef));
  for (const session of sessions) {
    await purgeTenantFromSession(session, tenantId, preserveJobIds);
  }
}
