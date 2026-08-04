import {
  ensureDatabaseAdapter,
  isD1DatabaseLike,
  listDeletedObjectCatalogObjectsForSystemCleanup,
  purgeDeletedObjectCatalogObjectsForSystemCleanup,
  tombstoneObjectCatalogEntryForTenant,
  type Env,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

const DATA_EXPORT_CLEANUP_BATCH_LIMIT = 25;
const ADMIN_JOB_ARTIFACT_RETENTION_DAYS = 30;
const ADMIN_JOB_CLEANUP_BATCH_LIMIT = 25;
const DELETED_OBJECT_PURGE_BATCH_LIMIT = 100;
const OBJECT_CATALOG_TOMBSTONE_RETENTION_DAYS = 7;
const ACCOUNT_ARTIFACT_SHARD_PAGE_LIMIT = 8;
const ACCOUNT_ARTIFACT_SHARD_CURSOR_KEY = 'jobs:artifact-cleanup:account-source-cursor';

async function resolveAccountArtifactCleanupAdapters(env: Env): Promise<{
  adapters: DatabaseAdapter[];
  nextCursor: string;
}> {
  if (!env.CONTROL || !env.AUTHRIM_CONFIG) {
    throw new Error('artifact_cleanup_account_directory_unavailable');
  }
  const afterShardId =
    (await env.AUTHRIM_CONFIG.get(ACCOUNT_ARTIFACT_SHARD_CURSOR_KEY))?.trim() || null;
  if (afterShardId && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(afterShardId)) {
    throw new Error('artifact_cleanup_shard_cursor_invalid');
  }
  let shards = await env.CONTROL.listAccountDirectorySourceShards({
    afterShardId,
    limit: ACCOUNT_ARTIFACT_SHARD_PAGE_LIMIT,
  });
  if (shards.length === 0 && afterShardId) {
    shards = await env.CONTROL.listAccountDirectorySourceShards({
      afterShardId: null,
      limit: ACCOUNT_ARTIFACT_SHARD_PAGE_LIMIT,
    });
  }
  if (shards.length > ACCOUNT_ARTIFACT_SHARD_PAGE_LIMIT) {
    throw new Error('artifact_cleanup_shard_page_invalid');
  }
  const adapters = shards.map((shard) => {
    if (
      typeof shard.shardId !== 'string' ||
      typeof shard.bindingRef !== 'string' ||
      !Number.isSafeInteger(shard.routeGeneration) ||
      shard.routeGeneration < 1
    ) {
      throw new Error('artifact_cleanup_shard_page_invalid');
    }
    const source = (env as unknown as Record<string, unknown>)[shard.bindingRef];
    if (!isD1DatabaseLike(source)) throw new Error('artifact_cleanup_source_binding_unavailable');
    return ensureDatabaseAdapter(source, `artifact-cleanup:${shard.bindingRef}`);
  });
  return {
    adapters,
    nextCursor:
      shards.length === ACCOUNT_ARTIFACT_SHARD_PAGE_LIMIT
        ? (shards[shards.length - 1]?.shardId ?? '')
        : '',
  };
}

async function deleteBucketObject(bucket: R2Bucket, objectKey: string): Promise<void> {
  await bucket.delete(objectKey);
}

export async function cleanupExpiredDataExportArtifacts(
  env: Env,
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>, err?: Error) => void;
  }
): Promise<number> {
  if (!env.EXPORT_ARTIFACTS) {
    logger.info('Skipping data export artifact cleanup because EXPORT_ARTIFACTS is not configured');
    return 0;
  }

  const page = await resolveAccountArtifactCleanupAdapters(env);
  const now = Date.now();
  let cleaned = 0;
  for (const adapter of page.adapters) {
    const remaining = DATA_EXPORT_CLEANUP_BATCH_LIMIT - cleaned;
    if (remaining <= 0) break;
    const expiredRows = await adapter.query<{
      id: string;
      tenant_id: string;
      object_catalog_id: string | null;
      file_path: string | null;
    }>(
      `SELECT id, tenant_id, object_catalog_id, file_path
         FROM data_export_requests
        WHERE status = 'completed'
          AND expires_at IS NOT NULL
          AND expires_at < ?
          AND (object_catalog_id IS NOT NULL OR file_path IS NOT NULL)
        ORDER BY expires_at ASC
        LIMIT ${remaining}`,
      [now]
    );

    for (const row of expiredRows) {
      try {
        if (row.object_catalog_id) {
          await tombstoneObjectCatalogEntryForTenant(
            adapter,
            row.tenant_id,
            row.object_catalog_id,
            now
          );
        } else if (row.file_path) {
          await deleteBucketObject(env.EXPORT_ARTIFACTS, row.file_path);
        }
        await adapter.execute(
          `UPDATE data_export_requests
              SET object_catalog_id = NULL,
                  file_path = NULL
            WHERE id = ? AND tenant_id = ?`,
          [row.id, row.tenant_id]
        );
        cleaned += 1;
      } catch (error) {
        logger.error(
          'Failed to tombstone data export artifact',
          {
            request_id: row.id,
            object_catalog_id: row.object_catalog_id,
            file_path: row.file_path,
          },
          error as Error
        );
      }
    }
    await purgeDeletedObjectArtifacts(env, adapter, logger);
  }
  await env.AUTHRIM_CONFIG!.put(ACCOUNT_ARTIFACT_SHARD_CURSOR_KEY, page.nextCursor);

  if (cleaned > 0) {
    logger.info('Tombstoned expired data export artifacts', { count: cleaned });
  }

  return cleaned;
}

