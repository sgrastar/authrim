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
  recordCount: number;
  byteCount: number;
  reconcilesGeneratedRows: boolean;
}
type Job = PlannedSqliteRestoreSequenceJob;
const fail = () => new Error('backup_restore_sequence_invalid');
const EXECUTION_BATCH_ROWS = 250;
const EXECUTION_BATCH_BYTES = 4 * 1024 * 1024;

function canShareExecutionBatch(policy: Source['policy']): boolean {
  return (
    policy.restoreDisposition !== 'reference_only' &&
    !policy.restoreHold &&
    !policy.deferredColumns?.length
  );
}

function canShareVerificationBatch(policy: Source['policy']): boolean {
  // Sidecars, deferred references and transformed values are complete before targets are sealed.
  // Their final readback can therefore share one physical target window. Held and reference-only
  // rows retain their dedicated verification rules because their materialized count differs.
  return policy.restoreDisposition !== 'reference_only' && !policy.restoreHold;
}

async function readCompleteDataset(
  source: Source,
  job: Job,
  planDigest: string,
  remainingRows: number,
  remainingBytes: number
): Promise<{ rows: string[]; bytes: number } | null> {
  const rows: string[] = [];
  let bytes = 0;
  let sourceCursor: string | null = null;
  for (;;) {
    const next = await source.readNextValidatedRow({
      datasetId: job.datasetId,
      sourceCursor,
      planDigest,
    });
    if (next === null) return { rows, bytes };
    if (!next.nextCursor || next.nextCursor === sourceCursor) throw fail();
    const rowBytes = new TextEncoder().encode(next.rowJson).length;
    if (rows.length >= remainingRows || bytes + rowBytes > remainingBytes) return null;
    rows.push(next.rowJson);
    bytes += rowBytes;
    sourceCursor = next.nextCursor;
  }
}

async function transformRows(
  context: TenantBackupStepContext,
  source: Source,
  rows: readonly string[],
  mode: 'write' | 'verify'
): Promise<string[]> {
  if (!source.policy.restoreTransform) return [...rows];
  const transformed: string[] = [];
  for (const row of rows) {
    const value = await source.policy.restoreTransform.transform(context, row, mode);
    if (!value || new TextEncoder().encode(value).length > 16 * 1024 * 1024) throw fail();
    transformed.push(value);
  }
  return transformed;
}

async function runDatasetExecutionBatch(
  context: TenantBackupStepContext,
  input: Parameters<typeof runSqliteRestoreSequenceStep>[1],
  loaded: Source,
  job: Job,
  phase: 'apply_sqlite_dataset' | 'apply_sqlite_dataset_deferred' | 'verify_sqlite_dataset',
  cursor: string
): Promise<TenantBackupStepResult> {
  let currentPhase = phase;
  let currentCursor = cursor;
  // A capacity-sized write, deferred-reference pass and readback belong to one dataset execution
  // batch. Persist only when that capacity is exhausted or the whole dataset is complete.
  for (let transition = 0; transition < 3; transition++) {
    const run =
      currentPhase === 'apply_sqlite_dataset'
        ? runSqliteRestoreDatasetStep
        : currentPhase === 'apply_sqlite_dataset_deferred'
          ? runSqliteRestoreDatasetDeferredStep
          : runSqliteRestoreDatasetVerificationStep;
    const result = await run(
      {
        ...context,
        operation: {
          ...context.operation,
          phase: currentPhase,
          cursor_json: currentCursor,
        },
      },
      {
        ...input,
        ...loaded,
        targetId: job.targetId,
        ordinal: job.targetOrdinal,
      }
    );
    if (result.phase === 'advance_restore_dataset' || result.phase === currentPhase) return result;
    if (
      typeof result.cursor !== 'string' ||
      !(
        (currentPhase === 'apply_sqlite_dataset' &&
          ['apply_sqlite_dataset_deferred', 'verify_sqlite_dataset'].includes(result.phase)) ||
        (currentPhase === 'apply_sqlite_dataset_deferred' &&
          result.phase === 'verify_sqlite_dataset')
      )
    )
      throw fail();
    currentPhase = result.phase as typeof currentPhase;
    currentCursor = result.cursor;
  }
  throw fail();
}

