import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  listActiveByUser: vi.fn(),
  findActiveByCredentialId: vi.fn(),
  recordUse: vi.fn(),
  recordSecondFactorVerification: vi.fn(),
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  sessionRepoTenants: [] as string[],
  auth: {},
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
}));

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class MockAdminSecondFactorRepository {
    listActiveByUser = mocks.listActiveByUser;
    findActiveByCredentialId = mocks.findActiveByCredentialId;
    recordUse = mocks.recordUse;
  }
  class MockAdminSessionRepository {
    constructor(_adapter: unknown, tenantId: string) {
      mocks.sessionRepoTenants.push(tenantId);
    }
    recordSecondFactorVerification = mocks.recordSecondFactorVerification;
  }
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_AUTH_REQUIRED]: 401,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    AdminSecondFactorRepository: MockAdminSecondFactorRepository,
    AdminSessionRepository: MockAdminSessionRepository,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    getChallengeStoreByChallengeId: vi.fn(async () => ({
      storeChallengeRpc: mocks.storeChallengeRpc,
      consumeChallengeRpc: mocks.consumeChallengeRpc,
    })),
    generateId: vi.fn(() => 'challenge-id'),
    adminAuthMiddleware:
      () =>
      async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', mocks.auth);
        await next();
      },
    createErrorResponse: vi.fn(
      (c: { json: (body: unknown, status: number) => Response }, code: string) =>
        c.json({ error: 'error', error_code: code }, status[code] ?? 500)
    ),
  };
});

import { myReauthRouter } from '../routes/admin-management/my-reauth';

const ORIGIN = 'https://admin.example.com';

function factor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sf-1',
    admin_user_id: 'admin-1',
    kind: 'webauthn_credential',
    credential_id: 'cred-1',
    public_key: btoa('public-key'),
    counter: 3,
    transports: ['usb'],
    backup_eligible: false,
    backup_state: false,
    revoked_at: null,
    ...overrides,
  };
}

