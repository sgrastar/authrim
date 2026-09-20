import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBundleManifestExpectation } from './bundle-manifest';
import {
  finalizeSqliteDatasetBatchInspections,
  finalizeSqliteDatasetInspection,
} from './dataset-inspection-receipt';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import { finalizeTenantBackupInputValidation } from './finalize-input-validation';
import { loadPlannedTenantBackupInput } from './input-plan';
import { readTenantBackupContainerV2Input } from './input-container-v2';
import { readNextTenantBackupContainerRow } from './container-dataset-reader';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector';
import { runSqliteInputValidationStep } from './validate-sqlite-input-step';
import { runTenantBackupReferenceValidationStep } from './validate-references-step';
import { DatabaseTenantBundleReferenceIndex } from './validation-index';
import { inspectSqliteInputRow } from './sqlite-input-inspection';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute' | 'batch'>;
interface PositionCursor {
  version: 1;
  sessionId: string;
  inputOrdinal: number;
  datasetIndex: number;
}
interface DatasetCursor extends PositionCursor {
  datasetCursor: string;
}
interface LoadedInput {
  expected: TenantBundleManifestExpectation;
  session: TenantBundleKeyEnvelope;
  loadPolicy(datasetId: string): Promise<SqliteDatasetInspectionPolicy>;
  loadPolicies?(): Promise<readonly SqliteDatasetInspectionPolicy[]>;
  loadDataset?(datasetId: string): Promise<Uint8Array>;
  assertAuthorized(): Promise<void>;
}

function fail(): never {
  throw new Error('backup_input_validation_sequence_invalid');
}
const VALIDATION_BATCH_ROWS = 250;
const VALIDATION_BATCH_BYTES = 4 * 1024 * 1024;
function position(raw: string | null): PositionCursor {
  let value: PositionCursor;
  try {
    value = JSON.parse(raw ?? 'null') as PositionCursor;
  } catch {
    return fail();
  }
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'datasetIndex,inputOrdinal,sessionId,version' ||
    value.version !== 1 ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.sessionId) ||
    !Number.isSafeInteger(value.inputOrdinal) ||
    value.inputOrdinal < 0 ||
    value.inputOrdinal > 32 ||
    !Number.isSafeInteger(value.datasetIndex) ||
    value.datasetIndex < 0 ||
    value.datasetIndex > 4096
  )
    fail();
  return value;
}
function datasetPosition(raw: string | null): DatasetCursor {
  let value: DatasetCursor;
  try {
    value = JSON.parse(raw ?? 'null') as DatasetCursor;
  } catch {
    return fail();
  }
  if (
    !value ||
    Object.keys(value).sort().join(',') !==
      'datasetCursor,datasetIndex,inputOrdinal,sessionId,version' ||
    typeof value.datasetCursor !== 'string' ||
    !value.datasetCursor ||
    value.datasetCursor.length > 4096
  )
    fail();
  position(
    JSON.stringify({
      version: value.version,
      sessionId: value.sessionId,
      inputOrdinal: value.inputOrdinal,
      datasetIndex: value.datasetIndex,
    })
  );
  return value;
}

/**
 * Validate one SQL row or one durable transition per scheduler slice. The sealed input inventory
 * fixes input order; installed code supplies the expected manifest and row policy on every retry.
 */
