import { describe, expect, it } from 'vitest';
import {
  createObjectCatalogEntry,
  getObjectCatalogObjectRecordByPublicArtifactId,
  getObjectCatalogObjectRecord,
  listObjectCatalogObjects,
  listDeletedObjectCatalogObjects,
  OBJECT_CLASSES,
  OBJECT_KINDS,
  OBJECT_REPRESENTATIONS,
  purgeDeletedObjectCatalogObjects,
  generatePublicArtifactId,
  isObjectClass,
  isObjectKind,
  isObjectRepresentation,
  tombstoneObjectCatalogEntry,
  tombstoneObjectCatalogEntryForTenant,
} from '../object-catalog.ts';

describe('object-catalog helpers', () => {
  it('generates opaque public artifact identifiers', () => {
    const artifactId = generatePublicArtifactId();
    expect(artifactId).toMatch(/^oa_[0-9a-f]{32}$/);
  });

  it('validates known object classes', () => {
    for (const value of OBJECT_CLASSES) {
      expect(isObjectClass(value)).toBe(true);
    }
    expect(isObjectClass('unknown')).toBe(false);
  });

  it('validates known representations and kinds', () => {
    for (const value of OBJECT_REPRESENTATIONS) {
      expect(isObjectRepresentation(value)).toBe(true);
    }
    for (const value of OBJECT_KINDS) {
      expect(isObjectKind(value)).toBe(true);
    }
    expect(isObjectRepresentation('random')).toBe(false);
    expect(isObjectKind('blob')).toBe(false);
  });

  it('creates and resolves logical and physical object catalog records', async () => {
    const state = {
      logical: [] as Array<Record<string, unknown>>,
      physical: [] as Array<Record<string, unknown>>,
    };
    const adapter = {
      execute: async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO object_catalog_objects')) {
          state.physical.push({
            id: params[0],
            catalog_id: params[1],
            representation: params[2],
            object_kind: params[3],
            object_index: params[4],
            bucket_binding: params[5],
            object_key: params[6],
            key_version: params[7],
            checksum_sha256: params[8],
            total_bytes: params[9],
            created_at: params[10],
            deleted_at: null,
          });
        } else if (sql.includes('INSERT INTO object_catalog')) {
          state.logical.push({
            id: params[0],
            public_artifact_id: params[1],
            tenant_id: params[2],
            object_class: params[3],
            created_at: params[4],
            updated_at: params[5],
            deleted_at: null,
          });
        } else if (sql.includes('UPDATE object_catalog_objects')) {
          const deletedAt = params[0] as number;
          const catalogId = params[1];
          state.physical = state.physical.map((row) =>
            row.catalog_id === catalogId ? { ...row, deleted_at: row.deleted_at ?? deletedAt } : row
          );
        } else if (sql.includes('UPDATE object_catalog')) {
          const deletedAt = params[0] as number;
          const updatedAt = params[1] as number;
          const catalogId = params[2];
          state.logical = state.logical.map((row) =>
            row.id === catalogId
              ? { ...row, deleted_at: row.deleted_at ?? deletedAt, updated_at: updatedAt }
              : row
          );
        } else if (sql.includes('DELETE FROM object_catalog_objects')) {
          const physicalId = params[0];
          state.physical = state.physical.filter((row) => row.id !== physicalId);
        } else if (sql.includes('DELETE FROM object_catalog')) {
          state.logical = state.logical.filter((logical) =>
            state.physical.some((physical) => physical.catalog_id === logical.id)
          );
        }
        return { rowsAffected: 1 };
      },
      queryOne: async (_sql: string, params: unknown[]) => {
        const tenantId = params[3];
        const logical =
          state.logical.find(
            (row) => row.id === params[0] && (tenantId === undefined || row.tenant_id === tenantId)
          ) ??
          state.logical.find(
            (row) =>
              row.public_artifact_id === params[0] &&
              (tenantId === undefined || row.tenant_id === tenantId)
          );
        const physical = logical
          ? state.physical.find(
              (row) =>
                row.catalog_id === logical.id &&
                row.representation === params[1] &&
                row.object_index === params[2]
            )
          : null;
        if (!logical || !physical) {
          return null;
        }
        return {
          catalog_id: logical.id,
          public_artifact_id: logical.public_artifact_id,
          tenant_id: logical.tenant_id,
          object_class: logical.object_class,
          catalog_created_at: logical.created_at,
          catalog_updated_at: logical.updated_at,
          catalog_deleted_at: logical.deleted_at,
          physical_id: physical.id,
          representation: physical.representation,
          object_kind: physical.object_kind,
          object_index: physical.object_index,
          bucket_binding: physical.bucket_binding,
          object_key: physical.object_key,
          key_version: physical.key_version,
          checksum_sha256: physical.checksum_sha256,
          total_bytes: physical.total_bytes,
          physical_created_at: physical.created_at,
          physical_deleted_at: physical.deleted_at,
        };
      },
      query: async (_sql: string, params?: unknown[]) => {
        if (
          _sql.includes('FROM object_catalog_objects oco') &&
          _sql.includes('oco.deleted_at IS NOT NULL')
        ) {
          const hasBucketBindingFilter = _sql.includes('AND oco.bucket_binding = ?');
          const bucketBinding = hasBucketBindingFilter ? params?.[0] : undefined;
          return state.physical
            .filter(
              (row) =>
                row.deleted_at !== null &&
                (bucketBinding === undefined || row.bucket_binding === bucketBinding)
            )
            .map((physical) => {
              const logical = state.logical.find((row) => row.id === physical.catalog_id)!;
              return {
                physical_id: physical.id,
                catalog_id: logical.id,
                public_artifact_id: logical.public_artifact_id,
                tenant_id: logical.tenant_id,
                object_class: logical.object_class,
                bucket_binding: physical.bucket_binding,
                object_key: physical.object_key,
                representation: physical.representation,
                object_kind: physical.object_kind,
                object_index: physical.object_index,
                deleted_at: physical.deleted_at,
              };
            });
        }

        const catalogId = params?.[0];
        const representation = params?.[1];
        const logical = state.logical.find((row) => row.id === catalogId);
        if (!logical) {
          return [];
        }

        return state.physical
          .filter(
            (row) =>
              row.catalog_id === catalogId &&
              (representation === undefined || row.representation === representation)
          )
          .map((physical) => ({
            catalog_id: logical.id,
            public_artifact_id: logical.public_artifact_id,
            tenant_id: logical.tenant_id,
            object_class: logical.object_class,
            catalog_created_at: logical.created_at,
            catalog_updated_at: logical.updated_at,
            catalog_deleted_at: logical.deleted_at,
            physical_id: physical.id,
            representation: physical.representation,
            object_kind: physical.object_kind,
            object_index: physical.object_index,
            bucket_binding: physical.bucket_binding,
            object_key: physical.object_key,
            key_version: physical.key_version,
            checksum_sha256: physical.checksum_sha256,
            total_bytes: physical.total_bytes,
            physical_created_at: physical.created_at,
            physical_deleted_at: physical.deleted_at,
          }));
      },
    } as Parameters<typeof createObjectCatalogEntry>[0];

    const { catalogId, publicArtifactId } = await createObjectCatalogEntry(adapter, {
      tenantId: 'tenant-1',
      objectClass: 'user_export',
      objects: [
        {
          representation: 'canonical_json',
          objectKind: 'single',
          bucketBinding: 'EXPORT_ARTIFACTS',
          objectKey: 'exports/tenant-1/report.json',
          keyVersion: 1,
          checksumSha256: 'abc123',
          totalBytes: 128,
        },
      ],
    });

    const record = await getObjectCatalogObjectRecord(adapter, catalogId);
    expect(record).not.toBeNull();
    expect(record?.logical.publicArtifactId).toBe(publicArtifactId);
    expect(record?.logical.objectClass).toBe('user_export');
    expect(record?.physical.bucketBinding).toBe('EXPORT_ARTIFACTS');
    expect(record?.physical.objectKey).toBe('exports/tenant-1/report.json');

    const byPublicId = await getObjectCatalogObjectRecordByPublicArtifactId(
      adapter,
      publicArtifactId
    );
    expect(byPublicId?.logical.id).toBe(catalogId);

    const byTenantPublicId = await getObjectCatalogObjectRecordByPublicArtifactId(
      adapter,
      publicArtifactId,
      'canonical_json',
      0,
      'tenant-1'
    );
    expect(byTenantPublicId?.logical.id).toBe(catalogId);

    const wrongTenantPublicId = await getObjectCatalogObjectRecordByPublicArtifactId(
      adapter,
      publicArtifactId,
      'canonical_json',
      0,
      'tenant-2'
    );
    expect(wrongTenantPublicId).toBeNull();

    const listed = await listObjectCatalogObjects(adapter, catalogId);
    expect(listed?.logical.publicArtifactId).toBe(publicArtifactId);
    expect(listed?.physical).toHaveLength(1);

    await tombstoneObjectCatalogEntryForTenant(adapter, 'tenant-1', catalogId, 1_700_000_123_000);
    const deleted = await listDeletedObjectCatalogObjects(adapter);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.catalogId).toBe(catalogId);
    expect(deleted[0]?.objectKey).toBe('exports/tenant-1/report.json');

    const purged = await purgeDeletedObjectCatalogObjects(adapter, [deleted[0]!.physicalId]);
    expect(purged).toBe(1);
    expect(await listDeletedObjectCatalogObjects(adapter)).toHaveLength(0);
    expect(state.logical).toHaveLength(0);
  });

  it('keeps a platform cleanup tombstone helper for already selected catalog rows', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const adapter = {
      execute: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rowsAffected: 1 };
      },
    } as Parameters<typeof tombstoneObjectCatalogEntry>[0];

    await tombstoneObjectCatalogEntry(adapter, 'catalog-cleanup', 1_700_000_123_000);

    expect(calls[0]?.sql).toContain('WHERE id = ?');
    expect(calls[0]?.params).toEqual([1_700_000_123_000, 1_700_000_123_000, 'catalog-cleanup']);
  });
});
