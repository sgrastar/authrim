export type AdminAuditCoverageStatus = 'covered' | 'gap_detected' | 'acknowledged' | 'ignored';

export interface AdminAuditCoverageEntry {
  action: string;
  surface: string;
  resourceType: string;
  status: AdminAuditCoverageStatus;
  critical: boolean;
  notes?: string;
}

export interface AdminAuditCoverageStatusView {
  operation_id: string;
  surface: string;
  resource_type: string;
  required_audit: 'admin_audit';
  criticality: 'normal' | 'critical';
  status: AdminAuditCoverageStatus;
  notes?: string;
}

export interface AdminAuditCoverageSummary {
  covered: number;
  gap_detected: number;
  acknowledged: number;
  ignored: number;
  last_checked_at?: number | null;
}

export const LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY: readonly AdminAuditCoverageEntry[] = [
  {
    action: 'storage_destination.create',
    surface: 'storage_destinations',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: true,
  },
  {
    action: 'storage_destination.update',
    surface: 'storage_destinations',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: true,
  },
  {
    action: 'storage_destination.delete',
    surface: 'storage_destinations',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: true,
  },
  {
    action: 'storage_destination.force_disable',
    surface: 'storage_destinations',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: true,
  },
  {
    action: 'storage_destination.enable',
    surface: 'storage_destinations',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: true,
  },
  {
    action: 'storage_destination.credentials.prepare',
    surface: 'storage_destinations',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: true,
  },
  {
    action: 'storage_destination.credentials.ready',
    surface: 'storage_destinations',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: true,
  },
  {
    action: 'storage_destination.credentials.activate',
    surface: 'storage_destinations',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: true,
  },
  {
    action: 'storage_destination.credentials.retire_previous',
    surface: 'storage_destinations',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: true,
  },
  {
    action: 'storage_destination.health_check',
    surface: 'storage_destinations',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: false,
  },
  {
    action: 'logging_destination_override.create',
    surface: 'logging_policies',
    resourceType: 'logging_destination_override',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging_destination_override.update',
    surface: 'logging_policies',
    resourceType: 'logging_destination_override',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging_destination_override.rollback',
    surface: 'logging_policies',
    resourceType: 'logging_destination_override',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging_fallback_policy.create',
    surface: 'logging_policies',
    resourceType: 'logging_fallback_policy',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging_fallback_policy.update',
    surface: 'logging_policies',
    resourceType: 'logging_fallback_policy',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging_policy_snapshot.draft_create',
    surface: 'logging_policies',
    resourceType: 'logging_policy_snapshot',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging_policy_snapshot.publish',
    surface: 'logging_policies',
    resourceType: 'logging_policy_snapshot',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging_export.create',
    surface: 'logging_policies',
    resourceType: 'logging_export_job',
    status: 'covered',
    critical: false,
  },
  {
    action: 'logging.runtime.tenant_db_probe',
    surface: 'logging_policies',
    resourceType: 'tenant_database_runtime',
    status: 'covered',
    critical: false,
  },
  {
    action: 'logging.usage_aggregates.refresh',
    surface: 'logging_policies',
    resourceType: 'logging_usage_aggregate',
    status: 'covered',
    critical: false,
  },
  {
    action: 'logging.quota_policy.create',
    surface: 'logging_policies',
    resourceType: 'logging_quota_policy',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging.quota_policy.update',
    surface: 'logging_policies',
    resourceType: 'logging_quota_policy',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging.quota.evaluate',
    surface: 'logging_policies',
    resourceType: 'logging_quota_evaluation',
    status: 'covered',
    critical: false,
  },
  {
    action: 'logging.delivery.bulk_retry',
    surface: 'logging_policies',
    resourceType: 'logging_message_job',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging.delivery.retry',
    surface: 'logging_policies',
    resourceType: 'logging_message_job',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging.message_job.cancel',
    surface: 'logging_policies',
    resourceType: 'logging_message_job',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging.message_job_repair.apply_safe',
    surface: 'logging_policies',
    resourceType: 'logging_message_repair_finding',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging.message_job_repair.apply_dangerous',
    surface: 'logging_policies',
    resourceType: 'logging_message_repair_finding',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging.dlq.delete',
    surface: 'logging_policies',
    resourceType: 'logging_dlq_item',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging.dlq.purge',
    surface: 'logging_policies',
    resourceType: 'logging_dlq_item',
    status: 'covered',
    critical: true,
  },
  {
    action: 'logging_notification.resolve',
    surface: 'logging_policies',
    resourceType: 'internal_notification_event',
    status: 'covered',
    critical: false,
  },
  {
    action: 'admin_logging.coverage.check',
    surface: 'admin_logging',
    resourceType: 'admin_audit_coverage_status',
    status: 'covered',
    critical: false,
  },
  {
    action: 'admin_logging.catalog_repair.apply_safe',
    surface: 'admin_logging',
    resourceType: 'log_object_catalog',
    status: 'covered',
    critical: true,
  },
  {
    action: 'admin_logging.catalog_repair.apply_dangerous',
    surface: 'admin_logging',
    resourceType: 'log_object_catalog',
    status: 'covered',
    critical: true,
  },
  {
    action: 'admin_logging.catalog_repair_job.apply_safe',
    surface: 'admin_logging',
    resourceType: 'log_catalog_repair_job',
    status: 'covered',
    critical: true,
  },
  {
    action: 'admin_logging.catalog_repair_job.cancel',
    surface: 'admin_logging',
    resourceType: 'log_catalog_repair_job',
    status: 'covered',
    critical: true,
  },
  {
    action: 'admin_logging.rewrap_jobs.create',
    surface: 'admin_logging',
    resourceType: 'logging_key_rewrap_job',
    status: 'covered',
    critical: true,
  },
  {
    action: 'admin_logging.rewrap_jobs.retry',
    surface: 'admin_logging',
    resourceType: 'logging_key_rewrap_job',
    status: 'covered',
    critical: true,
  },
  {
    action: 'admin_logging.rewrap_jobs.cancel',
    surface: 'admin_logging',
    resourceType: 'logging_key_rewrap_job',
    status: 'covered',
    critical: true,
  },
  {
    action: 'admin_logging.rewrap_jobs.priority_update',
    surface: 'admin_logging',
    resourceType: 'logging_key_rewrap_job',
    status: 'covered',
    critical: true,
  },
  {
    action: 'admin_logging.critical_policy.update',
    surface: 'admin_logging',
    resourceType: 'admin_destination',
    status: 'covered',
    critical: true,
  },
  {
    action: 'admin_logging.sensitive_detail.probe',
    surface: 'admin_logging',
    resourceType: 'log_object_catalog',
    status: 'covered',
    critical: true,
  },
  {
    action: 'admin_logging.sensitive_detail_policy.update',
    surface: 'admin_logging',
    resourceType: 'logging_destination_override',
    status: 'covered',
    critical: true,
  },
];

