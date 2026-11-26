import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_LOGGING_DELIVERY_PAYLOAD_SCHEMAS,
  parseLoggingDeliveryQueuePayload,
  shouldDlqUnsupportedQueuePayload,
} from '../queue-payload';

const envelope = {
  schema_version: 1,
  payload_id: 'qpl_1',
  tenant_key: 't_1',
  lane: 'default',
  created_at: 1_700_000_000_000,
};

const valid: Record<string, Record<string, unknown>> = {
  chunk_write: {
    ...envelope,
    payload_type: 'chunk_write',
    log_type: 'audit',
    plane: 'archive',
    records: [{ a: 1 }],
  },
  delivery_fanout: {
    ...envelope,
    payload_type: 'delivery_fanout',
    catalog_id: 'cat_1',
    object_key: 'k/1',
    destination_id: 'dest_1',
    log_type: 'security',
    plane: 'external_sink',
    record_count: 3,
  },
  log_chunk_delivery: {
    ...envelope,
    payload_type: 'log_chunk_delivery',
    catalog_id: 'cat_1',
    object_key: 'k/1',
    destination_id: 'dest_1',
    log_type: 'pii',
    plane: 'sensitive_detail',
    record_count: 0,
  },
  http_sink_batch: {
    ...envelope,
    payload_type: 'http_sink_batch',
    destination_id: 'dest_1',
    endpoint_url: 'https://example.test/hook',
    log_type: 'normal',
    plane: 'primary',
    batch_id: 'batch_1',
    record_count: 2,
  },
  dlq_replay: {
    ...envelope,
    payload_type: 'dlq_replay',
    dlq_item_id: 'dlq_1',
    requested_by: 'admin_1',
  },
};

const required: Record<string, string[]> = {
  chunk_write: ['log_type', 'plane', 'records'],
  delivery_fanout: [
    'catalog_id',
    'object_key',
    'destination_id',
    'log_type',
    'plane',
    'record_count',
  ],
  log_chunk_delivery: [
    'catalog_id',
    'object_key',
    'destination_id',
    'log_type',
    'plane',
    'record_count',
  ],
  http_sink_batch: [
    'destination_id',
    'endpoint_url',
    'log_type',
    'plane',
    'batch_id',
    'record_count',
  ],
  dlq_replay: ['dlq_item_id', 'requested_by'],
};

const base = (payload: Record<string, unknown>) => ({
  payloadType: payload.payload_type,
  schemaVersion: 1,
  payloadId: 'qpl_1',
  tenantKey: 't_1',
  lane: 'default',
  createdAt: 1_700_000_000_000,
});

