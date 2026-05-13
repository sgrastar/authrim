import { Hono } from 'hono';
import { expect } from 'vitest';
import type { Env, LoginEntrySettings } from '@authrim/ar-lib-core';
import { generateEmailDomainHash } from '@authrim/ar-lib-core/utils/email-domain-hash';
import {
  getDiscoveryConfigHandler,
  postDiscoveryGrantHandler,
  postDiscoveryGrantVerifyHandler,
  postDiscoveryHandler,
} from '../../../packages/ar-management/src/discovery';
import {
  tenantSystemExactEmailUsers,
  tenantSystemOidcClients,
  tenantSystemTenants,
  tenantSystemVanityDomains,
} from '../../fixtures/tenant-system/tenants';
import { createMockEnv } from '../fixtures';
import { loadMatrixCsv as loadTenantMatrixCsv } from '../../fixtures/tenant-system/matrix-loader';

export { loadTenantMatrixCsv as loadMatrixCsv };

export type TenantSystemTopology =
  | 'D1_single'
  | 'D2_mt_no_custom'
  | 'D3_custom_subdomain'
  | 'D4_custom_naked'
  | 'D5_custom_vanity'
  | 'D6_naked_vanity';

export interface SettingsMatrixRow {
  case_id: string;
  topology: TenantSystemTopology;
  entry_mode: LoginEntrySettings['login-entry.mode'];
  email_resolution: LoginEntrySettings['login-entry.email_resolution_policy'];
  selection_policy: LoginEntrySettings['login-entry.selection_policy'];
  discovery_methods: string;
  allow_manual: string;
  remember_last: string;
  redirect_common_login: string;
  require_common_before_tenant_login: string;
  skip_if_one_tenant: string;
  expect: string;
}

export interface DiscoveryConfigBody {
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
  single_tenant_mode: boolean;
  is_common_entry_host: boolean;
}

type TenantDatasetVariant = 'default' | 'single-active' | 'with-inactive';

interface TenantRow {
  id: string;
  tenant_code: string;
  name: string;
  is_active: 0 | 1;
}

interface UserRow {
  id: string;
  email: string;
  tenant_id: string;
  is_active: 0 | 1;
}

interface ClientRow {
  client_id: string;
  tenant_id: string;
  redirect_uris: string[];
}

interface InvitationRow {
  id: string;
  token: string;
  tenant_id: string;
  invited_email: string | null;
  max_uses: number;
  use_count: number;
  expires_at: number;
}

interface DomainMappingRow {
  domain: string;
  domain_hash: string;
  tenant_id: string;
  verified: 0 | 1;
  is_active: 0 | 1;
  tenant_active: 0 | 1;
  priority: number;
}

interface VanityDomainRow {
  id: string;
  tenant_id: string;
  hostname: string;
  is_active: 0 | 1;
  is_primary: 0 | 1;
  status: string;
  cloudflare_zone_id: string | null;
  cloudflare_custom_hostname_id: string | null;
  ssl_status: string | null;
  ownership_status: string | null;
  validation_method: string | null;
  validation_records_json: string | null;
  last_sync_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

class TenantSystemD1Database {
  constructor(
    private readonly data: {
      tenants: TenantRow[];
      users: UserRow[];
      clients: ClientRow[];
      invitations: InvitationRow[];
      domainMappings: DomainMappingRow[];
      vanityDomains: VanityDomainRow[];
    },
    private readonly databaseKind: 'core' | 'pii' = 'core'
  ) {}

  prepare(sql: string): D1PreparedStatement {
    let boundParams: unknown[] = [];
    const query = sql.replace(/\s+/g, ' ').trim();

    const statement = {
      bind: (...params: unknown[]) => {
        boundParams = params;
        return statement;
      },
      first: async <T>() => (await this.first<T>(query, boundParams)) ?? null,
      all: async <T>() => ({ results: await this.all<T>(query, boundParams) }),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    };

    return statement as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return Promise.all(statements.map((statement) => statement.run<T>()));
  }

  private async first<T>(query: string, params: unknown[]): Promise<T | null> {
    const rows = await this.all<T>(query, params);
    return rows[0] ?? null;
  }