export function findAdminAuditCoverageEntry(action: string): AdminAuditCoverageEntry | null {
  return LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY.find((entry) => entry.action === action) ?? null;
}

export function listAdminAuditCoverageGaps(
  entries: readonly AdminAuditCoverageEntry[] = LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY
): AdminAuditCoverageEntry[] {
  return entries.filter((entry) => entry.status === 'gap_detected');
}

export function buildAdminAuditCoverageStatusView(
  entries: readonly AdminAuditCoverageEntry[] = LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY
): AdminAuditCoverageStatusView[] {
  return entries.map((entry) => ({
    operation_id: entry.action,
    surface: entry.surface,
    resource_type: entry.resourceType,
    required_audit: 'admin_audit',
    criticality: entry.critical ? 'critical' : 'normal',
    status: entry.status,
    ...(entry.notes && { notes: entry.notes }),
  }));
}

export function summarizeAdminAuditCoverage(
  entries: readonly AdminAuditCoverageEntry[] = LOGGING_ADMIN_AUDIT_COVERAGE_REGISTRY,
  lastCheckedAt?: number | null
): AdminAuditCoverageSummary {
  const summary: AdminAuditCoverageSummary = {
    covered: 0,
    gap_detected: 0,
    acknowledged: 0,
    ignored: 0,
    last_checked_at: lastCheckedAt ?? null,
  };
  for (const entry of entries) {
    summary[entry.status] += 1;
  }
  return summary;
}
