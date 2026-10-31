import {
  logIcebergRestoreVisibleSql,
  logIcebergRestoreWriteGuard,
  filterLogIcebergRestoreRecords,
} from './log-iceberg-restore-hold';
import {
  assertLogArchiveRecord,
  type LogArchiveRecord,
} from '@authrim/ar-lib-logging/iceberg/schema';
import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';
import {
  filterUnErasedLogIcebergRecords,
  assertLogIcebergPiiSubject,
} from './log-iceberg-erasure-filter';

const PART_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

/** Source-owned static SQL; request values belong only in params. */
export interface LogIcebergSqlGuard {
  where: string;
  params: unknown[];
}
export function logIcebergGuard(guard?: LogIcebergSqlGuard): { sql: string; params: unknown[] } {
  if (!guard) return { sql: '', params: [] };
  if (
    typeof guard.where !== 'string' ||
    !guard.where.trim() ||
    guard.where.length > 8192 ||
    !Array.isArray(guard.params) ||
    guard.params.length > 100
  )
    throw new Error('log_iceberg_sql_guard_invalid');
  return { sql: ` AND (${guard.where})`, params: [...guard.params] };
}

export interface LogIcebergStagedHead {
  id: string;
  publication_id: string | null;
  tenant_id: string;
  tenant_key: string;
  source_dataset: string;
  event_id: string;
  storage_generation: string;
  event_at: number;
  ingested_at: number;
  expires_at: number | null;
  payload_hmac: string;
  envelope_digest: string;
  header_json: string;
  body_bytes: number;
  part_count: number;
  batch_id: string | null;
}

export async function logIcebergDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function logIcebergRecordId(
  record: Pick<LogArchiveRecord, 'tenant_key' | 'source_dataset' | 'event_id'>
): Promise<string> {
  return logIcebergDigest(
    JSON.stringify([record.tenant_key, record.source_dataset, record.event_id])
  );
}

/** Direct writers have NULL publication_id; Core preparations require a durable publish witness. */
export function logIcebergPublicationVisibleSql(alias = 'log_iceberg_records'): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(alias)) throw new Error('log_iceberg_sql_alias_invalid');
  return `((${alias}.publication_id IS NULL OR EXISTS(SELECT 1 FROM log_iceberg_publications p WHERE p.id=${alias}.publication_id AND p.record_id=${alias}.id AND p.payload_hmac=${alias}.payload_hmac AND p.state='published')) AND ${logIcebergRestoreVisibleSql(alias)})`;
}

/** The Admin staging store is never used as a pipeline retry source or log copy. */
export class SqlLogIcebergRecordStore {
  constructor(readonly adapter: DatabaseAdapter) {}

