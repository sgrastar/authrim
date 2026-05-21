import { describe, expect, it } from 'vitest';
import {
  buildLoggingMessagePayloadKey,
  buildLoggingMessageRedactedSummary,
  writeLoggingMessagePayloadToR2,
} from '../payload';

describe('logging message payload layout', () => {
  it('builds the configured R2 key layout', () => {
    const key = buildLoggingMessagePayloadKey({
      jobId: 'lmj_018bcfe5-6800-7000-8000-000000000000',
      payloadType: 'retry_delivery',
      lane: 'critical',
      criticality: 'critical',
      sourceType: 'dlq_item',
      tenantKey: 't_public',
      now: Date.UTC(2026, 4, 21, 3, 4, 5),
    });

    expect(key).toBe(
      [
        'message-jobs/retry_delivery',
        'criticality=critical',
        'lane=critical',
        'source_type=dlq_item',
        'tenant_key=t_public',
        'yyyy=2026',
        'mm=05',
        'dd=21',
        'hh=03',
        'lmj_018bcfe5-6800-7000-8000-000000000000.json',
      ].join('/')
    );
  });

  it('redacts sensitive fields and summarizes bulky values', () => {
    const summary = buildLoggingMessageRedactedSummary({
      payload_id: 'qpl_1',
      body: 'secret body',
      authorization: 'Bearer secret',
      records: [{ id: 1 }, { id: 2 }],
    });

    expect(summary).toMatchObject({
      authorization: '[redacted]',
      body: '[redacted]',
      payload_id: { type: 'string', length: 5 },
      records: { type: 'array', length: 2 },
    });
  });

  it('writes stable JSON payloads to R2 with checksum metadata', async () => {
    const writes: Array<{ key: string; value: string; metadata?: Record<string, string> }> = [];
    const result = await writeLoggingMessagePayloadToR2({
      bucket: {
        async put(key, value, options) {
          writes.push({ key, value, metadata: options?.customMetadata });
        },
      },
      jobId: 'lmj_1',
      payloadType: 'export_build',
      schemaVersion: 1,
      lane: 'bulk',
      criticality: 'standard',
      sourceType: 'payload_object',
      tenantKey: null,
      payload: { z: 1, a: 2, secret: 'hidden' },
      now: Date.UTC(2026, 4, 21, 0, 0, 0),
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe(result.objectRef);
    expect(writes[0].value).toBe('{"a":2,"secret":"hidden","z":1}');
    expect(writes[0].metadata).toMatchObject({
      payload_type: 'export_build',
      schema_version: '1',
      sha256: result.sha256,
      message_job_id: 'lmj_1',
    });
    expect(result.redactedSummary.secret).toBe('[redacted]');
    expect(result.validationSummary.byte_length).toBe(writes[0].value.length);
  });
});
