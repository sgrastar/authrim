import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, LoginEntrySettings } from '@authrim/ar-lib-core';
import {
  LOGIN_ENTRY_DEFAULTS,
  LOGIN_UI_DEFAULTS,
  TENANT_DISCOVERY_UI_DEFAULTS,
  ensureDatabaseAdapter,
  getDefaultTenantId,
  getUIConfig,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveUserStoreRuntimeSourcesFromEnv,
  resolveTenantCandidatesFromEmailDomain,
  usesNakedDomainIssuer,
  validateTenantRequestBinding,
} from '@authrim/ar-lib-core';
import { getLogger } from '@authrim/ar-lib-core';
import { SignJWT, jwtVerify } from 'jose';
import { getSingleTenantId, isSingleTenantMode } from './single-tenant-guard';
import { getCanonicalTenantBaseUrlAsync } from './request-issuer';

const DISCOVERY_METHODS = [
  'email_domain',
  'tenant_code',
  'tenant_slug',
  'wayf',
  'invitation',
  'app_hint',
];
const DISCOVERY_REQUEST_SCHEMA = z.object({
  mode: z.enum(['email', 'tenant_code', 'tenant_slug', 'wayf', 'invite_token', 'app_hint']),
  value: z.string().min(1).max(2048),
});
const DISCOVERY_GRANT_CREATE_SCHEMA = z.object({
  tenant_id: z.string().min(1).max(255),
  expected_tenant_id: z.string().min(1).max(255).optional(),
  return_to: z.string().url().max(2048).optional(),
  login_hint: z.string().min(1).max(320).optional(),
});
const DISCOVERY_GRANT_VERIFY_SCHEMA = z.object({
  grant: z.string().min(1).max(8192),
  current_url: z.string().url().max(2048),
});
const DISCOVERY_GRANT_ISSUER = 'authrim:discovery-grant';
const DISCOVERY_GRANT_AUDIENCE = 'authrim:tenant-login';
const DISCOVERY_GRANT_TTL_SECONDS = 300;

type DiscoverySource =
  | 'email_domain'
  | 'tenant_code'
  | 'tenant_slug'
  | 'wayf'
  | 'invitation'
  | 'app_hint';

interface TenantLookupRow {
  id: string;
  tenant_code: string;
  name: string;
  lifecycle_state: string;
}

interface InvitationLookupRow {
  id: string;
  token: string;
  tenant_id: string;
  invited_email: string | null;
  max_uses: number;
  use_count: number;
  expires_at: number;
}

interface DiscoveryCandidate {
  tenant_id: string;
  tenant_code: string;
  display_name: string;
  logo_url?: string | null;
  login_url: string;
  source: DiscoverySource;
}

type DiscoveryResponse =
  | { result: 'resolved'; candidate: DiscoveryCandidate; invited_email?: string | null }
  | { result: 'multiple'; candidates: DiscoveryCandidate[] }
  | { result: 'manual_required'; methods: string[]; allow_manual_tenant_entry: boolean }
  | { result: 'not_found'; code: string };

interface DiscoveryConfigResponse {
  config: {
    tenant_id: string;
    mode: LoginEntrySettings['login-entry.mode'];
    discovery_methods: string[];
    email_resolution_policy: LoginEntrySettings['login-entry.email_resolution_policy'];
    selection_policy: LoginEntrySettings['login-entry.selection_policy'];
    allow_manual_tenant_entry: boolean;
    remember_last_tenant: boolean;
    redirect_default_login_to_discovery: boolean;
    require_common_discovery_before_login: boolean;
    skip_discovery_if_only_one_tenant: boolean;
    redirect_tenant_discover_to_common_entry: boolean;
  };
  ui: {
    theme: string;
    variant: string;
    brand_name: string;
    logo_url: string | null;
    page_title: string;
    kicker_text: string;
    title_text: string;
    subtitle_text: string;
  };
  single_tenant_mode: boolean;
  is_common_entry_host: boolean;
  common_discover_url: string | null;
  wayf_candidates?: DiscoveryCandidate[];
  single_active_tenant_candidate?: DiscoveryCandidate;
  default_candidate?: DiscoveryCandidate;
}

interface ClientLookupRow {
  client_id: string;
  tenant_id: string;
}

interface ExactEmailUserRow {
  id: string;
  tenant_id: string;
}

interface ActiveUserTenantRow {
  id: string;
  tenant_id: string;
}

async function getDiscoveryCoreAdapter(env: Env) {
  return resolveAuthCorePersistenceAdapterFromEnv(env, 'discovery-core');
}

type DiscoveryMethod = DiscoveryConfigResponse['config']['discovery_methods'][number];
type DiscoveryUIConfig = DiscoveryConfigResponse['ui'];

const DISCOVERY_UI_THEME_OPTIONS = ['light', 'dark'] as const;
const DISCOVERY_UI_VARIANT_OPTIONS = [
  'beige',
  'blue-gray',
  'green',
  'brown',
  'navy',
  'slate',
] as const;

