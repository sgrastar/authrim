/**
 * `machine_access.all_scope_excluded_tenants` through the real adminAuthMiddleware: an all-tenants
 * machine token is refused on a listed tenant unless its principal and credential name it. Only
 * the tenant the request runs in (a stand-in for the request context, which copies `X-Tenant-Id`
 * into the context) and the stored grants are simulated; the refusal is decided by the middleware.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  adminAuthMiddleware,
  hasGlobalMachinePermission,
  hasGlobalPlatformAuthority,
} from '../admin-auth';
import { hasSystemAdminAuthority } from '../rbac';
import { refuseMachineOnExcludedTenant } from '../../services/machine-excluded-tenants';
import type { Env } from '../../types/env';
import type { AdminAuthContext } from '../../types/admin';

type Scope = { scope_mode: string; tenant_id: string | null };
const ALL: Scope = { scope_mode: 'all', tenant_id: null };
const allow = (tenantId: string): Scope => ({ scope_mode: 'allow', tenant_id: tenantId });

const SESSION_ID = 'admin-session-test123';

interface Grants {
  principalType: string;
  principalId: string;
  clientId: string;
  principalScopes: Scope[];
  credentialScopes: Scope[];
  /** What the principal holds; a wildcard by default. */
  permissions?: string[];
}

function mockDb(grants: Grants | null, humanSession = false): D1Database {
  const principal = grants && {
    id: grants.principalId,
    client_id: grants.clientId,
    display_name: 'Test principal',
    description: null,
    principal_type: grants.principalType,
    status: 'active',
    default_audience: 'authrim:admin-api',
    token_ttl_seconds: 600,
    created_by_actor_type: 'admin',
    created_by_actor_id: 'a',
    created_at: 1,
    updated_at: 1,
    disabled_at: null,
    disabled_by_actor_type: null,
    disabled_by_actor_id: null,
  };
  const credential = grants && {
    credential_id: 'amk_test',
    credential_principal_id: grants.principalId,
    credential_kid: 'k',
    credential_public_jwk_json: '{"kty":"EC"}',
    credential_alg: 'ES256',
    credential_display_name: 'Key',
    credential_description: null,
    credential_status: 'active',
    credential_not_before: null,
    credential_expires_at: null,
    credential_last_used_at: null,
    credential_last_used_ip: null,
    credential_last_used_user_agent: null,
    credential_created_by_actor_type: 'admin',
    credential_created_by_actor_id: 'a',
    credential_created_at: 1,
    credential_updated_at: 1,
    credential_revoked_at: null,
    credential_revoked_by_actor_type: null,
    credential_revoked_by_actor_id: null,
    credential_revoke_reason: null,
  };
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation(() => ({
        first: vi.fn().mockImplementation(async () => {
          if (sql.includes('admin_sessions') && humanSession) {
            return {
              id: SESSION_ID,
              tenant_id: 'default',
              admin_user_id: 'admin-user-1',
              expires_at: Date.now() + 3600000,
              mfa_verified: 0,
            };
          }
          if (sql.includes('admin_users') && humanSession) {
            return {
              id: 'admin-user-1',
              tenant_id: 'default',
              email: 'admin@example.com',
              is_active: 1,
              status: 'active',
            };
          }
          if (sql.includes('principal_permissions_json') && grants) {
            return {
              ...principal,
              ...credential,
              principal_permissions_json: JSON.stringify(grants.permissions ?? ['*']),
              credential_permissions_json: JSON.stringify([]),
              principal_scopes_json: JSON.stringify(grants.principalScopes),
              credential_scopes_json: JSON.stringify(grants.credentialScopes),
            };
          }
          return null;
        }),
        all: vi.fn().mockImplementation(async () => {
          if (sql.includes('admin_effective_role_assignments') && humanSession) {
            return {
              results: [
                {
                  id: 'role_super',
                  name: 'ar_super_admin',
                  permissions_json: JSON.stringify(['*']),
                  hierarchy_level: 100,
                  inherits_from: null,
                  has_global_scope: 1,
                },
              ],
              success: true,
            };
          }
          return { results: [], success: true };
        }),
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    })),
  } as unknown as D1Database;
}

async function fixture(grants: Grants, tenantScopeClaim: string[]) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 'admin-token-key';
  publicJwk.alg = 'RS256';
  const token = await new SignJWT({
    sub: `machine:${grants.principalId}`,
    aud: 'authrim:admin-api',
    azp: grants.clientId,
    client_id: grants.clientId,
    actor_type: 'machine',
    actor_id: grants.principalId,
    credential_id: 'amk_test',
    client_auth_method: 'private_key_jwt',
    credential_strength: 'asymmetric_key',
    sender_constrained: false,
    scope: (grants.permissions ?? ['admin:users:read', 'admin:tenants:provision']).join(' '),
    tenant_scope: tenantScopeClaim,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'admin-token-key' })
    .setIssuer('https://test.example.com')
    .setIssuedAt()
    .setExpirationTime('10m')
    .setJti('jti-1')
    .sign(privateKey);
  return { token, publicJwk };
}

