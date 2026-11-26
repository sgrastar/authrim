import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOG_CHUNK_WRITE_CLAIM_LEASE_MS,
  LogChunkWriteClaimActiveError,
  encryptLogChunkBody,
  writeLogChunkToR2,
} from '../r2-chunk-writer';
import type { LogChunkCatalogStore, LogObjectCatalogRow, WriteLogChunkInput } from '../types';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const T = 1_700_000_000_000;
const key32 = new Uint8Array(32).fill(7);

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

function store(overrides: Partial<LogChunkCatalogStore> = {}) {
  const methods = {
    createPendingObject: vi.fn(async (_row: LogObjectCatalogRow) => true),
    createPendingRecordIndexes: vi.fn(async (_rows: unknown[]) => undefined),
    commitObject: vi.fn(async (_id: string, _update: unknown) => undefined),
    commitRecordIndexes: vi.fn(async (_id: string, _at: number) => undefined),
    markObjectOrphanCandidate: vi.fn(async (_id: string, _at: number) => undefined),
  };
  return { ...methods, ...overrides } as typeof methods & Partial<LogChunkCatalogStore>;
}

function bucket() {
  const put = vi.fn(async (_key: string, _body: unknown, _options?: unknown) => undefined);
  return { put, bucket: { put } as unknown as R2Bucket };
}

function input(
  target: ReturnType<typeof bucket>,
  overrides: Partial<WriteLogChunkInput> = {}
): WriteLogChunkInput {
  return {
    bucket: target.bucket,
    tenantKey: 't_1',
    logType: 'audit',
    plane: 'archive',
    now: T,
    chunkId: 'chk_fixed',
    objectCatalogId: 'obj_fixed',
    shard: 's00',
    records: [
      { id: 'a', eventAt: T, payload: { id: 'a' }, indexedFields: { result: 'ok', secret: 'no' } },
      { id: 'b', eventAt: T + 1, payload: { id: 'b' } },
    ],
    encryption: { keyBytes: key32, encryptionScope: 'tenant:t_1:audit:archive', keyVersion: 3 },
    ...overrides,
  };
}

describe('LogChunkWriteClaimActiveError', () => {
  it('says why, when to retry and what caused it', () => {
    const cause = new Error('inner');
    const error = new LogChunkWriteClaimActiveError(1234, { cause });
    expect(error.name).toBe('LogChunkWriteClaimActiveError');
    expect(error.message).toBe('log_chunk_write_in_progress_or_conflicted');
    expect(error.retryAt).toBe(1234);
    expect(error.cause).toBe(cause);
    expect(LOG_CHUNK_WRITE_CLAIM_LEASE_MS).toBe(60_000);
  });
});

describe('encryptLogChunkBody', () => {
  const options = {
    keyBytes: key32,
    encryptionScope: 'tenant:t_1:audit:archive',
    keyVersion: 3,
    tenantKey: 't_1',
    logType: 'audit',
    plane: 'archive',
    objectKey: 'logs/x.bin',
    chunkId: 'chk_1',
    compression: 'none' as const,
  };

  it('refuses a key that is not 32 bytes', async () => {
    for (const length of [0, 16, 31, 33, 64]) {
      await expect(
        encryptLogChunkBody(new Uint8Array([1]), { ...options, keyBytes: new Uint8Array(length) })
      ).rejects.toThrow('log_chunk_encryption_key_must_be_32_bytes');
    }
    await expect(encryptLogChunkBody(new Uint8Array([1]), options)).resolves.toBeDefined();
  });

  it('writes a JSON envelope that only the same key and context can open', async () => {
    const plaintext = new TextEncoder().encode('hello chunk');
    const body = await encryptLogChunkBody(plaintext, options);
    const envelope = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      version: 1,
      algorithm: 'AES-256-GCM',
      contentType: 'application/authrim.log-chunk+jsonl',
      compression: 'none',
      encryptionScope: 'tenant:t_1:audit:archive',
      keyVersion: 3,
    });
    const bytes = (value: unknown): Uint8Array<ArrayBuffer> => {
      const binary = atob(String(value).replaceAll('-', '+').replaceAll('_', '/'));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    };
    const key = await crypto.subtle.importKey('raw', key32, 'AES-GCM', false, ['decrypt']);
    const aad = new TextEncoder().encode(
      '{"tenant_key":"t_1","log_type":"audit","plane":"archive","object_key":"logs/x.bin","chunk_id":"chk_1","compression":"none","encryption_scope":"tenant:t_1:audit:archive","key_version":3}'
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(envelope.iv), additionalData: aad, tagLength: 128 },
      key,
      bytes(envelope.ciphertext)
    );
    expect(new TextDecoder().decode(decrypted)).toBe('hello chunk');
    expect(bytes(envelope.iv)).toHaveLength(12);
  });

  it('writes URL-safe base64 without padding', async () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(0xfb);
        return array;
      }
    );
    const body = await encryptLogChunkBody(new Uint8Array(), options);
    const envelope = JSON.parse(new TextDecoder().decode(body)) as {
      iv: string;
      ciphertext: string;
    };
    expect(envelope.iv).toBe('-_v7'.repeat(4));
    expect(envelope.ciphertext).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('writeLogChunkToR2: what it refuses', () => {
  it('needs records, a known log type and plane, and encryption unless plaintext is allowed', async () => {
    const target = bucket();
    await expect(writeLogChunkToR2(input(target, { records: [] }))).rejects.toThrow(
      'log_chunk_records_required'
    );
    await expect(writeLogChunkToR2(input(target, { logType: 'nope' as never }))).rejects.toThrow(
      'unsupported_log_type:nope'
    );
    await expect(writeLogChunkToR2(input(target, { plane: 'nope' as never }))).rejects.toThrow(
      'unsupported_log_plane:nope'
    );
    for (const allowPlaintext of [undefined, false]) {
      await expect(
        writeLogChunkToR2(input(target, { encryption: undefined, allowPlaintext }))
      ).rejects.toThrow('log_chunk_encryption_required');
    }
    expect(target.put).not.toHaveBeenCalled();
    await expect(
      writeLogChunkToR2(input(target, { encryption: undefined, allowPlaintext: true }))
    ).resolves.toBeDefined();
    await expect(
      writeLogChunkToR2(input(target, { allowPlaintext: false }))
    ).resolves.toBeDefined();
  });
});

