import { decodeTenantBackupContainerV2 } from './backup-container-v2';
import { readTenantBackupArtifact } from './artifact-reader';
import { loadTenantBackupExportManifest } from './export-manifest-store';
import { encodeTenantBundleManifest } from './bundle-manifest';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { DatabaseAdapter } from '../../db/adapter';

interface Bucket {
  get(key: string): Promise<{
    size: number;
    body: {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
        cancel(): Promise<void>;
        releaseLock(): void;
      };
    };
  } | null>;
}

/** Verify R2 receipts, authenticated metadata, footer and every dataset digest once. */
export async function runTenantBackupArtifactVerificationStep(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'queryOne'>;
    bucket: Bucket;
    attemptId: string;
    key: TenantBundleKeyEnvelope;
    expected: Parameters<typeof loadTenantBackupExportManifest>[0]['expected'];
    now: () => number;
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'export' ||
    operation.state !== 'running' ||
    operation.phase !== 'verify_artifact' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.expected.source.tenantId !== lease.tenantId
  )
    throw new Error('backup_verify_step_context');
  let cursor: { version?: unknown; attemptId?: unknown };
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null') as typeof cursor;
  } catch {
    throw new Error('backup_verify_step_cursor');
  }
  if (cursor?.version !== 2 || cursor.attemptId !== input.attemptId)
    throw new Error('backup_verify_step_cursor');
  const attempt = await input.database.queryOne<{ part_count: number; byte_count: number }>(
    "SELECT part_count,byte_count FROM tenant_backup_artifact_attempts WHERE id=? AND tenant_id=? AND state='sealed'",
    [input.attemptId, lease.tenantId]
  );
  if (
    !attempt ||
    !Number.isSafeInteger(attempt.part_count) ||
    attempt.part_count < 1 ||
    !Number.isSafeInteger(attempt.byte_count) ||
    attempt.byte_count < 1
  )
    throw new Error('backup_verify_step_cursor');
  const savedManifest = await loadTenantBackupExportManifest({
    database: input.database,
    lease,
    attemptId: input.attemptId,
    expected: input.expected,
    now: input.now,
  });
  const parts: Uint8Array[] = [];
  let verifiedBytes = 0;
  for await (const part of readTenantBackupArtifact({
    database: input.database,
    bucket: input.bucket,
    lease,
    attemptId: input.attemptId,
    signal,
    now: input.now,
  })) {
    parts.push(part);
    verifiedBytes += part.length;
  }
  if (parts.length !== attempt.part_count || verifiedBytes !== attempt.byte_count)
    throw new Error('backup_verify_step_size');
  const decoded = await decodeTenantBackupContainerV2({ parts, session: input.key });
  if (
    new TextDecoder().decode(
      encodeTenantBundleManifest(decoded.manifest.backup, input.expected)
    ) !== new TextDecoder().decode(encodeTenantBundleManifest(savedManifest, input.expected))
  )
    throw new Error('backup_export_manifest_changed');
  signal.throwIfAborted();
  return {
    phase: 'release_export_resources',
    disposition: 'continue',
    cursor: JSON.stringify({
      version: 2,
      attemptId: input.attemptId,
      nextPart: parts.length,
      verifiedBytes,
    }),
  };
}
