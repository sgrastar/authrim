/**
 * Shared mocks for the mut-factor-totp-* tests (TOTP sign-up and sign-in handlers).
 *
 * The test files keep their own vi.mock calls (they are hoisted per file) and build the mocked
 * modules with the factories here, so the mock objects below are the ones the handlers call.
 */
import { vi } from 'vitest';
import { Hono, type Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

type AnyFn = (...args: never[]) => unknown;
type Override<T extends AnyFn> = T | null;

export const m = {
  challengeStore: {
    storeChallengeRpc: vi.fn(),
    getChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
    deleteChallengeRpc: vi.fn(),
  },
  sessionStore: { createSessionRpc: vi.fn() },
  rateLimiter: { incrementRpc: vi.fn() },
  totpRepo: {
    create: vi.fn(),
    findById: vi.fn(),
    findActiveByUserId: vi.fn(),
    activate: vi.fn(),
    markUsed: vi.fn(),
    replaceBackupCodes: vi.fn(),
  },
  runtimeUsers: {
    findByEmail: vi.fn(),
    findByPreferredUsername: vi.fn(),
    findById: vi.fn(),
    syncUser: vi.fn(),
    touchLastLogin: vi.fn(),
    findAccountAuthenticationState: vi.fn(),
    findAuthenticationResponseUser: vi.fn(),
  },
  getChallengeStoreByChallengeId: vi.fn(),
  publishEvent: vi.fn(),
  createAuditLog: vi.fn(),
  resolvePostLoginRedirectUrl: vi.fn(),
  consumeContinuation: vi.fn(),
  validateFields: vi.fn(),
  persistFields: vi.fn(),
  buildProfileFields: vi.fn(),
  resolveAccountDataContext: vi.fn(),
  resolveEmailAccountRoute: vi.fn(),
  usesRoutedAccountStorage: vi.fn(),
  provisionAccount: vi.fn(),
  consumeTimeStep: vi.fn(),
  checkEmailRegistration: vi.fn(),
  notifyExistingAccountSignUp: vi.fn(),
  completeSignupInvitation: vi.fn(),
  startSignupInvitation: vi.fn(),
  verifyHumanVerification: vi.fn(),
  readLiteMode: vi.fn(),
  coreAdapter: {},
};

/** Per-test replacements of real functions (null: the real one). */
export const overrides: {
  signUpPolicyFor: Override<AnyFn>;
  profileAllowsSignUp: Override<AnyFn>;
  sessionForChallenge: Override<AnyFn>;
  sessionTtlForProfile: Override<AnyFn>;
  namedInteractionChallengeRefusal: Override<AnyFn>;
  signInAttemptInteractionMetadata: Override<AnyFn>;
  flowCompletionRedirect: Override<AnyFn>;
} = {
  signUpPolicyFor: null,
  profileAllowsSignUp: null,
  sessionForChallenge: null,
  sessionTtlForProfile: null,
  namedInteractionChallengeRefusal: null,
  signInAttemptInteractionMetadata: null,
  flowCompletionRedirect: null,
};

function pick<T extends AnyFn>(key: keyof typeof overrides, actual: T): T {
  return ((...args: never[]) => {
    const replaced = overrides[key];
    return replaced ? replaced(...args) : actual(...args);
  }) as T;
}

type Handler = (c: Context<{ Bindings: Env }>) => Response | Promise<Response>;

type LibCore = typeof import('@authrim/ar-lib-core');

export function libCoreMock(actual: LibCore): Record<string, unknown> {
  const authCtx = () => ({ repositories: { totp: m.totpRepo }, coreAdapter: m.coreAdapter });
  return {
    ...actual,
    resolveSignInFlowProfileRefs: (
      ...[env, db, tenantId, binding]: Parameters<LibCore['resolveSignInFlowProfileRefs']>
    ) =>
      actual.resolveSignInFlowProfileRefs(env, db, tenantId, {
        ...binding,
        challengeId: null,
      }),
    checkEmailRegistration: m.checkEmailRegistration,
    getChallengeStoreByChallengeId: m.getChallengeStoreByChallengeId,
    getSessionStoreForNewSession: async () => ({
      stub: m.sessionStore,
      sessionId: 'g1:apac:3:session_new',
    }),
    resolveSignInAttemptInteraction: async () => null,
    recordSignInAttemptFailure: async () => null,
    getTenantIdFromContext: () => 'default',
    createAccountAuthContextFromHono: authCtx,
    createAuthContextFromHono: authCtx,
    createPIIContextFromHono: () => ({
      defaultPiiAdapter: {},
    }),
    resolveAccountDataContextFromHono: m.resolveAccountDataContext,
    consumeTotpAuthenticationState: async (
      _env: unknown,
      input: Record<string, unknown>,
      loader: () => Promise<{ lifecycle?: string } | null>
    ) => {
      const account = await loader();
      if (!account || account.lifecycle !== 'active') {
        throw new Error('account_authentication_not_allowed');
      }
      return (await m.consumeTimeStep(input)) as unknown;
    },
    CanonicalRuntimeUserStore: vi.fn(function CanonicalRuntimeUserStoreMock() {
      return m.runtimeUsers;
    }),
    publishEvent: m.publishEvent,
    createAuditLog: m.createAuditLog,
    resolvePostLoginRedirectUrl: m.resolvePostLoginRedirectUrl,
  };
}

export async function registrationGateMock(
  actual: typeof import('../../registration-policy-gate')
) {
  return {
    ...actual,
    signUpPolicyFor: pick('signUpPolicyFor', async () => actual.NO_POLICY),
    profileAllowsSignUp: pick('profileAllowsSignUp', actual.profileAllowsSignUp),
    flowCompletionRedirect: pick('flowCompletionRedirect', actual.flowCompletionRedirect),
    notifyExistingAccountSignUp: m.notifyExistingAccountSignUp,
  };
}

export function flowSessionMock(actual: typeof import('../../flow-session-profile')) {
  return {
    ...actual,
    sessionForChallenge: pick('sessionForChallenge', actual.sessionForChallenge),
    sessionTtlForProfile: pick('sessionTtlForProfile', actual.sessionTtlForProfile),
    namedInteractionChallengeRefusal: pick(
      'namedInteractionChallengeRefusal',
      actual.namedInteractionChallengeRefusal
    ),
  };
}

export function attemptRecordingMock(actual: typeof import('../../sign-in-attempt-recording')) {
  return {
    ...actual,
    signInAttemptInteractionMetadata: pick(
      'signInAttemptInteractionMetadata',
      actual.signInAttemptInteractionMetadata
    ),
  };
}

export function accountProvisioningMock(actual: typeof import('../../account-provisioning')) {
  return {
    ...actual,
    resolveTenantD1EmailAccountRoute: m.resolveEmailAccountRoute,
    usesRoutedAccountStorage: m.usesRoutedAccountStorage,
    provisionTenantD1EmailAccount: m.provisionAccount,
  };
}

export function invitationMock(actual: typeof import('../../invitation-redemption')) {
  return {
    ...actual,
    startSignupInvitation: m.startSignupInvitation,
    completeSignupInvitation: m.completeSignupInvitation,
  };
}

export const ENCRYPTION_KEY = '11'.repeat(32);
export const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

export const ENABLED = {
  'authentication-methods.totp.login_enabled': true,
  'authentication-methods.totp.signup_enabled': true,
  'authentication-methods.totp.reauth_enabled': true,
};

/** An env whose tenant authentication-methods document is `methods` (raw string kept as is). */
export function createEnv(
  methods: Record<string, unknown> | string | null = ENABLED,
  extra: Record<string, unknown> = {},
  more: Record<string, unknown> = {}
): Env {
  return {
    ISSUER_URL: 'https://op.example.com',
    PII_ENCRYPTION_KEY: ENCRYPTION_KEY,
    OTP_HMAC_SECRET: 'test-hmac-secret',
    SETTINGS: {
      get: vi.fn(async (key: string) => {
        if (key === 'settings:tenant:default:authentication-methods') {
          if (methods === null) return null;
          return typeof methods === 'string' ? methods : JSON.stringify(methods);
        }
        const value = more[key];
        return value === undefined ? null : JSON.stringify(value);
      }),
    },
    RATE_LIMITER: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => m.rateLimiter),
    },
    ...extra,
  } as unknown as Env;
}

