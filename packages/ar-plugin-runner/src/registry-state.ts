import type { D1Database, D1DatabaseSession, D1Result } from '@cloudflare/workers-types';
import type {
  PluginRunnerRegistryClaims,
  PluginRunnerRegistryShard,
} from '@authrim/ar-lib-core/control-plane';

// Five one-minute invocations cover 1,000 shards while leaving query budget for delivery.
const SWEEP_BATCH_SIZE = 200;
const SWEEP_INTERVAL_SECONDS = 5 * 60;
const SWEEP_TARGET_SECONDS = 5 * 60;
const SHARD_LEASE_SECONDS = 45;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

interface RegistryStateRow {
  active_generation: number | string;
  pending_generation: number | string | null;
  pending_cursor: number | string;
  pending_shard_count: number | string;
  sweep_started_at: number | string | null;
  sweep_completed_at: number | string | null;
}

interface DueShardRow {
  tenant_shard_id: string;
  binding_ref: string;
  data_role: string;
  residency_partition: string;
  route_generation: number | string;
  fencing_token: number | string;
}

interface FinishedShardRow {
  next_due_at: number | string | null;
  last_scan_at: number | string | null;
  scheduler_error_code: string | null;
  lease_owner: string | null;
  fencing_token: number | string;
}

interface ClaimedCursorRow {
  tenant_shard_id: string;
  fencing_token: number | string;
}

export interface ClaimedRunnerShard {
  shardId: string;
  bindingRef: string;
  dataRole: 'tenant_core/default' | 'tenant_core/users';
  residencyPartition: string;
  routeGeneration: number;
  ownerId: string;
  fencingToken: number;
}

export interface RegistrySweepProgress {
  generation: number;
  startIndex: number;
  nextIndex: number;
  complete: boolean;
  overdue: boolean;
  shards: PluginRunnerRegistryShard[];
}

function primary(db: D1Database): D1DatabaseSession {
  if (typeof db.withSession !== 'function') {
    throw new Error('plugin_runner_state_d1_session_required');
  }
  return db.withSession('first-primary');
}

function integer(value: number | string | null, code: string, minimum = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code);
  return parsed;
}

function rowState(row: RegistryStateRow | null): {
  activeGeneration: number;
  pendingGeneration: number | null;
  pendingCursor: number;
  pendingShardCount: number;
  sweepStartedAt: number | null;
  sweepCompletedAt: number | null;
} {
  if (!row) throw new Error('plugin_runner_registry_state_missing');
  return {
    activeGeneration: integer(
      row.active_generation,
      'plugin_runner_registry_active_generation_invalid'
    ),
    pendingGeneration:
      row.pending_generation === null
        ? null
        : integer(row.pending_generation, 'plugin_runner_registry_pending_generation_invalid', 1),
    pendingCursor: integer(row.pending_cursor, 'plugin_runner_registry_cursor_invalid'),
    pendingShardCount: integer(
      row.pending_shard_count,
      'plugin_runner_registry_shard_count_invalid'
    ),
    sweepStartedAt:
      row.sweep_started_at === null
        ? null
        : integer(row.sweep_started_at, 'plugin_runner_registry_started_at_invalid', 1),
    sweepCompletedAt:
      row.sweep_completed_at === null
        ? null
        : integer(row.sweep_completed_at, 'plugin_runner_registry_completed_at_invalid', 1),
  };
}

function assertBatch(results: D1Result<unknown>[], expected: number, code: string): void {
  if (
    results.length !== expected ||
    results.some((result) => result.success !== true || result.error !== undefined)
  ) {
    throw new Error(code);
  }
}

export class D1PluginRunnerStateRepository {
  constructor(private readonly db: D1Database) {}

