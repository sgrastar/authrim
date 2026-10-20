/**
 * Checks a settings save makes before it writes (tenant UI routing, the DCR default target, login
 * UI locales, the post login and App Login settings). Shared by the tenant, app and platform
 * routes and by the bulk apply.
 */
import type { CategoryName, Env, SettingsPatchRequest, DatabaseSource } from '@authrim/ar-lib-core';
import {
  dcrReservedTargetProblem,
  parseTrustedRedirectOrigins,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveClientTrustPolicy,
  tenantIssuerUrls,
  validateAccountPagePath,
  validateLoginUICustomCss,
  validatePostLoginRedirectUrl,
  validateTenantUIBaseUrlAsync,
  validateTrustedRedirectOrigins,
} from '@authrim/ar-lib-core';
import {
  MAX_LOGIN_UI_PRIMARY_LOCALES,
  isLoginUILocale,
} from '@authrim/ar-lib-core/types/login-ui-languages';
import { validateTenantUIPaths } from './patch-validation';
import { readScopedSettingsRecord } from './settings-support';

/**
 * A tenant's UI routing (`tenant.ui_*`): the base URL must be an allowed UI origin (the
 * platform's or the tenant's issuer, localhost or ALLOWED_ORIGINS), and each path must stay on
 * that host. The runtime checks the same, and skips a value that fails. Returns the problem, or
 * null.
 */
export async function validateTenantUIPatch(
  body: SettingsPatchRequest,
  env: Env,
  tenantId: string
): Promise<string | null> {
  const baseUrl = body.set?.['tenant.ui_base_url'];
  if (baseUrl !== undefined) {
    if (typeof baseUrl !== 'string') return 'tenant.ui_base_url must be a string';
    // An empty value would show as the tenant's own while sign-in used the platform's UI.
    if (baseUrl === '') {
      return "tenant.ui_base_url must not be empty; clear it to use the platform's UI";
    }
    const validation = await validateTenantUIBaseUrlAsync(baseUrl, env, tenantId);
    if (!validation.valid) {
      return `tenant.ui_base_url is not an allowed UI origin: ${validation.error ?? 'invalid'}`;
    }
  }
  return validateTenantUIPaths(body);
}

/**
 * The default access token target of new apps must not be an audience the platform keeps for
 * itself: an issuer URL of this tenant (what authorization code apps get) or its /userinfo URL.
 * Every issuer host the tenant's host and identifier policy allows is reserved, whether or not a
 * custom domain or lookup routes it today (see `tenantIssuerUrls`). Registration ignores such a
 * value too, whatever is stored. The primary custom domain is looked up strictly: when that fails
 * the issuers are unknown and `unavailable` is set, so nothing is saved on a guess. Returns the
 * problem, or null.
 */
export async function validateDcrReservedTargets(
  body: SettingsPatchRequest,
  env: Env,
  tenantId: string,
  tenantCoreDb?: DatabaseSource
): Promise<{ problem: string | null; unavailable?: boolean }> {
  const keys = (['dcr.default_audience', 'dcr.default_resource'] as const).filter(
    (key) => typeof body.set?.[key] === 'string' && body.set[key] !== ''
  );
  if (keys.length === 0) return { problem: null };
  let issuerUrls: string[];
  try {
    issuerUrls = await tenantIssuerUrls(env, tenantId, [], { tenantCoreDb });
  } catch {
    return { problem: null, unavailable: true };
  }
  for (const key of keys) {
    const problem = dcrReservedTargetProblem(key, body.set?.[key] as string, issuerUrls);
    if (problem) return { problem };
  }
  return { problem: null };
}

