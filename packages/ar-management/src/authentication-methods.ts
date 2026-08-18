/**
 * Authentication Methods API
 *
 * Public endpoint to retrieve available authentication methods and UI configuration.
 * Used by Login UI to dynamically render authentication options.
 *
 * GET /api/auth/authentication-methods
 *   - No authentication required (public endpoint)
 *   - Rate limited with lenient profile
 *   - Returns enabled authentication methods + UI config
 *
 * Data sources:
 *   - SETTINGS KV ("settings:tenant:{tenantId}:authentication-methods") → built-in and external methods
 *   - SETTINGS KV ("settings:tenant:{tenantId}:directory-connectors") → directory password method
 *   - SETTINGS KV ("settings:tenant:{tenantId}:login-ui") → UI theme
 *   - EXTERNAL_IDP service binding → enabled external login providers
 *
 * Security:
 *   - No secrets or internal config exposed
 *   - Rate limited to prevent abuse
 *   - Short cache TTL to balance Login UI performance and Admin UI update propagation
 */

import type { Context } from 'hono';
import type { Env, LoginUITextLocalizations } from '@authrim/ar-lib-core';
import {
  getRequestHost,
  getLogger,
  getTenantIdFromContext,
  profileForTotpPreset,
  readAuthenticationMethodsCacheRevision,
  resolveAuthCorePersistenceAdapterFromEnv,
  SELF_SERVICE_DEFAULTS,
  VALIDATION_LIMITS,
  validateAccountPagePath,
  validateLoginUICustomCss,
} from '@authrim/ar-lib-core';
import {
  LOGIN_UI_LOCALES,
  parseConfiguredPrimaryLoginUILocales,
  resolveEffectivePrimaryLoginUILocales,
  type LoginUILocale,
} from '@authrim/ar-lib-core/types/login-ui-languages';
import {
  decryptSecretFields,
  getPluginEncryptionKey,
  type EncryptedConfig,
} from '@authrim/ar-lib-plugin';

// =============================================================================
// Types
// =============================================================================

interface PasskeyMethod {
  enabled: boolean;
  loginEnabled: boolean;
  signupEnabled: boolean;
  reauthEnabled: boolean;
  accountLinkEnabled: boolean;
  capabilities: string[];
}

interface EmailCodeMethod {
  enabled: boolean;
  loginEnabled: boolean;
  signupEnabled: boolean;
  reauthEnabled: boolean;
  accountLinkEnabled: boolean;
  steps: string[];
}

interface TotpMethod {
  enabled: boolean;
  loginEnabled: boolean;
  signupEnabled: boolean;
  reauthEnabled: boolean;
  accountLinkEnabled: boolean;
  preset: 'compatible' | 'strong';
  algorithm: 'SHA1' | 'SHA256';
  digits: number;
  period: number;
  window: number;
  defaultAcr: string;
  requirement: {
    mode: 'optional' | 'required';
  };
  steps: string[];
}

interface DirectoryPasswordMethod {
  enabled: boolean;
  label: string;
  steps: string[];
}

type HumanVerificationProvider = string;
type HumanVerificationFailurePolicy = 'fail_closed';
type HumanVerificationWidgetMode = 'managed' | 'checkbox' | 'invisible' | 'score';

interface HumanVerificationMethod {
  enabled: boolean;
  provider: HumanVerificationProvider;
  siteKey: string | null;
  loginEnabled: boolean;
  signupEnabled: boolean;
  reauthEnabled: boolean;
  failurePolicy: HumanVerificationFailurePolicy;
  widget: {
    actionPrefix: string;
    theme: 'auto';
    size: 'flexible';
    mode: HumanVerificationWidgetMode;
  };
}

type ExternalLoginProviderType = 'oidc' | 'oauth2' | 'saml' | 'vc' | 'custom';
type ExternalLoginStartMode = 'oauth_redirect' | 'saml_sp';

interface ExternalLoginProvider {
  id: string;
  name: string;
  type: ExternalLoginProviderType;
  startMode: ExternalLoginStartMode;
  enabled: boolean;
  loginEnabled: boolean;
  signupEnabled: boolean;
  reauthEnabled: boolean;
  accountLinkEnabled: boolean;
  autoLinkEmail?: boolean;
  slug?: string;
  iconUrl?: string;
  iconName?: string;
  buttonColor?: string;
  buttonText?: string;
  startUrl?: string;
}

interface ExternalAuthenticationMethod {
  enabled: boolean;
  providers: ExternalLoginProvider[];
}

interface AuthenticationMethods {
  passkey: PasskeyMethod;
  emailCode: EmailCodeMethod;
  totp: TotpMethod;
  directoryPassword: DirectoryPasswordMethod;
  humanVerification: HumanVerificationMethod;
  external: ExternalAuthenticationMethod;
}

interface UIConfig {
  theme: string;
  variant: string;
  themeTemplate: 'classic' | 'meridian' | 'split-brand-panel' | 'fullbleed-glass';
  branding: {
    logoUrl: string | null;
    faviconUrl: string | null;
    brandName: string;
  };
  pageTemplate: {
    layout: 'centered_card' | 'split_panel' | 'fullbleed_card';
    fontFamily: 'system' | 'rounded' | 'serif' | 'mono';
    fontScale: 'compact' | 'comfortable' | 'spacious';
    backgroundColor: string;
    accentColor: string;
    titleColor: string;
    textColor: string;
    copyColor: string;
    logoDisplay: 'auto' | 'image' | 'text' | 'hidden';
    logoLayout: 'stack' | 'row';
    headerEnabled: boolean;
    subtitleEnabled: boolean;
    footerEnabled: boolean;
    poweredByEnabled: boolean;
    authSwitchLinkEnabled: boolean;
    topbarPosition:
      | 'below_card'
      | 'in_card'
      | 'top_right'
      | 'bottom_left'
      | 'bottom_center'
      | 'bottom_right'
      | 'hidden';
    themeToggleEnabled: boolean;
    languageSelectEnabled: boolean;
    languageSwitcherPosition: 'below_card' | 'top_right' | 'hidden';
    headerStyle: 'center' | 'bar';
    footerStyle: 'simple' | 'bar';
    splitFrame: 'full' | 'card';
    splitPanelSide: 'left' | 'right';
    splitPanelWidth: 'narrow' | 'wide';
    splitBackgroundMode: 'shared' | 'brand' | 'panel';
    loginPanelBackgroundColor: string;
    loginPanelBackgroundGradientColor: string;
    loginPanelBackgroundOpacity: number;
    brandContentMode: 'logo_copy' | 'logo' | 'none';
    brandPosition: 'top' | 'center' | 'bottom';
    brandAlign: 'left' | 'center' | 'right';
    brandPanelTitle: string | null;
    brandPanelText: string | null;
  };
  appearance: {
    backgroundImageUrl: string | null;
    loginPanelBackgroundImageUrl: string | null;
    thumbnailUrl: string | null;
    customCss: string | null;
    headerText: string | null;
    textLocalizations: LoginUITextLocalizations;
    footerText: string | null;
    footerLinks: Array<{ label: string; url: string }>;
    customBlocks: Array<{
      position: string;
      type: string;
      content: string;
      url?: string;
      alt?: string;
    }>;
  };
  supportedLocales: string[];
  defaultLocale: string;
  primaryLocales: string[];
  showEnglishLanguageNames: boolean;
  selfService: {
    accountPageEnabled: boolean;
    accountPagePath: string;
  };
}

interface AuthenticationMethodsMeta {
  cacheTTL: number;
  revision: string;
}

interface AuthenticationMethodsResponse {
  methods: AuthenticationMethods;
  ui: UIConfig;
  meta: AuthenticationMethodsMeta;
}

interface AuthenticationMethodsErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

// =============================================================================
// Defaults
// =============================================================================

const DEFAULT_CACHE_TTL = 60; // seconds
const DEFAULT_EDGE_CACHE_TTL = 24 * 60 * 60; // seconds
const MAX_EDGE_CACHE_TTL = 7 * 24 * 60 * 60; // seconds
const EDGE_CACHE_KEY_ORIGIN = 'https://authrim.internal';
const DIAGNOSTIC_SESSION_ID_HEADER = 'X-Diagnostic-Session-Id';
const MAX_DIAGNOSTIC_SESSION_ID_LENGTH = 128;
type AuthenticationMethodsEdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};
type WaitUntilExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};
type AuthenticationMethodsCacheStatus = 'hit' | 'miss' | 'bypass';
type AuthenticationMethodsDiagnosticLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
};
interface AuthenticationMethodsTimingSpan {
  name: string;
  durationMs: number;
}
interface AuthenticationMethodsDiagnosticTiming {
  enabled: boolean;
  sessionId: string | null;
  startedAt: number;
  spans: AuthenticationMethodsTimingSpan[];
  completed: boolean;
}
const MAX_EXTERNAL_LOGIN_PROVIDERS = 20;
const MAX_STRING_LENGTH = 256;
const MAX_URL_LENGTH = 2048;
const LEGACY_DEFAULT_LOGIN_UI_LOCALES = [
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
] as const;

function isLegacyDefaultLoginUILocaleSet(locales: readonly string[]): boolean {
  return (
    locales.length === LEGACY_DEFAULT_LOGIN_UI_LOCALES.length &&
    LEGACY_DEFAULT_LOGIN_UI_LOCALES.every((locale) => locales.includes(locale))
  );
}

const LOGIN_PROVIDER_ICON_NAMES = new Set([
  'buildings',
  'house',
  'house-simple',
  'bank',
  'building',
  'city',
  'graduation-cap',
  'student',
  'books',
  'chalkboard-teacher',
  'globe',
  'globe-hemisphere-east',
  'shield-check',
  'seal-check',
  'certificate',
  'identification-card',
  'fingerprint',
  'key',
  'briefcase',
  'users-three',
  'network',
  'share-network',
  'tree-structure',
  'handshake',
  'cloud',
  'cloud-check',
  'database',
  'hard-drives',
  'devices',
  'terminal-window',
  'book-open',
  'presentation-chart',
  'rocket-launch',
  'compass',
  'none',
]);

