import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  evaluate: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  createOffer: vi.fn(),
  getStatus: vi.fn(),
  issuer: vi.fn(),
  getAuth: vi.fn(),
}));

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));
vi.mock('../request-issuer', () => ({
  getCanonicalTenantBaseUrlAsync: (...args: unknown[]) => mocks.issuer(...args) as Promise<string>,
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const pass = async (_c: unknown, next: () => Promise<void>) => next();
  return {
    ...actual,
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.getAuth());
        c.set('tenantId', 'tenant-1');
        await next();
      },
    getTenantIdFromContext: (c: { get: (key: string) => unknown }) => c.get('tenantId'),
    getRateLimitProfileAsync: vi.fn(async () => ({})),
    rateLimitMiddleware: () => pass,
    requiredIdempotencyMiddleware: () => pass,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({ queryOne: mocks.queryOne })),
    evaluateAdminCredentialEligibility: mocks.evaluate,
  };
});

import { myWalletCredentialsRouter } from '../routes/admin-management/my-wallet-credentials';

const OFFER = {
  offerId: 'offer-1',
  credentialOfferUri: 'https://idp.example.test/vci/offers/ref',
  credentialOffer: 'openid-credential-offer://?credential_offer_uri=https%3A%2F%2Fx',
  expiresAt: 1_900_000_000_000,
  transactionCode: '123456',
};

function freshAuth(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    sessionId: 'session-1',
    authMethod: 'session',
    mfaVerified: true,
    authenticationTimeMs: Date.now() - 1000,
    tenantId: 'tenant-1',
    ...overrides,
  };
}

function createApp(env: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/me/wallet-credentials', myWalletCredentialsRouter);
  const fullEnv = {
    DB_ADMIN: {},
    VC_ISSUER: {
      createAdminCredentialOffer: mocks.createOffer,
      getAdminCredentialOfferStatus: mocks.getStatus,
    },
    ...env,
  } as unknown as Env;
  return {
    post: () => app.request('/api/admin/me/wallet-credentials/offers', { method: 'POST' }, fullEnv),
    get: (id = 'offer-1') =>
      app.request(`/api/admin/me/wallet-credentials/offers/${id}`, {}, fullEnv),
  };
}

