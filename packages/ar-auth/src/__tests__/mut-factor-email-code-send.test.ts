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
vi.mock('../account-provisioning', async (importOriginal) =>
  (await import('./helpers/mut-factor-email-code-harness')).emailCodeProvisioningMock(
    await importOriginal()
  )
);
const screen = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('../signup-screen-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../signup-screen-check')>()),
  checkSignUpScreen: screen.check,
}));

import { Hono } from 'hono';
import { emailCodeSendHandler } from '../email-code';
import { NO_POLICY, signUpPolicyFor } from '../registration-policy-gate';
import { em, emailCodeEnv, resetEmailCodeHarness } from './helpers/mut-factor-email-code-harness';
import { callArg } from './helpers/mut-factor-call-arg';

async function send(
  body: unknown = { email: 'User@Example.com' },
  bindings: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  waitUntilThrows = false
) {
  const app = new Hono();
  app.post('/send', emailCodeSendHandler);
  const background: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    if (waitUntilThrows) throw new Error('no execution context');
    background.push(promise);
  });
  const pending = app.request(
    '/send',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    emailCodeEnv(bindings),
    { waitUntil, passThroughOnException: vi.fn(), props: {} }
  );
  await vi.runAllTimersAsync();
  const response = await pending;
  await Promise.allSettled(background);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}
const audits = () => em.createAuditLog.mock.calls.map((call) => call[1] as Record<string, unknown>);
const stored = () =>
  em.storeChallengeRpc.mock.calls[0]?.[0] as Record<string, unknown> & {
    metadata: Record<string, unknown>;
  };

describe('email code send: limits and hidden failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEmailCodeHarness();
    screen.check.mockResolvedValue({ ok: true });
  });
  afterEach(() => vi.useRealTimers());

  it('tells the caller when it may send again', async () => {
    em.incrementRpc.mockResolvedValueOnce({ allowed: false, retryAfter: 321 });
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.body.error_description).toContain('321');
  });

  it('audits a missing secret with the address hash and the forwarded client', async () => {
    const res = await send(
      undefined,
      { OTP_HMAC_SECRET: '' },
      { 'X-Forwarded-For': '198.51.100.8,10.0.0.1' }
    );
    expect(res.body.success).toBe(true);
    expect(em.hashEmail).toHaveBeenCalledWith('user@example.com');
    expect(audits()).toEqual([
      {
        tenantId: 'tenant-1',
        userId: 'anonymous',
        action: 'auth.email_code.send_failed',
        resource: 'email_code',
        resourceId: 'email-hash',
        ipAddress: '198.51.100.8',
        userAgent: 'unknown',
        metadata: JSON.stringify({ method: 'email_code', reason: 'otp_secret_missing' }),
        severity: 'warning',
      },
    ]);
  });

  it('audits without an address hash or client when there are none', async () => {
    em.hashEmail.mockRejectedValueOnce(new Error('hash down'));
    em.createAuditLog.mockRejectedValueOnce(new TypeError('audit down'));
    const res = await send(undefined, { OTP_HMAC_SECRET: '' }, { 'User-Agent': 'agent/9' }, true);
    expect(res.body.success).toBe(true);
    expect(audits()[0]).toMatchObject({
      resourceId: 'unknown',
      ipAddress: 'unknown',
      userAgent: 'agent/9',
    });
    expect(em.error).toHaveBeenCalledWith(expect.any(String), {
      action: 'audit_log',
      errorType: 'TypeError',
    });
  });

  it('takes the code back and audits a failed delivery', async () => {
    em.notifierSend.mockResolvedValueOnce({ success: false });
    em.deleteChallengeRpc.mockRejectedValueOnce(new Error('store down'));
    const res = await send();
    expect(res.body.success).toBe(true);
    expect(em.deleteChallengeRpc).toHaveBeenCalledWith(
      `email_code:${stored().metadata.otp_session_id as string}`
    );
    expect(audits()).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        metadata: JSON.stringify({ method: 'email_code', reason: 'delivery_failed' }),
      }),
    ]);
  });

  it.each([
    ['a write fence', 'tenant_placement_migration_write_fenced', 503],
    ['an overloaded database', 'D1 DB is overloaded', 503],
    ['anything else', 'boom', 500],
  ])('answers %s before the send as such', async (_label, message, status) => {
    em.incrementRpc.mockRejectedValueOnce(new Error(message));
    const res = await send();
    expect(res.status).toBe(status);
  });
});

