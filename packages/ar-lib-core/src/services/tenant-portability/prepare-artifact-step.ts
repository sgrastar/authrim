import type { TenantBackupBoundaryReceiptsPort } from './boundary-rpc-contract';
import { saveTenantBackupExportManifest } from './export-manifest-store';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import type { BackupBoundaryParticipant } from './boundary-receipts';
import { TenantBackupArtifactWriter } from './artifact-writer';
import {
  encodeTenantBundleManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';
import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';

type WriterInput = Parameters<typeof TenantBackupArtifactWriter.create>;

/** The operation cursor is stored with this bound (operation-store). */
const MAX_CURSOR_LENGTH = 16_384;

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
  /**
   * Stage module state that is listed after the write hold from the boundary snapshots, such as
   * the R2 body plans. Called on every transition of this phase with its own position until done.
   */
  prepareResources?(
    cursor: string | null,
    boundaryUnixMs: number
  ): Promise<{ cursor: string | null; done: boolean }>;
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
    /** Version 2 only: the module preparation position. */
    resources?: string | null;
  };
  if (
    !(
      (cursor.version === 1 && Object.keys(cursor).length === 5) ||
      (cursor.version === 2 &&
        Object.keys(cursor).length === 6 &&
        (cursor.resources === null ||
          (typeof cursor.resources === 'string' && cursor.resources.length > 0)))
    ) ||
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
  if (input.prepareResources) {
    // Re-run on every transition after the receipt and inventory checks above.
    const prepared = await input.prepareResources(cursor.resources ?? null, cursor.releasedAt);
    if (!prepared.done) {
      if (typeof prepared.cursor !== 'string' || !prepared.cursor)
        throw new Error('backup_artifact_preparation_cursor');
      const next = JSON.stringify({
        version: 2,
        boundaryId: cursor.boundaryId,
        inventoryDigest: cursor.inventoryDigest,
        releasedAt: cursor.releasedAt,
        participants: cursor.participants,
        resources: prepared.cursor,
      });
      if (next.length > MAX_CURSOR_LENGTH) throw new Error('backup_artifact_preparation_cursor');
      await guard();
      return { phase: 'prepare_export_artifact', disposition: 'continue', cursor: next };
    }
  } else if (cursor.version !== 1) throw new Error('backup_artifact_preparation_cursor');
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
  await TenantBackupArtifactWriter.createOrResume(
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
  await guard();
  return {
    phase: 'export_artifact',
    disposition: 'continue',
    cursor: JSON.stringify({ version: 2, attemptId }),
  };
}
