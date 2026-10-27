import { randomUUID } from 'node:crypto';
import {
  environmentGenerationDigest,
  verifyEnvironmentGenerationDigest,
  type EnvironmentAuthority,
  type EnvironmentAuthorityState,
  type EnvironmentGenerationRecord,
  type EnvironmentGenerationProof,
  type EnvironmentSwitchOperation,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-authority';
import {
  assertEnvironmentSourceInventory,
  type EnvironmentReplicationInventory,
} from '@authrim/ar-lib-core/services/deployment-replication/environment-inventory';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import type { ReplicationJournalRecord } from './journal';
import type { ReplicationExportOperation } from './export-control-client';
import type { DownloadedReplicationExport } from './export-client';
import {
  assertReplicationGenerationLocation,
  type ReplicationGenerationLocation,
} from './generation-catalog';

export interface EnvironmentOperationPlan {
  operationId: string;
  pairId: string;
  environmentId: string;
  sourceDeploymentId: string;
  destinationDeploymentId: string;
  expectedEpoch: number;
  mode: 'sync' | 'switch' | 'failover';
}
export interface EnvironmentChildProgress {
  tenantId: string;
  restoreId: string;
  attempt: number;
  phase: 'pending' | 'exporting' | 'downloaded' | 'restoring' | 'verified';
  source?: ReplicationExportOperation;
  snapshot?: DownloadedReplicationExport;
  destination?: { generation: ReplicationGenerationLocation; verificationSha256: string };
}
export interface EnvironmentOperationProgress {
  formatVersion: 2;
  plan: EnvironmentOperationPlan;
  phase: 'pending' | 'draining' | 'exporting' | 'verified' | 'complete' | 'cancelled';
  generationId: string;
  inventory?: EnvironmentReplicationInventory;
  children: EnvironmentChildProgress[];
  generation?: EnvironmentGenerationRecord;
  cutover?: EnvironmentSwitchOperation;
  proof?: EnvironmentGenerationProof;
  writerAuthorityChanged: boolean;
}
export interface EnvironmentCheckpoint {
  current(): ReplicationJournalRecord<EnvironmentOperationProgress>;
  save(
    value: EnvironmentOperationProgress
  ): Promise<ReplicationJournalRecord<EnvironmentOperationProgress>>;
}
export interface EnvironmentCoordinatorDependencies {
  expectedPlan: EnvironmentOperationPlan;
  authority: EnvironmentAuthority;
  checkpoint: EnvironmentCheckpoint;
  source: {
    inventory(minimumObservedAtMs: number): Promise<EnvironmentReplicationInventory>;
    advance(tenantId: string, idempotencyKey: string): Promise<ReplicationExportOperation>;
    download(
      tenantId: string,
      operationId: string,
      minimumBoundaryUnixMs: number
    ): Promise<DownloadedReplicationExport>;
  };
  target: {
    restore(input: {
      tenantId: string;
      snapshot: DownloadedReplicationExport;
      restoreId: string;
      generationId: string;
      servingEpoch: number;
    }): Promise<NonNullable<EnvironmentChildProgress['destination']>>;
  };
  maximumSnapshotAgeMs: number;
  now?: () => number;
}

function invalid(): never {
  throw new Error('environment_replication_operation_conflict');
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalRestoreJson(a) === canonicalRestoreJson(b);
}
function operationIdentity(plan: EnvironmentOperationPlan) {
  return { pairId: plan.pairId, environmentId: plan.environmentId, operationId: plan.operationId };
}
function sameSource(state: EnvironmentAuthorityState, plan: EnvironmentOperationPlan) {
  if (
    state.pairId !== plan.pairId ||
    state.environmentId !== plan.environmentId ||
    state.ownerDeploymentId !== plan.sourceDeploymentId ||
    state.epoch !== plan.expectedEpoch
  )
    invalid();
}
function assertProgress(progress: EnvironmentOperationProgress, plan: EnvironmentOperationPlan) {
  if (
    !progress ||
    progress.formatVersion !== 2 ||
    !equal(progress.plan, plan) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(progress.generationId) ||
    !Array.isArray(progress.children) ||
    progress.children.length > 16 ||
    !['pending', 'draining', 'exporting', 'verified', 'complete', 'cancelled'].includes(
      progress.phase
    ) ||
    (progress.writerAuthorityChanged && progress.phase !== 'complete')
  )
    invalid();
  if (progress.phase === 'pending') {
    if (
      progress.children.length ||
      progress.inventory ||
      progress.generation ||
      progress.cutover ||
      progress.proof
    )
      invalid();
    return;
  }
  if (
    !progress.inventory ||
    progress.inventory.complete !== true ||
    progress.inventory.pairId !== plan.pairId ||
    progress.inventory.environmentId !== plan.environmentId ||
    progress.inventory.sourceDeploymentId !== plan.sourceDeploymentId ||
    progress.children.length !== progress.inventory.tenants.length
  )
    invalid();
  const restores = new Set<string>();
  for (let i = 0; i < progress.children.length; i++) {
    const child = progress.children[i];
    if (
      child.tenantId !== progress.inventory.tenants[i].tenantId ||
      restores.has(child.restoreId) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(child.restoreId) ||
      !Number.isSafeInteger(child.attempt) ||
      child.attempt < 1 ||
      !['pending', 'exporting', 'downloaded', 'restoring', 'verified'].includes(child.phase)
    )
      invalid();
    restores.add(child.restoreId);
    if (
      ['downloaded', 'restoring', 'verified'].includes(child.phase) &&
      (!child.snapshot || !child.source)
    )
      invalid();
    if (
      child.snapshot &&
      (child.snapshot.publication.operationId !== child.source?.id ||
        child.snapshot.publication.receipt.source.tenantId !== child.tenantId ||
        child.snapshot.publication.receipt.source.issuer !== progress.inventory.tenants[i].issuer ||
        restoreEvidenceDigest(child.snapshot.publication) !== child.snapshot.publicationSha256)
    )
      invalid();
    if (child.phase === 'verified') {
      const target = child.destination ?? invalid();
      assertReplicationGenerationLocation(target.generation);
      if (
        target.generation.pairId !== plan.pairId ||
        target.generation.tenantId !== child.tenantId ||
        target.generation.deploymentId !== plan.destinationDeploymentId ||
        target.generation.generationId !== child.restoreId ||
        target.generation.epoch !== plan.expectedEpoch + 1 ||
        target.generation.location.issuerOrigin !== progress.inventory.tenants[i].issuer ||
        !/^[a-f0-9]{64}$/u.test(target.verificationSha256)
      )
        invalid();
    } else if (child.destination) invalid();
  }
}

async function assertRecordedGeneration(
  progress: EnvironmentOperationProgress,
  planSha256: string
) {
  const record = progress.generation ?? invalid();
  await verifyEnvironmentGenerationDigest(record);
  if (
    record.generationId !== progress.generationId ||
    record.pairId !== progress.plan.pairId ||
    record.environmentId !== progress.plan.environmentId ||
    record.sourceDeploymentId !== progress.plan.sourceDeploymentId ||
    record.deploymentId !== progress.plan.destinationDeploymentId ||
    record.sourceEpoch !== progress.plan.expectedEpoch ||
    record.epoch !== progress.plan.expectedEpoch + 1 ||
    record.sourceOperationId !== progress.plan.operationId ||
    record.sourcePlanSha256 !== planSha256 ||
    record.inventory.sourceReceiptSha256 !== restoreEvidenceDigest(progress.inventory) ||
    !equal(
      record.inventory.tenants,
      progress.inventory?.tenants.map((t) => ({
        tenantId: t.tenantId,
        issuer: t.issuer,
        lifecycle: 'active',
      }))
    ) ||
    record.inventory.capturedAtMs !== progress.inventory?.observedAtMs ||
    record.sourceFenceRevision !==
      (progress.plan.mode === 'sync' ? 0 : progress.cutover?.drainRevision)
  )
    invalid();
  for (let i = 0; i < progress.children.length; i++) {
    const child = progress.children[i];
    const selected = record.children[i];
    if (
      child.phase !== 'verified' ||
      !child.destination ||
      !child.snapshot ||
      selected.tenantId !== child.tenantId ||
      selected.restoreId !== child.restoreId ||
      selected.capturedAtMs !== child.snapshot.publication.boundaryUnixMs ||
      selected.verificationSha256 !== child.destination.verificationSha256 ||
      !equal(selected.location, child.destination.generation.location)
    )
      invalid();
  }
  return record;
}

/** One bounded step; no tenant generation can promote outside the complete aggregate. */
export async function advanceEnvironmentReplicationOperation(
  input: EnvironmentCoordinatorDependencies
): Promise<EnvironmentOperationProgress> {
  const { authority, checkpoint } = input;
  const plan = structuredClone(input.expectedPlan);
  const maximumSnapshotAgeMs = input.maximumSnapshotAgeMs;
  if (
    !['sync', 'switch'].includes(plan.mode) ||
    !Number.isSafeInteger(maximumSnapshotAgeMs) ||
    maximumSnapshotAgeMs < 1000
  )
    invalid();
  let progress = checkpoint.current().value;
  const planSha256 = checkpoint.current().planSha256;
  assertProgress(progress, plan);
  if (progress.inventory) await assertEnvironmentSourceInventory(progress.inventory);
  const identity = operationIdentity(plan);
  const readInventory = async (minimum: number) => {
    const value = structuredClone(await input.source.inventory(minimum));
    await assertEnvironmentSourceInventory(value);
    if (
      value.pairId !== plan.pairId ||
      value.environmentId !== plan.environmentId ||
      value.sourceDeploymentId !== plan.sourceDeploymentId ||
      value.observedAtMs < minimum
    )
      invalid();
    return value;
  };
  const save = async (value: EnvironmentOperationProgress) => {
    progress = (await checkpoint.save(value)).value;
  };
  if (progress.phase === 'cancelled') invalid();
  if (progress.phase === 'complete') {
    const record = await assertRecordedGeneration(progress, planSha256);
    const registered = await authority.getGeneration({
      pairId: plan.pairId,
      environmentId: plan.environmentId,
      deploymentId: plan.destinationDeploymentId,
      generationId: record.generationId,
      epoch: record.epoch,
    });
    if (!equal(record, registered) || progress.writerAuthorityChanged !== (plan.mode === 'switch'))
      invalid();
    if (
      plan.mode === 'switch' &&
      (!progress.cutover ||
        progress.cutover.state !== 'promoted' ||
        progress.cutover.kind !== 'planned' ||
        progress.cutover.sourceDeploymentId !== plan.sourceDeploymentId ||
        progress.cutover.destinationDeploymentId !== plan.destinationDeploymentId ||
        progress.cutover.expectedEpoch !== plan.expectedEpoch ||
        progress.cutover.promotedEpoch !== plan.expectedEpoch + 1 ||
        !equal(progress.proof, {
          generationId: record.generationId,
          digestSha256: record.digestSha256,
          acceptedDataLoss: null,
        }) ||
        !equal(progress.cutover.generation, progress.proof) ||
        !equal(progress.cutover, await authority.getOperation(identity)))
    )
      invalid();
    if (
      plan.mode === 'sync' &&
      (progress.cutover || progress.proof || record.sourceFenceRevision !== 0)
    )
      invalid();
    return progress;
  }
  if (progress.phase === 'pending') {
    const state = await authority.get(plan.pairId, plan.environmentId);
    sameSource(state, plan);
    if (state.phase !== 'active') invalid();
    const inventory = await readInventory(0);
    await save({
      ...progress,
      inventory,
      children: inventory.tenants.map((tenant) => ({
        tenantId: tenant.tenantId,
        restoreId: randomUUID(),
        attempt: 1,
        phase: 'pending',
      })),
      phase: plan.mode === 'switch' ? 'draining' : 'exporting',
      ...(plan.mode === 'switch'
        ? {
            cutover: {
              ...identity,
              kind: 'planned',
              sourceDeploymentId: plan.sourceDeploymentId,
              destinationDeploymentId: plan.destinationDeploymentId,
              expectedEpoch: plan.expectedEpoch,
              expectedRevision: state.revision,
              state: 'draining',
              drainRevision: 0,
              drainedAtMs: null,
              generation: null,
              promotedEpoch: null,
            } as EnvironmentSwitchOperation,
          }
        : {}),
    });
  }
  if (progress.phase === 'draining') {
    const intent = progress.cutover ?? invalid();
    const operation = await authority.beginDrain({
      ...identity,
      kind: 'planned',
      sourceDeploymentId: plan.sourceDeploymentId,
      destinationDeploymentId: plan.destinationDeploymentId,
      expectedEpoch: plan.expectedEpoch,
      expectedRevision: intent.expectedRevision,
    });
    const state = await authority.get(plan.pairId, plan.environmentId);
    sameSource(state, plan);
    if (state.phase !== 'draining' || state.activeOperationId !== plan.operationId) invalid();
    await save({ ...progress, cutover: operation });
    if (state.outstandingPermits !== 0 || state.drainedAtMs === null) return progress;
    const observed = await authority.getOperation(identity);
    if (observed.drainedAtMs === null) return progress;
    const inventory = await readInventory(observed.drainedAtMs);
    if (inventory.inventorySha256 !== progress.inventory?.inventorySha256) invalid();
    await save({ ...progress, inventory, cutover: observed, phase: 'exporting' });
  }
  if (progress.phase === 'exporting') {
    const state = await authority.get(plan.pairId, plan.environmentId);
    sameSource(state, plan);
    if (
      plan.mode === 'sync'
        ? state.phase !== 'active'
        : state.phase !== 'draining' ||
          state.activeOperationId !== plan.operationId ||
          state.outstandingPermits !== 0
    )
      invalid();
    const minimum = plan.mode === 'switch' ? (progress.cutover?.drainedAtMs ?? invalid()) : 0;
    const index = progress.children.findIndex((child) => child.phase !== 'verified');
    if (index !== -1) {
      let child = progress.children[index];
      const saveChild = async (value: EnvironmentChildProgress) => {
        const children = progress.children.map((item, position) =>
          position === index ? value : item
        );
        await save({ ...progress, children });
        child = progress.children[index];
      };
      if (child.phase === 'pending' || child.phase === 'exporting') {
        const source = await input.source.advance(
          child.tenantId,
          `${plan.operationId}:${restoreEvidenceDigest(child.tenantId).slice(0, 16)}`
        );
        if (child.source && source.id !== child.source.id) invalid();
        await saveChild({ ...child, source, phase: 'exporting' });
        if (source.state !== 'ready') return progress;
        const snapshot = await input.source.download(child.tenantId, source.id, minimum);
        await saveChild({ ...child, snapshot, phase: 'downloaded' });
        assertProgress(progress, plan);
      }
      if (child.phase === 'restoring')
        await saveChild({
          ...child,
          restoreId: randomUUID(),
          attempt: child.attempt + 1,
          phase: 'downloaded',
        });
      if (child.phase === 'downloaded') {
        const snapshot = child.snapshot ?? invalid();
        await saveChild({ ...child, phase: 'restoring' });
        const destination = await input.target.restore({
          tenantId: child.tenantId,
          snapshot,
          restoreId: child.restoreId,
          generationId: progress.generationId,
          servingEpoch: plan.expectedEpoch + 1,
        });
        const after = await authority.get(plan.pairId, plan.environmentId);
        sameSource(after, plan);
        if (after.phase !== state.phase || after.activeOperationId !== state.activeOperationId)
          invalid();
        await saveChild({ ...child, destination, phase: 'verified' });
      }
      assertProgress(progress, plan);
      if (progress.children.some((item) => item.phase !== 'verified')) return progress;
    }
    const inventory = progress.inventory ?? invalid();
    const finalInventory = await readInventory(minimum);
    if (inventory.inventorySha256 !== finalInventory.inventorySha256) invalid();
    const now = (input.now ?? Date.now)();
    const fence = plan.mode === 'switch' ? (progress.cutover?.drainRevision ?? invalid()) : 0;
    const body: Omit<EnvironmentGenerationRecord, 'digestSha256'> = {
      formatVersion: 1,
      ...{ pairId: plan.pairId, environmentId: plan.environmentId },
      sourceDeploymentId: plan.sourceDeploymentId,
      deploymentId: plan.destinationDeploymentId,
      generationId: progress.generationId,
      epoch: plan.expectedEpoch + 1,
      sourceEpoch: plan.expectedEpoch,
      sourceFenceRevision: fence,
      sourceOperationId: plan.operationId,
      sourcePlanSha256: planSha256,
      inventory: {
        formatVersion: 1,
        environmentId: plan.environmentId,
        sourceDeploymentId: plan.sourceDeploymentId,
        sourceEpoch: plan.expectedEpoch,
        sourceFenceRevision: fence,
        capturedAtMs: inventory.observedAtMs,
        sourceReceiptSha256: restoreEvidenceDigest(inventory),
        complete: true,
        tenants: inventory.tenants.map((tenant) => ({
          tenantId: tenant.tenantId,
          issuer: tenant.issuer,
          lifecycle: 'active',
        })),
      },
      children: progress.children.map((child) => {
        if (!child.destination || !child.snapshot) return invalid();
        const capturedAtMs = child.snapshot.publication.boundaryUnixMs;
        if (
          capturedAtMs < minimum ||
          now - capturedAtMs > maximumSnapshotAgeMs ||
          capturedAtMs > now + 30_000
        )
          invalid();
        return {
          tenantId: child.tenantId,
          restoreId: child.restoreId,
          sourceEpoch: plan.expectedEpoch,
          sourceFenceRevision: fence,
          capturedAtMs,
          verificationSha256: child.destination.verificationSha256,
          location: child.destination.generation.location,
        };
      }),
    };
    const generation = { ...body, digestSha256: await environmentGenerationDigest(body) };
    await save({ ...progress, generation, phase: 'verified' });
  }
  if (progress.phase === 'verified') {
    const generation = await assertRecordedGeneration(progress, planSha256);
    await authority.registerGeneration(generation);
    if (plan.mode === 'sync')
      await save({ ...progress, phase: 'complete', writerAuthorityChanged: false });
    else {
      const proof: EnvironmentGenerationProof = {
        generationId: generation.generationId,
        digestSha256: generation.digestSha256,
        acceptedDataLoss: null,
      };
      await save({ ...progress, proof });
      await authority.verifyGeneration(identity, proof);
      const cutover = await authority.promote(identity);
      await save({ ...progress, phase: 'complete', cutover, writerAuthorityChanged: true });
    }
  }
  return checkpoint.current().value;
}

/** Only a previously registered COMPLETE environment snapshot may be used without contacting CF. */
export async function advanceEnvironmentFailover(input: {
  expectedPlan: EnvironmentOperationPlan;
  authority: EnvironmentAuthority;
  checkpoint: EnvironmentCheckpoint;
  reviewedStandby: { planSha256: string; progress: EnvironmentOperationProgress };
  maximumSnapshotAgeMs: number;
}): Promise<EnvironmentOperationProgress> {
  const { authority, checkpoint } = input;
  const plan = structuredClone(input.expectedPlan);
  const reviewedStandby = structuredClone(input.reviewedStandby);
  const standby = reviewedStandby.progress;
  if (
    plan.mode !== 'failover' ||
    standby.phase !== 'complete' ||
    standby.plan.mode !== 'sync' ||
    standby.writerAuthorityChanged ||
    standby.plan.pairId !== plan.pairId ||
    standby.plan.environmentId !== plan.environmentId ||
    standby.plan.sourceDeploymentId !== plan.sourceDeploymentId ||
    standby.plan.destinationDeploymentId !== plan.destinationDeploymentId ||
    standby.plan.expectedEpoch !== plan.expectedEpoch ||
    !Number.isSafeInteger(input.maximumSnapshotAgeMs) ||
    input.maximumSnapshotAgeMs < 1000 ||
    input.maximumSnapshotAgeMs > 30 * 86400_000
  )
    invalid();
  assertProgress(standby, standby.plan);
  await assertEnvironmentSourceInventory(standby.inventory);
  const generation = await assertRecordedGeneration(standby, reviewedStandby.planSha256);
  const registered = await authority.getGeneration({
    pairId: plan.pairId,
    environmentId: plan.environmentId,
    deploymentId: plan.destinationDeploymentId,
    generationId: generation.generationId,
    epoch: generation.epoch,
  });
  if (!equal(registered, generation)) invalid();
  let progress = checkpoint.current().value;
  assertProgress(progress, plan);
  if (progress.inventory) await assertEnvironmentSourceInventory(progress.inventory);
  const identity = operationIdentity(plan);
  const save = async (value: EnvironmentOperationProgress) => {
    progress = (await checkpoint.save(value)).value;
  };
  if (progress.phase === 'cancelled') invalid();
  if (
    progress.phase !== 'pending' &&
    (!equal(progress.generation, generation) ||
      !equal(progress.inventory, standby.inventory) ||
      !equal(progress.children, standby.children) ||
      progress.generationId !== generation.generationId)
  )
    invalid();
  if (progress.phase === 'complete') {
    if (
      !progress.writerAuthorityChanged ||
      !progress.cutover ||
      progress.cutover.state !== 'promoted' ||
      !equal(progress.cutover, await authority.getOperation(identity)) ||
      !equal(progress.proof, progress.cutover.generation) ||
      progress.proof?.acceptedDataLoss?.maximumSnapshotAgeMs !== input.maximumSnapshotAgeMs ||
      progress.proof.acceptedDataLoss.sourceSyncPlanSha256 !== reviewedStandby.planSha256 ||
      progress.proof.acceptedDataLoss.sourceSyncOperationId !== standby.plan.operationId
    )
      invalid();
    return progress;
  }
  if (progress.phase === 'pending') {
    const state = await authority.get(plan.pairId, plan.environmentId);
    sameSource(state, plan);
    if (state.phase !== 'active') invalid();
    await save({
      ...progress,
      generationId: generation.generationId,
      generation,
      inventory: standby.inventory,
      children: standby.children,
      phase: 'draining',
      cutover: {
        ...identity,
        kind: 'failover',
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
    const operation = await authority.beginDrain({
      ...identity,
      kind: 'failover',
      sourceDeploymentId: plan.sourceDeploymentId,
      destinationDeploymentId: plan.destinationDeploymentId,
      expectedEpoch: plan.expectedEpoch,
      expectedRevision: intent.expectedRevision,
    });
    const state = await authority.get(plan.pairId, plan.environmentId);
    sameSource(state, plan);
    if (state.phase !== 'draining' || state.activeOperationId !== plan.operationId) invalid();
    await save({ ...progress, cutover: operation });
    if (state.outstandingPermits !== 0 || state.drainedAtMs === null) return progress;
    const observed = await authority.getOperation(identity);
    if (observed.drainedAtMs === null) return progress;
    await save({
      ...progress,
      phase: 'verified',
      cutover: observed,
      proof: {
        generationId: generation.generationId,
        digestSha256: generation.digestSha256,
        acceptedDataLoss: {
          sourceSyncOperationId: standby.plan.operationId,
          sourceSyncPlanSha256: reviewedStandby.planSha256,
          maximumSnapshotAgeMs: input.maximumSnapshotAgeMs,
          acceptedAtMs: observed.drainedAtMs,
        },
      },
    });
  }
  if (progress.phase === 'verified') {
    const proof = progress.proof ?? invalid();
    if (
      proof.generationId !== generation.generationId ||
      proof.digestSha256 !== generation.digestSha256 ||
      proof.acceptedDataLoss?.maximumSnapshotAgeMs !== input.maximumSnapshotAgeMs ||
      proof.acceptedDataLoss.sourceSyncOperationId !== standby.plan.operationId ||
      proof.acceptedDataLoss.sourceSyncPlanSha256 !== reviewedStandby.planSha256
    )
      invalid();
    await authority.verifyGeneration(identity, proof);
    const cutover = await authority.promote(identity);
    await save({ ...progress, phase: 'complete', cutover, writerAuthorityChanged: true });
  }
  if (!['complete', 'draining'].includes(checkpoint.current().value.phase)) invalid();
  return checkpoint.current().value;
}
