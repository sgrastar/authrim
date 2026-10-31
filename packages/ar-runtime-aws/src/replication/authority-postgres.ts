import type { Pool, PoolClient } from 'pg';
import {
  DeploymentAuthorityError,
  assertDeploymentDrainRequest,
  assertDeploymentAcceptedDataLoss,
  assertDeploymentFailoverGeneration,
  assertDeploymentStandbyGeneration,
  assertDeploymentOperationIdentity,
  assertDeploymentPairDefinition,
  assertDeploymentVerifiedGeneration,
  assertDeploymentWritePermit,
  authorityCanonicalJson,
  authorityFailure,
  type DeploymentAuthority,
  type DeploymentFailoverGeneration,
  type DeploymentStandbyGeneration,
  type DeploymentAuthorityState,
  type DeploymentDrainRequest,
  type DeploymentOperationIdentity,
  type DeploymentPairDefinition,
  type DeploymentSwitchOperation,
  type DeploymentVerifiedGeneration,
  type DeploymentWritePermit,
} from '@authrim/ar-lib-core/services/deployment-replication/authority';

import {
  assertReplicationGenerationLocation,
  type ReplicationGenerationLocation,
} from './generation-catalog';

const NOW = 'floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint';
const PAIRS = 'authrim_replication_authorities';
const PERMITS = 'authrim_replication_permits';
const OPERATIONS = 'authrim_replication_operations';

