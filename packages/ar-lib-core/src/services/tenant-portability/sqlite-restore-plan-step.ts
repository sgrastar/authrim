import type { TenantBundleManifest } from './bundle-manifest';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import { TENANT_BACKUP_MAX_SQLITE_DATASETS } from './installed-sqlite-datasets';
import type {
  TenantBackupRestorePlanInventoryPort,
  TenantBackupRestorePlanHead,
} from './restore-plan-inventory';
import { persistSqliteRestoreSequence } from './restore-sqlite-sequence';
import type { SqliteDatasetInspectionPolicy } from './sqlite-dataset-inspector';
import { sqliteDatasetInspectionPolicyDescriptor } from './sqlite-dataset-inspector';
import {
  persistInitializedSqliteRestoreTarget,
  type InitializedSqliteRestoreResource,
} from './sqlite-restore-plan';

export interface TenantBackupSqliteRestorePlanTarget {
  targetId: string;
  resourceId: string;
  provisioningId: string;
  datasets: readonly {
    manifest: TenantBundleManifest;
    policy: SqliteDatasetInspectionPolicy;
    recordCount: number;
    byteCount: number;
  }[];
  initialize(): Promise<InitializedSqliteRestoreResource>;
  assertProvisioningOwnership(): Promise<void>;
}

interface Cursor {
  version: 1;
  sessionId: string;
  inputSetDigest: string;
  planSetDigest: string;
  targetIndex: number;
}
function fail(): never {
  throw new Error('backup_sqlite_restore_plan_step_invalid');
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value))
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function targetSetDigest(targets: readonly TenantBackupSqliteRestorePlanTarget[]) {
  return digest(
    targets.map((target) => ({
      targetId: target.targetId,
      resourceId: target.resourceId,
      provisioningId: target.provisioningId,
      datasets: target.datasets.map(({ manifest, policy, recordCount, byteCount }) => ({
        bundleId: manifest.bundleId,
        ...sqliteDatasetInspectionPolicyDescriptor(policy),
        recordCount,
        byteCount,
      })),
    }))
  );
}
function validateTargets(targets: readonly TenantBackupSqliteRestorePlanTarget[]): void {
  if (!targets.length || targets.length > 64) fail();
  const identities = new Set<string>();
  const placements = new Set<string>();
  let datasets = 0;
  for (const target of targets) {
    if (
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(target.targetId) ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(target.resourceId) ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(target.provisioningId) ||
      !target.datasets.length ||
      target.datasets.some(
        ({ manifest, policy, recordCount, byteCount }) =>
          manifest.source.tenantId.length === 0 ||
          !Number.isSafeInteger(recordCount) ||
          recordCount < 0 ||
          !Number.isSafeInteger(byteCount) ||
          byteCount < 0 ||
          (recordCount === 0) !== (byteCount === 0) ||
          !manifest.datasets.some(
            (item) =>
              item.id === policy.dataset.id &&
              item.store === 'database' &&
              item.disposition === 'include'
          )
      )
    )
      fail();
    if (identities.has(target.targetId) || placements.has(target.resourceId)) fail();
    identities.add(target.targetId);
    placements.add(target.resourceId);
    datasets += target.datasets.length;
  }
  if (datasets > TENANT_BACKUP_MAX_SQLITE_DATASETS) fail();
}

/** Provision and pin one unpublished SQL target per slice, then seal a separate restore plan. */
export async function runTenantBackupSqliteRestorePlanStep(input: {
  context: TenantBackupStepContext;
  inventory: TenantBackupRestorePlanInventoryPort & {
    create(inputInventoryDigest: string): Promise<TenantBackupRestorePlanHead>;
  };
  targets: readonly TenantBackupSqliteRestorePlanTarget[];
  assertInputs(): Promise<void>;
}): Promise<TenantBackupStepResult> {
  const { context } = input;
  if (
    context.operation.kind !== 'import' ||
    context.operation.state !== 'running' ||
    context.operation.phase !== 'prepare_restore_plan' ||
    context.operation.id !== context.lease.operationId ||
    context.operation.tenant_id !== context.lease.tenantId
  )
    fail();
  validateTargets(input.targets);
  let raw: Partial<Cursor> & { version?: unknown; sessionId?: unknown; inputSetDigest?: unknown };
  try {
    raw = JSON.parse(context.operation.cursor_json ?? 'null') as typeof raw;
  } catch {
    return fail();
  }
  if (
    !raw ||
    raw.version !== 1 ||
    typeof raw.sessionId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(raw.sessionId) ||
    typeof raw.inputSetDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.inputSetDigest)
  )
    fail();
  const planSetDigest = await targetSetDigest(input.targets);
  const initial = Object.keys(raw).sort().join(',') === 'inputSetDigest,sessionId,version';
  if (
    !initial &&
    (Object.keys(raw).sort().join(',') !==
      'inputSetDigest,planSetDigest,sessionId,targetIndex,version' ||
      raw.planSetDigest !== planSetDigest ||
      !Number.isSafeInteger(raw.targetIndex) ||
      typeof raw.targetIndex !== 'number' ||
      raw.targetIndex < 0 ||
      raw.targetIndex > input.targets.length + 1)
  )
    fail();
  const cursor: Cursor = {
    version: 1,
    sessionId: raw.sessionId,
    inputSetDigest: raw.inputSetDigest,
    planSetDigest,
    targetIndex: initial ? 0 : Number(raw.targetIndex),
  };
  const guard = async () => {
    context.signal.throwIfAborted();
    await input.assertInputs();
    const head = await input.inventory.headForLease(context.lease);
    if (head.input_inventory_digest !== cursor.inputSetDigest) fail();
    context.signal.throwIfAborted();
    return head;
  };
  await input.assertInputs();
  let head = await input.inventory.create(cursor.inputSetDigest);
  if (head.input_inventory_digest !== cursor.inputSetDigest) fail();

  for (let from = cursor.targetIndex; from < input.targets.length; from += 4) {
    const group = input.targets.slice(from, from + 4);
    const resources = await Promise.all(group.map((target) => target.initialize()));
    for (const [offset, target] of group.entries()) {
      const resource = resources[offset] ?? fail();
      if (
        resource.targetId !== target.targetId ||
        resource.resourceId !== target.resourceId ||
        resource.provisioningId !== target.provisioningId
      )
        fail();
      await persistInitializedSqliteRestoreTarget({
        context,
        inventory: input.inventory,
        ordinal: from + offset,
        resource,
        assertProvisioningOwnership: async () => {
          await target.assertProvisioningOwnership();
          await guard();
        },
      });
      await guard();
    }
  }

  const sequenceOrdinal = input.targets.length;
  await persistSqliteRestoreSequence(
    input.inventory,
    sequenceOrdinal,
    input.targets.flatMap((target, ordinal) =>
      target.datasets.map(({ manifest, policy, recordCount, byteCount }) => ({
        targetId: target.targetId,
        ordinal,
        manifest,
        policy,
        recordCount,
        byteCount,
      }))
    )
  );
  await guard();
  head = await guard();
  const sealed = await input.inventory.seal(head.item_count, head.chain_digest);
  if (sealed.item_count !== sequenceOrdinal + 1) fail();
  await input.assertInputs();
  return {
    phase: 'start_sqlite_restore_sequence',
    cursor: JSON.stringify({
      version: 1,
      sequenceOrdinal,
      jobIndex: 0,
      datasetCursor: null,
      completedRows: [],
      emptyPrepared: false,
    }),
    disposition: 'continue',
  };
}