export function validateLoginUIPatch(body: SettingsPatchRequest): {
  ok: boolean;
  message?: string;
  details?: Record<string, unknown>;
} {
  const supportedLocales = body.set?.['login-ui.supported_locales'];
  const defaultLocale = body.set?.['login-ui.default_locale'];
  const primaryLocales = body.set?.['login-ui.primary_locales'];
  const showEnglishLanguageNames = body.set?.['login-ui.show_english_language_names'];
  let parsedSupportedLocales: string[] | undefined;

  if (supportedLocales !== undefined) {
    if (typeof supportedLocales !== 'string') {
      return { ok: false, message: 'login-ui.supported_locales must be a comma-separated string' };
    }
    parsedSupportedLocales = supportedLocales
      .split(',')
      .map((locale) => locale.trim())
      .filter(Boolean);
    if (
      parsedSupportedLocales.length === 0 ||
      new Set(parsedSupportedLocales).size !== parsedSupportedLocales.length ||
      parsedSupportedLocales.some((locale) => !isLoginUILocale(locale))
    ) {
      return {
        ok: false,
        message: 'login-ui.supported_locales must contain one or more unique supported locales',
      };
    }
  }

  if (
    defaultLocale !== undefined &&
    (typeof defaultLocale !== 'string' || !isLoginUILocale(defaultLocale))
  ) {
    return { ok: false, message: 'login-ui.default_locale must be a supported locale' };
  }
  if (
    typeof defaultLocale === 'string' &&
    parsedSupportedLocales &&
    !parsedSupportedLocales.includes(defaultLocale)
  ) {
    return { ok: false, message: 'login-ui.default_locale must be enabled in supported_locales' };
  }

  if (
    primaryLocales !== undefined &&
    primaryLocales !== null &&
    (!Array.isArray(primaryLocales) ||
      primaryLocales.length > MAX_LOGIN_UI_PRIMARY_LOCALES ||
      new Set(primaryLocales).size !== primaryLocales.length ||
      primaryLocales.some((locale) => !isLoginUILocale(locale)))
  ) {
    return {
      ok: false,
      message: `login-ui.primary_locales must be null or an array of up to ${MAX_LOGIN_UI_PRIMARY_LOCALES} unique supported locales`,
    };
  }

  if (showEnglishLanguageNames !== undefined && typeof showEnglishLanguageNames !== 'boolean') {
    return {
      ok: false,
      message: 'login-ui.show_english_language_names must be a boolean',
    };
  }

  const customCss = body.set?.['login-ui.custom_css'];
  if (customCss !== undefined) {
    const validation = validateLoginUICustomCss(customCss);
    if (!validation.valid) {
      return {
        ok: false,
        message: validation.errors.join(' '),
        details: { errors: validation.errors },
      };
    }
    body.set!['login-ui.custom_css'] = validation.sanitizedCss ?? '';
  }

  const accountPages = body.set?.['login-ui.account_pages'];
  if (accountPages !== undefined) {
    if (typeof accountPages !== 'string' || accountPages.length > 2_000_000) {
      return { ok: false, message: 'login-ui.account_pages must be a JSON string under 2 MB' };
    }
    try {
      const document = JSON.parse(accountPages) as Record<string, unknown>;
      if (
        document.schema_version !== 'authrim.account_pages.v1' ||
        !Array.isArray(document.pages)
      ) {
        throw new Error('Invalid account pages schema');
      }
      if (document.pages.length > 24) throw new Error('At most 24 account pages are allowed');
      const pageIds = new Set<string>();
      for (const rawPage of document.pages) {
        if (!rawPage || typeof rawPage !== 'object' || Array.isArray(rawPage))
          throw new Error('Invalid account page');
        const page = rawPage as Record<string, unknown>;
        if (
          typeof page.id !== 'string' ||
          !/^[a-z0-9_-]{1,96}$/u.test(page.id) ||
          pageIds.has(page.id)
        ) {
          throw new Error('Account page IDs must be unique safe identifiers');
        }
        if (typeof page.name !== 'string' || !page.name.trim() || page.name.length > 80) {
          throw new Error('Account page names must contain 1 to 80 characters');
        }
        if (
          page.base_preset_id !== 'authrim-default' ||
          typeof page.base_preset_version !== 'number' ||
          !Number.isInteger(page.base_preset_version) ||
          page.base_preset_version < 1
        ) {
          throw new Error('Invalid account page base preset');
        }
        if (
          typeof page.published_version !== 'number' ||
          !Number.isInteger(page.published_version) ||
          page.published_version < 0 ||
          typeof page.published_at !== 'string'
        ) {
          throw new Error('Invalid account page publication metadata');
        }
        pageIds.add(page.id);
        for (const rawDefinition of [page.draft, page.published, page.rollback].filter(Boolean)) {
          if (!rawDefinition || typeof rawDefinition !== 'object' || Array.isArray(rawDefinition))
            throw new Error('Invalid account page definition');
          const definition = rawDefinition as Record<string, unknown>;
          if (!Array.isArray(definition.screens) || definition.screens.length > 32)
            throw new Error('An account page may contain at most 32 screens');
          const placementIds = new Set<string>();
          const screenKeys = new Set<string>();
          const snapshots = definition.screen_snapshots;
          const stableTargets = new Set(
            definition.screens
              .filter(
                (placement) =>
                  Boolean(placement) &&
                  typeof placement === 'object' &&
                  !Array.isArray(placement) &&
                  (placement as Record<string, unknown>).enabled !== false &&
                  ((placement as Record<string, unknown>).condition === undefined ||
                    (placement as Record<string, unknown>).condition === 'always')
              )
              .map((placement) => String((placement as Record<string, unknown>).id))
          );
          for (const rawPlacement of definition.screens) {
            if (!rawPlacement || typeof rawPlacement !== 'object' || Array.isArray(rawPlacement))
              throw new Error('Invalid screen placement');
            const placement = rawPlacement as Record<string, unknown>;
            if (
              typeof placement.id !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,96}$/u.test(placement.id) ||
              placementIds.has(placement.id)
            )
              throw new Error('Placement IDs must be unique');
            if (
              typeof placement.screen_key !== 'string' ||
              !/^[a-z0-9_-]{1,96}$/u.test(placement.screen_key) ||
              screenKeys.has(placement.screen_key)
            )
              throw new Error('Screen keys must be unique safe identifiers');
            placementIds.add(placement.id);
            screenKeys.add(placement.screen_key);
            if (
              placement.condition !== undefined &&
              ![
                'always',
                'hidden',
                'passkey_enabled',
                'totp_enabled',
                'external_idp_enabled',
                'consent_records_available',
                'multiple_sessions',
              ].includes(String(placement.condition))
            ) {
              throw new Error('Invalid account page visibility condition');
            }
            if (
              placement.show_for_guests !== undefined &&
              typeof placement.show_for_guests !== 'boolean'
            ) {
              throw new Error('Account page show_for_guests must be boolean');
            }
            if (placement.enabled !== false && snapshots !== undefined) {
              if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots))
                throw new Error('Published definitions require screen snapshots');
              const snapshot = (snapshots as Record<string, unknown>)[placement.screen_key];
              if (
                !snapshot ||
                typeof snapshot !== 'object' ||
                Array.isArray(snapshot) ||
                (snapshot as Record<string, unknown>).screen_kind !== 'account'
              )
                throw new Error(`Missing account screen snapshot for ${placement.screen_key}`);
              const fields = (snapshot as Record<string, unknown>).fields;
              if (!Array.isArray(fields)) throw new Error('Invalid account screen fields');
              for (const rawField of fields) {
                if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField)) continue;
                const field = rawField as Record<string, unknown>;
                if (
                  ![
                    'layout_row',
                    'heading',
                    'text',
                    'link',
                    'divider',
                    'account_profile_widget',
                    'account_device_list_widget',
                    'account_session_widget',
                    'account_passkey_widget',
                    'account_totp_widget',
                    'account_consent_widget',
                    'account_activity_widget',
                    'account_social_account_widget',
                    'account_launcher_widget',
                  ].includes(String(field.block_type))
                ) {
                  throw new Error('Account screen snapshots contain an unsupported block type');
                }
                if (field.block_type !== 'link') continue;
                if (typeof field.href !== 'string' || field.href.length > 2048) {
                  throw new Error('Account screen links require a safe URL');
                }
                const href = field.href.trim();
                let safe = /^#[a-zA-Z][\w-]*$/u.test(href) || /^\/(?!\/)/u.test(href);
                if (!safe) {
                  try {
                    safe = new URL(href).protocol === 'https:';
                  } catch {
                    safe = false;
                  }
                }
                if (!safe)
                  throw new Error(
                    'Account screen links only allow anchors, relative paths, or HTTPS'
                  );
                if (href.startsWith('#') && !stableTargets.has(href.slice(1))) {
                  throw new Error(
                    'Account screen anchor links must target an always-visible placement'
                  );
                }
              }
              const widgetCount = fields.filter(
                (field) =>
                  Boolean(field) &&
                  typeof field === 'object' &&
                  typeof (field as Record<string, unknown>).block_type === 'string' &&
                  String((field as Record<string, unknown>).block_type).startsWith('account_')
              ).length;
              if (widgetCount > 1)
                throw new Error('Account screens may contain at most one primary widget');
            }
          }
        }
      }
      if (
        document.default_page_id !== null &&
        (typeof document.default_page_id !== 'string' || !pageIds.has(document.default_page_id))
      )
        throw new Error('The default account page must reference an existing page');
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Invalid account pages JSON',
      };
    }
  }

  return { ok: true };
}

