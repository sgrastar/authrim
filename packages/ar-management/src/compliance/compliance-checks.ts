/**
 * Compliance checks: each one a fact about the tenant read from what Authrim enforces, with the
 * frameworks whose controls it supports. A framework's status is summed from its checks; nothing
 * here claims a framework is met beyond what these checks show.
 */
import type { MfaEnforcement, AdminMfaCoverage, UserMfaCoverage } from './mfa-coverage';
import type { RetentionAttentionReason } from '../routes/settings/data-retention';
import type { RetentionCategoryId } from './retention-inventory';

export type ComplianceFramework = 'gdpr' | 'soc2' | 'iso27001' | 'pci_dss';
export type ComplianceStatus = 'compliant' | 'warning' | 'non_compliant' | 'not_applicable';

export type ComplianceCheckId =
  | 'data_retention_enforced'
  | 'audit_logging'
  | 'admin_mfa'
  | 'user_mfa_enforced'
  | 'user_mfa_coverage'
  | 'rbac_configured';

/** Which frameworks' controls each check supports. */
export const CHECK_FRAMEWORKS: Readonly<Record<ComplianceCheckId, ComplianceFramework[]>> = {
  data_retention_enforced: ['gdpr', 'soc2', 'iso27001'],
  audit_logging: ['soc2', 'iso27001', 'pci_dss'],
  admin_mfa: ['soc2', 'iso27001', 'pci_dss'],
  user_mfa_enforced: ['soc2', 'pci_dss'],
  user_mfa_coverage: ['soc2'],
  rbac_configured: ['soc2', 'iso27001'],
};

export const COMPLIANCE_FRAMEWORKS: readonly ComplianceFramework[] = [
  'gdpr',
  'soc2',
  'iso27001',
  'pci_dss',
];

/** Users with MFA at or above this share are compliant; at or above the lower one, a warning. */
export const USER_MFA_COMPLIANT_PERCENT = 80;
export const USER_MFA_WARNING_PERCENT = 50;

export interface ComplianceCheck {
  id: ComplianceCheckId;
  frameworks: ComplianceFramework[];
  status: ComplianceStatus;
  /** What the status was decided from. */
  facts: Record<string, number | string | boolean | null | string[]>;
}

export interface FrameworkSummary {
  framework: ComplianceFramework;
  status: ComplianceStatus;
  compliant_checks: number;
  warning_checks: number;
  non_compliant_checks: number;
  not_applicable_checks: number;
  total_checks: number;
}

export interface ComplianceCheckInput {
  retention: {
    attention: Array<{ category: RetentionCategoryId; reason: RetentionAttentionReason }>;
    expired_records: number;
  };
  audit: {
    /**
     * Whether the tenant's audit log can be queried here: supported, not_supported (an
     * archive-only profile, by design), or pending_runtime_support (its store is not available).
     */
    hot_query_status: 'supported' | 'not_supported' | 'pending_runtime_support';
    entries_last_30_days: number | null;
  };
  mfa: { enforcement: MfaEnforcement; admins: AdminMfaCoverage; users: UserMfaCoverage };
  rbac: { active_roles: number; users_with_roles: number };
}

function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

export function buildComplianceChecks(input: ComplianceCheckInput): ComplianceCheck[] {
  const { retention, audit, mfa, rbac } = input;
  const check = (
    id: ComplianceCheckId,
    status: ComplianceStatus,
    facts: ComplianceCheck['facts']
  ): ComplianceCheck => ({ id, frameworks: CHECK_FRAMEWORKS[id], status, facts });

  const userMfaPercent = percent(mfa.users.with_any, mfa.users.users);

  return [
    check('data_retention_enforced', retention.attention.length === 0 ? 'compliant' : 'warning', {
      attention: retention.attention.map((item) => `${item.category}:${item.reason}`),
      expired_records: retention.expired_records,
    }),
    // Audit logging is always on. A primary store that is not available, or a queryable log
    // with no entries for 30 days, is a warning; an archive-only profile is by design.
    check(
      'audit_logging',
      audit.hot_query_status === 'pending_runtime_support' ||
        (audit.hot_query_status === 'supported' && audit.entries_last_30_days === 0)
        ? 'warning'
        : 'compliant',
      { hot_query_status: audit.hot_query_status, entries_last_30_days: audit.entries_last_30_days }
    ),
    check(
      'admin_mfa',
      mfa.admins.admins === 0
        ? 'not_applicable'
        : mfa.admins.with_passkey === mfa.admins.admins
          ? 'compliant'
          : 'warning',
      { admins: mfa.admins.admins, with_passkey: mfa.admins.with_passkey }
    ),
    check('user_mfa_enforced', mfa.enforcement.enforced ? 'compliant' : 'warning', {
      assurance_enabled: mfa.enforcement.assurance_enabled,
      default_aal: mfa.enforcement.default_aal,
      scopes_requiring_mfa: mfa.enforcement.scopes_requiring_mfa,
    }),
    check(
      'user_mfa_coverage',
      mfa.users.users === 0
        ? 'not_applicable'
        : userMfaPercent >= USER_MFA_COMPLIANT_PERCENT
          ? 'compliant'
          : userMfaPercent >= USER_MFA_WARNING_PERCENT
            ? 'warning'
            : 'non_compliant',
      { users: mfa.users.users, with_mfa: mfa.users.with_any, percent: userMfaPercent }
    ),
    check(
      'rbac_configured',
      rbac.active_roles > 0 && rbac.users_with_roles > 0 ? 'compliant' : 'warning',
      { active_roles: rbac.active_roles, users_with_roles: rbac.users_with_roles }
    ),
  ];
}

/** The worst status among the given ones (all not applicable: not applicable). */
export function worstStatus(statuses: ComplianceStatus[]): ComplianceStatus {
  if (statuses.includes('non_compliant')) return 'non_compliant';
  if (statuses.includes('warning')) return 'warning';
  if (statuses.length === 0 || statuses.every((status) => status === 'not_applicable')) {
    return 'not_applicable';
  }
  return 'compliant';
}

export function summarizeFrameworks(checks: ComplianceCheck[]): FrameworkSummary[] {
  return COMPLIANCE_FRAMEWORKS.map((framework) => {
    const own = checks.filter((check) => check.frameworks.includes(framework));
    const count = (status: ComplianceStatus) =>
      own.filter((check) => check.status === status).length;
    return {
      framework,
      status: worstStatus(own.map((check) => check.status)),
      compliant_checks: count('compliant'),
      warning_checks: count('warning'),
      non_compliant_checks: count('non_compliant'),
      not_applicable_checks: count('not_applicable'),
      total_checks: own.length,
    };
  });
}