describe('email code send: a new address', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEmailCodeHarness();
    screen.check.mockResolvedValue({ ok: true });
    em.findByEmail.mockResolvedValue(null);
  });
  afterEach(() => vi.useRealTimers());

  it('sends nothing for a sign-up its Flow screen refuses', async () => {
    screen.check.mockResolvedValueOnce({ ok: false, reason: 'unknown_field' });
    const res = await send({ email: 'new@example.com', custom_fields: { x: 1 } });
    expect(res.body.success).toBe(true);
    expect(screen.check).toHaveBeenCalledWith(expect.anything(), 'tenant-1', {
      customFields: { x: 1 },
    });
    expect(em.syncUser).not.toHaveBeenCalled();
    expect(em.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('answers missing required fields with their schema', async () => {
    em.validateRegistration.mockResolvedValueOnce({
      ok: false,
      error: 'missing',
      missingRequiredFields: [{ fieldKey: 'team', label: 'Team', fieldType: 'text' }],
    });
    const res = await send({ email: 'new@example.com', name: 'New' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error_code: 'AR130002',
      missing_required_fields: [{ field_key: 'team', label: 'Team', field_type: 'text' }],
    });
    expect(em.validateRegistration).toHaveBeenCalledWith(expect.anything(), 'tenant-1', {
      email: 'new@example.com',
      'field.canonical.email': 'new@example.com',
      name: 'New',
      'field.canonical.name': 'New',
    });
  });

  it('provisions a routed account with its name', async () => {
    em.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValueOnce({
      user: { id: 'old', active: 0 },
    });
    const res = await send({ email: 'new@example.com', name: 'New Person' }, { __TENANT_D1: true });
    expect(res.body.success).toBe(true);
    const input = callArg<{ runtimeUser: Record<string, unknown> }>(
      em.provisionTenantD1EmailAccount,
      0,
      1
    );
    expect(input.runtimeUser.piiFields).toEqual({ email: true, name: true });
    expect(input.runtimeUser.sensitiveValues).toEqual({
      email: 'new@example.com',
      name: 'New Person',
    });
    expect(stored().userId).toBe('new-user-1');
  });

  it('provisions a routed account without a name', async () => {
    em.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockRejectedValueOnce(
      new Error('account_data_route_not_found')
    );
    await send({ email: 'new@example.com' }, { __TENANT_D1: true });
    const input = callArg<{ runtimeUser: Record<string, unknown> }>(
      em.provisionTenantD1EmailAccount,
      0,
      1
    );
    expect(input.runtimeUser.piiFields).toEqual({ email: true });
  });

  it('sends to an active routed account without making one', async () => {
    em.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValueOnce({
      user: { id: 'routed-1', email: 'new@example.com', name: 'R', active: 1 },
    });
    await send({ email: 'new@example.com' }, { __TENANT_D1: true });
    expect(em.provisionTenantD1EmailAccount).not.toHaveBeenCalled();
    expect(stored().userId).toBe('routed-1');
  });

  it('keeps the Flow session profile for a sign-up made here only', async () => {
    vi.mocked(signUpPolicyFor).mockResolvedValue({ ...NO_POLICY, sessionProfileRef: 'strict' });
    await send({ email: 'new@example.com' });
    expect(stored().metadata.session_profile_ref).toBe('strict');
    em.storeChallengeRpc.mockClear();
    em.findByEmail.mockResolvedValue({ id: 'user-1', email: 'user@example.com', name: 'User' });
    await send();
    expect(stored().metadata).not.toHaveProperty('session_profile_ref');
    vi.mocked(signUpPolicyFor).mockResolvedValue(NO_POLICY);
  });

  it('greets a new account by its address when it gave no name', async () => {
    await send({ email: 'fresh.person@example.com' });
    const payload = em.notifierSend.mock.calls[0][0] as { metadata: { textBody: string } };
    expect(payload.metadata.textBody).toContain('fresh.person');
  });
});
