import type { TenantBackupBoundaryReceiptsPort } from './boundary-rpc-contract';
import { saveTenantBackupExportManifest } from './export-manifest-store';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import type { BackupBoundaryParticipant } from './boundary-receipts';
import { TenantBackupArtifactWriter } from './artifact-writer';
import { TenantBackupCipherJournal } from './cipher-journal';
import { initializeTenantBackupContent } from './resumable-bundle-writer';
import {
  encodeTenantBundleManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';

type WriterInput = Parameters<typeof TenantBackupArtifactWriter.create>;

/** Persist the encrypted manifest before advancing the operation to dataset export. */
export async function runPrepareTenantBackupArtifactStep(input: {
  context: TenantBackupStepContext;
  inventory: TenantBackupExecutionInventory;
  receipts: TenantBackupBoundaryReceiptsPort;
  environmentId: string;
  boundaryTenantId: string;
  database: WriterInput[0];
  bucket: WriterInput[1];
  key: TenantBundleKeyEnvelope;
  manifest: TenantBundleManifest;
  expected: TenantBundleManifestExpectation;
  now(): number;
  /** Verify recorded snapshot ownership, retention and complete module coverage. */
  assertSources(): Promise<void>;
}): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = input.context;
  signal.throwIfAborted();
  if (
    operation.kind !== 'export' ||
    operation.state !== 'running' ||
    operation.phase !== 'prepare_export_artifact' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.expected.source.tenantId !== lease.tenantId
  )
    throw new Error('backup_artifact_preparation_context');
  const head = await input.inventory.headForLease(lease);
  if (head.state !== 'sealed') throw new Error('backup_artifact_preparation_unsealed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(operation.cursor_json ?? 'null');
  } catch {
    throw new Error('backup_artifact_preparation_cursor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('backup_artifact_preparation_cursor');
  const cursor = parsed as {
    version: number;
    boundaryId: string;
    inventoryDigest: string;
    releasedAt: number;
    participants: BackupBoundaryParticipant[];
  };
  if (
    Object.keys(cursor).length !== 5 ||
    cursor.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(cursor.boundaryId) ||
    cursor.inventoryDigest !== head.chain_digest ||
    !Number.isSafeInteger(cursor.releasedAt) ||
    cursor.releasedAt < 0 ||
    !Array.isArray(cursor.participants)
  )
    throw new Error('backup_artifact_preparation_cursor');
  const released = await input.receipts.readReleased(
    {
      environmentId: input.environmentId,
      tenantId: input.boundaryTenantId,
      operationId: operation.id,
      boundaryId: cursor.boundaryId,
      inventoryDigest: head.chain_digest,
    },
    cursor.participants,
    input.now()
  );
  if (
    !released ||
    released.held_at !== cursor.releasedAt ||
    input.manifest.snapshotId !== cursor.boundaryId ||
    input.manifest.boundaryUnixMs !== cursor.releasedAt ||
    input.manifest.inventoryDigestSha256 !== head.chain_digest
  )
    throw new Error('backup_artifact_preparation_boundary');
  const guard = async () => {
    signal.throwIfAborted();
    await input.inventory.headForLease(lease);
    await input.assertSources();
    signal.throwIfAborted();
  };
  await guard();
  encodeTenantBundleManifest(input.manifest, input.expected);
  const keyBundleId = Array.from(input.key.envelope.subarray(1, 17), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  if (keyBundleId !== input.expected.bundleId) throw new Error('backup_artifact_preparation_key');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        'authrim-backup-artifact-v1',
        input.environmentId,
        lease.tenantId,
        operation.id,
        cursor.boundaryId,
      ])
    )
  );
  const attemptId = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const writer = await TenantBackupArtifactWriter.createOrResume(
    input.database,
    input.bucket,
    attemptId,
    lease,
    () => input.now()
  );
  await saveTenantBackupExportManifest({
    database: input.database,
    lease,
    attemptId,
    manifest: input.manifest,
    expected: input.expected,
    now: () => input.now(),
  });
  const journal = await TenantBackupCipherJournal.open(
    input.database,
    writer,
    lease,
    () => input.now(),
    input.key
  );
  await guard();
  await initializeTenantBackupContent({
    journal,
    manifest: input.manifest,
    expected: input.expected,
  });
  await guard();
  return {
    phase: 'export_artifact',
    disposition: 'continue',
    cursor: JSON.stringify({ version: 1, attemptId }),
  };
}