export function parseStringArraySetting(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

export function validateAppLoginScope(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const scope = value.trim();
  return (
    scope.length > 0 &&
    scope.length <= 512 &&
    scope.split(/\s+/).every((part) => /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(part)) &&
    scope.split(/\s+/).includes('openid')
  );
}

export async function getAppLoginClientProfile(
  env: Env,
  tenantId: string,
  clientId: string,
  /** `none`: a check that must leave no trace (a preview): the database routing reports nothing. */
  sideEffects?: 'none'
): Promise<{
  clientId: string;
  redirectUris: string[];
  firstParty: boolean;
  appLoginEnabled: boolean;
} | null> {
  const trimmedClientId = clientId.trim();
  if (!trimmedClientId) {
    return null;
  }

  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'settings-v2-app-login', {
    tenantId,
    ...(sideEffects ? { sideEffects } : {}),
  });
  const client = await adapter.queryOne<{
    client_id: string;
    redirect_uris: string | string[] | null;
  }>('SELECT client_id, redirect_uris FROM oauth_clients WHERE tenant_id = ? AND client_id = ?', [
    tenantId,
    trimmedClientId,
  ]);
  if (!client) {
    return null;
  }

  const [clientSettings, trustPolicy] = await Promise.all([
    readScopedSettingsRecord(env, 'client', {
      type: 'client',
      tenantId,
      id: trimmedClientId,
    }),
    resolveClientTrustPolicy(adapter, tenantId, 'oidc_client', trimmedClientId),
  ]);

  return {
    clientId: client.client_id,
    redirectUris: parseStringArraySetting(client.redirect_uris),
    firstParty: trustPolicy?.first_party === true,
    appLoginEnabled: clientSettings['client.app_login_enabled'] === true,
  };
}

