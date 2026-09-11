import { describe, expect, it, vi } from 'vitest';
import { decodeStoredLogChunkRecord } from '../r2-chunk-reader';
import { writeLogChunkToR2 } from '../r2-chunk-writer';
import { normalizeR2Prefix } from '../r2-keys';
import type { LogChunkCatalogStore } from '../types';

function testEncryption(tenantKey = 't_safeopaque', logType = 'audit', plane = 'archive') {
  return {
    keyBytes: new Uint8Array(32).fill(7),
    encryptionScope: `tenant:${tenantKey}:${logType}:${plane}`,
    keyVersion: 1,
  };
}

describe('writeLogChunkToR2', () => {
  it('sanitizes unsafe R2 prefix segments', () => {
    expect(normalizeR2Prefix('/../logs v1//tenant/../../evil\u0000/')).toBe('logs_v1/tenant/evil_');
    expect(normalizeR2Prefix('///')).toBe('logs');
  });

  it('requires encryption by default to avoid plaintext R2 log chunks', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await expect(
      writeLogChunkToR2({
        bucket,
        tenantKey: 't_safeopaque',
        logType: 'audit',
        plane: 'archive',
        records: [{ id: 'evt-1', eventAt: 1, payload: { id: 'evt-1' } }],
      })
    ).rejects.toThrow('log_chunk_encryption_required');
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('writes a single immutable gzip JSONL chunk without raw tenant id in the key', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const result = await writeLogChunkToR2({
      bucket,
      tenantKey: 't_safeopaque',
      logType: 'audit',
      plane: 'archive',
      prefix: 'audit',
      now: 1_700_000_000_000,
      encryption: testEncryption(),
      records: [
        {
          id: 'evt-1',
          eventAt: 1_700_000_000_000,
          payload: { id: 'evt-1', tenantId: 'tenant-raw' },
          indexedFields: { eventType: 'auth.login' },
        },
      ],
    });

    expect(bucket.put).toHaveBeenCalledOnce();
    expect(result.objectKey).toContain('/t_safeopaque/archive/audit/2023/11/14/22/');
    expect(result.objectKey).toContain('.jsonl.gz');
    expect(result.objectKey).not.toContain('tenant-raw');
    expect(result.recordCount).toBe(1);
    expect(result.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((bucket.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        customMetadata: expect.objectContaining({
          tenantKey: 't_safeopaque',
          logType: 'audit',
          plane: 'archive',
          recordCount: '1',
        }),
      })
    );
  });

  it('keeps archive surface in metadata while using the canonical shard key layout', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const result = await writeLogChunkToR2({
      bucket,
      tenantKey: 't_safeopaque',
      logType: 'admin_audit',
      plane: 'archive',
      surface: 'storage_destinations',
      prefix: 'logs/v1',
      now: Date.UTC(2026, 4, 20, 10, 0, 0),
      encryption: testEncryption('t_safeopaque', 'admin_audit'),
      records: [{ id: 'evt-1', eventAt: 1, payload: { id: 'evt-1' } }],
    });

    expect(result.objectKey).toMatch(
      /^logs\/v1\/t_safeopaque\/archive\/admin_audit\/2026\/05\/20\/10\/shard-\d\d\/chk_[^/]+\.jsonl\.gz$/u
    );
    expect(result.objectKey).not.toContain('/storage_destinations/');
  });

  it('uses the catalog pending/commit protocol around R2 writes', async () => {
    const calls: string[] = [];
    const catalogStore: LogChunkCatalogStore = {
      createPendingObject: vi.fn(async () => {
        calls.push('pending_object');
      }),
      createPendingRecordIndexes: vi.fn(async () => {
        calls.push('pending_indexes');
      }),
      commitObject: vi.fn(async () => {
        calls.push('commit_object');
      }),
      commitRecordIndexes: vi.fn(async () => {
        calls.push('commit_indexes');
      }),
      markObjectOrphanCandidate: vi.fn(),
    };
    const bucket = {
      put: vi.fn(async () => {
        calls.push('put');
      }),
    } as unknown as R2Bucket;

    await writeLogChunkToR2({
      bucket,
      tenantKey: 't_safeopaque',
      logType: 'audit',
      plane: 'archive',
      records: [{ id: 'evt-1', eventAt: 1, payload: { id: 'evt-1' } }],
      catalogStore,
      encryption: testEncryption(),
    });

    expect(calls).toEqual([
      'pending_object',
      'pending_indexes',
      'put',
      'commit_object',
      'commit_indexes',
    ]);
  });

  it('allows only one R2 writer for the same stable catalog identity', async () => {
    let objectRow: Parameters<LogChunkCatalogStore['createPendingObject']>[0] | null = null;
    let releasePut: (() => void) | undefined;
    let notifyPutStarted: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve;
    });
    const catalogStore: LogChunkCatalogStore = {
      createPendingObject: vi.fn(async (row) => {
        if (objectRow) {
          return false;
        }
        objectRow = row;
        return true;
      }),
      getObject: vi.fn(async () => objectRow),
      createPendingRecordIndexes: vi.fn(),
      commitObject: vi.fn(async (_id, update) => {
        if (objectRow) {
          objectRow = {
            ...objectRow,
            status: 'committed',
            byteCount: update.byteCount,
            checksumSha256: update.checksumSha256,
            committedAt: update.committedAt,
          };
        }
      }),
      commitRecordIndexes: vi.fn(),
      markObjectOrphanCandidate: vi.fn(),
    };
    const bucket = {
      put: vi.fn(async () => {
        notifyPutStarted?.();
        await new Promise<void>((resolve) => {
          releasePut = resolve;
        });
      }),
    } as unknown as R2Bucket;
    const input = {
      bucket,
      tenantKey: 't_safeopaque',
      logType: 'audit' as const,
      plane: 'archive' as const,
      records: [{ id: 'evt-stable', eventAt: 1, payload: { id: 'evt-stable' } }],
      catalogStore,
      encryption: testEncryption(),
      now: 1_700_000_000_000,
      chunkId: 'chk_stable',
      objectCatalogId: 'obj_stable',
    };

    const first = writeLogChunkToR2(input);
    await putStarted;
    await expect(writeLogChunkToR2(input)).rejects.toThrow(
      'log_chunk_write_in_progress_or_conflicted'
    );
    expect(bucket.put).toHaveBeenCalledOnce();
    releasePut?.();
    await expect(first).resolves.toEqual(
      expect.objectContaining({ chunkId: 'chk_stable', objectCatalogId: 'obj_stable' })
    );
  });

  it('reclaims an orphaned stable archive claim after a transient write failure', async () => {
    let objectRow: Parameters<LogChunkCatalogStore['createPendingObject']>[0] | null = null;
    let indexStatus: 'pending' | 'committed' | 'deleted' | undefined;
    const catalogStore: LogChunkCatalogStore = {
      createPendingObject: vi.fn(async (row) => {
        if (objectRow) {
          return false;
        }
        objectRow = row;
        return true;
      }),
      getObject: vi.fn(async () => objectRow),
      reclaimOrphanObject: vi.fn(async () => {
        if (!objectRow || objectRow.status !== 'orphan_candidate') {
          return false;
        }
        objectRow = { ...objectRow, status: 'pending', committedAt: undefined };
        return true;
      }),
      createPendingRecordIndexes: vi.fn(async () => {
        indexStatus = 'pending';
      }),
      commitObject: vi.fn(async (_id, update) => {
        if (objectRow) {
          objectRow = {
            ...objectRow,
            status: 'committed',
            byteCount: update.byteCount,
            checksumSha256: update.checksumSha256,
            committedAt: update.committedAt,
          };
        }
      }),
      commitRecordIndexes: vi.fn(async () => {
        indexStatus = 'committed';
      }),
      markObjectOrphanCandidate: vi.fn(async () => {
        if (objectRow?.status === 'pending') {
          objectRow = { ...objectRow, status: 'orphan_candidate' };
          indexStatus = 'deleted';
        }
      }),
    };
    const bucket = {
      put: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient_r2_failure'))
        .mockResolvedValueOnce(undefined),
    } as unknown as R2Bucket;
    const input = {
      bucket,
      tenantKey: 't_safeopaque',
      logType: 'audit' as const,
      plane: 'archive' as const,
      records: [{ id: 'evt-retry', eventAt: 1, payload: { id: 'evt-retry' } }],
      catalogStore,
      encryption: testEncryption(),
      now: 1_700_000_000_000,
      chunkId: 'chk_retry',
      objectCatalogId: 'obj_retry',
    };

    await expect(writeLogChunkToR2(input)).rejects.toThrow('transient_r2_failure');
    expect(objectRow).toEqual(expect.objectContaining({ status: 'orphan_candidate' }));
    expect(indexStatus).toBe('deleted');

    await expect(writeLogChunkToR2(input)).resolves.toEqual(
      expect.objectContaining({ chunkId: 'chk_retry', objectCatalogId: 'obj_retry' })
    );
    expect(catalogStore.reclaimOrphanObject).toHaveBeenCalledOnce();
    expect(bucket.put).toHaveBeenCalledTimes(2);
    expect(objectRow).toEqual(
      expect.objectContaining({ status: 'committed', checksumSha256: expect.any(String) })
    );
    expect(indexStatus).toBe('committed');
  });

  it('finishes pending indexes on replay after the object commit succeeded', async () => {
    let objectRow: Parameters<LogChunkCatalogStore['createPendingObject']>[0] | null = null;
    let indexStatus: 'pending' | 'committed' | 'deleted' | undefined;
    const catalogStore: LogChunkCatalogStore = {
      createPendingObject: vi.fn(async (row) => {
        if (objectRow) return false;
        objectRow = row;
        return true;
      }),
      getObject: vi.fn(async () => objectRow),
      createPendingRecordIndexes: vi.fn(async () => {
        indexStatus = 'pending';
      }),
      commitObject: vi.fn(async (_id, update) => {
        if (objectRow) {
          objectRow = {
            ...objectRow,
            status: 'committed',
            byteCount: update.byteCount,
            checksumSha256: update.checksumSha256,
            committedAt: update.committedAt,
          };
        }
      }),
      commitRecordIndexes: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient_index_commit_failure'))
        .mockImplementationOnce(async () => {
          indexStatus = 'committed';
        }),
      markObjectOrphanCandidate: vi.fn(async () => {
        indexStatus = 'deleted';
      }),
    };
    const bucket = { put: vi.fn().mockResolvedValue(undefined) } as unknown as R2Bucket;
    const input = {
      bucket,
      tenantKey: 't_safeopaque',
      logType: 'audit' as const,
      plane: 'archive' as const,
      records: [{ id: 'evt-index-retry', eventAt: 1, payload: { id: 'evt-index-retry' } }],
      catalogStore,
      encryption: testEncryption(),
      now: 1_700_000_000_000,
      chunkId: 'chk_index_retry',
      objectCatalogId: 'obj_index_retry',
    };

    await expect(writeLogChunkToR2(input)).rejects.toThrow('transient_index_commit_failure');
    expect(objectRow).toEqual(expect.objectContaining({ status: 'committed' }));
    expect(indexStatus).toBe('pending');
    expect(catalogStore.markObjectOrphanCandidate).not.toHaveBeenCalled();

    await expect(writeLogChunkToR2(input)).resolves.toEqual(
      expect.objectContaining({ objectCatalogId: 'obj_index_retry' })
    );
    expect(bucket.put).toHaveBeenCalledOnce();
    expect(catalogStore.commitRecordIndexes).toHaveBeenCalledTimes(2);
    expect(indexStatus).toBe('committed');
  });

  it('stores block offsets for record-level lookup indexes', async () => {
    let indexRows: Parameters<LogChunkCatalogStore['createPendingRecordIndexes']>[0] = [];
    const catalogStore: LogChunkCatalogStore = {
      createPendingObject: vi.fn(),
      createPendingRecordIndexes: vi.fn(async (rows) => {
        indexRows = rows;
      }),
      commitObject: vi.fn(),
      commitRecordIndexes: vi.fn(),
      markObjectOrphanCandidate: vi.fn(),
    };
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    await writeLogChunkToR2({
      bucket,
      tenantKey: 't_safeopaque',
      logType: 'audit',
      plane: 'archive',
      records: [
        { id: 'evt-1', eventAt: 1, payload: { id: 'evt-1' } },
        { id: 'evt-2', eventAt: 2, payload: { id: 'evt-2' } },
      ],
      catalogStore,
      encryption: testEncryption(),
    });

    expect(indexRows).toHaveLength(2);
    expect(indexRows[0]).toEqual(
      expect.objectContaining({
        blockOffset: expect.any(Number),
        blockLength: expect.any(Number),
        recordOffset: expect.any(Number),
        recordLength: expect.any(Number),
      })
    );
  });

  it('stores encrypted chunk envelopes when application encryption is configured', async () => {
    let objectRow: Parameters<LogChunkCatalogStore['createPendingObject']>[0] | null = null;
    let indexRows: Parameters<LogChunkCatalogStore['createPendingRecordIndexes']>[0] = [];
    const catalogStore: LogChunkCatalogStore = {
      createPendingObject: vi.fn(async (row) => {
        objectRow = row;
      }),
      createPendingRecordIndexes: vi.fn(async (rows) => {
        indexRows = rows;
      }),
      commitObject: vi.fn(),
      commitRecordIndexes: vi.fn(),
      markObjectOrphanCandidate: vi.fn(),
    };
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;

    const result = await writeLogChunkToR2({
      bucket,
      tenantKey: 't_safeopaque',
      logType: 'admin_audit',
      plane: 'archive',
      records: [{ id: 'adm-1', eventAt: 1, payload: { id: 'adm-1' } }],
      catalogStore,
      encryption: {
        keyBytes: new Uint8Array(32).fill(7),
        encryptionScope: 'tenant:t_safeopaque:admin_audit:archive',
        keyVersion: 3,
      },
      now: 1_700_000_000_000,
    });

    const [, storedBody, options] = (bucket.put as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const envelope = JSON.parse(new TextDecoder().decode(storedBody as Uint8Array)) as {
      algorithm: string;
      encryptionScope: string;
      keyVersion: number;
      ciphertext: string;
    };

    expect(envelope).toMatchObject({
      algorithm: 'AES-256-GCM',
      encryptionScope: 'tenant:t_safeopaque:admin_audit:archive',
      keyVersion: 3,
    });
    expect(envelope.ciphertext).toBeTruthy();
    expect(new TextDecoder().decode(storedBody as Uint8Array)).not.toContain('adm-1');
    expect(options).toEqual(
      expect.objectContaining({
        httpMetadata: { contentType: 'application/authrim.log-chunk+encrypted' },
        customMetadata: expect.objectContaining({
          encryptionScope: 'tenant:t_safeopaque:admin_audit:archive',
          keyVersion: '3',
        }),
      })
    );
    expect(objectRow).toMatchObject({
      encryptionScope: 'tenant:t_safeopaque:admin_audit:archive',
      keyVersion: 3,
    });
    expect(result).toMatchObject({
      encryptionScope: 'tenant:t_safeopaque:admin_audit:archive',
      keyVersion: 3,
    });
    await expect(
      decodeStoredLogChunkRecord({
        storedBody: storedBody as Uint8Array,
        compression: 'gzip_block',
        recordIndex: indexRows[0]!,
        encryption: {
          keyBytes: new Uint8Array(32).fill(7),
          tenantKey: 't_safeopaque',
          logType: 'admin_audit',
          plane: 'archive',
          objectKey: result.objectKey,
          chunkId: result.chunkId,
          expectedEncryptionScope: 'tenant:t_safeopaque:admin_audit:archive',
          expectedKeyVersion: 3,
        },
      })
    ).resolves.toEqual({ id: 'adm-1' });
  });
});
