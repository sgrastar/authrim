import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, LoginEntrySettings } from '@authrim/ar-lib-core';
import {
  LOGIN_ENTRY_DEFAULTS,
  LOGIN_UI_DEFAULTS,
  TENANT_DISCOVERY_UI_DEFAULTS,
  TENANT_D1_STORAGE_PROFILE_ID,
  createLookupAliasIndex,
  ensureDatabaseAdapter,
  getCachedAuthCorePersistenceContextFromEnv,
  getDefaultTenantId,
  getUIConfig,
  loadVerifiedLookupBucketAssignmentProvider,
  LookupRouteResolver,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveTenantDatabaseSourceFromRegistry,
  usesNakedDomainIssuer,
  validateTenantRequestBinding,
  type LookupAliasKind,
} from '@authrim/ar-lib-core';
import { getLogger } from '@authrim/ar-lib-core';
import { SignJWT, jwtVerify } from 'jose';
import { getSingleTenantId, isSingleTenantMode } from './single-tenant-guard';
import { getCanonicalTenantBaseUrlAsync } from './request-issuer';
import { DiscoveryEmailOtpService, type DiscoveryEmailOtpTimingName } from './discovery-email-otp';

const DISCOVERY_METHODS = [
  'email_exact',
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
const DISCOVERY_EMAIL_START_SCHEMA = z.object({ email: z.string().min(3).max(320) });
const DISCOVERY_EMAIL_VERIFY_SCHEMA = z.object({
  challenge_id: z.string().min(1).max(128),
  code: z.string().regex(/^\d{6}$/u),
});
const DISCOVERY_GRANT_ISSUER = 'authrim:discovery-grant';
const DISCOVERY_GRANT_AUDIENCE = 'authrim:tenant-login';
const DISCOVERY_GRANT_TTL_SECONDS = 300;
const TENANT_CANDIDATE_PRESENTATION_CACHE_TTL_MS = 1_000;
const MAX_TENANT_CANDIDATE_PRESENTATION_CACHE_ENTRIES = 1_000;
const DIAGNOSTIC_SESSION_ID_HEADER = 'X-Diagnostic-Session-Id';
const PHASE0C_DIAGNOSTIC_SESSION = /^phase0c-[0-9]{14}-[a-f0-9]{6}$/u;
const MAX_DIAGNOSTIC_SESSION_ID_LENGTH = 128;

type DiscoveryDiagnosticTimingName =
  | 'discovery_settings'
  | DiscoveryEmailOtpTimingName
  | 'tenant_registry'
  | 'tenant_primary_recheck'
  | 'candidate_build'
  | 'handler_total';

interface DiscoveryDiagnosticSpan {
  name: DiscoveryDiagnosticTimingName;
  durationMs: number;
}

interface DiscoveryDiagnosticTiming {
  enabled: boolean;
  sessionId: string | null;
  startedAt: number;
  spans: DiscoveryDiagnosticSpan[];
}

function diagnosticFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function sanitizeDiagnosticSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^A-Za-z0-9._:-]/gu, '_').slice(0, MAX_DIAGNOSTIC_SESSION_ID_LENGTH);
}

function roundDiagnosticDuration(durationMs: number): number {
  return Math.round(Math.max(0, durationMs) * 100) / 100;
}

function createDiscoveryDiagnosticTiming(c: Context<{ Bindings: Env }>): DiscoveryDiagnosticTiming {
  const sessionId = sanitizeDiagnosticSessionId(c.req.header(DIAGNOSTIC_SESSION_ID_HEADER));
  const explicitlyEnabled = diagnosticFlagEnabled(c.env.AUTHRIM_DIAGNOSTIC_TIMING_ENABLED);
  const phase0cTestProbe =
    c.env.AUTHRIM_ENVIRONMENT_NAME === 'test' &&
    sessionId !== null &&
    PHASE0C_DIAGNOSTIC_SESSION.test(sessionId);
  const enabled = sessionId !== null && (explicitlyEnabled || phase0cTestProbe);
  return {
    enabled,
    sessionId: enabled ? sessionId : null,
    startedAt: enabled ? performance.now() : 0,
    spans: [],
  };
}

