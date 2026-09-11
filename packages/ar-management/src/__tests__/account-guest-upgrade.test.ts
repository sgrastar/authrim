import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
const mocks = vi.hoisted(() => ({
  deliveryReady: vi.fn(),
  origin: vi.fn(),
  session: vi.fn(),
  accountSession: vi.fn(),
  lifecycle: vi.fn(),
  operation: vi.fn(),
  hold: vi.fn(),
  create: vi.fn(),
  verifyEmail: vi.fn(),
  verifyPasskey: vi.fn(),
  settings: vi.fn(),
  contract: vi.fn(),
  notification: vi.fn(),
  commit: vi.fn(),
  updateSession: vi.fn(),
  reserve: vi.fn(),
  registration: vi.fn(),
  verifyRegistration: vi.fn(),
  missing: vi.fn(),
  emailAddition: vi.fn(),
  userRead: vi.fn(),
  userSync: vi.fn(),
  profileSync: vi.fn(),
  execute: vi.fn(),
  audit: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../account-operation-log', () => ({ recordAccountOperation: mocks.audit }));
vi.mock('../account-page', () => ({ requireAccountSession: mocks.accountSession }));
vi.mock('../account-passkeys', () => ({
  getAccountWebAuthnOrigin: mocks.origin,
}));
vi.mock('../account-identifier-replacement', () => ({
  addVerifiedAccountEmail: mocks.emailAddition,
}));
vi.mock('../account-identifier-addition', () => ({
  buildAccountEmailAddition: vi.fn(async (value) => value),
  buildAccountExternalSubjectAddition: vi.fn(async (value) => value),
  publishAccountExternalSubjectAddition: vi.fn(),
}));
vi.mock('../account-directory-reservation', () => ({
  InitialAccountIdentifierReservationService: vi.fn(function () {
    return { reserve: mocks.reserve };
  }),
}));
vi.mock('../lookup-bucket-write-route', () => ({
  createLookupBucketWriteResolver: vi.fn(async () => vi.fn()),
}));
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: mocks.registration,
  verifyRegistrationResponse: mocks.verifyRegistration,
}));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  validateAccountDirectoryPublication: vi.fn(async (value) => value),
  getTenantIdFromContext: () => 'tenant',
  getSessionStoreBySessionId: () => ({
    stub: { getSessionRpc: mocks.session, updateSessionDataRpc: mocks.updateSession },
  }),
  createAccountAuthContextFromHono: () => ({ coreAdapter: { execute: mocks.execute } }),
  createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
  CanonicalRuntimeUserStore: vi.fn(function () {
    return { findById: mocks.userRead, syncUser: mocks.userSync };
  }),
  syncUserLifecycleState: mocks.profileSync,
  GuestLifecycleRepository: vi.fn(function () {
    return { get: mocks.lifecycle, acquireHold: mocks.hold };
  }),
  GuestUpgradeRepository: vi.fn(function () {
    return {
      get: mocks.operation,
      pinReservation: vi.fn(async (_id, value) => value),
      create: mocks.create,
      verifyEmail: mocks.verifyEmail,
      verifyPasskey: mocks.verifyPasskey,
      cancelUncommitted: vi.fn(),
    };
  }),
  resolveGuestSettings: mocks.settings,
  loadClientContractCached: mocks.contract,
  produceNotificationDelivery: mocks.notification,
  isNotificationDeliveryAvailable: mocks.deliveryReady,
  commitGuestUpgrade: mocks.commit,
  getAccountDataContextFromHono: () => ({
    legacyUserId: 'guest',
    accountId: 'account:guest',
    membership: { routeProjection: {} },
  }),
  resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(async () => ({ nonPiiDb: {} })),
  getMissingRequiredCustomClaims: mocks.missing,
  getLogger: vi.fn(() => ({
    module: () => ({ error: mocks.logError }),
  })),
}));
import {
  getAccountGuestUpgradeHandler,
  startAccountGuestUpgradeHandler,
  completeAccountGuestUpgradeHandler,
} from '../account-guest-upgrade';
const token = 'a'.repeat(64);
const operation = async () => ({
  operation_id: 'op',
  tenant_id: 'tenant',
  user_id: 'guest',
  client_id: 'client',
  initiating_session_id: 'session',
  request_token_hash: Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
    (x) => x.toString(16).padStart(2, '0')
  ).join(''),
  method: 'email',
  state: 'awaiting_proof',
  expires_at: Math.floor(Date.now() / 1000) + 600,
  proof_payload_json: '{"email":"test@example.org"}',
});
function context(body: unknown = {}) {
  const headers = new Headers();
  return {
    env: { ACCOUNT_DIRECTORY: {}, OTP_HMAC_SECRET: 'test-only-guest-otp-secret-at-least-32-bytes' },
    req: { json: async () => body },
    header: (k: string, v: string) => headers.set(k, v),
    json: (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers }),
  } as unknown as Context<{ Bindings: Env }>;
}
describe('account guest upgrade API', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.origin.mockReturnValue('https://login.example.org');
    mocks.deliveryReady.mockResolvedValue(true);
    mocks.accountSession.mockResolvedValue({ userId: 'guest', sessionId: 'session' });
    mocks.session.mockResolvedValue({
      id: 'session',
      userId: 'guest',
      tenantId: 'tenant',
      expiresAt: Date.now() + 600000,
      data: { client_id: 'client', is_guest_session: true },
    });
    mocks.lifecycle.mockResolvedValue({
      phase: 'active',
      client_id: 'client',
      deletion_due_at: 100,
      upgrade_hold_until: null,
    });
    mocks.hold.mockResolvedValue({ phase: 'active' });
    mocks.operation.mockResolvedValue(await operation());
    mocks.settings.mockResolvedValue({
      loginEnabled: false,
      policy: { upgradeEnabled: true, upgradeHoldMinutes: 10 },
      upgradeMethods: ['email', 'passkey'],
    });
    mocks.contract.mockResolvedValue({
      guestAuth: { allowedUpgradeMethods: ['email', 'passkey'] },
    });
    mocks.notification.mockResolvedValue({ delivery: 'pending' });
    mocks.commit.mockResolvedValue('completed');
    mocks.reserve.mockResolvedValue({ reservedCount: 1 });
    mocks.verifyEmail.mockResolvedValue(false);
    mocks.missing.mockResolvedValue([]);
    mocks.userRead.mockResolvedValue({
      tenant_id: 'tenant',
      account_type: 'user',
      registration_state: 'guest',
      status: 'active',
    });
  });
  it.each(['active', 'upgrading', 'registered'])(
    'returns the unified registration contract for %s',
    async (phase) => {
      mocks.lifecycle.mockResolvedValue({ phase, client_id: 'client', deletion_due_at: null });
      const response = await getAccountGuestUpgradeHandler(context());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        status: 'active',
        registration_state: phase === 'registered' ? 'registered' : 'guest',
      });
      expect(body).not.toHaveProperty('account_kind');
    }
  );
  it('rejects a user projection from another tenant', async () => {
    mocks.userRead.mockResolvedValue({ tenant_id: 'other', status: 'active' });
    expect((await getAccountGuestUpgradeHandler(context())).status).toBe(409);
  });
  it('keeps deadline visible when upgrade is disabled', async () => {
    mocks.settings.mockResolvedValue({
      policy: { upgradeEnabled: false },
      upgradeMethods: ['email'],
    });
    const result = await getAccountGuestUpgradeHandler(context());
    expect(await result.json()).toMatchObject({
      deletion_due_at: 100,
      upgrade_eligible: false,
      allowed_methods: [],
    });
    expect(mocks.hold).not.toHaveBeenCalled();
  });
  it.each([
    ['session', true],
    ['another-session', false],
  ])(
    'repairs only the initiating session after durable completion (%s)',
    async (initiatingSession, expected) => {
      mocks.lifecycle.mockResolvedValue({
        phase: 'registered',
        client_id: 'client',
        upgrade_operation_id: 'op',
        upgraded_at: 1234,
      });
      mocks.operation.mockResolvedValue({
        ...(await operation()),
        state: 'completed',
        initiating_session_id: initiatingSession,
      });
      expect((await getAccountGuestUpgradeHandler(context())).status).toBe(200);
      expect(mocks.updateSession).toHaveBeenCalledTimes(expected ? 1 : 0);
      if (expected)
        expect(mocks.updateSession).toHaveBeenCalledWith(
          'session',
          expect.objectContaining({ is_guest_session: false, amr: ['otp'], authTime: 1234 }),
          { onlyIfGuestSession: true }
        );
    }
  );
  it('starts email registration even with guest login disabled and accepts queued delivery', async () => {
    const response = await startAccountGuestUpgradeHandler(
      context({ method: 'email', email: 'test@example.org' })
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { upgrade_token: string };
    expect(data.upgrade_token).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'guest',
        clientId: 'client',
        sessionId: 'session',
        payloadJson: '{"email":"test@example.org"}',
      })
    );
    expect(mocks.hold).toHaveBeenCalledWith('guest', expect.any(Number), 10);
    expect(mocks.notification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'guest',
        owner: { owner: 'tenant', tenantId: 'tenant' },
      })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'guest',
        action: 'account.guest.upgrade_started',
        required: true,
        metadata: expect.objectContaining({ method: 'email' }),
      })
    );
  });
  it.each([
    null,
    { method: 'social' },
    { method: 'email', email: 'invalid' },
    { method: 'passkey', preserve_sub: false },
  ])('rejects malformed input before spending the hold (%j)', async (body) => {
    expect((await startAccountGuestUpgradeHandler(context(body))).status).toBe(400);
    expect(mocks.hold).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('starts a discoverable passkey bound to the original subject and origin', async () => {
    mocks.registration.mockResolvedValue({ challenge: 'original-challenge' });
    const response = await startAccountGuestUpgradeHandler(context({ method: 'passkey' }));
    expect(response.status).toBe(200);
    expect(mocks.registration).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'login.example.org',
        userID: new TextEncoder().encode('guest'),
        authenticatorSelection: expect.objectContaining({
          userVerification: 'required',
          residentKey: 'required',
        }),
      })
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'guest',
        method: 'passkey',
        verifier: 'original-challenge',
        payloadJson: JSON.stringify({
          origin: 'https://login.example.org',
          rpId: 'login.example.org',
        }),
      })
    );
    expect(mocks.notification).not.toHaveBeenCalled();
  });
  it.each(['wrong-origin', 'invalid-signature', 'missing-response'])(
    'rejects passkey proof before persistence (%s)',
    async (failure) => {
      mocks.operation.mockResolvedValue({
        ...(await operation()),
        method: 'passkey',
        challenge_verifier: 'challenge',
        proof_payload_json: JSON.stringify({
          origin:
            failure === 'wrong-origin' ? 'https://other.example.org' : 'https://login.example.org',
          rpId: 'login.example.org',
        }),
      });
      mocks.verifyRegistration.mockResolvedValue({ verified: false });
      const response = await completeAccountGuestUpgradeHandler(
        context({
          operation_id: 'op',
          upgrade_token: token,
          ...(failure !== 'missing-response' && { passkey_response: {} }),
        })
      );
      expect(response.status).toBe(400);
      expect(mocks.verifyPasskey).not.toHaveBeenCalled();
      expect(mocks.commit).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: 'guest',
          action: 'account.guest.upgrade_failed',
          metadata: expect.objectContaining({ operationId: 'op', reason: 'invalid_upgrade_proof' }),
        })
      );
      if (failure === 'invalid-signature')
        expect(mocks.verifyRegistration).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedOrigin: 'https://login.example.org',
            expectedRPID: 'login.example.org',
            expectedChallenge: 'challenge',
            requireUserVerification: true,
          })
        );
    }
  );
  it('rejects cross-tenant and expired sessions before reading account state', async () => {
    mocks.session.mockResolvedValue({
      userId: 'guest',
      tenantId: 'other',
      expiresAt: Date.now() + 10000,
    });
    expect((await startAccountGuestUpgradeHandler(context({ method: 'passkey' }))).status).toBe(
      401
    );
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });
  it('rejects disabled methods before proof creation', async () => {
    mocks.contract.mockResolvedValue({ guestAuth: { allowedUpgradeMethods: ['passkey'] } });
    expect(
      (
        await startAccountGuestUpgradeHandler(
          context({ method: 'email', email: 'test@example.org' })
        )
      ).status
    ).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it('rejects a token from another session', async () => {
    mocks.operation.mockResolvedValue({ ...(await operation()), initiating_session_id: 'other' });
    expect(
      (
        await completeAccountGuestUpgradeHandler(
          context({ operation_id: 'op', upgrade_token: token, code: '123456' })
        )
      ).status
    ).toBe(400);
    expect(mocks.verifyEmail).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('does not commit an invalid OTP', async () => {
    expect(
      (
        await completeAccountGuestUpgradeHandler(
          context({ operation_id: 'op', upgrade_token: token, code: '123456' })
        )
      ).status
    ).toBe(400);
    expect(mocks.verifyEmail).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'guest', sessionId: 'session', operationId: 'op' })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'guest',
        action: 'account.guest.upgrade_failed',
        metadata: expect.objectContaining({ operationId: 'op', reason: 'invalid_upgrade_proof' }),
      })
    );
    expect(mocks.commit).not.toHaveBeenCalled();
  });
  it('returns an existing-login choice on identity collision without admission', async () => {
    mocks.operation.mockResolvedValue({ ...(await operation()), state: 'verified' });
    mocks.reserve.mockRejectedValueOnce(new Error('directory_identifier_reservation_conflict'));
    const result = await completeAccountGuestUpgradeHandler(
      context({ operation_id: 'op', upgrade_token: token })
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({
      error: 'identity_already_registered',
      existing_login_available: true,
    });
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
  it('does not refresh authentication when a completed operation is retried', async () => {
    mocks.operation.mockResolvedValue({ ...(await operation()), state: 'completed' });
    mocks.lifecycle.mockResolvedValue({
      phase: 'registered',
      client_id: 'client',
      upgraded_at: 123,
    });
    mocks.session.mockResolvedValue({
      id: 'session',
      userId: 'guest',
      tenantId: 'tenant',
      expiresAt: Date.now() + 600000,
      data: { client_id: 'client', is_guest_session: false, authTime: 456, amr: ['webauthn'] },
    });
    const result = await completeAccountGuestUpgradeHandler(
      context({ operation_id: 'op', upgrade_token: token })
    );
    expect(result.status).toBe(200);
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
  it('repairs a guest session using the durable completion timestamp', async () => {
    mocks.operation.mockResolvedValue({ ...(await operation()), state: 'completed' });
    mocks.lifecycle.mockResolvedValue({
      phase: 'registered',
      client_id: 'client',
      upgraded_at: 123,
    });
    const result = await completeAccountGuestUpgradeHandler(
      context({ operation_id: 'op', upgrade_token: token })
    );
    expect(result.status).toBe(200);
    expect(mocks.updateSession).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        authTime: 123,
        upgraded_at: 123000,
        guest_resume_credential_hash: undefined,
      }),
      { onlyIfGuestSession: true }
    );
    expect(mocks.updateSession.mock.calls[0][1]).not.toHaveProperty('device_id_hash');
  });
  it('retains the subject and clears guest resume authentication after completion', async () => {
    mocks.operation.mockResolvedValue({ ...(await operation()), state: 'verified' });
    const result = await completeAccountGuestUpgradeHandler(
      context({ operation_id: 'op', upgrade_token: token })
    );
    expect(await result.json()).toEqual({ success: true, user_id: 'guest', preserve_sub: true });
    expect(mocks.updateSession).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        is_guest_session: false,
        guest_resume_credential: false,
        guest_resume_credential_hash: undefined,
        amr: ['otp'],
      }),
      { onlyIfGuestSession: true }
    );
    expect(mocks.updateSession.mock.calls[0][1]).not.toHaveProperty('device_id_hash');
  });
  it('commits verified email to the same account and synchronizes incomplete profile independently', async () => {
    const op = {
      ...(await operation()),
      state: 'verified',
      reservation_publication_json: '{"operationId":"pinned"}',
    };
    mocks.operation.mockResolvedValue(op);
    mocks.userRead.mockResolvedValue({
      account_type: 'user',
      registration_state: 'guest',
      name: 'Guest',
      email: null,
      email_verified: 0,
    });
    mocks.profileSync.mockResolvedValue({
      lifecycleState: 'incomplete',
      missingRequiredFields: [{ fieldKey: 'name' }],
    });
    mocks.commit.mockImplementationOnce(async (input) => {
      await input.commit(op);
      return 'completed';
    });
    const response = await completeAccountGuestUpgradeHandler(
      context({ operation_id: 'op', upgrade_token: token })
    );
    expect(response.status).toBe(200);
    expect(mocks.emailAddition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'guest',
        email: 'test@example.org',
        preparedPublication: { operationId: 'pinned' },
      })
    );
    expect(mocks.userSync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'guest', userType: 'end_user', emailVerified: true })
    );
    expect(mocks.profileSync).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant', userId: 'guest' })
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE guest_devices SET is_active = FALSE'),
      ['tenant', 'guest']
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO guest_account_upgrades'),
      expect.arrayContaining(['op', 'tenant', 'guest', 'guest', 'email'])
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'guest', action: 'account.guest.upgraded' })
    );
  });
  it('does not elevate the session if credential publication fails', async () => {
    const op = { ...(await operation()), state: 'verified', reservation_publication_json: '{}' };
    mocks.operation.mockResolvedValue(op);
    mocks.emailAddition.mockRejectedValueOnce(new Error('outbox unavailable'));
    mocks.commit.mockImplementationOnce(async (input) => {
      await input.commit(op);
      return 'completed';
    });
    expect(
      (
        await completeAccountGuestUpgradeHandler(
          context({ operation_id: 'op', upgrade_token: token })
        )
      ).status
    ).toBe(503);
    expect(mocks.userSync).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
  it('does not elevate the session for an in-progress commit', async () => {
    mocks.operation.mockResolvedValue({ ...(await operation()), state: 'committing' });
    mocks.commit.mockResolvedValue('pending');
    expect(
      (
        await completeAccountGuestUpgradeHandler(
          context({ operation_id: 'op', upgrade_token: token })
        )
      ).status
    ).toBe(202);
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
  it('fails closed on unavailable configuration', async () => {
    mocks.settings.mockRejectedValueOnce(new Error('settings_read_failed'));
    expect(
      (
        await startAccountGuestUpgradeHandler(
          context({ method: 'email', email: 'test@example.org' })
        )
      ).status
    ).toBe(503);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), {
      userId: 'guest',
      action: 'account.guest.upgrade_failed',
      required: true,
      metadata: { stage: 'start', reason: 'guest_upgrade_unavailable' },
    });
  });
  it('audits an unexpected completion failure after the guest session is identified', async () => {
    mocks.operation.mockRejectedValueOnce(new Error('operation_read_failed'));

    const response = await completeAccountGuestUpgradeHandler(
      context({ operation_id: 'op', upgrade_token: token, code: '123456' })
    );

    expect(response.status).toBe(503);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), {
      userId: 'guest',
      action: 'account.guest.upgrade_failed',
      required: true,
      metadata: { stage: 'complete', reason: 'guest_upgrade_unavailable' },
    });
  });
  it.each([
    ['status', () => getAccountGuestUpgradeHandler(context())],
    [
      'start',
      () =>
        startAccountGuestUpgradeHandler(context({ method: 'email', email: 'test@example.org' })),
    ],
    [
      'complete',
      () =>
        completeAccountGuestUpgradeHandler(
          context({ operation_id: 'op', upgrade_token: token, code: '123456' })
        ),
    ],
  ])('logs an unexpected %s failure without error details', async (stage, invoke) => {
    mocks.session.mockRejectedValueOnce(new Error('private-address@example.org'));

    const response = await invoke();

    expect(response.status).toBe(503);
    expect(mocks.logError).toHaveBeenCalledWith('Guest account upgrade request failed', {
      action: 'guest_upgrade',
      stage,
      errorType: 'Error',
    });
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain('private-address@example.org');
  });
});

