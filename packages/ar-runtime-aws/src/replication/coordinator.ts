import { randomUUID } from 'node:crypto';
import { assertDeploymentStandbyGeneration } from '@authrim/ar-lib-core/services/deployment-replication/authority';
import type {
  DeploymentAuthority,
  DeploymentAuthorityState,
  DeploymentSwitchOperation,
  DeploymentStandbyGeneration,
} from '@authrim/ar-lib-core/services/deployment-replication/authority';
import type { DownloadedReplicationExport } from './export-client';
import type { ReplicationExportOperation } from './export-control-client';
import type { ReplicationGenerationLocation } from './generation-catalog';
import { assertReplicationGenerationLocation } from './generation-catalog';
import {
  assertReplicationIdentifier,
  replicationCanonicalJson,
} from '@authrim/ar-lib-core/services/deployment-replication/transport';
import type { ReplicationJournalRecord } from './journal';

export interface ReplicationOperationPlan {
  operationId: string;
  pairId: string;
  tenantId: string;
  sourceDeploymentId: string;
  destinationDeploymentId: string;
  expectedEpoch: number;
  mode: 'sync' | 'switch' | 'failover';
}

export interface ReplicationOperationProgress {
  formatVersion: 1;
  phase:
    | 'pending'
    | 'draining'
    | 'exporting'
    | 'downloaded'
    | 'restoring'
    | 'verified'
    | 'complete';
  plan: ReplicationOperationPlan;
  generationId: string;
  attempt: number;
  source?: ReplicationExportOperation;
  snapshot?: DownloadedReplicationExport;
  destination?: {
    generation: ReplicationGenerationLocation;
    verificationSha256: string;
  };
  cutover?: DeploymentSwitchOperation;
  standby?: DeploymentStandbyGeneration;
  /** Traffic/DNS is separate from the data writer authority. No inference from HTTP health. */
  writerAuthorityChanged: boolean;
}

export interface ReplicationCoordinatorDependencies {
  /** Reconstructed from the independently pinned operator plan, never from checkpoint contents. */
  expectedPlan: ReplicationOperationPlan;
  authority: DeploymentAuthority;
  checkpoint: {
    current(): ReplicationJournalRecord<ReplicationOperationProgress>;
    save(
      value: ReplicationOperationProgress
    ): Promise<ReplicationJournalRecord<ReplicationOperationProgress>>;
  };
  source: {
    advance(idempotencyKey: string): Promise<ReplicationExportOperation>;
    download(
      operationId: string,
      minimumBoundaryUnixMs: number
    ): Promise<DownloadedReplicationExport>;
  };
  target: {
    /** Every attempt receives a new empty generation. Must fully verify SQL, state and keys. */
    restore(input: {
      snapshot: DownloadedReplicationExport;
      generationId: string;
      servingEpoch: number;
    }): Promise<NonNullable<ReplicationOperationProgress['destination']>>;
    /** Immutable catalog publication, idempotent only for exactly the same pins. */
    register(generation: ReplicationGenerationLocation): Promise<void>;
  };
}

function invalid(): never {
  throw new Error('replication_operation_conflict');
}
function sameSource(state: DeploymentAuthorityState, plan: ReplicationOperationPlan): void {
  if (
    state.pairId !== plan.pairId ||
    state.tenantId !== plan.tenantId ||
    state.ownerDeploymentId !== plan.sourceDeploymentId ||
    state.epoch !== plan.expectedEpoch
  )
    invalid();
}

