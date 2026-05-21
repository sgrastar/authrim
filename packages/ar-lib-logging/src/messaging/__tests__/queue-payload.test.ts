import { describe, expect, it } from 'vitest';
import { parseLoggingMessageQueuePayload } from '../queue-payload';

describe('logging message queue payload parser', () => {
  it('accepts retry_delivery payloads', () => {
    const result = parseLoggingMessageQueuePayload({
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
      replay_payload: {
        payload_type: 'dlq_replay',
        schema_version: 1,
        payload_id: 'qpl_replay',
        tenant_key: 't_1',
        lane: 'default',
        created_at: 1,
        dlq_item_id: 'dlq_1',
        requested_by: 'admin_1',
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.payload_type).toBe('retry_delivery');
    }
  });

  it('accepts export_build payloads', () => {
    const result = parseLoggingMessageQueuePayload({
      payload_type: 'export_build',
      schema_version: 1,
      payload_id: 'qpl_export',
      message_job_id: 'lmj_export',
      lane: 'bulk',
      created_at: 1,
      export_job_id: 'lexp_1',
      phase: 'plan',
      snapshot_cutoff_at: 1,
      requested_by: 'admin_1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.payload_type).toBe('export_build');
    }
  });

  it('accepts export_build partition and cleanup payload metadata', () => {
    expect(
      parseLoggingMessageQueuePayload({
        payload_type: 'export_build',
        schema_version: 1,
        payload_id: 'qpl_partition',
        message_job_id: 'lmj_partition',
        lane: 'bulk',
        created_at: 1,
        export_job_id: 'lexp_1',
        phase: 'build_partition',
        partition_strategy: 'query_page',
        partition_key: 'query_page:1',
        partition_index: 1,
        partition_count: 3,
        part_size: 1000,
        snapshot_cutoff_at: 1,
        requested_by: 'admin_1',
      })
    ).toMatchObject({ ok: true });

    expect(
      parseLoggingMessageQueuePayload({
        payload_type: 'export_build',
        schema_version: 1,
        payload_id: 'qpl_cleanup',
        message_job_id: 'lmj_cleanup',
        lane: 'bulk',
        created_at: 1,
        export_job_id: 'lexp_1',
        phase: 'cleanup',
        cleanup_reason: 'cancelled',
        cleanup_object_refs: ['logging-exports/v1/lexp_1/manifest.json'],
        snapshot_cutoff_at: 1,
        requested_by: 'admin_1',
      })
    ).toMatchObject({ ok: true });
  });

  it('rejects malformed export_build partition metadata', () => {
    expect(
      parseLoggingMessageQueuePayload({
        payload_type: 'export_build',
        schema_version: 1,
        payload_id: 'qpl_bad_partition',
        message_job_id: 'lmj_bad_partition',
        lane: 'bulk',
        created_at: 1,
        export_job_id: 'lexp_1',
        phase: 'build_partition',
        partition_index: -1,
        snapshot_cutoff_at: 1,
        requested_by: 'admin_1',
      })
    ).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('separates unsupported schemas from malformed payloads', () => {
    expect(
      parseLoggingMessageQueuePayload({
        payload_type: 'retry_delivery',
        schema_version: 99,
        payload_id: 'qpl_retry',
        message_job_id: 'lmj_retry',
        lane: 'default',
        created_at: 1,
      })
    ).toMatchObject({ ok: false, reason: 'unsupported_schema' });

    expect(parseLoggingMessageQueuePayload({ payload_type: 'retry_delivery' })).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });
});