export function resetHarness(): void {
  vi.resetAllMocks();
  for (const key of Object.keys(overrides) as (keyof typeof overrides)[]) overrides[key] = null;
  m.getChallengeStoreByChallengeId.mockResolvedValue(m.challengeStore);
  m.rateLimiter.incrementRpc.mockResolvedValue({ allowed: true });
  m.challengeStore.storeChallengeRpc.mockResolvedValue({ success: true });
  m.challengeStore.getChallengeRpc.mockResolvedValue(null);
  m.challengeStore.consumeChallengeRpc.mockResolvedValue(null);
  m.challengeStore.deleteChallengeRpc.mockResolvedValue({ deleted: true });
  m.sessionStore.createSessionRpc.mockResolvedValue({ success: true });
  m.totpRepo.findActiveByUserId.mockResolvedValue([]);
  m.totpRepo.findById.mockResolvedValue(null);
  m.totpRepo.create.mockResolvedValue(null);
  m.totpRepo.activate.mockResolvedValue(null);
  m.totpRepo.markUsed.mockResolvedValue(true);
  m.totpRepo.replaceBackupCodes.mockResolvedValue([]);
  m.runtimeUsers.findByEmail.mockResolvedValue(null);
  m.runtimeUsers.findByPreferredUsername.mockResolvedValue(null);
  m.runtimeUsers.findById.mockResolvedValue(null);
  m.runtimeUsers.syncUser.mockResolvedValue(undefined);
  m.runtimeUsers.touchLastLogin.mockResolvedValue(true);
  m.runtimeUsers.findAccountAuthenticationState.mockResolvedValue({
    userId: 'user-001',
    accountType: 'user',
    lifecycle: 'active',
    sourceVersionMs: 1_000,
  });
  m.runtimeUsers.findAuthenticationResponseUser.mockImplementation(async (userId: string) => ({
    id: userId,
    email: 'person@example.com',
    name: 'Person',
  }));
  m.publishEvent.mockResolvedValue(undefined);
  m.createAuditLog.mockResolvedValue(undefined);
  m.resolvePostLoginRedirectUrl.mockResolvedValue({ redirectUrl: '/' });
  m.consumeContinuation.mockResolvedValue({
    type: 'login',
    redirectUrl: 'https://rp.example.com/callback?code=abc',
  });
  m.validateFields.mockImplementation(async (_env: unknown, _t: unknown, values: unknown) => ({
    ok: true,
    values: {},
    schemas: [],
    received: values,
  }));
  m.persistFields.mockResolvedValue(undefined);
  m.buildProfileFields.mockReturnValue({ piiFields: {}, sensitiveValues: {} });
  m.resolveAccountDataContext.mockResolvedValue({ accountId: 'account:user-001' });
  m.resolveEmailAccountRoute.mockResolvedValue('not_required');
  m.usesRoutedAccountStorage.mockReturnValue(false);
  m.consumeTimeStep.mockResolvedValue({ lastAcceptedTimeStep: 1 });
  m.checkEmailRegistration.mockResolvedValue('available');
  m.notifyExistingAccountSignUp.mockResolvedValue(undefined);
  m.completeSignupInvitation.mockResolvedValue(undefined);
  m.verifyHumanVerification.mockResolvedValue(null);
  m.readLiteMode.mockResolvedValue('off');
}

export function createTotpApp(handlers: {
  totpLoginStartHandler: Handler;
  totpLoginVerifyHandler: Handler;
  totpSignupActivateHandler: Handler;
  totpSignupOptionsHandler: Handler;
}) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/start', handlers.totpLoginStartHandler);
  app.post('/verify', handlers.totpLoginVerifyHandler);
  app.post('/options', handlers.totpSignupOptionsHandler);
  app.post('/activate', handlers.totpSignupActivateHandler);
  return app;
}

export interface PostResult {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
  waitUntil: ReturnType<typeof vi.fn>;
}

/** Posts JSON and resolves the constant-time delay (fake timers are expected). */
export async function postJson(
  app: Hono<{ Bindings: Env }>,
  path: string,
  body: unknown,
  env: Env = createEnv(),
  headers: Record<string, string> = {}
): Promise<PostResult> {
  const waitUntil = vi.fn();
  const pending = app.request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.10',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
    { waitUntil } as unknown as ExecutionContext
  );
  await vi.advanceTimersByTimeAsync(700);
  const response = await pending;
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, headers: response.headers, waitUntil };
}
