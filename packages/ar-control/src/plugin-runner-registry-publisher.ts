import {
  buildPluginRunnerRegistryGenerationKey,
  buildPluginRunnerRegistrySnapshotKey,
  signPluginRunnerRegistry,
  type PluginRunnerRegistryDataRole,
  type PluginRunnerRegistryShard,
} from '@authrim/ar-lib-core/control-plane';
import type { JWK } from 'jose';
import type { ControlEnv } from './types';

const REGISTRY_TTL_SECONDS = 30 * 60;
const REGISTRY_REFRESH_WINDOW_SECONDS = 10 * 60;
const MAX_ENVIRONMENTS_PER_RUN = 100;
const MAX_SHARDS_PER_ENVIRONMENT = 5_000;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_BINDING = /^TDB_[A-Z0-9_]{1,120}$/u;
const SAFE_PARTITION = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DATA_ROLES = new Set(['tenant_core/default', 'tenant_core/users'] as const);
const SHARED_CORE_SHARD: ShardRow = {
  shard_id: 'platform-shared-core',
  binding_ref: 'TDB_SHARED_CORE',
  data_role: 'tenant_core/default',
  residency_partition: 'global',
  generation: 1,
};

interface ShardRow {
  shard_id: string;
  binding_ref: string;
  data_role: string;
  residency_partition: string;
  generation: number;
}

interface PublicationRow {
  environment_id: string;
  generation: number;
  inventory_digest: string;
  snapshot_jws: string;
  issued_at: number;
  expires_at: number;
  status: 'publishing' | 'active';
}

export interface PluginRunnerRegistryPublishResult {
  environmentId: string;
  generation: number;
  status: 'published' | 'unchanged' | 'resumed';
}