async function openRegisteredRestoreTargets(
  context: TenantBackupStepContext,
  input: Parameters<typeof runSqliteRestoreSequenceStep>[1],
  jobs: readonly Job[]
): Promise<void> {
  const targets = new Map<string, { targetId: string; targetOrdinal: number }>();
  for (const job of jobs) {
    const existing = targets.get(job.targetId);
    if (existing && existing.targetOrdinal !== job.targetOrdinal) throw fail();
    targets.set(job.targetId, {
      targetId: job.targetId,
      targetOrdinal: job.targetOrdinal,
    });
  }

  const pending = [...targets.values()];
  for (let offset = 0; offset < pending.length; offset += 4) {
    await Promise.all(
      pending.slice(offset, offset + 4).map((target) =>
        openPlannedSqliteRestoreTarget({
          ...input,
          context,
          targetId: target.targetId,
          ordinal: target.targetOrdinal,
          mode: 'write',
        })
      )
    );
  }
}

async function reconcileGeneratedRestoreRows(
  context: TenantBackupStepContext,
  input: Parameters<typeof runSqliteRestoreSequenceStep>[1],
  jobs: readonly Job[],
  planDigest: string
): Promise<void> {
  for (const job of jobs) {
    if (!job.reconcilesGeneratedRows) continue;
    const loaded = await input.loadValidatedDataset(structuredClone(job));
    if (loaded.policy.restoreReconcilesGeneratedRows !== true) continue;
    if (!loaded.policy.restoreHold || loaded.policy.restoreTransform) throw fail();
    const complete = await readCompleteDataset(loaded, job, planDigest, 500, EXECUTION_BATCH_BYTES);
    if (!complete || complete.rows.length !== job.recordCount) throw fail();
    const materialized: string[] = [];
    for (const rowJson of complete.rows) {
      if (!(await loaded.policy.restoreHold.shouldHold(context, rowJson)))
        materialized.push(rowJson);
    }
    const target = await openPlannedSqliteRestoreTarget({
      ...input,
      context,
      targetId: job.targetId,
      ordinal: job.targetOrdinal,
    });
    await target.reconcileGeneratedRows(loaded.policy, loaded.manifest, materialized);
  }
}

