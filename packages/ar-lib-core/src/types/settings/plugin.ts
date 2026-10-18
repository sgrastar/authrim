/**
 * Plugin Settings Category
 *
 * Settings related to plugin execution and management.
 * How long a plugin may run is not a tenant setting: ar-plugin-runner reads it from the policy of
 * each installation (timeout_ms, 1 to 30,000 ms), so the tenant has no switch for it.
 * Updating plugins is not a setting either: there is no source to check for updates (no registry or
 * distribution point), so a switch for it would do nothing. Design it anew when an update mechanism
 * is built.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/plugin
 * Config Level: tenant
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Plugin Settings Interface
 */
export interface PluginSettings {
  // Plugin Execution
  'plugin.enabled': boolean;

  // Individual Plugin Enable/Disable
  'plugin.notifier_resend_enabled': boolean;
}

/**
 * Plugin Settings Metadata
 */
export const PLUGIN_SETTINGS_META: Record<keyof PluginSettings, SettingMeta> = {
  'plugin.enabled': {
    key: 'plugin.enabled',
    type: 'boolean',
    default: false,
    envKey: 'PLUGIN_ENABLED',
    label: 'Plugins Enabled',
    description: 'Enable plugin execution for this tenant',
    visibility: 'admin',
    status: 'in_development',
  },
  'plugin.notifier_resend_enabled': {
    key: 'plugin.notifier_resend_enabled',
    type: 'boolean',
    default: true,
    envKey: 'PLUGIN_NOTIFIER_RESEND_ENABLED',
    label: 'Resend Email Plugin',
    description:
      'Enable the Resend Email notifier plugin for sending OTP codes and transactional emails',
    visibility: 'admin',
    dependsOn: [{ key: 'plugin.enabled', value: true }],
  },
};

/**
 * Plugin Category Metadata
 */
export const PLUGIN_CATEGORY_META: CategoryMeta = {
  category: 'plugin',
  label: 'Plugins',
  description: 'Plugin execution and management settings',
  settings: PLUGIN_SETTINGS_META,
};

/**
 * Default Plugin settings values
 */
export const PLUGIN_DEFAULTS: PluginSettings = {
  'plugin.enabled': false,
  'plugin.notifier_resend_enabled': true,
};