function recordDiscoveryDiagnosticTiming(
  timing: DiscoveryDiagnosticTiming,
  name: DiscoveryDiagnosticTimingName,
  durationMs: number
): void {
  if (!timing.enabled) return;
  timing.spans.push({ name, durationMs: roundDiagnosticDuration(durationMs) });
}

async function measureDiscoveryDiagnosticTiming<T>(
  timing: DiscoveryDiagnosticTiming,
  name: DiscoveryDiagnosticTimingName,
  operation: () => Promise<T>
): Promise<T> {
  if (!timing.enabled) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    recordDiscoveryDiagnosticTiming(timing, name, performance.now() - startedAt);
  }
}

function attachDiscoveryDiagnosticTiming(
  response: Response,
  timing: DiscoveryDiagnosticTiming
): Response {
  if (!timing.enabled || !timing.sessionId) return response;
  recordDiscoveryDiagnosticTiming(timing, 'handler_total', performance.now() - timing.startedAt);
  const headers = new Headers(response.headers);
  const value = timing.spans
    .map((span) => `${span.name};dur=${span.durationMs.toFixed(2)}`)
    .join(', ');
  const existing = headers.get('Server-Timing');
  headers.set('Server-Timing', existing ? `${existing}, ${value}` : value);
  headers.set('X-Authrim-Diagnostic-Session-Id', timing.sessionId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type DiscoverySource =
  | 'email_exact'
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

async function getDiscoveryCoreAdapter(env: Env) {
  return resolveAuthCorePersistenceAdapterFromEnv(env, 'discovery-core');
}

async function usesTenantD1Storage(env: Env): Promise<boolean> {
  return (
    (await getCachedAuthCorePersistenceContextFromEnv(env)).storageProfileId ===
    TENANT_D1_STORAGE_PROFILE_ID
  );
}

async function resolveTenantDefaultStore(env: Env, tenantId: string) {
  return resolveTenantDatabaseSourceFromRegistry(env, {
    tenantId,
    role: 'tenant_core',
    shardGroup: 'default',
    shardIndex: 0,
    runtimeSnapshotMode: 'required',
  });
}

async function queryActiveTenantFromStore(
  tenantId: string,
  source: Awaited<ReturnType<typeof resolveTenantDefaultStore>>['source']
): Promise<TenantLookupRow | null> {
  return ensureDatabaseAdapter(source, 'tenant-discovery-default').queryOne<TenantLookupRow>(
    "SELECT id, tenant_code, name, lifecycle_state FROM tenants WHERE id = ? AND lifecycle_state = 'active'",
    [tenantId]
  );
}

async function resolveTenantAliasFromLookup(
  env: Env,
  aliasKind: LookupAliasKind,
  value: string
): Promise<TenantLookupRow | null> {
  if (
    !env.AUTHRIM_ENVIRONMENT_NAME ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
  ) {
    throw new Error('tenant_alias_lookup_unavailable');
  }
  const index = await createLookupAliasIndex(aliasKind, value);
  const assignments = await loadVerifiedLookupBucketAssignmentProvider({
    store: env.TENANT_RUNTIME_REGISTRY,
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
    publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
  });
  const alias = await new LookupRouteResolver(
    env as unknown as Record<string, unknown>,
    assignments
  ).resolveAlias({ index });
  if (!alias) return null;

  const store = await resolveTenantDefaultStore(env, alias.tenantId);
  const target = alias.routeProjection.target;
  if (
    target.bindingRef !== store.bindingRef ||
    alias.routeProjection.tenantRouteGeneration !== store.runtimeGeneration
  ) {
    throw new Error('tenant_alias_route_revalidation_failed');
  }
  const tenant = await queryActiveTenantFromStore(alias.tenantId, store.source);
  const normalizedValue = value.trim().toLowerCase();
  const destinationAlias = aliasKind === 'tenant_code' ? tenant?.tenant_code : tenant?.id;
  if (
    !tenant ||
    tenant.id !== alias.tenantId ||
    destinationAlias?.trim().toLowerCase() !== normalizedValue
  ) {
    throw new Error('tenant_alias_destination_revalidation_failed');
  }
  return tenant;
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
  if (!raw) return ['email_exact', 'tenant_code', 'tenant_slug'];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return ['email_exact', 'tenant_code', 'tenant_slug'];
    }

    return parsed.filter(
      (value): value is DiscoveryMethod =>
        typeof value === 'string' && DISCOVERY_METHODS.includes(value)
    );
  } catch {
    return ['email_exact', 'tenant_code', 'tenant_slug'];
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
  ).filter((method) => emailResolutionPolicy !== 'disabled' || method !== 'email_exact');

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

function getConfiguredUrlHostname(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function getConfiguredCommonEntryHostname(env: Env): Promise<string | null> {
  const uiConfig = await getUIConfig(env).catch(() => null);
  return getConfiguredUrlHostname(uiConfig?.baseUrl);
}

function getPrimaryTenantIssuerHostname(env: Env): string | null {
  const baseDomain = env.BASE_DOMAIN?.toLowerCase();
  if (!baseDomain) {
    return null;
  }

  if (env.NAKED_DOMAIN_AS_ISSUER === 'true') {
    return baseDomain;
  }

  const tenantId = env.PRIMARY_TENANT_ID || env.DEFAULT_TENANT_ID || getDefaultTenantId(env);
  return `${tenantId.toLowerCase()}.${baseDomain}`;
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

async function getDiscoveryGrantKey(env: Env): Promise<Uint8Array> {
  const secret = env.OTP_HMAC_SECRET;
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
  const fallback = await resolveTenantLoginUrl(env, tenantId);
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

async function resolveTenantLoginUrl(env: Env, tenantId: string): Promise<string> {
  const canonicalLoginUrl = `${await getCanonicalTenantBaseUrlAsync(env, tenantId)}/login`;
  if (!isSingleTenantMode(env) || env.LOGIN_UI_EXECUTION_HOST_MODE !== 'dedicated') {
    return canonicalLoginUrl;
  }

  const uiConfig = await getUIConfig(env).catch(() => null);
  const uiBaseUrl = uiConfig?.baseUrl || env.UI_URL;
  if (!uiBaseUrl) {
    return canonicalLoginUrl;
  }

  try {
    return new URL('/login', uiBaseUrl).toString();
  } catch {
    return canonicalLoginUrl;
  }
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
  if (await usesTenantD1Storage(env)) {
    const store = await resolveTenantDefaultStore(env, tenantId);
    const tenant = await queryActiveTenantFromStore(tenantId, store.source);
    if (tenant && tenant.id !== tenantId) {
      throw new Error('tenant_route_destination_revalidation_failed');
    }
    return tenant;
  }
  const adapter = await getDiscoveryCoreAdapter(env);
  return adapter.queryOne<TenantLookupRow>(
    "SELECT id, tenant_code, name, lifecycle_state FROM tenants WHERE id = ? AND lifecycle_state = 'active'",
    [tenantId]
  );
}

async function getTenantRowsByIdWithDiagnosticTiming(
  env: Env,
  tenantIds: string[],
  timing: DiscoveryDiagnosticTiming
): Promise<Array<TenantLookupRow | null>> {
  const stores = await measureDiscoveryDiagnosticTiming(timing, 'tenant_registry', async () => {
    if (!(await usesTenantD1Storage(env))) return null;
    return Promise.all(
      tenantIds.map(async (tenantId) => ({
        tenantId,
        store: await resolveTenantDefaultStore(env, tenantId),
      }))
    );
  });
  if (stores) {
    return measureDiscoveryDiagnosticTiming(timing, 'tenant_primary_recheck', () =>
      Promise.all(
        stores.map(async ({ tenantId, store }) => {
          const tenant = await queryActiveTenantFromStore(tenantId, store.source);
          if (tenant && tenant.id !== tenantId) {
            throw new Error('tenant_route_destination_revalidation_failed');
          }
          return tenant;
        })
      )
    );
  }
  return measureDiscoveryDiagnosticTiming(timing, 'tenant_primary_recheck', () =>
    Promise.all(tenantIds.map((tenantId) => getTenantRowById(env, tenantId)))
  );
}

async function getTenantRowByTenantCode(
  env: Env,
  tenantCode: string
): Promise<TenantLookupRow | null> {
  if (await usesTenantD1Storage(env)) {
    return resolveTenantAliasFromLookup(env, 'tenant_code', tenantCode);
  }
  const adapter = await getDiscoveryCoreAdapter(env);
  return adapter.queryOne<TenantLookupRow>(
    "SELECT id, tenant_code, name, lifecycle_state FROM tenants WHERE tenant_code = ? AND lifecycle_state = 'active'",
    [tenantCode]
  );
}

async function getClientRowsByClientId(env: Env, clientId: string): Promise<ClientLookupRow[]> {
  const adapter = await getDiscoveryCoreAdapter(env);
  return adapter.query<ClientLookupRow>(
    'SELECT client_id, tenant_id FROM oauth_clients WHERE client_id = ? ORDER BY tenant_id ASC',
    [clientId]
  );
}

interface TenantCandidatePresentation {
  brandName: string | null;
  logoUrl: string | null;
  loginUrl: string;
}

interface TenantCandidatePresentationCacheEntry {
  value: TenantCandidatePresentation;
  expiresAt: number;
}

const tenantCandidatePresentationCache = new Map<string, TenantCandidatePresentationCacheEntry>();
let tenantCandidatePresentationScopeIds = new WeakMap<object, number>();
let nextTenantCandidatePresentationScopeId = 1;

export function clearTenantCandidatePresentationCacheForTest(): void {
  tenantCandidatePresentationCache.clear();
  tenantCandidatePresentationScopeIds = new WeakMap();
  nextTenantCandidatePresentationScopeId = 1;
}

function cloneTenantCandidatePresentation(
  value: TenantCandidatePresentation
): TenantCandidatePresentation {
  return { ...value };
}

function cacheTenantCandidatePresentation(
  cacheKey: string,
  value: TenantCandidatePresentation,
  now: number
): void {
  for (const [key, entry] of tenantCandidatePresentationCache) {
    if (entry.expiresAt <= now) tenantCandidatePresentationCache.delete(key);
  }
  while (tenantCandidatePresentationCache.size >= MAX_TENANT_CANDIDATE_PRESENTATION_CACHE_ENTRIES) {
    const oldest = tenantCandidatePresentationCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    tenantCandidatePresentationCache.delete(oldest);
  }
  tenantCandidatePresentationCache.set(cacheKey, {
    value: cloneTenantCandidatePresentation(value),
    expiresAt: now + TENANT_CANDIDATE_PRESENTATION_CACHE_TTL_MS,
  });
}

function tenantCandidatePresentationCacheKey(env: Env, tenantId: string): string {
  const scopeId = (value: unknown): string => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return '';
    const scope = value as object;
    let id = tenantCandidatePresentationScopeIds.get(scope);
    if (!id) {
      id = nextTenantCandidatePresentationScopeId;
      nextTenantCandidatePresentationScopeId += 1;
      tenantCandidatePresentationScopeIds.set(scope, id);
    }
    return String(id);
  };
  return [
    env.AUTHRIM_ENVIRONMENT_NAME ?? '',
    env.BASE_DOMAIN ?? '',
    env.ISSUER_URL ?? '',
    env.UI_URL ?? '',
    env.LOGIN_UI_EXECUTION_HOST_MODE ?? '',
    env.DEFAULT_TENANT_ID ?? '',
    env.NAKED_DOMAIN_AS_ISSUER ?? '',
    scopeId(env.SETTINGS),
    scopeId(env.AUTHRIM_CONFIG),
    scopeId(env.DB),
    tenantId,
  ].join('\0');
}

async function getTenantCandidatePresentation(
  env: Env,
  tenantId: string
): Promise<TenantCandidatePresentation> {
  const now = Date.now();
  const cacheKey = tenantCandidatePresentationCacheKey(env, tenantId);
  const cached = tenantCandidatePresentationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    tenantCandidatePresentationCache.delete(cacheKey);
    tenantCandidatePresentationCache.set(cacheKey, cached);
    return cloneTenantCandidatePresentation(cached.value);
  }
  if (cached) tenantCandidatePresentationCache.delete(cacheKey);

  const loginUiKey = `settings:tenant:${tenantId}:login-ui`;
  const tenantKey = `settings:tenant:${tenantId}:tenant`;
  const [loginUiSettings, tenantSettingsFromSettings, tenantSettingsFromLegacy, loginUrl] =
    await Promise.all([
      readSettingsRecord(env.SETTINGS, loginUiKey),
      readSettingsRecord(env.SETTINGS, tenantKey),
      readSettingsRecord(env.AUTHRIM_CONFIG, tenantKey),
      resolveTenantLoginUrl(env, tenantId),
    ]);
  const tenantSettings = tenantSettingsFromSettings ?? tenantSettingsFromLegacy ?? {};

  const brandName = loginUiSettings?.['login-ui.brand_name'];
  const loginUiLogoUrl = loginUiSettings?.['login-ui.logo_url'];
  const tenantLogoUri = tenantSettings['tenant.logo_uri'];

  const presentation = {
    brandName: typeof brandName === 'string' && brandName.trim().length > 0 ? brandName : null,
    logoUrl:
      (typeof loginUiLogoUrl === 'string' && loginUiLogoUrl.trim().length > 0
        ? loginUiLogoUrl
        : null) ||
      (typeof tenantLogoUri === 'string' && tenantLogoUri.trim().length > 0 ? tenantLogoUri : null),
    loginUrl,
  };
  cacheTenantCandidatePresentation(cacheKey, presentation, now);
  return presentation;
}

function buildCandidateFromPresentation(
  tenant: TenantLookupRow,
  source: DiscoverySource,
  presentation: TenantCandidatePresentation
): DiscoveryCandidate {
  return {
    tenant_id: tenant.id,
    tenant_code: tenant.tenant_code,
    display_name: (presentation.brandName ?? tenant.name) || tenant.id,
    logo_url: presentation.logoUrl,
    login_url: presentation.loginUrl,
    source,
  };
}

async function buildCandidate(
  env: Env,
  tenant: TenantLookupRow,
  source: DiscoverySource
): Promise<DiscoveryCandidate> {
  return buildCandidateFromPresentation(
    tenant,
    source,
    await getTenantCandidatePresentation(env, tenant.id)
  );
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
      // Exact-email discovery is only available through the OTP start/verify endpoints.
      // The legacy generic endpoint must never query membership data from a raw email.
      return buildManualRequiredResponse(settings);
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

async function isCommonEntryHost(c: Context<{ Bindings: Env }>): Promise<boolean> {
  if (!c.env.BASE_DOMAIN || isSingleTenantMode(c.env)) {
    return false;
  }

  const tenantId = getContextTenantId(c) || getDefaultTenantId(c.env);
  const host = getRequestHostHeader(c);
  if (!host) {
    return false;
  }

  const configuredCommonEntryHost = await getConfiguredCommonEntryHostname(c.env);
  if (
    configuredCommonEntryHost &&
    host === configuredCommonEntryHost &&
    host !== getPrimaryTenantIssuerHostname(c.env)
  ) {
    return true;
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
    const commonEntryHost = await isCommonEntryHost(c);
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

    const commonEntryHost = await isCommonEntryHost(c);
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

function discoveryClientIp(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function discoveryEmailUnavailable(c: Context<{ Bindings: Env }>) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error: 'temporarily_unavailable' }, 503);
}

async function requireEmailExactDiscovery(c: Context<{ Bindings: Env }>): Promise<boolean> {
  const commonEntryHost = await isCommonEntryHost(c);
  const settings = await getDiscoverySettings(c.env, getDiscoverySettingsScope(c, commonEntryHost));
  return (
    settings.email_resolution_policy === 'exact_email_only' &&
    settings.discovery_methods.includes('email_exact') &&
    settings.selection_policy !== 'manual_only'
  );
}

export async function postDiscoveryEmailStartHandler(c: Context<{ Bindings: Env }>) {
  c.header('Cache-Control', 'no-store');
  try {
    if (!(await requireEmailExactDiscovery(c))) {
      return c.json({ error: 'discovery_disabled' }, 403);
    }
    const parsed = DISCOVERY_EMAIL_START_SCHEMA.safeParse(await c.req.json<unknown>());
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const result = await new DiscoveryEmailOtpService(c.env).start({
      email: parsed.data.email,
      clientIp: discoveryClientIp(c),
    });
    return c.json(
      { challenge_id: result.challengeId, expires_in: result.expiresIn, status: 'code_sent' },
      202
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'discovery_rate_limited') return c.json({ error: 'rate_limited' }, 429);
    if (code === 'lookup_email_invalid') return c.json({ error: 'invalid_request' }, 400);
    return discoveryEmailUnavailable(c);
  }
}

export async function postDiscoveryEmailVerifyHandler(c: Context<{ Bindings: Env }>) {
  c.header('Cache-Control', 'no-store');
  const timing = createDiscoveryDiagnosticTiming(c);
  const respond = (response: Response) => attachDiscoveryDiagnosticTiming(response, timing);
  try {
    if (
      !(await measureDiscoveryDiagnosticTiming(timing, 'discovery_settings', () =>
        requireEmailExactDiscovery(c)
      ))
    ) {
      return respond(c.json({ error: 'discovery_disabled' }, 403));
    }
    const parsed = DISCOVERY_EMAIL_VERIFY_SCHEMA.safeParse(await c.req.json<unknown>());
    if (!parsed.success) return respond(c.json({ error: 'invalid_request' }, 400));
    const memberships = await new DiscoveryEmailOtpService(
      c.env,
      timing.enabled
        ? {
            recordTiming: (name, durationMs) =>
              recordDiscoveryDiagnosticTiming(timing, name, durationMs),
          }
        : undefined
    ).verify({ challengeId: parsed.data.challenge_id, code: parsed.data.code });
    const tenantIds = [...new Set(memberships.map((membership) => membership.tenantId))];
    const [rows, presentations] = await Promise.all([
      getTenantRowsByIdWithDiagnosticTiming(c.env, tenantIds, timing),
      measureDiscoveryDiagnosticTiming(timing, 'candidate_build', () =>
        Promise.all(tenantIds.map((tenantId) => getTenantCandidatePresentation(c.env, tenantId)))
      ),
    ]);
    const candidates = rows.flatMap((row, index) =>
      row ? [buildCandidateFromPresentation(row, 'email_exact', presentations[index])] : []
    );
    if (candidates.length === 0) {
      return respond(c.json(buildNotFoundResponse('email_not_found')));
    }
    if (candidates.length === 1) {
      return respond(
        c.json({ result: 'resolved', candidate: candidates[0] } satisfies DiscoveryResponse)
      );
    }
    return respond(c.json({ result: 'multiple', candidates } satisfies DiscoveryResponse));
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'discovery_challenge_invalid') {
      return respond(c.json({ error: 'invalid_or_expired_code' }, 400));
    }
    return respond(discoveryEmailUnavailable(c));
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
