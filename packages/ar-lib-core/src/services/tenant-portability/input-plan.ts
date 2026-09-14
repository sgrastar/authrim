import type { TenantBackupStepContext } from './operation-executor';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import type { TenantBackupInputIdentity } from './input-frame-reader';
import type { TenantBundleReadLimits } from './bundle-framing';
import {
  encodeTenantBundleManifest,
  decodeTenantBundleManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';
import { runTenantBackupInputDecodeStep } from './decode-input-step';

export interface TenantBackupPlannedInput {
  version: 1;
  kind: 'backup-input';
  identity: TenantBackupInputIdentity;
  limits: TenantBundleReadLimits;
  manifest: TenantBundleManifest;
}
function fail(): never {
  throw new Error('backup_input_plan_invalid');
}
async function owner(context: TenantBackupStepContext, inventory: TenantBackupExecutionInventory) {
  context.signal.throwIfAborted();
  if (
    context.operation.kind !== 'import' ||
    context.operation.state !== 'running' ||
    context.operation.id !== context.lease.operationId ||
    context.operation.tenant_id !== context.lease.tenantId ||
    context.operation.lease_owner !== context.lease.owner ||
    context.operation.fencing_token !== context.lease.fencingToken
  )
    fail();
  return inventory.headForLease(context.lease);
}
function entry(
  value: TenantBackupPlannedInput,
  expected: TenantBundleManifestExpectation
): TenantBackupPlannedInput {
  if (
    Object.keys(value).sort().join(',') !== 'identity,kind,limits,manifest,version' ||
    value.version !== 1 ||
    value.kind !== 'backup-input' ||
    !value.identity ||
    !value.limits
  )
    fail();
  const { identity, limits } = value;
  if (
    Object.keys(identity).sort().join(',') !== 'etag,key,size,version' ||
    Object.keys(limits).sort().join(',') !== 'maxFrames,maxTotalBytes' ||
    ['key', 'version', 'etag'].some((key) => {
      const item = identity[key as keyof TenantBackupInputIdentity];
      return typeof item !== 'string' || !item || item.length > 1024;
    }) ||
    !Number.isSafeInteger(identity.size) ||
    identity.size < 174 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    identity.size > limits.maxTotalBytes ||
    !Number.isSafeInteger(limits.maxFrames) ||
    limits.maxFrames < 2 ||
    limits.maxFrames > 1000001
  )
    fail();
  const manifest = decodeTenantBundleManifest(
    encodeTenantBundleManifest(value.manifest, expected),
    expected
  );
  return {
    version: 1,
    kind: 'backup-input',
    identity: { ...identity },
    limits: { ...limits },
    manifest,
  };
}

/** Read and revalidate one immutable input from the sealed operation inventory. */
export async function loadPlannedTenantBackupInput(
  context: TenantBackupStepContext,
  inventory: TenantBackupExecutionInventory,
  ordinal: number,
  expected: TenantBundleManifestExpectation
): Promise<TenantBackupPlannedInput> {
  const head = await owner(context, inventory);
  if (head.state !== 'sealed') fail();
  const rows = await inventory.readPage(ordinal);
  const saved = rows[0];
  if (!saved || saved.ordinal !== ordinal || saved.item_id !== `backup-input:${expected.bundleId}`)
    fail();
  return entry(JSON.parse(saved.payload_json) as TenantBackupPlannedInput, expected);
}

/** Upload preparation verifies operation ownership and retention before pinning non-secret metadata. */
export async function persistTenantBackupInput(input: {
  context: TenantBackupStepContext;
  inventory: TenantBackupExecutionInventory;
  ordinal: number;
  identity: TenantBackupInputIdentity;
  limits: TenantBundleReadLimits;
  manifest: TenantBundleManifest;
  expected: TenantBundleManifestExpectation;
  assertUploadOwnership: (identity: Readonly<TenantBackupInputIdentity>) => Promise<void>;
}): Promise<void> {
  const pinned = entry(
    {
      version: 1,
      kind: 'backup-input',
      identity: input.identity,
      limits: input.limits,
      manifest: input.manifest,
    },
    input.expected
  );
  if (pinned.manifest.source.tenantId !== input.context.lease.tenantId) fail();
  await owner(input.context, input.inventory);
  await input.assertUploadOwnership(Object.freeze({ ...pinned.identity }));
  await owner(input.context, input.inventory);
  await input.inventory.append(
    input.ordinal,
    `backup-input:${pinned.manifest.bundleId}`,
    JSON.stringify(pinned)
  );
}

/** Execute exactly the immutable source in this operation's sealed preparation inventory. */
export async function runPlannedTenantBackupInputDecodeStep(
  context: TenantBackupStepContext,
  input: {
    inventory: TenantBackupExecutionInventory;
    ordinal: number;
    expected: TenantBundleManifestExpectation;
  } & Pick<
    Parameters<typeof runTenantBackupInputDecodeStep>[1],
    'database' | 'bucket' | 'session' | 'now'
  >
) {
  const head = await owner(context, input.inventory);
  const pinned = await loadPlannedTenantBackupInput(
    context,
    input.inventory,
    input.ordinal,
    input.expected
  );
  return runTenantBackupInputDecodeStep(context, {
    database: input.database,
    bucket: input.bucket,
    session: input.session,
    now: input.now,
    ...pinned,
    expected: input.expected,
    async assertPinnedInput() {
      const current = await owner(context, input.inventory);
      if (current.state !== 'sealed' || current.chain_digest !== head.chain_digest) fail();
    },
  });
}
