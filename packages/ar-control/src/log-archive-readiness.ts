import {
  LOG_ICEBERG_READINESS_SCHEMA_VERSION,
  assertLogIcebergReadinessAttempt,
  logIcebergReadinessAttemptDigest,
  type LogIcebergReadinessAttempt,
  type LogIcebergReadinessResult,
} from '@authrim/ar-lib-core/services/log-iceberg-readiness';
import { signControlRuntimeSmokeRequest } from './runtime-smoke-signer';
import type { ControlEnv } from './types';

/** Existing signed bootstrap authority invokes a fixed private Management probe only. */
export async function advanceLogArchiveReadiness(
  env: ControlEnv,
  attempt: LogIcebergReadinessAttempt
): Promise<LogIcebergReadinessResult> {
  assertLogIcebergReadinessAttempt(attempt);
  attempt = { ...attempt };
  const digest = await logIcebergReadinessAttemptDigest(attempt);
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || !env.SMOKE_AR_MANAGEMENT?.probeLogArchive)
    throw new Error('runtime_smoke_log_archive_binding_unavailable');
  const token = await signControlRuntimeSmokeRequest({
    env,
    request: {
      environmentId,
      operationId: `log_archive_probe_v1:${digest}`,
      attempt: 1,
      targetWorker: `${environmentId}-ar-management`,
      bindingRef: 'LOG_ARCHIVE',
      expectedMigrationGeneration: LOG_ICEBERG_READINESS_SCHEMA_VERSION,
      dataRole: 'tenant_core/default',
      residencyPartition: 'platform',
    },
  });
  return env.SMOKE_AR_MANAGEMENT.probeLogArchive({ token, attempt });
}