  /** May be composed with an Admin business mutation in the same atomic batch. */
  async preparePut(
    tenantId: string,
    record: LogArchiveRecord,
    guard?: LogIcebergSqlGuard,
    publicationId?: string
  ): Promise<{ id: string; statements: PreparedStatement[] }> {
    const outer = logIcebergGuard(guard);
    const condition = {
      sql: `${outer.sql} AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM log_iceberg_publications p WHERE p.record_id=?)) OR EXISTS(SELECT 1 FROM log_iceberg_publications p WHERE p.id=? AND p.state='prepared' AND p.tenant_id=? AND p.record_id=? AND p.payload_hmac=?))`,
      params: [] as unknown[],
    };
    assertLogArchiveRecord(record);
    if (!tenantId || tenantId.length > 256) throw new Error('log_iceberg_tenant_invalid');
    assertLogIcebergPiiSubject(record.source_dataset, record.subject_id);
    const id = await logIcebergRecordId(record);
    const restoreGuard = logIcebergRestoreWriteGuard({
      id,
      tenantId,
      hmac: record.payload_hmac,
      generation: record.storage_generation,
      expiresAt: record.expires_at,
    });
    condition.sql += ` AND (${restoreGuard.where})`;
    condition.params = [
      ...outer.params,
      publicationId ?? null,
      id,
      publicationId ?? null,
      tenantId,
      id,
      record.payload_hmac,
      ...restoreGuard.params,
    ];
    const { detail_ciphertext: body, ...header } = record;
    // The envelope is ASCII JSON/base64; splitting cannot cut a UTF-8 code point.
    if (!/^[\x20-\x7e]+$/.test(body) || body.length > MAX_BODY_BYTES)
      throw new Error('log_iceberg_staging_body_invalid');
    const envelopeDigest = await logIcebergDigest(body);
    const headerJson = JSON.stringify(header);
    if (encoder.encode(headerJson).byteLength > 16 * 1024)
      throw new Error('log_iceberg_staging_header_too_large');
    const parts = Math.ceil(body.length / PART_BYTES);
    const statements: PreparedStatement[] = [
      {
        sql: `INSERT INTO log_iceberg_event_receipts(id,tenant_id,source_dataset,payload_hmac,expires_at,state,created_at)
        SELECT ?,?,?,?,?,'staged',? WHERE NOT EXISTS(SELECT 1 FROM log_iceberg_subject_erasures WHERE tenant_id=? AND source_dataset=? AND subject_id=?)${condition.sql} ON CONFLICT(id) DO UPDATE SET payload_hmac=CASE
        WHEN log_iceberg_event_receipts.tenant_id=excluded.tenant_id AND log_iceberg_event_receipts.source_dataset=excluded.source_dataset
          AND log_iceberg_event_receipts.payload_hmac=excluded.payload_hmac AND log_iceberg_event_receipts.expires_at IS excluded.expires_at
        THEN log_iceberg_event_receipts.payload_hmac ELSE NULL END`,
        params: [
          id,
          tenantId,
          record.source_dataset,
          record.payload_hmac,
          record.expires_at,
          record.ingested_at,
          tenantId,
          record.source_dataset,
          record.source_dataset === 'pii.pii_log' ? record.subject_id : null,
          ...condition.params,
        ],
      },
      {
        sql: `INSERT INTO log_iceberg_records
        (id,tenant_id,tenant_key,source_dataset,event_id,storage_generation,event_at,ingested_at,
         expires_at,payload_hmac,envelope_digest,header_json,body_bytes,part_count,publication_id)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM log_iceberg_event_receipts WHERE id=? AND state='staged')
          AND NOT EXISTS(SELECT 1 FROM log_iceberg_subject_erasures WHERE tenant_id=? AND source_dataset=? AND subject_id=?)${condition.sql}
        ON CONFLICT(id) DO UPDATE SET payload_hmac=
          CASE WHEN log_iceberg_records.tenant_id=excluded.tenant_id
            AND log_iceberg_records.tenant_key=excluded.tenant_key
            AND log_iceberg_records.source_dataset=excluded.source_dataset
            AND log_iceberg_records.event_id=excluded.event_id
            AND log_iceberg_records.payload_hmac=excluded.payload_hmac
            AND log_iceberg_records.publication_id IS excluded.publication_id
          THEN log_iceberg_records.payload_hmac ELSE NULL END`,
        params: [
          id,
          tenantId,
          record.tenant_key,
          record.source_dataset,
          record.event_id,
          record.storage_generation,
          record.event_at,
          record.ingested_at,
          record.expires_at,
          record.payload_hmac,
          envelopeDigest,
          headerJson,
          body.length,
          parts,
          publicationId ?? null,
          id,
          tenantId,
          record.source_dataset,
          record.source_dataset === 'pii.pii_log' ? record.subject_id : null,
          ...condition.params,
        ],
      },
    ];
    for (let i = 0; i < parts; i++)
      statements.push({
        sql: `INSERT INTO log_iceberg_record_parts(id,record_id,tenant_id,part_index,body)
        SELECT ?,id,tenant_id,?,? FROM log_iceberg_records
        WHERE id=? AND tenant_id=? AND envelope_digest=?${condition.sql}
        ON CONFLICT(id) DO NOTHING`,
        params: [
          `${id}_${i}`,
          i,
          body.slice(i * PART_BYTES, (i + 1) * PART_BYTES),
          id,
          tenantId,
          envelopeDigest,
          ...condition.params,
        ],
      });
    return { id, statements };
  }