async function post(path: string, body: unknown) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/me/reauth', myReauthRouter);
  const response = await app.request(
    `/api/admin/me/reauth/second-factor/${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
    },
    { ADMIN_UI_URL: ORIGIN }
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

function storedChallenge(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    challenge: 'webauthn-challenge',
    metadata: { rpID: 'admin.example.com', origin: ORIGIN, sessionId: 'sess-1' },
    ...overrides,
  };
}

function authenticated(overrides: Record<string, unknown> = {}) {
  return {
    verified: true,
    authenticationInfo: {
      newCounter: 4,
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      ...overrides,
    },
  };
}

const verifyBody = { challenge_id: 'challenge-id', credential: { id: 'cred-1' } };

describe('second-factor re-authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionRepoTenants.length = 0;
    mocks.auth = {
      userId: 'admin-1',
      authMethod: 'session',
      tenantId: 'default',
      sessionId: 'sess-1',
      roles: [],
      mfaVerified: true,
    };
    mocks.listActiveByUser.mockResolvedValue([factor()]);
    mocks.generateAuthenticationOptions.mockResolvedValue({ challenge: 'webauthn-challenge' });
    mocks.consumeChallengeRpc.mockResolvedValue(storedChallenge());
    mocks.findActiveByCredentialId.mockResolvedValue(factor());
    mocks.verifyAuthenticationResponse.mockResolvedValue(authenticated());
    mocks.recordSecondFactorVerification.mockResolvedValue(true);
    mocks.recordUse.mockResolvedValue(true);
  });

  describe('options', () => {
    it('offers only the admin’s active WebAuthn factors, bound to the session', async () => {
      mocks.listActiveByUser.mockResolvedValue([
        factor(),
        factor({ id: 'sf-2', kind: 'keyring_holder_key', credential_id: null }),
      ]);

      const { status, body } = await post('options', { rp_id: 'admin.example.com' });

      expect(status).toBe(200);
      expect(body).toMatchObject({ challenge_id: 'challenge-id' });
      expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          rpID: 'admin.example.com',
          userVerification: 'required',
          allowCredentials: [{ id: 'cred-1', type: 'public-key', transports: ['usb'] }],
        })
      );
      expect(mocks.storeChallengeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'admin_second_factor_reauth:challenge-id',
          type: 'admin_second_factor_reauth',
          userId: 'admin-1',
          metadata: { rpID: 'admin.example.com', origin: ORIGIN, sessionId: 'sess-1' },
        })
      );
    });

    it('says when no second factor is registered', async () => {
      mocks.listActiveByUser.mockResolvedValue([]);

      const { status, body } = await post('options', { rp_id: 'admin.example.com' });

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'no_second_factor' });
    });

    it('refuses a machine caller', async () => {
      mocks.auth = { ...mocks.auth, authMethod: 'machine_access_token', sessionId: undefined };

      expect((await post('options', { rp_id: 'admin.example.com' })).status).toBe(403);
    });
  });

  describe('verify', () => {
    it('records the factor on the session and audits it', async () => {
      const { status, body } = await post('verify', verifyBody);

      expect(status).toBe(200);
      expect(body).toMatchObject({ verified: true });
      expect(mocks.consumeChallengeRpc).toHaveBeenCalledWith({
        id: 'admin_second_factor_reauth:challenge-id',
        tenantId: 'default',
        type: 'admin_second_factor_reauth',
      });
      expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
        expect.objectContaining({ requireUserVerification: true })
      );
      expect(mocks.recordUse).toHaveBeenCalledWith(
        'sf-1',
        expect.objectContaining({ expectedCounter: 3, counter: 4, backupState: false })
      );
      expect(mocks.sessionRepoTenants).toEqual(['default']);
      expect(mocks.recordSecondFactorVerification).toHaveBeenCalledWith(
        'sess-1',
        { adminUserId: 'admin-1', secondFactorId: 'sf-1' },
        expect.any(Number)
      );
      expect(mocks.writeAdminAuditLog.mock.calls[0]?.[1]).toMatchObject({
        action: 'admin.second_factor.verified',
        resourceId: 'sess-1',
        metadata: { second_factor_id: 'sf-1' },
      });
    });

    it.each([
      ['a credential that became backup eligible', { credentialDeviceType: 'multiDevice' }],
      ['a credential that reports a backup', { credentialBackedUp: true }],
    ])('refuses %s', async (_label, info) => {
      mocks.verifyAuthenticationResponse.mockResolvedValue(authenticated(info));

      const { status, body } = await post('verify', verifyBody);

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'verification_failed' });
      expect(mocks.recordSecondFactorVerification).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown or revoked credential', null],
      ['another admin’s factor', factor({ admin_user_id: 'admin-2' })],
      ['a factor registered as backup eligible', factor({ backup_eligible: true })],
      ['a Keyring holder key', factor({ kind: 'keyring_holder_key' })],
    ])('refuses %s', async (_label, found) => {
      mocks.findActiveByCredentialId.mockResolvedValue(found);

      const { status } = await post('verify', verifyBody);

      expect(status).toBe(400);
      expect(mocks.recordSecondFactorVerification).not.toHaveBeenCalled();
    });

    it.each([
      ['another admin', { userId: 'admin-2' }],
      ['another session', { metadata: { ...storedChallenge().metadata, sessionId: 'sess-2' } }],
    ])('refuses a challenge for %s', async (_label, overrides) => {
      mocks.consumeChallengeRpc.mockResolvedValue(storedChallenge(overrides));

      const { body } = await post('verify', verifyBody);

      expect(body).toMatchObject({ error: 'invalid_challenge' });
      expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
    });

    it('refuses an assertion that does not verify', async () => {
      mocks.verifyAuthenticationResponse.mockRejectedValue(new Error('bad signature'));

      expect((await post('verify', verifyBody)).body).toMatchObject({
        error: 'verification_failed',
      });
      expect(mocks.recordUse).not.toHaveBeenCalled();
    });

    it('records nothing when another use of the factor moved its counter first', async () => {
      mocks.recordUse.mockResolvedValue(false);

      const { status, body } = await post('verify', verifyBody);

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'verification_failed' });
      expect(mocks.recordSecondFactorVerification).not.toHaveBeenCalled();
    });

    it('reports failure when the factor was revoked or the session ended meanwhile', async () => {
      mocks.recordSecondFactorVerification.mockResolvedValue(false);

      const { status, body } = await post('verify', verifyBody);

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'verification_failed' });
      expect(mocks.writeAdminAuditLog).not.toHaveBeenCalled();
    });

    it.each([[null], [7], [{}]])('rejects the body %j', async (body) => {
      expect((await post('verify', body)).status).toBe(400);
      expect(mocks.consumeChallengeRpc).not.toHaveBeenCalled();
    });
  });
});
