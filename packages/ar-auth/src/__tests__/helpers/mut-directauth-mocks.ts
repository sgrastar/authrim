/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- untyped vi.fn() stand-ins, as in the setup of direct-auth-flows.test.ts this copies */
/**
 * Module mocks for the mut-directauth-* tests of direct-auth.ts (copied from the setup of
 * direct-auth-flows.test.ts). Importing this module (through mut-directauth-harness.ts) registers
 * them: import it before anything that loads ../direct-auth.
 */
import { vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const authCodeStore = {
    storeCodeRpc: vi.fn(),
  };
  const challengeStore = {
    storeChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
    getChallengeRpc: vi.fn(),
    deleteChallengeRpc: vi.fn(),
  };
  const rateLimiter = {
    incrementRpc: vi.fn(),
  };
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  const coreAdapter = {
    execute: vi.fn(),
    queryOne: vi.fn(),
  };
  const userCore = {
    findById: vi.fn(),
    createUser: vi.fn(),
    updatePIIStatus: vi.fn(),
    updateLastLogin: vi.fn(),
  };
  const passkey = {
    findByUserId: vi.fn(),
    findByCredentialId: vi.fn(),
    updateCounterAfterAuth: vi.fn(),
    mirrorCounterAfterAuth: vi.fn(),
    create: vi.fn(),
  };
  const emailNotifier = {
    send: vi.fn(),
  };
  const userPII = {
    findById: vi.fn(),
    findByTenantAndEmail: vi.fn(),
    createPII: vi.fn(),
  };

  return {
    authCodeStore,
    challengeStore,
    rateLimiter,
    sessionStore,
    coreAdapter,
    userCore,
    passkey,
    emailNotifier,
    getNotifier: vi.fn(),
    userPII,
    getClient: vi.fn(),
    getWebOriginRegistry: vi.fn(),
    getTenantSettingsDocument: vi.fn(),
    getDefaultTenantId: vi.fn(),
    resolveTenantFromEmailDomain: vi.fn(),
    generateUserIdFromSettings: vi.fn(),
    publishEvent: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
    generateRegistrationOptions: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
    generateEmailCode: vi.fn(),
    hashEmailCode: vi.fn(),
    verifyEmailCodeHash: vi.fn(),
    hashEmail: vi.fn(),
    validateRegistrationFieldSubmissionFromEnv: vi.fn(),
    checkSignUpScreen: vi.fn(),
    persistRegistrationFieldValuesFromEnv: vi.fn(),
    verifyHumanVerificationForAction: vi.fn(),
    readLiteMode: vi.fn(),
    verifyEmailVerificationProtocol: vi.fn(),
    markOtpLoginEmailVerified: vi.fn(),
    clearAccountRegistrationPending: vi.fn(async () => undefined),
    ensureDatabaseAdapter: vi.fn((source) => source),
    resolveOtpAccountCoreDataContextByIdentifierFromHono: vi.fn(),
    resolveAccountDataContextByIdentifierFromHono: vi.fn(),
    resolveAccountDataContextFromHono: vi.fn(),
    resolvePasskeyProvisioningResumeUserId: vi.fn(),
    provisionTenantD1EmailAccount: vi.fn(),
    publishTenantD1PasskeyRoute: vi.fn(),
    findActiveInvitationByToken: vi.fn(),
    reserveInvitationUse: vi.fn(),
    findInvitationReservation: vi.fn(),
    findInvitationById: vi.fn(),
    bindInvitationReservation: vi.fn(),
    claimInvitationReservation: vi.fn(),
    releaseInvitationReservation: vi.fn(),
    applyInvitationAssignments: vi.fn(),
    getCookie: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    advancePasskeyCounterRpc: vi.fn(),
    createPIIContextFromHono: vi.fn(() => ({
      piiRepositories: {
        userPII,
      },
    })),
    createAccountAuthContextFromHono: vi.fn(),
  };
});

vi.mock('hono/cookie', () => ({
  getCookie: mocks.getCookie,
  setCookie: vi.fn(),
  deleteCookie: vi.fn(),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
}));

vi.mock('../../utils/email-code-utils', () => ({
  generateEmailCode: mocks.generateEmailCode,
  hashEmailCode: mocks.hashEmailCode,
  verifyEmailCodeHash: mocks.verifyEmailCodeHash,
  hashEmail: mocks.hashEmail,
}));

vi.mock('../../registration-field-utils', () => ({
  buildCanonicalProfileRuntimeUserFields: () => ({ piiFields: {}, sensitiveValues: {} }),
  validateRegistrationFieldSubmissionFromEnv: mocks.validateRegistrationFieldSubmissionFromEnv,
  persistRegistrationFieldValuesFromEnv: mocks.persistRegistrationFieldValuesFromEnv,
}));