function isJob(value: unknown): value is Job {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  return (
    Object.keys(job).sort().join(',') ===
      'bundleId,byteCount,datasetId,manifestDigest,policyDigest,reconcilesGeneratedRows,recordCount,table,targetId,targetOrdinal' &&
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
    /^[a-f0-9]{64}$/.test(job.policyDigest) &&
    typeof job.recordCount === 'number' &&
    Number.isSafeInteger(job.recordCount) &&
    job.recordCount >= 0 &&
    typeof job.byteCount === 'number' &&
    Number.isSafeInteger(job.byteCount) &&
    job.byteCount >= 0 &&
    typeof job.reconcilesGeneratedRows === 'boolean' &&
    (job.recordCount === 0) === (job.byteCount === 0)
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
    decoded.version !== 2 ||
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
  for (let from = 0; from < head.item_count; ) {
    const rows = await inventory.readPage(from);
    if (!rows.length) throw fail();
    for (const row of rows) {
      if (row.item_id !== 'sqlite-restore-sequence') continue;
      if (sequence) throw fail();
      sequence = row;
    }
    from += rows.length;
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
  input: Pick<DatasetInput, 'targetId' | 'ordinal' | 'manifest' | 'policy'> & {
    recordCount: number;
    byteCount: number;
  },
  pinnedManifestDigest?: string
): Promise<Job> {
  const policy = input.policy;
  if (
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(input.targetId) ||
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 0 ||
    !Number.isSafeInteger(input.recordCount) ||
    input.recordCount < 0 ||
    !Number.isSafeInteger(input.byteCount) ||
    input.byteCount < 0 ||
    (input.recordCount === 0) !== (input.byteCount === 0) ||
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
    manifestDigest:
      pinnedManifestDigest ??
      (await hash(encodeTenantBundleManifest(input.manifest, input.manifest))),
    policyDigest: await hash(
      new TextEncoder().encode(JSON.stringify(sqliteDatasetInspectionPolicyDescriptor(policy)))
    ),
    recordCount: input.recordCount,
    byteCount: input.byteCount,
    reconcilesGeneratedRows: policy.restoreReconcilesGeneratedRows === true,
  };
}

function orderDatasets<T extends { targetId: string; policy: DatasetInput['policy'] }>(
  datasets: readonly T[]
): T[] {
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
    const previousTarget = ordered.at(-1)?.targetId;
    const preferredIndex = previousTarget
      ? ready.findIndex((id) => byDataset.get(id)?.dataset.targetId === previousTarget)
      : -1;
    const id = ready.splice(preferredIndex >= 0 ? preferredIndex : 0, 1)[0];
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
  datasets: readonly (Pick<DatasetInput, 'targetId' | 'ordinal' | 'manifest' | 'policy'> & {
    recordCount: number;
    byteCount: number;
  })[]
): Promise<void> {
  if (datasets.length > TENANT_BACKUP_MAX_SQLITE_DATASETS) throw fail();
  const pinned = orderDatasets(
    datasets.map((dataset) => ({
      ...dataset,
      manifest: structuredClone(dataset.manifest),
      policy: cloneSqliteDatasetInspectionPolicy(dataset.policy),
    }))
  );
  const manifestDigests = new Map<string, string>();
  const jobs: Job[] = [];
  for (const dataset of pinned) {
    let manifestDigest = manifestDigests.get(dataset.manifest.bundleId);
    if (!manifestDigest) {
      manifestDigest = await hash(encodeTenantBundleManifest(dataset.manifest, dataset.manifest));
      manifestDigests.set(dataset.manifest.bundleId, manifestDigest);
    }
    jobs.push(await descriptor(dataset, manifestDigest));
  }
  const jobsByBundle = new Map<string, Job[]>();
  for (const job of jobs) {
    const own = jobsByBundle.get(job.bundleId) ?? [];
    own.push(job);
    jobsByBundle.set(job.bundleId, own);
  }
  const checkedBundles = new Set<string>();
  for (const dataset of pinned) {
    const bundleId = dataset.manifest.bundleId;
    if (checkedBundles.has(bundleId)) continue;
    checkedBundles.add(bundleId);
    const own = jobsByBundle.get(bundleId) ?? [];
    const expected = dataset.manifest.datasets.filter(
      (value) => value.store === 'database' && value.disposition === 'include'
    );
    const counts = new Map<string, number>();
    for (const job of own) counts.set(job.datasetId, (counts.get(job.datasetId) ?? 0) + 1);
    if (
      !own.length ||
      own.some((job) => job.manifestDigest !== manifestDigests.get(bundleId)) ||
      expected.some((value) => counts.get(value.id) !== 1) ||
      own.length !== expected.length
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
    JSON.stringify({ version: 2, kind: 'sqlite-restore-sequence', jobs })
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
  const registeredJobs = decodeJobs(rows[0].payload_json);
  const jobs = registeredJobs.filter(({ recordCount }) => recordCount > 0);
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
    (cursor.datasetCursor !== null && typeof cursor.datasetCursor !== 'string') ||
    !('emptyPrepared' in cursor) ||
    typeof cursor.emptyPrepared !== 'boolean'
  )
    throw fail();
  await input.assertValidatedUnpublishedPlan(head.chain_digest);
  const starting = context.operation.phase === 'start_sqlite_restore_sequence';
  if (starting && !cursor.emptyPrepared) {
    if (cursor.jobIndex !== 0 || cursor.datasetCursor !== null) throw fail();
    // The sealed plan already authenticates every registered dataset descriptor, including its
    // zero count and zero byte length. Open each physical target once to pin its seed fingerprint
    // and unpublished lease; do not reload policies or query one destination table per empty item.
    await openRegisteredRestoreTargets(context, input, registeredJobs);
    return {
      phase: 'start_sqlite_restore_sequence',
      cursor: JSON.stringify({
        version: 1,
        sequenceOrdinal: input.sequenceOrdinal,
        jobIndex: 0,
        datasetCursor: null,
        completedRows: [],
        emptyPrepared: true,
      }),
      disposition: 'continue',
    };
  }
  if (!cursor.emptyPrepared) throw fail();
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
      registeredJobs,
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
      result.rowsWritten > jobs[index].recordCount ||
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
    if (result.rowsWritten !== jobs[index].recordCount) {
      const held = await input.loadValidatedDataset(structuredClone(jobs[index]));
      const actual = await descriptor({
        ...held,
        targetId: jobs[index].targetId,
        ordinal: jobs[index].targetOrdinal,
        recordCount: jobs[index].recordCount,
        byteCount: jobs[index].byteCount,
      });
      if (JSON.stringify(actual) !== JSON.stringify(jobs[index]) || !held.policy.restoreHold)
        throw fail();
    }
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
      emptyPrepared: true,
    });
  }
  if (index === jobs.length) {
    if (!starting && context.operation.phase !== 'advance_restore_dataset') throw fail();
    await reconcileGeneratedRestoreRows(context, input, registeredJobs, head.chain_digest);
    return { phase: 'restore_other_stores', cursor: envelope(null), disposition: 'continue' };
  }
  let job = jobs[index];
  if (datasetCursor === null) {
    const batch: { job: Job; loaded: Source; rows: string[]; bytes: number }[] = [];
    let batchRows = 0;
    let batchBytes = 0;
    for (let candidateIndex = index; candidateIndex < jobs.length; candidateIndex++) {
      const candidate = jobs[candidateIndex];
      if (batch.length && candidate.targetId !== batch[0].job.targetId) break;
      const loaded = await input.loadValidatedDataset(structuredClone(candidate));
      const actual = await descriptor({
        ...loaded,
        targetId: candidate.targetId,
        ordinal: candidate.targetOrdinal,
        recordCount: candidate.recordCount,
        byteCount: candidate.byteCount,
      });
      if (JSON.stringify(actual) !== JSON.stringify(candidate)) throw fail();
      const complete = await readCompleteDataset(
        loaded,
        candidate,
        head.chain_digest,
        EXECUTION_BATCH_ROWS - batchRows,
        EXECUTION_BATCH_BYTES - batchBytes
      );
      if (
        !complete ||
        complete.rows.length !== candidate.recordCount ||
        (complete.rows.length && !canShareExecutionBatch(loaded.policy))
      )
        break;
      batch.push({ job: candidate, loaded, ...complete });
      batchRows += complete.rows.length;
      batchBytes += complete.bytes;
    }
    if (batch.length) {
      await input.inventory.headForLease(context.lease);
      await input.assertValidatedUnpublishedPlan(head.chain_digest);
      const writableEmpty = batch.filter(
        ({ loaded, rows }) =>
          rows.length === 0 && loaded.policy.restoreDisposition !== 'reference_only'
      );
      const writableRows = batch.filter(({ rows }) => rows.length > 0);
      if (writableEmpty.length || writableRows.length) {
        const target = await openPlannedSqliteRestoreTarget({
          ...input,
          context,
          targetId: batch[0].job.targetId,
          ordinal: batch[0].job.targetOrdinal,
        });
        if (writableEmpty.length)
          await target.verifyEmptyDatasets(writableEmpty.map(({ loaded }) => loaded.policy));
        if (writableRows.length) {
          const preparedRows = await Promise.all(
            writableRows.map(async ({ loaded, rows }) => ({
              policy: loaded.policy,
              manifest: loaded.manifest,
              rowJsons: await transformRows(context, loaded, rows, 'write'),
            }))
          );
          await target.writeDatasetRows(preparedRows);
          for (const { loaded, rows } of writableRows) {
            await target.verifyDataset(loaded.policy, rows.length);
          }
        }
      }
      completedRows.push(...batch.map(({ rows }) => rows.length));
      index += batch.length;
      datasetCursor = null;
      if (index === jobs.length) {
        await reconcileGeneratedRestoreRows(context, input, registeredJobs, head.chain_digest);
        return { phase: 'restore_other_stores', cursor: envelope(null), disposition: 'continue' };
      }
      job = jobs[index];
    }
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
    recordCount: job.recordCount,
    byteCount: job.byteCount,
  });
  if (JSON.stringify(actual) !== JSON.stringify(job)) throw fail();
  await input.inventory.headForLease(context.lease);
  const phase = context.operation.phase as
    | 'apply_sqlite_dataset'
    | 'apply_sqlite_dataset_deferred'
    | 'verify_sqlite_dataset';
  const result = await runDatasetExecutionBatch(context, input, loaded, job, phase, datasetCursor);
  return { ...result, cursor: envelope(result.cursor) };
}

