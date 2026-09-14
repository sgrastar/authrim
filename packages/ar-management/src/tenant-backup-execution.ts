import { runTenantBackupArtifactPublicationStep } from '@authrim/ar-lib-core/services/tenant-portability/publish-artifact-step';
import {
  backupDatabaseResourceDescriptor,
  resolveBackupTenantDatabaseResources,
} from '@authrim/ar-lib-core/services/tenant-portability/database-resources';
import {
  fixedBackupDatabaseResourceDescriptor,
  resolveFixedBackupDatabaseResources,
} from '@authrim/ar-lib-core/services/tenant-portability/fixed-database-resources';
import {
  resolveTenantBackupDatabaseInventory,
  tenantBackupDatabaseFamily,
} from './tenant-backup-database-inventory';
import { runPrepareTenantBackupArtifactStep } from '@authrim/ar-lib-core/services/tenant-portability/prepare-artifact-step';
import { TenantBackupExecutionInventory } from '@authrim/ar-lib-core/services/tenant-portability/execution-inventory';
import { TenantBackupImportRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/import-request';
import { runTenantBackupInputDecodeSequenceStep } from '@authrim/ar-lib-core/services/tenant-portability/input-decode-sequence';
import { runTenantBackupSqliteInputValidationSequenceStep } from '@authrim/ar-lib-core/services/tenant-portability/input-sqlite-validation-sequence';
import type { SqliteDatasetInspectionPolicy } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { DatabaseTenantBackupRestorePlanInventory } from '@authrim/ar-lib-core/services/tenant-portability/restore-plan-inventory';
import {
  runTenantBackupSqliteRestorePlanStep,
  type TenantBackupSqliteRestorePlanTarget,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-restore-plan-step';
import { probeTenantBackupInputManifest } from '@authrim/ar-lib-core/services/tenant-portability/input-manifest-probe';
import { persistTenantBackupInput } from '@authrim/ar-lib-core/services/tenant-portability/input-plan';
import { runTenantBackupArtifactStep } from '@authrim/ar-lib-core/services/tenant-portability/export-artifact-step';
import { runTenantBackupArtifactVerificationStep } from '@authrim/ar-lib-core/services/tenant-portability/verify-artifact-step';
import type { TenantPortableDataset } from '@authrim/ar-lib-core/services/tenant-portability/module-contract';
import type { TenantBackupSelection } from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import type { TenantBackupStepResult } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { requireDedicatedAdminDatabaseAdapter, type Env } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { TenantBackupRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import {
  runTenantBackupSqliteExportPlanStep,
  type TenantBackupSqlitePlanResource,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-export-plan-step';
import { getTenantBackupKeyStore, getTenantBackupBoundaryClient } from './tenant-backup-services';
import { getCanonicalTenantBaseUrlAsync } from './request-issuer';
import { version as productVersion } from '../package.json';

function sameInputIdentity(
  left: { key: string; version: string; etag: string; size: number },
  right: { key: string; version: string; etag: string; size: number }
) {
  return (
    left.key === right.key &&
    left.version === right.version &&
    left.etag === right.etag &&
    left.size === right.size
  );
}

function importCursor(value: string | null): { version: 1; nextInput: number } {
  if (value === null) return { version: 1, nextInput: 0 };
  try {
    const cursor = JSON.parse(value) as Record<string, unknown>;
    if (
      !cursor ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !== 'nextInput,version' ||
      cursor.version !== 1 ||
      !Number.isSafeInteger(cursor.nextInput) ||
      (cursor.nextInput as number) < 0 ||
      (cursor.nextInput as number) > 32
    )
      throw new Error();
    return cursor as { version: 1; nextInput: number };
  } catch {
    throw new Error('backup_import_execution_cursor');
  }
}

/** Reconstruct per-slice source intent and the accepted key from durable, authenticated state. */
export async function loadTenantBackupExportExecution(
  env: Env,
  context: TenantBackupStepContext,
  now: () => number = Date.now
) {
  context.signal.throwIfAborted();
  if (context.operation.kind !== 'export' || !env.EXPORT_ARTIFACTS)
    throw new Error('backup_export_execution_unavailable');
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  const requests = new TenantBackupRequestStore(database);
  const intent = await requests.loadForExecution(context, now);
  if (
    intent.kind !== 'export' ||
    intent.source.productVersion !== productVersion ||
    intent.source.issuer !== (await getCanonicalTenantBaseUrlAsync(env, context.lease.tenantId))
  )
    throw new Error('backup_export_source_changed');
  const keys = await getTenantBackupKeyStore(env);
  if (!keys) throw new Error('backup_export_key_unavailable');
  const key = await keys.loadActive(context.lease, now);
  // Issuer resolution and key unwrapping may race cancellation or checkpoint advancement.
  await requests.loadForExecution(context, now);
  context.signal.throwIfAborted();
  return { database, bucket: env.EXPORT_ARTIFACTS, intent, key };
}

type RequiredDatabases = Parameters<typeof resolveTenantBackupDatabaseInventory>[2];
export type TenantBackupDatasetResolver = (
  selection: TenantBackupSelection
) => readonly TenantPortableDataset[];

function resolveDatasets(
  resolver: TenantBackupDatasetResolver,
  selection: TenantBackupSelection
): TenantPortableDataset[] {
  const datasets = resolver(selection).map((dataset) => ({ ...dataset }));
  if (
    !datasets.length ||
    datasets.length > 4096 ||
    new Set(datasets.map((dataset) => dataset.id)).size !== datasets.length ||
    datasets.some(
      (dataset) =>
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(dataset.id) ||
        dataset.store !== 'database' ||
        dataset.disposition !== 'include'
    )
  )
    throw new Error('backup_installed_dataset_invalid');
  return datasets;
}

async function resolveSqlitePlanResources(
  env: Env,
  context: TenantBackupStepContext,
  required: RequiredDatabases
): Promise<TenantBackupSqlitePlanResource[]> {
  const tenant = required.roles.length
    ? await resolveBackupTenantDatabaseResources(env, {
        tenantId: context.lease.tenantId,
        roles: required.roles,
        signal: context.signal,
      })
    : [];
  const fixed = required.fixed.length
    ? resolveFixedBackupDatabaseResources(env, required.fixed)
    : [];
  const resources: TenantBackupSqlitePlanResource[] = [
    ...tenant.map((resource) => ({
      resourceId: resource.databaseId,
      family: tenantBackupDatabaseFamily(resource),
      database: resource.database,
      descriptor: {
        id: `database:${resource.databaseId}`,
        payload: backupDatabaseResourceDescriptor(resource),
      },
    })),
    ...fixed.map((resource) => ({
      resourceId: resource.databaseId,
      family: resource.family,
      database: resource.database,
      descriptor: {
        id: `fixed-database:${resource.binding}`,
        payload: fixedBackupDatabaseResourceDescriptor(resource),
      },
    })),
  ];
  if (!resources.length) throw new Error('backup_export_database_adapter_missing');
  return resources;
}

/** Build the complete trusted SQL inventory through bounded, replayable scheduler slices. */
export async function runTenantBackupExportPreparation(
  env: Env,
  context: TenantBackupStepContext,
  required: RequiredDatabases,
  now: () => number = Date.now
): Promise<TenantBackupStepResult> {
  if (context.operation.kind !== 'export' || context.operation.phase !== 'prepare')
    throw new Error('backup_export_execution_unavailable');
  const loaded = await loadTenantBackupExportExecution(env, context, now);
  const requiredDatabases = {
    roles: [...required.roles],
    fixed: [...required.fixed],
  };
  const resources = await resolveSqlitePlanResources(env, context, requiredDatabases);
  const expected = JSON.stringify(
    resources.map((resource) => [
      resource.resourceId,
      resource.family,
      resource.descriptor.id,
      resource.descriptor.payload,
    ])
  );
  const assertSources = async () => {
    await new TenantBackupRequestStore(loaded.database).loadForExecution(context, now);
    const current = await resolveSqlitePlanResources(env, context, requiredDatabases);
    if (
      JSON.stringify(
        current.map((resource) => [
          resource.resourceId,
          resource.family,
          resource.descriptor.id,
          resource.descriptor.payload,
        ])
      ) !== expected
    )
      throw new Error('backup_export_source_changed');
  };
  return runTenantBackupSqliteExportPlanStep({
    context,
    inventory: new TenantBackupExecutionInventory(loaded.database, context.lease, now),
    selection: loaded.intent.selection,
    resources,
    assertSources,
  });
}

/** Probe and pin one immutable encrypted input per slice without retaining its content key. */
export async function runTenantBackupImportPreparation(
  env: Env,
  context: TenantBackupStepContext,
  datasetResolver: TenantBackupDatasetResolver,
  now: () => number = Date.now
): Promise<TenantBackupStepResult> {
  context.signal.throwIfAborted();
  if (
    context.operation.kind !== 'import' ||
    context.operation.phase !== 'prepare' ||
    !env.IMPORT_ARTIFACTS
  )
    throw new Error('backup_import_execution_unavailable');
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  const requests = new TenantBackupImportRequestStore(database);
  const loaded = await requests.loadForExecution(context, now);
  const datasets = resolveDatasets(datasetResolver, loaded.intent.selection);
  if (
    loaded.intent.source.productVersion !== productVersion ||
    loaded.intent.source.issuer !==
      (await getCanonicalTenantBaseUrlAsync(env, context.lease.tenantId))
  )
    throw new Error('backup_import_source_changed');
  const keyStore = await getTenantBackupKeyStore(env);
  if (!keyStore) throw new Error('backup_import_key_unavailable');
  const keys = await keyStore.loadActiveInputs(context.lease, now);
  if (
    keys.length !== loaded.inputs.length ||
    keys.some((key, ordinal) => key.inputId !== loaded.inputs[ordinal]?.inputId)
  )
    throw new Error('backup_import_key_unavailable');
  const cursor = importCursor(context.operation.cursor_json);
  if (cursor.nextInput > loaded.inputs.length) throw new Error('backup_import_execution_cursor');
  const inventory = new TenantBackupExecutionInventory(database, context.lease, now);
  const head = await inventory.create();
  if (head.item_count !== cursor.nextInput) throw new Error('backup_import_execution_cursor');
  if (cursor.nextInput === loaded.inputs.length) {
    await inventory.seal(head.item_count, head.chain_digest);
    return {
      phase: 'decode_input',
      cursor: JSON.stringify({ version: 1, inputOrdinal: 0 }),
      disposition: 'continue',
    };
  }
  const bound = loaded.inputs[cursor.nextInput];
  const active = keys[cursor.nextInput];
  if (!bound || !active || active.inputId !== bound.inputId)
    throw new Error('backup_import_key_unavailable');
  const assertCurrent = async () => {
    const current = await requests.loadForExecution(context, now);
    const selected = current.inputs[bound.ordinal];
    if (
      current.intent.inputs[bound.ordinal]?.id !== bound.inputId ||
      current.intent.inputs[bound.ordinal]?.digestSha256 !== bound.digestSha256 ||
      !selected ||
      selected.inputId !== bound.inputId ||
      selected.digestSha256 !== bound.digestSha256 ||
      !sameInputIdentity(selected.identity, bound.identity)
    )
      throw new Error('backup_import_input_changed');
  };
  const probed = await probeTenantBackupInputManifest({
    bucket: env.IMPORT_ARTIFACTS,
    identity: bound.identity,
    session: active.key,
    limits: {
      maxTotalBytes: bound.identity.size,
      maxFrames: Math.min(1_000_001, Math.max(2, Math.floor((bound.identity.size - 8) / 5))),
    },
    expected: {
      source: loaded.intent.source,
      selection: loaded.intent.selection,
      datasets,
    },
    signal: context.signal,
    assertAuthorized: assertCurrent,
  });
  await persistTenantBackupInput({
    context,
    inventory,
    ordinal: bound.ordinal,
    identity: bound.identity,
    limits: {
      maxTotalBytes: bound.identity.size,
      maxFrames: Math.min(1_000_001, Math.max(2, Math.floor((bound.identity.size - 8) / 5))),
    },
    manifest: probed.manifest,
    expected: probed.expected,
    assertUploadOwnership: async (identity) => {
      await assertCurrent();
      if (!sameInputIdentity(identity, bound.identity))
        throw new Error('backup_import_input_changed');
    },
  });
  await assertCurrent();
  return {
    phase: 'prepare',
    cursor: JSON.stringify({ version: 1, nextInput: cursor.nextInput + 1 }),
    disposition: 'continue',
  };
}

/** Decode one frame from the ordered, atomically bound input set in each scheduler slice. */
export async function runTenantBackupImportDecode(
  env: Env,
  context: TenantBackupStepContext,
  datasetResolver: TenantBackupDatasetResolver,
  now: () => number = Date.now
): Promise<TenantBackupStepResult> {
  context.signal.throwIfAborted();
  if (
    context.operation.kind !== 'import' ||
    context.operation.phase !== 'decode_input' ||
    !env.IMPORT_ARTIFACTS
  )
    throw new Error('backup_import_execution_unavailable');
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  const requests = new TenantBackupImportRequestStore(database);
  const loaded = await requests.loadForExecution(context, now);
  const datasets = resolveDatasets(datasetResolver, loaded.intent.selection);
  if (
    loaded.intent.source.productVersion !== productVersion ||
    loaded.intent.source.issuer !==
      (await getCanonicalTenantBaseUrlAsync(env, context.lease.tenantId))
  )
    throw new Error('backup_import_source_changed');
  const keyStore = await getTenantBackupKeyStore(env);
  if (!keyStore) throw new Error('backup_import_key_unavailable');
  const keys = await keyStore.loadActiveInputs(context.lease, now);
  if (
    keys.length !== loaded.inputs.length ||
    keys.some((key, ordinal) => key.inputId !== loaded.inputs[ordinal]?.inputId)
  )
    throw new Error('backup_import_key_unavailable');
  const result = await runTenantBackupInputDecodeSequenceStep(context, {
    inventory: new TenantBackupExecutionInventory(database, context.lease, now),
    inputCount: loaded.inputs.length,
    database,
    bucket: env.IMPORT_ARTIFACTS,
    now,
    loadInput: async (ordinal, bundleId) => {
      const current = await requests.loadForExecution(context, now);
      const bound = current.inputs[ordinal];
      const key = keys[ordinal];
      if (
        !bound ||
        !key ||
        key.inputId !== bound.inputId ||
        bound.inputId !== loaded.inputs[ordinal]?.inputId ||
        bound.digestSha256 !== loaded.inputs[ordinal]?.digestSha256
      )
        throw new Error('backup_import_input_changed');
      return {
        session: key.key,
        expected: {
          bundleId,
          source: current.intent.source,
          selection: current.intent.selection,
          datasets,
        },
      };
    },
  });
  await requests.loadForExecution(context, now);
  context.signal.throwIfAborted();
  return result;
}

/** Validate ordered SQL inputs against installed policies before any restore target is writable. */
export async function runTenantBackupImportValidation(
  env: Env,
  context: TenantBackupStepContext,
  adapter: {
    datasets: TenantBackupDatasetResolver;
    loadPolicy(datasetId: string): Promise<SqliteDatasetInspectionPolicy>;
    assertSources(): Promise<void>;
  },
  now: () => number = Date.now
): Promise<TenantBackupStepResult> {
  context.signal.throwIfAborted();
  if (
    context.operation.kind !== 'import' ||
    ![
      'validate_input_modules',
      'validate_sqlite_dataset',
      'advance_validation_dataset',
      'validate_input_references',
      'finalize_input_validation',
    ].includes(context.operation.phase) ||
    !env.IMPORT_ARTIFACTS
  )
    throw new Error('backup_import_execution_unavailable');
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  const requests = new TenantBackupImportRequestStore(database);
  const keyStore = await getTenantBackupKeyStore(env);
  if (!keyStore) throw new Error('backup_import_key_unavailable');
  const assertCurrent = async () => {
    context.signal.throwIfAborted();
    const current = await requests.loadForExecution(context, now);
    if (
      current.intent.source.productVersion !== productVersion ||
      current.intent.source.issuer !==
        (await getCanonicalTenantBaseUrlAsync(env, context.lease.tenantId))
    )
      throw new Error('backup_import_source_changed');
    const currentKeys = await keyStore.loadActiveInputs(context.lease, now);
    if (
      currentKeys.length !== current.inputs.length ||
      currentKeys.some((key, ordinal) => key.inputId !== current.inputs[ordinal]?.inputId)
    )
      throw new Error('backup_import_key_unavailable');
    await adapter.assertSources();
    context.signal.throwIfAborted();
    return { current, currentKeys };
  };
  const initial = await assertCurrent();
  const datasets = resolveDatasets(adapter.datasets, initial.current.intent.selection);
  const result = await runTenantBackupSqliteInputValidationSequenceStep(context, {
    database,
    bucket: env.IMPORT_ARTIFACTS,
    inventory: new TenantBackupExecutionInventory(database, context.lease, now),
    now,
    loadInput: async (ordinal, bundleId) => {
      const loaded = await assertCurrent();
      const bound = loaded.current.inputs[ordinal];
      const key = loaded.currentKeys[ordinal];
      if (
        !bound ||
        !key ||
        key.inputId !== bound.inputId ||
        bound.inputId !== initial.current.inputs[ordinal]?.inputId ||
        bound.digestSha256 !== initial.current.inputs[ordinal]?.digestSha256
      )
        throw new Error('backup_import_input_changed');
      return {
        expected: {
          bundleId,
          source: loaded.current.intent.source,
          selection: loaded.current.intent.selection,
          datasets,
        },
        session: key.key,
        loadPolicy: async (datasetId) => {
          await assertCurrent();
          const policy = await adapter.loadPolicy(datasetId);
          await assertCurrent();
          return policy;
        },
        assertAuthorized: async () => {
          await assertCurrent();
        },
      };
    },
  });
  await assertCurrent();
  return result;
}

/** Build a separate unpublished restore plan only after durable whole-input validation. */
export async function runTenantBackupImportRestorePlanning(
  env: Env,
  context: TenantBackupStepContext,
  adapter: {
    targets: readonly TenantBackupSqliteRestorePlanTarget[];
    assertSources(): Promise<void>;
  },
  now: () => number = Date.now
): Promise<TenantBackupStepResult> {
  if (context.operation.kind !== 'import' || context.operation.phase !== 'prepare_restore_plan')
    throw new Error('backup_import_execution_unavailable');
  const database = requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup');
  const requests = new TenantBackupImportRequestStore(database);
  const keyStore = await getTenantBackupKeyStore(env);
  if (!keyStore) throw new Error('backup_import_key_unavailable');
  const assertInputs = async () => {
    context.signal.throwIfAborted();
    const current = await requests.loadForExecution(context, now);
    if (
      current.intent.source.productVersion !== productVersion ||
      current.intent.source.issuer !==
        (await getCanonicalTenantBaseUrlAsync(env, context.lease.tenantId))
    )
      throw new Error('backup_import_source_changed');
    const keys = await keyStore.loadActiveInputs(context.lease, now);
    if (
      keys.length !== current.inputs.length ||
      keys.some((key, ordinal) => key.inputId !== current.inputs[ordinal]?.inputId)
    )
      throw new Error('backup_import_key_unavailable');
    await adapter.assertSources();
    context.signal.throwIfAborted();
  };
  await assertInputs();
  const result = await runTenantBackupSqliteRestorePlanStep({
    context,
    inventory: new DatabaseTenantBackupRestorePlanInventory(database, context.lease, now),
    targets: adapter.targets,
    assertInputs,
  });
  await assertInputs();
  return result;
}

/** Management execution entry for prepared artifact phases; module adapters supply live coverage and reads. */
export async function runTenantBackupArtifactExecution(
  env: Env,
  context: TenantBackupStepContext,
  adapters: {
    datasets: readonly TenantPortableDataset[];
    requiredDatabases: Parameters<typeof resolveTenantBackupDatabaseInventory>[2];
    /** Includes final module receipts, snapshot release and retention verification. */
    assertPublishable: (inventoryDigest: string) => Promise<void>;
    readNext: Parameters<typeof runTenantBackupArtifactStep>[1]['readNext'];
    assertSources: () => Promise<void>;
  },
  now: () => number = Date.now
): Promise<TenantBackupStepResult> {
  if (
    !['prepare_export_artifact', 'export_artifact', 'verify_artifact', 'publish_artifact'].includes(
      context.operation.phase
    )
  )
    throw new Error('backup_artifact_execution_phase');
  const requiredDatabases = {
    roles: [...adapters.requiredDatabases.roles],
    fixed: [...adapters.requiredDatabases.fixed],
  };
  const loaded = await loadTenantBackupExportExecution(env, context, now);
  let cursor: unknown;
  try {
    cursor = JSON.parse(context.operation.cursor_json ?? 'null');
  } catch {
    throw new Error('backup_artifact_execution_cursor');
  }
  const expected = {
    bundleId: Array.from(loaded.key.envelope.subarray(1, 17), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join(''),
    source: loaded.intent.source,
    selection: loaded.intent.selection,
    datasets: adapters.datasets.map((dataset) => ({ ...dataset })),
  };
  const assertSources = async () => {
    context.signal.throwIfAborted();
    await new TenantBackupRequestStore(loaded.database).loadForExecution(context, now);
    await resolveTenantBackupDatabaseInventory(env, context, requiredDatabases, now);
    await adapters.assertSources();
    await new TenantBackupRequestStore(loaded.database).loadForExecution(context, now);
    context.signal.throwIfAborted();
  };
  await assertSources();
  if (context.operation.phase === 'prepare_export_artifact') {
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      !('boundaryId' in cursor) ||
      typeof cursor.boundaryId !== 'string' ||
      !('inventoryDigest' in cursor) ||
      typeof cursor.inventoryDigest !== 'string' ||
      !('releasedAt' in cursor) ||
      typeof cursor.releasedAt !== 'number'
    )
      throw new Error('backup_artifact_execution_cursor');
    const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
    if (!environmentId) throw new Error('backup_boundary_rpc_unavailable');
    const boundary = getTenantBackupBoundaryClient(env, {
      tenantId: context.lease.tenantId,
      operationId: context.lease.operationId,
      inventoryDigest: cursor.inventoryDigest,
    });
    const result = await runPrepareTenantBackupArtifactStep({
      context,
      inventory: new TenantBackupExecutionInventory(loaded.database, context.lease, now),
      receipts: boundary.receipts,
      environmentId,
      boundaryTenantId: context.lease.tenantId,
      database: loaded.database,
      bucket: loaded.bucket,
      key: loaded.key,
      expected,
      manifest: {
        formatVersion: 1,
        ...expected,
        snapshotId: cursor.boundaryId,
        boundaryUnixMs: cursor.releasedAt,
        inventoryDigestSha256: cursor.inventoryDigest,
      },
      now,
      assertSources,
    });
    await assertSources();
    return result;
  }
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Array.isArray(cursor) ||
    !('attemptId' in cursor) ||
    typeof cursor.attemptId !== 'string' ||
    !/^[A-Za-z0-9-]{1,64}$/.test(cursor.attemptId)
  )
    throw new Error('backup_artifact_execution_cursor');
  if (context.operation.phase === 'publish_artifact') {
    const result = await runTenantBackupArtifactPublicationStep(context, {
      database: loaded.database,
      inventory: new TenantBackupExecutionInventory(loaded.database, context.lease, now),
      now,
      assertPublishable: async (digest) => {
        await assertSources();
        await adapters.assertPublishable(digest);
        await assertSources();
      },
    });
    await assertSources();
    return result;
  }
  const args = {
    database: loaded.database,
    bucket: loaded.bucket,
    attemptId: cursor.attemptId,
    key: loaded.key,
    expected,
    now,
  };
  const result =
    context.operation.phase === 'export_artifact'
      ? await runTenantBackupArtifactStep(context, {
          ...args,
          readNext: adapters.readNext,
          assertBoundary: assertSources,
        })
      : await runTenantBackupArtifactVerificationStep(context, args);
  await assertSources();
  return result;
}