const DEFAULT_UI_CONFIG: UIConfig = {
  theme: 'light',
  variant: 'beige',
  themeTemplate: 'meridian',
  branding: {
    logoUrl: null,
    faviconUrl: null,
    brandName: 'Authrim',
  },
  pageTemplate: {
    layout: 'centered_card',
    fontFamily: 'system',
    fontScale: 'comfortable',
    backgroundColor: '',
    accentColor: '',
    titleColor: '',
    textColor: '',
    copyColor: '',
    logoDisplay: 'auto',
    logoLayout: 'stack',
    headerEnabled: true,
    subtitleEnabled: true,
    footerEnabled: true,
    poweredByEnabled: true,
    authSwitchLinkEnabled: true,
    topbarPosition: 'below_card',
    themeToggleEnabled: true,
    languageSelectEnabled: true,
    languageSwitcherPosition: 'below_card',
    headerStyle: 'center',
    footerStyle: 'simple',
    splitFrame: 'full',
    splitPanelSide: 'left',
    splitPanelWidth: 'narrow',
    splitBackgroundMode: 'shared',
    loginPanelBackgroundColor: '',
    loginPanelBackgroundGradientColor: '',
    loginPanelBackgroundOpacity: 70,
    brandContentMode: 'logo_copy',
    brandPosition: 'center',
    brandAlign: 'left',
    brandPanelTitle: null,
    brandPanelText: null,
  },
  appearance: {
    backgroundImageUrl: null,
    loginPanelBackgroundImageUrl: null,
    thumbnailUrl: null,
    customCss: null,
    headerText: null,
    textLocalizations: {},
    footerText: null,
    footerLinks: [],
    customBlocks: [],
  },
  supportedLocales: [
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
  defaultLocale: 'en',
  primaryLocales: resolveEffectivePrimaryLoginUILocales(LOGIN_UI_LOCALES, null),
  showEnglishLanguageNames: false,
  selfService: {
    accountPageEnabled: SELF_SERVICE_DEFAULTS['self-service.account_page_enabled'],
    accountPagePath: SELF_SERVICE_DEFAULTS['self-service.account_page_path'],
  },
};

// =============================================================================
// Internal helpers
// =============================================================================

interface SystemSettings {
  general?: {
    siteName?: string;
    logoUrl?: string;
    language?: string;
  };
  appearance?: {
    primaryColor?: string;
    secondaryColor?: string;
    fontFamily?: string;
  };
  advanced?: {
    passkeyEnabled?: boolean;
    magicLinkEnabled?: boolean;
  };
  loginUI?: {
    theme?: string;
    variant?: string;
    supportedLocales?: string[];
  };
  [key: string]: unknown;
}

/**
 * Read system settings from KV
 */
async function getSystemSettings(env: Env): Promise<SystemSettings> {
  try {
    const json = await env.SETTINGS?.get('system_settings');
    if (json) {
      return JSON.parse(json);
    }
  } catch {
    // Invalid JSON — use defaults
  }
  return {};
}

/**
 * Login UI settings stored in AUTHRIM_CONFIG KV (settings-v2 format)
 */
interface LoginUIKVSettings {
  'login-ui.theme'?: string;
  'login-ui.variant'?: string;
  'login-ui.theme_template'?: string;
  'login-ui.page_layout'?: string;
  'login-ui.font_family'?: string;
  'login-ui.font_scale'?: string;
  'login-ui.background_color'?: string;
  'login-ui.accent_color'?: string;
  'login-ui.title_color'?: string;
  'login-ui.text_color'?: string;
  'login-ui.copy_color'?: string;
  'login-ui.brand_name'?: string;
  'login-ui.logo_url'?: string;
  'login-ui.favicon_url'?: string;
  'login-ui.thumbnail_url'?: string;
  'login-ui.logo_display'?: string;
  'login-ui.logo_layout'?: string;
  'login-ui.brand_panel_title'?: string;
  'login-ui.brand_panel_text'?: string;
  'login-ui.supported_locales'?: string;
  'login-ui.default_locale'?: string;
  'login-ui.primary_locales'?: unknown;
  'login-ui.show_english_language_names'?: boolean | string;
  'login-ui.background_image_url'?: string;
  'login-ui.login_panel_background_image_url'?: string;
  'login-ui.custom_css'?: string;
  'login-ui.header_enabled'?: boolean | string;
  'login-ui.subtitle_enabled'?: boolean | string;
  'login-ui.footer_enabled'?: boolean | string;
  'login-ui.powered_by_enabled'?: boolean | string;
  'login-ui.auth_switch_link_enabled'?: boolean | string;
  'login-ui.topbar_position'?: string;
  'login-ui.theme_toggle_enabled'?: boolean | string;
  'login-ui.language_select_enabled'?: boolean | string;
  'login-ui.language_switcher_position'?: string;
  'login-ui.header_style'?: string;
  'login-ui.footer_style'?: string;
  'login-ui.split_frame'?: string;
  'login-ui.split_panel_side'?: string;
  'login-ui.split_panel_width'?: string;
  'login-ui.split_background_mode'?: string;
  'login-ui.login_panel_background_color'?: string;
  'login-ui.login_panel_background_gradient_color'?: string;
  'login-ui.login_panel_background_opacity'?: number | string;
  'login-ui.brand_content_mode'?: string;
  'login-ui.brand_position'?: string;
  'login-ui.brand_align'?: string;
  'login-ui.header_text'?: string;
  'login-ui.text_localizations'?: string;
  'login-ui.footer_text'?: string;
  'login-ui.footer_links'?: string;
  'login-ui.custom_blocks'?: string;
  'login-ui.custom_themes'?: string;
}

interface AuthenticationMethodKVSettings {
  'authentication-methods.cache_ttl'?: number;
  'authentication-methods.passkey.enabled'?: boolean | string;
  'authentication-methods.passkey.login_enabled'?: boolean | string;
  'authentication-methods.passkey.signup_enabled'?: boolean | string;
  'authentication-methods.passkey.reauth_enabled'?: boolean | string;
  'authentication-methods.passkey.account_link_enabled'?: boolean | string;
  'authentication-methods.email_otp.enabled'?: boolean | string;
  'authentication-methods.email_otp.login_enabled'?: boolean | string;
  'authentication-methods.email_otp.signup_enabled'?: boolean | string;
  'authentication-methods.email_otp.reauth_enabled'?: boolean | string;
  'authentication-methods.email_otp.account_link_enabled'?: boolean | string;
  'authentication-methods.totp.enabled'?: boolean | string;
  'authentication-methods.totp.login_enabled'?: boolean | string;
  'authentication-methods.totp.signup_enabled'?: boolean | string;
  'authentication-methods.totp.reauth_enabled'?: boolean | string;
  'authentication-methods.totp.account_link_enabled'?: boolean | string;
  'authentication-methods.totp.preset'?: string;
  'authentication-methods.totp.default_acr'?: string;
  'authentication-methods.totp.requirement_policy'?: string | Record<string, unknown>;
  'authentication-methods.human_verification.provider'?: string;
  'authentication-methods.human_verification.login_enabled'?: boolean | string;
  'authentication-methods.human_verification.signup_enabled'?: boolean | string;
  'authentication-methods.human_verification.reauth_enabled'?: boolean | string;
  'authentication-methods.external_provider_usage'?: string | ExternalLoginProviderUsageConfig[];
  'authentication-methods.external_providers'?: string | ExternalLoginProviderConfig[];
}

interface DirectoryConnectorDiscoverySettings {
  enabled?: unknown;
  default_connector_id?: unknown;
  connectors?: unknown;
}

interface ExternalLoginProviderConfig {
  id?: string;
  name?: string;
  type?: string;
  startMode?: string;
  slug?: string;
  iconUrl?: string;
  iconName?: string;
  buttonColor?: string;
  buttonText?: string;
  startUrl?: string;
  enabled?: boolean;
  loginEnabled?: boolean;
  signupEnabled?: boolean;
  reauthEnabled?: boolean;
  accountLinkEnabled?: boolean;
}

interface ExternalLoginProviderUsageConfig {
  id?: string;
  providerId?: string;
  loginEnabled?: boolean;
  signupEnabled?: boolean;
  reauthEnabled?: boolean;
  accountLinkEnabled?: boolean;
}

/**
 * Read Login UI settings from AUTHRIM_CONFIG KV (settings-v2 system)
 * Falls back to system_settings.loginUI for backward compatibility
 */
interface LoginUIResolved {
  theme: string;
  variant: string;
  themeTemplate: UIConfig['themeTemplate'];
  pageLayout: UIConfig['pageTemplate']['layout'];
  fontFamily: UIConfig['pageTemplate']['fontFamily'];
  fontScale: UIConfig['pageTemplate']['fontScale'];
  backgroundColor: string;
  accentColor: string;
  titleColor: string;
  textColor: string;
  copyColor: string;
  brandName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  thumbnailUrl: string | null;
  logoDisplay: UIConfig['pageTemplate']['logoDisplay'];
  logoLayout: UIConfig['pageTemplate']['logoLayout'];
  brandPanelTitle: string | null;
  brandPanelText: string | null;
  supportedLocales: string[];
  defaultLocale: string;
  primaryLocales: LoginUILocale[] | null;
  showEnglishLanguageNames: boolean;
  backgroundImageUrl: string | null;
  loginPanelBackgroundImageUrl: string | null;
  customCss: string | null;
  headerEnabled: boolean;
  subtitleEnabled: boolean;
  footerEnabled: boolean;
  poweredByEnabled: boolean;
  authSwitchLinkEnabled: boolean;
  topbarPosition: UIConfig['pageTemplate']['topbarPosition'];
  themeToggleEnabled: boolean;
  languageSelectEnabled: boolean;
  languageSwitcherPosition: UIConfig['pageTemplate']['languageSwitcherPosition'];
  headerStyle: UIConfig['pageTemplate']['headerStyle'];
  footerStyle: UIConfig['pageTemplate']['footerStyle'];
  splitFrame: UIConfig['pageTemplate']['splitFrame'];
  splitPanelSide: UIConfig['pageTemplate']['splitPanelSide'];
  splitPanelWidth: UIConfig['pageTemplate']['splitPanelWidth'];
  splitBackgroundMode: UIConfig['pageTemplate']['splitBackgroundMode'];
  loginPanelBackgroundColor: string;
  loginPanelBackgroundGradientColor: string;
  loginPanelBackgroundOpacity: number;
  brandContentMode: UIConfig['pageTemplate']['brandContentMode'];
  brandPosition: UIConfig['pageTemplate']['brandPosition'];
  brandAlign: UIConfig['pageTemplate']['brandAlign'];
  headerText: string | null;
  textLocalizations: LoginUITextLocalizations;
  footerText: string | null;
  footerLinks: Array<{ label: string; url: string }>;
  customBlocks: Array<{
    position: string;
    type: string;
    content: string;
    url?: string;
    alt?: string;
  }>;
}

/**
 * Safely parse a JSON string into an array, returning empty array on failure.
 * Validates that the result is actually an array.
 */
function safeParseJsonArray<T>(json: string | undefined): T[] {
  if (!json || typeof json !== 'string') return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const LOGIN_UI_TEXT_FIELDS = new Set([
  'tagline',
  'brandPanelTitle',
  'brandPanelText',
  'footerText',
  'loginTitle',
  'registrationTitle',
  'accountTitle',
]);

function safeParseTextLocalizations(
  json: string | undefined,
  fallback: LoginUITextLocalizations = {}
): LoginUITextLocalizations {
  if (!json || typeof json !== 'string') return fallback;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(
          ([locale, value]) =>
            LOGIN_UI_LOCALES.includes(locale as (typeof LOGIN_UI_LOCALES)[number]) &&
            Boolean(value) &&
            typeof value === 'object' &&
            !Array.isArray(value)
        )
        .flatMap(([locale, value]) => {
          const localized = Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .filter(
                ([field, text]) => LOGIN_UI_TEXT_FIELDS.has(field) && typeof text === 'string'
              )
              .map(([field, text]) => [field, (text as string).trim().slice(0, MAX_STRING_LENGTH)])
          );
          return Object.keys(localized).length > 0 ? [[locale, localized]] : [];
        })
    );
  } catch {
    return fallback;
  }
}

function readBoundedIntegerEnvValue(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function resolveAuthenticationMethodsEdgeCacheTTL(env: Env): number {
  return readBoundedIntegerEnvValue(
    env.AUTHENTICATION_METHODS_EDGE_CACHE_TTL,
    DEFAULT_EDGE_CACHE_TTL,
    0,
    MAX_EDGE_CACHE_TTL
  );
}

function roundDurationMs(durationMs: number): number {
  return Math.round(durationMs * 100) / 100;
}

function sanitizeDiagnosticSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, MAX_DIAGNOSTIC_SESSION_ID_LENGTH);
}

function createAuthenticationMethodsDiagnosticTiming(
  request: Request
): AuthenticationMethodsDiagnosticTiming {
  const sessionId = sanitizeDiagnosticSessionId(request.headers.get(DIAGNOSTIC_SESSION_ID_HEADER));
  return {
    enabled: Boolean(sessionId),
    sessionId,
    startedAt: performance.now(),
    spans: [],
    completed: false,
  };
}

