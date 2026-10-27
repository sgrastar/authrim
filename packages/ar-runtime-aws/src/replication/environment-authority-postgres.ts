import { assertReplicationGenerationLocation } from './generation-catalog';
import type { Pool, PoolClient } from 'pg';
import {
  DeploymentAuthorityError,
  authorityCanonicalJson,
  authorityFailure,
} from '@authrim/ar-lib-core/services/deployment-replication/authority';
import {
  assertEnvironmentPairDefinition,
  assertEnvironmentOperationIdentity,
  assertEnvironmentDrainRequest,
  assertEnvironmentWritePermit,
  assertEnvironmentGenerationProof,
  assertEnvironmentGenerationRecord,
  verifyEnvironmentGenerationDigest,
  type EnvironmentPairDefinition,
  type EnvironmentAuthorityState,
  type EnvironmentWritePermit,
  type EnvironmentOperationIdentity,
  type EnvironmentDrainRequest,
  type EnvironmentSwitchOperation,
  type EnvironmentGenerationRecord,
  type EnvironmentGenerationProof,
  type EnvironmentAuthority,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';

const NOW = 'floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint';
const PAIRS = 'authrim_replication_environment_authorities';
const PERMITS = 'authrim_replication_environment_permits';
const OPERATIONS = 'authrim_replication_environment_operations';

interface PairRow {
  pair_id: string;
  environment_id: string;
  definition_json: string;
  owner_deployment_id: string;
  selected_generation_id: string;
  epoch: string;
  revision: string;
  phase: 'active' | 'draining';
  active_operation_id: string | null;
  drained_at_ms: string | null;
}

interface OperationRow {
  request_json: string;
  state: EnvironmentSwitchOperation['state'];
  drain_revision: string;
  drained_at_ms: string | null;
  generation_json: string | null;
  promoted_epoch: string | null;
}

function number(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) authorityFailure('state_invalid');
  return result;
}

function pairIdentity(pairId: string, environmentId: string): void {
  assertEnvironmentOperationIdentity({ pairId, environmentId, operationId: 'identity-check' });
}

function definition(row: PairRow): EnvironmentPairDefinition {
  const value: unknown = JSON.parse(row.definition_json);
  assertEnvironmentPairDefinition(value);
  if (
    row.pair_id !== value.pairId ||
    row.environment_id !== value.environmentId ||
    !value.deployments.some((item) => item.deploymentId === row.owner_deployment_id) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(row.selected_generation_id) ||
    !['active', 'draining'].includes(row.phase) ||
    (row.phase === 'draining') !== (row.active_operation_id !== null)
  )
    authorityFailure('state_invalid');
  number(row.epoch);
  number(row.revision);
  return value;
}

function operation(row: OperationRow): EnvironmentSwitchOperation {
  const request: unknown = JSON.parse(row.request_json);
  assertEnvironmentDrainRequest(request);
  const generation: unknown = row.generation_json === null ? null : JSON.parse(row.generation_json);
  if (generation !== null) assertEnvironmentGenerationProof(generation);
  const drainRevision = number(row.drain_revision);
  const drainedAtMs = row.drained_at_ms === null ? null : number(row.drained_at_ms);
  const promotedEpoch = row.promoted_epoch === null ? null : number(row.promoted_epoch);
  if (
    !['draining', 'verified', 'promoted', 'cancelled'].includes(row.state) ||
    drainRevision !== request.expectedRevision + 1 ||
    (row.state === 'promoted') !== (promotedEpoch !== null) ||
    (promotedEpoch !== null && promotedEpoch !== request.expectedEpoch + 1) ||
    (row.state === 'draining' && generation !== null) ||
    (['verified', 'promoted'].includes(row.state) &&
      (generation === null || drainedAtMs === null)) ||
    (generation !== null &&
      (request.kind === 'failover') !== (generation.acceptedDataLoss !== null))
  )
    authorityFailure('state_invalid');
  return { ...request, state: row.state, drainRevision, drainedAtMs, generation, promotedEpoch };
}