const AUTOMATION: Grants = {
  principalType: 'automation',
  principalId: 'amp_auto',
  clientId: 'auto-client',
  principalScopes: [ALL],
  credentialScopes: [],
};

function appFor(env: Env) {
  const app = new Hono<{ Bindings: Env }>();
  // The request context copies the X-Tenant-Id of a tenant-scoped route into the context.
  app.use('/api/admin/*', async (c, next) => {
    const header = c.req.header('X-Tenant-Id');
    if (header) c.set('tenantId', header);
    await next();
  });
  app.use('/api/admin/*', adminAuthMiddleware());
  // What the central authority checks say about the caller.
  app.get('/api/admin/probe-authority', (c) => {
    const auth = (c as unknown as { get(key: string): AdminAuthContext }).get('adminAuth');
    return c.json({
      platform: hasGlobalPlatformAuthority(auth, 'admin:*'),
      system: hasSystemAdminAuthority(auth),
      provision: hasGlobalMachinePermission(auth, 'admin:tenants:provision'),
      wildcard: hasGlobalMachinePermission(auth, '*'),
    });
  });
  app.all('/api/admin/*', async (c) => {
    // A handler that asks the shared helper too: the setting is read once for the request.
    const handlerTenant = c.req.header('X-Handler-Tenant');
    const refused = handlerTenant ? await refuseMachineOnExcludedTenant(c, handlerTenant) : null;
    if (!refused && c.req.header('X-Echo')) return c.json({ bytes: (await c.req.text()).length });
    return refused ?? c.json({ ok: true });
  });
  // A route that is not under /api/admin (a protocol-style path) but has the Admin API's auth.
  app.use('/api/rebac/*', async (c, next) => {
    const header = c.req.header('X-Tenant-Id');
    if (header) c.set('tenantId', header);
    await next();
  });
  app.use('/api/rebac/*', adminAuthMiddleware());
  app.all('/api/rebac/*', (c) => c.json({ ok: true }));
  return { fetch: (request: Request) => app.fetch(request, env) };
}

interface Setup {
  grants?: Grants | null;
  claim?: string[];
  settings?: Record<string, string | undefined>;
  settingsKv?: unknown;
}

