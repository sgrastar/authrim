import { Hono, type Handler } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import { sha256Base64Url, type AdminAgentLoginHandoffRecord } from '@authrim/ar-agent-access/core';

const mocks = vi.hoisted(() => ({
  createLoginHandoff: vi.fn(),
  getLoginHandoffByCodeHash: vi.fn(),
  consumeLoginHandoff: vi.fn(),
  purgeLoginHandoffs: vi.fn(),
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
    adminAuthContextHasTenantScope: vi.fn(
      (context: AdminAuthContext, tenantId: string) =>
        context.tenantId === tenantId || context.tenantScope?.includes('*') === true
    ),
  };
});

vi.mock('../issuer', () => ({
  getRequestIssuer: vi.fn(() => mocks.currentIssuer),
}));

import {
  adminAgentHandoffCookieName,
  adminAgentLoginHandoffConsumeHandler,
  buildAdminAgentHandoffLoginUrl,
  createAdminAgentLoginHandoff,
} from '../admin-agent-login-handoff';

const handoffId = `alh_${'a'.repeat(32)}`;
const handoffCode = `ahc_${'b'.repeat(43)}`;
const browserSecret = 'browser-secret';

function appWith(handler: Handler<{ Bindings: Env }>) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, mocks.currentTenantId as never);
    c.set('requestId' as never, 'request-1' as never);
    await next();
  });
  app.get('*', handler);
  return app;
}

function env(): Env {
  return {
    ADMIN_UI_URL: 'https://admin.example.com',
  } as Env;
}

function handoff(
  overrides: Partial<AdminAgentLoginHandoffRecord> = {}
): AdminAgentLoginHandoffRecord {
  return {
    id: handoffId,
    targetTenantId: 'tenant-1',
    targetOrigin: 'https://tenant.example.com',
    authorizationPath: '/oauth/admin-agent/authorize?request_uri=urn%3Atest',
    status: 'issued',
    browserBindingHash: '',
    sourceSessionId: 'session-secret',
    sourceSessionHash: '',
    adminUserId: 'admin-1',
    codeHash: '',
    lastTransitionId: 'transition-issued',
    createdAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    issuedAt: Date.now() - 500,
    ...overrides,
  };
}

function liveAdmin(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    userId: 'admin-1',
    authMethod: 'session',
    roles: ['super_admin'],
    permissions: ['*'],
    tenantId: 'tenant-1',
    tenantScope: ['*'],
    sessionId: 'session-secret',
    sessionExpiresAt: Date.now() + 3_600_000,
    mfaVerified: true,
    ...overrides,
  };
}

