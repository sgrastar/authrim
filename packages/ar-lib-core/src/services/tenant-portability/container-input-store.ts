import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupContainerManifestV2 } from './backup-container-v2';
import type { TenantBackupInputIdentity } from './input-frame-reader';
import type { TenantBackupLease } from './operation-store';

interface Saved {
  object_key: string;
  object_version: string;
  object_etag: string;
  object_size: number;
  manifest_sha256: string;
  dataset_stats_json: string;
}

function fail(): never {
  throw new Error('backup_container_input_store_invalid');
}

async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
}

/** Durable input-level verification; no row, event or empty-dataset checkpoints. */
export class TenantBackupContainerInputStore {
  constructor(
    private readonly database: Pick<DatabaseAdapter, 'queryOne'>,
    private readonly lease: TenantBackupLease,
    private readonly now: () => number
  ) {}

  async save(
    bundleId: string,
    identity: Readonly<TenantBackupInputIdentity>,
    manifest: TenantBackupContainerManifestV2
  ): Promise<void> {
    const timestamp = this.now();
    const stats = JSON.stringify({
      formatVersion: 2,
      datasets: manifest.datasets,
      registeredDatasets: manifest.backup.datasets.map((dataset) => ({
        id: dataset.id,
        module: dataset.module,
        kind: dataset.kind,
        store: dataset.store,
        schemaVersion: dataset.schemaVersion,
        disposition: dataset.disposition,
      })),
      totalRows: manifest.totalRows,
      totalBytes: manifest.totalBytes,
      dataSha256: manifest.dataSha256,
    });
    const manifestSha256 = await digest(JSON.stringify(manifest.backup));
    if (
      !/^[a-f0-9]{32}$/.test(bundleId) ||
      !identity.key ||
      !identity.version ||
      !identity.etag ||
      !Number.isSafeInteger(identity.size) ||
      identity.size < 1 ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0
    )
      fail();
    await this.database.queryOne(
      `INSERT INTO tenant_backup_container_inputs
      (operation_id,tenant_id,bundle_id,object_key,object_version,object_etag,object_size,manifest_sha256,dataset_stats_json,verified_at)
      SELECT o.id,o.tenant_id,?,?,?,?,?,?,?,? FROM tenant_backup_operations o
      WHERE o.id=? AND o.tenant_id=? AND o.kind='import' AND o.state='running'
      AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>? AND o.updated_at<=?
      ON CONFLICT(operation_id,bundle_id) DO NOTHING RETURNING bundle_id`,
      [
        bundleId,
        identity.key,
        identity.version,
        identity.etag,
        identity.size,
        manifestSha256,
        stats,
        timestamp,
        this.lease.operationId,
        this.lease.tenantId,
        this.lease.owner,
        this.lease.fencingToken,
        timestamp,
        timestamp,
      ]
    );
    const saved = await this.load(bundleId);
    if (
      saved.object_key !== identity.key ||
      saved.object_version !== identity.version ||
      saved.object_etag !== identity.etag ||
      saved.object_size !== identity.size ||
      saved.manifest_sha256 !== manifestSha256 ||
      saved.dataset_stats_json !== stats
    )
      fail();
  }

  async load(bundleId: string): Promise<Saved> {
    const timestamp = this.now();
    if (!/^[a-f0-9]{32}$/.test(bundleId) || !Number.isSafeInteger(timestamp) || timestamp < 0)
      fail();
    const saved = await this.database.queryOne<Saved>(
      `SELECT c.object_key,c.object_version,c.object_etag,c.object_size,c.manifest_sha256,c.dataset_stats_json
      FROM tenant_backup_container_inputs c JOIN tenant_backup_operations o
      ON o.id=c.operation_id AND o.tenant_id=c.tenant_id
      WHERE c.operation_id=? AND c.tenant_id=? AND c.bundle_id=? AND o.kind='import'
      AND o.state='running' AND o.lease_owner=? AND o.fencing_token=?
      AND o.lease_expires_at>? AND o.updated_at<=?`,
      [
        this.lease.operationId,
        this.lease.tenantId,
        bundleId,
        this.lease.owner,
        this.lease.fencingToken,
        timestamp,
        timestamp,
      ]
    );
    if (!saved) fail();
    return saved;
  }
}
