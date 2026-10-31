import { readRenderedMigrationSql } from '../../../../../test/helpers/migration-source.mjs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { TenantBackupMutationAdmission } from '../tenant-portability/mutation-admission';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import {
  coreLogPublicationSource,
  coreLogPublicationEnvironmentPermitId,
  filterPublishedCoreLogRecords,
  prepareCoreLogPublication,
  type CoreLogPublicationSource,
} from '../log-iceberg-core-publication';
import { createLogIcebergWritePort, type LogIcebergRuntimeEnv } from '../log-iceberg-runtime';
import { exportLogIcebergBatch } from '../log-iceberg-export';
import { logIcebergRecordId } from '../log-iceberg-store';
import { logIcebergRetryMarkerMetadata } from '../log-iceberg-retry-marker';
import { icebergFixture } from './log-iceberg-test-fixture';

vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));

const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((fn) => fn()));
function completeAdapter(adapter: DatabaseAdapter) {
  Object.assign(adapter, {
    transaction: async () => {
      throw new Error('Use atomic batch');
    },
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    getType: () => 'd1',
    close: async () => {},
  });
}
async function fixture(mode: 'pipeline' | 'scheduled', actualControl = false, samlDr = false) {
  const f = await icebergFixture(),
    core = sqliteAdapter();
  close.push(
    () => f.db.close(),
    () => core.db.close()
  );
  completeAdapter(f.adapter);
  completeAdapter(core.adapter);
  f.db
    .prepare(
      'INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,?,?,?)'
    )
    .run('tenant-a', 'tenant-a', 'key-a', 'Tenant', f.now, f.now);
  core.db.exec(
    "CREATE TABLE business_state(id TEXT PRIMARY KEY,value INTEGER NOT NULL); INSERT INTO business_state VALUES('business',0)"
  );
  const source: CoreLogPublicationSource = {
    environmentId: 'test',
    tenantId: 'tenant-a',
    bindingRef: 'DB',
    databaseId: 'source-db',
    provider: 'd1',
    generation: 1,
    bindingRouteGeneration: 1,
    dataRole: 'tenant_core',
    residencyPartition: 'default',
    shardId: 'default',
    shardGroup: 'default',
    shardIndex: 0,
  };
  const controlDb = new DatabaseSync(':memory:');
  close.push(() => controlDb.close());
  for (const file of ['001_0_5_0_control_baseline.sql'])
    controlDb.exec(
      readRenderedMigrationSql(
        new URL(`../../../../../migrations/control/d1/`, import.meta.url),
        `${file}`
      )
    );
  const admission = new TenantBackupMutationAdmission(
    {
      async queryOne<T>(sql: string, params: unknown[] = []) {
        return (
          (controlDb.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null
        );
      },
      async execute(sql: string, params: unknown[] = []) {
        return {
          success: true,
          rowsAffected: Number(controlDb.prepare(sql).run(...(params as SQLInputValue[])).changes),
        };
      },
    },
    'test',
    true,
    samlDr
  );
  const objects = new Map<
    string,
    { text: string; metadata: Record<string, string>; etag: string }
  >();
  let revision = 0;
  const put = vi.fn(async (key: string, value: string | Uint8Array, options: R2PutOptions = {}) => {
    const current = objects.get(key),
      condition = options.onlyIf as R2Conditional | undefined;
    if (
      (condition?.etagDoesNotMatch === '*' && current) ||
      (condition?.etagMatches && current?.etag !== condition.etagMatches)
    )
      return null;
    const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
    const object = { text, metadata: options.customMetadata ?? {}, etag: String(++revision) };
    objects.set(key, object);
    return { key, etag: object.etag };
  });
  const head = vi.fn(async (key: string) => {
    const object = objects.get(key);
    return object
      ? {
          size: new TextEncoder().encode(object.text).length,
          customMetadata: object.metadata,
          etag: object.etag,
        }
      : null;
  });
  const get = vi.fn(async (key: string) => {
    const object = objects.get(key);
    if (!object) return null;
    const data = new TextEncoder().encode(object.text);
    return {
      size: data.length,
      customMetadata: object.metadata,
      etag: object.etag,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
    };
  });
  const send = vi.fn(async () => {});
  const config = {
    ...f.config,
    mode,
    dbRetentionDays: mode === 'scheduled' ? 7 : null,
    exportIntervalMinutes: mode === 'scheduled' ? 10 : null,
  };
  const env: LogIcebergRuntimeEnv = {
    DB: f.adapter,
    DB_ADMIN: f.adapter,
    LOG_ARCHIVE: { put, head, get } as unknown as R2Bucket,
    LOGGING_DELIVERY_QUEUE: { send } as unknown as NonNullable<
      LogIcebergRuntimeEnv['LOGGING_DELIVERY_QUEUE']
    >,
    LOG_ARCHIVE_STREAM: { send: vi.fn(async () => {}) },
    CONTROL: {
      acquireTenantBackupMutationPermit: async (value: { tenantId: string; permitId: string }) => ({
        admitted: actualControl
          ? await admission.acquire(value.tenantId, value.permitId, Date.now())
          : true,
      }),
      completeTenantBackupMutationPermit: async (value: { tenantId: string; permitId: string }) => {
        if (actualControl) await admission.complete(value.tenantId, value.permitId, Date.now());
      },
    } as unknown as NonNullable<LogIcebergRuntimeEnv['CONTROL']>,
    OBJECT_ENCRYPTION_ROOT_KEY: f.keys.rootKeyHex,
    LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
      schema_version: 1,
      current_version: 1,
      roots: { 1: f.keys.rootKeyHex },
    }),
    LOG_ARCHIVE_CONTENT_HMAC_KEY: f.keys.contentHmacKeyHex,
    AUTHRIM_LOG_ARCHIVE_MODE: mode,
    AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: config.generation,
    AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
    AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: new Date(config.activatedAt).toISOString(),
    AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: config.accountId,
    AUTHRIM_LOG_ARCHIVE_BUCKET: config.bucket,
    AUTHRIM_LOG_ARCHIVE_CATALOG_URI: config.catalogUri,
    AUTHRIM_LOG_ARCHIVE_WAREHOUSE: config.warehouse,
    AUTHRIM_LOG_ARCHIVE_NAMESPACE: config.namespace,
    AUTHRIM_LOG_ARCHIVE_TABLE: config.table,
    AUTHRIM_LOG_ARCHIVE_TABLE_UUID: config.tableUuid,
    AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: config.physicalFingerprint,
    ...(mode === 'scheduled'
      ? {
          AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7',
          AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '10',
        }
      : {}),
  };
  if (samlDr) {
    env.ENABLE_SAML_DR_EXPORT = 'true';
    env.SAML_DR_MUTATION_CONTROL = {
      acquireEnvironmentBackupMutationPermit: async ({ permitId }) => ({
        admitted: await admission.acquireEnvironment(permitId, Date.now()),
      }),
      completeEnvironmentBackupMutationPermit: async ({ permitId }) => {
        await admission.completeEnvironment(permitId, Date.now());
      },
    };
  }
  const resolver = vi.fn(async () => core.adapter);
  const port = createLogIcebergWritePort(env, config, () => f.now, {
    resolveCorePublicationSource: resolver,
  });
  env.LOG_ARCHIVE_WRITER = port;
  const prepare = (id = 'audit-1', value = 'private detail', ingestedAt = f.now) =>
    prepareCoreLogPublication(env, core.adapter, {
      tenantId: 'tenant-a',
      sourceDataset: 'core.operational_logs',
      logType: 'operational',
      eventAt: f.now,
      expiresAt: f.now + 86400000,
      ingestedAt,
      row: { id, tenant_id: 'tenant-a', action: 'group.update', metadata_json: value },
      source,
    });
  const predicate = {
    where: "EXISTS(SELECT 1 FROM business_state WHERE id='business' AND value=1)",
    params: [],
  };
  const business = {
    sql: "UPDATE business_state SET value=1 WHERE id='business' AND value=0",
    params: [],
  };
  const visible = () =>
    f.staging.readTenant({
      tenantId: 'tenant-a',
      tenantKey: 'key-a',
      sourceDataset: 'core.operational_logs',
      now: f.now,
    });
  return {
    ...f,
    core,
    controlDb,
    admission,
    source,
    prepare,
    predicate,
    business,
    port,
    env,
    objects,
    put,
    get,
    head,
    send,
    resolver,
    visible,
  };
}

