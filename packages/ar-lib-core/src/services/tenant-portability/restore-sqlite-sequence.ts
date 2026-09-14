import { openPlannedSqliteRestoreTarget } from './sqlite-restore-plan';
import { encodeTenantBundleManifest } from './bundle-manifest';
import type { TenantBackupRestorePlanInventoryPort } from './restore-plan-inventory';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import {
  runSqliteRestoreDatasetStep,
  runSqliteRestoreDatasetVerificationStep,
} from './restore-sqlite-step';

type DatasetInput = Parameters<typeof runSqliteRestoreDatasetStep>[1];
type Source = Pick<DatasetInput, 'policy' | 'manifest' | 'readNextValidatedRow'>;
interface Job {
  targetId: string;
  targetOrdinal: number;
  datasetId: string;
  bundleId: string;
  table: string;
  manifestDigest: string;
  policyDigest: string;
}
const fail = () => new Error('backup_restore_sequence_invalid');
async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function descriptor(
  input: Pick<DatasetInput, 'targetId' | 'ordinal' | 'manifest' | 'policy'>
): Promise<Job> {
  const policy = input.policy;
  if (
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.targetId) ||
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 0 ||
    !input.manifest.datasets.some(
      (dataset) =>
        dataset.id === policy.dataset.id &&
        dataset.store === 'database' &&
        dataset.disposition === 'include'
    )
  )
    throw fail();
  return {
    targetId: input.targetId,
    targetOrdinal: input.ordinal,
    datasetId: policy.dataset.id,
    bundleId: input.manifest.bundleId,
    table: policy.schema.table,
    manifestDigest: await hash(encodeTenantBundleManifest(input.manifest, input.manifest)),
    policyDigest: await hash(
      new TextEncoder().encode(
        JSON.stringify({
          dataset: policy.dataset,
          schema: policy.schema,
          parentDataset: policy.parentDataset,
          tenantKey: policy.tenantKey,
        })
      )
    ),
  };
}
/** Installed planner supplies complete dependency order after validating the fixed input set. */
export async function persistSqliteRestoreSequence(
  inventory: TenantBackupRestorePlanInventoryPort,
  ordinal: number,
  datasets: readonly Pick<DatasetInput, 'targetId' | 'ordinal' | 'manifest' | 'policy'>[]
): Promise<void> {
  if (datasets.length > 256) throw fail();
  const pinned = datasets.map((dataset) => ({
    ...dataset,
    manifest: structuredClone(dataset.manifest),
    policy: {
      ...structuredClone({ ...dataset.policy, inspectRow: undefined }),
      inspectRow: dataset.policy.inspectRow,
    },
  }));
  const jobs: Job[] = [];
  for (const dataset of pinned) jobs.push(await descriptor(dataset));
  for (const [index, dataset] of pinned.entries()) {
    const own = jobs.filter((job) => job.bundleId === dataset.manifest.bundleId);
    if (
      own.some((job) => job.manifestDigest !== jobs[index].manifestDigest) ||
      dataset.manifest.datasets
        .filter((value) => value.store === 'database' && value.disposition === 'include')
        .some((value) => own.filter((job) => job.datasetId === value.id).length !== 1)
    )
      throw fail();
  }
  if (
    jobs.some((job) => job.targetOrdinal >= ordinal) ||
    new Set(jobs.map((job) => JSON.stringify([job.targetId, job.table]))).size !== jobs.length
  )
    throw fail();
  await inventory.append(
    ordinal,
    'sqlite-restore-sequence',
    JSON.stringify({ version: 1, kind: 'sqlite-restore-sequence', jobs })
  );
}

