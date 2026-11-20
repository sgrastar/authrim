import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../registration-policy-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registration-policy-gate')>();
  return { ...actual, signUpPolicyFor: vi.fn(async () => actual.NO_POLICY) };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-factor-email-code-harness')).emailCodeLibCoreMock(
    await importOriginal()
  )
);
vi.mock('../utils/email-code-utils', async () =>
  (await import('./helpers/mut-factor-email-code-harness')).emailCodeUtilsMock()
);
vi.mock('../registration-field-utils', async () =>
  (await import('./helpers/mut-factor-email-code-harness')).fieldUtilsMock()
);
vi.mock('../issuer', () => ({ getRequestIssuer: vi.fn(() => 'https://auth.example.com') }));
vi.mock('../flow-session-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../flow-session-profile')>();
  const { em } = await import('./helpers/mut-factor-email-code-harness');
  return {
    ...actual,
    sessionTtlForProfile: (...args: Parameters<typeof actual.sessionTtlForProfile>) =>
      em.sessionTtlForProfile.getMockImplementation()
        ? (em.sessionTtlForProfile(...args) as ReturnType<typeof actual.sessionTtlForProfile>)
        : actual.sessionTtlForProfile(...args),
  };
});

import { emailCodeVerifyHandler } from '../email-code';
import {
  em,
  postVerify,
  resetEmailCodeHarness,
  routedContext,
  validChallenge,
} from './helpers/mut-factor-email-code-harness';

const verify = (
  bindings: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  body: unknown = { code: '123456', email: 'user@example.com' }
) => postVerify(emailCodeVerifyHandler, body, bindings, undefined, headers);
const T = new Date('2026-06-23T00:00:00.250Z').getTime();
const withCustomFields = () =>
  em.consumeChallengeRpc.mockResolvedValueOnce({
    ...validChallenge,
    metadata: { ...validChallenge.metadata, custom_fields: { team: 'blue' } },
  });

