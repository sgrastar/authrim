import { describe, expect, it } from 'vitest';
import {
  buildComplianceChecks,
  summarizeFrameworks,
  worstStatus,
  type ComplianceCheckInput,
} from '../compliance/compliance-checks';

function input(overrides: Partial<ComplianceCheckInput> = {}): ComplianceCheckInput {
  return {
    retention: { attention: [], expired_records: 0 },
    audit: { hot_query_status: 'supported', entries_last_30_days: 12 },
    mfa: {
      enforcement: {
        enforced: true,
        assurance_enabled: true,
        default_aal: 'AAL2',
        scopes_requiring_mfa: [],
      },
      admins: { admins: 3, with_passkey: 3 },
      users: { users: 10, with_passkey: 7, with_totp: 2, with_any: 9, guests: 1, deleting: 0 },
    },
    rbac: { active_roles: 2, users_with_roles: 4 },
    ...overrides,
  };
}

function statuses(checks: ReturnType<typeof buildComplianceChecks>) {
  return Object.fromEntries(checks.map((check) => [check.id, check.status]));
}

describe('compliance checks', () => {
  it('passes every check when what Authrim enforces meets it', () => {
    const checks = buildComplianceChecks(input());
    expect(statuses(checks)).toEqual({
      data_retention_enforced: 'compliant',
      audit_logging: 'compliant',
      admin_mfa: 'compliant',
      user_mfa_enforced: 'compliant',
      user_mfa_coverage: 'compliant',
      rbac_configured: 'compliant',
    });
    expect(worstStatus(checks.map((check) => check.status))).toBe('compliant');
  });

  it('warns when data is not being removed as its retention says', () => {
    const [retention] = buildComplianceChecks(
      input({
        retention: {
          attention: [{ category: 'user_tombstones', reason: 'task_disabled' }],
          expired_records: 4,
        },
      })
    );
    expect(retention).toMatchObject({
      status: 'warning',
      facts: { attention: ['user_tombstones:task_disabled'], expired_records: 4 },
    });
  });

  it('judges MFA from enforcement, admin passkeys and the share of users with a factor', () => {
    const base = input();
    const checks = buildComplianceChecks({
      ...base,
      mfa: {
        enforcement: { ...base.mfa.enforcement, enforced: false, assurance_enabled: false },
        admins: { admins: 3, with_passkey: 2 },
        users: { ...base.mfa.users, users: 10, with_any: 6 },
      },
    });
    expect(statuses(checks)).toMatchObject({
      user_mfa_enforced: 'warning',
      admin_mfa: 'warning',
      user_mfa_coverage: 'warning',
    });

    const low = buildComplianceChecks({
      ...base,
      mfa: { ...base.mfa, users: { ...base.mfa.users, users: 10, with_any: 4 } },
    });
    expect(statuses(low).user_mfa_coverage).toBe('non_compliant');

    const none = buildComplianceChecks({
      ...base,
      mfa: {
        ...base.mfa,
        admins: { admins: 0, with_passkey: 0 },
        users: { ...base.mfa.users, users: 0, with_any: 0 },
      },
    });
    expect(statuses(none)).toMatchObject({
      admin_mfa: 'not_applicable',
      user_mfa_coverage: 'not_applicable',
    });
  });

  it('warns about a queryable log with no entries or an unavailable store, not archive-only', () => {
    const auditStatus = (audit: ComplianceCheckInput['audit']) =>
      statuses(buildComplianceChecks(input({ audit }))).audit_logging;
    expect(auditStatus({ hot_query_status: 'supported', entries_last_30_days: 0 })).toBe('warning');
    expect(
      auditStatus({ hot_query_status: 'pending_runtime_support', entries_last_30_days: null })
    ).toBe('warning');
    expect(auditStatus({ hot_query_status: 'not_supported', entries_last_30_days: null })).toBe(
      'compliant'
    );
  });

  it('sums each framework from its own checks', () => {
    const checks = buildComplianceChecks(
      input({
        retention: {
          attention: [{ category: 'audit_events', reason: 'task_failed' }],
          expired_records: 0,
        },
      })
    );
    const frameworks = Object.fromEntries(
      summarizeFrameworks(checks).map((summary) => [summary.framework, summary])
    );
    // Only data retention is off: it bears on GDPR, SOC 2 and ISO 27001, not PCI DSS.
    expect(frameworks.gdpr).toMatchObject({ status: 'warning', total_checks: 1 });
    expect(frameworks.soc2).toMatchObject({
      status: 'warning',
      warning_checks: 1,
      total_checks: 6,
    });
    expect(frameworks.pci_dss).toMatchObject({ status: 'compliant', total_checks: 3 });
    expect(worstStatus([])).toBe('not_applicable');
    expect(worstStatus(['not_applicable', 'compliant'])).toBe('compliant');
  });
});
