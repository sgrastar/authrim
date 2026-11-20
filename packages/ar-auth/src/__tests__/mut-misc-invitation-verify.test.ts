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

const CODE = '654321';
const EMAIL = 'invited@example.com';

async function storedCode(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-1',
    type: 'invitation_email_code',
    email: EMAIL,
    challenge: await hashEmailCode(CODE, EMAIL, VERIFICATION_ID, NOW, 'otp-test-secret'),
    metadata: { invitation_id: 'invitation-1', issued_at: NOW },
    ...overrides,
  };
}

const verify = (body: Record<string, unknown> = {}, env?: Record<string, unknown>) =>
  post('/verify', { token, verification_id: VERIFICATION_ID, code: CODE, ...body }, env);

describe('invitation email code verify input', () => {
  it.each([
    ['a verification id with a prefix', { verification_id: `x${VERIFICATION_ID}` }],
    ['a verification id with a suffix', { verification_id: `${VERIFICATION_ID}x` }],
    ['a non-string verification id', { verification_id: 1 }],
    ['a code with a prefix', { code: `1${CODE}` }],
    ['a code with a suffix', { code: `${CODE}1` }],
    ['a non-numeric code', { code: 'abcdef' }],
    ['a non-string code', { code: 654321 }],
  ])('refuses %s before any lookup', async (_label, body) => {
    const response = await verify(body);
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.VALIDATION_INVALID_VALUE);
    expect(mocks.findActiveInvitationByToken).not.toHaveBeenCalled();
  });

  it('refuses an unknown invitation', async () => {
    mocks.findActiveInvitationByToken.mockResolvedValue(null);
    const response = await verify();
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND);
    expect(mocks.incrementRpc).not.toHaveBeenCalled();
  });

  it('for a lite tenant, refuses a request of another tenant only', async () => {
    mocks.readLiteMode.mockResolvedValue('on');
    mocks.tenantFromContext.mockReturnValue('tenant-2');
    const refused = await verify();
    expect(refused.status).toBe(403);
    expect(mocks.incrementRpc).not.toHaveBeenCalled();

    mocks.tenantFromContext.mockReturnValue('tenant-1');
    mocks.store.getChallengeRpc.mockResolvedValue(await storedCode());
    expect((await verify()).status).toBe(200);
  });

  it('refuses without the OTP secret', async () => {
    const response = await verify({}, { RATE_LIMITER: baseEnv.RATE_LIMITER });
    expect(response.status).toBe(500);
    expect(mocks.incrementRpc).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });
});

describe('invitation email code verify attempts', () => {
  it('counts attempts per verification and drops the code past five', async () => {
    mocks.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 30 });
    const response = await verify();
    expect(response.status).toBe(429);
    expect(idFromName).toHaveBeenCalledWith(
      buildDOKey('rate-limit', 'invitation-email-verify', 'tenant-1')
    );
    expect(mocks.incrementRpc).toHaveBeenCalledWith(`verify:${VERIFICATION_ID}`, {
      windowSeconds: 600,
      maxRequests: 5,
    });
    expect(mocks.store.deleteChallengeRpc).toHaveBeenCalledWith(
      `invitation_email_code:${VERIFICATION_ID}`
    );
    expect(mocks.store.getChallengeRpc).not.toHaveBeenCalled();
  });

  it('still refuses when dropping the code fails', async () => {
    mocks.incrementRpc.mockResolvedValue({ allowed: false, retryAfter: 30 });
    mocks.store.deleteChallengeRpc.mockRejectedValue(new Error('gone'));
    expect((await verify()).status).toBe(429);
  });

  it('treats an unreadable stored code as invalid', async () => {
    mocks.store.getChallengeRpc.mockRejectedValue(new Error('down'));
    const response = await verify();
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.AUTH_INVALID_CODE);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it.each([
    ['another type', { type: 'email_code' }],
    ['another tenant', { tenantId: 'tenant-2' }],
    ['another invitation', { metadata: { invitation_id: 'invitation-2', issued_at: NOW } }],
    ['no metadata', { metadata: undefined }],
    ['another email', { email: 'other@example.com' }],
    ['a non-string hash', { challenge: 7 }],
    ['a non-numeric issue time', { metadata: { invitation_id: 'invitation-1', issued_at: '1' } }],
    ['another issue time', { metadata: { invitation_id: 'invitation-1', issued_at: NOW + 1 } }],
  ])('refuses a stored code with %s', async (_label, overrides) => {
    mocks.store.getChallengeRpc.mockResolvedValue(await storedCode(overrides));
    const response = await verify();
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.AUTH_INVALID_CODE);
    expect(mocks.store.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses a wrong code', async () => {
    mocks.store.getChallengeRpc.mockResolvedValue(await storedCode());
    const response = await verify({ code: '000000' });
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.AUTH_INVALID_CODE);
  });

  it('refuses a code already consumed by a concurrent request', async () => {
    mocks.store.getChallengeRpc.mockResolvedValue(await storedCode());
    mocks.store.consumeChallengeRpc.mockRejectedValue(new Error('consumed'));
    const response = await verify();
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.AUTH_INVALID_CODE);
    expect(mocks.store.storeChallengeRpc).not.toHaveBeenCalled();
  });
});

describe('invitation email proof', () => {
  it('consumes the code and stores a short-lived proof for the invited email', async () => {
    mocks.store.getChallengeRpc.mockResolvedValue(await storedCode());
    const response = await verify();
    expect(response.status).toBe(200);
    const body = await response.json<{ invitation_email_proof: string; expires_in: number }>();
    expect(body.expires_in).toBe(900);
    expect(body.invitation_email_proof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(mocks.store.consumeChallengeRpc).toHaveBeenCalledWith({
      id: `invitation_email_code:${VERIFICATION_ID}`,
      tenantId: 'tenant-1',
      type: 'invitation_email_code',
    });
    const proof = mocks.store.storeChallengeRpc.mock.calls[0][0] as Record<string, unknown>;
    expect(proof).toMatchObject({
      tenantId: 'tenant-1',
      type: 'invitation_email_proof',
      userId: 'invitation:invitation-1',
      challenge: 'invitation_email_proof',
      ttl: 900,
      email: EMAIL,
      metadata: { invitation_id: 'invitation-1' },
    });
  });

  it('answers an internal error when the proof cannot be stored', async () => {
    mocks.store.getChallengeRpc.mockResolvedValue(await storedCode());
    mocks.store.storeChallengeRpc.mockRejectedValue(new Error('down'));
    const response = await verify();
    expect(await errorCode(response)).toBe(AR_ERROR_CODES.INTERNAL_ERROR);
    expect(mocks.error).toHaveBeenCalledWith('Failed to verify invitation email code', {
      error: 'Error: down',
    });
  });
});