function privateJwk(env: ControlEnv): JWK {
  const activeSlot = env.RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT;
  if (activeSlot !== 'A' && activeSlot !== 'B') {
    throw new Error('plugin_runner_registry_signing_slot_invalid');
  }
  const encoded =
    activeSlot === 'A'
      ? env.RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A
      : env.RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B;
  const expectedKeyId = env.TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID;
  if (!encoded || !expectedKeyId || !SAFE_ID.test(expectedKeyId) || encoded.length > 16_384) {
    throw new Error('plugin_runner_registry_signing_key_unavailable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error('plugin_runner_registry_signing_key_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('plugin_runner_registry_signing_key_invalid');
  }
  const jwk = parsed as JWK;
  if (jwk.kid !== expectedKeyId) {
    throw new Error('plugin_runner_registry_signing_key_id_mismatch');
  }
  return jwk;
}

function normalizeShards(rows: ShardRow[]): PluginRunnerRegistryShard[] {
  if (rows.length > MAX_SHARDS_PER_ENVIRONMENT) {
    throw new Error('plugin_runner_registry_shard_limit_exceeded');
  }
  return rows.map((row) => {
    if (
      !SAFE_ID.test(row.shard_id) ||
      !SAFE_BINDING.test(row.binding_ref) ||
      !DATA_ROLES.has(row.data_role as PluginRunnerRegistryDataRole) ||
      !SAFE_PARTITION.test(row.residency_partition) ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 1
    ) {
      throw new Error('plugin_runner_registry_shard_invalid');
    }
    return {
      shardId: row.shard_id,
      bindingRef: row.binding_ref,
      dataRole: row.data_role as PluginRunnerRegistryDataRole,
      residencyPartition: row.residency_partition,
      routeGeneration: row.generation,
    };
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class PluginRunnerRegistryPublisher {
  constructor(
    private readonly env: ControlEnv,
    private readonly now: () => number
  ) {}

  async reconcile(): Promise<PluginRunnerRegistryPublishResult[]> {
    if (!this.env.TENANT_RUNTIME_REGISTRY) {
      throw new Error('plugin_runner_registry_store_unavailable');
    }
    const environments = await this.env.CONTROL_DB.prepare(
      `SELECT environment.environment_id
         FROM control_environments environment
         LEFT JOIN control_plugin_runner_registry_publications publication
           ON publication.environment_id = environment.environment_id
        WHERE environment.lifecycle_state IN ('creating', 'active')
        ORDER BY CASE
                   WHEN publication.environment_id IS NULL THEN 0
                   WHEN publication.status = 'publishing' THEN 1
                   ELSE 2
                 END,
                 publication.expires_at, environment.environment_id
        LIMIT ?`
    )
      .bind(MAX_ENVIRONMENTS_PER_RUN)
      .all<{ environment_id: string }>();
    const results: PluginRunnerRegistryPublishResult[] = [];
    for (const row of environments.results) {
      if (!SAFE_ID.test(row.environment_id)) {
        throw new Error('plugin_runner_registry_environment_invalid');
      }
      results.push(await this.publishEnvironment(row.environment_id));
    }
    return results;
  }

  async publishEnvironment(environmentId: string): Promise<PluginRunnerRegistryPublishResult> {
    if (!SAFE_ID.test(environmentId)) {
      throw new Error('plugin_runner_registry_environment_invalid');
    }
    const store = this.env.TENANT_RUNTIME_REGISTRY;
    if (!store) throw new Error('plugin_runner_registry_store_unavailable');
    const now = this.now();
    const existing = await this.state(environmentId);
    if (
      existing?.status === 'publishing' &&
      existing.expires_at > now + REGISTRY_REFRESH_WINDOW_SECONDS
    ) {
      await this.publishPrepared(existing, store);
      return { environmentId, generation: existing.generation, status: 'resumed' };
    }
    const rows = await this.env.CONTROL_DB.prepare(
      `SELECT shard_id, binding_ref, data_role, residency_partition, generation
         FROM control_tenant_shards
        WHERE environment_id = ? AND status = 'active'
          AND data_role IN ('tenant_core/default', 'tenant_core/users')
        ORDER BY shard_id
        LIMIT ?`
    )
      .bind(environmentId, MAX_SHARDS_PER_ENVIRONMENT + 1)
      .all<ShardRow>();
    const shards = normalizeShards(
      [...rows.results, SHARED_CORE_SHARD].sort((left, right) =>
        left.shard_id.localeCompare(right.shard_id)
      )
    );
    const inventoryDigest = await sha256(JSON.stringify(shards));
    if (
      existing?.status === 'active' &&
      existing.inventory_digest === inventoryDigest &&
      existing.expires_at > now + REGISTRY_REFRESH_WINDOW_SECONDS
    ) {
      return { environmentId, generation: existing.generation, status: 'unchanged' };
    }
    const generation = (existing?.generation ?? 0) + 1;
    const expiresAt = now + REGISTRY_TTL_SECONDS;
    const snapshot = await signPluginRunnerRegistry({
      registry: {
        environmentId,
        generation,
        issuedAt: now,
        expiresAt,
        shards,
      },
      privateJwk: privateJwk(this.env),
    });
    if (existing) {
      await this.env.CONTROL_DB.prepare(
        `UPDATE control_plugin_runner_registry_publications
            SET generation = ?, inventory_digest = ?, snapshot_jws = ?, issued_at = ?,
                expires_at = ?, status = 'publishing', updated_at = ?
          WHERE environment_id = ? AND generation = ? AND status = ?`
      )
        .bind(
          generation,
          inventoryDigest,
          snapshot,
          now,
          expiresAt,
          now,
          environmentId,
          existing.generation,
          existing.status
        )
        .run();
    } else {
      await this.env.CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO control_plugin_runner_registry_publications (
           environment_id, generation, inventory_digest, snapshot_jws, issued_at,
           expires_at, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'publishing', ?)`
      )
        .bind(environmentId, generation, inventoryDigest, snapshot, now, expiresAt, now)
        .run();
    }
    const prepared = await this.state(environmentId);
    if (!prepared) throw new Error('plugin_runner_registry_publication_prepare_failed');
    if (prepared.status === 'active') {
      return { environmentId, generation: prepared.generation, status: 'unchanged' };
    }
    await this.publishPrepared(prepared, store);
    return {
      environmentId,
      generation: prepared.generation,
      status: prepared.snapshot_jws === snapshot ? 'published' : 'resumed',
    };
  }

  private state(environmentId: string): Promise<PublicationRow | null> {
    return this.env.CONTROL_DB.prepare(
      `SELECT environment_id, generation, inventory_digest, snapshot_jws,
              issued_at, expires_at, status
         FROM control_plugin_runner_registry_publications WHERE environment_id = ?`
    )
      .bind(environmentId)
      .first<PublicationRow>();
  }

  private async publishPrepared(state: PublicationRow, store: KVNamespace): Promise<void> {
    await store.put(buildPluginRunnerRegistrySnapshotKey(state.environment_id), state.snapshot_jws);
    await store.put(
      buildPluginRunnerRegistryGenerationKey(state.environment_id),
      String(state.generation)
    );
    const completed = await this.env.CONTROL_DB.prepare(
      `UPDATE control_plugin_runner_registry_publications SET status = 'active', updated_at = ?
        WHERE environment_id = ? AND generation = ? AND status = 'publishing'
          AND snapshot_jws = ?`
    )
      .bind(this.now(), state.environment_id, state.generation, state.snapshot_jws)
      .run();
    if ((completed.meta.changes ?? 0) === 1) return;
    const adopted = await this.state(state.environment_id);
    if (
      adopted?.status === 'active' &&
      adopted.generation === state.generation &&
      adopted.snapshot_jws === state.snapshot_jws
    ) {
      return;
    }
    throw new Error('plugin_runner_registry_publication_stale');
  }
}
