import type { Env } from '@authrim/ar-lib-core';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import {
  decodePortableLogicalTargetPlan,
  decodePortablePluginConfiguration,
  decodePortablePublicAsset,
  LOGICAL_PLACEMENT_DATASET,
  PLUGIN_CONFIGURATION_DATASET,
  PUBLIC_ASSETS_DATASET,
  type PortableLogicalTargetPlan,
  type PortablePluginConfiguration,
  type PortablePublicAsset,
} from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import {
  restorePortableWebhookSecret,
  verifyPortableWebhookSecret,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-webhook-secret';
import type { Phase3OtherStoreSource } from './tenant-backup-phase3-other-stores';
import {
  createPhase4OtherStoreHandlers,
  type Phase4OtherStorePorts,
} from './tenant-backup-phase4-other-stores';

type Purpose = 'restore' | 'verify';
type DatasetId =
  | 'admin.credential_secret_bodies'
  | 'admin.logging_key_material_bodies'
  | 'core.webhook_configs'
  | 'flows-ui.public_assets'
  | 'integrations.plugin_runner_configuration'
  | 'placement-rebuild.logical_target_plan';
type SqlDatasetId = Extract<DatasetId, `admin.${string}` | `core.${string}`>;
type RecordDatasetId = Exclude<DatasetId, SqlDatasetId>;
const DATASETS: readonly DatasetId[] = [
  'core.webhook_configs',
  'admin.credential_secret_bodies',
  'admin.logging_key_material_bodies',
  'flows-ui.public_assets',
  'integrations.plugin_runner_configuration',
  'placement-rebuild.logical_target_plan',
];

interface Cursor {
  version: 1;
  purpose: Purpose;
  stage: 'phase4' | 'phase5';
  datasetId: DatasetId | null;
  sourceCursor: string | null;
}

export interface Phase5OtherStorePorts {
  phase4: Phase4OtherStorePorts;
  loadSqlite(
    context: TenantBackupStepContext,
    planDigest: string,
    purpose: Purpose,
    datasetId: SqlDatasetId
  ): Promise<Phase3OtherStoreSource>;
  loadRecord(
    context: TenantBackupStepContext,
    planDigest: string,
    purpose: Purpose,
    datasetId: RecordDatasetId
  ): Promise<Omit<Phase3OtherStoreSource, 'target'>>;
  restoreAdminEnvelope(
    context: TenantBackupStepContext,
    datasetId: Extract<SqlDatasetId, `admin.${string}`>,
    source: Phase3OtherStoreSource,
    rowJson: string
  ): Promise<void>;
  verifyAdminEnvelope(
    context: TenantBackupStepContext,
    datasetId: Extract<SqlDatasetId, `admin.${string}`>,
    source: Phase3OtherStoreSource,
    rowJson: string
  ): Promise<boolean>;
  importAsset(context: TenantBackupStepContext, asset: PortablePublicAsset): Promise<void>;
  verifyAsset(context: TenantBackupStepContext, asset: PortablePublicAsset): Promise<boolean>;
  importPlugin(
    context: TenantBackupStepContext,
    configuration: PortablePluginConfiguration
  ): Promise<void>;
  verifyPlugin(
    context: TenantBackupStepContext,
    configuration: PortablePluginConfiguration
  ): Promise<boolean>;
  prepareLogicalTarget(
    context: TenantBackupStepContext,
    plan: PortableLogicalTargetPlan
  ): Promise<void>;
  verifyLogicalTarget(
    context: TenantBackupStepContext,
    plan: PortableLogicalTargetPlan
  ): Promise<boolean>;
}

function invalid(): never {
  throw new Error('backup_phase5_other_store_invalid');
}

function encode(cursor: Cursor): string {
  const result = JSON.stringify(cursor);
  if (result.length > 4096) invalid();
  return result;
}

function parse(value: string | null, purpose: Purpose): Cursor {
  if (value === null)
    return {
      version: 1,
      purpose,
      stage: 'phase4',
      datasetId: null,
      sourceCursor: null,
    };
  try {
    const cursor = JSON.parse(value) as Cursor;
    if (
      !cursor ||
      typeof cursor !== 'object' ||
      Array.isArray(cursor) ||
      Object.keys(cursor).sort().join(',') !== 'datasetId,purpose,sourceCursor,stage,version' ||
      cursor.version !== 1 ||
      cursor.purpose !== purpose ||
      !['phase4', 'phase5'].includes(cursor.stage) ||
      (cursor.stage === 'phase4' && cursor.datasetId !== null) ||
      (cursor.stage === 'phase5' && !DATASETS.includes(cursor.datasetId as DatasetId)) ||
      (cursor.sourceCursor !== null &&
        (typeof cursor.sourceCursor !== 'string' ||
          !cursor.sourceCursor ||
          cursor.sourceCursor.length > 3072))
    )
      invalid();
    return cursor;
  } catch {
    return invalid();
  }
}

function next(datasetId: DatasetId, purpose: Purpose): { cursor: string | null; done: boolean } {
  const index = DATASETS.indexOf(datasetId) + 1;
  return index === DATASETS.length
    ? { cursor: null, done: true }
    : {
        cursor: encode({
          version: 1,
          purpose,
          stage: 'phase5',
          datasetId: DATASETS[index],
          sourceCursor: null,
        }),
        done: false,
      };
}

function targetEncryption(env: Pick<Env, 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_VERSION'>) {
  const version = env.PII_ENCRYPTION_KEY_VERSION ?? '1';
  if (!/^[1-9][0-9]{0,8}$/.test(version)) invalid();
  return { targetKey: env.PII_ENCRYPTION_KEY, targetKeyVersion: Number(version) };
}

function isSql(datasetId: DatasetId): datasetId is SqlDatasetId {
  return datasetId.startsWith('core.') || datasetId.startsWith('admin.');
}

async function applyRecord(
  ports: Phase5OtherStorePorts,
  context: TenantBackupStepContext,
  datasetId: RecordDatasetId,
  rowJson: string,
  purpose: Purpose
) {
  if (datasetId === PUBLIC_ASSETS_DATASET.id) {
    const value = await decodePortablePublicAsset(rowJson, context.lease.tenantId);
    if (purpose === 'restore') await ports.importAsset(context, value);
    else if (!(await ports.verifyAsset(context, value))) invalid();
    return;
  }
  if (datasetId === PLUGIN_CONFIGURATION_DATASET.id) {
    const value = decodePortablePluginConfiguration(rowJson, context.lease.tenantId);
    if (purpose === 'restore') await ports.importPlugin(context, value);
    else if (!(await ports.verifyPlugin(context, value))) invalid();
    return;
  }
  const value = decodePortableLogicalTargetPlan(rowJson, context.lease.tenantId);
  if (purpose === 'restore') await ports.prepareLogicalTarget(context, value);
  else if (!(await ports.verifyLogicalTarget(context, value))) invalid();
}

export function createPhase5OtherStoreHandlers(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY_VERSION'>,
  ports: Phase5OtherStorePorts
) {
  const phase4 = createPhase4OtherStoreHandlers(env, ports.phase4);
  const run = async (
    context: TenantBackupStepContext,
    planDigest: string,
    cursorValue: string | null,
    purpose: Purpose
  ): Promise<{ cursor: string | null; done: boolean }> => {
    if (!/^[a-f0-9]{64}$/.test(planDigest)) invalid();
    const cursor = parse(cursorValue, purpose);
    context.signal.throwIfAborted();
    if (cursor.stage === 'phase4') {
      const result =
        purpose === 'restore'
          ? await phase4.restoreOtherStores(context, planDigest, cursor.sourceCursor)
          : await phase4.verifyOtherStores(context, planDigest, cursor.sourceCursor);
      if (!result.done)
        return {
          cursor: encode({ ...cursor, sourceCursor: result.cursor }),
          done: false,
        };
      return {
        cursor: encode({
          version: 1,
          purpose,
          stage: 'phase5',
          datasetId: DATASETS[0],
          sourceCursor: null,
        }),
        done: false,
      };
    }
    const datasetId = cursor.datasetId ?? invalid();
    if (isSql(datasetId)) {
      const source = await ports.loadSqlite(context, planDigest, purpose, datasetId);
      if (source.policy.dataset.id !== datasetId) invalid();
      const row = await source.readNextValidatedRow({ sourceCursor: cursor.sourceCursor });
      context.signal.throwIfAborted();
      if (row === null) return next(datasetId, purpose);
      if (!row.nextCursor || row.nextCursor === cursor.sourceCursor) invalid();
      const ignored = source.policy.verificationIgnoredColumns ?? [];
      if (
        (datasetId === 'core.webhook_configs' && !ignored.includes('secret_encrypted')) ||
        (datasetId !== 'core.webhook_configs' && !ignored.includes('envelope_json'))
      )
        invalid();
      if (datasetId === 'core.webhook_configs') {
        const common = {
          target: source.target as unknown as Parameters<
            typeof restorePortableWebhookSecret
          >[0]['target'],
          policy: source.policy,
          manifest: source.manifest,
        };
        if (purpose === 'restore')
          await restorePortableWebhookSecret({
            ...common,
            rowJson: row.rowJson,
            ...targetEncryption(env),
          });
        else
          await verifyPortableWebhookSecret({
            ...common,
            rowJson: row.rowJson,
            ...targetEncryption(env),
          });
      } else if (purpose === 'restore')
        await ports.restoreAdminEnvelope(context, datasetId, source, row.rowJson);
      else if (!(await ports.verifyAdminEnvelope(context, datasetId, source, row.rowJson)))
        invalid();
      context.signal.throwIfAborted();
      return { cursor: encode({ ...cursor, sourceCursor: row.nextCursor }), done: false };
    }
    const source = await ports.loadRecord(context, planDigest, purpose, datasetId);
    if (source.policy.dataset.id !== datasetId) invalid();
    const row = await source.readNextValidatedRow({ sourceCursor: cursor.sourceCursor });
    context.signal.throwIfAborted();
    if (row === null) return next(datasetId, purpose);
    if (!row.nextCursor || row.nextCursor === cursor.sourceCursor) invalid();
    await applyRecord(ports, context, datasetId, row.rowJson, purpose);
    context.signal.throwIfAborted();
    return { cursor: encode({ ...cursor, sourceCursor: row.nextCursor }), done: false };
  };
  return {
    restoreOtherStores: (
      context: TenantBackupStepContext,
      planDigest: string,
      cursor: string | null
    ) => run(context, planDigest, cursor, 'restore'),
    verifyOtherStores: (
      context: TenantBackupStepContext,
      planDigest: string,
      cursor: string | null
    ) => run(context, planDigest, cursor, 'verify'),
  };
}
