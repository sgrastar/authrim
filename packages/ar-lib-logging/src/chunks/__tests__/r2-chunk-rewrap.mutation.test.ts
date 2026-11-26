import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptLogChunkBody } from '../r2-chunk-reader';
import { rewrapLogChunkObject, type RewrapLogChunkObjectInput } from '../r2-chunk-rewrap';
import { encryptLogChunkBody } from '../r2-chunk-writer';

afterEach(() => {
  vi.useRealTimers();
});

const OLD = { keyBytes: new Uint8Array(32).fill(1), encryptionScope: 'scope-old', keyVersion: 1 };
const NEW = { keyBytes: new Uint8Array(32).fill(2), encryptionScope: 'scope-new', keyVersion: 2 };
const context = {
  tenantKey: 'tenant-a',
  logType: 'audit',
  plane: 'archive',
  chunkId: 'chunk-1',
} as const;

async function sealed(plaintext: string, objectKey: string, keys = OLD): Promise<Uint8Array> {
  return encryptLogChunkBody(new TextEncoder().encode(plaintext), {
    ...keys,
    ...context,
    objectKey,
    compression: 'none',
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fakeBucket(
  initial: Record<string, Uint8Array>,
  options: { streamed?: boolean; claimSize?: number } = {}
) {
  const objects = new Map(Object.entries(initial));
  const get = vi.fn(async (key: string) => {
    const bytes = objects.get(key);
    if (!bytes) return null;
    const size = options.claimSize ?? bytes.byteLength;
    return options.streamed === false
      ? { size, arrayBuffer: async () => bytes.slice().buffer }
      : {
          size,
          body: new Response(bytes.slice()).body,
          arrayBuffer: async () => bytes.slice().buffer,
        };
  });
  const put = vi.fn(async (key: string, body: Uint8Array, _options?: unknown) => {
    if (objects.has(key)) return null;
    objects.set(key, body);
    return {};
  });
  return { bucket: { get, put } as unknown as R2Bucket, objects, get, put };
}

function input(
  bucket: R2Bucket,
  overrides: Partial<RewrapLogChunkObjectInput> = {}
): RewrapLogChunkObjectInput {
  return {
    bucket,
    objectCatalogId: 'obj-1',
    objectKey: 'logs/source.bin',
    targetObjectKey: 'logs/target.bin',
    ...context,
    compression: 'none',
    from: OLD,
    to: NEW,
    now: 5000,
    ...overrides,
  };
}

describe('rewrapLogChunkObject: the target key', () => {
  it('must be a different key of at most 1024 bytes', async () => {
    const source = await sealed('x', 'logs/source.bin');
    for (const targetObjectKey of ['', 'logs/source.bin', 'あ'.repeat(342), 'x'.repeat(1025)]) {
      const { bucket, get } = fakeBucket({ 'logs/source.bin': source });
      await expect(rewrapLogChunkObject(input(bucket, { targetObjectKey }))).rejects.toThrow(
        'log_chunk_rewrap_target_object_key_invalid'
      );
      expect(get).not.toHaveBeenCalled();
    }
    for (const targetObjectKey of ['x'.repeat(1024), 'あ'.repeat(341), 'logs/Source.bin']) {
      const { bucket } = fakeBucket({ 'logs/source.bin': source });
      await expect(rewrapLogChunkObject(input(bucket, { targetObjectKey }))).resolves.toBeDefined();
    }
  });
});

describe('rewrapLogChunkObject: a new target', () => {
  it('writes the body sealed with the new key, bound to the new key, and catalogs it', async () => {
    const source = await sealed('chunk text', 'logs/source.bin');
    const { bucket, objects, put } = fakeBucket({ 'logs/source.bin': source });
    const updateRewrappedObject = vi.fn(async () => undefined);
    const result = await rewrapLogChunkObject(
      input(bucket, { catalogUpdater: { updateRewrappedObject } })
    );

    const target = objects.get('logs/target.bin');
    if (!target) throw new Error('expected a target');
    const checksum = await sha256Hex(target);
    expect(result).toStrictEqual({
      objectCatalogId: 'obj-1',
      objectKey: 'logs/target.bin',
      byteCount: target.byteLength,
      checksumSha256: checksum,
      encryptionScope: 'scope-new',
      keyVersion: 2,
      updatedAt: 5000,
    });
    expect(updateRewrappedObject).toHaveBeenCalledWith({
      objectCatalogId: 'obj-1',
      previousObjectKey: 'logs/source.bin',
      objectKey: 'logs/target.bin',
      byteCount: target.byteLength,
      checksumSha256: checksum,
      encryptionScope: 'scope-new',
      keyVersion: 2,
      updatedAt: 5000,
    });
    expect(put).toHaveBeenCalledWith('logs/target.bin', target, {
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/authrim.log-chunk+encrypted' },
      customMetadata: {
        tenantKey: 'tenant-a',
        logType: 'audit',
        plane: 'archive',
        checksumSha256: checksum,
        compression: 'none',
        encryptionScope: 'scope-new',
        keyVersion: '2',
        rewrappedAt: '5000',
      },
    });
    const opened = await decryptLogChunkBody({
      storedBody: target,
      keyBytes: NEW.keyBytes,
      ...context,
      objectKey: 'logs/target.bin',
      expectedEncryptionScope: 'scope-new',
      expectedKeyVersion: 2,
    });
    expect(new TextDecoder().decode(opened.body)).toBe('chunk text');
    expect(objects.get('logs/source.bin')).toBe(source);
  });

  it('refuses to start from a source that is missing or sealed with another key', async () => {
    const empty = fakeBucket({});
    await expect(rewrapLogChunkObject(input(empty.bucket))).rejects.toThrow(
      'log_chunk_rewrap_object_not_found'
    );
    expect(empty.put).not.toHaveBeenCalled();
    const wrongKey = fakeBucket({ 'logs/source.bin': await sealed('x', 'logs/source.bin', NEW) });
    await expect(rewrapLogChunkObject(input(wrongKey.bucket))).rejects.toThrow();
    expect(wrongKey.put).not.toHaveBeenCalled();
    const wrongScope = fakeBucket({ 'logs/source.bin': await sealed('x', 'logs/source.bin') });
    await expect(
      rewrapLogChunkObject(input(wrongScope.bucket, { from: { ...OLD, encryptionScope: 'other' } }))
    ).rejects.toThrow('log_chunk_encryption_scope_mismatch');
    await expect(
      rewrapLogChunkObject(input(wrongScope.bucket, { from: { ...OLD, keyVersion: 9 } }))
    ).rejects.toThrow('log_chunk_key_version_mismatch');
  });

  it('reads the clock for the time of the rewrap by default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(4242));
    const { bucket } = fakeBucket({ 'logs/source.bin': await sealed('x', 'logs/source.bin') });
    expect((await rewrapLogChunkObject(input(bucket, { now: undefined }))).updatedAt).toBe(4242);
  });
});

describe('rewrapLogChunkObject: the size of the source', () => {
  async function run(
    maxBytes: number | undefined,
    options: { streamed?: boolean; claimSize?: number } = {}
  ) {
    const source = await sealed('x', 'logs/source.bin');
    const { bucket } = fakeBucket({ 'logs/source.bin': source }, options);
    return { source, promise: () => rewrapLogChunkObject(input(bucket, { maxBytes })) };
  }

  it('is bounded by the object size it reports, and by the bytes it streams, exactly', async () => {
    const { source } = await run(undefined);
    const size = source.byteLength;
    for (const options of [{ streamed: true }, { streamed: false }]) {
      await expect((await run(size, options)).promise()).resolves.toBeDefined();
      await expect((await run(size - 1, options)).promise()).rejects.toThrow(
        'log_chunk_rewrap_object_too_large'
      );
    }
    await expect((await run(size, { claimSize: size })).promise()).resolves.toBeDefined();
    await expect((await run(size, { claimSize: size + 1 })).promise()).rejects.toThrow(
      'log_chunk_rewrap_object_too_large'
    );
    await expect((await run(size - 1, { claimSize: 1 })).promise()).rejects.toThrow(
      'log_chunk_rewrap_object_too_large'
    );
    await expect(
      (await run(size - 1, { claimSize: 1, streamed: false })).promise()
    ).rejects.toThrow('log_chunk_rewrap_object_too_large');
  });

  it('is 64 MiB by default and unlimited-looking limits fall back to it', async () => {
    for (const maxBytes of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1e12,
    ]) {
      await expect((await run(maxBytes)).promise()).resolves.toBeDefined();
    }
    for (const maxBytes of [0, -5, 0.9]) {
      await expect((await run(maxBytes)).promise()).rejects.toThrow(
        'log_chunk_rewrap_object_too_large'
      );
    }
    const { source } = await run(undefined);
    await expect((await run(source.byteLength + 0.9)).promise()).resolves.toBeDefined();
    await expect((await run(source.byteLength - 0.1)).promise()).rejects.toThrow(
      'log_chunk_rewrap_object_too_large'
    );
    const refused = await run(source.byteLength * 1000, { claimSize: 64 * 1024 * 1024 + 1 });
    await expect(refused.promise()).rejects.toThrow('log_chunk_rewrap_object_too_large');
  });

  it('is also applied to a target that already exists', async () => {
    const source = await sealed('x', 'logs/source.bin');
    const existing = await sealed('x', 'logs/target.bin', NEW);
    const { bucket } = fakeBucket({ 'logs/source.bin': source, 'logs/target.bin': existing });
    await expect(
      rewrapLogChunkObject(input(bucket, { maxBytes: existing.byteLength - 1 }))
    ).rejects.toThrow('log_chunk_rewrap_object_too_large');
  });
});

describe('rewrapLogChunkObject: reading the source as a stream', () => {
  it('joins the chunks, skips empty reads and releases the reader, and reads no target it created', async () => {
    const source = await sealed('streamed', 'logs/source.bin');
    const third = Math.floor(source.byteLength / 3);
    const reads: Array<{ done: boolean; value?: Uint8Array }> = [
      { done: false, value: source.slice(0, third) },
      { done: false, value: undefined },
      { done: false, value: source.slice(third, 2 * third) },
      { done: false, value: source.slice(2 * third) },
      { done: true },
    ];
    const releaseLock = vi.fn();
    const objects = new Map<string, Uint8Array>();
    const get = vi.fn(async (key: string) =>
      key === 'logs/source.bin'
        ? {
            size: source.byteLength,
            body: {
              getReader: () => ({ read: async () => reads.shift() ?? { done: true }, releaseLock }),
            },
          }
        : null
    );
    const put = vi.fn(async (key: string, body: Uint8Array) => {
      objects.set(key, body);
      return {};
    });
    const result = await rewrapLogChunkObject(input({ get, put } as unknown as R2Bucket));
    expect(result.objectKey).toBe('logs/target.bin');
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('logs/source.bin');
  });

  it('releases the reader when the stream is too long', async () => {
    const releaseLock = vi.fn();
    const reads = [{ done: false, value: new Uint8Array(10) }, { done: true }];
    const get = vi.fn(async () => ({
      body: {
        getReader: () => ({ read: async () => reads.shift() ?? { done: true }, releaseLock }),
      },
    }));
    await expect(
      rewrapLogChunkObject(input({ get, put: vi.fn() } as unknown as R2Bucket, { maxBytes: 5 }))
    ).rejects.toThrow('log_chunk_rewrap_object_too_large');
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('rewrapLogChunkObject: a target that already exists', () => {
  it('is reused when it holds the same chunk under the new key', async () => {
    const source = await sealed('same', 'logs/source.bin');
    const existing = await sealed('same', 'logs/target.bin', NEW);
    const { bucket, objects } = fakeBucket({
      'logs/source.bin': source,
      'logs/target.bin': existing,
    });
    const updateRewrappedObject = vi.fn(async () => undefined);
    const result = await rewrapLogChunkObject(
      input(bucket, { catalogUpdater: { updateRewrappedObject } })
    );
    expect(objects.get('logs/target.bin')).toBe(existing);
    expect(result).toMatchObject({
      byteCount: existing.byteLength,
      checksumSha256: await sha256Hex(existing),
    });
    expect(updateRewrappedObject).toHaveBeenCalledWith(
      expect.objectContaining({
        byteCount: existing.byteLength,
        checksumSha256: await sha256Hex(existing),
      })
    );
  });

  it('is refused when it differs, is not readable with the new key, or vanished', async () => {
    const source = await sealed('same', 'logs/source.bin');
    const conflict = 'log_chunk_rewrap_target_object_conflict';
    const different = fakeBucket({
      'logs/source.bin': source,
      'logs/target.bin': await sealed('other', 'logs/target.bin', NEW),
    });
    await expect(rewrapLogChunkObject(input(different.bucket))).rejects.toThrow(conflict);
    const sameLength = fakeBucket({
      'logs/source.bin': source,
      'logs/target.bin': await sealed('sbme', 'logs/target.bin', NEW),
    });
    await expect(rewrapLogChunkObject(input(sameLength.bucket))).rejects.toThrow(conflict);
    const lastByte = fakeBucket({
      'logs/source.bin': source,
      'logs/target.bin': await sealed('samf', 'logs/target.bin', NEW),
    });
    await expect(rewrapLogChunkObject(input(lastByte.bucket))).rejects.toThrow(conflict);
    const shorter = fakeBucket({
      'logs/source.bin': source,
      'logs/target.bin': await sealed('sam', 'logs/target.bin', NEW),
    });
    await expect(rewrapLogChunkObject(input(shorter.bucket))).rejects.toThrow(conflict);
    const wrongKey = fakeBucket({
      'logs/source.bin': source,
      'logs/target.bin': await sealed('same', 'logs/target.bin', OLD),
    });
    await expect(rewrapLogChunkObject(input(wrongKey.bucket))).rejects.toThrow();
    const raced = fakeBucket({ 'logs/source.bin': source });
    raced.put.mockResolvedValueOnce(null);
    await expect(rewrapLogChunkObject(input(raced.bucket))).rejects.toThrow(conflict);
  });

  it('does not catalog a target that was refused', async () => {
    const source = await sealed('same', 'logs/source.bin');
    const { bucket } = fakeBucket({
      'logs/source.bin': source,
      'logs/target.bin': await sealed('other', 'logs/target.bin', NEW),
    });
    const updateRewrappedObject = vi.fn(async () => undefined);
    await expect(
      rewrapLogChunkObject(input(bucket, { catalogUpdater: { updateRewrappedObject } }))
    ).rejects.toThrow();
    expect(updateRewrappedObject).not.toHaveBeenCalled();
  });
});