  private async all<T>(query: string, params: unknown[]): Promise<T[]> {
    if (this.databaseKind === 'pii' && query.includes('FROM users_pii WHERE email = ?')) {
      const email = String(params[0] ?? '');
      return this.data.users
        .filter((user) => user.email === email)
        .map(({ id, tenant_id }) => ({ id, tenant_id })) as T[];
    }

    if (query.includes('FROM users_core WHERE id = ? AND tenant_id = ? AND is_active = 1')) {
      const [id, tenantId] = params;
      return this.data.users
        .filter((user) => user.id === id && user.tenant_id === tenantId && user.is_active === 1)
        .map(({ id: userId, tenant_id }) => ({ id: userId, tenant_id })) as T[];
    }

    if (query.includes('FROM tenants WHERE tenant_code = ? AND is_active = 1')) {
      const tenantCode = String(params[0] ?? '');
      return this.data.tenants.filter(
        (tenant) => tenant.tenant_code === tenantCode && tenant.is_active === 1
      ) as T[];
    }

    if (query.includes('FROM tenants WHERE id = ? AND is_active = 1')) {
      const tenantId = String(params[0] ?? '');
      return this.data.tenants.filter(
        (tenant) => tenant.id === tenantId && tenant.is_active === 1
      ) as T[];
    }

    if (query.includes('FROM tenants') && query.includes('WHERE is_active = 1')) {
      const limit = Number(params[0] ?? 2);
      return this.data.tenants
        .filter((tenant) => tenant.is_active === 1)
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, Number.isFinite(limit) && limit > 0 ? limit : 2) as T[];
    }

    if (query.includes('FROM oauth_clients WHERE client_id = ?')) {
      const clientId = String(params[0] ?? '');
      return this.data.clients
        .filter((client) => client.client_id === clientId)
        .map((client) => ({
          client_id: client.client_id,
          client_secret_hash: null,
          client_name: client.client_id,
          redirect_uris: JSON.stringify(client.redirect_uris),
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
          scope: 'openid profile email',
          token_endpoint_auth_method: 'none',
          contacts: null,
          logo_uri: null,
          client_uri: null,
          policy_uri: null,
          tos_uri: null,
          jwks_uri: null,
          jwks: null,
          subject_type: null,
          sector_identifier_uri: null,
          id_token_signed_response_alg: null,
          userinfo_signed_response_alg: null,
          request_object_signing_alg: null,
          is_trusted: 0,
          skip_consent: 0,
          allow_claims_without_scope: 0,
          token_exchange_allowed: 0,
          allowed_subject_token_clients: null,
          allowed_token_exchange_resources: null,
          delegation_mode: null,
          client_credentials_allowed: 0,
          allowed_scopes: null,
          default_scope: null,
          default_audience: null,
          initiate_login_uri: null,
          registration_access_token_hash: null,
          post_logout_redirect_uris: null,
          backchannel_logout_uri: null,
          backchannel_logout_session_required: null,
          frontchannel_logout_uri: null,
          frontchannel_logout_session_required: null,
          software_id: null,
          software_version: null,
          requestable_scopes: null,
          allowed_redirect_origins: null,
          require_pkce: 0,
          tenant_id: client.tenant_id,
          created_at: 0,
          updated_at: 0,
        })) as T[];
    }

    if (query.includes('FROM tenant_invitations')) {
      const token = String(params[0] ?? '');
      const now = Number(params[1] ?? 0);
      return this.data.invitations.filter(
        (invitation) => invitation.token === token && invitation.expires_at > now
      ) as T[];
    }

    if (query.includes('FROM tenant_domain_mappings')) {
      const domainHash = String(params[0] ?? '');
      return this.data.domainMappings
        .filter(
          (mapping) =>
            mapping.domain_hash === domainHash &&
            mapping.verified === 1 &&
            mapping.is_active === 1 &&
            mapping.tenant_active === 1 &&
            this.data.tenants.some(
              (tenant) => tenant.id === mapping.tenant_id && tenant.is_active === 1
            )
        )
        .sort((a, b) => b.priority - a.priority || a.tenant_id.localeCompare(b.tenant_id))
        .map(({ tenant_id, priority }) => ({ tenant_id, priority })) as T[];
    }

    if (
      query.includes('FROM tenant_vanity_domains') &&
      query.includes('tenant_vanity_domains.hostname = ?')
    ) {
      const hostname = String(params[0] ?? '');
      return this.data.vanityDomains
        .filter((domain) => {
          const tenant = this.data.tenants.find((row) => row.id === domain.tenant_id);
          return (
            domain.hostname === hostname &&
            domain.is_active === 1 &&
            domain.status === 'active' &&
            tenant?.is_active === 1
          );
        })
        .map((domain) => ({ ...domain, tenant_code: domain.tenant_id })) as T[];
    }

    if (
      query.includes('FROM tenant_vanity_domains') &&
      query.includes('tenant_id = ?') &&
      query.includes('is_primary = 1')
    ) {
      const tenantId = String(params[0] ?? '');
      return this.data.vanityDomains.filter(
        (domain) =>
          domain.tenant_id === tenantId &&
          domain.is_active === 1 &&
          domain.is_primary === 1 &&
          domain.status === 'active'
      ) as T[];
    }

    return [];
  }
}

export function makeCommonHost(topology: string): string {
  if (topology === 'D1_single' || topology === 'D2_mt_no_custom') {
    return 'authrim.localhost';
  }

  return 'tenant-system.authrim.test';
}