async function send(
  setup: Setup,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string | ReadableStream<Uint8Array>
): Promise<Response> {
  const grants = setup.grants === undefined ? AUTOMATION : setup.grants;
  const fx = grants ? await fixture(grants, setup.claim ?? ['*']) : null;
  const env = {
    ISSUER_URL: 'https://test.example.com',
    DEFAULT_TENANT_ID: 'default',
    DB: mockDb(grants),
    DB_ADMIN: mockDb(grants),
    ...(fx ? { PUBLIC_JWK_JSON: JSON.stringify(fx.publicJwk) } : {}),
    ...(setup.settings ?? {}),
    ...(setup.settingsKv ? { SETTINGS: setup.settingsKv } : {}),
  } as unknown as Env;
  return appFor(env).fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(fx ? { Authorization: `Bearer ${fx.token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body, duplex: 'half' }),
    })
  );
}

const PROTECT_DEFAULT = { MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: 'default' };
const REFUSED = {
  error: 'access_denied',
  error_description: 'Admin machine credential is not valid for this tenant.',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('all-tenants machine token with the primary tenant in the list', () => {
  const setup: Setup = { settings: PROTECT_DEFAULT };

  describe.each([
    ['users list', 'GET', '/api/admin/users'],
    ['clients', 'POST', '/api/admin/clients'],
    ['tenant settings', 'PATCH', '/api/admin/settings/security'],
    ['admin users', 'POST', '/api/admin/admin-users'],
    ['admin invitations', 'POST', '/api/admin/admin-invitations'],
    ['admin invitation code hand-off', 'POST', '/api/admin/admin-invitations/inv_1/resend'],
  ])('tenant-scoped route: %s', (_name, method, path) => {
    it('is refused on the protected tenant, with the answer a tenant outside the scope gets', async () => {
      const response = await send(setup, method, path, { 'X-Tenant-Id': 'default' });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual(REFUSED);
    });

    it('is accepted on another tenant', async () => {
      const response = await send(setup, method, path, { 'X-Tenant-Id': 'acme' });
      expect(response.status).toBe(200);
    });
  });

  it.each([
    ['delete', 'DELETE', '/api/admin/tenants/default'],
    ['read', 'GET', '/api/admin/tenants/default'],
    ['provisioning', 'GET', '/api/admin/tenants/default/provisioning'],
    ['provisioning cleanup', 'POST', '/api/admin/tenants/default/provisioning/cleanup'],
    ['provisioning retry', 'POST', '/api/admin/tenants/default/provisioning/retry'],
    ['suspend', 'POST', '/api/admin/tenants/default/lifecycle/suspend'],
    ['lifecycle job retry', 'POST', '/api/admin/tenants/default/lifecycle/jobs/j1/retry'],
    ['set default', 'POST', '/api/admin/tenants/default/set-default'],
    ['clone', 'POST', '/api/admin/tenants/default/clone'],
    ['info a tenant admin may open', 'GET', '/api/admin/tenants/default/info'],
    ['tenant settings through the path', 'GET', '/api/admin/tenants/default/settings/security'],
    ['logging settings of the tenant', 'GET', '/api/admin/settings/logging/tenant/default'],
  ])('inventory route naming the protected tenant (%s) is refused', async (_n, method, path) => {
    // The inventory routes carry no tenant header: they run on the primary host.
    const response = await send(setup, method, path);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(REFUSED);
  });

  it.each([
    ['percent-encoded', '/api/admin/tenants/%64efault/provisioning'],
    ['percent-encoded upper', '/api/admin/tenants/%44EFAULT'],
    ['upper case', '/api/admin/tenants/DEFAULT'],
    ['mixed case', '/api/admin/tenants/Default/provisioning/cleanup'],
    ['double encoded', '/api/admin/tenants/%2564efault'],
    ['trailing slash', '/api/admin/tenants/default/'],
    ['padded', '/api/admin/tenants/%20default'],
    ['too deeply encoded', '/api/admin/tenants/%25252564efault'],
    ['malformed escape', '/api/admin/tenants/%zz/provisioning'],
    ['logging, encoded', '/api/admin/settings/logging/tenant/%64efault'],
  ])('does not let a %s variant of the tenant id bypass it', async (_n, path) => {
    const response = await send(setup, 'GET', path);
    expect(response.status).toBe(403);
  });

  it('does not let a case variant of the tenant header bypass it', async () => {
    const response = await send(setup, 'GET', '/api/admin/users', { 'X-Tenant-Id': 'DEFAULT' });
    expect(response.status).toBe(403);
  });

  it.each([
    ['create a tenant', 'POST', '/api/admin/tenants'],
    ['list tenants', 'GET', '/api/admin/tenants'],
    ['read provisioning of another tenant', 'GET', '/api/admin/tenants/acme/provisioning'],
    ['delete another tenant', 'DELETE', '/api/admin/tenants/acme'],
    ['encoded id of another tenant', 'GET', '/api/admin/tenants/%61cme/provisioning'],
    ['platform settings on the primary host', 'GET', '/api/admin/platform/settings/security'],
  ])('keeps the platform / inventory operation working: %s', async (_n, method, path) => {
    const response = await send(setup, method, path);
    expect(response.status).toBe(200);
  });
});

describe('who is not refused', () => {
  const settings = PROTECT_DEFAULT;

  it('accepts a principal and credential that name the protected tenant explicitly', async () => {
    const named: Grants = {
      ...AUTOMATION,
      principalScopes: [ALL, allow('default')],
      credentialScopes: [ALL, allow('default')],
    };
    for (const [method, path, headers] of [
      ['GET', '/api/admin/users', { 'X-Tenant-Id': 'default' }],
      ['POST', '/api/admin/admin-invitations', { 'X-Tenant-Id': 'default' }],
      ['DELETE', '/api/admin/tenants/default', {}],
    ] as const) {
      const response = await send({ settings, grants: named }, method, path, { ...headers });
      expect(response.status, `${method} ${path}`).toBe(200);
    }
  });

  it('accepts it when only the principal has a scope and names the tenant', async () => {
    const named: Grants = { ...AUTOMATION, principalScopes: [ALL, allow('default')] };
    const response = await send({ settings, grants: named }, 'GET', '/api/admin/users', {
      'X-Tenant-Id': 'default',
    });
    expect(response.status).toBe(200);
  });

  it('refuses it when the principal names the tenant but its credential, with its own scope, does not', async () => {
    const half: Grants = {
      ...AUTOMATION,
      principalScopes: [ALL, allow('default')],
      credentialScopes: [ALL],
    };
    const response = await send({ settings, grants: half }, 'GET', '/api/admin/users', {
      'X-Tenant-Id': 'default',
    });
    expect(response.status).toBe(403);
  });

  it('accepts a principal limited to the protected tenant by name (not an all-tenants scope)', async () => {
    const limited: Grants = { ...AUTOMATION, principalScopes: [allow('default')] };
    const response = await send(
      { settings, grants: limited, claim: ['default'] },
      'GET',
      '/api/admin/users',
      { 'X-Tenant-Id': 'default' }
    );
    expect(response.status).toBe(200);
  });

  it('leaves a principal scoped only to another tenant as it was', async () => {
    const other: Grants = { ...AUTOMATION, principalScopes: [allow('acme')] };
    const own = await send(
      { settings, grants: other, claim: ['acme'] },
      'GET',
      '/api/admin/users',
      {
        'X-Tenant-Id': 'acme',
      }
    );
    expect(own.status).toBe(200);
    const foreign = await send(
      { settings, grants: other, claim: ['acme'] },
      'GET',
      '/api/admin/users',
      { 'X-Tenant-Id': 'default' }
    );
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toEqual(REFUSED);
  });

  it.each(['setup_tool', 'internal_service'])(
    'never refuses the platform principal type %s, even with every tenant listed',
    async (principalType) => {
      const platform: Grants = {
        ...AUTOMATION,
        principalType,
        principalId: `amp_${principalType}`,
      };
      for (const value of ['default', '*']) {
        const response = await send(
          {
            grants: platform,
            // `*` is not a valid list: it reads as every tenant being excluded.
            settings: { MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: value },
          },
          'GET',
          '/api/admin/users',
          { 'X-Tenant-Id': 'default' }
        );
        expect(response.status, `${principalType} ${value}`).toBe(200);
      }
    }
  );

  it('does not touch the Admin console relay: its transport credential and the admin session it carries', async () => {
    const relay: Grants = {
      ...AUTOMATION,
      principalType: 'admin_ui_bff',
      principalId: 'amp_authrim_admin_ui_bff',
      clientId: 'authrim-admin-ui-bff',
    };
    const fx = await fixture(relay, ['*']);
    const env = {
      ISSUER_URL: 'https://test.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: mockDb(relay, true),
      DB_ADMIN: mockDb(relay, true),
      PUBLIC_JWK_JSON: JSON.stringify(fx.publicJwk),
      MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: 'default,acme',
    } as unknown as Env;
    const app = appFor(env);
    for (const [method, path, tenant] of [
      ['GET', '/api/admin/users', 'default'],
      ['GET', '/api/admin/users', 'acme'],
      ['GET', '/api/admin/tenants/default/info', 'default'],
    ] as const) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${fx.token}`,
            Cookie: `authrim_admin_session=${SESSION_ID}`,
            'X-Authrim-Admin-UI-Api-Mode': 'cross-site-proxy-bff',
            'X-Tenant-Id': tenant,
          },
        })
      );
      expect(response.status, `${method} ${path} ${tenant}`).toBe(200);
    }
  });

  it('never refuses the setup principal the bootstrap writes (by its fixed id)', async () => {
    const bootstrap: Grants = {
      ...AUTOMATION,
      principalType: 'automation',
      principalId: 'amp_authrim_setup',
      clientId: 'authrim-setup',
    };
    const response = await send(
      { settings, grants: bootstrap },
      'DELETE',
      '/api/admin/tenants/default'
    );
    expect(response.status).toBe(200);
  });

  it('does not affect a signed-in human, whatever the list says', async () => {
    const env = {
      ISSUER_URL: 'https://test.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: mockDb(null, true),
      DB_ADMIN: mockDb(null, true),
      ...settings,
    } as unknown as Env;
    const app = appFor(env);
    for (const [method, path, headers] of [
      ['GET', '/api/admin/users', { 'X-Tenant-Id': 'default' }],
      ['DELETE', '/api/admin/tenants/default', {}],
    ] as const) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { Cookie: `authrim_admin_session=${SESSION_ID}`, ...headers },
        })
      );
      expect(response.status, `${method} ${path}`).toBe(200);
    }
  });
});

