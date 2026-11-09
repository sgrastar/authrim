import { describe, expect, it, vi } from 'vitest';
import { R2IcebergObjectStore } from '../object-store';
import { IcebergBatchCollisionError, IcebergBudgetError } from '../types';

const TABLE = 's3://archive-bucket/tenant-a/table';
const OBJECT = `${TABLE}/data/part-1.parquet`;

function bucket() {
  const get = vi.fn();
  const head = vi.fn();
  const put = vi.fn();
  return { get, head, put };
}

function object(bytes: number[], reportedSize = bytes.length) {
  const cancel = vi.fn(async () => undefined);
  const arrayBuffer = vi.fn(async () => Uint8Array.from(bytes).buffer);
  return { size: reportedSize, body: { cancel }, arrayBuffer, cancel };
}

describe('R2IcebergObjectStore path boundary', () => {
  it.each([
    'https://archive-bucket/tenant-a/table',
    's3://user:secret@archive-bucket/tenant-a/table',
    's3://archive-bucket/tenant-a/table?query=1',
    's3://archive-bucket/tenant-a/table#fragment',
    's3://archive-bucket/',
    's3://archive-bucket/tenant-a/%74able',
  ])('rejects an invalid table location: %s', (location) => {
    expect(() => new R2IcebergObjectStore(bucket(), location)).toThrow(
      'Invalid Iceberg table location'
    );
  });

  it('accepts only object keys below the configured table', () => {
    const store = new R2IcebergObjectStore(bucket(), TABLE);
    expect(store.objectKey(OBJECT)).toBe('tenant-a/table/data/part-1.parquet');
    for (const path of [
      's3://archive-bucket/tenant-b/table/data/part-1.parquet',
      's3://other-bucket/tenant-a/table/data/part-1.parquet',
      `${TABLE}/data//part-1.parquet`,
      `${TABLE}/data/../part-1.parquet`,
      `${TABLE}/data/%2e%2e/part-1.parquet`,
      `${TABLE}/data/part-1.parquet?download=1`,
      `${TABLE}/data/part-1.parquet#fragment`,
    ]) {
      expect(() => store.objectKey(path)).toThrow('Iceberg object outside configured table');
    }
  });
});

