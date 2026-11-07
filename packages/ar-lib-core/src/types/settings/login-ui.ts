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
 * Layout templates (placement only). Colours and shape come from the palette.
 * - standard: header, a centred card holding the form, footer
 * - split: brand panel + form side
 * - minimal: a centred form placed directly on the page, no card box
 */
export const LOGIN_UI_TEMPLATE_IDS = ['standard', 'split', 'minimal'] as const;
export type LoginUITemplateId = (typeof LOGIN_UI_TEMPLATE_IDS)[number];
export const DEFAULT_LOGIN_UI_TEMPLATE: LoginUITemplateId = 'standard';

/**
 * Built-in palette ids. The palettes themselves (colours and shape tokens) live in the Login UI's
 * registry (ar-login-ui src/lib/palettes.ts); this list is the single backend source of truth for
 * which ids may be stored and returned. Add a palette there first, then add its id here.
 */
export const LOGIN_UI_PALETTE_IDS = [
  'meridian',
  'classic',
  'swiss-grid',
  'glass',
  'clear-glass',
  'flat',
] as const;
export type LoginUIPaletteId = (typeof LOGIN_UI_PALETTE_IDS)[number];
export const DEFAULT_LOGIN_UI_PALETTE: LoginUIPaletteId = 'meridian';

/** Unknown or missing palette ids read as the default palette. */
export function normalizeLoginUIPaletteId(value: unknown): LoginUIPaletteId {
  return typeof value === 'string' && (LOGIN_UI_PALETTE_IDS as readonly string[]).includes(value)
    ? (value as LoginUIPaletteId)
    : DEFAULT_LOGIN_UI_PALETTE;
}

export type LoginUITextField =
  | 'tagline'
  | 'brandPanelTitle'
  | 'brandPanelText'
  | 'footerText'
  | 'loginTitle'
  | 'registrationTitle'
  | 'accountTitle';

export type LoginUITextLocalizations = Record<string, Partial<Record<LoginUITextField, string>>>;

/**
 * Login UI Settings Interface
 */
export interface LoginUISettings {
  // Theme
  'login-ui.theme': string;
  'login-ui.theme_fixed': boolean;
  'login-ui.template': string;
  'login-ui.palette': string;
  /** @deprecated Replaced by `login-ui.palette`. */
  'login-ui.theme_template': string;
  'login-ui.published_version': number;
  'login-ui.published_at': string;
  'login-ui.published_snapshot': string;
  'login-ui.rollback_snapshot': string;
  /** @deprecated Replaced by `login-ui.template`. */
  'login-ui.page_layout': string;
  'login-ui.font_family': string;
  'login-ui.font_scale': string;
  'login-ui.background_color': string;
  'login-ui.accent_color': string;
  'login-ui.title_color': string;
  'login-ui.text_color': string;
  'login-ui.copy_color': string;
  'login-ui.form_area_color': string;

  // Branding
  'login-ui.brand_name': string;
  'login-ui.header_name': string;
  'login-ui.logo_url': string;
  'login-ui.favicon_url': string;
  'login-ui.thumbnail_url': string;
  'login-ui.logo_display': string;
  'login-ui.logo_layout': string;
  'login-ui.brand_panel_logo_display': string;
  'login-ui.brand_panel_title': string;
  'login-ui.brand_panel_text': string;

  // Locales
  'login-ui.supported_locales': string;
  'login-ui.default_locale': string;
  'login-ui.primary_locales': string[] | null;
  'login-ui.show_english_language_names': boolean;