  async put(
    tenantId: string,
    record: LogArchiveRecord,
    publicationId?: string,
    beforeStatements: PreparedStatement[] = []
  ): Promise<void> {
    if (!(await filterUnErasedLogIcebergRecords(this.adapter, tenantId, [record])).length) return;
    const { id, statements } = await this.preparePut(tenantId, record, undefined, publicationId);
    try {
      await this.adapter.batch([...beforeStatements, ...statements]);
    } catch (error) {
      const saved = await this.adapter.queryOne<{ payload_hmac: string }>(
        'SELECT payload_hmac FROM log_iceberg_records WHERE id=?',
        [id],
        { consistencyClass: 'primary_required' }
      );
      if (saved && saved.payload_hmac !== record.payload_hmac)
        throw new Error('log_iceberg_event_id_collision');
      const receipt = await this.adapter.queryOne<{ payload_hmac: string }>(
        'SELECT payload_hmac FROM log_iceberg_event_receipts WHERE id=?',
        [id],
        { consistencyClass: 'primary_required' }
      );
      if (receipt && receipt.payload_hmac !== record.payload_hmac)
        throw new Error('log_iceberg_event_id_collision');
      throw error;
    }
    const saved = await this.adapter.queryOne<LogIcebergStagedHead>(
      'SELECT * FROM log_iceberg_records WHERE id=?',
      [id],
      { consistencyClass: 'primary_required' }
    );
    if (!saved) {
      if (!(await filterUnErasedLogIcebergRecords(this.adapter, tenantId, [record])).length) return;
      const receipt = await this.adapter.queryOne<{
        payload_hmac: string;
        tenant_id: string;
        source_dataset: string;
        state: string;
      }>(
        'SELECT payload_hmac,tenant_id,source_dataset,state FROM log_iceberg_event_receipts WHERE id=?',
        [id],
        { consistencyClass: 'primary_required' }
      );
      if (
        receipt?.state === 'published' &&
        receipt.payload_hmac === record.payload_hmac &&
        receipt.tenant_id === tenantId &&
        receipt.source_dataset === record.source_dataset
      )
        return;
    }
    // Identical content with a fresh encryption nonce is a retry, never an overwrite.
    if (
      !saved ||
      saved.tenant_id !== tenantId ||
      saved.tenant_key !== record.tenant_key ||
      saved.source_dataset !== record.source_dataset ||
      saved.event_id !== record.event_id ||
      saved.payload_hmac !== record.payload_hmac ||
      saved.publication_id !== (publicationId ?? null)
    )
      throw new Error('log_iceberg_event_id_collision');
  }

  /** A missing source may have been committed/deleted concurrently. The caller
   * must subsequently load a fresh cold snapshot and the source-delete watermark. */
  async read(
    heads: readonly LogIcebergStagedHead[],
    options?: { restoreOperationId: string }
  ): Promise<LogArchiveRecord[]> {
    let total = 0;
    for (const head of heads) {
      if (
        head.publication_id &&
        !(await this.adapter.queryOne(
          "SELECT id FROM log_iceberg_publications WHERE id=? AND record_id=? AND payload_hmac=? AND state='published'",
          [head.publication_id, head.id, head.payload_hmac],
          { consistencyClass: 'primary_required' }
        ))
      )
        throw new Error('log_iceberg_publication_not_published');
      if (
        !Number.isSafeInteger(head.body_bytes) ||
        head.body_bytes < 1 ||
        head.body_bytes > MAX_BODY_BYTES ||
        !Number.isSafeInteger(head.part_count) ||
        head.part_count < 1 ||
        head.part_count > 64
      )
        throw new Error('log_iceberg_staging_invalid');
      total += head.body_bytes;
      if (total > MAX_READ_BYTES) throw new Error('log_iceberg_staging_budget_exceeded');
    }
    const records: LogArchiveRecord[] = [];
    for (const head of heads) {
      const parts: Array<{ part_index: number; body: string }> = [];
      for (let i = 0; i < head.part_count; i += 12) {
        parts.push(
          ...(await this.adapter.query<{ part_index: number; body: string }>(
            `SELECT part_index,body FROM log_iceberg_record_parts
           WHERE record_id=? AND part_index>=? AND part_index<? ORDER BY part_index LIMIT 12`,
            [head.id, i, Math.min(i + 12, head.part_count)],
            { consistencyClass: 'primary_required' }
          ))
        );
      }
      if (parts.length !== head.part_count) {
        const current = await this.adapter.queryOne<{ id: string }>(
          'SELECT id FROM log_iceberg_records WHERE id=?',
          [head.id],
          { consistencyClass: 'primary_required' }
        );
        if (!current) continue;
        throw new Error('log_iceberg_staging_parts_missing');
      }
      if (
        parts.some(
          (part, i) =>
            part.part_index !== i ||
            typeof part.body !== 'string' ||
            part.body.length < 1 ||
            part.body.length > PART_BYTES
        )
      )
        throw new Error('log_iceberg_staging_parts_invalid');
      const body = parts.map((part) => part.body).join('');
      if (
        body.length !== head.body_bytes ||
        (await logIcebergDigest(body)) !== head.envelope_digest
      )
        throw new Error('log_iceberg_staging_digest_mismatch');
      const header = JSON.parse(head.header_json) as unknown;
      if (!header || typeof header !== 'object' || Array.isArray(header))
        throw new Error('log_iceberg_staging_invalid');
      const record = { ...header, detail_ciphertext: body };
      assertLogArchiveRecord(record);
      if (
        record.tenant_key !== head.tenant_key ||
        record.source_dataset !== head.source_dataset ||
        record.event_id !== head.event_id ||
        record.payload_hmac !== head.payload_hmac ||
        record.storage_generation !== head.storage_generation ||
        record.event_at !== head.event_at ||
        record.ingested_at !== head.ingested_at ||
        record.expires_at !== head.expires_at ||
        (await logIcebergRecordId(record)) !== head.id
      )
        throw new Error('log_iceberg_staging_scope_mismatch');
      records.push(record);
    }
    return filterLogIcebergRestoreRecords(
      this.adapter,
      records.map((record) => {
        const head = heads.find(
          (value) =>
            value.event_id === record.event_id &&
            value.tenant_key === record.tenant_key &&
            value.source_dataset === record.source_dataset
        );
        if (!head) throw new Error('log_iceberg_staging_scope_mismatch');
        return { id: head.id, tenantId: head.tenant_id, record };
      }),
      options?.restoreOperationId
    );
  }