export async function cleanupExpiredAdminJobArtifacts(
  env: Env,
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>, err?: Error) => void;
  }
): Promise<number> {
  if (!env.EXPORT_ARTIFACTS) {
    logger.info('Skipping admin job artifact cleanup because EXPORT_ARTIFACTS is not configured');
    return 0;
  }

  if (!env.DB_ADMIN) throw new Error('artifact_cleanup_admin_database_unavailable');
  const adapter = ensureDatabaseAdapter(env.DB_ADMIN, 'management-admin-job-artifact-cleanup');
  const cutoffSeconds =
    Math.floor(Date.now() / 1000) - ADMIN_JOB_ARTIFACT_RETENTION_DAYS * 24 * 60 * 60;
  const oldRows = await adapter.query<{
    id: string;
    tenant_id: string;
    object_catalog_id: string | null;
    result_r2_key: string | null;
  }>(
    `SELECT id, tenant_id, object_catalog_id, result_r2_key
       FROM admin_jobs
      WHERE status IN ('completed', 'failed', 'partial_failure')
        AND completed_at IS NOT NULL
        AND completed_at < ?
        AND (object_catalog_id IS NOT NULL OR result_r2_key IS NOT NULL)
      ORDER BY completed_at ASC
      LIMIT ${ADMIN_JOB_CLEANUP_BATCH_LIMIT}`,
    [cutoffSeconds]
  );

  let cleaned = 0;
  const deletedAt = Date.now();
  for (const row of oldRows) {
    try {
      if (row.object_catalog_id) {
        await tombstoneObjectCatalogEntryForTenant(
          adapter,
          row.tenant_id,
          row.object_catalog_id,
          deletedAt
        );
      } else if (row.result_r2_key) {
        await deleteBucketObject(env.EXPORT_ARTIFACTS, row.result_r2_key);
      }
      await adapter.execute(
        `UPDATE admin_jobs
            SET object_catalog_id = NULL,
                result_r2_key = NULL
          WHERE id = ? AND tenant_id = ?`,
        [row.id, row.tenant_id]
      );
      cleaned += 1;
    } catch (error) {
      logger.error(
        'Failed to tombstone admin job artifact',
        {
          job_id: row.id,
          object_catalog_id: row.object_catalog_id,
          result_r2_key: row.result_r2_key,
        },
        error as Error
      );
    }
  }

  if (cleaned > 0) {
    logger.info('Tombstoned expired admin job artifacts', { count: cleaned });
  }

  return cleaned;
}

export async function purgeDeletedObjectArtifacts(
  env: Env,
  adapter: DatabaseAdapter,
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>, err?: Error) => void;
  }
): Promise<number> {
  const exportBucket = env.EXPORT_ARTIFACTS;
  const importBucket = env.IMPORT_ARTIFACTS;
  const sensitiveBucket = env.SENSITIVE_DETAILS;

  const pending = await listDeletedObjectCatalogObjectsForSystemCleanup(adapter, {
    deletedBefore: Date.now() - OBJECT_CATALOG_TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    limit: DELETED_OBJECT_PURGE_BATCH_LIMIT,
  });
  if (pending.length === 0) {
    return 0;
  }

  const purgedIds: string[] = [];
  for (const object of pending) {
    try {
      const bucket =
        object.bucketBinding === 'EXPORT_ARTIFACTS'
          ? exportBucket
          : object.bucketBinding === 'IMPORT_ARTIFACTS'
            ? importBucket
            : sensitiveBucket;
      if (bucket) {
        await deleteBucketObject(bucket, object.objectKey);
      }
      purgedIds.push(object.physicalId);
    } catch (error) {
      logger.error(
        'Failed to purge deleted object artifact',
        {
          catalog_id: object.catalogId,
          physical_id: object.physicalId,
          bucket_binding: object.bucketBinding,
          object_key: object.objectKey,
        },
        error as Error
      );
    }
  }

  const purged = await purgeDeletedObjectCatalogObjectsForSystemCleanup(adapter, purgedIds);
  if (purged > 0) {
    logger.info('Purged deleted object artifacts', { count: purged });
  }
  return purged;
}

export async function runObjectArtifactCleanup(
  env: Env,
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>, err?: Error) => void;
  }
): Promise<void> {
  if (!env.DB_ADMIN) throw new Error('artifact_cleanup_admin_database_unavailable');
  const adapter = ensureDatabaseAdapter(env.DB_ADMIN, 'management-object-artifact-cleanup');

  await cleanupExpiredDataExportArtifacts(env, logger);
  await cleanupExpiredAdminJobArtifacts(env, logger);
  await purgeDeletedObjectArtifacts(env, adapter, logger);
}
