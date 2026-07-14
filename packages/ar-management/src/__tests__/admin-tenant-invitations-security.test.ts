import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  ensureTenant: vi.fn(),
  requireAccess: vi.fn(),
  audit: vi.fn(),
  sendEmail: vi.fn(),
  getNotifier: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const statusByCode: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: 404,
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    createAuthContextFromHono: () => ({
      coreAdapter: {
        queryOne: mocks.queryOne,
        query: mocks.query,
        execute: mocks.execute,
      },
    }),
    createAuditLogFromContext: mocks.audit,
    getRequiredPluginContext: () => ({ registry: { getNotifier: mocks.getNotifier } }),
    getLogger: () => ({ module: () => ({ warn: mocks.logWarn, error: mocks.logError }) }),
    createErrorResponse: (
      c: { json: (body: unknown, status?: number) => Response },
      code: string
    ) => c.json({ error_code: code }, statusByCode[code] ?? 500),
  };
});

vi.mock('../single-tenant-guard', () => ({ ensureSupportedTenantId: mocks.ensureTenant }));
vi.mock('../admin-tenant-access', () => ({ requireTenantResourceAccess: mocks.requireAccess }));
vi.mock('../request-issuer', () => ({
  getCanonicalTenantBaseUrl: (_env: unknown, tenantId: string) =>
    `https://${tenantId}.example.test`,
}));

import { AR_ERROR_CODES } from '@authrim/ar-lib-core';
import {
  cancelTenantInvitationHandler,
  createTenantInvitationHandler,
  listTenantInvitationsHandler,
} from '../admin-tenant-invitations';

function app() {
  const instance = new Hono<{
    Bindings: { EMAIL_FROM?: string };
    Variables: { adminAuth: { adminId: string } };
  }>();
  instance.use('*', async (c, next) => {
    c.set('adminAuth', { adminId: 'admin-actor' });
    await next();
  });
  instance.post('/tenants/:id/invitations', createTenantInvitationHandler as never);
  instance.get('/tenants/:id/invitations', listTenantInvitationsHandler as never);
  instance.delete('/tenants/:id/invitations/:inv_id', cancelTenantInvitationHandler as never);
  return instance;
}

function invitationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invitation-a',
    token: 'secret-token',
    tenant_id: 'tenant-a',
    invited_email: 'user@example.test',
    invited_by: 'admin-actor',
    role_id: null,
    org_id: null,
    max_uses: 1,
    use_count: 0,
    expires_at: 2_000_000_000,
    created_at: 1_900_000_000,
    updated_at: 1_900_000_000,
    ...overrides,
  };
}