async function readSettingsRecord(
  kv: KVNamespace | undefined,
  key: string
): Promise<Record<string, unknown> | null> {
  if (!kv) return null;

  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeDiscoveryMethods(raw: string | undefined): DiscoveryMethod[] {
  if (!raw) return ['email_domain', 'tenant_code', 'tenant_slug'];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return ['email_domain', 'tenant_code', 'tenant_slug'];
    }

    return parsed.filter(
      (value): value is DiscoveryMethod =>
        typeof value === 'string' && DISCOVERY_METHODS.includes(value)
    );
  } catch {
    return ['email_domain', 'tenant_code', 'tenant_slug'];
  }
}

async function getDiscoverySettings(
  env: Env,
  scope: { type: 'platform' } | { type: 'tenant'; id: string }
): Promise<DiscoveryConfigResponse['config']> {
  const platformKey = 'settings:platform:login-entry';
  const tenantKey = scope.type === 'tenant' ? `settings:tenant:${scope.id}:login-entry` : null;
  const [platformStored, tenantStored] = await Promise.all([
    readSettingsRecord(env.SETTINGS, platformKey),
    tenantKey ? readSettingsRecord(env.SETTINGS, tenantKey) : Promise.resolve(null),
  ]);
  const tenantOverrideEnabled =
    scope.type === 'tenant' &&
    (isSingleTenantMode(env) ||
      readSettingBoolean(tenantStored, 'login-entry.override_enabled') === true);
  const stored =
    scope.type === 'platform'
      ? platformStored
      : tenantOverrideEnabled
        ? tenantStored
        : platformStored;
  const emailResolutionPolicy =
    (stored?.['login-entry.email_resolution_policy'] as
      | LoginEntrySettings['login-entry.email_resolution_policy']
      | undefined) ?? LOGIN_ENTRY_DEFAULTS['login-entry.email_resolution_policy'];
  const discoveryMethods = normalizeDiscoveryMethods(
    stored?.['login-entry.discovery_methods'] as string | undefined
  ).filter((method) => emailResolutionPolicy !== 'disabled' || method !== 'email_domain');

  return {
    tenant_id: scope.type === 'tenant' ? scope.id : getDefaultTenantId(env),
    mode:
      (stored?.['login-entry.mode'] as LoginEntrySettings['login-entry.mode'] | undefined) ??
      LOGIN_ENTRY_DEFAULTS['login-entry.mode'],
    discovery_methods: discoveryMethods,
    email_resolution_policy: emailResolutionPolicy,
    selection_policy:
      (stored?.['login-entry.selection_policy'] as
        | LoginEntrySettings['login-entry.selection_policy']
        | undefined) ?? LOGIN_ENTRY_DEFAULTS['login-entry.selection_policy'],
    allow_manual_tenant_entry:
      (stored?.['login-entry.allow_manual_tenant_entry'] as boolean | undefined) ??
      LOGIN_ENTRY_DEFAULTS['login-entry.allow_manual_tenant_entry'],
    remember_last_tenant:
      (stored?.['login-entry.remember_last_tenant'] as boolean | undefined) ??
      LOGIN_ENTRY_DEFAULTS['login-entry.remember_last_tenant'],
    redirect_default_login_to_discovery:
      (stored?.['login-entry.redirect_default_login_to_discovery'] as boolean | undefined) ??
      LOGIN_ENTRY_DEFAULTS['login-entry.redirect_default_login_to_discovery'],
    require_common_discovery_before_login:
      (stored?.['login-entry.require_common_discovery_before_login'] as boolean | undefined) ??
      LOGIN_ENTRY_DEFAULTS['login-entry.require_common_discovery_before_login'],
    skip_discovery_if_only_one_tenant:
      (stored?.['login-entry.skip_discovery_if_only_one_tenant'] as boolean | undefined) ??
      LOGIN_ENTRY_DEFAULTS['login-entry.skip_discovery_if_only_one_tenant'],
    redirect_tenant_discover_to_common_entry:
      (stored?.['login-entry.redirect_tenant_discover_to_common_entry'] as boolean | undefined) ??
      LOGIN_ENTRY_DEFAULTS['login-entry.redirect_tenant_discover_to_common_entry'],
  };
}

function getRequestHostHeader(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header('X-Authrim-Original-Host') ||
    c.req.header('X-Forwarded-Host') ||
    c.req.header('Host') ||
    ''
  )
    .split(',')[0]
    .split(':')[0]
    .trim()
    .toLowerCase();
}

function getContextTenantId(c: Context<{ Bindings: Env }>): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const tenantId = ((c as any).get('tenantId') as string | null | undefined)?.trim();
    return tenantId || null;
  } catch {
    return null;
  }
}

function normalizeAbsoluteUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function buildLoginUrlWithGrant(loginUrl: string, grant: string): string {
  const url = new URL(loginUrl);
  url.searchParams.set('discovery_grant', grant);
  return url.toString();
}

