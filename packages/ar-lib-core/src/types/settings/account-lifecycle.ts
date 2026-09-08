import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

export interface AccountLifecycleSettings {
  'account-lifecycle.guest.deletion_enabled': boolean;
  'account-lifecycle.guest.deletion_after_days': number;
  'account-lifecycle.guest.upgrade_enabled': boolean;
  'account-lifecycle.guest.upgrade_hold_minutes': number;
}

export const ACCOUNT_LIFECYCLE_DEFAULTS: AccountLifecycleSettings = {
  'account-lifecycle.guest.deletion_enabled': false,
  'account-lifecycle.guest.deletion_after_days': 30,
  'account-lifecycle.guest.upgrade_enabled': true,
  'account-lifecycle.guest.upgrade_hold_minutes': 10,
};

export const ACCOUNT_LIFECYCLE_SETTINGS_META: Record<keyof AccountLifecycleSettings, SettingMeta> =
  {
    'account-lifecycle.guest.deletion_enabled': {
      key: 'account-lifecycle.guest.deletion_enabled',
      type: 'boolean',
      default: false,
      label: 'Automatically delete guest accounts',
      description:
        'Apply creation-based retention to newly created human guest accounts. Existing accounts require an explicit preview and apply operation.',
      visibility: 'page',
    },
    'account-lifecycle.guest.deletion_after_days': {
      key: 'account-lifecycle.guest.deletion_after_days',
      type: 'number',
      default: 30,
      label: 'Days after creation',
      description: 'Deletion eligibility starts this many days after creation, not last use.',
      min: 1,
      max: 3650,
      integer: true,
      unit: 'days',
      visibility: 'page',
    },
    'account-lifecycle.guest.upgrade_enabled': {
      key: 'account-lifecycle.guest.upgrade_enabled',
      type: 'boolean',
      default: true,
      label: 'Allow guest upgrades',
      description:
        'Allow guests to register an enabled authentication method while retaining their subject.',
      visibility: 'page',
    },
    'account-lifecycle.guest.upgrade_hold_minutes': {
      key: 'account-lifecycle.guest.upgrade_hold_minutes',
      type: 'number',
      default: 10,
      label: 'Upgrade deletion hold',
      description:
        'One-time deletion hold when a guest starts upgrading. Does not extend authentication proof validity.',
      min: 1,
      max: 60,
      integer: true,
      unit: 'minutes',
      visibility: 'page',
    },
  };

export const ACCOUNT_LIFECYCLE_CATEGORY_META: CategoryMeta = {
  category: 'account-lifecycle',
  label: 'Account lifecycle',
  description: 'Human guest retention and registration policy',
  settings: ACCOUNT_LIFECYCLE_SETTINGS_META,
};