interface PairRow {
  pair_id: string;
  tenant_id: string;
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
  kind: DeploymentSwitchOperation['kind'];
  accepted_data_loss_json: string | null;
  state: DeploymentSwitchOperation['state'];
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

function pairIdentity(pairId: string, tenantId: string): void {
  assertDeploymentOperationIdentity({ pairId, tenantId, operationId: 'identity-check' });
}

function definition(row: PairRow): DeploymentPairDefinition {
  const value: unknown = JSON.parse(row.definition_json);
  assertDeploymentPairDefinition(value);
  if (
    row.pair_id !== value.pairId ||
    row.tenant_id !== value.tenantId ||
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

function operation(row: OperationRow): DeploymentSwitchOperation {
  const request: unknown = JSON.parse(row.request_json);
  assertDeploymentDrainRequest(request);
  const acceptedDataLoss: unknown =
    row.accepted_data_loss_json === null ? null : JSON.parse(row.accepted_data_loss_json);
  if (acceptedDataLoss !== null) assertDeploymentAcceptedDataLoss(acceptedDataLoss);
  const generation: unknown = row.generation_json === null ? null : JSON.parse(row.generation_json);
  if (generation !== null) assertDeploymentVerifiedGeneration(generation);
  if (
    !['planned', 'failover'].includes(row.kind) ||
    (row.kind === 'failover' && row.state !== 'draining') !== (acceptedDataLoss !== null) ||
    !['draining', 'verified', 'promoted'].includes(row.state) ||
    (row.state === 'draining') !== (generation === null) ||
    (row.state === 'promoted') !== (row.promoted_epoch !== null)
  )
    authorityFailure('state_invalid');
  const drainRevision = number(row.drain_revision);
  const drainedAtMs = row.drained_at_ms === null ? null : number(row.drained_at_ms);
  const promotedEpoch = row.promoted_epoch === null ? null : number(row.promoted_epoch);
  if (
    drainRevision !== request.expectedRevision + 1 ||
    (promotedEpoch !== null && promotedEpoch !== request.expectedEpoch + 1) ||
    (generation !== null &&
      (drainedAtMs === null ||
        generation.sourceDeploymentId !== request.sourceDeploymentId ||
        generation.destinationDeploymentId !== request.destinationDeploymentId ||
        generation.sourceEpoch !== request.expectedEpoch ||
        (row.kind === 'planned' &&
          (generation.sourceFenceRevision !== drainRevision ||
            generation.capturedAtMs < drainedAtMs)) ||
        (row.kind === 'failover' &&
          (generation.sourceFenceRevision !== request.expectedRevision ||
            acceptedDataLoss === null ||
            acceptedDataLoss.acceptedAtMs < drainedAtMs ||
            generation.capturedAtMs > acceptedDataLoss.acceptedAtMs ||
            acceptedDataLoss.acceptedAtMs - generation.capturedAtMs >
              acceptedDataLoss.maximumSnapshotAgeMs))))
  )
    authorityFailure('state_invalid');
  return {
    ...request,
    kind: row.kind,
    acceptedDataLoss,
    state: row.state,
    drainRevision,
    drainedAtMs,
    generation,
    promotedEpoch,
  };
}

/**
 * One independently leased Pool connection per transaction. Every mutation first locks the pair,
 * including permit admission/completion, so drain and promotion cannot race an admitted writer.
 * Schema installation is explicit (authority-schema.sql), never a runtime startup side effect.
 */
export class PostgresDeploymentAuthority implements DeploymentAuthority {
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

  private async locked(client: PoolClient, pairId: string, tenantId: string): Promise<PairRow> {
    const rows = await client.query<PairRow>(
      `SELECT * FROM ${PAIRS} WHERE pair_id=$1 AND tenant_id=$2 FOR UPDATE`,
      [pairId, tenantId]
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

  private async state(client: PoolClient, row: PairRow): Promise<DeploymentAuthorityState> {
    return {
      pairId: row.pair_id,
      tenantId: row.tenant_id,
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
    identity: DeploymentOperationIdentity
  ): Promise<DeploymentSwitchOperation | null> {
    const result = await client.query<OperationRow>(
      `SELECT * FROM ${OPERATIONS} WHERE pair_id=$1 AND tenant_id=$2 AND operation_id=$3`,
      [identity.pairId, identity.tenantId, identity.operationId]
    );
    return result.rows.length === 1 ? operation(result.rows[0]) : null;
  }

  async initialize(input: DeploymentPairDefinition): Promise<DeploymentAuthorityState> {
    assertDeploymentPairDefinition(input);
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
        const reserved = await client.query(
          'SELECT 1 FROM authrim_replication_environment_reservations WHERE deployment_id=$1',
          [deployment.deploymentId]
        );
        if (reserved.rows.length) authorityFailure('membership_conflict');
      }

      await client.query(
        `INSERT INTO ${PAIRS}
         (pair_id,tenant_id,definition_json,owner_deployment_id,selected_generation_id,epoch,revision,phase)
         VALUES ($1,$2,$3,$4,$5,1,1,'active') ON CONFLICT (pair_id) DO NOTHING`,
        [
          pinned.pairId,
          pinned.tenantId,
          json,
          pinned.initialOwnerDeploymentId,
          pinned.initialGenerationId,
        ]
      );
      const row = await this.locked(client, pinned.pairId, pinned.tenantId);
      if (row.definition_json !== json) authorityFailure('idempotency_conflict');
      for (const deployment of pinned.deployments) {
        await client.query(
          `INSERT INTO authrim_replication_members (tenant_id,deployment_id,pair_id)
           VALUES ($1,$2,$3) ON CONFLICT (tenant_id,deployment_id) DO NOTHING`,
          [pinned.tenantId, deployment.deploymentId, pinned.pairId]
        );
        const membership = await client.query<{ pair_id: string }>(
          `SELECT pair_id FROM authrim_replication_members WHERE tenant_id=$1 AND deployment_id=$2`,
          [pinned.tenantId, deployment.deploymentId]
        );
        if (membership.rows[0]?.pair_id !== pinned.pairId) authorityFailure('membership_conflict');
      }
      return this.state(client, row);
    });
  }

  async get(pairId: string, tenantId: string): Promise<DeploymentAuthorityState> {
    pairIdentity(pairId, tenantId);
    return this.transaction(async (client) =>
      this.state(client, await this.locked(client, pairId, tenantId))
    );
  }

  async enter(input: DeploymentWritePermit): Promise<DeploymentWritePermit> {
    assertDeploymentWritePermit(input);
    const pinned = structuredClone(input);
    const json = authorityCanonicalJson(pinned);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.tenantId);
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
      // Recover a lost successful admission reply even after drain began. Its still-open permit
      // already prevents promotion. A completed permit can never run its effect again.
      if (existing.rows.length) return pinned;
      if (row.phase !== 'active') authorityFailure('writer_draining');
      await client.query(
        `INSERT INTO ${PERMITS} (pair_id,tenant_id,permit_id,identity_json) VALUES ($1,$2,$3,$4)`,
        [pinned.pairId, pinned.tenantId, pinned.permitId, json]
      );
      return pinned;
    });
  }

  async complete(input: DeploymentWritePermit): Promise<void> {
    assertDeploymentWritePermit(input);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.tenantId);
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

