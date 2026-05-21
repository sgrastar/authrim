import type { LogPlane, LogType } from '../registry';
import { defaultLogManifestShard, floorLogManifestBucket } from './r2-manifest-writer';

export type LogCatalogRepairFindingType =
  | 'expired_pending_object'
  | 'orphan_candidate_cleanup'
  | 'missing_manifest';

export type LogCatalogRepairAction =
  | 'mark_orphan_candidate'
  | 'delete_orphan_indexes'
  | 'regenerate_manifest';

export type DangerousLogCatalogRepairAction =
  | 'delete_object'
  | 'purge_record_indexes'
  | 'rewrite_manifest_lineage';

export interface LogCatalogRepairObjectRow {
  id: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  objectKey: string;
  status: 'pending' | 'committed' | 'orphan_candidate' | 'deleted';
  recordCount: number;
  byteCount: number;
  checksumSha256?: string | null;
  createdAt: number;
  committedAt?: number | null;
}

export interface LogCatalogRepairManifestRow {
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  bucketStartAt: number;
  shard: string;
  status: 'pending' | 'committed' | 'repair_needed';
}

export interface DetectLogCatalogRepairFindingsInput {
  objects: readonly LogCatalogRepairObjectRow[];
  manifests?: readonly LogCatalogRepairManifestRow[];
  now: number;
  pendingTtlMs?: number;
  manifestBucketSizeMs?: number;
  manifestShardCount?: number;
}

export interface LogCatalogRepairFinding {
  type: LogCatalogRepairFindingType;
  action: LogCatalogRepairAction;
  safety: 'safe_auto' | 'manual_review';
  objectCatalogId?: string;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  bucketStartAt?: number;
  shard?: string;
  reason: string;
}

export interface LogCatalogSafeRepairExecutor {
  markObjectOrphanCandidate(objectCatalogId: string, repairedAt: number): Promise<void>;
  deleteRecordIndexesForObject(objectCatalogId: string, repairedAt: number): Promise<void>;
  enqueueManifestRegeneration(
    finding: LogCatalogRepairFinding,
    repairedAt: number
  ): Promise<void>;
}

export interface ExecuteSafeLogCatalogRepairsInput {
  findings: readonly LogCatalogRepairFinding[];
  executor: LogCatalogSafeRepairExecutor;
  now: number;
}

export interface LogCatalogSafeRepairResult {
  applied: LogCatalogRepairFinding[];
  skipped: Array<{
    finding: LogCatalogRepairFinding;
    reason: 'manual_review_required' | 'missing_object_catalog_id';
  }>;
}

export interface DangerousLogCatalogRepairPlanInput {
  action: DangerousLogCatalogRepairAction;
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  objectCatalogId?: string;
  objectKey?: string;
  manifestObjectKey?: string;
  affectedRecordCount?: number;
}

export interface DangerousLogCatalogRepairPlan {
  action: DangerousLogCatalogRepairAction;
  safety: 'dangerous_manual';
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  impact: {
    objectCatalogId?: string;
    objectKey?: string;
    manifestObjectKey?: string;
    affectedRecordCount: number;
  };
  confirmation: string;
}

function manifestKey(input: {
  tenantKey: string;
  logType: LogType;
  plane: LogPlane;
  bucketStartAt: number;
  shard: string;
}): string {
  return [input.tenantKey, input.logType, input.plane, input.bucketStartAt, input.shard].join(':');
}