describe('R2IcebergObjectStore bounded reads', () => {
  it('reads only the exact table key and returns object bytes', async () => {
    const r2 = bucket();
    const stored = object([1, 2, 3]);
    r2.get.mockResolvedValue(stored);
    const store = new R2IcebergObjectStore(r2, TABLE);

    await expect(store.read(OBJECT, 3)).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    expect(r2.get).toHaveBeenCalledExactlyOnceWith('tenant-a/table/data/part-1.parquet');
    expect(stored.cancel).not.toHaveBeenCalled();
  });

  it('rejects a reported oversize object and cancels its body before reading', async () => {
    const r2 = bucket();
    const stored = object([1, 2], 11);
    r2.get.mockResolvedValue(stored);
    const store = new R2IcebergObjectStore(r2, TABLE);

    await expect(store.read(OBJECT, 10)).rejects.toBeInstanceOf(IcebergBudgetError);
    expect(stored.cancel).toHaveBeenCalledOnce();
    expect(stored.arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects oversized bytes even if the reported size was smaller', async () => {
    const r2 = bucket();
    r2.get.mockResolvedValue(object([1, 2, 3], 2));
    const store = new R2IcebergObjectStore(r2, TABLE);

    await expect(store.read(OBJECT, 2)).rejects.toBeInstanceOf(IcebergBudgetError);
  });

  it('reports missing objects without treating them as empty', async () => {
    const r2 = bucket();
    r2.get.mockResolvedValue(null);
    r2.head.mockResolvedValue(null);
    const store = new R2IcebergObjectStore(r2, TABLE);

    await expect(store.read(OBJECT, 10)).rejects.toThrow('Iceberg object missing');
    await expect(store.size(OBJECT)).rejects.toThrow('Iceberg object missing');
    expect(r2.head).toHaveBeenCalledExactlyOnceWith('tenant-a/table/data/part-1.parquet');
  });

  it('reads the recorded size through a head request', async () => {
    const r2 = bucket();
    r2.head.mockResolvedValue({ size: 123 });
    const store = new R2IcebergObjectStore(r2, TABLE);

    await expect(store.size(OBJECT)).resolves.toBe(123);
    expect(r2.head).toHaveBeenCalledExactlyOnceWith('tenant-a/table/data/part-1.parquet');
  });

  it.each([
    [-1, 1],
    [0, 0],
    [0.5, 1],
    [0, 1.5],
    [Number.MAX_SAFE_INTEGER + 1, 1],
  ])('rejects an invalid range before touching R2: %s, %s', async (offset, length) => {
    const r2 = bucket();
    const store = new R2IcebergObjectStore(r2, TABLE);
    await expect(store.readRange(OBJECT, offset, length)).rejects.toThrow('Invalid Iceberg range');
    expect(r2.get).not.toHaveBeenCalled();
  });

  it('passes the exact range to R2 and returns only its bytes', async () => {
    const r2 = bucket();
    r2.get.mockResolvedValue(object([8, 9], 10));
    const store = new R2IcebergObjectStore(r2, TABLE);

    await expect(store.readRange(OBJECT, 4, 2)).resolves.toEqual(Uint8Array.from([8, 9]));
    expect(r2.get).toHaveBeenCalledExactlyOnceWith('tenant-a/table/data/part-1.parquet', {
      range: { offset: 4, length: 2 },
    });
  });

  it('cancels a range response that extends beyond the object', async () => {
    const r2 = bucket();
    const stored = object([8, 9], 5);
    r2.get.mockResolvedValue(stored);
    const store = new R2IcebergObjectStore(r2, TABLE);

    await expect(store.readRange(OBJECT, 4, 2)).rejects.toThrow('Iceberg range outside object');
    expect(stored.cancel).toHaveBeenCalledOnce();
    expect(stored.arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects a truncated range response', async () => {
    const r2 = bucket();
    r2.get.mockResolvedValue(object([8], 10));
    const store = new R2IcebergObjectStore(r2, TABLE);

    await expect(store.readRange(OBJECT, 4, 2)).rejects.toThrow('Iceberg range length mismatch');
  });
});

describe('R2IcebergObjectStore immutable writes', () => {
  it('creates an immutable object with its logical identity and digest', async () => {
    const r2 = bucket();
    r2.put.mockResolvedValue({ key: OBJECT });
    const store = new R2IcebergObjectStore(r2, TABLE);
    const bytes = Uint8Array.from([1, 2, 3]);

    await store.putImmutable(OBJECT, bytes, 'batch-1:schema-1');

    expect(r2.put).toHaveBeenCalledOnce();
    const [key, body, options] = r2.put.mock.calls[0] as unknown as [
      string,
      ArrayBuffer,
      {
        onlyIf: { etagDoesNotMatch: string };
        customMetadata: Record<string, string>;
        sha256: ArrayBuffer;
      },
    ];
    expect(key).toBe('tenant-a/table/data/part-1.parquet');
    expect(new Uint8Array(body)).toEqual(bytes);
    expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' });
    expect(options.customMetadata).toEqual({
      authrim_identity: 'batch-1:schema-1',
      authrim_sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
    });
    expect(new Uint8Array(options.sha256)).toHaveLength(32);
    expect(r2.head).not.toHaveBeenCalled();
  });

  it('accepts a retry only when the existing immutable object has matching identity and size', async () => {
    const r2 = bucket();
    r2.put.mockResolvedValue(null);
    r2.head.mockResolvedValue({
      size: 3,
      customMetadata: { authrim_identity: 'batch-1:schema-1' },
    });
    const store = new R2IcebergObjectStore(r2, TABLE);

    await expect(
      store.putImmutable(OBJECT, Uint8Array.from([1, 2, 3]), 'batch-1:schema-1')
    ).resolves.toBeUndefined();
    expect(r2.head).toHaveBeenCalledExactlyOnceWith('tenant-a/table/data/part-1.parquet');
  });

  it.each([
    null,
    { size: 3, customMetadata: { authrim_identity: 'other-batch' } },
    { size: 2, customMetadata: { authrim_identity: 'batch-1:schema-1' } },
  ])('rejects an immutable collision instead of silently adopting it: %#', async (existing) => {
    const r2 = bucket();
    r2.put.mockResolvedValue(null);
    r2.head.mockResolvedValue(existing);
    const store = new R2IcebergObjectStore(r2, TABLE);

    await expect(
      store.putImmutable(OBJECT, Uint8Array.from([1, 2, 3]), 'batch-1:schema-1')
    ).rejects.toBeInstanceOf(IcebergBatchCollisionError);
  });
});
