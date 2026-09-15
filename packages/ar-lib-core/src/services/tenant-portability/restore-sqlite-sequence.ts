import { openPlannedSqliteRestoreTarget } from './sqlite-restore-plan';
import { encodeTenantBundleManifest } from './bundle-manifest';
import type { TenantBackupRestorePlanInventoryPort } from './restore-plan-inventory';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import {
  runSqliteRestoreDatasetDeferredStep,
  runSqliteRestoreDatasetStep,
  runSqliteRestoreDatasetVerificationStep,
} from './restore-sqlite-step';
import { TENANT_BACKUP_MAX_SQLITE_DATASETS } from './installed-sqlite-datasets';
import {
  cloneSqliteDatasetInspectionPolicy,
  sqliteDatasetInspectionPolicyDescriptor,
} from './sqlite-dataset-inspector';

type DatasetInput = Parameters<typeof runSqliteRestoreDatasetStep>[1];
type Source = Pick<DatasetInput, 'policy' | 'manifest' | 'readNextValidatedRow'>;
export interface PlannedSqliteRestoreSequenceJob {
  targetId: string;
  targetOrdinal: number;
  datasetId: string;
  bundleId: string;
  table: string;
  manifestDigest: string;
  policyDigest: string;
}
type Job = PlannedSqliteRestoreSequenceJob;
const fail = () => new Error('backup_restore_sequence_invalid');

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  return (
    Object.keys(job).sort().join(',') ===
      'bundleId,datasetId,manifestDigest,policyDigest,table,targetId,targetOrdinal' &&
    typeof job.targetId === 'string' &&
    /^[A-Za-z0-9_.:-]{1,256}$/.test(job.targetId) &&
    typeof job.targetOrdinal === 'number' &&
    Number.isSafeInteger(job.targetOrdinal) &&
    job.targetOrdinal >= 0 &&
    typeof job.datasetId === 'string' &&
    /^[A-Za-z0-9_.:-]{1,256}$/.test(job.datasetId) &&
    typeof job.bundleId === 'string' &&
    /^[a-f0-9]{32}$/.test(job.bundleId) &&
    typeof job.table === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(job.table) &&
    typeof job.manifestDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(job.manifestDigest) &&
    typeof job.policyDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(job.policyDigest)
  );
}

function decodeJobs(value: string): Job[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw fail();
  }
  if (
    !decoded ||
    typeof decoded !== 'object' ||
    Array.isArray(decoded) ||
    Object.keys(decoded).sort().join(',') !== 'jobs,kind,version' ||
    !('version' in decoded) ||
    decoded.version !== 1 ||
    !('kind' in decoded) ||
    decoded.kind !== 'sqlite-restore-sequence' ||
    !('jobs' in decoded) ||
    !Array.isArray(decoded.jobs) ||
    decoded.jobs.length > TENANT_BACKUP_MAX_SQLITE_DATASETS ||
    decoded.jobs.some((job: unknown) => !isJob(job))
  )
    throw fail();
  return decoded.jobs as Job[];
}

/** Locate one dataset's target from the sealed server-built restore sequence. */
export async function loadPlannedSqliteRestoreSequenceJob(
  inventory: TenantBackupRestorePlanInventoryPort,
  lease: TenantBackupStepContext['lease'],
  planDigest: string,
  datasetId: string
): Promise<{ sequenceOrdinal: number; job: Readonly<PlannedSqliteRestoreSequenceJob> }> {
  if (!/^[a-f0-9]{64}$/.test(planDigest) || !/^[A-Za-z0-9_.:-]{1,256}$/.test(datasetId))
    throw fail();
  const head = await inventory.headForLease(lease);
  if (head.state !== 'sealed' || head.chain_digest !== planDigest) throw fail();
  let sequence: { ordinal: number; item_id: string; payload_json: string } | undefined;
  for (let from = 0; from < head.item_count; from += 16) {
    const rows = await inventory.readPage(from);
    for (const row of rows) {
      if (row.item_id !== 'sqlite-restore-sequence') continue;
      if (sequence) throw fail();
      sequence = row;
    }
  }
  if (!sequence) throw fail();
  const matches = decodeJobs(sequence.payload_json).filter((job) => job.datasetId === datasetId);
  if (matches.length !== 1) throw fail();
  await inventory.headForLease(lease);
  return { sequenceOrdinal: sequence.ordinal, job: Object.freeze({ ...matches[0] }) };
}
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
      new TextEncoder().encode(JSON.stringify(sqliteDatasetInspectionPolicyDescriptor(policy)))
    ),
  };
}

function orderDatasets<T extends { policy: DatasetInput['policy'] }>(datasets: readonly T[]): T[] {
  const byDataset = new Map<string, { dataset: T; index: number }>();
  for (const [index, candidate] of datasets.entries()) {
    const id = candidate.policy.dataset.id;
    if (byDataset.has(id)) throw fail();
    byDataset.set(id, { dataset: candidate, index });
  }
  const sourceIndex = (id: string) => {
    const value = byDataset.get(id);
    if (!value) throw fail();
    return value.index;
  };
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const candidate of datasets) {
    const id = candidate.policy.dataset.id;
    const declared = candidate.policy.restoreAfter ?? [];
    if (new Set(declared).size !== declared.length) throw fail();
    const required = new Set<string>();
    for (const dependency of declared) {
      if (dependency === id) continue;
      if (!byDataset.has(dependency)) throw fail();
      required.add(dependency);
      const downstream = dependents.get(dependency) ?? new Set<string>();
      downstream.add(id);
      dependents.set(dependency, downstream);
    }
    dependencies.set(id, required);
  }
  const ready = [...byDataset.entries()]
    .filter(([id]) => dependencies.get(id)?.size === 0)
    .sort((left, right) => left[1].index - right[1].index)
    .map(([id]) => id);
  const ordered: T[] = [];
  while (ready.length) {
    const id = ready.shift();
    if (!id) throw fail();
    const selected = byDataset.get(id);
    if (!selected) throw fail();
    ordered.push(selected.dataset);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = dependencies.get(dependent);
      if (!remaining) throw fail();
      remaining.delete(id);
      if (remaining.size === 0) {
        ready.push(dependent);
        ready.sort((left, right) => sourceIndex(left) - sourceIndex(right));
      }
    }
  }
  if (ordered.length !== datasets.length) throw fail();
  return ordered;
}
/** Installed planner supplies complete dependency order after validating the fixed input set. */
export async function persistSqliteRestoreSequence(
  inventory: TenantBackupRestorePlanInventoryPort,
  ordinal: number,
  datasets: readonly Pick<DatasetInput, 'targetId' | 'ordinal' | 'manifest' | 'policy'>[]
): Promise<void> {
  if (datasets.length > TENANT_BACKUP_MAX_SQLITE_DATASETS) throw fail();
  const pinned = orderDatasets(
    datasets.map((dataset) => ({
      ...dataset,
      manifest: structuredClone(dataset.manifest),
      policy: cloneSqliteDatasetInspectionPolicy(dataset.policy),
    }))
  );
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
  const jobs = decodeJobs(rows[0].payload_json);
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
    !['apply_sqlite_dataset', 'apply_sqlite_dataset_deferred', 'verify_sqlite_dataset'].includes(
      context.operation.phase
    )
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
    return { phase: 'restore_other_stores', cursor: envelope(null), disposition: 'continue' };
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
      : context.operation.phase === 'apply_sqlite_dataset_deferred'
        ? runSqliteRestoreDatasetDeferredStep
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