function recordAuthenticationMethodsTiming(
  timing: AuthenticationMethodsDiagnosticTiming,
  name: string,
  startedAt: number
): void {
  if (!timing.enabled) return;
  timing.spans.push({
    name,
    durationMs: roundDurationMs(performance.now() - startedAt),
  });
}

async function measureAuthenticationMethodsTiming<T>(
  timing: AuthenticationMethodsDiagnosticTiming,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    recordAuthenticationMethodsTiming(timing, name, startedAt);
  }
}

function finalizeAuthenticationMethodsTiming(
  timing: AuthenticationMethodsDiagnosticTiming
): AuthenticationMethodsTimingSpan[] {
  if (!timing.enabled) return [];
  if (!timing.completed) {
    timing.spans.push({
      name: 'handler_total',
      durationMs: roundDurationMs(performance.now() - timing.startedAt),
    });
    timing.completed = true;
  }
  return timing.spans;
}

function buildServerTimingHeader(spans: AuthenticationMethodsTimingSpan[]): string {
  return spans.map((span) => `${span.name};dur=${span.durationMs}`).join(', ');
}

function attachAuthenticationMethodsDiagnosticHeaders(
  response: Response,
  timing: AuthenticationMethodsDiagnosticTiming,
  spans: AuthenticationMethodsTimingSpan[]
): Response {
  if (!timing.enabled || spans.length === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Server-Timing', buildServerTimingHeader(spans));
  if (timing.sessionId) {
    headers.set('X-Authrim-Diagnostic-Session-Id', timing.sessionId);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function emitAuthenticationMethodsDiagnosticLog(input: {
  log: AuthenticationMethodsDiagnosticLogger;
  timing: AuthenticationMethodsDiagnosticTiming;
  spans: AuthenticationMethodsTimingSpan[];
  tenantId: string;
  requestedClientId: string | null;
  cacheStatus: AuthenticationMethodsCacheStatus;
  edgeCacheEnabled: boolean;
  edgeCacheTTL: number;
}): void {
  if (!input.timing.enabled) return;
  input.log.info('Authentication methods diagnostics', {
    diagnosticSessionId: input.timing.sessionId,
    tenantId: input.tenantId,
    clientScoped: Boolean(input.requestedClientId),
    cacheStatus: input.cacheStatus,
    edgeCacheEnabled: input.edgeCacheEnabled,
    edgeCacheTTL: input.edgeCacheTTL,
    timingMs: Object.fromEntries(input.spans.map((span) => [span.name, span.durationMs])),
  });
}

function normalizeCacheKeyPart(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || fallback;
}

function buildAuthenticationMethodsEdgeCacheRequest(input: {
  tenantId: string;
  forwardedHost: string | null;
  clientId: string | null;
  revision: string;
}): Request {
  const url = new URL('/cache/authentication-methods/v2', EDGE_CACHE_KEY_ORIGIN);
  url.searchParams.set('tenant', input.tenantId);
  url.searchParams.set('host', normalizeCacheKeyPart(input.forwardedHost, '__unknown_host__'));
  url.searchParams.set('client', input.clientId?.trim() || '__tenant__');
  url.searchParams.set('revision', input.revision);
  return new Request(url.toString(), { method: 'GET' });
}

function getAuthenticationMethodsCacheTag(tenantId: string): string {
  const safeTenantId = tenantId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'unknown';
  return `authrim-authentication-methods,authrim-authentication-methods-tenant-${safeTenantId}`;
}

function buildAuthenticationMethodsHeaders(input: {
  tenantId: string;
  cacheTTL: number;
  edgeCacheTTL: number;
  cacheStatus: AuthenticationMethodsCacheStatus;
}): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': `public, max-age=${input.cacheTTL}`,
    'X-Authrim-Authentication-Methods-Cache': input.cacheStatus,
    'X-Authrim-Authentication-Methods-Client-TTL': String(input.cacheTTL),
  });
  if (input.edgeCacheTTL > 0) {
    headers.set('Cloudflare-CDN-Cache-Control', `public, max-age=${input.edgeCacheTTL}`);
    headers.set('Cache-Tag', getAuthenticationMethodsCacheTag(input.tenantId));
  }
  return headers;
}

function buildAuthenticationMethodsJsonResponse(
  tenantId: string,
  body: AuthenticationMethodsResponse,
  cacheTTL: number,
  edgeCacheTTL: number,
  cacheStatus: AuthenticationMethodsCacheStatus
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: buildAuthenticationMethodsHeaders({ tenantId, cacheTTL, edgeCacheTTL, cacheStatus }),
  });
}

function getDefaultEdgeCache(): AuthenticationMethodsEdgeCache | null {
  const candidate = (
    globalThis as unknown as {
      caches?: { default?: AuthenticationMethodsEdgeCache };
    }
  ).caches?.default;
  return candidate ?? null;
}

function getWaitUntilExecutionContext(
  c: Context<{ Bindings: Env }>
): WaitUntilExecutionContext | null {
  try {
    return (c as unknown as { executionCtx?: WaitUntilExecutionContext }).executionCtx ?? null;
  } catch {
    return null;
  }
}

async function putAuthenticationMethodsEdgeCache(
  c: Context<{ Bindings: Env }>,
  cache: AuthenticationMethodsEdgeCache,
  request: Request,
  response: Response,
  edgeCacheTTL: number
): Promise<void> {
  const cacheable = new Response(response.body, response);
  cacheable.headers.set('Cache-Control', `public, max-age=${edgeCacheTTL}`);
  const put = cache.put(request, cacheable).catch((error) => {
    getLogger(c)
      .module('LOGIN-METHODS')
      .warn('Failed to store authentication methods edge cache', {}, error as Error);
  });
  const executionCtx = getWaitUntilExecutionContext(c);
  if (executionCtx) {
    executionCtx.waitUntil(put);
    return;
  }
  await put;
}

function cloneCachedAuthenticationMethodsResponse(
  tenantId: string,
  cached: Response,
  edgeCacheTTL: number
): Response {
  const cacheTTL = Math.max(
    0,
    Math.floor(Number(cached.headers.get('X-Authrim-Authentication-Methods-Client-TTL')) || 60)
  );
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: buildAuthenticationMethodsHeaders({
      tenantId,
      cacheTTL,
      edgeCacheTTL,
      cacheStatus: 'hit',
    }),
  });
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}

async function readAuthenticationMethodKVSettings(
  env: Env,
  tenantId: string
): Promise<AuthenticationMethodKVSettings | null> {
  try {
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
    return kvJson ? (JSON.parse(kvJson) as AuthenticationMethodKVSettings) : null;
  } catch {
    return null;
  }
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function readNonEmptyString(value: unknown, fallback: string | null = null): string | null {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_STRING_LENGTH) : fallback;
}

function readSafeColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu.test(trimmed)) return trimmed;
  if (/^rgb[a]?\(\s*[0-9.,%\s]+\)$/iu.test(trimmed)) return trimmed;
  if (/^[a-z]{3,20}$/iu.test(trimmed)) return trimmed;
  return fallback;
}

function readBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readCustomCss(value: unknown, fallback: string | null): string | null {
  const validation = validateLoginUICustomCss(value);
  return validation.valid ? validation.sanitizedCss : fallback;
}

