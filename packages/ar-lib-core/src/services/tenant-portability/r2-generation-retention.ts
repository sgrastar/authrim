import type { DatabaseAdapter } from '../../db/adapter';

interface RetiredGenerationIdentity {
  id: string;
  tenant_key: string;
  bucket_binding: string;
  object_catalog_id: string;
  object_key: string;
  replacement_object_key: string | null;
  reason: string;
  key_registry_id: string | null;
  previous_key_version: number | null;
  replacement_key_version: number | null;
  record_count: number | null;
  accounting_applied: number;
  created_at: number;
}

export type RetiredTenantBackupR2BucketBinding =
  | 'AUDIT_ARCHIVE'
  | 'DIAGNOSTIC_LOGS'
  | 'SENSITIVE_DETAILS'
  | 'EXPORT_ARTIFACTS'
  | 'IMPORT_ARTIFACTS';

export type RetiredTenantBackupR2Generation = RetiredGenerationIdentity;

type RetirementReason = 'rewrap' | 'catalog_delete';

interface RetirementIdentityInput {
  id: string;
  tenantKey: string;
  bucketBinding: RetiredTenantBackupR2BucketBinding;
  objectCatalogId: string;
  objectKey: string;
  replacementObjectKey: string | null;
  reason: RetirementReason;
  keyRegistryId: string | null;
  previousKeyVersion: number | null;
  replacementKeyVersion: number | null;
  recordCount: number | null;
  accountingApplied: 0 | 1;
  createdAt: number;
}

const RETIREMENT_MATCH = `tenant_key = ? AND bucket_binding = ?
  AND object_catalog_id = ? AND object_key = ?
  AND replacement_object_key IS ? AND reason = ?
  AND key_registry_id IS ? AND previous_key_version IS ?
  AND replacement_key_version IS ? AND record_count IS ?`;

function invalid(): never {
  throw new Error('tenant_backup_r2_generation_retention_invalid');
}

function matchParams(input: RetirementIdentityInput): unknown[] {
  return [
    input.tenantKey,
    input.bucketBinding,
    input.objectCatalogId,
    input.objectKey,
    input.replacementObjectKey,
    input.reason,
    input.keyRegistryId,
    input.previousKeyVersion,
    input.replacementKeyVersion,
    input.recordCount,
  ];
}

function sameRetirement(row: RetiredGenerationIdentity, input: RetirementIdentityInput): boolean {
  return (
    row.tenant_key === input.tenantKey &&
    row.bucket_binding === input.bucketBinding &&
    row.object_catalog_id === input.objectCatalogId &&
    row.object_key === input.objectKey &&
    row.replacement_object_key === input.replacementObjectKey &&
    row.reason === input.reason &&
    row.key_registry_id === input.keyRegistryId &&
    row.previous_key_version === input.previousKeyVersion &&
    row.replacement_key_version === input.replacementKeyVersion &&
    row.record_count === input.recordCount
  );
}

function validateIdentity(input: RetirementIdentityInput): void {
  if (
    !input.id ||
    !input.tenantKey ||
    !input.objectCatalogId ||
    !input.objectKey ||
    input.objectKey === input.replacementObjectKey ||
    !Number.isSafeInteger(input.createdAt) ||
    input.createdAt < 0
  )
    invalid();
}

async function readRetirement(
  adapter: Pick<DatabaseAdapter, 'queryOne'>,
  input: RetirementIdentityInput
): Promise<RetiredGenerationIdentity> {
  const saved = await adapter.queryOne<RetiredGenerationIdentity>(
    `SELECT id, tenant_key, bucket_binding, object_catalog_id, object_key,
            replacement_object_key, reason, key_registry_id, previous_key_version,
            replacement_key_version, record_count, accounting_applied, created_at
       FROM tenant_backup_r2_retired_generations
      WHERE bucket_binding = ? AND object_key = ? AND object_catalog_id = ?`,
    [input.bucketBinding, input.objectKey, input.objectCatalogId]
  );
  if (!saved || !sameRetirement(saved, input)) invalid();
  return saved;
}

