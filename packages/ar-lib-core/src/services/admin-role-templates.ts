import { ADMIN_PERMISSIONS } from '../types/admin-user';

export interface AdminRoleTemplateDefinition {
  key:
    | 'support_readonly'
    | 'support_analyst'
    | 'support_operator'
    | 'customer_support_approver'
    | 'technical_investigator'
    | 'compliance_reviewer'
    | 'storage_destination_viewer'
    | 'storage_destination_admin'
    | 'platform_database_viewer'
    | 'platform_database_admin';
  name: string;
  displayName: string;
  description: string;
  hierarchyLevel: number;
  permissions: string[];
}

const BUILTIN_ADMIN_ROLE_TEMPLATES: AdminRoleTemplateDefinition[] = [
  {
    key: 'support_readonly',
    name: 'support_readonly',
    displayName: 'Support Readonly',
    description:
      'Summary-level support access without full sensitive detail dereference privileges.',
    hierarchyLevel: 25,
    permissions: [
      ADMIN_PERMISSIONS.USERS_READ,
      ADMIN_PERMISSIONS.CLIENTS_READ,
      ADMIN_PERMISSIONS.SETTINGS_READ,
      ADMIN_PERMISSIONS.AUDIT_READ,
      ADMIN_PERMISSIONS.ADMIN_AUDIT_READ,
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
      ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.WEBHOOKS_READ,
      ADMIN_PERMISSIONS.JOBS_READ,
      ADMIN_PERMISSIONS.OPERATIONAL_LOGS_READ,
      ADMIN_PERMISSIONS.APPROVALS_READ,
    ],
  },
  {
    key: 'support_analyst',
    name: 'support_analyst',
    displayName: 'Support Analyst',
    description:
      'Privacy-preserving support access for aggregate analysis and count-only cohort previews.',
    hierarchyLevel: 26,
    permissions: [
      ADMIN_PERMISSIONS.SUPPORT_OPS_REGISTRY_READ,
      ADMIN_PERMISSIONS.SUPPORT_OPS_AGGREGATE_READ,
      ADMIN_PERMISSIONS.SUPPORT_OPS_COHORTS_PREVIEW,
      ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_READ,
    ],
  },
  {
    key: 'support_operator',
    name: 'support_operator',
    displayName: 'Support Operator',
    description:
      'Privacy-preserving support access for cohort creation and approved action requests.',
    hierarchyLevel: 35,
    permissions: [
      ADMIN_PERMISSIONS.SUPPORT_OPS_REGISTRY_READ,
      ADMIN_PERMISSIONS.SUPPORT_OPS_AGGREGATE_READ,
      ADMIN_PERMISSIONS.SUPPORT_OPS_COHORTS_PREVIEW,
      ADMIN_PERMISSIONS.SUPPORT_OPS_COHORTS_CREATE,
      ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_REQUEST,
      ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_READ,
      ADMIN_PERMISSIONS.APPROVALS_READ,
    ],
  },
  {
    key: 'customer_support_approver',
    name: 'customer_support_approver',
    displayName: 'Customer Support Approver',
    description: 'Approves privacy-preserving support actions for a tenant.',
    hierarchyLevel: 40,
    permissions: [
      ADMIN_PERMISSIONS.SUPPORT_OPS_REGISTRY_READ,
      ADMIN_PERMISSIONS.SUPPORT_OPS_COHORTS_PREVIEW,
      ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_READ,
      ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_APPROVE,
      ADMIN_PERMISSIONS.SUPPORT_OPS_ACTIONS_EXECUTE,
      ADMIN_PERMISSIONS.APPROVALS_READ,
      ADMIN_PERMISSIONS.APPROVALS_APPROVE,
    ],
  },
  {
    key: 'technical_investigator',
    name: 'technical_investigator',
    displayName: 'Technical Investigator',
    description:
      'Investigation role with full detail read capability for audit, webhook payloads, job artifacts, and operational log detail.',
    hierarchyLevel: 45,
    permissions: [
      ADMIN_PERMISSIONS.USERS_READ,
      ADMIN_PERMISSIONS.CLIENTS_READ,
      ADMIN_PERMISSIONS.SETTINGS_READ,
      ADMIN_PERMISSIONS.AUDIT_READ,
      ADMIN_PERMISSIONS.ADMIN_AUDIT_READ,
      ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ,
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
      ADMIN_PERMISSIONS.LOGGING_EXPORT_CREATE,
      ADMIN_PERMISSIONS.LOGGING_SENSITIVE_DETAIL_EXPORT,
      ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_READ,
      ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ,
      ADMIN_PERMISSIONS.WEBHOOKS_READ,
      ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ,
      ADMIN_PERMISSIONS.JOBS_READ,
      ADMIN_PERMISSIONS.JOBS_ARTIFACT_READ,
      ADMIN_PERMISSIONS.OPERATIONAL_LOGS_READ,
      ADMIN_PERMISSIONS.OPERATIONAL_LOGS_DETAIL_READ,
      ADMIN_PERMISSIONS.APPROVALS_READ,
      ADMIN_PERMISSIONS.APPROVALS_DETAIL_READ,
      ADMIN_PERMISSIONS.APPROVALS_WRITE,
      ADMIN_PERMISSIONS.APPROVALS_GRANT_ISSUE,
    ],
  },
  {
    key: 'compliance_reviewer',
    name: 'compliance_reviewer',
    displayName: 'Compliance Reviewer',
    description:
      'Review role for compliance investigations with approval and sensitive detail access.',
    hierarchyLevel: 50,
    permissions: [
      ADMIN_PERMISSIONS.AUDIT_READ,
      ADMIN_PERMISSIONS.ADMIN_AUDIT_READ,
      ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ,
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
      ADMIN_PERMISSIONS.LOGGING_EXPORT_CREATE,
      ADMIN_PERMISSIONS.LOGGING_SENSITIVE_DETAIL_EXPORT,
      ADMIN_PERMISSIONS.DIRECTORY_AUTH_EVIDENCE_EXPORT_CREATE,
      ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_READ,
      ADMIN_PERMISSIONS.ADMIN_LOGGING_REPAIR_READ,
      ADMIN_PERMISSIONS.ADMIN_LOGGING_SENSITIVE_DETAIL_POLICY_READ,
      ADMIN_PERMISSIONS.WEBHOOKS_READ,
      ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ,
      ADMIN_PERMISSIONS.JOBS_READ,
      ADMIN_PERMISSIONS.JOBS_ARTIFACT_READ,
      ADMIN_PERMISSIONS.OPERATIONAL_LOGS_READ,
      ADMIN_PERMISSIONS.OPERATIONAL_LOGS_DETAIL_READ,
      ADMIN_PERMISSIONS.APPROVALS_READ,
      ADMIN_PERMISSIONS.APPROVALS_DETAIL_READ,
      ADMIN_PERMISSIONS.APPROVALS_APPROVE,
      ADMIN_PERMISSIONS.APPROVALS_GRANT_ISSUE,
    ],
  },
  {
    key: 'storage_destination_viewer',
    name: 'storage_destination_viewer',
    displayName: 'Storage Destination Viewer',
    description:
      'View tenant storage destinations and usage without credential management privileges.',
    hierarchyLevel: 32,
    permissions: [
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_USAGE_READ,
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
    ],
  },
  {
    key: 'storage_destination_admin',
    name: 'storage_destination_admin',
    displayName: 'Storage Destination Admin',
    description:
      'Manage tenant storage destinations and allow feature owners to select approved destinations.',
    hierarchyLevel: 55,
    permissions: [
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_LIST,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREATE,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_UPDATE,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_DELETE,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_HEALTH_CHECK,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_TEST,
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_USAGE_READ,
      ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ,
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_READ,
      ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE,
      ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_READ,
      ADMIN_PERMISSIONS.LOGGING_TENANT_OVERRIDES_UPDATE,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_EVENTS_READ,
      ADMIN_PERMISSIONS.LOGGING_DELIVERY_RETRY,
      ADMIN_PERMISSIONS.LOGGING_DLQ_REPLAY,
      ADMIN_PERMISSIONS.LOGGING_DLQ_DELETE,
      ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH,
      ADMIN_PERMISSIONS.DIAGNOSTIC_LOGGING_DESTINATION_SELECT,
      ADMIN_PERMISSIONS.JOBS_DESTINATION_SELECT,
      ADMIN_PERMISSIONS.DR_BACKUP_DESTINATION_SELECT,
    ],
  },
  {
    key: 'platform_database_viewer',
    name: 'platform_database_viewer',
    displayName: 'Platform Database Viewer',
    description:
      'View platform database connections and routing state without changing runtime storage.',
    hierarchyLevel: 60,
    permissions: [
      ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_LIST,
      ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_READ,
      ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_TEST,
      ADMIN_PERMISSIONS.DATABASE_ROUTING_READ,
    ],
  },
  {
    key: 'platform_database_admin',
    name: 'platform_database_admin',
    displayName: 'Platform Database Admin',
    description:
      'Manage platform database connections and perform controlled database routing changes.',
    hierarchyLevel: 85,
    permissions: [
      ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_LIST,
      ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_READ,
      ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREATE,
      ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_UPDATE,
      ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_DELETE,
      ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREDENTIALS_WRITE,
      ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_TEST,
      ADMIN_PERMISSIONS.DATABASE_ROUTING_READ,
      ADMIN_PERMISSIONS.DATABASE_ROUTING_WRITE,
      ADMIN_PERMISSIONS.DATABASE_ROUTING_SWITCH,
      ADMIN_PERMISSIONS.DATABASE_ROUTING_ROLLBACK,
    ],
  },
];

export function getBuiltinAdminRoleTemplates(): AdminRoleTemplateDefinition[] {
  return BUILTIN_ADMIN_ROLE_TEMPLATES.map((template) => ({
    ...template,
    permissions: [...template.permissions],
  }));
}
