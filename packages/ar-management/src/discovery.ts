import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, LoginEntrySettings } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  LOGIN_ENTRY_DEFAULTS,
  LOGIN_UI_DEFAULTS,
  TENANT_DISCOVERY_UI_DEFAULTS,
  getDefaultTenantId,
  getTenantIdFromContext,
  resolveTenantCandidatesFromEmailDomain,
  usesNakedDomainIssuer,
} from '@authrim/ar-lib-core';
import { getLogger } from '@authrim/ar-lib-core';
import { getSingleTenantId, isSingleTenantMode } from './single-tenant-guard';
import { getCanonicalTenantBaseUrl } from './request-issuer';

const DISCOVERY_METHODS = ['email_domain', 'tenant_code', 'tenant_slug', 'invitation', 'app_hint'];
const DISCOVERY_REQUEST_SCHEMA = z.object({
  mode: z.enum(['email', 'tenant_code', 'tenant_slug', 'invite_token', 'app_hint']),
  value: z.string().min(1).max(2048),
});

type DiscoverySource = 'email_domain' | 'tenant_code' | 'tenant_slug' | 'invitation' | 'app_hint';

interface TenantLookupRow {
  id: string;
  tenant_code: string;
  name: string;
  is_active: number;
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
  tenantId: string
): Promise<DiscoveryConfigResponse['config']> {
  const kvKey = `settings:tenant:${tenantId}:login-entry`;
  const stored = await readSettingsRecord(env.SETTINGS, kvKey);
  const emailResolutionPolicy =
    (stored?.['login-entry.email_resolution_policy'] as
      | LoginEntrySettings['login-entry.email_resolution_policy']
      | undefined) ?? LOGIN_ENTRY_DEFAULTS['login-entry.email_resolution_policy'];
  const discoveryMethods = normalizeDiscoveryMethods(
    stored?.['login-entry.discovery_methods'] as string | undefined
  ).filter((method) => emailResolutionPolicy !== 'disabled' || method !== 'email_domain');

  return {
    tenant_id: tenantId,
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
  };
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
  return value && DISCOVERY_UI_THEME_OPTIONS.includes(value as (typeof DISCOVERY_UI_THEME_OPTIONS)[number])
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
    tenantId && !isCommonEntryHost ? getLoginUiSettingsRecord(env, tenantId) : Promise.resolve(null),
  ]);

  return {
    theme:
      resolveDiscoveryVisualSetting(tenantSettings, platformSettings, loginUiSettings, {
        tenantKey: 'tenant-discovery-ui.theme',
        loginUiKey: 'login-ui.theme',
        defaultValue: LOGIN_UI_DEFAULTS['login-ui.theme'],
        normalize: normalizeThemeValue,
      }) ?? LOGIN_UI_DEFAULTS['login-ui.theme'],
    variant:
      resolveDiscoveryVisualSetting(tenantSettings, platformSettings, loginUiSettings, {
        tenantKey: 'tenant-discovery-ui.variant',
        loginUiKey: 'login-ui.variant',
        defaultValue: LOGIN_UI_DEFAULTS['login-ui.variant'],
        normalize: normalizeVariantValue,
      }) ?? LOGIN_UI_DEFAULTS['login-ui.variant'],
    brand_name:
      resolveDiscoveryVisualSetting(tenantSettings, platformSettings, loginUiSettings, {
        tenantKey: 'tenant-discovery-ui.brand_name',
        loginUiKey: 'login-ui.brand_name',
        defaultValue: LOGIN_UI_DEFAULTS['login-ui.brand_name'],
      }) ?? LOGIN_UI_DEFAULTS['login-ui.brand_name'],
    logo_url: resolveDiscoveryVisualSetting(tenantSettings, platformSettings, loginUiSettings, {
      tenantKey: 'tenant-discovery-ui.logo_url',
      loginUiKey: 'login-ui.logo_url',
      defaultValue: '',
      allowNull: true,
    }),
    page_title: resolveDiscoveryText(
      tenantSettings,
      platformSettings,
      'tenant-discovery-ui.page_title'
    ),
    kicker_text: resolveDiscoveryText(
      tenantSettings,
      platformSettings,
      'tenant-discovery-ui.kicker_text'
    ),
    title_text: resolveDiscoveryText(
      tenantSettings,
      platformSettings,
      'tenant-discovery-ui.title_text'
    ),
    subtitle_text: resolveDiscoveryText(
      tenantSettings,
      platformSettings,
      'tenant-discovery-ui.subtitle_text'
    ),
  };
}

