export { LOG_ARCHIVE_SCHEMA_VERSION as LOG_ICEBERG_READINESS_SCHEMA_VERSION } from '@authrim/ar-lib-logging/iceberg/capabilities';
import {
  readSnapshotRecords,
  type IcebergCatalogPort,
  type IcebergLoadedTable,
  type IcebergObjectStore,
} from '@authrim/ar-lib-logging/iceberg';
import { ensureDatabaseAdapter, type DatabaseAdapter } from '../db';
import {
  assertLogIcebergActivated,
  assertLogIcebergRemoteConfig,
  resolveLogIcebergConfig,
} from './log-iceberg-config';
import {
  createLogIcebergCatalog,
  createLogIcebergObjectStore,
  validateLogIcebergTable,
  type LogIcebergCatalogEnv,
} from './log-iceberg-catalog';
import { buildLogIcebergRowRecord } from './log-iceberg-emitter';
import {
  createLogIcebergWritePort,
  type LogArchiveWriteServiceBinding,
} from './log-iceberg-runtime';
import { createLogIcebergKeyResolver } from './log-iceberg-keys';
import { exportLogIcebergBatch } from './log-iceberg-export';
import { logIcebergRecordId, logIcebergDigest } from './log-iceberg-store';
import { decryptLogIcebergRecord, logIcebergCanonicalJson } from './log-iceberg-record';
import { decodeLogIcebergRow } from './log-iceberg-row-codec';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';

