/**
 * Shared mocks for the mut-factor-passkey-* tests (passkey sign-in handlers). The test files keep
 * their own vi.mock calls and build the mocked modules with the factories here.
 */
import { vi } from 'vitest';
import { Hono, type Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

export const pm = {
  webauthn: {
    generateRegistrationOptions: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  },
  challengeStore: {
    storeChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
    getChallengeRpc: vi.fn(),
    deleteChallengeRpc: vi.fn(),
  },
  sessionStore: { createSessionRpc: vi.fn() },
  passkeyRepo: {
    findByCredentialId: vi.fn(),
    findByUserId: vi.fn(),
    mirrorCounterAfterAuth: vi.fn(),
  },
  coreAdapter: { execute: vi.fn(), queryOne: vi.fn(), query: vi.fn() },
  runtimeUsers: {
    findByEmail: vi.fn(),
    syncUser: vi.fn(),
    findAccountAuthenticationState: vi.fn(),
    findAuthenticationResponseUser: vi.fn(),
    touchLastLogin: vi.fn(),
  },
  createAuthContext: vi.fn(),
  createAccountAuthContext: vi.fn(),
  advanceState: vi.fn(),
  assertGuestAllowed: vi.fn(),
  publishEvent: vi.fn(),
  createAuditLog: vi.fn(),
  scheduleAdminAudit: vi.fn(),
  requireAdminAdapter: vi.fn(),
  adminCreateSession: vi.fn(),
  resolvePasskeyRoute: vi.fn(),
  usesRoutedAccountStorage: vi.fn(),
  readLiteMode: vi.fn(),
  checkEmailRegistration: vi.fn(),
  resumeUserId: vi.fn(),
  provisionAccount: vi.fn(),
  resolveEmailRoute: vi.fn(),
  pendingMark: vi.fn(),
  validateFields: vi.fn(),
  buildProfileFields: vi.fn(),
  screenCheck: vi.fn(),
  sessionTtlForProfile: vi.fn(),
  resolveAccountData: vi.fn(),
};

type Handler = (c: Context<{ Bindings: Env }>) => Response | Promise<Response>;

type LibCore = typeof import('@authrim/ar-lib-core');

export function passkeyLibCoreMock(actual: LibCore): Record<string, unknown> {
  return {
    ...actual,
    getChallengeStoreByChallengeId: async () => pm.challengeStore,
    getChallengeStoreByUserId: async () => pm.challengeStore,
    getSessionStoreForNewSession: async () => ({
      stub: pm.sessionStore,
      sessionId: 'session-new',
    }),
    getTenantIdFromContext: () => 'default',
    createAuthContextFromHono: pm.createAuthContext,
    createAccountAuthContextFromHono: pm.createAccountAuthContext,
    createPIIContextFromHono: () => ({
      defaultPiiAdapter: {},
    }),
    CanonicalRuntimeUserStore: vi.fn(function CanonicalRuntimeUserStoreMock() {
      return pm.runtimeUsers;
    }),
    advancePasskeyAuthenticationState: async (
      _env: unknown,
      input: unknown,
      loader: () => Promise<unknown>
    ) => {
      await loader();
      return (await pm.advanceState(input)) as unknown;
    },
    assertGuestCredentialAuthenticationAllowed: pm.assertGuestAllowed,
    checkEmailRegistration: pm.checkEmailRegistration,
    resolveAccountDataContextFromHono: pm.resolveAccountData,
    generateUserIdFromSettings: async () => 'user-new',
    newAccountRegistrationPendingMark: pm.pendingMark,
    publishEvent: pm.publishEvent,
    createAuditLog: pm.createAuditLog,
    scheduleAdminAuthenticationAudit: pm.scheduleAdminAudit,
    requireDedicatedAdminDatabaseAdapter: pm.requireAdminAdapter,
    AdminSessionRepository: vi.fn(function AdminSessionRepositoryMock() {
      return { createSession: pm.adminCreateSession };
    }),
  };
}

export function passkeyProvisioningMock(actual: typeof import('../../account-provisioning')) {
  return {
    ...actual,
    resolveTenantD1PasskeyAccountRoute: pm.resolvePasskeyRoute,
    resolvePasskeyProvisioningResumeUserId: pm.resumeUserId,
    provisionTenantD1EmailAccount: pm.provisionAccount,
    resolveTenantD1EmailAccountRoute: pm.resolveEmailRoute,
    usesRoutedAccountStorage: pm.usesRoutedAccountStorage,
  };
}

export function resetPasskeyHarness(): void {
  vi.resetAllMocks();
  const authCtx = { repositories: { passkey: pm.passkeyRepo }, coreAdapter: pm.coreAdapter };
  pm.createAuthContext.mockReturnValue(authCtx);
  pm.createAccountAuthContext.mockReturnValue(authCtx);
  pm.challengeStore.storeChallengeRpc.mockResolvedValue({ success: true });
  pm.challengeStore.consumeChallengeRpc.mockResolvedValue({ challenge: 'expected-challenge' });
  pm.sessionStore.createSessionRpc.mockImplementation(async (id: string) => ({ id }));
  pm.passkeyRepo.findByCredentialId.mockResolvedValue(null);
  pm.passkeyRepo.mirrorCounterAfterAuth.mockResolvedValue(true);
  pm.coreAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
  pm.runtimeUsers.findAccountAuthenticationState.mockResolvedValue({
    userId: 'user-1',
    accountType: 'user',
    lifecycle: 'active',
    sourceVersionMs: 1,
  });
  pm.runtimeUsers.findAuthenticationResponseUser.mockResolvedValue({
    id: 'user-1',
    email: 'person@example.com',
    name: 'Person',
    emailVerified: 1,
    createdAt: 'c',
    updatedAt: 'u',
    lastLoginAt: null,
  });
  pm.runtimeUsers.touchLastLogin.mockResolvedValue(true);
  pm.advanceState.mockResolvedValue(undefined);
  pm.assertGuestAllowed.mockResolvedValue(undefined);
  pm.publishEvent.mockResolvedValue(undefined);
  pm.createAuditLog.mockResolvedValue(undefined);
  pm.requireAdminAdapter.mockReturnValue({});
  pm.adminCreateSession.mockResolvedValue(undefined);
  pm.resolvePasskeyRoute.mockResolvedValue(null);
  pm.usesRoutedAccountStorage.mockReturnValue(false);
  pm.readLiteMode.mockResolvedValue('off');
  pm.runtimeUsers.findByEmail.mockResolvedValue(null);
  pm.runtimeUsers.syncUser.mockResolvedValue(undefined);
  pm.passkeyRepo.findByUserId.mockResolvedValue([]);
  pm.checkEmailRegistration.mockResolvedValue('allowed');
  pm.resumeUserId.mockResolvedValue(null);
  pm.resolveEmailRoute.mockResolvedValue('not_required');
  pm.pendingMark.mockResolvedValue({ mark: 'pending' });
  pm.resolveAccountData.mockResolvedValue({});
  pm.validateFields.mockResolvedValue({ ok: true, values: {} });
  pm.buildProfileFields.mockReturnValue({ piiFields: {}, sensitiveValues: {} });
  pm.screenCheck.mockResolvedValue({ ok: true });
  pm.webauthn.generateRegistrationOptions.mockResolvedValue({ challenge: 'reg-challenge' });
  pm.webauthn.generateAuthenticationOptions.mockResolvedValue({
    challenge: 'generated-challenge',
    rpId: 'login.example.com',
  });
  pm.webauthn.verifyAuthenticationResponse.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 8 },
  });
}

export function passkeyEnv(
  settings: Record<string, string | null> = {},
  extra: Record<string, unknown> = {}
): Env {
  return {
    ISSUER_URL: 'https://login.example.com',
    SETTINGS: {
      get: vi.fn(async (key: string) => settings[key] ?? null),
    },
    ...extra,
  } as unknown as Env;
}

export function passkeyApp(handlers: {
  passkeyLoginOptionsHandler: Handler;
  passkeyLoginVerifyHandler: Handler;
  passkeyRegisterOptionsHandler: Handler;
  passkeyRegisterVerifyHandler: Handler;
}) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/register/options', handlers.passkeyRegisterOptionsHandler);
  app.post('/register/verify', handlers.passkeyRegisterVerifyHandler);
  app.post('/login/options', handlers.passkeyLoginOptionsHandler);
  app.post('/login/verify', handlers.passkeyLoginVerifyHandler);
  return app;
}

export async function send(
  app: Hono<{ Bindings: Env }>,
  url: string,
  body: unknown,
  env: Env,
  headers: Record<string, string> = {}
) {
  const waitUntil = vi.fn();
  const response = await app.request(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env,
    { waitUntil } as unknown as ExecutionContext
  );
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, headers: response.headers, waitUntil };
}
