import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  decodeTenantBundleManifest,
  TENANT_BUNDLE_MANIFEST_MAX_BYTES,
  type TenantBundleManifest,
} from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import { TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES } from '@authrim/ar-lib-core/services/tenant-portability/backup-container-v2';
import { TENANT_BACKUP_ARTIFACT_PART_MAX_BYTES } from '@authrim/ar-lib-core/services/tenant-portability/artifact-writer';
import type { TenantBackupRequestIntent } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import type { TenantBackupExportPublicationReceiptV1 } from '@authrim/ar-lib-core/services/tenant-portability/trusted-export-receipt';

interface Head {
  attempt_id: string;
  expires_at: number;
  part_count: number;
  byte_count: number;
  manifest_json: string;
  manifest_sha256: string;
  inventory_digest: string;
}
interface Part {
  ordinal: number;
  byte_count: number;
  sha256: string;
  uploaded: number;
}
const PAGE_SIZE = 128;
function unavailable(): never {
  throw new Error('backup_export_receipt_unavailable');
}

/** Authorize export/sensitive permissions and fresh human authentication before calling. */
export async function readTenantBackupExportReceipt(input: {
  database: Pick<DatabaseAdapter, 'queryOne' | 'query'>;
  tenantId: string;
  operationId: string;
  intent: TenantBackupRequestIntent;
  now: () => number;
  signal: AbortSignal;
}): Promise<TenantBackupExportPublicationReceiptV1> {
  if (input.intent.kind !== 'export' || input.intent.source.tenantId !== input.tenantId)
    unavailable();
  const head = async () => {
    input.signal.throwIfAborted();
    const now = input.now();
    if (!Number.isSafeInteger(now) || now < 0) unavailable();
    const row = await input.database.queryOne<Head>(
      `SELECT v.attempt_id,v.expires_at,a.part_count,a.byte_count,
       m.manifest_json,m.manifest_sha256,i.chain_digest AS inventory_digest
       FROM tenant_backup_publications v
       JOIN tenant_backup_operations o ON o.id=v.operation_id AND o.tenant_id=v.tenant_id
       JOIN tenant_backup_artifact_attempts a ON a.id=v.attempt_id AND a.tenant_id=v.tenant_id AND a.operation_id=o.id
       JOIN tenant_backup_export_manifests m ON m.attempt_id=a.id
       JOIN tenant_backup_execution_inventories i ON i.operation_id=o.id AND i.tenant_id=o.tenant_id AND i.request_digest=o.request_digest
       WHERE v.operation_id=? AND v.tenant_id=? AND o.kind='export'
       AND o.state='ready' AND o.phase='export_complete' AND a.state='sealed'
       AND i.state='sealed' AND v.published_at<=? AND v.expires_at>?`,
      [input.operationId, input.tenantId, now, now]
    );
    if (
      !row ||
      !Number.isSafeInteger(row.part_count) ||
      row.part_count < 1 ||
      row.part_count > TENANT_BACKUP_CONTAINER_V2_MAX_DATA_FRAMES + 1 ||
      !Number.isSafeInteger(row.byte_count) ||
      row.byte_count < 1 ||
      !Number.isSafeInteger(row.expires_at) ||
      row.expires_at <= now ||
      typeof row.manifest_json !== 'string' ||
      new TextEncoder().encode(row.manifest_json).byteLength > TENANT_BUNDLE_MANIFEST_MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(row.manifest_sha256) ||
      !/^[a-f0-9]{64}$/.test(row.inventory_digest)
    )
      unavailable();
    return row;
  };
  const pinned = await head();
  const bytes = new TextEncoder().encode(pinned.manifest_json);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (digest !== pinned.manifest_sha256) unavailable();
  // This is immutable server-owned preparation metadata, not metadata parsed from the artifact.
  const persisted = JSON.parse(pinned.manifest_json) as TenantBundleManifest;
  const manifest = decodeTenantBundleManifest(bytes, {
    bundleId: persisted.bundleId,
    source: input.intent.source,
    selection: input.intent.selection,
    datasets: persisted.datasets,
  });
  if (
    manifest.inventoryDigestSha256 !== pinned.inventory_digest ||
    manifest.boundaryUnixMs > input.now()
  )
    unavailable();
  const check = async () => {
    const current = await head();
    if (Object.keys(pinned).some((key) => current[key as keyof Head] !== pinned[key as keyof Head]))
      unavailable();
  };
  const parts: { size: number; sha256: string }[] = [];
  let total = 0;
  while (parts.length < pinned.part_count) {
    await check();
    const page = await input.database.query<Part>(
      `SELECT ordinal,byte_count,sha256,uploaded FROM tenant_backup_artifact_parts
       WHERE attempt_id=? AND tenant_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?`,
      [pinned.attempt_id, input.tenantId, parts.length, PAGE_SIZE]
    );
    if (!page.length || page.length > PAGE_SIZE) unavailable();
    for (const part of page) {
      if (
        part.ordinal !== parts.length ||
        parts.length >= pinned.part_count ||
        part.uploaded !== 1 ||
        !Number.isSafeInteger(part.byte_count) ||
        part.byte_count < 1 ||
        part.byte_count > TENANT_BACKUP_ARTIFACT_PART_MAX_BYTES ||
        part.byte_count > pinned.byte_count - total ||
        !/^[a-f0-9]{64}$/.test(part.sha256)
      )
        unavailable();
      parts.push({ size: part.byte_count, sha256: part.sha256 });
      total += part.byte_count;
    }
  }
  if (
    total !== pinned.byte_count ||
    (await input.database.queryOne(
      'SELECT ordinal FROM tenant_backup_artifact_parts WHERE attempt_id=? AND tenant_id=? AND ordinal>=? LIMIT 1',
      [pinned.attempt_id, input.tenantId, pinned.part_count]
    ))
  )
    unavailable();
  await check();
  return {
    formatVersion: 1,
    operationId: input.operationId,
    expiresAt: pinned.expires_at,
    byteCount: total,
    boundaryUnixMs: manifest.boundaryUnixMs,
    receipt: {
      source: manifest.source,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      parts,
    },
    selection: manifest.selection,
    datasets: manifest.datasets,
  };
}