function resolveLoginUIFromKVSettings(
  kvSettings: LoginUIKVSettings,
  defaults: LoginUIResolved
): LoginUIResolved {
  const configuredSupportedLocales = kvSettings['login-ui.supported_locales']
    ? kvSettings['login-ui.supported_locales']
        .split(',')
        .map((locale) => locale.trim())
        .filter((locale) => LOGIN_UI_LOCALES.includes(locale as (typeof LOGIN_UI_LOCALES)[number]))
        .filter((locale, index, locales) => locales.indexOf(locale) === index)
    : defaults.supportedLocales;
  const supportedLocales = isLegacyDefaultLoginUILocaleSet(configuredSupportedLocales)
    ? [...LOGIN_UI_LOCALES]
    : configuredSupportedLocales;
  const safeSupportedLocales =
    supportedLocales.length > 0 ? supportedLocales : defaults.supportedLocales;
  const configuredDefaultLocale = kvSettings['login-ui.default_locale'];
  const configuredPrimaryLocales = Object.prototype.hasOwnProperty.call(
    kvSettings,
    'login-ui.primary_locales'
  )
    ? parseConfiguredPrimaryLoginUILocales(kvSettings['login-ui.primary_locales'])
    : defaults.primaryLocales;

  return {
    theme: kvSettings['login-ui.theme'] || defaults.theme,
    variant: kvSettings['login-ui.variant'] || defaults.variant,
    themeTemplate: readEnum(
      kvSettings['login-ui.theme_template'],
      ['classic', 'meridian', 'split-brand-panel', 'fullbleed-glass'],
      defaults.themeTemplate
    ),
    pageLayout: readEnum(
      kvSettings['login-ui.page_layout'],
      ['centered_card', 'split_panel', 'fullbleed_card'],
      defaults.pageLayout
    ),
    fontFamily: readEnum(
      kvSettings['login-ui.font_family'],
      ['system', 'rounded', 'serif', 'mono'],
      defaults.fontFamily
    ),
    fontScale: readEnum(
      kvSettings['login-ui.font_scale'],
      ['compact', 'comfortable', 'spacious'],
      defaults.fontScale
    ),
    backgroundColor: readSafeColor(
      kvSettings['login-ui.background_color'],
      defaults.backgroundColor
    ),
    accentColor: readSafeColor(kvSettings['login-ui.accent_color'], defaults.accentColor),
    titleColor: readSafeColor(kvSettings['login-ui.title_color'], defaults.titleColor),
    textColor: readSafeColor(kvSettings['login-ui.text_color'], defaults.textColor),
    copyColor: readSafeColor(kvSettings['login-ui.copy_color'], defaults.copyColor),
    brandName: kvSettings['login-ui.brand_name'] || defaults.brandName,
    logoUrl: isValidLoginUIImageUrl(kvSettings['login-ui.logo_url'])
      ? kvSettings['login-ui.logo_url']!
      : defaults.logoUrl,
    faviconUrl: isValidLoginUIImageUrl(kvSettings['login-ui.favicon_url'])
      ? kvSettings['login-ui.favicon_url']!
      : defaults.faviconUrl,
    thumbnailUrl: isValidLoginUIImageUrl(kvSettings['login-ui.thumbnail_url'])
      ? kvSettings['login-ui.thumbnail_url']!
      : defaults.thumbnailUrl,
    logoDisplay: readEnum(
      kvSettings['login-ui.logo_display'],
      ['auto', 'image', 'text', 'hidden'],
      defaults.logoDisplay
    ),
    logoLayout: readEnum(kvSettings['login-ui.logo_layout'], ['stack', 'row'], defaults.logoLayout),
    brandPanelTitle: readNonEmptyString(
      kvSettings['login-ui.brand_panel_title'],
      defaults.brandPanelTitle
    ),
    brandPanelText: readNonEmptyString(
      kvSettings['login-ui.brand_panel_text'],
      defaults.brandPanelText
    ),
    supportedLocales: safeSupportedLocales,
    defaultLocale:
      typeof configuredDefaultLocale === 'string' &&
      safeSupportedLocales.includes(configuredDefaultLocale)
        ? configuredDefaultLocale
        : safeSupportedLocales.includes(defaults.defaultLocale)
          ? defaults.defaultLocale
          : (safeSupportedLocales[0] ?? DEFAULT_UI_CONFIG.defaultLocale),
    primaryLocales: configuredPrimaryLocales,
    showEnglishLanguageNames: readBoolean(
      kvSettings['login-ui.show_english_language_names'],
      defaults.showEnglishLanguageNames
    ),
    backgroundImageUrl: isValidLoginUIImageUrl(kvSettings['login-ui.background_image_url'])
      ? kvSettings['login-ui.background_image_url']!
      : defaults.backgroundImageUrl,
    loginPanelBackgroundImageUrl: isValidLoginUIImageUrl(
      kvSettings['login-ui.login_panel_background_image_url']
    )
      ? kvSettings['login-ui.login_panel_background_image_url']!
      : defaults.loginPanelBackgroundImageUrl,
    customCss: readCustomCss(kvSettings['login-ui.custom_css'], defaults.customCss),
    headerEnabled: readBoolean(kvSettings['login-ui.header_enabled'], defaults.headerEnabled),
    subtitleEnabled: readBoolean(kvSettings['login-ui.subtitle_enabled'], defaults.subtitleEnabled),
    footerEnabled: readBoolean(kvSettings['login-ui.footer_enabled'], defaults.footerEnabled),
    poweredByEnabled: readBoolean(
      kvSettings['login-ui.powered_by_enabled'],
      defaults.poweredByEnabled
    ),
    authSwitchLinkEnabled: readBoolean(
      kvSettings['login-ui.auth_switch_link_enabled'],
      defaults.authSwitchLinkEnabled
    ),
    topbarPosition: readEnum(
      kvSettings['login-ui.topbar_position'],
      [
        'below_card',
        'in_card',
        'top_right',
        'bottom_left',
        'bottom_center',
        'bottom_right',
        'hidden',
      ],
      readEnum(
        kvSettings['login-ui.language_switcher_position'],
        ['below_card', 'top_right', 'hidden'],
        defaults.topbarPosition
      )
    ),
    themeToggleEnabled: readBoolean(
      kvSettings['login-ui.theme_toggle_enabled'],
      defaults.themeToggleEnabled
    ),
    languageSelectEnabled: readBoolean(
      kvSettings['login-ui.language_select_enabled'],
      defaults.languageSelectEnabled
    ),
    languageSwitcherPosition: readEnum(
      kvSettings['login-ui.language_switcher_position'],
      ['below_card', 'top_right', 'hidden'],
      defaults.languageSwitcherPosition
    ),
    headerStyle: readEnum(
      kvSettings['login-ui.header_style'],
      ['center', 'bar'],
      defaults.headerStyle
    ),
    footerStyle: readEnum(
      kvSettings['login-ui.footer_style'],
      ['simple', 'bar'],
      defaults.footerStyle
    ),
    splitFrame: readEnum(kvSettings['login-ui.split_frame'], ['full', 'card'], defaults.splitFrame),
    splitPanelSide: readEnum(
      kvSettings['login-ui.split_panel_side'],
      ['left', 'right'],
      defaults.splitPanelSide
    ),
    splitPanelWidth: readEnum(
      kvSettings['login-ui.split_panel_width'],
      ['narrow', 'wide'],
      defaults.splitPanelWidth
    ),
    splitBackgroundMode: readEnum(
      kvSettings['login-ui.split_background_mode'],
      ['shared', 'brand', 'panel'],
      defaults.splitBackgroundMode
    ),
    loginPanelBackgroundColor: readSafeColor(
      kvSettings['login-ui.login_panel_background_color'],
      defaults.loginPanelBackgroundColor
    ),
    loginPanelBackgroundGradientColor: readSafeColor(
      kvSettings['login-ui.login_panel_background_gradient_color'],
      defaults.loginPanelBackgroundGradientColor
    ),
    loginPanelBackgroundOpacity: readBoundedNumber(
      kvSettings['login-ui.login_panel_background_opacity'],
      defaults.loginPanelBackgroundOpacity,
      0,
      100
    ),
    brandContentMode: readEnum(
      kvSettings['login-ui.brand_content_mode'],
      ['logo_copy', 'logo', 'none'],
      defaults.brandContentMode
    ),
    brandPosition: readEnum(
      kvSettings['login-ui.brand_position'],
      ['top', 'center', 'bottom'],
      defaults.brandPosition
    ),
    brandAlign: readEnum(
      kvSettings['login-ui.brand_align'],
      ['left', 'center', 'right'],
      defaults.brandAlign
    ),
    headerText: kvSettings['login-ui.header_text'] || defaults.headerText,
    textLocalizations:
      kvSettings['login-ui.text_localizations'] === undefined
        ? defaults.textLocalizations
        : safeParseTextLocalizations(
            kvSettings['login-ui.text_localizations'],
            defaults.textLocalizations
          ),
    footerText: kvSettings['login-ui.footer_text'] || defaults.footerText,
    footerLinks:
      kvSettings['login-ui.footer_links'] === undefined
        ? defaults.footerLinks
        : safeParseJsonArray<{ label: string; url: string }>(kvSettings['login-ui.footer_links']),
    customBlocks:
      kvSettings['login-ui.custom_blocks'] === undefined
        ? defaults.customBlocks
        : safeParseJsonArray<{
            position: string;
            type: string;
            content: string;
            url?: string;
            alt?: string;
          }>(kvSettings['login-ui.custom_blocks']),
  };
}

async function applyClientLoginUIOverride(
  env: Env,
  tenantId: string,
  clientId: string | null | undefined,
  base: LoginUIResolved
): Promise<LoginUIResolved> {
  if (
    !clientId ||
    clientId.length > VALIDATION_LIMITS.CLIENT_ID_MAX_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/u.test(clientId)
  ) {
    return base;
  }
  try {
    const kvJson = await env.SETTINGS?.get(`settings:client:${tenantId}:${clientId}:login-ui`);
    if (!kvJson) return base;
    return resolveLoginUIFromKVSettings(JSON.parse(kvJson) as LoginUIKVSettings, base);
  } catch {
    return base;
  }
}

/**
 * Read Login UI settings from AUTHRIM_CONFIG KV (settings-v2 system)
 * Falls back to system_settings.loginUI for backward compatibility
 */
