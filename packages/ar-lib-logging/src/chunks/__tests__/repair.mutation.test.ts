import { describe, expect, it, vi } from 'vitest';
import {
  buildDangerousLogCatalogRepairPlan,
  detectLogCatalogRepairFindings,
  executeSafeLogCatalogRepairs,
  type LogCatalogRepairFinding,
  type LogCatalogRepairObjectRow,
} from '../repair';
import { defaultLogManifestShard, floorLogManifestBucket } from '../r2-manifest-writer';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = 10 * HOUR;

function object(overrides: Partial<LogCatalogRepairObjectRow> = {}): LogCatalogRepairObjectRow {
  return {
    id: 'obj_1',
    tenantKey: 't_1',
    logType: 'audit',
    plane: 'archive',
    objectKey: 'k',
    status: 'pending',
    recordCount: 1,
    byteCount: 1,
    createdAt: 0,
    ...overrides,
  };
}

describe('detectLogCatalogRepairFindings', () => {
  it('flags a pending object once it has waited 15 minutes, exactly', () => {
    const at = (age: number) =>
      detectLogCatalogRepairFindings({ objects: [object({ createdAt: NOW - age })], now: NOW });
    expect(at(15 * MIN - 1)).toEqual([]);
    expect(at(15 * MIN)).toStrictEqual([
      {
        type: 'expired_pending_object',
        action: 'mark_orphan_candidate',
        safety: 'safe_auto',
        objectCatalogId: 'obj_1',
        tenantKey: 't_1',
        logType: 'audit',
        plane: 'archive',
        reason: 'Pending catalog object exceeded the pending TTL.',
      },
    ]);
    expect(at(15 * MIN + 1)).toHaveLength(1);
  });

  it('uses the pending time limit it is given', () => {
    const at = (age: number, pendingTtlMs: number) =>
      detectLogCatalogRepairFindings({
        objects: [object({ createdAt: NOW - age })],
        now: NOW,
        pendingTtlMs,
      });
    expect(at(999, 1000)).toEqual([]);
    expect(at(1000, 1000)).toHaveLength(1);
    expect(at(0, 0)).toHaveLength(1);
  });

  it('flags an orphan candidate for cleanup of its pending indexes', () => {
    expect(
      detectLogCatalogRepairFindings({
        objects: [object({ status: 'orphan_candidate' })],
        now: NOW,
      })
    ).toStrictEqual([
      {
        type: 'orphan_candidate_cleanup',
        action: 'delete_orphan_indexes',
        safety: 'safe_auto',
        objectCatalogId: 'obj_1',
        tenantKey: 't_1',
        logType: 'audit',
        plane: 'archive',
        reason: 'Object is already marked orphan_candidate and can have pending indexes removed.',
      },
    ]);
  });

  it('leaves deleted objects, and committed ones that have a manifest, alone', () => {
    expect(
      detectLogCatalogRepairFindings({ objects: [object({ status: 'deleted' })], now: NOW })
    ).toEqual([]);
    const committed = object({ status: 'committed', committedAt: 2 * HOUR + 5 });
    const shard = defaultLogManifestShard({ tenantKey: 't_1' });
    const manifest = {
      tenantKey: 't_1',
      logType: 'audit' as const,
      plane: 'archive' as const,
      bucketStartAt: 2 * HOUR,
      shard,
      status: 'committed' as const,
    };
    expect(
      detectLogCatalogRepairFindings({ objects: [committed], manifests: [manifest], now: NOW })
    ).toEqual([]);
    for (const status of ['pending', 'repair_needed'] as const) {
      expect(
        detectLogCatalogRepairFindings({
          objects: [committed],
          manifests: [{ ...manifest, status }],
          now: NOW,
        })
      ).toHaveLength(1);
    }
  });

  it('flags a committed object whose manifest bucket has no committed manifest, once per bucket', () => {
    const shard = defaultLogManifestShard({ tenantKey: 't_1' });
    const objects = [
      object({ id: 'a', status: 'committed', committedAt: 2 * HOUR + 1 }),
      object({ id: 'b', status: 'committed', committedAt: 2 * HOUR + 59 * MIN }),
      object({ id: 'c', status: 'committed', committedAt: 3 * HOUR }),
    ];
    expect(detectLogCatalogRepairFindings({ objects, now: NOW })).toStrictEqual([
      {
        type: 'missing_manifest',
        action: 'regenerate_manifest',
        safety: 'safe_auto',
        tenantKey: 't_1',
        logType: 'audit',
        plane: 'archive',
        bucketStartAt: 2 * HOUR,
        shard,
        reason: 'Committed catalog objects exist without a committed manifest bucket.',
      },
      {
        type: 'missing_manifest',
        action: 'regenerate_manifest',
        safety: 'safe_auto',
        tenantKey: 't_1',
        logType: 'audit',
        plane: 'archive',
        bucketStartAt: 3 * HOUR,
        shard,
        reason: 'Committed catalog objects exist without a committed manifest bucket.',
      },
    ]);
  });

  it('buckets by the commit time, or else the creation time, and by the bucket size it is given', () => {
    const created = object({
      status: 'committed',
      createdAt: 5 * HOUR + 7,
      committedAt: undefined,
    });
    expect(detectLogCatalogRepairFindings({ objects: [created], now: NOW })[0]?.bucketStartAt).toBe(
      5 * HOUR
    );
    const nulled = object({ status: 'committed', createdAt: 5 * HOUR + 7, committedAt: null });
    expect(detectLogCatalogRepairFindings({ objects: [nulled], now: NOW })[0]?.bucketStartAt).toBe(
      5 * HOUR
    );
    const committed = object({
      status: 'committed',
      createdAt: 0,
      committedAt: 4 * HOUR + 7 * MIN,
    });
    expect(
      detectLogCatalogRepairFindings({ objects: [committed], now: NOW })[0]?.bucketStartAt
    ).toBe(4 * HOUR);
    expect(
      detectLogCatalogRepairFindings({
        objects: [committed],
        now: NOW,
        manifestBucketSizeMs: 5 * MIN,
      })[0]?.bucketStartAt
    ).toBe(floorLogManifestBucket(4 * HOUR + 7 * MIN, 5 * MIN));
    const sharded = detectLogCatalogRepairFindings({
      objects: [committed],
      now: NOW,
      manifestShardCount: 4,
    })[0];
    expect(sharded?.shard).toBe(defaultLogManifestShard({ tenantKey: 't_1', shardCount: 4 }));
  });

  it('tells apart manifests of another tenant, type, plane, bucket or shard', () => {
    const shard = defaultLogManifestShard({ tenantKey: 't_1' });
    const committed = object({ status: 'committed', committedAt: 2 * HOUR });
    const manifest = {
      tenantKey: 't_1',
      logType: 'audit' as const,
      plane: 'archive' as const,
      bucketStartAt: 2 * HOUR,
      shard,
      status: 'committed' as const,
    };
    for (const change of [
      { tenantKey: 't_2' },
      { logType: 'security' as const },
      { plane: 'primary' as const },
      { bucketStartAt: 3 * HOUR },
      { shard: 'other' },
    ]) {
      expect(
        detectLogCatalogRepairFindings({
          objects: [committed],
          manifests: [{ ...manifest, ...change }],
          now: NOW,
        })
      ).toHaveLength(1);
    }
    expect(
      detectLogCatalogRepairFindings({ objects: [committed], manifests: [manifest], now: NOW })
    ).toEqual([]);
  });

  it('reports every kind of finding in the order of the objects', () => {
    const findings = detectLogCatalogRepairFindings({
      objects: [
        object({ id: 'p', createdAt: 0 }),
        object({ id: 'o', status: 'orphan_candidate' }),
        object({ id: 'c', status: 'committed', committedAt: HOUR }),
      ],
      now: NOW,
    });
    expect(findings.map((finding) => finding.type)).toEqual([
      'expired_pending_object',
      'orphan_candidate_cleanup',
      'missing_manifest',
    ]);
  });
});