/** Drive every SQL dataset in a sealed plan; completion here does not activate any target. */
export async function runSqliteRestoreSequenceStep(
  context: TenantBackupStepContext,
  input: Pick<DatasetInput, 'inventory' | 'now' | 'resolve' | 'assertValidatedUnpublishedPlan'> & {
    sequenceOrdinal: number;
    loadValidatedDataset: (job: Readonly<Job>) => Promise<Source>;
  }
): Promise<TenantBackupStepResult> {
  context.signal.throwIfAborted();
  if (
    context.operation.kind !== 'import' ||
    context.operation.state !== 'running' ||
    context.operation.id !== context.lease.operationId ||
    context.operation.tenant_id !== context.lease.tenantId ||
    context.operation.lease_owner !== context.lease.owner ||
    context.operation.fencing_token !== context.lease.fencingToken
  )
    throw fail();
  const head = await input.inventory.headForLease(context.lease);
  const rows = await input.inventory.readPage(input.sequenceOrdinal);
  if (!rows.length || rows[0].item_id !== 'sqlite-restore-sequence') throw fail();
  const decoded: unknown = JSON.parse(rows[0].payload_json);
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    !('version' in decoded) ||
    decoded.version !== 1 ||
    !('kind' in decoded) ||
    decoded.kind !== 'sqlite-restore-sequence' ||
    !('jobs' in decoded) ||
    !Array.isArray(decoded.jobs) ||
    decoded.jobs.length > 256
  )
    throw fail();
  const jobs = decoded.jobs as Job[]; // Created by the installed planner and protected by inventory digests.
  const cursor: unknown = JSON.parse(context.operation.cursor_json ?? 'null');
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    !('version' in cursor) ||
    cursor.version !== 1 ||
    !('sequenceOrdinal' in cursor) ||
    cursor.sequenceOrdinal !== input.sequenceOrdinal ||
    !('jobIndex' in cursor) ||
    !Number.isSafeInteger(cursor.jobIndex) ||
    typeof cursor.jobIndex !== 'number' ||
    cursor.jobIndex < 0 ||
    cursor.jobIndex > jobs.length ||
    !('datasetCursor' in cursor) ||
    (cursor.datasetCursor !== null && typeof cursor.datasetCursor !== 'string')
  )
    throw fail();
  await input.assertValidatedUnpublishedPlan(head.chain_digest);
  const starting = context.operation.phase === 'start_sqlite_restore_sequence';
  const rawCompleted: unknown =
    'completedRows' in cursor ? cursor.completedRows : starting ? [] : null;
  if (
    !Array.isArray(rawCompleted) ||
    rawCompleted.length !== cursor.jobIndex ||
    rawCompleted.some(
      (count: unknown) => typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0
    )
  )
    throw fail();
  const completedRows = [...(rawCompleted as number[])];
  if (['verify_restore_targets', 'verify_sealed_sqlite_datasets'].includes(context.operation.phase))
    return finalizeSqliteTargets(
      context,
      input,
      jobs,
      { ...cursor, jobIndex: cursor.jobIndex, datasetCursor: cursor.datasetCursor },
      completedRows
    );
  let index = cursor.jobIndex;
  let datasetCursor = cursor.datasetCursor;
  if (starting && (index !== 0 || datasetCursor !== null)) throw fail();
  if (context.operation.phase === 'advance_restore_dataset') {
    if (index >= jobs.length || typeof datasetCursor !== 'string') throw fail();
    const result: unknown = JSON.parse(datasetCursor);
    if (
      !result ||
      typeof result !== 'object' ||
      !('rowsVerified' in result) ||
      !('rowsWritten' in result) ||
      result.rowsVerified !== result.rowsWritten ||
      !Number.isSafeInteger(result.rowsWritten) ||
      typeof result.rowsWritten !== 'number' ||
      result.rowsWritten < 0 ||
      !('datasetId' in result) ||
      result.datasetId !== jobs[index].datasetId ||
      !('targetId' in result) ||
      result.targetId !== jobs[index].targetId ||
      !('targetOrdinal' in result) ||
      result.targetOrdinal !== jobs[index].targetOrdinal ||
      !('sourceCursor' in result) ||
      !('verifySourceCursor' in result) ||
      result.sourceCursor !== result.verifySourceCursor
    )
      throw fail();
    completedRows.push(result.rowsWritten);
    index++;
    datasetCursor = null;
  } else if (
    !starting &&
    !['apply_sqlite_dataset', 'verify_sqlite_dataset'].includes(context.operation.phase)
  )
    throw fail();
  function envelope(inner: string | null) {
    return JSON.stringify({
      version: 1,
      sequenceOrdinal: input.sequenceOrdinal,
      jobIndex: index,
      datasetCursor: inner,
      completedRows,
    });
  }
  if (index === jobs.length) {
    if (!starting && context.operation.phase !== 'advance_restore_dataset') throw fail();
    return { phase: 'verify_restore_targets', cursor: envelope(null), disposition: 'continue' };
  }
  const job = jobs[index];
  if (datasetCursor === null) {
    datasetCursor = JSON.stringify({
      version: 1,
      targetId: job.targetId,
      targetOrdinal: job.targetOrdinal,
      datasetId: job.datasetId,
      sourceCursor: null,
      rowsWritten: 0,
    });
    return {
      phase: 'apply_sqlite_dataset',
      cursor: envelope(datasetCursor),
      disposition: 'continue',
    };
  }
  const loaded = await input.loadValidatedDataset(structuredClone(job));
  const actual = await descriptor({
    ...loaded,
    targetId: job.targetId,
    ordinal: job.targetOrdinal,
  });
  if (JSON.stringify(actual) !== JSON.stringify(job)) throw fail();
  await input.inventory.headForLease(context.lease);
  const run =
    context.operation.phase === 'apply_sqlite_dataset'
      ? runSqliteRestoreDatasetStep
      : runSqliteRestoreDatasetVerificationStep;
  const result = await run(
    { ...context, operation: { ...context.operation, cursor_json: datasetCursor } },
    {
      ...input,
      ...loaded,
      targetId: job.targetId,
      ordinal: job.targetOrdinal,
    }
  );
  return { ...result, cursor: envelope(result.cursor) };
}

