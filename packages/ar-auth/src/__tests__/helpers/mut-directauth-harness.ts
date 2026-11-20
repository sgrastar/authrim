/**
 * Contexts, settings and the default mock behaviour for the mut-directauth-* tests (see
 * mut-directauth-mocks.ts, which this module loads first so its module mocks are registered).
 */
import { vi } from 'vitest';
import { attemptRecording, mocks, registrationCheck } from './mut-directauth-mocks';

export { mocks, attemptRecording, registrationCheck };

export async function s256Challenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function createEnv() {
  return {
    ISSUER_URL: 'https://issuer.example.com',
    OTP_HMAC_SECRET: 'otp-test-secret',
    ALLOWED_ORIGINS: 'https://app.example.com',
    AUTHRIM_CONFIG: {
      get: vi.fn().mockResolvedValue(null),
    },
    SETTINGS: undefined as KVNamespace | undefined,
    RATE_LIMITER: {
      idFromName: vi.fn(() => 'rate-limit-id'),
      get: vi.fn(() => mocks.rateLimiter),
    },
    AUTH_CODE_STORE: {
      idFromName: vi.fn(() => 'auth-code-id'),
      get: vi.fn(() => mocks.authCodeStore),
    },
  };
}

export function createMockKV(data: Record<string, string> = {}) {
  return {
    get: vi.fn(async (key: string) => data[key] ?? null),
    put: vi.fn(),
    delete: vi.fn(),
  };
}

export function createContext(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  url = 'https://app.example.com/api/v1/auth/direct'
) {
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    req: {
      url,
      json: vi.fn(async () => body),
      header: vi.fn((name: string) => lowerHeaders[name.toLowerCase()]),
    },
    env: createEnv(),
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant_test' : undefined)),
    executionCtx: {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    },
    json: (payload: unknown, status = 200, responseHeaders: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json', ...responseHeaders },
      }),
  };
}

export function createEmailOtpEnabledSettings(
  extraRecords: Record<string, string> = {},
  overrides: Record<string, boolean | string> = {}
) {
  return createMockKV({
    'settings:tenant:tenant_test:authentication-methods': JSON.stringify({
      'authentication-methods.email_otp.login_enabled': true,
      'authentication-methods.email_otp.signup_enabled': true,
      'authentication-methods.email_otp.reauth_enabled': true,
      'authentication-methods.email_otp.account_link_enabled': true,
      ...overrides,
    }),
    ...extraRecords,
  });
}

export function enableEmailOtp(
  context: ReturnType<typeof createContext>,
  extraRecords: Record<string, string> = {},
  overrides: Record<string, boolean | string> = {}
) {
  context.env.SETTINGS = createEmailOtpEnabledSettings(extraRecords, overrides) as never;
  return context;
}

/**
 * The resume record of a provisioned send, stored for whatever send asks (read first, used up
 * once the send passed its checks).
 */
export function storeSendResumeRecords(usage = 'signup') {
  const other = mocks.challengeStore.getChallengeRpc.getMockImplementation();
  mocks.challengeStore.getChallengeRpc.mockImplementation(async (id: string) =>
    typeof id === 'string' && id.startsWith('direct_email_send_resume:')
      ? {
          id,
          tenantId: 'tenant_test',
          type: 'direct_email_send_resume',
          challenge: id.slice('direct_email_send_resume:'.length),
          consumed: false,
          metadata: { usage },
        }
      : other
        ? ((await other(id)) as unknown)
        : null
  );
  mocks.challengeStore.consumeChallengeRpc.mockImplementation(async (request: { type?: string }) =>
    request?.type === 'direct_email_send_resume' ? { metadata: { usage } } : undefined
  );
}

/** Challenge consumptions apart from looking up a resumed email-code send. */
export function consumesOtherThanSendResume() {
  return mocks.challengeStore.consumeChallengeRpc.mock.calls.filter(
    ([request]) => (request as { type?: string })?.type !== 'direct_email_send_resume'
  );
}

