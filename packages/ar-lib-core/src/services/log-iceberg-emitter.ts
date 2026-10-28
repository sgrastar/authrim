import { prepareLogIcebergRetentionScope } from './log-iceberg-retention-scope';
import type { LogArchiveRecord } from '@authrim/ar-lib-logging/iceberg/schema';
import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';
import { assertLogIcebergActivated, resolveLogIcebergConfig } from './log-iceberg-config';
import {
  buildLogIcebergRecord,
  type LogIcebergOverview,
  type LogIcebergRecordKeys,
} from './log-iceberg-record';
import { encodeLogIcebergRow, type LogIcebergSqlRow } from './log-iceberg-row-codec';
import {
  logIcebergWriterForTenant,
  logIcebergMutationScope,
  logIcebergOutboxStatement,
  type LogIcebergRuntimeEnv,
} from './log-iceberg-runtime';
import { SqlLogIcebergRecordStore, type LogIcebergSqlGuard } from './log-iceberg-store';
export type { LogIcebergSqlGuard } from './log-iceberg-store';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';
import { createLogIcebergKeyResolver } from './log-iceberg-keys';

export interface LogIcebergRowWrite {
  tenantId: string;
  sourceDataset: string;
  logType: string;
  row: LogIcebergSqlRow;
  eventAt: number;
  expiresAt: number | null;
  overview?: Partial<LogIcebergOverview>;
  protectedDetail?: Record<string, unknown>;
  adminInlineMetadata?: Record<string, unknown>;
  ingestedAt?: number;
}

export function resolveLogIcebergRecordKeys(env: LogIcebergRuntimeEnv): LogIcebergRecordKeys {
  return createLogIcebergKeyResolver(env)();
}

export async function buildLogIcebergRowRecord(
  env: LogIcebergRuntimeEnv,
  input: LogIcebergRowWrite
): Promise<LogArchiveRecord> {
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  input = {
    ...input,
    row: { ...input.row },
    overview: input.overview ? { ...input.overview } : undefined,
    protectedDetail: input.protectedDetail ? structuredClone(input.protectedDetail) : undefined,
    adminInlineMetadata: input.adminInlineMetadata
      ? structuredClone(input.adminInlineMetadata)
      : undefined,
  };
  if (typeof input.row.id !== 'string' || !input.row.id || input.row.tenant_id !== input.tenantId)
    throw new Error('log_iceberg_row_scope_invalid');
  // Capture the scalar row before resolving remote tenant identity.
  const row = { ...input.row };
  const overview = input.overview ? { ...input.overview } : undefined;
  for (const [name, value] of Object.entries(row)) {
    if (
      !/^[a-z_][a-z0-9_]*$/.test(name) ||
      (value !== null &&
        typeof value !== 'string' &&
        !(
          typeof value === 'number' &&
          Number.isFinite(value) &&
          (!Number.isInteger(value) || Number.isSafeInteger(value))
        ))
    )
      throw new Error('log_iceberg_row_body_invalid');
  }
  const writer = logIcebergWriterForTenant(env, config, input.tenantId);
  const tenantKey = await writer.resolveTenantKey(input.tenantId);
  const keys = resolveLogIcebergRecordKeys(env);
  const body = await encodeLogIcebergRow({
    context: {
      tenantKey,
      sourceDataset: input.sourceDataset,
      eventId: input.row.id,
      generation: config.generation,
      schemaVersion: config.schemaVersion,
    },
    row,
    keys,
    protectedDetail: input.protectedDetail,
    adminInlineMetadata: input.adminInlineMetadata,
  });
  return buildLogIcebergRecord(
    config,
    {
      eventId: input.row.id,
      tenantKey,
      sourceDataset: input.sourceDataset,
      logType: input.logType,
      eventAt: input.eventAt,
      expiresAt: input.expiresAt,
      ingestedAt: input.ingestedAt ?? Date.now(),
      overview,
      body,
    },
    keys
  );
}

/** Explicit producer path. The scheduled mode writes only encrypted DB parts;
 * the pipeline mode persists a delivery reference and queues encrypted payload. */
export async function emitLogIcebergRow(
  env: LogIcebergRuntimeEnv,
  input: LogIcebergRowWrite
): Promise<LogArchiveRecord> {
  const tenantId = input.tenantId;
  const config = resolveLogIcebergConfig(env);
  const record = await buildLogIcebergRowRecord(env, input);
  const writer = logIcebergWriterForTenant(env, config, tenantId);
  const request = {
    tenantId: tenantId,
    storageGeneration: config.generation,
    records: [record],
  };
  if (env.LOG_ARCHIVE_WRITER && tenantId !== 'platform') await writer.writeRecords(request);
  else
    await runTenantBackupCoveredEffect(
      { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
      logIcebergMutationScope(env, tenantId),
      () => writer.writeRecords(request)
    );
  return record;
}

/** For an existing atomic Admin business batch. Prepare encrypted durable state
 * first, add every returned statement to that batch, dispatch only after commit.
 * A failed dispatch remains recoverable from the committed pointer outbox. */
export async function prepareLogIcebergRowWrite(
  env: LogIcebergRuntimeEnv,
  adminAdapter: DatabaseAdapter,
  input: LogIcebergRowWrite,
  guard?: LogIcebergSqlGuard | ((record: LogArchiveRecord) => LogIcebergSqlGuard)
): Promise<{
  statements: PreparedStatement[];
  dispatch: () => Promise<void>;
  record: LogArchiveRecord;
}> {
  const tenantId = input.tenantId;
  const suppliedGuard =
    typeof guard === 'function' || !guard
      ? guard
      : { where: guard.where, params: [...guard.params] };
  const config = resolveLogIcebergConfig(env);
  const record = await buildLogIcebergRowRecord(env, input);
  const resolvedGuard = typeof suppliedGuard === 'function' ? suppliedGuard(record) : suppliedGuard;
  const fixedGuard = resolvedGuard
    ? { where: resolvedGuard.where, params: [...resolvedGuard.params] }
    : undefined;
  const retention = await prepareLogIcebergRetentionScope(
    config,
    { tenantId, tenantKey: record.tenant_key, sourceDataset: record.source_dataset },
    fixedGuard
  );
  if (config.mode === 'scheduled') {
    const { statements } = await new SqlLogIcebergRecordStore(adminAdapter).preparePut(
      tenantId,
      record,
      fixedGuard
    );
    return { statements: [...retention, ...statements], record, dispatch: async () => {} };
  }
  const writer = logIcebergWriterForTenant(env, config, tenantId);
  const prepare = () =>
    writer.preparePipelineReferences({
      tenantId,
      storageGeneration: config.generation,
      records: [record],
    });
  const references =
    tenantId === 'platform'
      ? await runTenantBackupCoveredEffect(
          { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
          logIcebergMutationScope(env, tenantId),
          prepare
        )
      : await prepare();
  return {
    statements: [
      ...retention,
      ...references.map((reference) =>
        logIcebergOutboxStatement(tenantId, reference, Date.now(), fixedGuard)
      ),
    ],
    record,
    dispatch: () =>
      tenantId === 'platform'
        ? runTenantBackupCoveredEffect(
            { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
            logIcebergMutationScope(env, tenantId),
            () => writer.dispatchPipelineReferences({ tenantId, references })
          )
        : writer.dispatchPipelineReferences({ tenantId: tenantId, references }),
  };
}