  async advanceSweep(
    registry: PluginRunnerRegistryClaims,
    now: number
  ): Promise<RegistrySweepProgress | null> {
    if (!Number.isSafeInteger(now) || now < 1) {
      throw new Error('plugin_runner_registry_now_invalid');
    }
    const session = primary(this.db);
    let state = rowState(
      await session
        .prepare(
          `SELECT active_generation, pending_generation, pending_cursor, pending_shard_count,
                  sweep_started_at, sweep_completed_at
             FROM plugin_runner_registry_state WHERE singleton_key = 'active'`
        )
        .first<RegistryStateRow>()
    );
    if (
      registry.generation < state.activeGeneration ||
      (state.pendingGeneration !== null && registry.generation < state.pendingGeneration)
    ) {
      throw new Error('plugin_runner_registry_generation_rollback');
    }

    if (state.pendingGeneration !== null && registry.generation > state.pendingGeneration) {
      const statements = [
        session
          .prepare(`UPDATE plugin_runner_registry_shards SET active = 0 WHERE active = 1`)
          .bind(),
        session
          .prepare(
            `UPDATE plugin_runner_registry_state
                SET pending_generation = ?, pending_cursor = 0, pending_shard_count = ?,
                    sweep_started_at = ?, sweep_completed_at = NULL, sweep_overdue = 0,
                    last_error_code = NULL, updated_at = ?
              WHERE singleton_key = 'active' AND pending_generation = ?`
          )
          .bind(registry.generation, registry.shards.length, now, now, state.pendingGeneration),
      ];
      const results = await session.batch(statements);
      assertBatch(results, statements.length, 'plugin_runner_registry_sweep_supersede_failed');
      if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
        throw new Error('plugin_runner_registry_sweep_supersede_stale');
      }
      state = {
        ...state,
        pendingGeneration: registry.generation,
        pendingCursor: 0,
        pendingShardCount: registry.shards.length,
        sweepStartedAt: now,
        sweepCompletedAt: null,
      };
    }