export function makeTenantHost(topology: string, tenantId: string): string {
  if (topology === 'D1_single') {
    return makeCommonHost(topology);
  }

  if (topology === 'D4_custom_naked' && tenantId === 'first') {
    return makeCommonHost(topology);
  }

  return `${tenantId}.${makeCommonHost(topology)}`;
}

export function makeVanityHost(tenantId: 'first' | 'second' = 'first'): string {
  return tenantId === 'first' ? 'login.first.example.test' : 'login.second.example.test';
}

export async function buildEnvForTopology(
  topology: TenantSystemTopology,
  overrides: Partial<Env> = {}
): Promise<Env> {
  const commonHost = makeCommonHost(topology);
  const env = await createMockEnv();

  env.ISSUER_URL = `https://${commonHost}`;
  env.DEFAULT_TENANT_ID = 'first';
  env.PRIMARY_TENANT_ID = 'first';
  env.EMAIL_DOMAIN_HASH_SECRET = 'tenant-system-domain-hash-secret';

  if (topology !== 'D1_single' && topology !== 'D2_mt_no_custom') {
    env.BASE_DOMAIN = commonHost;
  }

  if (topology === 'D4_custom_naked' || topology === 'D6_naked_vanity') {
    env.NAKED_DOMAIN_AS_ISSUER = 'true';
  }

  Object.assign(env, overrides);
  return env;
}

export function loginEntrySettingsFromRow(row: SettingsMatrixRow): LoginEntrySettings {
  return {
    'login-entry.mode': row.entry_mode,
    'login-entry.email_resolution_policy': row.email_resolution,
    'login-entry.selection_policy': row.selection_policy,
    'login-entry.discovery_methods': JSON.stringify(row.discovery_methods.split('+')),
    'login-entry.allow_manual_tenant_entry': row.allow_manual === 'true',
    'login-entry.remember_last_tenant': row.remember_last === 'true',
    'login-entry.redirect_default_login_to_discovery': row.redirect_common_login === 'true',
    'login-entry.require_common_discovery_before_login':
      row.require_common_before_tenant_login === 'true',
    'login-entry.skip_discovery_if_only_one_tenant': row.skip_if_one_tenant === 'true',
    'login-entry.redirect_tenant_discover_to_common_entry': true,
  };
}

export async function applyLoginEntryProfile(
  env: Env,
  tenantId: string,
  profile: LoginEntrySettings
): Promise<void> {
  await Promise.all([
    env.SETTINGS?.put('settings:platform:login-entry', JSON.stringify(profile)),
    env.SETTINGS?.put(`settings:tenant:${tenantId}:login-entry`, JSON.stringify(profile)),
    env.SETTINGS?.put('settings:tenant:first:login-entry', JSON.stringify(profile)),
    env.SETTINGS?.put('settings:tenant:default:login-entry', JSON.stringify(profile)),
  ]);
}

export async function applyLoginEntryRow(env: Env, row: SettingsMatrixRow): Promise<void> {
  await applyLoginEntryProfile(env, 'first', loginEntrySettingsFromRow(row));
}

