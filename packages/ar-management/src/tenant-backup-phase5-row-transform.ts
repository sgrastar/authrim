import type { Env } from '@authrim/ar-lib-core';
import { exportPortableWebhookSecretRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-webhook-secret';
import { PHASE5_SENSITIVE_SQLITE_DATASETS } from '@authrim/ar-lib-core/services/tenant-portability/phase5-sqlite-references';
import {
  createPhase4TenantBackupRowTransform,
  PHASE4_TRANSFORMED_SQLITE_DATASETS,
} from './tenant-backup-phase4-row-transform';
import type { TenantBackupInstalledSqliteExportPorts } from './tenant-backup-sqlite-export-adapter';

export const PHASE5_TRANSFORMED_SQLITE_DATASETS = [
  ...PHASE4_TRANSFORMED_SQLITE_DATASETS,
  ...PHASE5_SENSITIVE_SQLITE_DATASETS,
] as const;

export interface Phase5SensitiveRowTransformPort {
  transformAdminEnvelope(datasetId: string, rowJson: string): Promise<string>;
}

/** Keep every source-environment ciphertext out of the encrypted portable bundle. */
export function createPhase5TenantBackupRowTransform(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY'>,
  port: Phase5SensitiveRowTransformPort
): NonNullable<TenantBackupInstalledSqliteExportPorts['transformRow']> {
  const phase4 = createPhase4TenantBackupRowTransform(env);
  return async (input) => {
    if ((PHASE4_TRANSFORMED_SQLITE_DATASETS as readonly string[]).includes(input.datasetId))
      return phase4(input);
    if (input.datasetId === 'core.webhook_configs')
      return exportPortableWebhookSecretRow(input.rowJson, env.PII_ENCRYPTION_KEY);
    if (
      input.datasetId === 'admin.credential_secret_bodies' ||
      input.datasetId === 'admin.logging_key_material_bodies'
    )
      return port.transformAdminEnvelope(input.datasetId, input.rowJson);
    throw new Error('backup_phase5_row_transform_dataset');
  };
}
