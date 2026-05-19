export type TenantDatabaseMigrationValidationSeverity = 'error' | 'warning';

export interface TenantDatabaseMigrationChecksumSample {
  table: string;
  sampleKey: string;
  checksumSha256: string;
}

export interface TenantDatabaseMigrationValidationTarget {
  role: 'tenant_core' | 'tenant_pii' | 'tenant_audit' | 'tenant_custom';
  shardGroup?: string;
  shardIndex?: number;
  sourceSchemaVersion: number | null;
  targetSchemaVersion: number | null;
  minimumSourceSchemaVersion: number;
  minimumTargetSchemaVersion: number;
  sourceRowCount: number | null;
  targetRowCount: number | null;
  checksumSamplesSource?: TenantDatabaseMigrationChecksumSample[];
  checksumSamplesTarget?: TenantDatabaseMigrationChecksumSample[];
}

export interface TenantDatabaseMigrationValidationIssue {
  severity: TenantDatabaseMigrationValidationSeverity;
  code:
    | 'source_schema_too_old'
    | 'target_schema_too_old'
    | 'row_count_missing'
    | 'row_count_mismatch'
    | 'checksum_sample_missing'
    | 'checksum_sample_mismatch';
  role: TenantDatabaseMigrationValidationTarget['role'];
  shardGroup: string;
  shardIndex: number;
  message: string;
  detail?: Record<string, unknown>;
}

export interface TenantDatabaseMigrationValidationResult {
  passed: boolean;
  checkedAt: string;
  targetsChecked: number;
  issueCount: number;
  warningCount: number;
  issues: TenantDatabaseMigrationValidationIssue[];
}

function targetShardGroup(target: TenantDatabaseMigrationValidationTarget): string {
  return target.shardGroup ?? 'default';
}

function targetShardIndex(target: TenantDatabaseMigrationValidationTarget): number {
  return target.shardIndex ?? 0;
}

function issue(
  target: TenantDatabaseMigrationValidationTarget,
  code: TenantDatabaseMigrationValidationIssue['code'],
  message: string,
  detail?: Record<string, unknown>,
  severity: TenantDatabaseMigrationValidationSeverity = 'error'
): TenantDatabaseMigrationValidationIssue {
  return {
    severity,
    code,
    role: target.role,
    shardGroup: targetShardGroup(target),
    shardIndex: targetShardIndex(target),
    message,
    detail,
  };
}

function sampleKey(sample: TenantDatabaseMigrationChecksumSample): string {
  return `${sample.table}:${sample.sampleKey}`;
}

function validateChecksumSamples(
  target: TenantDatabaseMigrationValidationTarget,
  issues: TenantDatabaseMigrationValidationIssue[]
): void {
  const sourceSamples = target.checksumSamplesSource ?? [];
  const targetSamples = target.checksumSamplesTarget ?? [];

  if (sourceSamples.length === 0 && targetSamples.length === 0) {
    return;
  }

  if (sourceSamples.length === 0 || targetSamples.length === 0) {
    issues.push(
      issue(target, 'checksum_sample_missing', 'Checksum sampling exists on only one side.', {
        sourceSampleCount: sourceSamples.length,
        targetSampleCount: targetSamples.length,
      })
    );
    return;
  }

  const targetByKey = new Map(targetSamples.map((sample) => [sampleKey(sample), sample]));
  for (const sourceSample of sourceSamples) {
    const key = sampleKey(sourceSample);
    const targetSample = targetByKey.get(key);
    if (!targetSample) {
      issues.push(
        issue(target, 'checksum_sample_missing', 'Target checksum sample is missing.', {
          sample: key,
        })
      );
      continue;
    }
    if (sourceSample.checksumSha256 !== targetSample.checksumSha256) {
      issues.push(
        issue(target, 'checksum_sample_mismatch', 'Checksum sample mismatch.', {
          sample: key,
          sourceChecksumSha256: sourceSample.checksumSha256,
          targetChecksumSha256: targetSample.checksumSha256,
        })
      );
    }
  }
}

export function validateTenantDatabaseMigrationTargets(
  targets: TenantDatabaseMigrationValidationTarget[],
  now: Date = new Date()
): TenantDatabaseMigrationValidationResult {
  const issues: TenantDatabaseMigrationValidationIssue[] = [];

  for (const target of targets) {
    if (
      target.sourceSchemaVersion === null ||
      target.sourceSchemaVersion < target.minimumSourceSchemaVersion
    ) {
      issues.push(
        issue(target, 'source_schema_too_old', 'Source schema version is below requirement.', {
          sourceSchemaVersion: target.sourceSchemaVersion,
          minimumSourceSchemaVersion: target.minimumSourceSchemaVersion,
        })
      );
    }

    if (
      target.targetSchemaVersion === null ||
      target.targetSchemaVersion < target.minimumTargetSchemaVersion
    ) {
      issues.push(
        issue(target, 'target_schema_too_old', 'Target schema version is below requirement.', {
          targetSchemaVersion: target.targetSchemaVersion,
          minimumTargetSchemaVersion: target.minimumTargetSchemaVersion,
        })
      );
    }

    if (target.sourceRowCount === null || target.targetRowCount === null) {
      issues.push(
        issue(target, 'row_count_missing', 'Source and target row counts are required.', {
          sourceRowCount: target.sourceRowCount,
          targetRowCount: target.targetRowCount,
        })
      );
    } else if (target.sourceRowCount !== target.targetRowCount) {
      issues.push(
        issue(target, 'row_count_mismatch', 'Source and target row counts differ.', {
          sourceRowCount: target.sourceRowCount,
          targetRowCount: target.targetRowCount,
        })
      );
    }

    validateChecksumSamples(target, issues);
  }

  const errorCount = issues.filter((item) => item.severity === 'error').length;
  const warningCount = issues.filter((item) => item.severity === 'warning').length;

  return {
    passed: errorCount === 0,
    checkedAt: now.toISOString(),
    targetsChecked: targets.length,
    issueCount: errorCount,
    warningCount,
    issues,
  };
}