export function detectLogCatalogRepairFindings(
  input: DetectLogCatalogRepairFindingsInput
): LogCatalogRepairFinding[] {
  const pendingTtlMs = input.pendingTtlMs ?? 15 * 60 * 1000;
  const manifestBucketSizeMs = input.manifestBucketSizeMs ?? 60 * 60 * 1000;
  const manifestKeys = new Set(
    (input.manifests ?? [])
      .filter((manifest) => manifest.status === 'committed')
      .map((manifest) =>
        manifestKey({
          tenantKey: manifest.tenantKey,
          logType: manifest.logType,
          plane: manifest.plane,
          bucketStartAt: manifest.bucketStartAt,
          shard: manifest.shard,
        })
      )
  );
  const missingManifestKeys = new Set<string>();
  const findings: LogCatalogRepairFinding[] = [];

  for (const object of input.objects) {
    if (object.status === 'pending' && input.now - object.createdAt >= pendingTtlMs) {
      findings.push({
        type: 'expired_pending_object',
        action: 'mark_orphan_candidate',
        safety: 'safe_auto',
        objectCatalogId: object.id,
        tenantKey: object.tenantKey,
        logType: object.logType,
        plane: object.plane,
        reason: 'Pending catalog object exceeded the pending TTL.',
      });
      continue;
    }

    if (object.status === 'orphan_candidate') {
      findings.push({
        type: 'orphan_candidate_cleanup',
        action: 'delete_orphan_indexes',
        safety: 'safe_auto',
        objectCatalogId: object.id,
        tenantKey: object.tenantKey,
        logType: object.logType,
        plane: object.plane,
        reason: 'Object is already marked orphan_candidate and can have pending indexes removed.',
      });
      continue;
    }

    if (object.status !== 'committed') {
      continue;
    }

    const bucketStartAt = floorLogManifestBucket(
      object.committedAt ?? object.createdAt,
      manifestBucketSizeMs
    );
    const shard = defaultLogManifestShard({
      tenantKey: object.tenantKey,
      shardCount: input.manifestShardCount,
    });
    const key = manifestKey({
      tenantKey: object.tenantKey,
      logType: object.logType,
      plane: object.plane,
      bucketStartAt,
      shard,
    });

    if (!manifestKeys.has(key) && !missingManifestKeys.has(key)) {
      missingManifestKeys.add(key);
      findings.push({
        type: 'missing_manifest',
        action: 'regenerate_manifest',
        safety: 'safe_auto',
        tenantKey: object.tenantKey,
        logType: object.logType,
        plane: object.plane,
        bucketStartAt,
        shard,
        reason: 'Committed catalog objects exist without a committed manifest bucket.',
      });
    }
  }

  return findings;
}

export async function executeSafeLogCatalogRepairs(
  input: ExecuteSafeLogCatalogRepairsInput
): Promise<LogCatalogSafeRepairResult> {
  const applied: LogCatalogRepairFinding[] = [];
  const skipped: LogCatalogSafeRepairResult['skipped'] = [];

  for (const finding of input.findings) {
    if (finding.safety !== 'safe_auto') {
      skipped.push({ finding, reason: 'manual_review_required' });
      continue;
    }

    if (finding.action === 'mark_orphan_candidate') {
      if (!finding.objectCatalogId) {
        skipped.push({ finding, reason: 'missing_object_catalog_id' });
        continue;
      }
      await input.executor.markObjectOrphanCandidate(finding.objectCatalogId, input.now);
      applied.push(finding);
      continue;
    }

    if (finding.action === 'delete_orphan_indexes') {
      if (!finding.objectCatalogId) {
        skipped.push({ finding, reason: 'missing_object_catalog_id' });
        continue;
      }
      await input.executor.deleteRecordIndexesForObject(finding.objectCatalogId, input.now);
      applied.push(finding);
      continue;
    }

    if (finding.action === 'regenerate_manifest') {
      await input.executor.enqueueManifestRegeneration(finding, input.now);
      applied.push(finding);
    }
  }

  return { applied, skipped };
}

export function buildDangerousLogCatalogRepairPlan(
  input: DangerousLogCatalogRepairPlanInput
): DangerousLogCatalogRepairPlan {
  const target =
    input.objectCatalogId ?? input.objectKey ?? input.manifestObjectKey ?? input.tenantKey;
  return {
    action: input.action,
    safety: 'dangerous_manual',
    tenantKey: input.tenantKey,
    logType: input.logType,
    plane: input.plane,
    impact: {
      objectCatalogId: input.objectCatalogId,
      objectKey: input.objectKey,
      manifestObjectKey: input.manifestObjectKey,
      affectedRecordCount: input.affectedRecordCount ?? 0,
    },
    confirmation: `CONFIRM ${input.action.toUpperCase()} ${target}`,
  };
}
