import { describe, expect, it } from 'vitest';

import {
  buildDangerousLogCatalogRepairPlan,
  detectLogCatalogRepairFindings,
  executeSafeLogCatalogRepairs,
} from '../repair';

describe('log catalog repair detection', () => {
  it('detects expired pending objects and orphan candidate cleanup as safe auto repairs', () => {
    const findings = detectLogCatalogRepairFindings({
      now: 10_000,
      pendingTtlMs: 1000,
      objects: [
        {
          id: 'obj_pending',
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          objectKey: 'logs/pending.jsonl.gz',
          status: 'pending',
          recordCount: 1,
          byteCount: 100,
          createdAt: 8000,
        },
        {
          id: 'obj_orphan',
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          objectKey: 'logs/orphan.jsonl.gz',
          status: 'orphan_candidate',
          recordCount: 1,
          byteCount: 100,
          createdAt: 9000,
        },
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        type: 'expired_pending_object',
        action: 'mark_orphan_candidate',
        safety: 'safe_auto',
        objectCatalogId: 'obj_pending',
      }),
      expect.objectContaining({
        type: 'orphan_candidate_cleanup',
        action: 'delete_orphan_indexes',
        safety: 'safe_auto',
        objectCatalogId: 'obj_orphan',
      }),
    ]);
  });

  it('detects one missing manifest finding per bucket and shard', () => {
    const committedAt = Date.UTC(2026, 4, 20, 1, 15, 0);
    const findings = detectLogCatalogRepairFindings({
      now: committedAt + 1000,
      manifestBucketSizeMs: 60 * 60 * 1000,
      manifestShardCount: 16,
      manifests: [],
      objects: [
        {
          id: 'obj_1',
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          objectKey: 'logs/1.jsonl.gz',
          status: 'committed',
          recordCount: 1,
          byteCount: 100,
          checksumSha256: 'a'.repeat(64),
          createdAt: committedAt,
          committedAt,
        },
        {
          id: 'obj_2',
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          objectKey: 'logs/2.jsonl.gz',
          status: 'committed',
          recordCount: 1,
          byteCount: 100,
          checksumSha256: 'b'.repeat(64),
          createdAt: committedAt + 1,
          committedAt: committedAt + 1,
        },
      ],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: 'missing_manifest',
      action: 'regenerate_manifest',
      safety: 'safe_auto',
      tenantKey: 'tk_abc',
      logType: 'audit',
      plane: 'archive',
      bucketStartAt: Date.UTC(2026, 4, 20, 1, 0, 0),
    });
  });

  it('does not report missing manifests when a committed manifest exists', () => {
    const committedAt = Date.UTC(2026, 4, 20, 1, 15, 0);
    const bucketStartAt = Date.UTC(2026, 4, 20, 1, 0, 0);

    const findings = detectLogCatalogRepairFindings({
      now: committedAt + 1000,
      manifestBucketSizeMs: 60 * 60 * 1000,
      manifestShardCount: 1,
      manifests: [
        {
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          bucketStartAt,
          shard: 'shard-00',
          status: 'committed',
        },
      ],
      objects: [
        {
          id: 'obj_1',
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          objectKey: 'logs/1.jsonl.gz',
          status: 'committed',
          recordCount: 1,
          byteCount: 100,
          checksumSha256: 'a'.repeat(64),
          createdAt: committedAt,
          committedAt,
        },
      ],
    });

    expect(findings).toEqual([]);
  });

  it('executes safe auto repair findings through the executor contract', async () => {
    const calls: Array<[string, unknown, number]> = [];
    const findings = detectLogCatalogRepairFindings({
      now: 10_000,
      pendingTtlMs: 1000,
      manifestShardCount: 1,
      manifests: [],
      objects: [
        {
          id: 'obj_pending',
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          objectKey: 'logs/pending.jsonl.gz',
          status: 'pending',
          recordCount: 1,
          byteCount: 100,
          createdAt: 8000,
        },
        {
          id: 'obj_orphan',
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          objectKey: 'logs/orphan.jsonl.gz',
          status: 'orphan_candidate',
          recordCount: 1,
          byteCount: 100,
          createdAt: 9000,
        },
        {
          id: 'obj_committed',
          tenantKey: 'tk_abc',
          logType: 'audit',
          plane: 'archive',
          objectKey: 'logs/committed.jsonl.gz',
          status: 'committed',
          recordCount: 1,
          byteCount: 100,
          createdAt: 9000,
          committedAt: 9000,
        },
      ],
    });

    const result = await executeSafeLogCatalogRepairs({
      findings,
      now: 11_000,
      executor: {
        async markObjectOrphanCandidate(id, repairedAt) {
          calls.push(['mark_orphan', id, repairedAt]);
        },
        async deleteRecordIndexesForObject(id, repairedAt) {
          calls.push(['delete_indexes', id, repairedAt]);
        },
        async enqueueManifestRegeneration(finding, repairedAt) {
          calls.push(['regenerate_manifest', finding.bucketStartAt, repairedAt]);
        },
      },
    });

    expect(result.skipped).toEqual([]);
    expect(result.applied).toHaveLength(3);
    expect(calls).toEqual([
      ['mark_orphan', 'obj_pending', 11_000],
      ['delete_indexes', 'obj_orphan', 11_000],
      ['regenerate_manifest', 0, 11_000],
    ]);
  });

  it('builds dangerous manual repair plans with typed confirmation', () => {
    expect(
      buildDangerousLogCatalogRepairPlan({
        action: 'delete_object',
        tenantKey: 'tk_abc',
        logType: 'audit',
        plane: 'archive',
        objectCatalogId: 'obj_1',
        objectKey: 'logs/1.jsonl.gz',
        affectedRecordCount: 10,
      })
    ).toEqual({
      action: 'delete_object',
      safety: 'dangerous_manual',
      tenantKey: 'tk_abc',
      logType: 'audit',
      plane: 'archive',
      impact: {
        objectCatalogId: 'obj_1',
        objectKey: 'logs/1.jsonl.gz',
        manifestObjectKey: undefined,
        affectedRecordCount: 10,
      },
      confirmation: 'CONFIRM DELETE_OBJECT obj_1',
    });
  });
});
