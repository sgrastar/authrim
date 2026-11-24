import { vi, afterEach } from 'vitest';
import { authState, oauthProvider } from './callback-harness';

const M = vi.hoisted(() => ({
  consumeAuthState: vi.fn(),
  getProvider: vi.fn(),
  handleIdentity: vi.fn(),
  exchangeCode: vi.fn(),
  fetchUserInfo: vi.fn(),
  validateIdToken: vi.fn(),
  fromProvider: vi.fn(),
  store: { storeChallengeRpc: vi.fn() },
  getStore: vi.fn(),
  createSession: vi.fn(),
  getSessionStore: vi.fn(),
  registerProviderSession: vi.fn(),
  findById: vi.fn(),
  resolveAccount: vi.fn(),
  publishEvent: vi.fn(),
  sessionProfile: vi.fn(),
  usageGate: vi.fn(),
  inbound: vi.fn(),
  requirement: vi.fn(),
  apply: vi.fn(),
  release: vi.fn(),
  loadPolicy: vi.fn(),
  liteMode: vi.fn(),
  readAccountSession: vi.fn(),
  createDiag: vi.fn(),
  scheduleFailure: vi.fn(),
  errorLog: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  getKey: vi.fn(),
  coreAdapter: { id: 'account-core' },
  piiAdapter: { id: 'pii' },
  runtimeStoreArgs: vi.fn(),
  reauthPolicy: vi.fn(),
  safeFetchJson: vi.fn(),
  isFapi2: vi.fn(),
  loadFapi2Config: vi.fn(),
  validateFapi2: vi.fn(),
  fapiCtor: vi.fn(),
  validateJarm: vi.fn(),
  fapiExchange: vi.fn(),
  fapiResource: vi.fn(),
  discover: vi.fn(),
  appleSecret: vi.fn(),
  recordActivity: vi.fn(),
  logTokenValidation: vi.fn(),
  logAuthDecision: vi.fn(),
  diagCleanup: vi.fn(),
}));

export { M };

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getChallengeStoreByChallengeId: M.getStore,
  getSessionStoreForNewSession: M.getSessionStore,
  registerExternalProviderSession: M.registerProviderSession,
  createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: M.coreAdapter })),
  createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: M.piiAdapter })),
  CanonicalRuntimeUserStore: class {
    constructor(args: unknown) {
      M.runtimeStoreArgs(args);
    }
    findById = M.findById;
  },
  getTenantIdFromContext: vi.fn(() => 'default'),
  resolveAccountDataContextByIdentifier: M.resolveAccount,
  getUIConfig: vi.fn().mockResolvedValue({ baseUrl: 'https://login.example.com' }),
  createDiagnosticLoggerFromContext: M.createDiag,
  publishEvent: M.publishEvent,
  readLiteModeAuthoritative: M.liteMode,
  readAccountSession: M.readAccountSession,
  readExternalProviderReauthPolicy: M.reauthPolicy,
  safeFetchJson: M.safeFetchJson,
  scheduleSignInAttemptFailureRecord: M.scheduleFailure,
  getLogger: () => ({
    module: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: M.errorLog }),
  }),
}));
vi.mock('../../services/external-email-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/external-email-check')>()),
  externalSessionProfile: M.sessionProfile,
  loadExternalSignUpPolicy: M.loadPolicy,
}));
vi.mock('../../services/external-usage-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/external-usage-gate')>()),
  assertExternalProviderUsageAllowed: M.usageGate,
}));
vi.mock('../../services/inbound-mapping', () => ({ mapOIDCInboundUserInfo: M.inbound }));
vi.mock('../../services/signup-invitation', () => ({
  externalSignupInvitationRequirement: M.requirement,
  applyExternalSignupInvitation: M.apply,
  releaseExternalSignupInvitation: M.release,
}));
vi.mock('../../services/identity-stitching', () => ({
  handleIdentity: M.handleIdentity,
  completeExternalIdpJIT: vi.fn(),
}));
vi.mock('../../services/provider-store', () => ({ getProviderByIdOrSlug: M.getProvider }));
vi.mock('../../utils/crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crypto')>()),
  decrypt: M.decrypt,
  encrypt: M.encrypt,
  getEncryptionKeyOrUndefined: M.getKey,
}));
vi.mock('../../utils/state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/state')>()),
  consumeAuthState: M.consumeAuthState,
}));
vi.mock('../../services/fapi2-provider', () => ({
  isFapi2Provider: M.isFapi2,
  loadFapi2ProviderConfig: M.loadFapi2Config,
  validateFapi2ProviderMetadata: M.validateFapi2,
}));
vi.mock('../../clients/fapi2-client', () => ({
  Fapi2Client: class {
    constructor(config: unknown) {
      M.fapiCtor(config);
    }
    validateJarmResponse = M.validateJarm;
    exchangeCode = M.fapiExchange;
    fetchResource = M.fapiResource;
  },
}));
vi.mock('../../utils/apple-jwt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/apple-jwt')>()),
  generateAppleClientSecret: M.appleSecret,
}));
vi.mock('../../services/link-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/link-intent')>()),
  recordSocialAccountActivity: M.recordActivity,
}));
vi.mock('../../clients/oidc-client', () => ({ OIDCRPClient: { fromProvider: M.fromProvider } }));