export async function validateAppLoginTarget(
  env: Env,
  tenantId: string,
  input: {
    clientId: unknown;
    redirectUri: unknown;
    scope: unknown;
    finalReturnTo: unknown;
    trustedOrigins: readonly string[];
  },
  sideEffects?: 'none'
): Promise<
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      details?: Record<string, unknown>;
    }
> {
  if (typeof input.clientId !== 'string' || !input.clientId.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'login-entry.app_login_client_id is required when App Login is selected',
    };
  }
  if (typeof input.redirectUri !== 'string' || !input.redirectUri.trim()) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'login-entry.app_login_redirect_uri is required when App Login is selected',
    };
  }
  if (!validateAppLoginScope(input.scope)) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'login-entry.app_login_scope must include openid and contain valid scope tokens',
    };
  }
  if (
    input.finalReturnTo !== undefined &&
    input.finalReturnTo !== '' &&
    !validatePostLoginRedirectUrl(input.finalReturnTo, input.trustedOrigins)
  ) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message:
        'login-entry.app_login_final_return_to must be empty, a non-reserved relative path, or a trusted HTTPS URL',
    };
  }

  const client = await getAppLoginClientProfile(env, tenantId, input.clientId, sideEffects);
  if (!client) {
    return {
      ok: false,
      status: 404,
      error: 'not_found',
      message: `App Login client "${input.clientId.trim()}" was not found in this tenant`,
    };
  }
  if (!client.firstParty || !client.appLoginEnabled) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message:
        'App Login target client must be same-tenant, first-party, and have App Login enabled in Client settings',
      details: { clientId: client.clientId, resolutionLink: `/admin/clients/${client.clientId}` },
    };
  }
  const redirectUri = input.redirectUri.trim();
  if (!client.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'login-entry.app_login_redirect_uri must be registered on the App Login client',
      details: { clientId: client.clientId, resolutionLink: `/admin/clients/${client.clientId}` },
    };
  }

  return { ok: true };
}

export async function validateClientAppLoginPatch(
  env: Env,
  tenantId: string,
  clientId: string,
  body: SettingsPatchRequest
): Promise<
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      details?: Record<string, unknown>;
    }
> {
  const set = body.set ?? {};
  const current = await readScopedSettingsRecord(env, 'client', {
    type: 'client',
    tenantId,
    id: clientId,
  });
  const effectiveAppLoginEnabled =
    set['client.app_login_enabled'] ?? current['client.app_login_enabled'] ?? false;
  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'settings-v2-app-login', {
    tenantId,
  });
  const trustPolicy = await resolveClientTrustPolicy(adapter, tenantId, 'oidc_client', clientId);
  const effectiveFirstParty = trustPolicy?.first_party === true;
  if (effectiveAppLoginEnabled === true && effectiveFirstParty !== true) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message: 'App Login can only be enabled for first-party clients',
      details: { clientId, requiredPolicy: 'client_trust_policy.first_party' },
    };
  }

  const disablesAppLogin =
    set['client.app_login_enabled'] === false ||
    body.disable?.includes('client.app_login_enabled') ||
    body.clear?.includes('client.app_login_enabled');
  if (!disablesAppLogin) {
    return { ok: true };
  }

  const loginEntry = await readScopedSettingsRecord(env, 'login-entry', {
    type: 'tenant',
    id: tenantId,
  });
  if (
    loginEntry['login-entry.post_login_behavior'] === 'app_login' &&
    loginEntry['login-entry.app_login_client_id'] === clientId
  ) {
    return {
      ok: false,
      status: 400,
      error: 'bad_request',
      message:
        'This client is used by Login UI App Login. Change /admin/login-ui#post-login before disabling First Party App or App Login.',
      details: { resolutionLink: '/admin/login-ui#post-login' },
    };
  }

  return { ok: true };
}

