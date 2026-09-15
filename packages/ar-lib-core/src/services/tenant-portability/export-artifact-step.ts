import { encodeTenantBundleManifest } from './bundle-manifest';
import type { TenantBundleManifest } from './bundle-manifest';
import { loadTenantBackupExportManifest } from './export-manifest-store';
import { TenantBackupArtifactWriter } from './artifact-writer';
import { TenantBackupCipherJournal } from './cipher-journal';
import { writeTenantBackupDatasetSlice } from './resumable-bundle-writer';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';

type WriterArguments = Parameters<typeof TenantBackupArtifactWriter.resume>;
type DatasetInput = Parameters<typeof writeTenantBackupDatasetSlice>[0];

/**
 * Durable export_artifact phase. Preparation must already have persisted the attempt, manifest,
 * source inventory and snapshot boundary. This stage never resolves a different source or creates
 * a replacement attempt implicitly. Verification/publication remain subsequent operation phases.
 */
export async function runTenantBackupArtifactStep(
  context: TenantBackupStepContext,
  input: {
    database: WriterArguments[0];
    bucket: WriterArguments[1];
    attemptId: string;
    key: TenantBundleKeyEnvelope;
    now: () => number;
    manifest?: DatasetInput['manifest'];
    expected: DatasetInput['expected'];
    readNext: (
      datasetId: string,
      cursor: string | null,
      signal: AbortSignal,
      manifest?: TenantBundleManifest
    ) => Promise<{ bytes: Uint8Array; nextCursor: string } | null>;
    assertBoundary: DatasetInput['assertBoundary'];
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
  let cursor: unknown;
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null');
  } catch {
    throw new Error('backup_export_step_cursor');
  }
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    !('version' in cursor) ||
    cursor.version !== 1 ||
    !('attemptId' in cursor) ||
    cursor.attemptId !== input.attemptId
  )
    throw new Error('backup_export_step_cursor');
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
  const journal = await TenantBackupCipherJournal.open(
    input.database,
    writer,
    lease,
    input.now,
    input.key
  );
  const result = await writeTenantBackupDatasetSlice({
    ...input,
    manifest,
    journal,
    signal,
    readNext: (datasetId, cursor, readSignal) =>
      input.readNext(datasetId, cursor, readSignal, manifest),
  });
  return {
    phase: result.complete ? 'verify_artifact' : 'export_artifact',
    cursor: JSON.stringify({ version: 1, attemptId: input.attemptId }),
    disposition: 'continue',
  };
}