for (const mode of ['scheduled', 'pipeline'] as const)
  describe(`Core publication atomicity (${mode})`, () => {
    it('reuses the exact durable environment permit after its acquisition ACK is lost', async () => {
      const f = await fixture(mode, true, true),
        control = f.env.SAML_DR_MUTATION_CONTROL;
      if (!control?.acquireEnvironmentBackupMutationPermit) throw new Error('missing control');
      const acquire = control.acquireEnvironmentBackupMutationPermit.bind(control);
      let lost = false;
      control.acquireEnvironmentBackupMutationPermit = async (input) => {
        const result = await acquire(input);
        const source = f.core.db
          .prepare('SELECT source_token FROM log_iceberg_core_publications')
          .get();
        if (
          !lost &&
          source &&
          input.permitId ===
            (await coreLogPublicationEnvironmentPermitId(String(source.source_token)))
        ) {
          lost = true;
          throw new Error('lost environment acquire ACK');
        }
        return result;
      };
      const prepared = await f.prepare();
      expect(lost).toBe(true);
      expect(
        f.controlDb
          .prepare(
            'SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL'
          )
          .get()?.n
      ).toBe(2);
      await f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate));
      await prepared.dispatch();
      expect(
        f.controlDb
          .prepare(
            'SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL'
          )
          .get()?.n
      ).toBe(0);
    });
    it('does not skip replication admission to resume a durable publication', async () => {
      const f = await fixture(mode, true, true),
        original = f.port.prepareCorePublication.bind(f.port);
      vi.spyOn(f.port, 'prepareCorePublication').mockImplementationOnce(async (input) => {
        f.env.AUTHRIM_REPLICATION_WRITER = JSON.stringify({
          version: 2,
          endpoint: 'https://authority.example.test/replication/v1/rpc',
          credentialId: 'writer-a',
          pairId: 'pair-a',
          environmentId: 'test',
          deploymentId: 'cf-a',
          epoch: 1,
          generationId: 'gen-a',
        });
        f.env.AUTHRIM_REPLICATION_WRITER_SECRET = 'a'.repeat(64);
        return original(input);
      });
      const authority = vi.fn(async () => Response.json({ error: 'draining' }, { status: 409 }));
      vi.stubGlobal('fetch', authority);
      try {
        await expect(f.prepare()).rejects.toThrow('replication_authority_unavailable');
        expect(authority).toHaveBeenCalledOnce();
        expect(f.put).not.toHaveBeenCalled();
        expect(
          f.core.db.prepare('SELECT body_prepared FROM log_iceberg_core_publications').get()
            ?.body_prepared
        ).toBe(0);
        expect(
          f.controlDb
            .prepare(
              'SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL'
            )
            .get()?.n
        ).toBe(2);
      } finally {
        vi.unstubAllGlobals();
      }
    });
    it('continues body preparation and publication with distinct durable environment/tenant permits after draining begins', async () => {
      const f = await fixture(mode, true, true);
      const original = f.port.prepareCorePublication.bind(f.port);
      const boundary = {
        id: 'strict-boundary',
        tenantId: 'tenant-a',
        operationId: 'backup',
        inventoryDigest: 'a'.repeat(64),
        now: Date.now(),
      };
      vi.spyOn(f.port, 'prepareCorePublication').mockImplementationOnce(async (input) => {
        const permits = f.controlDb
          .prepare('SELECT id,scope FROM tenant_backup_mutation_permits WHERE completed_at IS NULL')
          .all();
        expect(permits).toHaveLength(2);
        expect(permits.map((row) => row.scope).sort()).toEqual(['environment', 'tenant']);
        const environmentId = await coreLogPublicationEnvironmentPermitId(input.sourceToken);
        expect(environmentId).not.toBe(input.sourceToken);
        expect(environmentId).toMatch(
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
        );
        expect(permits.some((row) => row.id === environmentId)).toBe(true);
        await f.admission.begin(boundary);
        expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).toBeNull();
        return original(input);
      });
      const prepared = await f.prepare();
      await f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate));
      await prepared.dispatch();
      expect(
        f.controlDb
          .prepare(
            'SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL'
          )
          .get()?.n
      ).toBe(0);
      expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).not.toBeNull();
      expect(
        f.core.db.prepare('SELECT state FROM log_iceberg_core_publications').get()?.state
      ).toBe('published');
    });
    it.each(['before', 'after'] as const)(
      'recovers %s lost durable environment completion without reopening permits or duplicating payloads',
      async (lost) => {
        const f = await fixture(mode, true, true),
          prepared = await f.prepare();
        await f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate));
        const control = f.env.SAML_DR_MUTATION_CONTROL;
        if (!control) throw new Error('missing environment control');
        const complete = control.completeEnvironmentBackupMutationPermit.bind(control);
        let lose = true;
        control.completeEnvironmentBackupMutationPermit = async (input) => {
          if (lose) {
            lose = false;
            if (lost === 'after') await complete(input);
            throw new Error('lost environment ACK');
          }
          await complete(input);
        };
        const boundary = {
          id: 'ack-boundary',
          tenantId: 'tenant-a',
          operationId: 'backup',
          inventoryDigest: 'a'.repeat(64),
          now: Date.now(),
        };
        await f.admission.begin(boundary);
        await expect(prepared.dispatch()).rejects.toThrow('lost environment ACK');
        if (lost === 'before') {
          expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).toBeNull();
          expect(
            f.db.prepare('SELECT finalized FROM log_iceberg_publications').get()?.finalized
          ).toBe(0);
          await f.port.reconcileCorePublications();
        } else {
          expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).not.toBeNull();
        }
        expect(
          f.controlDb
            .prepare(
              'SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL'
            )
            .get()?.n
        ).toBe(0);
        expect(
          f.db
            .prepare(
              `SELECT COUNT(*) AS n FROM ${mode === 'pipeline' ? 'log_iceberg_outbox' : 'log_iceberg_event_receipts'}`
            )
            .get()?.n
        ).toBe(1);
        expect(f.put.mock.calls.length).toBe(mode === 'pipeline' ? 1 : 0);
        expect(
          f.controlDb
            .prepare(
              "SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE scope='environment' AND completed_at IS NOT NULL"
            )
            .get()?.n
        ).toBeGreaterThanOrEqual(2);
      }
    );
    it.each([61000, 21 * 60 * 1000])(
      'aborts the expired source fence and closes both strict permits while draining (delay=%s)',
      async (delay) => {
        const f = await fixture(mode, true, true),
          prepared = await f.prepare();
        const boundary = {
          id: 'expire-boundary',
          tenantId: 'tenant-a',
          operationId: 'backup',
          inventoryDigest: 'a'.repeat(64),
          now: Date.now(),
        };
        await f.admission.begin(boundary);
        f.core.db.function('strftime', { varargs: true }, () =>
          String(Math.floor((Date.now() + delay) / 1000))
        );
        await f.port.reconcileCorePublications();
        expect(
          f.core.db.prepare('SELECT state FROM log_iceberg_core_publications').get()?.state
        ).toBe('aborted');
        expect(
          f.controlDb
            .prepare(
              'SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL'
            )
            .get()?.n
        ).toBe(0);
        expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).not.toBeNull();
        await expect(
          f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate))
        ).rejects.toThrow();
        expect(f.core.db.prepare('SELECT value FROM business_state').get()?.value).toBe(0);
      }
    );
    it('does not close the shared durable admission when another publisher is still finishing its owned writes', async () => {
      const f = await fixture(mode, true, true),
        prepared = await f.prepare();
      await f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate));
      const execute = f.core.adapter.execute.bind(f.core.adapter);
      let release!: () => void, entered!: () => void;
      const gated = new Promise<void>((resolve) => {
          release = resolve;
        }),
        started = new Promise<void>((resolve) => {
          entered = resolve;
        });
      let blocked = false;
      vi.spyOn(f.core.adapter, 'execute').mockImplementation(async (sql, params) => {
        const result = await execute(sql, params);
        if (
          !blocked &&
          sql.startsWith('UPDATE log_iceberg_core_publications SET admission_completed_at=')
        ) {
          blocked = true;
          entered();
          await gated;
        }
        return result;
      });
      const first = prepared.dispatch();
      await started;
      // Lease age is not proof the first publisher stopped its request-owned I/O.
      f.core.db.function('strftime', { varargs: true }, () =>
        String(Math.floor((Date.now() + 61000) / 1000))
      );
      f.db.function('strftime', { varargs: true }, () =>
        String(Math.floor((Date.now() + 61000) / 1000))
      );
      const boundary = {
        id: 'concurrent-publish-boundary',
        tenantId: 'tenant-a',
        operationId: 'backup',
        inventoryDigest: 'a'.repeat(64),
        now: Date.now(),
      };
      await f.admission.begin(boundary);
      try {
        await prepared.dispatch().catch(() => undefined);
        expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).toBeNull();
        expect(
          f.controlDb
            .prepare(
              "SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE scope='environment' AND completed_at IS NULL"
            )
            .get()?.n
        ).toBe(1);
      } finally {
        release();
        await first;
      }
      expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).not.toBeNull();
    });
    it('retains the durable environment admission when the tenant permit is denied, then aborts safely through its source fence', async () => {
      const f = await fixture(mode, true, true),
        control = f.env.CONTROL;
      if (!control?.acquireTenantBackupMutationPermit) throw new Error('missing tenant control');
      const acquire = control.acquireTenantBackupMutationPermit.bind(control);
      control.acquireTenantBackupMutationPermit = async () => ({ admitted: false });
      await expect(f.prepare()).rejects.toThrow('log_core_publication_admission_unavailable');
      expect(f.put).not.toHaveBeenCalled();
      expect(
        f.controlDb
          .prepare(
            "SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE scope='environment' AND completed_at IS NULL"
          )
          .get()?.n
      ).toBe(1);
      control.acquireTenantBackupMutationPermit = acquire;
      const boundary = {
        id: 'partial-reserve-boundary',
        tenantId: 'tenant-a',
        operationId: 'backup',
        inventoryDigest: 'a'.repeat(64),
        now: Date.now(),
      };
      await f.admission.begin(boundary);
      expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).toBeNull();
      f.core.db.function('strftime', { varargs: true }, () =>
        String(Math.floor((Date.now() + 61000) / 1000))
      );
      await f.port.reconcileCorePublications();
      expect(
        f.core.db.prepare('SELECT state FROM log_iceberg_core_publications').get()?.state
      ).toBe('aborted');
      expect(
        f.controlDb
          .prepare(
            'SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL'
          )
          .get()?.n
      ).toBe(0);
      expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).not.toBeNull();
    });
    it('refuses a new strict reservation before source or payload creation once backup draining starts', async () => {
      const f = await fixture(mode, true, true);
      await f.admission.begin({
        id: 'deny-boundary',
        tenantId: 'tenant-a',
        operationId: 'backup',
        inventoryDigest: 'a'.repeat(64),
        now: Date.now(),
      });
      await expect(f.prepare()).rejects.toThrow('backup_mutation_unavailable');
      expect(
        f.core.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_core_publications').get()?.n
      ).toBe(0);
      expect(f.put).not.toHaveBeenCalled();
    });
    it('keeps its durable permit while a backup drains and closes it only after source publication', async () => {
      const f = await fixture(mode, true),
        prepared = await f.prepare();
      const source = f.core.db
        .prepare('SELECT source_token FROM log_iceberg_core_publications')
        .get();
      expect(
        f.controlDb
          .prepare('SELECT completed_at FROM tenant_backup_mutation_permits WHERE id=?')
          .get(String(source?.source_token))?.completed_at
      ).toBeNull();
      const boundary = {
        id: 'boundary',
        tenantId: 'tenant-a',
        operationId: 'backup',
        inventoryDigest: 'a'.repeat(64),
        now: Date.now(),
      };
      await f.admission.begin(boundary);
      expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).toBeNull();
      await f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate));
      await prepared.dispatch();
      expect(
        typeof f.controlDb
          .prepare('SELECT completed_at FROM tenant_backup_mutation_permits WHERE id=?')
          .get(String(source?.source_token))?.completed_at
      ).toBe('number');
      expect(await f.admission.hold(boundary.tenantId, boundary.id, Date.now())).not.toBeNull();
    });
    it('rejects a delayed body preparation before creating staging parts or retry payloads once the source deadline expires', async () => {
      const f = await fixture(mode, true);
      const prepare = f.port.prepareCorePublication.bind(f.port);
      vi.spyOn(f.port, 'prepareCorePublication').mockImplementationOnce(async (input) => {
        f.core.db.function('strftime', { varargs: true }, () =>
          String(Math.floor((Date.now() + 61000) / 1000))
        );
        return prepare(input);
      });
      await expect(f.prepare()).rejects.toThrow('log_core_publication_admission_expired');
      expect(f.put).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_record_parts').get()?.n).toBe(0);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_outbox').get()?.n).toBe(0);
      expect(
        f.core.db.prepare('SELECT body_prepared FROM log_iceberg_core_publications').get()
          ?.body_prepared
      ).toBe(0);
    });
    it('aborts an expired admission before release and rejects late batches even after Control tombstone cleanup', async () => {
      const f = await fixture(mode, true),
        prepared = await f.prepare();
      f.core.db.function('strftime', { varargs: true }, () =>
        String(Math.floor((Date.now() + 61000) / 1000))
      );
      await expect(
        f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate))
      ).rejects.toThrow();
      expect(f.core.db.prepare('SELECT value FROM business_state').get()?.value).toBe(0);
      await f.port.reconcileCorePublications();
      expect(
        f.core.db.prepare('SELECT state FROM log_iceberg_core_publications').get()?.state
      ).toBe('aborted');
      expect(
        f.controlDb
          .prepare(
            'SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL'
          )
          .get()?.n
      ).toBe(0);
      f.controlDb.exec('DELETE FROM tenant_backup_mutation_permits');
      await expect(
        f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate))
      ).rejects.toThrow();
      expect(f.core.db.prepare('SELECT value FROM business_state').get()?.value).toBe(0);
    });
    it.each([false, true])(
      'recovers lost tenant acquire/completion acknowledgements without duplicating capability (strict=%s)',
      async (strict) => {
        const f = await fixture(mode, true, strict),
          control = f.env.CONTROL;
        if (
          !control?.acquireTenantBackupMutationPermit ||
          !control.completeTenantBackupMutationPermit
        )
          throw new Error('missing control');
        const acquire = control.acquireTenantBackupMutationPermit.bind(control),
          complete = control.completeTenantBackupMutationPermit.bind(control);
        let loseAcquire = true;
        control.acquireTenantBackupMutationPermit = async (value) => {
          const result = await acquire(value);
          if (loseAcquire) {
            loseAcquire = false;
            throw new Error('lost acquire ACK');
          }
          return result;
        };
        const prepared = await f.prepare();
        expect(
          f.controlDb
            .prepare(
              'SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL'
            )
            .get()?.n
        ).toBe(strict ? 2 : 1);
        await f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate));
        let loseComplete = true;
        control.completeTenantBackupMutationPermit = async (value) => {
          await complete(value);
          if (loseComplete) {
            loseComplete = false;
            throw new Error('lost complete ACK');
          }
        };
        await expect(prepared.dispatch()).rejects.toThrow('lost complete ACK');
        expect(
          f.core.db.prepare('SELECT state FROM log_iceberg_core_publications').get()?.state
        ).toBe('published');
        expect(
          f.db.prepare('SELECT finalized FROM log_iceberg_publications').get()?.finalized
        ).toBe(0);
        await f.port.reconcileCorePublications();
        expect(
          f.db.prepare('SELECT finalized FROM log_iceberg_publications').get()?.finalized
        ).toBe(1);
        expect(
          f.controlDb
            .prepare(
              'SELECT COUNT(*) AS n FROM tenant_backup_mutation_permits WHERE completed_at IS NULL'
            )
            .get()?.n
        ).toBe(0);
      }
    );
    it('keeps prepared data invisible and publishes only after the source business commit', async () => {
      const f = await fixture(mode),
        prepared = await f.prepare();
      expect(await f.visible()).toEqual([]);
      expect(await filterPublishedCoreLogRecords(f.adapter, 'tenant-a', [prepared.record])).toEqual(
        []
      );
      expect(f.send).not.toHaveBeenCalled();
      expect(
        f.core.db.prepare('SELECT state,body_prepared FROM log_iceberg_core_publications').get()
      ).toMatchObject({ state: 'prepared', body_prepared: 1 });
      expect(
        JSON.stringify(f.core.db.prepare('SELECT * FROM log_iceberg_core_publications').all())
      ).not.toContain('private detail');
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(
        mode === 'scheduled' ? 1 : 0
      );
      expect(f.put).toHaveBeenCalledTimes(mode === 'pipeline' ? 1 : 0);
      await f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate));
      expect(await f.visible()).toEqual([]);
      // A crash here is recovered entirely from durable source metadata.
      expect(await f.port.reconcileCorePublications()).toEqual({
        published: 1,
        aborted: 0,
        retained: 0,
      });
      expect(
        await filterPublishedCoreLogRecords(f.adapter, 'tenant-a', [prepared.record])
      ).toHaveLength(1);
      expect(await f.visible()).toHaveLength(mode === 'scheduled' ? 1 : 0);
      expect(f.send).toHaveBeenCalledTimes(mode === 'pipeline' ? 1 : 0);
      expect(
        f.core.db.prepare('SELECT state FROM log_iceberg_core_publications').get()?.state
      ).toBe('published');
      expect(f.db.prepare('SELECT finalized FROM log_iceberg_publications').get()?.finalized).toBe(
        1
      );
    });
    it('does not publish a CAS0 or rolled-back business mutation', async () => {
      const f = await fixture(mode),
        prepared = await f.prepare();
      await f.core.adapter.batch(
        prepared.wrapBusinessBatch([{ sql: 'SELECT 1', params: [] }], f.predicate)
      );
      await prepared.dispatch();
      expect(f.db.prepare('SELECT state FROM log_iceberg_publications').get()?.state).toBe(
        'prepared'
      );
      expect(f.send).not.toHaveBeenCalled();
      await expect(
        f.core.adapter.batch(
          prepared.wrapBusinessBatch(
            [
              f.business,
              { sql: 'INSERT INTO business_state VALUES(?,?)', params: ['business', 9] },
            ],
            f.predicate
          )
        )
      ).rejects.toThrow();
      expect(f.core.db.prepare('SELECT value FROM business_state').get()?.value).toBe(0);
      expect(
        f.core.db.prepare('SELECT state FROM log_iceberg_core_publications').get()?.state
      ).toBe('prepared');
      expect(await f.visible()).toEqual([]);
    });
    it('aborts source first, prevents a late commit, and retires ciphertext with the same-key marker', async () => {
      const f = await fixture(mode),
        prepared = await f.prepare();
      const key = [...f.objects.keys()][0];
      expect(await f.port.reconcileCorePublications({ orphanBefore: Date.now() + 100000 })).toEqual(
        { published: 0, aborted: 1, retained: 0 }
      );
      expect(
        f.core.db.prepare('SELECT state FROM log_iceberg_core_publications').get()?.state
      ).toBe('aborted');
      await expect(
        f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate))
      ).rejects.toThrow();
      expect(f.core.db.prepare('SELECT value FROM business_state').get()?.value).toBe(0);
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(0);
      expect(f.send).not.toHaveBeenCalled();
      if (mode === 'pipeline') {
        expect(f.objects.get(key)?.text).toBe('');
        expect(f.objects.get(key)?.metadata).toEqual(
          logIcebergRetryMarkerMetadata(await logIcebergRecordId(prepared.record))
        );
        const erased = f.db.prepare('SELECT state,payload_erased_at FROM log_iceberg_outbox').get();
        expect(erased?.state).toBe('erased');
        expect(typeof erased?.payload_erased_at).toBe('number');
      } else expect(f.put).not.toHaveBeenCalled();
    });
    it('retains prepared bodies if source proof is unreachable, and does not leak them through cold reads', async () => {
      const f = await fixture(mode),
        prepared = await f.prepare();
      f.resolver.mockRejectedValue(new Error('source unreachable'));
      expect(await f.port.reconcileCorePublications({ orphanBefore: Date.now() + 100000 })).toEqual(
        { published: 0, aborted: 0, retained: 1 }
      );
      expect(
        f.db.prepare('SELECT state,finalized FROM log_iceberg_publications').get()
      ).toMatchObject({ state: 'prepared', finalized: 0 });
      expect(await filterPublishedCoreLogRecords(f.adapter, 'tenant-a', [prepared.record])).toEqual(
        []
      );
      expect(f.send).not.toHaveBeenCalled();
    });
    it('reuses the first prepared envelope on retry and refuses another content HMAC', async () => {
      const f = await fixture(mode),
        first = await f.prepare(),
        original = [...f.objects.values()][0]?.text;
      const head = f.db.prepare('SELECT header_json FROM log_iceberg_records').get()?.header_json;
      const again = await f.prepare();
      expect(again.publicationId).toBe(first.publicationId);
      if (mode === 'pipeline') expect([...f.objects.values()][0]?.text).toBe(original);
      else
        expect(f.db.prepare('SELECT header_json FROM log_iceberg_records').get()?.header_json).toBe(
          head
        );
      await expect(f.prepare('audit-1', 'changed detail')).rejects.toThrow();
      expect(f.send).not.toHaveBeenCalled();
    });

    it('recovers body-ready ACK loss and never creates another envelope', async () => {
      const f = await fixture(mode),
        originalExecute = f.core.adapter.execute.bind(f.core.adapter);
      let crash = true;
      f.core.adapter.execute = async (sql, params) => {
        if (crash && sql.includes('SET body_prepared=1')) {
          crash = false;
          throw new Error('crash before body-ready ACK');
        }
        return originalExecute(sql, params);
      };
      await expect(f.prepare()).rejects.toThrow('crash before body-ready ACK');
      expect(
        f.core.db.prepare('SELECT body_prepared FROM log_iceberg_core_publications').get()
          ?.body_prepared
      ).toBe(0);
      const first =
        mode === 'pipeline'
          ? [...f.objects.values()][0]?.text
          : f.db.prepare('SELECT header_json FROM log_iceberg_records').get()?.header_json;
      expect(await f.visible()).toEqual([]);
      const prepared = await f.prepare();
      const after =
        mode === 'pipeline'
          ? [...f.objects.values()][0]?.text
          : f.db.prepare('SELECT header_json FROM log_iceberg_records').get()?.header_json;
      expect(after).toBe(first);
      await f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate));
      await prepared.dispatch();
      expect(f.db.prepare('SELECT state FROM log_iceberg_publications').get()?.state).toBe(
        'published'
      );
    });
    it('creates an aborted source tombstone before deleting an orphan whose source row disappeared', async () => {
      const f = await fixture(mode),
        prepared = await f.prepare();
      f.core.db.exec('DELETE FROM log_iceberg_core_publications');
      await f.port.reconcileCorePublications({ orphanBefore: Date.now() + 100000 });
      expect(
        f.core.db.prepare('SELECT state FROM log_iceberg_core_publications').get()?.state
      ).toBe('aborted');
      await expect(
        f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate))
      ).rejects.toThrow();
      expect(f.core.db.prepare('SELECT value FROM business_state').get()?.value).toBe(0);
    });
    it('does not publish after the Admin lease expires between source proof and publication', async () => {
      const f = await fixture(mode),
        prepared = await f.prepare();
      await f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate));
      const originalResolve = f.resolver.getMockImplementation();
      if (!originalResolve) throw new Error('missing fixture resolver');
      f.resolver.mockImplementation(async (source) => {
        const core = await originalResolve(source);
        f.db.exec('UPDATE scheduled_task_leases SET lease_until=0');
        return core;
      });
      await expect(prepared.dispatch()).rejects.toThrow('log_iceberg_stale_fence');
      expect(f.db.prepare('SELECT state FROM log_iceberg_publications').get()?.state).toBe(
        'prepared'
      );
      expect(f.send).not.toHaveBeenCalled();
      expect(await f.visible()).toEqual([]);
      f.resolver.mockImplementation(originalResolve);
      await prepared.dispatch();
      expect(f.db.prepare('SELECT state FROM log_iceberg_publications').get()?.state).toBe(
        'published'
      );
    });
    it.each([false, true])(
      'retains physical prepared data during an active DR capture after installing the abort fence (strict=%s)',
      async (strict) => {
        const f = await fixture(mode, strict, strict);
        await f.prepare();
        f.db
          .prepare(
            "INSERT INTO tenant_backup_snapshots(id,tenant_id,tenant_key,state) VALUES('snapshot','tenant-a','key-a','capturing')"
          )
          .run();
        await f.port.reconcileCorePublications({ orphanBefore: Date.now() + 100000 });
        expect(
          f.db.prepare('SELECT state,finalized FROM log_iceberg_publications').get()
        ).toMatchObject({ state: 'aborted', finalized: 0 });
        expect(
          f.core.db.prepare('SELECT state FROM log_iceberg_core_publications').get()?.state
        ).toBe('aborted');
        if (mode === 'pipeline') expect([...f.objects.values()][0]?.text.length).toBeGreaterThan(0);
        else expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(1);
        expect(await f.visible()).toEqual([]);
        f.db.exec(
          "UPDATE tenant_backup_snapshots SET state='sealed'; UPDATE log_iceberg_publications SET next_attempt_at=0"
        );
        await f.port.reconcileCorePublications({ orphanBefore: Date.now() + 100000 });
        expect(
          f.db.prepare('SELECT finalized FROM log_iceberg_publications').get()?.finalized
        ).toBe(1);
      }
    );
    it('refuses to claim an already direct event as a new Core publication', async () => {
      const f = await fixture(mode);
      const builder = await import('../log-iceberg-emitter');
      const record = await builder.buildLogIcebergRowRecord(f.env, {
        tenantId: 'tenant-a',
        sourceDataset: 'core.operational_logs',
        logType: 'operational',
        eventAt: f.now,
        expiresAt: f.now + 86400000,
        ingestedAt: f.now,
        row: {
          id: 'audit-1',
          tenant_id: 'tenant-a',
          action: 'group.update',
          metadata_json: 'private detail',
        },
      });
      await f.port.writeRecords({
        tenantId: 'tenant-a',
        storageGeneration: f.config.generation,
        records: [record],
      });
      await expect(f.prepare()).rejects.toThrow('log_core_publication_admin_missing');
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_publications').get()?.n).toBe(0);
      expect(await filterPublishedCoreLogRecords(f.adapter, 'tenant-a', [record])).toEqual([
        record,
      ]);
    });
    it('prevents a direct writer from stealing a reserved publication ID', async () => {
      const f = await fixture(mode),
        prepared = await f.prepare();
      await expect(
        f.port.writeRecords({
          tenantId: 'tenant-a',
          storageGeneration: f.config.generation,
          records: [prepared.record],
        })
      ).rejects.toThrow();
      expect(f.db.prepare('SELECT state FROM log_iceberg_publications').get()?.state).toBe(
        'prepared'
      );
      expect(f.send).not.toHaveBeenCalled();
    });
  });

describe('Core preparation export visibility', () => {
  it('never selects unpublished scheduled staging for Parquet export, then exports after its witness', async () => {
    const f = await fixture('scheduled'),
      prepared = await f.prepare('old-audit', 'private detail', Date.now() - 8 * 86400000);
    expect(await exportLogIcebergBatch(f.config, f.ports)).toMatchObject({ moved: 0 });
    expect(f.store.objects.size).toBe(0);
    await f.core.adapter.batch(prepared.wrapBusinessBatch([f.business], f.predicate));
    await prepared.dispatch();
    expect(await exportLogIcebergBatch(f.config, f.ports)).toMatchObject({ moved: 1 });
    expect(f.store.objects.size).toBeGreaterThan(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_records').get()?.n).toBe(0);
  });
});

it('rejects a runtime-owned route without inventing a Cloudflare publication source', () => {
  expect(() =>
    coreLogPublicationSource(
      { AUTHRIM_ENVIRONMENT_NAME: 'test' },
      { allocationScope: 'shared_pool' }
    )
  ).toThrow('log_core_publication_source_invalid');
});