    const periodicSweepDue =
      state.pendingGeneration === null &&
      registry.generation === state.activeGeneration &&
      (state.sweepCompletedAt === null || state.sweepCompletedAt + SWEEP_INTERVAL_SECONDS <= now);
    const newGeneration = registry.generation > state.activeGeneration;
    if (state.pendingGeneration === null && (newGeneration || periodicSweepDue)) {
      const statements = [];
      if (newGeneration) {
        statements.push(
          session
            .prepare(`UPDATE plugin_runner_registry_shards SET active = 0 WHERE active = 1`)
            .bind()
        );
      }
      statements.push(
        session
          .prepare(
            `UPDATE plugin_runner_registry_state
                SET pending_generation = ?, pending_cursor = 0, pending_shard_count = ?,
                    sweep_started_at = ?, sweep_completed_at = NULL, sweep_overdue = 0,
                    last_error_code = NULL, updated_at = ?
              WHERE singleton_key = 'active' AND active_generation = ?
                AND pending_generation IS NULL`
          )
          .bind(registry.generation, registry.shards.length, now, now, state.activeGeneration)
      );
      const results = await session.batch(statements);
      assertBatch(results, statements.length, 'plugin_runner_registry_sweep_start_failed');
      if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
        throw new Error('plugin_runner_registry_sweep_start_stale');
      }
      state = {
        ...state,
        pendingGeneration: registry.generation,
        pendingCursor: 0,
        pendingShardCount: registry.shards.length,
        sweepStartedAt: now,
      };
    }

    if (state.pendingGeneration === null) return null;
    if (
      state.pendingGeneration !== registry.generation ||
      state.pendingShardCount !== registry.shards.length ||
      state.pendingCursor > registry.shards.length
    ) {
      throw new Error('plugin_runner_registry_sweep_state_mismatch');
    }
    const startIndex = state.pendingCursor;
    const shards = registry.shards.slice(startIndex, startIndex + SWEEP_BATCH_SIZE);
    const nextIndex = startIndex + shards.length;
    const complete = nextIndex === registry.shards.length;
    const overdue = (state.sweepStartedAt ?? now) + SWEEP_TARGET_SECONDS < now;
    const statements = shards.map((shard) =>
      session
        .prepare(
          `INSERT INTO plugin_runner_registry_shards (
             tenant_shard_id, binding_ref, data_role, residency_partition,
             route_generation, registry_generation, active, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(tenant_shard_id) DO UPDATE SET
             binding_ref = excluded.binding_ref,
             data_role = excluded.data_role,
             residency_partition = excluded.residency_partition,
             route_generation = excluded.route_generation,
             registry_generation = excluded.registry_generation,
             active = 1,
             updated_at = excluded.updated_at`
        )
        .bind(
          shard.shardId,
          shard.bindingRef,
          shard.dataRole,
          shard.residencyPartition,
          shard.routeGeneration,
          registry.generation,
          now
        )
    );
    if (shards.length > 0) {
      const placeholders = shards.map(() => '?').join(', ');
      statements.push(
        session
          .prepare(
            `INSERT INTO plugin_runner_shard_cursors (
               tenant_shard_id, next_due_at, last_scan_at, last_generation,
               cursor_json, consecutive_error_count, fencing_token, updated_at
             )
             SELECT tenant_shard_id, NULL, NULL, route_generation, '{}', 0, 0, ?
               FROM plugin_runner_registry_shards
              WHERE tenant_shard_id IN (${placeholders})
             ON CONFLICT(tenant_shard_id) DO NOTHING`
          )
          .bind(now, ...shards.map((shard) => shard.shardId))
      );
    }
    statements.push(
      complete
        ? session
            .prepare(
              `UPDATE plugin_runner_registry_state
                  SET active_generation = ?, pending_generation = NULL, pending_cursor = 0,
                      pending_shard_count = 0, sweep_completed_at = ?, sweep_overdue = ?,
                      last_error_code = CASE WHEN ? = 1
                        THEN 'plugin_runner_full_sweep_overdue' ELSE NULL END,
                      updated_at = ?
                WHERE singleton_key = 'active' AND pending_generation = ? AND pending_cursor = ?`
            )
            .bind(
              registry.generation,
              now,
              overdue ? 1 : 0,
              overdue ? 1 : 0,
              now,
              registry.generation,
              startIndex
            )
        : session
            .prepare(
              `UPDATE plugin_runner_registry_state
                  SET pending_cursor = ?, sweep_overdue = ?, updated_at = ?
                WHERE singleton_key = 'active' AND pending_generation = ? AND pending_cursor = ?`
            )
            .bind(nextIndex, overdue ? 1 : 0, now, registry.generation, startIndex)
    );
    const results = await session.batch(statements);
    assertBatch(results, statements.length, 'plugin_runner_registry_sweep_advance_failed');
    if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
      throw new Error('plugin_runner_registry_sweep_advance_stale');
    }
    return { generation: registry.generation, startIndex, nextIndex, complete, overdue, shards };
  }

  async claimDueShards(input: {
    ownerId: string;
    now: number;
    limit: number;
    shardIds?: readonly string[];
  }): Promise<ClaimedRunnerShard[]> {
    if (
      !SAFE_ID.test(input.ownerId) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 1 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > SWEEP_BATCH_SIZE ||
      input.shardIds?.some((id) => !SAFE_ID.test(id))
    ) {
      throw new Error('plugin_runner_shard_claim_input_invalid');
    }
    const session = primary(this.db);
    let candidates: DueShardRow[];
    if (input.shardIds && input.shardIds.length > 0) {
      if (input.shardIds.length > SWEEP_BATCH_SIZE) {
        throw new Error('plugin_runner_shard_claim_input_invalid');
      }
      const placeholders = input.shardIds.map(() => '?').join(', ');
      const result = await session
        .prepare(
          `SELECT registry.tenant_shard_id, registry.binding_ref, registry.data_role,
                  registry.residency_partition, registry.route_generation, cursor.fencing_token
             FROM plugin_runner_registry_shards registry
             JOIN plugin_runner_shard_cursors cursor
               ON cursor.tenant_shard_id = registry.tenant_shard_id
            WHERE registry.active = 1 AND registry.tenant_shard_id IN (${placeholders})
              AND (cursor.lease_expires_at IS NULL OR cursor.lease_expires_at <= ?)
            ORDER BY registry.tenant_shard_id LIMIT ?`
        )
        .bind(...input.shardIds, input.now, input.limit)
        .all<DueShardRow>();
      candidates = result.results;
    } else {
      const result = await session
        .prepare(
          `SELECT registry.tenant_shard_id, registry.binding_ref, registry.data_role,
                  registry.residency_partition, registry.route_generation, cursor.fencing_token
             FROM plugin_runner_registry_shards registry
             JOIN plugin_runner_shard_cursors cursor
               ON cursor.tenant_shard_id = registry.tenant_shard_id
            WHERE registry.active = 1
              AND (cursor.next_due_at IS NULL OR cursor.next_due_at <= ?)
              AND (cursor.lease_expires_at IS NULL OR cursor.lease_expires_at <= ?)
            ORDER BY COALESCE(cursor.next_due_at, 0), registry.tenant_shard_id LIMIT ?`
        )
        .bind(input.now, input.now, input.limit)
        .all<DueShardRow>();
      candidates = result.results;
    }
    for (const row of candidates) {
      if (
        !SAFE_ID.test(row.tenant_shard_id) ||
        !/^[A-Z][A-Z0-9_]*_TDB_[A-Z0-9_]{1,120}$/u.test(row.binding_ref) ||
        (row.data_role !== 'tenant_core/default' && row.data_role !== 'tenant_core/users')
      ) {
        throw new Error('plugin_runner_shard_candidate_invalid');
      }
      integer(row.fencing_token, 'plugin_runner_shard_fencing_token_invalid');
    }
    if (candidates.length === 0) return [];
    const candidateIds = candidates.map((row) => row.tenant_shard_id);
    const placeholders = candidateIds.map(() => '?').join(', ');
    const leaseExpiresAt = input.now + SHARD_LEASE_SECONDS;
    const update = await session
      .prepare(
        `UPDATE plugin_runner_shard_cursors
            SET lease_owner = ?, lease_expires_at = ?, fencing_token = fencing_token + 1,
                updated_at = ?
          WHERE tenant_shard_id IN (${placeholders})
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
      )
      .bind(input.ownerId, leaseExpiresAt, input.now, ...candidateIds, input.now)
      .run();
    if ((update.meta.changes ?? 0) === 0) return [];
    const reflected = await session
      .prepare(
        `SELECT tenant_shard_id, fencing_token
           FROM plugin_runner_shard_cursors
          WHERE lease_owner = ? AND lease_expires_at = ?
            AND tenant_shard_id IN (${placeholders})`
      )
      .bind(input.ownerId, leaseExpiresAt, ...candidateIds)
      .all<ClaimedCursorRow>();
    const claimedFencing = new Map(
      reflected.results.map((row) => [
        row.tenant_shard_id,
        integer(row.fencing_token, 'plugin_runner_shard_fencing_token_invalid', 1),
      ])
    );
    return candidates.flatMap((row) => {
      const fencingToken = claimedFencing.get(row.tenant_shard_id);
      if (fencingToken === undefined) return [];
      return [
        {
          shardId: row.tenant_shard_id,
          bindingRef: row.binding_ref,
          dataRole: row.data_role as ClaimedRunnerShard['dataRole'],
          residencyPartition: row.residency_partition,
          routeGeneration: integer(
            row.route_generation,
            'plugin_runner_shard_route_generation_invalid',
            1
          ),
          ownerId: input.ownerId,
          fencingToken,
        } satisfies ClaimedRunnerShard,
      ];
    });
  }

  async finishShard(input: {
    claim: ClaimedRunnerShard;
    now: number;
    nextDueAt: number | null;
    errorCode?: string;
  }): Promise<void> {
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < 1 ||
      (input.nextDueAt !== null &&
        (!Number.isSafeInteger(input.nextDueAt) || input.nextDueAt < input.now)) ||
      (input.errorCode !== undefined && !/^[a-z][a-z0-9_:-]{0,127}$/u.test(input.errorCode))
    ) {
      throw new Error('plugin_runner_shard_finish_input_invalid');
    }
    const result = await primary(this.db)
      .prepare(
        `UPDATE plugin_runner_shard_cursors
            SET next_due_at = ?, last_scan_at = ?, last_generation = ?,
                scheduler_error_code = ?,
                consecutive_error_count = CASE WHEN ? IS NULL THEN 0 ELSE consecutive_error_count + 1 END,
                lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE tenant_shard_id = ? AND lease_owner = ? AND fencing_token = ?`
      )
      .bind(
        input.nextDueAt,
        input.now,
        input.claim.routeGeneration,
        input.errorCode ?? null,
        input.errorCode ?? null,
        input.now,
        input.claim.shardId,
        input.claim.ownerId,
        input.claim.fencingToken
      )
      .run();
    if ((result.meta.changes ?? 0) === 1) return;
    const reflected = await primary(this.db)
      .prepare(
        `SELECT next_due_at, last_scan_at, scheduler_error_code, lease_owner, fencing_token
           FROM plugin_runner_shard_cursors WHERE tenant_shard_id = ?`
      )
      .bind(input.claim.shardId)
      .first<FinishedShardRow>();
    if (
      reflected &&
      reflected.lease_owner === null &&
      integer(reflected.fencing_token, 'plugin_runner_shard_fencing_token_invalid') ===
        input.claim.fencingToken &&
      integer(reflected.last_scan_at, 'plugin_runner_shard_last_scan_invalid', 1) === input.now &&
      (reflected.next_due_at === null
        ? input.nextDueAt === null
        : integer(reflected.next_due_at, 'plugin_runner_next_due_invalid') === input.nextDueAt) &&
      reflected.scheduler_error_code === (input.errorCode ?? null)
    ) {
      return;
    }
    throw new Error('plugin_runner_shard_finish_stale');
  }
}
