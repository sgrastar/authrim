import { logProducerFixture } from './log-iceberg-producer-fixture';
import { LOG_ICEBERG_POLICY_PREFIX } from '../log-iceberg-policy-artifacts';
import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeLoggingPolicySnapshot,
  publishRuntimeLoggingPolicySnapshot,
} from '@authrim/ar-lib-logging/policies';
import { emitRuntimeLogRecords } from '../logging-runtime-emitter';

const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

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

describe('runtime log emitter', () => {
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
      prefix: LOG_ICEBERG_POLICY_PREFIX,
      now: 1_700_000_000_000,
    });
    vi.mocked(bucket.put).mockClear();

    const adapter = createMockAdapter();
    const queue = { send: vi.fn(async () => {}) };
    const result = await emitRuntimeLogRecords({
      env: {
        DB_ADMIN: adapter as never,
        AUTHRIM_CONFIG: kv,
        LOG_ARCHIVE: bucket,
        SENSITIVE_DETAILS: bucket,
        LOGGING_DELIVERY_QUEUE: queue as never,
        OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
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
        planes: ['external_sink'],
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
        'external_sink',
        'critical',
        'retrying',
      ])
    );
    expect(findDeliveryEventMetadata(adapter)).toMatchObject({
      error: 'runtime_log_critical_target_not_configured',
      fallback_used: false,
    });
  });
});

for (const mode of ['scheduled', 'pipeline'] as const)
  for (const [logType, sourceDataset] of [
    ['job', 'runtime.admin_job_events'],
    ['webhook', 'runtime.webhook_delivery_events'],
  ] as const) {
    it(`writes ${logType} through ${mode} without old JSON chunks or a second searchable copy`, async () => {
      const f = await logProducerFixture(mode);
      try {
        const result = await emitRuntimeLogRecords({
          env: f.env,
          tenantId: 'tenant-a',
          logType,
          sourceDataset,
          surface: logType,
          planes: ['archive'],
          tenantKeyResolver: async () => 'key-a',
          records: [
            {
              id: 'runtime-1',
              eventAt: f.now,
              payload: { status: 'success', private_note: 'private-body' },
            },
          ],
        });
        expect(result.targetResults).toHaveLength(1);
        expect(await f.rows(sourceDataset)).toMatchObject([
          { id: 'runtime-1', tenant_id: 'tenant-a' },
        ]);
        expect(f.db.prepare('SELECT COUNT(*) n FROM log_iceberg_records').get()).toMatchObject({
          n: mode === 'scheduled' ? 1 : 0,
        });
        expect(f.objects.size).toBe(mode === 'pipeline' ? 1 : 0);
        expect(JSON.stringify([...f.objects.values()])).not.toContain('private-body');
        if (mode === 'pipeline') expect(f.queueMessages).toHaveLength(1);
        await emitRuntimeLogRecords({
          env: f.env,
          tenantId: 'tenant-a',
          logType,
          sourceDataset,
          surface: logType,
          planes: ['archive'],
          records: [
            {
              id: 'runtime-1',
              eventAt: f.now,
              payload: { status: 'success', private_note: 'private-body' },
            },
          ],
        });
        expect(await f.rows(sourceDataset)).toHaveLength(1);
      } finally {
        f.db.close();
      }
    });
  }
