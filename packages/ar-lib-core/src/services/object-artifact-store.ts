import type { DatabaseAdapter } from '../db/adapter';
import type { Env } from '../types/env';
import { readR2ObjectTextWithLimit } from '../utils/body-limits';
import { decryptObjectArtifact } from './object-artifact-crypto';
import {
  type ObjectCatalogBucketBinding,
  type ObjectCatalogListResult,
  type ObjectCatalogPhysicalRecord,
  type ObjectCatalogLookupResult,
  type ObjectClass,
  type ObjectRepresentation,
  isObjectClass,
  isObjectKind,
  isObjectRepresentation,
} from './object-catalog';

const MAX_CATALOG_OBJECT_ARTIFACT_BYTES = 10 * 1024 * 1024;

export interface LoadCatalogObjectArtifactOptions {
  tenantId: string;
  objectCatalogId: string;
  representation?: ObjectRepresentation;
  objectIndex?: number;
  expectedClass?: ObjectClass;
  expectedBucketBinding?: ObjectCatalogBucketBinding;
  allowPlaintextFallback?: boolean;
}

export interface LoadPublicCatalogObjectArtifactOptions {
  tenantId: string;
  publicArtifactId: string;
  representation?: ObjectRepresentation;
  objectIndex?: number;
  expectedClass?: ObjectClass;
  expectedBucketBinding?: ObjectCatalogBucketBinding;
  allowPlaintextFallback?: boolean;
}

export interface LoadedCatalogObjectArtifact {
  logical: ObjectCatalogLookupResult['logical'];
  physical: ObjectCatalogLookupResult['physical'];
  content: string;
  contentType: string;
  encrypted: boolean;
}

export interface LoadedCatalogObjectRepresentation {
  logical: ObjectCatalogLookupResult['logical'];
  physical: ObjectCatalogPhysicalRecord[];
  content: string;
  contentType: string;
  encrypted: boolean;
}

