import { vi } from 'vitest';
import { IDP_AUTHORIZE, baseProvider } from './start-harness';

const mocks = vi.hoisted(() => ({
  readAccountSession: vi.fn(),
  verifyHuman: vi.fn(),
  challengeKind: vi.fn(),
  reauthPolicy: vi.fn(),
  resolveInteraction: vi.fn(),
  assertInteraction: vi.fn(),
  isMismatch: vi.fn(),
  findByClientId: vi.fn(),
  consumeLite: vi.fn(),
  usageGate: vi.fn(),
  reserveInvitation: vi.fn(),
  consumeLinkIntent: vi.fn(),
  getProvider: vi.fn(),
  storeAuthState: vi.fn(),
  createAuthorizationUrl: vi.fn(),
  discover: vi.fn(),
  fromProvider: vi.fn(),
  isReauthFresh: vi.fn(),
  reauthTtl: vi.fn(),
  coreAdapter: { marker: 'core' },
  profileSso: vi.fn(),
  getAll: vi.fn(),
  registerCategory: vi.fn(),
  createSettingsManager: vi.fn(),
  resolveEffective: vi.fn(),
  isFapi2: vi.fn(),
  loadFapi2Config: vi.fn(),
  validateFapi2: vi.fn(),
  fapiCtor: vi.fn(),
  createRequestObject: vi.fn(),
  push: vi.fn(),
  publishRequestObject: vi.fn(),
  dynamicConfig: vi.fn(),
  diagLog: vi.fn(),
  diagCleanup: vi.fn(),
  createDiag: vi.fn(),
  getEncryptionKey: vi.fn(),
  decrypt: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  getSessionStore: vi.fn(),
  getSessionRpc: vi.fn(),
  getChallengeStore: vi.fn(),
  storeChallengeRpc: vi.fn(),
  consumeAuthState: vi.fn(),
}));
export { mocks };

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  readAccountSession: mocks.readAccountSession,
  readAuthorizationChallengeKind: mocks.challengeKind,
  readExternalProviderReauthPolicy: mocks.reauthPolicy,
  verifyHumanVerificationWithRunner: mocks.verifyHuman,
  resolveSignInAttemptInteraction: mocks.resolveInteraction,
  assertInteractionAnswersChallenge: mocks.assertInteraction,
  isInteractionChallengeMismatchError: mocks.isMismatch,
  isAccountReauthFresh: mocks.isReauthFresh,
  resolveAccountReauthTtlSeconds: mocks.reauthTtl,
  getTenantIdFromContext: () => 'default',
  getUIConfig: vi.fn().mockResolvedValue({ baseUrl: 'https://login.example.com' }),
  createDiagnosticLoggerFromContext: mocks.createDiag,
  getDiagnosticSessionId: () => 'diag-session',
  getSessionStoreBySessionId: mocks.getSessionStore,
  getChallengeStoreByChallengeId: mocks.getChallengeStore,
  isShardedSessionId: (id: string) => id.startsWith('0_'),
  getLogger: () => ({
    module: () => ({
      warn: mocks.warn,
      error: mocks.error,
      info: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  createAuthContextFromHono: vi.fn(() => ({
    repositories: { client: { findByClientId: mocks.findByClientId } },
    coreAdapter: mocks.coreAdapter,
  })),
}));
vi.mock('@authrim/ar-lib-core/utils/settings-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/utils/settings-manager')>()),
  createSettingsManager: mocks.createSettingsManager,
}));
vi.mock('@authrim/ar-lib-core/types/settings/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/types/settings/client')>()),
  CLIENT_CATEGORY_META: { name: 'client-meta' },
}));
vi.mock('@authrim/ar-lib-core/types/settings/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/types/settings/oauth')>()),
  OAUTH_CATEGORY_META: { name: 'oauth-meta' },
}));
vi.mock('@authrim/ar-lib-core/services/effective-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core/services/effective-settings')>()),
  resolveEffectiveSettings: mocks.resolveEffective,
}));
vi.mock('../../services/silent-sso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/silent-sso')>()),
  signInFlowProfileSso: mocks.profileSso,
}));
vi.mock('../../services/lite-start', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/lite-start')>()),
  consumeLiteExternalStart: mocks.consumeLite,
}));
vi.mock('../../services/external-usage-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/external-usage-gate')>()),
  assertExternalProviderUsageAllowed: mocks.usageGate,
}));
vi.mock('../../services/signup-invitation', () => ({
  reserveExternalSignupInvitation: mocks.reserveInvitation,
}));
vi.mock('../../services/link-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/link-intent')>()),
  consumeLinkIntent: mocks.consumeLinkIntent,
}));
vi.mock('../../services/provider-store', () => ({ getProviderByIdOrSlug: mocks.getProvider }));
vi.mock('../../services/dynamic-registration', () => ({
  ensureDynamicClientRegistration: vi.fn(async (input: { provider: unknown }) => ({
    provider: input.provider,
    clientSecret: 'upstream-secret',
  })),
  getDynamicClientRegistrationConfig: mocks.dynamicConfig,
}));
vi.mock('../../services/fapi2-provider', () => ({
  isFapi2Provider: mocks.isFapi2,
  loadFapi2ProviderConfig: mocks.loadFapi2Config,
  validateFapi2ProviderMetadata: mocks.validateFapi2,
}));
vi.mock('../../clients/fapi2-client', () => ({
  Fapi2Client: class {
    constructor(config: unknown) {
      mocks.fapiCtor(config);
    }
    createAuthorizationRequestObject = mocks.createRequestObject;
    pushAuthorizationRequest = mocks.push;
  },
}));
vi.mock('../../handlers/request-object', () => ({
  publishRequestObject: mocks.publishRequestObject,
}));
vi.mock('../../utils/crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/crypto')>()),
  decrypt: mocks.decrypt,
  getEncryptionKeyOrUndefined: mocks.getEncryptionKey,
}));
vi.mock('../../utils/state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/state')>()),
  storeAuthState: mocks.storeAuthState,
  consumeAuthState: mocks.consumeAuthState,
}));
vi.mock('../../utils/pkce', () => ({
  generateState: () => 'fixed-state-value',
  generateNonce: () => 'fixed-nonce-value',
  generatePKCE: async () => ({ codeVerifier: 'ext-verifier', codeChallenge: 'ext-challenge' }),
}));
vi.mock('../../clients/oidc-client', () => ({
  OIDCRPClient: { fromProvider: mocks.fromProvider },
}));