describe('writeLogChunkToR2: what it writes', () => {
  it('stores an encrypted chunk with its metadata, and reports it', async () => {
    const target = bucket();
    const result = await writeLogChunkToR2(input(target, { compression: 'gzip_block' }));
    const [objectKey, body, options] = must(target.put.mock.calls[0]);
    expect(result).toMatchObject({
      chunkId: 'chk_fixed',
      objectCatalogId: 'obj_fixed',
      objectKey,
      shard: 's00',
      recordCount: 2,
      byteCount: (body as Uint8Array).byteLength,
      compression: 'gzip_block',
      encryptionScope: 'tenant:t_1:audit:archive',
      keyVersion: 3,
      createdAt: T,
    });
    expect(result.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    const digest = await crypto.subtle.digest('SHA-256', body as Uint8Array<ArrayBuffer>);
    expect(result.checksumSha256).toBe(
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    );
    expect(options).toStrictEqual({
      httpMetadata: {
        contentType: 'application/authrim.log-chunk+encrypted',
        contentEncoding: undefined,
      },
      customMetadata: {
        tenantKey: 't_1',
        logType: 'audit',
        plane: 'archive',
        recordCount: '2',
        checksumSha256: result.checksumSha256,
        compression: 'gzip_block',
        shard: 's00',
        encryptionScope: 'tenant:t_1:audit:archive',
        keyVersion: '3',
        createdAt: String(T),
      },
    });
  });

  it('stores a plaintext chunk as NDJSON, marked gzip only when it is', async () => {
    const gzip = bucket();
    await writeLogChunkToR2(input(gzip, { encryption: undefined, allowPlaintext: true }));
    const gzipOptions = must(gzip.put.mock.calls[0])[2] as {
      httpMetadata: unknown;
      customMetadata: Record<string, string>;
    };
    expect(gzipOptions.httpMetadata).toStrictEqual({
      contentType: 'application/x-ndjson',
      contentEncoding: 'gzip',
    });
    expect(gzipOptions.customMetadata.compression).toBe('gzip_block');
    expect(gzipOptions.customMetadata).not.toHaveProperty('encryptionScope');
    expect(gzipOptions.customMetadata).not.toHaveProperty('keyVersion');

    const plain = bucket();
    const result = await writeLogChunkToR2(
      input(plain, { encryption: undefined, allowPlaintext: true, compression: 'none' })
    );
    expect(must(plain.put.mock.calls[0])[2]).toMatchObject({
      httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: undefined },
    });
    expect(new TextDecoder().decode(must(plain.put.mock.calls[0])[1] as Uint8Array)).toBe(
      '{"id":"a"}\n{"id":"b"}'
    );
    expect(result.encryptionScope).toBeUndefined();
    expect(result.keyVersion).toBeUndefined();
  });

  it('names its ids from the time, and its shard from the tenant, when none are given', async () => {
    const target = bucket();
    const result = await writeLogChunkToR2(
      input(target, {
        chunkId: undefined,
        objectCatalogId: undefined,
        shard: undefined,
        now: 0x0123456789ab,
      })
    );
    expect(result.chunkId).toMatch(/^chk_01234567-89ab-7/);
    expect(result.objectCatalogId).toMatch(/^obj_01234567-89ab-7/);
    expect(result.shard).toMatch(/^shard-\d+$/);
    expect(result.compression).toBe('gzip_block');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T + 42));
    const clocked = await writeLogChunkToR2(input(target, { now: undefined }));
    expect(clocked.createdAt).toBe(T + 42);
  });
});

