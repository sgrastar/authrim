import type { DatabaseAdapter } from '../db/adapter';

export const OBJECT_CLASSES = [
  'admin_audit_detail',
  'webhook_delivery_payload',
  'operational_log_detail',
  'user_export',
  'user_import_input',
  'user_import_result',
  'approval_transport_detail',
] as const;

export type ObjectClass = (typeof OBJECT_CLASSES)[number];

export const OBJECT_REPRESENTATIONS = [
  'canonical_json',
  'csv_projection',
  'ndjson_projection',
  'zip_bundle',
] as const;

export type ObjectRepresentation = (typeof OBJECT_REPRESENTATIONS)[number];

export const OBJECT_KINDS = ['single', 'manifest', 'chunk'] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];
export type ObjectCatalogBucketBinding =
  | 'EXPORT_ARTIFACTS'
  | 'IMPORT_ARTIFACTS'
  | 'SENSITIVE_DETAILS';

export interface ObjectCatalogLogicalRecord {
  id: string;
  publicArtifactId: string;
  tenantId: string;
  objectClass: ObjectClass;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export interface ObjectCatalogPhysicalRecord {
  id: string;
  catalogId: string;
  representation: ObjectRepresentation;
  objectKind: ObjectKind;
  bucketBinding: ObjectCatalogBucketBinding;
  objectKey: string;
  chunkIndex?: number | null;
  keyVersion: number;
  checksumSha256?: string | null;
  totalBytes?: number | null;
  createdAt: number;
  deletedAt?: number | null;
}

export interface CreateObjectCatalogObjectInput {
  representation: ObjectRepresentation;
  objectKind: ObjectKind;
  bucketBinding: ObjectCatalogBucketBinding;
  objectKey: string;
  objectIndex?: number | null;
  keyVersion: number;
  checksumSha256?: string | null;
  totalBytes?: number | null;
}

export interface CreateObjectCatalogInput {
  id?: string;
  publicArtifactId?: string;
  tenantId: string;
  objectClass: ObjectClass;
  createdAt?: number;
  objects: CreateObjectCatalogObjectInput[];
}

export interface UpdateObjectCatalogObjectInput {
  catalogId: string;
  representation?: ObjectRepresentation;
  objectIndex?: number;
  bucketBinding?: ObjectCatalogBucketBinding;
  objectKey?: string;
  keyVersion: number;
  checksumSha256?: string | null;
  totalBytes?: number | null;
  updatedAt?: number;
}

export interface ObjectCatalogLookupResult {
  logical: ObjectCatalogLogicalRecord;
  physical: ObjectCatalogPhysicalRecord;
}

export interface ObjectCatalogListResult {
  logical: ObjectCatalogLogicalRecord;
  physical: ObjectCatalogPhysicalRecord[];
}

export interface DeletedObjectCatalogPhysicalRecord {
  physicalId: string;
  catalogId: string;
  publicArtifactId: string;
  tenantId: string;
  objectClass: ObjectClass;
  bucketBinding: ObjectCatalogBucketBinding;
  objectKey: string;
  representation: ObjectRepresentation;
  objectKind: ObjectKind;
  chunkIndex: number | null;
  deletedAt: number;
}

export function generatePublicArtifactId(): string {
  return `oa_${crypto.randomUUID().replace(/-/g, '')}`;
}

function generateCatalogRowId(): string {
  return crypto.randomUUID();
}

export async function createObjectCatalogEntry(
  adapter: DatabaseAdapter,
  input: CreateObjectCatalogInput
): Promise<{ catalogId: string; publicArtifactId: string }> {
  const now = input.createdAt ?? Date.now();
  const catalogId = input.id ?? generateCatalogRowId();
  const publicArtifactId = input.publicArtifactId ?? generatePublicArtifactId();

  await adapter.execute(
    `INSERT INTO object_catalog (
      id,
      public_artifact_id,
      tenant_id,
      object_class,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [catalogId, publicArtifactId, input.tenantId, input.objectClass, now, now]
  );

  for (const object of input.objects) {
    await adapter.execute(
      `INSERT INTO object_catalog_objects (
        id,
        catalog_id,
        representation,
        object_kind,
        object_index,
        bucket_binding,
        object_key,
        key_version,
        checksum_sha256,
        total_bytes,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateCatalogRowId(),
        catalogId,
        object.representation,
        object.objectKind,
        object.objectIndex ?? 0,
        object.bucketBinding,
        object.objectKey,
        object.keyVersion,
        object.checksumSha256 ?? null,
        object.totalBytes ?? null,
        now,
      ]
    );
  }

  return {
    catalogId,
    publicArtifactId,
  };
}

