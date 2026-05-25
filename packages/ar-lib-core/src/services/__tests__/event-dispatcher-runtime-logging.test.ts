import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeLoggingPolicySnapshot,
  publishRuntimeLoggingPolicySnapshot,
} from '@authrim/ar-lib-logging/policies';
import { decodeLogRecordFromBlock, decryptLogChunkBody } from '@authrim/ar-lib-logging/chunks';
import { createEventDispatcher } from '../event-dispatcher';
import type { DatabaseAdapter, ExecuteResult, HealthStatus } from '../../db/adapter';

const ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

async function deriveRuntimeChunkKey(input: {
  tenantKey: string;
  logType: string;
  plane: string;
  keyVersion: number;
}): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey('raw', hexToBytes(ROOT_KEY), 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('authrim-log-chunk-archive-encryption'),
      info: new TextEncoder().encode(
        `${input.tenantKey}:${input.logType}:${input.plane}:v${input.keyVersion}`
      ),
    },
    material,
    256
  );
  return new Uint8Array(bits);
}

function chunkIdFromObjectKey(objectKey: string): string {
  const match = /\/(chk_[^/]+)\.jsonl(?:\.gz)?$/u.exec(objectKey);
  if (!match) {
    throw new Error('test_chunk_id_not_found');
  }
  return match[1];
}

function createSnapshotStores() {
  const kvValues = new Map<string, string>();
  const objectValues = new Map<string, Uint8Array>();
  const kv = {
    get: vi.fn(async (key: string) => kvValues.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      kvValues.set(key, value);
    }),
  } as unknown as KVNamespace;
  const bucket = {
    put: vi.fn(async (key: string, value: ArrayBuffer | ArrayBufferView | string) => {
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      objectValues.set(key, bytes);
    }),
    get: vi.fn(async (key: string) =>
      objectValues.has(key)
        ? {
            text: vi.fn(async () => new TextDecoder().decode(objectValues.get(key))),
          }
        : null
    ),
  } as unknown as R2Bucket;
  return { kv, bucket, objectValues };
}

function createMockAdapter() {
  const adapter: DatabaseAdapter = {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT tenant_key FROM tenants')) {
        expect(params).toEqual(['tenant-runtime-dispatch']);
        return { tenant_key: 't_runtime_dispatch' };
      }
      return null;
    }),
    execute: vi.fn(async (): Promise<ExecuteResult> => ({ rowsAffected: 1, success: true })),
    transaction: vi.fn(async (callback) => callback(adapter)),
    batch: vi.fn(async (statements) => {
      for (const statement of statements) {
        await adapter.execute(statement.sql, statement.params);
      }
      return statements.map(() => ({ rowsAffected: 1, success: true }));
    }),
    isHealthy: vi.fn(
      async (): Promise<HealthStatus> => ({ healthy: true, latencyMs: 1, type: 'mock' })
    ),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => {}),
  };
  return adapter;
}

