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

const USER_INVALID = 'AR030001';
const verify = (
  body: unknown = { code: '123456', email: 'user@example.com' },
  bindings: Record<string, unknown> = {},
  cookie?: string,
  headers: Record<string, string> = {}
) => postVerify(emailCodeVerifyHandler, body, bindings, cookie, headers);
const failures = () =>
  em.publishEvent.mock.calls
    .map((call) => (call[1] as { data: { clientId?: string; errorCode?: string } }).data)
    .filter((data) => data.errorCode)
    .map((data) => `${data.clientId}:${data.errorCode}`);

describe('email code verify: the challenge and the code', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEmailCodeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    [{ email: 'user@example.com' }, 'AR130001'],
    [{ code: '123456' }, 'AR130001'],
    [{ code: '1234567', email: 'user@example.com' }, 'AR130003'],
  ])('refuses %j before reading a challenge', async (body, code) => {
    const res = await verify(body);
    expect(res.body.error_code).toBe(code);
    expect(em.consumeChallengeRpc).not.toHaveBeenCalled();
  });

  it('consumes the challenge of the OTP session cookie', async () => {
    await verify();
    expect(em.consumeChallengeRpc).toHaveBeenCalledWith({
      id: 'email_code:otp-session-1',
      tenantId: 'tenant-1',
      type: 'email_code',
    });
  });

  it('answers a challenge that cannot be consumed as a wrong code', async () => {
    em.consumeChallengeRpc.mockRejectedValueOnce(new Error('consumed'));
    const res = await verify();
    expect(res.body.error_code).toBe('AR000006');
    expect(failures()).toEqual(['email-auth:challenge_error']);
  });

  it('refuses a challenge bound to another OTP session', async () => {
    em.consumeChallengeRpc.mockResolvedValueOnce({
      ...validChallenge,
      metadata: { ...validChallenge.metadata, otp_session_id: 'otp-session-2' },
    });
    const res = await verify();
    expect(res.body.error_code).toBe('AR040002');
    expect(em.verifyCode).not.toHaveBeenCalled();
  });

  it('refuses a code for another address and takes one differing only in case', async () => {
    em.consumeChallengeRpc.mockResolvedValueOnce({ ...validChallenge, email: 'other@example.com' });
    const other = await verify();
    expect(other.body.error_code).toBe('AR000006');
    expect(em.verifyCode).not.toHaveBeenCalled();
    em.consumeChallengeRpc.mockResolvedValueOnce({ ...validChallenge, email: 'USER@example.com' });
    const same = await verify({ code: '123456', email: 'User@Example.com' });
    expect(same.status).toBe(200);
    expect(em.findForOtpLogin).toHaveBeenCalledWith('user-1', 'USER@example.com', {
      includeInactive: true,
    });
    expect(em.verifyCode).toHaveBeenCalledWith(
      '123456',
      'user@example.com',
      'otp-session-1',
      1_900_000_000,
      'hashed-code',
      'private-secret'
    );
  });

  it('looks the account up by the submitted address when the challenge holds none', async () => {
    em.consumeChallengeRpc.mockResolvedValueOnce({ ...validChallenge, email: undefined });
    const res = await verify();
    expect(res.body.error_code).toBe('AR000006');
  });

  it('refuses once email code sign-in is switched off', async () => {
    const res = await verify(undefined, {
      SETTINGS: {
        get: vi.fn(async () =>
          JSON.stringify({ 'authentication-methods.email_otp.login_enabled': false })
        ),
      },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error_code: 'AR050006',
      authentication_method: 'email_otp',
      usage: 'login',
    });
    expect(em.verifyCode).not.toHaveBeenCalled();
  });

  it('fails closed without the HMAC secret', async () => {
    const res = await verify(undefined, { OTP_HMAC_SECRET: '' });
    expect(res.status).toBe(500);
    expect(em.verifyCode).not.toHaveBeenCalled();
  });

  it('reports a wrong code', async () => {
    em.verifyCode.mockResolvedValueOnce(false);
    const res = await verify();
    expect(res.body.error_code).toBe('AR000006');
    expect(failures()).toEqual(['email-auth:invalid_code']);
    expect(em.createSessionRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['inactive', { id: 'user-1', active: 0 }],
  ])('reports an account that is %s', async (_label, user) => {
    em.findForOtpLogin.mockResolvedValueOnce(user);
    const res = await verify();
    expect(res.body.error_code).toBe(USER_INVALID);
    expect(failures()).toEqual(['email-auth:user_inactive']);
    expect(em.guestCredentialFence).not.toHaveBeenCalled();
  });
});

describe('email code verify: the account state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEmailCodeHarness();
  });
  afterEach(() => vi.useRealTimers());

  it('reads a standard account through its own core adapter', async () => {
    await verify();
    expect(em.guestCredentialFence).toHaveBeenCalledWith(
      { kind: 'standard-core' },
      'tenant-1',
      'user-1'
    );
    const loader = em.ensureAccountAuthenticationState.mock.calls[0][3] as () => Promise<unknown>;
    await loader();
    expect(em.findCanonicalAccountAuthenticationState).toHaveBeenCalledWith(
      { kind: 'standard-core' },
      'tenant-1',
      'user-1'
    );
  });

  it('reads a routed account through its account core', async () => {
    await verify(undefined, { __TENANT_D1: true });
    expect(em.ensureDatabaseAdapter).toHaveBeenCalledWith(
      { adapter: 'tenant-core' },
      'otp-account-core'
    );
    expect(em.guestCredentialFence).toHaveBeenCalledWith(
      { adapter: 'tenant-core' },
      'tenant-1',
      'user-1'
    );
  });

  it('refuses an account its state does not allow', async () => {
    em.ensureAccountAuthenticationState.mockRejectedValueOnce(
      new Error('account_authentication_not_allowed')
    );
    const res = await verify();
    expect(res.body.error_code).toBe(USER_INVALID);
    expect(em.createSessionRpc).not.toHaveBeenCalled();
  });

  it.each([[new Error('do down')], [{ message: 'account_authentication_not_allowed' }]])(
    'answers 503 when the state cannot be read: %j',
    async (error) => {
      em.ensureAccountAuthenticationState.mockRejectedValueOnce(error);
      const res = await verify();
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('1');
      expect(res.body).toEqual({
        error: 'temporarily_unavailable',
        error_description: 'Authentication state unavailable.',
      });
    }
  );

  it('answers 503 when the session settings cannot be read', async () => {
    em.consumeChallengeRpc.mockResolvedValueOnce({
      ...validChallenge,
      metadata: { ...validChallenge.metadata, session_profile_ref: 'strict' },
    });
    em.sessionTtlForProfile.mockRejectedValue(new Error('settings down'));
    const res = await verify();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Session settings are unavailable.',
    });
    expect(em.sessionTtlForProfile).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      'email_code',
      'strict'
    );
  });

  it('answers a routed lookup that is temporarily unavailable as retryable', async () => {
    em.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValueOnce(
      new Error('D1 DB is overloaded')
    );
    const res = await verify(undefined, { __TENANT_D1: true });
    expect(res.status).toBe(503);
  });

  it('answers a write fence as retryable', async () => {
    em.createAccountAuthContextFromHono.mockImplementationOnce(() => {
      throw new Error('tenant_placement_migration_write_fenced');
    });
    const res = await verify();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
  });

  it('uses the routed user', async () => {
    em.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValueOnce(
      routedContext({ email: null, name: null })
    );
    const res = await verify({ code: '123456', email: 'User@Example.com' }, { __TENANT_D1: true });
    expect(res.body.user).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      name: null,
      email_verified: 1,
    });
  });
});
