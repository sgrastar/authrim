export type AuditEventFailureBehavior = 'fail_open_best_effort' | 'fail_closed_or_strong_retry';
export type AuditEventBackpressureMode = 'event_class' | 'fail_closed_all';

export type AuditEventFailureCategory =
  | 'login'
  | 'token'
  | 'user_activity'
  | 'signing_key'
  | 'admin_user'
  | 'role_permission'
  | 'policy'
  | 'security_setting'
  | 'tenant'
  | 'database'
  | 'storage_profile'
  | 'provisioning'
  | 'other';

export interface AuditEventClassification {
  category: AuditEventFailureCategory;
  behavior: AuditEventFailureBehavior;
  reason: string;
}

interface AuditEventClassificationRule {
  category: AuditEventFailureCategory;
  behavior: AuditEventFailureBehavior;
  reason: string;
  prefixes: readonly string[];
}

export const AUDIT_FAIL_OPEN_CATEGORIES: readonly AuditEventFailureCategory[] = [
  'login',
  'token',
  'user_activity',
] as const;

export const AUDIT_FAIL_CLOSED_CATEGORIES: readonly AuditEventFailureCategory[] = [
  'signing_key',
  'admin_user',
  'role_permission',
  'policy',
  'security_setting',
  'tenant',
  'database',
  'storage_profile',
  'provisioning',
  'other',
] as const;

const FAIL_CLOSED_RULES: readonly AuditEventClassificationRule[] = [
  {
    category: 'signing_key',
    behavior: 'fail_closed_or_strong_retry',
    reason: 'Signing key changes affect token trust and must not be silently lost.',
    prefixes: ['signing_key.', 'signing_keys.', 'key_manager.', 'key.'],
  },
  {
    category: 'admin_user',
    behavior: 'fail_closed_or_strong_retry',
    reason: 'Admin user and admin credential changes are privileged control-plane events.',
    prefixes: ['admin_user.', 'admin_audit.', 'passkey.'],
  },
  {
    category: 'role_permission',
    behavior: 'fail_closed_or_strong_retry',
    reason: 'Role, permission, and relationship changes affect authorization decisions.',
    prefixes: ['admin_role.', 'role.', 'permission.', 'admin_relationship.', 'relationship.'],
  },
  {
    category: 'policy',
    behavior: 'fail_closed_or_strong_retry',
    reason: 'Policy changes affect authorization, token, and tenant behavior.',
    prefixes: ['policy.', 'admin_policy.', 'tenant_policy.', 'contract_policy.'],
  },
  {
    category: 'security_setting',
    behavior: 'fail_closed_or_strong_retry',
    reason: 'Security setting changes must remain auditable during incidents.',
    prefixes: [
      'security.',
      'security_setting.',
      'ip_allowlist.',
      'mfa_policy.',
      'refresh_token.theft_detected',
      'refresh_token.family_revoked',
      'token.theft_detected',
      'token.replay_detected',
      'dpop.replay_detected',
    ],
  },
  {
    category: 'tenant',
    behavior: 'fail_closed_or_strong_retry',
    reason: 'Tenant lifecycle changes affect isolation and routing.',
    prefixes: ['tenant.', 'tenant_runtime.', 'runtime_registry.'],
  },
  {
    category: 'database',
    behavior: 'fail_closed_or_strong_retry',
    reason: 'Database connection and registry changes affect durable data placement.',
    prefixes: ['database.', 'database_connection.', 'tenant_database.'],
  },
  {
    category: 'storage_profile',
    behavior: 'fail_closed_or_strong_retry',
    reason: 'Storage profile and destination changes affect data residency and isolation.',
    prefixes: ['storage_profile.', 'storage_destination.', 'runtime_profile.storage.'],
  },
  {
    category: 'provisioning',
    behavior: 'fail_closed_or_strong_retry',
    reason: 'Provisioning and migration jobs affect tenant availability and data placement.',
    prefixes: ['provisioning.', 'migration.', 'tenant_database_migration.', 'job.'],
  },
  {
    category: 'admin_user',
    behavior: 'fail_closed_or_strong_retry',
    reason: 'User administrative state changes affect account access and must be explicit.',
    prefixes: [
      'user.create',
      'user.update',
      'user.delete',
      'user.suspend',
      'user.activate',
      'user.unlock',
      'user.lock',
      'user.anonymized',
      'user.pii_',
    ],
  },
] as const;

const FAIL_OPEN_RULES: readonly AuditEventClassificationRule[] = [
  {
    category: 'login',
    behavior: 'fail_open_best_effort',
    reason: 'Login audit is high-volume and must not block normal authentication success.',
    prefixes: [
      'login.',
      'logout.',
      'auth.login.',
      'auth.logout.',
      'user.login',
      'user.logout',
      'email_code.',
      'anonymous_login.',
    ],
  },
  {
    category: 'token',
    behavior: 'fail_open_best_effort',
    reason: 'Token audit is high-volume and should use retry or best-effort delivery.',
    prefixes: ['token.', 'refresh_token.', 'userinfo.', 'introspection.', 'native_sso.'],
  },
  {
    category: 'user_activity',
    behavior: 'fail_open_best_effort',
    reason: 'User activity audit is high-volume and not required for request correctness.',
    prefixes: ['user.activity.', 'session.activity.', 'consent.view.', 'profile.view.'],
  },
] as const;

function normalizeAuditAction(action: string): string {
  return action.trim().toLowerCase().replaceAll(':', '.');
}

function matchesPrefix(action: string, prefix: string): boolean {
  if (prefix.endsWith('.')) {
    return action === prefix.slice(0, -1) || action.startsWith(prefix);
  }
  if (prefix.endsWith('_')) {
    return action.startsWith(prefix);
  }
  return action === prefix || action.startsWith(`${prefix}.`);
}

function findClassificationRule(
  action: string,
  rules: readonly AuditEventClassificationRule[]
): AuditEventClassificationRule | null {
  for (const rule of rules) {
    if (rule.prefixes.some((prefix) => matchesPrefix(action, prefix))) {
      return rule;
    }
  }
  return null;
}

export function classifyAuditEvent(action: string): AuditEventClassification {
  const normalizedAction = normalizeAuditAction(action);
  const failClosedRule = findClassificationRule(normalizedAction, FAIL_CLOSED_RULES);

  if (failClosedRule) {
    return {
      category: failClosedRule.category,
      behavior: failClosedRule.behavior,
      reason: failClosedRule.reason,
    };
  }

  const failOpenRule = findClassificationRule(normalizedAction, FAIL_OPEN_RULES);

  if (failOpenRule) {
    return {
      category: failOpenRule.category,
      behavior: failOpenRule.behavior,
      reason: failOpenRule.reason,
    };
  }

  return {
    category: 'other',
    behavior: 'fail_closed_or_strong_retry',
    reason:
      'Unclassified audit events default to strong delivery until the event catalog explicitly marks them safe for best-effort delivery.',
  };
}

export function resolveAuditEventFailureBehavior(
  action: string,
  mode: AuditEventBackpressureMode = 'event_class'
): AuditEventClassification {
  const classification = classifyAuditEvent(action);

  if (mode === 'fail_closed_all' && classification.behavior !== 'fail_closed_or_strong_retry') {
    return {
      ...classification,
      behavior: 'fail_closed_or_strong_retry',
      reason: `Audit profile fail_closed_all mode overrides event-class behavior. ${classification.reason}`,
    };
  }

  return classification;
}