function insertRetirement(input: RetirementIdentityInput) {
  return {
    sql: `INSERT INTO tenant_backup_r2_retired_generations (
            id, tenant_key, bucket_binding, object_catalog_id, object_key,
            replacement_object_key, reason, key_registry_id, previous_key_version,
            replacement_key_version, record_count, accounting_applied, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`,
    params: [
      input.id,
      input.tenantKey,
      input.bucketBinding,
      input.objectCatalogId,
      input.objectKey,
      input.replacementObjectKey,
      input.reason,
      input.keyRegistryId,
      input.previousKeyVersion,
      input.replacementKeyVersion,
      input.recordCount,
      input.accountingApplied,
      input.createdAt,
    ],
  };
}

export async function persistRewrappedLogObjectGeneration(
  adapter: DatabaseAdapter,
  input: {
    retirementId: string;
    tenantKey: string;
    objectCatalogId: string;
    previousObjectKey: string;
    objectKey: string;
    keyRegistryId: string;
    previousKeyVersion: number;
    keyVersion: number;
    recordCount: number;
    byteCount: number;
    checksumSha256: string;
    encryptionScope: string;
    updatedAt: number;
  }
): Promise<void> {
  if (
    !input.keyRegistryId ||
    !Number.isSafeInteger(input.previousKeyVersion) ||
    input.previousKeyVersion < 1 ||
    !Number.isSafeInteger(input.keyVersion) ||
    input.keyVersion < 1 ||
    input.previousKeyVersion === input.keyVersion ||
    !Number.isSafeInteger(input.recordCount) ||
    input.recordCount < 0 ||
    !Number.isSafeInteger(input.byteCount) ||
    input.byteCount < 0 ||
    !/^[a-f0-9]{64}$/.test(input.checksumSha256) ||
    !input.encryptionScope
  )
    invalid();
  const retirement: RetirementIdentityInput = {
    id: input.retirementId,
    tenantKey: input.tenantKey,
    bucketBinding: 'AUDIT_ARCHIVE',
    objectCatalogId: input.objectCatalogId,
    objectKey: input.previousObjectKey,
    replacementObjectKey: input.objectKey,
    reason: 'rewrap',
    keyRegistryId: input.keyRegistryId,
    previousKeyVersion: input.previousKeyVersion,
    replacementKeyVersion: input.keyVersion,
    recordCount: input.recordCount,
    accountingApplied: 0,
    createdAt: input.updatedAt,
  };
  validateIdentity(retirement);
  const match = matchParams(retirement);
  const targetCatalog = [
    input.objectCatalogId,
    input.tenantKey,
    input.objectKey,
    input.byteCount,
    input.checksumSha256,
    input.encryptionScope,
    input.keyVersion,
  ];
  await adapter.batch([
    insertRetirement(retirement),
    {
      sql: `UPDATE log_object_catalog
               SET object_key = ?, byte_count = ?, checksum_sha256 = ?, encryption_scope = ?,
                   key_version = ?, committed_at = (
                     SELECT created_at FROM tenant_backup_r2_retired_generations
                      WHERE ${RETIREMENT_MATCH} LIMIT 1
                   )
             WHERE id = ? AND tenant_key = ? AND object_key = ? AND key_version = ?
               AND status = 'committed'
               AND EXISTS (SELECT 1 FROM logging_key_versions
                 WHERE key_registry_id = ? AND version = ?)
               AND EXISTS (SELECT 1 FROM logging_key_versions
                 WHERE key_registry_id = ? AND version = ?)
               AND EXISTS (SELECT 1 FROM tenant_backup_r2_retired_generations
                 WHERE ${RETIREMENT_MATCH})`,
      params: [
        input.objectKey,
        input.byteCount,
        input.checksumSha256,
        input.encryptionScope,
        input.keyVersion,
        ...match,
        input.objectCatalogId,
        input.tenantKey,
        input.previousObjectKey,
        input.previousKeyVersion,
        input.keyRegistryId,
        input.previousKeyVersion,
        input.keyRegistryId,
        input.keyVersion,
        ...match,
      ],
    },
    {
      sql: `UPDATE logging_key_versions
               SET stale_count = CASE WHEN stale_count > 0 THEN stale_count - 1 ELSE 0 END
             WHERE key_registry_id = ? AND version = ?
               AND EXISTS (SELECT 1 FROM logging_key_versions
                 WHERE key_registry_id = ? AND version = ?)
               AND EXISTS (SELECT 1 FROM tenant_backup_r2_retired_generations
                 WHERE ${RETIREMENT_MATCH} AND accounting_applied = 0)
               AND EXISTS (SELECT 1 FROM log_object_catalog
                 WHERE id = ? AND tenant_key = ? AND object_key = ? AND byte_count = ?
                   AND checksum_sha256 = ? AND encryption_scope = ? AND key_version = ?
                   AND status = 'committed')`,
      params: [
        input.keyRegistryId,
        input.previousKeyVersion,
        input.keyRegistryId,
        input.keyVersion,
        ...match,
        ...targetCatalog,
      ],
    },
    {
      sql: `UPDATE logging_key_versions
               SET usage_count = usage_count + ?
             WHERE key_registry_id = ? AND version = ?
               AND EXISTS (SELECT 1 FROM logging_key_versions
                 WHERE key_registry_id = ? AND version = ?)
               AND EXISTS (SELECT 1 FROM tenant_backup_r2_retired_generations
                 WHERE ${RETIREMENT_MATCH} AND accounting_applied = 0)
               AND EXISTS (SELECT 1 FROM log_object_catalog
                 WHERE id = ? AND tenant_key = ? AND object_key = ? AND byte_count = ?
                   AND checksum_sha256 = ? AND encryption_scope = ? AND key_version = ?
                   AND status = 'committed')`,
      params: [
        input.recordCount,
        input.keyRegistryId,
        input.keyVersion,
        input.keyRegistryId,
        input.previousKeyVersion,
        ...match,
        ...targetCatalog,
      ],
    },
    {
      sql: `UPDATE tenant_backup_r2_retired_generations
               SET accounting_applied = 1
             WHERE ${RETIREMENT_MATCH} AND accounting_applied = 0
               AND EXISTS (SELECT 1 FROM logging_key_versions
                 WHERE key_registry_id = ? AND version = ?)
               AND EXISTS (SELECT 1 FROM logging_key_versions
                 WHERE key_registry_id = ? AND version = ?)
               AND EXISTS (SELECT 1 FROM log_object_catalog
                 WHERE id = ? AND tenant_key = ? AND object_key = ? AND byte_count = ?
                   AND checksum_sha256 = ? AND encryption_scope = ? AND key_version = ?
                   AND status = 'committed')`,
      params: [
        ...match,
        input.keyRegistryId,
        input.previousKeyVersion,
        input.keyRegistryId,
        input.keyVersion,
        ...targetCatalog,
      ],
    },
  ]);
  const saved = await readRetirement(adapter, retirement);
  const current = await adapter.queryOne<{
    object_key: string;
    byte_count: number;
    checksum_sha256: string | null;
    encryption_scope: string | null;
    key_version: number | null;
    committed_at: number | null;
    status: string;
  }>(
    `SELECT object_key, byte_count, checksum_sha256, encryption_scope, key_version,
            committed_at, status
       FROM log_object_catalog WHERE id = ? AND tenant_key = ?`,
    [input.objectCatalogId, input.tenantKey]
  );
  if (
    saved.accounting_applied !== 1 ||
    !current ||
    current.object_key !== input.objectKey ||
    current.byte_count !== input.byteCount ||
    current.checksum_sha256 !== input.checksumSha256 ||
    current.encryption_scope !== input.encryptionScope ||
    current.key_version !== input.keyVersion ||
    current.committed_at !== saved.created_at ||
    current.status !== 'committed'
  )
    invalid();
}

