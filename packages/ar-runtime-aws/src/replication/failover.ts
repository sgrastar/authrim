import {
  assertDeploymentFailoverGeneration,
  assertDeploymentStandbyGeneration,
} from '@authrim/ar-lib-core/services/deployment-replication/authority';
import { assertReplicationIdentifier } from '@authrim/ar-lib-core/services/deployment-replication/transport';
import { assertReplicationGenerationLocation } from './generation-catalog';
import type {
  DeploymentAuthority,
  DeploymentFailoverGeneration,
} from '@authrim/ar-lib-core/services/deployment-replication/authority';
import { canonicalRestoreJson } from '../import/restore-evidence';
import type { ReplicationJournalRecord } from './journal';
import type { ReplicationOperationPlan, ReplicationOperationProgress } from './coordinator';

interface FailoverProgress extends ReplicationOperationProgress {
  failoverProof?: DeploymentFailoverGeneration;
}

function invalid(): never {
  throw new Error('replication_failover_invalid');
}

/** No source-provider calls. Unresolved writes remain a hard blocker even during a full outage. */
export async function advanceReplicationFailover(input: {
  expectedPlan: ReplicationOperationPlan;
  authority: DeploymentAuthority;
  checkpoint: {
    current(): ReplicationJournalRecord<ReplicationOperationProgress>;
    save(
      value: ReplicationOperationProgress
    ): Promise<ReplicationJournalRecord<ReplicationOperationProgress>>;
  };
  reviewedStandby: { planSha256: string; progress: ReplicationOperationProgress };
  maximumSnapshotAgeMs: number;
}): Promise<ReplicationOperationProgress> {
  const authority = input.authority;
  const plan = structuredClone(input.expectedPlan);
  const reviewedStandby = structuredClone(input.reviewedStandby);
  const maximumSnapshotAgeMs = input.maximumSnapshotAgeMs;
  let progress = input.checkpoint.current().value as FailoverProgress;
  const standby = reviewedStandby.progress;
  if (
    !plan ||
    Object.keys(plan).sort().join(',') !==
      'destinationDeploymentId,expectedEpoch,mode,operationId,pairId,sourceDeploymentId,tenantId'
  )
    invalid();
  for (const value of [
    plan.operationId,
    plan.pairId,
    plan.tenantId,
    plan.sourceDeploymentId,
    plan.destinationDeploymentId,
  ])
    assertReplicationIdentifier(value);
  if (
    plan.mode !== 'failover' ||
    plan.sourceDeploymentId === plan.destinationDeploymentId ||
    !Number.isSafeInteger(plan.expectedEpoch) ||
    plan.expectedEpoch < 1 ||
    plan.expectedEpoch >= Number.MAX_SAFE_INTEGER ||
    !standby ||
    standby.formatVersion !== 1 ||
    standby.phase !== 'complete' ||
    !standby.plan ||
    standby.plan.mode !== 'sync' ||
    standby.writerAuthorityChanged !== false ||
    canonicalRestoreJson(standby.plan) !==
      canonicalRestoreJson({ ...plan, mode: 'sync', operationId: standby.plan.operationId }) ||
    standby.plan.operationId === plan.operationId ||
    !Number.isSafeInteger(standby.attempt) ||
    standby.attempt < 0 ||
    standby.cutover !== undefined ||
    !standby.destination ||
    !standby.snapshot ||
    !/^[a-f0-9]{64}$/u.test(reviewedStandby.planSha256) ||
    !Number.isSafeInteger(maximumSnapshotAgeMs) ||
    maximumSnapshotAgeMs < 1000 ||
    maximumSnapshotAgeMs > 30 * 86400_000
  )
    invalid();
  assertDeploymentStandbyGeneration(standby.standby);
  assertReplicationGenerationLocation(standby.destination.generation);
  assertReplicationIdentifier(standby.plan.operationId);
  const selected = standby.destination.generation;
  const registered = standby.standby;
  if (
    selected.pairId !== plan.pairId ||
    selected.tenantId !== plan.tenantId ||
    selected.deploymentId !== plan.destinationDeploymentId ||
    selected.generationId !== standby.generationId ||
    selected.epoch !== plan.expectedEpoch + 1 ||
    registered.pairId !== plan.pairId ||
    registered.tenantId !== plan.tenantId ||
    registered.sourceSyncOperationId !== standby.plan.operationId ||
    registered.sourceSyncPlanSha256 !== reviewedStandby.planSha256 ||
    canonicalRestoreJson(registered.generation) !==
      canonicalRestoreJson({
        generationId: standby.generationId,
        sourceDeploymentId: plan.sourceDeploymentId,
        destinationDeploymentId: plan.destinationDeploymentId,
        sourceEpoch: plan.expectedEpoch,
        sourceFenceRevision: registered.generation.sourceFenceRevision,
        capturedAtMs: standby.snapshot.publication.boundaryUnixMs,
        manifestSha256: selected.location.manifestSha256,
        verificationSha256: standby.destination.verificationSha256,
      })
  )
    invalid();
  const identity = { pairId: plan.pairId, tenantId: plan.tenantId, operationId: plan.operationId };
  const assertProgress = (value: FailoverProgress): void => {
    if (
      !value ||
      value.formatVersion !== 1 ||
      canonicalRestoreJson(value.plan) !== canonicalRestoreJson(plan) ||
      !['pending', 'draining', 'verified', 'complete'].includes(value.phase) ||
      !Number.isSafeInteger(value.attempt) ||
      value.attempt < 0 ||
      value.writerAuthorityChanged !== (value.phase === 'complete')
    )
      invalid();
    assertReplicationIdentifier(value.generationId);
    if (value.phase === 'pending') {
      if (
        value.cutover !== undefined ||
        value.failoverProof !== undefined ||
        value.standby !== undefined ||
        value.snapshot !== undefined ||
        value.destination !== undefined
      )
        invalid();
      return;
    }
    if (
      value.generationId !== standby.generationId ||
      !value.destination ||
      !value.snapshot ||
      !value.standby ||
      canonicalRestoreJson(value.destination) !== canonicalRestoreJson(standby.destination) ||
      canonicalRestoreJson(value.snapshot) !== canonicalRestoreJson(standby.snapshot) ||
      canonicalRestoreJson(value.standby) !== canonicalRestoreJson(registered)
    )
      invalid();
    const cutover = value.cutover ?? invalid();
    const expectedRevision = registered.generation.sourceFenceRevision;
    const intent = value.phase === 'draining' && cutover.drainRevision === 0;
    if (
      canonicalRestoreJson(cutover) !==
        canonicalRestoreJson({
          ...identity,
          kind: 'failover',
          sourceDeploymentId: plan.sourceDeploymentId,
          destinationDeploymentId: plan.destinationDeploymentId,
          expectedEpoch: plan.expectedEpoch,
          expectedRevision,
          state: cutover.state,
          drainRevision: intent ? 0 : expectedRevision + 1,
          drainedAtMs: cutover.drainedAtMs,
          generation: cutover.generation,
          acceptedDataLoss: cutover.acceptedDataLoss,
          promotedEpoch: cutover.promotedEpoch,
        }) ||
      (intent && cutover.drainedAtMs !== null) ||
      (cutover.drainedAtMs !== null &&
        (!Number.isSafeInteger(cutover.drainedAtMs) || cutover.drainedAtMs < 1))
    )
      invalid();
    if (value.phase === 'draining') {
      if (
        cutover.state !== 'draining' ||
        cutover.generation !== null ||
        cutover.acceptedDataLoss !== null ||
        cutover.promotedEpoch !== null ||
        value.failoverProof !== undefined
      )
        invalid();
      return;
    }
    assertDeploymentFailoverGeneration(value.failoverProof);
    const proof = value.failoverProof;
    if (
      cutover.drainedAtMs === null ||
      canonicalRestoreJson(proof) !==
        canonicalRestoreJson({
          generation: registered.generation,
          acceptedDataLoss: {
            sourceSyncOperationId: standby.plan.operationId,
            sourceSyncPlanSha256: reviewedStandby.planSha256,
            maximumSnapshotAgeMs,
            acceptedAtMs: cutover.drainedAtMs,
          },
        })
    )
      invalid();
    if (value.phase === 'complete') {
      if (
        cutover.state !== 'promoted' ||
        cutover.promotedEpoch !== plan.expectedEpoch + 1 ||
        canonicalRestoreJson(cutover.generation) !== canonicalRestoreJson(proof.generation) ||
        canonicalRestoreJson(cutover.acceptedDataLoss) !==
          canonicalRestoreJson(proof.acceptedDataLoss)
      )
        invalid();
    } else if (
      cutover.state !== 'draining' ||
      cutover.generation !== null ||
      cutover.acceptedDataLoss !== null ||
      cutover.promotedEpoch !== null
    )
      invalid();
  };
  const record = input.checkpoint.current();
  if (
    record.operationId !== plan.operationId ||
    !/^[a-f0-9]{64}$/u.test(record.planSha256) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  )
    invalid();
  assertProgress(progress);
  const save = async (value: FailoverProgress) => {
    assertProgress(value);
    progress = (await input.checkpoint.save(value)).value as FailoverProgress;
    assertProgress(progress);
  };
  if (progress.phase === 'complete') {
    // A locally consistent journal is not proof that promotion actually committed. Historical
    // operations remain readable after failback; the comparison does not repeat their effects.
    if (
      canonicalRestoreJson(await authority.getOperation(identity)) !==
      canonicalRestoreJson(progress.cutover)
    )
      invalid();
    return progress;
  }
  if (progress.phase === 'pending') {
    const state = await authority.get(plan.pairId, plan.tenantId);
    if (
      state.pairId !== plan.pairId ||
      state.tenantId !== plan.tenantId ||
      state.phase !== 'active' ||
      state.ownerDeploymentId !== plan.sourceDeploymentId ||
      state.epoch !== plan.expectedEpoch
    )
      invalid();
    await save({
      ...progress,
      phase: 'draining',
      generationId: standby.generationId,
      snapshot: standby.snapshot,
      destination: standby.destination,
      standby: standby.standby,
      cutover: {
        ...identity,
        kind: 'failover',
        acceptedDataLoss: null,
        sourceDeploymentId: plan.sourceDeploymentId,
        destinationDeploymentId: plan.destinationDeploymentId,
        expectedEpoch: plan.expectedEpoch,
        expectedRevision: state.revision,
        state: 'draining',
        drainRevision: 0,
        drainedAtMs: null,
        generation: null,
        promotedEpoch: null,
      },
    });
  }
  if (progress.phase === 'draining') {
    const intent = progress.cutover ?? invalid();
    const operation = await authority.beginFailoverDrain({
      ...identity,
      sourceDeploymentId: plan.sourceDeploymentId,
      destinationDeploymentId: plan.destinationDeploymentId,
      expectedEpoch: plan.expectedEpoch,
      expectedRevision: intent.expectedRevision,
    });
    const state = await authority.get(plan.pairId, plan.tenantId);
    if (
      state.pairId !== plan.pairId ||
      state.tenantId !== plan.tenantId ||
      state.phase !== 'draining' ||
      state.activeOperationId !== plan.operationId ||
      state.epoch !== plan.expectedEpoch ||
      state.ownerDeploymentId !== plan.sourceDeploymentId
    )
      invalid();
    await save({ ...progress, cutover: operation });
    if (state.outstandingPermits !== 0 || state.drainedAtMs === null) return progress;
    const observed = await authority.getOperation(identity);
    if (observed.drainedAtMs === null) return progress;
    const failoverProof: DeploymentFailoverGeneration = {
      generation: standby.standby.generation,
      acceptedDataLoss: {
        sourceSyncOperationId: standby.plan.operationId,
        sourceSyncPlanSha256: reviewedStandby.planSha256,
        maximumSnapshotAgeMs,
        acceptedAtMs: observed.drainedAtMs,
      },
    };
    // Persist exact acceptance before remote verification; resumed runs cannot silently select a
    // different snapshot or enlarge the approved RPO. The authority independently checks DB time.
    await save({ ...progress, phase: 'verified', cutover: observed, failoverProof });
  }
  if (progress.phase === 'verified') {
    const proof = progress.failoverProof ?? invalid();
    if (
      canonicalRestoreJson(proof.generation) !== canonicalRestoreJson(standby.standby.generation) ||
      proof.acceptedDataLoss.maximumSnapshotAgeMs !== maximumSnapshotAgeMs ||
      proof.acceptedDataLoss.sourceSyncOperationId !== standby.plan.operationId ||
      proof.acceptedDataLoss.sourceSyncPlanSha256 !== reviewedStandby.planSha256
    )
      invalid();
    await authority.verifyFailoverGeneration(identity, proof);
    const promoted = await authority.promote(identity);
    await save({ ...progress, phase: 'complete', cutover: promoted, writerAuthorityChanged: true });
  }
  const result = input.checkpoint.current().value;
  assertProgress(result as FailoverProgress);
  if (result.phase !== 'complete' && result.phase !== 'draining') invalid();
  return result;
}