  async readTenant(input: {
    tenantId: string;
    tenantKey: string;
    sourceDataset: string;
    now: number;
    fromMs?: number;
    toMs?: number;
    eventId?: string;
  }): Promise<LogArchiveRecord[]> {
    if (
      !input.tenantId ||
      !input.tenantKey ||
      !input.sourceDataset ||
      !Number.isSafeInteger(input.now)
    )
      throw new Error('log_iceberg_staging_scope_invalid');
    const conditions = [
      'tenant_id=?',
      logIcebergPublicationVisibleSql(),
      'tenant_key=?',
      'source_dataset=?',
      '(expires_at IS NULL OR expires_at>?)',
    ];
    const params: unknown[] = [input.tenantId, input.tenantKey, input.sourceDataset, input.now];
    if (input.eventId !== undefined) {
      if (!input.eventId || input.eventId.length > 256)
        throw new Error('log_iceberg_staging_scope_invalid');
      conditions.push('event_id=?');
      params.push(input.eventId);
    }
    for (const [value, comparison] of [
      [input.fromMs, '>='],
      [input.toMs, '<='],
    ] as const) {
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('log_iceberg_staging_window_invalid');
      conditions.push(`event_at${comparison}?`);
      params.push(value);
    }
    const sizes = await this.adapter.query<{
      id: string;
      body_bytes: number;
      header_bytes: number;
    }>(
      `SELECT id,body_bytes,length(CAST(header_json AS BLOB)) AS header_bytes
       FROM log_iceberg_records WHERE ${conditions.join(' AND ')}
       ORDER BY event_at DESC,id DESC LIMIT 10001`,
      params,
      { consistencyClass: 'primary_required' }
    );
    if (sizes.length > 10000) throw new Error('log_iceberg_staging_budget_exceeded');
    let bytes = 0;
    for (const size of sizes) {
      if (
        !Number.isSafeInteger(size.body_bytes) ||
        size.body_bytes < 1 ||
        !Number.isSafeInteger(size.header_bytes) ||
        size.header_bytes < 1 ||
        size.header_bytes > 16 * 1024
      )
        throw new Error('log_iceberg_staging_invalid');
      bytes += size.body_bytes + size.header_bytes;
      if (bytes > MAX_READ_BYTES) throw new Error('log_iceberg_staging_budget_exceeded');
    }
    const heads: LogIcebergStagedHead[] = [];
    for (let i = 0; i < sizes.length; i += 24) {
      const ids = sizes.slice(i, i + 24).map(({ id }) => id);
      heads.push(
        ...(await this.adapter.query<LogIcebergStagedHead>(
          `SELECT * FROM log_iceberg_records WHERE tenant_id=? AND tenant_key=? AND source_dataset=?
         AND id IN (${ids.map(() => '?').join(',')})`,
          [input.tenantId, input.tenantKey, input.sourceDataset, ...ids],
          { consistencyClass: 'primary_required' }
        ))
      );
    }
    return this.read(heads);
  }
}
