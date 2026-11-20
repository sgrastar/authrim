/**
 * Shared mocks for the mut-factor-email-code-* tests (adapted from email-code-handler.test.ts).
 * The test files keep their own vi.mock calls and build the mocked modules with the factories.
 */
import { vi } from 'vitest';
import { Hono, type Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

export const em = {
  clearAccountRegistrationPending: vi.fn(),
  findByEmail: vi.fn(),
  findById: vi.fn(),
  findForOtpLogin: vi.fn(),
  syncUser: vi.fn(),
  markEmailVerifiedForOtpLogin: vi.fn(),
  markEmailVerifiedAndTouchLastLogin: vi.fn(),
  validateRegistration: vi.fn(),
  buildCanonicalFields: vi.fn(),
  persistRegistrationFields: vi.fn(),
  generateCode: vi.fn(),
  hashCode: vi.fn(),
  verifyCode: vi.fn(),
  hashEmail: vi.fn(),
  storeChallengeRpc: vi.fn(),
  consumeChallengeRpc: vi.fn(),
  deleteChallengeRpc: vi.fn(),
  notifierSend: vi.fn(),
  getNotifier: vi.fn(),
  incrementRpc: vi.fn(),
  createSessionRpc: vi.fn(),
  publishEvent: vi.fn(),
  createAuditLog: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  createAccountAuthContextFromHono: vi.fn(),
  resolveOtpAccountCoreDataContextByIdentifierFromHono: vi.fn(),
  resolveAccountDataContextByIdentifierFromHono: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(),
  markOtpLoginEmailVerified: vi.fn(),
  ensureDatabaseAdapter: vi.fn(),
  provisionTenantD1EmailAccount: vi.fn(),
  ensureAccountAuthenticationState: vi.fn(),
  guestCredentialFence: vi.fn(),
  findCanonicalAccountAuthenticationState: vi.fn(),
  sessionTtlForProfile: vi.fn(),
  withGroupInputWrite: vi.fn(),
};

type Handler = (c: Context<{ Bindings: Env }>) => Response | Promise<Response>;

type LibCore = typeof import('@authrim/ar-lib-core');

export function emailCodeLibCoreMock(actual: LibCore): Record<string, unknown> {
  return {
    ...actual,
    clearAccountRegistrationPending: em.clearAccountRegistrationPending,
    checkEmailRegistration: async () => 'allowed',
    withGroupInputWrite: em.withGroupInputWrite,
    getTenantIdFromContext: () => 'tenant-1',
    getTenantMetadataContextFromHono: (c: { env: { __TENANT_D1?: true } }) =>
      c.env.__TENANT_D1
        ? { tenantId: 'tenant-1', route: { allocationScope: 'tenant_exclusive' } }
        : undefined,
    resolveAccountDataContextByIdentifierFromHono: em.resolveAccountDataContextByIdentifierFromHono,
    resolveOtpAccountCoreDataContextByIdentifierFromHono:
      em.resolveOtpAccountCoreDataContextByIdentifierFromHono,
    resolveAccountDataContextFromHono: em.resolveAccountDataContextFromHono,
    markOtpLoginEmailVerified: em.markOtpLoginEmailVerified,
    ensureDatabaseAdapter: em.ensureDatabaseAdapter,
    createAccountAuthContextFromHono: em.createAccountAuthContextFromHono,
    ensureAccountAuthenticationState: em.ensureAccountAuthenticationState,
    assertGuestCredentialAuthenticationAllowed: em.guestCredentialFence,
    findCanonicalAccountAuthenticationState: em.findCanonicalAccountAuthenticationState,
    createPIIContextFromHono: () => ({ defaultPiiAdapter: {} }),
    CanonicalRuntimeUserStore: class {
      findByEmail = em.findByEmail;
      findById = em.findById;
      findForOtpLogin = em.findForOtpLogin;
      syncUser = em.syncUser;
      markEmailVerifiedForOtpLogin = em.markEmailVerifiedForOtpLogin;
      markEmailVerifiedAndTouchLastLogin = em.markEmailVerifiedAndTouchLastLogin;
    },
    generateUserIdFromSettings: async () => 'new-user-1',
    getChallengeStoreByChallengeId: async () => ({
      storeChallengeRpc: em.storeChallengeRpc,
      consumeChallengeRpc: em.consumeChallengeRpc,
      deleteChallengeRpc: em.deleteChallengeRpc,
    }),
    getSessionStoreForNewSession: async () => ({
      stub: { createSessionRpc: em.createSessionRpc },
      sessionId: 'session-1',
    }),
    generateBrowserState: async () => 'browser-state-1',
    getSessionCookieSameSite: () => 'Lax',
    getBrowserStateCookieSameSite: () => 'Lax',
    getRequiredPluginContext: () => ({
      registry: { getNotifier: em.getNotifier },
    }),
    produceNotificationDelivery: async (_env: unknown, input: { payload: unknown }) => {
      const notifier = em.getNotifier('email') as
        | { send: (payload: unknown) => Promise<{ success: boolean }> }
        | undefined;
      if (!notifier) throw new Error('notification_delivery_provider_order_unavailable');
      const result = await notifier.send(input.payload);
      return { delivery: result.success ? 'delivered' : 'permanent_failure' };
    },
    publishEvent: em.publishEvent,
    createAuditLog: em.createAuditLog,
    getLogger: () => ({
      module: () => ({ error: em.error, warn: em.warn, info: vi.fn() }),
    }),
  };
}

export const emailCodeUtilsMock = () => ({
  generateEmailCode: em.generateCode,
  hashEmailCode: em.hashCode,
  verifyEmailCodeHash: em.verifyCode,
  hashEmail: em.hashEmail,
});

export const fieldUtilsMock = () => ({
  validateRegistrationFieldSubmissionFromEnv: em.validateRegistration,
  buildCanonicalProfileRuntimeUserFields: em.buildCanonicalFields,
  persistRegistrationFieldValuesFromEnv: em.persistRegistrationFields,
});

export function emailCodeProvisioningMock(actual: typeof import('../../account-provisioning')) {
  return { ...actual, provisionTenantD1EmailAccount: em.provisionTenantD1EmailAccount };
}

export const validChallenge = {
  challenge: 'hashed-code',
  userId: 'user-1',
  email: 'user@example.com',
  metadata: {
    email_hash: 'email-hash',
    otp_session_id: 'otp-session-1',
    issued_at: 1_900_000_000,
    purpose: 'login',
  },
};

export const OTP_COOKIE = 'authrim_otp_session=otp-session-1';

export const routedContext = (user: Record<string, unknown> = {}) => ({
  tenantId: 'tenant-1',
  accountId: 'account:user-1',
  legacyUserId: 'user-1',
  coreDb: { adapter: 'tenant-core' },
  user: {
    id: 'user-1',
    email: 'user@example.com',
    name: 'User',
    active: 1,
    email_verified: 0,
    ...user,
  },
});

export function resetEmailCodeHarness(): void {
  for (const mock of Object.values(em)) mock.mockReset();
  em.clearAccountRegistrationPending.mockResolvedValue(undefined);
  em.withGroupInputWrite.mockImplementation(
    async (_db: unknown, _t: string, _u: string, _op: string, write: () => Promise<unknown>) =>
      write()
  );
  em.createAccountAuthContextFromHono.mockReturnValue({ coreAdapter: { kind: 'standard-core' } });
  em.ensureDatabaseAdapter.mockImplementation((source: unknown) => source);
  em.ensureAccountAuthenticationState.mockResolvedValue({ lifecycle: 'active' });
  em.guestCredentialFence.mockResolvedValue(undefined);
  em.findCanonicalAccountAuthenticationState.mockResolvedValue({ lifecycle: 'active' });
  em.findForOtpLogin.mockResolvedValue({
    id: 'user-1',
    email: 'user@example.com',
    name: 'User',
    active: 1,
    email_verified: 0,
  });
  em.verifyCode.mockResolvedValue(true);
  em.consumeChallengeRpc.mockResolvedValue(validChallenge);
  em.createSessionRpc.mockResolvedValue(undefined);
  em.markEmailVerifiedAndTouchLastLogin.mockResolvedValue(undefined);
  em.markOtpLoginEmailVerified.mockResolvedValue(true);
  em.persistRegistrationFields.mockResolvedValue(undefined);
  em.publishEvent.mockResolvedValue(undefined);
  em.createAuditLog.mockResolvedValue(undefined);
  em.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValue(routedContext());
  em.incrementRpc.mockResolvedValue({ allowed: true, retryAfter: 0 });
  em.findByEmail.mockResolvedValue({ id: 'user-1', email: 'user@example.com', name: 'User' });
  em.validateRegistration.mockResolvedValue({ ok: true, values: {} });
  em.buildCanonicalFields.mockReturnValue({ piiFields: {}, sensitiveValues: {} });
  em.generateCode.mockReturnValue('123456');
  em.hashCode.mockResolvedValue('hashed-code');
  em.hashEmail.mockResolvedValue('email-hash');
  em.storeChallengeRpc.mockResolvedValue(undefined);
  em.deleteChallengeRpc.mockResolvedValue(undefined);
  em.getNotifier.mockReturnValue({ send: em.notifierSend });
  em.notifierSend.mockResolvedValue({ success: true, messageId: 'message-1' });
  em.syncUser.mockResolvedValue(undefined);
  em.provisionTenantD1EmailAccount.mockResolvedValue({
    status: 'ready',
    accountId: 'account:new-user-1',
    userId: 'new-user-1',
  });
}

const METHODS = {
  'authentication-methods.email_otp.login_enabled': true,
  'authentication-methods.email_otp.signup_enabled': true,
};

export function emailCodeEnv(overrides: Record<string, unknown> = {}) {
  return {
    ISSUER_URL: 'https://auth.example.com',
    OTP_HMAC_SECRET: 'private-secret',
    SETTINGS: { get: vi.fn(async () => JSON.stringify(METHODS)) },
    RATE_LIMITER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ incrementRpc: em.incrementRpc })),
    },
    ...overrides,
  };
}

export async function postVerify(
  handler: Handler,
  body: unknown,
  bindings: Record<string, unknown> = {},
  cookie: string | undefined = OTP_COOKIE,
  headers: Record<string, string> = {}
) {
  const app = new Hono();
  app.post('/verify', handler);
  const background: Promise<unknown>[] = [];
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    background.push(promise);
  });
  const pending = app.request(
    '/verify',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    },
    emailCodeEnv(bindings),
    { waitUntil, passThroughOnException: vi.fn(), props: {} }
  );
  await vi.runAllTimersAsync();
  const response = await pending;
  await Promise.allSettled(background);
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, headers: response.headers, waitUntil };
}