export interface LogIcebergReadinessAttempt {
  attemptId: string;
  startedAt: string;
  deploymentFingerprint: string;
}
export function assertLogIcebergReadinessAttempt(
  value: unknown
): asserts value is LogIcebergReadinessAttempt {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('log_iceberg_probe_attempt_invalid');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !== 'attemptId,deploymentFingerprint,startedAt' ||
    typeof v.attemptId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.attemptId) ||
    typeof v.deploymentFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.deploymentFingerprint) ||
    typeof v.startedAt !== 'string' ||
    !Number.isSafeInteger(Date.parse(v.startedAt)) ||
    new Date(v.startedAt).toISOString() !== v.startedAt
  )
    throw new Error('log_iceberg_probe_attempt_invalid');
}
export async function logIcebergReadinessAttemptDigest(
  value: LogIcebergReadinessAttempt
): Promise<string> {
  assertLogIcebergReadinessAttempt(value);
  return logIcebergDigest(logIcebergCanonicalJson(value));
}
export interface LogIcebergReadinessResult extends LogIcebergReadinessAttempt {
  state: 'pending' | 'ready';
  mode: 'pipeline' | 'scheduled';
  generation: string;
  schemaVersion: number;
  keyVersion: number;
  tableUuid: string;
  physicalFingerprint: string;
  eventId: string;
  snapshotId: string | null;
  checkedAt: string;
}
export interface LogIcebergReadinessPorts {
  admin: DatabaseAdapter;
  writer: LogArchiveWriteServiceBinding;
  catalog: IcebergCatalogPort;
  readCatalog?: IcebergCatalogPort;
  store: (table: IcebergLoadedTable) => IcebergObjectStore;
}
/** Server-owned bootstrap probe only. No caller-selected tenant, record, payload, or export scope. */
export async function probeLogIcebergReadiness(
  env: LogIcebergCatalogEnv,
  attempt: LogIcebergReadinessAttempt,
  supplied?: LogIcebergReadinessPorts
): Promise<LogIcebergReadinessResult> {
  assertLogIcebergReadinessAttempt(attempt);
  attempt = { ...attempt };
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  assertLogIcebergRemoteConfig(config);
  const keys = createLogIcebergKeyResolver(env),
    keyVersion = keys().keyVersion;
  const eventId = `log_archive_probe_v1:${attempt.attemptId}:${keyVersion}`;
  if (!/^log_archive_probe_v1:[a-f0-9-]{36}:[1-9][0-9]{0,8}$/.test(eventId))
    throw new Error('log_iceberg_probe_generation_invalid');
  const ports = supplied ?? {
    admin: ensureDatabaseAdapter(env.DB_ADMIN ?? missing(), 'log-iceberg-readiness'),
    writer: createLogIcebergWritePort(env, config),
    catalog: createLogIcebergCatalog(env, config, 'write'),
    readCatalog: createLogIcebergCatalog(env, config, 'read'),
    store: (table: IcebergLoadedTable) => createLogIcebergObjectStore(env, table),
  };
  const tenantId = 'platform',
    tenantKey = await ports.writer.resolveTenantKey(tenantId);
  const firstAt = Date.parse(attempt.startedAt);
  if (firstAt < config.activatedAt || firstAt > Date.now() + 30000)
    throw new Error('log_iceberg_probe_attempt_invalid');
  const row = {
    id: eventId,
    tenant_id: tenantId,
    created_at: firstAt,
    source: 'authrim/setup',
    type: 'log_archive_readiness',
    payload_json: JSON.stringify({
      job_type: 'log_archive_readiness',
      schema_version: config.schemaVersion,
      generation: config.generation,
      key_version: keyVersion,
      attempt_id: attempt.attemptId,
      deployment_fingerprint: attempt.deploymentFingerprint,
    }),
  };
  const record = await buildLogIcebergRowRecord(
    { ...env, LOG_ARCHIVE_WRITER: ports.writer },
    {
      tenantId,
      sourceDataset: 'runtime.admin_job_events',
      logType: 'job',
      row,
      eventAt: firstAt,
      ingestedAt: firstAt,
      expiresAt: null,
      overview: { action: 'log_archive_readiness', result: 'probe', severity: 'info' },
    }
  );
  const id = await logIcebergRecordId(record);
  return runTenantBackupCoveredEffect(
    { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
    { environment: true },
    async () => {
      const existing = await ports.admin.queryOne<{ payload_hmac: string; state: string }>(
        config.mode === 'scheduled'
          ? 'SELECT payload_hmac,state FROM log_iceberg_event_receipts WHERE id=?'
          : 'SELECT payload_hmac,state FROM log_iceberg_outbox WHERE id=?',
        [id],
        { consistencyClass: 'primary_required' }
      );
      if (existing && existing.payload_hmac !== record.payload_hmac)
        throw new Error('log_iceberg_probe_identity_conflict');
      if (
        !existing ||
        (config.mode === 'pipeline' && ['preparing', 'pending'].includes(existing.state))
      )
        await ports.writer.writeRecords({
          tenantId,
          storageGeneration: config.generation,
          records: [record],
        });
      if (config.mode === 'scheduled')
        await exportLogIcebergBatch(config, ports, { eventId, tenantKey });
      // A fresh exact Catalog snapshot, not Queue/Stream acceptance, proves readable Parquet.
      const table = await (ports.readCatalog ?? ports.catalog).loadTable();
      await validateLogIcebergTable(config, table);
      const cold = await readSnapshotRecords({
        table,
        store: ports.store(table),
        tenantKey,
        sourceDatasets: ['runtime.admin_job_events'],
        eventIds: [eventId],
        nowMs: Date.now(),
      });
      const base: LogIcebergReadinessResult = {
        ...attempt,
        state: 'pending',
        mode: config.mode,
        generation: config.generation,
        schemaVersion: config.schemaVersion,
        keyVersion,
        tableUuid: config.tableUuid,
        physicalFingerprint: config.physicalFingerprint,
        eventId,
        snapshotId: cold.snapshotId,
        checkedAt: new Date().toISOString(),
      };
      if (!cold.records.length) return base;
      for (const actual of cold.records) {
        if (
          actual.payload_hmac !== record.payload_hmac ||
          actual.storage_generation !== config.generation ||
          actual.detail_key_version !== String(keyVersion)
        )
          throw new Error('log_iceberg_probe_identity_conflict');
        const body = await decryptLogIcebergRecord(
          actual,
          { tenantKey, sourceDataset: 'runtime.admin_job_events', eventId },
          async (version) => keys(version)
        );
        if (
          logIcebergCanonicalJson(decodeLogIcebergRow(body, tenantId, eventId)) !==
          logIcebergCanonicalJson(row)
        )
          throw new Error('log_iceberg_probe_roundtrip_invalid');
      }
      if (
        !cold.snapshotId ||
        (await ports.admin.queryOne('SELECT id FROM log_iceberg_records WHERE id=?', [id], {
          consistencyClass: 'primary_required',
        }))
      )
        throw new Error('log_iceberg_probe_source_not_confirmed');
      return { ...base, state: 'ready' };
    }
  );
}
function missing(): never {
  throw new Error('log_iceberg_admin_database_unavailable');
}
