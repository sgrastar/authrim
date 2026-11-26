import { describe, expect, it } from 'vitest';
import { parseLoggingMessageQueuePayload } from '../queue-payload';

const replay = {
  payload_type: 'dlq_replay',
  schema_version: 1,
  payload_id: 'qpl_replay',
  tenant_key: 't_1',
  lane: 'default',
  created_at: 1,
  dlq_item_id: 'dlq_1',
  requested_by: 'admin_1',
};

const retry: Record<string, unknown> = {
  payload_type: 'retry_delivery',
  schema_version: 1,
  payload_id: 'qpl_retry',
  message_job_id: 'lmj_retry',
  tenant_key: 't_1',
  lane: 'default',
  created_at: 1,
  source_type: 'dlq_item',
  source_id: 'dlq_1',
  retry_id: 'retry_1',
  idempotency_key: 'idem_1',
  target_payload_hash: 'hash',
  requested_by: 'admin_1',
  replay_payload: replay,
};

const exportBuild: Record<string, unknown> = {
  payload_type: 'export_build',
  schema_version: 1,
  payload_id: 'qpl_export',
  message_job_id: 'lmj_export',
  lane: 'bulk',
  created_at: 1,
  export_job_id: 'lexp_1',
  phase: 'plan',
  snapshot_cutoff_at: 5,
  requested_by: 'admin_1',
};

const ok = (value: unknown): boolean => parseLoggingMessageQueuePayload(value).ok;