/**
 * One independently leased Pool connection per transaction. Every mutation first locks the pair,
 * including permit admission/completion, so drain and promotion cannot race an admitted writer.
 * Schema installation is explicit (authority-schema.sql), never a runtime startup side effect.
 */
export class PostgresEnvironmentAuthority implements EnvironmentAuthority {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      return authorityFailure('unavailable');
    }
    let discard = false;
    let committing = false;
    try {
      await client.query('BEGIN');
      const result = await run(client);
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      discard = committing;
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      if (error instanceof DeploymentAuthorityError) throw error;
      return authorityFailure('unavailable');
    } finally {
      client.release(discard);
    }
  }

  private async locked(
    client: PoolClient,
    pairId: string,
    environmentId: string
  ): Promise<PairRow> {
    const rows = await client.query<PairRow>(
      `SELECT * FROM ${PAIRS} WHERE pair_id=$1 AND environment_id=$2 FOR UPDATE`,
      [pairId, environmentId]
    );
    if (rows.rows.length !== 1) authorityFailure('not_found');
    definition(rows.rows[0]);
    return rows.rows[0];
  }

  private async outstanding(client: PoolClient, pairId: string): Promise<number> {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${PERMITS}
       WHERE pair_id=$1 AND completed_at_ms IS NULL`,
      [pairId]
    );
    const count = Number(result.rows[0]?.count);
    if (!Number.isSafeInteger(count) || count < 0) authorityFailure('state_invalid');
    return count;
  }

  private async state(client: PoolClient, row: PairRow): Promise<EnvironmentAuthorityState> {
    return {
      pairId: row.pair_id,
      environmentId: row.environment_id,
      ownerDeploymentId: row.owner_deployment_id,
      selectedGenerationId: row.selected_generation_id,
      epoch: number(row.epoch),
      revision: number(row.revision),
      phase: row.phase,
      activeOperationId: row.active_operation_id,
      drainedAtMs: row.drained_at_ms === null ? null : number(row.drained_at_ms),
      outstandingPermits: await this.outstanding(client, row.pair_id),
    };
  }

  private async readOperation(
    client: PoolClient,
    identity: EnvironmentOperationIdentity
  ): Promise<EnvironmentSwitchOperation | null> {
    const result = await client.query<OperationRow>(
      `SELECT * FROM ${OPERATIONS} WHERE pair_id=$1 AND environment_id=$2 AND operation_id=$3`,
      [identity.pairId, identity.environmentId, identity.operationId]
    );
    return result.rows.length === 1 ? operation(result.rows[0]) : null;
  }

  async initialize(input: EnvironmentPairDefinition): Promise<EnvironmentAuthorityState> {
    assertEnvironmentPairDefinition(input);
    const pinned = structuredClone(input);
    pinned.deployments = [...pinned.deployments].sort((a, b) =>
      a.deploymentId < b.deploymentId ? -1 : a.deploymentId > b.deploymentId ? 1 : 0
    ) as [(typeof pinned.deployments)[0], (typeof pinned.deployments)[1]];
    const json = authorityCanonicalJson(pinned);
    return this.transaction(async (client) => {
      for (const deployment of pinned.deployments) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `authrim-replication-deployment:${deployment.deploymentId}`,
        ]);
        const singleton = await client.query(
          'SELECT 1 FROM authrim_replication_members WHERE deployment_id=$1 LIMIT 1',
          [deployment.deploymentId]
        );
        if (singleton.rows.length) authorityFailure('membership_conflict');
        const reserved = await client.query<{ pair_id: string; environment_id: string }>(
          'SELECT pair_id,environment_id FROM authrim_replication_environment_reservations WHERE deployment_id=$1',
          [deployment.deploymentId]
        );
        if (
          reserved.rows.length &&
          (reserved.rows[0].pair_id !== pinned.pairId ||
            reserved.rows[0].environment_id !== pinned.environmentId)
        )
          authorityFailure('membership_conflict');
      }
      await client.query(
        `INSERT INTO ${PAIRS}
         (pair_id,environment_id,definition_json,owner_deployment_id,selected_generation_id,epoch,revision,phase)
         VALUES ($1,$2,$3,$4,$5,1,1,'active') ON CONFLICT (pair_id) DO NOTHING`,
        [
          pinned.pairId,
          pinned.environmentId,
          json,
          pinned.initialOwnerDeploymentId,
          pinned.initialGenerationId,
        ]
      );
      const row = await this.locked(client, pinned.pairId, pinned.environmentId);
      if (row.definition_json !== json) authorityFailure('idempotency_conflict');
      for (const deployment of pinned.deployments) {
        await client.query(
          'INSERT INTO authrim_replication_environment_reservations(deployment_id,pair_id,environment_id) VALUES($1,$2,$3) ON CONFLICT(deployment_id) DO NOTHING',
          [deployment.deploymentId, pinned.pairId, pinned.environmentId]
        );
      }
      return this.state(client, row);
    });
  }

  async get(pairId: string, environmentId: string): Promise<EnvironmentAuthorityState> {
    pairIdentity(pairId, environmentId);
    return this.transaction(async (client) =>
      this.state(client, await this.locked(client, pairId, environmentId))
    );
  }

  async enter(input: EnvironmentWritePermit): Promise<EnvironmentWritePermit> {
    assertEnvironmentWritePermit(input);
    const pinned = structuredClone(input);
    const json = authorityCanonicalJson(pinned);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.environmentId);
      const existing = await client.query<{
        identity_json: string;
        completed_at_ms: string | null;
      }>(`SELECT identity_json,completed_at_ms FROM ${PERMITS} WHERE pair_id=$1 AND permit_id=$2`, [
        pinned.pairId,
        pinned.permitId,
      ]);
      if (existing.rows[0] && existing.rows[0].identity_json !== json)
        authorityFailure('idempotency_conflict');
      if (existing.rows[0]?.completed_at_ms !== null && existing.rows.length)
        authorityFailure('permit_completed');
      if (
        row.owner_deployment_id !== pinned.deploymentId ||
        number(row.epoch) !== pinned.epoch ||
        row.selected_generation_id !== pinned.generationId
      )
        authorityFailure('writer_fenced');
      const original = definition(row);
      if (
        number(row.epoch) === 1 &&
        row.owner_deployment_id === original.initialOwnerDeploymentId &&
        row.selected_generation_id === original.initialGenerationId
      ) {
        if (pinned.tenantId !== undefined || pinned.restoreId !== undefined)
          authorityFailure('writer_fenced');
      } else {
        const selected = await this.readGeneration(client, {
          pairId: pinned.pairId,
          environmentId: pinned.environmentId,
          deploymentId: pinned.deploymentId,
          generationId: pinned.generationId,
          epoch: pinned.epoch,
        });
        if (
          !selected.children.some(
            (child) => child.tenantId === pinned.tenantId && child.restoreId === pinned.restoreId
          )
        )
          authorityFailure('writer_fenced');
      }
      // Recover a lost successful admission reply even after drain began. Its still-open permit
      // already prevents promotion. A completed permit can never run its effect again.
      if (existing.rows.length) return pinned;
      if (row.phase !== 'active') authorityFailure('writer_draining');
      await client.query(
        `INSERT INTO ${PERMITS} (pair_id,environment_id,permit_id,identity_json) VALUES ($1,$2,$3,$4)`,
        [pinned.pairId, pinned.environmentId, pinned.permitId, json]
      );
      return pinned;
    });
  }

  async complete(input: EnvironmentWritePermit): Promise<void> {
    assertEnvironmentWritePermit(input);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.environmentId);
      const existing = await client.query<{
        identity_json: string;
        completed_at_ms: string | null;
      }>(`SELECT identity_json,completed_at_ms FROM ${PERMITS} WHERE pair_id=$1 AND permit_id=$2`, [
        pinned.pairId,
        pinned.permitId,
      ]);
      if (existing.rows[0]?.identity_json !== authorityCanonicalJson(pinned))
        authorityFailure('permit_mismatch');
      if (existing.rows[0].completed_at_ms !== null) return;
      if (
        row.owner_deployment_id !== pinned.deploymentId ||
        number(row.epoch) !== pinned.epoch ||
        row.selected_generation_id !== pinned.generationId
      )
        authorityFailure('writer_fenced');
      await client.query(
        `UPDATE ${PERMITS} SET completed_at_ms=${NOW} WHERE pair_id=$1 AND permit_id=$2`,
        [pinned.pairId, pinned.permitId]
      );
      if (row.phase === 'draining' && (await this.outstanding(client, pinned.pairId)) === 0) {
        await client.query(
          `UPDATE ${PAIRS} SET drained_at_ms=COALESCE(drained_at_ms,${NOW}) WHERE pair_id=$1`,
          [pinned.pairId]
        );
        await client.query(
          `UPDATE ${OPERATIONS} SET drained_at_ms=(SELECT drained_at_ms FROM ${PAIRS} WHERE pair_id=$1)
           WHERE pair_id=$1 AND operation_id=$2`,
          [pinned.pairId, row.active_operation_id]
        );
      }
    });
  }

  async beginDrain(input: EnvironmentDrainRequest): Promise<EnvironmentSwitchOperation> {
    assertEnvironmentDrainRequest(input);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.environmentId);
      const existing = await this.readOperation(client, pinned);
      if (existing) {
        const {
          state: _state,
          drainRevision: _revision,
          drainedAtMs: _drained,
          generation: _generation,
          promotedEpoch: _epoch,
          ...request
        } = existing;
        if (authorityCanonicalJson(request) !== authorityCanonicalJson(pinned))
          authorityFailure('idempotency_conflict');
        return existing;
      }
      if (
        row.phase !== 'active' ||
        number(row.epoch) !== pinned.expectedEpoch ||
        number(row.revision) !== pinned.expectedRevision ||
        row.owner_deployment_id !== pinned.sourceDeploymentId ||
        !definition(row).deployments.some(
          (item) => item.deploymentId === pinned.destinationDeploymentId
        )
      )
        authorityFailure('switch_conflict');
      const count = await this.outstanding(client, pinned.pairId);
      const updated = await client.query<PairRow>(
        `UPDATE ${PAIRS} SET phase='draining',active_operation_id=$2,revision=revision+1,
         drained_at_ms=CASE WHEN $3::bigint=0 THEN ${NOW} ELSE NULL END
         WHERE pair_id=$1 RETURNING *`,
        [pinned.pairId, pinned.operationId, count]
      );
      const drained = updated.rows[0];
      await client.query(
        `INSERT INTO ${OPERATIONS}
         (pair_id,environment_id,operation_id,request_json,state,drain_revision,drained_at_ms)
         VALUES ($1,$2,$3,$4,'draining',$5,$6)`,
        [
          pinned.pairId,
          pinned.environmentId,
          pinned.operationId,
          authorityCanonicalJson(pinned),
          drained.revision,
          drained.drained_at_ms,
        ]
      );
      return (await this.readOperation(client, pinned)) ?? authorityFailure('state_invalid');
    });
  }

  async getOperation(input: EnvironmentOperationIdentity): Promise<EnvironmentSwitchOperation> {
    assertEnvironmentOperationIdentity(input);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      await this.locked(client, pinned.pairId, pinned.environmentId);
      return (await this.readOperation(client, pinned)) ?? authorityFailure('operation_not_found');
    });
  }

  private async currentOperation(
    client: PoolClient,
    row: PairRow,
    identity: EnvironmentOperationIdentity
  ): Promise<EnvironmentSwitchOperation> {
    const current =
      (await this.readOperation(client, identity)) ?? authorityFailure('operation_not_found');
    if (
      row.phase !== 'draining' ||
      row.active_operation_id !== current.operationId ||
      row.owner_deployment_id !== current.sourceDeploymentId ||
      number(row.epoch) !== current.expectedEpoch ||
      number(row.revision) !== current.drainRevision
    )
      authorityFailure('switch_conflict');
    if ((await this.outstanding(client, row.pair_id)) !== 0 || current.drainedAtMs === null)
      authorityFailure('unresolved_permits');
    return current;
  }

  private async readGeneration(
    client: PoolClient,
    input: {
      pairId: string;
      environmentId: string;
      deploymentId: string;
      generationId: string;
      epoch: number;
    }
  ): Promise<EnvironmentGenerationRecord> {
    const found = await client.query<{ record_json: string }>(
      `SELECT record_json FROM authrim_replication_environment_generations WHERE pair_id=$1 AND environment_id=$2 AND deployment_id=$3 AND generation_id=$4 AND epoch=$5`,
      [input.pairId, input.environmentId, input.deploymentId, input.generationId, input.epoch]
    );
    if (found.rows.length !== 1) authorityFailure('generation_not_found');
    const value: unknown = JSON.parse(found.rows[0].record_json);
    assertEnvironmentGenerationRecord(value);
    await verifyEnvironmentGenerationDigest(value);
    if (
      value.pairId !== input.pairId ||
      value.environmentId !== input.environmentId ||
      value.deploymentId !== input.deploymentId ||
      value.generationId !== input.generationId ||
      value.epoch !== input.epoch
    )
      authorityFailure('generation_mismatch');
    return value;
  }

  async registerGeneration(input: EnvironmentGenerationRecord): Promise<void> {
    const pinned = structuredClone(input);
    await verifyEnvironmentGenerationDigest(pinned);
    // The catalog has no live credentials. Validate every immutable location with the normal AWS validator.
    for (const child of pinned.children)
      assertReplicationGenerationLocation({
        pairId: pinned.pairId,
        tenantId: child.tenantId,
        deploymentId: pinned.deploymentId,
        generationId: child.restoreId,
        epoch: pinned.epoch,
        location: child.location,
      });
    const json = authorityCanonicalJson(pinned);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.environmentId);
      const existing = await client.query<{ record_json: string }>(
        `SELECT record_json FROM authrim_replication_environment_generations WHERE pair_id=$1 AND (generation_id=$2 OR source_operation_id=$3)`,
        [pinned.pairId, pinned.generationId, pinned.sourceOperationId]
      );
      if (existing.rows.length) {
        if (existing.rows.length !== 1 || existing.rows[0].record_json !== json)
          authorityFailure('idempotency_conflict');
        return;
      }
      const def = definition(row);
      const clock = await client.query<{ now_ms: string }>(`SELECT ${NOW} AS now_ms`);
      const captures = [
        pinned.inventory.capturedAtMs,
        ...pinned.children.map((c) => c.capturedAtMs),
      ];
      if (
        row.owner_deployment_id !== pinned.sourceDeploymentId ||
        number(row.epoch) !== pinned.sourceEpoch ||
        !def.deployments.some((d) => d.deploymentId === pinned.deploymentId) ||
        pinned.generationId === def.initialGenerationId ||
        pinned.generationId === row.selected_generation_id ||
        captures.some((t) => t > number(clock.rows[0].now_ms))
      )
        authorityFailure('generation_mismatch');
      if (pinned.sourceFenceRevision === 0) {
        if (row.phase !== 'active') authorityFailure('switch_conflict');
      } else {
        const op = await this.currentOperation(client, row, {
          pairId: pinned.pairId,
          environmentId: pinned.environmentId,
          operationId: pinned.sourceOperationId,
        });
        if (
          op.kind !== 'planned' ||
          op.state !== 'draining' ||
          pinned.sourceFenceRevision !== op.drainRevision ||
          op.destinationDeploymentId !== pinned.deploymentId ||
          captures.some((t) => t < (op.drainedAtMs ?? Number.MAX_SAFE_INTEGER))
        )
          authorityFailure('generation_mismatch');
      }
      await client.query(
        `INSERT INTO authrim_replication_environment_generations(pair_id,environment_id,deployment_id,generation_id,epoch,source_operation_id,record_json) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          pinned.pairId,
          pinned.environmentId,
          pinned.deploymentId,
          pinned.generationId,
          pinned.epoch,
          pinned.sourceOperationId,
          json,
        ]
      );
    });
  }

  async getGeneration(input: {
    pairId: string;
    environmentId: string;
    deploymentId: string;
    generationId: string;
    epoch: number;
  }): Promise<EnvironmentGenerationRecord> {
    pairIdentity(input.pairId, input.environmentId);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      await this.locked(client, pinned.pairId, pinned.environmentId);
      return this.readGeneration(client, pinned);
    });
  }

  private async checkProof(
    client: PoolClient,
    current: EnvironmentSwitchOperation,
    proof: EnvironmentGenerationProof
  ): Promise<void> {
    const generation = await this.readGeneration(client, {
      pairId: current.pairId,
      environmentId: current.environmentId,
      deploymentId: current.destinationDeploymentId,
      generationId: proof.generationId,
      epoch: current.expectedEpoch + 1,
    });
    if (
      generation.digestSha256 !== proof.digestSha256 ||
      generation.sourceDeploymentId !== current.sourceDeploymentId ||
      generation.sourceEpoch !== current.expectedEpoch ||
      current.drainedAtMs === null
    )
      authorityFailure('generation_mismatch');
    const captures = [
      generation.inventory.capturedAtMs,
      ...generation.children.map((c) => c.capturedAtMs),
    ];
    const clock = await client.query<{ now_ms: string }>(`SELECT ${NOW} AS now_ms`);
    const now = number(clock.rows[0].now_ms);
    if (current.kind === 'planned') {
      if (
        proof.acceptedDataLoss !== null ||
        generation.sourceOperationId !== current.operationId ||
        generation.sourceFenceRevision !== current.drainRevision ||
        captures.some((t) => t < (current.drainedAtMs ?? Number.MAX_SAFE_INTEGER) || t > now)
      )
        authorityFailure('generation_mismatch');
    } else {
      const loss = proof.acceptedDataLoss;
      const oldest = Math.min(...captures);
      if (
        !loss ||
        generation.sourceFenceRevision !== 0 ||
        generation.sourceOperationId !== loss.sourceSyncOperationId ||
        generation.sourcePlanSha256 !== loss.sourceSyncPlanSha256 ||
        loss.acceptedAtMs < current.drainedAtMs ||
        loss.acceptedAtMs > now ||
        captures.some((t) => t > loss.acceptedAtMs) ||
        now - oldest > loss.maximumSnapshotAgeMs
      )
        authorityFailure('snapshot_age_exceeded');
    }
  }

  async verifyGeneration(
    input: EnvironmentOperationIdentity,
    proof: EnvironmentGenerationProof
  ): Promise<EnvironmentSwitchOperation> {
    assertEnvironmentOperationIdentity(input);
    assertEnvironmentGenerationProof(proof);
    const pinned = structuredClone(input);
    const value = structuredClone(proof);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.environmentId);
      const prior =
        (await this.readOperation(client, pinned)) ?? authorityFailure('operation_not_found');
      if (prior.state === 'cancelled') authorityFailure('switch_conflict');
      if (prior.generation !== null) {
        if (authorityCanonicalJson(prior.generation) !== authorityCanonicalJson(value))
          authorityFailure('idempotency_conflict');
        return prior;
      }
      const current = await this.currentOperation(client, row, pinned);
      await this.checkProof(client, current, value);
      const used = await client.query(
        `SELECT 1 FROM ${OPERATIONS} WHERE pair_id=$1 AND state <> 'cancelled' AND generation_json::jsonb->>'generationId'=$2`,
        [pinned.pairId, value.generationId]
      );
      if (used.rows.length) authorityFailure('generation_reused');
      await client.query(
        `UPDATE ${OPERATIONS} SET state='verified',generation_json=$3 WHERE pair_id=$1 AND operation_id=$2`,
        [pinned.pairId, pinned.operationId, authorityCanonicalJson(value)]
      );
      return (await this.readOperation(client, pinned)) ?? authorityFailure('state_invalid');
    });
  }

  async promote(input: EnvironmentOperationIdentity): Promise<EnvironmentSwitchOperation> {
    assertEnvironmentOperationIdentity(input);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.environmentId);
      const prior =
        (await this.readOperation(client, pinned)) ?? authorityFailure('operation_not_found');
      if (prior.state === 'promoted') return prior;
      const current = await this.currentOperation(client, row, pinned);
      if (current.state !== 'verified' || !current.generation)
        authorityFailure('generation_unverified');
      await this.checkProof(client, current, current.generation);
      await client.query(
        `UPDATE ${PAIRS} SET owner_deployment_id=$2,selected_generation_id=$3,epoch=epoch+1,revision=revision+1,phase='active',active_operation_id=NULL,drained_at_ms=NULL WHERE pair_id=$1`,
        [pinned.pairId, current.destinationDeploymentId, current.generation.generationId]
      );
      await client.query(
        `UPDATE ${OPERATIONS} SET state='promoted',promoted_epoch=$3 WHERE pair_id=$1 AND operation_id=$2`,
        [pinned.pairId, pinned.operationId, current.expectedEpoch + 1]
      );
      return (await this.readOperation(client, pinned)) ?? authorityFailure('state_invalid');
    });
  }

  async cancelDrain(input: EnvironmentOperationIdentity): Promise<EnvironmentSwitchOperation> {
    assertEnvironmentOperationIdentity(input);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.environmentId);
      const current =
        (await this.readOperation(client, pinned)) ?? authorityFailure('operation_not_found');
      if (current.state === 'cancelled') return current;
      if (
        current.state === 'promoted' ||
        row.phase !== 'draining' ||
        row.active_operation_id !== current.operationId ||
        number(row.epoch) !== current.expectedEpoch ||
        number(row.revision) !== current.drainRevision ||
        row.owner_deployment_id !== current.sourceDeploymentId
      )
        authorityFailure('switch_conflict');
      // Cancellation never manufactures a completed permit. Unknown old writes remain counted.
      await client.query(
        `UPDATE ${PAIRS} SET phase='active',active_operation_id=NULL,drained_at_ms=NULL,revision=revision+1 WHERE pair_id=$1`,
        [pinned.pairId]
      );
      await client.query(
        `UPDATE ${OPERATIONS} SET state='cancelled' WHERE pair_id=$1 AND operation_id=$2`,
        [pinned.pairId, pinned.operationId]
      );
      return (await this.readOperation(client, pinned)) ?? authorityFailure('state_invalid');
    });
  }

  async getServingGeneration(input: {
    pairId: string;
    environmentId: string;
    deploymentId: string;
  }): Promise<EnvironmentGenerationRecord> {
    pairIdentity(input.pairId, input.environmentId);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.environmentId);
      if (row.phase !== 'active' || row.owner_deployment_id !== pinned.deploymentId)
        authorityFailure('writer_fenced');
      return this.readGeneration(client, {
        ...pinned,
        generationId: row.selected_generation_id,
        epoch: number(row.epoch),
      });
    });
  }
}