export async function updateObjectCatalogObject(
  adapter: DatabaseAdapter,
  input: UpdateObjectCatalogObjectInput
): Promise<void> {
  const now = input.updatedAt ?? Date.now();

  await adapter.execute(
    `UPDATE object_catalog_objects
     SET bucket_binding = COALESCE(?, bucket_binding),
         object_key = COALESCE(?, object_key),
         key_version = ?,
         checksum_sha256 = ?,
         total_bytes = ?
     WHERE catalog_id = ?
       AND representation = ?
       AND object_index = ?
       AND deleted_at IS NULL`,
    [
      input.bucketBinding ?? null,
      input.objectKey ?? null,
      input.keyVersion,
      input.checksumSha256 ?? null,
      input.totalBytes ?? null,
      input.catalogId,
      input.representation ?? 'canonical_json',
      input.objectIndex ?? 0,
    ]
  );

  await adapter.execute(
    `UPDATE object_catalog
     SET updated_at = ?
     WHERE id = ?
       AND deleted_at IS NULL`,
    [now, input.catalogId]
  );
}

export async function getObjectCatalogObjectRecord(
  adapter: DatabaseAdapter,
  catalogId: string,
  representation: ObjectRepresentation = 'canonical_json',
  objectIndex: number = 0
): Promise<ObjectCatalogLookupResult | null> {
  const row = await adapter.queryOne<{
    catalog_id: string;
    public_artifact_id: string;
    tenant_id: string;
    object_class: string;
    catalog_created_at: number;
    catalog_updated_at: number;
    catalog_deleted_at: number | null;
    physical_id: string;
    representation: string;
    object_kind: string;
    object_index: number;
    bucket_binding: ObjectCatalogBucketBinding;
    object_key: string;
    key_version: number;
    checksum_sha256: string | null;
    total_bytes: number | null;
    physical_created_at: number;
    physical_deleted_at: number | null;
  }>(
    `SELECT
      oc.id AS catalog_id,
      oc.public_artifact_id,
      oc.tenant_id,
      oc.object_class,
      oc.created_at AS catalog_created_at,
      oc.updated_at AS catalog_updated_at,
      oc.deleted_at AS catalog_deleted_at,
      oco.id AS physical_id,
      oco.representation,
      oco.object_kind,
      oco.object_index,
      oco.bucket_binding,
      oco.object_key,
      oco.key_version,
      oco.checksum_sha256,
      oco.total_bytes,
      oco.created_at AS physical_created_at,
      oco.deleted_at AS physical_deleted_at
    FROM object_catalog oc
    INNER JOIN object_catalog_objects oco ON oco.catalog_id = oc.id
    WHERE oc.id = ?
      AND oc.deleted_at IS NULL
      AND oco.deleted_at IS NULL
      AND oco.representation = ?
      AND oco.object_index = ?
    LIMIT 1`,
    [catalogId, representation, objectIndex]
  );

  if (!row || !isObjectClass(row.object_class) || !isObjectRepresentation(row.representation) || !isObjectKind(row.object_kind)) {
    return null;
  }

  return {
    logical: {
      id: row.catalog_id,
      publicArtifactId: row.public_artifact_id,
      tenantId: row.tenant_id,
      objectClass: row.object_class,
      createdAt: row.catalog_created_at,
      updatedAt: row.catalog_updated_at,
      deletedAt: row.catalog_deleted_at,
    },
    physical: {
      id: row.physical_id,
      catalogId: row.catalog_id,
      representation: row.representation,
      objectKind: row.object_kind,
      bucketBinding: row.bucket_binding,
      objectKey: row.object_key,
      chunkIndex: row.object_index,
      keyVersion: row.key_version,
      checksumSha256: row.checksum_sha256,
      totalBytes: row.total_bytes,
      createdAt: row.physical_created_at,
      deletedAt: row.physical_deleted_at,
    },
  };
}

