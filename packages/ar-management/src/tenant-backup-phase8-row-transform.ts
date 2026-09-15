import type { Env } from '@authrim/ar-lib-core';
import { TENANT_DATASET_POLICIES } from '@authrim/ar-lib-core/services/tenant-portability/dataset-registry';
import {
  parsePhase8PortableSqliteRow,
  phase8LogRowInWindow,
} from '@authrim/ar-lib-core/services/tenant-portability/phase8-log-window';
import { PHASE8_SENSITIVE_SQLITE_DATASETS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-references';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-modules';
import { exportPortableTotpSecretRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-totp-secret';
import { exportPortableOperationalLogDetailRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-operational-log-detail';
import { exportPortableLinkedIdentityTokensRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-linked-identity-tokens';
import { exportPortablePiiLogValuesRow } from '@authrim/ar-lib-core/services/tenant-portability/portable-pii-log-values';
import {
  createPhase5TenantBackupRowTransform,
  PHASE5_TRANSFORMED_SQLITE_DATASETS,
  type Phase5SensitiveRowTransformPort,
} from './tenant-backup-phase5-row-transform';
import type { TenantBackupInstalledSqliteExportPorts } from './tenant-backup-sqlite-export-adapter';

export { PHASE8_SENSITIVE_SQLITE_DATASETS };

const kinds = new Map(
  TENANT_DATASET_POLICIES.map(({ family, table, kind }) => [`${family}.${table}`, kind])
);

function sanitizeAdminReferenceRow(rowJson: string): string {
  const row = JSON.parse(rowJson) as Record<string, readonly [string, string | null]>;
  for (const column of ['id', 'tenant_id', 'email']) {
    const value = row[column];
    if (value?.[0] !== 'text' || value[1] === null || !value[1])
      throw new Error('backup_phase8_admin_reference_invalid');
  }
  for (const column of ['password_hash', 'totp_secret_encrypted', 'last_login_ip']) {
    if (!Object.hasOwn(row, column)) throw new Error('backup_phase8_admin_reference_invalid');
    row[column] = ['null', null];
  }
  return JSON.stringify(row);
}

export interface Phase8SensitiveRowTransformPort extends Phase5SensitiveRowTransformPort {
  loadExternalPiiLogValues(
    input: Parameters<NonNullable<TenantBackupInstalledSqliteExportPorts['transformRow']>>[0],
    catalogReference: string
  ): Promise<string | null>;
}

const PHASE8_ENVIRONMENT_CIPHERTEXT_DATASETS = PHASE8_SENSITIVE_SQLITE_DATASETS.filter(
  (datasetId) => datasetId !== 'pii.identity_identifier_replacement_challenges'
);

function scrubHeldEnvironmentCiphertext(datasetId: string, rowJson: string): string {
  const row = JSON.parse(rowJson) as Record<string, readonly [string, string | null]>;
  const columns =
    datasetId === 'admin.agent_management_executions'
      ? ['result_envelope']
      : [
          'payload_key_id',
          'payload_envelope_json',
          'recipient_encrypted',
          'recipient_encryption_key_version',
        ];
  for (const column of columns) {
    if (!Object.hasOwn(row, column)) throw new Error('backup_phase8_row_transform_dataset');
    row[column] = ['null', null];
  }
  return JSON.stringify(row);
}

/** Apply the fixed log window before a row enters the encrypted bundle. */
export function createPhase8TenantBackupRowFilter(): NonNullable<
  TenantBackupInstalledSqliteExportPorts['filterRow']
> {
  return async (input) => {
    const kind = kinds.get(input.datasetId);
    if (!kind) throw new Error('backup_phase8_row_transform_dataset');
    if (['audit', 'history', 'sensitive_logs'].includes(kind)) {
      if (!Number.isSafeInteger(input.boundaryUnixMs) || (input.boundaryUnixMs ?? -1) < 0)
        throw new Error('backup_phase8_log_boundary');
      if (
        !phase8LogRowInWindow({
          datasetId: input.datasetId,
          row: parsePhase8PortableSqliteRow(input.rowJson),
          period: input.selection.logs.period,
          boundaryUnixMs: input.boundaryUnixMs ?? -1,
        })
      )
        return false;
    }
    return true;
  };
}

/** Remove every source-environment ciphertext before bundle encryption. */
export function createPhase8TenantBackupRowTransform(
  env: Pick<Env, 'RP_TOKEN_ENCRYPTION_KEY' | 'PII_ENCRYPTION_KEY'>,
  port: Phase8SensitiveRowTransformPort
): NonNullable<TenantBackupInstalledSqliteExportPorts['transformRow']> {
  const phase5 = createPhase5TenantBackupRowTransform(env, port);
  return async (input) => {
    if ((PHASE5_TRANSFORMED_SQLITE_DATASETS as readonly string[]).includes(input.datasetId))
      return phase5(input);
    // Source administrators are inventory-only and must be mapped to an existing target Admin.
    // Keep the stable identity/profile fields needed for that mapping, never their login material.
    if (input.datasetId === 'admin.admin_users') return sanitizeAdminReferenceRow(input.rowJson);
    if (input.datasetId === 'core.totp_credentials')
      return exportPortableTotpSecretRow(input.rowJson, env.PII_ENCRYPTION_KEY);
    if (input.datasetId === 'core.operational_logs')
      return exportPortableOperationalLogDetailRow(input.rowJson, env.PII_ENCRYPTION_KEY);
    if (input.datasetId === 'pii.linked_identities')
      return exportPortableLinkedIdentityTokensRow(input.rowJson, env.RP_TOKEN_ENCRYPTION_KEY);
    if (input.datasetId === 'pii.pii_log')
      return exportPortablePiiLogValuesRow(input.rowJson, env.PII_ENCRYPTION_KEY, (reference) =>
        port.loadExternalPiiLogValues(input, reference)
      );
    if (
      input.datasetId === 'admin.agent_management_executions' ||
      input.datasetId === 'core.notification_delivery_intents'
    )
      return scrubHeldEnvironmentCiphertext(input.datasetId, input.rowJson);
    throw new Error('backup_phase8_row_transform_dataset');
  };
}

export const PHASE8_TRANSFORMED_SQLITE_DATASETS = [
  ...PHASE5_TRANSFORMED_SQLITE_DATASETS,
  ...PHASE8_ENVIRONMENT_CIPHERTEXT_DATASETS,
].filter((datasetId, index, values) => values.indexOf(datasetId) === index);

export const PHASE8_FILTERED_LOG_DATASETS = PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.filter(
  ({ dataset }) => ['audit', 'history', 'sensitive_logs'].includes(dataset.kind)
).map(({ dataset }) => dataset.id);
