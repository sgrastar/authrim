/**
 * Check API Audit Settings Category
 *
 * Configuration for permission check audit logging.
 * API: GET/PATCH /api/admin/platform/settings/check-api-audit
 * Config Level: platform
 *
 * Supports 3 audit modes:
 * - waitUntil: Non-blocking (recommended for most cases)
 * - sync: Synchronous logging (guaranteed logging before response)
 * - queue: Queue-based async processing (high-scale scenarios)
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Audit log mode
 */
export type CheckApiAuditMode = 'waitUntil' | 'sync' | 'queue';

/**
 * Audit log allow policy
 */
export type CheckApiAuditLogAllow = 'always' | 'sample' | 'never';

/**
 * Check API Audit Settings Interface
 */
export interface CheckApiAuditSettings {
  /** Enable permission check audit logging */
  'audit.check_api_enabled': boolean;
  /** Audit log recording mode */
  'audit.check_api_mode': CheckApiAuditMode;
  /** How to log allow events (deny events are always logged) */
  'audit.check_api_log_allow': CheckApiAuditLogAllow;
  /** Sample rate for allow events (0.0-1.0, e.g., 0.01 = 1%) */
  'audit.check_api_sample_rate': number;
  /** Retention period for audit logs in days */
  'audit.check_api_retention_days': number;
}

/**
 * Check API Audit Settings Metadata
 */
export const CHECK_API_AUDIT_SETTINGS_META: Record<keyof CheckApiAuditSettings, SettingMeta> = {
  'audit.check_api_enabled': {
    key: 'audit.check_api_enabled',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CHECK_API_AUDIT',
    // As the Check API read it: only 'true' turns it on.
    envBoolean: 'exactly-true',
    label: 'Enable Audit Logging',
    description: 'Enable permission check audit logging',
    visibility: 'admin',
  },
  'audit.check_api_mode': {
    key: 'audit.check_api_mode',
    type: 'enum',
    default: 'waitUntil',
    envKey: 'CHECK_API_AUDIT_MODE',
    label: 'Audit Mode',
    description:
      'Audit log recording mode: waitUntil (non-blocking), sync (guaranteed), queue (high-scale)',
    visibility: 'admin',
    enum: ['waitUntil', 'sync', 'queue'],
  },
  'audit.check_api_log_allow': {
    key: 'audit.check_api_log_allow',
    type: 'enum',
    default: 'sample',
    envKey: 'CHECK_API_AUDIT_LOG_ALLOW',
    label: 'Log Allow Policy',
    description: 'How to log allowed permission checks: always, sample (recommended), never',
    visibility: 'admin',
    enum: ['always', 'sample', 'never'],
  },
  'audit.check_api_sample_rate': {
    key: 'audit.check_api_sample_rate',
    type: 'number',
    default: 0.01,
    envKey: 'CHECK_API_AUDIT_SAMPLE_RATE',
    label: 'Sample Rate',
    description: 'Sample rate for allow events (0.0-1.0, e.g., 0.01 = 1%)',
    visibility: 'admin',
    min: 0,
    max: 1,
    // As the Check API read it: a decimal in 0..1, else the default.
    envNumber: 'fraction-in-range',
  },
  'audit.check_api_retention_days': {
    key: 'audit.check_api_retention_days',
    type: 'number',
    default: 90,
    envKey: 'CHECK_API_AUDIT_RETENTION_DAYS',
    label: 'Retention Days',
    description: 'Number of days to retain audit logs (default: 90)',
    visibility: 'admin',
    min: 1,
    max: 3650, // 10 years max
    integer: true,
    // As the Check API read it: 0 or less left the default.
    envNumber: 'positive',
  },
};

/**
 * Check API Audit Category Metadata
 */
export const CHECK_API_AUDIT_CATEGORY_META: CategoryMeta = {
  category: 'check-api-audit',
  label: 'Check API Audit',
  description: 'Permission check audit logging configuration',
  settings: CHECK_API_AUDIT_SETTINGS_META,
};

/**
 * Default Check API Audit settings values
 */
export const CHECK_API_AUDIT_DEFAULTS: CheckApiAuditSettings = {
  'audit.check_api_enabled': false,
  'audit.check_api_mode': 'waitUntil',
  'audit.check_api_log_allow': 'sample',
  'audit.check_api_sample_rate': 0.01,
  'audit.check_api_retention_days': 90,
};