describe('the setting itself', () => {
  it('changes nothing while the list is empty or unset', async () => {
    for (const settings of [{}, { MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: '' }]) {
      for (const [method, path, headers] of [
        ['GET', '/api/admin/users', { 'X-Tenant-Id': 'default' }],
        ['POST', '/api/admin/admin-invitations', { 'X-Tenant-Id': 'default' }],
        ['DELETE', '/api/admin/tenants/default', {}],
        ['GET', '/api/admin/tenants/default/provisioning', {}],
      ] as const) {
        const response = await send({ settings }, method, path, { ...headers });
        expect(response.status, `${method} ${path}`).toBe(200);
      }
    }
  });

  it('takes effect on the next request with the same token, without waiting for it to expire', async () => {
    const fx = await fixture(AUTOMATION, ['*']);
    const kvState: { value?: string } = {};
    const kv = {
      get: async () =>
        kvState.value === undefined
          ? null
          : JSON.stringify({ 'machine_access.all_scope_excluded_tenants': kvState.value }),
    };
    const env = {
      ISSUER_URL: 'https://test.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: mockDb(AUTOMATION),
      DB_ADMIN: mockDb(AUTOMATION),
      PUBLIC_JWK_JSON: JSON.stringify(fx.publicJwk),
      SETTINGS: kv,
    } as unknown as Env;
    const app = appFor(env);
    const call = () =>
      app.fetch(
        new Request('http://localhost/api/admin/users', {
          headers: { Authorization: `Bearer ${fx.token}`, 'X-Tenant-Id': 'default' },
        })
      );
    expect((await call()).status).toBe(200);
    kvState.value = 'default';
    expect((await call()).status).toBe(403);
    kvState.value = '';
    expect((await call()).status).toBe(200);
  });

  it('fails closed for an all-tenants token when the setting cannot be read', async () => {
    const kv = {
      get: async () => {
        throw new Error('KV unavailable');
      },
    };
    const other = await send({ settingsKv: kv }, 'GET', '/api/admin/users', {
      'X-Tenant-Id': 'acme',
    });
    expect(other.status).toBe(403);
    await expect(other.json()).resolves.toEqual(REFUSED);
    // Platform principals and tokens naming their tenants are not locked out by it.
    const setupTool = await send(
      {
        settingsKv: kv,
        grants: { ...AUTOMATION, principalType: 'setup_tool', principalId: 'amp_s' },
      },
      'GET',
      '/api/admin/users',
      { 'X-Tenant-Id': 'default' }
    );
    expect(setupTool.status).toBe(200);
    const named = await send(
      {
        settingsKv: kv,
        grants: { ...AUTOMATION, principalScopes: [allow('acme')] },
        claim: ['acme'],
      },
      'GET',
      '/api/admin/users',
      { 'X-Tenant-Id': 'acme' }
    );
    expect(named.status).toBe(200);
  });

  it('fails closed for an all-tenants token when the saved value is not valid', async () => {
    const kv = {
      get: async () => JSON.stringify({ 'machine_access.all_scope_excluded_tenants': 'Default,*' }),
    };
    const response = await send({ settingsKv: kv }, 'GET', '/api/admin/users', {
      'X-Tenant-Id': 'acme',
    });
    expect(response.status).toBe(403);
  });

  it('lets an all-tenants token that names its tenants explicitly work while the setting is unreadable', async () => {
    const kv = {
      get: async () => {
        throw new Error('KV unavailable');
      },
    };
    const named: Grants = { ...AUTOMATION, principalScopes: [ALL, allow('acme')] };
    const response = await send({ settingsKv: kv, grants: named }, 'GET', '/api/admin/users', {
      'X-Tenant-Id': 'acme',
    });
    expect(response.status).toBe(200);
  });

  it('does not log the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fx = await fixture(AUTOMATION, ['*']);
    const env = {
      ISSUER_URL: 'https://test.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: mockDb(AUTOMATION),
      DB_ADMIN: mockDb(AUTOMATION),
      PUBLIC_JWK_JSON: JSON.stringify(fx.publicJwk),
      ...PROTECT_DEFAULT,
    } as unknown as Env;
    const response = await appFor(env).fetch(
      new Request('http://localhost/api/admin/users', {
        headers: { Authorization: `Bearer ${fx.token}`, 'X-Tenant-Id': 'default' },
      })
    );
    expect(response.status).toBe(403);
    const output = [...warn.mock.calls, ...info.mock.calls, ...log.mock.calls]
      .map((call) => call.map(String).join(' '))
      .join('\n');
    expect(output).toContain('excluded from the all-tenants scope');
    expect(output).not.toContain(fx.token);
    warn.mockRestore();
    info.mockRestore();
    log.mockRestore();
  });
});

