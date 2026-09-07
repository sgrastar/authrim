import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAuthContext, Env } from '@authrim/ar-lib-core';
import type { AdminAgentLoginHandoffRecord } from '@authrim/ar-agent-access/core';

const mocks = vi.hoisted(() => ({
  auth: {} as AdminAuthContext,
  rootSession: null as Record<string, unknown> | null,
  targetAuth: null as AdminAuthContext | null,
  getLoginHandoffById: vi.fn(),
  issueLoginHandoff: vi.fn(),
  writeAudit: vi.fn(),
  queryOne: vi.fn(),
  targetIpAllowed: true,
}));

vi.mock('@authrim/ar-agent-access/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-agent-access/core')>();
  return {
    ...actual,
    AdminAgentAccessRepository: class {
      getLoginHandoffById = mocks.getLoginHandoffById;
      issueLoginHandoff = mocks.issueLoginHandoff;
      writeAudit = mocks.writeAudit;
    },
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware: vi.fn(
      () => async (c: { set(key: string, value: unknown): void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.auth);
        await next();
      }
    ),
    authenticateAdminSessionForTenant: vi.fn(() => Promise.resolve(mocks.targetAuth)),
    getRateLimitProfileAsync: vi.fn(() => Promise.resolve({ maxRequests: 10, windowSeconds: 60 })),
    rateLimitMiddleware: vi.fn(
      () => async (_c: unknown, next: () => Promise<Response | void>) => next()
    ),
    isAdminRequestIpAllowedForTenant: vi.fn(() => Promise.resolve(mocks.targetIpAllowed)),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({ queryOne: mocks.queryOne })),
  };
});

import { agentLoginHandoffsRouter } from '../routes/admin-management/agent-login-handoffs';

const handoffId = `alh_${'a'.repeat(32)}`;

function auth(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    userId: 'admin-1',
    authMethod: 'session',
    roles: ['super_admin'],
    permissions: ['admin:agent:use'],
    tenantId: 'default',
    tenantScope: ['*'],
    sessionId: 'session-root',
    sessionExpiresAt: Date.now() + 3_600_000,
    mfaVerified: true,
    ...overrides,
  };
}

function handoff(
  overrides: Partial<AdminAgentLoginHandoffRecord> = {}
): AdminAgentLoginHandoffRecord {
  return {
    id: handoffId,
    targetTenantId: 'tenant-1',
    targetOrigin: 'https://tenant.example.com',
    authorizationPath: '/oauth/admin-agent/authorize?request_uri=urn%3Atest',
    status: 'pending',
    browserBindingHash: 'browser-hash',
    lastTransitionId: 'transition-created',
    createdAt: Date.now() - 1_000,
    expiresAt: Date.now() + 120_000,
    ...overrides,
  };
}

function app() {
  const application = new Hono<{ Bindings: Env }>();
  application.use('*', async (c, next) => {
    c.set('requestId' as never, 'request-1' as never);
    await next();
  });
  application.route('/api/admin/agent-login-handoffs', agentLoginHandoffsRouter);
  return application;
}