export async function retireDeletedLogObjectGeneration(
  adapter: DatabaseAdapter,
  input: {
    retirementId: string;
    tenantKey: string;
    objectCatalogId: string;
    objectKey: string;
    deletedAt: number;
    bucketBinding: RetiredTenantBackupR2BucketBinding;
  }
): Promise<void> {
  const retirement: RetirementIdentityInput = {
    id: input.retirementId,
    tenantKey: input.tenantKey,
    bucketBinding: input.bucketBinding,
    objectCatalogId: input.objectCatalogId,
    objectKey: input.objectKey,
    replacementObjectKey: null,
    reason: 'catalog_delete',
    keyRegistryId: null,
    previousKeyVersion: null,
    replacementKeyVersion: null,
    recordCount: null,
    accountingApplied: 1,
    createdAt: input.deletedAt,
  };
  validateIdentity(retirement);
  const match = matchParams(retirement);
  await adapter.batch([
    insertRetirement(retirement),
    {
      sql: `UPDATE log_object_catalog
               SET status = 'deleted', deleted_at = (
                 SELECT created_at FROM tenant_backup_r2_retired_generations
                  WHERE ${RETIREMENT_MATCH} LIMIT 1
               )
             WHERE id = ? AND tenant_key = ? AND object_key = ? AND status <> 'deleted'
               AND EXISTS (SELECT 1 FROM tenant_backup_r2_retired_generations
                 WHERE ${RETIREMENT_MATCH})`,
      params: [...match, input.objectCatalogId, input.tenantKey, input.objectKey, ...match],
    },
    {
      sql: `UPDATE log_chunk_record_index
               SET status = 'deleted'
             WHERE object_catalog_id = ? AND status <> 'deleted'
               AND EXISTS (SELECT 1 FROM tenant_backup_r2_retired_generations
                 WHERE ${RETIREMENT_MATCH})
               AND EXISTS (SELECT 1 FROM log_object_catalog
                 WHERE id = ? AND tenant_key = ? AND object_key = ? AND status = 'deleted'
                   AND deleted_at = (SELECT created_at
                     FROM tenant_backup_r2_retired_generations
                    WHERE ${RETIREMENT_MATCH} LIMIT 1))`,
      params: [
        input.objectCatalogId,
        ...match,
        input.objectCatalogId,
        input.tenantKey,
        input.objectKey,
        ...match,
      ],
    },
  ]);
  const saved = await readRetirement(adapter, retirement);
  const current = await adapter.queryOne<{ status: string; deleted_at: number | null }>(
    `SELECT status, deleted_at FROM log_object_catalog
      WHERE id = ? AND tenant_key = ? AND object_key = ?`,
    [input.objectCatalogId, input.tenantKey, input.objectKey]
  );
  if (!current || current.status !== 'deleted' || current.deleted_at !== saved.created_at)
    invalid();
}

