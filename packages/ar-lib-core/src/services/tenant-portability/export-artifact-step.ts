import {
  encodeTenantBackupContainerV2,
  type TenantBackupContainerDatasetSourceV2,
} from './backup-container-v2';
import { encodeTenantBundleManifest, type TenantBundleManifest } from './bundle-manifest';
import { loadTenantBackupExportManifest } from './export-manifest-store';
import {
  TenantBackupArtifactWriter,
  writeTenantBackupContainerArtifactV2,
} from './artifact-writer';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';

type WriterArguments = Parameters<typeof TenantBackupArtifactWriter.resume>;
const DATASET_READ_CONCURRENCY = 4;

function fail(): never {
  throw new Error('backup_export_step_cursor');
}

/**
 * Export the pinned T0 snapshot into one v2 container for normal backups. There are no row or
 * event checkpoints. Large artifacts persist only completed capacity parts.
 */
export async function runTenantBackupArtifactStep(
  context: TenantBackupStepContext,
  input: {
    database: WriterArguments[0];
    bucket: WriterArguments[1];
    attemptId: string;
    key: TenantBundleKeyEnvelope;
    now: () => number;
    manifest?: TenantBundleManifest;
    expected: {
      bundleId: string;
      source: TenantBundleManifest['source'];
      selection: TenantBundleManifest['selection'];
      datasets: TenantBundleManifest['datasets'];
    };
    readNext: (
      datasetId: string,
      cursor: string | null,
      signal: AbortSignal,
      manifest?: TenantBundleManifest,
      readSession?: object
    ) => Promise<{ bytes: Uint8Array; nextCursor: string } | null>;
    assertBoundary: () => Promise<void>;
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  signal.throwIfAborted();
  if (
    operation.kind !== 'export' ||
    operation.phase !== 'export_artifact' ||
    operation.state !== 'running' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.expected.source.tenantId !== lease.tenantId
  )
    throw new Error('backup_export_step_context');
  let cursor: { version?: unknown; attemptId?: unknown };
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null') as typeof cursor;
  } catch {
    fail();
  }
  if (cursor?.version !== 2 || cursor.attemptId !== input.attemptId) fail();
  const writer = await TenantBackupArtifactWriter.resume(
    input.database,
    input.bucket,
    input.attemptId,
    lease,
    input.now
  );
  const manifest = await loadTenantBackupExportManifest({
    database: input.database,
    lease,
    attemptId: input.attemptId,
    expected: input.expected,
    now: input.now,
  });
  if (
    input.manifest &&
    new TextDecoder().decode(encodeTenantBundleManifest(input.manifest, input.expected)) !==
      new TextDecoder().decode(encodeTenantBundleManifest(manifest, input.expected))
  )
    throw new Error('backup_export_manifest_changed');

  await input.assertBoundary();
  const datasetChunks: Uint8Array[][] = manifest.datasets.map(() => []);
  const readSession = {};
  let nextDatasetIndex = 0;
  const readDataset = async (index: number): Promise<void> => {
    const descriptor = manifest.datasets[index];
    if (descriptor.disposition !== 'include') return;
    let sourceCursor: string | null = null;
    for (;;) {
      signal.throwIfAborted();
      const next = await input.readNext(descriptor.id, sourceCursor, signal, manifest, readSession);
      if (!next) return;
      if (
        !(next.bytes instanceof Uint8Array) ||
        !next.bytes.length ||
        typeof next.nextCursor !== 'string' ||
        !next.nextCursor ||
        next.nextCursor === sourceCursor
      )
        throw new Error('backup_export_source_invalid');
      sourceCursor = next.nextCursor;
      datasetChunks[index].push(next.bytes);
    }
  };
  const workers = Array.from(
    { length: Math.min(DATASET_READ_CONCURRENCY, manifest.datasets.length) },
    async () => {
      for (;;) {
        const index = nextDatasetIndex++;
        if (index >= manifest.datasets.length) return;
        await readDataset(index);
      }
    }
  );
  await Promise.all(workers);
  const datasets = (async function* (): AsyncGenerator<TenantBackupContainerDatasetSourceV2> {
    for (let index = 0; index < manifest.datasets.length; index++) {
      const descriptor = manifest.datasets[index];
      yield {
        datasetId: descriptor.id,
        chunks: (async function* () {
          yield* datasetChunks[index];
        })(),
      };
    }
  })();
  const salt = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`authrim-backup-container-v2:${input.attemptId}`)
    )
  );
  const container = await encodeTenantBackupContainerV2({
    manifest,
    datasets,
    session: input.key,
    signal,
    streamSalt: salt,
  });
  await input.assertBoundary();
  await writeTenantBackupContainerArtifactV2(writer, container, signal);
  await input.assertBoundary();
  return {
    phase: 'verify_artifact',
    cursor: JSON.stringify({ version: 2, attemptId: input.attemptId }),
    disposition: 'continue',
  };
}
