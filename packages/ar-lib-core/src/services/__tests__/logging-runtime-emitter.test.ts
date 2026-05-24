import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeLoggingPolicySnapshot,
  publishRuntimeLoggingPolicySnapshot,
} from '@authrim/ar-lib-logging/policies';
import { emitRuntimeLogRecords } from '../logging-runtime-emitter';

function createSnapshotStores() {
  const kvValues = new Map<string, string>();
  const objectValues = new Map<string, Uint8Array>();
  const objectWrites: Array<{ key: string; options?: R2PutOptions }> = [];
  const kv = {
    get: vi.fn(async (key: string) => kvValues.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      kvValues.set(key, value);
    }),
  } as unknown as KVNamespace;
  const bucket = {
    put: vi.fn(
      async (
        key: string,
        value: ArrayBuffer | ArrayBufferView | string,
        options?: R2PutOptions
      ) => {
        const bytes =
          typeof value === 'string'
            ? new TextEncoder().encode(value)
            : value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : value instanceof Uint8Array
                ? value
                : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        objectValues.set(key, bytes);
        objectWrites.push({ key, options });
      }
    ),
    get: vi.fn(async (key: string) =>
      objectValues.has(key)
        ? {
            text: vi.fn(async () => new TextDecoder().decode(objectValues.get(key))),
          }
        : null
    ),
  } as unknown as R2Bucket;
  return { kv, bucket, objectValues, objectWrites };
}

function createMockAdapter() {
  const adapter = {
    execute: vi.fn(async () => ({ rowsAffected: 1 })),
    batch: vi.fn(async (statements: Array<{ sql: string; params: unknown[] }>) => {
      for (const statement of statements) {
        await adapter.execute(statement.sql, statement.params);
      }
      return statements.map(() => ({ rowsAffected: 1 }));
    }),
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(adapter)),
    isHealthy: vi.fn(async () => true),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => {}),
  };
  return adapter;
}

function findDeliveryEventMetadata(adapter: ReturnType<typeof createMockAdapter>) {
  const call = adapter.execute.mock.calls.find(([sql]) =>
    String(sql).includes('INSERT INTO logging_delivery_events')
  );
  const params = call?.[1] as unknown[] | undefined;
  return params?.[13] ? JSON.parse(String(params[13])) : null;
}

async function decodeFirstChunkRecord(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const body =
    typeof DecompressionStream === 'undefined'
      ? bytes
      : new Uint8Array(
          await new Response(
            new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
          ).arrayBuffer()
        );
  return JSON.parse(new TextDecoder().decode(body).split('\n')[0]) as Record<string, unknown>;
}

