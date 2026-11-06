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
  coreQuery: vi.fn(),
  coreQueryOne: vi.fn(),
  transition: vi.fn(),
  stepUp: vi.fn(async (_c: unknown, _descriptor: unknown): Promise<Response | null> => null),
}));

vi.mock('../admin-step-up-gate', () => ({ requireAdminStepUp: mocks.stepUp }));

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
    createAuthContextFromHono: () => ({
      coreAdapter: { query: mocks.coreQuery, queryOne: mocks.coreQueryOne },
    }),
    transitionCredentialStatus: mocks.transition,
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
    list: () => app.request('/api/admin/me/wallet-credentials', {}, fullEnv),
    revoke: (id = 'cred-1') =>
      app.request(`/api/admin/me/wallet-credentials/${id}/revoke`, { method: 'POST' }, fullEnv),
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

  describe('GET / (own credentials)', () => {
    // RFC 7638 appendix-style key: thumbprint computed independently below.
    const JWK = {
      kty: 'EC',
      crv: 'P-256',
      x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
      y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
    };

    it('lists the caller credentials newest first with the key thumbprint', async () => {
      mocks.coreQuery.mockResolvedValue([
        {
          public_id: 'cred-2',
          status: 'active',
          holder_binding: JSON.stringify({ ...JWK, d: 'must-not-matter', use: 'sig' }),
          created_at: 2_000,
          expires_at: 1_900_000_000,
        },
        {
          public_id: 'cred-1',
          status: 'revoked',
          holder_binding: null,
          created_at: 1_000,
          expires_at: null,
        },
      ]);
      const response = await createApp().list();

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const body = await response.json<{ items: Array<Record<string, unknown>> }>();
      const expected = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`{"crv":"P-256","kty":"EC","x":"${JWK.x}","y":"${JWK.y}"}`)
      );
      const expectedThumbprint = btoa(String.fromCharCode(...new Uint8Array(expected)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(body.items[0]).toEqual({
        id: 'cred-2',
        status: 'active',
        issuedAt: 2_000,
        expiresAt: 1_900_000_000_000,
        holderKeyThumbprint: expectedThumbprint,
      });
      expect(body.items[1]).toEqual({
        id: 'cred-1',
        status: 'revoked',
        issuedAt: 1_000,
        expiresAt: null,
      });
      const [sql, params] = mocks.coreQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('ORDER BY created_at DESC');
      expect(sql).toContain('LIMIT 50');
      expect(sql).not.toContain("'pending'");
      expect(params).toEqual(['tenant-1', 'admin-1', 'https://authrim.com/credentials/admin/v1']);
    });

    it('omits the thumbprint for a malformed stored key', async () => {
      mocks.coreQuery.mockResolvedValue([
        {
          public_id: 'c',
          status: 'active',
          holder_binding: '{not json',
          created_at: 1,
          expires_at: null,
        },
      ]);
      const body = await (
        await createApp().list()
      ).json<{
        items: Array<Record<string, unknown>>;
      }>();
      expect(body.items[0]).not.toHaveProperty('holderKeyThumbprint');
    });

    it('does not require fresh authentication but does require a home session', async () => {
      mocks.coreQuery.mockResolvedValue([]);
      mocks.getAuth.mockReturnValue(freshAuth({ mfaVerified: false, authenticationTimeMs: 1 }));
      expect((await createApp().list()).status).toBe(200);

      mocks.getAuth.mockReturnValue(freshAuth({ authMethod: 'bearer' }));
      expect((await createApp().list()).status).toBe(403);
    });
  });

  describe('POST /:credentialId/revoke', () => {
    beforeEach(() => {
      mocks.coreQueryOne.mockResolvedValue({ public_id: 'cred-1' });
      mocks.transition.mockResolvedValue({ outcome: 'changed', previous: 'active' });
    });

    it('revokes the caller own credential and audits the id only', async () => {
      const response = await createApp().revoke();

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'cred-1', status: 'revoked' });
      expect(mocks.coreQueryOne.mock.calls[0][1]).toEqual([
        'tenant-1',
        'cred-1',
        'admin-1',
        'https://authrim.com/credentials/admin/v1',
      ]);
      expect(mocks.transition).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'tenant-1',
          credentialId: 'cred-1',
          from: ['pending', 'active', 'suspended'],
          to: 'revoked',
        })
      );
      const audit = JSON.stringify(mocks.writeAdminAuditLog.mock.calls[0][1]);
      expect(audit).toContain('admin_wallet_credential.revoked');
      expect(audit).toContain('cred-1');
    });

    it('asks for an admin_credential.revoke step-up bound to the admin and the credential', async () => {
      await createApp().revoke();
      expect(mocks.stepUp).toHaveBeenCalledTimes(1);
      expect(mocks.stepUp.mock.calls[0][1]).toEqual({
        operation: 'admin_credential.revoke',
        targetTenantId: 'tenant-1',
        targetIds: ['admin-1', 'cred-1'],
        params: { scope: 'own_wallet_credential' },
      });
    });

    it('revokes nothing when the step-up refuses the request', async () => {
      mocks.stepUp.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
      );
      const response = await createApp().revoke();
      expect(response.status).toBe(403);
      expect(mocks.transition).not.toHaveBeenCalled();
      expect(mocks.writeAdminAuditLog).not.toHaveBeenCalled();
    });

    it('does not spend a receipt on another admin credential', async () => {
      mocks.coreQueryOne.mockResolvedValue(null);
      await createApp().revoke('cred-of-someone-else');
      expect(mocks.stepUp).not.toHaveBeenCalled();
    });

    it('is idempotent: an already revoked credential is 200 again', async () => {
      mocks.transition.mockResolvedValue({ outcome: 'unchanged' });
      const response = await createApp().revoke();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'cred-1', status: 'revoked' });
    });

    it('answers 404 for another admin credential without revoking', async () => {
      mocks.coreQueryOne.mockResolvedValue(null);
      const response = await createApp().revoke('cred-of-someone-else');

      expect(response.status).toBe(404);
      expect(mocks.transition).not.toHaveBeenCalled();
      expect(mocks.writeAdminAuditLog).not.toHaveBeenCalled();
    });

    it('answers 404 for a malformed id', async () => {
      const response = await createApp().revoke('bad%20id');
      expect(response.status).toBe(404);
      expect(mocks.transition).not.toHaveBeenCalled();
    });

    it('answers 404 when the credential vanished meanwhile', async () => {
      mocks.transition.mockResolvedValue({ outcome: 'not_found' });
      expect((await createApp().revoke()).status).toBe(404);
    });

    it('answers 409 when the credential cannot be revoked from its state', async () => {
      mocks.transition.mockResolvedValue({ outcome: 'not_allowed', current: 'deferred' });
      expect((await createApp().revoke()).status).toBe(409);
    });

    it.each([
      ['a conflict', { outcome: 'conflict' }],
      ['an error', null],
    ])('answers 503 with Retry-After on %s', async (_name, result) => {
      if (result) mocks.transition.mockResolvedValue(result);
      else mocks.transition.mockRejectedValue(new Error('boom'));
      const response = await createApp().revoke();

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('1');
      expect(mocks.writeAdminAuditLog).not.toHaveBeenCalled();
    });

    it.each([
      ['not MFA verified', { mfaVerified: false }],
      ['authenticated too long ago', { authenticationTimeMs: Date.now() - 6 * 60 * 1000 }],
      ['an agent principal', { actorType: 'agent' }],
    ])('requires fresh authentication when %s', async (_name, overrides) => {
      mocks.getAuth.mockReturnValue(freshAuth(overrides));
      const response = await createApp().revoke();

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'wallet_credential_fresh_auth_required' });
      expect(mocks.transition).not.toHaveBeenCalled();
    });

    it('refuses a session switched to another tenant', async () => {
      mocks.queryOne.mockImplementation(async (sql: string) =>
        sql.includes('FROM admin_sessions')
          ? { tenant_id: 'tenant-1', derived_target_tenant_id: 'tenant-2' }
          : { tenant_id: 'tenant-1' }
      );
      expect((await createApp().revoke()).status).toBe(403);
      expect(mocks.transition).not.toHaveBeenCalled();
    });
  });
});
