/**
 * Plugin Settings Category
 *
 * Settings related to plugin execution and management.
 * `plugin.enabled` is the tenant's permission for external (custom, dynamic worker) plugin code to
 * run. It does not touch the built-in plugins: the email providers (Resend, Cloudflare Mail,
 * console), the CAPTCHA providers (Turnstile, reCAPTCHA, hCaptcha) and TOTP are chosen by the
 * plugin admin API, the Email Settings order and `authentication-methods.human_verification`, as
 * before. Whether a tenant admin or only the platform may flip it is not decided here: both may
 * (settings category `plugin` is tenant-scoped); a platform-only switch could be added later.
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
    label: 'External Plugins Enabled',
    description:
      'Allow the code of external (custom) plugins to run for this tenant. Built-in email, CAPTCHA and TOTP providers are not affected.',
    visibility: 'admin',
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
};
