import type { DatabaseAdapter } from '../../db/adapter';

export type TenantDatabaseRole = 'tenant_core' | 'tenant_pii' | 'tenant_audit' | 'tenant_custom';
export type TenantDatabaseProvider = 'd1' | 'hyperdrive' | 'postgres' | 'mysql' | 'custom';
export type TenantDatabaseStatus =
  | 'requested'
  | 'provisioning'
  | 'ready'
  | 'active'
  | 'degraded'
  | 'degraded_pending_snapshot'
  | 'restored_pending'
  | 'failed'
  | 'disabled'
  | 'retired'
  | 'deleting'
  | 'deleted';
export type TenantDatabaseActivePointerStatus = 'active' | 'degraded_pending_snapshot' | 'disabled';
export type TenantDatabaseStatsWarningState = 'ok' | 'warning' | 'strong_warning';
export type TenantDatabaseD1FileSizeStatus = 'fresh' | 'stale' | 'unknown' | 'unavailable';

export interface TenantDatabaseRegistryKey {
  tenant_id: string;
  role: TenantDatabaseRole;
  generation: number;
  shard_group?: string;
  shard_index?: number;
}

/**
 * Runtime-facing database assignment.
 *
 * This table is the source of truth used by workers to resolve the active
 * database binding for a tenant. It intentionally does not model free capacity;
 * desired resources, placement ownership, and capacity are controlled by the Control Worker.
 */