async function finalizeSqliteTargets(
  context: TenantBackupStepContext,
  input: Parameters<typeof runSqliteRestoreSequenceStep>[1],
  registeredJobs: Job[],
  jobs: Job[],
  cursor: object & { jobIndex: number; datasetCursor: string | null },
  completedRows: number[]
): Promise<TenantBackupStepResult> {
  if (cursor.jobIndex !== jobs.length) throw fail();
  const targets = [
    ...new Map(
      registeredJobs.map((job) => [
        job.targetId,
        { targetId: job.targetId, ordinal: job.targetOrdinal },
      ])
    ).values(),
  ];
  const sealIndex = 'sealIndex' in cursor ? cursor.sealIndex : 0;
  let verifyIndex = 'verifyIndex' in cursor ? cursor.verifyIndex : 0;
  const emptyVerified = 'emptyVerified' in cursor ? cursor.emptyVerified : false;
  if (
    typeof sealIndex !== 'number' ||
    !Number.isSafeInteger(sealIndex) ||
    sealIndex < 0 ||
    sealIndex > targets.length ||
    typeof verifyIndex !== 'number' ||
    !Number.isSafeInteger(verifyIndex) ||
    verifyIndex < 0 ||
    verifyIndex > jobs.length ||
    typeof emptyVerified !== 'boolean'
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
      emptyPrepared: true,
      emptyVerified,
    });
  }
  if (context.operation.phase === 'verify_restore_targets') {
    if (verifyIndex !== 0 || cursor.datasetCursor !== null) throw fail();
    if (sealIndex < targets.length) {
      const batch = targets.slice(sealIndex, sealIndex + 4);
      await Promise.all(
        batch.map(async (descriptor) => {
          const target = await openPlannedSqliteRestoreTarget({
            ...input,
            context,
            ...descriptor,
            mode: 'seal',
          });
          await target.seal();
        })
      );
      return {
        phase: 'verify_restore_targets',
        cursor: state(sealIndex + batch.length, null),
        disposition: 'continue',
      };
    }
    return {
      phase: 'verify_sealed_sqlite_datasets',
      cursor: JSON.stringify({
        version: 1,
        sequenceOrdinal: input.sequenceOrdinal,
        jobIndex: jobs.length,
        datasetCursor: null,
        completedRows,
        sealIndex,
        verifyIndex: 0,
        emptyPrepared: true,
        emptyVerified: false,
      }),
      disposition: 'continue',
    };
  }
  if (sealIndex !== targets.length) throw fail();
  if (!emptyVerified) {
    return {
      phase: 'verify_sealed_sqlite_datasets',
      cursor: JSON.stringify({
        version: 1,
        sequenceOrdinal: input.sequenceOrdinal,
        jobIndex: jobs.length,
        datasetCursor: null,
        completedRows,
        sealIndex,
        verifyIndex,
        emptyPrepared: true,
        emptyVerified: true,
      }),
      disposition: 'continue',
    };
  }
  if (verifyIndex === jobs.length) {
    if (cursor.datasetCursor !== null) throw fail();
    return {
      phase: 'verify_other_restore_stores',
      cursor: state(sealIndex, null),
      disposition: 'continue',
    };
  }
  if (cursor.datasetCursor === null) {
    const targetId = jobs[verifyIndex].targetId;
    const empty: { job: Job; loaded: Source }[] = [];
    while (
      verifyIndex + empty.length < jobs.length &&
      jobs[verifyIndex + empty.length].targetId === targetId &&
      completedRows[verifyIndex + empty.length] === 0
    ) {
      const candidate = jobs[verifyIndex + empty.length];
      const loaded = await input.loadValidatedDataset(structuredClone(candidate));
      if (
        JSON.stringify(
          await descriptor({
            ...loaded,
            targetId: candidate.targetId,
            ordinal: candidate.targetOrdinal,
            recordCount: candidate.recordCount,
            byteCount: candidate.byteCount,
          })
        ) !== JSON.stringify(candidate)
      )
        throw fail();
      empty.push({ job: candidate, loaded });
    }
    if (empty.length) {
      const writable = empty.filter(
        ({ loaded }) => loaded.policy.restoreDisposition !== 'reference_only'
      );
      if (writable.length) {
        const target = await openPlannedSqliteRestoreTarget({
          ...input,
          context,
          targetId: writable[0].job.targetId,
          ordinal: writable[0].job.targetOrdinal,
          mode: 'verify',
        });
        await target.verifyEmptyDatasets(writable.map(({ loaded }) => loaded.policy));
      }
      verifyIndex += empty.length;
      return {
        phase: 'verify_sealed_sqlite_datasets',
        cursor: state(sealIndex, null),
        disposition: 'continue',
      };
    }

    const batch: { job: Job; loaded: Source; rows: string[] }[] = [];
    let batchRows = 0;
    let batchBytes = 0;
    const verificationHead = await input.inventory.headForLease(context.lease);
    for (let candidateIndex = verifyIndex; candidateIndex < jobs.length; candidateIndex++) {
      const candidate = jobs[candidateIndex];
      if (candidate.targetId !== targetId || completedRows[candidateIndex] === 0) break;
      const loaded = await input.loadValidatedDataset(structuredClone(candidate));
      if (!canShareVerificationBatch(loaded.policy)) break;
      if (
        JSON.stringify(
          await descriptor({
            ...loaded,
            targetId: candidate.targetId,
            ordinal: candidate.targetOrdinal,
            recordCount: candidate.recordCount,
            byteCount: candidate.byteCount,
          })
        ) !== JSON.stringify(candidate)
      )
        throw fail();
      const complete = await readCompleteDataset(
        loaded,
        candidate,
        verificationHead.chain_digest,
        EXECUTION_BATCH_ROWS - batchRows,
        EXECUTION_BATCH_BYTES - batchBytes
      );
      if (!complete || complete.rows.length !== completedRows[candidateIndex]) break;
      batch.push({ job: candidate, loaded, rows: complete.rows });
      batchRows += complete.rows.length;
      batchBytes += complete.bytes;
    }
    if (batch.length) {
      const target = await openPlannedSqliteRestoreTarget({
        ...input,
        context,
        targetId: batch[0].job.targetId,
        ordinal: batch[0].job.targetOrdinal,
        mode: 'verify',
      });
      for (const { loaded, rows } of batch) {
        await target.verifyRows(
          loaded.policy,
          loaded.manifest,
          await transformRows(context, loaded, rows, 'verify')
        );
        await target.verifyDataset(loaded.policy, rows.length);
      }
      verifyIndex += batch.length;
      return {
        phase: 'verify_sealed_sqlite_datasets',
        cursor: state(sealIndex, null),
        disposition: 'continue',
      };
    }
  }
  const job = jobs[verifyIndex];
  const loaded = await input.loadValidatedDataset(structuredClone(job));
  if (
    JSON.stringify(
      await descriptor({
        ...loaded,
        targetId: job.targetId,
        ordinal: job.targetOrdinal,
        recordCount: job.recordCount,
        byteCount: job.byteCount,
      })
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
  let verificationCursor = inner;
  for (let page = 0; page < 8; page++) {
    const result = await runSqliteRestoreDatasetVerificationStep(
      {
        ...context,
        operation: {
          ...context.operation,
          phase: 'verify_sqlite_dataset',
          cursor_json: verificationCursor,
        },
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
    if (result.phase !== 'verify_sqlite_dataset' || typeof result.cursor !== 'string') throw fail();
    verificationCursor = result.cursor;
  }
  return {
    phase: 'verify_sealed_sqlite_datasets',
    cursor: state(sealIndex, verificationCursor),
    disposition: 'continue',
  };
}