describe('parseLoggingDeliveryQueuePayload', () => {
  it('lists the supported schema versions of every payload type', () => {
    expect(SUPPORTED_LOGGING_DELIVERY_PAYLOAD_SCHEMAS).toStrictEqual({
      chunk_write: [1],
      delivery_fanout: [1],
      log_chunk_delivery: [1],
      http_sink_batch: [1],
      dlq_replay: [1],
    });
  });

  it('accepts a valid payload of every type and returns it as it is', () => {
    for (const payload of Object.values(valid)) {
      const result = parseLoggingDeliveryQueuePayload(payload);
      expect(result).toStrictEqual({ ok: true, payload });
      if (result.ok) expect(result.payload).toBe(payload);
    }
  });

  it('refuses what is not an object, with no detail', () => {
    for (const value of [null, undefined, 0, 'x', true, [], [valid.dlq_replay]]) {
      expect(parseLoggingDeliveryQueuePayload(value)).toStrictEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('refuses an envelope with a field missing or of the wrong kind', () => {
    const source = valid.dlq_replay;
    const wrong: Record<string, unknown[]> = {
      payload_type: [undefined, 5, null],
      schema_version: [undefined, '1', 1.5, Number.NaN, null],
      payload_id: [undefined, 5, null],
      tenant_key: [undefined, 5, null],
      lane: [undefined, 'urgent', 5, 'Default'],
      created_at: [undefined, '1', Number.NaN, Number.POSITIVE_INFINITY, null],
    };
    for (const [key, values] of Object.entries(wrong)) {
      for (const value of values) {
        expect(parseLoggingDeliveryQueuePayload({ ...source, [key]: value })).toStrictEqual({
          ok: false,
          reason: 'malformed',
        });
      }
    }
    for (const lane of ['critical', 'default', 'bulk']) {
      expect(parseLoggingDeliveryQueuePayload({ ...source, lane }).ok).toBe(true);
    }
    expect(parseLoggingDeliveryQueuePayload({ ...source, created_at: 0 }).ok).toBe(true);
    expect(parseLoggingDeliveryQueuePayload({ ...source, created_at: -5 }).ok).toBe(true);
  });

  it('refuses a payload whose own fields are missing or of the wrong kind, naming its envelope', () => {
    for (const [type, keys] of Object.entries(required)) {
      const source = valid[type];
      for (const key of keys) {
        const missing = { ...source };
        delete missing[key];
        expect(parseLoggingDeliveryQueuePayload(missing)).toStrictEqual({
          ok: false,
          reason: 'malformed',
          ...base(source),
        });
        expect(parseLoggingDeliveryQueuePayload({ ...source, [key]: { nested: true } }).ok).toBe(
          false
        );
      }
    }
  });

  it('checks the kind of each string, number and list field', () => {
    const wrongKind = (type: string, key: string, value: unknown): boolean =>
      parseLoggingDeliveryQueuePayload({ ...valid[type], [key]: value }).ok;
    expect(wrongKind('chunk_write', 'records', 'x')).toBe(false);
    expect(wrongKind('chunk_write', 'records', {})).toBe(false);
    expect(wrongKind('chunk_write', 'records', [])).toBe(true);
    expect(wrongKind('chunk_write', 'log_type', 5)).toBe(false);
    expect(wrongKind('chunk_write', 'plane', 5)).toBe(false);
    for (const type of ['delivery_fanout', 'log_chunk_delivery']) {
      for (const key of ['catalog_id', 'object_key', 'destination_id', 'log_type', 'plane']) {
        expect(wrongKind(type, key, 5)).toBe(false);
      }
      expect(wrongKind(type, 'record_count', '3')).toBe(false);
      expect(wrongKind(type, 'record_count', 0)).toBe(true);
    }
    for (const key of ['destination_id', 'endpoint_url', 'log_type', 'plane', 'batch_id']) {
      expect(wrongKind('http_sink_batch', key, 5)).toBe(false);
    }
    expect(wrongKind('http_sink_batch', 'record_count', '3')).toBe(false);
    expect(wrongKind('dlq_replay', 'dlq_item_id', 5)).toBe(false);
    expect(wrongKind('dlq_replay', 'requested_by', 5)).toBe(false);
  });

  it('accepts only known log types and planes', () => {
    const types = [
      'normal',
      'audit',
      'admin_audit',
      'security',
      'pii',
      'diagnostic',
      'job',
      'webhook',
      'operational',
    ];
    const planes = [
      'primary',
      'archive',
      'external_sink',
      'sensitive_detail',
      'diagnostic_detail',
      'delivery_event',
    ];
    for (const type of [
      'chunk_write',
      'delivery_fanout',
      'log_chunk_delivery',
      'http_sink_batch',
    ]) {
      for (const logType of types) {
        expect(parseLoggingDeliveryQueuePayload({ ...valid[type], log_type: logType }).ok).toBe(
          true
        );
      }
      for (const plane of planes) {
        expect(parseLoggingDeliveryQueuePayload({ ...valid[type], plane }).ok).toBe(true);
      }
      expect(parseLoggingDeliveryQueuePayload({ ...valid[type], log_type: 'unknown' }).ok).toBe(
        false
      );
      expect(parseLoggingDeliveryQueuePayload({ ...valid[type], plane: 'unknown' }).ok).toBe(false);
    }
  });

  it('accepts an optional object reference only as a string', () => {
    for (const [type, key] of [
      ['chunk_write', 'records_object_ref'],
      ['http_sink_batch', 'body_object_ref'],
    ] as const) {
      expect(parseLoggingDeliveryQueuePayload({ ...valid[type], [key]: 'obj/1' }).ok).toBe(true);
      expect(parseLoggingDeliveryQueuePayload({ ...valid[type], [key]: undefined }).ok).toBe(true);
      for (const bad of [5, null, {}, true]) {
        expect(parseLoggingDeliveryQueuePayload({ ...valid[type], [key]: bad }).ok).toBe(false);
      }
    }
  });

  it('reports a schema version or payload type it does not support, with its envelope', () => {
    const source = valid.dlq_replay;
    for (const schema_version of [2, 0, -1, 100]) {
      expect(parseLoggingDeliveryQueuePayload({ ...source, schema_version })).toStrictEqual({
        ok: false,
        reason: 'unsupported_schema',
        ...base(source),
        schemaVersion: schema_version,
      });
    }
    expect(parseLoggingDeliveryQueuePayload({ ...source, payload_type: 'nope' })).toMatchObject({
      ok: false,
      reason: 'unsupported_schema',
      payloadType: 'nope',
    });
  });

  it('treats the names of inherited object members as unsupported types, not as an error', () => {
    for (const payload_type of [
      'toString',
      'constructor',
      'hasOwnProperty',
      '__proto__',
      'valueOf',
    ]) {
      expect(
        parseLoggingDeliveryQueuePayload({
          ...valid.dlq_replay,
          payload_type,
        })
      ).toMatchObject({ ok: false, reason: 'unsupported_schema', payloadType: payload_type });
    }
  });

  it('puts only unsupported schemas in the dead-letter queue', () => {
    const source = valid.dlq_replay;
    expect(
      shouldDlqUnsupportedQueuePayload(
        parseLoggingDeliveryQueuePayload({ ...source, schema_version: 2 })
      )
    ).toBe(true);
    expect(
      shouldDlqUnsupportedQueuePayload(
        parseLoggingDeliveryQueuePayload({ ...source, dlq_item_id: 5 })
      )
    ).toBe(false);
    expect(shouldDlqUnsupportedQueuePayload(parseLoggingDeliveryQueuePayload(null))).toBe(false);
    expect(shouldDlqUnsupportedQueuePayload(parseLoggingDeliveryQueuePayload(source))).toBe(false);
  });
});
