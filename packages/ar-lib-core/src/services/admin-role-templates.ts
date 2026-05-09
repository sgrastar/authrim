import { ADMIN_PERMISSIONS } from '../types/admin-user';

export interface AdminRoleTemplateDefinition {
  key:
    | 'support_readonly'
    | 'support_analyst'
    | 'support_operator'
    | 'customer_support_approver'
    | 'technical_investigator'
    | 'compliance_reviewer';
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
];

export function getBuiltinAdminRoleTemplates(): AdminRoleTemplateDefinition[] {
  return BUILTIN_ADMIN_ROLE_TEMPLATES.map((template) => ({
    ...template,
    permissions: [...template.permissions],
  }));
}