describe('writeLogChunkToR2: the catalog', () => {
  it('records the pending object, the pending index and the commit in order', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T + 5_000);
    const target = bucket();
    const catalog = store();
    const calls: string[] = [];
    catalog.createPendingObject.mockImplementation(async () => {
      calls.push('object');
      return true;
    });
    catalog.createPendingRecordIndexes.mockImplementation(async () => {
      calls.push('indexes');
    });
    target.put.mockImplementation(async () => {
      calls.push('put');
    });
    catalog.commitObject.mockImplementation(async () => {
      calls.push('commit');
    });
    catalog.commitRecordIndexes.mockImplementation(async () => {
      calls.push('commit-indexes');
    });
    const result = await writeLogChunkToR2(
      input(target, { catalogStore: catalog, surface: 'admin', compression: 'none' })
    );
    expect(calls).toEqual(['object', 'indexes', 'put', 'commit', 'commit-indexes']);
    const row = must(catalog.createPendingObject.mock.calls[0])[0];
    expect(row).toStrictEqual({
      id: 'obj_fixed',
      tenantKey: 't_1',
      logType: 'audit',
      plane: 'archive',
      surface: 'admin',
      objectKey: result.objectKey,
      objectKind: 'chunk',
      status: 'pending',
      recordCount: 2,
      byteCount: result.byteCount,
      compression: 'none',
      encryptionScope: 'tenant:t_1:audit:archive',
      keyVersion: 3,
      createdAt: T,
      claimLeaseUntil: T + 5_000 + 60_000,
    });
    expect(catalog.commitObject).toHaveBeenCalledWith('obj_fixed', {
      byteCount: result.byteCount,
      checksumSha256: result.checksumSha256,
      committedAt: T + 5_000,
    });
    expect(catalog.commitRecordIndexes).toHaveBeenCalledWith('obj_fixed', T + 5_000);
  });

  it('indexes each record by its place in the chunk and the fields its profile allows', async () => {
    const target = bucket();
    const catalog = store();
    await writeLogChunkToR2(
      input(target, { catalogStore: catalog, compression: 'none', surface: 'admin' })
    );
    const rows = must(catalog.createPendingRecordIndexes.mock.calls[0])[0] as Array<
      Record<string, unknown>
    >;
    expect(rows).toStrictEqual([
      {
        recordId: 'a',
        tenantKey: 't_1',
        logType: 'audit',
        plane: 'archive',
        surface: 'admin',
        objectCatalogId: 'obj_fixed',
        chunkId: 'chk_fixed',
        lineNumber: 0,
        blockOffset: 0,
        blockLength: 21,
        recordOffset: 0,
        recordLength: 10,
        eventAt: T,
        indexProfile: 'audit',
        indexedFields: { result: 'ok' },
        status: 'pending',
        createdAt: T,
      },
      {
        recordId: 'b',
        tenantKey: 't_1',
        logType: 'audit',
        plane: 'archive',
        surface: 'admin',
        objectCatalogId: 'obj_fixed',
        chunkId: 'chk_fixed',
        lineNumber: 1,
        blockOffset: 0,
        blockLength: 21,
        recordOffset: 11,
        recordLength: 10,
        eventAt: T + 1,
        indexProfile: 'audit',
        indexedFields: undefined,
        status: 'pending',
        createdAt: T,
      },
    ]);
  });

  it('uses the named index profile, or the one of the log type', async () => {
    const target = bucket();
    const catalog = store();
    await writeLogChunkToR2(input(target, { catalogStore: catalog, indexProfile: 'normal' }));
    const rows = must(catalog.createPendingRecordIndexes.mock.calls[0])[0] as Array<{
      indexProfile: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.indexProfile === 'normal')).toBe(true);
  });

  it('writes a row archive with its catalog fields and no record index', async () => {
    const target = bucket();
    const catalog = store();
    await writeLogChunkToR2(
      input(target, {
        catalogStore: catalog,
        rowArchive: {
          sourceTable: 'audit_log',
          firstEventAt: 1,
          lastEventAt: 2,
          maxExpiresAt: null,
          neverExpires: true,
        },
      })
    );
    expect(must(catalog.createPendingObject.mock.calls[0])[0].rowArchive).toStrictEqual({
      sourceTable: 'audit_log',
      firstEventAt: 1,
      lastEventAt: 2,
      maxExpiresAt: null,
      neverExpires: true,
      chunkId: 'chk_fixed',
    });
    expect(catalog.createPendingRecordIndexes).toHaveBeenCalledWith([]);
    const plain = store();
    await writeLogChunkToR2(input(target, { catalogStore: plain }));
    expect(must(plain.createPendingObject.mock.calls[0])[0]).not.toHaveProperty('rowArchive');
  });
});