export async function runTenantBackupSqliteInputValidationSequenceStep(
  context: TenantBackupStepContext,
  input: {
    database: Database;
    bucket: Parameters<typeof readTenantBackupContainerV2Input>[0]['bucket'];
    inventory: TenantBackupExecutionInventory;
    now: () => number;
    loadInput(ordinal: number, bundleId: string): Promise<LoadedInput>;
    ownsDataset?(ordinal: number, bundleId: string, datasetId: string): Promise<boolean>;
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'import' ||
    operation.state !== 'running' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    ![
      'validate_input_modules',
      'validate_sqlite_dataset',
      'advance_validation_dataset',
      'validate_input_references',
      'finalize_input_validation',
    ].includes(operation.phase)
  )
    fail();
  signal.throwIfAborted();
  const head = await input.inventory.headForLease(lease);
  if (head.state !== 'sealed' || head.item_count < 1 || head.item_count > 32) fail();

  if (operation.phase === 'validate_input_references') {
    const raw = JSON.parse(operation.cursor_json ?? 'null') as {
      sessionId?: unknown;
      inputSetDigest?: unknown;
    } | null;
    if (!raw || raw.inputSetDigest !== head.chain_digest || typeof raw.sessionId !== 'string')
      fail();
    return runTenantBackupReferenceValidationStep(context, {
      database: input.database,
      now: input.now,
      sessionId: raw.sessionId,
      inputSetDigest: head.chain_digest,
      assertCompleteInputInspection: async (digest, sessionId) => {
        signal.throwIfAborted();
        const current = await input.inventory.headForLease(lease);
        if (
          current.state !== 'sealed' ||
          current.chain_digest !== digest ||
          sessionId !== raw.sessionId
        )
          fail();
      },
    });
  }
  if (operation.phase === 'finalize_input_validation') {
    await finalizeTenantBackupInputValidation(context, {
      database: input.database,
      inventory: input.inventory,
      now: input.now,
    });
    const raw = JSON.parse(operation.cursor_json ?? 'null') as { sessionId?: unknown } | null;
    if (!raw || typeof raw.sessionId !== 'string') fail();
    return {
      phase: 'prepare_restore_plan',
      cursor: JSON.stringify({
        version: 1,
        sessionId: raw.sessionId,
        inputSetDigest: head.chain_digest,
      }),
      disposition: 'continue',
    };
  }

  const outer =
    operation.phase === 'validate_input_modules'
      ? position(operation.cursor_json)
      : datasetPosition(operation.cursor_json);
  if (outer.inputOrdinal >= head.item_count) fail();
  const rows = await input.inventory.readPage(outer.inputOrdinal);
  const saved = rows[0];
  const prefix = 'backup-input:';
  const bundleId = saved?.item_id.startsWith(prefix) ? saved.item_id.slice(prefix.length) : '';
  if (!saved || saved.ordinal !== outer.inputOrdinal || !/^[a-f0-9]{32}$/.test(bundleId)) fail();
  const loaded = await input.loadInput(outer.inputOrdinal, bundleId);
  if (loaded.expected.bundleId !== bundleId) fail();
  const planned = await loadPlannedTenantBackupInput(
    context,
    input.inventory,
    outer.inputOrdinal,
    loaded.expected
  );
  if (outer.datasetIndex > planned.manifest.datasets.length) fail();
  const authorize = async () => {
    signal.throwIfAborted();
    await loaded.assertAuthorized();
    const current = await input.inventory.headForLease(lease);
    if (current.state !== 'sealed' || current.chain_digest !== head.chain_digest) fail();
    signal.throwIfAborted();
  };
  await authorize();

  if (operation.phase === 'validate_input_modules') {
    if (outer.datasetIndex === planned.manifest.datasets.length) {
      const nextInput = outer.inputOrdinal + 1;
      if (nextInput < head.item_count)
        return {
          phase: 'validate_input_modules',
          cursor: JSON.stringify({ ...outer, inputOrdinal: nextInput, datasetIndex: 0 }),
          disposition: 'continue',
        };
      return {
        phase: 'validate_input_references',
        cursor: JSON.stringify({
          version: 1,
          sessionId: outer.sessionId,
          inputSetDigest: head.chain_digest,
          after: '',
          examined: 0,
          unresolvedProvenance: 0,
        }),
        disposition: 'continue',
      };
    }
    const dataset = planned.manifest.datasets[outer.datasetIndex];
    if (
      !['database', 'kv', 'durable_object', 'object'].includes(dataset.store) ||
      dataset.disposition !== 'include'
    )
      fail();
    const installedPolicies = loaded.loadPolicies ? await loaded.loadPolicies() : null;
    const policiesById = installedPolicies
      ? new Map(installedPolicies.map((policy) => [policy.dataset.id, policy]))
      : null;
    const batch: { policy: SqliteDatasetInspectionPolicy; recordCount: number }[] = [];
    const batchRecords: {
      bundleId: string;
      sourceId: string;
      record: Parameters<DatabaseTenantBundleReferenceIndex['recordOnce']>[2];
    }[] = [];
    const batchReferences: {
      bundleId: string;
      sourceEdgeId: string;
      dependency: Parameters<DatabaseTenantBundleReferenceIndex['referenceOnce']>[2];
    }[] = [];
    let nextDatasetIndex = outer.datasetIndex;
    let batchRows = 0;
    let batchBytes = 0;
    const index =
      loaded.loadDataset && loaded.loadPolicies
        ? await DatabaseTenantBundleReferenceIndex.resume(
            input.database,
            outer.sessionId,
            lease,
            input.now
          )
        : null;
    if (loaded.loadDataset && loaded.loadPolicies && !index) fail();
    while (
      loaded.loadDataset &&
      loaded.loadPolicies &&
      nextDatasetIndex < planned.manifest.datasets.length &&
      batch.length < 256
    ) {
      const candidate = planned.manifest.datasets[nextDatasetIndex];
      if (
        head.item_count !== 1 &&
        input.ownsDataset &&
        !(await input.ownsDataset(outer.inputOrdinal, bundleId, candidate.id))
      )
        break;
      const bytes = await loaded.loadDataset(candidate.id);
      if (!(bytes instanceof Uint8Array) || batchBytes + bytes.length > VALIDATION_BATCH_BYTES)
        break;
      const candidatePolicy =
        policiesById?.get(candidate.id) ?? (await loaded.loadPolicy(candidate.id));
      if (candidatePolicy.dataset.id !== candidate.id) fail();
      let cursor: string | null = null;
      const rows: string[] = [];
      for (;;) {
        const row = readNextTenantBackupContainerRow(bytes, cursor);
        if (!row) break;
        rows.push(row.rowJson);
        if (batchRows + rows.length > VALIDATION_BATCH_ROWS) break;
        cursor = row.nextCursor;
      }
      if (batchRows + rows.length > VALIDATION_BATCH_ROWS) break;
      const activeIndex = index;
      if (!activeIndex) fail();
      for (let rowOrdinal = 0; rowOrdinal < rows.length; rowOrdinal++) {
        await inspectSqliteInputRow({
          policy: candidatePolicy,
          manifest: planned.manifest,
          rowJson: rows[rowOrdinal],
          rowOrdinal,
          index: {
            async recordOnce(recordBundleId, sourceId, record) {
              batchRecords.push({ bundleId: recordBundleId, sourceId, record });
              return true;
            },
            async referenceOnce(referenceBundleId, sourceEdgeId, dependency) {
              batchReferences.push({
                bundleId: referenceBundleId,
                sourceEdgeId,
                dependency,
              });
            },
          },
          assertPinnedInput: async () => {},
        });
      }
      batch.push({ policy: candidatePolicy, recordCount: rows.length });
      batchRows += rows.length;
      batchBytes += bytes.length;
      nextDatasetIndex++;
    }
    if (batch.length) {
      if (!index) fail();
      await index.recordInspectionBatch({ records: batchRecords, references: batchReferences });
      await finalizeSqliteDatasetBatchInspections(context, {
        database: input.database,
        manifest: planned.manifest,
        datasets: batch,
        sessionId: outer.sessionId,
        now: input.now,
        assertPinnedInput: authorize,
        operationCursorGuard: operation.cursor_json ?? '',
      });
      return {
        phase: 'validate_input_modules',
        cursor: JSON.stringify({ ...outer, datasetIndex: nextDatasetIndex }),
        disposition: 'continue',
      };
    }
    if (input.ownsDataset && !(await input.ownsDataset(outer.inputOrdinal, bundleId, dataset.id)))
      return {
        phase: 'validate_input_modules',
        cursor: JSON.stringify({ ...outer, datasetIndex: outer.datasetIndex + 1 }),
        disposition: 'continue',
      };
    const policy = await loaded.loadPolicy(dataset.id);
    if (policy.dataset.id !== dataset.id) fail();
    await authorize();
    return {
      phase: 'validate_sqlite_dataset',
      cursor: JSON.stringify({
        ...outer,
        datasetCursor: JSON.stringify({
          version: 1,
          sessionId: outer.sessionId,
          bundleId,
          datasetId: dataset.id,
          sourceCursor: null,
          rows: 0,
        }),
      }),
      disposition: 'continue',
    };
  }

  const active = outer as DatasetCursor;
  const dataset = planned.manifest.datasets[active.datasetIndex];
  if (
    !dataset ||
    !['database', 'kv', 'durable_object', 'object'].includes(dataset.store) ||
    dataset.disposition !== 'include'
  )
    fail();
  if (input.ownsDataset && !(await input.ownsDataset(active.inputOrdinal, bundleId, dataset.id)))
    fail();
  const policy = await loaded.loadPolicy(dataset.id);
  if (policy.dataset.id !== dataset.id) fail();
  const datasetBytes = loaded.loadDataset
    ? await loaded.loadDataset(dataset.id)
    : (
        await readTenantBackupContainerV2Input({
          bucket: input.bucket,
          identity: planned.identity,
          session: loaded.session,
          signal,
          assertAuthorized: authorize,
        })
      ).datasets.get(dataset.id);
  if (!(datasetBytes instanceof Uint8Array)) fail();
  const innerContext = {
    ...context,
    operation: { ...operation, cursor_json: active.datasetCursor },
  };
  if (operation.phase === 'validate_sqlite_dataset') {
    const result = await runSqliteInputValidationStep(innerContext, {
      database: input.database,
      now: input.now,
      sessionId: active.sessionId,
      policy,
      manifest: planned.manifest,
      assertPinnedInput: authorize,
      readNextRow: async (sourceCursor) =>
        readNextTenantBackupContainerRow(datasetBytes, sourceCursor),
    });
    if (!['validate_sqlite_dataset', 'advance_validation_dataset'].includes(result.phase)) fail();
    return {
      ...result,
      cursor: JSON.stringify({ ...active, datasetCursor: result.cursor }),
    };
  }
  await finalizeSqliteDatasetInspection(innerContext, {
    database: input.database,
    manifest: planned.manifest,
    policy,
    now: input.now,
    assertPinnedInput: authorize,
    operationCursorGuard: operation.cursor_json ?? '',
  });
  await authorize();
  return {
    phase: 'validate_input_modules',
    cursor: JSON.stringify({
      version: 1,
      sessionId: active.sessionId,
      inputOrdinal: active.inputOrdinal,
      datasetIndex: active.datasetIndex + 1,
    }),
    disposition: 'continue',
  };
}