async function getCommonDiscoverUrl(env: Env): Promise<string | null> {
  const uiConfig = await getUIConfig(env).catch(() => null);
  if (uiConfig?.baseUrl) {
    return new URL('/discover', uiConfig.baseUrl).toString();
  }

  if (env.BASE_DOMAIN) {
    return `https://${env.BASE_DOMAIN}/discover`;
  }

  return null;
}

function getDiscoveryGrantSecret(env: Env): string | null {
  return env.KEY_MANAGER_SECRET || env.ADMIN_API_SECRET || env.OTP_HMAC_SECRET || null;
}

async function getDiscoveryGrantKey(env: Env): Promise<Uint8Array> {
  const secret = getDiscoveryGrantSecret(env);
  if (!secret) {
    throw new Error('Discovery grant secret is not configured');
  }

  return new TextEncoder().encode(`authrim.discovery_grant.v1:${secret}`);
}

async function issueDiscoveryGrant(env: Env, tenantId: string, targetUrl: string): Promise<string> {
  const key = await getDiscoveryGrantKey(env);

  return await new SignJWT({
    tenant_id: tenantId,
    target_url: targetUrl,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(DISCOVERY_GRANT_ISSUER)
    .setAudience(DISCOVERY_GRANT_AUDIENCE)
    .setSubject(tenantId)
    .setIssuedAt()
    .setExpirationTime(`${DISCOVERY_GRANT_TTL_SECONDS}s`)
    .sign(key);
}

async function resolveGrantTargetLoginUrl(
  env: Env,
  tenantId: string,
  options: {
    returnTo?: string;
    expectedTenantId?: string;
    loginHint?: string;
  }
): Promise<string> {
  const fallback = `${await getCanonicalTenantBaseUrlAsync(env, tenantId)}/login`;
  if (!options.returnTo || !options.expectedTenantId || options.expectedTenantId !== tenantId) {
    return appendLoginHint(fallback, options.loginHint);
  }

  let parsedReturnTo: URL;
  try {
    parsedReturnTo = new URL(options.returnTo);
  } catch {
    return fallback;
  }

  const uiConfig = await getUIConfig(env).catch(() => null);
  const expectedLoginPath = uiConfig?.paths.login || '/login';
  if (parsedReturnTo.pathname !== expectedLoginPath) {
    return appendLoginHint(fallback, options.loginHint);
  }

  const bindingAllowed = await validateTenantRequestBinding(
    new Request(parsedReturnTo.toString()),
    env.AUTHRIM_CONFIG,
    env,
    tenantId
  );

  return appendLoginHint(bindingAllowed ? parsedReturnTo.toString() : fallback, options.loginHint);
}

function appendLoginHint(url: string, loginHint?: string): string {
  if (!loginHint) {
    return url;
  }

  const nextUrl = new URL(url);
  nextUrl.searchParams.set('login_hint', loginHint);
  return nextUrl.toString();
}

async function getSingleActiveTenantCandidate(env: Env): Promise<DiscoveryCandidate | null> {
  const adapter = await getDiscoveryCoreAdapter(env);
  const tenants = await adapter.query<TenantLookupRow>(
    `SELECT id, tenant_code, name, lifecycle_state
     FROM tenants
     WHERE lifecycle_state = 'active'
     ORDER BY id ASC
     LIMIT 2`,
    []
  );

  if (tenants.length !== 1) {
    return null;
  }

  return await buildCandidate(env, tenants[0], 'tenant_slug');
}

async function getActiveTenantWayfCandidates(env: Env): Promise<DiscoveryCandidate[]> {
  const adapter = await getDiscoveryCoreAdapter(env);
  const tenants = await adapter.query<TenantLookupRow>(
    `SELECT id, tenant_code, name, lifecycle_state
     FROM tenants
     WHERE lifecycle_state = 'active'
     ORDER BY name ASC, id ASC`,
    []
  );

  return Promise.all(tenants.map((tenant) => buildCandidate(env, tenant, 'wayf')));
}

function readSettingString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readSettingBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : null;
}

function normalizeThemeValue(value: string | null): string | null {
  return value &&
    DISCOVERY_UI_THEME_OPTIONS.includes(value as (typeof DISCOVERY_UI_THEME_OPTIONS)[number])
    ? value
    : null;
}

function normalizeVariantValue(value: string | null): string | null {
  return value &&
    DISCOVERY_UI_VARIANT_OPTIONS.includes(value as (typeof DISCOVERY_UI_VARIANT_OPTIONS)[number])
    ? value
    : null;
}

async function getDiscoveryUiSettingsRecord(
  env: Env,
  scope: { type: 'platform' } | { type: 'tenant'; id: string }
): Promise<Record<string, unknown> | null> {
  const key =
    scope.type === 'platform'
      ? 'settings:platform:tenant-discovery-ui'
      : `settings:tenant:${scope.id}:tenant-discovery-ui`;
  return readSettingsRecord(env.SETTINGS, key);
}

async function getLoginUiSettingsRecord(
  env: Env,
  tenantId: string
): Promise<Record<string, unknown> | null> {
  return readSettingsRecord(env.SETTINGS, `settings:tenant:${tenantId}:login-ui`);
}

function resolveDiscoveryText(
  tenantSettings: Record<string, unknown> | null,
  platformSettings: Record<string, unknown> | null,
  key:
    | 'tenant-discovery-ui.page_title'
    | 'tenant-discovery-ui.kicker_text'
    | 'tenant-discovery-ui.title_text'
    | 'tenant-discovery-ui.subtitle_text'
): string {
  return readSettingString(tenantSettings, key) ?? readSettingString(platformSettings, key) ?? '';
}

function resolveDiscoveryVisualSetting(
  tenantSettings: Record<string, unknown> | null,
  platformSettings: Record<string, unknown> | null,
  loginUiSettings: Record<string, unknown> | null,
  options: {
    tenantKey: string;
    loginUiKey: keyof typeof LOGIN_UI_DEFAULTS;
    defaultValue: string;
    normalize?: (value: string | null) => string | null;
    allowNull?: boolean;
  }
): string | null {
  const normalize = options.normalize ?? ((value: string | null) => value);
  const tenantValue = normalize(readSettingString(tenantSettings, options.tenantKey));
  if (tenantValue) {
    return tenantValue;
  }

  const platformValue = normalize(readSettingString(platformSettings, options.tenantKey));
  if (platformValue) {
    return platformValue;
  }

  const inheritFromLoginUi =
    readSettingBoolean(tenantSettings, 'tenant-discovery-ui.inherit_from_login_ui') ??
    readSettingBoolean(platformSettings, 'tenant-discovery-ui.inherit_from_login_ui') ??
    TENANT_DISCOVERY_UI_DEFAULTS['tenant-discovery-ui.inherit_from_login_ui'];

  if (inheritFromLoginUi && loginUiSettings) {
    const loginUiValue = normalize(readSettingString(loginUiSettings, options.loginUiKey));
    if (loginUiValue) {
      return loginUiValue;
    }
  }

  if (options.allowNull) {
    return options.defaultValue || null;
  }

  return options.defaultValue;
}

async function getDiscoveryUiConfig(
  env: Env,
  tenantId: string | null,
  isCommonEntryHost: boolean
): Promise<DiscoveryUIConfig> {
  const [platformSettings, tenantSettings, loginUiSettings] = await Promise.all([
    getDiscoveryUiSettingsRecord(env, { type: 'platform' }),
    tenantId && !isCommonEntryHost
      ? getDiscoveryUiSettingsRecord(env, { type: 'tenant', id: tenantId })
      : Promise.resolve(null),
    tenantId && !isCommonEntryHost
      ? getLoginUiSettingsRecord(env, tenantId)
      : Promise.resolve(null),
  ]);
  const effectiveTenantSettings =
    tenantSettings &&
    (isSingleTenantMode(env) ||
      readSettingBoolean(tenantSettings, 'tenant-discovery-ui.override_enabled') === true)
      ? tenantSettings
      : null;

  return {
    theme:
      resolveDiscoveryVisualSetting(effectiveTenantSettings, platformSettings, loginUiSettings, {
        tenantKey: 'tenant-discovery-ui.theme',
        loginUiKey: 'login-ui.theme',
        defaultValue: LOGIN_UI_DEFAULTS['login-ui.theme'],
        normalize: normalizeThemeValue,
      }) ?? LOGIN_UI_DEFAULTS['login-ui.theme'],
    variant:
      resolveDiscoveryVisualSetting(effectiveTenantSettings, platformSettings, loginUiSettings, {
        tenantKey: 'tenant-discovery-ui.variant',
        loginUiKey: 'login-ui.variant',
        defaultValue: LOGIN_UI_DEFAULTS['login-ui.variant'],
        normalize: normalizeVariantValue,
      }) ?? LOGIN_UI_DEFAULTS['login-ui.variant'],
    brand_name:
      resolveDiscoveryVisualSetting(effectiveTenantSettings, platformSettings, loginUiSettings, {
        tenantKey: 'tenant-discovery-ui.brand_name',
        loginUiKey: 'login-ui.brand_name',
        defaultValue: LOGIN_UI_DEFAULTS['login-ui.brand_name'],
      }) ?? LOGIN_UI_DEFAULTS['login-ui.brand_name'],
    logo_url: resolveDiscoveryVisualSetting(
      effectiveTenantSettings,
      platformSettings,
      loginUiSettings,
      {
        tenantKey: 'tenant-discovery-ui.logo_url',
        loginUiKey: 'login-ui.logo_url',
        defaultValue: '',
        allowNull: true,
      }
    ),
    page_title: resolveDiscoveryText(
      effectiveTenantSettings,
      platformSettings,
      'tenant-discovery-ui.page_title'
    ),
    kicker_text: resolveDiscoveryText(
      effectiveTenantSettings,
      platformSettings,
      'tenant-discovery-ui.kicker_text'
    ),
    title_text: resolveDiscoveryText(
      effectiveTenantSettings,
      platformSettings,
      'tenant-discovery-ui.title_text'
    ),
    subtitle_text: resolveDiscoveryText(
      effectiveTenantSettings,
      platformSettings,
      'tenant-discovery-ui.subtitle_text'
    ),
  };
}

async function getTenantRowById(env: Env, tenantId: string): Promise<TenantLookupRow | null> {
  const adapter = await getDiscoveryCoreAdapter(env);
  return adapter.queryOne<TenantLookupRow>(
    "SELECT id, tenant_code, name, lifecycle_state FROM tenants WHERE id = ? AND lifecycle_state = 'active'",
    [tenantId]
  );
}

async function getTenantRowByTenantCode(
  env: Env,
  tenantCode: string
): Promise<TenantLookupRow | null> {
  const adapter = await getDiscoveryCoreAdapter(env);
  return adapter.queryOne<TenantLookupRow>(
    "SELECT id, tenant_code, name, lifecycle_state FROM tenants WHERE tenant_code = ? AND lifecycle_state = 'active'",
    [tenantCode]
  );
}

async function getTenantRowsByExactEmail(env: Env, email: string): Promise<TenantLookupRow[]> {
  const coreAdapter = await getDiscoveryCoreAdapter(env);

  try {
    const activeTenants = await coreAdapter.query<TenantLookupRow>(
      "SELECT id, tenant_code, name, lifecycle_state FROM tenants WHERE lifecycle_state = 'active' ORDER BY id ASC",
      []
    );
    const matchedTenants = await Promise.all(
      activeTenants.map(async (tenant) => {
        const userStoreSources = await resolveUserStoreRuntimeSourcesFromEnv(env, tenant.id);
        if (!userStoreSources.piiDb) {
          return null;
        }

        const piiAdapter = ensureDatabaseAdapter(
          userStoreSources.piiDb,
          `discovery-pii-${tenant.id}`
        );
        const piiUser = await piiAdapter.queryOne<ExactEmailUserRow>(
          'SELECT id, tenant_id FROM users_pii WHERE email = ? AND tenant_id = ?',
          [email, tenant.id]
        );
        if (!piiUser) {
          return null;
        }

        const activeUser = await coreAdapter.queryOne<ActiveUserTenantRow>(
          'SELECT id, tenant_id FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1',
          [piiUser.id, piiUser.tenant_id]
        );

        return activeUser ? tenant : null;
      })
    );

    const resolvedTenants = matchedTenants.filter(
      (tenant): tenant is TenantLookupRow => tenant !== null
    );
    if (resolvedTenants.length === 0) {
      return [];
    }

    const uniqueTenantIds = new Set<string>();
    return resolvedTenants.filter((tenant) => {
      if (uniqueTenantIds.has(tenant.id)) {
        return false;
      }
      uniqueTenantIds.add(tenant.id);
      return true;
    });
  } catch {
    return [];
  }
}

async function getClientRowsByClientId(env: Env, clientId: string): Promise<ClientLookupRow[]> {
  const adapter = await getDiscoveryCoreAdapter(env);
  return adapter.query<ClientLookupRow>(
    'SELECT client_id, tenant_id FROM oauth_clients WHERE client_id = ? ORDER BY tenant_id ASC',
    [clientId]
  );
}

async function getTenantBranding(
  env: Env,
  tenant: TenantLookupRow
): Promise<{ display_name: string; logo_url: string | null }> {
  const loginUiKey = `settings:tenant:${tenant.id}:login-ui`;
  const tenantKey = `settings:tenant:${tenant.id}:tenant`;
  const [loginUiSettings, tenantSettingsFromSettings, tenantSettingsFromLegacy] = await Promise.all(
    [
      readSettingsRecord(env.SETTINGS, loginUiKey),
      readSettingsRecord(env.SETTINGS, tenantKey),
      readSettingsRecord(env.AUTHRIM_CONFIG, tenantKey),
    ]
  );
  const tenantSettings = tenantSettingsFromSettings ?? tenantSettingsFromLegacy ?? {};

  const brandName = loginUiSettings?.['login-ui.brand_name'];
  const loginUiLogoUrl = loginUiSettings?.['login-ui.logo_url'];
  const tenantLogoUri = tenantSettings['tenant.logo_uri'];

  return {
    display_name:
      typeof brandName === 'string' && brandName.trim().length > 0
        ? brandName
        : tenant.name || tenant.id,
    logo_url:
      (typeof loginUiLogoUrl === 'string' && loginUiLogoUrl.trim().length > 0
        ? loginUiLogoUrl
        : null) ||
      (typeof tenantLogoUri === 'string' && tenantLogoUri.trim().length > 0 ? tenantLogoUri : null),
  };
}

async function buildCandidate(
  env: Env,
  tenant: TenantLookupRow,
  source: DiscoverySource
): Promise<DiscoveryCandidate> {
  const branding = await getTenantBranding(env, tenant);

  return {
    tenant_id: tenant.id,
    tenant_code: tenant.tenant_code,
    display_name: branding.display_name,
    logo_url: branding.logo_url,
    login_url: `${await getCanonicalTenantBaseUrlAsync(env, tenant.id)}/login`,
    source,
  };
}

function buildManualRequiredResponse(
  settings: DiscoveryConfigResponse['config']
): Extract<DiscoveryResponse, { result: 'manual_required' }> {
  return {
    result: 'manual_required',
    methods: settings.discovery_methods,
    allow_manual_tenant_entry: settings.allow_manual_tenant_entry,
  };
}

function buildNotFoundResponse(code: string): Extract<DiscoveryResponse, { result: 'not_found' }> {
  return { result: 'not_found', code };
}

async function getSingleTenantCandidate(env: Env): Promise<DiscoveryCandidate | null> {
  const tenantId = getSingleTenantId(env);
  const tenant = await getTenantRowById(env, tenantId);
  if (!tenant) {
    return null;
  }

  return buildCandidate(env, tenant, 'tenant_slug');
}

async function resolveEmailDiscovery(
  env: Env,
  email: string,
  policy: LoginEntrySettings['login-entry.email_resolution_policy']
): Promise<Exclude<DiscoveryResponse, { result: 'not_found' | 'manual_required' }> | null> {
  const exactEmailTenants = await getTenantRowsByExactEmail(env, email);
  if (exactEmailTenants.length > 0) {
    const exactEmailCandidates = await Promise.all(
      exactEmailTenants.map((tenant) => buildCandidate(env, tenant, 'email_domain'))
    );

    if (exactEmailCandidates.length === 1) {
      return { result: 'resolved', candidate: exactEmailCandidates[0] };
    }

    return { result: 'multiple', candidates: exactEmailCandidates };
  }

  if (policy !== 'exact_email_then_domain') {
    return null;
  }

  const candidates = await resolveTenantCandidatesFromEmailDomain(
    await getDiscoveryCoreAdapter(env),
    email,
    env
  );
  if (candidates.length === 0) {
    return null;
  }

  const tenantRows = await Promise.all(
    candidates.map((candidate) => getTenantRowById(env, candidate.tenant_id))
  );
  const resolvedCandidates = await Promise.all(
    tenantRows
      .filter((tenant): tenant is TenantLookupRow => !!tenant)
      .map((tenant) => buildCandidate(env, tenant, 'email_domain'))
  );

  if (resolvedCandidates.length === 1) {
    return { result: 'resolved', candidate: resolvedCandidates[0] };
  }

  return { result: 'multiple', candidates: resolvedCandidates };
}

async function resolveInvitationDiscovery(
  env: Env,
  token: string
): Promise<Extract<DiscoveryResponse, { result: 'resolved' }> | null> {
  const adapter = await getDiscoveryCoreAdapter(env);
  const now = Math.floor(Date.now() / 1000);

  const invitation = await adapter.queryOne<InvitationLookupRow>(
    `SELECT id, token, tenant_id, invited_email, max_uses, use_count, expires_at
     FROM tenant_invitations
     WHERE token = ? AND expires_at > ?`,
    [token, now]
  );

  if (!invitation) {
    return null;
  }

  if (invitation.max_uses !== -1 && invitation.use_count >= invitation.max_uses) {
    return null;
  }

  const tenant = await getTenantRowById(env, invitation.tenant_id);
  if (!tenant) {
    return null;
  }

  return {
    result: 'resolved',
    candidate: await buildCandidate(env, tenant, 'invitation'),
    invited_email: invitation.invited_email,
  };
}

async function resolveDiscoveryRequest(
  env: Env,
  settings: DiscoveryConfigResponse['config'],
  mode: z.infer<typeof DISCOVERY_REQUEST_SCHEMA>['mode'],
  value: string
): Promise<DiscoveryResponse> {
  if (isSingleTenantMode(env) && mode !== 'invite_token') {
    const candidate = await getSingleTenantCandidate(env);
    if (!candidate) {
      return buildNotFoundResponse('tenant_not_found');
    }
    return { result: 'resolved', candidate };
  }

  switch (mode) {
    case 'email': {
      if (
        !settings.discovery_methods.includes('email_domain') ||
        settings.email_resolution_policy === 'disabled'
      ) {
        return buildManualRequiredResponse(settings);
      }

      const resolved = await resolveEmailDiscovery(env, value, settings.email_resolution_policy);
      if (resolved) {
        return resolved;
      }

      if (settings.email_resolution_policy === 'exact_email_only') {
        return buildNotFoundResponse('email_not_found');
      }

      return settings.allow_manual_tenant_entry
        ? buildManualRequiredResponse(settings)
        : buildNotFoundResponse('email_domain_not_found');
    }

    case 'tenant_code': {
      if (!settings.discovery_methods.includes('tenant_code')) {
        return buildManualRequiredResponse(settings);
      }

      const tenant = await getTenantRowByTenantCode(env, value);
      if (!tenant) {
        return buildNotFoundResponse('tenant_code_not_found');
      }

      return {
        result: 'resolved',
        candidate: await buildCandidate(env, tenant, 'tenant_code'),
      };
    }

    case 'tenant_slug': {
      if (!settings.discovery_methods.includes('tenant_slug')) {
        return buildManualRequiredResponse(settings);
      }

      const tenant = await getTenantRowById(env, value);
      if (!tenant) {
        return buildNotFoundResponse('tenant_slug_not_found');
      }

      return {
        result: 'resolved',
        candidate: await buildCandidate(env, tenant, 'tenant_slug'),
      };
    }

    case 'wayf': {
      if (!settings.discovery_methods.includes('wayf')) {
        return buildManualRequiredResponse(settings);
      }

      const tenant = await getTenantRowById(env, value);
      if (!tenant) {
        return buildNotFoundResponse('tenant_slug_not_found');
      }

      return {
        result: 'resolved',
        candidate: await buildCandidate(env, tenant, 'wayf'),
      };
    }

    case 'invite_token': {
      const resolved = await resolveInvitationDiscovery(env, value);
      return resolved ?? buildNotFoundResponse('invitation_not_found');
    }

    case 'app_hint': {
      if (!settings.discovery_methods.includes('app_hint')) {
        return buildNotFoundResponse('app_hint_not_found');
      }

      const clients = await getClientRowsByClientId(env, value);
      if (clients.length === 0) {
        return buildNotFoundResponse('app_hint_not_found');
      }

      const candidates = await Promise.all(
        clients.map(async (client) => {
          const tenant = await getTenantRowById(env, client.tenant_id);
          return tenant ? buildCandidate(env, tenant, 'app_hint') : null;
        })
      );
      const resolvedCandidates = candidates.filter(
        (candidate): candidate is DiscoveryCandidate => candidate !== null
      );

      if (resolvedCandidates.length === 1) {
        return {
          result: 'resolved',
          candidate: resolvedCandidates[0],
        };
      }
      if (resolvedCandidates.length > 1) {
        return { result: 'multiple', candidates: resolvedCandidates };
      }

      return buildNotFoundResponse('app_hint_not_found');
    }
  }
}

function getDiscoverySettingsScope(
  c: Context<{ Bindings: Env }>,
  commonEntryHost: boolean
): { type: 'platform' } | { type: 'tenant'; id: string } {
  if (commonEntryHost) {
    return { type: 'platform' };
  }

  const tenantId = getContextTenantId(c);
  if (!tenantId) {
    throw new Error('Discovery settings require tenant context');
  }

  return { type: 'tenant', id: tenantId };
}

function isCommonEntryHost(c: Context<{ Bindings: Env }>): boolean {
  if (!c.env.BASE_DOMAIN || isSingleTenantMode(c.env)) {
    return false;
  }

  const tenantId = getContextTenantId(c) || getDefaultTenantId(c.env);
  const host = getRequestHostHeader(c);
  if (!host) {
    return false;
  }

  if (host === c.env.BASE_DOMAIN) {
    return !usesNakedDomainIssuer(c.env, tenantId);
  }

  if (host.endsWith(`.${c.env.BASE_DOMAIN}`)) {
    return false;
  }

  // Custom tenant domains should not be treated as common-entry hosts when
  // upstream middleware has already resolved them to a concrete tenant.
  if (tenantId && tenantId !== getDefaultTenantId(c.env)) {
    return false;
  }

  return true;
}

export async function getDiscoveryConfigHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DISCOVERY');

  try {
    const commonEntryHost = isCommonEntryHost(c);
    const settingsScope = getDiscoverySettingsScope(c, commonEntryHost);
    const config = await getDiscoverySettings(c.env, settingsScope);
    const singleTenantMode = isSingleTenantMode(c.env);
    const defaultCandidate = singleTenantMode ? await getSingleTenantCandidate(c.env) : undefined;
    const singleActiveTenantCandidate =
      !singleTenantMode && commonEntryHost && config.skip_discovery_if_only_one_tenant
        ? await getSingleActiveTenantCandidate(c.env)
        : undefined;
    const wayfCandidates =
      !singleTenantMode && config.discovery_methods.includes('wayf')
        ? await getActiveTenantWayfCandidates(c.env)
        : undefined;
    const commonDiscoverUrl = await getCommonDiscoverUrl(c.env);
    const tenantId = settingsScope.type === 'tenant' ? settingsScope.id : getDefaultTenantId(c.env);
    const ui = await getDiscoveryUiConfig(
      c.env,
      commonEntryHost ? null : tenantId,
      commonEntryHost
    );

    return c.json({
      config,
      ui,
      single_tenant_mode: singleTenantMode,
      is_common_entry_host: commonEntryHost,
      common_discover_url: commonDiscoverUrl,
      wayf_candidates: wayfCandidates,
      single_active_tenant_candidate: singleActiveTenantCandidate ?? undefined,
      default_candidate: defaultCandidate ?? undefined,
    } satisfies DiscoveryConfigResponse);
  } catch (error) {
    log.error('Failed to load discovery config', { error: String(error) });
    return c.json({ error: 'server_error', message: 'Failed to load discovery config' }, 500);
  }
}

