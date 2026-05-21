import type {
  LogChunkCatalogStore,
  LogChunkRecordIndexRow,
  LogObjectCatalogRow,
} from '@authrim/ar-lib-logging/chunks';
import { ensureDatabaseAdapter, type DatabaseAdapter, type DatabaseSource } from '../../db';

interface LogChunkManifestRowInput {
  id: string;
  tenantKey: string;
  logType: string;
  plane: string;
  bucketStartAt: number;
  bucketEndAt: number;
  shard: string;
  manifestObjectKey: string;
  chunkCount: number;
  recordCount: number;
  checksumSha256: string;
  status: 'pending' | 'committed' | 'repair_needed';
  createdAt: number;
  updatedAt: number;
}

interface LogChunkRecordIndexRowInput extends LogChunkRecordIndexRow {
  blockOffset?: number | null;
  blockLength?: number | null;
}

function optionalJson(value: Record<string, unknown> | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

export class SqlLogChunkCatalogStore implements LogChunkCatalogStore {
  private readonly adapter: DatabaseAdapter;

  constructor(db: DatabaseSource) {
    this.adapter = ensureDatabaseAdapter(db, 'logging-chunk-catalog');
  }

  async createPendingObject(row: LogObjectCatalogRow): Promise<void> {
    await this.adapter.execute(
      `INSERT INTO log_object_catalog (
        id, tenant_key, log_type, plane, surface, object_key, object_kind, status,
        record_count, byte_count, checksum_sha256, compression, encryption_scope,
        key_version, created_at, committed_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenantKey,
        row.logType,
        row.plane,
        row.surface ?? null,
        row.objectKey,
        row.objectKind,
        row.status,
        row.recordCount,
        row.byteCount,
        row.checksumSha256 ?? null,
        row.compression,
        row.encryptionScope ?? null,
        row.keyVersion ?? null,
        row.createdAt,
        row.committedAt ?? null,
        null,
      ]
    );
  }

  async createPendingRecordIndexes(rows: LogChunkRecordIndexRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    await this.adapter.batch(
      rows.map((row) => {
        const input = row as LogChunkRecordIndexRowInput;
        return {
          sql: `INSERT INTO log_chunk_record_index (
          record_id, tenant_key, log_type, plane, surface, object_catalog_id, chunk_id,
          line_number, block_offset, block_length, record_offset, record_length,
          event_at, index_profile, indexed_fields, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            row.recordId,
            row.tenantKey,
            row.logType,
            row.plane,
            row.surface ?? null,
            row.objectCatalogId,
            row.chunkId,
            row.lineNumber,
            input.blockOffset ?? null,
            input.blockLength ?? null,
            row.recordOffset,
            row.recordLength,
            row.eventAt,
            row.indexProfile,
            optionalJson(row.indexedFields),
            row.status,
            row.createdAt,
          ],
        };
      })
    );
  }

  async upsertManifest(row: LogChunkManifestRowInput): Promise<void> {
    const update = await this.adapter.execute(
      `UPDATE log_chunk_manifests
       SET id = ?,
           bucket_end_at = ?,
           manifest_object_key = ?,
           chunk_count = ?,
           record_count = ?,
           checksum_sha256 = ?,
           status = ?,
         updated_at = ?
     WHERE tenant_key = ?
       AND log_type = ?
       AND plane = ?
       AND bucket_start_at = ?
       AND shard = ?`,
      [
        row.id,
        row.bucketEndAt,
        row.manifestObjectKey,
        row.chunkCount,
        row.recordCount,
        row.checksumSha256,
        row.status,
        row.updatedAt,
        row.tenantKey,
        row.logType,
        row.plane,
        row.bucketStartAt,
        row.shard,
      ]
    );

    if (update.rowsAffected > 0) {
      return;
    }

    await this.adapter.execute(
      `INSERT INTO log_chunk_manifests (
        id, tenant_key, log_type, plane, bucket_start_at, bucket_end_at, shard,
        manifest_object_key, chunk_count, record_count, checksum_sha256, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenantKey,
        row.logType,
        row.plane,
        row.bucketStartAt,
        row.bucketEndAt,
        row.shard,
        row.manifestObjectKey,
        row.chunkCount,
        row.recordCount,
        row.checksumSha256,
        row.status,
        row.createdAt,
        row.updatedAt,
      ]
    );
  }

  async commitObject(
    id: string,
    update: { byteCount: number; checksumSha256: string; committedAt: number }
  ): Promise<void> {
    await this.adapter.execute(
      `UPDATE log_object_catalog
       SET status = 'committed',
           byte_count = ?,
           checksum_sha256 = ?,
           committed_at = ?
       WHERE id = ? AND status = 'pending'`,
      [update.byteCount, update.checksumSha256, update.committedAt, id]
    );
  }

  async commitRecordIndexes(objectCatalogId: string): Promise<void> {
    await this.adapter.execute(
      `UPDATE log_chunk_record_index
       SET status = 'committed'
       WHERE object_catalog_id = ? AND status = 'pending'`,
      [objectCatalogId]
    );
  }

  async markObjectOrphanCandidate(id: string, failedAt: number): Promise<void> {
    await this.adapter.execute(
      `UPDATE log_object_catalog
       SET status = 'orphan_candidate',
           committed_at = ?
       WHERE id = ? AND status = 'pending'`,
      [failedAt, id]
    );
    await this.adapter.execute(
      `UPDATE log_chunk_record_index
       SET status = 'deleted'
       WHERE object_catalog_id = ? AND status = 'pending'`,
      [id]
    );
  }
}