export async function listObjectCatalogObjects(
  adapter: DatabaseAdapter,
  catalogId: string,
  representation?: ObjectRepresentation
): Promise<ObjectCatalogListResult | null> {
  const rows = await adapter.query<{
    catalog_id: string;
    public_artifact_id: string;
    tenant_id: string;
    object_class: string;
    catalog_created_at: number;
    catalog_updated_at: number;
    catalog_deleted_at: number | null;
    physical_id: string;
    representation: string;
    object_kind: string;
    object_index: number;
    bucket_binding: ObjectCatalogBucketBinding;
    object_key: string;
    key_version: number;
    checksum_sha256: string | null;
    total_bytes: number | null;
    physical_created_at: number;
    physical_deleted_at: number | null;
  }>(
    `SELECT
      oc.id AS catalog_id,
      oc.public_artifact_id,
      oc.tenant_id,
      oc.object_class,
      oc.created_at AS catalog_created_at,
      oc.updated_at AS catalog_updated_at,
      oc.deleted_at AS catalog_deleted_at,
      oco.id AS physical_id,
      oco.representation,
      oco.object_kind,
      oco.object_index,
      oco.bucket_binding,
      oco.object_key,
      oco.key_version,
      oco.checksum_sha256,
      oco.total_bytes,
      oco.created_at AS physical_created_at,
      oco.deleted_at AS physical_deleted_at
    FROM object_catalog oc
    INNER JOIN object_catalog_objects oco ON oco.catalog_id = oc.id
    WHERE oc.id = ?
      AND oc.deleted_at IS NULL
      AND oco.deleted_at IS NULL
      ${representation ? 'AND oco.representation = ?' : ''}
    ORDER BY oco.representation ASC, oco.object_index ASC`,
    representation ? [catalogId, representation] : [catalogId]
  );

  if (rows.length === 0) {
    return null;
  }

  const first = rows[0];
  if (!isObjectClass(first.object_class)) {
    return null;
  }

  const physical = rows
    .filter((row) => isObjectRepresentation(row.representation) && isObjectKind(row.object_kind))
    .map<ObjectCatalogPhysicalRecord>((row) => ({
      id: row.physical_id,
      catalogId: row.catalog_id,
      representation: row.representation as ObjectRepresentation,
      objectKind: row.object_kind as ObjectKind,
      bucketBinding: row.bucket_binding,
      objectKey: row.object_key,
      chunkIndex: row.object_index,
      keyVersion: row.key_version,
      checksumSha256: row.checksum_sha256,
      totalBytes: row.total_bytes,
      createdAt: row.physical_created_at,
      deletedAt: row.physical_deleted_at,
    }));

  if (physical.length === 0) {
    return null;
  }

  return {
    logical: {
      id: first.catalog_id,
      publicArtifactId: first.public_artifact_id,
      tenantId: first.tenant_id,
      objectClass: first.object_class,
      createdAt: first.catalog_created_at,
      updatedAt: first.catalog_updated_at,
      deletedAt: first.catalog_deleted_at,
    },
    physical,
  };
}

export async function getObjectCatalogObjectRecordByPublicArtifactId(
  adapter: DatabaseAdapter,
  publicArtifactId: string,
  representation: ObjectRepresentation = 'canonical_json',
  objectIndex: number = 0
): Promise<ObjectCatalogLookupResult | null> {
  const row = await adapter.queryOne<{
    catalog_id: string;
    public_artifact_id: string;
    tenant_id: string;
    object_class: string;
    catalog_created_at: number;
    catalog_updated_at: number;
    catalog_deleted_at: number | null;
    physical_id: string;
    representation: string;
    object_kind: string;
    object_index: number;
    bucket_binding: ObjectCatalogBucketBinding;
    object_key: string;
    key_version: number;
    checksum_sha256: string | null;
    total_bytes: number | null;
    physical_created_at: number;
    physical_deleted_at: number | null;
  }>(
    `SELECT
      oc.id AS catalog_id,
      oc.public_artifact_id,
      oc.tenant_id,
      oc.object_class,
      oc.created_at AS catalog_created_at,
      oc.updated_at AS catalog_updated_at,
      oc.deleted_at AS catalog_deleted_at,
      oco.id AS physical_id,
      oco.representation,
      oco.object_kind,
      oco.object_index,
      oco.bucket_binding,
      oco.object_key,
      oco.key_version,
      oco.checksum_sha256,
      oco.total_bytes,
      oco.created_at AS physical_created_at,
      oco.deleted_at AS physical_deleted_at
    FROM object_catalog oc
    INNER JOIN object_catalog_objects oco ON oco.catalog_id = oc.id
    WHERE oc.public_artifact_id = ?
      AND oc.deleted_at IS NULL
      AND oco.deleted_at IS NULL
      AND oco.representation = ?
      AND oco.object_index = ?
    LIMIT 1`,
    [publicArtifactId, representation, objectIndex]
  );

  if (!row || !isObjectClass(row.object_class) || !isObjectRepresentation(row.representation) || !isObjectKind(row.object_kind)) {
    return null;
  }

  return {
    logical: {
      id: row.catalog_id,
      publicArtifactId: row.public_artifact_id,
      tenantId: row.tenant_id,
      objectClass: row.object_class,
      createdAt: row.catalog_created_at,
      updatedAt: row.catalog_updated_at,
      deletedAt: row.catalog_deleted_at,
    },
    physical: {
      id: row.physical_id,
      catalogId: row.catalog_id,
      representation: row.representation,
      objectKind: row.object_kind,
      bucketBinding: row.bucket_binding,
      objectKey: row.object_key,
      chunkIndex: row.object_index,
      keyVersion: row.key_version,
      checksumSha256: row.checksum_sha256,
      totalBytes: row.total_bytes,
      createdAt: row.physical_created_at,
      deletedAt: row.physical_deleted_at,
    },
  };
}

