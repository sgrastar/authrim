import { emitLogIcebergRow } from '@authrim/ar-lib-core/services/log-iceberg-emitter';
import type { LogIcebergStagedHead } from '@authrim/ar-lib-core/services/log-iceberg-store';
import { filterPublishedCoreLogRecords } from '@authrim/ar-lib-core/services/log-iceberg-core-publication';
import {
  consumeLogIcebergMessage,
  readLogIcebergRetryPayload,
} from '@authrim/ar-lib-core/services/log-iceberg-runtime';
import { exportLogIcebergBatch } from '@authrim/ar-lib-core/services/log-iceberg-export';
import { dispatchLogIcebergOutboxPage } from '@authrim/ar-lib-core/services/log-iceberg-delivery';
import { cleanupLogIcebergRetryPage } from '@authrim/ar-lib-core/services/log-iceberg-retry-cleanup';
import { resolveLogIcebergConfig } from '@authrim/ar-lib-core/services/log-iceberg-config';
import { isLogIcebergRetryErasureMarker } from '@authrim/ar-lib-core/services/log-iceberg-retry-marker';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { TenantBackupOperationStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-store';
import { encodePortableIcebergLog } from '@authrim/ar-lib-core/services/tenant-portability/portable-iceberg-log';
import { buildLogIcebergRowRecord } from '@authrim/ar-lib-core/services/log-iceberg-emitter';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { createTenantBackupIcebergLogRestorePorts } from '../tenant-backup-iceberg-log-restore-port';
vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));
const opened: Array<Awaited<ReturnType<typeof logProducerFixture>>> = [];
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
});
async function setup(mode: 'scheduled' | 'pipeline') {
  const base = await logProducerFixture(mode);
  opened.push(base);
  const bucket = base.env.LOG_ARCHIVE;
  if (!bucket) throw new Error('Missing retry bucket');
  const f = {
    ...base,
    env: { ...base.env, LOG_ARCHIVE: bucket },
    db: base.db as typeof base.db & {
      function(name: string, options: { varargs: true }, implementation: () => string): void;
    },
  };
  // Real R2 conditional creation and ETag replacement for cancellation/late-PUT tests.
  f.env.LOG_ARCHIVE.put = vi.fn(async (key: string, value: unknown, options?: R2PutOptions) => {
    const previous = f.objects.get(key),
      condition = options?.onlyIf as R2Conditional | undefined;
    if (condition?.etagDoesNotMatch === '*' && previous) return null;
    if (condition?.etagMatches && (!previous || condition.etagMatches !== key)) return null;
    const text =
      typeof value === 'string'
        ? value
        : value instanceof Uint8Array
          ? new TextDecoder().decode(value)
          : (() => {
              throw new Error('unsupported fixture body');
            })();
    f.objects.set(key, { text, metadata: options?.customMetadata ?? {} });
    return { key, etag: key } as R2Object;
  }) as unknown as R2Bucket['put'];

  const old = await logProducerFixture(mode);
  opened.push(old);
  old.env.LOG_ARCHIVE_CONTENT_HMAC_KEY = 'ac'.repeat(32);
  old.env.OBJECT_ENCRYPTION_ROOT_KEY = 'bc'.repeat(32);
  old.env.LOG_ARCHIVE_ROOT_KEYRING = JSON.stringify({
    schema_version: 1,
    current_version: 1,
    roots: { 1: 'bc'.repeat(32) },
  });
  const record = await buildLogIcebergRowRecord(old.env, {
    tenantId: 'tenant-a',
    sourceDataset: 'admin.admin_audit_log',
    logType: 'admin_audit',
    eventAt: old.now - 5000,
    ingestedAt: old.now - 4000,
    expiresAt: old.now + 30 * 86400000,
    row: {
      id: 'dr-record',
      tenant_id: 'tenant-a',
      action: 'restore.test',
      created_at: old.now - 5000,
      before_json: null,
      after_json: null,
      metadata_json: '{"sensitive":"source-value"}',
    },
    adminInlineMetadata: { admin_actor_id: 'admin-a', admin_actor_type: 'admin_user' },
  });
  const bytes = await encodePortableIcebergLog({
    record,
    tenantId: 'tenant-a',
    tenantKey: 'key-a',
    includeSensitiveDetails: true,
    resolveKeys: async () => ({
      rootKeyHex: 'bc'.repeat(32),
      contentHmacKeyHex: 'ac'.repeat(32),
      keyVersion: 1,
    }),
  });
  const rowJson = new TextDecoder().decode(bytes),
    digest = 'a'.repeat(64),
    now = Date.now();
  for (const name of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '024_tenant_backup_restore_plan_inventory.sql',
  ])
    f.db.exec(
      readFileSync(new URL('../../../../migrations/admin/d1/' + name, import.meta.url), 'utf8')
    );
  f.db
    .prepare(
      `INSERT INTO tenant_backup_operations(id,tenant_id,kind,idempotency_key,request_digest,state,phase,created_by,created_at,updated_at,lease_owner,fencing_token,lease_expires_at) VALUES('import-a','tenant-a','import','idem',?,'running','restore_other_stores','admin-a',?,?,'worker',1,?)`
    )
    .run(digest, now, now, now + 60000);
  f.db
    .prepare(
      `INSERT INTO tenant_backup_restore_plan_inventories(operation_id,tenant_id,input_inventory_digest,state,chain_digest,created_at) VALUES('import-a','tenant-a',?,'sealed',?,?)`
    )
    .run(digest, digest, now);
  const operation = await new TenantBackupOperationStore(f.adapter).get('tenant-a', 'import-a');
  if (!operation) throw new Error('Missing operation');
  const context = {
    operation,
    lease: { tenantId: 'tenant-a', operationId: 'import-a', owner: 'worker', fencingToken: 1 },
    signal: new AbortController().signal,
  };
  f.env.AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT = new Date(f.now).toISOString();
  const env = Object.assign({} as Env, f.env);
  const port = createTenantBackupIcebergLogRestorePorts({
    env,
    tenantKey: 'key-a',
    assertUnpublished: async () => {},
    resolveCore: async () => f.adapter,
  });
  return { f, record, rowJson, digest, context, port };
}
function queueRef(row: Record<string, unknown>) {
  return {
    payload_type: 'iceberg_ingest' as const,
    schema_version: 1 as const,
    id: String(row.id),
    storage_generation: String(row.storage_generation),
    source_dataset: String(row.source_dataset),
    subject_id: row.subject_id as string | null,
    payload_hmac: String(row.payload_hmac),
    payload_key: String(row.payload_key),
    payload_digest: String(row.payload_digest),
    payload_bytes: Number(row.payload_bytes),
    expires_at: row.expires_at as number | null,
  };
}
for (const mode of ['scheduled', 'pipeline'] as const)
  describe(`${mode} logical DR restore with real SQL and target crypto`, () => {
    it('re-encrypts under target keys, keeps original event/expiry, and retries without duplicate logs', async () => {
      const { f, record, rowJson, digest, context, port } = await setup(mode);
      await port.importIcebergLog(context, digest, rowJson);
      await port.importIcebergLog(context, digest, rowJson);
      expect(await port.verifyIcebergLog(context, digest, rowJson)).toBe(true);
      const head = f.db
        .prepare(
          mode === 'scheduled'
            ? 'SELECT * FROM log_iceberg_records'
            : 'SELECT * FROM log_iceberg_outbox'
        )
        .get();
      if (!head) throw new Error('Missing restored body');
      const privateRecord =
        mode === 'scheduled'
          ? (
              await f.staging.read([head as unknown as LogIcebergStagedHead], {
                restoreOperationId: 'import-a',
              })
            )[0]
          : await readLogIcebergRetryPayload(f.env, queueRef(head));
      expect(
        await filterPublishedCoreLogRecords(f.adapter, 'tenant-a', [privateRecord])
      ).toHaveLength(0);
      f.db.exec("UPDATE tenant_backup_operations SET phase='verify_restore_activation'");
      await port.activateRestoredLogHolds(
        { ...context, operation: { ...context.operation, phase: 'verify_restore_activation' } },
        digest
      );
      const rows = await f.rows('admin.admin_audit_log');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'dr-record', action: 'restore.test' });
      expect(f.db.prepare('SELECT COUNT(*) n FROM log_iceberg_records').get()?.n).toBe(
        mode === 'scheduled' ? 1 : 0
      );
      expect(f.queueMessages).toHaveLength(0);
      const header = f.db
        .prepare(
          mode === 'scheduled'
            ? 'SELECT header_json FROM log_iceberg_records'
            : 'SELECT expires_at FROM log_iceberg_outbox'
        )
        .get();
      if (mode === 'scheduled') {
        const parsed: unknown = JSON.parse(String(header?.header_json));
        expect(parsed).toMatchObject({ event_at: record.event_at, expires_at: record.expires_at });
      } else expect(header?.expires_at).toBe(record.expires_at);
    });
    it('rediscovers a restored pending PII purge even when no log bodies were selected', async () => {
      const { f, digest, context, port } = await setup(mode);
      await port.registerRestoredPiiPurgeScope(context, digest);
      expect(
        f.db
          .prepare(
            "SELECT COUNT(*) n FROM log_iceberg_retention_jobs WHERE tenant_id='tenant-a' AND source_dataset='pii.pii_log'"
          )
          .get()?.n
      ).toBe(1);
      expect(f.db.prepare('SELECT COUNT(*) n FROM log_iceberg_records').get()?.n).toBe(0);
      expect(f.objects.size).toBe(0);
    });
    it('keeps historical copies isolated through old hot age, repeated cron, and lease reacquisition', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      await port.importIcebergLog(context, digest, rowJson);
      const future = f.now + 8 * 86400000;
      f.db.function('strftime', { varargs: true }, () => String(Math.floor(future / 1000)));
      f.db.prepare('UPDATE tenant_backup_operations SET lease_expires_at=?').run(future + 60000);
      const catalog = {
        loadTable: vi.fn(async () => {
          throw new Error('held record must not reach Catalog');
        }),
        commit: vi.fn(async () => {
          throw new Error('unexpected Catalog commit');
        }),
      };
      const config = resolveLogIcebergConfig(f.env);
      if (mode === 'scheduled') {
        const result = await exportLogIcebergBatch(config, {
          admin: f.adapter,
          catalog,
          store: () => {
            throw new Error('unexpected R2 export');
          },
        } as Parameters<typeof exportLogIcebergBatch>[1]);
        expect(result.moved).toBe(0);
        expect(f.db.prepare('SELECT COUNT(*) n FROM log_iceberg_records').get()?.n).toBe(1);
      } else {
        const dispatch = vi.fn();
        expect(
          (await dispatchLogIcebergOutboxPage(config, { admin: f.adapter, dispatch })).queued
        ).toBe(0);
        const row = f.db.prepare('SELECT * FROM log_iceberg_outbox').get();
        if (!row) throw new Error('Missing outbox');
        expect(await consumeLogIcebergMessage(queueRef(row), f.env)).toBe(true);
        expect(f.streamRecords).toHaveLength(0);
        const cleanup = await cleanupLogIcebergRetryPage(config, {
          admin: f.adapter,
          catalog,
          store: () => {
            throw new Error('unexpected store');
          },
          objects: f.env.LOG_ARCHIVE,
          resolveTenantKey: async () => 'key-a',
          readPayload: (ref) => readLogIcebergRetryPayload(f.env, ref),
          authenticate: async () => {},
          capturingTenantKeys: async () => new Set(),
          coverTenant: async (_tenant, run) => run(),
        } as Parameters<typeof cleanupLogIcebergRetryPage>[1]);
        expect(cleanup.retired).toBe(0);
        expect(dispatch).not.toHaveBeenCalled();
      }
      expect(catalog.loadTable).not.toHaveBeenCalled();
      expect(await port.verifyIcebergLog(context, digest, rowJson)).toBe(true);
      f.db.exec("UPDATE tenant_backup_operations SET phase='verify_restore_activation'");
      await port.activateRestoredLogHolds(
        { ...context, operation: { ...context.operation, phase: 'verify_restore_activation' } },
        digest
      );
      if (mode === 'pipeline') {
        const writer = f.env.LOG_ARCHIVE_WRITER;
        if (!writer) throw new Error('Missing writer');
        expect(
          (
            await dispatchLogIcebergOutboxPage(config, {
              admin: f.adapter,
              dispatch: (input) => writer.dispatchPipelineReferences(input),
            })
          ).queued
        ).toBe(1);
        await consumeLogIcebergMessage(f.queueMessages[0], f.env);
        expect(f.streamRecords).toHaveLength(1);
      } else
        expect(
          await f.staging.readTenant({
            tenantId: 'tenant-a',
            tenantKey: 'key-a',
            sourceDataset: 'admin.admin_audit_log',
            now: f.now,
          })
        ).toHaveLength(1);
    });
    it('verifies the held copy after the authoritative unpublished Core target moves', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      await port.importIcebergLog(context, digest, rowJson);
      const moved = await logProducerFixture(mode);
      opened.push(moved);
      const reopened = createTenantBackupIcebergLogRestorePorts({
        env: Object.assign({} as Env, f.env, { DB: moved.adapter }),
        tenantKey: 'key-a',
        assertUnpublished: async () => {},
        resolveCore: async () => moved.adapter,
      });
      expect(await reopened.verifyIcebergLog(context, digest, rowJson)).toBe(true);
      expect(f.db.prepare('SELECT state FROM log_iceberg_restore_holds').get()?.state).toBe(
        'holding'
      );
      expect(moved.db.prepare('SELECT COUNT(*) n FROM log_iceberg_records').get()?.n).toBe(0);
    });
    it('publishes one operation witness without updating or scanning the historical cohort', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      await port.importIcebergLog(context, digest, rowJson);
      const config = resolveLogIcebergConfig(f.env);
      f.db
        .prepare(
          "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO log_iceberg_restore_holds(id,operation_id,tenant_id,payload_hmac,storage_generation,state,created_at) SELECT printf('%064x',x),'import-a','tenant-a',?,?,'holding',0 FROM n"
        )
        .run('b'.repeat(64), config.generation);
      f.db.exec(
        "CREATE TRIGGER no_bulk_hold_publication BEFORE UPDATE ON log_iceberg_restore_holds BEGIN SELECT RAISE(ABORT,'row publication is unbounded'); END; UPDATE tenant_backup_operations SET phase='verify_restore_activation'"
      );
      const activated = {
        ...context,
        operation: { ...context.operation, phase: 'verify_restore_activation' },
      };
      const execute = vi.spyOn(f.adapter, 'execute');
      await port.activateRestoredLogHolds(activated, digest);
      expect(f.db.prepare('SELECT state FROM log_iceberg_restore_activations').get()?.state).toBe(
        'active'
      );
      expect(
        f.db.prepare("SELECT COUNT(*) n FROM log_iceberg_restore_holds WHERE state='holding'").get()
          ?.n
      ).toBe(10001);
      expect(
        execute.mock.calls.filter(([sql]) => sql.includes('log_iceberg_restore_activations'))
      ).toHaveLength(1);
      const first = f.db
        .prepare('SELECT activated_at FROM log_iceberg_restore_activations')
        .get()?.activated_at;
      await port.activateRestoredLogHolds(activated, digest);
      expect(
        f.db.prepare('SELECT activated_at FROM log_iceberg_restore_activations').get()?.activated_at
      ).toBe(first);
      expect(
        execute.mock.calls.some(([sql]) => sql.includes('UPDATE log_iceberg_restore_holds'))
      ).toBe(false);
    });
    it('pins activation to the prepared generation and rejects cancellation after publication', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      await port.importIcebergLog(context, digest, rowJson);
      f.db.exec("UPDATE tenant_backup_operations SET phase='verify_restore_activation'");
      const activated = {
        ...context,
        operation: { ...context.operation, phase: 'verify_restore_activation' },
      };
      const wrong = createTenantBackupIcebergLogRestorePorts({
        env: Object.assign({} as Env, f.env, {
          AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: 'wrong-generation',
        }),
        tenantKey: 'key-a',
        assertUnpublished: async () => {},
        resolveCore: async () => f.adapter,
      });
      await expect(wrong.activateRestoredLogHolds(activated, digest)).rejects.toThrow(
        'backup_iceberg_restore_hold_not_activatable'
      );
      await port.activateRestoredLogHolds(activated, digest);
      f.db.exec("UPDATE tenant_backup_operations SET state='cancelling'");
      await expect(
        port.cleanupRestoredLogHolds({
          ...context,
          operation: { ...context.operation, state: 'cancelling' },
        })
      ).rejects.toThrow('backup_iceberg_restore_already_active');
    });
    it('cleans indexed bounded pages with a constant-size remaining-work check', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      await port.importIcebergLog(context, digest, rowJson);
      const config = resolveLogIcebergConfig(f.env);
      f.db
        .prepare(
          "WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<65) INSERT INTO log_iceberg_restore_holds(id,operation_id,tenant_id,payload_hmac,storage_generation,state,created_at) SELECT printf('%064x',x),'import-a','tenant-a',?,?,'holding',0 FROM n"
        )
        .run('b'.repeat(64), config.generation);
      const query = f.db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT id FROM log_iceberg_restore_holds WHERE operation_id=? AND tenant_id=? AND cleanup_completed_at IS NULL ORDER BY id LIMIT 32'
        )
        .all('import-a', 'tenant-a');
      expect(JSON.stringify(query)).toContain('idx_log_iceberg_restore_holds_cleanup');
      expect(JSON.stringify(query)).not.toContain('TEMP B-TREE');
      f.db.exec("UPDATE tenant_backup_operations SET state='cancelling'");
      const cancelling = {
        ...context,
        operation: { ...context.operation, state: 'cancelling' as const },
      };
      const read = vi.spyOn(f.adapter, 'queryOne');
      expect(await port.cleanupRestoredLogHolds(cancelling)).toEqual({
        complete: false,
        remaining: 1,
      });
      expect(
        f.db
          .prepare(
            'SELECT COUNT(*) n FROM log_iceberg_restore_holds WHERE cleanup_completed_at IS NOT NULL'
          )
          .get()?.n
      ).toBe(32);
      expect(await port.cleanupRestoredLogHolds(cancelling)).toEqual({
        complete: false,
        remaining: 1,
      });
      expect(await port.cleanupRestoredLogHolds(cancelling)).toEqual({
        complete: true,
        remaining: 0,
      });
      expect(read.mock.calls.some(([sql]) => sql.includes('COUNT('))).toBe(false);
      expect(f.db.prepare('SELECT state FROM log_iceberg_restore_activations').get()?.state).toBe(
        'aborted'
      );
    });
    it('aborts only its historical copies and rejects delayed preparation after cancellation', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      await port.importIcebergLog(context, digest, rowJson);
      f.db.exec("UPDATE tenant_backup_operations SET state='cancelling'");
      const cancelling = {
        ...context,
        operation: { ...context.operation, state: 'cancelling' as const },
      };
      expect(await port.cleanupRestoredLogHolds(cancelling)).toEqual({
        complete: true,
        remaining: 0,
      });
      expect(f.db.prepare('SELECT state FROM log_iceberg_restore_holds').get()?.state).toBe(
        'aborted'
      );
      expect(f.db.prepare('SELECT COUNT(*) n FROM log_iceberg_records').get()?.n).toBe(0);
      if (mode === 'pipeline') {
        const row = f.db.prepare('SELECT * FROM log_iceberg_outbox').get();
        if (!row) throw new Error('Missing outbox');
        const object = await f.env.LOG_ARCHIVE.head(String(row.payload_key));
        expect(isLogIcebergRetryErasureMarker(object, String(row.id))).toBe(true);
      }
      await expect(port.importIcebergLog(context, digest, rowJson)).rejects.toThrow(
        'backup_iceberg_restore_fenced'
      );
      expect(await port.cleanupRestoredLogHolds(cancelling)).toEqual({
        complete: true,
        remaining: 0,
      });
    });
    it('leaves normal audit records outside the import hold and cancellation', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      await emitLogIcebergRow(f.env, {
        tenantId: 'tenant-a',
        sourceDataset: 'admin.admin_audit_log',
        logType: 'admin_audit',
        eventAt: f.now,
        expiresAt: null,
        row: {
          id: 'normal-audit',
          tenant_id: 'tenant-a',
          action: 'import.requested',
          created_at: f.now,
        },
      });
      await port.importIcebergLog(context, digest, rowJson);
      expect(f.db.prepare('SELECT COUNT(*) n FROM log_iceberg_restore_holds').get()?.n).toBe(1);
      f.db.exec("UPDATE tenant_backup_operations SET state='cancelling'");
      await port.cleanupRestoredLogHolds({
        ...context,
        operation: { ...context.operation, state: 'cancelling' },
      });
      const rows = await f.rows('admin.admin_audit_log');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('normal-audit');
    });
    it('fences a body write already in flight when cancellation records its permanent denial', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      let started!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
          started = resolve;
        }),
        resume = new Promise<void>((resolve) => {
          release = resolve;
        });
      if (mode === 'pipeline') {
        const original = f.env.LOG_ARCHIVE.put.bind(f.env.LOG_ARCHIVE);
        vi.spyOn(f.env.LOG_ARCHIVE, 'put').mockImplementationOnce(async (...args) => {
          started();
          await resume;
          return original(...args);
        });
      } else {
        const original = f.adapter.batch.bind(f.adapter);
        let paused = false;
        vi.spyOn(f.adapter, 'batch').mockImplementation(async (statements) => {
          if (
            !paused &&
            statements.some((statement) =>
              statement.sql.includes('INSERT INTO log_iceberg_records')
            )
          ) {
            paused = true;
            started();
            await resume;
          }
          return original(statements);
        });
      }
      const importing = port.importIcebergLog(context, digest, rowJson).then(
        () => null,
        (error: unknown) => error
      );
      await entered;
      f.db.exec("UPDATE tenant_backup_operations SET state='cancelling'");
      const cancelling = {
        ...context,
        operation: { ...context.operation, state: 'cancelling' as const },
      };
      expect(await port.cleanupRestoredLogHolds(cancelling)).toEqual({
        complete: true,
        remaining: 0,
      });
      release();
      expect(await importing).toBeInstanceOf(Error);
      expect(f.db.prepare('SELECT COUNT(*) n FROM log_iceberg_records').get()?.n).toBe(0);
      if (mode === 'pipeline') {
        const row = f.db.prepare('SELECT * FROM log_iceberg_outbox').get();
        if (!row) throw new Error('Missing outbox');
        expect(
          isLogIcebergRetryErasureMarker(
            await f.env.LOG_ARCHIVE.head(String(row.payload_key)),
            String(row.id)
          )
        ).toBe(true);
      }
      expect(f.streamRecords).toHaveLength(0);
    });
    it('allows original expiry cleanup while the import is still holding without extending the TTL', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      await port.importIcebergLog(context, digest, rowJson);
      const future = f.now + 31 * 86400000;
      f.db.function('strftime', { varargs: true }, () => String(Math.floor(future / 1000)));
      f.db.prepare('UPDATE tenant_backup_operations SET lease_expires_at=?').run(future + 60000);
      if (mode === 'pipeline') {
        const catalog = {
          loadTable: vi.fn(async () => {
            throw new Error('expiry cleanup must not export');
          }),
          commit: vi.fn(async () => {
            throw new Error('unexpected Catalog commit');
          }),
        };
        const result = await cleanupLogIcebergRetryPage(resolveLogIcebergConfig(f.env), {
          admin: f.adapter,
          catalog,
          store: () => {
            throw new Error('unexpected store');
          },
          objects: f.env.LOG_ARCHIVE,
          resolveTenantKey: async () => 'key-a',
          readPayload: (ref) => readLogIcebergRetryPayload(f.env, ref),
          authenticate: async () => {},
          capturingTenantKeys: async () => new Set(),
          coverTenant: async (_tenant, run) => run(),
        } as Parameters<typeof cleanupLogIcebergRetryPage>[1]);
        expect(result.retired).toBe(1);
        expect(f.db.prepare('SELECT state FROM log_iceberg_restore_holds').get()?.state).toBe(
          'aborted'
        );
      } else {
        // Existing total-retention cleanup can remove these expired staging rows; saved() skips them.
        f.db.exec('DELETE FROM log_iceberg_record_parts; DELETE FROM log_iceberg_records');
      }
      const clock = vi.spyOn(Date, 'now').mockReturnValue(future);
      try {
        expect(await port.verifyIcebergLog(context, digest, rowJson)).toBe(true);
      } finally {
        clock.mockRestore();
      }
      expect(f.streamRecords).toHaveLength(0);
    });
    it('keeps the original retention deadline and verifies expired copies without requiring their body', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      const outer = JSON.parse(rowJson) as { record_json: [string, string] },
        inner = JSON.parse(outer.record_json[1]) as Record<string, unknown>;
      inner.expires_at = Date.now() - 1;
      outer.record_json[1] = JSON.stringify(inner);
      const expired = JSON.stringify(outer);
      await port.importIcebergLog(context, digest, expired);
      expect(await port.verifyIcebergLog(context, digest, expired)).toBe(true);
      expect(f.db.prepare('SELECT COUNT(*) n FROM log_iceberg_restore_holds').get()?.n).toBe(0);
      expect(f.objects.size).toBe(0);
    });
    it('rejects an old operation fence and a cross-tenant portable row', async () => {
      const { f, rowJson, digest, context, port } = await setup(mode);
      f.db.exec('UPDATE tenant_backup_operations SET fencing_token=2');
      await expect(port.importIcebergLog(context, digest, rowJson)).rejects.toThrow(
        'backup_iceberg_restore_fenced'
      );
      expect(f.objects.size).toBe(0);
      f.db.exec('UPDATE tenant_backup_operations SET fencing_token=1');
      const other = JSON.parse(rowJson) as Record<string, unknown>;
      other.tenant_id = ['text', 'tenant-b'];
      await expect(port.importIcebergLog(context, digest, JSON.stringify(other))).rejects.toThrow(
        'backup_iceberg_log_record_invalid'
      );
    });
  });
