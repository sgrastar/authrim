import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS } from '../../types/admin-user';
import { getBuiltinAdminRoleTemplates } from '../admin-role-templates';

describe('admin-role-templates', () => {
  it('returns the expected built-in admin role templates', () => {
    const templates = getBuiltinAdminRoleTemplates();
    expect(templates.map((template) => template.key)).toEqual([
      'support_readonly',
      'support_analyst',
      'support_operator',
      'customer_support_approver',
      'technical_investigator',
      'compliance_reviewer',
      'storage_destination_viewer',
      'storage_destination_admin',
      'platform_database_viewer',
      'platform_database_admin',
    ]);
  });

  it('keeps summary-only support roles away from full detail permissions', () => {
    const support = getBuiltinAdminRoleTemplates().find(
      (template) => template.key === 'support_readonly'
    );
    expect(support?.permissions).toContain(ADMIN_PERMISSIONS.ADMIN_AUDIT_READ);
    expect(support?.permissions).toContain(ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ);
    expect(support?.permissions).toContain(ADMIN_PERMISSIONS.ADMIN_LOGGING_OVERVIEW_READ);
    expect(support?.permissions).not.toContain(ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ);
    expect(support?.permissions).not.toContain(ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ);
  });

  it('includes explicit detail capabilities for investigation roles', () => {
    const investigator = getBuiltinAdminRoleTemplates().find(
      (template) => template.key === 'technical_investigator'
    );
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.ADMIN_LOGGING_COVERAGE_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.LOGGING_EXPORT_CREATE);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.LOGGING_SENSITIVE_DETAIL_EXPORT);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.JOBS_ARTIFACT_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.OPERATIONAL_LOGS_DETAIL_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.APPROVALS_DETAIL_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.APPROVALS_GRANT_ISSUE);
  });

  it('separates storage destination viewing from credential updates', () => {
    const viewer = getBuiltinAdminRoleTemplates().find(
      (template) => template.key === 'storage_destination_viewer'
    );
    const admin = getBuiltinAdminRoleTemplates().find(
      (template) => template.key === 'storage_destination_admin'
    );

    expect(viewer?.permissions).toContain(ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_READ);
    expect(viewer?.permissions).toContain(ADMIN_PERMISSIONS.LOGGING_OVERVIEW_READ);
    expect(viewer?.permissions).not.toContain(
      ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE
    );
    expect(admin?.permissions).toContain(ADMIN_PERMISSIONS.STORAGE_DESTINATIONS_CREDENTIALS_WRITE);
    expect(admin?.permissions).toContain(ADMIN_PERMISSIONS.LOGGING_PLATFORM_DEFAULTS_UPDATE);
    expect(admin?.permissions).toContain(ADMIN_PERMISSIONS.LOGGING_SNAPSHOTS_PUBLISH);
    expect(admin?.permissions).toContain(ADMIN_PERMISSIONS.DIAGNOSTIC_LOGGING_DESTINATION_SELECT);
    expect(admin?.permissions).toContain(ADMIN_PERMISSIONS.JOBS_DESTINATION_SELECT);
    expect(admin?.permissions).toContain(ADMIN_PERMISSIONS.DR_BACKUP_DESTINATION_SELECT);
  });

  it('separates database visibility from routing changes', () => {
    const viewer = getBuiltinAdminRoleTemplates().find(
      (template) => template.key === 'platform_database_viewer'
    );
    const admin = getBuiltinAdminRoleTemplates().find(
      (template) => template.key === 'platform_database_admin'
    );

    expect(viewer?.permissions).toContain(ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_READ);
    expect(viewer?.permissions).toContain(ADMIN_PERMISSIONS.DATABASE_ROUTING_READ);
    expect(viewer?.permissions).not.toContain(ADMIN_PERMISSIONS.DATABASE_ROUTING_SWITCH);
    expect(admin?.permissions).toContain(ADMIN_PERMISSIONS.DATABASE_CONNECTIONS_CREDENTIALS_WRITE);
    expect(admin?.permissions).toContain(ADMIN_PERMISSIONS.DATABASE_ROUTING_SWITCH);
    expect(admin?.permissions).toContain(ADMIN_PERMISSIONS.DATABASE_ROUTING_ROLLBACK);
  });
});