describe('writeLogChunkToR2: a chunk that already has a catalog row', () => {
  function existing(overrides: Partial<LogObjectCatalogRow> = {}): LogObjectCatalogRow {
    return {
      id: 'obj_fixed',
      tenantKey: 't_1',
      logType: 'audit',
      plane: 'archive',
      objectKey: 'will-be-replaced',
      objectKind: 'chunk',
      status: 'pending',
      recordCount: 2,
      byteCount: 10,
      compression: 'none',
      encryptionScope: 'tenant:t_1:audit:archive',
      keyVersion: 3,
      createdAt: T,
      ...overrides,
    };
  }

  async function run(
    row: LogObjectCatalogRow | null,
    extra: Partial<LogChunkCatalogStore> = {},
    options: Partial<WriteLogChunkInput> = {}
  ) {
    const target = bucket();
    const getObject = vi.fn(async (_id: string): Promise<LogObjectCatalogRow | null> => row);
    const catalog = store({
      createPendingObject: vi.fn(async () => false),
      getObject,
      ...extra,
    });
    // The object key does not depend on the catalog, so learn it from a first write.
    const probe = bucket();
    const probed = await writeLogChunkToR2(input(probe, { compression: 'none', ...options }));
    const matching = row ? { ...row, objectKey: probed.objectKey } : null;
    getObject.mockImplementation(async () => matching);
    return {
      target,
      catalog,
      getObject,
      probed,
      promise: () =>
        writeLogChunkToR2(
          input(target, { catalogStore: catalog, compression: 'none', ...options })
        ),
    };
  }

  it('refuses when the row cannot be read or describes another chunk', async () => {
    const conflict = 'log_chunk_write_in_progress_or_conflicted';
    const missing = await run(null);
    const missingFailure = await missing.promise().catch((error: unknown) => error);
    expect(missingFailure).not.toBeInstanceOf(LogChunkWriteClaimActiveError);
    expect((missingFailure as Error).message).toBe(conflict);
    for (const change of [
      { tenantKey: 't_2' },
      { logType: 'security' as const },
      { plane: 'primary' as const },
      { surface: 'other' },
      { objectKey: 'other-key' },
      { recordCount: 3 },
      { compression: 'gzip_block' as const },
      { encryptionScope: 'other' },
      { keyVersion: 9 },
    ]) {
      const f = await run(existing(change));
      if ('objectKey' in change) {
        const row = await f.getObject('obj_fixed');
        f.getObject.mockImplementation(async () => (row ? { ...row, ...change } : null));
      }
      const failure = await f.promise().catch((error: unknown) => error);
      // A row that describes another chunk is a conflict, not a claim held by another writer.
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(LogChunkWriteClaimActiveError);
      expect((failure as Error).message).toBe(conflict);
      expect(f.target.put).not.toHaveBeenCalled();
      expect(f.catalog.markObjectOrphanCandidate).not.toHaveBeenCalled();
    }
  });

  it('returns a committed chunk as it was, after committing its indexes again', async () => {
    const f = await run(
      existing({ status: 'committed', checksumSha256: 'c'.repeat(64), byteCount: 77 })
    );
    const result = await f.promise();
    expect(result).toStrictEqual({
      chunkId: 'chk_fixed',
      objectCatalogId: 'obj_fixed',
      objectKey: f.probed.objectKey,
      shard: 's00',
      recordCount: 2,
      byteCount: 77,
      checksumSha256: 'c'.repeat(64),
      compression: 'none',
      encryptionScope: 'tenant:t_1:audit:archive',
      keyVersion: 3,
      createdAt: T,
    });
    expect(f.catalog.commitRecordIndexes).toHaveBeenCalledTimes(1);
    expect(f.target.put).not.toHaveBeenCalled();
  });

  it('does not take a pending row for a committed chunk, even if it carries a checksum', async () => {
    const f = await run(
      existing({ status: 'pending', checksumSha256: 'c'.repeat(64), byteCount: 77 }),
      {
        reclaimExpiredPendingObject: vi.fn(async () => true),
      }
    );
    const result = await f.promise();
    expect(f.target.put).toHaveBeenCalledTimes(1);
    expect(result.byteCount).not.toBe(77);
    expect(result.checksumSha256).not.toBe('c'.repeat(64));
  });

  it('writes again over an orphan or an expired pending write that it manages to reclaim', async () => {
    const orphan = await run(existing({ status: 'orphan_candidate' }), {
      reclaimOrphanObject: vi.fn(async () => true),
    });
    await expect(orphan.promise()).resolves.toBeDefined();
    expect(orphan.catalog.reclaimOrphanObject).toHaveBeenCalledWith(
      'obj_fixed',
      expect.any(Number)
    );
    expect(orphan.target.put).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T + 9_000);
    const pending = await run(existing({ status: 'pending' }), {
      reclaimExpiredPendingObject: vi.fn(async () => true),
    });
    await expect(pending.promise()).resolves.toBeDefined();
    expect(pending.catalog.reclaimExpiredPendingObject).toHaveBeenCalledWith(
      'obj_fixed',
      T + 9_000,
      T + 9_000 + 60_000
    );
  });

  it('tells the caller when to retry if another writer holds the claim', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T + 1_000);
    const held = await run(existing({ status: 'pending', claimLeaseUntil: T + 30_000 }), {
      reclaimExpiredPendingObject: vi.fn(async () => false),
    });
    const failure = await held.promise().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LogChunkWriteClaimActiveError);
    expect((failure as LogChunkWriteClaimActiveError).retryAt).toBe(T + 30_000);
    const noLease = await run(existing({ status: 'pending' }), {});
    const other = await noLease.promise().catch((error: unknown) => error);
    expect((other as LogChunkWriteClaimActiveError).retryAt).toBe(T + 1_000 + 60_000);
    const orphanHeld = await run(existing({ status: 'orphan_candidate' }), {
      reclaimOrphanObject: vi.fn(async () => false),
      reclaimExpiredPendingObject: vi.fn(async () => true),
    });
    await expect(orphanHeld.promise()).rejects.toBeInstanceOf(LogChunkWriteClaimActiveError);
    const committedNoChecksum = await run(existing({ status: 'committed' }), {
      reclaimOrphanObject: vi.fn(async () => true),
      reclaimExpiredPendingObject: vi.fn(async () => true),
    });
    await expect(committedNoChecksum.promise()).rejects.toBeInstanceOf(
      LogChunkWriteClaimActiveError
    );
  });
});