describe('where the request tenant is judged, and what else a request names', () => {
  const setup: Setup = { settings: PROTECT_DEFAULT };
  const json = (value: unknown) => JSON.stringify(value);

  it('judges the request tenant of a protocol-style route that has the Admin API auth', async () => {
    const refused = await send(
      setup,
      'POST',
      '/api/rebac/write',
      { 'X-Tenant-Id': 'default' },
      json({ tenant_id: 'default' })
    );
    expect(refused.status).toBe(403);
    const ok = await send(
      setup,
      'POST',
      '/api/rebac/write',
      { 'X-Tenant-Id': 'acme' },
      json({ tenant_id: 'acme' })
    );
    expect(ok.status).toBe(200);
    // The request runs in an unprotected tenant but its body names the protected one.
    const named = await send(
      setup,
      'DELETE',
      '/api/rebac/tuples',
      { 'X-Tenant-Id': 'acme' },
      json({ tenant_id: 'default' })
    );
    expect(named.status).toBe(403);
  });

  it('does not judge the host tenant of platform and inventory operations that name no tenant', async () => {
    for (const [method, path] of [
      ['GET', '/api/admin/platform/settings/machine-access'],
      ['PATCH', '/api/admin/platform/settings/security'],
      ['GET', '/api/admin/platform/plugins'],
      ['POST', '/api/admin/tenants'],
      ['GET', '/api/admin/tenants/acme/provisioning'],
      ['DELETE', '/api/admin/tenants/acme'],
    ] as const) {
      const response = await send(setup, method, path);
      expect(response.status, `${method} ${path}`).toBe(200);
    }
  });

  it.each([
    ['query tenant_id', 'GET', '/api/admin/platform/plugins/p/config?tenant_id=default'],
    ['query filter[tenant_id]', 'GET', '/api/admin/platform/tombstones?filter[tenant_id]=default'],
    [
      'query tenantId in a list',
      'GET',
      '/api/admin/platform/settings/pii-partitions/stats?tenantId=acme,default',
    ],
    ['encoded query', 'GET', '/api/admin/platform/tombstones?tenant_id=%64efault'],
  ])('refuses a protected tenant named in the %s of a platform route', async (_n, method, path) => {
    // The query value is read as the URL gives it: only percent-decoding by the URL parser.
    const response = await send(setup, method, path);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(REFUSED);
  });

  it('refuses the X-Tenant-Id header of a platform route, the body tenant_id and tenant_ids', async () => {
    expect(
      (
        await send(setup, 'GET', '/api/admin/platform/plugins/p/config', {
          'X-Tenant-Id': 'default',
        })
      ).status
    ).toBe(403);
    expect(
      (await send(setup, 'GET', '/api/admin/platform/plugins/p/config', { 'X-Tenant-Id': 'acme' }))
        .status
    ).toBe(200);
    for (const body of [
      { tenant_id: 'default' },
      { tenantId: 'DEFAULT' },
      { tenant_ids: ['acme', 'default'] },
      { tenantIds: ['Default'] },
    ]) {
      const response = await send(
        setup,
        'PUT',
        '/api/admin/platform/plugins/p/config',
        {},
        json({ config: {}, ...body })
      );
      expect(response.status, json(body)).toBe(403);
    }
    expect(
      (
        await send(
          setup,
          'PUT',
          '/api/admin/platform/plugins/p/config',
          {},
          json({ config: {}, tenant_id: 'acme' })
        )
      ).status
    ).toBe(200);
    expect(
      (await send(setup, 'PUT', '/api/admin/platform/plugins/p/config', {}, json({ config: {} })))
        .status
    ).toBe(200);
  });

  it('does not let a padded body hide a tenant, and ignores bodies that are not JSON', async () => {
    const padded = json({ pad: 'x'.repeat(1024 * 1024 + 10), tenant_id: 'default' });
    expect(
      (await send(setup, 'POST', '/api/admin/platform/tombstones/cleanup', {}, padded)).status
    ).toBe(403);
    expect(
      (await send(setup, 'POST', '/api/admin/platform/tombstones/cleanup', {}, '{broken')).status
    ).toBe(200);
  });

  it('leaves the platform principal types, a named tenant and a human alone on all of these', async () => {
    const tool = { ...AUTOMATION, principalType: 'setup_tool', principalId: 'amp_setup_x' };
    expect(
      (
        await send(
          { settings: PROTECT_DEFAULT, grants: tool },
          'GET',
          '/api/admin/platform/tombstones?tenant_id=default'
        )
      ).status
    ).toBe(200);
    expect(
      (
        await send(
          { settings: PROTECT_DEFAULT, grants: tool },
          'POST',
          '/api/rebac/write',
          { 'X-Tenant-Id': 'default' },
          json({ tenant_id: 'default' })
        )
      ).status
    ).toBe(200);
    const named: Grants = { ...AUTOMATION, principalScopes: [ALL, allow('default')] };
    expect(
      (
        await send(
          { settings: PROTECT_DEFAULT, grants: named },
          'GET',
          '/api/admin/platform/tombstones?tenant_id=default'
        )
      ).status
    ).toBe(200);
  });

  it('shares one read of the setting between the middleware and the handler helper', async () => {
    const gets = vi.fn(async () =>
      JSON.stringify({ 'machine_access.all_scope_excluded_tenants': 'default' })
    );
    const response = await send({ settingsKv: { get: gets } }, 'GET', '/api/admin/users', {
      'X-Tenant-Id': 'acme',
      'X-Handler-Tenant': 'acme',
    });
    expect(response.status).toBe(200);
    const reads = gets.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    const again = vi.fn(async () =>
      JSON.stringify({ 'machine_access.all_scope_excluded_tenants': 'default' })
    );
    // Without the handler's own check the number of reads is the same.
    await send({ settingsKv: { get: again } }, 'GET', '/api/admin/users', {
      'X-Tenant-Id': 'acme',
    });
    expect(again.mock.calls.length).toBe(reads);
    // And the handler's check refuses a tenant the request itself does not name.
    const refused = await send(setup, 'GET', '/api/admin/users', {
      'X-Tenant-Id': 'acme',
      'X-Handler-Tenant': 'default',
    });
    expect(refused.status).toBe(403);
  });

  it('reads a stored null as every tenant excluded, even over an environment list', async () => {
    const kv = {
      get: async () => JSON.stringify({ 'machine_access.all_scope_excluded_tenants': null }),
    };
    const response = await send(
      { settings: PROTECT_DEFAULT, settingsKv: kv },
      'GET',
      '/api/admin/users',
      { 'X-Tenant-Id': 'acme' }
    );
    expect(response.status).toBe(403);
  });

  it('refuses an all-tenants machine token while the settings store is unreadable even if no list was ever saved', async () => {
    const kv = {
      get: async () => {
        throw new Error('KV unavailable');
      },
    };
    const response = await send({ settingsKv: kv }, 'GET', '/api/admin/users', {
      'X-Tenant-Id': 'acme',
    });
    expect(response.status).toBe(403);
  });
});

