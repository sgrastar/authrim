import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mockAdapter = vi.hoisted(() => {
  const adapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  };
  adapter.transaction.mockImplementation(async (callback) => callback(adapter));
  return adapter;
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => mockAdapter),
  };
});

import { processLoggingStorageMaintenanceJobs } from '../logging-storage-maintenance-jobs';

function messageJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lmj_job',
    kind: 'retry_delivery',
    status: 'queued',
    lane: 'default',
    criticality: 'standard',
    priority: 0,
    tenant_id: null,
    tenant_key: 't_message',
    topology_type: 'shared_d1',
    database_binding_ref: null,
    connection_ref: null,
    topology_snapshot_version: null,
    topology_resolved_at: 1000,
    scope_type: 'tenant',
    scope_id: 't_message',
    scope_key: 'tenant:t_message',
    source_type: 'dlq_item',
    source_id: 'dlq_1',
    root_job_id: null,
    parent_job_id: null,
    depth: 0,
    payload_object_ref: 'message-jobs/retry_delivery/job.json',
    payload_sha256: 'sha256',
    payload_type: 'retry_delivery',
    payload_schema_version: 1,
    redacted_summary_json: null,
    validation_summary_json: null,
    idempotency_key: 'retry',
    dedupe_until: 2000,
    not_before: 1000,
    attempt_count: 0,
    max_attempts: 5,
    attempt_policy_json: JSON.stringify({ maxAttempts: 5, leaseTimeoutMs: 300000 }),
    claim_token: null,
    claimed_at: null,
    claimed_until: null,
    requested_by: 'admin-1',
    reason: null,
    error_class: null,
    last_error: null,
    blocked_reason: null,
    cancel_requested_at: null,
    cancelled_by: null,
    created_at: 1000,
    updated_at: 1000,
    started_at: null,
    completed_at: null,
    expires_at: null,
    ...overrides,
  };
}

