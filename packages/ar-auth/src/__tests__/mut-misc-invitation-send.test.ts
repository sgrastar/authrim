import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AR_ERROR_CODES, buildDOKey } from '@authrim/ar-lib-core';
import { hashEmailCode } from '../utils/email-code-utils';

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
  readLiteMode: vi.fn(),
  verifyHumanVerification: vi.fn(),
  tenantFromContext: vi.fn(),
}));

vi.mock('../lite-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lite-mode')>()),
  readLiteMode: mocks.readLiteMode,
}));
vi.mock('../human-verification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../human-verification')>()),
  verifyHumanVerificationForAction: mocks.verifyHumanVerification,
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
    getTenantIdFromContext: mocks.tenantFromContext,
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

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0, 500);
const token = 'a'.repeat(32);
const VERIFICATION_ID = '11111111-2222-4333-8444-555555555555';
const invitation = {
  id: 'invitation-1',
  token,
  tenant_id: 'tenant-1',
  invited_email: 'Invited@Example.com',
  max_uses: 1,
  use_count: 0,
  expires_at: 2_000_000_000,
};

function createApp() {
  const app = new Hono();
  app.get('/validate', validateInvitationHandler);
  app.post('/send', sendInvitationEmailCodeHandler);
  app.post('/verify', verifyInvitationEmailCodeHandler);
  return app;
}

const idFromName = vi.fn((name: string) => name);
const baseEnv = {
  OTP_HMAC_SECRET: 'otp-test-secret',
  RATE_LIMITER: { idFromName, get: vi.fn(() => ({ incrementRpc: mocks.incrementRpc })) },
};

const post = (path: string, body: unknown, env: Record<string, unknown> = baseEnv) =>
  createApp().request(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env
  );