describe('executeSafeLogCatalogRepairs', () => {
  const finding = (overrides: Partial<LogCatalogRepairFinding>): LogCatalogRepairFinding => ({
    type: 'expired_pending_object',
    action: 'mark_orphan_candidate',
    safety: 'safe_auto',
    objectCatalogId: 'obj_1',
    tenantKey: 't_1',
    logType: 'audit',
    plane: 'archive',
    reason: 'r',
    ...overrides,
  });

  function executor() {
    return {
      markObjectOrphanCandidate: vi.fn(async () => undefined),
      deleteRecordIndexesForObject: vi.fn(async () => undefined),
      enqueueManifestRegeneration: vi.fn(async () => undefined),
    };
  }

  it('applies each safe repair through its own executor method, at the given time', async () => {
    const target = executor();
    const mark = finding({});
    const clean = finding({ action: 'delete_orphan_indexes', objectCatalogId: 'obj_2' });
    const manifest = finding({
      action: 'regenerate_manifest',
      objectCatalogId: undefined,
      bucketStartAt: 1,
    });
    const result = await executeSafeLogCatalogRepairs({
      findings: [mark, clean, manifest],
      executor: target,
      now: 777,
    });
    expect(result).toStrictEqual({ applied: [mark, clean, manifest], skipped: [] });
    expect(target.markObjectOrphanCandidate).toHaveBeenCalledOnce();
    expect(target.markObjectOrphanCandidate).toHaveBeenCalledWith('obj_1', 777);
    expect(target.deleteRecordIndexesForObject).toHaveBeenCalledOnce();
    expect(target.deleteRecordIndexesForObject).toHaveBeenCalledWith('obj_2', 777);
    expect(target.enqueueManifestRegeneration).toHaveBeenCalledOnce();
    expect(target.enqueueManifestRegeneration).toHaveBeenCalledWith(manifest, 777);
  });

  it('skips findings that need review, naming why, and touches nothing', async () => {
    const target = executor();
    const manual = finding({ safety: 'manual_review' });
    const manualManifest = finding({ action: 'regenerate_manifest', safety: 'manual_review' });
    const noId = finding({ objectCatalogId: undefined });
    const noIdClean = finding({ action: 'delete_orphan_indexes', objectCatalogId: undefined });
    const emptyId = finding({ objectCatalogId: '' });
    const result = await executeSafeLogCatalogRepairs({
      findings: [manual, manualManifest, noId, noIdClean, emptyId],
      executor: target,
      now: 1,
    });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toStrictEqual([
      { finding: manual, reason: 'manual_review_required' },
      { finding: manualManifest, reason: 'manual_review_required' },
      { finding: noId, reason: 'missing_object_catalog_id' },
      { finding: noIdClean, reason: 'missing_object_catalog_id' },
      { finding: emptyId, reason: 'missing_object_catalog_id' },
    ]);
    for (const method of Object.values(target)) expect(method).not.toHaveBeenCalled();
  });

  it('does nothing for no findings, and for an action it does not know', async () => {
    const target = executor();
    expect(
      await executeSafeLogCatalogRepairs({ findings: [], executor: target, now: 1 })
    ).toStrictEqual({
      applied: [],
      skipped: [],
    });
    const unknown = finding({ action: 'something_else' as never });
    expect(
      await executeSafeLogCatalogRepairs({ findings: [unknown], executor: target, now: 1 })
    ).toStrictEqual({
      applied: [],
      skipped: [],
    });
  });
});