export async function tombstoneObjectCatalogEntry(
  adapter: DatabaseAdapter,
  catalogId: string,
  deletedAt: number = Date.now()
): Promise<void> {
  await adapter.execute(
    `UPDATE object_catalog
     SET deleted_at = COALESCE(deleted_at, ?),
         updated_at = ?
     WHERE id = ?`,
    [deletedAt, deletedAt, catalogId]
  );

  await adapter.execute(
    `UPDATE object_catalog_objects
     SET deleted_at = COALESCE(deleted_at, ?)
     WHERE catalog_id = ?`,
    [deletedAt, catalogId]
  );
}

export async function listDeletedObjectCatalogObjects(
  adapter: DatabaseAdapter,
  options?: {
    bucketBinding?: ObjectCatalogBucketBinding;
    deletedBefore?: number;
    limit?: number;
  }
): Promise<DeletedObjectCatalogPhysicalRecord[]> {
  const params: unknown[] = [];
  const bucketPredicate = options?.bucketBinding ? 'AND oco.bucket_binding = ?' : '';
  if (options?.bucketBinding) {
    params.push(options.bucketBinding);
  }
  const deletedBeforePredicate = options?.deletedBefore
    ? 'AND COALESCE(oco.deleted_at, oc.deleted_at) <= ?'
    : '';
  if (options?.deletedBefore) {
    params.push(options.deletedBefore);
  }
  const limit =
    typeof options?.limit === 'number' && Number.isSafeInteger(options.limit) && options.limit > 0
      ? Math.min(options.limit, 1000)
      : 100;
  params.push(limit);

  const rows = await adapter.query<{
    physical_id: string;
    catalog_id: string;
    public_artifact_id: string;
    tenant_id: string;
    object_class: string;
    bucket_binding: ObjectCatalogBucketBinding;
    object_key: string;
    representation: string;
    object_kind: string;
    object_index: number;
    deleted_at: number | null;
  }>(
    `SELECT
       oco.id AS physical_id,
       oc.id AS catalog_id,
       oc.public_artifact_id,
       oc.tenant_id,
       oc.object_class,
       oco.bucket_binding,
       oco.object_key,
       oco.representation,
       oco.object_kind,
       oco.object_index,
       COALESCE(oco.deleted_at, oc.deleted_at) AS deleted_at
     FROM object_catalog_objects oco
     INNER JOIN object_catalog oc ON oc.id = oco.catalog_id
     WHERE oco.deleted_at IS NOT NULL
       ${bucketPredicate}
       ${deletedBeforePredicate}
     ORDER BY oco.deleted_at ASC, oco.object_index ASC
     LIMIT ?`,
    params
  );

  return rows
    .filter(
      (row) =>
        row.deleted_at !== null &&
        isObjectClass(row.object_class) &&
        isObjectRepresentation(row.representation) &&
        isObjectKind(row.object_kind)
    )
    .map((row) => ({
      physicalId: row.physical_id,
      catalogId: row.catalog_id,
      publicArtifactId: row.public_artifact_id,
      tenantId: row.tenant_id,
      objectClass: row.object_class as ObjectClass,
      bucketBinding: row.bucket_binding,
      objectKey: row.object_key,
      representation: row.representation as ObjectRepresentation,
      objectKind: row.object_kind as ObjectKind,
      chunkIndex: row.object_index,
      deletedAt: row.deleted_at as number,
    }));
}

export async function purgeDeletedObjectCatalogObjects(
  adapter: DatabaseAdapter,
  physicalIds: string[]
): Promise<number> {
  if (physicalIds.length === 0) {
    return 0;
  }

  let purged = 0;
  for (const physicalId of physicalIds) {
    const result = await adapter.execute('DELETE FROM object_catalog_objects WHERE id = ?', [physicalId]);
    purged += result.rowsAffected ?? 0;
  }

  await adapter.execute(
    `DELETE FROM object_catalog
     WHERE deleted_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM object_catalog_objects oco
         WHERE oco.catalog_id = object_catalog.id
       )`,
    []
  );

  return purged;
}

export function isObjectClass(value: string): value is ObjectClass {
  return (OBJECT_CLASSES as readonly string[]).includes(value);
}

export function isObjectRepresentation(value: string): value is ObjectRepresentation {
  return (OBJECT_REPRESENTATIONS as readonly string[]).includes(value);
}

export function isObjectKind(value: string): value is ObjectKind {
  return (OBJECT_KINDS as readonly string[]).includes(value);
}