describe('central Admin Agent login handoff approval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = auth();
    mocks.targetAuth = auth();
    mocks.rootSession = {
      id: 'session-root',
      tenant_id: 'default',
      admin_user_id: 'admin-1',
      expires_at: Date.now() + 3_600_000,
      mfa_verified: 1,
      parent_session_id: null,
    };
    mocks.queryOne.mockImplementation(() => Promise.resolve(mocks.rootSession));
    mocks.getLoginHandoffById.mockResolvedValue(handoff());
    mocks.issueLoginHandoff.mockResolvedValue(true);
    mocks.writeAudit.mockResolvedValue(undefined);
    mocks.targetIpAllowed = true;
  });

  it('issues a 60-second one-time code from the central root session', async () => {
    // Successful target-scoped RBAC evaluation is authoritative even when the source session's
    // summary scope remains its central tenant rather than a platform-wide wildcard.
    mocks.targetAuth = auth({ tenantScope: ['default'] });
    const before = Date.now();
    const response = await app().request(
      `/api/admin/agent-login-handoffs/${handoffId}/approve`,
      { method: 'POST' },
      {} as Env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as { consume_url: string };
    const consumeUrl = new URL(body.consume_url);
    expect(consumeUrl.origin).toBe('https://tenant.example.com');
    expect(consumeUrl.pathname).toBe('/oauth/admin-agent/login-handoff/consume');
    expect(consumeUrl.searchParams.get('code')).toMatch(/^ahc_[A-Za-z0-9_-]{43}$/u);
    expect(body.consume_url).not.toContain('session-root');

    const issued = mocks.issueLoginHandoff.mock.calls[0][0];
    expect(issued.sourceSessionId).toBe('session-root');
    expect(issued.adminUserId).toBe('admin-1');
    expect(issued.expiresAt).toBeGreaterThan(before);
    expect(issued.expiresAt).toBeLessThanOrEqual(before + 60_100);
    expect(issued.audit).toMatchObject({ action: 'agent.login_handoff.issued' });
  });

  it('rejects a child session so handoffs cannot create child-of-child chains', async () => {
    mocks.rootSession = { ...mocks.rootSession, parent_session_id: 'session-parent' };

    const response = await app().request(
      `/api/admin/agent-login-handoffs/${handoffId}/approve`,
      { method: 'POST' },
      {} as Env
    );

    expect(response.status).toBe(403);
    expect(mocks.issueLoginHandoff).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.login_handoff.denied',
        metadata: expect.objectContaining({ reason: 'source_session_not_root' }),
      })
    );
  });

  it('revalidates live target-tenant permission before issuing', async () => {
    mocks.targetAuth = auth({ permissions: [] });

    const response = await app().request(
      `/api/admin/agent-login-handoffs/${handoffId}/approve`,
      { method: 'POST' },
      {} as Env
    );

    expect(response.status).toBe(403);
    expect(mocks.issueLoginHandoff).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'target_tenant_authorization_denied' }),
      })
    );
  });

  it('enforces the target tenant IP allowlist using the forwarded browser address', async () => {
    mocks.targetIpAllowed = false;

    const response = await app().request(
      `/api/admin/agent-login-handoffs/${handoffId}/approve`,
      { method: 'POST' },
      {} as Env
    );

    expect(response.status).toBe(403);
    expect(mocks.issueLoginHandoff).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'target_tenant_ip_denied' }),
      })
    );
  });

  it.each([
    ['missing', null],
    ['expired', handoff({ expiresAt: Date.now() - 1 })],
    ['already issued', handoff({ status: 'issued' })],
  ])('returns a uniform terminal response for a %s handoff', async (_label, value) => {
    mocks.getLoginHandoffById.mockResolvedValue(value);
    const response = await app().request(
      `/api/admin/agent-login-handoffs/${handoffId}/approve`,
      { method: 'POST' },
      {} as Env
    );

    expect(response.status).toBe(410);
    expect(mocks.issueLoginHandoff).not.toHaveBeenCalled();
  });

  it('returns 410 without leaking a code when the issue CAS loses a replay race', async () => {
    mocks.issueLoginHandoff.mockResolvedValue(false);
    const response = await app().request(
      `/api/admin/agent-login-handoffs/${handoffId}/approve`,
      { method: 'POST' },
      {} as Env
    );

    expect(response.status).toBe(410);
    expect(await response.text()).not.toContain('ahc_');
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: 'issue_replay_or_expired' }),
      })
    );
  });

  it('fails closed for a corrupted target origin', async () => {
    mocks.getLoginHandoffById.mockResolvedValue(
      handoff({ targetOrigin: 'https://user@tenant.example.com' })
    );
    const response = await app().request(
      `/api/admin/agent-login-handoffs/${handoffId}/approve`,
      { method: 'POST' },
      {} as Env
    );

    expect(response.status).toBe(410);
    expect(mocks.issueLoginHandoff).not.toHaveBeenCalled();
  });
});
