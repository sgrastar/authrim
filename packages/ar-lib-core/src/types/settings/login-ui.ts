/**
 * Login UI Settings Category
 *
 * Settings related to Login UI appearance and behavior.
 * API: GET/PATCH /api/admin/tenants/:tenantId/settings/login-ui
 * Config Level: tenant
 *
 * These settings are consumed by:
 * - authentication-methods API (GET /api/auth/authentication-methods → ui section)
 * - Login UI (theme store, branding display)
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Login UI Settings Interface
 */
export interface LoginUISettings {
  // Theme
  'login-ui.theme': string;
  'login-ui.variant': string;

  // Branding
  'login-ui.brand_name': string;
  'login-ui.logo_url': string;
  'login-ui.favicon_url': string;

  // Locales
  'login-ui.supported_locales': string;

  // Appearance
  'login-ui.background_image_url': string;
  'login-ui.custom_css': string;
  'login-ui.header_text': string;
  'login-ui.footer_text': string;
  'login-ui.footer_links': string;
  'login-ui.custom_blocks': string;
}

/**
 * Login UI Settings Metadata
 */
export const LOGIN_UI_SETTINGS_META: Record<keyof LoginUISettings, SettingMeta> = {
  'login-ui.theme': {
    key: 'login-ui.theme',
    type: 'enum',
    default: 'light',
    envKey: 'LOGIN_UI_THEME',
    label: 'Theme Mode',
    description: 'Default theme mode for the Login UI (light or dark)',
    enum: ['light', 'dark'],
    visibility: 'public',
  },
  'login-ui.variant': {
    key: 'login-ui.variant',
    type: 'enum',
    default: 'beige',
    envKey: 'LOGIN_UI_VARIANT',
    label: 'Theme Variant',
    description:
      'Color variant for the Login UI. Light: beige, blue-gray, green. Dark: brown, navy, slate',
    enum: ['beige', 'blue-gray', 'green', 'brown', 'navy', 'slate'],
    visibility: 'public',
  },
  'login-ui.brand_name': {
    key: 'login-ui.brand_name',
    type: 'string',
    default: 'Authrim',
    envKey: 'LOGIN_UI_BRAND_NAME',
    label: 'Brand Name',
    description: 'Brand name displayed on the Login UI',
    visibility: 'public',
  },
  'login-ui.logo_url': {
    key: 'login-ui.logo_url',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_LOGO_URL',
    label: 'Logo URL',
    description: 'URL to the logo image displayed on the Login UI',
    visibility: 'public',
  },
  'login-ui.supported_locales': {
    key: 'login-ui.supported_locales',
    type: 'string',
    default: 'en,ja',
    envKey: 'LOGIN_UI_SUPPORTED_LOCALES',
    label: 'Supported Locales',
    description: 'Comma-separated list of supported UI locales (e.g., en,ja)',
    visibility: 'public',
  },
  'login-ui.favicon_url': {
    key: 'login-ui.favicon_url',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_FAVICON_URL',
    label: 'Favicon URL',
    description: 'URL to the favicon image displayed in browser tabs',
    visibility: 'public',
    status: 'in_development',
  },
  'login-ui.background_image_url': {
    key: 'login-ui.background_image_url',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_BACKGROUND_IMAGE_URL',
    label: 'Background Image URL',
    description: 'URL to the background image displayed on the Login UI',
    visibility: 'public',
    status: 'in_development',
  },
  'login-ui.custom_css': {
    key: 'login-ui.custom_css',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_CUSTOM_CSS',
    label: 'Custom CSS',
    description: 'Custom CSS to apply to the Login UI (restricted properties only)',
    visibility: 'public',
    status: 'in_development',
  },
  'login-ui.header_text': {
    key: 'login-ui.header_text',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_HEADER_TEXT',
    label: 'Header Text',
    description: 'Header text displayed above the login form',
    visibility: 'public',
    status: 'in_development',
  },
  'login-ui.footer_text': {
    key: 'login-ui.footer_text',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_FOOTER_TEXT',
    label: 'Footer Text',
    description: 'Footer text displayed below the login form (e.g., copyright notice)',
    visibility: 'public',
    status: 'in_development',
  },
  'login-ui.footer_links': {
    key: 'login-ui.footer_links',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_FOOTER_LINKS',
    label: 'Footer Links',
    description:
      'JSON array of footer links. Format: [{"label":"Privacy Policy","url":"https://..."}]',
    visibility: 'public',
    status: 'in_development',
  },
  'login-ui.custom_blocks': {
    key: 'login-ui.custom_blocks',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_CUSTOM_BLOCKS',
    label: 'Custom Blocks',
    description:
      'JSON array of custom content blocks. Format: [{"position":"above-form"|"below-form"|"above-header"|"below-footer","type":"text"|"html"|"image"|"link","content":"..."}]',
    visibility: 'public',
    status: 'in_development',
  },
};

/**
 * Login UI Category Metadata
 */
export const LOGIN_UI_CATEGORY_META: CategoryMeta = {
  category: 'login-ui',
  label: 'Login UI',
  description: 'Login UI appearance, theme, and branding settings',
  settings: LOGIN_UI_SETTINGS_META,
};

/**
 * Default Login UI settings values
 */
export const LOGIN_UI_DEFAULTS: LoginUISettings = {
  'login-ui.theme': 'light',
  'login-ui.variant': 'beige',
  'login-ui.brand_name': 'Authrim',
  'login-ui.logo_url': '',
  'login-ui.favicon_url': '',
  'login-ui.supported_locales': 'en,ja',
  'login-ui.background_image_url': '',
  'login-ui.custom_css': '',
  'login-ui.header_text': '',
  'login-ui.footer_text': '',
  'login-ui.footer_links': '',
  'login-ui.custom_blocks': '',
};
