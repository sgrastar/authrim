import type { Env } from '@authrim/ar-lib-core';
import { exportPortableOauthClientSecretRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-client-secret';
import type { TenantBackupInstalledSqliteExportPorts } from './tenant-backup-sqlite-export-adapter';

export const PHASE3_TRANSFORMED_SQLITE_DATASETS = ['core.oauth_clients'] as const;

/** Installed source-key boundary. Source ciphertext never leaves this function unchanged. */
export function createPhase3TenantBackupRowTransform(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY'>
): NonNullable<TenantBackupInstalledSqliteExportPorts['transformRow']> {
  const sourceEncryptionKey = env.RP_TOKEN_ENCRYPTION_KEY || env.PII_ENCRYPTION_KEY;
  return async ({ datasetId, rowJson }) => {
    if (datasetId !== 'core.oauth_clients') throw new Error('backup_phase3_row_transform_dataset');
    return exportPortableOauthClientSecretRow(rowJson, sourceEncryptionKey);
  };
}