export async function hasCapturingTenantBackupSnapshot(
  adapter: Pick<DatabaseAdapter, 'queryOne'>
): Promise<boolean> {
  return Boolean(
    await adapter.queryOne<{ id: string }>(
      `SELECT id FROM tenant_backup_snapshots WHERE state = 'capturing' LIMIT 1`
    )
  );
}

export async function listRetiredTenantBackupR2Generations(
  adapter: Pick<DatabaseAdapter, 'query'>,
  limit: number
): Promise<RetiredTenantBackupR2Generation[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) invalid();
  return adapter.query<RetiredTenantBackupR2Generation>(
    `SELECT id, tenant_key, bucket_binding, object_catalog_id, object_key,
            replacement_object_key, reason, key_registry_id, previous_key_version,
            replacement_key_version, record_count, accounting_applied, created_at
       FROM tenant_backup_r2_retired_generations
      ORDER BY created_at ASC, id ASC LIMIT ?`,
    [limit]
  );
}

export async function completeRetiredTenantBackupR2Generation(
  adapter: Pick<DatabaseAdapter, 'execute'>,
  input: { id: string; objectKey: string }
): Promise<void> {
  const result = await adapter.execute(
    `DELETE FROM tenant_backup_r2_retired_generations WHERE id = ? AND object_key = ?`,
    [input.id, input.objectKey]
  );
  if (result.rowsAffected !== 1) invalid();
}