export interface TenantDatabaseRegistryRow extends Required<TenantDatabaseRegistryKey> {
  provider: TenantDatabaseProvider;
  database_id: string | null;
  database_name: string | null;
  binding_ref: string | null;
  connection_ref: string | null;
  schema_version: number;
  status: TenantDatabaseStatus;
  shard_count: number;
  shard_key_strategy: string;
  worker_shard: string | null;
  deployment_target: string | null;
  region_hint: string | null;
  jurisdiction: string | null;
  signature: string | null;
  signature_key_id: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface TenantDatabaseRegistryInput extends TenantDatabaseRegistryKey {
  provider: TenantDatabaseProvider;
  database_id?: string | null;
  database_name?: string | null;
  binding_ref?: string | null;
  connection_ref?: string | null;
  schema_version?: number;
  status?: TenantDatabaseStatus;
  shard_count?: number;
  shard_key_strategy?: string;
  worker_shard?: string | null;
  deployment_target?: string | null;
  region_hint?: string | null;
  jurisdiction?: string | null;
  signature?: string | null;
  signature_key_id?: string | null;
  metadata_json?: string | null;
  actor_id?: string | null;
}

export interface TenantDatabaseActivePointer {
  tenant_id: string;
  role: TenantDatabaseRole;
  shard_group: string;
  generation: number;
  shard_count: number;
  shard_key_strategy: string;
  runtime_generation: number;
  status: TenantDatabaseActivePointerStatus;
  updated_at: string;
  updated_by: string | null;
  metadata_json: string | null;
}

export interface TenantDatabaseActivePointerInput {
  tenant_id: string;
  role: TenantDatabaseRole;
  shard_group?: string;
  generation: number;
  shard_count?: number;
  shard_key_strategy?: string;
  runtime_generation?: number;
  status?: TenantDatabaseActivePointerStatus;
  updated_by?: string | null;
  metadata_json?: string | null;
}

export type TenantRuntimeCacheNamespace =
  | 'settings'
  | 'policy'
  | 'runtime_registry'
  | 'identity_core'
  | 'identity_pii'
  | 'clients'
  | 'consent'
  | 'rebac';

export interface TenantRuntimeCacheGenerationRow {
  tenant_id: string;
  cache_namespace: TenantRuntimeCacheNamespace;
  generation: number;
  updated_at: string;
  updated_by: string | null;
  metadata_json: string | null;
}

export interface TenantRuntimeCacheGenerationInput {
  tenant_id: string;
  cache_namespace: TenantRuntimeCacheNamespace;
  generation: number;
  updated_by?: string | null;
  metadata_json?: string | null;
}

export type TenantRuntimeRegistrySnapshotScope = 'tenant' | 'deployment_target';
export type TenantRuntimeRegistrySnapshotStatus = 'active' | 'superseded' | 'expired' | 'invalid';

export interface TenantRuntimeRegistrySnapshotRow {
  tenant_id: string;
  snapshot_scope: TenantRuntimeRegistrySnapshotScope;
  deployment_target: string;
  runtime_generation: number;
  backend_provider: 'd1';
  placement_policy: 'shared_pool' | 'tenant_exclusive';
  placement_policy_generation: number;
  snapshot_version: number;
  status: TenantRuntimeRegistrySnapshotStatus;
  object_ref: string | null;
  published_at: string;
  expires_at: string;
  signature: string | null;
  signature_key_id: string | null;
  metadata_json: string | null;
}

export interface TenantRuntimeRegistrySnapshotInput {
  tenant_id: string;
  snapshot_scope?: TenantRuntimeRegistrySnapshotScope;
  deployment_target?: string;
  runtime_generation: number;
  backend_provider: 'd1';
  placement_policy: 'shared_pool' | 'tenant_exclusive';
  placement_policy_generation: number;
  snapshot_version?: number;
  status?: TenantRuntimeRegistrySnapshotStatus;
  object_ref?: string | null;
  published_at: string;
  expires_at: string;
  signature?: string | null;
  signature_key_id?: string | null;
  metadata_json?: string | null;
}

export interface TenantDatabaseStatsKey {
  tenant_id: string;
  role: TenantDatabaseRole;
  generation: number;
  shard_group?: string;
  shard_index?: number;
}

export interface TenantDatabaseStatsRow extends Required<TenantDatabaseStatsKey> {
  account_count: number | null;
  active_user_count: number | null;
  active_pending_user_count: number | null;
  d1_file_size_bytes: number | null;
  d1_file_size_checked_at: string | null;
  d1_file_size_status: TenantDatabaseD1FileSizeStatus;
  table_size_estimate_json: string | null;
  row_count_estimate_json: string | null;
  warning_state: TenantDatabaseStatsWarningState;
  warning_reasons_json: string | null;
  stats_checked_at: string;
  updated_at: string;
}

export interface TenantDatabaseStatsInput extends TenantDatabaseStatsKey {
  account_count?: number | null;
  active_user_count?: number | null;
  active_pending_user_count?: number | null;
  d1_file_size_bytes?: number | null;
  d1_file_size_checked_at?: string | null;
  d1_file_size_status?: TenantDatabaseD1FileSizeStatus;
  table_size_estimate_json?: string | null;
  row_count_estimate_json?: string | null;
  warning_state?: TenantDatabaseStatsWarningState;
  warning_reasons_json?: string | null;
  stats_checked_at: string;
}

export interface TenantDatabaseStatsSummary {
  active_tenant_core_databases: number;
  stats_rows: number;
  missing_stats_count: number;
  stale_stats_count: number;
  warning_count: number;
  strong_warning_count: number;
  stale_file_size_count: number;
  unavailable_file_size_count: number;
}

function normalizeShardGroup(value: string | undefined): string {
  return value?.trim() || 'default';
}

function normalizeShardIndex(value: number | undefined): number {
  return value ?? 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class TenantDatabaseRegistryRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async upsertRegistryRow(input: TenantDatabaseRegistryInput): Promise<TenantDatabaseRegistryRow> {
    const shardGroup = normalizeShardGroup(input.shard_group);
    const shardIndex = normalizeShardIndex(input.shard_index);
    const now = nowIso();
    const existing = await this.getRegistryRow({
      tenant_id: input.tenant_id,
      role: input.role,
      generation: input.generation,
      shard_group: shardGroup,
      shard_index: shardIndex,
    });

    if (existing) {
      await this.adapter.execute(
        `UPDATE tenant_database_registry
            SET provider = ?, database_id = ?, database_name = ?, binding_ref = ?,
                connection_ref = ?, schema_version = ?, status = ?, shard_count = ?,
                shard_key_strategy = ?, worker_shard = ?, deployment_target = ?,
                region_hint = ?, jurisdiction = ?, signature = ?, signature_key_id = ?,
                metadata_json = ?, updated_at = ?, updated_by = ?
          WHERE tenant_id = ? AND role = ? AND generation = ?
            AND shard_group = ? AND shard_index = ?`,
        [
          input.provider,
          input.database_id === undefined ? existing.database_id : input.database_id,
          input.database_name === undefined ? existing.database_name : input.database_name,
          input.binding_ref === undefined ? existing.binding_ref : input.binding_ref,
          input.connection_ref === undefined ? existing.connection_ref : input.connection_ref,
          input.schema_version ?? existing.schema_version,
          input.status ?? existing.status,
          input.shard_count ?? existing.shard_count,
          input.shard_key_strategy ?? existing.shard_key_strategy,
          input.worker_shard === undefined ? existing.worker_shard : input.worker_shard,
          input.deployment_target === undefined
            ? existing.deployment_target
            : input.deployment_target,
          input.region_hint === undefined ? existing.region_hint : input.region_hint,
          input.jurisdiction === undefined ? existing.jurisdiction : input.jurisdiction,
          input.signature === undefined ? existing.signature : input.signature,
          input.signature_key_id === undefined ? existing.signature_key_id : input.signature_key_id,
          input.metadata_json === undefined ? existing.metadata_json : input.metadata_json,
          now,
          input.actor_id ?? null,
          input.tenant_id,
          input.role,
          input.generation,
          shardGroup,
          shardIndex,
        ]
      );
    } else {
      await this.adapter.execute(
        `INSERT INTO tenant_database_registry (
           tenant_id, role, generation, shard_group, shard_index, provider,
           database_id, database_name, binding_ref, connection_ref, schema_version,
           status, shard_count, shard_key_strategy, worker_shard, deployment_target,
           region_hint, jurisdiction, signature, signature_key_id, metadata_json,
           created_at, updated_at, created_by, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.tenant_id,
          input.role,
          input.generation,
          shardGroup,
          shardIndex,
          input.provider,
          input.database_id ?? null,
          input.database_name ?? null,
          input.binding_ref ?? null,
          input.connection_ref ?? null,
          input.schema_version ?? 1,
          input.status ?? 'requested',
          input.shard_count ?? 1,
          input.shard_key_strategy ?? 'none',
          input.worker_shard ?? null,
          input.deployment_target ?? null,
          input.region_hint ?? null,
          input.jurisdiction ?? null,
          input.signature ?? null,
          input.signature_key_id ?? null,
          input.metadata_json ?? null,
          now,
          now,
          input.actor_id ?? null,
          input.actor_id ?? null,
        ]
      );
    }

    const saved = await this.getRegistryRow({
      tenant_id: input.tenant_id,
      role: input.role,
      generation: input.generation,
      shard_group: shardGroup,
      shard_index: shardIndex,
    });
    if (!saved) {
      throw new Error('tenant_database_registry_upsert_failed');
    }
    return saved;
  }

  async getRegistryRow(key: TenantDatabaseRegistryKey): Promise<TenantDatabaseRegistryRow | null> {
    return this.adapter.queryOne<TenantDatabaseRegistryRow>(
      `SELECT * FROM tenant_database_registry
        WHERE tenant_id = ? AND role = ? AND generation = ?
          AND shard_group = ? AND shard_index = ?`,
      [
        key.tenant_id,
        key.role,
        key.generation,
        normalizeShardGroup(key.shard_group),
        normalizeShardIndex(key.shard_index),
      ]
    );
  }

  async updateRegistryStatus(
    key: TenantDatabaseRegistryKey,
    status: TenantDatabaseStatus,
    actorId: string | null = null
  ): Promise<void> {
    await this.adapter.execute(
      `UPDATE tenant_database_registry
          SET status = ?, updated_at = ?, updated_by = ?
        WHERE tenant_id = ? AND role = ? AND generation = ?
          AND shard_group = ? AND shard_index = ?`,
      [
        status,
        nowIso(),
        actorId,
        key.tenant_id,
        key.role,
        key.generation,
        normalizeShardGroup(key.shard_group),
        normalizeShardIndex(key.shard_index),
      ]
    );
  }

  async updateRegistryStatusAndMetadata(
    key: TenantDatabaseRegistryKey,
    status: TenantDatabaseStatus,
    metadataJson: string | null,
    actorId: string | null = null
  ): Promise<void> {
    await this.adapter.execute(
      `UPDATE tenant_database_registry
          SET status = ?, metadata_json = ?, updated_at = ?, updated_by = ?
        WHERE tenant_id = ? AND role = ? AND generation = ?
          AND shard_group = ? AND shard_index = ?`,
      [
        status,
        metadataJson,
        nowIso(),
        actorId,
        key.tenant_id,
        key.role,
        key.generation,
        normalizeShardGroup(key.shard_group),
        normalizeShardIndex(key.shard_index),
      ]
    );
  }

  async listRegistryRowsForTenant(tenantId: string): Promise<TenantDatabaseRegistryRow[]> {
    return this.adapter.query<TenantDatabaseRegistryRow>(
      `SELECT * FROM tenant_database_registry
        WHERE tenant_id = ?
        ORDER BY role ASC, shard_group ASC, generation DESC, shard_index ASC`,
      [tenantId]
    );
  }

  async getActivePointer(
    tenantId: string,
    role: TenantDatabaseRole,
    shardGroup: string = 'default'
  ): Promise<TenantDatabaseActivePointer | null> {
    return this.adapter.queryOne<TenantDatabaseActivePointer>(
      `SELECT * FROM tenant_database_active_pointers
        WHERE tenant_id = ? AND role = ? AND shard_group = ?`,
      [tenantId, role, normalizeShardGroup(shardGroup)]
    );
  }

  async listActivePointersForTenant(tenantId: string): Promise<TenantDatabaseActivePointer[]> {
    return this.adapter.query<TenantDatabaseActivePointer>(
      `SELECT * FROM tenant_database_active_pointers
        WHERE tenant_id = ? AND status IN ('active', 'degraded_pending_snapshot')
        ORDER BY role ASC, shard_group ASC`,
      [tenantId]
    );
  }

  async updateActivePointerStatus(
    tenantId: string,
    role: TenantDatabaseRole,
    shardGroup: string,
    status: TenantDatabaseActivePointerStatus,
    actorId: string | null = null,
    metadataJson: string | null = null
  ): Promise<void> {
    await this.adapter.execute(
      `UPDATE tenant_database_active_pointers
          SET status = ?, metadata_json = ?, updated_at = ?, updated_by = ?
        WHERE tenant_id = ? AND role = ? AND shard_group = ?`,
      [status, metadataJson, nowIso(), actorId, tenantId, role, normalizeShardGroup(shardGroup)]
    );
  }

  async setActivePointer(
    input: TenantDatabaseActivePointerInput
  ): Promise<TenantDatabaseActivePointer> {
    const shardGroup = normalizeShardGroup(input.shard_group);
    const now = nowIso();

    await this.adapter.transaction(async (tx) => {
      const registry = await tx.queryOne<TenantDatabaseRegistryRow>(
        `SELECT * FROM tenant_database_registry
          WHERE tenant_id = ? AND role = ? AND generation = ? AND shard_group = ?
          ORDER BY shard_index ASC LIMIT 1`,
        [input.tenant_id, input.role, input.generation, shardGroup]
      );
      if (!registry) {
        throw new Error('tenant_database_active_pointer_missing_registry_row');
      }

      const existing = await tx.queryOne<TenantDatabaseActivePointer>(
        `SELECT * FROM tenant_database_active_pointers
          WHERE tenant_id = ? AND role = ? AND shard_group = ?`,
        [input.tenant_id, input.role, shardGroup]
      );

      if (existing) {
        await tx.execute(
          `UPDATE tenant_database_active_pointers
              SET generation = ?, shard_count = ?, shard_key_strategy = ?,
                  runtime_generation = ?, status = ?, updated_at = ?, updated_by = ?,
                  metadata_json = ?
            WHERE tenant_id = ? AND role = ? AND shard_group = ?`,
          [
            input.generation,
            input.shard_count ?? registry.shard_count,
            input.shard_key_strategy ?? registry.shard_key_strategy,
            input.runtime_generation ?? existing.runtime_generation + 1,
            input.status ?? 'active',
            now,
            input.updated_by ?? null,
            input.metadata_json ?? null,
            input.tenant_id,
            input.role,
            shardGroup,
          ]
        );
      } else {
        await tx.execute(
          `INSERT INTO tenant_database_active_pointers (
             tenant_id, role, shard_group, generation, shard_count, shard_key_strategy,
             runtime_generation, status, updated_at, updated_by, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.tenant_id,
            input.role,
            shardGroup,
            input.generation,
            input.shard_count ?? registry.shard_count,
            input.shard_key_strategy ?? registry.shard_key_strategy,
            input.runtime_generation ?? 1,
            input.status ?? 'active',
            now,
            input.updated_by ?? null,
            input.metadata_json ?? null,
          ]
        );
      }
    });

