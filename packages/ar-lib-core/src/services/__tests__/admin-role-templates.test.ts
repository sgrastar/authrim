import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS } from '../../types/admin-user';
import { getBuiltinAdminRoleTemplates } from '../admin-role-templates';

describe('admin-role-templates', () => {
  it('returns the expected built-in support and investigation templates', () => {
    const templates = getBuiltinAdminRoleTemplates();
    expect(templates.map((template) => template.key)).toEqual([
      'support_readonly',
      'technical_investigator',
      'compliance_reviewer',
    ]);
  });

  it('keeps summary-only support roles away from full detail permissions', () => {
    const support = getBuiltinAdminRoleTemplates().find(
      (template) => template.key === 'support_readonly'
    );
    expect(support?.permissions).toContain(ADMIN_PERMISSIONS.ADMIN_AUDIT_READ);
    expect(support?.permissions).not.toContain(ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ);
    expect(support?.permissions).not.toContain(ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ);
  });

  it('includes explicit detail capabilities for investigation roles', () => {
    const investigator = getBuiltinAdminRoleTemplates().find(
      (template) => template.key === 'technical_investigator'
    );
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.ADMIN_AUDIT_DETAIL_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.WEBHOOKS_PAYLOAD_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.JOBS_ARTIFACT_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.OPERATIONAL_LOGS_DETAIL_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.APPROVALS_DETAIL_READ);
    expect(investigator?.permissions).toContain(ADMIN_PERMISSIONS.APPROVALS_GRANT_ISSUE);
  });
});