export function webHeaders() {
  return {
    origin: 'https://app.example.com',
    host: 'app.example.com',
  };
}

export function tenantProxyHeaders() {
  return {
    origin: 'https://first.test.authrim.com',
    host: 'test.authrim.com',
    'x-authrim-browser-origin': 'https://login.test.authrim.com',
    'x-authrim-forwarded-host': 'first.test.authrim.com',
    'x-authrim-ui-proxy': 'login-ui',
  };
}

/** The default behaviour of every mock (the beforeEach of direct-auth-flows.test.ts). */
export function resetDirectAuthMocks() {
  mocks.getCookie.mockReset();
  mocks.checkSignUpScreen.mockReset();
  mocks.checkSignUpScreen.mockResolvedValue({ ok: true });
  vi.clearAllMocks();
  mocks.getTenantSettingsDocument.mockResolvedValue(null);
  mocks.getDefaultTenantId.mockReturnValue('default');
  mocks.resolveTenantFromEmailDomain.mockResolvedValue(null);
  mocks.getClient.mockResolvedValue({
    client_id: 'web-client',
    application_type: 'web',
    allowed_redirect_origins: ['https://app.example.com'],
  });
  mocks.getWebOriginRegistry.mockResolvedValue({
    origins: [{ origin: 'https://app.example.com', handoff_allowed: true }],
  });
  mocks.generateUserIdFromSettings.mockResolvedValue('user_new');
  mocks.publishEvent.mockResolvedValue(undefined);
  mocks.authCodeStore.storeCodeRpc.mockResolvedValue(undefined);
  mocks.challengeStore.storeChallengeRpc.mockResolvedValue(undefined);
  mocks.challengeStore.deleteChallengeRpc.mockResolvedValue(undefined);
  mocks.challengeStore.getChallengeRpc.mockReset();
  mocks.challengeStore.consumeChallengeRpc.mockReset();
  // As the store does, an unknown record cannot be consumed (a send not resumed after provisioning).
  mocks.challengeStore.consumeChallengeRpc.mockImplementation(
    async (request: { type?: string }) => {
      if (request?.type === 'direct_email_send_resume') throw new Error('Challenge not found');
      return undefined;
    }
  );
  mocks.rateLimiter.incrementRpc.mockResolvedValue({ allowed: true });
  mocks.sessionStore.getSessionRpc.mockResolvedValue({
    id: '0_session_existing',
    userId: 'user_existing',
    createdAt: Date.now() - 120_000,
    expiresAt: Date.now() + 60_000,
    data: { amr: ['passkey'] },
  });
  mocks.coreAdapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  mocks.coreAdapter.queryOne.mockResolvedValue({
    state: 'active',
    current_step_id: 'auth:step',
    contract_hash: 'contract_hash',
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
  mocks.userCore.findById.mockResolvedValue({
    id: 'user_existing',
    is_active: true,
    created_at: Date.now() - 120_000,
  });
  mocks.userCore.createUser.mockResolvedValue(undefined);
  mocks.userCore.updatePIIStatus.mockResolvedValue(undefined);
  mocks.userCore.updateLastLogin.mockResolvedValue(undefined);
  mocks.passkey.findByUserId.mockResolvedValue([]);
  mocks.passkey.findByCredentialId.mockResolvedValue({
    id: 'passkey_1',
    user_id: 'user_existing',
    credential_id: 'credential-id',
    public_key: 'AQIDBA==',
    counter: 4,
  });
  mocks.passkey.updateCounterAfterAuth.mockResolvedValue(undefined);
  mocks.passkey.mirrorCounterAfterAuth.mockResolvedValue(true);
  mocks.advancePasskeyCounterRpc.mockResolvedValue({ counter: 5, advanced: true });
  mocks.passkey.create.mockResolvedValue(undefined);
  mocks.emailNotifier.send.mockResolvedValue({ success: true, messageId: 'message_1' });
  mocks.getNotifier.mockReturnValue(mocks.emailNotifier);
  mocks.userPII.findByTenantAndEmail.mockResolvedValue(null);
  mocks.userPII.findById.mockResolvedValue({
    id: 'user_existing',
    email: 'user@example.com',
    name: 'Example User',
  });
  mocks.userPII.createPII.mockResolvedValue(undefined);
  mocks.generateAuthenticationOptions.mockResolvedValue({
    challenge: 'passkey-login-challenge',
    timeout: 60_000,
    rpId: 'app.example.com',
    allowCredentials: [],
    userVerification: 'required',
    extensions: undefined,
  });
  mocks.verifyAuthenticationResponse.mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 5 },
  });
  mocks.generateRegistrationOptions.mockResolvedValue({
    rp: { id: 'app.example.com', name: 'Authrim' },
    user: { id: 'user_new', name: 'new@example.com', displayName: 'New User' },
    challenge: 'passkey-signup-challenge',
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    timeout: 60_000,
    excludeCredentials: [],
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    attestation: 'none',
    extensions: undefined,
  });
  mocks.verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credentialID: new Uint8Array([9, 8, 7]),
      credentialPublicKey: new Uint8Array([6, 5, 4, 3]),
      counter: 0,
      aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
    },
  });
  mocks.generateEmailCode.mockReturnValue('123456');
  mocks.hashEmailCode.mockResolvedValue('hashed-email-code');
  mocks.verifyEmailCodeHash.mockResolvedValue(true);
  mocks.hashEmail.mockResolvedValue('hashed-email');
  mocks.validateRegistrationFieldSubmissionFromEnv.mockResolvedValue({
    ok: true,
    values: {},
  });
  mocks.persistRegistrationFieldValuesFromEnv.mockResolvedValue(undefined);
  mocks.verifyEmailVerificationProtocol.mockResolvedValue({
    verified: false,
    reason: 'verification_failed',
  });
  mocks.resolveAccountDataContextByIdentifierFromHono.mockResolvedValue({});
  mocks.resolveAccountDataContextFromHono.mockResolvedValue({});
  mocks.resolveOtpAccountCoreDataContextByIdentifierFromHono.mockResolvedValue({
    tenantId: 'tenant_test',
    accountId: 'account:user_existing',
    legacyUserId: 'user_existing',
    storageProfileId: 'builtin:storage:tenant-d1',
    coreDb: { adapter: 'tenant-core' },
    coreBindingRef: 'TDB_USERS',
    coreResidencyPartition: 'default',
    accountRouteGeneration: 1,
    membership: {},
    user: {
      id: 'user_existing',
      email: 'user@example.com',
      name: 'Example User',
      active: 1,
      email_verified: 0,
      account_type: 'end_user',
      created_at: new Date(Date.now() - 120_000).toISOString(),
    },
  });
  mocks.markOtpLoginEmailVerified.mockResolvedValue(true);
  mocks.provisionTenantD1EmailAccount.mockResolvedValue({
    status: 'ready',
    accountId: 'account:user_new',
    userId: 'user_new',
  });
  mocks.findActiveInvitationByToken.mockReset();
  mocks.findActiveInvitationByToken.mockResolvedValue(null);
  mocks.readLiteMode.mockReset();
  mocks.readLiteMode.mockResolvedValue('off');
  mocks.verifyHumanVerificationForAction.mockImplementation(
    async (
      c: { env: { SETTINGS?: { get: (key: string) => Promise<string | null> } } },
      action: string,
      responseToken: unknown,
      alsoRequiredFor: string[] = []
    ) => {
      const raw = await c.env.SETTINGS?.get('settings:tenant:tenant_test:authentication-methods');
      const settings = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const enabled =
        settings['authentication-methods.human_verification.provider'] &&
        [action, ...alsoRequiredFor].some(
          (required) =>
            settings[`authentication-methods.human_verification.${required}_enabled`] === true
        );
      if (!enabled || responseToken) return null;
      return new Response(JSON.stringify({ error: 'human_verification_required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  );
}