export const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

export const TOKENS = { access_token: 'upstream-access', token_type: 'Bearer', expires_in: 3600 };
export const REQUEST_CONTEXT = {
  tokenEndpoint: 'https://idp.example.com/token',
  authMethod: 'client_secret_basic',
  authHeaderPresent: true,
};
export const ready = (overrides: Record<string, unknown> = {}) => ({
  status: 'ready',
  userId: 'user-1',
  isNewUser: false,
  linkedIdentityId: 'li-1',
  stitchedFromExisting: false,
  ...overrides,
});

afterEach(() => vi.useRealTimers());

export function setupCallbackMocks(): void {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  M.getProvider.mockResolvedValue(oauthProvider);
  M.consumeAuthState.mockResolvedValue(authState());
  M.fromProvider.mockReturnValue({
    exchangeCode: M.exchangeCode,
    fetchUserInfoWithMeta: M.fetchUserInfo,
    validateIdToken: M.validateIdToken,
    discover: M.discover,
  });
  M.exchangeCode.mockResolvedValue({ tokens: TOKENS, requestContext: REQUEST_CONTEXT });
  M.fetchUserInfo.mockResolvedValue({
    userInfo: { sub: 'ext-sub', email: 'new@example.com', name: 'New Person' },
    endpoint: 'https://idp.example.com/userinfo',
    signedResponse: false,
  });
  M.handleIdentity.mockResolvedValue(ready());
  M.createDiag.mockResolvedValue(null);
  M.getKey.mockReturnValue('encryption-key');
  M.decrypt.mockResolvedValue('upstream-secret');
  M.encrypt.mockResolvedValue('encrypted-id-token');
  M.inbound.mockResolvedValue(null);
  M.usageGate.mockResolvedValue(undefined);
  M.liteMode.mockResolvedValue('off');
  M.getStore.mockResolvedValue(M.store);
  M.store.storeChallengeRpc.mockResolvedValue(undefined);
  M.getSessionStore.mockResolvedValue({
    sessionId: 'session-a',
    stub: { createSessionRpc: M.createSession },
  });
  M.createSession.mockResolvedValue(undefined);
  M.registerProviderSession.mockResolvedValue(undefined);
  M.findById.mockResolvedValue({ id: 'user-1' });
  M.resolveAccount.mockResolvedValue({ accountId: 'account:user-1' });
  M.publishEvent.mockResolvedValue(undefined);
  M.sessionProfile.mockResolvedValue({
    allowed: true,
    interactionId: undefined,
    profiled: { ttl: { seconds: 1800 }, snapshot: { snap: 'shot' } },
  });
  M.requirement.mockResolvedValue(null);
  M.isFapi2.mockReturnValue(false);
  M.validateFapi2.mockReset();
  M.safeFetchJson.mockReset();
  M.appleSecret.mockResolvedValue('apple-client-secret');
  M.recordActivity.mockResolvedValue(undefined);
  M.logTokenValidation.mockResolvedValue(undefined);
  M.logAuthDecision.mockResolvedValue(undefined);
  M.diagCleanup.mockResolvedValue(undefined);
}