describe('envelope', () => {
  it('returns a valid payload as it is', () => {
    for (const payload of [retry, exportBuild]) {
      const result = parseLoggingMessageQueuePayload(payload);
      expect(result).toStrictEqual({ ok: true, payload });
    }
  });

  it('refuses what is not an object, with no detail', () => {
    for (const value of [null, undefined, 0, 'x', true, [], [retry]]) {
      expect(parseLoggingMessageQueuePayload(value)).toStrictEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('refuses an envelope with a field missing or of the wrong kind', () => {
    const wrong: Record<string, unknown[]> = {
      payload_type: [undefined, 5, null],
      schema_version: [undefined, '1', 1.5, Number.NaN, null],
      payload_id: [undefined, 5, null],
      message_job_id: [undefined, 5, null],
      tenant_key: [5, {}],
      lane: [undefined, 'urgent', 5],
      created_at: [undefined, '1', Number.NaN, Number.POSITIVE_INFINITY, null],
    };
    for (const [key, values] of Object.entries(wrong)) {
      for (const value of values) {
        expect(parseLoggingMessageQueuePayload({ ...exportBuild, [key]: value })).toStrictEqual({
          ok: false,
          reason: 'malformed',
        });
      }
    }
  });

  it('lets the tenant be absent, null or a string, and any of the three lanes', () => {
    for (const tenant_key of [undefined, null, 't_1', '']) {
      expect(ok({ ...exportBuild, tenant_key })).toBe(true);
    }
    for (const lane of ['critical', 'default', 'bulk'])
      expect(ok({ ...exportBuild, lane })).toBe(true);
    expect(ok({ ...exportBuild, created_at: 0 })).toBe(true);
  });

  it('reports an unsupported schema or type with the envelope that was read', () => {
    const base = { payloadId: 'qpl_export', messageJobId: 'lmj_export' };
    expect(parseLoggingMessageQueuePayload({ ...exportBuild, schema_version: 2 })).toStrictEqual({
      ok: false,
      reason: 'unsupported_schema',
      payloadType: 'export_build',
      schemaVersion: 2,
      ...base,
    });
    expect(parseLoggingMessageQueuePayload({ ...exportBuild, payload_type: 'nope' })).toMatchObject(
      {
        ok: false,
        reason: 'unsupported_schema',
        payloadType: 'nope',
        ...base,
      }
    );
    for (const payload_type of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(parseLoggingMessageQueuePayload({ ...exportBuild, payload_type })).toMatchObject({
        ok: false,
        reason: 'unsupported_schema',
        payloadType: payload_type,
      });
    }
  });
});

describe('retry_delivery', () => {
  it('needs each of its own fields, and names the envelope when one is missing', () => {
    for (const key of [
      'source_type',
      'source_id',
      'retry_id',
      'idempotency_key',
      'target_payload_hash',
      'requested_by',
      'replay_payload',
    ]) {
      const missing = { ...retry };
      delete missing[key];
      expect(parseLoggingMessageQueuePayload(missing)).toStrictEqual({
        ok: false,
        reason: 'malformed',
        payloadType: 'retry_delivery',
        schemaVersion: 1,
        payloadId: 'qpl_retry',
        messageJobId: 'lmj_retry',
      });
    }
    for (const key of [
      'source_id',
      'retry_id',
      'idempotency_key',
      'target_payload_hash',
      'requested_by',
    ]) {
      expect(ok({ ...retry, [key]: 5 })).toBe(false);
    }
  });

  it('accepts the three source types only', () => {
    for (const source_type of ['dlq_item', 'delivery_event', 'payload_object']) {
      expect(ok({ ...retry, source_type })).toBe(true);
    }
    expect(ok({ ...retry, source_type: 'other' })).toBe(false);
  });

  it('accepts an optional reason only as a string', () => {
    expect(ok({ ...retry, reason: 'because' })).toBe(true);
    expect(ok({ ...retry, reason: undefined })).toBe(true);
    for (const reason of [5, null, {}]) expect(ok({ ...retry, reason })).toBe(false);
  });

  it('needs a replay payload that itself parses as a delivery payload', () => {
    expect(ok({ ...retry, replay_payload: { ...replay, dlq_item_id: 5 } })).toBe(false);
    expect(ok({ ...retry, replay_payload: { ...replay, schema_version: 2 } })).toBe(false);
    expect(ok({ ...retry, replay_payload: null })).toBe(false);
    expect(ok({ ...retry, replay_payload: 'x' })).toBe(false);
  });
});

describe('export_build', () => {
  it('needs its job, phase, cutoff and requester', () => {
    for (const key of ['export_job_id', 'phase', 'snapshot_cutoff_at', 'requested_by']) {
      const missing = { ...exportBuild };
      delete missing[key];
      expect(parseLoggingMessageQueuePayload(missing)).toMatchObject({
        ok: false,
        reason: 'malformed',
        payloadType: 'export_build',
      });
    }
    for (const key of ['export_job_id', 'requested_by'])
      expect(ok({ ...exportBuild, [key]: 5 })).toBe(false);
  });

  it('accepts the five phases only', () => {
    for (const phase of ['plan', 'build_partition', 'finalize', 'verify_manifest', 'cleanup']) {
      expect(ok({ ...exportBuild, phase })).toBe(true);
    }
    expect(ok({ ...exportBuild, phase: 'other' })).toBe(false);
  });

  it('needs a finite numeric cutoff', () => {
    for (const snapshot_cutoff_at of [0, -1, 1.5])
      expect(ok({ ...exportBuild, snapshot_cutoff_at })).toBe(true);
    for (const snapshot_cutoff_at of ['5', Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(ok({ ...exportBuild, snapshot_cutoff_at })).toBe(false);
    }
  });

  it('accepts the four partition strategies, or none', () => {
    for (const partition_strategy of [
      undefined,
      'time_bucket_shard',
      'query_page',
      'chunk_index',
      'manifest_shard',
    ]) {
      expect(ok({ ...exportBuild, partition_strategy })).toBe(true);
    }
    for (const partition_strategy of ['other', 5, null]) {
      expect(ok({ ...exportBuild, partition_strategy })).toBe(false);
    }
  });

  it('accepts a partition key that is absent, null or a string', () => {
    for (const partition_key of [undefined, null, 'k', ''])
      expect(ok({ ...exportBuild, partition_key })).toBe(true);
    for (const partition_key of [5, {}]) expect(ok({ ...exportBuild, partition_key })).toBe(false);
  });

  it('bounds the optional counts from below', () => {
    const integer = (key: string, minimum: number) => {
      expect(ok({ ...exportBuild, [key]: undefined })).toBe(true);
      expect(ok({ ...exportBuild, [key]: minimum })).toBe(true);
      expect(ok({ ...exportBuild, [key]: minimum + 10 })).toBe(true);
      expect(ok({ ...exportBuild, [key]: minimum - 1 })).toBe(false);
      for (const bad of [minimum + 0.5, '5', null, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(ok({ ...exportBuild, [key]: bad })).toBe(false);
      }
    };
    integer('partition_index', 0);
    integer('partition_count', 1);
    integer('part_size', 1);
  });

  it('accepts the five cleanup reasons, or none', () => {
    for (const cleanup_reason of [
      undefined,
      'cancelled',
      'expired',
      'failed',
      'dangerous_repair',
      'manual',
    ]) {
      expect(ok({ ...exportBuild, cleanup_reason })).toBe(true);
    }
    for (const cleanup_reason of ['other', 5, null])
      expect(ok({ ...exportBuild, cleanup_reason })).toBe(false);
  });

  it('accepts cleanup object refs only as a list of strings', () => {
    for (const cleanup_object_refs of [undefined, [], ['a', 'b']]) {
      expect(ok({ ...exportBuild, cleanup_object_refs })).toBe(true);
    }
    for (const cleanup_object_refs of ['a', [1], ['a', 2], [null], {}, null]) {
      expect(ok({ ...exportBuild, cleanup_object_refs })).toBe(false);
    }
  });
});
