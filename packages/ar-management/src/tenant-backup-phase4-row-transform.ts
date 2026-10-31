import type { Env } from '@authrim/ar-lib-core';
import { exportPortableOauthClientSecretRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-client-secret';
import { exportPortableUpstreamProviderSecretsRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-upstream-provider-secrets';
import type { TenantBackupInstalledSqliteExportPorts } from './tenant-backup-sqlite-export-adapter';

export const PHASE4_TRANSFORMED_SQLITE_DATASETS = [
  'core.oauth_clients',
  'core.upstream_providers',
] as const;

/** Source-key boundary for every environment-encrypted SQL value through Phase 4. */
export function createPhase4TenantBackupRowTransform(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY'>
): NonNullable<TenantBackupInstalledSqliteExportPorts['transformRow']> {
  return async ({ datasetId, rowJson }) => {
    if (datasetId === 'core.oauth_clients')
      return exportPortableOauthClientSecretRow(
        rowJson,
        env.RP_TOKEN_ENCRYPTION_KEY || env.PII_ENCRYPTION_KEY
      );
    if (datasetId === 'core.upstream_providers')
      return exportPortableUpstreamProviderSecretsRow(rowJson, env.RP_TOKEN_ENCRYPTION_KEY);
    throw new Error('backup_phase4_row_transform_dataset');
  };
}
