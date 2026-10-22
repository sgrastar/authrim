import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapter: {
    queryOne: vi.fn(),
  },
  findActiveInvitationByToken: vi.fn(),
  hasRemainingInvitationUses: vi.fn(),
  invitationHasUsesLeft: vi.fn(),
  resolveEffectiveSettings: vi.fn(),
  store: {
    storeChallengeRpc: vi.fn(),
    getChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
    deleteChallengeRpc: vi.fn(),
  },
  getChallengeStoreByChallengeId: vi.fn(),
  produceNotificationDelivery: vi.fn(),
  incrementRpc: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    resolveOptionalCoreAdapterFromHono: vi.fn(() => mocks.adapter),
    resolveEffectiveSettings: mocks.resolveEffectiveSettings,
    resolveEmailSendLimit: vi.fn(async () => ({ windowSeconds: 900, maxRequests: 3 })),
    getChallengeStoreByChallengeId: mocks.getChallengeStoreByChallengeId,
    produceNotificationDelivery: mocks.produceNotificationDelivery,
    getLogger: vi.fn(() => ({
      module: () => ({ warn: mocks.warn, error: mocks.error }),
    })),
  };
});

vi.mock('@authrim/ar-lib-core/services/invitation-auth-core', async () => {
  const actual = await vi.importActual<
    typeof import('@authrim/ar-lib-core/services/invitation-auth-core')
  >('@authrim/ar-lib-core/services/invitation-auth-core');
  return {
    ...actual,
    findActiveInvitationByToken: mocks.findActiveInvitationByToken,
    hasRemainingInvitationUses: mocks.hasRemainingInvitationUses,
    invitationHasUsesLeft: mocks.invitationHasUsesLeft,
  };
});

vi.mock('../utils/email-code-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/email-code-utils')>()),
  generateEmailCode: () => '123456',
}));

import {
  sendInvitationEmailCodeHandler,
  validateInvitationHandler,
  verifyInvitationEmailCodeHandler,
} from '../invitation-handlers';

const token = 'a'.repeat(32);
const invitation = {
  id: 'invitation-1',
  token,
  tenant_id: 'tenant-1',
  invited_email: 'Invited@Example.com',
  role_id: 'role-1',
  org_id: 'org-1',
  max_uses: 1,
  use_count: 0,
  expires_at: 2_000_000_000,
};

function createApp() {
  const app = new Hono();
  app.get('/validate', validateInvitationHandler);
  app.post('/email-verification/send', sendInvitationEmailCodeHandler);
  app.post('/email-verification/verify', verifyInvitationEmailCodeHandler);
  return app;
}

const env = {
  OTP_HMAC_SECRET: 'otp-test-secret',
  RATE_LIMITER: {
    idFromName: vi.fn(() => 'limiter'),
    get: vi.fn(() => ({ incrementRpc: mocks.incrementRpc })),
  },
};