export const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

export function setupStartMocks(): void {
  vi.clearAllMocks();
  mocks.verifyHuman.mockResolvedValue({ verified: true });
  mocks.getProvider.mockResolvedValue(baseProvider);
  mocks.storeAuthState.mockResolvedValue('auth-state-id');
  mocks.createAuthorizationUrl.mockResolvedValue(IDP_AUTHORIZE);
  mocks.discover.mockResolvedValue({});
  mocks.fromProvider.mockReturnValue({
    createAuthorizationUrl: mocks.createAuthorizationUrl,
    discover: mocks.discover,
  });
  mocks.findByClientId.mockResolvedValue(null);
  mocks.challengeKind.mockResolvedValue('login');
  mocks.consumeLite.mockResolvedValue(null);
  mocks.usageGate.mockResolvedValue(undefined);
  mocks.isMismatch.mockReset();
  mocks.isMismatch.mockReturnValue(false);
  mocks.createDiag.mockResolvedValue(null);
  mocks.getEncryptionKey.mockReturnValue('encryption-key');
  mocks.decrypt.mockReset();
  mocks.decrypt.mockResolvedValue('upstream-secret');
  mocks.isFapi2.mockReturnValue(false);
  mocks.validateFapi2.mockReset();
  mocks.dynamicConfig.mockReturnValue(undefined);
  mocks.createSettingsManager.mockReturnValue({
    registerCategory: mocks.registerCategory,
    getAll: mocks.getAll,
  });
  mocks.getAll.mockResolvedValue({ values: {}, sources: {} });
  mocks.profileSso.mockResolvedValue(null);
  mocks.resolveEffective.mockResolvedValue({});
  mocks.diagLog.mockResolvedValue(undefined);
  mocks.diagCleanup.mockResolvedValue(undefined);
  mocks.getSessionStore.mockReturnValue({ stub: { getSessionRpc: mocks.getSessionRpc } });
  mocks.getSessionRpc.mockResolvedValue(null);
  mocks.getChallengeStore.mockResolvedValue({ storeChallengeRpc: mocks.storeChallengeRpc });
  mocks.storeChallengeRpc.mockResolvedValue(undefined);
  mocks.consumeAuthState.mockResolvedValue({ id: 'auth-state-id' });
}
