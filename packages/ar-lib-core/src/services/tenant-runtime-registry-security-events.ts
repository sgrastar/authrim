import type { DatabaseAdapter } from '../db/adapter';
import { AdminAuditLogRepository } from '../repositories/admin/admin-audit-log';
import { InternalNotificationEventRepository } from '../repositories/admin/internal-notification-event';

export type TenantRuntimeRegistrySnapshotSecurityReason =
  | 'invalid_signature'
  | 'unsigned_snapshot'
  | 'verification_key_not_configured'
  | 'deployment_target_mismatch'
  | 'malformed_snapshot'
  | 'expired_snapshot'
  | 'missing_snapshot';

export interface TenantRuntimeRegistrySnapshotSecurityEventInput {
  tenantId: string;
  deploymentTarget: string;
  snapshotKey: string;
  reason: TenantRuntimeRegistrySnapshotSecurityReason;
  signatureKeyId?: string | null;
  runtimeGeneration?: number | null;
  role?: string | null;
  source?: 'runtime_resolver' | 'management_job' | 'operator_tool';
  now?: Date;
}

export interface TenantRuntimeRegistrySnapshotSecurityEventResult {
  auditLogged: boolean;
  notificationEnqueued: boolean;
  securityAlertCreated: boolean;
  errors: string[];
}

function createDeduplicationKey(input: TenantRuntimeRegistrySnapshotSecurityEventInput): string {
  return [
    'tenant_runtime_registry_snapshot',
    input.reason,
    input.tenantId,
    input.deploymentTarget,
    input.runtimeGeneration ?? 'unknown_generation',
    input.signatureKeyId ?? 'no_key',
  ].join(':');
}

function createPayload(input: TenantRuntimeRegistrySnapshotSecurityEventInput) {
  return {
    tenant_id: input.tenantId,
    deployment_target: input.deploymentTarget,
    snapshot_key: input.snapshotKey,
    reason: input.reason,
    signature_key_id: input.signatureKeyId ?? null,
    runtime_generation: input.runtimeGeneration ?? null,
    role: input.role ?? null,
    source: input.source ?? 'runtime_resolver',
  };
}

async function createSecurityAlert(
  adapter: DatabaseAdapter,
  input: TenantRuntimeRegistrySnapshotSecurityEventInput,
  payload: Record<string, unknown>
): Promise<void> {
  const nowMs = input.now?.getTime() ?? Date.now();
  const metadata = {
    ...payload,
    internal_notification_deduplication_key: createDeduplicationKey(input),
  };

  await adapter.execute(
    `INSERT INTO security_alerts (
      id, tenant_id, type, severity, status, title, description,
      source_ip, user_id, client_id, metadata, created_at, updated_at
    ) VALUES (?, ?, 'config_change', 'critical', 'open', ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      input.tenantId,
      'Runtime registry snapshot verification failed',
      'A tenant runtime registry snapshot failed verification and the affected tenant was failed closed.',
      JSON.stringify(metadata),
      Math.floor(nowMs / 1000),
      Math.floor(nowMs / 1000),
    ]
  );
}

export async function recordTenantRuntimeRegistrySnapshotSecurityEvent(
  input: TenantRuntimeRegistrySnapshotSecurityEventInput,
  options: {
    adminAuditAdapter?: DatabaseAdapter | null;
    internalNotificationAdapter?: DatabaseAdapter | null;
    securityAlertAdapter?: DatabaseAdapter | null;
  }
): Promise<TenantRuntimeRegistrySnapshotSecurityEventResult> {
  const payload = createPayload(input);
  const result: TenantRuntimeRegistrySnapshotSecurityEventResult = {
    auditLogged: false,
    notificationEnqueued: false,
    securityAlertCreated: false,
    errors: [],
  };

  if (options.adminAuditAdapter) {
    try {
      const auditRepo = new AdminAuditLogRepository(options.adminAuditAdapter);
      await auditRepo.createAuditLog({
        tenant_id: input.tenantId,
        action: 'tenant_runtime_registry_snapshot.verification_failed',
        resource_type: 'tenant_runtime_registry_snapshot',
        resource_id: input.snapshotKey,
        result: 'failure',
        error_code: input.reason,
        error_message: 'Runtime registry snapshot verification failed',
        severity: 'critical',
        metadata: payload,
      });
      result.auditLogged = true;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (options.internalNotificationAdapter) {
    try {
      const notificationRepo = new InternalNotificationEventRepository(
        options.internalNotificationAdapter
      );
      await notificationRepo.enqueue({
        tenantId: input.tenantId,
        category: 'storage_registry_security',
        eventType: 'tenant_runtime_registry_snapshot.verification_failed',
        severity: 'critical',
        deduplicationKey: createDeduplicationKey(input),
        payload,
        now: input.now,
      });
      result.notificationEnqueued = true;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (options.securityAlertAdapter) {
    try {
      await createSecurityAlert(options.securityAlertAdapter, input, payload);
      result.securityAlertCreated = true;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return result;
}
