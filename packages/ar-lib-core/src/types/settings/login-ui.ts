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
  'login-ui.theme_template': string;
  'login-ui.published_version': number;
  'login-ui.published_at': string;
  'login-ui.published_snapshot': string;
  'login-ui.rollback_snapshot': string;
  'login-ui.page_layout': string;
  'login-ui.font_family': string;
  'login-ui.font_scale': string;
  'login-ui.background_color': string;
  'login-ui.title_color': string;
  'login-ui.text_color': string;
  'login-ui.copy_color': string;

  // Branding
  'login-ui.brand_name': string;
  'login-ui.logo_url': string;
  'login-ui.favicon_url': string;
  'login-ui.thumbnail_url': string;
  'login-ui.logo_display': string;
  'login-ui.logo_layout': string;
  'login-ui.brand_panel_title': string;
  'login-ui.brand_panel_text': string;

  // Locales
  'login-ui.supported_locales': string;
  'login-ui.default_locale': string;

  // Appearance
  'login-ui.background_image_url': string;
  'login-ui.login_panel_background_image_url': string;
  'login-ui.custom_css': string;
  'login-ui.header_enabled': boolean;
  'login-ui.subtitle_enabled': boolean;
  'login-ui.footer_enabled': boolean;
  'login-ui.powered_by_enabled': boolean;
  'login-ui.auth_switch_link_enabled': boolean;
  'login-ui.topbar_position': string;
  'login-ui.theme_toggle_enabled': boolean;
  'login-ui.language_select_enabled': boolean;
  'login-ui.language_switcher_position': string;
  'login-ui.header_style': string;
  'login-ui.footer_style': string;
  'login-ui.split_frame': string;
  'login-ui.split_panel_side': string;
  'login-ui.split_panel_width': string;
  'login-ui.split_background_mode': string;
  'login-ui.login_panel_background_color': string;
  'login-ui.login_panel_background_gradient_color': string;
  'login-ui.login_panel_background_opacity': number;
  'login-ui.brand_content_mode': string;
  'login-ui.brand_position': string;
  'login-ui.brand_align': string;
  'login-ui.header_text': string;
  'login-ui.footer_text': string;
  'login-ui.footer_links': string;
  'login-ui.custom_blocks': string;
  'login-ui.custom_themes': string;
  'login-ui.account_pages': string;
  'login-ui.account_page_draft': string;
  'login-ui.account_page_published': string;
  'login-ui.account_page_published_version': number;
  'login-ui.account_page_published_at': string;
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
  'login-ui.theme_template': {
    key: 'login-ui.theme_template',
    type: 'enum',
    default: 'meridian',
    envKey: 'LOGIN_UI_THEME_TEMPLATE',
    label: 'Theme Template',
    description: 'Built-in Login UI theme template',
    enum: ['classic', 'meridian', 'split-brand-panel', 'fullbleed-glass'],
    visibility: 'public',
  },
  'login-ui.published_version': {
    key: 'login-ui.published_version',
    type: 'number',
    default: 0,
    envKey: 'LOGIN_UI_PUBLISHED_VERSION',
    label: 'Published Version',
    description: 'Latest published Login UI theme version',
    min: 0,
    visibility: 'internal',
    status: 'in_development',
  },
  'login-ui.published_at': {
    key: 'login-ui.published_at',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_PUBLISHED_AT',
    label: 'Published At',
    description: 'ISO timestamp of the latest published Login UI theme version',
    visibility: 'internal',
    status: 'in_development',
  },
  'login-ui.published_snapshot': {
    key: 'login-ui.published_snapshot',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_PUBLISHED_SNAPSHOT',
    label: 'Published Snapshot',
    description: 'Serialized Login UI settings snapshot for the latest published version',
    visibility: 'internal',
    status: 'in_development',
  },
  'login-ui.rollback_snapshot': {
    key: 'login-ui.rollback_snapshot',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_ROLLBACK_SNAPSHOT',
    label: 'Rollback Snapshot',
    description: 'Serialized Login UI settings snapshot used to roll back the latest publish',
    visibility: 'internal',
    status: 'in_development',
  },
  'login-ui.page_layout': {
    key: 'login-ui.page_layout',
    type: 'enum',
    default: 'centered_card',
    envKey: 'LOGIN_UI_PAGE_LAYOUT',
    label: 'Page Layout',
    description: 'Outer page layout for Login UI screens',
    enum: ['centered_card', 'split_panel', 'fullbleed_card'],
    visibility: 'public',
  },
  'login-ui.font_family': {
    key: 'login-ui.font_family',
    type: 'enum',
    default: 'system',
    envKey: 'LOGIN_UI_FONT_FAMILY',
    label: 'Font Family',
    description: 'Font family preset used by Login UI',
    enum: ['system', 'rounded', 'serif', 'mono'],
    visibility: 'public',
  },
  'login-ui.font_scale': {
    key: 'login-ui.font_scale',
    type: 'enum',
    default: 'comfortable',
    envKey: 'LOGIN_UI_FONT_SCALE',
    label: 'Font Scale',
    description: 'Typography density preset used by Login UI',
    enum: ['compact', 'comfortable', 'spacious'],
    visibility: 'public',
  },
  'login-ui.background_color': {
    key: 'login-ui.background_color',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_BACKGROUND_COLOR',
    label: 'Background Color',
    description:
      'Page background color override. Empty follows the selected theme template background',
    visibility: 'public',
  },
  'login-ui.title_color': {
    key: 'login-ui.title_color',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_TITLE_COLOR',
    label: 'Title Color',
    description: 'Optional CSS color override for Login UI headings and titles',
    visibility: 'public',
  },
  'login-ui.text_color': {
    key: 'login-ui.text_color',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_TEXT_COLOR',
    label: 'Text Color',
    description: 'Optional CSS color override for primary Login UI body text',
    visibility: 'public',
  },
  'login-ui.copy_color': {
    key: 'login-ui.copy_color',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_COPY_COLOR',
    label: 'Copy Color',
    description: 'Optional CSS color override for supporting copy, subtitles, and helper text',
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
  'login-ui.logo_display': {
    key: 'login-ui.logo_display',
    type: 'enum',
    default: 'auto',
    envKey: 'LOGIN_UI_LOGO_DISPLAY',
    label: 'Logo Display',
    description: 'Logo rendering priority. Auto uses image first, then brand text fallback',
    enum: ['auto', 'image', 'text', 'hidden'],
    visibility: 'public',
  },
  'login-ui.brand_panel_title': {
    key: 'login-ui.brand_panel_title',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_BRAND_PANEL_TITLE',
    label: 'Brand Panel Title',
    description: 'Optional title displayed in split page layouts',
    visibility: 'public',
  },
  'login-ui.brand_panel_text': {
    key: 'login-ui.brand_panel_text',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_BRAND_PANEL_TEXT',
    label: 'Brand Panel Text',
    description: 'Optional supporting text displayed in split page layouts',
    visibility: 'public',
  },
  'login-ui.supported_locales': {
    key: 'login-ui.supported_locales',
    type: 'string',
    default: 'en,ja,zh-CN,zh-TW,es,pt,fr,de,ko,ru,id',
    envKey: 'LOGIN_UI_SUPPORTED_LOCALES',
    label: 'Supported Locales',
    description: 'Comma-separated list of supported LoginUI locales',
    visibility: 'public',
  },
  'login-ui.default_locale': {
    key: 'login-ui.default_locale',
    type: 'enum',
    default: 'en',
    envKey: 'LOGIN_UI_DEFAULT_LOCALE',
    label: 'Default Locale',
    description: 'Fallback locale used when no enabled browser or saved locale matches',
    enum: ['en', 'ja', 'zh-CN', 'zh-TW', 'es', 'pt', 'fr', 'de', 'ko', 'ru', 'id'],
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
  },
  'login-ui.thumbnail_url': {
    key: 'login-ui.thumbnail_url',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_THUMBNAIL_URL',
    label: 'Thumbnail URL',
    description: 'URL to the manually uploaded thumbnail used by Admin UI theme previews',
    visibility: 'public',
  },
  'login-ui.background_image_url': {
    key: 'login-ui.background_image_url',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_BACKGROUND_IMAGE_URL',
    label: 'Background Image URL',
    description: 'URL to the background image displayed on the Login UI',
    visibility: 'public',
  },
  'login-ui.login_panel_background_image_url': {
    key: 'login-ui.login_panel_background_image_url',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_LOGIN_PANEL_BACKGROUND_IMAGE_URL',
    label: 'Login Panel Background Image URL',
    description: 'Optional image used by the independent login panel background mode',
    visibility: 'public',
  },
  'login-ui.custom_css': {
    key: 'login-ui.custom_css',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_CUSTOM_CSS',
    label: 'Custom CSS',
    description: 'Custom CSS to apply to the Login UI (restricted properties only)',
    visibility: 'public',
  },
  'login-ui.header_enabled': {
    key: 'login-ui.header_enabled',
    type: 'boolean',
    default: true,
    envKey: 'LOGIN_UI_HEADER_ENABLED',
    label: 'Show Header',
    description: 'Display the Login UI header area',
    visibility: 'public',
  },
  'login-ui.subtitle_enabled': {
    key: 'login-ui.subtitle_enabled',
    type: 'boolean',
    default: true,
    envKey: 'LOGIN_UI_SUBTITLE_ENABLED',
    label: 'Show Subtitle',
    description: 'Display the Login UI subtitle below the brand title',
    visibility: 'public',
  },
  'login-ui.footer_enabled': {
    key: 'login-ui.footer_enabled',
    type: 'boolean',
    default: true,
    envKey: 'LOGIN_UI_FOOTER_ENABLED',
    label: 'Show Footer',
    description: 'Display the Login UI footer area',
    visibility: 'public',
  },
  'login-ui.powered_by_enabled': {
    key: 'login-ui.powered_by_enabled',
    type: 'boolean',
    default: true,
    envKey: 'LOGIN_UI_POWERED_BY_ENABLED',
    label: 'Show Powered By',
    description: 'Display the powered-by text in the Login UI footer',
    visibility: 'public',
  },
  'login-ui.auth_switch_link_enabled': {
    key: 'login-ui.auth_switch_link_enabled',
    type: 'boolean',
    default: true,
    envKey: 'LOGIN_UI_AUTH_SWITCH_LINK_ENABLED',
    label: 'Show Login/Register Link',
    description: 'Display the link that switches between login and registration pages',
    visibility: 'public',
  },
  'login-ui.topbar_position': {
    key: 'login-ui.topbar_position',
    type: 'enum',
    default: 'below_card',
    envKey: 'LOGIN_UI_TOPBAR_POSITION',
    label: 'Topbar Position',
    description: 'Where the theme toggle and language selector are displayed on Login UI pages',
    enum: [
      'below_card',
      'in_card',
      'top_right',
      'bottom_left',
      'bottom_center',
      'bottom_right',
      'hidden',
    ],
    visibility: 'public',
  },
  'login-ui.theme_toggle_enabled': {
    key: 'login-ui.theme_toggle_enabled',
    type: 'boolean',
    default: true,
    envKey: 'LOGIN_UI_THEME_TOGGLE_ENABLED',
    label: 'Show Theme Toggle',
    description: 'Display the user-controlled light/dark theme toggle',
    visibility: 'public',
  },
  'login-ui.language_select_enabled': {
    key: 'login-ui.language_select_enabled',
    type: 'boolean',
    default: true,
    envKey: 'LOGIN_UI_LANGUAGE_SELECT_ENABLED',
    label: 'Show Language Selector',
    description: 'Display the language selector on Login UI pages',
    visibility: 'public',
  },
  'login-ui.language_switcher_position': {
    key: 'login-ui.language_switcher_position',
    type: 'enum',
    default: 'below_card',
    envKey: 'LOGIN_UI_LANGUAGE_SWITCHER_POSITION',
    label: 'Language Switcher Position',
    description: 'Where the language switcher is displayed on Login UI pages',
    enum: ['below_card', 'top_right', 'hidden'],
    visibility: 'public',
  },
  'login-ui.header_style': {
    key: 'login-ui.header_style',
    type: 'enum',
    default: 'center',
    envKey: 'LOGIN_UI_HEADER_STYLE',
    label: 'Header Style',
    description: 'Header presentation style for the Login UI outer page',
    enum: ['center', 'bar'],
    visibility: 'public',
  },
  'login-ui.footer_style': {
    key: 'login-ui.footer_style',
    type: 'enum',
    default: 'simple',
    envKey: 'LOGIN_UI_FOOTER_STYLE',
    label: 'Footer Style',
    description: 'Footer presentation style for the Login UI outer page',
    enum: ['simple', 'bar'],
    visibility: 'public',
  },
  'login-ui.logo_layout': {
    key: 'login-ui.logo_layout',
    type: 'enum',
    default: 'stack',
    envKey: 'LOGIN_UI_LOGO_LAYOUT',
    label: 'Logo Layout',
    description: 'Logo and brand text layout in the Login UI header',
    enum: ['stack', 'row'],
    visibility: 'public',
  },
  'login-ui.split_frame': {
    key: 'login-ui.split_frame',
    type: 'enum',
    default: 'full',
    envKey: 'LOGIN_UI_SPLIT_FRAME',
    label: 'Split Frame',
    description: 'Whether split-panel themes use a full-page or framed card shell',
    enum: ['full', 'card'],
    visibility: 'public',
  },
  'login-ui.split_panel_side': {
    key: 'login-ui.split_panel_side',
    type: 'enum',
    default: 'left',
    envKey: 'LOGIN_UI_SPLIT_PANEL_SIDE',
    label: 'Split Panel Side',
    description: 'Side where the split brand panel is displayed',
    enum: ['left', 'right'],
    visibility: 'public',
  },
  'login-ui.split_panel_width': {
    key: 'login-ui.split_panel_width',
    type: 'enum',
    default: 'narrow',
    envKey: 'LOGIN_UI_SPLIT_PANEL_WIDTH',
    label: 'Split Panel Width',
    description: 'Width preset for the split sign-in panel',
    enum: ['narrow', 'wide'],
    visibility: 'public',
  },
  'login-ui.split_background_mode': {
    key: 'login-ui.split_background_mode',
    type: 'enum',
    default: 'shared',
    envKey: 'LOGIN_UI_SPLIT_BACKGROUND_MODE',
    label: 'Split Background Mode',
    description: 'Controls how page, brand, and login panel background layers are composed',
    enum: ['shared', 'brand', 'panel'],
    visibility: 'public',
  },
  'login-ui.login_panel_background_color': {
    key: 'login-ui.login_panel_background_color',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_LOGIN_PANEL_BACKGROUND_COLOR',
    label: 'Login Panel Background Color',
    description: 'Optional solid or gradient start color for the login panel',
    visibility: 'public',
  },
  'login-ui.login_panel_background_gradient_color': {
    key: 'login-ui.login_panel_background_gradient_color',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_LOGIN_PANEL_BACKGROUND_GRADIENT_COLOR',
    label: 'Login Panel Gradient Color',
    description: 'Optional gradient end color for the login panel',
    visibility: 'public',
  },
  'login-ui.login_panel_background_opacity': {
    key: 'login-ui.login_panel_background_opacity',
    type: 'number',
    default: 70,
    envKey: 'LOGIN_UI_LOGIN_PANEL_BACKGROUND_OPACITY',
    label: 'Login Panel Image Opacity',
    description: 'Opacity of the independent login panel image from transparent to clear',
    min: 0,
    max: 100,
    unit: 'percent',
    visibility: 'public',
  },
  'login-ui.brand_content_mode': {
    key: 'login-ui.brand_content_mode',
    type: 'enum',
    default: 'logo_copy',
    envKey: 'LOGIN_UI_BRAND_CONTENT_MODE',
    label: 'Brand Content',
    description: 'Content displayed in the split brand panel',
    enum: ['logo_copy', 'logo', 'none'],
    visibility: 'public',
  },
  'login-ui.brand_position': {
    key: 'login-ui.brand_position',
    type: 'enum',
    default: 'center',
    envKey: 'LOGIN_UI_BRAND_POSITION',
    label: 'Brand Position',
    description: 'Vertical placement for split brand panel content',
    enum: ['top', 'center', 'bottom'],
    visibility: 'public',
  },
  'login-ui.brand_align': {
    key: 'login-ui.brand_align',
    type: 'enum',
    default: 'left',
    envKey: 'LOGIN_UI_BRAND_ALIGN',
    label: 'Brand Alignment',
    description: 'Text alignment for split brand panel content',
    enum: ['left', 'center', 'right'],
    visibility: 'public',
  },
  'login-ui.header_text': {
    key: 'login-ui.header_text',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_HEADER_TEXT',
    label: 'Header Text',
    description: 'Header text displayed above the login form',
    visibility: 'public',
  },
  'login-ui.footer_text': {
    key: 'login-ui.footer_text',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_FOOTER_TEXT',
    label: 'Footer Text',
    description: 'Footer text displayed below the login form (e.g., copyright notice)',
    visibility: 'public',
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
  },
  'login-ui.custom_themes': {
    key: 'login-ui.custom_themes',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_CUSTOM_THEMES',
    label: 'Custom Themes',
    description:
      'JSON document holding duplicated Login UI themes managed from the Themes admin page',
    visibility: 'public',
  },
  'login-ui.account_pages': {
    key: 'login-ui.account_pages',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_ACCOUNT_PAGES',
    label: 'Account Pages',
    description: 'Versioned custom account pages with resolved published screen snapshots',
    visibility: 'internal',
    status: 'in_development',
  },
  'login-ui.account_page_draft': {
    key: 'login-ui.account_page_draft',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_ACCOUNT_PAGE_DRAFT',
    label: 'Account Page Draft',
    description: 'Serialized draft account page composition managed from Admin UI',
    visibility: 'internal',
    status: 'in_development',
  },
  'login-ui.account_page_published': {
    key: 'login-ui.account_page_published',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_ACCOUNT_PAGE_PUBLISHED',
    label: 'Published Account Page',
    description: 'Serialized published account page composition used by Login UI',
    visibility: 'internal',
    status: 'in_development',
  },
  'login-ui.account_page_published_version': {
    key: 'login-ui.account_page_published_version',
    type: 'number',
    default: 0,
    envKey: 'LOGIN_UI_ACCOUNT_PAGE_PUBLISHED_VERSION',
    label: 'Published Account Page Version',
    description: 'Monotonic version of the published account page composition',
    min: 0,
    visibility: 'internal',
    status: 'in_development',
  },
  'login-ui.account_page_published_at': {
    key: 'login-ui.account_page_published_at',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_ACCOUNT_PAGE_PUBLISHED_AT',
    label: 'Published Account Page At',
    description: 'ISO timestamp of the latest account page publication',
    visibility: 'internal',
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
  'login-ui.theme_template': 'meridian',
  'login-ui.published_version': 0,
  'login-ui.published_at': '',
  'login-ui.published_snapshot': '',
  'login-ui.rollback_snapshot': '',
  'login-ui.page_layout': 'centered_card',
  'login-ui.font_family': 'system',
  'login-ui.font_scale': 'comfortable',
  'login-ui.background_color': '',
  'login-ui.title_color': '',
  'login-ui.text_color': '',
  'login-ui.copy_color': '',
  'login-ui.brand_name': 'Authrim',
  'login-ui.logo_url': '',
  'login-ui.favicon_url': '',
  'login-ui.thumbnail_url': '',
  'login-ui.logo_display': 'auto',
  'login-ui.logo_layout': 'stack',
  'login-ui.brand_panel_title': '',
  'login-ui.brand_panel_text': '',
  'login-ui.supported_locales': 'en,ja,zh-CN,zh-TW,es,pt,fr,de,ko,ru,id',
  'login-ui.default_locale': 'en',
  'login-ui.background_image_url': '',
  'login-ui.login_panel_background_image_url': '',
  'login-ui.custom_css': '',
  'login-ui.header_enabled': true,
  'login-ui.subtitle_enabled': true,
  'login-ui.footer_enabled': true,
  'login-ui.powered_by_enabled': true,
  'login-ui.auth_switch_link_enabled': true,
  'login-ui.topbar_position': 'below_card',
  'login-ui.theme_toggle_enabled': true,
  'login-ui.language_select_enabled': true,
  'login-ui.language_switcher_position': 'below_card',
  'login-ui.header_style': 'center',
  'login-ui.footer_style': 'simple',
  'login-ui.split_frame': 'full',
  'login-ui.split_panel_side': 'left',
  'login-ui.split_panel_width': 'narrow',
  'login-ui.split_background_mode': 'shared',
  'login-ui.login_panel_background_color': '',
  'login-ui.login_panel_background_gradient_color': '',
  'login-ui.login_panel_background_opacity': 70,
  'login-ui.brand_content_mode': 'logo_copy',
  'login-ui.brand_position': 'center',
  'login-ui.brand_align': 'left',
  'login-ui.header_text': '',
  'login-ui.footer_text': '',
  'login-ui.footer_links': '',
  'login-ui.custom_blocks': '',
  'login-ui.custom_themes': '',
  'login-ui.account_pages': '',
  'login-ui.account_page_draft': '',
  'login-ui.account_page_published': '',
  'login-ui.account_page_published_version': 0,
  'login-ui.account_page_published_at': '',
};
