import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBundleManifestExpectation } from './bundle-manifest';
import { finalizeSqliteDatasetInspection } from './dataset-inspection-receipt';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import { finalizeTenantBackupInputValidation } from './finalize-input-validation';
import { TenantBackupInputReceipts } from './input-receipts';
import { loadPlannedTenantBackupInput } from './input-plan';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector';
import { readNextSqliteInputRow } from './sqlite-input-row-source';
import { runSqliteInputValidationStep } from './validate-sqlite-input-step';
import { runTenantBackupReferenceValidationStep } from './validate-references-step';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
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
  assertAuthorized(): Promise<void>;
}

function fail(): never {
  throw new Error('backup_input_validation_sequence_invalid');
}
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
    bucket: Parameters<typeof readNextSqliteInputRow>[0]['replayInput']['bucket'];
    inventory: TenantBackupExecutionInventory;
    now: () => number;
    loadInput(ordinal: number, bundleId: string): Promise<LoadedInput>;
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
    if (dataset.store !== 'database' || dataset.disposition !== 'include') fail();
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
  if (!dataset || dataset.store !== 'database' || dataset.disposition !== 'include') fail();
  const policy = await loaded.loadPolicy(dataset.id);
  if (policy.dataset.id !== dataset.id) fail();
  const replayInput = {
    ...planned,
    expected: loaded.expected,
    session: loaded.session,
    bucket: input.bucket,
    signal,
    assertAuthorized: authorize,
  };
  const receipts = new TenantBackupInputReceipts(input.database, lease, input.now);
  const firstSequence = await receipts.datasetStart(bundleId, dataset.id, replayInput);
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
      readNextRow: (sourceCursor) =>
        readNextSqliteInputRow({
          receipts,
          replayInput,
          datasetId: dataset.id,
          firstSequence,
          sourceCursor,
          planDigest: head.chain_digest,
          assertValidatedPlan: async (digest, expectedBundle, expectedDataset) => {
            if (
              digest !== head.chain_digest ||
              expectedBundle !== bundleId ||
              expectedDataset !== dataset.id
            )
              fail();
            await authorize();
          },
        }),
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