describe('how much of a body is read to find the tenants it names', () => {
  const setup: Setup = { settings: PROTECT_DEFAULT };
  const MIB = 1024 * 1024;
  const stream = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  const bytes = (text: string) => new TextEncoder().encode(text);

  it('counts bytes, not characters: multi-byte text over the limit is refused', async () => {
    // 400,000 characters is under 1 MiB as a string length but about 1.2 MB as bytes.
    const body = JSON.stringify({ pad: '日'.repeat(400_000), tenant_id: 'acme' });
    expect(body.length).toBeLessThan(MIB);
    expect(bytes(body).byteLength).toBeGreaterThan(MIB);
    expect(
      (await send(setup, 'POST', '/api/admin/platform/tombstones/cleanup', {}, body)).status
    ).toBe(403);
  });

  it('stops reading a stream without a Content-Length once it passes the limit midway', async () => {
    let pulled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(256 * 1024).fill(0x20));
        if (pulled > 100) controller.close();
      },
    });
    const response = await send(
      setup,
      'POST',
      '/api/admin/platform/tombstones/cleanup',
      {},
      source
    );
    expect(response.status).toBe(403);
    // It did not drain the whole (26 MB) stream.
    expect(pulled).toBeLessThan(40);
  });

  it('reads a chunked body within the limit, judges it, and leaves the whole body to the handler', async () => {
    const text = JSON.stringify({ config: { note: '日本語'.repeat(1000) }, tenant_id: 'acme' });
    const data = bytes(text);
    const chunks = [data.slice(0, 100), data.slice(100, 5000), data.slice(5000)];
    const ok = await send(
      setup,
      'PUT',
      '/api/admin/platform/plugins/p/config',
      { 'X-Echo': '1' },
      stream(chunks)
    );
    expect(ok.status).toBe(200);
    const echoed = await ok.json<{ bytes: number }>();
    expect(echoed.bytes).toBe(text.length);
    // The same chunked body naming the protected tenant is refused.
    const named = bytes(JSON.stringify({ tenant_id: 'default' }));
    const refused = await send(
      setup,
      'PUT',
      '/api/admin/platform/plugins/p/config',
      {},
      stream([named.slice(0, 5), named.slice(5)])
    );
    expect(refused.status).toBe(403);
  });
});

