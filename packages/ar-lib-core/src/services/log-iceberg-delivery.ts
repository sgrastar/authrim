import { logIcebergRestoreVisibleSql } from './log-iceberg-restore-hold';
import { ensureDatabaseAdapter } from '../db';
import type { DatabaseAdapter } from '../db/adapter';
import {
  assertLogIcebergActivated,
  resolveLogIcebergConfig,
  type LogIcebergConfig,
} from './log-iceberg-config';
import { type LogIcebergQueueReference, type LogIcebergRuntimeEnv } from './log-iceberg-runtime';
import { LOG_ICEBERG_DB_NOW, LogIcebergTableLease } from './log-iceberg-lease';
import { logIcebergMutationScope, logIcebergWriterForTenant } from './log-iceberg-runtime';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';

interface DeliveryHead extends Omit<LogIcebergQueueReference, 'payload_type' | 'schema_version'> {
  tenant_id: string;
  attempt_count: number;
}
export interface LogIcebergDeliveryPorts {
  admin: DatabaseAdapter;
  dispatch(input: { tenantId: string; references: LogIcebergQueueReference[] }): Promise<void>;
  coverTenant?<T>(tenantId: string, run: () => Promise<T>): Promise<T>;
}

/** Recovery scans delivery pointers only. It never reads DB log bodies or
 * rebuilds an event, nonce, expiry or R2 object from database contents. */
export async function dispatchLogIcebergOutboxPage(
  config: LogIcebergConfig,
  ports: LogIcebergDeliveryPorts
): Promise<{ leased: boolean; queued: number; failed: number }> {
  if (config.mode !== 'pipeline') return { leased: false, queued: 0, failed: 0 };
  const lease = new LogIcebergTableLease(ports.admin, `delivery_${config.generation}`);
  if (!(await lease.acquire())) return { leased: false, queued: 0, failed: 0 };
  const deadline = Date.now() + 10000;
  let queued = 0,
    failed = 0;
  try {
    const heads = await ports.admin.query<DeliveryHead>(
      `SELECT id,tenant_id,storage_generation,source_dataset,subject_id,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at,attempt_count FROM log_iceberg_outbox
      WHERE storage_generation=? AND ${logIcebergRestoreVisibleSql('log_iceberg_outbox')} AND state IN('pending','queued') AND next_attempt_at<=${LOG_ICEBERG_DB_NOW}
      ORDER BY next_attempt_at,created_at,id LIMIT 100`,
      [config.generation],
      { consistencyClass: 'primary_required' }
    );
    for (const head of heads) {
      if (Date.now() >= deadline) break;
      await lease.assert();
      const run = async () => {
        const { tenant_id: tenantId, attempt_count: attempts, ...pointer } = head;
        if (!Number.isSafeInteger(attempts) || attempts < 0)
          throw new Error('log_iceberg_delivery_metadata_invalid');
        const reference: LogIcebergQueueReference = {
          ...pointer,
          payload_type: 'iceberg_ingest',
          schema_version: 1,
        };
        try {
          await ports.dispatch({ tenantId, references: [reference] });
          await lease.assert();
          const result = await ports.admin.execute(
            `UPDATE log_iceberg_outbox SET attempt_count=attempt_count+1,next_attempt_at=${LOG_ICEBERG_DB_NOW}+300000,last_error_code=NULL,updated_at=${LOG_ICEBERG_DB_NOW}
            WHERE id=? AND payload_digest=? AND state IN('pending','queued') AND ${lease.predicate}`,
            [head.id, head.payload_digest, ...lease.params]
          );
          if (result.rowsAffected === 1) queued++;
        } catch (error) {
          await lease.assert();
          const delay = Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7));
          const code =
            error instanceof Error && /^[a-z][a-z0-9_]{0,95}$/.test(error.message)
              ? error.message
              : 'log_iceberg_delivery_failed';
          await ports.admin.execute(
            `UPDATE log_iceberg_outbox SET attempt_count=attempt_count+1,next_attempt_at=${LOG_ICEBERG_DB_NOW}+?,last_error_code=?,updated_at=${LOG_ICEBERG_DB_NOW}
            WHERE id=? AND payload_digest=? AND state IN('pending','queued') AND ${lease.predicate}`,
            [delay, code, head.id, head.payload_digest, ...lease.params]
          );
          failed++;
        }
      };
      try {
        if (ports.coverTenant) await ports.coverTenant(head.tenant_id, run);
        else await run();
      } catch {
        // A frozen tenant must not prevent recovery of other tenants. A lost
        // scanner lease, however, stops all subsequent effects immediately.
        await lease.assert();
        failed++;
      }
    }
    return { leased: true, queued, failed };
  } finally {
    await lease.release();
  }
}

export async function runLogIcebergDelivery(
  env: LogIcebergRuntimeEnv
): Promise<{ leased: boolean; queued: number; failed: number }> {
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  if (config.mode !== 'pipeline') return { leased: false, queued: 0, failed: 0 };
  if (!env.DB_ADMIN) throw new Error('log_iceberg_admin_database_unavailable');
  return dispatchLogIcebergOutboxPage(config, {
    admin: ensureDatabaseAdapter(env.DB_ADMIN, 'log-iceberg-delivery'),
    dispatch: (input) =>
      logIcebergWriterForTenant(env, config, input.tenantId).dispatchPipelineReferences(input),
    coverTenant: (tenantId, run) =>
      runTenantBackupCoveredEffect(
        { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
        logIcebergMutationScope(env, tenantId),
        run
      ),
  });
}