describe('logging/storage maintenance jobs', () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.query.mockResolvedValue([]);
    mockAdapter.queryOne.mockResolvedValue(null);
    mockAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  });

  it('runs scheduled destination health checks and enqueues failure notifications', async () => {
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [
          {
            id: 'dest_1',
            scope_type: 'platform',
            scope_id: 'global',
            destination_kind: 'object_storage',
            provider: 'r2',
            name: 'archive',
            lifecycle_status: 'active',
            health_status: 'configured',
            provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE' }),
            last_health_check_at: null,
          },
        ];
      }
      return [];
    });

    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);

    expect(result.healthChecks).toEqual({ checked: 1, failed: 1 });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_destination_health_events'),
      expect.arrayContaining(['dest_1', 'quick', 'configured', 'unreachable', 'failure'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE admin_destinations'),
      expect.arrayContaining(['unreachable', 'dest_1'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining(['logging.destination.health.unreachable', 'high'])
    );
    expect(log.info).toHaveBeenCalledWith(
      'Logging/storage maintenance completed',
      expect.objectContaining({
        healthChecks: { checked: 1, failed: 1 },
      })
    );
  });

  it('uses policy retention windows for delivery events, aggregates, and closed DLQ items', async () => {
    const now = 1_779_148_800_000;
    const dayMs = 24 * 60 * 60 * 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_delivery_events')) {
        return [{ id: 'lde_old_success' }, { id: 'lde_old_retry' }];
      }
      if (sql.includes('FROM logging_dlq_items')) {
        return [{ id: 'dlq_closed' }];
      }
      return [];
    });
    mockAdapter.execute.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('DELETE FROM logging_delivery_event_aggregates')) {
        return { rowsAffected: 3 };
      }
      if (sql.includes('DELETE FROM logging_delivery_events')) {
        return { rowsAffected: params.length };
      }
      if (sql.includes('DELETE FROM logging_dlq_items')) {
        return { rowsAffected: params.length };
      }
      return { rowsAffected: 1 };
    });

    try {
      const result = await processLoggingStorageMaintenanceJobs({} as Env, log);

      expect(result.retention).toEqual({
        deliveryEventsDeleted: 2,
        deliveryAggregatesDeleted: 3,
        dlqItemsPurged: 1,
      });
      expect(mockAdapter.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM logging_delivery_events'),
        [
          now - 7 * dayMs,
          now - 30 * dayMs,
          now - 180 * dayMs,
          now - 90 * dayMs,
          now - 30 * dayMs,
          500,
        ]
      );
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM logging_delivery_event_aggregates'),
        [now - 7 * dayMs, now - 30 * dayMs, now - 180 * dayMs, now - 90 * dayMs, now - 30 * dayMs]
      );
      expect(mockAdapter.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM logging_dlq_items'),
        [now - 180 * dayMs, now - 90 * dayMs, 500]
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('runs deep scheduled R2 health probes for stale healthy destinations', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const head = vi.fn().mockResolvedValue({ size: 33 });
    const deleteObject = vi.fn().mockResolvedValue(undefined);
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [
          {
            id: 'dest_deep',
            scope_type: 'platform',
            scope_id: 'global',
            destination_kind: 'object_storage',
            provider: 'r2',
            name: 'archive',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({ bindingRef: 'AUDIT_ARCHIVE', prefix: 'audit' }),
            last_health_check_at: Date.now() - 25 * 60 * 60 * 1000,
          },
        ];
      }
      return [];
    });

    const result = await processLoggingStorageMaintenanceJobs(
      {
        AUDIT_ARCHIVE: {
          put,
          head,
          delete: deleteObject,
        },
      } as unknown as Env,
      log
    );

    expect(result.healthChecks).toEqual({ checked: 1, failed: 0 });
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('audit/health/dest_deep-'),
      'authrim destination health check'
    );
    expect(head).toHaveBeenCalledWith(expect.stringContaining('audit/health/dest_deep-'));
    expect(deleteObject).toHaveBeenCalledWith(expect.stringContaining('audit/health/dest_deep-'));
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_destination_health_events'),
      expect.arrayContaining(['dest_deep', 'deep', 'healthy', 'healthy', 'success'])
    );
  });

  it('applies safe catalog repair findings during scheduled maintenance', async () => {
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [];
      }
      if (sql.includes("object_kind = 'chunk'")) {
        return [];
      }
      if (sql.includes('FROM log_object_catalog')) {
        return [
          {
            id: 'chk_1',
            tenant_key: 't_safe',
            log_type: 'audit',
            plane: 'archive',
            object_key: 'logs/v1/t_safe/archive/audit/chunk.jsonl',
            status: 'pending',
            record_count: 1,
            byte_count: 100,
            checksum_sha256: 'sha256:test',
            created_at: 1,
            committed_at: null,
          },
        ];
      }
      if (sql.includes('FROM log_chunk_manifests')) {
        return [];
      }
      return [];
    });

    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);

    expect(result.catalogRepair).toEqual({ findings: 1, applied: 1, skipped: 0 });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'orphan_candidate'"),
      ['chk_1']
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'deleted'"),
      ['chk_1']
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining(['chk_1'])
    );
  });

  it('publishes scheduled chunk manifests for committed catalog rows', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [];
      }
      if (sql.includes("object_kind = 'chunk'")) {
        return [
          {
            id: 'chk_1',
            tenant_key: 't_manifest',
            log_type: 'audit',
            plane: 'archive',
            object_key: 'logs/v1/t_manifest/archive/audit/chunk-1.jsonl',
            record_count: 2,
            byte_count: 200,
            checksum_sha256: 'sha256:chunk',
            committed_at: Date.now() - 2 * 60 * 60 * 1000,
          },
        ];
      }
      if (sql.includes('FROM log_object_catalog')) {
        return [];
      }
      if (sql.includes('FROM log_chunk_manifests')) {
        return [];
      }
      return [];
    });

    const result = await processLoggingStorageMaintenanceJobs(
      {
        AUDIT_ARCHIVE: { put },
      } as unknown as Env,
      log
    );

    expect(result.manifests).toEqual({ published: 1, skipped: 0 });
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('logs/t_manifest/archive/audit/manifests/'),
      expect.any(Uint8Array),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/json' },
      })
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE log_chunk_manifests'),
      expect.arrayContaining(['t_manifest', 'audit', 'archive'])
    );
  });

  it('claims retry_delivery message jobs and dispatches replay payloads', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const jobRow = {
      id: 'lmj_retry',
      kind: 'retry_delivery',
      status: 'queued',
      lane: 'default',
      criticality: 'standard',
      priority: 10,
      tenant_id: null,
      tenant_key: 't_retry',
      topology_type: 'shared_d1',
      database_binding_ref: null,
      connection_ref: null,
      topology_snapshot_version: null,
      topology_resolved_at: now,
      scope_type: 'tenant',
      scope_id: 't_retry',
      scope_key: 'tenant:t_retry',
      source_type: 'dlq_item',
      source_id: 'dlq_1',
      root_job_id: null,
      parent_job_id: null,
      depth: 0,
      payload_object_ref: 'message-jobs/retry_delivery/job.json',
      payload_sha256: 'sha256',
      payload_type: 'retry_delivery',
      payload_schema_version: 1,
      redacted_summary_json: null,
      validation_summary_json: null,
      idempotency_key: 'retry',
      dedupe_until: now + 1000,
      not_before: now,
      attempt_count: 0,
      max_attempts: 5,
      attempt_policy_json: JSON.stringify({ maxAttempts: 5, leaseTimeoutMs: 300000 }),
      claim_token: null,
      claimed_at: null,
      claimed_until: null,
      requested_by: 'admin-1',
      reason: null,
      error_class: null,
      last_error: null,
      blocked_reason: null,
      cancel_requested_at: null,
      cancelled_by: null,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
      expires_at: null,
    };
    let dueReturned = false;
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('claimed_until IS NOT NULL') || sql.includes('expires_at IS NOT NULL')) {
        return [];
      }
      if (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?')) {
        if (dueReturned) {
          return [];
        }
        dueReturned = true;
        return [jobRow];
      }
      return [];
    });
    let claimToken = '';
    mockAdapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('claim_token = ?') && sql.includes('claimed_at = ?')) {
        claimToken = String(params[1]);
      }
      return { rowsAffected: 1 };
    });
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_message_jobs')) {
        return {
          ...jobRow,
          status: 'claimed',
          attempt_count: 1,
          claim_token: claimToken,
          claimed_at: now,
          claimed_until: now + 5 * 60 * 1000,
          started_at: now,
        };
      }
      return null;
    });
    const deliverySend = vi.fn().mockResolvedValue(undefined);
    const payloadGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'retry_delivery',
          schema_version: 1,
          payload_id: 'qpl_retry',
          message_job_id: 'lmj_retry',
          tenant_key: 't_retry',
          lane: 'default',
          created_at: now,
          source_type: 'dlq_item',
          source_id: 'dlq_1',
          retry_id: 'lmj_retry',
          idempotency_key: 'retry',
          target_payload_hash: 'hash',
          requested_by: 'admin-1',
          replay_payload: {
            payload_type: 'delivery_fanout',
            schema_version: 1,
            payload_id: 'qpl_delivery',
            tenant_key: 't_retry',
            lane: 'default',
            created_at: now,
            catalog_id: 'chk_1',
            object_key: 'logs/chunk.jsonl',
            destination_id: 'dest_1',
            log_type: 'audit',
            plane: 'archive',
            record_count: 1,
          },
        })
      ),
    });

    const result = await processLoggingStorageMaintenanceJobs(
      {
        DIAGNOSTIC_LOGS: { get: payloadGet },
        LOGGING_DELIVERY_QUEUE: { send: deliverySend },
      } as unknown as Env,
      log
    );

    expect(result.messageJobs).toMatchObject({ claimed: 1, completed: 1, retrying: 0 });
    expect(payloadGet).toHaveBeenCalledWith('message-jobs/retry_delivery/job.json');
    expect(deliverySend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'delivery_fanout',
        catalog_id: 'chk_1',
      })
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET status = ?, completed_at = ?'),
      expect.arrayContaining(['completed', now, now, 'lmj_retry'])
    );
    vi.useRealTimers();
  });

  it('safe-repairs expired and stuck logging message jobs during scheduled maintenance', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [];
      }
      if (sql.includes("object_kind = 'chunk'")) {
        return [];
      }
      if (sql.includes('FROM log_object_catalog')) {
        return [];
      }
      if (sql.includes('FROM log_chunk_manifests')) {
        return [];
      }
      if (sql.includes('expires_at IS NOT NULL')) {
        return [
          messageJobRow({
            id: 'lmj_expired',
            status: 'retrying',
            expires_at: now - 1000,
            updated_at: now - 2000,
          }),
        ];
      }
      if (sql.includes('claimed_until IS NOT NULL')) {
        return [
          messageJobRow({
            id: 'lmj_stuck',
            status: 'running',
            claim_token: 'claim_stuck',
            claimed_at: now - 10 * 60 * 1000,
            claimed_until: now - 5 * 60 * 1000,
            attempt_count: 1,
            updated_at: now - 10 * 60 * 1000,
          }),
        ];
      }
      if (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?')) {
        return [];
      }
      return [];
    });

    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);

    expect(result.messageJobs).toMatchObject({
      repaired: 2,
      expired: 1,
      retrying: 1,
    });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET status = ?, last_error = ?, completed_at = ?'),
      expect.arrayContaining(['expired', expect.any(String), now, now, 'lmj_expired'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET status = ?, not_before = ?'),
      expect.arrayContaining(['retrying', expect.any(Number), 'claim_lease_timeout'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_message_repair_findings'),
      expect.arrayContaining(['lmj_expired', 'expired_retrying', 'warning', 'safe_repaired'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_message_repair_findings'),
      expect.arrayContaining(['lmj_stuck', 'stuck_claim', 'warning', 'safe_repaired'])
    );
    vi.useRealTimers();
  });

  it('builds queued export_build message jobs into R2 part artifacts and manifests', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const exportJobRow = messageJobRow({
      id: 'lmj_export',
      kind: 'export_build',
      lane: 'default',
      source_type: 'payload_object',
      source_id: 'lexp_1',
      payload_object_ref: 'message-jobs/export_build/job.json',
      payload_type: 'export_build',
      payload_schema_version: 1,
      idempotency_key: 'export:lexp_1',
    });
    let dueReturned = false;
    let claimToken = '';
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('claimed_until IS NOT NULL') || sql.includes('expires_at IS NOT NULL')) {
        return [];
      }
      if (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?')) {
        if (dueReturned) {
          return [];
        }
        dueReturned = true;
        return [exportJobRow];
      }
      if (sql.includes('FROM log_object_catalog')) {
        return [
          {
            id: 'obj_1',
            tenant_key: 't_message',
            log_type: 'audit',
            plane: 'archive',
            surface: null,
            object_key: 'logs/chunk.jsonl',
            object_kind: 'chunk',
            status: 'committed',
            record_count: 2,
            byte_count: 200,
            checksum_sha256: 'sha256:chunk',
            created_at: now - 5000,
            committed_at: now - 4000,
          },
        ];
      }
      return [];
    });
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_message_jobs')) {
        return {
          ...exportJobRow,
          status: 'claimed',
          attempt_count: 1,
          claim_token: claimToken,
          claimed_at: now,
          claimed_until: now + 5 * 60 * 1000,
          started_at: now,
        };
      }
      if (sql.includes('FROM logging_export_jobs')) {
        return {
          id: 'lexp_1',
          format: 'jsonl',
          status: 'queued',
          expires_at: now + 7 * 24 * 60 * 60 * 1000,
        };
      }
      return null;
    });
    mockAdapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('claim_token = ?') && sql.includes('claimed_at = ?')) {
        claimToken = String(params[1]);
      }
      return { rowsAffected: 1 };
    });
    const payloadGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'export_build',
          schema_version: 1,
          payload_id: 'qpl_export',
          message_job_id: 'lmj_export',
          tenant_key: 't_message',
          lane: 'default',
          created_at: now,
          export_job_id: 'lexp_1',
          phase: 'plan',
          partition_strategy: 'time_bucket_shard',
          snapshot_cutoff_at: now,
          requested_by: 'admin-1',
          filters: {
            tenant_key: 't_message',
            log_type: 'audit',
            plane: 'archive',
            source: 'catalog',
            time_start: null,
            time_end: null,
            limit: 100,
            include_payload: false,
          },
        })
      ),
    });
    const artifactPut = vi.fn().mockResolvedValue(undefined);

    const result = await processLoggingStorageMaintenanceJobs(
      {
        DIAGNOSTIC_LOGS: { get: payloadGet },
        EXPORT_ARTIFACTS: { put: artifactPut },
      } as unknown as Env,
      log
    );

    expect(result.messageJobs).toMatchObject({ claimed: 1, completed: 1 });
    expect(artifactPut).toHaveBeenCalledWith(
      'logging-exports/v1/lexp_1/parts/part-00000.jsonl',
      expect.stringContaining('"id":"obj_1"'),
      expect.objectContaining({ httpMetadata: { contentType: 'application/x-ndjson' } })
    );
    expect(artifactPut).toHaveBeenCalledWith(
      'logging-exports/v1/lexp_1/manifest.json',
      expect.stringContaining('"snapshot_cutoff_at"'),
      expect.objectContaining({ httpMetadata: { contentType: 'application/json' } })
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_export_jobs'),
      expect.arrayContaining([
        'completed',
        'logging-exports/v1/lexp_1/parts/part-00000.jsonl',
        'logging-exports/v1/lexp_1/manifest.json',
      ])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_message_export_builds'),
      expect.arrayContaining(['verify_manifest', 1])
    );
    vi.useRealTimers();
  });

  it('splits large export_build plans into partition and finalize message jobs', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const exportJobRow = messageJobRow({
      id: 'lmj_export_plan',
      kind: 'export_build',
      lane: 'bulk',
      source_type: 'payload_object',
      source_id: 'lexp_large',
      payload_object_ref: 'message-jobs/export_build/large-plan.json',
      payload_type: 'export_build',
      payload_schema_version: 1,
      idempotency_key: 'export:lexp_large',
    });
    let dueReturned = false;
    let claimToken = '';
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('claimed_until IS NOT NULL') || sql.includes('expires_at IS NOT NULL')) {
        return [];
      }
      if (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?')) {
        if (dueReturned) {
          return [];
        }
        dueReturned = true;
        return [exportJobRow];
      }
      return [];
    });
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_message_jobs')) {
        return {
          ...exportJobRow,
          status: 'claimed',
          attempt_count: 1,
          claim_token: claimToken,
          claimed_at: now,
          claimed_until: now + 5 * 60 * 1000,
          started_at: now,
        };
      }
      if (sql.includes('FROM logging_export_jobs')) {
        return {
          id: 'lexp_large',
          format: 'jsonl',
          status: 'queued',
          expires_at: now + 7 * 24 * 60 * 60 * 1000,
        };
      }
      return null;
    });
    mockAdapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('claim_token = ?') && sql.includes('claimed_at = ?')) {
        claimToken = String(params[1]);
      }
      return { rowsAffected: 1 };
    });
    const payloadGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'export_build',
          schema_version: 1,
          payload_id: 'qpl_export_large',
          message_job_id: 'lmj_export_plan',
          tenant_key: 't_message',
          lane: 'bulk',
          created_at: now,
          export_job_id: 'lexp_large',
          phase: 'plan',
          partition_strategy: 'query_page',
          snapshot_cutoff_at: now,
          requested_by: 'admin-1',
          filters: {
            tenant_key: 't_message',
            log_type: 'audit',
            plane: 'archive',
            source: 'record_index',
            time_start: null,
            time_end: null,
            limit: 2500,
            include_payload: false,
          },
        })
      ),
    });
    const payloadPut = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);

    const result = await processLoggingStorageMaintenanceJobs(
      {
        DIAGNOSTIC_LOGS: { get: payloadGet, put: payloadPut },
        EXPORT_ARTIFACTS: { put: vi.fn() },
        LOGGING_MESSAGE_BULK_QUEUE: { send },
      } as unknown as Env,
      log
    );

    expect(result.messageJobs).toMatchObject({ claimed: 1, completed: 1 });
    expect(payloadPut).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'export_build',
        phase: 'build_partition',
        partition_index: 0,
        partition_count: 3,
      })
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'export_build',
        phase: 'finalize',
        partition_index: 3,
        partition_count: 3,
      })
    );
    const exportBuildRows = mockAdapter.execute.mock.calls.filter(
      ([sql]) =>
        typeof sql === 'string' && sql.includes('INSERT INTO logging_message_export_builds')
    );
    expect(exportBuildRows).toHaveLength(4);
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET partition_count = ?, metadata_json = ?, updated_at = ?'),
      expect.arrayContaining([3, expect.any(String), now, 'lmj_export_plan', 'lexp_large'])
    );
    vi.useRealTimers();
  });

  it('includes record_index payload expansion errors in export_build artifacts', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const exportJobRow = messageJobRow({
      id: 'lmj_export_record',
      kind: 'export_build',
      lane: 'bulk',
      source_type: 'payload_object',
      source_id: 'lexp_record',
      payload_object_ref: 'message-jobs/export_build/record.json',
      payload_type: 'export_build',
      payload_schema_version: 1,
      idempotency_key: 'export:lexp_record',
    });
    let dueReturned = false;
    let claimToken = '';
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('claimed_until IS NOT NULL') || sql.includes('expires_at IS NOT NULL')) {
        return [];
      }
      if (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?')) {
        if (dueReturned) {
          return [];
        }
        dueReturned = true;
        return [exportJobRow];
      }
      if (sql.includes('FROM log_chunk_record_index')) {
        return [
          {
            record_id: 'rec_1',
            tenant_key: 't_message',
            log_type: 'audit',
            plane: 'archive',
            surface: null,
            object_catalog_id: 'obj_1',
            chunk_id: 'chk_1',
            object_key: 'logs/missing-chunk.jsonl',
            object_kind: 'chunk',
            compression: 'none',
            encryption_scope: null,
            key_version: null,
            line_number: 1,
            block_offset: null,
            block_length: null,
            record_offset: 0,
            record_length: 20,
            event_at: now - 1000,
            index_profile: 'standard',
            indexed_fields: JSON.stringify({ action: 'test' }),
            status: 'committed',
            created_at: now - 900,
          },
        ];
      }
      return [];
    });
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_message_jobs')) {
        return {
          ...exportJobRow,
          status: 'claimed',
          attempt_count: 1,
          claim_token: claimToken,
          claimed_at: now,
          claimed_until: now + 5 * 60 * 1000,
          started_at: now,
        };
      }
      if (sql.includes('FROM logging_export_jobs')) {
        return {
          id: 'lexp_record',
          format: 'jsonl',
          status: 'queued',
          expires_at: now + 7 * 24 * 60 * 60 * 1000,
        };
      }
      return null;
    });
    mockAdapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('claim_token = ?') && sql.includes('claimed_at = ?')) {
        claimToken = String(params[1]);
      }
      return { rowsAffected: 1 };
    });
    const payloadGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'export_build',
          schema_version: 1,
          payload_id: 'qpl_export_record',
          message_job_id: 'lmj_export_record',
          tenant_key: 't_message',
          lane: 'bulk',
          created_at: now,
          export_job_id: 'lexp_record',
          phase: 'plan',
          partition_strategy: 'query_page',
          snapshot_cutoff_at: now,
          requested_by: 'admin-1',
          filters: {
            tenant_key: 't_message',
            log_type: 'audit',
            plane: 'archive',
            source: 'record_index',
            time_start: null,
            time_end: null,
            limit: 100,
            include_payload: true,
          },
        })
      ),
    });
    const artifactPut = vi.fn().mockResolvedValue(undefined);
    const chunkGet = vi.fn().mockResolvedValue(null);

    const result = await processLoggingStorageMaintenanceJobs(
      {
        DIAGNOSTIC_LOGS: { get: payloadGet },
        AUDIT_ARCHIVE: { get: chunkGet },
        EXPORT_ARTIFACTS: { put: artifactPut },
      } as unknown as Env,
      log
    );

    expect(result.messageJobs).toMatchObject({ claimed: 1, completed: 1 });
    expect(chunkGet).toHaveBeenCalledWith('logs/missing-chunk.jsonl');
    expect(artifactPut).toHaveBeenCalledWith(
      'logging-exports/v1/lexp_record/parts/part-00000.jsonl',
      expect.stringContaining('"record_payload_error":"object_not_found"'),
      expect.any(Object)
    );
    vi.useRealTimers();
  });

  it('rejects oversized record_index chunk objects without buffering export payloads', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const exportJobRow = messageJobRow({
      id: 'lmj_export_oversized_chunk',
      kind: 'export_build',
      lane: 'bulk',
      source_type: 'payload_object',
      source_id: 'lexp_oversized_chunk',
      payload_object_ref: 'message-jobs/export_build/oversized-chunk.json',
      payload_type: 'export_build',
      payload_schema_version: 1,
      idempotency_key: 'export:lexp_oversized_chunk',
    });
    let dueReturned = false;
    let claimToken = '';
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('claimed_until IS NOT NULL') || sql.includes('expires_at IS NOT NULL')) {
        return [];
      }
      if (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?')) {
        if (dueReturned) {
          return [];
        }
        dueReturned = true;
        return [exportJobRow];
      }
      if (sql.includes('FROM log_chunk_record_index')) {
        return [
          {
            record_id: 'rec_oversized',
            tenant_key: 't_message',
            log_type: 'audit',
            plane: 'archive',
            surface: null,
            object_catalog_id: 'obj_oversized',
            chunk_id: 'chk_oversized',
            object_key: 'logs/oversized-chunk.jsonl',
            object_kind: 'chunk',
            object_byte_count: null,
            compression: 'none',
            encryption_scope: null,
            key_version: null,
            line_number: 1,
            block_offset: null,
            block_length: null,
            record_offset: 0,
            record_length: 20,
            event_at: now - 1000,
            index_profile: 'standard',
            indexed_fields: JSON.stringify({ action: 'test' }),
            status: 'committed',
            created_at: now - 900,
          },
        ];
      }
      return [];
    });
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_message_jobs')) {
        return {
          ...exportJobRow,
          status: 'claimed',
          attempt_count: 1,
          claim_token: claimToken,
          claimed_at: now,
          claimed_until: now + 5 * 60 * 1000,
          started_at: now,
        };
      }
      if (sql.includes('FROM logging_export_jobs')) {
        return {
          id: 'lexp_oversized_chunk',
          format: 'jsonl',
          status: 'queued',
          expires_at: now + 7 * 24 * 60 * 60 * 1000,
        };
      }
      return null;
    });
    mockAdapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('claim_token = ?') && sql.includes('claimed_at = ?')) {
        claimToken = String(params[1]);
      }
      return { rowsAffected: 1 };
    });
    const payloadGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'export_build',
          schema_version: 1,
          payload_id: 'qpl_export_oversized_chunk',
          message_job_id: 'lmj_export_oversized_chunk',
          tenant_key: 't_message',
          lane: 'bulk',
          created_at: now,
          export_job_id: 'lexp_oversized_chunk',
          phase: 'plan',
          partition_strategy: 'query_page',
          snapshot_cutoff_at: now,
          requested_by: 'admin-1',
          filters: {
            tenant_key: 't_message',
            log_type: 'audit',
            plane: 'archive',
            source: 'record_index',
            time_start: null,
            time_end: null,
            limit: 100,
            include_payload: true,
          },
        })
      ),
    });
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const chunkGet = vi.fn().mockResolvedValue({
      size: 65 * 1024 * 1024,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
      arrayBuffer,
    });
    const artifactPut = vi.fn().mockResolvedValue(undefined);

    const result = await processLoggingStorageMaintenanceJobs(
      {
        DIAGNOSTIC_LOGS: { get: payloadGet },
        AUDIT_ARCHIVE: { get: chunkGet },
        EXPORT_ARTIFACTS: { put: artifactPut },
      } as unknown as Env,
      log
    );

    expect(result.messageJobs).toMatchObject({ claimed: 1, completed: 1 });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(artifactPut).toHaveBeenCalledWith(
      'logging-exports/v1/lexp_oversized_chunk/parts/part-00000.jsonl',
      expect.stringContaining('"record_payload_error":"logging_export_chunk_object_too_large"'),
      expect.any(Object)
    );
    vi.useRealTimers();
  });

  it('detects missing export part artifacts as message repair findings', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [];
      }
      if (sql.includes("object_kind = 'chunk'")) {
        return [];
      }
      if (sql.includes('FROM log_object_catalog')) {
        return [];
      }
      if (sql.includes('FROM log_chunk_manifests')) {
        return [];
      }
      if (sql.includes('FROM logging_message_export_builds')) {
        return [
          {
            message_job_id: 'lmj_export_missing',
            export_job_id: 'lexp_missing',
            part_object_ref: 'logging-exports/v1/lexp_missing/parts/part-00000.jsonl',
            phase: 'verify_manifest',
            tenant_key: 't_message',
            kind: 'export_build',
            status: 'completed',
            criticality: 'standard',
            lane: 'default',
          },
        ];
      }
      if (
        sql.includes('claimed_until IS NOT NULL') ||
        sql.includes('expires_at IS NOT NULL') ||
        (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?'))
      ) {
        return [];
      }
      return [];
    });
    const head = vi.fn().mockResolvedValue(null);

    const result = await processLoggingStorageMaintenanceJobs(
      {
        EXPORT_ARTIFACTS: { head },
      } as unknown as Env,
      log
    );

    expect(result.messageJobs.repairFindings).toBe(1);
    expect(head).toHaveBeenCalledWith('logging-exports/v1/lexp_missing/parts/part-00000.jsonl');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_message_repair_findings'),
      expect.arrayContaining([
        'lmj_export_missing',
        'missing_export_part',
        'error',
        'open',
        'rebuild_export_partition',
      ])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_export_jobs'),
      expect.arrayContaining(['retrying', 'missing_export_part', now, 'lexp_missing'])
    );
    vi.useRealTimers();
  });

  it('cleans queued export artifacts during scheduled maintenance', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [];
      }
      if (sql.includes("object_kind = 'chunk'")) {
        return [];
      }
      if (sql.includes('FROM log_object_catalog')) {
        return [];
      }
      if (sql.includes('FROM log_chunk_manifests')) {
        return [];
      }
      if (sql.includes('cleanup_status = ?')) {
        return [
          {
            message_job_id: 'lmj_cancelled_export',
            export_job_id: 'lexp_cancelled',
            part_object_ref: 'logging-exports/v1/lexp_cancelled/parts/part-00000.jsonl',
            manifest_object_ref: 'logging-exports/v1/lexp_cancelled/manifest.json',
          },
        ];
      }
      if (
        sql.includes('claimed_until IS NOT NULL') ||
        sql.includes('expires_at IS NOT NULL') ||
        sql.includes('FROM logging_message_export_builds') ||
        (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?'))
      ) {
        return [];
      }
      return [];
    });
    const deleteObject = vi.fn().mockResolvedValue(undefined);

    const result = await processLoggingStorageMaintenanceJobs(
      {
        EXPORT_ARTIFACTS: { delete: deleteObject },
      } as unknown as Env,
      log
    );

    expect(result.messageJobs.repaired).toBe(1);
    expect(deleteObject).toHaveBeenCalledWith(
      'logging-exports/v1/lexp_cancelled/parts/part-00000.jsonl'
    );
    expect(deleteObject).toHaveBeenCalledWith('logging-exports/v1/lexp_cancelled/manifest.json');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_message_export_builds'),
      expect.arrayContaining(['completed', now, 'lexp_cancelled', 'queued'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_export_jobs'),
      expect.arrayContaining([now, 'lexp_cancelled'])
    );
    vi.useRealTimers();
  });

  it('runs export_build cleanup payload jobs for cancelled exports', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const cleanupJobRow = messageJobRow({
      id: 'lmj_export_cleanup',
      kind: 'export_build',
      lane: 'bulk',
      source_type: 'payload_object',
      source_id: 'lexp_cleanup',
      payload_object_ref: 'message-jobs/export_build/cleanup.json',
      payload_type: 'export_build',
      payload_schema_version: 1,
      idempotency_key: 'export-cleanup:lexp_cleanup',
    });
    let dueReturned = false;
    let claimToken = '';
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [];
      }
      if (sql.includes("object_kind = 'chunk'")) {
        return [];
      }
      if (sql.includes('FROM log_object_catalog')) {
        return [];
      }
      if (sql.includes('FROM log_chunk_manifests')) {
        return [];
      }
      if (sql.includes('cleanup_status = ?')) {
        return [];
      }
      if (sql.includes('claimed_until IS NOT NULL') || sql.includes('expires_at IS NOT NULL')) {
        return [];
      }
      if (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?')) {
        if (dueReturned) {
          return [];
        }
        dueReturned = true;
        return [cleanupJobRow];
      }
      if (sql.includes('FROM logging_message_export_builds')) {
        return [
          {
            part_object_ref: 'logging-exports/v1/lexp_cleanup/parts/part-00000.jsonl',
            manifest_object_ref: 'logging-exports/v1/lexp_cleanup/manifest.json',
            export_artifact_object_ref: null,
            export_manifest_object_ref: 'logging-exports/v1/lexp_cleanup/manifest.json',
          },
        ];
      }
      return [];
    });
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_message_jobs')) {
        return {
          ...cleanupJobRow,
          status: 'claimed',
          attempt_count: 1,
          claim_token: claimToken,
          claimed_at: now,
          claimed_until: now + 5 * 60 * 1000,
          started_at: now,
        };
      }
      if (sql.includes('FROM logging_export_jobs')) {
        return {
          id: 'lexp_cleanup',
          format: 'jsonl',
          status: 'cancelled',
          expires_at: now + 7 * 24 * 60 * 60 * 1000,
        };
      }
      return null;
    });
    mockAdapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('claim_token = ?') && sql.includes('claimed_at = ?')) {
        claimToken = String(params[1]);
      }
      return { rowsAffected: 1 };
    });
    const payloadGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'export_build',
          schema_version: 1,
          payload_id: 'qpl_cleanup',
          message_job_id: 'lmj_export_cleanup',
          tenant_key: 't_message',
          lane: 'bulk',
          created_at: now,
          export_job_id: 'lexp_cleanup',
          phase: 'cleanup',
          cleanup_reason: 'cancelled',
          snapshot_cutoff_at: now,
          requested_by: 'admin-1',
        })
      ),
    });
    const deleteObject = vi.fn().mockResolvedValue(undefined);

    const result = await processLoggingStorageMaintenanceJobs(
      {
        DIAGNOSTIC_LOGS: { get: payloadGet },
        EXPORT_ARTIFACTS: { delete: deleteObject },
      } as unknown as Env,
      log
    );

    expect(result.messageJobs).toMatchObject({ claimed: 1, completed: 1 });
    expect(deleteObject).toHaveBeenCalledWith(
      'logging-exports/v1/lexp_cleanup/parts/part-00000.jsonl'
    );
    expect(deleteObject).toHaveBeenCalledWith('logging-exports/v1/lexp_cleanup/manifest.json');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET cleanup_status = ?, metadata_json = ?, updated_at = ?'),
      expect.arrayContaining(['completed', expect.any(String), now, 'lexp_cleanup'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET artifact_object_ref = NULL, manifest_object_ref = NULL'),
      expect.arrayContaining([now, 'lexp_cleanup'])
    );
    vi.useRealTimers();
  });

  it('verifies export manifests before marking partitioned exports completed', async () => {
    const now = 1_779_321_600_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const verifyJobRow = messageJobRow({
      id: 'lmj_export_verify',
      kind: 'export_build',
      lane: 'bulk',
      source_type: 'payload_object',
      source_id: 'lexp_verify',
      payload_object_ref: 'message-jobs/export_build/verify.json',
      payload_type: 'export_build',
      payload_schema_version: 1,
      idempotency_key: 'export-verify:lexp_verify',
    });
    let dueReturned = false;
    let claimToken = '';
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [];
      }
      if (sql.includes("object_kind = 'chunk'")) {
        return [];
      }
      if (sql.includes('FROM log_object_catalog')) {
        return [];
      }
      if (sql.includes('FROM log_chunk_manifests')) {
        return [];
      }
      if (sql.includes('FROM logging_message_export_builds') || sql.includes('cleanup_status = ?')) {
        return [];
      }
      if (sql.includes('claimed_until IS NOT NULL') || sql.includes('expires_at IS NOT NULL')) {
        return [];
      }
      if (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?')) {
        if (dueReturned) {
          return [];
        }
        dueReturned = true;
        return [verifyJobRow];
      }
      return [];
    });
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM logging_message_jobs')) {
        return {
          ...verifyJobRow,
          status: 'claimed',
          attempt_count: 1,
          claim_token: claimToken,
          claimed_at: now,
          claimed_until: now + 5 * 60 * 1000,
          started_at: now,
        };
      }
      if (sql.includes('FROM logging_export_jobs')) {
        return {
          id: 'lexp_verify',
          format: 'jsonl',
          status: 'running',
          artifact_object_ref: null,
          manifest_object_ref: 'logging-exports/v1/lexp_verify/manifest.json',
          checksum_sha256: 'sha256:manifest',
          record_count: 2,
          byte_count: 40,
          expires_at: now + 7 * 24 * 60 * 60 * 1000,
        };
      }
      return null;
    });
    mockAdapter.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('claim_token = ?') && sql.includes('claimed_at = ?')) {
        claimToken = String(params[1]);
      }
      return { rowsAffected: 1 };
    });
    const payloadGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          payload_type: 'export_build',
          schema_version: 1,
          payload_id: 'qpl_verify',
          message_job_id: 'lmj_export_verify',
          tenant_key: 't_message',
          lane: 'bulk',
          created_at: now,
          export_job_id: 'lexp_verify',
          phase: 'verify_manifest',
          partition_count: 2,
          snapshot_cutoff_at: now,
          requested_by: 'admin-1',
          filters: {
            tenant_key: 't_message',
            log_type: 'audit',
            plane: 'archive',
            source: 'record_index',
            time_start: null,
            time_end: null,
            limit: 2000,
            include_payload: false,
          },
        })
      ),
    });
    const exportGet = vi.fn().mockResolvedValue({
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          checksum_sha256: 'sha256:manifest',
          record_count: 2,
          byte_count: 40,
          parts: [
            {
              object_ref: 'logging-exports/v1/lexp_verify/parts/part-00000.jsonl',
              record_count: 1,
              byte_count: 20,
            },
            {
              object_ref: 'logging-exports/v1/lexp_verify/parts/part-00001.jsonl',
              record_count: 1,
              byte_count: 20,
            },
          ],
        })
      ),
    });
    const head = vi.fn().mockResolvedValue({ size: 20 });

    const result = await processLoggingStorageMaintenanceJobs(
      {
        DIAGNOSTIC_LOGS: { get: payloadGet },
        EXPORT_ARTIFACTS: { get: exportGet, head },
      } as unknown as Env,
      log
    );

    expect(result.messageJobs).toMatchObject({ claimed: 1, completed: 1 });
    expect(head).toHaveBeenCalledWith('logging-exports/v1/lexp_verify/parts/part-00000.jsonl');
    expect(head).toHaveBeenCalledWith('logging-exports/v1/lexp_verify/parts/part-00001.jsonl');
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET status = ?, checksum_sha256 = ?, record_count = ?, byte_count = ?'),
      expect.arrayContaining(['completed', 'sha256:manifest', 2, 40, now, now, 'lexp_verify'])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE logging_delivery_event_aggregates'),
      expect.arrayContaining(['t_message', 'export_artifact', 'audit', 'archive', 'bulk', 'delivered'])
    );
    vi.useRealTimers();
  });

  it('enqueues a manifest publish failure notification when the archive bucket is unavailable', async () => {
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [];
      }
      if (sql.includes("object_kind = 'chunk'")) {
        return [
          {
            id: 'chk_missing_bucket',
            tenant_key: 't_manifest_missing_bucket',
            log_type: 'audit',
            plane: 'archive',
            object_key: 'logs/v1/t_manifest_missing_bucket/archive/audit/chunk-1.jsonl',
            record_count: 2,
            byte_count: 200,
            checksum_sha256: 'sha256:chunk',
            committed_at: Date.now() - 2 * 60 * 60 * 1000,
          },
        ];
      }
      if (sql.includes('FROM log_object_catalog')) {
        return [];
      }
      if (sql.includes('FROM log_chunk_manifests')) {
        return [];
      }
      return [];
    });

    const result = await processLoggingStorageMaintenanceJobs({} as Env, log);

    expect(result.manifests).toEqual({ published: 0, skipped: 1 });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining([
        't_manifest_missing_bucket',
        'logging_delivery_failure',
        'logging.manifest.publish.failed',
        'medium',
      ])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.arrayContaining([
        expect.stringContaining('logging_manifest_publish_failed:t_manifest_missing_bucket'),
        expect.stringContaining('manifest_bucket_unavailable'),
      ])
    );
  });

  it('creates and dispatches queued rewrap jobs for stale committed chunks', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockAdapter.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_destinations')) {
        return [];
      }
      if (sql.includes('FROM logging_key_registry')) {
        return [
          {
            key_registry_id: 'lkr_1',
            tenant_key: 't_rewrap',
            surface: null,
            log_type: 'admin_audit',
            plane: 'archive',
            active_version: 2,
            from_version: 1,
            key_version_status: 'rewrap_required',
            object_catalog_id: 'loc_1',
            object_key: 'logs/v1/t_rewrap/archive/admin_audit/chunk-1.jsonl',
            record_count: 3,
            committed_at: Date.now() - 60_000,
          },
        ];
      }
      if (sql.includes('FROM logging_rewrap_jobs')) {
        return [];
      }
      if (sql.includes("object_kind = 'chunk'")) {
        return [];
      }
      if (sql.includes('FROM log_object_catalog')) {
        return [];
      }
      if (sql.includes('FROM log_chunk_manifests')) {
        return [];
      }
      return [];
    });

    const result = await processLoggingStorageMaintenanceJobs(
      {
        LOGGING_DELIVERY_BULK_QUEUE: { send },
      } as unknown as Env,
      log
    );

    expect(result.rewrap).toEqual({
      candidates: 1,
      jobsCreated: 1,
      dispatched: 1,
      queueUnavailable: 0,
      skipped: 0,
    });
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_rewrap_jobs'),
      expect.arrayContaining(['lkr_1', 1, 2, 20, 'queued'])
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'rewrap_chunk',
        schema_version: 1,
        tenant_key: 't_rewrap',
        lane: 'bulk',
        rewrap_job_id: expect.stringMatching(/^lrw_/),
        object_catalog_id: 'loc_1',
      })
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'running'"),
      expect.arrayContaining([expect.stringMatching(/^lrw_/)])
    );
    expect(mockAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.arrayContaining(['t_rewrap', expect.stringMatching(/^rewrap:lrw_/), 'admin_audit'])
    );
  });

  it('refreshes usage aggregates and evaluates quota during scheduled maintenance', async () => {
    const now = 1_779_325_200_000;
    const hourStart = 1_779_325_200_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockAdapter.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM admin_destinations')) {
        return [];
      }
      if (sql.includes("object_kind = 'chunk'")) {
        return [];
      }
      if (sql.includes('FROM log_chunk_manifests')) {
        return [];
      }
      if (sql.includes('FROM logging_key_registry')) {
        return [];
      }
      if (sql.includes('FROM logging_message_jobs') && sql.includes('not_before <= ?')) {
        return [];
      }
      if (sql.includes('FROM logging_delivery_event_aggregates') && sql.includes('SUM(record_count)')) {
        return params?.[0] === hourStart
          ? [
              {
                tenant_key: 't_usage',
                log_type: 'diagnostic',
                plane: 'external_sink',
                lane: 'bulk',
                record_count: 12,
                byte_count: 240,
                batch_count: 1,
              },
            ]
          : [];
      }
      if (sql.includes('FROM log_object_catalog') && sql.includes('COUNT(*) AS object_count')) {
        return [];
      }
      if (sql.includes('FROM logging_dlq_items') && sql.includes('COUNT(*) AS item_count')) {
        return [];
      }
      if (sql.includes('FROM sensitive_detail_chunk_index')) {
        return [];
      }
      if (sql.includes('FROM logging_message_jobs') && sql.includes('COUNT(*) AS job_count')) {
        return [];
      }
      if (sql.includes('FROM logging_quota_policies')) {
        return [
          {
            id: 'lqp_usage',
            scope_type: 'tenant',
            scope_id: 'tenant-1',
            log_type: 'diagnostic',
            plane: 'external_sink',
            lane: 'bulk',
            metric_name: 'delivery_records',
            window_kind: 'hour',
            soft_limit: 10,
            hard_limit: 20,
            warning_ratio: 0.8,
            enforcement_mode: 'soft_limit',
          },
        ];
      }
      if (sql.includes('FROM logging_delivery_events')) {
        return [];
      }
      if (sql.includes('FROM logging_dlq_items')) {
        return [];
      }
      return [];
    });
    let notificationLookupCount = 0;
    mockAdapter.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT tenant_key FROM tenants')) {
        return { tenant_key: 't_usage' };
      }
      if (sql.includes('SELECT SUM(value) AS value')) {
        return { value: 12 };
      }
      if (sql.includes('FROM internal_notification_events')) {
        notificationLookupCount += 1;
        if (notificationLookupCount === 1) {
          return null;
        }
        return {
          id: 'notification-1',
          tenant_id: 'tenant-1',
          category: 'logging_quota_warning',
          event_type: 'logging.quota.soft_exceeded',
          severity: 'medium',
          status: 'pending',
          deduplication_key: 'quota',
          payload_json: '{}',
          attempts: 0,
          last_error: null,
          next_attempt_at: null,
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
          delivered_at: null,
        };
      }
      return null;
    });

    try {
      const result = await processLoggingStorageMaintenanceJobs({} as Env, log);

      expect(result.usage).toEqual({
        windowsRefreshed: 2,
        aggregatesRefreshed: 3,
        quotaPoliciesEvaluated: 1,
        quotaWarnings: 1,
        quotaActions: 1,
      });
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO logging_usage_aggregates'),
        expect.arrayContaining([
          null,
          't_usage',
          'diagnostic',
          'external_sink',
          'bulk',
          'delivery_records',
          'hour',
          hourStart,
          12,
        ])
      );
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO logging_quota_evaluations'),
        expect.arrayContaining([
          'lqp_usage',
          'tenant-1',
          't_usage',
          'diagnostic',
          'external_sink',
          'bulk',
          'delivery_records',
          'hour',
          hourStart,
          12,
          10,
          20,
          'soft_exceeded',
          'throttle_non_critical',
        ])
      );
      expect(mockAdapter.execute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO internal_notification_events'),
        expect.arrayContaining([
          'tenant-1',
          'logging_quota_warning',
          'logging.quota.soft_exceeded',
          'medium',
        ])
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