describe('a wildcard is no cross-tenant authority while tenants are excluded', () => {
  const WILDCARD: Grants = { ...AUTOMATION, permissions: ['*'] };
  const probe = async (setup: Setup) =>
    await (
      await send(setup, 'GET', '/api/admin/probe-authority', { 'X-Tenant-Id': 'acme' })
    ).json<Record<string, boolean>>();
  const exact = ['admin:tenants:provision', 'admin:tenants:delete', 'admin:admin_users:write'];

  it('takes platform authority from a wildcard-holding non-platform machine, only while a tenant is listed', async () => {
    expect(await probe({ settings: PROTECT_DEFAULT, grants: WILDCARD })).toEqual({
      platform: false,
      system: false,
      provision: false,
      wildcard: false,
    });
    expect(await probe({ grants: WILDCARD })).toEqual({
      platform: true,
      system: true,
      provision: true,
      wildcard: true,
    });
    expect(
      await probe({
        settings: { MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: '' },
        grants: WILDCARD,
      })
    ).toMatchObject({ platform: true });
  });

  it('takes it while the setting cannot be read, too', async () => {
    const kv = {
      get: async () => {
        throw new Error('KV unavailable');
      },
    };
    // Only a token that names its tenant gets through while nothing can be read.
    const named: Grants = {
      ...WILDCARD,
      principalScopes: [ALL, allow('acme')],
    };
    expect(await probe({ settingsKv: kv, grants: named })).toMatchObject({
      platform: false,
      system: false,
    });
  });

  it('keeps an exact-name permission, and never touches platform principals', async () => {
    const holder: Grants = { ...AUTOMATION, permissions: exact };
    expect(await probe({ settings: PROTECT_DEFAULT, grants: holder })).toEqual({
      platform: false,
      system: false,
      provision: true,
      wildcard: false,
    });
    const tool: Grants = { ...WILDCARD, principalType: 'setup_tool', principalId: 'amp_tool' };
    expect(await probe({ settings: PROTECT_DEFAULT, grants: tool })).toMatchObject({
      platform: true,
      system: true,
    });
  });

  it('lets exact-permission automation create and delete tenants and hand off invitations for an unprotected tenant, and refuses the protected one', async () => {
    const setup: Setup = {
      settings: PROTECT_DEFAULT,
      grants: { ...AUTOMATION, permissions: exact },
    };
    for (const [method, path, headers] of [
      ['POST', '/api/admin/tenants', {}],
      ['DELETE', '/api/admin/tenants/acme', {}],
      ['GET', '/api/admin/tenants/acme/provisioning', {}],
      ['POST', '/api/admin/admin-invitations', { 'X-Tenant-Id': 'acme' }],
    ] as const) {
      expect((await send(setup, method, path, { ...headers })).status, `${method} ${path}`).toBe(
        200
      );
    }
    for (const [method, path, headers] of [
      ['DELETE', '/api/admin/tenants/default', {}],
      ['POST', '/api/admin/admin-invitations', { 'X-Tenant-Id': 'default' }],
    ] as const) {
      expect((await send(setup, method, path, { ...headers })).status, `${method} ${path}`).toBe(
        403
      );
    }
  });
});