  // Appearance
  'login-ui.background_image_url': string;
  'login-ui.background_image_opacity': number;
  'login-ui.background_image_grayscale': boolean;
  'login-ui.login_panel_background_image_url': string;
  'login-ui.brand_panel_image_url': string;
  'login-ui.brand_panel_image_opacity': number;
  'login-ui.brand_panel_image_grayscale': boolean;
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
  'login-ui.form_frame': string;
  'login-ui.split_panel_side': string;
  'login-ui.split_panel_width': string;
  'login-ui.split_background_mode': string;
  'login-ui.login_panel_background_color': string;
  'login-ui.login_panel_background_gradient_color': string;
  'login-ui.login_panel_background_opacity': number;
  'login-ui.login_panel_background_grayscale': boolean;
  'login-ui.brand_content_mode': string;
  'login-ui.brand_position': string;
  'login-ui.brand_align': string;
  'login-ui.header_text': string;
  'login-ui.text_localizations': string;
  'login-ui.footer_text': string;
  'login-ui.footer_links': string;
  'login-ui.custom_blocks': string;
  'login-ui.custom_themes': string;
  'login-ui.account_pages': string;
  'login-ui.account_page_draft': string;
  'login-ui.account_page_published': string;
  'login-ui.account_page_published_version': number;
  'login-ui.account_page_published_at': string;
  'login-ui.active_theme_id': string;
  'login-ui.active_theme_version': number;

  // Lite Login UI
  'login-ui.lite_mode': string;
  'login-ui.lite_logo': string;
}

/**
 * Login UI Settings Metadata
 */
