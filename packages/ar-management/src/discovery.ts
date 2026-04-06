import type { Context } from 'hono';
import { z } from 'zod';
import type { Env, LoginEntrySettings } from '@authrim/ar-lib-core';
import {
  D1Adapter,
  LOGIN_ENTRY_DEFAULTS,
  buildIssuerUrl,
  getDefaultTenantId,
  getTenantIdFromContext,
  resolveTenantCandidatesFromEmailDomain,
} from '@authrim/ar-lib-core';
import { getLogger } from '@authrim/ar-lib-core';
import { getSingleTenantId, isSingleTenantMode } from './single-tenant-guard';

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
    selection_policy: LoginEntrySettings['login-entry.selection_policy'];
    allow_manual_tenant_entry: boolean;
    remember_last_tenant: boolean;
    redirect_default_login_to_discovery: boolean;
  };
  single_tenant_mode: boolean;
  is_common_entry_host: boolean;
  default_candidate?: DiscoveryCandidate;
}

interface ClientLookupRow {
  client_id: string;
  tenant_id: string;
}

type DiscoveryMethod = DiscoveryConfigResponse['config']['discovery_methods'][number];

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

  return {
    tenant_id: tenantId,
    mode:
      (stored?.['login-entry.mode'] as LoginEntrySettings['login-entry.mode'] | undefined) ??
      LOGIN_ENTRY_DEFAULTS['login-entry.mode'],
    discovery_methods: normalizeDiscoveryMethods(
      stored?.['login-entry.discovery_methods'] as string | undefined
    ),
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
    login_url: `${buildIssuerUrl(env, tenant.id)}/login`,
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
  email: string
): Promise<Exclude<DiscoveryResponse, { result: 'not_found' | 'manual_required' }> | null> {
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
      if (!settings.discovery_methods.includes('email_domain')) {
        return buildManualRequiredResponse(settings);
      }

      const resolved = await resolveEmailDiscovery(env, value);
      if (resolved) {
        return resolved;
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

  const host = (c.req.header('X-Forwarded-Host') || c.req.header('Host') || '')
    .split(':')[0]
    .toLowerCase();
  if (!host) {
    return false;
  }

  if (host === c.env.BASE_DOMAIN) {
    return true;
  }

  return !host.endsWith(`.${c.env.BASE_DOMAIN}`);
}

export async function getDiscoveryConfigHandler(c: Context<{ Bindings: Env }>) {
  const log = getLogger(c).module('DISCOVERY');

  try {
    const tenantId = getDiscoverySettingsTenantId(c);
    const config = await getDiscoverySettings(c.env, tenantId);
    const singleTenantMode = isSingleTenantMode(c.env);
    const defaultCandidate = singleTenantMode ? await getSingleTenantCandidate(c.env) : undefined;

    return c.json({
      config,
      single_tenant_mode: singleTenantMode,
      is_common_entry_host: isCommonEntryHost(c),
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
