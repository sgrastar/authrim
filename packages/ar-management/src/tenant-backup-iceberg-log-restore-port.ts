import { loadLogIcebergRestoreHold } from '@authrim/ar-lib-core/services/log-iceberg-restore-hold';
import { retireLogIcebergRetryObject } from '@authrim/ar-lib-core/services/log-iceberg-retry-marker';
import {
  requireDedicatedAdminDatabaseAdapter,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { prepareLogIcebergRetentionScope } from '@authrim/ar-lib-core/services/log-iceberg-retention-scope';
import { resolveLogIcebergConfig } from '@authrim/ar-lib-core/services/log-iceberg-config';
import {
  buildLogIcebergRowRecord,
  prepareLogIcebergRowWrite,
} from '@authrim/ar-lib-core/services/log-iceberg-emitter';
import { decryptLogIcebergRecord } from '@authrim/ar-lib-core/services/log-iceberg-record';
import { createLogIcebergKeyResolver } from '@authrim/ar-lib-core/services/log-iceberg-keys';
import {
  createLogIcebergWritePort,
  readLogIcebergRetryPayload,
  type LogIcebergQueueReference,
} from '@authrim/ar-lib-core/services/log-iceberg-runtime';
import {
  logIcebergRecordId,
  SqlLogIcebergRecordStore,
  type LogIcebergStagedHead,
} from '@authrim/ar-lib-core/services/log-iceberg-store';
import { LOG_ICEBERG_DB_NOW } from '@authrim/ar-lib-core/services/log-iceberg-lease';
import { decodePortableIcebergLog } from '@authrim/ar-lib-core/services/tenant-portability/portable-iceberg-log';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';

/** A validated DR row is re-encrypted under target-only keys and stored through
 * the selected mode. No source Parquet, catalog identity or source key is imported. */
export function createTenantBackupIcebergLogRestorePorts(input: {
  env: Env;
  tenantKey: string;
  assertUnpublished(context: TenantBackupStepContext, planDigest: string): Promise<void>;
  resolveCore(context: TenantBackupStepContext, planDigest: string): Promise<DatabaseAdapter>;
}) {
  const admin = requireDedicatedAdminDatabaseAdapter(input.env, 'tenant-backup-iceberg');
  async function targetScope(context: TenantBackupStepContext, planDigest: string) {
    context.signal.throwIfAborted();
    if (!/^[a-f0-9]{64}$/.test(planDigest) || context.operation.kind !== 'import')
      throw new Error('backup_iceberg_restore_invalid');
    await input.assertUnpublished(context, planDigest);
    const core = await input.resolveCore(context, planDigest);
    const tenant = await core.queryOne<{ tenant_key: string }>(
      'SELECT tenant_key FROM tenants WHERE id=?',
      [context.lease.tenantId],
      { consistencyClass: 'primary_required' }
    );
    if (tenant?.tenant_key !== input.tenantKey)
      throw new Error('backup_iceberg_target_scope_changed');
    // The active import lease and sealed restore plan fence every Admin write.
    const guard = {
      where: `EXISTS(SELECT 1 FROM tenant_backup_operations o JOIN tenant_backup_restore_plan_inventories p ON p.operation_id=o.id AND p.tenant_id=o.tenant_id WHERE o.id=? AND o.tenant_id=? AND o.kind='import' AND o.state='running' AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>${LOG_ICEBERG_DB_NOW} AND p.state='sealed' AND p.chain_digest=?)`,
      params: [
        context.lease.operationId,
        context.lease.tenantId,
        context.lease.owner,
        context.lease.fencingToken,
        planDigest,
      ],
    };
    const assertFence = async () => {
      if (
        !(await admin.queryOne(`SELECT 1 WHERE ${guard.where}`, guard.params, {
          consistencyClass: 'primary_required',
        }))
      )
        throw new Error('backup_iceberg_restore_fenced');
      context.signal.throwIfAborted();
    };
    await assertFence();
    // Use the already authorized unpublished Core target. Ordinary service RPC
    // admission must not acquire a second tenant permit during an import hold.
    const env = { ...input.env, DB: core, LOG_ARCHIVE_WRITER: undefined };
    const config = resolveLogIcebergConfig(env);
    const writer = createLogIcebergWritePort(env, config);
    const local = { ...env, LOG_ARCHIVE_WRITER: writer };
    return { guard, assertFence, env: local, config };
  }
  async function target(context: TenantBackupStepContext, planDigest: string, rowJson: string) {
    const scope = await targetScope(context, planDigest);
    const row = decodePortableIcebergLog(rowJson, context.lease.tenantId);
    row.ingestedAt = Math.max(
      row.ingestedAt ?? 0,
      scope.config.activatedAt,
      context.operation.created_at
    );
    return { ...scope, row };
  }
  async function saved(context: TenantBackupStepContext, planDigest: string, rowJson: string) {
    const value = await target(context, planDigest, rowJson);
    if (value.row.expiresAt !== null && value.row.expiresAt <= Date.now())
      return { ...value, expired: true as const };
    const expected = await buildLogIcebergRowRecord(value.env, value.row);
    const id = await logIcebergRecordId(expected);
    const hold = await loadLogIcebergRestoreHold(admin, id);
    if (
      !hold ||
      hold.operation_id !== context.lease.operationId ||
      hold.tenant_id !== context.lease.tenantId ||
      hold.payload_hmac !== expected.payload_hmac ||
      hold.storage_generation !== value.config.generation ||
      hold.state === 'aborted' ||
      hold.operation_state === null ||
      hold.operation_state === 'aborted'
    )
      throw new Error('backup_iceberg_restore_hold_missing');
    let record;
    if (value.config.mode === 'scheduled') {
      const head = await admin.queryOne<LogIcebergStagedHead>(
        'SELECT * FROM log_iceberg_records WHERE id=? AND tenant_id=?',
        [id, context.lease.tenantId],
        { consistencyClass: 'primary_required' }
      );
      if (!head) throw new Error('backup_iceberg_target_record_missing');
      [record] = await new SqlLogIcebergRecordStore(admin).read([head], {
        restoreOperationId: context.lease.operationId,
      });
    } else {
      const outbox = await admin.queryOne<
        LogIcebergQueueReference & { state: string; tenant_id: string }
      >(
        'SELECT * FROM log_iceberg_outbox WHERE id=? AND tenant_id=?',
        [id, context.lease.tenantId],
        { consistencyClass: 'primary_required' }
      );
      if (!outbox || !['pending', 'queued', 'ingested'].includes(outbox.state))
        throw new Error('backup_iceberg_target_record_missing');
      record = await readLogIcebergRetryPayload(value.env, {
        ...outbox,
        payload_type: 'iceberg_ingest',
        schema_version: 1,
      });
    }
    if (
      !record ||
      record.tenant_key !== input.tenantKey ||
      record.source_dataset !== expected.source_dataset ||
      record.event_id !== expected.event_id ||
      record.payload_hmac !== expected.payload_hmac ||
      record.event_at !== expected.event_at ||
      record.ingested_at !== expected.ingested_at ||
      record.expires_at !== expected.expires_at ||
      record.storage_generation !== value.config.generation
    )
      throw new Error('backup_iceberg_target_record_differs');
    await decryptLogIcebergRecord(
      record,
      { tenantKey: input.tenantKey, sourceDataset: expected.source_dataset },
      async (version) => createLogIcebergKeyResolver(value.env)(version)
    );
    await value.assertFence();
    return { ...value, expired: false as const };
  }
  function lifecycleGuard(context: TenantBackupStepContext, planDigest?: string) {
    context.signal.throwIfAborted();
    if (
      context.operation.kind !== 'import' ||
      (planDigest !== undefined && !/^[a-f0-9]{64}$/.test(planDigest))
    )
      throw new Error('backup_iceberg_restore_invalid');
    return {
      where: `EXISTS(SELECT 1 FROM tenant_backup_operations o ${planDigest !== undefined ? 'JOIN tenant_backup_restore_plan_inventories p ON p.operation_id=o.id AND p.tenant_id=o.tenant_id' : ''} WHERE o.id=? AND o.tenant_id=? AND o.kind='import' AND o.state=? AND o.lease_owner=? AND o.fencing_token=? AND o.lease_expires_at>${LOG_ICEBERG_DB_NOW}${planDigest !== undefined ? " AND o.phase='verify_restore_activation' AND p.state='sealed' AND p.chain_digest=?" : ''})`,
      params: [
        context.lease.operationId,
        context.lease.tenantId,
        planDigest !== undefined ? 'running' : 'cancelling',
        context.lease.owner,
        context.lease.fencingToken,
        ...(planDigest !== undefined ? [planDigest] : []),
      ],
    };
  }
  async function assertLifecycle(guard: { where: string; params: unknown[] }) {
    if (
      !(await admin.queryOne(`SELECT 1 WHERE ${guard.where}`, guard.params, {
        consistencyClass: 'primary_required',
      }))
    )
      throw new Error('backup_iceberg_restore_fenced');
  }
  return {
    async activateRestoredLogHolds(
      context: TenantBackupStepContext,
      planDigest: string
    ): Promise<void> {
      const guard = lifecycleGuard(context, planDigest);
      await assertLifecycle(guard);
      const config = resolveLogIcebergConfig(input.env);
      const existing = await admin.queryOne<{
        tenant_id: string;
        storage_generation: string;
        plan_digest: string | null;
        state: string;
      }>(
        'SELECT tenant_id,storage_generation,plan_digest,state FROM log_iceberg_restore_activations WHERE id=?',
        [context.lease.operationId],
        { consistencyClass: 'primary_required' }
      );
      if (
        existing &&
        (existing.tenant_id !== context.lease.tenantId ||
          existing.storage_generation !== config.generation ||
          existing.plan_digest !== planDigest ||
          existing.state === 'aborted')
      )
        throw new Error('backup_iceberg_restore_hold_not_activatable');
      await admin.execute(
        `INSERT INTO log_iceberg_restore_activations(id,tenant_id,storage_generation,plan_digest,state,created_at,activated_at)
        SELECT ?,?,?,?,'active',${LOG_ICEBERG_DB_NOW},${LOG_ICEBERG_DB_NOW} WHERE (${guard.where})
        ON CONFLICT(id) DO UPDATE SET state=CASE WHEN log_iceberg_restore_activations.tenant_id=excluded.tenant_id AND log_iceberg_restore_activations.storage_generation=excluded.storage_generation AND log_iceberg_restore_activations.plan_digest=excluded.plan_digest AND log_iceberg_restore_activations.state IN('pending','active') THEN 'active' ELSE NULL END,activated_at=COALESCE(log_iceberg_restore_activations.activated_at,excluded.activated_at)`,
        [
          context.lease.operationId,
          context.lease.tenantId,
          config.generation,
          planDigest,
          ...guard.params,
        ]
      );
      await assertLifecycle(guard);
    },
    async cleanupRestoredLogHolds(
      context: TenantBackupStepContext
    ): Promise<{ complete: boolean; remaining: number }> {
      const guard = lifecycleGuard(context);
      await assertLifecycle(guard);
      const config = resolveLogIcebergConfig(input.env);
      const activation = await admin.queryOne<{
        tenant_id: string;
        storage_generation: string;
        state: string;
      }>(
        'SELECT tenant_id,storage_generation,state FROM log_iceberg_restore_activations WHERE id=?',
        [context.lease.operationId],
        { consistencyClass: 'primary_required' }
      );
      if (
        activation &&
        (activation.tenant_id !== context.lease.tenantId ||
          activation.storage_generation !== config.generation)
      )
        throw new Error('backup_iceberg_restore_hold_scope_changed');
      if (activation?.state === 'active') throw new Error('backup_iceberg_restore_already_active');
      // Commit the operation-wide denial first, including when a stale worker has not claimed any row yet.
      await admin.execute(
        `INSERT INTO log_iceberg_restore_activations(id,tenant_id,storage_generation,plan_digest,state,created_at,activated_at)
        SELECT ?,?,?,NULL,'aborted',${LOG_ICEBERG_DB_NOW},NULL WHERE (${guard.where}) ON CONFLICT(id) DO UPDATE SET state=CASE WHEN log_iceberg_restore_activations.tenant_id=excluded.tenant_id AND log_iceberg_restore_activations.storage_generation=excluded.storage_generation AND log_iceberg_restore_activations.state!='active' THEN 'aborted' ELSE NULL END`,
        [context.lease.operationId, context.lease.tenantId, config.generation, ...guard.params]
      );
      await assertLifecycle(guard);
      const holds = await admin.query<
        import('@authrim/ar-lib-core/services/log-iceberg-restore-hold').LogIcebergRestoreHold
      >(
        `SELECT * FROM log_iceberg_restore_holds WHERE operation_id=? AND tenant_id=? AND cleanup_completed_at IS NULL ORDER BY id LIMIT 32`,
        [context.lease.operationId, context.lease.tenantId],
        { consistencyClass: 'primary_required' }
      );
      for (const hold of holds) {
        if (hold.storage_generation !== config.generation)
          throw new Error('backup_iceberg_restore_hold_scope_changed');
        await admin.batch([
          {
            sql: `UPDATE log_iceberg_restore_holds SET state='aborted' WHERE id=? AND operation_id=? AND tenant_id=? AND (${guard.where})`,
            params: [hold.id, context.lease.operationId, context.lease.tenantId, ...guard.params],
          },
          {
            sql: `UPDATE log_iceberg_outbox SET state='erased',updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND tenant_id=? AND payload_hmac=? AND EXISTS(SELECT 1 FROM log_iceberg_restore_holds h WHERE h.id=log_iceberg_outbox.id AND h.state='aborted') AND (${guard.where})`,
            params: [hold.id, hold.tenant_id, hold.payload_hmac, ...guard.params],
          },
        ]);
        await assertLifecycle(guard);
        const outbox = await admin.queryOne<{
          payload_key: string;
          payload_hmac: string;
          payload_digest: string | null;
          payload_bytes: number | null;
        }>(
          'SELECT payload_key,payload_hmac,payload_digest,payload_bytes FROM log_iceberg_outbox WHERE id=? AND tenant_id=?',
          [hold.id, hold.tenant_id],
          { consistencyClass: 'primary_required' }
        );
        if (config.mode === 'pipeline') {
          const key = `_authrim_retry/iceberg/v1/${config.generation}/${hold.id}.json`;
          if (outbox && (outbox.payload_key !== key || outbox.payload_hmac !== hold.payload_hmac))
            throw new Error('backup_iceberg_restore_hold_scope_changed');
          if (!input.env.LOG_ARCHIVE) throw new Error('backup_iceberg_retry_store_missing');
          if (
            !(await retireLogIcebergRetryObject(
              input.env.LOG_ARCHIVE,
              {
                id: hold.id,
                generation: config.generation,
                key,
                hmac: hold.payload_hmac,
                digest: outbox?.payload_digest ?? null,
                bytes: outbox?.payload_bytes ?? null,
              },
              () => assertLifecycle(guard)
            ))
          )
            continue;
        }
        await admin.batch([
          {
            sql: `DELETE FROM log_iceberg_record_parts WHERE record_id=? AND tenant_id=? AND (${guard.where})`,
            params: [hold.id, hold.tenant_id, ...guard.params],
          },
          {
            sql: `DELETE FROM log_iceberg_records WHERE id=? AND tenant_id=? AND payload_hmac=? AND (${guard.where})`,
            params: [hold.id, hold.tenant_id, hold.payload_hmac, ...guard.params],
          },
          {
            sql: `UPDATE log_iceberg_outbox SET payload_erased_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND tenant_id=? AND state='erased' AND (${guard.where})`,
            params: [hold.id, hold.tenant_id, ...guard.params],
          },
          {
            sql: `UPDATE log_iceberg_restore_holds SET cleanup_completed_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND operation_id=? AND tenant_id=? AND state='aborted' AND (${guard.where})`,
            params: [hold.id, context.lease.operationId, hold.tenant_id, ...guard.params],
          },
        ]);
        await assertLifecycle(guard);
      }
      // This is a bounded remaining-work indicator, not a count of the entire import.
      const remaining = (await admin.queryOne(
        'SELECT id FROM log_iceberg_restore_holds WHERE operation_id=? AND tenant_id=? AND cleanup_completed_at IS NULL LIMIT 1',
        [context.lease.operationId, context.lease.tenantId],
        { consistencyClass: 'primary_required' }
      ))
        ? 1
        : 0;
      return { complete: remaining === 0, remaining };
    },
    async registerRestoredPiiPurgeScope(
      context: TenantBackupStepContext,
      planDigest: string
    ): Promise<void> {
      const scope = await targetScope(context, planDigest);
      await admin.batch(
        await prepareLogIcebergRetentionScope(
          scope.config,
          {
            tenantId: context.lease.tenantId,
            tenantKey: input.tenantKey,
            sourceDataset: 'pii.pii_log',
          },
          scope.guard
        )
      );
      await scope.assertFence();
    },
    async importIcebergLog(
      context: TenantBackupStepContext,
      planDigest: string,
      rowJson: string
    ): Promise<void> {
      const value = await target(context, planDigest, rowJson);
      if (value.row.expiresAt !== null && value.row.expiresAt <= Date.now()) return;
      const expected = await buildLogIcebergRowRecord(value.env, value.row),
        id = await logIcebergRecordId(expected);
      // Pin operation identity once. Every historical row joins this witness; activation touches one row.
      await admin.execute(
        `INSERT INTO log_iceberg_restore_activations(id,tenant_id,storage_generation,plan_digest,state,created_at,activated_at)
        SELECT ?,?,?,?,'pending',${LOG_ICEBERG_DB_NOW},NULL WHERE (${value.guard.where}) ON CONFLICT(id) DO UPDATE SET plan_digest=CASE WHEN log_iceberg_restore_activations.tenant_id=excluded.tenant_id AND log_iceberg_restore_activations.storage_generation=excluded.storage_generation AND log_iceberg_restore_activations.plan_digest=excluded.plan_digest AND log_iceberg_restore_activations.state='pending' THEN log_iceberg_restore_activations.plan_digest ELSE NULL END`,
        [
          context.lease.operationId,
          context.lease.tenantId,
          value.config.generation,
          planDigest,
          ...value.guard.params,
        ]
      );
      await admin.execute(
        `INSERT INTO log_iceberg_restore_holds(id,operation_id,tenant_id,payload_hmac,storage_generation,state,expires_at,created_at)
        SELECT ?,?,?,?,?,'holding',?,${LOG_ICEBERG_DB_NOW} WHERE (${value.guard.where}) AND EXISTS(SELECT 1 FROM log_iceberg_restore_activations a WHERE a.id=? AND a.tenant_id=? AND a.storage_generation=? AND a.plan_digest=? AND a.state='pending') AND
        (EXISTS(SELECT 1 FROM log_iceberg_restore_holds h WHERE h.id=? AND h.operation_id=?) OR
          (NOT EXISTS(SELECT 1 FROM log_iceberg_records WHERE id=?) AND NOT EXISTS(SELECT 1 FROM log_iceberg_outbox WHERE id=?) AND NOT EXISTS(SELECT 1 FROM log_iceberg_event_receipts WHERE id=?)))
        ON CONFLICT(id) DO UPDATE SET payload_hmac=CASE WHEN log_iceberg_restore_holds.operation_id=excluded.operation_id AND log_iceberg_restore_holds.tenant_id=excluded.tenant_id AND log_iceberg_restore_holds.payload_hmac=excluded.payload_hmac AND log_iceberg_restore_holds.storage_generation=excluded.storage_generation AND log_iceberg_restore_holds.expires_at IS excluded.expires_at AND log_iceberg_restore_holds.state='holding' THEN log_iceberg_restore_holds.payload_hmac ELSE NULL END`,
        [
          id,
          context.lease.operationId,
          context.lease.tenantId,
          expected.payload_hmac,
          value.config.generation,
          expected.expires_at,
          ...value.guard.params,
          context.lease.operationId,
          context.lease.tenantId,
          value.config.generation,
          planDigest,
          id,
          context.lease.operationId,
          id,
          id,
          id,
        ]
      );
      const hold = await loadLogIcebergRestoreHold(admin, id);
      if (
        !hold ||
        hold.operation_id !== context.lease.operationId ||
        hold.payload_hmac !== expected.payload_hmac ||
        hold.tenant_id !== context.lease.tenantId ||
        hold.storage_generation !== value.config.generation ||
        hold.state !== 'holding' ||
        hold.operation_state !== 'pending'
      )
        throw new Error('backup_iceberg_restore_hold_missing');
      const heldGuard = {
        where: `(${value.guard.where}) AND EXISTS(SELECT 1 FROM log_iceberg_restore_holds h WHERE h.id=? AND h.operation_id=? AND h.state='holding' AND EXISTS(SELECT 1 FROM log_iceberg_restore_activations a WHERE a.id=h.operation_id AND a.state='pending') AND h.payload_hmac=? AND (h.expires_at IS NULL OR h.expires_at>${LOG_ICEBERG_DB_NOW}))`,
        params: [...value.guard.params, id, context.lease.operationId, expected.payload_hmac],
      };
      const prepared = await prepareLogIcebergRowWrite(value.env, admin, value.row, heldGuard);
      try {
        await admin.batch(prepared.statements);
      } catch (error) {
        // Only a verified exact committed record can reconcile a lost batch ACK.
        try {
          await saved(context, planDigest, rowJson);
        } catch {
          throw error;
        }
      }
      await saved(context, planDigest, rowJson);
      // Keep retry bodies durable; the normal scanner sends after target activation.
    },
    async verifyIcebergLog(
      context: TenantBackupStepContext,
      planDigest: string,
      rowJson: string
    ): Promise<boolean> {
      await saved(context, planDigest, rowJson);
      return true;
    },
  };
}
