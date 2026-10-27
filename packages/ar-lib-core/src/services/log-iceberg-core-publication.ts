import { filterLogIcebergRestoreRecords } from './log-iceberg-restore-hold';
import { TENANT_BACKUP_MUTATION_PERMIT_LEASE_MS } from './tenant-portability/mutation-admission';
import { prepareLogIcebergRetentionScope } from './log-iceberg-retention-scope';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import { assertLogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import { ensureDatabaseAdapter, type DatabaseAdapter, type PreparedStatement } from '../db';
import type { Env } from '../types/env';
import type { LogIcebergConfig } from './log-iceberg-config';
import { assertLogIcebergActivated, resolveLogIcebergConfig } from './log-iceberg-config';
import { buildLogIcebergRowRecord, type LogIcebergRowWrite } from './log-iceberg-emitter';
import { decryptLogIcebergRecord, logIcebergCanonicalJson } from './log-iceberg-record';
import { createLogIcebergKeyResolver } from './log-iceberg-keys';
import {
  logIcebergDigest,
  logIcebergRecordId,
  SqlLogIcebergRecordStore,
  type LogIcebergSqlGuard,
} from './log-iceberg-store';
import {
  createLogIcebergWritePort,
  logIcebergOutboxStatement,
  type LogIcebergRuntimeEnv,
  type LogIcebergWriteRequest,
  type LogIcebergQueueReference,
} from './log-iceberg-runtime';
import {
  resolveTenantDatabaseSourceFromRegistry,
  type ResolvedTenantStore,
  type TenantDatabaseResolverEnv,
} from './tenant-database-resolver';
import { LOG_ICEBERG_DB_NOW, LogIcebergTableLease } from './log-iceberg-lease';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';
import { retireLogIcebergRetryObject } from './log-iceberg-retry-marker';
import { listCapturingTenantBackupTenantKeys } from './tenant-portability/r2-generation-retention';

const primary = { consistencyClass: 'primary_required' as const };
const ID = /^[a-f0-9]{64}$/u;
const OPAQUE = /^[A-Za-z0-9_.:-]{1,256}$/u;
const ORPHAN_MS = 24 * 60 * 60 * 1000;
const ADMISSION_MS = 60000;
export type CoreLogPublicationState = 'prepared' | 'committed' | 'published' | 'aborted';
export interface CoreLogPublicationSource {
  environmentId: string;
  tenantId: string;
  bindingRef: string;
  databaseId: string;
  provider: string;
  generation: number;
  bindingRouteGeneration: number;
  dataRole: ResolvedTenantStore['dataRole'];
  residencyPartition: string;
  shardId: string;
  shardGroup: string;
  shardIndex: number;
}
export interface CoreLogPublicationIdentity {
  publicationId: string;
  tenantId: string;
  storageGeneration: string;
  recordId: string;
  sourceDataset: string;
  payloadHmac: string;
  source: CoreLogPublicationSource;
  sourceDigest: string;
  sourceToken: string;
}
export interface CoreLogPublicationPreparation extends CoreLogPublicationIdentity {
  record: LogArchiveRecord;
}
export interface CoreLogPublicationRequest {
  tenantId: string;
  publicationId: string;
}
export interface CoreLogPublicationReconcile {
  limit?: number;
  orphanBefore?: number;
}
export interface CoreLogPublicationRpc {
  reserveCorePublication(
    input: Omit<CoreLogPublicationIdentity, 'sourceToken'>
  ): Promise<{ sourceToken: string; state: CoreLogPublicationState }>;
  prepareCorePublication(input: CoreLogPublicationPreparation): Promise<void>;
  publishCorePublication(
    input: CoreLogPublicationRequest
  ): Promise<{ state: CoreLogPublicationState }>;
  reconcileCorePublications(
    input?: CoreLogPublicationReconcile
  ): Promise<{ published: number; aborted: number; retained: number }>;
}
interface CoreRow {
  id: string;
  tenant_id: string;
  storage_generation: string;
  record_id: string;
  source_dataset: string;
  payload_hmac: string;
  source_digest: string;
  source_token: string;
  state: CoreLogPublicationState;
  body_prepared: number;
  admission_expires_at: number;
  admission_completed_at: number | null;
  lease_token: string | null;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
}
interface AdminRow extends Omit<
  CoreRow,
  | 'body_prepared'
  | 'lease_token'
  | 'lease_until'
  | 'admission_expires_at'
  | 'admission_completed_at'
> {
  source_json: string;
  mode: 'pipeline' | 'scheduled';
  finalized: number;
}
export interface CoreLogPublicationPorts {
  resolveSource(source: CoreLogPublicationSource): Promise<DatabaseAdapter>;
  preparePipeline(
    request: LogIcebergWriteRequest,
    publicationId: string
  ): Promise<LogIcebergQueueReference[]>;
  dispatchPipeline(input: {
    tenantId: string;
    references: LogIcebergQueueReference[];
  }): Promise<void>;
  tenantKey(tenantId: string): Promise<string>;
  coverTenant?<T>(tenantId: string, run: () => Promise<T>): Promise<T>;
}

function assertSource(source: CoreLogPublicationSource): void {
  if (
    !source ||
    Object.keys(source).length !== 12 ||
    ![
      source.environmentId,
      source.tenantId,
      source.bindingRef,
      source.databaseId,
      source.provider,
      source.residencyPartition,
      source.shardId,
      source.shardGroup,
    ].every((v) => typeof v === 'string' && OPAQUE.test(v)) ||
    !/^[A-Z][A-Z0-9_]*$/u.test(source.bindingRef) ||
    !/^tenant_core(?:\/[A-Za-z0-9_.:-]+)?$/u.test(source.dataRole) ||
    ![source.generation, source.bindingRouteGeneration].every(
      (v) => Number.isSafeInteger(v) && v > 0
    ) ||
    !Number.isSafeInteger(source.shardIndex) ||
    source.shardIndex < 0
  )
    throw new Error('log_core_publication_source_invalid');
}
export function coreLogPublicationSource(
  env: { AUTHRIM_ENVIRONMENT_NAME?: string },
  route: ResolvedTenantStore
): CoreLogPublicationSource {
  const value = {
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME ?? '',
    tenantId: route.tenantId,
    bindingRef: route.bindingRef,
    databaseId: route.registryRow.database_id ?? route.registryRow.connection_ref ?? '',
    provider: route.registryRow.provider,
    generation: route.generation,
    bindingRouteGeneration: route.bindingRouteGeneration,
    dataRole: route.dataRole,
    residencyPartition: route.residencyPartition,
    shardId: route.shardId,
    shardGroup: route.shardGroup,
    shardIndex: route.shardIndex,
  };
  assertSource(value);
  return value;
}
async function resolveSource(
  env: LogIcebergRuntimeEnv,
  source: CoreLogPublicationSource
): Promise<DatabaseAdapter> {
  assertSource(source);
  if ((env as Partial<Env>).AUTHRIM_ENVIRONMENT_NAME !== source.environmentId)
    throw new Error('log_core_publication_environment_mismatch');
  const route = await resolveTenantDatabaseSourceFromRegistry(
    env as unknown as TenantDatabaseResolverEnv,
    {
      tenantId: source.tenantId,
      role: 'tenant_core',
      dataRole: source.dataRole,
      bindingRef: source.bindingRef,
      requiredBindingRouteGeneration: source.bindingRouteGeneration,
      residencyPartition: source.residencyPartition,
      shardId: source.shardId,
      shardGroup: source.shardGroup,
      shardIndex: source.shardIndex,
      sideEffects: 'none',
      memoryCacheTtlMs: 0,
      generationCacheTtlMs: 0,
    }
  );
  if (
    logIcebergCanonicalJson(coreLogPublicationSource(env as Partial<Env>, route)) !==
    logIcebergCanonicalJson(source)
  )
    throw new Error('log_core_publication_source_changed');
  return ensureDatabaseAdapter(route.source, 'log-core-publication');
}
function dbNow(core: DatabaseAdapter): string {
  return /postgres|hyperdrive/u.test(core.getType())
    ? 'CAST(EXTRACT(EPOCH FROM clock_timestamp())*1000 AS BIGINT)'
    : LOG_ICEBERG_DB_NOW;
}
function assertIdentity(row: CoreRow | AdminRow, input: CoreLogPublicationIdentity): void {
  if (
    row.id !== input.publicationId ||
    row.tenant_id !== input.tenantId ||
    row.storage_generation !== input.storageGeneration ||
    row.record_id !== input.recordId ||
    row.source_dataset !== input.sourceDataset ||
    row.payload_hmac !== input.payloadHmac ||
    row.source_digest !== input.sourceDigest ||
    row.source_token !== input.sourceToken
  )
    throw new Error('log_core_publication_identity_conflict');
}
function identity(row: AdminRow): CoreLogPublicationIdentity {
  const source = JSON.parse(row.source_json) as CoreLogPublicationSource;
  assertSource(source);
  return {
    publicationId: row.id,
    tenantId: row.tenant_id,
    storageGeneration: row.storage_generation,
    recordId: row.record_id,
    sourceDataset: row.source_dataset,
    payloadHmac: row.payload_hmac,
    source,
    sourceDigest: row.source_digest,
    sourceToken: row.source_token,
  };
}
async function assertRequest(
  input: CoreLogPublicationIdentity,
  config: LogIcebergConfig
): Promise<void> {
  assertSource(input.source);
  if (
    ![input.publicationId, input.recordId, input.payloadHmac, input.sourceDigest].every(
      (v) => typeof v === 'string' && ID.test(v)
    ) ||
    input.tenantId !== input.source.tenantId ||
    input.storageGeneration !== config.generation ||
    !OPAQUE.test(input.sourceToken) ||
    input.sourceDigest !== (await logIcebergDigest(logIcebergCanonicalJson(input.source)))
  )
    throw new Error('log_core_publication_identity_invalid');
  if (
    input.publicationId !==
    (await logIcebergDigest(
      JSON.stringify(['core-publication-v1', config.generation, input.recordId, input.sourceDigest])
    ))
  )
    throw new Error('log_core_publication_identity_invalid');
}
const loadCore = (core: DatabaseAdapter, id: string) =>
  core.queryOne<CoreRow>('SELECT * FROM log_iceberg_core_publications WHERE id=?', [id], primary);

function coreRegistration(
  core: DatabaseAdapter,
  input: CoreLogPublicationIdentity
): PreparedStatement {
  const clock = dbNow(core);
  return {
    sql: `INSERT INTO log_iceberg_core_publications(id,tenant_id,storage_generation,record_id,source_dataset,payload_hmac,source_digest,source_token,state,body_prepared,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,'prepared',0,${clock},${clock}) ON CONFLICT(id) DO UPDATE SET payload_hmac=CASE
    WHEN log_iceberg_core_publications.tenant_id=excluded.tenant_id AND log_iceberg_core_publications.storage_generation=excluded.storage_generation
      AND log_iceberg_core_publications.record_id=excluded.record_id AND log_iceberg_core_publications.source_dataset=excluded.source_dataset
      AND log_iceberg_core_publications.payload_hmac=excluded.payload_hmac AND log_iceberg_core_publications.source_digest=excluded.source_digest
    THEN log_iceberg_core_publications.payload_hmac ELSE NULL END`,
    params: [
      input.publicationId,
      input.tenantId,
      input.storageGeneration,
      input.recordId,
      input.sourceDataset,
      input.payloadHmac,
      input.sourceDigest,
      input.sourceToken,
    ],
  };
}
function coreCommit(
  core: DatabaseAdapter,
  input: CoreLogPublicationIdentity,
  predicate: LogIcebergSqlGuard,
  expiresAt: number
): PreparedStatement {
  if (!predicate.where.trim() || predicate.where.length > 8192 || predicate.params.length > 100)
    throw new Error('log_core_publication_predicate_invalid');
  const clock = dbNow(core);
  return {
    sql: `INSERT INTO log_iceberg_core_publications(id,tenant_id,storage_generation,record_id,source_dataset,payload_hmac,source_digest,source_token,state,body_prepared,admission_expires_at,created_at,updated_at)
    SELECT ?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM log_iceberg_core_publications WHERE id=? AND state='prepared' AND body_prepared=1 AND source_token=? AND admission_expires_at=? AND admission_expires_at>${clock} AND admission_completed_at IS NULL) THEN ? ELSE NULL END,?,?,'prepared',1,?,${clock},${clock}
    ON CONFLICT(id) DO UPDATE SET payload_hmac=CASE WHEN log_iceberg_core_publications.tenant_id=excluded.tenant_id
      AND log_iceberg_core_publications.storage_generation=excluded.storage_generation AND log_iceberg_core_publications.record_id=excluded.record_id
      AND log_iceberg_core_publications.source_dataset=excluded.source_dataset AND log_iceberg_core_publications.payload_hmac=excluded.payload_hmac
      AND log_iceberg_core_publications.source_digest=excluded.source_digest AND log_iceberg_core_publications.source_token=excluded.source_token
      AND log_iceberg_core_publications.state='prepared' AND log_iceberg_core_publications.body_prepared=1
      AND log_iceberg_core_publications.admission_expires_at>${clock} AND log_iceberg_core_publications.admission_completed_at IS NULL
      THEN log_iceberg_core_publications.payload_hmac ELSE NULL END,
      state=CASE WHEN (${predicate.where}) THEN 'committed' ELSE 'prepared' END,updated_at=${clock}`,
    params: [
      input.publicationId,
      input.tenantId,
      input.storageGeneration,
      input.recordId,
      input.sourceDataset,
      input.publicationId,
      input.sourceToken,
      expiresAt,
      input.payloadHmac,
      input.sourceDigest,
      input.sourceToken,
      expiresAt,
      ...predicate.params,
    ],
  };
}

/** The final statement is the CAS guard: no result-index changes and no after-commit audit gap. */
export async function prepareCoreLogPublication(
  env: LogIcebergRuntimeEnv,
  core: DatabaseAdapter,
  input: LogIcebergRowWrite & { source: CoreLogPublicationSource }
) {
  input = { ...input, source: { ...input.source } };
  assertSource(input.source);
  if (input.source.tenantId !== input.tenantId)
    throw new Error('log_core_publication_source_invalid');
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  const record = await buildLogIcebergRowRecord(env, input);
  const recordId = await logIcebergRecordId(record),
    sourceDigest = await logIcebergDigest(logIcebergCanonicalJson(input.source));
  const value: CoreLogPublicationIdentity = {
    publicationId: await logIcebergDigest(
      JSON.stringify(['core-publication-v1', config.generation, recordId, sourceDigest])
    ),
    tenantId: input.tenantId,
    storageGeneration: config.generation,
    recordId,
    sourceDataset: record.source_dataset,
    payloadHmac: record.payload_hmac,
    source: input.source,
    sourceDigest,
    sourceToken: crypto.randomUUID(),
  };
  const writer = env.LOG_ARCHIVE_WRITER ?? createLogIcebergWritePort(env, config);
  const { sourceToken: _initialToken, ...reservation } = value;
  const prepareCovered = <T>(run: () => Promise<T>) =>
    env.LOG_ARCHIVE_WRITER
      ? run()
      : runTenantBackupCoveredEffect(
          { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
          { tenantId: value.tenantId },
          run
        );
  const reserved = await prepareCovered(() => writer.reserveCorePublication(reservation));
  value.sourceToken = reserved.sourceToken;
  let row = await loadCore(core, value.publicationId);
  if (!row) throw new Error('log_core_publication_source_unavailable');
  assertIdentity(row, value);
  if (row.state === 'aborted') throw new Error('log_core_publication_aborted');
  if (row.state === 'prepared') {
    await prepareCovered(() => writer.prepareCorePublication({ ...value, record }));
    row = await loadCore(core, value.publicationId);
    if (!row || row.state === 'aborted' || !row.body_prepared)
      throw new Error('log_core_publication_aborted');
  }
  const dispatch = async () => {
    await writer.publishCorePublication({
      tenantId: value.tenantId,
      publicationId: value.publicationId,
    });
  };
  const commitStatement = (predicate: LogIcebergSqlGuard) =>
    coreCommit(
      core,
      value,
      { where: predicate.where, params: [...predicate.params] },
      Number(row.admission_expires_at)
    );
  return {
    publicationId: value.publicationId,
    state: row.state,
    record,
    beforeStatements: [] as PreparedStatement[],
    commitStatement,
    wrapBusinessBatch: (statements: PreparedStatement[], predicate: LogIcebergSqlGuard) => [
      ...statements,
      commitStatement(predicate),
    ],
    dispatch,
  };
}

/** Cold records carry no database-only publication column. Bind their logical IDs to the same witness. */
export async function filterPublishedCoreLogRecords(
  admin: DatabaseAdapter,
  tenantId: string,
  records: readonly LogArchiveRecord[]
): Promise<LogArchiveRecord[]> {
  const blocked = new Set<string>();
  const ids: string[] = [];
  for (const record of records) ids.push(await logIcebergRecordId(record));
  for (let start = 0; start < ids.length; start += 64) {
    const chunk = ids.slice(start, start + 64);
    const rows = await admin.query<{ record_id: string; payload_hmac: string; state: string }>(
      `SELECT record_id,payload_hmac,state FROM log_iceberg_publications WHERE tenant_id=? AND record_id IN(${chunk.map(() => '?').join(',')})`,
      [tenantId, ...chunk],
      primary
    );
    for (const row of rows) {
      const index = ids.indexOf(row.record_id, start);
      if (index < 0 || row.payload_hmac !== records[index].payload_hmac)
        throw new Error('log_core_publication_identity_conflict');
      if (row.state !== 'published') blocked.add(row.record_id);
    }
  }
  return filterLogIcebergRestoreRecords(
    admin,
    records.flatMap((record, index) =>
      blocked.has(ids[index]) ? [] : [{ id: ids[index], tenantId, record }]
    )
  );
}

/** All writes and visibility changes stay in the existing Core named RPC service. */
export function createCoreLogPublicationPort(
  env: LogIcebergRuntimeEnv,
  config: LogIcebergConfig,
  supplied: Omit<CoreLogPublicationPorts, 'resolveSource'> &
    Partial<Pick<CoreLogPublicationPorts, 'resolveSource'>>
): CoreLogPublicationRpc {
  const ports: CoreLogPublicationPorts = {
    ...supplied,
    resolveSource: supplied.resolveSource ?? ((source) => resolveSource(env, source)),
  };
  const assertCoreOwner = () => {
    if (
      !supplied.resolveSource &&
      (!env.AUTHRIM_ENVIRONMENT_NAME ||
        env.AUTHRIM_WORKER_SCRIPT_NAME !== `${env.AUTHRIM_ENVIRONMENT_NAME}-ar-lib-core`)
    )
      throw new Error('log_core_publication_writer_denied');
  };
  const admin = () =>
    ensureDatabaseAdapter(env.DB_ADMIN ?? missing(), 'log-core-publication-admin');
  const cover = <T>(tenantId: string, run: () => Promise<T>) =>
    ports.coverTenant
      ? ports.coverTenant(tenantId, run)
      : runTenantBackupCoveredEffect(
          { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
          { tenantId },
          run
        );
  const loadAdmin = (id: string) =>
    admin().queryOne<AdminRow>('SELECT * FROM log_iceberg_publications WHERE id=?', [id], primary);
  async function claimAdminPublication(value: CoreLogPublicationIdentity): Promise<AdminRow> {
    await admin().execute(
      `INSERT INTO log_iceberg_publications(id,tenant_id,storage_generation,record_id,source_dataset,payload_hmac,mode,source_json,source_digest,source_token,state,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,'prepared',${LOG_ICEBERG_DB_NOW},${LOG_ICEBERG_DB_NOW}
      WHERE EXISTS(SELECT 1 FROM log_iceberg_publications WHERE id=? AND record_id=?)
        OR (NOT EXISTS(SELECT 1 FROM log_iceberg_event_receipts WHERE id=?)
          AND NOT EXISTS(SELECT 1 FROM log_iceberg_records WHERE id=?)
          AND NOT EXISTS(SELECT 1 FROM log_iceberg_outbox WHERE id=?))
      ON CONFLICT(id) DO UPDATE SET payload_hmac=CASE
      WHEN log_iceberg_publications.tenant_id=excluded.tenant_id AND log_iceberg_publications.storage_generation=excluded.storage_generation
        AND log_iceberg_publications.record_id=excluded.record_id AND log_iceberg_publications.source_dataset=excluded.source_dataset
        AND log_iceberg_publications.payload_hmac=excluded.payload_hmac AND log_iceberg_publications.source_digest=excluded.source_digest
        AND log_iceberg_publications.source_token=excluded.source_token AND log_iceberg_publications.mode=excluded.mode
      THEN log_iceberg_publications.payload_hmac ELSE NULL END`,
      [
        value.publicationId,
        value.tenantId,
        config.generation,
        value.recordId,
        value.sourceDataset,
        value.payloadHmac,
        config.mode,
        logIcebergCanonicalJson(value.source),
        value.sourceDigest,
        value.sourceToken,
        value.publicationId,
        value.recordId,
        value.recordId,
        value.recordId,
        value.recordId,
      ]
    );
    const saved = await loadAdmin(value.publicationId);
    if (!saved) throw new Error('log_core_publication_admin_missing');
    assertIdentity(saved, value);
    if (saved.state === 'aborted') throw new Error('log_core_publication_aborted');
    return saved;
  }

  async function holdAdmission(value: CoreLogPublicationIdentity): Promise<void> {
    const control = env.CONTROL;
    if (!control?.acquireTenantBackupMutationPermit)
      throw new Error('log_core_publication_admission_unavailable');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await control.acquireTenantBackupMutationPermit({
          tenantId: value.tenantId,
          permitId: value.sourceToken,
        });
        if (result?.admitted === true) return;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    throw new Error('log_core_publication_admission_unavailable');
  }
  async function completeAdmission(
    core: DatabaseAdapter,
    value: CoreLogPublicationIdentity
  ): Promise<void> {
    const row = await loadCore(core, value.publicationId);
    if (!row || !['aborted', 'published'].includes(row.state))
      throw new Error('log_core_publication_admission_not_final');
    assertIdentity(row, value);
    if (row.admission_completed_at !== null) return;
    if (!env.CONTROL?.completeTenantBackupMutationPermit)
      throw new Error('log_core_publication_admission_unavailable');
    await env.CONTROL.completeTenantBackupMutationPermit({
      tenantId: value.tenantId,
      permitId: value.sourceToken,
    });
    await core.execute(
      `UPDATE log_iceberg_core_publications SET admission_completed_at=${dbNow(core)} WHERE id=? AND source_token=? AND state IN('aborted','published')`,
      [value.publicationId, value.sourceToken]
    );
  }
  async function reserveCorePublication(request: Omit<CoreLogPublicationIdentity, 'sourceToken'>) {
    assertCoreOwner();
    const value = { ...request, source: { ...request.source }, sourceToken: crypto.randomUUID() };
    await assertRequest(value, config);
    const core = await ports.resolveSource(value.source),
      statement = coreRegistration(core, value);
    await core.execute(statement.sql, statement.params);
    const saved = await loadCore(core, value.publicationId);
    if (!saved) throw new Error('log_core_publication_source_unavailable');
    value.sourceToken = saved.source_token;
    assertIdentity(saved, value);
    if (saved.state === 'aborted') {
      await completeAdmission(core, value);
      throw new Error('log_core_publication_aborted');
    }
    await claimAdminPublication(value);
    if (saved.state === 'prepared') {
      const live = await core.queryOne(
        `SELECT id FROM log_iceberg_core_publications WHERE id=? AND created_at+${ADMISSION_MS}>${dbNow(core)} AND (admission_expires_at=0 OR admission_expires_at>${dbNow(core)})`,
        [value.publicationId],
        primary
      );
      if (!live) throw new Error('log_core_publication_admission_expired');
      await holdAdmission(value);
      await core.execute(
        `UPDATE log_iceberg_core_publications SET admission_expires_at=created_at+${ADMISSION_MS} WHERE id=? AND state='prepared' AND admission_expires_at=0 AND admission_completed_at IS NULL AND created_at+${ADMISSION_MS}>${dbNow(core)}`,
        [value.publicationId]
      );
      const confirmed = await loadCore(core, value.publicationId);
      if (!confirmed || confirmed.state === 'aborted') {
        if (confirmed) await completeAdmission(core, value);
        throw new Error('log_core_publication_aborted');
      }
    }
    return { sourceToken: saved.source_token, state: saved.state };
  }
  async function prepareCorePublication(input: CoreLogPublicationPreparation): Promise<void> {
    assertCoreOwner();
    input = { ...input, source: { ...input.source }, record: { ...input.record } };
    await assertRequest(input, config);
    assertLogArchiveRecord(input.record);
    const core = await ports.resolveSource(input.source),
      sourceRow = await loadCore(core, input.publicationId);
    if (!sourceRow) throw new Error('log_core_publication_source_unavailable');
    assertIdentity(sourceRow, input);
    if (sourceRow.state === 'aborted') throw new Error('log_core_publication_aborted');
    if (
      input.recordId !== (await logIcebergRecordId(input.record)) ||
      input.record.payload_hmac !== input.payloadHmac ||
      input.record.source_dataset !== input.sourceDataset ||
      input.record.storage_generation !== config.generation ||
      input.record.ingested_at < config.activatedAt
    )
      throw new Error('log_core_publication_record_invalid');
    const keys = createLogIcebergKeyResolver(env);
    await decryptLogIcebergRecord(
      input.record,
      {
        tenantKey: await ports.tenantKey(input.tenantId),
        sourceDataset: input.sourceDataset,
        eventId: input.record.event_id,
      },
      async (version) => keys(version)
    );
    if (sourceRow.state === 'committed' || sourceRow.state === 'published') {
      if (!sourceRow.body_prepared) throw new Error('log_core_publication_record_invalid');
      return;
    }
    const live = await core.queryOne(
      `SELECT id FROM log_iceberg_core_publications WHERE id=? AND state='prepared' AND source_token=? AND admission_expires_at>${dbNow(core)} AND admission_completed_at IS NULL`,
      [input.publicationId, input.sourceToken],
      primary
    );
    if (!live) throw new Error('log_core_publication_admission_expired');
    const saved = await claimAdminPublication(input);
    if (saved.state === 'published') return;
    if (config.mode === 'pipeline')
      await ports.preparePipeline(
        { tenantId: input.tenantId, storageGeneration: config.generation, records: [input.record] },
        input.publicationId
      );
    else
      await new SqlLogIcebergRecordStore(admin()).put(
        input.tenantId,
        input.record,
        input.publicationId
      );
    if ((await loadAdmin(input.publicationId))?.state === 'aborted')
      throw new Error('log_core_publication_aborted');
    await core.execute(
      `UPDATE log_iceberg_core_publications SET body_prepared=1,updated_at=${dbNow(core)} WHERE id=? AND state='prepared' AND source_token=? AND payload_hmac=? AND admission_expires_at>${dbNow(core)} AND admission_completed_at IS NULL`,
      [input.publicationId, input.sourceToken, input.payloadHmac]
    );
    const ready = await loadCore(core, input.publicationId);
    if (!ready || ready.state === 'aborted' || !ready.body_prepared)
      throw new Error('log_core_publication_aborted');
  }
  async function reconcileOne(
    row: AdminRow,
    orphanBefore?: number
  ): Promise<CoreLogPublicationState> {
    const value = identity(row);
    await assertRequest(value, config);
    const lease = new LogIcebergTableLease(admin(), `publication_${row.id}`);
    if (!(await lease.acquire())) return row.state === 'aborted' ? 'aborted' : 'prepared';
    let core: DatabaseAdapter | undefined,
      token = crypto.randomUUID();
    try {
      core = await ports.resolveSource(value.source);
      const clock = dbNow(core);
      await core.execute(
        `UPDATE log_iceberg_core_publications SET lease_token=?,lease_until=${clock}+60000 WHERE id=? AND (lease_until IS NULL OR lease_until<=${clock})`,
        [token, row.id]
      );
      let current = await loadCore(core, row.id);
      if (current) assertIdentity(current, value);
      if (
        current &&
        !(await core.queryOne(
          `SELECT id FROM log_iceberg_core_publications WHERE id=? AND lease_token=? AND lease_until>${clock}`,
          [row.id, token],
          primary
        ))
      )
        return current.state;
      await lease.assert();
      if (
        row.state === 'published' &&
        (!current || !['committed', 'published'].includes(current.state))
      )
        throw new Error('log_core_publication_source_unknown');
      const expired =
        current?.state === 'prepared' &&
        !(await core.queryOne(
          `SELECT id FROM log_iceberg_core_publications WHERE id=? AND (CASE WHEN admission_expires_at=0 THEN created_at+${ADMISSION_MS} ELSE admission_expires_at END)>${clock}`,
          [row.id],
          primary
        ));
      if (!current || current.state === 'prepared' || current.state === 'aborted') {
        if (
          current &&
          current.state !== 'aborted' &&
          !expired &&
          (orphanBefore === undefined || row.created_at > orphanBefore)
        )
          return 'prepared';
        if (!current) {
          const register = coreRegistration(core, value);
          await core.execute(register.sql.replace("'prepared',0", "'aborted',0"), register.params);
        } else if (current.state === 'prepared')
          await core.execute(
            `UPDATE log_iceberg_core_publications SET state='aborted',updated_at=${clock} WHERE id=? AND state='prepared' AND lease_token=? AND lease_until>${clock}`,
            [row.id, token]
          );
        current = await loadCore(core, row.id);
        if (!current) throw new Error('log_core_publication_source_unavailable');
        assertIdentity(current, value);
        if (current.state !== 'aborted') return current.state;
        await lease.assert();
        // Admin abort is a permanent fence against late staging/PUT preparations.
        await admin().batch([
          {
            sql: `UPDATE log_iceberg_publications SET state='aborted',updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND state='prepared' AND ${lease.predicate}`,
            params: [row.id, ...lease.params],
          },
          {
            sql: `UPDATE log_iceberg_outbox SET state='erased',updated_at=${LOG_ICEBERG_DB_NOW} WHERE publication_id=? AND EXISTS(SELECT 1 FROM log_iceberg_publications WHERE id=? AND state='aborted') AND ${lease.predicate}`,
            params: [row.id, row.id, ...lease.params],
          },
          {
            sql: `UPDATE log_iceberg_event_receipts SET state='erased' WHERE id=? AND EXISTS(SELECT 1 FROM log_iceberg_publications WHERE id=? AND state='aborted') AND ${lease.predicate}`,
            params: [row.record_id, row.id, ...lease.params],
          },
        ]);
        await lease.assert();
        if (
          (await listCapturingTenantBackupTenantKeys(admin())).has(
            await ports.tenantKey(row.tenant_id)
          )
        ) {
          await completeAdmission(core, value);
          return 'aborted';
        }
        await admin().execute(
          `DELETE FROM log_iceberg_records WHERE publication_id=? AND EXISTS(SELECT 1 FROM log_iceberg_publications WHERE id=? AND state='aborted') AND ${lease.predicate}`,
          [row.id, row.id, ...lease.params]
        );
        await lease.assert();
        const retries = await admin().query<{
          id: string;
          storage_generation: string;
          payload_key: string;
          payload_hmac: string;
          payload_digest: string | null;
          payload_bytes: number | null;
          payload_erased_at: number | null;
        }>(
          'SELECT id,storage_generation,payload_key,payload_hmac,payload_digest,payload_bytes,payload_erased_at FROM log_iceberg_outbox WHERE publication_id=?',
          [row.id],
          primary
        );
        for (const retry of retries) {
          if (retry.payload_erased_at !== null) continue;
          if (
            !env.LOG_ARCHIVE ||
            !(await retireLogIcebergRetryObject(
              env.LOG_ARCHIVE,
              {
                id: retry.id,
                generation: retry.storage_generation,
                key: retry.payload_key,
                hmac: retry.payload_hmac,
                digest: retry.payload_digest,
                bytes: retry.payload_bytes,
              },
              () => lease.assert()
            ))
          ) {
            await completeAdmission(core, value);
            return 'aborted';
          }
          await admin().execute(
            `UPDATE log_iceberg_outbox SET payload_erased_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND state='erased' AND ${lease.predicate}`,
            [retry.id, ...lease.params]
          );
        }
        await completeAdmission(core, value);
        await admin().execute(
          `UPDATE log_iceberg_publications SET finalized=1 WHERE id=? AND state='aborted' AND ${lease.predicate}`,
          [row.id, ...lease.params]
        );
        await lease.assert();
        return 'aborted';
      }
      if (!current.body_prepared) throw new Error('log_core_publication_body_unconfirmed');
      await lease.assert();
      const refs =
        config.mode === 'pipeline'
          ? await admin().query<LogIcebergQueueReference>(
              `SELECT 'iceberg_ingest' AS payload_type,1 AS schema_version,id,storage_generation,source_dataset,subject_id,payload_hmac,payload_key,payload_digest,payload_bytes,expires_at FROM log_iceberg_outbox WHERE publication_id=? AND state!='erased'`,
              [row.id],
              primary
            )
          : [];
      if (config.mode === 'pipeline' && refs.length !== 1 && row.state !== 'published')
        throw new Error('log_core_publication_body_unconfirmed');
      const guard = {
        where: `EXISTS(SELECT 1 FROM log_iceberg_publications WHERE id=? AND state='published') AND ${lease.predicate}`,
        params: [row.id, ...lease.params],
      };
      await admin().batch([
        {
          sql: `UPDATE log_iceberg_publications SET state='published',updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND state IN('prepared','published') AND ${lease.predicate}`,
          params: [row.id, ...lease.params],
        },
        ...(await prepareLogIcebergRetentionScope(
          config,
          {
            tenantId: row.tenant_id,
            tenantKey: await ports.tenantKey(row.tenant_id),
            sourceDataset: row.source_dataset,
          },
          guard
        )),
        ...refs.map((ref) =>
          logIcebergOutboxStatement(row.tenant_id, ref, Date.now(), guard, row.id)
        ),
      ]);
      await lease.assert();
      if ((await loadAdmin(row.id))?.state !== 'published')
        throw new Error('log_core_publication_not_published');
      if (refs.length) await ports.dispatchPipeline({ tenantId: row.tenant_id, references: refs });
      await core.execute(
        `UPDATE log_iceberg_core_publications SET state='published',updated_at=${clock} WHERE id=? AND state IN('committed','published') AND lease_token=? AND lease_until>${clock}`,
        [row.id, token]
      );
      const ack = await loadCore(core, row.id);
      if (ack?.state === 'published') {
        await completeAdmission(core, value);
        await admin().execute(
          `UPDATE log_iceberg_publications SET finalized=1 WHERE id=? AND state='published' AND ${lease.predicate}`,
          [row.id, ...lease.params]
        );
      }
      return 'published';
    } finally {
      if (core)
        await core.execute(
          'UPDATE log_iceberg_core_publications SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?',
          [row.id, token]
        );
      await lease.release();
    }
  }
  async function coverPublication<T>(row: AdminRow, run: () => Promise<T>): Promise<T> {
    const value = identity(row),
      core = await ports.resolveSource(value.source),
      source = await loadCore(core, row.id);
    if (source) assertIdentity(source, value);
    const withinControlLease =
      source &&
      (await core.queryOne(
        `SELECT id FROM log_iceberg_core_publications WHERE id=? AND created_at+${TENANT_BACKUP_MUTATION_PERMIT_LEASE_MS}>${dbNow(core)}`,
        [row.id],
        primary
      ));
    if ((!source || source.admission_completed_at === null) && withinControlLease) {
      let held = false;
      try {
        await holdAdmission(value);
        held = true;
      } catch (error) {
        const current = await loadCore(core, row.id);
        if (!current || !['published', 'aborted'].includes(current.state)) throw error;
        // A lost completion ACK may already have closed the original permit. The normal
        // short permit is then required for remaining metadata/physical cleanup.
      }
      if (held) return run();
    }
    return cover(row.tenant_id, run);
  }
  async function publishCorePublication(input: CoreLogPublicationRequest) {
    assertCoreOwner();
    const row = await loadAdmin(input.publicationId);
    if (!row || row.tenant_id !== input.tenantId)
      throw new Error('log_core_publication_admin_missing');
    return { state: await coverPublication(row, () => reconcileOne(row)) };
  }
  async function reconcileCorePublications(input: CoreLogPublicationReconcile = {}) {
    assertCoreOwner();
    const limit = input.limit ?? 16;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('log_core_publication_scan_invalid');
    const before = input.orphanBefore ?? Date.now() - ORPHAN_MS;
    if (!Number.isSafeInteger(before) || before < 0)
      throw new Error('log_core_publication_scan_invalid');
    const rows = await admin().query<AdminRow>(
      `SELECT * FROM log_iceberg_publications WHERE storage_generation=? AND finalized=0 AND next_attempt_at<=${LOG_ICEBERG_DB_NOW} ORDER BY next_attempt_at,updated_at,id LIMIT ?`,
      [config.generation, limit],
      primary
    );
    const result = { published: 0, aborted: 0, retained: 0 };
    for (const row of rows) {
      try {
        const state = await coverPublication(row, () => reconcileOne(row, before));
        if (state === 'published') result.published++;
        else if (state === 'aborted') result.aborted++;
        else result.retained++;
      } catch {
        result.retained++;
      }
      try {
        await cover(row.tenant_id, () =>
          admin().execute(
            `UPDATE log_iceberg_publications SET next_attempt_at=${LOG_ICEBERG_DB_NOW}+300000,attempt_count=attempt_count+1 WHERE id=? AND finalized=0`,
            [row.id]
          )
        );
      } catch {
        /* A frozen/unavailable source remains due for recovery. */
      }
    }
    return result;
  }
  return {
    reserveCorePublication,
    prepareCorePublication,
    publishCorePublication,
    reconcileCorePublications,
  };
}
function missing(): never {
  throw new Error('log_core_publication_admin_unavailable');
}