describe('buildDangerousLogCatalogRepairPlan', () => {
  const base = { tenantKey: 't_1', logType: 'audit', plane: 'archive' } as const;

  it('describes the impact and asks for a confirmation naming the action and its target', () => {
    expect(
      buildDangerousLogCatalogRepairPlan({
        ...base,
        action: 'delete_object',
        objectCatalogId: 'obj_1',
        objectKey: 'k/1',
        manifestObjectKey: 'm/1',
        affectedRecordCount: 12,
      })
    ).toStrictEqual({
      action: 'delete_object',
      safety: 'dangerous_manual',
      tenantKey: 't_1',
      logType: 'audit',
      plane: 'archive',
      impact: {
        objectCatalogId: 'obj_1',
        objectKey: 'k/1',
        manifestObjectKey: 'm/1',
        affectedRecordCount: 12,
      },
      confirmation: 'CONFIRM DELETE_OBJECT obj_1',
    });
  });

  it('names the target by the catalog id, else the object key, else the manifest key, else the tenant', () => {
    const confirmation = (extra: Record<string, string>) =>
      buildDangerousLogCatalogRepairPlan({ ...base, action: 'purge_record_indexes', ...extra })
        .confirmation;
    expect(confirmation({ objectCatalogId: 'o', objectKey: 'k', manifestObjectKey: 'm' })).toBe(
      'CONFIRM PURGE_RECORD_INDEXES o'
    );
    expect(confirmation({ objectKey: 'k', manifestObjectKey: 'm' })).toBe(
      'CONFIRM PURGE_RECORD_INDEXES k'
    );
    expect(confirmation({ manifestObjectKey: 'm' })).toBe('CONFIRM PURGE_RECORD_INDEXES m');
    expect(confirmation({})).toBe('CONFIRM PURGE_RECORD_INDEXES t_1');
    expect(
      buildDangerousLogCatalogRepairPlan({ ...base, action: 'rewrite_manifest_lineage' }).impact
    ).toStrictEqual({
      objectCatalogId: undefined,
      objectKey: undefined,
      manifestObjectKey: undefined,
      affectedRecordCount: 0,
    });
  });
});