function assertProgress(
  progress: ReplicationOperationProgress,
  expected: ReplicationOperationPlan,
  expectedPlanSha256: string
): void {
  const plan = progress?.plan;
  if (
    !plan ||
    Object.keys(plan).sort().join(',') !==
      'destinationDeploymentId,expectedEpoch,mode,operationId,pairId,sourceDeploymentId,tenantId' ||
    replicationCanonicalJson(plan) !== replicationCanonicalJson(expected)
  )
    invalid();
  for (const id of [
    plan.operationId,
    plan.pairId,
    plan.tenantId,
    plan.sourceDeploymentId,
    plan.destinationDeploymentId,
    progress.generationId,
  ])
    assertReplicationIdentifier(id);
  if (
    progress.formatVersion !== 1 ||
    !['sync', 'switch'].includes(plan.mode) ||
    plan.sourceDeploymentId === plan.destinationDeploymentId ||
    !Number.isSafeInteger(plan.expectedEpoch) ||
    plan.expectedEpoch < 1 ||
    plan.expectedEpoch >= Number.MAX_SAFE_INTEGER ||
    ![
      'pending',
      'draining',
      'exporting',
      'downloaded',
      'restoring',
      'verified',
      'complete',
    ].includes(progress.phase) ||
    !Number.isSafeInteger(progress.attempt) ||
    progress.attempt < 0 ||
    progress.writerAuthorityChanged !== (plan.mode === 'switch' && progress.phase === 'complete') ||
    (plan.mode === 'sync' && progress.phase === 'draining') ||
    (plan.mode === 'switch' && progress.phase !== 'pending' && !progress.cutover)
  )
    invalid();
  if (['downloaded', 'restoring', 'verified', 'complete'].includes(progress.phase)) {
    if (
      !progress.snapshot ||
      !progress.source ||
      progress.snapshot.publication.operationId !== progress.source.id ||
      progress.source.state !== 'ready' ||
      progress.source.phase !== 'export_complete' ||
      progress.snapshot.publication.receipt.source.tenantId !== plan.tenantId ||
      !Number.isSafeInteger(progress.snapshot.publication.boundaryUnixMs) ||
      progress.snapshot.publication.boundaryUnixMs < 1 ||
      !/^[a-f0-9]{64}$/u.test(progress.snapshot.publicationSha256)
    )
      invalid();
  }
  if (progress.phase === 'verified' || progress.phase === 'complete') {
    if (!progress.destination) invalid();
    assertReplicationGenerationLocation(progress.destination.generation);
    const generation = progress.destination.generation;
    if (
      generation.pairId !== plan.pairId ||
      generation.tenantId !== plan.tenantId ||
      generation.deploymentId !== plan.destinationDeploymentId ||
      generation.generationId !== progress.generationId ||
      generation.epoch !== plan.expectedEpoch + 1 ||
      !/^[a-f0-9]{64}$/u.test(progress.destination.verificationSha256)
    )
      invalid();
  }
  if (plan.mode === 'sync' && progress.phase === 'complete') {
    assertDeploymentStandbyGeneration(progress.standby);
    const standby = progress.standby;
    if (
      standby.pairId !== plan.pairId ||
      standby.tenantId !== plan.tenantId ||
      standby.sourceSyncOperationId !== plan.operationId ||
      standby.sourceSyncPlanSha256 !== expectedPlanSha256 ||
      replicationCanonicalJson(standby.generation) !==
        replicationCanonicalJson({
          generationId: progress.generationId,
          sourceDeploymentId: plan.sourceDeploymentId,
          destinationDeploymentId: plan.destinationDeploymentId,
          sourceEpoch: plan.expectedEpoch,
          sourceFenceRevision: standby.generation.sourceFenceRevision,
          capturedAtMs: (progress.snapshot ?? invalid()).publication.boundaryUnixMs,
          manifestSha256: (progress.destination ?? invalid()).generation.location.manifestSha256,
          verificationSha256: (progress.destination ?? invalid()).verificationSha256,
        })
    )
      invalid();
  }
  if (progress.cutover) {
    const cutover = progress.cutover;
    if (
      cutover.kind !== 'planned' ||
      cutover.acceptedDataLoss !== null ||
      cutover.pairId !== plan.pairId ||
      cutover.tenantId !== plan.tenantId ||
      cutover.operationId !== plan.operationId ||
      cutover.sourceDeploymentId !== plan.sourceDeploymentId ||
      cutover.destinationDeploymentId !== plan.destinationDeploymentId ||
      cutover.expectedEpoch !== plan.expectedEpoch
    )
      invalid();
    if (progress.phase === 'complete') {
      if (
        cutover.state !== 'promoted' ||
        cutover.promotedEpoch !== plan.expectedEpoch + 1 ||
        replicationCanonicalJson(cutover.generation) !==
          replicationCanonicalJson({
            generationId: progress.generationId,
            sourceDeploymentId: plan.sourceDeploymentId,
            destinationDeploymentId: plan.destinationDeploymentId,
            sourceEpoch: plan.expectedEpoch,
            sourceFenceRevision: cutover.drainRevision,
            capturedAtMs: (progress.snapshot ?? invalid()).publication.boundaryUnixMs,
            manifestSha256: (progress.destination ?? invalid()).generation.location.manifestSha256,
            verificationSha256: (progress.destination ?? invalid()).verificationSha256,
          })
      )
        invalid();
    }
  }
}