describe('runtime log emitter', () => {
  it('writes normal, job, webhook, and operational archive chunks with stable R2 layout and metadata', async () => {
    const tenantId = 'tenant-runtime-contract';
    const tenantKey = 't_runtime_contract';
    const { kv, bucket, objectValues, objectWrites } = createSnapshotStores();
    const logTypes = ['normal', 'job', 'webhook', 'operational'] as const;
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: tenantId,
      version: 1,
      snapshotId: 'snap_runtime_output_contract',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: logTypes.map((logType) => ({
          id: `lpa_${logType}_archive`,
          tenant_id: tenantId,
          log_type: logType,
          plane: 'archive',
          destination_id: 'dest_runtime_archive',
          enabled: 1,
          managed_by: 'tenant',
          lane: 'default',
          version: 1,
        })),
        fallbacks: [],
        destinations: [
          {
            id: 'dest_runtime_archive',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'object_storage',
            provider: 'r2',
            name: 'runtime-archive',
            display_name: 'Runtime Archive',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({
              bindingRef: 'AUDIT_ARCHIVE',
              prefix: 'runtime-contract',
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(logTypes),
            allowed_planes: JSON.stringify(['archive']),
            region: null,
            critical_allowed: 0,
            default_fallback_eligible: 1,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
        ],
      },
    });
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv,
      objectStore: bucket,
      now: 1_700_000_000_000,
    });
    vi.mocked(bucket.put).mockClear();
    objectWrites.length = 0;

    const deliveryAdapter = createMockAdapter();
    const indexAdapter = createMockAdapter();
    const queue = { send: vi.fn(async () => {}) };

    for (const logType of logTypes) {
      await emitRuntimeLogRecords({
        env: {
          DB_ADMIN: deliveryAdapter as never,
          LOGGING_INDEX_DB: indexAdapter as never,
          AUTHRIM_CONFIG: kv,
          DIAGNOSTIC_LOGS: bucket,
          AUDIT_ARCHIVE: bucket,
          LOGGING_DELIVERY_QUEUE: queue as never,
        },
        tenantId,
        logType,
        surface: `${logType}_surface`,
        tenantKeyResolver: async () => tenantKey,
        records: [
          {
            id: `${logType}-1`,
            eventAt: 1_700_000_000_000,
            payload: { log_type: logType, status: 'stored' },
            indexedFields: { status: 'stored' },
          },
        ],
        planes: ['archive'],
      });
    }

    expect(objectWrites).toHaveLength(logTypes.length);
    for (const logType of logTypes) {
      const write = objectWrites.find((item) => item.key.includes(`/archive/${logType}/`));
      const objectKeyPattern = new RegExp(
        [
          `^runtime-contract/${tenantKey}/archive/${logType}/`,
          String.raw`\d{4}/\d{2}/\d{2}/\d{2}/shard-\d\d/chk_[^/]+\.jsonl\.gz$`,
        ].join(''),
        'u'
      );
      expect(write?.key).toMatch(objectKeyPattern);
      expect(write?.options?.httpMetadata).toMatchObject({
        contentType: 'application/x-ndjson',
        contentEncoding: 'gzip',
      });
      expect(write?.options?.customMetadata).toMatchObject({
        tenantKey,
        logType,
        plane: 'archive',
        recordCount: '1',
        compression: 'gzip_block',
      });
    }
    expect(queue.send).toHaveBeenCalledTimes(logTypes.length);

    const normalKey = [...objectValues.keys()].find((key) => key.includes('/archive/normal/'));
    expect(normalKey).toBeTruthy();
    const normalRecord = await decodeFirstChunkRecord(objectValues.get(normalKey!)!);
    expect(normalRecord).toMatchObject({
      schema_version: 'authrim.log.archive.v1',
      record_type: 'log_record',
      tenant_key: tenantKey,
      log_type: 'normal',
      plane: 'archive',
      surface: 'normal_surface',
      summary: { log_type: 'normal', status: 'stored' },
      delivery: {
        target_type: 'r2',
        destination_id: 'dest_runtime_archive',
      },
    });
  });

  it('writes operational archive chunks and enqueues chunk delivery from runtime policy', async () => {
    const tenantId = 'tenant-runtime-op';
    const { kv, bucket, objectValues } = createSnapshotStores();
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: tenantId,
      version: 1,
      snapshotId: 'snap_runtime_op_archive',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_operational_archive',
            tenant_id: tenantId,
            log_type: 'operational',
            plane: 'archive',
            destination_id: 'dest_ops_archive',
            enabled: 1,
            managed_by: 'tenant',
            lane: 'default',
            version: 1,
          },
        ],
        fallbacks: [],
        destinations: [
          {
            id: 'dest_ops_archive',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'object_storage',
            provider: 'r2',
            name: 'ops-archive',
            display_name: 'Operational Archive',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({
              bindingRef: 'AUDIT_ARCHIVE',
              prefix: 'ops-chunks',
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['operational']),
            allowed_planes: JSON.stringify(['archive']),
            region: null,
            critical_allowed: 0,
            default_fallback_eligible: 1,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
        ],
      },
    });
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv,
      objectStore: bucket,
      now: 1_700_000_000_000,
    });
    vi.mocked(kv.get).mockClear();
    vi.mocked(bucket.get).mockClear();
    vi.mocked(bucket.put).mockClear();

    const deliveryAdapter = createMockAdapter();
    const indexAdapter = createMockAdapter();
    const queue = { send: vi.fn(async () => {}) };
    const result = await emitRuntimeLogRecords({
      env: {
        DB_ADMIN: deliveryAdapter as never,
        LOGGING_INDEX_DB: indexAdapter as never,
        AUTHRIM_CONFIG: kv,
        DIAGNOSTIC_LOGS: bucket,
        AUDIT_ARCHIVE: bucket,
        LOGGING_DELIVERY_QUEUE: queue as never,
      },
      tenantId,
      logType: 'operational',
      surface: 'operational_log',
      tenantKeyResolver: async () => 't_registry_ops',
      records: [
        {
          id: 'op-1',
          eventAt: 1_700_000_000_000,
          payload: { action: 'user.lock', status: 'stored' },
          indexedFields: {
            surface: 'operational_log',
            eventType: 'user.lock',
            severity: 'info',
            status: 'stored',
          },
        },
      ],
      planes: ['archive'],
    });

    expect(result.tenantKey).toBe('t_registry_ops');
    expect(result.targetResults[0]).toMatchObject({
      plane: 'archive',
      destinationId: 'dest_ops_archive',
      status: 'queued',
      queued: true,
    });
    expect([...objectValues.keys()].some((key) => key.includes('ops-chunks/'))).toBe(true);
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'delivery_fanout',
        destination_id: 'dest_ops_archive',
        log_type: 'operational',
        plane: 'archive',
      })
    );
    expect(indexAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO log_object_catalog'),
      expect.any(Array)
    );
    expect(deliveryAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.any(Array)
    );
  });

  it('stores webhook HTTP sink batches and enqueues delivery payloads', async () => {
    const tenantId = 'tenant-runtime-webhook';
    const { kv, bucket, objectValues } = createSnapshotStores();
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: tenantId,
      version: 1,
      snapshotId: 'snap_runtime_webhook_http',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_webhook_sink',
            tenant_id: tenantId,
            log_type: 'webhook',
            plane: 'external_sink',
            destination_id: 'dest_webhook_http',
            enabled: 1,
            managed_by: 'tenant',
            lane: 'default',
            version: 1,
          },
        ],
        fallbacks: [],
        destinations: [
          {
            id: 'dest_webhook_http',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'http_sink',
            provider: 'http',
            name: 'webhook-sink',
            display_name: 'Webhook Sink',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({
              url: 'https://collector.example/logs',
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['webhook']),
            allowed_planes: JSON.stringify(['external_sink']),
            region: null,
            critical_allowed: 0,
            default_fallback_eligible: 0,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
        ],
      },
    });
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv,
      objectStore: bucket,
      now: 1_700_000_000_000,
    });
    vi.mocked(bucket.put).mockClear();

    const adapter = createMockAdapter();
    const queue = { send: vi.fn(async () => {}) };
    const result = await emitRuntimeLogRecords({
      env: {
        DB_ADMIN: adapter as never,
        AUTHRIM_CONFIG: kv,
        DIAGNOSTIC_LOGS: bucket,
        AUDIT_ARCHIVE: bucket,
        LOGGING_DELIVERY_QUEUE: queue as never,
      },
      tenantId,
      logType: 'webhook',
      surface: 'webhook_delivery',
      tenantKeyResolver: async () => 't_registry_webhook/../../raw',
      records: [
        {
          id: 'delivery-1',
          eventAt: 1_700_000_000_000,
          payload: { webhook_id: 'wh-1', event_type: 'user.created', status: 'success' },
          indexedFields: {
            webhookId: 'wh-1',
            eventType: 'user.created',
            status: 'success',
            httpStatus: 200,
            attempt: 1,
          },
        },
      ],
      planes: ['external_sink'],
    });

    expect(result.targetResults[0]).toMatchObject({
      plane: 'external_sink',
      destinationId: 'dest_webhook_http',
      status: 'queued',
      queued: true,
    });
    const payloadObjectKey = [...objectValues.keys()].find((key) =>
      key.includes('logging-delivery-payloads/v1/t_registry_webhook_.._.._raw/')
    );
    expect(payloadObjectKey).toBeTruthy();
    expect(payloadObjectKey).toMatch(
      /^logging-delivery-payloads\/v1\/t_registry_webhook_.._.._raw\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/qpl_[^/]+\.json$/
    );
    expect(payloadObjectKey).not.toContain('[object Object]');
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'http_sink_batch',
        destination_id: 'dest_webhook_http',
        endpoint_url: 'https://collector.example/logs',
        record_count: 1,
      })
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.any(Array)
    );
  });

  it('fails closed for critical logs when no runtime destination can be resolved', async () => {
    const adapter = createMockAdapter();

    await expect(
      emitRuntimeLogRecords({
        env: {
          DB_ADMIN: adapter as never,
        },
        tenantId: 'tenant-critical-missing',
        logType: 'admin_audit',
        surface: 'admin_audit',
        tenantKeyResolver: async () => 't_registry_critical_missing',
        records: [
          {
            id: 'admin-audit-1',
            eventAt: 1_700_000_000_000,
            payload: { action: 'logging.critical.update', status: 'attempted' },
          },
        ],
        planes: ['archive'],
      })
    ).rejects.toThrow('runtime_log_critical_target_not_configured');

    const deliveryInsert = adapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO logging_delivery_events')
    );
    expect(deliveryInsert?.[1]).toEqual(
      expect.arrayContaining([
        't_registry_critical_missing',
        null,
        'admin_audit',
        'archive',
        'critical',
        'retrying',
      ])
    );
    expect(findDeliveryEventMetadata(adapter)).toMatchObject({
      error: 'runtime_log_critical_target_not_configured',
      fallback_used: false,
    });
  });

  it('records platform fallback metadata when the selected destination is unusable', async () => {
    const tenantId = 'tenant-runtime-fallback';
    const { kv, bucket } = createSnapshotStores();
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: tenantId,
      version: 1,
      snapshotId: 'snap_runtime_webhook_fallback',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_webhook_sink_failing',
            tenant_id: tenantId,
            log_type: 'webhook',
            plane: 'external_sink',
            destination_id: 'dest_webhook_failing',
            enabled: 1,
            managed_by: 'tenant',
            lane: 'default',
            version: 1,
          },
        ],
        fallbacks: [
          {
            id: 'lfp_webhook_platform',
            scope_type: 'platform',
            scope_id: 'global',
            log_type: 'webhook',
            plane: 'external_sink',
            fallback_destination_id: 'dest_webhook_platform',
            failure_mode: 'platform_default',
            version: 1,
          },
        ],
        destinations: [
          {
            id: 'dest_webhook_failing',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'http_sink',
            provider: 'http',
            name: 'webhook-failing',
            display_name: 'Webhook Failing',
            lifecycle_status: 'active',
            health_status: 'failing',
            provider_config: JSON.stringify({
              url: 'https://failing.example/logs',
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['webhook']),
            allowed_planes: JSON.stringify(['external_sink']),
            region: null,
            critical_allowed: 0,
            default_fallback_eligible: 0,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
          {
            id: 'dest_webhook_platform',
            scope_type: 'platform',
            scope_id: null,
            destination_kind: 'http_sink',
            provider: 'http',
            name: 'webhook-platform',
            display_name: 'Webhook Platform',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({
              url: 'https://platform.example/logs',
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['webhook']),
            allowed_planes: JSON.stringify(['external_sink']),
            region: null,
            critical_allowed: 0,
            default_fallback_eligible: 1,
            retention_days: 30,
            encryption_mode: 'platform_managed',
          },
        ],
      },
    });
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv,
      objectStore: bucket,
      now: 1_700_000_000_000,
    });

    const adapter = createMockAdapter();
    const queue = { send: vi.fn(async () => {}) };
    const result = await emitRuntimeLogRecords({
      env: {
        DB_ADMIN: adapter as never,
        AUTHRIM_CONFIG: kv,
        DIAGNOSTIC_LOGS: bucket,
        AUDIT_ARCHIVE: bucket,
        LOGGING_DELIVERY_QUEUE: queue as never,
      },
      tenantId,
      logType: 'webhook',
      surface: 'webhook_delivery',
      tenantKeyResolver: async () => 't_registry_fallback',
      records: [
        {
          id: 'delivery-fallback-1',
          eventAt: 1_700_000_000_000,
          payload: { webhook_id: 'wh-1', event_type: 'user.updated', status: 'success' },
        },
      ],
      planes: ['external_sink'],
    });

    expect(result.targetResults[0]).toMatchObject({
      destinationId: 'dest_webhook_platform',
      status: 'queued',
    });
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        destination_id: 'dest_webhook_platform',
        endpoint_url: 'https://platform.example/logs',
      })
    );
    expect(findDeliveryEventMetadata(adapter)).toMatchObject({
      selected_destination_id: 'dest_webhook_failing',
      effective_destination_id: 'dest_webhook_platform',
      fallback_destination_id: 'dest_webhook_platform',
      fallback_used: true,
      fallback_reason: 'destination_unusable',
      policy_warnings: ['destination_unusable'],
    });
  });
});
