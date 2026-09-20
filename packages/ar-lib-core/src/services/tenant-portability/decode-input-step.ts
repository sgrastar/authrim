import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import { TenantBackupContainerInputStore } from './container-input-store';
import { readTenantBackupContainerV2Input } from './input-container-v2';
import type { TenantBackupInputIdentity } from './input-frame-reader';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import {
  encodeTenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';

function fail(): never {
  throw new Error('backup_decode_input_step_invalid');
}

/** Authenticate one complete v2 input and save one input-level receipt. */
export async function runTenantBackupInputDecodeStep(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'queryOne'>;
    bucket: Parameters<typeof readTenantBackupContainerV2Input>[0]['bucket'];
    identity: TenantBackupInputIdentity;
    session: TenantBundleKeyEnvelope;
    expected: TenantBundleManifestExpectation;
    now: () => number;
    assertPinnedInput: () => Promise<void>;
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'import' ||
    operation.state !== 'running' ||
    operation.phase !== 'decode_input' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.expected.source.tenantId !== lease.tenantId
  )
    fail();
  let cursor: { version?: unknown; bundleId?: unknown };
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null') as typeof cursor;
  } catch {
    fail();
  }
  if (cursor?.version !== 2 || cursor.bundleId !== input.expected.bundleId) fail();
  const authorize = async () => {
    signal.throwIfAborted();
    await input.assertPinnedInput();
    signal.throwIfAborted();
  };
  const decoded = await readTenantBackupContainerV2Input({
    bucket: input.bucket,
    identity: input.identity,
    session: input.session,
    signal,
    assertAuthorized: authorize,
  });
  const expectedManifest = encodeTenantBundleManifest(decoded.manifest.backup, input.expected);
  if (
    new TextDecoder().decode(expectedManifest) !==
      new TextDecoder().decode(
        encodeTenantBundleManifest(decoded.manifest.backup, {
          bundleId: decoded.manifest.backup.bundleId,
          source: decoded.manifest.backup.source,
          selection: decoded.manifest.backup.selection,
          datasets: decoded.manifest.backup.datasets,
        })
      ) ||
    decoded.manifest.datasets.some(
      (dataset, index) => dataset.id !== decoded.manifest.backup.datasets[index]?.id
    )
  )
    fail();
  const store = new TenantBackupContainerInputStore(input.database, lease, input.now);
  await store.save(input.expected.bundleId, input.identity, decoded.manifest);
  await authorize();
  return {
    phase: 'validate_input_modules',
    cursor: JSON.stringify({ version: 2, bundleId: input.expected.bundleId }),
    disposition: 'continue',
  };
}
