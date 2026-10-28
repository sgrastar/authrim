import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { prepareAppend, stageSnapshotForAppend } from 'icebird/src/write/stage.js';
import {
  icebergSnapshotFixture as icebergFixture,
  icebergSnapshotCoreFixture as sqliteAdapter,
  icebergSnapshotMetadata,
} from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { logArchivePhysicalFingerprint } from '@authrim/ar-lib-logging/iceberg';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import {
  logIcebergDigest,
  logIcebergRecordId,
} from '@authrim/ar-lib-core/services/log-iceberg-store';
import {
  decodePortableIcebergLog,
  ICEBERG_LOG_RECORDS_DATASETS,
} from '@authrim/ar-lib-core/services/tenant-portability/portable-iceberg-log';
import { tenantBackupRecordSnapshotId } from '../tenant-backup-phase5-adapter';
import {
  createTenantBackupIcebergLogSnapshotPorts,
  ICEBERG_LOG_SNAPSHOT_RESOURCE,
} from '../tenant-backup-iceberg-log-snapshot-port';
import { readBackupSqliteSchema } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-schema-reader';
import { planSqliteTenantDatasets } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-plan';
import {
  sqliteCapturePlan,
  sqliteSnapshotStartOrResumeStatement,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-capture-plan';
import { lookupSqliteSnapshotRows } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-snapshot-lookup';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';

function bucket() {
  const values = new Map<string, { text: string; metadata: Record<string, string> }>();
  const binding = {
    async put(
      key: string,
      value: string,
      options?: { onlyIf?: { etagDoesNotMatch?: string }; customMetadata?: Record<string, string> }
    ) {
      if (options?.onlyIf?.etagDoesNotMatch === '*' && values.has(key)) return null;
      values.set(key, { text: value, metadata: options?.customMetadata ?? {} });
      return { key };
    },
    async get(key: string) {
      const value = values.get(key);
      if (!value) return null;
      const bytes = new TextEncoder().encode(value.text);
      return {
        size: bytes.length,
        customMetadata: value.metadata,
        text: async () => value.text,
        body: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
      };
    },
    async list(input: { prefix: string; limit: number; cursor?: string }) {
      const keys = [...values.keys()].filter((k) => k.startsWith(input.prefix)).sort(),
        after = input.cursor ?? '',
        selected = keys.filter((k) => k > after).slice(0, input.limit);
      return {
        objects: selected.map((key) => ({ key })),
        truncated: keys.filter((k) => k > after).length > selected.length,
        cursor: selected.at(-1),
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
  return { values, binding: binding as unknown as R2Bucket };
}
describe('T0 Iceberg log snapshot source participant', () => {
  let f: Awaited<ReturnType<typeof icebergFixture>>,
    core: ReturnType<typeof sqliteAdapter>,
    artifacts: ReturnType<typeof bucket>,
    retry: ReturnType<typeof bucket>;
  let env: Parameters<typeof createTenantBackupIcebergLogSnapshotPorts>[0]['env'],
    context: AdapterContext;
  let held = vi.fn(async () => {}),
    ddl = vi.fn(async () => {});
  const op = 'backup-operation',
    tenant = 'tenant-a';
  beforeEach(async () => {
    f = await icebergFixture();
    core = sqliteAdapter();
    artifacts = bucket();
    retry = bucket();
    f.db.exec(
      `CREATE TABLE IF NOT EXISTS tenant_backup_operations(id TEXT NOT NULL PRIMARY KEY,tenant_id TEXT NOT NULL,state TEXT NOT NULL,lease_owner TEXT,fencing_token INTEGER NOT NULL,lease_expires_at INTEGER,updated_at INTEGER NOT NULL,UNIQUE(id,tenant_id))`
    );
    f.db
      .prepare(
        "INSERT INTO tenant_backup_operations(id,tenant_id,state,lease_owner,fencing_token,lease_expires_at,updated_at) VALUES(?,?,'running','worker',1,?,?)"
      )
      .run(op, tenant, f.now + 86400000, f.now);
    env = {
      EXPORT_ARTIFACTS: artifacts.binding,
      LOG_ARCHIVE: retry.binding,
      OBJECT_ENCRYPTION_ROOT_KEY: f.keys.rootKeyHex,
      OBJECT_ENCRYPTION_KEY_VERSION: '1',
      LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
        schema_version: 1,
        current_version: 1,
        roots: { 1: f.keys.rootKeyHex },
      }),
      LOG_ARCHIVE_CONTENT_HMAC_KEY: f.keys.contentHmacKeyHex,
      CONTROL: {
        acquireEnvironmentBackupMutationPermit: async () => ({ admitted: true }),
        completeEnvironmentBackupMutationPermit: async () => {},
        acquireTenantBackupMutationPermit: async () => ({ admitted: true }),
        completeTenantBackupMutationPermit: async () => {},
      },
      AUTHRIM_LOG_ARCHIVE_MODE: 'scheduled',
      AUTHRIM_LOG_ARCHIVE_STORAGE_GENERATION: f.config.generation,
      AUTHRIM_LOG_ARCHIVE_SCHEMA_VERSION: '1',
      AUTHRIM_LOG_ARCHIVE_ACTIVATED_AT: new Date(f.config.activatedAt).toISOString(),
      AUTHRIM_LOG_ARCHIVE_ACCOUNT_ID: f.config.accountId,
      AUTHRIM_LOG_ARCHIVE_BUCKET: f.config.bucket,
      AUTHRIM_LOG_ARCHIVE_WAREHOUSE: f.config.warehouse,
      AUTHRIM_LOG_ARCHIVE_CATALOG_URI: f.config.catalogUri,
      AUTHRIM_LOG_ARCHIVE_NAMESPACE: f.config.namespace,
      AUTHRIM_LOG_ARCHIVE_TABLE: f.config.table,
      AUTHRIM_LOG_ARCHIVE_TABLE_UUID: f.config.tableUuid,
      AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: f.config.physicalFingerprint,
      AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: '7',
      AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: '10',
    };
    context = {
      context: {
        lease: { tenantId: tenant, operationId: op, owner: 'worker', fencingToken: 1 },
        signal: new AbortController().signal,
      },
      selection: {
        settings: false,
        users: false,
        admin: false,
        artifacts: false,
        logs: { audit: true, other: true, sensitive: true, period: 'all' },
      },
      inventory: { headForLease: async () => ({ state: 'sealed', chain_digest: 'a'.repeat(64) }) },
      boundaryUnixMs: f.now,
    } as unknown as AdapterContext;
    held = vi.fn(async () => {});
    ddl = vi.fn(async () => {});
  });
  afterEach(() => {
    f.db.close();
    core.db.close();
  });
  const make = () =>
    createTenantBackupIcebergLogSnapshotPorts({
      env,
      tenantKey: 'key-a',
      resolveCoreSource: async () => ({ resourceId: 'source-core', database: core.adapter }),
      resolveAdminSource: async () => ({ resourceId: 'source-admin', database: f.adapter }),
      assertSourceDdlHeld: ddl,
      catalog: f.catalog,
      store: () => f.store,
      now: () => f.now,
    });
  async function capture(port: ReturnType<typeof make>) {
    await port.prepareSources({ ...context, cursor: null });
    const id = await tenantBackupRecordSnapshotId(context, ICEBERG_LOG_SNAPSHOT_RESOURCE);
    await port.prepareBoundary(context, id);
    await port.records.start(context, id, held, f.now);
    return id;
  }
  async function materialize(port: ReturnType<typeof make>, initial: string | null = null) {
    let cursor = initial;
    for (let i = 0; i < 100; i++) {
      const result = await port.prepareArtifactResources({
        ...context,
        cursor,
        boundaryUnixMs: context.boundaryUnixMs ?? f.now,
      });
      if (result.done) return;
      cursor = result.cursor;
    }
    throw Error('materialization did not finish');
  }
  async function readCategory(
    port: ReturnType<typeof make>,
    snapshotId: string,
    datasetId: string
  ) {
    let cursor: string | null = null;
    const rows = [];
    for (let i = 0; i < 100; i++) {
      const result = await port.records.readNext(
        { ...context, datasetId },
        snapshotId,
        cursor,
        context.context.signal
      );
      if (!result) return rows;
      rows.push(decodePortableIcebergLog(new TextDecoder().decode(result.bytes).trim(), tenant));
      cursor = result.nextCursor;
    }
    throw Error('read did not finish');
  }
  async function read(port: ReturnType<typeof make>, snapshotId: string) {
    const rows = [];
    for (const dataset of ICEBERG_LOG_RECORDS_DATASETS) {
      const category =
        dataset.kind === 'audit' ? 'audit' : dataset.kind === 'history' ? 'other' : 'sensitive';
      if (context.selection.logs[category])
        rows.push(...(await readCategory(port, snapshotId, dataset.id)));
    }
    return rows;
  }
  async function append(records: LogArchiveRecord[]) {
    const resolver = {
      async reader(path: string) {
        const data = await f.store.read(path, 8 * 1024 * 1024);
        return {
          byteLength: data.length,
          slice: (start: number, end?: number) => Uint8Array.from(data.subarray(start, end)).buffer,
        };
      },
      writer(path: string) {
        const w = new ByteWriter();
        return Object.assign(w, { finish: () => f.store.putImmutable(path, w.getBytes(), path) });
      },
    };
    const prepared = await prepareAppend({
      tableUrl: f.catalog.metadata.location,
      metadata: f.catalog.metadata,
      resolver,
      records: records.map((r) => ({
        ...r,
        event_at: BigInt(r.event_at),
        ingested_at: BigInt(r.ingested_at),
        expires_at: r.expires_at === null ? null : BigInt(r.expires_at),
        ...(env.AUTHRIM_LOG_ARCHIVE_MODE === 'pipeline'
          ? { __ingest_ts: new Date(r.ingested_at) }
          : {}),
      })),
    });
    await f.catalog.commit(
      await stageSnapshotForAppend({
        tableUrl: f.catalog.metadata.location,
        metadata: f.catalog.metadata,
        resolver,
        prepared,
      })
    );
  }
  it('captures source references without reading a body in the hold, then reads the old COW parts after source deletion', async () => {
    const original = await f.record('before');
    await f.staging.put(tenant, original);
    const port = make();
    const id = await capture(port);
    expect(held.mock.calls.length).toBeGreaterThan(3);
    expect(
      [...artifacts.values.values()].some((v) => v.text.includes('private@example.invalid'))
    ).toBe(false);
    f.db
      .prepare('DELETE FROM log_iceberg_record_parts WHERE record_id=?')
      .run(await logIcebergRecordId(original));
    f.db.exec('DELETE FROM log_iceberg_records');
    await f.staging.put(tenant, await f.record('after'));
    await materialize(port);
    const rows = await read(port, id);
    expect(rows.map((r) => String(r.row.id))).toEqual(['before']);
    expect(rows[0].expiresAt).toBe(original.expires_at);
    expect(
      [...artifacts.values.values()].some((v) => v.text.includes('private@example.invalid'))
    ).toBe(false);
    for (let i = 0; i < 20; i++) if (await port.records.releasePage?.(context, id)) break;
    await expect(port.records.assertReleased(context, id)).resolves.toBeUndefined();
    expect(artifacts.values.size).toBe(0);
  });
  it('deduplicates hot/cold and cross-page copies and resumes a lost seen acknowledgement with one output per logical event', async () => {
    const records = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        f.record('event-' + String(i).padStart(2, '0'), {
          sourceDataset:
            i % 3 === 0 ? 'core.audit_log' : i % 3 === 1 ? 'core.operational_logs' : 'pii.pii_log',
          logType: i % 3 === 1 ? 'operational' : 'audit',
        })
      )
    );
    for (const row of records) await f.staging.put(tenant, row);
    await append(records);
    await append([records[0]]);
    const sourceReads = vi.spyOn(f.store, 'read');
    const port = make(),
      id = await capture(port),
      original = f.adapter.batch.bind(f.adapter);
    let lost = false;
    f.adapter.batch = async (statements) => {
      const result = await original(statements);
      if (!lost && statements.some((s) => s.sql.includes('INSERT INTO log_iceberg_backup_seen'))) {
        lost = true;
        throw Error('lost seen acknowledgement');
      }
      return result;
    };
    await expect(materialize(port)).rejects.toThrow('lost seen');
    await materialize(port);
    const rows = await read(port, id);
    expect(sourceReads.mock.calls.some(([path]) => path.endsWith('.parquet'))).toBe(false);
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((r) => String(r.row.id))).size).toBe(20);
    expect(lost).toBe(true);
  });
  it('rejects a same-event different-content collision across storage pages', async () => {
    const row = await f.record('collision');
    await f.staging.put(tenant, row);
    await append([await f.record('collision', { row: { metadata_json: '{"different":true}' } })]);
    const port = make();
    await capture(port);
    await expect(materialize(port)).rejects.toThrow('content_collision');
  });
  it('leaves settings-only exports independent of log snapshot admission', async () => {
    context.selection.logs = { audit: false, other: false, sensitive: false, period: 'all' };
    if (env.CONTROL)
      env.CONTROL.acquireEnvironmentBackupMutationPermit = async () => ({ admitted: false });
    const port = make();
    expect(await port.prepareSources({ ...context, cursor: null })).toEqual({
      cursor: null,
      done: true,
    });
    expect(
      await port.prepareArtifactResources({ ...context, cursor: null, boundaryUnixMs: f.now })
    ).toEqual({ cursor: null, done: true });
    expect(artifacts.values.size).toBe(0);
    expect(ddl).not.toHaveBeenCalled();
  });
  it('refuses source schema installation when Control does not admit the environment mutation', async () => {
    if (env.CONTROL)
      env.CONTROL.acquireEnvironmentBackupMutationPermit = async () => ({ admitted: false });
    const port = make();
    await expect(port.prepareSources({ ...context, cursor: null })).rejects.toThrow(
      'backup_mutation_unavailable'
    );
    expect(ddl).not.toHaveBeenCalled();
    expect(artifacts.values.size).toBe(0);
  });
  it('includes only T0 committed Core publications, including a not-yet-finalized Admin copy', async () => {
    const makePublication = async (eventId: string, state: 'prepared' | 'committed') => {
      const row = await f.record(eventId),
        id = await logIcebergRecordId(row),
        publicationId = await logIcebergDigest('publication-' + eventId),
        digest = 'c'.repeat(64),
        token = 'token-' + eventId;
      f.db
        .prepare(
          `INSERT INTO log_iceberg_publications(id,tenant_id,storage_generation,record_id,source_dataset,payload_hmac,mode,source_json,source_digest,source_token,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'scheduled','{}',?,?,'prepared',?,?)`
        )
        .run(
          publicationId,
          tenant,
          f.config.generation,
          id,
          row.source_dataset,
          row.payload_hmac,
          digest,
          token,
          f.now,
          f.now
        );
      core.db
        .prepare(
          `INSERT INTO log_iceberg_core_publications(id,tenant_id,storage_generation,record_id,source_dataset,payload_hmac,source_digest,source_token,state,body_prepared,admission_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1,?,?)`
        )
        .run(
          publicationId,
          tenant,
          f.config.generation,
          id,
          row.source_dataset,
          row.payload_hmac,
          digest,
          token,
          state,
          f.now,
          f.now
        );
      await f.staging.put(tenant, row, publicationId);
      return row;
    };
    const committed = await makePublication('committed-before-T0', 'committed'),
      prepared = await makePublication('only-prepared-at-T0', 'prepared');
    await append([committed, prepared]);
    const port = make(),
      snapshotId = await capture(port);
    core.db.exec("UPDATE log_iceberg_core_publications SET state='committed'");
    await materialize(port);
    expect((await read(port, snapshotId)).map((r) => String(r.row.id))).toEqual([
      'committed-before-T0',
    ]);
  });
  it('fails explicitly if a selected source expires while materialization is in progress', async () => {
    await f.staging.put(tenant, await f.record('short-lived', { expiresAt: f.now + 60000 }));
    const port = make();
    await capture(port);
    f.now += 120000;
    await expect(materialize(port)).rejects.toThrow('source_expired');
  });
  it('does not publish a partial cross-store capture after the short held boundary expires', async () => {
    await f.staging.put(tenant, await f.record('before'));
    const port = make();
    await port.prepareSources({ ...context, cursor: null });
    const id = await tenantBackupRecordSnapshotId(context, ICEBERG_LOG_SNAPSHOT_RESOURCE);
    await port.prepareBoundary(context, id);
    let calls = 0;
    const expires = async () => {
      if (++calls === 3) throw Error('held boundary expired');
    };
    await expect(port.records.start(context, id, expires, f.now)).rejects.toThrow(
      'held boundary expired'
    );
    await expect(materialize(port)).rejects.toThrow('boundary_missing');
    expect(f.catalog.metadata.refs?.['authrim-dr-' + id]).toBeUndefined();
    for (let i = 0; i < 20; i++) if (await port.records.releasePage?.(context, id)) break;
    await expect(port.records.assertReleased(context, id)).resolves.toBeUndefined();
  });
  it('refuses a stale operation fence before storing a DR page or seen witness', async () => {
    await f.staging.put(tenant, await f.record('before'));
    const port = make();
    await capture(port);
    f.db.exec("UPDATE tenant_backup_operations SET lease_owner='next-worker',fencing_token=2");
    await expect(materialize(port)).rejects.toThrow('fenced');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM log_iceberg_backup_seen').get()?.n).toBe(0);
  });
  it('applies the anonymous PII deny at T0 without using later live deny changes', async () => {
    const denied = await f.record('denied', { sourceDataset: 'pii.pii_log' }),
      kept = await f.record('kept', {
        sourceDataset: 'pii.pii_log',
        subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      });
    for (const row of [denied, kept]) await f.staging.put(tenant, row);
    const deny = async (row: LogArchiveRecord) => {
      f.db
        .prepare(
          `INSERT INTO log_iceberg_subject_erasures(id,tenant_id,tenant_key,source_dataset,subject_id,state,created_at,updated_at) VALUES(?,?,'key-a','pii.pii_log',?,'pending',?,?)`
        )
        .run(
          await logIcebergDigest(JSON.stringify([tenant, row.source_dataset, row.subject_id])),
          tenant,
          row.subject_id,
          f.now,
          f.now
        );
    };
    await deny(denied);
    const port = make(),
      snapshotId = await capture(port);
    await deny(kept);
    await materialize(port);
    expect((await read(port, snapshotId)).map((r) => String(r.row.id))).toEqual(['kept']);
  });
  it('fails explicitly if the native Catalog pin expires instead of exporting an empty archive', async () => {
    await append([await f.record('cold')]);
    const port = make();
    await capture(port);
    f.now += 24 * 3600000 + 1;
    await expect(materialize(port)).rejects.toThrow('source_expired');
  });
  it('refuses to release a pin that was retargeted after its exact capture receipt', async () => {
    const port = make(),
      id = await capture(port),
      ref = 'authrim-dr-' + id,
      entry = f.catalog.metadata.refs?.[ref];
    if (!entry) throw Error('pin missing');
    entry['snapshot-id'] = f.catalog.metadata['current-snapshot-id'] ?? 0;
    await expect(port.records.releasePage?.(context, id)).rejects.toThrow('pin_changed');
    expect(f.catalog.metadata.refs?.[ref]).toBeDefined();
  });
  it('copies a T0 pending Pipeline retry into independent encrypted DR pages before later marker cleanup', async () => {
    f.catalog.metadata = icebergSnapshotMetadata(true);
    Object.assign(env, {
      AUTHRIM_LOG_ARCHIVE_MODE: 'pipeline',
      AUTHRIM_LOG_ARCHIVE_DB_RETENTION_DAYS: undefined,
      AUTHRIM_LOG_ARCHIVE_EXPORT_INTERVAL_MINUTES: undefined,
      AUTHRIM_LOG_ARCHIVE_PHYSICAL_FINGERPRINT: await logArchivePhysicalFingerprint(
        f.catalog.metadata
      ),
    });
    const row = await f.record('pending'),
      id = await logIcebergRecordId(row),
      text = JSON.stringify(row),
      key = `_authrim_retry/iceberg/v1/${f.config.generation}/${id}.json`,
      digest = await logIcebergDigest(text);
    await retry.binding.put(key, text, {
      customMetadata: {
        authrim_record_id: id,
        authrim_storage_generation: f.config.generation,
        authrim_payload_hmac: row.payload_hmac,
        authrim_payload_sha256: digest,
      },
    });
    f.db
      .prepare(
        `INSERT INTO log_iceberg_outbox(id,tenant_id,storage_generation,source_dataset,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`
      )
      .run(
        id,
        tenant,
        f.config.generation,
        row.source_dataset,
        row.payload_hmac,
        key,
        digest,
        new TextEncoder().encode(text).length,
        row.expires_at,
        f.now,
        f.now
      );
    const port = make(),
      snapshotId = await capture(port);
    await materialize(port);
    retry.values.delete(key);
    expect((await read(port, snapshotId)).map((r) => String(r.row.id))).toEqual(['pending']);
  });
  it('uses one T0 capture and one scan to seal independent audit, other and sensitive pages', async () => {
    const audit = await f.record('category-audit'),
      other = await f.record('category-other', {
        sourceDataset: 'core.operational_logs',
        logType: 'operational',
      }),
      sensitive = await f.record('category-sensitive', { sourceDataset: 'pii.pii_log' });
    for (const record of [audit, other, sensitive]) await f.staging.put(tenant, record);
    const foreign = await f.record('category-audit', { tenantId: 'tenant-b', tenantKey: 'key-b' });
    await f.staging.put('tenant-b', foreign);
    await append([audit, foreign]); // Shared files keep foreign tenants and duplicate copies isolated.
    const port = make(),
      id = await capture(port);
    await materialize(port);
    expect(
      (await readCategory(port, id, 'logs.iceberg_audit_records')).map((row) => row.row.id)
    ).toEqual(['category-audit']);
    expect(
      (await readCategory(port, id, 'logs.iceberg_other_records')).map((row) => row.row.id)
    ).toEqual(['category-other']);
    expect(
      (await readCategory(port, id, 'logs.iceberg_sensitive_records')).map((row) => row.row.id)
    ).toEqual(['category-sensitive']);
    expect(
      core.db
        .prepare("SELECT COUNT(*) n FROM tenant_backup_snapshots WHERE state='capturing'")
        .get()?.n
    ).toBe(1);
    expect(
      f.db.prepare("SELECT COUNT(*) n FROM tenant_backup_snapshots WHERE state='capturing'").get()
        ?.n
    ).toBe(1);
    expect(
      Object.keys(f.catalog.metadata.refs ?? {}).filter((ref) => ref.startsWith('authrim-dr-'))
    ).toHaveLength(1);
    await expect(
      port.records.readNext(context, id, null, context.context.signal)
    ).rejects.toThrow();
    context.selection.logs.sensitive = false;
    await expect(readCategory(port, id, 'logs.iceberg_sensitive_records')).rejects.toThrow(
      'category_not_selected'
    );
    await expect(
      port.records.readNext(
        { ...context, datasetId: 'logs.iceberg_records' },
        id,
        null,
        context.context.signal
      )
    ).rejects.toThrow();
  });

  it('captures restore admission at T0 and excludes holding/aborted records from hot and cold sources', async () => {
    const records = await Promise.all(
      ['holding', 'aborted', 'active'].map((state) => f.record('restore-' + state))
    );
    for (let i = 0; i < records.length; i++) {
      const record = records[i],
        state = ['holding', 'aborted', 'active'][i],
        recordId = await logIcebergRecordId(record);
      await f.staging.put(tenant, record);
      f.db
        .prepare(
          'INSERT INTO log_iceberg_restore_holds(id,operation_id,tenant_id,payload_hmac,storage_generation,state,created_at) VALUES(?,?,?,?,?,?,?)'
        )
        .run(
          recordId,
          'source-import-' + state,
          tenant,
          record.payload_hmac,
          record.storage_generation,
          state === 'aborted' ? 'aborted' : 'holding',
          f.now
        );
      f.db
        .prepare(
          'INSERT INTO log_iceberg_restore_activations(id,tenant_id,storage_generation,plan_digest,state,created_at,activated_at) VALUES(?,?,?,?,?,?,?)'
        )
        .run(
          'source-import-' + state,
          tenant,
          record.storage_generation,
          'a'.repeat(64),
          state === 'holding' ? 'pending' : state,
          f.now,
          state === 'active' ? f.now : null
        );
    }
    await append(records);
    const port = make(),
      id = await capture(port);
    f.db.exec(
      "UPDATE log_iceberg_restore_activations SET state=CASE state WHEN 'pending' THEN 'active' ELSE 'pending' END,activated_at=CASE state WHEN 'pending' THEN 1 ELSE NULL END"
    );
    await materialize(port);
    expect((await read(port, id)).map((row) => row.row.id)).toEqual(['restore-active']);
  });
  it('reuses the real generic Admin capture triggers while both generic and private snapshots preserve T0 rows', async () => {
    const record = await f.record('generic-private-denied', { sourceDataset: 'pii.pii_log' });
    await f.staging.put(tenant, record);
    const denyId = await logIcebergDigest(
      JSON.stringify([tenant, record.source_dataset, record.subject_id])
    );
    f.db
      .prepare(
        "INSERT INTO log_iceberg_subject_erasures(id,tenant_id,tenant_key,source_dataset,subject_id,state,created_at,updated_at) VALUES(?,?,'key-a','pii.pii_log',?,'pending',?,?)"
      )
      .run(denyId, tenant, record.subject_id, f.now, f.now);
    const port = make();
    await port.prepareSources({ ...context, cursor: null });
    const metadata = await readBackupSqliteSchema(f.adapter, 'log_iceberg_subject_erasures');
    const generic = planSqliteTenantDatasets('admin', [metadata], {
      ...context.selection,
      users: true,
    }).captureSchemas;
    for (const trigger of sqliteCapturePlan(generic).triggers) {
      const installed = f.db
        .prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
        .get(trigger.name);
      expect(String(installed?.sql).trim().replace(/;+$/, '')).toBe(trigger.sql);
    }
    const start = sqliteSnapshotStartOrResumeStatement(generic, 'generic-admin', tenant, 'key-a');
    await f.adapter.batch([start]);
    const id = await tenantBackupRecordSnapshotId(context, ICEBERG_LOG_SNAPSHOT_RESOURCE);
    await port.prepareBoundary(context, id);
    await port.records.start(context, id, held, f.now);
    f.db.prepare('DELETE FROM log_iceberg_subject_erasures WHERE id=?').run(denyId);
    const genericRows = await lookupSqliteSnapshotRows({
      database: f.adapter,
      schema: generic[0],
      snapshotId: 'generic-admin',
      tenantId: tenant,
      column: 'id',
      values: [denyId],
      preimageLimit: 100,
    });
    expect(genericRows).toHaveLength(1);
    expect(genericRows[0].row.state).toEqual(['text', 'pending']);
    await materialize(port);
    expect(await read(port, id)).toHaveLength(0);
  });
});