  async beginDrain(input: DeploymentDrainRequest): Promise<DeploymentSwitchOperation> {
    return this.beginDrainOperation(input, 'planned');
  }

  async beginFailoverDrain(input: DeploymentDrainRequest): Promise<DeploymentSwitchOperation> {
    return this.beginDrainOperation(input, 'failover');
  }

  private async beginDrainOperation(
    input: DeploymentDrainRequest,
    kind: DeploymentSwitchOperation['kind']
  ): Promise<DeploymentSwitchOperation> {
    assertDeploymentDrainRequest(input);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.tenantId);
      const existing = await this.readOperation(client, pinned);
      if (existing) {
        const {
          kind: previousKind,
          acceptedDataLoss: _accepted,
          state: _state,
          drainRevision: _revision,
          drainedAtMs: _drained,
          generation: _generation,
          promotedEpoch: _epoch,
          ...request
        } = existing;
        if (
          previousKind !== kind ||
          authorityCanonicalJson(request) !== authorityCanonicalJson(pinned)
        )
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
         (pair_id,tenant_id,operation_id,request_json,state,drain_revision,drained_at_ms,kind)
         VALUES ($1,$2,$3,$4,'draining',$5,$6,$7)`,
        [
          pinned.pairId,
          pinned.tenantId,
          pinned.operationId,
          authorityCanonicalJson(pinned),
          drained.revision,
          drained.drained_at_ms,
          kind,
        ]
      );
      return (await this.readOperation(client, pinned)) ?? authorityFailure('state_invalid');
    });
  }

  async getOperation(input: DeploymentOperationIdentity): Promise<DeploymentSwitchOperation> {
    assertDeploymentOperationIdentity(input);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      await this.locked(client, pinned.pairId, pinned.tenantId);
      return (await this.readOperation(client, pinned)) ?? authorityFailure('operation_not_found');
    });
  }

  private async currentOperation(
    client: PoolClient,
    row: PairRow,
    identity: DeploymentOperationIdentity
  ): Promise<DeploymentSwitchOperation> {
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

  async verifyGeneration(
    input: DeploymentOperationIdentity,
    generation: DeploymentVerifiedGeneration
  ): Promise<DeploymentSwitchOperation> {
    assertDeploymentOperationIdentity(input);
    assertDeploymentVerifiedGeneration(generation);
    const pinned = structuredClone(input);
    const proof = structuredClone(generation);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.tenantId);
      const existing =
        (await this.readOperation(client, pinned)) ?? authorityFailure('operation_not_found');
      if (existing.kind !== 'planned') authorityFailure('operation_kind_mismatch');
      if (existing.generation) {
        if (authorityCanonicalJson(existing.generation) !== authorityCanonicalJson(proof))
          authorityFailure('idempotency_conflict');
        return existing;
      }
      const current = await this.currentOperation(client, row, pinned);
      const clock = await client.query<{ now_ms: string }>(`SELECT ${NOW} AS now_ms`);
      if (
        proof.sourceDeploymentId !== current.sourceDeploymentId ||
        proof.destinationDeploymentId !== current.destinationDeploymentId ||
        proof.sourceEpoch !== current.expectedEpoch ||
        proof.sourceFenceRevision !== current.drainRevision ||
        proof.capturedAtMs < (current.drainedAtMs ?? Number.MAX_SAFE_INTEGER) ||
        proof.capturedAtMs > number(clock.rows[0].now_ms) ||
        proof.generationId === row.selected_generation_id ||
        proof.generationId === definition(row).initialGenerationId
      )
        authorityFailure('generation_mismatch');
      const duplicate = await client.query(
        `SELECT 1 FROM ${OPERATIONS} WHERE pair_id=$1 AND generation_json::jsonb->>'generationId'=$2`,
        [pinned.pairId, proof.generationId]
      );
      if (duplicate.rows.length) authorityFailure('generation_reused');
      await client.query(
        `UPDATE ${OPERATIONS} SET state='verified',generation_json=$3 WHERE pair_id=$1 AND operation_id=$2`,
        [pinned.pairId, pinned.operationId, authorityCanonicalJson(proof)]
      );
      return (await this.readOperation(client, pinned)) ?? authorityFailure('state_invalid');
    });
  }

  private async checkCatalog(
    client: PoolClient,
    input: DeploymentStandbyGeneration
  ): Promise<void> {
    const proof = input.generation;
    const result = await client.query<{ location_json: string }>(
      `SELECT location_json FROM authrim_replication_generation_locations
       WHERE pair_id=$1 AND tenant_id=$2 AND deployment_id=$3 AND generation_id=$4 AND epoch=$5`,
      [
        input.pairId,
        input.tenantId,
        proof.destinationDeploymentId,
        proof.generationId,
        proof.sourceEpoch + 1,
      ]
    );
    if (result.rows.length !== 1) authorityFailure('standby_unregistered');
    const value = JSON.parse(result.rows[0].location_json) as ReplicationGenerationLocation;
    assertReplicationGenerationLocation(value);
    if (
      value.pairId !== input.pairId ||
      value.tenantId !== input.tenantId ||
      value.deploymentId !== proof.destinationDeploymentId ||
      value.generationId !== proof.generationId ||
      value.epoch !== proof.sourceEpoch + 1 ||
      value.location.manifestSha256 !== proof.manifestSha256
    )
      authorityFailure('generation_mismatch');
  }

  async registerStandbyGeneration(input: DeploymentStandbyGeneration): Promise<void> {
    assertDeploymentStandbyGeneration(input);
    const pinned = structuredClone(input);
    const json = authorityCanonicalJson(pinned);
    await this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.tenantId);
      const prior = await client.query<{ proof_json: string }>(
        `SELECT proof_json FROM authrim_replication_standby_generations
         WHERE pair_id=$1 AND (generation_id=$2 OR source_sync_operation_id=$3)`,
        [pinned.pairId, pinned.generation.generationId, pinned.sourceSyncOperationId]
      );
      if (prior.rows.length) {
        if (prior.rows.length !== 1 || prior.rows[0].proof_json !== json)
          authorityFailure('idempotency_conflict');
        return;
      }
      const proof = pinned.generation;
      const clock = await client.query<{ now_ms: string }>(`SELECT ${NOW} AS now_ms`);
      if (
        row.phase !== 'active' ||
        row.owner_deployment_id !== proof.sourceDeploymentId ||
        number(row.epoch) !== proof.sourceEpoch ||
        number(row.revision) !== proof.sourceFenceRevision ||
        !definition(row).deployments.some(
          (item) => item.deploymentId === proof.destinationDeploymentId
        ) ||
        proof.capturedAtMs > number(clock.rows[0].now_ms) ||
        proof.generationId === row.selected_generation_id ||
        proof.generationId === definition(row).initialGenerationId
      )
        authorityFailure('generation_mismatch');
      await this.checkCatalog(client, pinned);
      await client.query(
        `INSERT INTO authrim_replication_standby_generations
         (pair_id,tenant_id,generation_id,source_sync_operation_id,source_sync_plan_sha256,proof_json,registered_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,${NOW})`,
        [
          pinned.pairId,
          pinned.tenantId,
          proof.generationId,
          pinned.sourceSyncOperationId,
          pinned.sourceSyncPlanSha256,
          json,
        ]
      );
    });
  }

  async verifyFailoverGeneration(
    input: DeploymentOperationIdentity,
    inputProof: DeploymentFailoverGeneration
  ): Promise<DeploymentSwitchOperation> {
    assertDeploymentOperationIdentity(input);
    assertDeploymentFailoverGeneration(inputProof);
    const pinned = structuredClone(input);
    const proof = structuredClone(inputProof);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.tenantId);
      const existing =
        (await this.readOperation(client, pinned)) ?? authorityFailure('operation_not_found');
      if (existing.kind !== 'failover') authorityFailure('operation_kind_mismatch');
      if (existing.generation) {
        if (
          authorityCanonicalJson({
            generation: existing.generation,
            acceptedDataLoss: existing.acceptedDataLoss,
          }) !== authorityCanonicalJson(proof)
        )
          authorityFailure('idempotency_conflict');
        return existing;
      }
      const current = await this.currentOperation(client, row, pinned);
      const generation = proof.generation;
      const accepted = proof.acceptedDataLoss;
      const clock = await client.query<{ now_ms: string }>(`SELECT ${NOW} AS now_ms`);
      const now = number(clock.rows[0].now_ms);
      if (
        generation.sourceDeploymentId !== current.sourceDeploymentId ||
        generation.destinationDeploymentId !== current.destinationDeploymentId ||
        generation.sourceEpoch !== current.expectedEpoch ||
        generation.sourceFenceRevision !== current.expectedRevision ||
        generation.generationId === row.selected_generation_id ||
        generation.generationId === definition(row).initialGenerationId ||
        accepted.acceptedAtMs < (current.drainedAtMs ?? Number.MAX_SAFE_INTEGER) ||
        accepted.acceptedAtMs > now ||
        generation.capturedAtMs > accepted.acceptedAtMs ||
        now - generation.capturedAtMs > accepted.maximumSnapshotAgeMs
      )
        authorityFailure('generation_mismatch');
      const standby: DeploymentStandbyGeneration = {
        pairId: pinned.pairId,
        tenantId: pinned.tenantId,
        sourceSyncOperationId: accepted.sourceSyncOperationId,
        sourceSyncPlanSha256: accepted.sourceSyncPlanSha256,
        generation,
      };
      const registered = await client.query<{ proof_json: string }>(
        `SELECT proof_json FROM authrim_replication_standby_generations WHERE pair_id=$1 AND tenant_id=$2 AND generation_id=$3`,
        [pinned.pairId, pinned.tenantId, generation.generationId]
      );
      if (
        registered.rows.length !== 1 ||
        registered.rows[0].proof_json !== authorityCanonicalJson(standby)
      )
        authorityFailure('standby_unregistered');
      await this.checkCatalog(client, standby);
      const duplicate = await client.query(
        `SELECT 1 FROM ${OPERATIONS} WHERE pair_id=$1 AND generation_json::jsonb->>'generationId'=$2`,
        [pinned.pairId, generation.generationId]
      );
      if (duplicate.rows.length) authorityFailure('generation_reused');
      await client.query(
        `UPDATE ${OPERATIONS} SET state='verified',generation_json=$3,accepted_data_loss_json=$4 WHERE pair_id=$1 AND operation_id=$2`,
        [
          pinned.pairId,
          pinned.operationId,
          authorityCanonicalJson(generation),
          authorityCanonicalJson(accepted),
        ]
      );
      return (await this.readOperation(client, pinned)) ?? authorityFailure('state_invalid');
    });
  }

  async promote(input: DeploymentOperationIdentity): Promise<DeploymentSwitchOperation> {
    assertDeploymentOperationIdentity(input);
    const pinned = structuredClone(input);
    return this.transaction(async (client) => {
      const row = await this.locked(client, pinned.pairId, pinned.tenantId);
      const existing =
        (await this.readOperation(client, pinned)) ?? authorityFailure('operation_not_found');
      // Recovery of the exact durable receipt does not re-promote, even after a later failback.
      if (existing.state === 'promoted') return existing;
      const current = await this.currentOperation(client, row, pinned);
      if (current.state !== 'verified' || !current.generation)
        authorityFailure('generation_unverified');
      if (current.kind === 'failover') {
        const clock = await client.query<{ now_ms: string }>(`SELECT ${NOW} AS now_ms`);
        if (
          !current.acceptedDataLoss ||
          number(clock.rows[0].now_ms) - current.generation.capturedAtMs >
            current.acceptedDataLoss.maximumSnapshotAgeMs
        )
          authorityFailure('snapshot_too_old');
      }
      const result = await client.query<{ epoch: string }>(
        `UPDATE ${PAIRS} SET owner_deployment_id=$3,selected_generation_id=$4,epoch=epoch+1,
         revision=revision+1,phase='active',active_operation_id=NULL,drained_at_ms=NULL
         WHERE pair_id=$1 AND tenant_id=$2 AND epoch=$5 AND revision=$6 AND active_operation_id=$7
         RETURNING epoch`,
        [
          pinned.pairId,
          pinned.tenantId,
          current.destinationDeploymentId,
          current.generation.generationId,
          current.expectedEpoch,
          current.drainRevision,
          pinned.operationId,
        ]
      );
      if (result.rows.length !== 1) authorityFailure('switch_conflict');
      await client.query(
        `UPDATE ${OPERATIONS} SET state='promoted',promoted_epoch=$3 WHERE pair_id=$1 AND operation_id=$2`,
        [pinned.pairId, pinned.operationId, result.rows[0].epoch]
      );
      return (await this.readOperation(client, pinned)) ?? authorityFailure('state_invalid');
    });
  }
}