describe('writeLogChunkToR2: a failed write', () => {
  it('marks the object an orphan candidate and passes the error on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T + 7_000);
    const target = bucket();
    target.put.mockRejectedValueOnce(new Error('r2_down'));
    const catalog = store();
    await expect(writeLogChunkToR2(input(target, { catalogStore: catalog }))).rejects.toThrow(
      'r2_down'
    );
    expect(catalog.markObjectOrphanCandidate).toHaveBeenCalledWith('obj_fixed', T + 7_000);
    expect(catalog.commitObject).not.toHaveBeenCalled();
  });

  it('reports a claim that may still be held when even the marking fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T + 7_000);
    const target = bucket();
    target.put.mockRejectedValueOnce(new Error('r2_down'));
    const cleanup = new Error('d1_down');
    const catalog = store({
      markObjectOrphanCandidate: vi.fn(() => Promise.reject(cleanup)),
    });
    const failure = await writeLogChunkToR2(input(target, { catalogStore: catalog })).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(LogChunkWriteClaimActiveError);
    expect((failure as LogChunkWriteClaimActiveError).retryAt).toBe(T + 7_000 + 60_000);
    expect((failure as LogChunkWriteClaimActiveError).cause).toBe(cleanup);
  });

  it('keeps a committed object that failed afterwards, committing no orphan mark', async () => {
    const target = bucket();
    const catalog = store();
    catalog.commitRecordIndexes.mockRejectedValueOnce(new Error('index_commit_failed'));
    await expect(writeLogChunkToR2(input(target, { catalogStore: catalog }))).rejects.toThrow(
      'index_commit_failed'
    );
    expect(catalog.markObjectOrphanCandidate).not.toHaveBeenCalled();
    expect(catalog.commitObject).toHaveBeenCalledTimes(1);
  });
});
