import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import {
  AR_ERROR_CODES,
  LEGACY_REGISTRATION_POLICY,
  type Env,
  type RegistrationPolicy,
} from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  delivery: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  modules: [] as string[],
  readProfile: vi.fn(),
  allowsHandle: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  produceNotificationDelivery: mocks.delivery,
  getLogger: () => ({
    module: (name: string) => {
      mocks.modules.push(name);
      return { info: mocks.info, error: mocks.error, warn: vi.fn() };
    },
  }),
}));
vi.mock('../authentication-profile', () => ({
  readAuthenticationProfile: mocks.readProfile,
  profileAllowsHandle: mocks.allowsHandle,
}));

import {
  NO_POLICY,
  eligibilityRefusal,
  notifyExistingAccountSignUp,
  profileAllowsSignUp,
  registrationRefusalResponse,
  signUpCodeTtlSeconds,
} from '../registration-policy-gate';
import type { RegistrationRefusal, SignUpPolicy } from '../registration-policy-gate';

const NOW = Date.UTC(2026, 10, 19, 15, 30, 0);

function context(env: Record<string, unknown> = {}) {
  return {
    env,
    get: (key: string) => (key === 'tenantId' ? 'tenant-1' : undefined),
    req: { header: () => undefined, path: '/signup' },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<{ Bindings: Env }>;
}

const policy = (overrides: Partial<RegistrationPolicy> = {}): RegistrationPolicy => ({
  ...LEGACY_REGISTRATION_POLICY,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.delivery.mockReset().mockResolvedValue({ delivery: 'queued' });
  mocks.info.mockReset();
  mocks.error.mockReset();
  mocks.modules.length = 0;
  mocks.readProfile.mockReset().mockResolvedValue({ profile: 'p' });
  mocks.allowsHandle.mockReset().mockReturnValue(false);
});
afterEach(() => vi.useRealTimers());

describe('profileAllowsSignUp', () => {
  const flow = (overrides: Partial<SignUpPolicy>): SignUpPolicy => ({
    ...NO_POLICY,
    source: 'interaction',
    profileRef: 'strict',
    ...overrides,
  });

  it('allows without a read for no Flow or the default profile', async () => {
    expect(await profileAllowsSignUp(context(), 'tenant-1', NO_POLICY, 'passkey')).toBe(true);
    expect(
      await profileAllowsSignUp(context(), 'tenant-1', flow({ profileRef: 'default' }), 'totp')
    ).toBe(true);
    expect(mocks.readProfile).not.toHaveBeenCalled();
  });

  it('asks the Flow profile whether the method may sign up', async () => {
    const ctx = context({ KEY: 1 });
    expect(await profileAllowsSignUp(ctx, 'tenant-1', flow({}), 'mail_otp')).toBe(false);
    expect(mocks.readProfile).toHaveBeenCalledWith(ctx.env, 'tenant-1', 'strict');
    expect(mocks.allowsHandle).toHaveBeenCalledWith({ profile: 'p' }, 'mail_otp', 'signup');
  });
});

describe('eligibilityRefusal', () => {
  const domain = policy({ eligibility: 'domain', allowed_domains: ['example.com'] });

  it.each([
    [
      policy({ eligibility: 'invite' }),
      { email: 'a@x.test', hasInvitation: false },
      'invitation_required',
    ],
    [policy({ eligibility: 'invite' }), { email: null, hasInvitation: true }, null],
    [domain, { email: null, hasInvitation: true }, 'email_domain_not_allowed'],
    [domain, { email: 'a@other.test', hasInvitation: false }, 'email_domain_not_allowed'],
    [domain, { email: 'a@example.com', hasInvitation: false }, null],
    [policy(), { email: null, hasInvitation: false }, null],
  ])('decides %#', (rules, input, expected) => {
    expect(eligibilityRefusal(rules, input)).toBe(expected);
  });
});

describe('registrationRefusalResponse', () => {
  async function refuse(rules: RegistrationPolicy, refusal: RegistrationRefusal) {
    const response = await registrationRefusalResponse(context(), rules, refusal);
    return { status: response.status, body: await response.json<Record<string, unknown>>() };
  }

  it('logs the refusal reason', async () => {
    await refuse(policy(), 'invitation_required');
    expect(mocks.modules).toContain('SIGN-UP');
    expect(mocks.info).toHaveBeenCalledWith('Sign-up refused by its registration policy', {
      action: 'signup_policy_refused',
      reason: 'invitation_required',
    });
  });

  it('answers every refusal alike under a generic policy', async () => {
    const { status, body } = await refuse(policy({ denied_response: 'generic' }), 'account_exists');
    expect(status).toBe(403);
    expect(body).toMatchObject({
      error_code: AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS,
      reason: 'signup_not_allowed',
    });
  });

  it('answers an existing account as a conflict', async () => {
    const { status, body } = await refuse(policy({ denied_response: 'reason' }), 'account_exists');
    expect(status).toBe(409);
    expect(body).toMatchObject({
      error_code: AR_ERROR_CODES.ADMIN_CONFLICT,
      reason: 'account_exists',
    });
  });

  it('names the reason of another refusal', async () => {
    const { body } = await refuse(
      policy({ denied_response: 'reason' }),
      'email_domain_not_allowed'
    );
    expect(body).toMatchObject({
      error_code: AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS,
      reason: 'email_domain_not_allowed',
    });
  });
});

describe('signUpCodeTtlSeconds', () => {
  it('keeps the shorter of the Flow and the otherwise lifetime', () => {
    expect(signUpCodeTtlSeconds(policy({ code_ttl_seconds: null }), 600)).toBe(600);
    expect(signUpCodeTtlSeconds(policy({ code_ttl_seconds: 120 }), 600)).toBe(120);
    expect(signUpCodeTtlSeconds(policy({ code_ttl_seconds: 900 }), 600)).toBe(600);
  });
});

describe('notifyExistingAccountSignUp', () => {
  async function addressKey(value: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }

  it('sends one notice per lower-cased address and hour', async () => {
    await notifyExistingAccountSignUp(context(), {
      tenantId: 'tenant-1',
      userId: 'user-1',
      email: 'Person@Example.com',
    });
    const attemptId = `${await addressKey('tenant-1:person@example.com')}:${Math.floor(NOW / 3_600_000)}`;
    expect(attemptId).toMatch(/^[a-f0-9]{24}:\d+$/u);
    const [env, request] = mocks.delivery.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(env).toEqual({});
    expect(request).toMatchObject({
      owner: { owner: 'tenant', tenantId: 'tenant-1' },
      intentId: `signup-account-exists:${attemptId}`,
      outboxId: `notification:signup-account-exists:${attemptId}`,
      notificationKind: 'auth.signup-account-exists',
      accountId: 'user-1',
      idempotencyKey: `signup-account-exists:${attemptId}`,
      expiresAt: Math.floor(NOW / 1000) + 86400,
      payload: {
        channel: 'email',
        to: 'Person@Example.com',
        from: 'noreply@authrim.dev',
        subject: 'You already have an account',
      },
    });
    const payload = request.payload as { body: string; metadata: { textBody: string } };
    expect(payload.body).toContain('Person@Example.com');
    expect(payload.metadata.textBody).toContain('Person@Example.com');
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('sends from the configured address', async () => {
    await notifyExistingAccountSignUp(context({ EMAIL_FROM: 'id@tenant.test' }), {
      tenantId: 'tenant-1',
      userId: 'user-1',
      email: 'a@b.test',
    });
    expect(mocks.delivery.mock.calls[0][1]).toMatchObject({ payload: { from: 'id@tenant.test' } });
  });

  it.each([
    [
      'a permanent failure',
      () => mocks.delivery.mockResolvedValue({ delivery: 'permanent_failure' }),
      'Error',
    ],
    ['a thrown TypeError', () => mocks.delivery.mockRejectedValue(new TypeError('x')), 'TypeError'],
    ['a non-Error rejection', () => mocks.delivery.mockRejectedValue('x'), 'Unknown'],
  ])('only logs %s', async (_label, arrange, errorType) => {
    arrange();
    await expect(
      notifyExistingAccountSignUp(context(), {
        tenantId: 'tenant-1',
        userId: 'u',
        email: 'a@b.test',
      })
    ).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith(
      'Failed to tell an account owner of a sign-up for their address',
      { action: 'signup_account_exists_notice', errorType }
    );
  });
});