async function getCatalogObjectRecord(
  adapter: DatabaseAdapter,
  identifierColumn: 'oc.id' | 'oc.public_artifact_id',
  identifierValue: string,
  representation: ObjectRepresentation,
  objectIndex: number
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
    WHERE ${identifierColumn} = ?
      AND oc.deleted_at IS NULL
      AND oco.deleted_at IS NULL
      AND oco.representation = ?
      AND oco.object_index = ?
    LIMIT 1`,
    [identifierValue, representation, objectIndex]
  );

  if (
    !row ||
    !isObjectClass(row.object_class) ||
    !isObjectRepresentation(row.representation) ||
    !isObjectKind(row.object_kind)
  ) {
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

async function listCatalogObjectRecords(
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
      objectKind: row.object_kind as ObjectCatalogPhysicalRecord['objectKind'],
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

function resolveObjectBucket(env: Env, binding: ObjectCatalogBucketBinding): R2Bucket | null {
  switch (binding) {
    case 'EXPORT_ARTIFACTS':
      return env.EXPORT_ARTIFACTS ?? null;
    case 'IMPORT_ARTIFACTS':
      return env.IMPORT_ARTIFACTS ?? null;
    case 'SENSITIVE_DETAILS':
      return env.SENSITIVE_DETAILS ?? null;
    default:
      return null;
  }
}

function isDecryptableBinding(
  binding: ObjectCatalogBucketBinding
): binding is 'EXPORT_ARTIFACTS' | 'SENSITIVE_DETAILS' {
  return binding === 'EXPORT_ARTIFACTS' || binding === 'SENSITIVE_DETAILS';
}

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function loadCatalogObjectArtifact(
  adapter: DatabaseAdapter,
  env: Env,
  options: LoadCatalogObjectArtifactOptions
): Promise<LoadedCatalogObjectArtifact | null> {
  const record = await getCatalogObjectRecord(
    adapter,
    'oc.id',
    options.objectCatalogId,
    options.representation ?? 'canonical_json',
    options.objectIndex ?? 0
  );
  if (!record || record.logical.tenantId !== options.tenantId) {
    return null;
  }
  if (options.expectedClass && record.logical.objectClass !== options.expectedClass) {
    return null;
  }
  if (
    options.expectedBucketBinding &&
    record.physical.bucketBinding !== options.expectedBucketBinding
  ) {
    return null;
  }

  const bucket = resolveObjectBucket(env, record.physical.bucketBinding);
  if (!bucket) {
    return null;
  }

  const object = await bucket.get(record.physical.objectKey);
  if (!object) {
    return null;
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const rawContentType = headers.get('Content-Type') || 'application/octet-stream';
  const rawPayload = await readR2ObjectTextWithLimit(object, MAX_CATALOG_OBJECT_ARTIFACT_BYTES);
  if (record.physical.checksumSha256) {
    const actualChecksum = await sha256Hex(rawPayload);
    if (actualChecksum !== record.physical.checksumSha256) {
      return null;
    }
  }

  if (env.OBJECT_ENCRYPTION_ROOT_KEY && isDecryptableBinding(record.physical.bucketBinding)) {
    try {
      const envelope = JSON.parse(rawPayload) as Parameters<typeof decryptObjectArtifact>[0];
      const content = await decryptObjectArtifact(envelope, {
        rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
        context: {
          tenantId: options.tenantId,
          objectKey: record.physical.objectKey,
          objectClass: record.logical.objectClass,
        },
      });
      return {
        logical: record.logical,
        physical: record.physical,
        content,
        contentType: envelope.contentType,
        encrypted: true,
      };
    } catch {
      if (options.allowPlaintextFallback === false) {
        return null;
      }
    }
  }

  return {
    logical: record.logical,
    physical: record.physical,
    content: rawPayload,
    contentType: rawContentType,
    encrypted: false,
  };
}

export async function loadPublicCatalogObjectArtifact(
  adapter: DatabaseAdapter,
  env: Env,
  options: LoadPublicCatalogObjectArtifactOptions
): Promise<LoadedCatalogObjectArtifact | null> {
  const record = await getCatalogObjectRecord(
    adapter,
    'oc.public_artifact_id',
    options.publicArtifactId,
    options.representation ?? 'canonical_json',
    options.objectIndex ?? 0
  );
  if (!record || record.logical.tenantId !== options.tenantId) {
    return null;
  }
  if (options.expectedClass && record.logical.objectClass !== options.expectedClass) {
    return null;
  }
  if (
    options.expectedBucketBinding &&
    record.physical.bucketBinding !== options.expectedBucketBinding
  ) {
    return null;
  }

  const bucket = resolveObjectBucket(env, record.physical.bucketBinding);
  if (!bucket) {
    return null;
  }

  const object = await bucket.get(record.physical.objectKey);
  if (!object) {
    return null;
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const rawContentType = headers.get('Content-Type') || 'application/octet-stream';
  const rawPayload = await readR2ObjectTextWithLimit(object, MAX_CATALOG_OBJECT_ARTIFACT_BYTES);
  if (record.physical.checksumSha256) {
    const actualChecksum = await sha256Hex(rawPayload);
    if (actualChecksum !== record.physical.checksumSha256) {
      return null;
    }
  }

  if (env.OBJECT_ENCRYPTION_ROOT_KEY && isDecryptableBinding(record.physical.bucketBinding)) {
    try {
      const envelope = JSON.parse(rawPayload) as Parameters<typeof decryptObjectArtifact>[0];
      const content = await decryptObjectArtifact(envelope, {
        rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
        context: {
          tenantId: options.tenantId,
          objectKey: record.physical.objectKey,
          objectClass: record.logical.objectClass,
        },
      });
      return {
        logical: record.logical,
        physical: record.physical,
        content,
        contentType: envelope.contentType,
        encrypted: true,
      };
    } catch {
      if (options.allowPlaintextFallback === false) {
        return null;
      }
    }
  }

  return {
    logical: record.logical,
    physical: record.physical,
    content: rawPayload,
    contentType: rawContentType,
    encrypted: false,
  };
}

export async function loadCatalogObjectJson<T>(
  adapter: DatabaseAdapter,
  env: Env,
  options: LoadCatalogObjectArtifactOptions
): Promise<(LoadedCatalogObjectArtifact & { value: T }) | null> {
  const loaded = await loadCatalogObjectArtifact(adapter, env, options);
  if (!loaded) {
    return null;
  }

  try {
    return {
      ...loaded,
      value: JSON.parse(loaded.content) as T,
    };
  } catch {
    return null;
  }
}

export async function loadCatalogObjectRepresentation(
  adapter: DatabaseAdapter,
  env: Env,
  options: Omit<LoadCatalogObjectArtifactOptions, 'objectIndex'>
): Promise<LoadedCatalogObjectRepresentation | null> {
  const catalog = await listCatalogObjectRecords(
    adapter,
    options.objectCatalogId,
    options.representation ?? 'canonical_json'
  );
  if (!catalog || catalog.logical.tenantId !== options.tenantId) {
    return null;
  }
  if (options.expectedClass && catalog.logical.objectClass !== options.expectedClass) {
    return null;
  }

  const representation = options.representation ?? 'canonical_json';
  const physical = catalog.physical.filter(
    (entry) =>
      entry.representation === representation &&
      (!options.expectedBucketBinding || entry.bucketBinding === options.expectedBucketBinding)
  );
  if (physical.length === 0) {
    return null;
  }

  const single = physical.find((entry) => entry.objectKind === 'single');
  if (single) {
    const loaded = await loadCatalogObjectArtifact(adapter, env, {
      ...options,
      objectIndex: single.chunkIndex ?? 0,
    });
    if (!loaded) {
      return null;
    }

    return {
      logical: loaded.logical,
      physical,
      content: loaded.content,
      contentType: loaded.contentType,
      encrypted: loaded.encrypted,
    };
  }

  const chunks = physical
    .filter((entry) => entry.objectKind === 'chunk' && (entry.chunkIndex ?? -1) >= 0)
    .sort((left, right) => (left.chunkIndex ?? 0) - (right.chunkIndex ?? 0));
  if (chunks.length === 0) {
    return null;
  }

  const parts: string[] = [];
  let contentType = 'application/octet-stream';
  let encrypted = false;

  for (const chunk of chunks) {
    const loaded = await loadCatalogObjectArtifact(adapter, env, {
      ...options,
      objectIndex: chunk.chunkIndex ?? 0,
    });
    if (!loaded) {
      return null;
    }
    parts.push(loaded.content);
    contentType = loaded.contentType || contentType;
    encrypted = encrypted || loaded.encrypted;
  }

  return {
    logical: catalog.logical,
    physical,
    content: parts.join(''),
    contentType,
    encrypted,
  };
}

export async function loadPublicCatalogObjectJson<T>(
  adapter: DatabaseAdapter,
  env: Env,
  options: LoadPublicCatalogObjectArtifactOptions
): Promise<(LoadedCatalogObjectArtifact & { value: T }) | null> {
  const loaded = await loadPublicCatalogObjectArtifact(adapter, env, options);
  if (!loaded) {
    return null;
  }

  try {
    return {
      ...loaded,
      value: JSON.parse(loaded.content) as T,
    };
  } catch {
    return null;
  }
}