async function getLoginUISettings(
  env: Env,
  tenantId: string,
  systemSettings: SystemSettings,
  clientId?: string | null
): Promise<LoginUIResolved> {
  const defaults: LoginUIResolved = {
    theme: DEFAULT_UI_CONFIG.theme,
    variant: DEFAULT_UI_CONFIG.variant,
    themeTemplate: DEFAULT_UI_CONFIG.themeTemplate,
    pageLayout: DEFAULT_UI_CONFIG.pageTemplate.layout,
    fontFamily: DEFAULT_UI_CONFIG.pageTemplate.fontFamily,
    fontScale: DEFAULT_UI_CONFIG.pageTemplate.fontScale,
    backgroundColor: DEFAULT_UI_CONFIG.pageTemplate.backgroundColor,
    accentColor: DEFAULT_UI_CONFIG.pageTemplate.accentColor,
    titleColor: DEFAULT_UI_CONFIG.pageTemplate.titleColor,
    textColor: DEFAULT_UI_CONFIG.pageTemplate.textColor,
    copyColor: DEFAULT_UI_CONFIG.pageTemplate.copyColor,
    brandName: DEFAULT_UI_CONFIG.branding.brandName,
    logoUrl: DEFAULT_UI_CONFIG.branding.logoUrl,
    faviconUrl: DEFAULT_UI_CONFIG.branding.faviconUrl,
    thumbnailUrl: DEFAULT_UI_CONFIG.appearance.thumbnailUrl,
    logoDisplay: DEFAULT_UI_CONFIG.pageTemplate.logoDisplay,
    logoLayout: DEFAULT_UI_CONFIG.pageTemplate.logoLayout,
    brandPanelTitle: DEFAULT_UI_CONFIG.pageTemplate.brandPanelTitle,
    brandPanelText: DEFAULT_UI_CONFIG.pageTemplate.brandPanelText,
    supportedLocales: [...DEFAULT_UI_CONFIG.supportedLocales],
    defaultLocale: DEFAULT_UI_CONFIG.defaultLocale,
    primaryLocales: null,
    showEnglishLanguageNames: DEFAULT_UI_CONFIG.showEnglishLanguageNames,
    backgroundImageUrl: DEFAULT_UI_CONFIG.appearance.backgroundImageUrl,
    loginPanelBackgroundImageUrl: DEFAULT_UI_CONFIG.appearance.loginPanelBackgroundImageUrl,
    customCss: DEFAULT_UI_CONFIG.appearance.customCss,
    headerEnabled: DEFAULT_UI_CONFIG.pageTemplate.headerEnabled,
    subtitleEnabled: DEFAULT_UI_CONFIG.pageTemplate.subtitleEnabled,
    footerEnabled: DEFAULT_UI_CONFIG.pageTemplate.footerEnabled,
    poweredByEnabled: DEFAULT_UI_CONFIG.pageTemplate.poweredByEnabled,
    authSwitchLinkEnabled: DEFAULT_UI_CONFIG.pageTemplate.authSwitchLinkEnabled,
    topbarPosition: DEFAULT_UI_CONFIG.pageTemplate.topbarPosition,
    themeToggleEnabled: DEFAULT_UI_CONFIG.pageTemplate.themeToggleEnabled,
    languageSelectEnabled: DEFAULT_UI_CONFIG.pageTemplate.languageSelectEnabled,
    languageSwitcherPosition: DEFAULT_UI_CONFIG.pageTemplate.languageSwitcherPosition,
    headerStyle: DEFAULT_UI_CONFIG.pageTemplate.headerStyle,
    footerStyle: DEFAULT_UI_CONFIG.pageTemplate.footerStyle,
    splitFrame: DEFAULT_UI_CONFIG.pageTemplate.splitFrame,
    splitPanelSide: DEFAULT_UI_CONFIG.pageTemplate.splitPanelSide,
    splitPanelWidth: DEFAULT_UI_CONFIG.pageTemplate.splitPanelWidth,
    splitBackgroundMode: DEFAULT_UI_CONFIG.pageTemplate.splitBackgroundMode,
    loginPanelBackgroundColor: DEFAULT_UI_CONFIG.pageTemplate.loginPanelBackgroundColor,
    loginPanelBackgroundGradientColor:
      DEFAULT_UI_CONFIG.pageTemplate.loginPanelBackgroundGradientColor,
    loginPanelBackgroundOpacity: DEFAULT_UI_CONFIG.pageTemplate.loginPanelBackgroundOpacity,
    brandContentMode: DEFAULT_UI_CONFIG.pageTemplate.brandContentMode,
    brandPosition: DEFAULT_UI_CONFIG.pageTemplate.brandPosition,
    brandAlign: DEFAULT_UI_CONFIG.pageTemplate.brandAlign,
    headerText: DEFAULT_UI_CONFIG.appearance.headerText,
    textLocalizations: DEFAULT_UI_CONFIG.appearance.textLocalizations,
    footerText: DEFAULT_UI_CONFIG.appearance.footerText,
    footerLinks: [...DEFAULT_UI_CONFIG.appearance.footerLinks],
    customBlocks: [...DEFAULT_UI_CONFIG.appearance.customBlocks],
  };

  // Resolve settings-v2 from platform to tenant to client so the Admin UI scope
  // hierarchy is reflected by the public Login UI configuration.
  let inheritedDefaults = defaults;
  let hasPlatformSettings = false;
  try {
    const platformJson = await env.SETTINGS?.get('settings:platform:login-ui');
    if (platformJson) {
      inheritedDefaults = resolveLoginUIFromKVSettings(
        JSON.parse(platformJson) as LoginUIKVSettings,
        defaults
      );
      hasPlatformSettings = true;
    }
  } catch {
    // Invalid platform settings do not prevent tenant or legacy settings from loading.
  }

  try {
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:login-ui`);
    if (kvJson) {
      const kvSettings = JSON.parse(kvJson) as LoginUIKVSettings;
      return applyClientLoginUIOverride(
        env,
        tenantId,
        clientId,
        resolveLoginUIFromKVSettings(kvSettings, inheritedDefaults)
      );
    }
  } catch {
    // Invalid JSON — fall through to legacy
  }

  if (hasPlatformSettings) {
    return applyClientLoginUIOverride(env, tenantId, clientId, inheritedDefaults);
  }

  // Fallback to legacy system_settings.loginUI
  return applyClientLoginUIOverride(env, tenantId, clientId, {
    theme: systemSettings.loginUI?.theme || defaults.theme,
    variant: systemSettings.loginUI?.variant || defaults.variant,
    themeTemplate: defaults.themeTemplate,
    pageLayout: defaults.pageLayout,
    fontFamily: defaults.fontFamily,
    fontScale: defaults.fontScale,
    backgroundColor: defaults.backgroundColor,
    accentColor: defaults.accentColor,
    titleColor: defaults.titleColor,
    textColor: defaults.textColor,
    copyColor: defaults.copyColor,
    brandName: systemSettings.general?.siteName || defaults.brandName,
    logoUrl: isValidLoginUIImageUrl(systemSettings.general?.logoUrl)
      ? systemSettings.general!.logoUrl!
      : defaults.logoUrl,
    faviconUrl: defaults.faviconUrl,
    thumbnailUrl: defaults.thumbnailUrl,
    logoDisplay: defaults.logoDisplay,
    logoLayout: defaults.logoLayout,
    brandPanelTitle: defaults.brandPanelTitle,
    brandPanelText: defaults.brandPanelText,
    supportedLocales: systemSettings.loginUI?.supportedLocales || defaults.supportedLocales,
    defaultLocale: defaults.defaultLocale,
    primaryLocales: defaults.primaryLocales,
    showEnglishLanguageNames: defaults.showEnglishLanguageNames,
    backgroundImageUrl: defaults.backgroundImageUrl,
    loginPanelBackgroundImageUrl: defaults.loginPanelBackgroundImageUrl,
    customCss: defaults.customCss,
    headerEnabled: defaults.headerEnabled,
    subtitleEnabled: defaults.subtitleEnabled,
    footerEnabled: defaults.footerEnabled,
    poweredByEnabled: defaults.poweredByEnabled,
    authSwitchLinkEnabled: defaults.authSwitchLinkEnabled,
    topbarPosition: defaults.topbarPosition,
    themeToggleEnabled: defaults.themeToggleEnabled,
    languageSelectEnabled: defaults.languageSelectEnabled,
    languageSwitcherPosition: defaults.languageSwitcherPosition,
    headerStyle: defaults.headerStyle,
    footerStyle: defaults.footerStyle,
    splitFrame: defaults.splitFrame,
    splitPanelSide: defaults.splitPanelSide,
    splitPanelWidth: defaults.splitPanelWidth,
    splitBackgroundMode: defaults.splitBackgroundMode,
    loginPanelBackgroundColor: defaults.loginPanelBackgroundColor,
    loginPanelBackgroundGradientColor: defaults.loginPanelBackgroundGradientColor,
    loginPanelBackgroundOpacity: defaults.loginPanelBackgroundOpacity,
    brandContentMode: defaults.brandContentMode,
    brandPosition: defaults.brandPosition,
    brandAlign: defaults.brandAlign,
    headerText: defaults.headerText,
    textLocalizations: defaults.textLocalizations,
    footerText: defaults.footerText,
    footerLinks: defaults.footerLinks,
    customBlocks: defaults.customBlocks,
  });
}

/**
 * Validate a URL string: must be HTTPS and within length limit
 */
function isValidHttpsUrl(url: string | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  if (url.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidLoginUIImageUrl(url: string | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  if (url.length > MAX_URL_LENGTH) return false;
  if (url.startsWith('/api/assets/')) {
    return /^\/api\/assets\/[A-Za-z0-9_-]{1,128}\/login-ui\/(?:logo|background|panel-background|favicon|thumbnail)\/[A-Za-z0-9._-]+\.(?:gif|ico|jpe?g|png|webp)$/u.test(
      url
    );
  }
  return isValidHttpsUrl(url);
}

/**
 * Truncate a string to the max allowed length
 */
function truncateString(value: string | undefined, maxLen: number = MAX_STRING_LENGTH): string {
  if (!value || typeof value !== 'string') return '';
  return value.slice(0, maxLen);
}

function normalizeLoginProviderIconName(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && LOGIN_PROVIDER_ICON_NAMES.has(normalized) ? normalized : undefined;
}

/**
 * Normalize provider types for the Login UI. Unknown future protocols remain displayable.
 */
function normalizeExternalProviderType(value: string | undefined): ExternalLoginProviderType {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'saml' || normalized === 'saml_idp' || normalized === 'saml_sp') {
    return 'saml';
  }
  if (normalized === 'vc' || normalized === 'openid4vc' || normalized === 'openid4vp') {
    return 'vc';
  }
  if (normalized === 'oauth2' || normalized === 'oauth') {
    return 'oauth2';
  }
  if (normalized === 'oidc' || normalized === 'openid_connect') {
    return 'oidc';
  }
  return normalized ? 'custom' : 'oidc';
}

function normalizeExternalStartMode(
  value: string | undefined,
  type: ExternalLoginProviderType
): ExternalLoginStartMode {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'oauth_redirect' ||
    normalized === 'oauth' ||
    normalized === 'oidc' ||
    normalized === 'oauth2'
  ) {
    return 'oauth_redirect';
  }
  if (normalized === 'saml_sp' || normalized === 'saml') {
    return 'saml_sp';
  }
  if (type === 'saml') return 'saml_sp';
  return 'oauth_redirect';
}

function isValidStartUrl(value: string | undefined): value is string {
  if (!value || typeof value !== 'string') return false;
  if (value.startsWith('//')) return false;
  try {
    const parsed = new URL(value, 'https://authrim.local');
    if (parsed.origin === 'https://authrim.local') {
      return value.startsWith('/');
    }
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildSAMLSPLoginStartUrl(providerId: string): string {
  const params = new URLSearchParams({ idp: providerId });
  return `/saml/sp/login?${params.toString()}`;
}

function getForwardedProto(request: Request): string {
  const headerValue = request.headers.get('X-Forwarded-Proto')?.split(',')[0]?.trim();
  if (headerValue === 'http' || headerValue === 'https') {
    return headerValue;
  }

  try {
    const protocol = new URL(request.url).protocol.replace(':', '');
    return protocol === 'http' || protocol === 'https' ? protocol : 'https';
  } catch {
    return 'https';
  }
}

function buildExternalIdpProviderHeaders(
  tenantId: string,
  request: Request
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Tenant-Id': tenantId,
  };
  const forwardedHost = getRequestHost(request);
  if (forwardedHost) {
    headers['X-Authrim-Forwarded-Host'] = forwardedHost;
    headers['X-Forwarded-Host'] = forwardedHost;
    headers['X-Forwarded-Proto'] = getForwardedProto(request);
  }
  return headers;
}

function parseExternalProviderUsageItems(
  settings: AuthenticationMethodKVSettings | null
): ExternalLoginProviderUsageConfig[] | null {
  if (!settings) return null;
  const rawUsage = settings['authentication-methods.external_provider_usage'];
  if (rawUsage === undefined) return null;
  if (Array.isArray(rawUsage)) return rawUsage;
  if (typeof rawUsage === 'string') {
    return safeParseJsonArray<ExternalLoginProviderUsageConfig>(rawUsage);
  }
  return null;
}

function isSAMLExternalProviderUsage(item: ExternalLoginProviderUsageConfig): boolean {
  const id = typeof item.id === 'string' ? item.id : '';
  const providerId = typeof item.providerId === 'string' ? item.providerId : '';
  return id.startsWith('saml:') || providerId.startsWith('saml:');
}

function externalProviderUsageHasEnabledSurface(item: ExternalLoginProviderUsageConfig): boolean {
  return (
    normalizeBoolean(item.loginEnabled, true) ||
    normalizeBoolean(item.signupEnabled, true) ||
    normalizeBoolean(item.reauthEnabled, true) ||
    normalizeBoolean(item.accountLinkEnabled, true)
  );
}

function shouldFetchExternalLoginProviders(
  settings: AuthenticationMethodKVSettings | null
): boolean {
  const usageItems = parseExternalProviderUsageItems(settings);
  if (usageItems === null) {
    // Legacy tenant: bridge providers may exist even before usage settings were saved.
    return true;
  }
  return usageItems.some(
    (item) => !isSAMLExternalProviderUsage(item) && externalProviderUsageHasEnabledSurface(item)
  );
}

/**
 * Fetch enabled external login providers from ar-bridge via service binding.
 */
async function fetchExternalLoginProviders(
  env: Env,
  tenantId: string,
  request: Request
): Promise<ExternalLoginProvider[]> {
  if (!env.EXTERNAL_IDP) {
    return [];
  }

  try {
    const response = await env.EXTERNAL_IDP.fetch('https://external-idp/api/external/providers', {
      method: 'GET',
      headers: buildExternalIdpProviderHeaders(tenantId, request),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      providers?: Array<{
        id: string;
        slug?: string;
        name: string;
        providerType?: string;
        iconUrl?: string;
        iconName?: string;
        buttonColor?: string;
        buttonText?: string;
        autoLinkEmail?: boolean;
        enabled?: boolean;
      }>;
    };

    if (!Array.isArray(data.providers)) {
      return [];
    }

    return data.providers
      .filter((p) => p.enabled !== false)
      .filter((p) => p.id && typeof p.id === 'string' && p.name && typeof p.name === 'string')
      .slice(0, MAX_EXTERNAL_LOGIN_PROVIDERS)
      .map((p) => {
        const type = normalizeExternalProviderType(p.providerType);
        const id = truncateString(p.slug || p.id);
        return {
          id,
          name: truncateString(p.name),
          type,
          startMode: 'oauth_redirect',
          enabled: true,
          loginEnabled: true,
          signupEnabled: true,
          reauthEnabled: true,
          accountLinkEnabled: p.autoLinkEmail !== false,
          autoLinkEmail: p.autoLinkEmail !== false,
          slug: p.slug ? truncateString(p.slug) : undefined,
          iconUrl: isValidHttpsUrl(p.iconUrl) ? p.iconUrl : undefined,
          iconName: normalizeLoginProviderIconName(p.iconName),
          buttonColor: p.buttonColor ? truncateString(p.buttonColor, 50) : undefined,
          buttonText: p.buttonText ? truncateString(p.buttonText, 100) : undefined,
          startUrl: `/api/external/${encodeURIComponent(id)}/start`,
        };
      });
  } catch {
    return [];
  }
}

async function fetchSAMLLoginProviders(
  env: Env,
  tenantId: string
): Promise<ExternalLoginProvider[]> {
  try {
    const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
      env,
      'authentication-methods-saml',
      {
        tenantId,
      }
    );
    const rows = await adapter.query<{ id: string; name: string; config_json: string }>(
      `SELECT id, name, config_json
       FROM identity_providers
       WHERE tenant_id = ? AND provider_type = 'saml_idp' AND enabled = 1
       ORDER BY name ASC
       LIMIT ?`,
      [tenantId, MAX_EXTERNAL_LOGIN_PROVIDERS]
    );

    return rows
      .filter((row) => row.id && row.name)
      .map((row) => ({
        id: `saml:${truncateString(row.id)}`,
        name: truncateString(row.name),
        type: 'saml',
        startMode: 'saml_sp',
        enabled: true,
        loginEnabled: true,
        signupEnabled: true,
        reauthEnabled: true,
        accountLinkEnabled: true,
        autoLinkEmail: true,
        iconUrl: getSAMLProviderLogoUrl(row.config_json),
        iconName: getSAMLProviderIconName(row.config_json),
        startUrl: buildSAMLSPLoginStartUrl(row.id),
      }));
  } catch {
    return [];
  }
}

function getSAMLProviderLogoUrl(configJson: string): string | undefined {
  try {
    const config = JSON.parse(configJson) as { logoUrl?: string };
    return isValidHttpsUrl(config.logoUrl) ? config.logoUrl : undefined;
  } catch {
    return undefined;
  }
}

function getSAMLProviderIconName(configJson: string): string | undefined {
  try {
    const config = JSON.parse(configJson) as { iconName?: string };
    return normalizeLoginProviderIconName(config.iconName);
  } catch {
    return undefined;
  }
}

async function fetchConfiguredExternalLoginProviders(
  env: Env,
  tenantId: string
): Promise<ExternalLoginProvider[]> {
  try {
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
    if (!kvJson) return [];

    const kvSettings = JSON.parse(kvJson) as AuthenticationMethodKVSettings;
    const rawProviders = kvSettings['authentication-methods.external_providers'];
    const providers =
      typeof rawProviders === 'string'
        ? safeParseJsonArray<ExternalLoginProviderConfig>(rawProviders)
        : rawProviders;

    if (!Array.isArray(providers)) return [];

    return providers
      .filter((provider) => provider.enabled !== false)
      .filter(
        (provider) =>
          typeof provider.id === 'string' &&
          typeof provider.name === 'string' &&
          isValidStartUrl(provider.startUrl)
      )
      .slice(0, MAX_EXTERNAL_LOGIN_PROVIDERS)
      .map((provider) => {
        const type = normalizeExternalProviderType(provider.type);
        const legacyEnabled = provider.enabled !== false;
        const loginEnabled = normalizeBoolean(provider.loginEnabled, legacyEnabled);
        const signupEnabled = normalizeBoolean(provider.signupEnabled, legacyEnabled);
        const reauthEnabled = normalizeBoolean(provider.reauthEnabled, loginEnabled);
        const accountLinkEnabled = normalizeBoolean(provider.accountLinkEnabled, legacyEnabled);
        return {
          id: truncateString(provider.id),
          name: truncateString(provider.name),
          type,
          startMode: normalizeExternalStartMode(provider.startMode, type),
          enabled: legacyEnabled && (loginEnabled || signupEnabled || reauthEnabled),
          loginEnabled,
          signupEnabled,
          reauthEnabled,
          accountLinkEnabled,
          autoLinkEmail: accountLinkEnabled,
          slug: provider.slug ? truncateString(provider.slug) : undefined,
          iconUrl: isValidHttpsUrl(provider.iconUrl) ? provider.iconUrl : undefined,
          iconName: normalizeLoginProviderIconName(provider.iconName),
          buttonColor: provider.buttonColor ? truncateString(provider.buttonColor, 50) : undefined,
          buttonText: provider.buttonText ? truncateString(provider.buttonText, 100) : undefined,
          startUrl: provider.startUrl,
        };
      })
      .filter((provider) => provider.enabled);
  } catch {
    return [];
  }
}

interface DirectoryPasswordResolved {
  enabled: boolean;
  label: string;
}

interface HumanVerificationResolved {
  providerPluginId: string;
  loginEnabled: boolean;
  signupEnabled: boolean;
  reauthEnabled: boolean;
}

interface HumanVerificationPluginConfig {
  siteKey?: unknown;
  secretKey?: unknown;
  failurePolicy?: unknown;
  widgetMode?: unknown;
}

interface BuiltInMethodsResolved {
  passkeyLoginEnabled: boolean;
  passkeySignupEnabled: boolean;
  passkeyReauthEnabled: boolean;
  passkeyAccountLinkEnabled: boolean;
  emailCodeLoginEnabled: boolean;
  emailCodeSignupEnabled: boolean;
  emailCodeReauthEnabled: boolean;
  emailCodeAccountLinkEnabled: boolean;
  totpLoginEnabled: boolean;
  totpSignupEnabled: boolean;
  totpReauthEnabled: boolean;
  totpAccountLinkEnabled: boolean;
  totpPreset: 'compatible' | 'strong';
  totpDefaultAcr: string;
  totpRequirementMode: 'optional' | 'required';
}

async function resolveBuiltInAuthenticationMethods(
  env: Env,
  tenantId: string,
  systemSettings?: SystemSettings
): Promise<BuiltInMethodsResolved> {
  const legacySettings = systemSettings ?? (await getSystemSettings(env));
  const legacyPasskeyDefault = legacySettings.advanced?.passkeyEnabled !== false;
  const legacyEmailCodeDefault = legacySettings.advanced?.magicLinkEnabled === true;
  const defaults: BuiltInMethodsResolved = {
    passkeyLoginEnabled: legacyPasskeyDefault,
    passkeySignupEnabled: legacyPasskeyDefault,
    passkeyReauthEnabled: legacyPasskeyDefault,
    passkeyAccountLinkEnabled: legacyPasskeyDefault,
    emailCodeLoginEnabled: legacyEmailCodeDefault,
    emailCodeSignupEnabled: legacyEmailCodeDefault,
    emailCodeReauthEnabled: legacyEmailCodeDefault,
    emailCodeAccountLinkEnabled: legacyEmailCodeDefault,
    totpLoginEnabled: false,
    totpSignupEnabled: false,
    totpReauthEnabled: false,
    totpAccountLinkEnabled: false,
    totpPreset: 'compatible',
    totpDefaultAcr: 'urn:authrim:aal:2',
    totpRequirementMode: 'optional',
  };

  try {
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
    if (!kvJson) return defaults;

    const kvSettings = JSON.parse(kvJson) as AuthenticationMethodKVSettings;
    const legacyPasskeyEnabled = kvSettings['authentication-methods.passkey.enabled'];
    const legacyEmailOtpEnabled = kvSettings['authentication-methods.email_otp.enabled'];
    const legacyTotpEnabled = kvSettings['authentication-methods.totp.enabled'];
    const totpRequirementPolicy = parseTotpRequirementPolicy(
      kvSettings['authentication-methods.totp.requirement_policy']
    );
    return {
      passkeyLoginEnabled: normalizeBoolean(
        kvSettings['authentication-methods.passkey.login_enabled'],
        normalizeBoolean(legacyPasskeyEnabled, defaults.passkeyLoginEnabled)
      ),
      passkeySignupEnabled: normalizeBoolean(
        kvSettings['authentication-methods.passkey.signup_enabled'],
        normalizeBoolean(legacyPasskeyEnabled, defaults.passkeySignupEnabled)
      ),
      passkeyReauthEnabled: normalizeBoolean(
        kvSettings['authentication-methods.passkey.reauth_enabled'],
        normalizeBoolean(legacyPasskeyEnabled, defaults.passkeyReauthEnabled)
      ),
      passkeyAccountLinkEnabled: normalizeBoolean(
        kvSettings['authentication-methods.passkey.account_link_enabled'],
        normalizeBoolean(legacyPasskeyEnabled, defaults.passkeyAccountLinkEnabled)
      ),
      emailCodeLoginEnabled: normalizeBoolean(
        kvSettings['authentication-methods.email_otp.login_enabled'],
        normalizeBoolean(legacyEmailOtpEnabled, defaults.emailCodeLoginEnabled)
      ),
      emailCodeSignupEnabled: normalizeBoolean(
        kvSettings['authentication-methods.email_otp.signup_enabled'],
        normalizeBoolean(legacyEmailOtpEnabled, defaults.emailCodeSignupEnabled)
      ),
      emailCodeReauthEnabled: normalizeBoolean(
        kvSettings['authentication-methods.email_otp.reauth_enabled'],
        normalizeBoolean(legacyEmailOtpEnabled, defaults.emailCodeReauthEnabled)
      ),
      emailCodeAccountLinkEnabled: normalizeBoolean(
        kvSettings['authentication-methods.email_otp.account_link_enabled'],
        normalizeBoolean(legacyEmailOtpEnabled, defaults.emailCodeAccountLinkEnabled)
      ),
      totpLoginEnabled: normalizeBoolean(
        kvSettings['authentication-methods.totp.login_enabled'],
        normalizeBoolean(legacyTotpEnabled, defaults.totpLoginEnabled)
      ),
      totpSignupEnabled: normalizeBoolean(
        kvSettings['authentication-methods.totp.signup_enabled'],
        normalizeBoolean(legacyTotpEnabled, defaults.totpSignupEnabled)
      ),
      totpReauthEnabled: normalizeBoolean(
        kvSettings['authentication-methods.totp.reauth_enabled'],
        normalizeBoolean(legacyTotpEnabled, defaults.totpReauthEnabled)
      ),
      totpAccountLinkEnabled: normalizeBoolean(
        kvSettings['authentication-methods.totp.account_link_enabled'],
        normalizeBoolean(legacyTotpEnabled, defaults.totpAccountLinkEnabled)
      ),
      totpPreset:
        kvSettings['authentication-methods.totp.preset'] === 'strong' ? 'strong' : 'compatible',
      totpDefaultAcr:
        typeof kvSettings['authentication-methods.totp.default_acr'] === 'string' &&
        kvSettings['authentication-methods.totp.default_acr'].trim().length > 0
          ? kvSettings['authentication-methods.totp.default_acr'].trim()
          : defaults.totpDefaultAcr,
      totpRequirementMode: totpRequirementPolicy.mode,
    };
  } catch {
    return defaults;
  }
}

function parseTotpRequirementPolicy(value: unknown): { mode: 'optional' | 'required' } {
  try {
    const parsed =
      typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        mode: (parsed as Record<string, unknown>).mode === 'required' ? 'required' : 'optional',
      };
    }
  } catch {
    // Invalid policy JSON is treated as optional.
  }
  return { mode: 'optional' };
}

async function resolveDirectoryPasswordMethod(
  env: Env,
  tenantId: string
): Promise<DirectoryPasswordResolved> {
  const defaults: DirectoryPasswordResolved = {
    enabled: false,
    label: 'Organization ID',
  };

  try {
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:directory-connectors`);
    if (!kvJson) return defaults;

    const kvSettings = JSON.parse(kvJson) as DirectoryConnectorDiscoverySettings;
    const defaultConnectorId =
      typeof kvSettings.default_connector_id === 'string' && kvSettings.default_connector_id.trim()
        ? kvSettings.default_connector_id.trim()
        : 'campus';
    const connectors = Array.isArray(kvSettings.connectors) ? kvSettings.connectors : [];
    const hasDefaultConnector = connectors.some((connector) => {
      if (!connector || typeof connector !== 'object' || Array.isArray(connector)) return false;
      const record = connector as Record<string, unknown>;
      const transport = record.transport === 'relay' ? 'relay' : 'direct';
      const endpointURL = typeof record.endpoint_url === 'string' ? record.endpoint_url.trim() : '';
      return (
        record.id === defaultConnectorId &&
        (transport === 'relay' || endpointURL.length > 0) &&
        record.auth_mode === 'hmac' &&
        typeof record.connector_id === 'string' &&
        record.connector_id.trim().length > 0 &&
        typeof record.key_id === 'string' &&
        record.key_id.trim().length > 0 &&
        typeof record.secret_ref === 'string' &&
        record.secret_ref.trim().length > 0
      );
    });

    return {
      enabled: normalizeBoolean(kvSettings.enabled, defaults.enabled) && hasDefaultConnector,
      label: defaults.label,
    };
  } catch {
    return defaults;
  }
}