export const LOGIN_UI_SETTINGS_META: Record<keyof LoginUISettings, SettingMeta> = {
  'login-ui.theme': {
    key: 'login-ui.theme',
    type: 'enum',
    default: 'auto',
    envKey: 'LOGIN_UI_THEME',
    label: 'Theme Mode',
    description:
      'Default theme mode for the Login UI. Auto follows the visitor device; light or dark is the tenant default',
    enum: ['auto', 'light', 'dark'],
    visibility: 'public',
  },
  'login-ui.theme_fixed': {
    key: 'login-ui.theme_fixed',
    type: 'boolean',
    default: false,
    envKey: 'LOGIN_UI_THEME_FIXED',
    label: 'Fix Theme Mode',
    description:
      'When true and the theme mode is light or dark, that mode is always used: the visitor choice and device setting are ignored and the theme toggle is hidden. Ignored when the theme mode is auto',
    visibility: 'public',
  },
  'login-ui.template': {
    key: 'login-ui.template',
    type: 'enum',
    default: DEFAULT_LOGIN_UI_TEMPLATE,
    envKey: 'LOGIN_UI_TEMPLATE',
    label: 'Template',
    description:
      'Login UI layout: standard (centred card), split (brand panel and form side) or minimal (centred form without a card)',
    enum: [...LOGIN_UI_TEMPLATE_IDS],
    visibility: 'public',
  },
  'login-ui.palette': {
    key: 'login-ui.palette',
    type: 'enum',
    default: DEFAULT_LOGIN_UI_PALETTE,
    envKey: 'LOGIN_UI_PALETTE',
    label: 'Palette',
    description:
      'Built-in colour and shape palette, combined freely with any template. Explicit colour settings override it',
    enum: [...LOGIN_UI_PALETTE_IDS],
    visibility: 'public',
  },
  'login-ui.theme_template': {
    key: 'login-ui.theme_template',
    type: 'enum',
    default: 'meridian',
    envKey: 'LOGIN_UI_THEME_TEMPLATE',
    label: 'Theme Template (deprecated)',
    description:
      'Deprecated: replaced by login-ui.palette. Still accepted; the Login UI API derives the palette from it only when login-ui.palette was never set',
    enum: ['classic', 'meridian', 'split-brand-panel', 'fullbleed-glass'],
    visibility: 'public',
    deprecated: true,
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
    label: 'Page Layout (deprecated)',
    description:
      'Deprecated: replaced by login-ui.template. Still accepted; the Login UI API derives the template from it only when login-ui.template was never set (split_panel is split, anything else is standard)',
    enum: ['centered_card', 'split_panel', 'fullbleed_card'],
    visibility: 'public',
    deprecated: true,
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
  'login-ui.accent_color': {
    key: 'login-ui.accent_color',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_ACCENT_COLOR',
    label: 'Accent Color',
    description:
      'Optional CSS color override for primary actions, focus indicators, and highlights',
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
  'login-ui.form_area_color': {
    key: 'login-ui.form_area_color',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_FORM_AREA_COLOR',
    label: 'Form Area Color',
    description:
      'Colour of the form area: the card, or the form side of the split template. #rgb, #rrggbb or #rrggbbaa. Empty follows the palette. In the split template the legacy login panel background colour wins when set',
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
  'login-ui.header_name': {
    key: 'login-ui.header_name',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_HEADER_NAME',
    label: 'Header Name',
    description: 'Name shown in the header. Empty uses the brand name',
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
  'login-ui.brand_panel_logo_display': {
    key: 'login-ui.brand_panel_logo_display',
    type: 'enum',
    default: 'inherit',
    envKey: 'LOGIN_UI_BRAND_PANEL_LOGO_DISPLAY',
    label: 'Brand Panel Logo Display',
    description:
      'How the split brand panel shows the logo and name. Inherit uses the logo display setting (which then applies to both the header and the panel)',
    enum: ['inherit', 'auto', 'image', 'text', 'hidden'],
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
    default: 'en,ja,zh-CN,zh-TW,es,pt,fr,de,ko,ru,id,ar,it,th,vi,hi,bn,tr,sw,am,pl',
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
    enum: [
      'en',
      'ja',
      'zh-CN',
      'zh-TW',
      'es',
      'pt',
      'fr',
      'de',
      'ko',
      'ru',
      'id',
      'ar',
      'it',
      'th',
      'vi',
      'hi',
      'bn',
      'tr',
      'sw',
      'am',
      'pl',
    ],
    visibility: 'public',
  },
  'login-ui.primary_locales': {
    key: 'login-ui.primary_locales',
    type: 'json',
    default: null,
    envKey: 'LOGIN_UI_PRIMARY_LOCALES',
    label: 'Primary Languages',
    description:
      'Up to six primary Login UI locales. Null selects defaults by speaker count; an empty array explicitly selects none',
    visibility: 'page',
  },
  'login-ui.show_english_language_names': {
    key: 'login-ui.show_english_language_names',
    type: 'boolean',
    default: false,
    envKey: 'LOGIN_UI_SHOW_ENGLISH_LANGUAGE_NAMES',
    label: 'Show English Language Names',
    description: 'Display English names alongside native language names in the Login UI selector',
    visibility: 'page',
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
  'login-ui.background_image_opacity': {
    key: 'login-ui.background_image_opacity',
    type: 'number',
    default: 100,
    envKey: 'LOGIN_UI_BACKGROUND_IMAGE_OPACITY',
    label: 'Background Image Opacity',
    description: 'Opacity of the page background image from transparent to clear',
    min: 0,
    max: 100,
    unit: 'percent',
    visibility: 'public',
  },
  'login-ui.background_image_grayscale': {
    key: 'login-ui.background_image_grayscale',
    type: 'boolean',
    default: false,
    envKey: 'LOGIN_UI_BACKGROUND_IMAGE_GRAYSCALE',
    label: 'Background Image Grayscale',
    description: 'Show the page background image in grayscale',
    visibility: 'public',
  },
  'login-ui.brand_panel_image_url': {
    key: 'login-ui.brand_panel_image_url',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_BRAND_PANEL_IMAGE_URL',
    label: 'Brand Panel Image URL',
    description: 'Optional picture laid over the split brand panel fill, under its text',
    visibility: 'public',
  },
  'login-ui.brand_panel_image_opacity': {
    key: 'login-ui.brand_panel_image_opacity',
    type: 'number',
    default: 100,
    envKey: 'LOGIN_UI_BRAND_PANEL_IMAGE_OPACITY',
    label: 'Brand Panel Image Opacity',
    description: 'Opacity of the brand panel picture from transparent to clear',
    min: 0,
    max: 100,
    unit: 'percent',
    visibility: 'public',
  },
  'login-ui.brand_panel_image_grayscale': {
    key: 'login-ui.brand_panel_image_grayscale',
    type: 'boolean',
    default: false,
    envKey: 'LOGIN_UI_BRAND_PANEL_IMAGE_GRAYSCALE',
    label: 'Brand Panel Image Grayscale',
    description: 'Show the brand panel picture in grayscale',
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
    description:
      'Where the theme toggle and language selector are displayed on Login UI pages. The form_bottom_* values place them at the bottom of the split template form side and behave as below_card elsewhere',
    enum: [
      'below_card',
      'in_card',
      'top_right',
      'bottom_left',
      'bottom_center',
      'bottom_right',
      'form_bottom_left',
      'form_bottom_center',
      'form_bottom_right',
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
  'login-ui.form_frame': {
    key: 'login-ui.form_frame',
    type: 'enum',
    default: 'full',
    envKey: 'LOGIN_UI_FORM_FRAME',
    label: 'Form Frame',
    description:
      'Split template only. Full: the form side is a full-height panel. Card: the brand panel runs behind the whole stage and the form area floats over it as a card',
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
  'login-ui.login_panel_background_grayscale': {
    key: 'login-ui.login_panel_background_grayscale',
    type: 'boolean',
    default: false,
    envKey: 'LOGIN_UI_LOGIN_PANEL_BACKGROUND_GRAYSCALE',
    label: 'Login Panel Image Grayscale',
    description: 'Show the independent login panel image in grayscale',
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
  'login-ui.text_localizations': {
    key: 'login-ui.text_localizations',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_TEXT_LOCALIZATIONS',
    label: 'Localized Text',
    description: 'JSON object of locale-specific Login UI text overrides',
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
  'login-ui.active_theme_id': {
    key: 'login-ui.active_theme_id',
    type: 'string',
    default: '',
    envKey: 'LOGIN_UI_ACTIVE_THEME_ID',
    label: 'Active Saved Theme ID',
    description:
      'ID of the saved Login UI theme last applied to this tenant. Written by the theme apply operation, not edited by hand',
    visibility: 'internal',
  },
  'login-ui.active_theme_version': {
    key: 'login-ui.active_theme_version',
    type: 'number',
    default: 0,
    envKey: 'LOGIN_UI_ACTIVE_THEME_VERSION',
    label: 'Active Saved Theme Version',
    description:
      'Version of the saved Login UI theme last applied to this tenant. Written by the theme apply operation, not edited by hand',
    min: 0,
    integer: true,
    visibility: 'internal',
  },
  // No envKey: an environment default would switch tenants on without the compatibility guard.
  'login-ui.lite_mode': {
    key: 'login-ui.lite_mode',
    type: 'enum',
    default: 'off',
    label: 'Lite Login UI',
    description:
      "Whether the tenant uses the lite Login UI (server-rendered, for very poor networks): off or always. Changed only through PUT /api/admin/login-ui/lite-mode, which checks that the lite UI can do everything the tenant uses and publishes the mode to the tenant's policy store. This setting records the mode for the console and backups; the runtimes read the policy store",
    enum: ['off', 'always'],
    scopes: ['tenant'],
    visibility: 'page',
  },
  'login-ui.lite_logo': {
    key: 'login-ui.lite_logo',
    type: 'string',
    default: '',
    label: 'Lite Login UI Logo',
    description:
      'The logo the lite Login UI inlines into its pages: a still PNG or WebP image as a data: URI, at most 8 KB and 640x160 pixels. Empty: the brand name is shown as text',
    scopes: ['tenant'],
    visibility: 'public',
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
  'login-ui.theme': 'auto',
  'login-ui.theme_fixed': false,
  'login-ui.template': DEFAULT_LOGIN_UI_TEMPLATE,
  'login-ui.palette': DEFAULT_LOGIN_UI_PALETTE,
  'login-ui.theme_template': 'meridian',
  'login-ui.published_version': 0,
  'login-ui.published_at': '',
  'login-ui.published_snapshot': '',
  'login-ui.rollback_snapshot': '',
  'login-ui.page_layout': 'centered_card',
  'login-ui.font_family': 'system',
  'login-ui.font_scale': 'comfortable',
  'login-ui.background_color': '',
  'login-ui.accent_color': '',
  'login-ui.title_color': '',
  'login-ui.text_color': '',
  'login-ui.copy_color': '',
  'login-ui.form_area_color': '',
  'login-ui.brand_name': 'Authrim',
  'login-ui.header_name': '',
  'login-ui.logo_url': '',
  'login-ui.favicon_url': '',
  'login-ui.thumbnail_url': '',
  'login-ui.logo_display': 'auto',
  'login-ui.logo_layout': 'stack',
  'login-ui.brand_panel_logo_display': 'inherit',
  'login-ui.brand_panel_title': '',
  'login-ui.brand_panel_text': '',
  'login-ui.supported_locales':
    'en,ja,zh-CN,zh-TW,es,pt,fr,de,ko,ru,id,ar,it,th,vi,hi,bn,tr,sw,am,pl',
  'login-ui.default_locale': 'en',
  'login-ui.primary_locales': null,
  'login-ui.show_english_language_names': false,
  'login-ui.background_image_url': '',
  'login-ui.background_image_opacity': 100,
  'login-ui.background_image_grayscale': false,
  'login-ui.login_panel_background_image_url': '',
  'login-ui.brand_panel_image_url': '',
  'login-ui.brand_panel_image_opacity': 100,
  'login-ui.brand_panel_image_grayscale': false,
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
  'login-ui.form_frame': 'full',
  'login-ui.split_panel_side': 'left',
  'login-ui.split_panel_width': 'narrow',
  'login-ui.split_background_mode': 'shared',
  'login-ui.login_panel_background_color': '',
  'login-ui.login_panel_background_gradient_color': '',
  'login-ui.login_panel_background_opacity': 70,
  'login-ui.login_panel_background_grayscale': false,
  'login-ui.brand_content_mode': 'logo_copy',
  'login-ui.brand_position': 'center',
  'login-ui.brand_align': 'left',
  'login-ui.header_text': '',
  'login-ui.text_localizations': '',
  'login-ui.footer_text': '',
  'login-ui.footer_links': '',
  'login-ui.custom_blocks': '',
  'login-ui.custom_themes': '',
  'login-ui.account_pages': '',
  'login-ui.account_page_draft': '',
  'login-ui.account_page_published': '',
  'login-ui.account_page_published_version': 0,
  'login-ui.account_page_published_at': '',
  'login-ui.active_theme_id': '',
  'login-ui.active_theme_version': 0,
  'login-ui.lite_mode': 'off',
  'login-ui.lite_logo': '',
};

/**
 * The appearance keys a saved Login UI theme may hold. Applying a theme sets each of these to the
 * theme's value, or clears it when the theme does not hold it, so the live Login UI equals the
 * theme. Locales and the legacy/deprecated keys are not part of a theme.
 */
export const LOGIN_UI_THEME_KEYS = [
  'login-ui.template',
  'login-ui.palette',
  'login-ui.theme',
  'login-ui.font_family',
  'login-ui.font_scale',
  'login-ui.background_color',
  'login-ui.accent_color',
  'login-ui.title_color',
  'login-ui.text_color',
  'login-ui.copy_color',
  'login-ui.form_area_color',
  'login-ui.brand_name',
  'login-ui.header_name',
  'login-ui.logo_url',
  'login-ui.favicon_url',
  'login-ui.logo_display',
  'login-ui.brand_panel_logo_display',
  'login-ui.logo_layout',
  'login-ui.brand_panel_title',
  'login-ui.brand_panel_text',
  'login-ui.background_image_url',
  'login-ui.background_image_opacity',
  'login-ui.background_image_grayscale',
  'login-ui.login_panel_background_image_url',
  'login-ui.login_panel_background_opacity',
  'login-ui.login_panel_background_grayscale',
  'login-ui.brand_panel_image_url',
  'login-ui.brand_panel_image_opacity',
  'login-ui.brand_panel_image_grayscale',
  'login-ui.custom_css',
  'login-ui.header_enabled',
  'login-ui.subtitle_enabled',
  'login-ui.footer_enabled',
  'login-ui.powered_by_enabled',
  'login-ui.theme_toggle_enabled',
  'login-ui.language_select_enabled',
  'login-ui.topbar_position',
  'login-ui.header_style',
  'login-ui.footer_style',
  'login-ui.split_frame',
  'login-ui.form_frame',
  'login-ui.split_panel_side',
  'login-ui.split_panel_width',
  'login-ui.split_background_mode',
  'login-ui.login_panel_background_color',
  'login-ui.login_panel_background_gradient_color',
  'login-ui.brand_content_mode',
  'login-ui.brand_position',
  'login-ui.brand_align',
  'login-ui.header_text',
  'login-ui.text_localizations',
  'login-ui.footer_text',
  'login-ui.footer_links',
] as const satisfies ReadonlyArray<keyof LoginUISettings>;
export type LoginUIThemeKey = (typeof LOGIN_UI_THEME_KEYS)[number];
