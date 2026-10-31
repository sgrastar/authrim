import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg';
import {
  buildLogIcebergRowRecord,
  prepareLogIcebergRowWrite,
  type LogIcebergRowWrite,
} from '../log-iceberg-emitter';
import { decryptLogIcebergRecord } from '../log-iceberg-record';
import type { LogIcebergRuntimeEnv } from '../log-iceberg-runtime';
import { AdminAuditLogRepository } from '../../repositories/admin/admin-audit-log';
import { icebergFixture } from './log-iceberg-test-fixture';

vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));

describe('explicit row producers and atomic business batches', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>,
    env: LogIcebergRuntimeEnv,
    captured: LogArchiveRecord[];
  beforeEach(async () => {
    f = await icebergFixture();
    captured = [];
    env = {
      AUTHRIM_LOG_ARCHIVE_MODE: f.config.mode,
      AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: f.config.generation,
      AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
      AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: new Date(f.config.activatedAt).toISOString(),
      AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: f.config.accountId,
      AUTHRIM_LOG_ARCHIVE_BUCKET: f.config.bucket,
      AUTHRIM_LOG_ARCHIVE_CATALOG_URI: f.config.catalogUri,
      AUTHRIM_LOG_ARCHIVE_WAREHOUSE: f.config.warehouse,
      AUTHRIM_LOG_ARCHIVE_NAMESPACE: f.config.namespace,
      AUTHRIM_LOG_ARCHIVE_TABLE: f.config.table,
      AUTHRIM_LOG_ARCHIVE_TABLE_UUID: f.config.tableUuid,
      AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: f.config.physicalFingerprint,
      AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7',
      AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '10',
      OBJECT_ENCRYPTION_ROOT_KEY: f.keys.rootKeyHex,
      LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
        schema_version: 1,
        current_version: 1,
        roots: { 1: f.keys.rootKeyHex },
      }),
      LOG_ARCHIVE_CONTENT_HMAC_KEY: f.keys.contentHmacKeyHex,
      LOG_ARCHIVE_WRITER: {
        readPolicyArtifact: async () => null,
        resolveTenantKey: async () => 'key-a',
        async writeRecords(request) {
          for (const record of request.records) {
            captured.push(record);
            await f.staging.put(request.tenantId, record);
          }
          return { stored: request.records.length, queued: 0 };
        },
        preparePipelineReferences: async () => {
          throw new Error('unexpected pipeline');
        },
        dispatchPipelineReferences: async () => {
          throw new Error('unexpected pipeline');
        },
      },
    };
  });
  afterEach(() => f.db.close());
  const input = (): LogIcebergRowWrite => ({
    tenantId: 'tenant-a',
    sourceDataset: 'admin.admin_audit_log',
    logType: 'admin_audit',
    eventAt: f.now,
    expiresAt: null,
    row: {
      id: 'audit-1',
      tenant_id: 'tenant-a',
      action: 'user.update',
      before_json: '{"secret":"before"}',
      after_json: '{"secret":"after"}',
    },
    ingestedAt: f.now,
  });
  it('commits encrypted staging with a business mutation or rolls both back', async () => {
    f.db.exec('CREATE TABLE business_state(id TEXT NOT NULL PRIMARY KEY,value TEXT NOT NULL)');
    const prepared = await prepareLogIcebergRowWrite(env, f.adapter, input());
    await expect(
      f.adapter.batch([
        { sql: 'INSERT INTO business_state VALUES(?,?)', params: ['business-1', 'value'] },
        ...prepared.statements,
        { sql: 'INSERT INTO business_state VALUES(?,?)', params: ['business-1', 'conflict'] },
      ])
    ).rejects.toThrow();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM business_state').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_event_receipts').get()?.n).toBe(0);
    await f.adapter.batch([
      { sql: 'INSERT INTO business_state VALUES(?,?)', params: ['business-1', 'value'] },
      ...prepared.statements,
    ]);
    await prepared.dispatch();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM business_state').get()?.n).toBe(1);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(1);
    expect(
      JSON.stringify(f.db.prepare('SELECT * FROM log_iceberg_record_parts').all())
    ).not.toContain('secret');
  });
  it('captures identity, expiry, row and protected detail before asynchronous tenant resolution', async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    if (!env.LOG_ARCHIVE_WRITER) throw new Error('missing fixture writer');
    env.LOG_ARCHIVE_WRITER.resolveTenantKey = async () => {
      await blocked;
      return 'key-a';
    };
    const value = {
      ...input(),
      sourceDataset: 'core.operational_logs',
      protectedDetail: { reason_detail: 'original reason' },
    };
    const pending = buildLogIcebergRowRecord(env, value);
    value.row.action = 'user.delete';
    value.row.id = 'changed';
    value.expiresAt = 123;
    value.protectedDetail.reason_detail = 'changed reason';
    release();
    const record = await pending;
    expect(record.event_id).toBe('audit-1');
    expect(record.expires_at).toBeNull();
    const body = await decryptLogIcebergRecord(
      record,
      { tenantKey: 'key-a', sourceDataset: 'core.operational_logs' },
      async () => f.keys
    );
    expect((body.row as Record<string, unknown>).action).toBe('user.update');
    expect(JSON.stringify(body)).not.toContain('changed reason');
  });
  it('writes Admin audit once through the new producer with no old Admin log table', async () => {
    expect(
      f.db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='admin_audit_log'")
        .get()
    ).toBeUndefined();
    const repo = new AdminAuditLogRepository(f.adapter, env);
    const value = {
      id: 'admin-1',
      created_at: f.now,
      tenant_id: 'tenant-a',
      action: 'user.update',
      result: 'success' as const,
      before: { secret: 'before' },
      after: { secret: 'after' },
      metadata: { reason_code: 'operator_request' },
    };
    const first = await repo.createAuditLog(value);
    await repo.createAuditLog(value);
    expect(first).toMatchObject({ id: 'admin-1', has_detail: true, created_at: f.now });
    expect(captured).toHaveLength(2);
    expect(captured[0].payload_hmac).toBe(captured[1].payload_hmac);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(1);
    expect(JSON.stringify(captured)).not.toContain('operator_request');
    const body = await decryptLogIcebergRecord(
      captured[0],
      { tenantKey: 'key-a', sourceDataset: 'admin.admin_audit_log' },
      async () => f.keys
    );
    expect((body.row as Record<string, unknown>).before_json).toBeNull();
    expect((body.row as Record<string, unknown>).after_json).toBeNull();
  });
  it('requires the new writer configuration and refuses old externalized detail references', async () => {
    await expect(
      new AdminAuditLogRepository(f.adapter).createAuditLog({
        tenant_id: 'tenant-a',
        action: 'user.update',
        result: 'success',
      })
    ).rejects.toThrow('log_iceberg_admin_writer_configuration_required');
    await expect(
      new AdminAuditLogRepository(f.adapter, env).createAuditLog({
        tenant_id: 'tenant-a',
        action: 'user.update',
        result: 'success',
        detail_object_catalog_id: 'old-reference',
      })
    ).rejects.toThrow('log_iceberg_external_detail_not_supported');
  });
});