describe('my wallet credential offers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuth.mockReturnValue(freshAuth());
    mocks.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('FROM admin_sessions')
        ? { tenant_id: 'tenant-1', derived_target_tenant_id: null }
        : { tenant_id: 'tenant-1' }
    );
    mocks.evaluate.mockResolvedValue({ eligible: true, email: 'a@example.com', name: 'A' });
    mocks.issuer.mockResolvedValue('https://idp.example.test/some/path');
    mocks.createOffer.mockResolvedValue(OFFER);
    mocks.getStatus.mockResolvedValue({ offerId: 'offer-1', state: 'pending', expiresAt: 5 });
  });

  describe('POST /offers', () => {
    it('creates an offer for the caller with no-store and an audit without secrets', async () => {
      const response = await createApp().post();

      expect(response.status).toBe(201);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({
        offerId: 'offer-1',
        credentialOffer: OFFER.credentialOffer,
        transactionCode: '123456',
        expiresAt: OFFER.expiresAt,
      });
      expect(mocks.createOffer).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        credentialIssuer: 'https://idp.example.test',
      });
      expect(mocks.writeAdminAuditLog).toHaveBeenCalledTimes(1);
      const audit = JSON.stringify(mocks.writeAdminAuditLog.mock.calls[0][1]);
      expect(audit).toContain('admin_wallet_credential.offer_created');
      expect(audit).toContain('offer-1');
      expect(audit).not.toContain('123456');
      expect(audit).not.toContain('credential_offer_uri');
    });

    it.each([
      ['not MFA verified', { mfaVerified: false }],
      ['authenticated too long ago', { authenticationTimeMs: Date.now() - 6 * 60 * 1000 }],
      ['an agent principal', { actorType: 'agent' }],
      ['a bearer principal', { authMethod: 'bearer' }],
    ])('requires fresh authentication when %s', async (_name, overrides) => {
      mocks.getAuth.mockReturnValue(freshAuth(overrides));
      const response = await createApp().post();

      expect(response.status).toBe(403);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'wallet_credential_fresh_auth_required' });
      expect(mocks.createOffer).not.toHaveBeenCalled();
    });

    it('refuses a session switched to another tenant', async () => {
      mocks.queryOne.mockImplementation(async (sql: string) =>
        sql.includes('FROM admin_sessions')
          ? { tenant_id: 'tenant-1', derived_target_tenant_id: 'tenant-2' }
          : { tenant_id: 'tenant-1' }
      );
      const response = await createApp().post();

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'wallet_credential_home_session_required' });
      expect(mocks.createOffer).not.toHaveBeenCalled();
    });

    it.each([
      ['session of another tenant', 'tenant-9', 'tenant-1'],
      ['admin homed in another tenant', 'tenant-1', 'tenant-9'],
    ])('refuses a %s', async (_name, sessionTenant, homeTenant) => {
      mocks.queryOne.mockImplementation(async (sql: string) =>
        sql.includes('FROM admin_sessions')
          ? { tenant_id: sessionTenant, derived_target_tenant_id: null }
          : { tenant_id: homeTenant }
      );
      const response = await createApp().post();

      expect(response.status).toBe(403);
      expect(mocks.createOffer).not.toHaveBeenCalled();
    });

    it('refuses an expired or missing session row', async () => {
      mocks.queryOne.mockResolvedValue(null);
      const response = await createApp().post();

      expect(response.status).toBe(403);
      expect(mocks.createOffer).not.toHaveBeenCalled();
    });

    it('refuses an ineligible admin', async () => {
      mocks.evaluate.mockResolvedValue({ eligible: false });
      const response = await createApp().post();

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'wallet_credential_not_eligible' });
      expect(mocks.createOffer).not.toHaveBeenCalled();
    });

    it('answers 503 without the credential issuer binding', async () => {
      const response = await createApp({ VC_ISSUER: undefined }).post();

      expect(response.status).toBe(503);
    });

    it('answers 503 for a non-https issuer', async () => {
      mocks.issuer.mockResolvedValue('http://idp.example.test');
      const response = await createApp().post();

      expect(response.status).toBe(503);
      expect(mocks.createOffer).not.toHaveBeenCalled();
    });
  });

  describe('GET /offers/:offerId', () => {
    it('returns the progress of the caller offer without requiring fresh authentication', async () => {
      mocks.getAuth.mockReturnValue(freshAuth({ mfaVerified: false, authenticationTimeMs: 1 }));
      const response = await createApp().get();

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ offerId: 'offer-1', state: 'pending', expiresAt: 5 });
      expect(mocks.getStatus).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        offerId: 'offer-1',
      });
    });

    it('answers 404 for an offer of another admin', async () => {
      mocks.getStatus.mockResolvedValue(null);
      const response = await createApp().get('offer-of-someone-else');

      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('answers 404 for a malformed offer id without calling ar-vc', async () => {
      const response = await createApp().get('bad%20id');

      expect(response.status).toBe(404);
      expect(mocks.getStatus).not.toHaveBeenCalled();
    });

    it('refuses a derived session', async () => {
      mocks.queryOne.mockImplementation(async (sql: string) =>
        sql.includes('FROM admin_sessions')
          ? { tenant_id: 'tenant-1', derived_target_tenant_id: 'tenant-2' }
          : { tenant_id: 'tenant-1' }
      );
      const response = await createApp().get();

      expect(response.status).toBe(403);
      expect(mocks.getStatus).not.toHaveBeenCalled();
    });

    it('refuses a non-session principal', async () => {
      mocks.getAuth.mockReturnValue(freshAuth({ authMethod: 'bearer' }));
      const response = await createApp().get();

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'wallet_credential_session_required' });
    });
  });
});