async function getTenantRowById(env: Env, tenantId: string): Promise<TenantLookupRow | null> {
  const adapter = new D1Adapter({ db: env.DB });
  return adapter.queryOne<TenantLookupRow>(
    'SELECT id, tenant_code, name, is_active FROM tenants WHERE id = ? AND is_active = 1',
    [tenantId]
  );
}

async function getTenantRowByTenantCode(
  env: Env,
  tenantCode: string
): Promise<TenantLookupRow | null> {
  const adapter = new D1Adapter({ db: env.DB });
  return adapter.queryOne<TenantLookupRow>(
    'SELECT id, tenant_code, name, is_active FROM tenants WHERE tenant_code = ? AND is_active = 1',
    [tenantCode]
  );
}

async function getTenantRowsByExactEmail(
  env: Env,
  email: string
): Promise<TenantLookupRow[]> {
  if (!env.DB_PII) {
    return [];
  }

  const piiAdapter = new D1Adapter({ db: env.DB_PII });
  const coreAdapter = new D1Adapter({ db: env.DB });

  try {
    const piiUsers = await piiAdapter.query<ExactEmailUserRow>(
      'SELECT id, tenant_id FROM users_pii WHERE email = ?',
      [email]
    );
    if (piiUsers.length === 0) {
      return [];
    }

    const activeUsers = await Promise.all(
      piiUsers.map((user) =>
        coreAdapter.queryOne<ActiveUserTenantRow>(
          'SELECT id, tenant_id FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1',
          [user.id, user.tenant_id]
        )
      )
    );

    const activeTenantIds = [...new Set(activeUsers.flatMap((user) => (user ? [user.tenant_id] : [])))];
    if (activeTenantIds.length === 0) {
      return [];
    }

    const tenants = await Promise.all(activeTenantIds.map((tenantId) => getTenantRowById(env, tenantId)));
    return tenants.filter((tenant): tenant is TenantLookupRow => tenant !== null);
  } catch {
    return [];
  }
}

async function getClientRowByClientId(env: Env, clientId: string): Promise<ClientLookupRow | null> {
  const adapter = new D1Adapter({ db: env.DB });
  return adapter.queryOne<ClientLookupRow>(
    'SELECT client_id, tenant_id FROM oauth_clients WHERE client_id = ?',
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
    login_url: `${getCanonicalTenantBaseUrl(env, tenant.id)}/login`,
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

  const candidates = await resolveTenantCandidatesFromEmailDomain(env.DB, email, env);
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
  const adapter = new D1Adapter({ db: env.DB });
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

    case 'invite_token': {
      const resolved = await resolveInvitationDiscovery(env, value);
      return resolved ?? buildNotFoundResponse('invitation_not_found');
    }

    case 'app_hint': {
      if (!settings.discovery_methods.includes('app_hint')) {
        return buildNotFoundResponse('app_hint_not_found');
      }

      const client = await getClientRowByClientId(env, value);
      if (!client) {
        return buildNotFoundResponse('app_hint_not_found');
      }

      const tenant = await getTenantRowById(env, client.tenant_id);
      if (tenant) {
        return {
          result: 'resolved',
          candidate: await buildCandidate(env, tenant, 'app_hint'),
        };
      }

      return buildNotFoundResponse('app_hint_not_found');
    }
  }
}

function getDiscoverySettingsTenantId(c: Context<{ Bindings: Env }>): string {
  return getTenantIdFromContext(c) || getDefaultTenantId(c.env);
}

function isCommonEntryHost(c: Context<{ Bindings: Env }>): boolean {
  if (!c.env.BASE_DOMAIN || isSingleTenantMode(c.env)) {
    return false;
  }

  const tenantId = getTenantIdFromContext(c) || getDefaultTenantId(c.env);
  const host = (c.req.header('X-Forwarded-Host') || c.req.header('Host') || '')
    .split(':')[0]
    .toLowerCase();
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
    const tenantId = getDiscoverySettingsTenantId(c);
    const config = await getDiscoverySettings(c.env, tenantId);
    const singleTenantMode = isSingleTenantMode(c.env);
    const defaultCandidate = singleTenantMode ? await getSingleTenantCandidate(c.env) : undefined;
    const commonEntryHost = isCommonEntryHost(c);
    const ui = await getDiscoveryUiConfig(c.env, commonEntryHost ? null : tenantId, commonEntryHost);

    return c.json({
      config,
      ui,
      single_tenant_mode: singleTenantMode,
      is_common_entry_host: commonEntryHost,
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

    const tenantId = getDiscoverySettingsTenantId(c);
    const settings = await getDiscoverySettings(c.env, tenantId);
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