describe('a body is read whatever its Content-Type says', () => {
  const setup: Setup = { settings: PROTECT_DEFAULT };
  const named = JSON.stringify({ tenantId: 'default' });
  const path = '/api/admin/platform/control-plane/capacity/preview';

  it.each([
    ['text/plain', { 'Content-Type': 'text/plain' }],
    ['multipart/form-data', { 'Content-Type': 'multipart/form-data; boundary=x' }],
    ['application/x-www-form-urlencoded', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['a JSON type with parameters', { 'Content-Type': 'application/vnd.api+json' }],
  ])('refuses a protected tenant named in a %s body', async (_n, headers) => {
    // `send` adds application/json; the explicit header below replaces it.
    const response = await send(setup, 'POST', path, headers, named);
    expect(response.status).toBe(403);
  });

  it('refuses it with no Content-Type at all', async () => {
    const fx = await fixture(AUTOMATION, ['*']);
    const env = {
      ISSUER_URL: 'https://test.example.com',
      DEFAULT_TENANT_ID: 'default',
      DB: mockDb(AUTOMATION),
      DB_ADMIN: mockDb(AUTOMATION),
      PUBLIC_JWK_JSON: JSON.stringify(fx.publicJwk),
      ...PROTECT_DEFAULT,
    } as unknown as Env;
    const bytes = new TextEncoder().encode(named);
    const request = new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fx.token}` },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('Content-Type')).toBeNull();
    expect((await appFor(env).fetch(request)).status).toBe(403);
  });

  it('does not refuse an unprotected tenant, or a body that is not JSON, in any content type', async () => {
    const other = JSON.stringify({ tenantId: 'acme' });
    expect((await send(setup, 'POST', path, { 'Content-Type': 'text/plain' }, other)).status).toBe(
      200
    );
    expect(
      (await send(setup, 'POST', path, { 'Content-Type': 'text/plain' }, 'a=b&c=d')).status
    ).toBe(200);
  });
});
