import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupLease } from './operation-store';
import {
  encodeTenantBundleManifest,
  decodeTenantBundleManifest,
  type TenantBundleManifest,
  type TenantBundleManifestExpectation,
} from './bundle-manifest';

type Input = {
  database: Pick<DatabaseAdapter, 'queryOne'>;
  lease: TenantBackupLease;
  attemptId: string;
  expected: TenantBundleManifestExpectation;
  now: () => number;
};
const LIVE = `a.id=? AND a.tenant_id=? AND a.operation_id=? AND a.fencing_token<=?
  AND a.state IN ('writing','sealed') AND (a.state='sealed' OR a.fencing_token=o.fencing_token)
  AND o.state='running' AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?`;
function params(input: Input): unknown[] {
  const now = input.now();
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    input.expected.source.tenantId !== input.lease.tenantId
  )
    throw new Error('backup_export_manifest_context');
  return [
    input.attemptId,
    input.lease.tenantId,
    input.lease.operationId,
    input.lease.fencingToken,
    input.lease.owner,
    input.lease.fencingToken,
    now,
    now,
  ];
}
async function hash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function saveTenantBackupExportManifest(
  input: Input & { manifest: TenantBundleManifest }
): Promise<void> {
  const bytes = encodeTenantBundleManifest(input.manifest, input.expected);
  const json = new TextDecoder().decode(bytes);
  const digest = await hash(new Uint8Array(bytes));
  await input.database.queryOne(
    `INSERT INTO tenant_backup_export_manifests(attempt_id,manifest_json,manifest_sha256)
     SELECT a.id,?,? FROM tenant_backup_artifact_attempts a JOIN tenant_backup_operations o
     ON o.id=a.operation_id AND o.tenant_id=a.tenant_id WHERE ${LIVE} AND a.state='writing'
     ON CONFLICT(attempt_id) DO NOTHING RETURNING attempt_id`,
    [json, digest, ...params(input)]
  );
  const saved = await loadTenantBackupExportManifest(input);
  if (new TextDecoder().decode(encodeTenantBundleManifest(saved, input.expected)) !== json)
    throw new Error('backup_export_manifest_changed');
}

/** Revalidate the installed expectation and current lease when loading immutable preparation metadata. */
export async function loadTenantBackupExportManifest(input: Input): Promise<TenantBundleManifest> {
  const row = await input.database.queryOne<{ manifest_json: string; manifest_sha256: string }>(
    `SELECT m.manifest_json,m.manifest_sha256 FROM tenant_backup_export_manifests m
     JOIN tenant_backup_artifact_attempts a ON a.id=m.attempt_id JOIN tenant_backup_operations o
     ON o.id=a.operation_id AND o.tenant_id=a.tenant_id WHERE ${LIVE}`,
    params(input)
  );
  if (!row) throw new Error('backup_export_manifest_unavailable');
  const bytes = new TextEncoder().encode(row.manifest_json);
  if ((await hash(new Uint8Array(bytes))) !== row.manifest_sha256)
    throw new Error('backup_export_manifest_integrity');
  const manifest = decodeTenantBundleManifest(bytes, input.expected);
  if (
    !(await input.database.queryOne(
      `SELECT a.id FROM tenant_backup_artifact_attempts a JOIN tenant_backup_operations o
     ON o.id=a.operation_id AND o.tenant_id=a.tenant_id WHERE ${LIVE}`,
      params(input)
    ))
  )
    throw new Error('backup_export_manifest_unavailable');
  return manifest;
}