describe('email code verify: the session it makes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    resetEmailCodeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it('makes an otp session and sets the cookies', async () => {
    const res = await verify(
      {},
      { 'User-Agent': 'agent/3', 'X-Forwarded-For': ' 198.51.100.4 , 10.0.0.1' }
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      sessionId: 'session-1',
      userId: 'user-1',
      user: { id: 'user-1', email: 'user@example.com', name: 'User', email_verified: 1 },
    });
    const [, , ttl, metadata] = em.createSessionRpc.mock.calls[0] as [
      string,
      string,
      number,
      Record<string, unknown>,
    ];
    expect(metadata).toMatchObject({
      email: 'user@example.com',
      name: 'User',
      amr: ['otp'],
      acr: 'urn:mace:incommon:iap:bronze',
      authTime: Math.floor(T / 1000),
      proven_at: T,
    });
    const cookies = res.headers.get('Set-Cookie') ?? '';
    expect(cookies).toContain(
      'authrim_otp_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'
    );
    expect(cookies).toContain(
      `authrim_session=session-1; Max-Age=${String(ttl)}; Path=/; HttpOnly; Secure`
    );
    expect(cookies).toMatch(
      /authrim_browser_state=browser-state-1; Max-Age=\d+; Path=\/; Secure; SameSite=Lax/
    );
    expect(em.createAuditLog).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-1',
      userId: 'user-1',
      action: 'user.login',
      resource: 'session',
      resourceId: 'session-1',
      ipAddress: '198.51.100.4',
      userAgent: 'agent/3',
      metadata: JSON.stringify({ method: 'email_code' }),
      severity: 'info',
    });
    expect(em.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: {
          userId: 'user-1',
          method: 'email_code',
          clientId: 'email-auth',
          sessionId: 'session-1',
        },
      })
    );
    expect(em.publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: { sessionId: 'session-1', userId: 'user-1', ttlSeconds: ttl },
      })
    );
  });

  it.each([
    [{ 'X-Real-IP': '192.0.2.77' }, '192.0.2.77', 'unknown'],
    [{}, 'unknown', 'unknown'],
  ])('audits the client address from %j', async (headers, ip, agent) => {
    await verify({}, headers);
    expect(em.createAuditLog.mock.calls[0][1]).toMatchObject({ ipAddress: ip, userAgent: agent });
  });

  it('answers with the submitted address when the account has none, and no name', async () => {
    em.findForOtpLogin.mockResolvedValueOnce({ id: 'user-1', email: null, name: '', active: 1 });
    em.consumeChallengeRpc.mockResolvedValueOnce({ ...validChallenge, email: 'USER@EXAMPLE.COM' });
    const res = await verify({}, {}, { code: '123456', email: 'USER@EXAMPLE.COM' });
    expect(res.body.user).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      email_verified: 1,
    });
  });

  it('marks the address verified after the response in standard storage', async () => {
    const res = await verify();
    expect(res.waitUntil).toHaveBeenCalledTimes(2);
    expect(em.markEmailVerifiedAndTouchLastLogin).toHaveBeenCalledWith('user-1', T);
    expect(em.clearAccountRegistrationPending).toHaveBeenCalledWith(
      { kind: 'standard-core' },
      'tenant-1',
      'user-1'
    );
  });

  it('marks an unverified routed address in its account core, and skips a verified one', async () => {
    const res = await verify({ __TENANT_D1: true });
    expect(res.waitUntil).toHaveBeenCalledTimes(2);
    expect(em.markOtpLoginEmailVerified).toHaveBeenCalledWith(
      { adapter: 'tenant-core' },
      'tenant-1',
      'user-1',
      T
    );
    em.markOtpLoginEmailVerified.mockClear();
    em.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValueOnce(
      routedContext({ email_verified: 1 })
    );
    const verified = await verify({ __TENANT_D1: true });
    expect(verified.waitUntil).toHaveBeenCalledTimes(1);
    expect(em.markOtpLoginEmailVerified).not.toHaveBeenCalled();
  });

  it('writes the sign-up attributes and the verified address together', async () => {
    withCustomFields();
    const res = await verify();
    expect(res.status).toBe(200);
    expect(em.withGroupInputWrite).toHaveBeenCalledWith(
      { kind: 'standard-core' },
      'tenant-1',
      'user-1',
      'registration:email-code',
      expect.any(Function)
    );
    expect(em.persistRegistrationFields).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'user-1',
      {
        team: 'blue',
      }
    );
    expect(em.markEmailVerifiedAndTouchLastLogin).toHaveBeenCalledTimes(1);
    expect(res.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('writes a routed sign-up address in its account core, unless already verified', async () => {
    withCustomFields();
    await verify({ __TENANT_D1: true });
    expect(em.markOtpLoginEmailVerified).toHaveBeenCalledTimes(1);
    expect(em.markEmailVerifiedAndTouchLastLogin).not.toHaveBeenCalled();
    em.markOtpLoginEmailVerified.mockClear();
    withCustomFields();
    em.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValueOnce(
      routedContext({ email_verified: 1 })
    );
    const res = await verify({ __TENANT_D1: true });
    expect(res.status).toBe(200);
    expect(em.markOtpLoginEmailVerified).not.toHaveBeenCalled();
    expect(em.persistRegistrationFields).toHaveBeenCalledTimes(2);
  });

  it('warns and goes on when the address write of a sign-up fails', async () => {
    withCustomFields();
    em.markEmailVerifiedAndTouchLastLogin.mockRejectedValueOnce(new Error('core down'));
    const res = await verify();
    expect(res.status).toBe(200);
    expect(em.warn).toHaveBeenCalledWith(
      'Failed to settle registration attributes',
      { action: 'registration_fields_persist' },
      expect.objectContaining({ message: 'core down' })
    );
  });

  it('does not warn when the sign-up writes succeed', async () => {
    withCustomFields();
    await verify();
    expect(em.warn).not.toHaveBeenCalledWith(
      'Failed to settle registration attributes',
      expect.anything(),
      expect.anything()
    );
  });

  it('answers a session store failure without cookies', async () => {
    em.createSessionRpc.mockRejectedValueOnce(new Error('do down'));
    const res = await verify();
    expect(res.status).toBe(500);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(em.createAuditLog).not.toHaveBeenCalled();
  });
});
