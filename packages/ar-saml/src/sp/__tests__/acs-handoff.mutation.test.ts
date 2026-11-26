/**
 * SAML ACS session handoff: when the sign-in returns to the Login UI on another origin the
 * session is handed over through a one-time challenge instead of a cookie.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExplicitMappingGraphs } from '@authrim/ar-lib-field-mapping/test-support';

const handoff = vi.hoisted(() => ({
  store: vi.fn(async (..._args: unknown[]) => ({ success: true })),
  storeThrows: false,
}));

const {
  mockSchedule,
  mockLogger,
  mockPublish,
  mockAudit,
  mockUIConfig,
  mockReauthPolicy,
  mockBinding,
} = vi.hoisted(() => ({
  mockSchedule: vi.fn(),
  mockLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockPublish: vi.fn(),
  mockAudit: vi.fn(),
  mockUIConfig: vi.fn(),
  mockReauthPolicy: vi.fn(),
  mockBinding: vi.fn(),
}));

const mockGetIdPConfigByEntityId = vi.fn();
vi.mock('../../admin/providers', () => ({
  getIdPUsageKeyByEntityId: vi.fn().mockResolvedValue(null),
  getIdPConfigByEntityId: async (...args: unknown[]): Promise<unknown> => {
    const config: unknown = await mockGetIdPConfigByEntityId(...args);
    return config
      ? { ...(config as Record<string, unknown>), identityMapping: { fieldMappingSetId: 'set-1' } }
      : config;
  },
}));

// A signed reference may be swapped per test; by default it is the whole document, as signed.
const signed = vi.hoisted(() => ({ override: null as null | ((xml: string) => string) }));
vi.mock('../../common/signature', () => ({
  verifyXmlSignature: vi.fn().mockReturnValue(true),
  verifyXmlSignatureAndGetReferences: vi.fn((xml: string) => [
    { uri: `#${/\bID="([^"]+)"/.exec(xml)?.[1]}`, xml: signed.override?.(xml) ?? xml },
  ]),
  hasSignature: vi.fn((xml: string) => xml.includes('<ds:Signature')),
}));

function mappingBinding() {
  const entry = (id: string, namespace: string, path: string, targetType: string) => ({
    id,
    namespace,
    path,
    valueType: 'string',
    cardinality: 'single',
    classification: 'pii',
    targetType,
  });
  return withExplicitMappingGraphs(
    {
      id: 'activation-1',
      tenantId: 'default',
      fieldMappingSetId: 'set-1',
      fieldMappingVersionId: 'set-1-v1',
      catalog: {
        identity: {
          id: 'catalog-1',
          version: '1',
          contentHash: 'catalog-1',
          compatibilityRange: '^0.3.0',
        },
        entries: [
          entry('field.saml.subject.nameId', 'saml.subject', 'nameId', 'source'),
          entry('field.profile.email', 'authrim.profile', 'email', 'canonical'),
        ],
      },
      edges: [
        {
          id: 'edge.nameId.email',
          sourceRef: { side: 'source', namespace: 'saml.subject', path: 'nameId' },
          targetRef: { side: 'destination', namespace: 'authrim.profile', path: 'email' },
          edgeKind: 'direct',
        },
      ],
      transforms: [],
      validationRules: [],
      fieldMappingSet: { id: 'set-1-v1', rules: [] },
    },
    true
  );
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => ({ module: () => mockLogger }),
    createLogger: () => ({ module: () => mockLogger }),
    getChallengeStoreByChallengeId: vi.fn(async () => {
      if (handoff.storeThrows) throw new Error('challenge store down');
      return { storeChallengeRpc: handoff.store };
    }),
    publishEvent: mockPublish,
    createAuditLog: mockAudit,
    getUIConfig: mockUIConfig,
    scheduleSignInAttemptFailureRecord: mockSchedule,
    readExternalProviderReauthPolicy: mockReauthPolicy,
    readExternalProviderUsagePolicy: vi.fn().mockResolvedValue({
      loginEnabled: true,
      signupEnabled: true,
    }),
    resolveTenantUserStoreSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
      coreDb: env.TDB_TEST_CORE,
      piiDb: env.TDB_TEST_PII,
    })),
    resolveUserStoreRuntimeSourcesFromEnv: vi.fn(async (env: Record<string, unknown>) => ({
      coreDb: env.TDB_TEST_CORE,
      piiDb: env.TDB_TEST_PII,
    })),
    resolveAccountDataContextByIdentifier: vi.fn(async () => {
      const adapter = (linkedIdentity: boolean) => ({
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn(async (sql: string) =>
          linkedIdentity && sql.includes('FROM linked_identities')
            ? { id: 'li-1', user_id: 'user-001', provider_user_id: 'saml-user@example.com' }
            : null
        ),
        execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        transaction: vi.fn(),
        batch: vi.fn().mockResolvedValue([]),
        isHealthy: vi.fn().mockResolvedValue(true),
        getType: vi.fn().mockReturnValue('mock'),
        close: vi.fn().mockResolvedValue(undefined),
      });
      return { coreDb: adapter(false), piiDb: adapter(true) };
    }),
    CanonicalRuntimeUserStore: class {
      async findById() {
        return {
          id: 'user-001',
          email: 'user@example.com',
          email_verified: 1,
          active: true,
          lifecycle_state: 'active',
        };
      }
      async findByEmail() {
        return null;
      }
    },
    resolveRuntimeIdentityMappingBinding: mockBinding,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({})),
    resolveSignInFlowProfileRefs: vi.fn(),
    readAuthenticationProfile: vi.fn(),
  };
});

import {
  callACS,
  buildEnv,
  NOW,
  REQUEST_ID,
  type AcsEnv,
  type AcsEnvState,
} from './helpers/acs-harness';

const state: AcsEnvState = {
  relayState: 'https://ui.example.com/dashboard',
  assertionConsumeStatus: 200,
  assertionConsumeThrows: false,
};
let env: AcsEnv;
const pending: Promise<unknown>[] = [];

async function run(options: { url?: string; envExtra?: Record<string, unknown> } = {}) {
  Object.assign(env, options.envExtra ?? {});
  const response = await callACS(env, pending, {
    url: options.url ?? 'https://auth.example.com/saml/sp/acs',
  });
  await Promise.allSettled(pending.splice(0));
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  handoff.storeThrows = false;
  state.relayState = 'https://ui.example.com/dashboard';
  state.context = undefined;
  state.assertionConsumeStatus = 200;
  mockPublish.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
  mockUIConfig.mockResolvedValue(null);
  mockReauthPolicy.mockResolvedValue({ reauthEnabled: false, acceptWithoutAuthTime: false });
  mockBinding.mockResolvedValue(mappingBinding());
  mockGetIdPConfigByEntityId.mockResolvedValue({
    entityId: 'https://idp.example.com',
    ssoUrl: 'https://idp.example.com/sso',
    certificate: 'mock-certificate',
    attributeMapping: { email: 'email' },
  });
  env = buildEnv(state);
});

afterEach(() => {
  vi.useRealTimers();
  signed.override = null;
});

describe('handing the session to the Login UI', () => {
  it('stores a one-time challenge and redirects to the UI callback instead of setting a cookie', async () => {
    const response = await run({ envExtra: { LOGIN_UI_CLIENT_ID: '  login-ui  ' } });

    expect(response.status).toBe(302);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(REQUEST_ID);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).not.toContain('authrim_session=');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe('https://ui.example.com/callback');
    const token = location.searchParams.get('handoff_token') ?? '';
    const stateParam = location.searchParams.get('state') ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(stateParam).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(stateParam);
    expect(location.searchParams.get('return_url')).toBe('https://ui.example.com/dashboard');
    const stored = handoff.store.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(stored).toMatchObject({
      id: `handoff:${token}`,
      tenantId: 'tenant-a',
      type: 'handoff',
      userId: 'user-001',
      metadata: {
        state: stateParam,
        source: 'saml_sp',
        return_url: 'https://ui.example.com/dashboard',
        origin: 'https://ui.example.com',
        created_at: NOW,
        client_id: 'login-ui',
      },
    });
    expect(typeof stored.challenge).toBe('string');
    expect(stored.ttl).toBe(60);
    expect((stored.metadata as Record<string, unknown>).aud).toBe('saml_sp_cookie_handoff');
  });

  it('reads the client id from PUBLIC_LOGIN_UI_CLIENT_ID and records no usage key for an IdP without a record', async () => {
    const response = await run({ envExtra: { PUBLIC_LOGIN_UI_CLIENT_ID: 'public-ui' } });

    expect(response.status).toBe(302);
    const metadata = (handoff.store.mock.calls[0]?.[0] as { metadata: Record<string, unknown> })
      .metadata;
    expect(metadata.client_id).toBe('public-ui');
    expect(metadata).not.toHaveProperty('external_provider_usage_key');
    expect(metadata).not.toHaveProperty('external_provider_usage');
  });

  it('omits the client id when the environment names none, and prefers LOGIN_UI_CLIENT_ID', async () => {
    await run();
    const bare = (handoff.store.mock.calls[0]?.[0] as { metadata: Record<string, unknown> })
      .metadata;
    expect(bare).not.toHaveProperty('client_id');

    handoff.store.mockClear();
    await run({ envExtra: { LOGIN_UI_CLIENT_ID: '   ', PUBLIC_LOGIN_UI_CLIENT_ID: ' fallback ' } });
    const fallback = (handoff.store.mock.calls[0]?.[0] as { metadata: Record<string, unknown> })
      .metadata;
    expect(fallback.client_id).toBe('fallback');
  });

  it('falls back to the session cookie when the challenge store is unavailable', async () => {
    handoff.storeThrows = true;

    const response = await run();

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://ui.example.com/dashboard');
    expect(response.headers.getSetCookie()[0]).toMatch(/^authrim_session=/);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'CHALLENGE_STORE is unavailable for session handoff',
      {},
      expect.any(Error)
    );
  });

  it.each([
    [
      'the request already came from the UI origin',
      'https://ui.example.com/saml/sp/acs',
      'https://ui.example.com/dashboard',
    ],
    [
      'the return URL is on the request origin',
      'https://auth.example.com/saml/sp/acs',
      'https://auth.example.com/home',
    ],
  ])('keeps the cookie flow when %s', async (_label, url, returnUrl) => {
    state.relayState = returnUrl;

    const response = await run({ url });

    expect(response.headers.get('location')).toBe(returnUrl);
    expect(response.headers.getSetCookie()[0]).toMatch(/^authrim_session=/);
    expect(handoff.store).not.toHaveBeenCalled();
  });

  it('keeps the cookie flow without a configured UI origin or with an unparsable request URL', async () => {
    delete (env as Record<string, unknown>).UI_URL;
    const noUi = await run();
    expect(noUi.headers.getSetCookie()[0]).toMatch(/^authrim_session=/);

    env = buildEnv(state);
    const badUrl = await run({ url: 'not a url' });
    expect(badUrl.headers.getSetCookie()[0]).toMatch(/^authrim_session=/);
    expect(handoff.store).not.toHaveBeenCalled();
  });
});
