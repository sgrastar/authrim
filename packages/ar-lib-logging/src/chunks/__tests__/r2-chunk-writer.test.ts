import { describe, expect, it, vi } from 'vitest';
import { decodeStoredLogChunkRecord } from '../r2-chunk-reader';
import { writeLogChunkToR2 } from '../r2-chunk-writer';
import { normalizeR2Prefix } from '../r2-keys';
import type { LogChunkCatalogStore } from '../types';

describe('writeLogChunkToR2', () => {
  it('sanitizes unsafe R2 prefix segments', () => {
    expect(normalizeR2Prefix('/../logs v1//tenant/../../evil\u0000/')).toBe('logs_v1/tenant/evil_');
    expect(normalizeR2Prefix('///')).toBe('logs');
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

  it('includes surface in the object key when provided', async () => {
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
      records: [{ id: 'evt-1', eventAt: 1, payload: { id: 'evt-1' } }],
    });

    expect(result.objectKey).toContain(
      '/t_safeopaque/archive/admin_audit/storage_destinations/2026/05/20/10/'
    );
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
    });

    expect(calls).toEqual([
      'pending_object',
      'pending_indexes',
      'put',
      'commit_object',
      'commit_indexes',
    ]);
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
