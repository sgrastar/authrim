import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import { TenantBackupExecutionInventory } from '@authrim/ar-lib-core/services/tenant-portability/execution-inventory';
import { TenantBackupImportRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/import-request';
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
import { readTenantBackupContainerV2Input } from '@authrim/ar-lib-core/services/tenant-portability/input-container-v2';
import { readNextTenantBackupContainerRow } from '@authrim/ar-lib-core/services/tenant-portability/container-dataset-reader';
import { TenantBackupContainerInputStore } from '@authrim/ar-lib-core/services/tenant-portability/container-input-store';
import type { SqliteDatasetInspectionPolicy } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { TenantBackupInstalledImportAdapter } from './tenant-backup-import-dispatcher';
import { getTenantBackupKeyStore } from './tenant-backup-services';
import { version as productVersion } from '../package.json';

type RestoreJob = Parameters<TenantBackupInstalledImportAdapter['loadValidatedDataset']>[1];
type LoadedDataset = Awaited<
  ReturnType<TenantBackupInstalledImportAdapter['loadValidatedDataset']>
>;

export interface TenantBackupValidatedInputPortOptions {
  env: Env;
  datasets(selection: TenantBackupSelection): readonly TenantPortableDataset[];
  loadPolicies?(
    context: TenantBackupStepContext
  ): Promise<readonly SqliteDatasetInspectionPolicy[]>;
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
  loadValidatedDatasetById(
    context: TenantBackupStepContext,
    planDigest: string,
    datasetId: string
  ): Promise<{
    policy: SqliteDatasetInspectionPolicy;
    manifest: TenantBundleManifest;
    readNextValidatedRow(input: {
      sourceCursor: string | null;
    }): Promise<{ rowJson: string; nextCursor: string } | null>;
  }>;
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

  type Current = Awaited<ReturnType<typeof loadCurrentUncached>>;
  let currentCache: { leaseKey: string; value: Promise<Current> } | undefined;
  type PreparedInput = {
    current: Current;
    execution: TenantBackupExecutionInventory;
    plannedInputs: Awaited<ReturnType<typeof loadPlannedTenantBackupInputs>>;
    owners: ReadonlyMap<string, string>;
    policiesById: Map<string, SqliteDatasetInspectionPolicy> | null;
  };
  let preparedCache: { leaseKey: string; value: Promise<PreparedInput> } | undefined;
  let inputAuthorizationCache: { leaseKey: string; value: Promise<void> } | undefined;
  let planAuthorizationCache:
    | { leaseKey: string; planDigest: string; value: Promise<void> }
    | undefined;
  const decodedCache = new Map<
    string,
    Promise<Awaited<ReturnType<typeof readTenantBackupContainerV2Input>>>
  >();

  function operationLeaseKey(context: TenantBackupStepContext): string {
    return JSON.stringify([
      context.lease.tenantId,
      context.lease.operationId,
      context.lease.owner,
      context.lease.fencingToken,
    ]);
  }

  async function loadCurrentUncached(context: TenantBackupStepContext) {
    context.signal.throwIfAborted();
    if (!options.env.IMPORT_ARTIFACTS) invalid();
    const request = await requestStore.loadForExecution(context, now);
    if (request.intent.source.productVersion !== productVersion) invalid();
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

  function loadCurrent(context: TenantBackupStepContext): Promise<Current> {
    const leaseKey = operationLeaseKey(context);
    if (currentCache?.leaseKey === leaseKey) return currentCache.value;
    const value = loadCurrentUncached(context);
    currentCache = { leaseKey, value };
    return value;
  }

  function authorizeInput(
    context: TenantBackupStepContext,
    execution: TenantBackupExecutionInventory
  ): Promise<void> {
    const leaseKey = operationLeaseKey(context);
    if (inputAuthorizationCache?.leaseKey === leaseKey) return inputAuthorizationCache.value;
    const value = (async () => {
      await loadCurrent(context);
      await execution.assertInputValidated(context.lease);
    })();
    inputAuthorizationCache = { leaseKey, value };
    return value;
  }

  function loadPreparedInput(context: TenantBackupStepContext): Promise<PreparedInput> {
    const leaseKey = operationLeaseKey(context);
    if (preparedCache?.leaseKey === leaseKey) return preparedCache.value;
    const value = (async () => {
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
      await authorizeInput(context, execution);
      const bundleCounts = new Map<string, number>();
      for (let from = 0; from < head.item_count; ) {
        const page = await execution.readPage(from);
        if (!page.length) invalid();
        for (const row of page) {
          const prefix = 'backup-input:';
          const bundleId = row.item_id.startsWith(prefix) ? row.item_id.slice(prefix.length) : '';
          if (!/^[a-f0-9]{32}$/u.test(bundleId)) invalid();
          bundleCounts.set(bundleId, (bundleCounts.get(bundleId) ?? 0) + 1);
        }
        from += page.length;
      }
      const plannedInputs = await loadPlannedTenantBackupInputs(context, execution, {
        source: current.request.intent.source,
        selection: current.request.intent.selection,
        datasets: current.datasets,
      });
      const owners = tenantBackupInputDatasetOwners(plannedInputs);
      if (
        bundleCounts.size !== plannedInputs.length ||
        plannedInputs.some(({ manifest }) => bundleCounts.get(manifest.bundleId) !== 1)
      )
        invalid();
      const installedPolicies = options.loadPolicies ? await options.loadPolicies(context) : null;
      const policiesById = installedPolicies
        ? new Map(installedPolicies.map((policy) => [policy.dataset.id, policy]))
        : null;
      if (policiesById && policiesById.size !== installedPolicies?.length) invalid();
      return { current, execution, plannedInputs, owners, policiesById };
    })();
    preparedCache = { leaseKey, value };
    return value;
  }

  async function loadDecoded(
    context: TenantBackupStepContext,
    planned: Awaited<ReturnType<typeof loadPlannedTenantBackupInput>>,
    key: Current['keys'][number],
    bucket: Current['bucket']
  ) {
    const cacheKey = `${operationLeaseKey(context)}:${planned.manifest.bundleId}`;
    const existing = decodedCache.get(cacheKey);
    if (existing) return existing;
    const value = (async () => {
      const store = new TenantBackupContainerInputStore(database, context.lease, now);
      const receipt = await store.load(planned.manifest.bundleId);
      if (
        receipt.object_key !== planned.identity.key ||
        receipt.object_version !== planned.identity.version ||
        receipt.object_etag !== planned.identity.etag ||
        receipt.object_size !== planned.identity.size
      )
        invalid();
      return readTenantBackupContainerV2Input({
        bucket,
        identity: planned.identity,
        session: key.key,
        signal: context.signal,
        assertAuthorized: async () => {
          await loadCurrent(context);
          await store.load(planned.manifest.bundleId);
        },
      });
    })();
    decodedCache.set(cacheKey, value);
    return value;
  }

  async function assertPlanUncached(
    context: TenantBackupStepContext,
    planDigest: string
  ): Promise<void> {
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

  function assertPlan(context: TenantBackupStepContext, planDigest: string): Promise<void> {
    const leaseKey = operationLeaseKey(context);
    if (
      planAuthorizationCache?.leaseKey === leaseKey &&
      planAuthorizationCache.planDigest === planDigest
    )
      return planAuthorizationCache.value;
    const value = assertPlanUncached(context, planDigest);
    planAuthorizationCache = { leaseKey, planDigest, value };
    return value;
  }

  return {
    async assertValidatedUnpublishedPlan(context, planDigest) {
      await assertPlan(context, planDigest);
    },

    async loadValidatedDataset(context, job): Promise<LoadedDataset> {
      validateJob(job);
      const { current, execution, plannedInputs, owners, policiesById } =
        await loadPreparedInput(context);
      const inputOrdinal = plannedInputs.findIndex(
        ({ manifest }) => manifest.bundleId === job.bundleId
      );
      if (inputOrdinal < 0 || owners.get(job.datasetId) !== job.bundleId) invalid();
      const bound = current.request.inputs[inputOrdinal];
      const key = current.keys[inputOrdinal];
      if (!bound || !key || bound.ordinal !== inputOrdinal || key.inputId !== bound.inputId)
        invalid();
      const planned = plannedInputs[inputOrdinal] ?? invalid();
      const policy =
        policiesById?.get(job.datasetId) ?? (await options.loadPolicy(context, job.datasetId));
      if (
        policy.dataset.id !== job.datasetId ||
        policy.schema.table !== job.table ||
        !planned.manifest.datasets.some(({ id }) => id === job.datasetId)
      )
        invalid();
      const authorize = async () => {
        await authorizeInput(context, execution);
      };
      const decoded = await loadDecoded(context, planned, key, current.bucket);
      const datasetBytes = decoded.datasets.get(job.datasetId) ?? invalid();
      await authorize();
      return {
        policy,
        manifest: planned.manifest,
        readNextValidatedRow: async ({ datasetId, sourceCursor, planDigest }) => {
          if (datasetId !== job.datasetId || !/^[a-f0-9]{64}$/u.test(planDigest)) invalid();
          return readNextTenantBackupContainerRow(datasetBytes, sourceCursor);
        },
      };
    },

    async loadValidatedSqliteDatasets(context) {
      const { current, execution, plannedInputs, owners, policiesById } =
        await loadPreparedInput(context);
      const result: Phase8ValidatedSqliteRestoreDataset[] = [];
      for (const [ordinal, planned] of plannedInputs.entries()) {
        if (current.request.inputs[ordinal]?.ordinal !== ordinal) invalid();
        const key = current.keys[ordinal] ?? invalid();
        const decoded = await loadDecoded(context, planned, key, current.bucket);
        for (const dataset of planned.manifest.datasets.filter(
          ({ id, store }) => store === 'database' && owners.get(id) === planned.manifest.bundleId
        )) {
          const policy =
            policiesById?.get(dataset.id) ?? (await options.loadPolicy(context, dataset.id));
          if (
            !sameDataset(policy.dataset, dataset) ||
            !policy.schema.table ||
            policy.schema.table.length > 256
          )
            invalid();
          const datasetBytes = decoded.datasets.get(dataset.id) ?? invalid();
          let recordCount = 0;
          let sourceCursor: string | null = null;
          for (;;) {
            const row = readNextTenantBackupContainerRow(datasetBytes, sourceCursor);
            if (!row) break;
            recordCount += 1;
            sourceCursor = row.nextCursor;
          }
          result.push({
            manifest: planned.manifest,
            policy,
            recordCount,
            byteCount: datasetBytes.byteLength,
          });
        }
      }
      if (!result.length || result.length > 4096) invalid();
      await execution.assertInputValidated(context.lease);
      await loadCurrent(context);
      return result;
    },

    async loadValidatedDatasetById(context, planDigest, datasetId) {
      if (!/^[A-Za-z0-9_.:-]{1,256}$/u.test(datasetId)) invalid();
      await assertPlan(context, planDigest);
      const { current, execution, plannedInputs, owners, policiesById } =
        await loadPreparedInput(context);
      const owner = owners.get(datasetId) ?? invalid();
      const inputOrdinal = plannedInputs.findIndex(({ manifest }) => manifest.bundleId === owner);
      const planned = plannedInputs[inputOrdinal] ?? invalid();
      const bound = current.request.inputs[inputOrdinal];
      const key = current.keys[inputOrdinal];
      if (
        !bound ||
        !key ||
        bound.ordinal !== inputOrdinal ||
        key.inputId !== bound.inputId ||
        !planned.manifest.datasets.some(({ id }) => id === datasetId)
      )
        invalid();
      const policy = policiesById?.get(datasetId) ?? (await options.loadPolicy(context, datasetId));
      if (policy.dataset.id !== datasetId) invalid();
      const authorize = async () => {
        await loadCurrent(context);
        await execution.assertInputValidated(context.lease);
        await assertPlan(context, planDigest);
      };
      const decoded = await loadDecoded(context, planned, key, current.bucket);
      const datasetBytes = decoded.datasets.get(datasetId) ?? invalid();
      await authorize();
      return {
        policy,
        manifest: planned.manifest,
        readNextValidatedRow: async ({ sourceCursor }) => {
          return readNextTenantBackupContainerRow(datasetBytes, sourceCursor);
        },
      };
    },
  };
}
