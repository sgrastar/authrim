import {
  ensureDatabaseAdapter,
  type Env,
  listEnvironmentTenantDefaultStores,
} from '@authrim/ar-lib-core';

const CONSENT_RETENTION_TENANT_PAGE_SIZE = 32;
const CONSENT_RETENTION_CURSOR_KEY = 'jobs:consent-retention:tenant-cursor';

interface ConsentRetentionLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>, error?: Error) => void;
}

export async function processConsentRetentionJobs(
  env: Env,
  log: ConsentRetentionLogger
): Promise<void> {
  if (!env.AUTHRIM_CONFIG) throw new Error('consent_retention_directory_unavailable');
  const afterTenantId =
    (await env.AUTHRIM_CONFIG.get(CONSENT_RETENTION_CURSOR_KEY))?.trim() || undefined;
  const tenants = await listEnvironmentTenantDefaultStores(env, {
    limit: CONSENT_RETENTION_TENANT_PAGE_SIZE,
    afterTenantId,
    concurrency: 4,
  });
  const now = Date.now();

  for (const tenant of tenants) {
    const tenantId = tenant.tenantId;
    const adapter = ensureDatabaseAdapter(
      tenant.store.source,
      `management-consent-retention:${tenant.store.bindingRef}`
    );
    let statements: Array<{ id: string; record_retention_days: number | null }>;
    try {
      statements = await adapter.query(
        `SELECT id, record_retention_days
           FROM consent_statements
          WHERE tenant_id = ?
            AND record_retention_days IS NOT NULL`,
        [tenantId]
      );
    } catch (error) {
      log.warn('Consent retention tenant scan failed', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

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

  const nextCursor =
    tenants.length === CONSENT_RETENTION_TENANT_PAGE_SIZE
      ? (tenants[tenants.length - 1]?.tenantId ?? '')
      : '';
  await env.AUTHRIM_CONFIG.put(CONSENT_RETENTION_CURSOR_KEY, nextCursor);

  log.info('Consent retention cleanup completed', { tenantCount: tenants.length });
}
