import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBackupContainerManifestV2 } from './backup-container-v2';
import { TenantBackupContainerInputStore } from './container-input-store';
import {
  initialTenantBackupContainerVerificationProgress,
  parseTenantBackupContainerVerificationProgress,
  verifyTenantBackupContainerV2Slice,
  type TenantBackupContainerVerificationBudget,
  type TenantBackupContainerVerificationProgress,
} from './input-container-verification';
import { TenantBackupInputFrameStore } from './input-frame-index';
import type { TenantBackupInputIdentity } from './input-frame-reader';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import {
  encodeTenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';
import {
  PinnedTenantBackupInputObject,
  type TenantBackupContainerInputBucketV2,
} from './pinned-input-object';

function fail(): never {
  throw new Error('backup_decode_input_step_invalid');
}

interface DecodeCursor {
  version: 2;
  bundleId: string;
  progress?: TenantBackupContainerVerificationProgress;
}

function decodeCursor(raw: string | null, bundleId: string): DecodeCursor {
  let cursor: DecodeCursor;
  try {
    cursor = JSON.parse(raw ?? 'null') as DecodeCursor;
  } catch {
    return fail();
  }
  const keys = Object.keys(cursor ?? {})
    .sort()
    .join(',');
  if (
    cursor?.version !== 2 ||
    cursor.bundleId !== bundleId ||
    (keys !== 'bundleId,version' && keys !== 'bundleId,progress,version')
  )
    fail();
  if (cursor.progress !== undefined)
    cursor.progress = parseTenantBackupContainerVerificationProgress(cursor.progress);
  return cursor;
}

function assertExpectedManifest(
  manifest: TenantBackupContainerManifestV2,
  expected: TenantBundleManifestExpectation
): void {
  const expectedManifest = encodeTenantBundleManifest(manifest.backup, expected);
  if (
    new TextDecoder().decode(expectedManifest) !==
      new TextDecoder().decode(
        encodeTenantBundleManifest(manifest.backup, {
          bundleId: manifest.backup.bundleId,
          source: manifest.backup.source,
          selection: manifest.backup.selection,
          datasets: manifest.backup.datasets,
        })
      ) ||
    manifest.datasets.some((dataset, index) => dataset.id !== manifest.backup.datasets[index]?.id)
  )
    fail();
}

/**
 * Authenticate one v2 input frame by frame and record its frame index. Large inputs take several
 * transitions; the cursor carries the walk position or the hash midstates. The input-level receipt
 * is saved only after every frame, the metadata and all hashes verified.
 */
export async function runTenantBackupInputDecodeStep(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'> &
      Partial<Pick<DatabaseAdapter, 'batch'>>;
    bucket: TenantBackupContainerInputBucketV2;
    identity: TenantBackupInputIdentity;
    session: TenantBundleKeyEnvelope;
    expected: TenantBundleManifestExpectation;
    now: () => number;
    assertPinnedInput: () => Promise<void>;
    budget?: TenantBackupContainerVerificationBudget;
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
  const bundleId = input.expected.bundleId;
  const cursor = decodeCursor(operation.cursor_json, bundleId);
  const authorize = async () => {
    signal.throwIfAborted();
    await input.assertPinnedInput();
    signal.throwIfAborted();
  };
  await authorize();
  const frames = new TenantBackupInputFrameStore(input.database, lease, input.now);
  const slice = await verifyTenantBackupContainerV2Slice({
    object: new PinnedTenantBackupInputObject({
      bucket: input.bucket,
      identity: input.identity,
      signal,
      assertAuthorized: authorize,
    }),
    session: input.session,
    progress: cursor.progress ?? initialTenantBackupContainerVerificationProgress(),
    loadFrames: (from, count) => frames.range(bundleId, from, count),
    saveFrames: (saved) => frames.save(bundleId, saved),
    acceptManifest: (manifest) => assertExpectedManifest(manifest, input.expected),
    budget: input.budget,
    signal,
  });
  await authorize();
  if (!slice.done)
    return {
      phase: 'decode_input',
      cursor: JSON.stringify({ version: 2, bundleId, progress: slice.progress }),
      disposition: 'continue',
    };
  const store = new TenantBackupContainerInputStore(input.database, lease, input.now);
  await store.save(bundleId, input.identity, slice.manifest);
  await authorize();
  return {
    phase: 'validate_input_modules',
    cursor: JSON.stringify({ version: 2, bundleId }),
    disposition: 'continue',
  };
}