async function decryptPluginConfigIfNeeded(
  config: Record<string, unknown>,
  env: Env
): Promise<Record<string, unknown>> {
  const encrypted = config as EncryptedConfig;
  if (!encrypted._encrypted || encrypted._encrypted.length === 0) {
    return config;
  }

  try {
    const key = await getPluginEncryptionKey(
      env as { PLUGIN_ENCRYPTION_KEY?: string; PLUGIN_ENCRYPTION_SALT?: string }
    );
    return await decryptSecretFields(encrypted, key);
  } catch {
    const encryptedFields = new Set(encrypted._encrypted);
    return Object.fromEntries(
      Object.entries(config).filter(
        ([field]) => field !== '_encrypted' && !encryptedFields.has(field)
      )
    );
  }
}

async function readHumanVerificationPluginConfig(
  env: Env,
  tenantId: string,
  pluginId: string
): Promise<HumanVerificationPluginConfig> {
  const settings = env.SETTINGS;
  if (!settings) return {};

  const readConfig = async (key: string): Promise<Record<string, unknown>> => {
    const raw = await settings.get(key);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return await decryptPluginConfigIfNeeded(parsed as Record<string, unknown>, env);
    } catch {
      return {};
    }
  };

  const [globalConfig, tenantConfig] = await Promise.all([
    readConfig(`plugins:config:${pluginId}`),
    readConfig(`plugins:config:${pluginId}:tenant:${tenantId}`),
  ]);

  return { ...globalConfig, ...tenantConfig };
}

