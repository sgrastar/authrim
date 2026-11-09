import { describe, expect, it, vi } from 'vitest';
import { decryptLogChunkBody } from '../r2-chunk-reader';
import { rewrapLogChunkObject } from '../r2-chunk-rewrap';
import { encryptLogChunkBody } from '../r2-chunk-writer';

describe('rewrapLogChunkObject', () => {
  it.each(['', 'logs/source.bin', 'x'.repeat(1025)])(
    'rejects an invalid target key before reading the source',
    async (targetObjectKey) => {
      const bucket = { get: vi.fn(), put: vi.fn() } as unknown as R2Bucket;
      await expect(
        rewrapLogChunkObject({
          bucket,
          objectCatalogId: 'obj-1',
          objectKey: 'logs/source.bin',
          targetObjectKey,
          chunkId: 'chunk-1',
          tenantKey: 'tenant-a',
          logType: 'audit',
          plane: 'archive',
          compression: 'none',
          from: { keyBytes: new Uint8Array(32), encryptionScope: 'scope', keyVersion: 1 },
          to: { keyBytes: new Uint8Array(32), encryptionScope: 'scope', keyVersion: 2 },
        })
      ).rejects.toThrow('log_chunk_rewrap_target_object_key_invalid');
      expect(bucket.get).not.toHaveBeenCalled();
      expect(bucket.put).not.toHaveBeenCalled();
    }
  );

  it('does not create or catalog a target when the source object is missing', async () => {
    const bucket = {
      get: vi.fn(async () => null),
      put: vi.fn(),
    } as unknown as R2Bucket;
    const updateRewrappedObject = vi.fn();
    await expect(
      rewrapLogChunkObject({
        bucket,
        objectCatalogId: 'obj-1',
        objectKey: 'logs/source.bin',
        targetObjectKey: 'logs/target.bin',
        chunkId: 'chunk-1',
        tenantKey: 'tenant-a',
        logType: 'audit',
        plane: 'archive',
        compression: 'none',
        from: { keyBytes: new Uint8Array(32), encryptionScope: 'scope', keyVersion: 1 },
        to: { keyBytes: new Uint8Array(32), encryptionScope: 'scope', keyVersion: 2 },
        catalogUpdater: { updateRewrappedObject },
      })
    ).rejects.toThrow('log_chunk_rewrap_object_not_found');
    expect(bucket.put).not.toHaveBeenCalled();
    expect(updateRewrappedObject).not.toHaveBeenCalled();
  });

  it('bounds streamed bytes even if R2 reports a smaller object size', async () => {
    const bucket = {
      get: vi.fn(async () => ({
        size: 2,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([1, 2]));
            controller.enqueue(Uint8Array.from([3, 4]));
            controller.close();
          },
        }),
      })),
      put: vi.fn(),
    } as unknown as R2Bucket;
    const updateRewrappedObject = vi.fn();
    await expect(
      rewrapLogChunkObject({
        bucket,
        objectCatalogId: 'obj-1',
        objectKey: 'logs/source.bin',
        targetObjectKey: 'logs/target.bin',
        chunkId: 'chunk-1',
        tenantKey: 'tenant-a',
        logType: 'audit',
        plane: 'archive',
        compression: 'none',
        from: { keyBytes: new Uint8Array(32), encryptionScope: 'scope', keyVersion: 1 },
        to: { keyBytes: new Uint8Array(32), encryptionScope: 'scope', keyVersion: 2 },
        maxBytes: 3,
        catalogUpdater: { updateRewrappedObject },
      })
    ).rejects.toThrow('log_chunk_rewrap_object_too_large');
    expect(bucket.put).not.toHaveBeenCalled();
    expect(updateRewrappedObject).not.toHaveBeenCalled();
  });

  it('rejects oversized R2 objects before buffering chunk bodies', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const bucket = {
      get: vi.fn(async () => ({
        size: 2 * 1024 * 1024,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
        arrayBuffer,
      })),
      put: vi.fn(),
    } as unknown as R2Bucket;

    await expect(
      rewrapLogChunkObject({
        bucket,
        objectCatalogId: 'obj_1',
        objectKey: 'logs/chunk.jsonl.enc',
        targetObjectKey: 'logs-rewrapped/tenant/obj_1/job_1/v2.bin',
        chunkId: 'chk_1',
        tenantKey: 't_opaque',
        logType: 'audit',
        plane: 'archive',
        compression: 'gzip_block',
        from: {
          keyBytes: new Uint8Array(32).fill(1),
          encryptionScope: 'tenant:t_opaque:audit:archive',
          keyVersion: 1,
        },
        to: {
          keyBytes: new Uint8Array(32).fill(2),
          encryptionScope: 'tenant:t_opaque:audit:archive',
          keyVersion: 2,
        },
        maxBytes: 1024,
      })
    ).rejects.toThrow('log_chunk_rewrap_object_too_large');

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('writes an immutable target generation and verifies it on retry', async () => {
    const sourceKey = 'logs/tenant/archive/audit/source.bin';
    const targetKey = 'logs-rewrapped/tenant/obj_1/job_1/v2.bin';
    const fromKey = new Uint8Array(32).fill(1);
    const toKey = new Uint8Array(32).fill(2);
    const plaintext = new TextEncoder().encode('{"id":"event-1"}\n');
    const sourceBody = await encryptLogChunkBody(plaintext, {
      keyBytes: fromKey,
      encryptionScope: 'tenant:tenant:audit:archive',
      keyVersion: 1,
      tenantKey: 'tenant',
      logType: 'audit',
      plane: 'archive',
      objectKey: sourceKey,
      chunkId: 'chunk-1',
      compression: 'none',
    });
    const objects = new Map<string, Uint8Array>([[sourceKey, sourceBody]]);
    const bucket = {
      get: vi.fn(async (key: string) => {
        const body = objects.get(key);
        return body
          ? ({
              size: body.byteLength,
              arrayBuffer: async () => body.slice().buffer,
            } as unknown as R2ObjectBody)
          : null;
      }),
      put: vi.fn(async (key: string, body: Uint8Array) => {
        if (objects.has(key)) return null;
        objects.set(key, body.slice());
        return {} as R2Object;
      }),
    } as unknown as R2Bucket;
    const updateRewrappedObject = vi.fn(async () => {});
    const input = {
      bucket,
      objectCatalogId: 'obj_1',
      objectKey: sourceKey,
      targetObjectKey: targetKey,
      chunkId: 'chunk-1',
      tenantKey: 'tenant',
      logType: 'audit' as const,
      plane: 'archive' as const,
      compression: 'none' as const,
      from: {
        keyBytes: fromKey,
        encryptionScope: 'tenant:tenant:audit:archive',
        keyVersion: 1,
      },
      to: {
        keyBytes: toKey,
        encryptionScope: 'tenant:tenant:audit:archive',
        keyVersion: 2,
      },
      now: 1234,
      catalogUpdater: { updateRewrappedObject },
    };

    const first = await rewrapLogChunkObject(input);
    const second = await rewrapLogChunkObject(input);

    expect(objects.get(sourceKey)).toEqual(sourceBody);
    expect(first.objectKey).toBe(targetKey);
    expect(second).toEqual(first);
    expect(updateRewrappedObject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        previousObjectKey: sourceKey,
        objectKey: targetKey,
        keyVersion: 2,
      })
    );
    const targetBody = objects.get(targetKey);
    expect(targetBody).toBeDefined();
    if (!targetBody) throw new Error('Missing rewrapped target');
    const decoded = await decryptLogChunkBody({
      storedBody: targetBody,
      keyBytes: toKey,
      tenantKey: 'tenant',
      logType: 'audit',
      plane: 'archive',
      objectKey: targetKey,
      chunkId: 'chunk-1',
      expectedEncryptionScope: 'tenant:tenant:audit:archive',
      expectedKeyVersion: 2,
    });
    expect(decoded.body).toEqual(plaintext);
  });

  it('rejects a different encrypted target without updating the catalog', async () => {
    const sourceKey = 'logs/tenant/archive/audit/source.bin';
    const targetKey = 'logs/tenant/archive/audit/target.bin';
    const fromKey = new Uint8Array(32).fill(1);
    const toKey = new Uint8Array(32).fill(2);
    const common = {
      tenantKey: 'tenant',
      logType: 'audit' as const,
      plane: 'archive' as const,
      chunkId: 'chunk-1',
      compression: 'none' as const,
    };
    const source = await encryptLogChunkBody(new TextEncoder().encode('original'), {
      ...common,
      keyBytes: fromKey,
      encryptionScope: 'scope',
      keyVersion: 1,
      objectKey: sourceKey,
    });
    const conflicting = await encryptLogChunkBody(new TextEncoder().encode('different'), {
      ...common,
      keyBytes: toKey,
      encryptionScope: 'scope',
      keyVersion: 2,
      objectKey: targetKey,
    });
    const bucket = {
      get: vi.fn(async (key: string) => {
        const body = key === sourceKey ? source : key === targetKey ? conflicting : null;
        return body
          ? ({ size: body.length, arrayBuffer: async () => body.buffer } as R2ObjectBody)
          : null;
      }),
      put: vi.fn(async () => null),
    } as unknown as R2Bucket;
    const updateRewrappedObject = vi.fn();

    await expect(
      rewrapLogChunkObject({
        ...common,
        bucket,
        objectCatalogId: 'obj-1',
        objectKey: sourceKey,
        targetObjectKey: targetKey,
        from: { keyBytes: fromKey, encryptionScope: 'scope', keyVersion: 1 },
        to: { keyBytes: toKey, encryptionScope: 'scope', keyVersion: 2 },
        catalogUpdater: { updateRewrappedObject },
      })
    ).rejects.toThrow('log_chunk_rewrap_target_object_conflict');
    expect(updateRewrappedObject).not.toHaveBeenCalled();
  });
});