export async function seedTenantDataset(
  env: Env,
  variant: TenantDatasetVariant = 'default'
): Promise<void> {
  const tenants =
    variant === 'single-active'
      ? [tenantSystemTenants.first]
      : [
          tenantSystemTenants.first,
          tenantSystemTenants.second,
          ...(variant === 'with-inactive' ? [tenantSystemTenants.inactive] : []),
        ];
  const now = Math.floor(Date.now() / 1000);
  const domainMappings: DomainMappingRow[] = [
    {
      domain: 'first.example.test',
      domain_hash: await generateEmailDomainHash(
        'user@first.example.test',
        env.EMAIL_DOMAIN_HASH_SECRET ?? ''
      ),
      tenant_id: 'first',
      verified: 1,
      is_active: 1,
      tenant_active: 1,
      priority: 100,
    },
    {
      domain: 'shared.example.test',
      domain_hash: await generateEmailDomainHash(
        'user@shared.example.test',
        env.EMAIL_DOMAIN_HASH_SECRET ?? ''
      ),
      tenant_id: 'first',
      verified: 1,
      is_active: 1,
      tenant_active: 1,
      priority: 100,
    },
    {
      domain: 'shared.example.test',
      domain_hash: await generateEmailDomainHash(
        'user@shared.example.test',
        env.EMAIL_DOMAIN_HASH_SECRET ?? ''
      ),
      tenant_id: 'second',
      verified: 1,
      is_active: 1,
      tenant_active: 1,
      priority: 90,
    },
    {
      domain: 'inactive.example.test',
      domain_hash: await generateEmailDomainHash(
        'user@inactive.example.test',
        env.EMAIL_DOMAIN_HASH_SECRET ?? ''
      ),
      tenant_id: 'inactive',
      verified: 0,
      is_active: 0,
      tenant_active: 0,
      priority: 100,
    },
  ];
  const data = {
    tenants: tenants.map(({ id, tenant_code, name, is_active }) => ({
      id,
      tenant_code,
      name,
      is_active,
    })),
    users: tenantSystemExactEmailUsers.map((user) => ({ ...user, is_active: 1 as const })),
    clients: [tenantSystemOidcClients.first, tenantSystemOidcClients.second],
    invitations: [
      {
        id: 'invite-valid',
        token: 'valid-invite',
        tenant_id: 'first',
        invited_email: 'invited@example.test',
        max_uses: -1,
        use_count: 0,
        expires_at: now + 3600,
      },
      {
        id: 'invite-expired',
        token: 'expired-invite',
        tenant_id: 'first',
        invited_email: null,
        max_uses: -1,
        use_count: 0,
        expires_at: now - 1,
      },
      {
        id: 'invite-exhausted',
        token: 'exhausted-invite',
        tenant_id: 'first',
        invited_email: null,
        max_uses: 1,
        use_count: 1,
        expires_at: now + 3600,
      },
      {
        id: 'invite-inactive',
        token: 'inactive-invite',
        tenant_id: 'inactive',
        invited_email: null,
        max_uses: -1,
        use_count: 0,
        expires_at: now + 3600,
      },
    ],
    domainMappings,
    vanityDomains: tenantSystemVanityDomains.map((domain) => ({
      ...domain,
      is_active: domain.is_active as 0 | 1,
      is_primary: domain.is_primary as 0 | 1,
      cloudflare_zone_id: 'zone-test',
      cloudflare_custom_hostname_id: `cf-${domain.id}`,
      ssl_status: domain.status === 'active' ? 'active' : 'pending',
      ownership_status: domain.status,
      validation_method: 'http',
      validation_records_json: JSON.stringify({ cname: domain.hostname }),
      last_sync_at: now,
      created_by: 'test',
      created_at: now,
      updated_at: now,
    })),
  };

  env.DB = new TenantSystemD1Database(data, 'core') as unknown as D1Database;
  env.DB_PII = new TenantSystemD1Database(data, 'pii') as unknown as D1Database;
}

export function createTenantSystemDiscoveryApp(tenantId = 'first'): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    await next();
  });
  app.get('/api/auth/discovery', getDiscoveryConfigHandler);
  app.post('/api/auth/discovery', postDiscoveryHandler);
  app.post('/api/auth/discovery/grant', postDiscoveryGrantHandler);
  app.post('/api/auth/discovery/grant/verify', postDiscoveryGrantVerifyHandler);

  return app;
}

export function createTenantSystemApiFetch(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  fallbackHost = 'tenant-system.authrim.test'
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestHeaders = new Headers(input instanceof Request ? input.headers : init?.headers);
    const originalHost =
      requestHeaders.get('x-authrim-original-host') || requestHeaders.get('host') || fallbackHost;
    const url =
      input instanceof Request
        ? new URL(input.url, `https://${originalHost}`)
        : new URL(String(input), `https://${originalHost}`);
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    const request = new Request(`https://${originalHost}${url.pathname}${url.search}`, {
      method,
      headers: requestHeaders,
      body: method === 'GET' || method === 'HEAD' ? undefined : init?.body,
    });
    request.headers.set('Host', originalHost);

    return app.request(request, {}, env);
  }) as typeof fetch;
}

export async function postDiscoveryRequest(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  host: string,
  body: { mode: string; value: string }
): Promise<Response> {
  return app.request(
    makeTenantRequest(host, '/api/auth/discovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {},
    env
  );
}

export function makeTenantRequest(host: string, path: string, options: RequestInit = {}): Request {
  return new Request(`https://${host}${path}`, {
    ...options,
    headers: {
      Host: host,
      ...(options.headers ?? {}),
    },
  });
}

export function expectRedirect(response: Response, targetMatcher: string | RegExp): void {
  const location = response.headers.get('location') ?? '';
  if (typeof targetMatcher === 'string') {
    expect(location).toBe(targetMatcher);
    return;
  }

  expect(location).toMatch(targetMatcher);
}

export async function expectDiscoveryConfig(
  response: Response,
  expectedSubset: Partial<DiscoveryConfigBody['config']>
): Promise<DiscoveryConfigBody> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as DiscoveryConfigBody;
  expect(body.config).toMatchObject(expectedSubset);
  return body;
}

export async function expectNoCrossTenantLeakage(
  response: Response,
  tenantId: string
): Promise<void> {
  const text = await response.clone().text();
  const otherTenantId = tenantId === 'first' ? 'second' : 'first';
  expect(text).not.toContain(`"tenant_id":"${otherTenantId}"`);
}