function providerFromHumanVerificationPluginId(pluginId: string): HumanVerificationProvider {
  switch (pluginId) {
    case 'human-verification-cloudflare-turnstile':
      return 'turnstile';
    case 'human-verification-hcaptcha':
      return 'hcaptcha';
    case 'human-verification-google-recaptcha':
      return 'recaptcha';
    default:
      return 'custom';
  }
}

function widgetModeFromConfig(
  provider: HumanVerificationProvider,
  config: HumanVerificationPluginConfig
): HumanVerificationWidgetMode {
  if (provider === 'turnstile') return 'managed';
  if (config.widgetMode === 'invisible') return 'invisible';
  if (provider === 'recaptcha' && config.widgetMode === 'score') return 'score';
  return 'checkbox';
}

async function isPluginEnabled(
  settings: KVNamespace | undefined,
  pluginId: string,
  tenantId: string
): Promise<boolean> {
  if (!settings) return false;

  const tenantValue = await settings.get(`plugins:enabled:${pluginId}:tenant:${tenantId}`);
  if (tenantValue !== null) {
    return tenantValue === 'true';
  }

  const globalValue = await settings.get(`plugins:enabled:${pluginId}`);
  if (globalValue !== null) {
    return globalValue === 'true';
  }

  return true;
}

async function resolveHumanVerificationMethod(
  env: Env,
  tenantId: string
): Promise<HumanVerificationMethod> {
  const defaults: HumanVerificationResolved = {
    providerPluginId: 'human-verification-cloudflare-turnstile',
    loginEnabled: false,
    signupEnabled: false,
    reauthEnabled: false,
  };

  let resolved = defaults;
  try {
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
    if (kvJson) {
      const kvSettings = JSON.parse(kvJson) as AuthenticationMethodKVSettings;
      resolved = {
        providerPluginId:
          typeof kvSettings['authentication-methods.human_verification.provider'] === 'string'
            ? kvSettings['authentication-methods.human_verification.provider']
            : defaults.providerPluginId,
        loginEnabled: normalizeBoolean(
          kvSettings['authentication-methods.human_verification.login_enabled'],
          defaults.loginEnabled
        ),
        signupEnabled: normalizeBoolean(
          kvSettings['authentication-methods.human_verification.signup_enabled'],
          defaults.signupEnabled
        ),
        reauthEnabled: normalizeBoolean(
          kvSettings['authentication-methods.human_verification.reauth_enabled'],
          defaults.reauthEnabled
        ),
      };
    }
  } catch {
    resolved = defaults;
  }

  let pluginEnabled = false;
  let pluginConfig: HumanVerificationPluginConfig = {};
  try {
    pluginEnabled = await isPluginEnabled(env.SETTINGS, resolved.providerPluginId, tenantId);
    pluginConfig = await readHumanVerificationPluginConfig(
      env,
      tenantId,
      resolved.providerPluginId
    );
  } catch {
    pluginEnabled = false;
    pluginConfig = {};
  }
  const provider = providerFromHumanVerificationPluginId(resolved.providerPluginId);
  const siteKey = typeof pluginConfig.siteKey === 'string' ? pluginConfig.siteKey : '';
  const configured = Boolean(siteKey && typeof pluginConfig.secretKey === 'string');
  const failurePolicy = 'fail_closed' as const;
  const hasEnabledUsage = resolved.loginEnabled || resolved.signupEnabled || resolved.reauthEnabled;

  return {
    enabled: pluginEnabled && hasEnabledUsage,
    provider,
    siteKey: pluginEnabled && configured ? siteKey : null,
    loginEnabled: pluginEnabled && resolved.loginEnabled,
    signupEnabled: pluginEnabled && resolved.signupEnabled,
    reauthEnabled: pluginEnabled && resolved.reauthEnabled,
    failurePolicy,
    widget: {
      actionPrefix: 'authrim',
      theme: 'auto',
      size: 'flexible',
      mode: widgetModeFromConfig(provider, pluginConfig),
    },
  };
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function mergeExternalLoginProviders(
  providerGroups: ExternalLoginProvider[][]
): ExternalLoginProvider[] {
  const providers = new Map<string, ExternalLoginProvider>();
  for (const provider of providerGroups.flat()) {
    if (!providers.has(provider.id)) {
      providers.set(provider.id, provider);
    }
  }
  return Array.from(providers.values()).slice(0, MAX_EXTERNAL_LOGIN_PROVIDERS);
}

async function resolveExternalProviderUsage(
  env: Env,
  tenantId: string
): Promise<Record<string, ExternalLoginProviderUsageConfig>> {
  try {
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
    if (!kvJson) return {};

    const kvSettings = JSON.parse(kvJson) as AuthenticationMethodKVSettings;
    const rawUsage = kvSettings['authentication-methods.external_provider_usage'];
    const usageItems =
      typeof rawUsage === 'string'
        ? safeParseJsonArray<ExternalLoginProviderUsageConfig>(rawUsage)
        : rawUsage;

    if (!Array.isArray(usageItems)) return {};

    const entries = usageItems
      .filter((item) => typeof item.id === 'string' || typeof item.providerId === 'string')
      .flatMap((item) => {
        const values: Array<[string, ExternalLoginProviderUsageConfig]> = [];
        if (item.id) values.push([item.id, item]);
        if (item.providerId) values.push([item.providerId, item]);
        return values;
      });
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function applyExternalProviderUsage(
  providers: ExternalLoginProvider[],
  usageById: Record<string, ExternalLoginProviderUsageConfig>
): ExternalLoginProvider[] {
  return providers
    .map((provider) => {
      const saved =
        usageById[provider.id] ?? (provider.slug ? usageById[provider.slug] : undefined);
      if (!saved) return provider;

      const providerEnabled = provider.enabled !== false;
      const autoLinkEmail = provider.autoLinkEmail !== false;
      const loginEnabled =
        providerEnabled && normalizeBoolean(saved.loginEnabled, provider.loginEnabled);
      const signupEnabled =
        providerEnabled && normalizeBoolean(saved.signupEnabled, provider.signupEnabled);
      const reauthEnabled =
        providerEnabled && normalizeBoolean(saved.reauthEnabled, provider.reauthEnabled);
      const accountLinkEnabled =
        providerEnabled &&
        autoLinkEmail &&
        normalizeBoolean(saved.accountLinkEnabled, provider.accountLinkEnabled);

      return {
        ...provider,
        loginEnabled,
        signupEnabled,
        reauthEnabled,
        accountLinkEnabled,
        enabled: loginEnabled || signupEnabled || reauthEnabled,
      };
    })
    .filter((provider) => provider.enabled);
}

/**
 * Build UI config from resolved Login UI settings
 */
function buildUIConfig(loginUI: LoginUIResolved): UIConfig {
  return {
    theme: loginUI.theme,
    variant: loginUI.variant,
    themeTemplate: loginUI.themeTemplate,
    branding: {
      logoUrl: loginUI.logoUrl,
      faviconUrl: loginUI.faviconUrl,
      brandName: loginUI.brandName,
    },
    pageTemplate: {
      layout: loginUI.pageLayout,
      fontFamily: loginUI.fontFamily,
      fontScale: loginUI.fontScale,
      backgroundColor: loginUI.backgroundColor,
      accentColor: loginUI.accentColor,
      titleColor: loginUI.titleColor,
      textColor: loginUI.textColor,
      copyColor: loginUI.copyColor,
      logoDisplay: loginUI.logoDisplay,
      logoLayout: loginUI.logoLayout,
      headerEnabled: loginUI.headerEnabled,
      subtitleEnabled: loginUI.subtitleEnabled,
      footerEnabled: loginUI.footerEnabled,
      poweredByEnabled: loginUI.poweredByEnabled,
      authSwitchLinkEnabled: loginUI.authSwitchLinkEnabled,
      topbarPosition: loginUI.topbarPosition,
      themeToggleEnabled: loginUI.themeToggleEnabled,
      languageSelectEnabled: loginUI.languageSelectEnabled,
      languageSwitcherPosition: loginUI.languageSwitcherPosition,
      headerStyle: loginUI.headerStyle,
      footerStyle: loginUI.footerStyle,
      splitFrame: loginUI.splitFrame,
      splitPanelSide: loginUI.splitPanelSide,
      splitPanelWidth: loginUI.splitPanelWidth,
      splitBackgroundMode: loginUI.splitBackgroundMode,
      loginPanelBackgroundColor: loginUI.loginPanelBackgroundColor,
      loginPanelBackgroundGradientColor: loginUI.loginPanelBackgroundGradientColor,
      loginPanelBackgroundOpacity: loginUI.loginPanelBackgroundOpacity,
      brandContentMode: loginUI.brandContentMode,
      brandPosition: loginUI.brandPosition,
      brandAlign: loginUI.brandAlign,
      brandPanelTitle: loginUI.brandPanelTitle,
      brandPanelText: loginUI.brandPanelText,
    },
    appearance: {
      backgroundImageUrl: loginUI.backgroundImageUrl,
      loginPanelBackgroundImageUrl: loginUI.loginPanelBackgroundImageUrl,
      thumbnailUrl: loginUI.thumbnailUrl,
      customCss: loginUI.customCss,
      headerText: loginUI.headerText,
      textLocalizations: loginUI.textLocalizations,
      footerText: loginUI.footerText,
      footerLinks: loginUI.footerLinks,
      customBlocks: loginUI.customBlocks,
    },
    supportedLocales: loginUI.supportedLocales,
    defaultLocale: loginUI.supportedLocales.includes(loginUI.defaultLocale)
      ? loginUI.defaultLocale
      : (loginUI.supportedLocales[0] ?? DEFAULT_UI_CONFIG.defaultLocale),
    primaryLocales: resolveEffectivePrimaryLoginUILocales(
      loginUI.supportedLocales.filter((locale): locale is LoginUILocale =>
        LOGIN_UI_LOCALES.includes(locale as LoginUILocale)
      ),
      loginUI.primaryLocales
    ),
    showEnglishLanguageNames: loginUI.showEnglishLanguageNames,
    selfService: {
      accountPageEnabled: SELF_SERVICE_DEFAULTS['self-service.account_page_enabled'],
      accountPagePath: SELF_SERVICE_DEFAULTS['self-service.account_page_path'],
    },
  };
}

async function resolveSelfServiceUIConfig(
  env: Env,
  tenantId: string
): Promise<UIConfig['selfService']> {
  try {
    const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:self-service`);
    if (!raw) {
      return {
        accountPageEnabled: SELF_SERVICE_DEFAULTS['self-service.account_page_enabled'],
        accountPagePath: SELF_SERVICE_DEFAULTS['self-service.account_page_path'],
      };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const configuredPath = parsed['self-service.account_page_path'];
    return {
      accountPageEnabled:
        typeof parsed['self-service.account_page_enabled'] === 'boolean'
          ? parsed['self-service.account_page_enabled']
          : SELF_SERVICE_DEFAULTS['self-service.account_page_enabled'],
      accountPagePath: validateAccountPagePath(configuredPath)
        ? configuredPath
        : SELF_SERVICE_DEFAULTS['self-service.account_page_path'],
    };
  } catch {
    return {
      accountPageEnabled: SELF_SERVICE_DEFAULTS['self-service.account_page_enabled'],
      accountPagePath: SELF_SERVICE_DEFAULTS['self-service.account_page_path'],
    };
  }
}

/**
 * Resolve cache TTL from KV → env → default
 * Priority: KV (SETTINGS) → env (AUTHENTICATION_METHODS_CACHE_TTL) → DEFAULT_CACHE_TTL
 */
async function resolveCacheTTL(env: Env, tenantId: string): Promise<number> {
  // 1. Try KV (settings-v2) — tenant-aware
  try {
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
    if (kvJson) {
      const kvSettings = JSON.parse(kvJson) as AuthenticationMethodKVSettings;
      const kvTTL = kvSettings['authentication-methods.cache_ttl'];
      if (typeof kvTTL === 'number' && kvTTL >= 0 && kvTTL <= 3600) {
        return kvTTL;
      }
    }
  } catch {
    // Invalid JSON — fall through
  }

  // 2. Try environment variable
  const envTTL = env.AUTHENTICATION_METHODS_CACHE_TTL;
  if (envTTL !== undefined && envTTL !== null && envTTL !== '') {
    const parsed = Number(envTTL);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 3600) {
      return Math.floor(parsed);
    }
  }

  // 3. Default
  return DEFAULT_CACHE_TTL;
}

// =============================================================================
// Handler
// =============================================================================

/**
 * GET /api/auth/authentication-methods
 *
 * Public endpoint — returns available authentication methods and UI configuration.
 */
export async function getAuthenticationMethodsHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('LOGIN-METHODS');
  const timing = createAuthenticationMethodsDiagnosticTiming(c.req.raw);

  try {
    const env = c.env as Env;
    const tenantId = getTenantIdFromContext(c);
    const requestedClientId = c.req.query('client_id')?.trim() || null;
    const forwardedHost = getRequestHost(c.req.raw);
    const edgeCacheTTL = resolveAuthenticationMethodsEdgeCacheTTL(env);
    const edgeCache = edgeCacheTTL > 0 ? getDefaultEdgeCache() : null;
    let edgeCacheRequest: Request | null = null;

    if (edgeCache) {
      try {
        const revision = await measureAuthenticationMethodsTiming(timing, 'revision_read', () =>
          readAuthenticationMethodsCacheRevision(env, tenantId)
        );
        edgeCacheRequest = buildAuthenticationMethodsEdgeCacheRequest({
          tenantId,
          forwardedHost,
          clientId: requestedClientId,
          revision,
        });
        const cached = await measureAuthenticationMethodsTiming(timing, 'cache_match', () =>
          edgeCache.match(edgeCacheRequest as Request)
        );
        if (cached) {
          const response = cloneCachedAuthenticationMethodsResponse(tenantId, cached, edgeCacheTTL);
          const spans = finalizeAuthenticationMethodsTiming(timing);
          emitAuthenticationMethodsDiagnosticLog({
            log,
            timing,
            spans,
            tenantId,
            requestedClientId,
            cacheStatus: 'hit',
            edgeCacheEnabled: true,
            edgeCacheTTL,
          });
          return attachAuthenticationMethodsDiagnosticHeaders(response, timing, spans);
        }
      } catch (error) {
        log.warn('Authentication methods edge cache lookup failed', {}, error as Error);
        edgeCacheRequest = null;
      }
    }

    const authenticationMethodSettings = await measureAuthenticationMethodsTiming(
      timing,
      'settings_read',
      () => readAuthenticationMethodKVSettings(env, tenantId)
    );
    const bridgeProvidersPromise = shouldFetchExternalLoginProviders(authenticationMethodSettings)
      ? fetchExternalLoginProviders(env, tenantId, c.req.raw)
      : Promise.resolve([]);

    // Fetch data in parallel
    const [
      settings,
      bridgeProviders,
      samlProviders,
      configuredProviders,
      directoryPassword,
      humanVerification,
      externalProviderUsage,
    ] = await measureAuthenticationMethodsTiming(timing, 'fanout', () =>
      Promise.all([
        getSystemSettings(env),
        bridgeProvidersPromise,
        fetchSAMLLoginProviders(env, tenantId),
        fetchConfiguredExternalLoginProviders(env, tenantId),
        resolveDirectoryPasswordMethod(env, tenantId),
        resolveHumanVerificationMethod(env, tenantId),
        resolveExternalProviderUsage(env, tenantId),
      ])
    );
    const externalProviders = applyExternalProviderUsage(
      mergeExternalLoginProviders([bridgeProviders, samlProviders, configuredProviders]),
      externalProviderUsage
    );

    const builtInMethods = await measureAuthenticationMethodsTiming(
      timing,
      'built_in_methods',
      () => resolveBuiltInAuthenticationMethods(env, tenantId, settings)
    );
    const passkeyLoginEnabled = builtInMethods.passkeyLoginEnabled;
    const passkeySignupEnabled = builtInMethods.passkeySignupEnabled;
    const passkeyReauthEnabled = builtInMethods.passkeyReauthEnabled;
    const passkeyAccountLinkEnabled = builtInMethods.passkeyAccountLinkEnabled;
    const passkeyEnabled =
      passkeyLoginEnabled ||
      passkeySignupEnabled ||
      passkeyReauthEnabled ||
      passkeyAccountLinkEnabled;
    const emailCodeLoginEnabled = builtInMethods.emailCodeLoginEnabled;
    const emailCodeSignupEnabled = builtInMethods.emailCodeSignupEnabled;
    const emailCodeReauthEnabled = builtInMethods.emailCodeReauthEnabled;
    const emailCodeAccountLinkEnabled = builtInMethods.emailCodeAccountLinkEnabled;
    const emailCodeEnabled =
      emailCodeLoginEnabled ||
      emailCodeSignupEnabled ||
      emailCodeReauthEnabled ||
      emailCodeAccountLinkEnabled;
    const totpLoginEnabled = builtInMethods.totpLoginEnabled;
    const totpSignupEnabled = builtInMethods.totpSignupEnabled;
    const totpReauthEnabled = builtInMethods.totpReauthEnabled;
    const totpAccountLinkEnabled = builtInMethods.totpAccountLinkEnabled;
    const totpEnabled =
      totpLoginEnabled || totpSignupEnabled || totpReauthEnabled || totpAccountLinkEnabled;
    const totpProfile = profileForTotpPreset(builtInMethods.totpPreset);
    const directoryPasswordEnabled = directoryPassword.enabled;
    const externalEnabled = externalProviders.length > 0;

    // Check if at least one method is available
    if (
      !passkeyEnabled &&
      !emailCodeEnabled &&
      !totpEnabled &&
      !directoryPasswordEnabled &&
      !externalEnabled
    ) {
      log.warn('No authentication method available', {});
      const errorResponse: AuthenticationMethodsErrorResponse = {
        error: {
          code: 'NO_AUTHENTICATION_METHOD_AVAILABLE',
          message: 'No authentication method is enabled for this tenant',
        },
      };
      c.header('Cache-Control', 'no-store');
      return c.json(errorResponse, 503);
    }

    const methods: AuthenticationMethods = {
      passkey: {
        enabled: passkeyEnabled,
        loginEnabled: passkeyLoginEnabled,
        signupEnabled: passkeySignupEnabled,
        reauthEnabled: passkeyReauthEnabled,
        accountLinkEnabled: passkeyAccountLinkEnabled,
        capabilities: passkeyEnabled ? ['conditional', 'discoverable'] : [],
      },
      emailCode: {
        enabled: emailCodeEnabled,
        loginEnabled: emailCodeLoginEnabled,
        signupEnabled: emailCodeSignupEnabled,
        reauthEnabled: emailCodeReauthEnabled,
        accountLinkEnabled: emailCodeAccountLinkEnabled,
        steps: emailCodeEnabled ? ['email', 'code'] : [],
      },
      totp: {
        enabled: totpEnabled,
        loginEnabled: totpLoginEnabled,
        signupEnabled: totpSignupEnabled,
        reauthEnabled: totpReauthEnabled,
        accountLinkEnabled: totpAccountLinkEnabled,
        preset: builtInMethods.totpPreset,
        algorithm: totpProfile.algorithm,
        digits: totpProfile.digits,
        period: totpProfile.period,
        window: totpProfile.window,
        defaultAcr: builtInMethods.totpDefaultAcr,
        requirement: {
          mode: builtInMethods.totpRequirementMode,
        },
        steps: totpEnabled ? ['identifier', 'code'] : [],
      },
      directoryPassword: {
        enabled: directoryPasswordEnabled,
        label: directoryPassword.label,
        steps: directoryPasswordEnabled ? ['username', 'password'] : [],
      },
      humanVerification,
      external: {
        enabled: externalEnabled,
        providers: externalProviders,
      },
    };

    // Resolve Login UI settings and cache TTL in parallel (tenant-aware)
    const [loginUISettings, selfServiceUI, cacheTTL] = await measureAuthenticationMethodsTiming(
      timing,
      'ui_config',
      () =>
        Promise.all([
          getLoginUISettings(env, tenantId, settings, requestedClientId),
          resolveSelfServiceUIConfig(env, tenantId),
          resolveCacheTTL(env, tenantId),
        ])
    );
    const ui = {
      ...buildUIConfig(loginUISettings),
      selfService: selfServiceUI,
    };

    const response: AuthenticationMethodsResponse = {
      methods,
      ui,
      meta: {
        cacheTTL,
        revision: new Date().toISOString(),
      },
    };

    const httpResponse = buildAuthenticationMethodsJsonResponse(
      tenantId,
      response,
      cacheTTL,
      edgeCacheTTL,
      edgeCacheRequest ? 'miss' : 'bypass'
    );
    if (edgeCache && edgeCacheRequest && edgeCacheTTL > 0) {
      await measureAuthenticationMethodsTiming(timing, 'cache_put', () =>
        putAuthenticationMethodsEdgeCache(
          c,
          edgeCache,
          edgeCacheRequest as Request,
          httpResponse.clone(),
          edgeCacheTTL
        )
      );
    }

    const spans = finalizeAuthenticationMethodsTiming(timing);
    const cacheStatus: AuthenticationMethodsCacheStatus = edgeCacheRequest ? 'miss' : 'bypass';
    emitAuthenticationMethodsDiagnosticLog({
      log,
      timing,
      spans,
      tenantId,
      requestedClientId,
      cacheStatus,
      edgeCacheEnabled: Boolean(edgeCache),
      edgeCacheTTL,
    });
    return attachAuthenticationMethodsDiagnosticHeaders(httpResponse, timing, spans);
  } catch (error) {
    log.error('Failed to get authentication methods', {}, error as Error);
    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to retrieve authentication methods',
      },
      500
    );
  }
}
