import { loadTenantBackupExportManifest } from './export-manifest-store';
import { encodeTenantBundleManifest } from './bundle-manifest';
import { verifyTenantBackupArtifactPart } from './artifact-verification';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';

type PartInput = Parameters<typeof verifyTenantBackupArtifactPart>[0];
/** Transport/content integrity only. Module coverage and snapshot readiness gate publication. */
export async function runTenantBackupArtifactVerificationStep(
  context: TenantBackupStepContext,
  input: Omit<PartInput, 'lease' | 'signal' | 'ordinal' | 'manifest'> & {
    manifest?: PartInput['manifest'];
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
  let cursor: { version: number; attemptId: string; nextPart?: number; verifiedBytes?: number };
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null') as typeof cursor;
  } catch {
    throw new Error('backup_verify_step_cursor');
  }
  if (!cursor || cursor.version !== 1 || cursor.attemptId !== input.attemptId)
    throw new Error('backup_verify_step_cursor');
  const ordinal = cursor.nextPart ?? 0,
    total = cursor.verifiedBytes ?? 0;
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    (ordinal === 0) !== (total === 0)
  )
    throw new Error('backup_verify_step_cursor');
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
  const result = await verifyTenantBackupArtifactPart({
    ...input,
    manifest,
    lease,
    signal,
    ordinal,
  });
  const verifiedBytes = total + result.bytes;
  if (verifiedBytes > result.totalBytes || (result.complete && verifiedBytes !== result.totalBytes))
    throw new Error('backup_verify_step_size');
  if (result.complete) {
    const extra = await input.database.queryOne(
      'SELECT ordinal FROM tenant_backup_artifact_parts WHERE attempt_id=? AND tenant_id=? AND ordinal>=? LIMIT 1',
      [input.attemptId, lease.tenantId, result.nextPart]
    );
    if (extra) throw new Error('backup_verify_step_extra_part');
  }
  signal.throwIfAborted();
  return {
    phase: result.complete ? 'release_export_resources' : 'verify_artifact',
    disposition: 'continue',
    cursor: JSON.stringify({
      version: 1,
      attemptId: input.attemptId,
      nextPart: result.nextPart,
      verifiedBytes,
    }),
  };
}