describe('Admin Agent login handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentTenantId = 'tenant-1';
    mocks.currentIssuer = 'https://tenant.example.com';
    mocks.createLoginHandoff.mockResolvedValue(undefined);
    mocks.purgeLoginHandoffs.mockResolvedValue(0);
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.consumeLoginHandoff.mockResolvedValue(true);
    mocks.authenticateAdminSessionForTenant.mockResolvedValue(liveAdmin());
    mocks.targetIpAllowed = true;
  });

  it('stores a hashed browser binding and redirects with only an opaque handoff id', async () => {
    const app = appWith(async (c) => c.redirect(await createAdminAgentLoginHandoff(c), 302));
    const response = await app.fetch(
      new Request('https://tenant.example.com/oauth/admin-agent/authorize?request_uri=urn%3Atest'),
      env()
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location')!);
    expect(location.origin).toBe('https://admin.example.com');
    expect(location.pathname).toBe('/admin/login');
    expect(location.searchParams.get('return_to')).toBeNull();
    expect(location.searchParams.get('agent_handoff')).toMatch(/^alh_[A-Za-z0-9_-]{32}$/u);
    expect(mocks.createLoginHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        targetTenantId: 'tenant-1',
        targetOrigin: 'https://tenant.example.com',
        authorizationPath: '/oauth/admin-agent/authorize?request_uri=urn%3Atest',
        browserBindingHash: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      })
    );
    const setCookie = response.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Domain=');
  });

  it.each([undefined, 'http://admin.example.com', 'https://user@admin.example.com'])(
    'fails closed before creating a handoff when ADMIN_UI_URL is invalid: %s',
    async (adminUiUrl) => {
      const app = appWith(async (c) => c.redirect(await createAdminAgentLoginHandoff(c), 302));
      const response = await app.fetch(
        new Request(
          'https://tenant.example.com/oauth/admin-agent/authorize?request_uri=urn%3Atest'
        ),
        { ...env(), ADMIN_UI_URL: adminUiUrl } as Env
      );

      expect(response.status).toBe(500);
      expect(mocks.createLoginHandoff).not.toHaveBeenCalled();
    }
  );

  it('builds the login URL only from the configured central Admin origin', () => {
    expect(buildAdminAgentHandoffLoginUrl(handoffId, 'https://admin.example.com/path')).toBe(
      `https://admin.example.com/admin/login?agent_handoff=${handoffId}`
    );
  });

  it('rejects a stolen handoff code without the tenant browser binding cookie', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(
      handoff({
        codeHash: await sha256Base64Url(`authrim-admin-agent-handoff-code-v1\0${handoffCode}`),
        browserBindingHash: await sha256Base64Url(
          `authrim-admin-agent-handoff-browser-v1\0${handoffId}\0${browserSecret}`
        ),
      })
    );
    const app = appWith(adminAgentLoginHandoffConsumeHandler);
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${handoffCode}`
      ),
      env()
    );

    expect(response.status).toBe(410);
    expect(mocks.authenticateAdminSessionForTenant).not.toHaveBeenCalled();
    expect(mocks.consumeLoginHandoff).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.login_handoff.denied',
        metadata: expect.objectContaining({ reason: 'binding_or_target_mismatch' }),
      })
    );
  });

  it('revalidates the source session and consumes once on the exact target issuer', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(
      handoff({
        codeHash: await sha256Base64Url(`authrim-admin-agent-handoff-code-v1\0${handoffCode}`),
        browserBindingHash: await sha256Base64Url(
          `authrim-admin-agent-handoff-browser-v1\0${handoffId}\0${browserSecret}`
        ),
        sourceSessionHash: await sha256Base64Url(
          'authrim-admin-agent-handoff-session-v1\0session-secret'
        ),
      })
    );
    const cookieName = adminAgentHandoffCookieName(handoffId);
    const app = appWith(adminAgentLoginHandoffConsumeHandler);
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${handoffCode}`,
        { headers: { Cookie: `${cookieName}=${browserSecret}` } }
      ),
      env()
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(
      'https://tenant.example.com/oauth/admin-agent/authorize?request_uri=urn%3Atest'
    );
    expect(mocks.authenticateAdminSessionForTenant).toHaveBeenCalledWith(
      expect.anything(),
      'session-secret',
      expect.any(Array),
      'tenant-1'
    );
    expect(mocks.consumeLoginHandoff).toHaveBeenCalledTimes(1);
    expect(mocks.consumeLoginHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSession: expect.objectContaining({
          adminUserId: 'admin-1',
          parentSessionId: 'session-secret',
          expiresAt: expect.any(Number),
        }),
      })
    );
    const setCookie = response.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toMatch(/authrim_admin_session=ash_[A-Za-z0-9_-]{43}/u);
    expect(setCookie).not.toContain('authrim_admin_session=session-secret');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('Domain=');
  });

  it('fails closed when the source Admin session was revoked', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(
      handoff({
        browserBindingHash: await sha256Base64Url(
          `authrim-admin-agent-handoff-browser-v1\0${handoffId}\0${browserSecret}`
        ),
        sourceSessionHash: await sha256Base64Url(
          'authrim-admin-agent-handoff-session-v1\0session-secret'
        ),
      })
    );
    mocks.authenticateAdminSessionForTenant.mockResolvedValue(null);
    const cookieName = adminAgentHandoffCookieName(handoffId);
    const app = appWith(adminAgentLoginHandoffConsumeHandler);
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${handoffCode}`,
        { headers: { Cookie: `${cookieName}=${browserSecret}` } }
      ),
      env()
    );

    expect(response.status).toBe(403);
    expect(mocks.consumeLoginHandoff).not.toHaveBeenCalled();
    expect(response.headers.get('Set-Cookie')).not.toContain('authrim_admin_session=');
  });

  it('does not establish a tenant session when the target IP allowlist rejects the browser', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(
      handoff({
        browserBindingHash: await sha256Base64Url(
          `authrim-admin-agent-handoff-browser-v1\0${handoffId}\0${browserSecret}`
        ),
        sourceSessionHash: await sha256Base64Url(
          'authrim-admin-agent-handoff-session-v1\0session-secret'
        ),
      })
    );
    mocks.targetIpAllowed = false;
    const cookieName = adminAgentHandoffCookieName(handoffId);
    const response = await appWith(adminAgentLoginHandoffConsumeHandler).fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${handoffCode}`,
        { headers: { Cookie: `${cookieName}=${browserSecret}` } }
      ),
      env()
    );

    expect(response.status).toBe(403);
    expect(mocks.consumeLoginHandoff).not.toHaveBeenCalled();
    expect(response.headers.get('Set-Cookie')).not.toContain('authrim_admin_session=');
  });

  it('rejects a valid code presented on another tenant issuer', async () => {
    mocks.currentTenantId = 'tenant-2';
    mocks.currentIssuer = 'https://other.example.com';
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(
      handoff({
        browserBindingHash: await sha256Base64Url(
          `authrim-admin-agent-handoff-browser-v1\0${handoffId}\0${browserSecret}`
        ),
      })
    );
    const cookieName = adminAgentHandoffCookieName(handoffId);
    const app = appWith(adminAgentLoginHandoffConsumeHandler);
    const response = await app.fetch(
      new Request(
        `https://other.example.com/oauth/admin-agent/login-handoff/consume?code=${handoffCode}`,
        { headers: { Cookie: `${cookieName}=${browserSecret}` } }
      ),
      env()
    );

    expect(response.status).toBe(410);
    expect(mocks.consumeLoginHandoff).not.toHaveBeenCalled();
  });

  it('rejects an open-redirect continuation before consuming the handoff', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(
      handoff({ authorizationPath: '//evil.example/oauth/admin-agent/authorize' })
    );
    const app = appWith(adminAgentLoginHandoffConsumeHandler);
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${handoffCode}`
      ),
      env()
    );

    expect(response.status).toBe(400);
    expect(mocks.authenticateAdminSessionForTenant).not.toHaveBeenCalled();
    expect(mocks.consumeLoginHandoff).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'invalid_authorization_continuation' }),
      })
    );
  });

  it('does not establish a session when the consume CAS loses a replay race', async () => {
    mocks.getLoginHandoffByCodeHash.mockResolvedValue(
      handoff({
        browserBindingHash: await sha256Base64Url(
          `authrim-admin-agent-handoff-browser-v1\0${handoffId}\0${browserSecret}`
        ),
        sourceSessionHash: await sha256Base64Url(
          'authrim-admin-agent-handoff-session-v1\0session-secret'
        ),
      })
    );
    mocks.consumeLoginHandoff.mockResolvedValue(false);
    const cookieName = adminAgentHandoffCookieName(handoffId);
    const app = appWith(adminAgentLoginHandoffConsumeHandler);
    const response = await app.fetch(
      new Request(
        `https://tenant.example.com/oauth/admin-agent/login-handoff/consume?code=${handoffCode}`,
        { headers: { Cookie: `${cookieName}=${browserSecret}` } }
      ),
      env()
    );

    expect(response.status).toBe(410);
    expect(response.headers.get('Set-Cookie')).not.toContain('authrim_admin_session=');
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'consume_replay_or_expired' }),
      })
    );
  });
});
