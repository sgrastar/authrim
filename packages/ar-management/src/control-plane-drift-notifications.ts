import {
  InternalNotificationEventRepository,
  assertControlPlaneRecordIsSecretFree,
  ensureDatabaseAdapter,
  type ControlServiceBinding,
  type ControlWorkerInventoryDriftNotification,
  type Env,
} from '@authrim/ar-lib-core';

const CONTROL_TENANT_ID = '__control__';
const MAX_FINDINGS = 100;
const MAX_DATE_EPOCH_SECONDS = 8_640_000_000;
const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

export interface ControlPlaneDriftNotificationLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface ControlPlaneDriftNotificationSummary {
  scanned: number;
  enqueued: number;
  failed: number;
  acknowledged: number;
  skipped: boolean;
}

type NotificationRepository = Pick<InternalNotificationEventRepository, 'enqueue'>;

function validateFinding(
  value: unknown,
  expectedEnvironmentId: string | undefined
): ControlWorkerInventoryDriftNotification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('control_drift_notification_payload_invalid');
  }
  const finding = value as Record<string, unknown>;
  if (
    typeof finding.environmentId !== 'string' ||
    !SAFE_ENVIRONMENT_ID.test(finding.environmentId) ||
    (expectedEnvironmentId !== undefined && finding.environmentId !== expectedEnvironmentId) ||
    typeof finding.workerScriptName !== 'string' ||
    !SAFE_SCRIPT_NAME.test(finding.workerScriptName) ||
    finding.findingKind !== 'actual_only' ||
    finding.severity !== 'warning' ||
    !Number.isSafeInteger(finding.firstObservedAt) ||
    (finding.firstObservedAt as number) <= 0 ||
    (finding.firstObservedAt as number) > MAX_DATE_EPOCH_SECONDS ||
    !Number.isSafeInteger(finding.lastObservedAt) ||
    (finding.lastObservedAt as number) < (finding.firstObservedAt as number) ||
    (finding.lastObservedAt as number) > MAX_DATE_EPOCH_SECONDS
  ) {
    throw new Error('control_drift_notification_payload_invalid');
  }
  const expectedFindingId = `drift:${finding.environmentId}:actual_only:${finding.workerScriptName}`;
  if (finding.findingId !== expectedFindingId) {
    throw new Error('control_drift_notification_payload_invalid');
  }
  assertControlPlaneRecordIsSecretFree(finding);
  return finding as unknown as ControlWorkerInventoryDriftNotification;
}

function validateFindings(
  value: unknown,
  expectedEnvironmentId: string | undefined
): ControlWorkerInventoryDriftNotification[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    throw new Error('control_drift_notification_payload_invalid');
  }
  const findings = value.map((finding) => validateFinding(finding, expectedEnvironmentId));
  if (new Set(findings.map((finding) => finding.findingId)).size !== findings.length) {
    throw new Error('control_drift_notification_payload_invalid');
  }
  return findings;
}

export async function processControlPlaneDriftNotifications(
  env: Env,
  logger: ControlPlaneDriftNotificationLogger,
  options: {
    control?: ControlServiceBinding;
    notificationRepository?: NotificationRepository;
    now?: Date;
  } = {}
): Promise<ControlPlaneDriftNotificationSummary> {
  const summary: ControlPlaneDriftNotificationSummary = {
    scanned: 0,
    enqueued: 0,
    failed: 0,
    acknowledged: 0,
    skipped: false,
  };
  const control = options.control ?? env.CONTROL;
  if (!control) {
    summary.skipped = true;
    logger.warn('Control drift notification sync skipped because CONTROL is unavailable');
    return summary;
  }
  if (!options.notificationRepository && !env.DB_ADMIN) {
    summary.skipped = true;
    logger.warn('Control drift notification sync skipped because DB_ADMIN is unavailable');
    return summary;
  }
  const repository =
    options.notificationRepository ??
    new InternalNotificationEventRepository(
      ensureDatabaseAdapter(env.DB_ADMIN, 'control-plane-drift-notifications')
    );
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || !SAFE_ENVIRONMENT_ID.test(environmentId)) {
    throw new Error('control_drift_notification_environment_invalid');
  }
  const findings = validateFindings(
    await control.listPendingWorkerInventoryDriftFindings(),
    environmentId
  );
  summary.scanned = findings.length;
  const now = options.now ?? new Date();
  const acknowledgedIds: string[] = [];

  for (const finding of findings) {
    try {
      await repository.enqueue({
        tenantId: CONTROL_TENANT_ID,
        category: 'control_plane_drift',
        eventType: 'control.worker_inventory.actual_only',
        severity: 'medium',
        deduplicationKey: `control_worker_inventory_drift:${finding.findingId}:${finding.firstObservedAt}`,
        payload: {
          finding_id: finding.findingId,
          environment_id: finding.environmentId,
          worker_script_name: finding.workerScriptName,
          finding_kind: finding.findingKind,
          severity: finding.severity,
          first_observed_at: new Date(finding.firstObservedAt * 1000).toISOString(),
          last_observed_at: new Date(finding.lastObservedAt * 1000).toISOString(),
        },
        routingPolicy: {
          providers: ['internal_event', 'webhook', 'email'],
          failurePolicy: 'retry_until_dead_letter',
          policyScope: 'deployment',
          allowProviderSuppression: true,
        },
        now,
      });
      summary.enqueued += 1;
      acknowledgedIds.push(finding.findingId);
    } catch {
      summary.failed += 1;
      logger.warn('Control drift notification enqueue failed', {
        finding_id: finding.findingId,
        error_code: 'notification_enqueue_failed',
      });
    }
  }

  if (acknowledgedIds.length > 0) {
    await control.acknowledgeWorkerInventoryDriftNotifications(acknowledgedIds);
    summary.acknowledged = acknowledgedIds.length;
  }
  logger.info('Control drift notification sync completed', { ...summary });
  return summary;
}
