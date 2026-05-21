import { describe, expect, it, vi } from 'vitest';
import { rewrapLogChunkObject } from '../r2-chunk-rewrap';

describe('rewrapLogChunkObject', () => {
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
});
