import { Hono, type Handler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import {
  hashAdminAgentLoginHandoffBrowserBinding,
  hashAdminAgentLoginHandoffCode,
  hashAdminAgentLoginHandoffSession,
  type AdminAgentAccessRepository,
  type AdminAgentLoginHandoffRecord,
} from '@authrim/ar-agent-access/core';

type RepoArg<K extends keyof AdminAgentAccessRepository> = AdminAgentAccessRepository[K] extends (
  input: infer A,
  ...rest: never[]
) => unknown
  ? A
  : never;

const mocks = vi.hoisted(() => ({
  createLoginHandoff: vi.fn<(input: RepoArg<'createLoginHandoff'>) => Promise<unknown>>(),
  getLoginHandoffByCodeHash: vi.fn(),
  consumeLoginHandoff: vi.fn<(input: RepoArg<'consumeLoginHandoff'>) => Promise<unknown>>(),
  purgeLoginHandoffs: vi.fn<(before: number) => Promise<unknown>>(),
  writeAudit: vi.fn(),
  authenticateAdminSessionForTenant: vi.fn(),
  currentTenantId: 'tenant-1',
  currentIssuer: 'https://tenant.example.com',
  targetIpAllowed: true,
}));

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    AdminAgentAccessRepository: class {
      createLoginHandoff = mocks.createLoginHandoff;
      getLoginHandoffByCodeHash = mocks.getLoginHandoffByCodeHash;
      consumeLoginHandoff = mocks.consumeLoginHandoff;
      purgeLoginHandoffs = mocks.purgeLoginHandoffs;
      writeAudit = mocks.writeAudit;
    },
  };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => mocks.currentTenantId),
    requireAdminDatabaseAdapter: vi.fn(() => ({})),
    authenticateAdminSessionForTenant: mocks.authenticateAdminSessionForTenant,
    isAdminRequestIpAllowedForTenant: vi.fn(() => Promise.resolve(mocks.targetIpAllowed)),
  };
});
vi.mock('../issuer', () => ({ getRequestIssuer: vi.fn(() => mocks.currentIssuer) }));

import {
  adminAgentHandoffCookieName,
  adminAgentLoginHandoffConsumeHandler,
  buildAdminAgentHandoffLoginUrl,
  createAdminAgentLoginHandoff,
} from '../admin-agent-login-handoff';

const handoffId = `alh_${'a'.repeat(16)}${'c'.repeat(16)}`;
const code = `ahc_${'b'.repeat(43)}`;
const secret = 'browser-secret';
const TENANT = 'https://tenant.example.com';

function appWith(handler: Handler<{ Bindings: Env }>, method: 'get' | 'post' = 'get') {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('requestId' as never, 'request-1');
    await next();
  });
  app[method]('*', handler);
  app.onError((error, c) => c.json({ thrown: error.message }, 500));
  return app;
}
const env = { ADMIN_UI_URL: 'https://admin.example.com' } as Env;

async function record(overrides: Partial<AdminAgentLoginHandoffRecord> = {}) {
  return {
    id: handoffId,
    targetTenantId: 'tenant-1',
    targetOrigin: TENANT,
    authorizationPath: '/oauth/admin-agent/authorize?request_uri=urn%3Atest',
    status: 'issued',
    browserBindingHash: await hashAdminAgentLoginHandoffBrowserBinding(handoffId, secret),
    sourceSessionId: 'session-secret',
    sourceSessionHash: await hashAdminAgentLoginHandoffSession('session-secret'),
    adminUserId: 'admin-1',
    codeHash: await hashAdminAgentLoginHandoffCode(code),
    lastTransitionId: 't',
    createdAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000,
    issuedAt: Date.now() - 500,
    ...overrides,
  } as AdminAgentLoginHandoffRecord;
}

function live(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    userId: 'admin-1',
    authMethod: 'session',
    roles: ['ar_super_admin'],
    permissions: ['*'],
    tenantId: 'tenant-1',
    sessionId: 'session-secret',
    sessionExpiresAt: Date.now() + 3_600_000,
    mfaVerified: true,
    ...overrides,
  };
}