function post(path: string, body: unknown) {
  return createApp().request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('public invitation handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findActiveInvitationByToken.mockResolvedValue(invitation);
    mocks.hasRemainingInvitationUses.mockReturnValue(true);
    mocks.invitationHasUsesLeft.mockResolvedValue(true);
    mocks.adapter.queryOne.mockResolvedValue({ id: 'tenant-1', name: 'Tenant One' });
    mocks.resolveEffectiveSettings.mockResolvedValue({});
    mocks.getChallengeStoreByChallengeId.mockResolvedValue(mocks.store);
    mocks.store.storeChallengeRpc.mockResolvedValue(undefined);
    mocks.store.consumeChallengeRpc.mockResolvedValue({});
    mocks.store.deleteChallengeRpc.mockResolvedValue(undefined);
    mocks.produceNotificationDelivery.mockResolvedValue({ delivery: 'delivered' });
    mocks.incrementRpc.mockResolvedValue({ allowed: true });
  });

  describe('GET /validate', () => {
    it.each(['', 'too-short'])(
      'rejects a missing or undersized token without a database lookup',
      async (invalidToken) => {
        const suffix = invalidToken ? `?token=${invalidToken}` : '';
        const response = await createApp().request(`/validate${suffix}`, undefined, {});

        expect(response.status).toBe(400);
        expect(mocks.findActiveInvitationByToken).not.toHaveBeenCalled();
      }
    );

    it('returns tenant details for an active invitation', async () => {
      const response = await createApp().request(`/validate?token=${token}`, undefined, {});

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        valid: true,
        invitation_id: 'invitation-1',
        tenant_id: 'tenant-1',
        tenant_name: 'Tenant One',
        invited_email: 'Invited@Example.com',
        email_verification_required: false,
        expires_at: 2_000_000_000,
      });
      expect(mocks.findActiveInvitationByToken).toHaveBeenCalledWith(
        mocks.adapter,
        token,
        expect.any(Number)
      );
    });

    it.each([
      ['required', 'Invited@Example.com', true],
      ['optional', 'Invited@Example.com', false],
      ['required', null, false],
    ])(
      'says whether the invited email must be proved (policy %s, invited email %s)',
      async (policy, invitedEmail, required) => {
        mocks.findActiveInvitationByToken.mockResolvedValue({
          ...invitation,
          invited_email: invitedEmail,
        });
        mocks.resolveEffectiveSettings.mockResolvedValue({
          'authentication-methods.invitation.email_verification': policy,
        });

        const response = await createApp().request(`/validate?token=${token}`, undefined, env);

        expect(await response.json()).toMatchObject({ email_verification_required: required });
        if (invitedEmail) {
          expect(mocks.resolveEffectiveSettings).toHaveBeenCalledWith(
            env,
            'authentication-methods',
            { tenantId: 'tenant-1' }
          );
        }
      }
    );

    it('does not disclose a missing invitation', async () => {
      mocks.findActiveInvitationByToken.mockResolvedValueOnce(null);

      const response = await createApp().request(`/validate?token=${token}`, undefined, {});

      expect(response.status).toBe(404);
      expect(mocks.adapter.queryOne).not.toHaveBeenCalled();
    });

    it('does not disclose an exhausted invitation', async () => {
      mocks.invitationHasUsesLeft.mockResolvedValueOnce(false);

      const response = await createApp().request(`/validate?token=${token}`, undefined, {});

      expect(response.status).toBe(404);
      expect(mocks.adapter.queryOne).not.toHaveBeenCalled();
    });

    it('hides an invitation whose tenant no longer exists', async () => {
      mocks.adapter.queryOne.mockResolvedValueOnce(null);

      const response = await createApp().request(`/validate?token=${token}`, undefined, {});

      expect(response.status).toBe(404);
      expect(mocks.warn).toHaveBeenCalledWith(
        'Invitation references non-existent tenant',
        expect.objectContaining({ tenant_id: 'tenant-1' })
      );
    });

    it('returns an internal error when the storage lookup fails', async () => {
      mocks.findActiveInvitationByToken.mockRejectedValueOnce(new Error('database unavailable'));

      const response = await createApp().request(`/validate?token=${token}`, undefined, {});

      expect(response.status).toBe(500);
      expect(mocks.error).toHaveBeenCalled();
    });
  });

  describe('POST /email-verification/send', () => {
    it('sends a code only to the email the invitation names', async () => {
      const response = await post('/email-verification/send', {
        token,
        email: 'attacker@example.com',
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        verification_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        expires_in: 600,
        masked_email: 'i***@example.com',
      });
      expect(mocks.store.storeChallengeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `invitation_email_code:${body.verification_id}`,
          tenantId: 'tenant-1',
          type: 'invitation_email_code',
          email: 'invited@example.com',
          metadata: expect.objectContaining({ invitation_id: 'invitation-1' }),
        })
      );
      expect(mocks.produceNotificationDelivery).toHaveBeenCalledWith(
        env,
        expect.objectContaining({
          payload: expect.objectContaining({ to: 'invited@example.com' }),
        })
      );
      expect(mocks.incrementRpc).toHaveBeenCalledWith('invitation:invitation-1', {
        windowSeconds: 900,
        maxRequests: 3,
      });
    });

    it.each([
      ['an invitation that names no email', { ...invitation, invited_email: null }],
      ['an unknown invitation', null],
    ])('sends nothing for %s', async (_label, found) => {
      mocks.findActiveInvitationByToken.mockResolvedValue(found);

      const response = await post('/email-verification/send', { token });

      expect(response.status).toBe(404);
      expect(mocks.produceNotificationDelivery).not.toHaveBeenCalled();
    });

    it('stops sending once the invitation reaches its send limit', async () => {
      mocks.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 60 });

      const response = await post('/email-verification/send', { token });

      expect(response.status).toBe(429);
      expect(mocks.store.storeChallengeRpc).not.toHaveBeenCalled();
      expect(mocks.produceNotificationDelivery).not.toHaveBeenCalled();
    });
  });

  describe('POST /email-verification/verify', () => {
    const verificationId = '11111111-2222-3333-4444-555555555555';

    async function storedCode(overrides: Record<string, unknown> = {}) {
      const { hashEmailCode } = await import('../utils/email-code-utils');
      const issuedAt = Date.now();
      return {
        tenantId: 'tenant-1',
        type: 'invitation_email_code',
        email: 'invited@example.com',
        challenge: await hashEmailCode(
          '123456',
          'invited@example.com',
          verificationId,
          issuedAt,
          'otp-test-secret'
        ),
        metadata: { invitation_id: 'invitation-1', issued_at: issuedAt },
        ...overrides,
      };
    }

    it('exchanges the right code for a proof bound to the invitation and its email', async () => {
      mocks.store.getChallengeRpc.mockResolvedValue(await storedCode());

      const response = await post('/email-verification/verify', {
        token,
        verification_id: verificationId,
        code: '123456',
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.invitation_email_proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(mocks.store.consumeChallengeRpc).toHaveBeenCalledWith({
        id: `invitation_email_code:${verificationId}`,
        tenantId: 'tenant-1',
        type: 'invitation_email_code',
      });
      expect(mocks.store.storeChallengeRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `invitation_email_proof:${body.invitation_email_proof}`,
          tenantId: 'tenant-1',
          type: 'invitation_email_proof',
          email: 'invited@example.com',
          ttl: 900,
          metadata: { invitation_id: 'invitation-1' },
        })
      );
    });

    it.each([
      ['a wrong code', {}, '654321'],
      ['a code of another invitation', { metadata: { invitation_id: 'other' } }, '123456'],
      ["another tenant's code", { tenantId: 'tenant-2' }, '123456'],
      ['another kind of challenge', { type: 'direct_email_code' }, '123456'],
    ])('issues no proof for %s', async (_label, overrides, code) => {
      const stored = await storedCode();
      mocks.store.getChallengeRpc.mockResolvedValue({
        ...stored,
        ...overrides,
        metadata: { ...stored.metadata, ...(overrides as { metadata?: object }).metadata },
      });

      const response = await post('/email-verification/verify', {
        token,
        verification_id: verificationId,
        code,
      });

      expect(response.status).toBe(400);
      expect(mocks.store.consumeChallengeRpc).not.toHaveBeenCalled();
      expect(mocks.store.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it('ends the code after five wrong attempts', async () => {
      mocks.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 600 });

      const response = await post('/email-verification/verify', {
        token,
        verification_id: verificationId,
        code: '123456',
      });

      expect(response.status).toBe(429);
      expect(mocks.incrementRpc).toHaveBeenCalledWith(`verify:${verificationId}`, {
        windowSeconds: 600,
        maxRequests: 5,
      });
      expect(mocks.store.deleteChallengeRpc).toHaveBeenCalledWith(
        `invitation_email_code:${verificationId}`
      );
      expect(mocks.store.storeChallengeRpc).not.toHaveBeenCalled();
    });

    it.each([
      [{ token, verification_id: 'not-a-uuid', code: '123456' }],
      [{ token, verification_id: verificationId, code: '12345' }],
    ])('rejects a malformed request %j', async (body) => {
      const response = await post('/email-verification/verify', body);

      expect(response.status).toBe(400);
      expect(mocks.findActiveInvitationByToken).not.toHaveBeenCalled();
    });
  });
});