    const saved = await this.getActivePointer(input.tenant_id, input.role, shardGroup);
    if (!saved) {
      throw new Error('tenant_database_active_pointer_upsert_failed');
    }
    return saved;
  }

  async listActiveRegistryRowsForRole(
    role: TenantDatabaseRole,
    limit: number = 100,
    offset: number = 0
  ): Promise<TenantDatabaseRegistryRow[]> {
    return this.adapter.query<TenantDatabaseRegistryRow>(
      `SELECT r.*
         FROM tenant_database_active_pointers p
         JOIN tenant_database_registry r
           ON r.tenant_id = p.tenant_id
          AND r.role = p.role
          AND r.generation = p.generation
          AND r.shard_group = p.shard_group
        WHERE p.role = ?
          AND p.status IN ('active', 'degraded_pending_snapshot')
          AND r.status IN ('ready', 'active', 'degraded', 'degraded_pending_snapshot')
        ORDER BY p.updated_at ASC, p.tenant_id ASC, r.shard_index ASC
        LIMIT ? OFFSET ?`,
      [role, limit, offset]
    );
  }

  async listActiveRegistryRowsForTenantRole(
    tenantId: string,
    role: TenantDatabaseRole
  ): Promise<TenantDatabaseRegistryRow[]> {
    return this.adapter.query<TenantDatabaseRegistryRow>(
      `SELECT r.*
         FROM tenant_database_active_pointers p
         JOIN tenant_database_registry r
           ON r.tenant_id = p.tenant_id
          AND r.role = p.role
          AND r.generation = p.generation
          AND r.shard_group = p.shard_group
        WHERE p.tenant_id = ?
          AND p.role = ?
          AND p.status IN ('active', 'degraded_pending_snapshot')
          AND r.status IN ('ready', 'active', 'degraded', 'degraded_pending_snapshot')
        ORDER BY p.updated_at ASC, r.shard_index ASC`,
      [tenantId, role]
    );
  }

  async upsertRuntimeCacheGeneration(
    input: TenantRuntimeCacheGenerationInput
  ): Promise<TenantRuntimeCacheGenerationRow> {
    const now = nowIso();
    await this.adapter.execute(
      `INSERT INTO tenant_runtime_cache_generations (
         tenant_id, cache_namespace, generation, updated_at, updated_by, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, cache_namespace) DO UPDATE SET
         generation = excluded.generation,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by,
         metadata_json = excluded.metadata_json`,
      [
        input.tenant_id,
        input.cache_namespace,
        input.generation,
        now,
        input.updated_by ?? null,
        input.metadata_json ?? null,
      ]
    );

    const saved = await this.adapter.queryOne<TenantRuntimeCacheGenerationRow>(
      `SELECT * FROM tenant_runtime_cache_generations
        WHERE tenant_id = ? AND cache_namespace = ?`,
      [input.tenant_id, input.cache_namespace]
    );
    if (!saved) {
      throw new Error('tenant_runtime_cache_generation_upsert_failed');
    }
    return saved;
  }

  async getRuntimeCacheGeneration(
    tenantId: string,
    cacheNamespace: TenantRuntimeCacheNamespace
  ): Promise<TenantRuntimeCacheGenerationRow | null> {
    return this.adapter.queryOne<TenantRuntimeCacheGenerationRow>(
      `SELECT * FROM tenant_runtime_cache_generations
        WHERE tenant_id = ? AND cache_namespace = ?`,
      [tenantId, cacheNamespace]
    );
  }

  async compareAndSetRuntimeCacheGeneration(
    input: TenantRuntimeCacheGenerationInput,
    expected: TenantRuntimeCacheGenerationRow | null
  ): Promise<boolean> {
    const now = nowIso();
    if (!expected) {
      const inserted = await this.adapter.execute(
        `INSERT OR IGNORE INTO tenant_runtime_cache_generations (
           tenant_id, cache_namespace, generation, updated_at, updated_by, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.tenant_id,
          input.cache_namespace,
          input.generation,
          now,
          input.updated_by ?? null,
          input.metadata_json ?? null,
        ]
      );
      return inserted.rowsAffected === 1;
    }

    const updated = await this.adapter.execute(
      `UPDATE tenant_runtime_cache_generations
          SET generation = ?, updated_at = ?, updated_by = ?, metadata_json = ?
        WHERE tenant_id = ? AND cache_namespace = ?
          AND generation = ? AND updated_at = ? AND metadata_json IS ?`,
      [
        input.generation,
        now,
        input.updated_by ?? null,
        input.metadata_json ?? null,
        input.tenant_id,
        input.cache_namespace,
        expected.generation,
        expected.updated_at,
        expected.metadata_json,
      ]
    );
    return updated.rowsAffected === 1;
  }

  async commitRuntimeCacheGenerationPublication(
    input: TenantRuntimeCacheGenerationInput,
    expected: TenantRuntimeCacheGenerationRow | null
  ): Promise<boolean> {
    return this.compareAndSetRuntimeCacheGeneration(input, expected);
  }

  async upsertRuntimeRegistrySnapshot(
    input: TenantRuntimeRegistrySnapshotInput
  ): Promise<TenantRuntimeRegistrySnapshotRow> {
    const snapshotScope = input.snapshot_scope ?? 'tenant';
    const deploymentTarget = input.deployment_target ?? 'default';
    const snapshotVersion = input.snapshot_version ?? 3;
    const status = input.status ?? 'active';

    await this.adapter.execute(
      `INSERT INTO tenant_runtime_registry_snapshots (
         tenant_id, snapshot_scope, deployment_target, runtime_generation,
         backend_provider, placement_policy, placement_policy_generation,
         snapshot_version, status, object_ref, published_at,
         expires_at, signature, signature_key_id, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, snapshot_scope, deployment_target, runtime_generation)
       DO UPDATE SET
         backend_provider = excluded.backend_provider,
         placement_policy = excluded.placement_policy,
         placement_policy_generation = excluded.placement_policy_generation,
         snapshot_version = excluded.snapshot_version,
         status = excluded.status,
         object_ref = excluded.object_ref,
         published_at = excluded.published_at,
         expires_at = excluded.expires_at,
         signature = excluded.signature,
         signature_key_id = excluded.signature_key_id,
         metadata_json = excluded.metadata_json`,
      [
        input.tenant_id,
        snapshotScope,
        deploymentTarget,
        input.runtime_generation,
        input.backend_provider,
        input.placement_policy,
        input.placement_policy_generation,
        snapshotVersion,
        status,
        input.object_ref ?? null,
        input.published_at,
        input.expires_at,
        input.signature ?? null,
        input.signature_key_id ?? null,
        input.metadata_json ?? null,
      ]
    );

    const saved = await this.adapter.queryOne<TenantRuntimeRegistrySnapshotRow>(
      `SELECT * FROM tenant_runtime_registry_snapshots
        WHERE tenant_id = ? AND snapshot_scope = ?
          AND deployment_target = ? AND runtime_generation = ?`,
      [input.tenant_id, snapshotScope, deploymentTarget, input.runtime_generation]
    );
    if (!saved) {
      throw new Error('tenant_runtime_registry_snapshot_upsert_failed');
    }
    return saved;
  }

  async getLatestRuntimeRegistrySnapshot(
    tenantId: string,
    deploymentTarget: string = 'default',
    snapshotScope: TenantRuntimeRegistrySnapshotScope = 'tenant'
  ): Promise<TenantRuntimeRegistrySnapshotRow | null> {
    return this.adapter.queryOne<TenantRuntimeRegistrySnapshotRow>(
      `SELECT * FROM tenant_runtime_registry_snapshots
        WHERE tenant_id = ? AND snapshot_scope = ?
          AND deployment_target = ? AND status = 'active'
        ORDER BY runtime_generation DESC, published_at DESC
        LIMIT 1`,
      [tenantId, snapshotScope, deploymentTarget]
    );
  }

  async upsertStats(input: TenantDatabaseStatsInput): Promise<TenantDatabaseStatsRow> {
    const shardGroup = normalizeShardGroup(input.shard_group);
    const shardIndex = normalizeShardIndex(input.shard_index);
    const now = nowIso();

    await this.adapter.execute(
      `INSERT INTO tenant_database_stats (
         tenant_id, role, generation, shard_group, shard_index,
         account_count, active_user_count, active_pending_user_count,
         d1_file_size_bytes, d1_file_size_checked_at, d1_file_size_status,
         table_size_estimate_json, row_count_estimate_json,
         warning_state, warning_reasons_json, stats_checked_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, role, generation, shard_group, shard_index) DO UPDATE SET
         account_count = excluded.account_count,
         active_user_count = excluded.active_user_count,
         active_pending_user_count = excluded.active_pending_user_count,
         d1_file_size_bytes = excluded.d1_file_size_bytes,
         d1_file_size_checked_at = excluded.d1_file_size_checked_at,
         d1_file_size_status = excluded.d1_file_size_status,
         table_size_estimate_json = excluded.table_size_estimate_json,
         row_count_estimate_json = excluded.row_count_estimate_json,
         warning_state = excluded.warning_state,
         warning_reasons_json = excluded.warning_reasons_json,
         stats_checked_at = excluded.stats_checked_at,
         updated_at = excluded.updated_at`,
      [
        input.tenant_id,
        input.role,
        input.generation,
        shardGroup,
        shardIndex,
        input.account_count ?? null,
        input.active_user_count ?? null,
        input.active_pending_user_count ?? null,
        input.d1_file_size_bytes ?? null,
        input.d1_file_size_checked_at ?? null,
        input.d1_file_size_status ?? 'unknown',
        input.table_size_estimate_json ?? null,
        input.row_count_estimate_json ?? null,
        input.warning_state ?? 'ok',
        input.warning_reasons_json ?? null,
        input.stats_checked_at,
        now,
      ]
    );

    const saved = await this.getStats({
      tenant_id: input.tenant_id,
      role: input.role,
      generation: input.generation,
      shard_group: shardGroup,
      shard_index: shardIndex,
    });
    if (!saved) {
      throw new Error('tenant_database_stats_upsert_failed');
    }
    return saved;
  }

  async getStats(key: TenantDatabaseStatsKey): Promise<TenantDatabaseStatsRow | null> {
    return this.adapter.queryOne<TenantDatabaseStatsRow>(
      `SELECT * FROM tenant_database_stats
        WHERE tenant_id = ? AND role = ? AND generation = ?
          AND shard_group = ? AND shard_index = ?`,
      [
        key.tenant_id,
        key.role,
        key.generation,
        normalizeShardGroup(key.shard_group),
        normalizeShardIndex(key.shard_index),
      ]
    );
  }

  async listStatsOlderThan(
    cutoffIso: string,
    limit: number = 100
  ): Promise<TenantDatabaseStatsRow[]> {
    return this.adapter.query<TenantDatabaseStatsRow>(
      `SELECT * FROM tenant_database_stats
        WHERE stats_checked_at < ?
        ORDER BY stats_checked_at ASC
        LIMIT ?`,
      [cutoffIso, limit]
    );
  }

  async getStatsSummary(cutoffIso: string): Promise<TenantDatabaseStatsSummary> {
    const row = await this.adapter.queryOne<
      Record<keyof TenantDatabaseStatsSummary, number | null>
    >(
      `SELECT
         COUNT(*) AS active_tenant_core_databases,
         SUM(CASE WHEN s.stats_checked_at IS NOT NULL THEN 1 ELSE 0 END) AS stats_rows,
         SUM(CASE WHEN s.stats_checked_at IS NULL THEN 1 ELSE 0 END) AS missing_stats_count,
         SUM(CASE WHEN s.stats_checked_at IS NOT NULL AND s.stats_checked_at < ? THEN 1 ELSE 0 END)
           AS stale_stats_count,
         SUM(CASE WHEN s.warning_state = 'warning' THEN 1 ELSE 0 END) AS warning_count,
         SUM(CASE WHEN s.warning_state = 'strong_warning' THEN 1 ELSE 0 END)
           AS strong_warning_count,
         SUM(CASE WHEN s.d1_file_size_status = 'stale' THEN 1 ELSE 0 END)
           AS stale_file_size_count,
         SUM(CASE WHEN s.d1_file_size_status = 'unavailable' THEN 1 ELSE 0 END)
           AS unavailable_file_size_count
       FROM tenant_database_active_pointers p
       JOIN tenant_database_registry r
         ON r.tenant_id = p.tenant_id
        AND r.role = p.role
        AND r.generation = p.generation
        AND r.shard_group = p.shard_group
       LEFT JOIN tenant_database_stats s
         ON s.tenant_id = r.tenant_id
        AND s.role = r.role
        AND s.generation = r.generation
        AND s.shard_group = r.shard_group
        AND s.shard_index = r.shard_index
      WHERE p.role = 'tenant_core'
        AND p.status IN ('active', 'degraded_pending_snapshot')
        AND r.status IN ('ready', 'active', 'degraded', 'degraded_pending_snapshot')`,
      [cutoffIso]
    );

    return {
      active_tenant_core_databases: row?.active_tenant_core_databases ?? 0,
      stats_rows: row?.stats_rows ?? 0,
      missing_stats_count: row?.missing_stats_count ?? 0,
      stale_stats_count: row?.stale_stats_count ?? 0,
      warning_count: row?.warning_count ?? 0,
      strong_warning_count: row?.strong_warning_count ?? 0,
      stale_file_size_count: row?.stale_file_size_count ?? 0,
      unavailable_file_size_count: row?.unavailable_file_size_count ?? 0,
    };
  }
}
