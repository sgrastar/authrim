import type { TenantBackupStepContext } from './operation-executor';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import type { TenantBackupInputIdentity } from './input-frame-reader';
import type { TenantBundleReadLimits } from './bundle-framing';
import {
  decodeTenantBundleImportManifest,
  encodeTenantBundleImportManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';
import { tenantBackupSelectionsCover } from './selection-contract';
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
  const manifest = decodeTenantBundleImportManifest(
    encodeTenantBundleImportManifest(value.manifest, expected),
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

/** Revalidate the complete immutable input set and its combined category coverage. */
export async function loadPlannedTenantBackupInputs(
  context: TenantBackupStepContext,
  inventory: TenantBackupExecutionInventory,
  expected: Omit<TenantBundleManifestExpectation, 'bundleId'>
): Promise<TenantBackupPlannedInput[]> {
  const head = await owner(context, inventory);
  if (head.state !== 'sealed' || head.item_count < 1 || head.item_count > 32) fail();
  const inputs: TenantBackupPlannedInput[] = [];
  for (let ordinal = 0; ordinal < head.item_count; ordinal += 1) {
    const saved = (await inventory.readPage(ordinal))[0];
    const prefix = 'backup-input:';
    const bundleId = saved?.item_id.startsWith(prefix) ? saved.item_id.slice(prefix.length) : '';
    if (!saved || saved.ordinal !== ordinal || !/^[a-f0-9]{32}$/.test(bundleId)) fail();
    inputs.push(
      entry(JSON.parse(saved.payload_json) as TenantBackupPlannedInput, {
        bundleId,
        source: expected.source,
        selection: expected.selection,
        datasets: expected.datasets,
      })
    );
  }
  if (
    !tenantBackupSelectionsCover(
      expected.selection,
      inputs.map(({ manifest }) => manifest.selection)
    ) ||
    expected.datasets.some(
      ({ id }) =>
        !inputs.some(({ manifest }) => manifest.datasets.some((dataset) => dataset.id === id))
    )
  )
    fail();
  await owner(context, inventory);
  return inputs;
}

/** Newest bundle owns an overlapping dataset; dependency validation still spans all owners. */
export function tenantBackupInputDatasetOwners(
  inputs: readonly TenantBackupPlannedInput[]
): ReadonlyMap<string, string> {
  const owners = new Map<string, { bundleId: string; boundaryUnixMs: number; ordinal: number }>();
  inputs.forEach(({ manifest }, ordinal) => {
    for (const { id } of manifest.datasets) {
      const current = owners.get(id);
      if (
        !current ||
        manifest.boundaryUnixMs > current.boundaryUnixMs ||
        (manifest.boundaryUnixMs === current.boundaryUnixMs && ordinal > current.ordinal)
      )
        owners.set(id, {
          bundleId: manifest.bundleId,
          boundaryUnixMs: manifest.boundaryUnixMs,
          ordinal,
        });
    }
  });
  return new Map([...owners].map(([datasetId, value]) => [datasetId, value.bundleId]));
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
  const exactExpected: TenantBundleManifestExpectation = {
    bundleId: pinned.manifest.bundleId,
    source: pinned.manifest.source,
    selection: pinned.manifest.selection,
    datasets: pinned.manifest.datasets,
  };
  return runTenantBackupInputDecodeStep(context, {
    database: input.database,
    bucket: input.bucket,
    session: input.session,
    now: input.now,
    ...pinned,
    expected: exactExpected,
    async assertPinnedInput() {
      const current = await owner(context, input.inventory);
      if (current.state !== 'sealed' || current.chain_digest !== head.chain_digest) fail();
    },
  });
}
