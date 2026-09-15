import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { TenantBackupExecutionInventory } from '@authrim/ar-lib-core/services/tenant-portability/execution-inventory';
import { TenantBackupImportRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/import-request';
import { TenantBackupInputReceipts } from '@authrim/ar-lib-core/services/tenant-portability/input-receipts';
import {
  loadPlannedTenantBackupInput,
  loadPlannedTenantBackupInputs,
  tenantBackupInputDatasetOwners,
} from '@authrim/ar-lib-core/services/tenant-portability/input-plan';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { DatabaseTenantBackupRestorePlanInventory } from '@authrim/ar-lib-core/services/tenant-portability/restore-plan-inventory';
import type { TenantBackupSelection } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import type { Phase8ValidatedSqliteRestoreDataset } from '@authrim/ar-lib-core/services/tenant-portability/phase8-restore-targets';
import { readNextSqliteInputRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-input-row-source';
import type { SqliteDatasetInspectionPolicy } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { TenantBackupInstalledImportAdapter } from './tenant-backup-import-dispatcher';
import { getCanonicalTenantBaseUrlAsync } from './request-issuer';
import { getTenantBackupKeyStore } from './tenant-backup-services';
import { version as productVersion } from '../package.json';

type RestoreJob = Parameters<TenantBackupInstalledImportAdapter['loadValidatedDataset']>[1];
type LoadedDataset = Awaited<
  ReturnType<TenantBackupInstalledImportAdapter['loadValidatedDataset']>
>;

export interface TenantBackupValidatedInputPortOptions {
  env: Env;
  datasets(selection: TenantBackupSelection): readonly TenantPortableDataset[];
  loadPolicy(
    context: TenantBackupStepContext,
    datasetId: string
  ): Promise<SqliteDatasetInspectionPolicy>;
  assertSources(context: TenantBackupStepContext): Promise<void>;
  /** Recheck that every pinned physical restore target is still isolated from runtime routing. */
  assertUnpublishedTarget(context: TenantBackupStepContext, planDigest: string): Promise<void>;
  now?: () => number;
}

export type TenantBackupValidatedInputPorts = Pick<
  TenantBackupInstalledImportAdapter,
  'loadValidatedDataset' | 'assertValidatedUnpublishedPlan'
> & {
  loadValidatedSqliteDatasets(
    context: TenantBackupStepContext
  ): Promise<readonly Phase8ValidatedSqliteRestoreDataset[]>;
};

function invalid(): never {
  throw new Error('backup_validated_input_invalid');
}

function validateDatasets(datasets: readonly TenantPortableDataset[]): TenantPortableDataset[] {
  const result = datasets.map((dataset) => structuredClone(dataset));
  if (
    result.length < 1 ||
    result.length > 4096 ||
    new Set(result.map(({ id }) => id)).size !== result.length ||
    result.some(
      ({ id, disposition }) => !/^[A-Za-z0-9_.:-]{1,256}$/u.test(id) || disposition !== 'include'
    )
  )
    invalid();
  return result;
}

function sameDataset(left: TenantPortableDataset, right: TenantPortableDataset): boolean {
  return (
    left.id === right.id &&
    left.module === right.module &&
    left.kind === right.kind &&
    left.store === right.store &&
    left.schemaVersion === right.schemaVersion &&
    left.disposition === right.disposition
  );
}

function validateJob(job: RestoreJob): void {
  if (
    !job ||
    typeof job !== 'object' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/u.test(job.datasetId) ||
    !/^[a-f0-9]{32}$/u.test(job.bundleId) ||
    !/^[a-f0-9]{64}$/u.test(job.manifestDigest) ||
    !/^[a-f0-9]{64}$/u.test(job.policyDigest) ||
    !job.table ||
    job.table.length > 256
  )
    invalid();
}

/**
 * Reopen one already validated encrypted input without staging plaintext. Every read is bound to
 * the live operation lease, accepted input key, sealed validation, installed policy and restore
 * plan digest. Uploaded metadata never selects a policy or target.
 */
export function createTenantBackupValidatedInputPorts(
  options: TenantBackupValidatedInputPortOptions
): TenantBackupValidatedInputPorts {
  const now = options.now ?? Date.now;
  const database = requireDedicatedAdminDatabaseAdapter(options.env, 'tenant-backup');
  const requestStore = new TenantBackupImportRequestStore(database);

  async function loadCurrent(context: TenantBackupStepContext) {
    context.signal.throwIfAborted();
    if (!options.env.IMPORT_ARTIFACTS) invalid();
    const request = await requestStore.loadForExecution(context, now);
    if (
      request.intent.source.productVersion !== productVersion ||
      request.intent.source.issuer !==
        (await getCanonicalTenantBaseUrlAsync(options.env, context.lease.tenantId))
    )
      invalid();
    const keyStore = await getTenantBackupKeyStore(options.env);
    if (!keyStore) invalid();
    const keys = await keyStore.loadActiveInputs(context.lease, now);
    if (
      keys.length !== request.inputs.length ||
      keys.some((key, ordinal) => key.inputId !== request.inputs[ordinal]?.inputId)
    )
      invalid();
    const datasets = validateDatasets(options.datasets(request.intent.selection));
    await options.assertSources(context);
    await requestStore.loadForExecution(context, now);
    context.signal.throwIfAborted();
    return { request, keys, datasets, bucket: options.env.IMPORT_ARTIFACTS };
  }

  async function assertPlan(context: TenantBackupStepContext, planDigest: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(planDigest)) invalid();
    const execution = new TenantBackupExecutionInventory(database, context.lease, now);
    await execution.assertInputValidated(context.lease);
    const restore = new DatabaseTenantBackupRestorePlanInventory(database, context.lease, now);
    const head = await restore.headForLease(context.lease);
    if (head.state !== 'sealed' || head.chain_digest !== planDigest) invalid();
    await restore.assertInputValidated(context.lease);
    await loadCurrent(context);
    await options.assertUnpublishedTarget(context, planDigest);
    await loadCurrent(context);
    await options.assertUnpublishedTarget(context, planDigest);
  }

  return {
    async assertValidatedUnpublishedPlan(context, planDigest) {
      await assertPlan(context, planDigest);
    },

    async loadValidatedDataset(context, job): Promise<LoadedDataset> {
      validateJob(job);
      const current = await loadCurrent(context);
      const execution = new TenantBackupExecutionInventory(database, context.lease, now);
      const head = await execution.headForLease(context.lease);
      if (head.state !== 'sealed') invalid();
      await execution.assertInputValidated(context.lease);
      let inputOrdinal = -1;
      for (let from = 0; from < head.item_count; from += 16) {
        const page = await execution.readPage(from);
        const matching = page.filter(({ item_id }) => item_id === `backup-input:${job.bundleId}`);
        if (matching.length > 1 || (matching.length === 1 && inputOrdinal !== -1)) invalid();
        if (matching[0]) inputOrdinal = matching[0].ordinal;
      }
      if (inputOrdinal < 0) invalid();
      const bound = current.request.inputs[inputOrdinal];
      const key = current.keys[inputOrdinal];
      if (!bound || !key || bound.ordinal !== inputOrdinal || key.inputId !== bound.inputId)
        invalid();
      const expected = {
        bundleId: job.bundleId,
        source: current.request.intent.source,
        selection: current.request.intent.selection,
        datasets: current.datasets,
      };
      const planned = await loadPlannedTenantBackupInput(
        context,
        execution,
        inputOrdinal,
        expected
      );
      const policy = await options.loadPolicy(context, job.datasetId);
      if (
        policy.dataset.id !== job.datasetId ||
        policy.schema.table !== job.table ||
        !planned.manifest.datasets.some(({ id }) => id === job.datasetId)
      )
        invalid();
      const authorize = async () => {
        await loadCurrent(context);
        await execution.assertInputValidated(context.lease);
      };
      const replayInput = {
        ...planned,
        expected: {
          bundleId: planned.manifest.bundleId,
          source: planned.manifest.source,
          selection: planned.manifest.selection,
          datasets: planned.manifest.datasets,
        },
        session: key.key,
        bucket: current.bucket,
        signal: context.signal,
        assertAuthorized: authorize,
      };
      const receipts = new TenantBackupInputReceipts(database, context.lease, now);
      const firstSequence = await receipts.datasetStart(job.bundleId, job.datasetId, replayInput);
      await authorize();
      return {
        policy,
        manifest: planned.manifest,
        readNextValidatedRow: ({ datasetId, sourceCursor, planDigest }) => {
          if (datasetId !== job.datasetId) invalid();
          return readNextSqliteInputRow({
            receipts,
            replayInput,
            datasetId,
            firstSequence,
            sourceCursor,
            planDigest,
            assertValidatedPlan: async (digest, bundleId, validatedDatasetId) => {
              if (bundleId !== job.bundleId || validatedDatasetId !== job.datasetId) invalid();
              await assertPlan(context, digest);
            },
          });
        },
      };
    },

    async loadValidatedSqliteDatasets(context) {
      const current = await loadCurrent(context);
      const execution = new TenantBackupExecutionInventory(database, context.lease, now);
      const head = await execution.headForLease(context.lease);
      if (
        head.state !== 'sealed' ||
        head.item_count !== current.request.inputs.length ||
        head.item_count < 1 ||
        head.item_count > 32
      )
        invalid();
      await execution.assertInputValidated(context.lease);
      const plannedInputs = await loadPlannedTenantBackupInputs(context, execution, {
        source: current.request.intent.source,
        selection: current.request.intent.selection,
        datasets: current.datasets,
      });
      const owners = tenantBackupInputDatasetOwners(plannedInputs);
      const result: Phase8ValidatedSqliteRestoreDataset[] = [];
      for (const [ordinal, planned] of plannedInputs.entries()) {
        if (current.request.inputs[ordinal]?.ordinal !== ordinal) invalid();
        for (const dataset of planned.manifest.datasets.filter(
          ({ id, store }) => store === 'database' && owners.get(id) === planned.manifest.bundleId
        )) {
          const policy = await options.loadPolicy(context, dataset.id);
          if (
            !sameDataset(policy.dataset, dataset) ||
            !policy.schema.table ||
            policy.schema.table.length > 256
          )
            invalid();
          result.push({ manifest: planned.manifest, policy });
        }
      }
      if (!result.length || result.length > 4096) invalid();
      await execution.assertInputValidated(context.lease);
      await loadCurrent(context);
      return result;
    },
  };
}