export const DEPRECATED_CLIENT_CONSENT_SETTING_KEYS = new Set([
  'client.consent_required',
  'client.first_party',
]);

export function findDeprecatedClientConsentSetting(body: SettingsPatchRequest): string | undefined {
  const keys = [...Object.keys(body.set ?? {}), ...(body.disable ?? []), ...(body.clear ?? [])];
  return keys.find((key) => DEPRECATED_CLIENT_CONSENT_SETTING_KEYS.has(key));
}

export async function validatePostLoginRelatedPatch(
  env: Env,
  tenantId: string,
  category: CategoryName,
  body: SettingsPatchRequest,
  sideEffects?: 'none'
): Promise<
  | { ok: true }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      details?: Record<string, unknown>;
    }
> {
  const set = body.set ?? {};

  if (category === 'security' && 'security.trusted_redirect_origins' in set) {
    if (!validateTrustedRedirectOrigins(set['security.trusted_redirect_origins'])) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        message: 'security.trusted_redirect_origins must contain HTTPS origins only',
      };
    }
  }

  if (category === 'self-service') {
    if (
      'self-service.account_page_path' in set &&
      !validateAccountPagePath(set['self-service.account_page_path'])
    ) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        message:
          'self-service.account_page_path must be a non-reserved relative path prefix such as /account',
      };
    }

    const disablesAccountPage =
      set['self-service.account_page_enabled'] === false ||
      body.disable?.includes('self-service.account_page_enabled') ||
      body.clear?.includes('self-service.account_page_enabled');
    if (disablesAccountPage) {
      const loginEntry = await readScopedSettingsRecord(env, 'login-entry', {
        type: 'tenant',
        id: tenantId,
      });
      if (loginEntry['login-entry.post_login_behavior'] === 'account') {
        return {
          ok: false,
          status: 400,
          error: 'bad_request',
          message:
            'Account Page cannot be disabled while Login UI post-login behavior is account. Change /admin/login-ui#post-login first.',
          details: { resolutionLink: '/admin/login-ui#post-login' },
        };
      }
    }
  }

  if (category === 'login-entry') {
    const loginEntry = await readScopedSettingsRecord(env, 'login-entry', {
      type: 'tenant',
      id: tenantId,
    });
    const effectiveBehavior =
      set['login-entry.post_login_behavior'] ?? loginEntry['login-entry.post_login_behavior'];
    const effectiveRedirectUrl =
      set['login-entry.post_login_redirect_url'] ??
      loginEntry['login-entry.post_login_redirect_url'] ??
      '/';
    const security = await readScopedSettingsRecord(env, 'security', {
      type: 'tenant',
      id: tenantId,
    });
    const trustedOrigins = parseTrustedRedirectOrigins(
      security['security.trusted_redirect_origins']
    );
    if (
      effectiveBehavior === 'custom_url' &&
      !validatePostLoginRedirectUrl(effectiveRedirectUrl, trustedOrigins)
    ) {
      return {
        ok: false,
        status: 400,
        error: 'bad_request',
        message:
          'login-entry.post_login_redirect_url must be a non-reserved relative path or a trusted HTTPS URL',
      };
    }

    if (effectiveBehavior === 'app_login') {
      const validation = await validateAppLoginTarget(
        env,
        tenantId,
        {
          clientId:
            set['login-entry.app_login_client_id'] ??
            loginEntry['login-entry.app_login_client_id'] ??
            '',
          redirectUri:
            set['login-entry.app_login_redirect_uri'] ??
            loginEntry['login-entry.app_login_redirect_uri'] ??
            '',
          finalReturnTo:
            set['login-entry.app_login_final_return_to'] ??
            loginEntry['login-entry.app_login_final_return_to'] ??
            '',
          scope:
            set['login-entry.app_login_scope'] ??
            loginEntry['login-entry.app_login_scope'] ??
            'openid profile email',
          trustedOrigins,
        },
        sideEffects
      );
      if (!validation.ok) {
        return validation;
      }
    }
  }

  return { ok: true };
}