vi.mock('../../signup-screen-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../signup-screen-check')>()),
  checkSignUpScreen: mocks.checkSignUpScreen,
}));

vi.mock('../../human-verification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../human-verification')>()),
  verifyHumanVerificationForAction: mocks.verifyHumanVerificationForAction,
}));

vi.mock('../../lite-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lite-mode')>()),
  readLiteMode: mocks.readLiteMode,
}));

vi.mock('../../email-verification-protocol', () => ({
  verifyEmailVerificationProtocol: mocks.verifyEmailVerificationProtocol,
}));

vi.mock('../../account-provisioning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../account-provisioning')>();
  return {
    ...actual,
    resolvePasskeyProvisioningResumeUserId: mocks.resolvePasskeyProvisioningResumeUserId,
    provisionTenantD1EmailAccount: mocks.provisionTenantD1EmailAccount,
    publishTenantD1PasskeyRoute: mocks.publishTenantD1PasskeyRoute,
  };
});

vi.mock('@authrim/ar-lib-core/services/invitation-auth-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@authrim/ar-lib-core/services/invitation-auth-core')>();
  return {
    ...actual,
    findActiveInvitationByToken: mocks.findActiveInvitationByToken,
    reserveInvitationUse: mocks.reserveInvitationUse,
    findInvitationReservation: mocks.findInvitationReservation,
    findInvitationById: mocks.findInvitationById,
    bindInvitationReservation: mocks.bindInvitationReservation,
    claimInvitationReservation: mocks.claimInvitationReservation,
    releaseInvitationReservation: mocks.releaseInvitationReservation,
    applyInvitationAssignments: mocks.applyInvitationAssignments,
  };
});

const attemptRecording = vi.hoisted(() => ({
  resolve: vi.fn(async (..._args: unknown[]) => null as string | null),
  record: vi.fn(async (..._args: unknown[]) => null as string | null),
}));