describe('guest upgrade prerequisite admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountSession.mockResolvedValue({ userId: 'guest', sessionId: 'session' });
    mocks.session.mockResolvedValue({
      id: 'session',
      userId: 'guest',
      tenantId: 'tenant',
      expiresAt: Date.now() + 600000,
      data: { client_id: 'client' },
    });
    mocks.lifecycle.mockResolvedValue({ phase: 'active', client_id: 'client' });
    mocks.settings.mockResolvedValue({
      policy: { upgradeEnabled: true },
      upgradeMethods: ['email', 'passkey'],
    });
    mocks.contract.mockResolvedValue({
      guestAuth: { allowedUpgradeMethods: ['email', 'passkey'] },
    });
    mocks.origin.mockReturnValue('https://login.example.org');
    mocks.deliveryReady.mockResolvedValue(true);
    mocks.missing.mockResolvedValue([]);
    mocks.userRead.mockResolvedValue({
      tenant_id: 'tenant',
      account_type: 'user',
      registration_state: 'guest',
      status: 'active',
    });
  });
  it.each(['secret', 'delivery', 'origin'])(
    'hides unavailable %s and rejects start before acquiring a hold',
    async (failure) => {
      const c = context({
        method: failure === 'origin' ? 'passkey' : 'email',
        email: 'test@example.org',
      });
      if (failure === 'secret') c.env.OTP_HMAC_SECRET = 'short';
      if (failure === 'delivery') mocks.deliveryReady.mockResolvedValue(false);
      if (failure === 'origin') mocks.origin.mockReturnValue(null);
      const status = await getAccountGuestUpgradeHandler(c);
      expect(await status.json()).toMatchObject({
        allowed_methods: [failure === 'origin' ? 'email' : 'passkey'],
      });
      const start = await startAccountGuestUpgradeHandler(c);
      expect(start.status).toBe(403);
      expect(mocks.hold).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.notification).not.toHaveBeenCalled();
    }
  );
  it('reports no eligibility when every method is unavailable', async () => {
    mocks.deliveryReady.mockResolvedValue(false);
    mocks.origin.mockReturnValue('http://insecure.example.org');
    const response = await getAccountGuestUpgradeHandler(context());
    expect(await response.json()).toMatchObject({ upgrade_eligible: false, allowed_methods: [] });
  });
});
