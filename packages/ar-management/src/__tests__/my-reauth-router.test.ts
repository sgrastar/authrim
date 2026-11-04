import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  getPasskeysByUser: vi.fn(),
  findByCredentialId: vi.fn(),
  updateCounter: vi.fn(),
  recordPasskeyVerification: vi.fn(),
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  generateId: vi.fn(() => 'challenge-id'),
  sessionRepoTenants: [] as string[],
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
}));

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class MockAdminPasskeyRepository {
    getPasskeysByUser = mocks.getPasskeysByUser;
    findByCredentialId = mocks.findByCredentialId;
    updateCounter = mocks.updateCounter;
  }
  class MockAdminSessionRepository {
    constructor(_adapter: unknown, tenantId: string) {
      mocks.sessionRepoTenants.push(tenantId);
    }
    recordPasskeyVerification = mocks.recordPasskeyVerification;
  }
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_AUTH_REQUIRED]: 401,
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    AdminPasskeyRepository: MockAdminPasskeyRepository,
    AdminSessionRepository: MockAdminSessionRepository,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    getChallengeStoreByChallengeId: vi.fn(async () => ({
      storeChallengeRpc: mocks.storeChallengeRpc,
      consumeChallengeRpc: mocks.consumeChallengeRpc,
    })),
    generateId: mocks.generateId,
    adminAuthMiddleware:
      () =>
      async (
        c: {
          req: { header: (name: string) => string | undefined };
          set: (key: string, value: unknown) => void;
        },
        next: () => Promise<void>
      ) => {
        const authMethod = c.req.header('x-test-auth-method') ?? 'session';
        c.set('adminAuth', {
          userId: c.req.header('x-test-user-id') ?? 'admin-1',
          authMethod,
          actorType: c.req.header('x-test-actor-type'),
          tenantId: 'tenant-1',
          sessionId:
            authMethod === 'session' ? (c.req.header('x-test-session-id') ?? 'sess-1') : undefined,
          roles: [],
          permissions: [],
          mfaVerified: true,
        });
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

function passkey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'passkey-1',
    admin_user_id: 'admin-1',
    credential_id: 'credential-1',
    public_key: btoa('public-key'),
    counter: 3,
    transports: ['internal'],
    ...overrides,
  };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/me/reauth', myReauthRouter);
  return { app, env: { ADMIN_UI_URL: ORIGIN } as unknown as Env };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const { app, env } = createApp();
  return app.request(
    `/api/admin/me/reauth/passkey/${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    },
    env
  );
}

function storedChallenge(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    challenge: 'webauthn-challenge',
    metadata: { rpID: 'admin.example.com', origin: ORIGIN, sessionId: 'sess-1' },
    ...overrides,
  };
}

const verifyBody = { challenge_id: 'challenge-id', credential: { id: 'credential-1' } };

describe('myReauthRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionRepoTenants.length = 0;
    mocks.getPasskeysByUser.mockResolvedValue([passkey()]);
    mocks.generateAuthenticationOptions.mockResolvedValue({ challenge: 'webauthn-challenge' });
    mocks.consumeChallengeRpc.mockResolvedValue(storedChallenge());
    mocks.findByCredentialId.mockResolvedValue(passkey());
    mocks.verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 4 },
    });
    mocks.updateCounter.mockResolvedValue(true);
    mocks.recordPasskeyVerification.mockResolvedValue(true);
  });

  describe('options', () => {
    it('binds a user-verified challenge to the admin, session, origin and RP ID', async () => {
      const response = await post('options', { rp_id: 'admin.example.com' });

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          rpID: 'admin.example.com',
          userVerification: 'required',
          allowCredentials: [expect.objectContaining({ id: 'credential-1' })],
        })
      );
      expect(mocks.storeChallengeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'admin_passkey_reauth:challenge-id',
          tenantId: 'tenant-1',
          type: 'admin_passkey_reauth',
          userId: 'admin-1',
          challenge: 'webauthn-challenge',
          metadata: { rpID: 'admin.example.com', origin: ORIGIN, sessionId: 'sess-1' },
        })
      );
      expect(await response.json()).toEqual({
        options: { challenge: 'webauthn-challenge' },
        challenge_id: 'challenge-id',
      });
    });

    it.each([
      ['a bearer token', { 'x-test-auth-method': 'bearer' }],
      ['a machine access token', { 'x-test-auth-method': 'machine_access_token' }],
      ['an agent actor', { 'x-test-actor-type': 'agent' }],
    ])('refuses %s', async (_label, headers) => {
      const response = await post('options', { rp_id: 'admin.example.com' }, headers);

      expect(response.status).toBe(403);
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it.each([
      ['a missing RP ID', {}],
      ['an RP ID that does not match the origin', { rp_id: 'evil.example.com' }],
      ['a null body', null],
    ])('rejects %s', async (_label, body) => {
      const response = await post('options', body);

      expect(response.status).toBe(400);
      expect(mocks.generateAuthenticationOptions).not.toHaveBeenCalled();
    });

    it('reports an admin without a passkey', async () => {
      mocks.getPasskeysByUser.mockResolvedValue([]);

      const response = await post('options', { rp_id: 'admin.example.com' });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'no_reauth_method' });
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
    });
  });

  describe('verify', () => {
    it('records the verified passkey on the session', async () => {
      const response = await post('verify', verifyBody);

      expect(response.status).toBe(200);
      const body = await response.json<{ verified: boolean; authenticated_at: number }>();
      expect(body.verified).toBe(true);
      expect(mocks.consumeChallengeRpc).toHaveBeenCalledWith({
        id: 'admin_passkey_reauth:challenge-id',
        tenantId: 'tenant-1',
        type: 'admin_passkey_reauth',
      });
      expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedChallenge: 'webauthn-challenge',
          expectedOrigin: ORIGIN,
          expectedRPID: 'admin.example.com',
          requireUserVerification: true,
        })
      );
      const [verifyInput] = mocks.verifyAuthenticationResponse.mock.calls[0] as [
        { credential: { id: string; counter: number } },
      ];
      expect(verifyInput.credential).toMatchObject({ id: 'credential-1', counter: 3 });
      expect(mocks.updateCounter).toHaveBeenCalledWith('passkey-1', 4);
      expect(mocks.sessionRepoTenants).toEqual(['tenant-1']);
      expect(mocks.recordPasskeyVerification).toHaveBeenCalledWith(
        'sess-1',
        'credential-1',
        body.authenticated_at
      );
      expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'admin.reauthenticated',
          resourceId: 'sess-1',
          result: 'success',
        })
      );
    });

    it('refuses a bearer token before consuming the challenge', async () => {
      const response = await post('verify', verifyBody, { 'x-test-auth-method': 'bearer' });

      expect(response.status).toBe(403);
      expect(mocks.consumeChallengeRpc).not.toHaveBeenCalled();
    });

    it('rejects an unknown or spent challenge', async () => {
      mocks.consumeChallengeRpc.mockRejectedValue(new Error('not found'));

      const response = await post('verify', verifyBody);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_challenge' });
      expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
    });

    it.each([
      ['another admin', storedChallenge({ userId: 'admin-2' })],
      [
        'another session',
        storedChallenge({
          metadata: { rpID: 'admin.example.com', origin: ORIGIN, sessionId: 'sess-2' },
        }),
      ],
      [
        'another origin',
        storedChallenge({
          metadata: {
            rpID: 'admin.example.com',
            origin: 'https://other.example.com',
            sessionId: 'sess-1',
          },
        }),
      ],
      ['no bound origin', storedChallenge({ metadata: { sessionId: 'sess-1' } })],
    ])('rejects a challenge issued for %s', async (_label, challenge) => {
      mocks.consumeChallengeRpc.mockResolvedValue(challenge);

      const response = await post('verify', verifyBody);

      expect(response.status).toBe(400);
      expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
      expect(mocks.recordPasskeyVerification).not.toHaveBeenCalled();
    });

    it.each([
      ['an unknown credential', null],
      ["another admin's credential", passkey({ admin_user_id: 'admin-2' })],
    ])('rejects %s', async (_label, found) => {
      mocks.findByCredentialId.mockResolvedValue(found);

      const response = await post('verify', verifyBody);

      expect(response.status).toBe(400);
      expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
      expect(mocks.recordPasskeyVerification).not.toHaveBeenCalled();
    });

    it.each([
      ['throws', () => mocks.verifyAuthenticationResponse.mockRejectedValue(new Error('bad'))],
      [
        'is not verified',
        () =>
          mocks.verifyAuthenticationResponse.mockResolvedValue({
            verified: false,
            authenticationInfo: { newCounter: 0 },
          }),
      ],
    ])('records nothing when the assertion %s', async (_label, arrange) => {
      arrange();

      const response = await post('verify', verifyBody);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'verification_failed' });
      expect(mocks.updateCounter).not.toHaveBeenCalled();
      expect(mocks.recordPasskeyVerification).not.toHaveBeenCalled();
      expect(mocks.writeAdminAuditLog).not.toHaveBeenCalled();
    });

    it('asks for sign-in again when the session ended meanwhile', async () => {
      mocks.recordPasskeyVerification.mockResolvedValue(false);

      const response = await post('verify', verifyBody);

      expect(response.status).toBe(401);
      expect(mocks.writeAdminAuditLog).not.toHaveBeenCalled();
    });

    it.each([
      ['a body without a credential', { challenge_id: 'challenge-id' }],
      ['a null body', null],
    ])('rejects %s', async (_label, body) => {
      const response = await post('verify', body);

      expect(response.status).toBe(400);
      expect(mocks.consumeChallengeRpc).not.toHaveBeenCalled();
    });
  });
});
