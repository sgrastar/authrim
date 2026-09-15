import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext } from './operation-executor';
import type { TenantBackupRestorePlanInventoryPort } from './restore-plan-inventory';
import { readSqliteRestoreSeedFingerprint } from './sqlite-restore-seed';
import { SqliteRestoreTarget, type SqliteRestoreTargetMode } from './sqlite-restore-target';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
export interface InitializedSqliteRestoreResource {
  targetId: string;
  resourceId: string;
  /** Durable provisioning receipt identity; the coordinator checks creation ownership. */
  provisioningId: string;
  database: Database;
  /** Optional trusted scope-aware fingerprint for a logically isolated slice in a shared DB. */
  readSeedFingerprint?: (assertAdmission: () => Promise<void>) => Promise<string>;
}
interface TargetEntry {
  version: 1;
  kind: 'sqlite-restore-target';
  targetId: string;
  resourceId: string;
  provisioningId: string;
  seedFingerprint: string;
}
function invalid(): never {
  throw new Error('backup_restore_plan_invalid');
}
function entry(value: unknown): TargetEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !==
      'kind,provisioningId,resourceId,seedFingerprint,targetId,version' ||
    row.version !== 1 ||
    row.kind !== 'sqlite-restore-target' ||
    ['targetId', 'resourceId', 'provisioningId'].some(
      (key) => typeof row[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(row[key])
    ) ||
    typeof row.seedFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.seedFingerprint)
  )
    invalid();
  return row as unknown as TargetEntry;
}
async function assertOwner(
  context: TenantBackupStepContext,
  inventory: TenantBackupRestorePlanInventoryPort
) {
  context.signal.throwIfAborted();
  const head = await inventory.headForLease(context.lease);
  if (
    context.operation.lease_owner !== context.lease.owner ||
    context.operation.fencing_token !== context.lease.fencingToken ||
    context.operation.kind !== 'import' ||
    context.operation.state !== 'running' ||
    context.operation.id !== context.lease.operationId ||
    context.operation.tenant_id !== context.lease.tenantId ||
    head.operation_id !== context.lease.operationId ||
    head.tenant_id !== context.lease.tenantId
  )
    invalid();
  return head;
}

/**
 * Called once by provisioning, before any target data is imported or routing is published.
 * Pin the initial fingerprint in the durable operation inventory, not a caller-owned checkpoint.
 * The callback must verify the provisioning receipt belongs to this import and holds admission.
 */
export async function persistInitializedSqliteRestoreTarget(input: {
  context: TenantBackupStepContext;
  inventory: TenantBackupRestorePlanInventoryPort;
  ordinal: number;
  resource: InitializedSqliteRestoreResource;
  assertProvisioningOwnership: () => Promise<void>;
}): Promise<void> {
  const resource = { ...input.resource };
  await assertOwner(input.context, input.inventory);
  const guard = async () => {
    await assertOwner(input.context, input.inventory);
    await input.assertProvisioningOwnership();
  };
  const seedFingerprint = await (
    resource.readSeedFingerprint ??
    ((admission) => readSqliteRestoreSeedFingerprint(resource.database, admission))
  )(guard);
  const target = entry({
    version: 1,
    kind: 'sqlite-restore-target',
    targetId: resource.targetId,
    resourceId: resource.resourceId,
    provisioningId: resource.provisioningId,
    seedFingerprint,
  });
  await guard();
  await input.inventory.append(
    input.ordinal,
    `restore-target:${target.targetId}`,
    JSON.stringify(target)
  );
}

/** Resolve and open exactly the unpublished resource recorded in the sealed validated import plan. */
export async function openPlannedSqliteRestoreTarget(input: {
  context: TenantBackupStepContext;
  inventory: TenantBackupRestorePlanInventoryPort;
  ordinal: number;
  targetId: string;
  now: () => number;
  mode?: SqliteRestoreTargetMode;
  resolve: (
    resourceId: string,
    provisioningId: string
  ) => Promise<InitializedSqliteRestoreResource>;
  /** Verifies full input validation and target routing against this exact sealed inventory digest. */
  assertValidatedUnpublishedPlan: (planDigest: string) => Promise<void>;
}): Promise<SqliteRestoreTarget> {
  const head = await assertOwner(input.context, input.inventory);
  if (head.state !== 'sealed') invalid();
  await input.inventory.assertInputValidated(input.context.lease);
  const rows = await input.inventory.readPage(input.ordinal);
  if (
    !rows.length ||
    rows[0].ordinal !== input.ordinal ||
    rows[0].item_id !== `restore-target:${input.targetId}`
  )
    invalid();
  const decoded: unknown = JSON.parse(rows[0].payload_json);
  const target = entry(decoded);
  if (target.targetId !== input.targetId) invalid();
  const planDigest = head.chain_digest;
  const guard = async () => {
    const current = await assertOwner(input.context, input.inventory);
    if (current.state !== 'sealed' || current.chain_digest !== planDigest) invalid();
    await input.inventory.assertInputValidated(input.context.lease);
    await input.assertValidatedUnpublishedPlan(planDigest);
  };
  await guard();
  const resolved = await input.resolve(target.resourceId, target.provisioningId);
  if (
    resolved.resourceId !== target.resourceId ||
    resolved.targetId !== target.targetId ||
    resolved.provisioningId !== target.provisioningId
  )
    invalid();
  await guard();
  const { context } = input;
  if (context.operation.lease_expires_at === null) invalid();
  return SqliteRestoreTarget.open({
    database: resolved.database,
    identity: {
      id: target.targetId,
      tenantId: context.lease.tenantId,
      operationId: context.lease.operationId,
      resourceId: target.resourceId,
      seedFingerprint: target.seedFingerprint,
      planDigest,
    },
    lease: {
      owner: context.lease.owner,
      fencingToken: context.lease.fencingToken,
      expiresAt: context.operation.lease_expires_at,
    },
    now: input.now,
    authorize: guard,
    readSeedFingerprint: resolved.readSeedFingerprint,
    mode: input.mode,
  });
}
