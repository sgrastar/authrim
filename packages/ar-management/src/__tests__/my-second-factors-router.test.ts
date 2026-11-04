import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const NOW = Date.now();

const mocks = vi.hoisted(() => ({
  listActiveByUser: vi.fn(),
  listByUser: vi.fn(),
  getEnrollmentGraceEndsAt: vi.fn(),
  insertWebAuthn: vi.fn(),
  revoke: vi.fn(),
  getPasskeysByUser: vi.fn(),
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  requireAdminStepUp: vi.fn(),
  writeAdminAuditLog: vi.fn(),
  refuseRecoveryRequest: vi.fn(),
  fileRecoveryRequest: vi.fn(),
  auth: {},
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
}));

vi.mock('../admin-shared', () => ({ writeAdminAuditLog: mocks.writeAdminAuditLog }));

vi.mock('../routes/admin-management/my-second-factor-recovery', () => ({
  refuseRecoveryRequest: mocks.refuseRecoveryRequest,
  fileRecoveryRequest: mocks.fileRecoveryRequest,
}));

vi.mock('../admin-step-up-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../admin-step-up-gate')>();
  return { ...actual, requireAdminStepUp: mocks.requireAdminStepUp };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  class MockAdminSecondFactorRepository {
    listActiveByUser = mocks.listActiveByUser;
    listByUser = mocks.listByUser;
    getEnrollmentGraceEndsAt = mocks.getEnrollmentGraceEndsAt;
    insertWebAuthn = mocks.insertWebAuthn;
    revoke = mocks.revoke;
  }
  class MockAdminPasskeyRepository {
    getPasskeysByUser = mocks.getPasskeysByUser;
  }
  const status: Record<string, number> = {
    [actual.AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: 400,
    [actual.AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: 403,
    [actual.AR_ERROR_CODES.INTERNAL_ERROR]: 500,
  };
  return {
    ...actual,
    AdminSecondFactorRepository: MockAdminSecondFactorRepository,
    AdminPasskeyRepository: MockAdminPasskeyRepository,
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

import { mySecondFactorsRouter } from '../routes/admin-management/my-second-factors';

const ORIGIN = 'https://admin.example.com';

function human(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    email: 'admin@example.com',
    authMethod: 'session',
    actorType: 'human',
    roles: [],
    tenantId: 'default',
    sessionTenantId: 'default',
    sessionId: 'sess-1',
    mfaVerified: true,
    authenticationTimeMs: NOW - 1000,
    ...overrides,
  };
}

function factor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sf-1',
    admin_user_id: 'admin-1',
    kind: 'webauthn_credential',
    credential_id: 'cred-1',
    holder_jkt: null,
    public_key: 'cGs=',
    counter: 0,
    transports: ['usb'],
    aaguid: null,
    backup_eligible: false,
    backup_state: false,
    label: 'Key',
    created_at: 1,
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

async function call(method: string, path: string, body?: unknown) {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/admin/me/second-factors', mySecondFactorsRouter);
  const response = await app.request(
    `/api/admin/me/second-factors${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { ADMIN_UI_URL: ORIGIN }
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

function registrationChallenge(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    challenge: 'webauthn-challenge',
    metadata: {
      rpID: 'admin.example.com',
      origin: ORIGIN,
      sessionId: 'sess-1',
      mode: 'step_up',
      label: 'Key',
    },
    ...overrides,
  };
}

function registered(overrides: Record<string, unknown> = {}) {
  return {
    verified: true,
    registrationInfo: {
      credential: { id: 'cred-new', publicKey: new Uint8Array([1, 2]), counter: 0 },
      aaguid: 'aaguid-1',
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
      ...overrides,
    },
  };
}

const verifyBody = {
  challenge_id: 'challenge-id',
  credential: { id: 'cred-new', response: { transports: ['usb', 'bogus'] } },
};

describe('mySecondFactorsRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth = human();
    mocks.listActiveByUser.mockResolvedValue([factor()]);
    mocks.listByUser.mockResolvedValue([factor()]);
    mocks.getEnrollmentGraceEndsAt.mockResolvedValue(NOW - 1);
    mocks.getPasskeysByUser.mockResolvedValue([{ credential_id: 'cred-login' }]);
    mocks.generateRegistrationOptions.mockResolvedValue({ challenge: 'webauthn-challenge' });
    mocks.requireAdminStepUp.mockResolvedValue(null);
    mocks.consumeChallengeRpc.mockResolvedValue(registrationChallenge());
    mocks.verifyRegistrationResponse.mockResolvedValue(registered());
    mocks.insertWebAuthn.mockImplementation(async (input: Record<string, unknown>) => ({
      inserted: true,
      factor: factor({ id: 'sf-new', credential_id: input.credential_id }),
    }));
    mocks.revoke.mockResolvedValue({ revoked: true });
  });

  describe('list', () => {
    it('lists the factors without key material and says how to register next', async () => {
      const { status, body } = await call('GET', '');

      expect(status).toBe(200);
      expect(body).toEqual({
        second_factors: [
          {
            id: 'sf-1',
            kind: 'webauthn_credential',
            label: 'Key',
            aaguid: null,
            created_at: 1,
            last_used_at: null,
            revoked_at: null,
          },
        ],
        active_count: 1,
        minimum: 1,
        enrollment: { mode: 'step_up', first_enrollment_ends_at: NOW - 1 },
      });
    });

    it('refuses a machine caller', async () => {
      mocks.auth = human({ authMethod: 'machine_access_token', actorType: 'machine' });
      expect((await call('GET', '')).status).toBe(403);
    });
  });

  describe('registration options', () => {
    it('needs an L2 receipt once a factor exists, and excludes known credentials', async () => {
      const { status, body } = await call('POST', '/webauthn/options', {
        rp_id: 'admin.example.com',
        label: ' Key ',
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({ challenge_id: 'challenge-id', mode: 'step_up' });
      const [, descriptor] = mocks.requireAdminStepUp.mock.calls[0] as [unknown, unknown];
      expect(descriptor).toEqual({
        operation: 'admin.second_factor.add',
        targetTenantId: 'default',
        targetIds: ['admin-1'],
      });
      const [options] = mocks.generateRegistrationOptions.mock.calls[0] as [
        { excludeCredentials: Array<{ id: string }>; authenticatorSelection: unknown },
      ];
      expect(options.excludeCredentials.map((item) => item.id)).toEqual(['cred-login', 'cred-1']);
      expect(options.authenticatorSelection).toEqual({
        residentKey: 'discouraged',
        userVerification: 'required',
      });
      const [stored] = mocks.storeChallengeRpc.mock.calls[0] as [Record<string, unknown>];
      expect(stored).toMatchObject({
        tenantId: 'default',
        type: 'admin_second_factor_registration',
        userId: 'admin-1',
        metadata: { sessionId: 'sess-1', mode: 'step_up', label: 'Key', origin: ORIGIN },
      });
    });

    it('returns the gate refusal and stores nothing without a receipt', async () => {
      mocks.requireAdminStepUp.mockResolvedValue(
        new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
      );

      const { status, body } = await call('POST', '/webauthn/options', {
        rp_id: 'admin.example.com',
      });

      expect(status).toBe(403);
      expect(body).toEqual({ error: 'step_up_required' });
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('lets the first factor in with a fresh passkey inside the window', async () => {
      mocks.listActiveByUser.mockResolvedValue([]);
      mocks.getEnrollmentGraceEndsAt.mockResolvedValue(NOW + 60_000);

      const { status, body } = await call('POST', '/webauthn/options', {
        rp_id: 'admin.example.com',
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({ mode: 'first' });
      expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    });

    it('asks for a passkey re-authentication on a first factor with an old passkey', async () => {
      mocks.listActiveByUser.mockResolvedValue([]);
      mocks.getEnrollmentGraceEndsAt.mockResolvedValue(NOW + 60_000);
      mocks.auth = human({ authenticationTimeMs: NOW - 10 * 60_000 });

      const { status, body } = await call('POST', '/webauthn/options', {
        rp_id: 'admin.example.com',
      });

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'admin_fresh_auth_required', fresh_auth_required: true });
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('sends an admin without factors past the window to recovery', async () => {
      mocks.listActiveByUser.mockResolvedValue([]);

      const { status, body } = await call('POST', '/webauthn/options', {
        rp_id: 'admin.example.com',
      });

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'second_factor_recovery_required' });
      expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    });

    it('checks a recovery request instead of the enrollment rules', async () => {
      mocks.listActiveByUser.mockResolvedValue([]);
      mocks.refuseRecoveryRequest.mockResolvedValue(null);

      const { status, body } = await call('POST', '/webauthn/options', {
        rp_id: 'admin.example.com',
        purpose: 'recovery',
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({ mode: 'recovery' });
      expect(mocks.refuseRecoveryRequest).toHaveBeenCalledOnce();
      expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
      expect(mocks.storeChallengeRpc.mock.calls[0]?.[0]).toMatchObject({
        metadata: { mode: 'recovery' },
      });
    });

    it('returns the recovery refusal', async () => {
      mocks.refuseRecoveryRequest.mockResolvedValue(
        new Response(JSON.stringify({ error: 'recovery_requires_last_resort' }), { status: 403 })
      );

      const { status, body } = await call('POST', '/webauthn/options', {
        rp_id: 'admin.example.com',
        purpose: 'recovery',
      });

      expect(status).toBe(403);
      expect(body).toEqual({ error: 'recovery_requires_last_resort' });
      expect(mocks.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it.each([
      [{}],
      [{ rp_id: 'admin.example.com', purpose: 'other' }],
      [{ rp_id: '' }],
      [{ rp_id: 'admin.example.com', label: 7 }],
      [{ rp_id: 'admin.example.com', label: 'x'.repeat(65) }],
      [{ rp_id: 'evil.example.net' }],
      [null],
      [[]],
    ])('rejects the body %j', async (body) => {
      expect((await call('POST', '/webauthn/options', body)).status).toBe(400);
      expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    });
  });

  describe('registration', () => {
    it('stores a device-bound credential with the challenge mode and audits it', async () => {
      const { status, body } = await call('POST', '/webauthn/verify', verifyBody);

      expect(status).toBe(201);
      expect(body).toMatchObject({ second_factor: { id: 'sf-new' } });
      const [input, options] = mocks.insertWebAuthn.mock.calls[0] as [
        Record<string, unknown>,
        unknown,
      ];
      expect(input).toEqual({
        admin_user_id: 'admin-1',
        credential_id: 'cred-new',
        public_key: btoa(String.fromCharCode(1, 2)),
        counter: 0,
        transports: ['usb'],
        aaguid: 'aaguid-1',
        backup_eligible: false,
        backup_state: false,
        label: 'Key',
      });
      expect(options).toEqual({ firstOnly: false });
      expect(mocks.verifyRegistrationResponse.mock.calls[0]?.[0]).toMatchObject({
        expectedChallenge: 'webauthn-challenge',
        expectedOrigin: ORIGIN,
        expectedRPID: 'admin.example.com',
        requireUserVerification: true,
      });
      const [, audit] = mocks.writeAdminAuditLog.mock.calls[0] as [unknown, unknown];
      expect(audit).toMatchObject({
        action: 'admin.second_factor.added',
        resourceId: 'sf-new',
        metadata: { kind: 'webauthn_credential', mode: 'step_up' },
      });
    });

    it('registers a first factor only while none exists', async () => {
      mocks.consumeChallengeRpc.mockResolvedValue(
        registrationChallenge({
          metadata: { ...registrationChallenge().metadata, mode: 'first' },
        })
      );
      mocks.insertWebAuthn.mockResolvedValue({ inserted: false, reason: 'already_enrolled' });

      const { status, body } = await call('POST', '/webauthn/verify', verifyBody);

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'second_factor_already_enrolled' });
      expect(mocks.insertWebAuthn.mock.calls[0]?.[1]).toEqual({ firstOnly: true });
    });

    it.each([
      ['a synced credential', { credentialDeviceType: 'multiDevice', credentialBackedUp: true }],
      ['a backup-eligible credential', { credentialDeviceType: 'multiDevice' }],
      ['a backed-up single-device credential', { credentialBackedUp: true }],
    ])('refuses %s', async (_label, info) => {
      mocks.verifyRegistrationResponse.mockResolvedValue(registered(info));

      const { status, body } = await call('POST', '/webauthn/verify', verifyBody);

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'second_factor_not_device_bound' });
      expect(mocks.insertWebAuthn).not.toHaveBeenCalled();
    });

    it('sends a first registration after the window closed to recovery', async () => {
      mocks.insertWebAuthn.mockResolvedValue({ inserted: false, reason: 'enrollment_closed' });

      const { status, body } = await call('POST', '/webauthn/verify', verifyBody);

      expect(status).toBe(403);
      expect(body).toMatchObject({ error: 'second_factor_recovery_required' });
      expect(mocks.writeAdminAuditLog).not.toHaveBeenCalled();
    });

    it('files a recovery request with the new key instead of registering it', async () => {
      mocks.consumeChallengeRpc.mockResolvedValue(
        registrationChallenge({
          metadata: { ...registrationChallenge().metadata, mode: 'recovery' },
        })
      );
      mocks.fileRecoveryRequest.mockResolvedValue(
        new Response(JSON.stringify({ recovery: { id: 'rec-1' } }), { status: 201 })
      );

      const { status, body } = await call('POST', '/webauthn/verify', verifyBody);

      expect(status).toBe(201);
      expect(body).toEqual({ recovery: { id: 'rec-1' } });
      expect(mocks.insertWebAuthn).not.toHaveBeenCalled();
      expect(mocks.fileRecoveryRequest.mock.calls[0]?.[2]).toEqual({
        credential_id: 'cred-new',
        public_key: btoa(String.fromCharCode(1, 2)),
        counter: 0,
        transports: ['usb'],
        aaguid: 'aaguid-1',
        label: 'Key',
      });
    });

    it('refuses a synced key for a recovery request too', async () => {
      mocks.consumeChallengeRpc.mockResolvedValue(
        registrationChallenge({
          metadata: { ...registrationChallenge().metadata, mode: 'recovery' },
        })
      );
      mocks.verifyRegistrationResponse.mockResolvedValue(
        registered({ credentialDeviceType: 'multiDevice' })
      );

      expect((await call('POST', '/webauthn/verify', verifyBody)).status).toBe(400);
      expect(mocks.fileRecoveryRequest).not.toHaveBeenCalled();
    });

    it('reports a credential already in use', async () => {
      mocks.insertWebAuthn.mockResolvedValue({ inserted: false, reason: 'credential_in_use' });

      const { status, body } = await call('POST', '/webauthn/verify', verifyBody);

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'credential_in_use' });
    });

    it.each([
      ['another admin', { userId: 'admin-2' }],
      ['another session', { metadata: { ...registrationChallenge().metadata, sessionId: 's2' } }],
      [
        'another origin',
        { metadata: { ...registrationChallenge().metadata, origin: 'https://x' } },
      ],
      ['an unknown mode', { metadata: { ...registrationChallenge().metadata, mode: 'other' } }],
    ])('refuses a challenge for %s', async (_label, overrides) => {
      mocks.consumeChallengeRpc.mockResolvedValue(registrationChallenge(overrides));

      const { status, body } = await call('POST', '/webauthn/verify', verifyBody);

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'invalid_challenge' });
      expect(mocks.verifyRegistrationResponse).not.toHaveBeenCalled();
    });

    it('refuses an unknown or used challenge', async () => {
      mocks.consumeChallengeRpc.mockRejectedValue(new Error('consumed'));

      expect((await call('POST', '/webauthn/verify', verifyBody)).body).toMatchObject({
        error: 'invalid_challenge',
      });
    });

    it('refuses a registration that does not verify', async () => {
      mocks.verifyRegistrationResponse.mockRejectedValue(new Error('bad attestation'));

      const { status, body } = await call('POST', '/webauthn/verify', verifyBody);

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'verification_failed' });
    });
  });

  describe('removal', () => {
    beforeEach(() => {
      mocks.listActiveByUser.mockResolvedValue([factor(), factor({ id: 'sf-2' })]);
    });

    it('revokes with an L2 receipt for that factor', async () => {
      const { status, body } = await call('DELETE', '/sf-1');

      expect(status).toBe(200);
      expect(body).toEqual({ revoked: true });
      const [, descriptor] = mocks.requireAdminStepUp.mock.calls[0] as [unknown, unknown];
      expect(descriptor).toEqual({
        operation: 'admin.second_factor.remove',
        targetTenantId: 'default',
        targetIds: ['sf-1'],
      });
      expect(mocks.revoke).toHaveBeenCalledWith('admin-1', 'sf-1');
      expect(mocks.writeAdminAuditLog.mock.calls[0]?.[1]).toMatchObject({
        action: 'admin.second_factor.revoked',
        resourceId: 'sf-1',
      });
    });

    it('refuses the last factor before spending a receipt', async () => {
      mocks.listActiveByUser.mockResolvedValue([factor()]);

      const { status, body } = await call('DELETE', '/sf-1');

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'second_factor_minimum', minimum: 1 });
      expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    });

    it('reports the minimum when a concurrent removal got there first', async () => {
      mocks.revoke.mockResolvedValue({ revoked: false, reason: 'minimum_reached' });

      expect((await call('DELETE', '/sf-1')).status).toBe(409);
    });

    it('does not reveal factors that are not the caller’s', async () => {
      const { status } = await call('DELETE', '/sf-other');

      expect(status).toBe(404);
      expect(mocks.requireAdminStepUp).not.toHaveBeenCalled();
    });

    it('returns the gate refusal without revoking', async () => {
      mocks.requireAdminStepUp.mockResolvedValue(
        new Response(JSON.stringify({ error: 'step_up_required' }), { status: 403 })
      );

      expect((await call('DELETE', '/sf-1')).status).toBe(403);
      expect(mocks.revoke).not.toHaveBeenCalled();
    });
  });
});
