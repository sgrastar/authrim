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
 *   - SETTINGS KV ("settings:tenant:{tenantId}:login-ui") → UI theme
 *   - EXTERNAL_IDP service binding → enabled external login providers
 *
 * Security:
 *   - No secrets or internal config exposed
 *   - Rate limited to prevent abuse
 *   - Cache-friendly (TTL in response)
 */

import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  getLogger,
  getTenantIdFromContext,
  resolveAuthCorePersistenceAdapterFromEnv,
} from '@authrim/ar-lib-core';

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

interface DirectoryPasswordMethod {
  enabled: boolean;
  label: string;
  steps: string[];
}

type ExternalLoginProviderType = 'oidc' | 'oauth2' | 'saml' | 'vc' | 'custom';
type ExternalLoginStartMode = 'oauth_redirect' | 'saml_sp' | 'direct';

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
  directoryPassword: DirectoryPasswordMethod;
  external: ExternalAuthenticationMethod;
}

interface UIConfig {
  theme: string;
  variant: string;
  branding: {
    logoUrl: string | null;
    faviconUrl: string | null;
    brandName: string;
  };
  appearance: {
    backgroundImageUrl: string | null;
    customCss: string | null;
    headerText: string | null;
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

const DEFAULT_CACHE_TTL = 300; // 5 minutes (seconds)
const MAX_EXTERNAL_LOGIN_PROVIDERS = 20;
const MAX_STRING_LENGTH = 256;
const MAX_URL_LENGTH = 2048;

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
  branding: {
    logoUrl: null,
    faviconUrl: null,
    brandName: 'Authrim',
  },
  appearance: {
    backgroundImageUrl: null,
    customCss: null,
    headerText: null,
    footerText: null,
    footerLinks: [],
    customBlocks: [],
  },
  supportedLocales: ['en', 'ja'],
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
  'login-ui.brand_name'?: string;
  'login-ui.logo_url'?: string;
  'login-ui.favicon_url'?: string;
  'login-ui.supported_locales'?: string;
  'login-ui.background_image_url'?: string;
  'login-ui.custom_css'?: string;
  'login-ui.header_text'?: string;
  'login-ui.footer_text'?: string;
  'login-ui.footer_links'?: string;
  'login-ui.custom_blocks'?: string;
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
  'authentication-methods.external_provider_usage'?: string | ExternalLoginProviderUsageConfig[];
  'authentication-methods.external_providers'?: string | ExternalLoginProviderConfig[];
  'authentication-methods.directory_password.enabled'?: boolean | string;
  'authentication-methods.directory_password.label'?: string;
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
  brandName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  supportedLocales: string[];
  backgroundImageUrl: string | null;
  customCss: string | null;
  headerText: string | null;
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

/**
 * Read Login UI settings from AUTHRIM_CONFIG KV (settings-v2 system)
 * Falls back to system_settings.loginUI for backward compatibility
 */
async function getLoginUISettings(
  env: Env,
  tenantId: string,
  systemSettings: SystemSettings
): Promise<LoginUIResolved> {
  const defaults: LoginUIResolved = {
    theme: DEFAULT_UI_CONFIG.theme,
    variant: DEFAULT_UI_CONFIG.variant,
    brandName: DEFAULT_UI_CONFIG.branding.brandName,
    logoUrl: DEFAULT_UI_CONFIG.branding.logoUrl,
    faviconUrl: DEFAULT_UI_CONFIG.branding.faviconUrl,
    supportedLocales: [...DEFAULT_UI_CONFIG.supportedLocales],
    backgroundImageUrl: DEFAULT_UI_CONFIG.appearance.backgroundImageUrl,
    customCss: DEFAULT_UI_CONFIG.appearance.customCss,
    headerText: DEFAULT_UI_CONFIG.appearance.headerText,
    footerText: DEFAULT_UI_CONFIG.appearance.footerText,
    footerLinks: [...DEFAULT_UI_CONFIG.appearance.footerLinks],
    customBlocks: [...DEFAULT_UI_CONFIG.appearance.customBlocks],
  };

  // Try settings-v2 (SETTINGS KV) first — tenant-aware
  try {
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:login-ui`);
    if (kvJson) {
      const kvSettings = JSON.parse(kvJson) as LoginUIKVSettings;
      return {
        theme: kvSettings['login-ui.theme'] || defaults.theme,
        variant: kvSettings['login-ui.variant'] || defaults.variant,
        brandName: kvSettings['login-ui.brand_name'] || defaults.brandName,
        logoUrl: isValidHttpsUrl(kvSettings['login-ui.logo_url'])
          ? kvSettings['login-ui.logo_url']!
          : defaults.logoUrl,
        faviconUrl: isValidHttpsUrl(kvSettings['login-ui.favicon_url'])
          ? kvSettings['login-ui.favicon_url']!
          : defaults.faviconUrl,
        supportedLocales: kvSettings['login-ui.supported_locales']
          ? kvSettings['login-ui.supported_locales']
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0 && s.length <= 10 && /^[a-z]{2}(-[A-Z]{2})?$/.test(s))
              .slice(0, 20)
          : defaults.supportedLocales,
        backgroundImageUrl: isValidHttpsUrl(kvSettings['login-ui.background_image_url'])
          ? kvSettings['login-ui.background_image_url']!
          : defaults.backgroundImageUrl,
        customCss: kvSettings['login-ui.custom_css'] || defaults.customCss,
        headerText: kvSettings['login-ui.header_text'] || defaults.headerText,
        footerText: kvSettings['login-ui.footer_text'] || defaults.footerText,
        footerLinks: safeParseJsonArray<{ label: string; url: string }>(
          kvSettings['login-ui.footer_links']
        ),
        customBlocks: safeParseJsonArray<{
          position: string;
          type: string;
          content: string;
          url?: string;
          alt?: string;
        }>(kvSettings['login-ui.custom_blocks']),
      };
    }
  } catch {
    // Invalid JSON — fall through to legacy
  }

  // Fallback to legacy system_settings.loginUI
  return {
    theme: systemSettings.loginUI?.theme || defaults.theme,
    variant: systemSettings.loginUI?.variant || defaults.variant,
    brandName: systemSettings.general?.siteName || defaults.brandName,
    logoUrl: isValidHttpsUrl(systemSettings.general?.logoUrl)
      ? systemSettings.general!.logoUrl!
      : defaults.logoUrl,
    faviconUrl: defaults.faviconUrl,
    supportedLocales: systemSettings.loginUI?.supportedLocales || defaults.supportedLocales,
    backgroundImageUrl: defaults.backgroundImageUrl,
    customCss: defaults.customCss,
    headerText: defaults.headerText,
    footerText: defaults.footerText,
    footerLinks: defaults.footerLinks,
    customBlocks: defaults.customBlocks,
  };
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
  if (normalized === 'direct' || normalized === 'url') {
    return 'direct';
  }
  if (type === 'saml') return 'saml_sp';
  if (type === 'oidc' || type === 'oauth2') return 'oauth_redirect';
  return 'direct';
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

/**
 * Fetch enabled external login providers from ar-bridge via service binding.
 */
async function fetchExternalLoginProviders(env: Env): Promise<ExternalLoginProvider[]> {
  if (!env.EXTERNAL_IDP) {
    return [];
  }

  try {
    const response = await env.EXTERNAL_IDP.fetch('https://external-idp/api/external/providers', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
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

interface BuiltInMethodsResolved {
  passkeyLoginEnabled: boolean;
  passkeySignupEnabled: boolean;
  passkeyReauthEnabled: boolean;
  passkeyAccountLinkEnabled: boolean;
  emailCodeLoginEnabled: boolean;
  emailCodeSignupEnabled: boolean;
  emailCodeReauthEnabled: boolean;
  emailCodeAccountLinkEnabled: boolean;
}

async function resolveBuiltInAuthenticationMethods(
  env: Env,
  tenantId: string,
  systemSettings?: SystemSettings
): Promise<BuiltInMethodsResolved> {
  const legacySettings = systemSettings ?? (await getSystemSettings(env));
  const legacyPasskeyDefault = legacySettings.advanced?.passkeyEnabled !== false;
  const legacyEmailCodeDefault = legacySettings.advanced?.magicLinkEnabled !== false;
  const defaults: BuiltInMethodsResolved = {
    passkeyLoginEnabled: legacyPasskeyDefault,
    passkeySignupEnabled: legacyPasskeyDefault,
    passkeyReauthEnabled: legacyPasskeyDefault,
    passkeyAccountLinkEnabled: legacyPasskeyDefault,
    emailCodeLoginEnabled: legacyEmailCodeDefault,
    emailCodeSignupEnabled: legacyEmailCodeDefault,
    emailCodeReauthEnabled: legacyEmailCodeDefault,
    emailCodeAccountLinkEnabled: legacyEmailCodeDefault,
  };

  try {
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
    if (!kvJson) return defaults;

    const kvSettings = JSON.parse(kvJson) as AuthenticationMethodKVSettings;
    const legacyPasskeyEnabled = kvSettings['authentication-methods.passkey.enabled'];
    const legacyEmailOtpEnabled = kvSettings['authentication-methods.email_otp.enabled'];
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
    };
  } catch {
    return defaults;
  }
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
    const kvJson = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
    if (!kvJson) return defaults;

    const kvSettings = JSON.parse(kvJson) as AuthenticationMethodKVSettings;
    return {
      enabled: normalizeBoolean(
        kvSettings['authentication-methods.directory_password.enabled'],
        defaults.enabled
      ),
      label:
        truncateString(kvSettings['authentication-methods.directory_password.label'], 80) ||
        defaults.label,
    };
  } catch {
    return defaults;
  }
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
    branding: {
      logoUrl: loginUI.logoUrl,
      faviconUrl: loginUI.faviconUrl,
      brandName: loginUI.brandName,
    },
    appearance: {
      backgroundImageUrl: loginUI.backgroundImageUrl,
      customCss: loginUI.customCss,
      headerText: loginUI.headerText,
      footerText: loginUI.footerText,
      footerLinks: loginUI.footerLinks,
      customBlocks: loginUI.customBlocks,
    },
    supportedLocales: loginUI.supportedLocales,
  };
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
  const envTTL = (env as unknown as Record<string, unknown>).AUTHENTICATION_METHODS_CACHE_TTL;
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

  try {
    const env = c.env as Env;
    const tenantId = getTenantIdFromContext(c);

    // Fetch data in parallel
    const [
      settings,
      bridgeProviders,
      samlProviders,
      configuredProviders,
      directoryPassword,
      externalProviderUsage,
    ] = await Promise.all([
      getSystemSettings(env),
      fetchExternalLoginProviders(env),
      fetchSAMLLoginProviders(env, tenantId),
      fetchConfiguredExternalLoginProviders(env, tenantId),
      resolveDirectoryPasswordMethod(env, tenantId),
      resolveExternalProviderUsage(env, tenantId),
    ]);
    const externalProviders = applyExternalProviderUsage(
      mergeExternalLoginProviders([bridgeProviders, samlProviders, configuredProviders]),
      externalProviderUsage
    );

    const builtInMethods = await resolveBuiltInAuthenticationMethods(env, tenantId, settings);
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
    const directoryPasswordEnabled = directoryPassword.enabled;
    const externalEnabled = externalProviders.length > 0;

    // Check if at least one method is available
    if (!passkeyEnabled && !emailCodeEnabled && !directoryPasswordEnabled && !externalEnabled) {
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
      directoryPassword: {
        enabled: directoryPasswordEnabled,
        label: directoryPassword.label,
        steps: directoryPasswordEnabled ? ['username', 'password'] : [],
      },
      external: {
        enabled: externalEnabled,
        providers: externalProviders,
      },
    };

    // Resolve Login UI settings and cache TTL in parallel (tenant-aware)
    const [loginUISettings, cacheTTL] = await Promise.all([
      getLoginUISettings(env, tenantId, settings),
      resolveCacheTTL(env, tenantId),
    ]);
    const ui = buildUIConfig(loginUISettings);

    const response: AuthenticationMethodsResponse = {
      methods,
      ui,
      meta: {
        cacheTTL,
        revision: new Date().toISOString(),
      },
    };

    // Set cache headers for CDN/browser caching
    c.header('Cache-Control', `public, max-age=${cacheTTL}`);

    return c.json(response);
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
