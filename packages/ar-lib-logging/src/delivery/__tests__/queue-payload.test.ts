import { describe, expect, it } from 'vitest';

import { parseLoggingDeliveryQueuePayload, shouldDlqUnsupportedQueuePayload } from '../index';

describe('logging delivery queue payload parser', () => {
  it('accepts supported chunk write payloads', () => {
    const result = parseLoggingDeliveryQueuePayload({
      payload_type: 'chunk_write',
      schema_version: 1,
      payload_id: 'payload_chunk_1',
      tenant_key: 'tk_123',
      lane: 'default',
      created_at: 1779148800000,
      log_type: 'operational',
      plane: 'archive',
      records: [{ id: 'evt_1', payload: { ok: true } }],
      records_object_ref: 'r2://payloads/records.json',
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        payload_type: 'chunk_write',
        schema_version: 1,
        log_type: 'operational',
        plane: 'archive',
      },
    });
  });

  it('accepts supported delivery fanout payloads', () => {
    const result = parseLoggingDeliveryQueuePayload({
      payload_type: 'delivery_fanout',
      schema_version: 1,
      payload_id: 'payload_1',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      catalog_id: 'cat_1',
      object_key: 'logs/tk_123/chunk.jsonl.gz',
      destination_id: 'dest_1',
      log_type: 'audit',
      plane: 'external_sink',
      record_count: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        payload_type: 'delivery_fanout',
        schema_version: 1,
      },
    });
  });

  it('accepts legacy log chunk delivery payloads', () => {
    const result = parseLoggingDeliveryQueuePayload({
      payload_type: 'log_chunk_delivery',
      schema_version: 1,
      payload_id: 'payload_1',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      catalog_id: 'cat_1',
      object_key: 'logs/tk_123/chunk.jsonl.gz',
      destination_id: 'dest_1',
      log_type: 'audit',
      plane: 'external_sink',
      record_count: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        payload_type: 'log_chunk_delivery',
        schema_version: 1,
      },
    });
  });

  it('accepts supported HTTP sink batch payloads', () => {
    const result = parseLoggingDeliveryQueuePayload({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'payload_2',
      tenant_key: 'tk_123',
      lane: 'default',
      created_at: 1779148800000,
      destination_id: 'dest_1',
      endpoint_url: 'https://collector.example/logs',
      log_type: 'webhook',
      plane: 'external_sink',
      batch_id: 'batch_1',
      record_count: 100,
      body_object_ref: 'r2://payloads/batch_1.jsonl.gz',
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        payload_type: 'http_sink_batch',
        schema_version: 1,
        log_type: 'webhook',
        plane: 'external_sink',
      },
    });
  });

  it('accepts supported DLQ replay payloads', () => {
    const result = parseLoggingDeliveryQueuePayload({
      payload_type: 'dlq_replay',
      schema_version: 1,
      payload_id: 'payload_dlq_replay_1',
      tenant_key: 'tk_123',
      lane: 'critical',
      created_at: 1779148800000,
      dlq_item_id: 'dlq_1',
      requested_by: 'admin-1',
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        payload_type: 'dlq_replay',
        schema_version: 1,
        dlq_item_id: 'dlq_1',
        requested_by: 'admin-1',
      },
    });
  });

  it('accepts supported rewrap chunk payloads', () => {
    const result = parseLoggingDeliveryQueuePayload({
      payload_type: 'rewrap_chunk',
      schema_version: 1,
      payload_id: 'payload_rewrap_1',
      tenant_key: 'tk_123',
      lane: 'bulk',
      created_at: 1779148800000,
      rewrap_job_id: 'lrw_1',
      object_catalog_id: 'obj_1',
    });

    expect(result).toMatchObject({
      ok: true,
      payload: {
        payload_type: 'rewrap_chunk',
        schema_version: 1,
        rewrap_job_id: 'lrw_1',
        object_catalog_id: 'obj_1',
      },
    });
  });

  it('rejects malformed payloads without DLQ schema handling', () => {
    const result = parseLoggingDeliveryQueuePayload({
      payload_type: 'http_sink_batch',
      schema_version: 1,
      payload_id: 'payload_2',
      tenant_key: 'tk_123',
      lane: 'default',
      created_at: 1779148800000,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'malformed',
      payloadType: 'http_sink_batch',
      schemaVersion: 1,
      payloadId: 'payload_2',
      tenantKey: 'tk_123',
      lane: 'default',
      createdAt: 1779148800000,
    });
    expect(shouldDlqUnsupportedQueuePayload(result)).toBe(false);
  });

  it('marks unsupported schema versions for DLQ instead of transient retry', () => {
    const result = parseLoggingDeliveryQueuePayload({
      payload_type: 'http_sink_batch',
      schema_version: 99,
      payload_id: 'payload_2',
      tenant_key: 'tk_123',
      lane: 'default',
      created_at: 1779148800000,
    });

    expect(result).toEqual({
      ok: false,
      reason: 'unsupported_schema',
      payloadType: 'http_sink_batch',
      schemaVersion: 99,
      payloadId: 'payload_2',
      tenantKey: 'tk_123',
      lane: 'default',
      createdAt: 1779148800000,
    });
    expect(shouldDlqUnsupportedQueuePayload(result)).toBe(true);
  });
});
