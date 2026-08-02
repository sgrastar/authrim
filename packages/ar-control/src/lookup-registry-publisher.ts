import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  signLookupShardRegistry,
  type LookupShardRegistryRange,
} from '@authrim/ar-lib-core';
import type { JWK } from 'jose';
import type { ControlEnv } from './types';

const REGISTRY_TTL_SECONDS = 30 * 60;
const REGISTRY_REFRESH_WINDOW_SECONDS = 10 * 60;
const MAX_ENVIRONMENTS_PER_RUN = 100;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

interface AssignmentRow {
  virtual_bucket: number;
  assignment_generation: number;
  lookup_shard_id: string;
  binding_ref: string;
}

interface PublicationRow {
  environment_id: string;
  generation: number;
  mapping_digest: string;
  snapshot_jws: string;
  issued_at: number;
  expires_at: number;
  status: 'publishing' | 'active';
}

export interface LookupRegistryPublishResult {
  environmentId: string;
  generation: number;
  status: 'published' | 'unchanged' | 'resumed';
}

export function runtimeRegistryPrivateJwkForSlot(
  env: ControlEnv,
  slot: 'A' | 'B',
  expectedKeyId: string
): JWK {
  const encoded =
    slot === 'A'
      ? env.RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A
      : env.RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B;
  if (!encoded || !expectedKeyId || !SAFE_ID.test(expectedKeyId) || encoded.length > 16_384) {
    throw new Error('lookup_registry_signing_key_unavailable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error('lookup_registry_signing_key_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('lookup_registry_signing_key_invalid');
  }
  const jwk = parsed as JWK;
  if (jwk.kid !== expectedKeyId) throw new Error('lookup_registry_signing_key_id_mismatch');
  return jwk;
}

export function runtimeRegistryPrivateJwk(env: ControlEnv): JWK {
  const activeSlot = env.RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT;
  if (activeSlot !== 'A' && activeSlot !== 'B') {
    throw new Error('lookup_registry_signing_slot_invalid');
  }
  const expectedKeyId = env.TENANT_RUNTIME_REGISTRY_SIGNING_KEY_ID;
  if (!expectedKeyId) throw new Error('lookup_registry_signing_key_unavailable');
  return runtimeRegistryPrivateJwkForSlot(env, activeSlot, expectedKeyId);
}

function ranges(rows: AssignmentRow[]): LookupShardRegistryRange[] {
  if (rows.length !== 4096) throw new Error('lookup_registry_assignment_coverage_incomplete');
  const result: LookupShardRegistryRange[] = [];
  for (let bucket = 0; bucket < rows.length; bucket += 1) {
    const row = rows[bucket];
    if (
      row.virtual_bucket !== bucket ||
      !Number.isSafeInteger(row.assignment_generation) ||
      row.assignment_generation < 1 ||
      !SAFE_ID.test(row.lookup_shard_id) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(row.binding_ref)
    ) {
      throw new Error('lookup_registry_assignment_invalid');
    }
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.endBucket === bucket - 1 &&
      previous.assignmentGeneration === row.assignment_generation &&
      previous.lookupShardId === row.lookup_shard_id &&
      previous.bindingRef === row.binding_ref
    ) {
      previous.endBucket = bucket;
    } else {
      result.push({
        startBucket: bucket,
        endBucket: bucket,
        assignmentGeneration: row.assignment_generation,
        lookupShardId: row.lookup_shard_id,
        bindingRef: row.binding_ref,
      });
    }
  }
  return result;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class LookupRegistryPublisher {
  constructor(
    private readonly env: ControlEnv,
    private readonly now: () => number
  ) {}

  async reconcile(): Promise<LookupRegistryPublishResult[]> {
    if (!this.env.TENANT_RUNTIME_REGISTRY) {
      throw new Error('lookup_registry_store_unavailable');
    }
    const environments = await this.env.CONTROL_DB.prepare(
      `SELECT assignment.environment_id
         FROM control_lookup_bucket_assignments assignment
         LEFT JOIN control_lookup_physical_shards shard
           ON shard.environment_id = assignment.environment_id
          AND shard.lookup_shard_id = assignment.lookup_shard_id
         LEFT JOIN control_lookup_registry_publications publication
           ON publication.environment_id = assignment.environment_id
        GROUP BY assignment.environment_id
        HAVING COUNT(*) = 4096
           AND SUM(CASE WHEN shard.status = 'active' THEN 1 ELSE 0 END) = 4096
        ORDER BY CASE
                   WHEN publication.environment_id IS NULL THEN 0
                   WHEN publication.status = 'publishing' THEN 1
                   ELSE 2
                 END,
                 publication.expires_at, assignment.environment_id
        LIMIT ?`
    )
      .bind(MAX_ENVIRONMENTS_PER_RUN)
      .all<{ environment_id: string }>();
    const results: LookupRegistryPublishResult[] = [];
    for (const row of environments.results) {
      if (!SAFE_ID.test(row.environment_id)) throw new Error('lookup_registry_environment_invalid');
      results.push(await this.publishEnvironment(row.environment_id));
    }
    return results;
  }

  async publishEnvironment(environmentId: string): Promise<LookupRegistryPublishResult> {
    if (!SAFE_ID.test(environmentId)) throw new Error('lookup_registry_environment_invalid');
    const store = this.env.TENANT_RUNTIME_REGISTRY;
    if (!store) throw new Error('lookup_registry_store_unavailable');
    const now = this.now();
    const existing = await this.state(environmentId);
    if (
      existing?.status === 'publishing' &&
      existing.expires_at > now + REGISTRY_REFRESH_WINDOW_SECONDS
    ) {
      await this.publishPrepared(existing, store);
      return { environmentId, generation: existing.generation, status: 'resumed' };
    }
    const assignmentRows = await this.env.CONTROL_DB.prepare(
      `SELECT assignment.virtual_bucket, assignment.assignment_generation,
              assignment.lookup_shard_id, shard.binding_ref
         FROM control_lookup_bucket_assignments assignment
         JOIN control_lookup_physical_shards shard
           ON shard.environment_id = assignment.environment_id
          AND shard.lookup_shard_id = assignment.lookup_shard_id
        WHERE assignment.environment_id = ? AND shard.status = 'active'
        ORDER BY assignment.virtual_bucket`
    )
      .bind(environmentId)
      .all<AssignmentRow>();
    const registryRanges = ranges(assignmentRows.results);
    const mappingDigest = await sha256(JSON.stringify(registryRanges));
    if (
      existing?.status === 'active' &&
      existing.mapping_digest === mappingDigest &&
      existing.expires_at > now + REGISTRY_REFRESH_WINDOW_SECONDS
    ) {
      if (await this.isReflected(existing, store)) {
        return { environmentId, generation: existing.generation, status: 'unchanged' };
      }
      await this.publishPrepared(existing, store);
      return { environmentId, generation: existing.generation, status: 'resumed' };
    }
    const generation = (existing?.generation ?? 0) + 1;
    const issuedAt = now;
    const expiresAt = now + REGISTRY_TTL_SECONDS;
    const snapshot = await signLookupShardRegistry({
      registry: {
        environmentId,
        generation,
        issuedAt,
        expiresAt,
        ranges: registryRanges,
      },
      privateJwk: runtimeRegistryPrivateJwk(this.env),
    });
    if (existing) {
      await this.env.CONTROL_DB.prepare(
        `UPDATE control_lookup_registry_publications
            SET generation = ?, mapping_digest = ?, snapshot_jws = ?, issued_at = ?,
                expires_at = ?, status = 'publishing', updated_at = ?
          WHERE environment_id = ? AND generation = ? AND status = ?`
      )
        .bind(
          generation,
          mappingDigest,
          snapshot,
          issuedAt,
          expiresAt,
          now,
          environmentId,
          existing.generation,
          existing.status
        )
        .run();
    } else {
      await this.env.CONTROL_DB.prepare(
        `INSERT OR IGNORE INTO control_lookup_registry_publications (
           environment_id, generation, mapping_digest, snapshot_jws, issued_at,
           expires_at, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'publishing', ?)`
      )
        .bind(environmentId, generation, mappingDigest, snapshot, issuedAt, expiresAt, now)
        .run();
    }
    const prepared = await this.state(environmentId);
    if (!prepared) throw new Error('lookup_registry_publication_prepare_failed');
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

  private async state(environmentId: string): Promise<PublicationRow | null> {
    return this.env.CONTROL_DB.prepare(
      `SELECT environment_id, generation, mapping_digest, snapshot_jws,
              issued_at, expires_at, status
         FROM control_lookup_registry_publications WHERE environment_id = ?`
    )
      .bind(environmentId)
      .first<PublicationRow>();
  }

  private async publishPrepared(state: PublicationRow, store: KVNamespace): Promise<void> {
    await store.put(buildLookupShardRegistrySnapshotKey(state.environment_id), state.snapshot_jws);
    await store.put(
      buildLookupShardRegistryGenerationKey(state.environment_id),
      String(state.generation)
    );
    if (!(await this.isReflected(state, store))) {
      throw new Error('lookup_registry_publication_reflection_failed');
    }
    const completed = await this.env.CONTROL_DB.prepare(
      `UPDATE control_lookup_registry_publications SET status = 'active', updated_at = ?
        WHERE environment_id = ? AND generation = ? AND status = 'publishing'
          AND snapshot_jws = ?`
    )
      .bind(this.now(), state.environment_id, state.generation, state.snapshot_jws)
      .run();
    if ((completed.meta.changes ?? 0) !== 1) {
      const adopted = await this.state(state.environment_id);
      if (
        adopted?.status === 'active' &&
        adopted.generation === state.generation &&
        adopted.snapshot_jws === state.snapshot_jws
      ) {
        return;
      }
      throw new Error('lookup_registry_publication_stale');
    }
  }

  private async isReflected(state: PublicationRow, store: KVNamespace): Promise<boolean> {
    const [snapshot, generation] = await Promise.all([
      store.get(buildLookupShardRegistrySnapshotKey(state.environment_id)),
      store.get(buildLookupShardRegistryGenerationKey(state.environment_id)),
    ]);
    return snapshot === state.snapshot_jws && generation === String(state.generation);
  }
}