async function finalizeSqliteTargets(
  context: TenantBackupStepContext,
  input: Parameters<typeof runSqliteRestoreSequenceStep>[1],
  jobs: Job[],
  cursor: object & { jobIndex: number; datasetCursor: string | null },
  completedRows: number[]
): Promise<TenantBackupStepResult> {
  if (cursor.jobIndex !== jobs.length) throw fail();
  const targets = [
    ...new Map(
      jobs.map((job) => [job.targetId, { targetId: job.targetId, ordinal: job.targetOrdinal }])
    ).values(),
  ];
  const sealIndex = 'sealIndex' in cursor ? cursor.sealIndex : 0;
  let verifyIndex = 'verifyIndex' in cursor ? cursor.verifyIndex : 0;
  if (
    typeof sealIndex !== 'number' ||
    !Number.isSafeInteger(sealIndex) ||
    sealIndex < 0 ||
    sealIndex > targets.length ||
    typeof verifyIndex !== 'number' ||
    !Number.isSafeInteger(verifyIndex) ||
    verifyIndex < 0 ||
    verifyIndex > jobs.length
  )
    throw fail();
  function state(sealed: number, inner: string | null) {
    return JSON.stringify({
      version: 1,
      sequenceOrdinal: input.sequenceOrdinal,
      jobIndex: jobs.length,
      datasetCursor: inner,
      completedRows,
      sealIndex: sealed,
      verifyIndex,
    });
  }
  if (context.operation.phase === 'verify_restore_targets') {
    if (verifyIndex !== 0 || cursor.datasetCursor !== null) throw fail();
    if (sealIndex < targets.length) {
      const target = await openPlannedSqliteRestoreTarget({
        ...input,
        context,
        ...targets[sealIndex],
        mode: 'seal',
      });
      await target.seal();
      return {
        phase: 'verify_restore_targets',
        cursor: state(sealIndex + 1, null),
        disposition: 'continue',
      };
    }
    return {
      phase: 'verify_sealed_sqlite_datasets',
      cursor: state(sealIndex, null),
      disposition: 'continue',
    };
  }
  if (sealIndex !== targets.length) throw fail();
  if (verifyIndex === jobs.length) {
    if (cursor.datasetCursor !== null) throw fail();
    return {
      phase: 'verify_other_restore_stores',
      cursor: state(sealIndex, null),
      disposition: 'continue',
    };
  }
  const job = jobs[verifyIndex];
  const loaded = await input.loadValidatedDataset(structuredClone(job));
  if (
    JSON.stringify(
      await descriptor({ ...loaded, targetId: job.targetId, ordinal: job.targetOrdinal })
    ) !== JSON.stringify(job)
  )
    throw fail();
  const inner =
    cursor.datasetCursor ??
    JSON.stringify({
      version: 1,
      targetId: job.targetId,
      targetOrdinal: job.targetOrdinal,
      datasetId: job.datasetId,
      rowsWritten: completedRows[verifyIndex],
      sourceCursor: completedRows[verifyIndex] ? 'final-readback' : null,
      rowsVerified: 0,
      verifySourceCursor: null,
    });
  const saved: unknown = JSON.parse(inner);
  if (
    !saved ||
    typeof saved !== 'object' ||
    !('rowsWritten' in saved) ||
    saved.rowsWritten !== completedRows[verifyIndex]
  )
    throw fail();
  const result = await runSqliteRestoreDatasetVerificationStep(
    {
      ...context,
      operation: { ...context.operation, phase: 'verify_sqlite_dataset', cursor_json: inner },
    },
    {
      ...input,
      ...loaded,
      targetId: job.targetId,
      ordinal: job.targetOrdinal,
      mode: 'verify',
    }
  );
  if (result.phase === 'advance_restore_dataset') {
    verifyIndex++;
    return {
      phase: 'verify_sealed_sqlite_datasets',
      cursor: state(sealIndex, null),
      disposition: 'continue',
    };
  }
  return {
    phase: 'verify_sealed_sqlite_datasets',
    cursor: state(sealIndex, result.cursor),
    disposition: 'continue',
  };
}