const registrationCheck = vi.hoisted(() => ({
  override: null as null | 'blocked' | 'unavailable',
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    checkEmailRegistration: async (...args: unknown[]) =>
      registrationCheck.override ??
      actual.checkEmailRegistration(
        ...(args as Parameters<typeof import('@authrim/ar-lib-core').checkEmailRegistration>)
      ),
    withGroupInputWrite: <T>(
      db: import('@authrim/ar-lib-core').DatabaseAdapter,
      tenant: string,
      user: string,
      operation: string,
      write: () => Promise<T>
    ) =>
      actual.withGroupInputWrite(
        {
          ...db,
          getType: () => 'd1',
          execute:
            typeof db.execute === 'function'
              ? db.execute.bind(db)
              : async () => ({ success: true, rowsAffected: 1 }),
        },
        tenant,
        user,
        operation,
        write
      ),

    assertGuestCredentialAuthenticationAllowed: vi.fn(async () => undefined),
    resolveSignInAttemptInteraction: attemptRecording.resolve,
    recordSignInAttemptFailure: attemptRecording.record,
    CanonicalRuntimeUserStore: class {
      async findById(userId: string) {
        const core = await mocks.userCore.findById(userId);
        if (!core?.is_active) return null;
        const pii = await mocks.userPII.findById(userId);
        return {
          id: core.id,
          account_type: core.user_type === 'admin' ? 'admin' : 'user',
          active: core.is_active ? 1 : 0,
          email: pii?.email ?? null,
          name: pii?.name ?? null,
          email_verified: core.email_verified ? 1 : 0,
          phone_number_verified: core.phone_number_verified ? 1 : 0,
          created_at: new Date(core.created_at ?? Date.now()).toISOString(),
          updated_at: new Date(core.updated_at ?? Date.now()).toISOString(),
          last_login_at: core.last_login_at ?? null,
        };
      }
      async findByEmail(email: string) {
        const pii = await mocks.userPII.findByTenantAndEmail('tenant_test', email);
        if (!pii) return null;
        return this.findById(pii.id);
      }
      async findForOtpLogin(userId: string, trustedEmail: string) {
        const core = await mocks.userCore.findById(userId);
        if (!core?.is_active) return null;
        return {
          id: core.id,
          account_type: core.user_type === 'admin' ? 'admin' : 'end_user',
          active: 1,
          email: trustedEmail.toLowerCase(),
          name: null,
          email_verified: core.email_verified ? 1 : 0,
          created_at: new Date(core.created_at ?? Date.now()).toISOString(),
        };
      }
      async findAccountAuthenticationState(userId: string) {
        const core = await mocks.userCore.findById(userId);
        if (!core) return null;
        return {
          userId,
          accountType: core.user_type === 'admin' ? 'admin' : 'user',
          lifecycle: core.is_active ? 'active' : 'inactive',
          sourceVersionMs: 1_000,
        };
      }
      async syncUser(input: {
        userId: string;
        email?: string | null;
        name?: string | null;
        emailVerified?: boolean;
      }) {
        await mocks.userCore.createUser({
          id: input.userId,
          tenant_id: 'tenant_test',
          email_verified: input.emailVerified === true,
          user_type: 'end_user',
        });
        await mocks.userPII.createPII({
          id: input.userId,
          tenant_id: 'tenant_test',
          email: input.email,
          name: input.name,
          preferred_username: input.email?.split('@')[0],
        });
        await mocks.userCore.updatePIIStatus(input.userId, 'active');
        return { created: true, graph: null, profileAttributeCount: 0, contactPointCount: 0 };
      }
      async markEmailVerified(userId: string) {
        await mocks.coreAdapter.execute(
          'UPDATE users_core SET email_verified = 1, updated_at = ? WHERE id = ? AND tenant_id = ?',
          [Date.now(), userId, 'tenant_test']
        );
        return true;
      }
      async markEmailVerifiedAndTouchLastLogin(userId: string) {
        await mocks.coreAdapter.execute(
          'UPDATE users_core SET email_verified = 1, last_login_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
          [Date.now(), Date.now(), userId, 'tenant_test']
        );
        return true;
      }
      async touchLastLogin(userId: string) {
        await mocks.userCore.updateLastLogin(userId);
        return true;
      }
      async deleteUser() {
        return true;
      }
    },
    getTenantIdFromContext: vi.fn(() => 'tenant_test'),
    getDefaultTenantId: mocks.getDefaultTenantId,
    getTenantSettingsDocument: mocks.getTenantSettingsDocument,
    getClient: mocks.getClient,
    getWebOriginRegistry: mocks.getWebOriginRegistry,
    resolveTenantFromEmailDomain: mocks.resolveTenantFromEmailDomain,
    resolveAccountDataContextByIdentifierFromHono:
      mocks.resolveAccountDataContextByIdentifierFromHono,
    resolveOtpAccountCoreDataContextByIdentifierFromHono:
      mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono,
    markOtpLoginEmailVerified: mocks.markOtpLoginEmailVerified,
    clearAccountRegistrationPending: mocks.clearAccountRegistrationPending,
    ensureDatabaseAdapter: mocks.ensureDatabaseAdapter,
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    ensureAccountAuthenticationState: vi.fn(async (_env, _tenant, _user, loader) => loader()),
    advancePasskeyAuthenticationState: vi.fn(async (_env, input, loader) => {
      const account = await loader();
      if (!account || account.lifecycle !== 'active') {
        throw new Error('account_authentication_not_allowed');
      }
      return mocks.advancePasskeyCounterRpc(
        input.tenantId,
        input.userId,
        `account:${input.userId}`,
        input.credentialId,
        input.storedCounter,
        input.observedCounter,
        input.observedAtMs
      );
    }),
    getSessionRevocationStore: vi.fn(() => ({
      advancePasskeyCounterRpc: mocks.advancePasskeyCounterRpc,
    })),
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: mocks.coreAdapter,
      repositories: {
        userCore: mocks.userCore,
        passkey: mocks.passkey,
      },
    })),
    createAccountAuthContextFromHono: mocks.createAccountAuthContextFromHono.mockImplementation(
      () => ({
        coreAdapter: mocks.coreAdapter,
        repositories: {
          userCore: mocks.userCore,
          passkey: mocks.passkey,
        },
      })
    ),
    createPIIContextFromHono: mocks.createPIIContextFromHono,
    hasPIIDatabase: vi.fn(() => true),
    isShardedSessionId: vi.fn((sessionId: string) => /^\d+_session_/.test(sessionId)),
    getSessionStoreBySessionId: vi.fn(() => ({ stub: mocks.sessionStore })),
    generateUserIdFromSettings: mocks.generateUserIdFromSettings,
    getChallengeStoreByChallengeId: vi.fn(async () => mocks.challengeStore),
    getChallengeStoreByUserId: vi.fn(async () => mocks.challengeStore),
    getRequiredPluginContext: vi.fn(() => ({
      registry: {
        getNotifier: mocks.getNotifier,
      },
    })),
    produceNotificationDelivery: vi.fn(async (_env, input) => {
      const notifier = mocks.getNotifier('email');
      if (!notifier) throw new Error('notification_delivery_provider_order_unavailable');
      const result = await notifier.send(input.payload);
      return {
        reference: { intentId: input.intentId },
        bindingRef: 'TDB_SHARED_CORE',
        delivery: result.success ? 'delivered' : 'permanent_failure',
      };
    }),
    publishEvent: mocks.publishEvent,
    getLogger: vi.fn(() => ({
      module: () => ({
        warn: mocks.warn,
        error: mocks.error,
        info: vi.fn(),
        debug: vi.fn(),
      }),
    })),
  };
});

export { mocks, attemptRecording, registrationCheck };
