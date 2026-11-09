import { describe, expect, it } from 'vitest';
import {
  buildRuntimeLoggingPolicySnapshotPointerKey,
  createRuntimeLoggingPolicySnapshot,
  loadPublishedRuntimeLoggingPolicySnapshot,
  publishRuntimeLoggingPolicySnapshot,
} from '../index';

describe('published logging policy snapshot boundaries', () => {
  it('publishes the KV snapshot before its pointer and leaves no pointer after a failed write', async () => {
    const now = 1_800_000_000_000;
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      version: 3,
      synchronizedAt: now,
      sourceUpdatedAt: now,
      expiresAt: now + 1_500,
      snapshotId: 'snapshot-a',
      policies: { assignments: [] },
    });
    const writes: Array<{ key: string; value: string; ttl?: number }> = [];
    const kv = {
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        writes.push({ key, value, ttl: options?.expirationTtl });
      },
      get: async () => null,
    };
    const publication = await publishRuntimeLoggingPolicySnapshot({ snapshot, kv, now });

    expect(writes).toHaveLength(2);
    expect(writes.map((write) => write.key)).toEqual([
      publication.snapshotKey,
      publication.pointerKey,
    ]);
    expect(writes.map((write) => write.ttl)).toEqual([1, 1]);
    expect(publication.objectRef).toBe(`kv://${publication.snapshotKey}`);

    const failedWrites: string[] = [];
    await expect(
      publishRuntimeLoggingPolicySnapshot({
        snapshot,
        now,
        kv: {
          put: async (key: string) => {
            failedWrites.push(key);
            throw new Error('KV write failed');
          },
          get: async () => null,
        },
      })
    ).rejects.toThrow('KV write failed');
    expect(failedWrites).toEqual([publication.snapshotKey]);
  });

  it('does not load another tenant policy through a swapped KV pointer', async () => {
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-b',
      version: 2,
      synchronizedAt: 1_800_000_000_000,
      sourceUpdatedAt: 1_800_000_000_000,
      snapshotId: 'snapshot-b',
      policies: { secret: 'tenant-b-only' },
    });
    const kvValues = new Map<string, string>();
    const objectValues = new Map<string, string>();
    const kv = {
      put: async (key: string, value: string) => {
        kvValues.set(key, value);
      },
      get: async (key: string) => kvValues.get(key) ?? null,
    };
    const objectStore = {
      put: async (key: string, value: string) => {
        objectValues.set(key, value);
      },
      get: async (key: string) => {
        const value = objectValues.get(key);
        return value ? { text: async () => value } : null;
      },
    };
    await publishRuntimeLoggingPolicySnapshot({ snapshot, kv, objectStore });
    const tenantBPointer = kvValues.get(
      buildRuntimeLoggingPolicySnapshotPointerKey({ scopeType: 'tenant', scopeId: 'tenant-b' })
    );
    if (!tenantBPointer) throw new Error('Fixture pointer is missing');
    kvValues.set(
      buildRuntimeLoggingPolicySnapshotPointerKey({ scopeType: 'tenant', scopeId: 'tenant-a' }),
      tenantBPointer
    );

    const read = (strict: boolean) =>
      loadPublishedRuntimeLoggingPolicySnapshot({
        scopeType: 'tenant',
        scopeId: 'tenant-a',
        kv,
        objectStore,
        strict,
      });
    await expect(read(false)).resolves.toBeNull();
    await expect(read(true)).rejects.toThrow('logging_policy_snapshot_unreadable');
  });

  it('rejects a streamed snapshot beyond the byte limit even when its size metadata is small', async () => {
    const snapshot = await createRuntimeLoggingPolicySnapshot({
      scopeType: 'tenant',
      scopeId: 'tenant-a',
      version: 1,
      synchronizedAt: 1_800_000_000_000,
      sourceUpdatedAt: 1_800_000_000_000,
      snapshotId: 'streamed-snapshot',
      policies: { assignments: [] },
    });
    const kvValues = new Map<string, string>();
    const kv = {
      put: async (key: string, value: string) => {
        kvValues.set(key, value);
      },
      get: async (key: string) => kvValues.get(key) ?? null,
    };
    await publishRuntimeLoggingPolicySnapshot({
      snapshot,
      kv,
      objectStore: { put: async () => undefined },
    });
    const objectStore = {
      put: async () => undefined,
      get: async () => ({
        size: 10,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(600_000));
            controller.enqueue(new Uint8Array(600_000));
            controller.close();
          },
        }),
        text: async () => {
          throw new Error('Streaming object must not use text()');
        },
      }),
    };

    await expect(
      loadPublishedRuntimeLoggingPolicySnapshot({
        scopeType: 'tenant',
        scopeId: 'tenant-a',
        kv,
        objectStore,
      })
    ).resolves.toBeNull();
    await expect(
      loadPublishedRuntimeLoggingPolicySnapshot({
        scopeType: 'tenant',
        scopeId: 'tenant-a',
        kv,
        objectStore,
        strict: true,
      })
    ).rejects.toThrow('logging_policy_snapshot_unreadable');
  });
});