async function consume(headers: Record<string, string> = {}, query = `?code=${code}`) {
  const cookie = `${adminAgentHandoffCookieName(handoffId)}=${secret}`;
  const response = await appWith(adminAgentLoginHandoffConsumeHandler).fetch(
    new Request(`${TENANT}/oauth/admin-agent/login-handoff/consume${query}`, {
      headers: { cookie, ...headers },
    }),
    env
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

function deniedReason(): unknown {
  return mocks.writeAudit.mock.calls[0]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentTenantId = 'tenant-1';
  mocks.currentIssuer = TENANT;
  mocks.targetIpAllowed = true;
  mocks.createLoginHandoff.mockResolvedValue(undefined);
  mocks.purgeLoginHandoffs.mockResolvedValue(0);
  mocks.consumeLoginHandoff.mockResolvedValue(true);
  mocks.authenticateAdminSessionForTenant.mockResolvedValue(live());
});

describe('login handoff creation', () => {
  it('names the binding cookie after the last 16 characters of the handoff id', () => {
    expect(adminAgentHandoffCookieName(handoffId)).toBe(`authrim_agent_handoff_${'c'.repeat(16)}`);
  });

  it('refuses a malformed handoff id when building the login URL', () => {
    expect(() => buildAdminAgentHandoffLoginUrl('alh_short', 'https://admin.example.com')).toThrow(
      'Invalid Admin Agent login handoff identifier'
    );
    expect(() => buildAdminAgentHandoffLoginUrl(handoffId, 'not a url')).toThrow(
      'ADMIN_UI_URL must be an HTTPS origin without userinfo'
    );
    expect(() =>
      buildAdminAgentHandoffLoginUrl(handoffId, 'https://:pw@admin.example.com')
    ).toThrow('ADMIN_UI_URL must be an HTTPS origin without userinfo');
    expect(() => buildAdminAgentHandoffLoginUrl(handoffId, '')).toThrow('ADMIN_UI_URL is required');
  });

  it.each([
    ['a non-GET request', 'post', `${TENANT}/oauth/admin-agent/authorize?x=1`],
    ['another path', 'get', `${TENANT}/oauth/admin-agent/other?x=1`],
    ['an overlong query', 'get', `${TENANT}/oauth/admin-agent/authorize?x=${'a'.repeat(16_400)}`],
  ] as const)('rejects %s as continuation', async (_label, method, url) => {
    const app = appWith(async (c) => c.text(await createAdminAgentLoginHandoff(c)), method);
    const response = await app.fetch(new Request(url, { method: method.toUpperCase() }), env);
    expect(await response.json()).toEqual({
      thrown: 'Invalid Admin Agent authorization continuation',
    });
    expect(mocks.createLoginHandoff).not.toHaveBeenCalled();
  });

  it('stores a five-minute pending handoff with an audit entry and purges old ones', async () => {
    const before = Date.now();
    const app = appWith(async (c) => c.text(await createAdminAgentLoginHandoff(c)));
    const response = await app.fetch(new Request(`${TENANT}/oauth/admin-agent/authorize?a=1`), env);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const input = mocks.createLoginHandoff.mock.calls[0][0];
    expect(input.expiresAt - input.createdAt).toBe(300_000);
    expect(input.transitionId).toMatch(/^transition_/);
    expect(input.audit).toMatchObject({
      tenantId: 'tenant-1',
      action: 'agent.login_handoff.created',
      resourceType: 'admin_agent_login_handoff',
      resourceId: input.id,
      severity: 'info',
      requestId: 'request-1',
      actorType: 'system',
      actorSub: 'admin-agent-authorize',
      metadata: { target_tenant_id: 'tenant-1', target_origin: TENANT, browser_bound: true },
    });
    expect(await response.text()).toBe(
      `https://admin.example.com/admin/login?agent_handoff=${input.id}`
    );
    const cookie = response.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain('Path=/oauth/admin-agent/login-handoff/consume');
    expect(cookie).toContain('Max-Age=300');
    const cutoff = mocks.purgeLoginHandoffs.mock.calls[0][0];
    expect(input.createdAt - cutoff).toBe(86_400_000);
    expect(cutoff).toBeGreaterThanOrEqual(before - 86_400_000);
  });

  it('does not fail the redirect when purging old handoffs fails', async () => {
    mocks.purgeLoginHandoffs.mockRejectedValue(new Error('db'));
    const app = appWith(async (c) => c.text(await createAdminAgentLoginHandoff(c)));
    const response = await app.fetch(new Request(`${TENANT}/oauth/admin-agent/authorize?a=1`), env);
    expect(response.status).toBe(200);
  });
});

describe('login handoff consumption', () => {
  it('rejects a malformed code without a lookup', async () => {
    const result = await consume({}, '?code=nope');
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: 'invalid_request',
      error_description: 'Invalid login handoff code.',
    });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.getLoginHandoffByCodeHash).not.toHaveBeenCalled();
    expect((await consume({}, '')).status).toBe(400);
  });

  it('reports an unknown code as gone', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(null);
    const result = await consume();
    expect(result.status).toBe(410);
    expect(result.body).toEqual({
      error: 'invalid_request',
      error_description: 'Login handoff is unavailable or expired.',
    });
    expect(mocks.getLoginHandoffByCodeHash).toHaveBeenCalledWith(
      await hashAdminAgentLoginHandoffCode(code)
    );
  });

  it.each([
    ['another origin', `https://evil.example.com/oauth/admin-agent/authorize`],
    ['another path', '/oauth/admin-agent/other?x=1'],
    ['a fragment', '/oauth/admin-agent/authorize?x=1#frag'],
  ])('denies a stored continuation pointing to %s', async (_label, authorizationPath) => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(await record({ authorizationPath }));
    const result = await consume();
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: 'invalid_request',
      error_description: 'Invalid authorization continuation.',
    });
    expect(deniedReason()).toMatchObject({
      action: 'agent.login_handoff.denied',
      resourceType: 'admin_agent_login_handoff',
      resourceId: handoffId,
      tenantId: 'tenant-1',
      result: 'failure',
      severity: 'warn',
      requestId: 'request-1',
      actorType: 'system',
      actorSub: 'admin-agent-login-handoff',
      adminUserId: undefined,
      metadata: {
        target_tenant_id: 'tenant-1',
        target_origin: TENANT,
        browser_bound: true,
        reason: 'invalid_authorization_continuation',
      },
    });
    const cleared = result.headers.get('Set-Cookie') ?? '';
    expect(cleared).toContain(`${adminAgentHandoffCookieName(handoffId)}=`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/oauth/admin-agent/login-handoff/consume');
  });

  it.each([
    ['a non-issued status', { status: 'consumed' }, {}],
    ['an expired handoff', { expiresAt: Date.now() - 1 }, {}],
    ['another tenant', {}, { tenant: 'tenant-2' }],
    ['another issuer origin', {}, { issuer: 'https://other.example.com' }],
    ['no browser cookie', {}, { noCookie: true }],
    ['a missing source session', { sourceSessionId: null }, {}],
    ['a missing source session hash', { sourceSessionHash: null }, {}],
    ['a missing admin user', { adminUserId: null }, {}],
  ] as const)('denies %s as binding_or_target_mismatch', async (_l, overrides, ctx) => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(
      await record(overrides as Partial<AdminAgentLoginHandoffRecord>)
    );
    if ('tenant' in ctx) mocks.currentTenantId = ctx.tenant;
    if ('issuer' in ctx) mocks.currentIssuer = ctx.issuer;
    const result = await consume('noCookie' in ctx ? { cookie: '' } : {});
    expect(result.status).toBe(410);
    expect(result.body).toMatchObject({
      error_description: 'Login handoff is unavailable or expired.',
    });
    expect(deniedReason()).toMatchObject({ metadata: { reason: 'binding_or_target_mismatch' } });
    expect(mocks.authenticateAdminSessionForTenant).not.toHaveBeenCalled();
  });

  it.each([
    ['no live admin', null],
    ['a token-authenticated admin', live({ authMethod: 'bearer' })],
    ['another admin user', live({ userId: 'admin-2' })],
    ['an admin without MFA', live({ mfaVerified: false })],
    ['a session without expiry', live({ sessionExpiresAt: undefined })],
  ])('denies %s as source_session_invalid', async (_label, admin) => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(await record());
    mocks.authenticateAdminSessionForTenant.mockResolvedValue(admin);
    const result = await consume();
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: 'access_denied',
      error_description: 'The Admin session is no longer valid.',
    });
    expect(deniedReason()).toMatchObject({
      adminUserId: 'admin-1',
      actorType: 'admin_user',
      actorSub: 'admin-1',
      metadata: { reason: 'source_session_invalid' },
    });
    expect(mocks.consumeLoginHandoff).not.toHaveBeenCalled();
  });

  it('denies a session hash that does not match the stored one', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(await record({ sourceSessionHash: 'other' }));
    const result = await consume();
    expect(result.status).toBe(403);
    expect(mocks.authenticateAdminSessionForTenant).toHaveBeenCalledWith(
      expect.anything(),
      'session-secret',
      expect.arrayContaining(['ar_super_admin']),
      'tenant-1'
    );
  });

  it('denies a target tenant whose IP policy refuses the request', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(await record());
    mocks.targetIpAllowed = false;
    const result = await consume();
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: 'access_denied',
      error_description: 'Admin access is not allowed for this tenant.',
    });
    expect(deniedReason()).toMatchObject({ metadata: { reason: 'target_tenant_ip_denied' } });
  });

  it('reports a replayed consume as gone', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(await record());
    mocks.consumeLoginHandoff.mockResolvedValue(false);
    const result = await consume();
    expect(result.status).toBe(410);
    expect(result.body).toEqual({
      error: 'invalid_request',
      error_description: 'Login handoff was already used or expired.',
    });
    expect(deniedReason()).toMatchObject({
      adminUserId: 'admin-1',
      metadata: { reason: 'consume_replay_or_expired' },
    });
  });

  it('refuses to mint a cookie for a session that ends within the second', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(await record());
    mocks.authenticateAdminSessionForTenant.mockResolvedValue(
      live({ sessionExpiresAt: Date.now() + 500 })
    );
    const result = await consume();
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: 'access_denied' });
    expect(result.headers.get('Set-Cookie') ?? '').not.toContain('authrim_admin_session=');
  });

  it('consumes into a child session and redirects to the continuation', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(await record());
    mocks.authenticateAdminSessionForTenant.mockResolvedValue(
      live({ tenantId: undefined, authenticationTimeMs: 1234, passkeyCredentialId: 'pk-1' })
    );
    const result = await consume({
      'X-Forwarded-For': ' 198.51.100.1 , 10.0.0.1',
      'User-Agent': 'UA',
    });
    expect(result.status).toBe(302);
    expect(result.headers.get('Location')).toBe(
      `${TENANT}/oauth/admin-agent/authorize?request_uri=urn%3Atest`
    );
    const input = mocks.consumeLoginHandoff.mock.calls[0][0];
    expect(input).toMatchObject({
      id: handoffId,
      targetTenantId: 'tenant-1',
      codeHash: await hashAdminAgentLoginHandoffCode(code),
      targetSession: {
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        parentSessionId: 'session-secret',
        parentSessionHash: await hashAdminAgentLoginHandoffSession('session-secret'),
        ipAddress: '198.51.100.1',
        userAgent: 'UA',
        createdAt: 1234,
        mfaVerifiedAt: 1234,
        passkeyCredentialId: 'pk-1',
      },
      audit: {
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        action: 'agent.login_handoff.consumed',
        resourceType: 'admin_agent_login_handoff',
        resourceId: handoffId,
        severity: 'info',
        actorType: 'admin_user',
        actorSub: 'admin-1',
        metadata: { target_tenant_id: 'tenant-1', target_origin: TENANT, browser_bound: true },
      },
    });
    expect(input.targetSession.id).toMatch(/^ash_/);
    const cookies = result.headers.getSetCookie();
    const session = cookies.find((value) => value.startsWith('authrim_admin_session='))!;
    expect(session).toContain(`authrim_admin_session=${input.targetSession.id}`);
    expect(session).toMatch(/Max-Age=(3600|3599|3598)\b/);
    expect(session).toContain('Path=/');
    expect(session).toContain('HttpOnly');
    expect(cookies.some((value) => value.startsWith(adminAgentHandoffCookieName(handoffId)))).toBe(
      true
    );
  });

  it('prefers the Cloudflare client IP and defaults timing fields to now', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(await record());
    const before = Date.now();
    await consume({ 'CF-Connecting-IP': '203.0.113.9', 'X-Forwarded-For': '198.51.100.1' });
    const session = mocks.consumeLoginHandoff.mock.calls[0][0].targetSession;
    expect(session.ipAddress).toBe('203.0.113.9');
    expect(session.createdAt).toBeGreaterThanOrEqual(before);
    expect(session.mfaVerifiedAt).toBe(session.createdAt);
    expect(session.passkeyCredentialId).toBeNull();
  });
});