describe('event dispatcher runtime logging', () => {
  it('routes normal webhook delivery metadata through runtime policy without logging payload detail', async () => {
    const tenantId = 'tenant-runtime-dispatch';
    const { kv, bucket, objectValues } = createSnapshotStores();
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: tenantId,
      version: 1,
      snapshotId: 'snap_dispatch_webhook_archive',
      synchronizedAt: 1_700_000_000_000,
      sourceUpdatedAt: 1_700_000_000_000,
      policies: {
        assignments: [
          {
            id: 'lpa_dispatch_webhook_archive',
            tenant_id: tenantId,
            log_type: 'webhook',
            plane: 'archive',
            destination_id: 'dest_dispatch_archive',
            enabled: 1,
            managed_by: 'tenant',
            lane: 'default',
            version: 1,
          },
        ],
        fallbacks: [],
        destinations: [
          {
            id: 'dest_dispatch_archive',
            scope_type: 'shared',
            scope_id: null,
            destination_kind: 'object_storage',
            provider: 'r2',
            name: 'webhook-dispatch-archive',
            display_name: 'Webhook Dispatch Archive',
            lifecycle_status: 'active',
            health_status: 'healthy',
            provider_config: JSON.stringify({
              bindingRef: 'DIAGNOSTIC_LOGS',
              prefix: 'webhook-dispatch',
            }),
            allowed_tenant_ids: JSON.stringify([]),
            allowed_log_types: JSON.stringify(['webhook']),
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

    const adapter = createMockAdapter();
    const deliveryQueue = { send: vi.fn(async () => {}) };
    const mockFetch = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal('fetch', mockFetch);

    const dispatcher = createEventDispatcher({
      adapter,
      kv: { get: vi.fn(async () => null), put: vi.fn(async () => {}) } as unknown as KVNamespace,
      webhookRegistry: {
        findByEventType: vi.fn(async () => [
          {
            id: 'wh_dispatch',
            tenantId,
            url: 'https://receiver.example/hooks?token=secret',
            secretEncrypted: 'encrypted_secret',
            timeoutMs: 10000,
            events: ['user.*'],
            active: true,
          },
        ]),
        recordSuccess: vi.fn(async () => {}),
        recordFailure: vi.fn(async () => {}),
      } as never,
      handlerRegistry: { getHandlers: vi.fn(() => []) } as never,
      hookRegistry: { getBeforeHooks: vi.fn(() => []), getAfterHooks: vi.fn(() => []) } as never,
      decryptSecret: vi.fn(async () => 'decrypted-secret'),
      runtimeLogging: {
        env: {
          DB_ADMIN: adapter,
          AUTHRIM_CONFIG: kv,
          DIAGNOSTIC_LOGS: bucket,
          OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY,
          LOGGING_DELIVERY_QUEUE: deliveryQueue as never,
        },
        tenantKeyResolver: async () => 't_runtime_dispatch',
      },
    });

    const result = await dispatcher.publish(
      {
        type: 'user.created',
        tenantId,
        data: { userId: 'user_123', secretValue: 'must-not-log' },
      },
      { skipAuditLog: true }
    );

    expect(result.success).toBe(true);
    expect(deliveryQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_type: 'delivery_fanout',
        destination_id: 'dest_dispatch_archive',
        log_type: 'webhook',
        plane: 'archive',
      })
    );
    const archiveKey = [...objectValues.keys()].find((key) =>
      key.includes('webhook-dispatch/t_runtime_dispatch/archive/webhook/')
    );
    expect(archiveKey).toBeTruthy();
    expect(archiveKey).not.toContain(tenantId);

    const indexStatement = vi
      .mocked(adapter.batch)
      .mock.calls.flatMap((call) => call[0])
      .find((statement) => statement.sql.includes('INSERT INTO log_chunk_record_index'));
    expect(indexStatement).toBeDefined();
    const params = indexStatement!.params;
    const decodedChunk = await decryptLogChunkBody({
      storedBody: objectValues.get(archiveKey!)!,
      keyBytes: await deriveRuntimeChunkKey({
        tenantKey: 't_runtime_dispatch',
        logType: 'webhook',
        plane: 'archive',
        keyVersion: 1,
      }),
      tenantKey: 't_runtime_dispatch',
      logType: 'webhook',
      plane: 'archive',
      objectKey: archiveKey!,
      chunkId: chunkIdFromObjectKey(archiveKey!),
      expectedEncryptionScope: 'tenant:t_runtime_dispatch:webhook:archive',
      expectedKeyVersion: 1,
    });
    const decodedRecord = await decodeLogRecordFromBlock(
      decodedChunk.body,
      {
        blockIndex: 0,
        compressedOffset: Number(params[8]),
        compressedLength: Number(params[9]),
        uncompressedLength: Number(params[9]),
        firstLineNumber: Number(params[7]),
        lastLineNumber: Number(params[7]),
        recordCount: 1,
      },
      {
        recordId: String(params[0]),
        lineNumber: Number(params[7]),
        blockIndex: 0,
        recordOffset: Number(params[10]),
        recordLength: Number(params[11]),
      },
      'gzip_block'
    );
    const archiveBody = JSON.stringify(decodedRecord);
    expect(archiveBody).toContain('webhook_delivery');
    expect(archiveBody).toContain('receiver.example');
    expect(archiveBody).not.toContain('must-not-log');
    expect(archiveBody).not.toContain('decrypted-secret');
    expect(archiveBody).not.toContain('token=secret');
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO logging_delivery_events'),
      expect.any(Array)
    );
  });
});