async function errorCode(response: Response) {
  return (await response.json<{ error_code?: string }>()).error_code;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(VERIFICATION_ID);
  mocks.findActiveInvitationByToken.mockResolvedValue(invitation);
  mocks.invitationHasUsesLeft.mockResolvedValue(true);
  mocks.adapter.queryOne.mockResolvedValue({ id: 'tenant-1', name: 'Tenant One' });
  mocks.getChallengeStoreByChallengeId.mockResolvedValue(mocks.store);
  mocks.store.storeChallengeRpc.mockResolvedValue(undefined);
  mocks.store.consumeChallengeRpc.mockResolvedValue({});
  mocks.store.deleteChallengeRpc.mockResolvedValue(undefined);
  mocks.produceNotificationDelivery.mockResolvedValue({ delivery: 'delivered' });
  mocks.incrementRpc.mockResolvedValue({ allowed: true });
  mocks.readLiteMode.mockResolvedValue('off');
  mocks.verifyHumanVerification.mockResolvedValue(null);
  mocks.tenantFromContext.mockReturnValue('tenant-1');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('invitation validation details', () => {
  it('looks the invitation up at the current second and its tenant by id', async () => {
    const response = await createApp().request(`/validate?token=${token}`, undefined, {});
    expect(response.status).toBe(200);
    expect(mocks.findActiveInvitationByToken).toHaveBeenCalledWith(
      mocks.adapter,
      token,
      Math.floor(NOW / 1000)
    );
    expect(mocks.invitationHasUsesLeft).toHaveBeenCalledWith(
      mocks.adapter,
      invitation,
      Math.floor(NOW / 1000)
    );
    expect(mocks.adapter.queryOne).toHaveBeenCalledWith(
      'SELECT id, name FROM tenants WHERE id = ?',
      ['tenant-1']
    );
  });

  it('answers an internal error when the core database is not configured', async () => {
    const core = await import('@authrim/ar-lib-core');
    vi.mocked(core.resolveOptionalCoreAdapterFromHono).mockReturnValueOnce(null);
    const response = await createApp().request(`/validate?token=${token}`, undefined, {});
    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
    expect(mocks.error).toHaveBeenCalled();
  });
});

describe('invitation email code send', () => {
  it('refuses a short token without a lookup', async () => {
    const response = await post('/send', { token: 'a'.repeat(31) });
    expect(response.status).toBe(404);
    expect(mocks.findActiveInvitationByToken).not.toHaveBeenCalled();
  });

  it('refuses an invitation that names no email', async () => {
    mocks.findActiveInvitationByToken.mockResolvedValue({ ...invitation, invited_email: null });
    const response = await post('/send', { token });
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    expect(mocks.findActiveInvitationByToken).toHaveBeenCalledWith(
      mocks.adapter,
      token,
      Math.floor(NOW / 1000)
    );
  });

  it('stores a hashed code for the invited email and sends it there', async () => {
    const response = await post('/send', { token });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verification_id: VERIFICATION_ID,
      expires_in: 600,
      masked_email: 'i***@example.com',
    });
    expect(idFromName).toHaveBeenCalledWith(
      buildDOKey('rate-limit', 'invitation-email-code', 'tenant-1')
    );
    expect(mocks.incrementRpc).toHaveBeenCalledWith('invitation:invitation-1', {
      windowSeconds: 900,
      maxRequests: 3,
    });
    expect(mocks.store.storeChallengeRpc).toHaveBeenCalledWith({
      id: `invitation_email_code:${VERIFICATION_ID}`,
      tenantId: 'tenant-1',
      type: 'invitation_email_code',
      userId: 'invitation:invitation-1',
      challenge: await hashEmailCode(
        '123456',
        'invited@example.com',
        VERIFICATION_ID,
        NOW,
        'otp-test-secret'
      ),
      ttl: 600,
      email: 'invited@example.com',
      metadata: { invitation_id: 'invitation-1', issued_at: NOW },
    });
    const delivery = mocks.produceNotificationDelivery.mock.calls[0][1] as Record<string, unknown>;
    expect(delivery).toMatchObject({
      owner: { owner: 'tenant', tenantId: 'tenant-1' },
      intentId: `invitation-email-code:${VERIFICATION_ID}`,
      outboxId: `notification:${VERIFICATION_ID}`,
      notificationKind: 'auth.direct-email-code',
      accountId: 'invitation:invitation-1',
      idempotencyKey: `invitation-email-code:${VERIFICATION_ID}`,
      expiresAt: Math.floor(NOW / 1000) + 600,
      payload: {
        channel: 'email',
        to: 'invited@example.com',
        from: 'noreply@authrim.dev',
        subject: 'Your verification code',
      },
    });
    const payload = delivery.payload as { body: string; metadata: { textBody: string } };
    expect(payload.body).toContain('123456');
    expect(payload.body).toContain('10');
    expect(payload.metadata.textBody).toContain('123456');
  });

  it('sends from the configured address', async () => {
    await post('/send', { token }, { ...baseEnv, EMAIL_FROM: 'login@tenant.example' });
    const delivery = mocks.produceNotificationDelivery.mock.calls[0][1] as {
      payload: { from: string };
    };
    expect(delivery.payload.from).toBe('login@tenant.example');
  });

  it('refuses without the OTP secret', async () => {
    const response = await post('/send', { token }, { RATE_LIMITER: baseEnv.RATE_LIMITER });
    // A missing secret is reported as a masked server error, not through the catch-all.
    expect(response.status).toBe(500);
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.store.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses over the per-invitation limit with the retry delay', async () => {
    mocks.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 42 });
    const response = await post('/send', { token });
    expect(response.status).toBe(429);
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.RATE_LIMIT_EXCEEDED);
    expect(mocks.store.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('drops the stored code when the delivery fails permanently, even if the drop fails', async () => {
    mocks.produceNotificationDelivery.mockResolvedValue({ delivery: 'permanent_failure' });
    mocks.store.deleteChallengeRpc.mockRejectedValue(new Error('gone'));
    const response = await post('/send', { token });
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.USER_EMAIL_DELIVERY_FAILED);
    expect(mocks.store.deleteChallengeRpc).toHaveBeenCalledWith(
      `invitation_email_code:${VERIFICATION_ID}`
    );
  });

  it('for a lite tenant, refuses another request tenant before human verification', async () => {
    mocks.readLiteMode.mockResolvedValue('on');
    mocks.tenantFromContext.mockReturnValue('tenant-2');
    const response = await post('/send', { token, human_verification_response: 'pow' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'lite_mode_endpoint_unavailable' });
    expect(mocks.readLiteMode).toHaveBeenCalledWith(expect.anything(), 'tenant-1');
    expect(mocks.verifyHumanVerification).not.toHaveBeenCalled();
  });

  it('for a lite tenant, requires the sign-up proof of work', async () => {
    mocks.readLiteMode.mockResolvedValue('on');
    mocks.verifyHumanVerification.mockResolvedValue(new Response('pow', { status: 403 }));
    const response = await post('/send', { token, human_verification_response: 'pow' });
    expect(await response.text()).toBe('pow');
    expect(mocks.verifyHumanVerification).toHaveBeenCalledWith(expect.anything(), 'signup', 'pow');
    expect(mocks.store.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('answers an internal error when the store fails', async () => {
    mocks.store.storeChallengeRpc.mockRejectedValue(new Error('down'));
    const response = await post('/send', { token });
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
    expect(mocks.error).toHaveBeenCalledWith('Failed to send invitation email code', {
      error: 'Error: down',
    });
  });
});