describe('tenant invitation security behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.ensureTenant.mockResolvedValue(null);
    mocks.requireAccess.mockResolvedValue(null);
    mocks.getNotifier.mockReturnValue({ send: mocks.sendEmail });
    mocks.sendEmail.mockResolvedValue({ success: true });
    mocks.execute.mockResolvedValue({ rowsAffected: 1 });
    mocks.query.mockResolvedValue([]);
    mocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants')) return { id: 'tenant-a', name: 'Tenant A' };
      if (sql.includes('FROM roles')) return { id: 'role-a' };
      if (sql.includes('FROM organizations')) return { id: 'org-a' };
      if (sql.includes('COUNT(*)')) return { count: 0 };
      if (sql.includes('FROM tenant_invitations')) return { id: 'invitation-a' };
      return null;
    });
  });

  it.each(['POST', 'GET', 'DELETE'])(
    'stops before storage when tenant mode rejects %s',
    async (method) => {
      mocks.ensureTenant.mockResolvedValue(new Response('unsupported', { status: 404 }));
      const path =
        method === 'DELETE'
          ? '/tenants/tenant-b/invitations/invitation-a'
          : '/tenants/tenant-b/invitations';
      const response = await app().request(path, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      });
      expect(response.status).toBe(404);
      expect(mocks.requireAccess).not.toHaveBeenCalled();
      expect(mocks.queryOne).not.toHaveBeenCalled();
    }
  );

  it.each(['POST', 'GET', 'DELETE'])(
    'denies cross-tenant access before storage for %s',
    async (method) => {
      mocks.requireAccess.mockResolvedValue(new Response('forbidden', { status: 403 }));
      const path =
        method === 'DELETE'
          ? '/tenants/tenant-b/invitations/invitation-a'
          : '/tenants/tenant-b/invitations';
      const response = await app().request(path, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      });
      expect(response.status).toBe(403);
      expect(mocks.queryOne).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    }
  );

  it.each([
    { invited_email: 'not-email' },
    { role_id: '' },
    { org_id: 'x'.repeat(64) },
    { max_uses: -2 },
    { max_uses: 1001 },
    { max_uses: 1.5 },
    { expires_in_hours: 0 },
    { expires_in_hours: 721 },
  ])('rejects malformed invitation input %# before tenant lookup', async (body) => {
    const response = await app().request('/tenants/tenant-a/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(mocks.queryOne).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('requires an existing tenant before generating a privilege-bearing invitation', async () => {
    mocks.queryOne.mockResolvedValue(null);
    const response = await app().request('/tenants/tenant-a/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    [{ role_id: 'role-b' }, 'roles'],
    [{ org_id: 'org-b' }, 'organizations'],
  ])('rejects a foreign or inactive assignment target %#', async (body, table) => {
    mocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants')) return { id: 'tenant-a', name: 'Tenant A' };
      if (sql.includes(`FROM ${table}`)) return null;
      return { id: 'valid' };
    });
    const response = await app().request('/tenants/tenant-a/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('stores a tenant-scoped invitation, returns its token once and audits the assignment', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T00:00:00.000Z'));
    const response = await app().request(
      '/tenants/tenant-a/invitations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role_id: 'role-a',
          org_id: 'org-a',
          max_uses: 2,
          expires_in_hours: 24,
        }),
      },
      { EMAIL_FROM: 'security@example.test' }
    );
    expect(response.status).toBe(201);
    const body = await response.json<{ token: string; invite_url: string; email_sent: boolean }>();
    expect(body.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.invite_url).toContain(`invite_token=${body.token}`);
    expect(body.email_sent).toBe(false);
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tenant_invitations'),
      expect.arrayContaining(['tenant-a', 'admin-actor', 'role-a', 'org-a', 2])
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'tenant_invitation.create',
      'tenant_invitation',
      expect.any(String),
      expect.objectContaining({ tenant_id: 'tenant-a', role_id: 'role-a', org_id: 'org-a' })
    );
  });

  it('escapes tenant-controlled HTML and sends an email without leaking the token to audit metadata', async () => {
    mocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants')) {
        return { id: 'tenant-a', name: '<img src=x onerror=alert(1)>\r\nBcc: attacker@test' };
      }
      return null;
    });
    const response = await app().request(
      '/tenants/tenant-a/invitations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invited_email: 'user@example.test' }),
      },
      {}
    );
    expect(response.status).toBe(201);
    const email = mocks.sendEmail.mock.calls[0]?.[0] as {
      body: string;
      metadata: { textBody: string };
      subject: string;
      to: string;
    };
    expect(email.to).toBe('user@example.test');
    expect(email.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.body).not.toContain('<img src=x');
    expect(email.subject).not.toMatch(/[\r\n]/u);
    expect(email.subject).toContain('Bcc: attacker@test');
    const responseBody = await response.json<{ token: string }>();
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(responseBody.token);
  });

  it.each([
    [null, 'not configured'],
    [{ send: vi.fn(async () => ({ success: false, error: 'provider rejected' })) }, 'Failed'],
    [{ send: vi.fn(async () => Promise.reject(new Error('provider unavailable'))) }, 'delivery'],
  ])(
    'keeps the stored invitation usable when optional email delivery is unavailable',
    async (notifier, warning) => {
      mocks.getNotifier.mockReturnValue(notifier);
      const response = await app().request(
        '/tenants/tenant-a/invitations',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invited_email: 'user@example.test' }),
        },
        {}
      );
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ email_sent: false });
      expect(mocks.logWarn).toHaveBeenCalledWith(
        expect.stringContaining(warning),
        expect.anything()
      );
      expect(mocks.audit).toHaveBeenCalled();
    }
  );

  it('lists only tenant-filtered rows and never returns invitation tokens', async () => {
    mocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants')) return { id: 'tenant-a' };
      if (sql.includes('COUNT(*)')) return { count: 1 };
      return null;
    });
    mocks.query.mockResolvedValue([invitationRow()]);
    const response = await app().request(
      '/tenants/tenant-a/invitations?limit=500&offset=3&include_expired=false'
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ items: Array<Record<string, unknown>>; total: number }>();
    expect(body.total).toBe(1);
    expect(body.items[0]).not.toHaveProperty('token');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('tenant_id = ?'), [
      'tenant-a',
      100,
      3,
    ]);
  });

  it('can explicitly include expired invitations while retaining tenant filtering', async () => {
    mocks.queryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants')) return { id: 'tenant-a' };
      if (sql.includes('COUNT(*)')) return null;
      return null;
    });
    mocks.query.mockResolvedValue([]);
    const response = await app().request('/tenants/tenant-a/invitations?include_expired=true');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 0, limit: 50, offset: 0 });
    expect(String(mocks.query.mock.calls[0]?.[0])).not.toContain('expires_at >');
  });

  it('cancels only an invitation belonging to the path tenant and audits after deletion', async () => {
    mocks.queryOne.mockResolvedValueOnce(null);
    expect(
      (await app().request('/tenants/tenant-a/invitations/missing', { method: 'DELETE' })).status
    ).toBe(404);
    expect(mocks.execute).not.toHaveBeenCalled();

    mocks.queryOne.mockResolvedValue({ id: 'invitation-a' });
    const response = await app().request('/tenants/tenant-a/invitations/invitation-a', {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(mocks.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('id = ? AND tenant_id = ?'),
      ['invitation-a', 'tenant-a']
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM tenant_invitations'),
      ['invitation-a', 'tenant-a']
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      'tenant_invitation.cancel',
      'tenant_invitation',
      'invitation-a',
      { tenant_id: 'tenant-a' }
    );
  });

  it.each([
    ['POST', '/tenants/tenant-a/invitations'],
    ['GET', '/tenants/tenant-a/invitations'],
    ['DELETE', '/tenants/tenant-a/invitations/invitation-a'],
  ])('returns a redacted 500 for storage failures on %s', async (method, path) => {
    mocks.queryOne.mockRejectedValue(new Error('database unavailable with secret details'));
    const response = await app().request(path, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? '{}' : undefined,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error_code: AR_ERROR_CODES.INTERNAL_ERROR });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