/**
 * Runs until a remote export/drain needs observation. Repeated invocations resume the same durable
 * journal. A crash during restore abandons those unselected targets and allocates a fresh attempt;
 * it never retries a non-transactional distributed restore onto partly restored databases.
 */
export async function advanceReplicationOperation(
  dependencies: ReplicationCoordinatorDependencies
): Promise<ReplicationOperationProgress> {
  const { authority, checkpoint } = dependencies;
  let progress = checkpoint.current().value;
  assertProgress(progress, dependencies.expectedPlan, checkpoint.current().planSha256);
  const plan = progress.plan;
  const identity = { pairId: plan.pairId, tenantId: plan.tenantId, operationId: plan.operationId };
  const save = async (next: ReplicationOperationProgress) => {
    assertProgress(next, dependencies.expectedPlan, checkpoint.current().planSha256);
    progress = (await checkpoint.save(next)).value;
  };
  const assertSourceCurrent = async () => {
    const state = await authority.get(plan.pairId, plan.tenantId);
    sameSource(state, plan);
    if (
      (plan.mode === 'sync' && state.phase !== 'active') ||
      (plan.mode === 'switch' &&
        (state.phase !== 'draining' ||
          state.activeOperationId !== plan.operationId ||
          state.outstandingPermits !== 0 ||
          state.drainedAtMs === null))
    )
      invalid();
    return state;
  };
  if (progress.formatVersion !== 1 || !['sync', 'switch'].includes(plan.mode)) invalid();
  if (progress.phase === 'complete') return progress;
  if (progress.phase === 'pending') {
    const state = await authority.get(plan.pairId, plan.tenantId);
    sameSource(state, plan);
    if (state.phase !== 'active') invalid();
    if (plan.mode === 'switch') {
      // Pin intent before the remote CAS. A lost response resumes getOperation/beginDrain.
      const cutover: DeploymentSwitchOperation = {
        ...identity,
        sourceDeploymentId: plan.sourceDeploymentId,
        destinationDeploymentId: plan.destinationDeploymentId,
        expectedEpoch: plan.expectedEpoch,
        expectedRevision: state.revision,
        kind: 'planned',
        acceptedDataLoss: null,
        state: 'draining',
        drainRevision: 0,
        drainedAtMs: null,
        generation: null,
        promotedEpoch: null,
      };
      await save({ ...progress, phase: 'draining', cutover });
    } else await save({ ...progress, phase: 'exporting' });
  }
  if (progress.phase === 'draining') {
    const intent = progress.cutover ?? invalid();
    const cutover = await authority.beginDrain({
      ...identity,
      sourceDeploymentId: plan.sourceDeploymentId,
      destinationDeploymentId: plan.destinationDeploymentId,
      expectedEpoch: plan.expectedEpoch,
      expectedRevision: intent.expectedRevision,
    });
    const state = await authority.get(plan.pairId, plan.tenantId);
    sameSource(state, plan);
    if (state.phase !== 'draining' || state.activeOperationId !== plan.operationId) invalid();
    await save({ ...progress, cutover });
    if (state.outstandingPermits !== 0 || state.drainedAtMs === null) return progress;
    await save({
      ...progress,
      phase: 'exporting',
      cutover: await authority.getOperation(identity),
    });
  }
  if (progress.phase === 'exporting') {
    const state = await authority.get(plan.pairId, plan.tenantId);
    sameSource(state, plan);
    if (
      (plan.mode === 'sync' && state.phase !== 'active') ||
      (plan.mode === 'switch' &&
        (state.phase !== 'draining' ||
          state.activeOperationId !== plan.operationId ||
          state.outstandingPermits !== 0))
    )
      invalid();
    const source = await dependencies.source.advance(plan.operationId);
    await save({ ...progress, source });
    if (source.state !== 'ready' || source.phase !== 'export_complete') return progress;
    const minimum = plan.mode === 'switch' ? (progress.cutover?.drainedAtMs ?? invalid()) : 0;
    const snapshot = await dependencies.source.download(source.id, minimum);
    if (
      snapshot.publication.receipt.source.tenantId !== plan.tenantId ||
      snapshot.publication.boundaryUnixMs < minimum
    )
      invalid();
    await save({ ...progress, phase: 'downloaded', snapshot });
  }
  if (progress.phase === 'restoring') {
    // This phase on entry means the previous outcome is unknown. Old targets remain preserved
    // and unselected; a new generation prevents a late old process from modifying this attempt.
    await save({
      ...progress,
      phase: 'downloaded',
      generationId: randomUUID(),
      attempt: progress.attempt + 1,
    });
  }
  if (progress.phase === 'downloaded') {
    if (!progress.snapshot) invalid();
    await assertSourceCurrent();
    await save({ ...progress, phase: 'restoring' });
    const destination = await dependencies.target.restore({
      snapshot: progress.snapshot ?? invalid(),
      generationId: progress.generationId,
      servingEpoch: plan.expectedEpoch + 1,
    });
    if (
      destination.generation.pairId !== plan.pairId ||
      destination.generation.tenantId !== plan.tenantId ||
      destination.generation.deploymentId !== plan.destinationDeploymentId ||
      destination.generation.generationId !== progress.generationId ||
      destination.generation.epoch !== plan.expectedEpoch + 1 ||
      !/^[a-f0-9]{64}$/u.test(destination.verificationSha256)
    )
      invalid();
    await assertSourceCurrent();
    await save({ ...progress, phase: 'verified', destination });
  }
  if (progress.phase === 'verified') {
    const destination = progress.destination ?? invalid();
    await dependencies.target.register(destination.generation);
    if (plan.mode === 'switch') {
      const cutover = await authority.getOperation(identity);
      // Even a recovered promotion receipt must match this journal's exact verified generation.
      // A prior successful operation is not proof that a different destination was activated.
      await authority.verifyGeneration(identity, {
        generationId: progress.generationId,
        sourceDeploymentId: plan.sourceDeploymentId,
        destinationDeploymentId: plan.destinationDeploymentId,
        sourceEpoch: plan.expectedEpoch,
        sourceFenceRevision: cutover.drainRevision,
        capturedAtMs: (progress.snapshot ?? invalid()).publication.boundaryUnixMs,
        manifestSha256: destination.generation.location.manifestSha256,
        verificationSha256: destination.verificationSha256,
      });
      const promoted = await authority.promote(identity);
      await save({
        ...progress,
        phase: 'complete',
        writerAuthorityChanged: true,
        cutover: promoted,
      });
    } else {
      const state = await authority.get(plan.pairId, plan.tenantId);
      sameSource(state, plan);
      if (state.phase !== 'active') invalid();
      const standby: DeploymentStandbyGeneration = {
        pairId: plan.pairId,
        tenantId: plan.tenantId,
        sourceSyncOperationId: plan.operationId,
        sourceSyncPlanSha256: checkpoint.current().planSha256,
        generation: {
          generationId: progress.generationId,
          sourceDeploymentId: plan.sourceDeploymentId,
          destinationDeploymentId: plan.destinationDeploymentId,
          sourceEpoch: plan.expectedEpoch,
          sourceFenceRevision: state.revision,
          capturedAtMs: (progress.snapshot ?? invalid()).publication.boundaryUnixMs,
          manifestSha256: destination.generation.location.manifestSha256,
          verificationSha256: destination.verificationSha256,
        },
      };
      await authority.registerStandbyGeneration(standby);
      await save({ ...progress, phase: 'complete', writerAuthorityChanged: false, standby });
    }
  }
  return progress;
}
