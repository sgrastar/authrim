/**
 * Support Operations Settings Category
 *
 * Tenant-scoped controls for privacy-preserving support operations.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/support-ops
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface SupportOpsSettings {
  /** Allow the same admin operator to approve a support operation action they requested */
  'support_ops.allow_self_approval': boolean;
  /** Required separation among requester, approver, and executor */
  'support_ops.duty_separation': 'requester_approver' | 'requester_approver_executor';
}

export const SUPPORT_OPS_SETTINGS_META: Record<keyof SupportOpsSettings, SettingMeta> = {
  'support_ops.allow_self_approval': {
    key: 'support_ops.allow_self_approval',
    type: 'boolean',
    default: false,
    envKey: 'SUPPORT_OPS_ALLOW_SELF_APPROVAL',
    label: 'Allow Self Approval',
    description:
      'Allow the same admin operator to approve a support operation action they requested. Keep disabled for two-person approval.',
    visibility: 'admin',
  },
  'support_ops.duty_separation': {
    key: 'support_ops.duty_separation',
    type: 'enum',
    default: 'requester_approver',
    envKey: 'SUPPORT_OPS_DUTY_SEPARATION',
    label: 'Duty Separation',
    description:
      'Controls whether support operation execution must be performed by a third operator after request and approval.',
    visibility: 'admin',
    enum: ['requester_approver', 'requester_approver_executor'],
  },
};

export const SUPPORT_OPS_CATEGORY_META: CategoryMeta = {
  category: 'support-ops',
  label: 'Support Operations',
  description: 'Privacy-preserving support operation approval and execution controls',
  settings: SUPPORT_OPS_SETTINGS_META,
};

export const SUPPORT_OPS_DEFAULTS: SupportOpsSettings = {
  'support_ops.allow_self_approval': false,
  'support_ops.duty_separation': 'requester_approver',
};