export async function postDiscoveryHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DISCOVERY');

  try {
    const body = await c.req.json<unknown>();
    const parsed = DISCOVERY_REQUEST_SCHEMA.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_request',
          message: parsed.error.issues.map((issue) => issue.message).join(', '),
        },
        400
      );
    }

    const commonEntryHost = isCommonEntryHost(c);
    const settingsScope = getDiscoverySettingsScope(c, commonEntryHost);
    const settings = await getDiscoverySettings(c.env, settingsScope);
    const result = await resolveDiscoveryRequest(
      c.env,
      settings,
      parsed.data.mode,
      parsed.data.value
    );

    return c.json(result satisfies DiscoveryResponse);
  } catch (error) {
    log.error('Failed to resolve discovery request', { error: String(error) });
    return c.json({ error: 'server_error', message: 'Failed to resolve discovery request' }, 500);
  }
}

export async function postDiscoveryGrantHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DISCOVERY');

  try {
    const body = await c.req.json<unknown>();
    const parsed = DISCOVERY_GRANT_CREATE_SCHEMA.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_request',
          message: parsed.error.issues.map((issue) => issue.message).join(', '),
        },
        400
      );
    }

    const tenant = await getTenantRowById(c.env, parsed.data.tenant_id);
    if (!tenant) {
      return c.json({ error: 'not_found', message: 'Tenant not found' }, 404);
    }

    const targetUrl = await resolveGrantTargetLoginUrl(c.env, tenant.id, {
      returnTo: parsed.data.return_to,
      expectedTenantId: parsed.data.expected_tenant_id,
      loginHint: parsed.data.login_hint,
    });
    const grant = await issueDiscoveryGrant(c.env, tenant.id, targetUrl);

    return c.json({
      grant,
      login_url: buildLoginUrlWithGrant(targetUrl, grant),
    });
  } catch (error) {
    log.error('Failed to issue discovery grant', { error: String(error) });
    return c.json({ error: 'server_error', message: 'Failed to issue discovery grant' }, 500);
  }
}

export async function postDiscoveryGrantVerifyHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DISCOVERY');

  try {
    const body = await c.req.json<unknown>();
    const parsed = DISCOVERY_GRANT_VERIFY_SCHEMA.safeParse(body);

    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_request',
          message: parsed.error.issues.map((issue) => issue.message).join(', '),
        },
        400
      );
    }

    const key = await getDiscoveryGrantKey(c.env);
    const { payload } = await jwtVerify(parsed.data.grant, key, {
      issuer: DISCOVERY_GRANT_ISSUER,
      audience: DISCOVERY_GRANT_AUDIENCE,
    });

    const tenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id : null;
    const targetUrl = typeof payload.target_url === 'string' ? payload.target_url : null;
    const normalizedCurrentUrl = normalizeAbsoluteUrl(parsed.data.current_url);
    const normalizedTargetUrl = targetUrl ? normalizeAbsoluteUrl(targetUrl) : null;
    const currentHost = new URL(parsed.data.current_url).host.toLowerCase();
    const requestHost = getRequestHostHeader(c);

    if (!tenantId || !normalizedCurrentUrl || !normalizedTargetUrl) {
      return c.json({ error: 'invalid_grant', message: 'Invalid discovery grant' }, 400);
    }

    if (requestHost && currentHost !== requestHost) {
      return c.json({ error: 'invalid_grant', message: 'Invalid discovery grant' }, 400);
    }

    if (normalizedCurrentUrl !== normalizedTargetUrl) {
      return c.json({ error: 'invalid_grant', message: 'Invalid discovery grant' }, 400);
    }

    const currentTenantId = getContextTenantId(c);
    if (!currentTenantId || currentTenantId !== tenantId) {
      return c.json({ error: 'invalid_grant', message: 'Invalid discovery grant' }, 400);
    }

    return c.json({
      valid: true,
      tenant_id: tenantId,
      target_url: normalizedTargetUrl,
    });
  } catch (error) {
    log.warn('Failed to verify discovery grant', { error: String(error) });
    return c.json({ error: 'invalid_grant', message: 'Invalid discovery grant' }, 400);
  }
}
