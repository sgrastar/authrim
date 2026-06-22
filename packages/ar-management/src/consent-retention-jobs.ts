import {
  type Env,
  getDefaultTenantId,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';

interface ConsentRetentionLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>, error?: Error) => void;
}

export async function processConsentRetentionJobs(
  env: Env,
  log: ConsentRetentionLogger
): Promise<void> {
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'management-consent-retention'
  );
  const tenantRows = await adapter.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id
       FROM consent_statements
      WHERE record_retention_days IS NOT NULL`
  );
  const tenantIds =
    tenantRows.length > 0 ? tenantRows.map((row) => row.tenant_id) : [getDefaultTenantId(env)];
  const now = Date.now();

  for (const tenantId of tenantIds) {
    const statements = await adapter.query<{
      id: string;
      record_retention_days: number | null;
    }>(
      `SELECT id, record_retention_days
         FROM consent_statements
        WHERE tenant_id = ?
          AND record_retention_days IS NOT NULL`,
      [tenantId]
    );

    for (const statement of statements) {
      if (statement.record_retention_days === null || statement.record_retention_days < 0) {
        continue;
      }
      const cutoff = now - statement.record_retention_days * 24 * 60 * 60 * 1000;
      try {
        await adapter.execute(
          `DELETE FROM consent_item_history
            WHERE tenant_id = ?
              AND statement_id = ?
              AND NOT EXISTS (
                SELECT 1
                  FROM user_consent_records active_record
                 WHERE active_record.tenant_id = consent_item_history.tenant_id
                   AND active_record.user_id = consent_item_history.user_id
                   AND active_record.statement_id = consent_item_history.statement_id
                   AND active_record.status = 'granted'
              )
              AND (
                (
                  consent_settings_snapshot_at IS NOT NULL
                  AND retain_until IS NOT NULL
                  AND retain_until < ?
                )
                OR (
                  consent_settings_snapshot_at IS NULL
                  AND created_at < ?
                )
              )`,
          [tenantId, statement.id, now, cutoff]
        );
        await adapter.execute(
          `DELETE FROM user_consent_records
            WHERE tenant_id = ?
              AND statement_id = ?
              AND status IN ('withdrawn', 'denied', 'expired')
              AND (
                (
                  consent_settings_snapshot_at IS NOT NULL
                  AND retain_until IS NOT NULL
                  AND retain_until < ?
                )
                OR (
                  consent_settings_snapshot_at IS NULL
                  AND updated_at < ?
                )
              )`,
          [tenantId, statement.id, now, cutoff]
        );
      } catch (error) {
        log.warn('Consent retention cleanup failed for statement', {
          tenantId,
          statementId: statement.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  log.info('Consent retention cleanup completed', { tenantCount: tenantIds.length });
}
