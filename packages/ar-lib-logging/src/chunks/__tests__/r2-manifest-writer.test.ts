import { describe, expect, it, vi } from 'vitest';

import {
  defaultLogManifestShard,
  floorLogManifestBucket,
  writeLogChunkManifestToR2,
  type LogChunkManifestRow,
} from '../index';

describe('R2 log chunk manifest writer', () => {
  it('builds hourly manifest objects with shard metadata and catalog upsert', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const upsertManifest = vi.fn().mockResolvedValue(undefined);
    const bucketStartAt = Date.UTC(2026, 4, 20, 0, 0, 0);
    const result = await writeLogChunkManifestToR2({
      bucket,
      tenantKey: 'tk_abc',
      logType: 'audit',
      plane: 'archive',
      bucketStartAt,
      bucketEndAt: bucketStartAt + 60 * 60 * 1000,
      shard: 'shard-01',
      prefix: 'audit',
      now: bucketStartAt,
      catalogStore: {
        createPendingObject: vi.fn(),
        createPendingRecordIndexes: vi.fn(),
        commitObject: vi.fn(),
        commitRecordIndexes: vi.fn(),
        markObjectOrphanCandidate: vi.fn(),
        upsertManifest,
      },
      chunks: [
        {
          objectCatalogId: 'obj_1',
          objectKey: 'audit/tk_abc/archive/audit/2026/05/20/00/chk_1.jsonl.gz',
          chunkId: 'chk_1',
          recordCount: 2,
          byteCount: 128,
          checksumSha256: 'a'.repeat(64),
          minEventAt: bucketStartAt,
          maxEventAt: bucketStartAt + 100,
        },
      ],
    });

    expect(result.manifestId).toMatch(/^man_/);
    expect(result.manifestObjectKey).toBe(
      'audit/tk_abc/archive/audit/manifests/2026/05/20/00/shard-01.manifest.json'
    );
    expect(result).toMatchObject({
      chunkCount: 1,
      recordCount: 2,
      byteCount: 128,
    });
    expect(bucket.put).toHaveBeenCalledWith(
      result.manifestObjectKey,
      expect.any(Uint8Array),
      expect.objectContaining({
        httpMetadata: { contentType: 'application/json' },
        customMetadata: expect.objectContaining({
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          shard: 'shard-01',
          chunkCount: '1',
          recordCount: '2',
        }),
      })
    );
    expect(upsertManifest).toHaveBeenCalledWith(
      expect.objectContaining<Partial<LogChunkManifestRow>>({
        tenantKey: 'tk_abc',
        logType: 'audit',
        plane: 'archive',
        bucketStartAt,
        shard: 'shard-01',
        status: 'committed',
      })
    );
  });

  it('floors manifest buckets and derives stable shard names', () => {
    const timestamp = Date.UTC(2026, 4, 20, 1, 23, 45);
    expect(floorLogManifestBucket(timestamp, 60 * 60 * 1000)).toBe(
      Date.UTC(2026, 4, 20, 1, 0, 0)
    );
    expect(defaultLogManifestShard({ tenantKey: 'tk_abc', shardCount: 16 })).toMatch(/^shard-\d\d$/);
    expect(defaultLogManifestShard({ tenantKey: 'tk_abc', shardCount: 16 })).toBe(
      defaultLogManifestShard({ tenantKey: 'tk_abc', shardCount: 16 })
    );
  });
});
