import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Challenge, Env, StoreChallengeRequest } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  listActiveByUser: vi.fn(),
  getEnrollmentGraceEndsAt: vi.fn(),
  getReenrollWindowEndsAt: vi.fn(),
  hasEverEnrolled: vi.fn(),
  isActive: vi.fn(),
  insertTotp: vi.fn(),
  listActiveTotpSecrets: vi.fn(),
  recordTotpUse: vi.fn(),
  recordSecondFactorVerification: vi.fn(),
  sessionRepoTenants: [] as string[],
  readAdminStepUpPolicy: vi.fn(),
  requireAdminStepUp: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  incrementRpc: vi.fn(),
  challenges: new Map<string, Challenge>(),
  auth: {} as Record<string, unknown>,
}));

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));
vi.mock('../admin-step-up-gate', () => ({
  requireAdminStepUp: mocks.requireAdminStepUp,
  refuseAdminFreshAuth: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: 'admin_fresh_auth_required' }, 403),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class MockAdminSecondFactorRepository {
    listActiveByUser = mocks.listActiveByUser;
    getEnrollmentGraceEndsAt = mocks.getEnrollmentGraceEndsAt;
    getReenrollWindowEndsAt = mocks.getReenrollWindowEndsAt;
    hasEverEnrolled = mocks.hasEverEnrolled;
    isActive = mocks.isActive;
    insertTotp = mocks.insertTotp;
    listActiveTotpSecrets = mocks.listActiveTotpSecrets;
    recordTotpUse = mocks.recordTotpUse;
  }
  class MockAdminSessionRepository {
    constructor(_adapter: unknown, tenantId: string) {
      mocks.sessionRepoTenants.push(tenantId);
    }
    recordSecondFactorVerification = mocks.recordSecondFactorVerification;
  }
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    AdminSecondFactorRepository: MockAdminSecondFactorRepository,
    AdminSessionRepository: MockAdminSessionRepository,
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => ({})),
    readAdminStepUpPolicy: mocks.readAdminStepUpPolicy,
    getChallengeStoreByChallengeId: vi.fn(async () => ({
      storeChallengeRpc: async (request: StoreChallengeRequest) => {
        mocks.challenges.set(request.id, {
          id: request.id,
          tenantId: request.tenantId,
          type: request.type,
          userId: request.userId,
          challenge: request.challenge,
          metadata: request.metadata,
          createdAt: Date.now(),
          expiresAt: Date.now() + request.ttl * 1000,
          consumed: false,
        } as Challenge);
      },
      getChallengeRpc: async (id: string) => mocks.challenges.get(id) ?? null,
      consumeChallengeRpc: async (request: { id: string }) => {
        const challenge = mocks.challenges.get(request.id);
        if (!challenge || challenge.consumed) throw new Error('consumed');
        challenge.consumed = true;
      },
    })),
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

import {
  TOTP_COMPATIBLE_PROFILE,
  generateTotpCode,
  getTotpTimeStep,
  sealAdminTotpSecret,
} from '@authrim/ar-lib-core';
import { myTotpFactorRouter } from '../routes/admin-management/my-totp-factor';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SECRET = 'JBSWY3DPEHPK3PXP';
const ENV = {
  ADMIN_CREDENTIAL_ENCRYPTION_KEY: KEY,
  RATE_LIMITER: {
    idFromName: (name: string) => name,
    get: () => ({ incrementRpc: mocks.incrementRpc }),
  },
} as unknown as Env;

async function call(path: string, body: unknown, env: Env = ENV) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/me/second-factors/totp', myTotpFactorRouter);
  const response = await app.request(
    `/api/admin/me/second-factors/totp${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
  return {
    status: response.status,
    cache: response.headers.get('Cache-Control'),
    body: await response.json<Record<string, unknown>>(),
  };
}

async function currentCode(secret = SECRET, offset = 0) {
  const step = getTotpTimeStep(Date.now(), TOTP_COMPATIBLE_PROFILE.period) + offset;
  return { code: await generateTotpCode(secret, TOTP_COMPATIBLE_PROFILE, step), step };
}

function baseAuth(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    email: 'admin-1@example.com',
    authMethod: 'session',
    tenantId: 'tenant-a',
    sessionTenantId: 'default',
    sessionId: 'sess-1',
    roles: [],
    mfaVerified: true,
    authenticationTimeMs: Date.now() - 1000,
    ...overrides,
  };
}

const ALLOW_TOTP = { overrides: undefined, enforced: true, allowedKinds: ['hardware', 'totp'] };

describe('authenticator app second factor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.challenges.clear();
    mocks.sessionRepoTenants.length = 0;
    mocks.auth = baseAuth();
    mocks.readAdminStepUpPolicy.mockResolvedValue(ALLOW_TOTP);
    mocks.requireAdminStepUp.mockResolvedValue(null);
    mocks.incrementRpc.mockResolvedValue({ allowed: true });
    // An admin inside the first-enrolment window with nothing registered yet.
    mocks.listActiveByUser.mockResolvedValue([]);
    mocks.getEnrollmentGraceEndsAt.mockResolvedValue(Date.now() + 86_400_000);
    mocks.getReenrollWindowEndsAt.mockResolvedValue(null);
    mocks.hasEverEnrolled.mockResolvedValue(false);
    mocks.isActive.mockResolvedValue(true);
    mocks.recordSecondFactorVerification.mockResolvedValue(true);
    mocks.recordTotpUse.mockResolvedValue(true);
    mocks.insertTotp.mockImplementation(async (input: { label?: string }) => ({
      inserted: true,
      factor: {
        id: 'sf-new',
        admin_user_id: 'admin-1',
        kind: 'totp',
        label: input.label ?? null,
        aaguid: null,
        created_at: 1,
        last_used_at: 1,
        revoked_at: null,
      },
    }));
  });

  describe('POST /enroll', () => {
    it('refuses where the tenant does not allow authenticator apps, before anything is spent', async () => {
      mocks.readAdminStepUpPolicy.mockResolvedValue({ ...ALLOW_TOTP, allowedKinds: undefined });

      const { status, body, cache } = await call('/enroll', {});

      expect(status).toBe(403);
      expect(cache).toBe('no-store');
      expect(body).toMatchObject({ error: 'second_factor_kind_not_allowed' });
      expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
      expect(mocks.challenges.size).toBe(0);
    });

    it('never takes an unreadable policy as permission', async () => {
      mocks.readAdminStepUpPolicy.mockRejectedValue(new Error('KV down'));

      const { status, body } = await call('/enroll', {});

      expect(status).toBe(503);
      expect(body).toMatchObject({ error: 'step_up_unavailable' });
    });

    it('starts a first enrolment with a fresh passkey alone, keeping the secret sealed', async () => {
      const { status, body } = await call('/enroll', { label: ' Phone ' });

      expect(status).toBe(201);
      expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
      expect(String(body.otpauth_uri)).toMatch(/^otpauth:\/\/totp\//u);
      expect(String(body.otpauth_uri)).toContain(`secret=${String(body.secret)}`);
      const [stored] = [...mocks.challenges.values()];
      expect(stored).toMatchObject({
        type: 'admin_totp_enrollment',
        userId: 'admin-1',
        tenantId: 'default',
        metadata: { sessionId: 'sess-1', mode: 'first', label: 'Phone', approvingFactorId: null },
      });
      const sealed = (stored.metadata as { secretEncrypted: string }).secretEncrypted;
      expect(sealed).not.toContain(String(body.secret));
    });

    it('needs an L2 receipt once the admin has a second factor, naming the kind', async () => {
      mocks.listActiveByUser.mockResolvedValue([{ id: 'sf-1', kind: 'webauthn_credential' }]);
      mocks.auth = baseAuth({
        secondFactorId: 'sf-1',
        secondFactorVerifiedAtMs: Date.now() - 1000,
      });

      const { status } = await call('/enroll', {});

      expect(status).toBe(201);
      expect(mocks.requireAdminStepUp).toHaveBeenCalledWith(
        expect.anything(),
        {
          operation: 'admin.second_factor.add',
          targetTenantId: 'default',
          targetIds: ['admin-1'],
          params: { kind: 'totp' },
        },
        expect.any(Number)
      );
      expect([...mocks.challenges.values()][0].metadata).toMatchObject({
        mode: 'step_up',
        approvingFactorId: 'sf-1',
      });
    });

    it('returns the gate’s refusal and stores nothing when the receipt is missing', async () => {
      mocks.listActiveByUser.mockResolvedValue([{ id: 'sf-1', kind: 'webauthn_credential' }]);
      mocks.requireAdminStepUp.mockImplementation(async (c: { json: Function }) =>
        c.json({ error: 'step_up_required' }, 403)
      );

      const { status, body } = await call('/enroll', {});

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'step_up_required' });
      expect(mocks.challenges.size).toBe(0);
    });

    it('asks for a fresh passkey when the first-enrolment evidence is stale', async () => {
      mocks.auth = baseAuth({ authenticationTimeMs: Date.now() - 3_600_000 });

      const { status, body } = await call('/enroll', {});

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'admin_fresh_auth_required' });
      expect(mocks.challenges.size).toBe(0);
    });

    it('refuses when the window has closed and nothing is registered', async () => {
      mocks.getEnrollmentGraceEndsAt.mockResolvedValue(Date.now() - 1000);

      const { status, body } = await call('/enroll', {});

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'second_factor_recovery_required' });
    });

    it('refuses a second authenticator app while one is active', async () => {
      mocks.listActiveByUser.mockResolvedValue([{ id: 'sf-t', kind: 'totp' }]);

      const { status, body } = await call('/enroll', {});

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'second_factor_kind_in_use' });
      expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    });

    it('spends no receipt when no encryption key is configured', async () => {
      mocks.listActiveByUser.mockResolvedValue([{ id: 'sf-1', kind: 'webauthn_credential' }]);

      const { status, body } = await call('/enroll', {}, {
        ...ENV,
        ADMIN_CREDENTIAL_ENCRYPTION_KEY: undefined,
      } as unknown as Env);

      expect(status).toBe(503);
      expect(body).toMatchObject({ error: 'totp_unavailable' });
      expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    });

    it('rejects a label that is not a short string', async () => {
      expect((await call('/enroll', { label: 7 })).status).toBe(400);
      expect((await call('/enroll', { label: 'x'.repeat(65) })).status).toBe(400);
    });

    it('is for a signed-in human admin only', async () => {
      mocks.auth = { userId: 'machine-1', authMethod: 'machine_access_token', tenantId: 'x' };

      expect((await call('/enroll', {})).status).toBe(403);
    });
  });

  describe('POST /enroll/verify', () => {
    async function startEnrollment(authOverrides: Record<string, unknown> = {}) {
      mocks.auth = baseAuth(authOverrides);
      const started = await call('/enroll', {});
      expect(started.status).toBe(201);
      return {
        challengeId: String(started.body.challenge_id),
        secret: String(started.body.secret),
      };
    }

    it('stores the secret sealed once a code from the app is confirmed, and spends the challenge', async () => {
      const { challengeId, secret } = await startEnrollment();
      const { code, step } = await currentCode(secret);

      const { status, body } = await call('/enroll/verify', { challenge_id: challengeId, code });

      expect(status).toBe(201);
      expect(body).toMatchObject({ second_factor: { id: 'sf-new', kind: 'totp' } });
      const [input, options] = mocks.insertTotp.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(input).toMatchObject({ admin_user_id: 'admin-1', secret_key_version: 1 });
      expect(input.secret_encrypted).not.toContain(secret);
      // The code that proved the secret counts as used.
      expect(input.time_step).toBeGreaterThanOrEqual(step - 1);
      expect(options).toMatchObject({ firstOnly: true, sessionId: 'sess-1' });
      expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'admin.second_factor.added',
          metadata: { kind: 'totp', mode: 'first' },
        })
      );
      // Spent: the same challenge cannot register again.
      const again = await call('/enroll/verify', { challenge_id: challengeId, code });
      expect(again.status).toBe(400);
      expect(mocks.insertTotp).toHaveBeenCalledTimes(1);
    });

    it('keeps the challenge on a wrong code, so a typo does not cost a new receipt', async () => {
      const { challengeId, secret } = await startEnrollment();
      const { code } = await currentCode(secret);
      const wrong = code === '000000' ? '000001' : '000000';

      const failed = await call('/enroll/verify', { challenge_id: challengeId, code: wrong });

      expect(failed.status).toBe(400);
      expect(failed.body).toMatchObject({ error: 'verification_failed' });
      expect(mocks.insertTotp).not.toHaveBeenCalled();
      const retried = await call('/enroll/verify', { challenge_id: challengeId, code });
      expect(retried.status).toBe(201);
    });

    it('limits the attempts before it reads the challenge', async () => {
      const { challengeId, secret } = await startEnrollment();
      mocks.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 120 });

      const { status, body } = await call('/enroll/verify', {
        challenge_id: challengeId,
        code: (await currentCode(secret)).code,
      });

      expect(status).toBe(429);
      expect(body).toMatchObject({ error: 'rate_limited', retry_after: 120 });
      expect(mocks.insertTotp).not.toHaveBeenCalled();
    });

    it('refuses a challenge that belongs to another session or admin', async () => {
      const { challengeId, secret } = await startEnrollment();
      const { code } = await currentCode(secret);

      mocks.auth = baseAuth({ sessionId: 'sess-other' });
      expect((await call('/enroll/verify', { challenge_id: challengeId, code })).status).toBe(400);
      mocks.auth = baseAuth({ userId: 'admin-2' });
      expect((await call('/enroll/verify', { challenge_id: challengeId, code })).status).toBe(400);
      expect(mocks.insertTotp).not.toHaveBeenCalled();
    });

    it('refuses a secret that was sealed for another admin', async () => {
      const { challengeId } = await startEnrollment();
      const foreign = await sealAdminTotpSecret(ENV, 'admin-2', SECRET);
      const stored = [...mocks.challenges.values()][0];
      (stored.metadata as { secretEncrypted: string }).secretEncrypted = foreign!.encrypted;

      const { status } = await call('/enroll/verify', {
        challenge_id: challengeId,
        code: (await currentCode()).code,
      });

      expect(status).toBe(400);
      expect(mocks.insertTotp).not.toHaveBeenCalled();
    });

    it('re-checks the policy when the code arrives', async () => {
      const { challengeId, secret } = await startEnrollment();
      mocks.readAdminStepUpPolicy.mockResolvedValue({ ...ALLOW_TOTP, allowedKinds: ['hardware'] });

      const { status, body } = await call('/enroll/verify', {
        challenge_id: challengeId,
        code: (await currentCode(secret)).code,
      });

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'second_factor_kind_not_allowed' });
      expect(mocks.insertTotp).not.toHaveBeenCalled();
    });

    it('refuses an added factor once the factor that approved it was revoked', async () => {
      mocks.listActiveByUser.mockResolvedValue([{ id: 'sf-1', kind: 'webauthn_credential' }]);
      const { challengeId, secret } = await startEnrollment({
        secondFactorId: 'sf-1',
        secondFactorVerifiedAtMs: Date.now() - 1000,
      });
      mocks.isActive.mockResolvedValue(false);

      const { status, body } = await call('/enroll/verify', {
        challenge_id: challengeId,
        code: (await currentCode(secret)).code,
      });

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'step_up_required' });
      expect(mocks.insertTotp).not.toHaveBeenCalled();
    });

    it('passes the approving factor to the insert, which refuses a revoked approval', async () => {
      mocks.listActiveByUser.mockResolvedValue([{ id: 'sf-1', kind: 'webauthn_credential' }]);
      const { challengeId, secret } = await startEnrollment({
        secondFactorId: 'sf-1',
        secondFactorVerifiedAtMs: Date.now() - 1000,
      });
      mocks.insertTotp.mockResolvedValue({ inserted: false, reason: 'approval_revoked' });

      const { status, body } = await call('/enroll/verify', {
        challenge_id: challengeId,
        code: (await currentCode(secret)).code,
      });

      expect(mocks.insertTotp.mock.calls[0][1]).toMatchObject({
        firstOnly: false,
        approvedBy: { factorId: 'sf-1', sessionId: 'sess-1' },
      });
      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'step_up_required' });
    });

    it.each([
      ['kind_in_use', 409, 'second_factor_kind_in_use'],
      ['enrollment_closed', 409, 'second_factor_recovery_required'],
      ['already_enrolled', 409, 'second_factor_already_enrolled'],
      ['session_ended', 401, 'session_ended'],
    ])('maps the refusal %s to %i %s', async (reason, expectedStatus, error) => {
      const { challengeId, secret } = await startEnrollment();
      mocks.insertTotp.mockResolvedValue({ inserted: false, reason });

      const { status, body } = await call('/enroll/verify', {
        challenge_id: challengeId,
        code: (await currentCode(secret)).code,
      });

      expect(status).toBe(expectedStatus);
      expect(body).toMatchObject({ error });
    });

    it.each([
      [{}],
      [{ challenge_id: 'x' }],
      [{ challenge_id: 'x', code: '12345' }],
      [{ code: '123456' }],
    ])('rejects the body %j', async (body) => {
      expect((await call('/enroll/verify', body)).status).toBe(400);
    });
  });

  describe('POST /verify', () => {
    async function stored(
      secret = SECRET,
      adminUserId = 'admin-1',
      lastUsed: number | null = null
    ) {
      const sealed = await sealAdminTotpSecret(ENV, adminUserId, secret);
      return {
        factor: { id: 'sf-t', kind: 'totp' },
        secret_encrypted: sealed!.encrypted,
        secret_key_version: sealed!.keyVersion,
        last_used_time_step: lastUsed,
      };
    }

    it('records the code as the session’s second factor, once', async () => {
      mocks.listActiveTotpSecrets.mockResolvedValue([await stored()]);
      const { code, step } = await currentCode();

      const { status, body } = await call('/verify', { code });

      expect(status).toBe(200);
      expect(body).toMatchObject({ verified: true });
      expect(mocks.recordTotpUse).toHaveBeenCalledWith('sf-t', {
        timeStep: step,
        usedAt: expect.any(Number),
      });
      expect(mocks.recordSecondFactorVerification).toHaveBeenCalledWith(
        'sess-1',
        { adminUserId: 'admin-1', secondFactorId: 'sf-t' },
        expect.any(Number)
      );
      expect(mocks.sessionRepoTenants).toEqual(['default']);
      expect(mocks.writeAdminAuditLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'admin.second_factor.verified',
          metadata: { second_factor_id: 'sf-t', kind: 'totp' },
        })
      );
    });

    it('refuses a code whose step was already used, even when it is still valid', async () => {
      const { code, step } = await currentCode();
      mocks.listActiveTotpSecrets.mockResolvedValue([await stored(SECRET, 'admin-1', step)]);

      const { status, body } = await call('/verify', { code });

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'verification_failed' });
      expect(mocks.recordTotpUse).not.toHaveBeenCalled();
      expect(mocks.recordSecondFactorVerification).not.toHaveBeenCalled();
    });

    it('gives no evidence when a concurrent request got the code first', async () => {
      mocks.listActiveTotpSecrets.mockResolvedValue([await stored()]);
      mocks.recordTotpUse.mockResolvedValue(false);

      const { status } = await call('/verify', { code: (await currentCode()).code });

      expect(status).toBe(400);
      expect(mocks.recordSecondFactorVerification).not.toHaveBeenCalled();
    });

    it('refuses a wrong code, and a secret that was sealed for another admin', async () => {
      mocks.listActiveTotpSecrets.mockResolvedValue([await stored()]);
      const { code } = await currentCode();
      expect(
        (await call('/verify', { code: code === '000000' ? '000001' : '000000' })).status
      ).toBe(400);

      mocks.listActiveTotpSecrets.mockResolvedValue([await stored(SECRET, 'admin-2')]);
      expect((await call('/verify', { code })).status).toBe(400);
      expect(mocks.recordTotpUse).not.toHaveBeenCalled();
    });

    it('answers no_second_factor when no authenticator app is registered', async () => {
      mocks.listActiveTotpSecrets.mockResolvedValue([]);

      const { status, body } = await call('/verify', { code: '123456' });

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'no_second_factor' });
    });

    it('records the evidence whatever the session tenant allows: the gate judges the tenant acted on', async () => {
      mocks.listActiveTotpSecrets.mockResolvedValue([await stored()]);
      mocks.readAdminStepUpPolicy.mockResolvedValue({ ...ALLOW_TOTP, allowedKinds: ['hardware'] });

      const { status } = await call('/verify', { code: (await currentCode()).code });

      expect(status).toBe(200);
      expect(mocks.recordSecondFactorVerification).toHaveBeenCalled();
      expect(mocks.readAdminStepUpPolicy).not.toHaveBeenCalled();
    });

    it('limits the attempts, and fails closed when the session ended meanwhile', async () => {
      mocks.listActiveTotpSecrets.mockResolvedValue([await stored()]);
      mocks.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 30 });
      expect((await call('/verify', { code: (await currentCode()).code })).status).toBe(429);

      mocks.recordSecondFactorVerification.mockResolvedValue(false);
      expect((await call('/verify', { code: (await currentCode()).code })).status).toBe(400);
    });

    it('rejects a body without a six-digit code', async () => {
      expect((await call('/verify', {})).status).toBe(400);
      expect((await call('/verify', { code: 'abcdef' })).status).toBe(400);
      expect((await call('/verify', { code: 123456 })).status).toBe(400);
    });
  });
});
