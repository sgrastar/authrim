/**
 * SAML ACS after validation: AuthnContext policy, the session it creates, the return URL it
 * trusts and the proof of a re-authentication.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExplicitMappingGraphs } from '@authrim/ar-lib-field-mapping/test-support';

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
  samlResponseXml,
  IDP_ENTITY,
  NOW,
  REQUEST_ID,
  SKEW_MS,
  type AcsEnv,
  type AcsEnvState,
} from './helpers/acs-harness';
import { provenSPReauthentication } from '../acs';

const state: AcsEnvState = {
  relayState: 'https://ui.example.com/',
  assertionConsumeStatus: 200,
  assertionConsumeThrows: false,
};
let env: AcsEnv;
const pending: Promise<unknown>[] = [];

function idp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: IDP_ENTITY,
    ssoUrl: 'https://idp.example.com/sso',
    certificate: 'mock-certificate',
    attributeMapping: { email: 'email' },
    ...overrides,
  };
}

async function run(
  options: { classRef?: string | null; relayForm?: string; headers?: Record<string, string> } = {}
) {
  const response = await callACS(env, pending, {
    xml: samlResponseXml(
      options.classRef === undefined ? {} : { authnContextClassRef: options.classRef }
    ),
    relayState: options.relayForm,
    headers: options.headers,
  });
  await Promise.allSettled(pending.splice(0));
  return response;
}

function sessionBody(): { ttl: unknown; data: object } {
  const call = state.sessionFetch?.mock.calls.find(
    (entry: unknown[]) => entry[0] === 'https://session-store/session'
  );
  return JSON.parse(String((call?.[1] as { body: string }).body)) as {
    ttl: unknown;
    data: object;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.relayState = 'https://ui.example.com/';
  state.context = undefined;
  state.assertionConsumeStatus = 200;
  state.assertionConsumeThrows = false;
  mockPublish.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
  mockUIConfig.mockResolvedValue(null);
  mockReauthPolicy.mockResolvedValue({ reauthEnabled: false, acceptWithoutAuthTime: false });
  mockBinding.mockResolvedValue(mappingBinding());
  mockGetIdPConfigByEntityId.mockResolvedValue(idp());
  env = buildEnv(state);
});

afterEach(() => {
  vi.useRealTimers();
  signed.override = null;
});

describe('AuthnContext policy', () => {
  const policy = (mode: string, allowedClassRefs?: string[]) =>
    mockGetIdPConfigByEntityId.mockResolvedValue(
      idp({ authnContextPolicy: { mode, ...(allowedClassRefs ? { allowedClassRefs } : {}) } })
    );
  const PASSWORD = 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password';

  it('refuses a class reference outside a require_any list and records assurance_not_met', async () => {
    policy('require_any', ['urn:example:mfa']);

    const response = await run();

    expect(response.status).toBe(400);
    expect(mockLogger.warn).toHaveBeenCalledWith('AuthnContext policy rejected SAML assertion', {
      issuer: IDP_ENTITY,
      authnContextClassRef: PASSWORD,
    });
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'assurance_not_met' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('refuses an assertion without a class reference when one is required, naming it missing', async () => {
    policy('require_any', [PASSWORD]);

    const response = await run({ classRef: null });

    expect(response.status).toBe(400);
    expect(mockLogger.warn).toHaveBeenCalledWith('AuthnContext policy rejected SAML assertion', {
      issuer: IDP_ENTITY,
      authnContextClassRef: 'missing',
    });
  });

  it.each([
    ['a listed class reference', ['urn:example:mfa', PASSWORD]],
    ['a listed class reference with surrounding spaces and blanks', ['  ', `  ${PASSWORD}  `]],
  ])('accepts %s', async (_label, allowed) => {
    policy('require_any', allowed);

    expect((await run()).status).toBe(302);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      'AuthnContext policy rejected SAML assertion',
      expect.anything()
    );
  });

  it.each([
    ['an empty allowlist', []],
    ['a whitespace-only allowlist', ['  ', '\t']],
  ])('fails closed under require_any with %s', async (_label, allowed) => {
    policy('require_any', allowed);

    const response = await run();

    expect(response.status).toBe(400);
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'assurance_not_met' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('fails closed under require_any with no allowlist property at all', async () => {
    policy('require_any');

    expect((await run()).status).toBe(400);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it.each(['require_all', 'REQUIRE_ANY', '', 'enforce'])(
    'fails closed for the unknown mode %j even with a matching allowlist',
    async (mode) => {
      policy(mode, [PASSWORD]);

      const response = await run();

      expect(response.status).toBe(400);
      expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'assurance_not_met' });
      expect(mockPublish).not.toHaveBeenCalled();
    }
  );

  const rawPolicy = (value: unknown) =>
    mockGetIdPConfigByEntityId.mockResolvedValue(idp({ authnContextPolicy: value as never }));

  it.each([
    ['a string policy', 'require_any'],
    ['an array policy', ['require_any']],
    ['a policy with a missing mode', {}],
    ['a policy with a non-string mode', { mode: 7 }],
    ['non-array allowedClassRefs', { mode: 'require_any', allowedClassRefs: PASSWORD }],
    ['non-string allowedClassRefs items', { mode: 'require_any', allowedClassRefs: [PASSWORD, 7] }],
    ['object allowedClassRefs', { mode: 'require_any', allowedClassRefs: { 0: PASSWORD } }],
  ])('fails closed with assurance_not_met for %s', async (_label, value) => {
    rawPolicy(value);

    const response = await run();

    expect(response.status).toBe(400);
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'assurance_not_met' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('treats a null policy like no policy', async () => {
    rawPolicy(null);

    expect((await run()).status).toBe(302);
  });

  it('does not refuse in observe mode', async () => {
    policy('observe', ['urn:example:mfa']);

    expect((await run()).status).toBe(302);
  });

  it('does not refuse when no policy is configured, and forwards no policy-less class', async () => {
    expect((await run({ classRef: null })).status).toBe(302);
  });
});

describe('the session it creates', () => {
  it('creates the session with the SAML method, the upstream class reference and the tenant ttl', async () => {
    await run();

    const call = state.sessionFetch?.mock.calls.find(
      (entry: unknown[]) => entry[0] === 'https://session-store/session'
    );
    expect(call?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const body = sessionBody();
    expect(body).toMatchObject({
      userId: 'user-001',
      tenantId: 'tenant-a',
      data: {
        amr: ['saml'],
        acr: 'urn:mace:incommon:iap:bronze',
        upstream_acr: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password',
      },
    });
    expect(typeof body.ttl).toBe('number');
    expect(body.data).not.toHaveProperty('reauth_proven_at');
  });

  it('keeps no upstream class reference when the IdP sent none', async () => {
    await run({ classRef: null });

    expect(sessionBody().data).not.toHaveProperty('upstream_acr');
  });

  it('answers with a failure when the session store refuses', async () => {
    state.sessionFetch?.mockResolvedValue(new Response('no', { status: 500 }));

    const response = await run();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'ACS Error',
      {},
      expect.objectContaining({ message: 'Session creation failed' })
    );
  });

  it('records a proven re-authentication time and its method on the session', async () => {
    const requestedAt = NOW - 30_000;
    state.context = {
      spReauthentication: {
        authorizationChallengeId: 'reauth_1',
        requestedAt,
        providerId: 'idp-1',
        providerIds: ['saml:idp-1', 'idp-1'],
      },
    };
    mockReauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: false });

    const response = await run();

    expect(response.status).toBe(302);
    expect(sessionBody().data).toMatchObject({
      reauth_proven_amr: ['saml'],
      reauth_proven_at: requestedAt,
    });
  });

  it('sets the session cookie and clears the request binding cookie', async () => {
    const response = await run();

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toMatch(
      /^authrim_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/
    );
    expect(cookies[1]).toContain(`${REQUEST_ID}=`);
    expect(cookies[1]).toContain('Max-Age=0');
  });
});

describe('return URL', () => {
  beforeEach(() => {
    state.relayState = '';
  });

  it.each([
    ['the UI origin', 'https://ui.example.com/home?x=1', 'https://ui.example.com/home?x=1'],
    ['the issuer origin', 'https://auth.example.com/account', 'https://auth.example.com/account'],
  ])('follows a RelayState on %s', async (_label, relay, expected) => {
    const response = await run({ relayForm: relay });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(expected);
  });

  it.each([
    ['a foreign origin', 'https://evil.example.com/'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a non-HTTP scheme', 'ftp://ui.example.com/'],
    ['the UI host over plain http', 'http://ui.example.com/'],
    ['a relative path', '/account'],
    ['an empty value', ''],
  ])('ignores a RelayState with %s and returns to the issuer home', async (_label, relay) => {
    const response = await run({ relayForm: relay });

    expect(response.headers.get('location')).toBe('https://auth.example.com/');
  });

  it('prefers the return URL kept with the sign-in request over the posted RelayState', async () => {
    state.relayState = 'https://ui.example.com/kept';

    const response = await run({ relayForm: 'https://auth.example.com/posted' });

    expect(response.headers.get('location')).toBe('https://ui.example.com/kept');
  });
});

describe('provenSPReauthentication', () => {
  const requestedAt = NOW;
  const reauth = (overrides: Record<string, unknown> = {}) => ({
    authorizationChallengeId: 'c',
    requestedAt,
    providerId: 'idp-1',
    providerIds: ['saml:idp-1', 'idp-1'],
    ...overrides,
  });
  const prove = (
    reauthentication: Parameters<typeof provenSPReauthentication>[2],
    instant?: string
  ) => provenSPReauthentication({} as never, 'tenant-a', reauthentication, instant);

  beforeEach(() => {
    mockReauthPolicy.mockResolvedValue({ reauthEnabled: true, acceptWithoutAuthTime: false });
  });

  it('returns the time Authrim asked when the IdP showed a login after the request', async () => {
    expect(await prove(reauth(), new Date(NOW + 1000).toISOString())).toBe(requestedAt);
    expect(mockReauthPolicy).toHaveBeenCalledWith({}, 'tenant-a', {
      providerId: 'idp-1',
      ids: ['saml:idp-1', 'idp-1'],
    });
  });

  it('accepts a login exactly one clock skew before the request and refuses one second earlier', async () => {
    expect(await prove(reauth(), new Date(NOW - SKEW_MS).toISOString())).toBe(requestedAt);
    expect(await prove(reauth(), new Date(NOW - SKEW_MS - 1000).toISOString())).toBeNull();
  });

  it.each([
    ['no IdP id', reauth({ providerId: undefined })],
    ['an empty IdP id', reauth({ providerId: '' })],
    ['no list of ids', reauth({ providerIds: undefined })],
    ['a non-list of ids', reauth({ providerIds: 'idp-1' })],
  ])('cannot match settings with %s, and does not read the policy', async (_label, input) => {
    expect(await prove(input, new Date(NOW + 1000).toISOString())).toBeNull();
    expect(mockReauthPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ['no AuthnInstant', undefined],
    ['an empty AuthnInstant', ''],
    ['an unparsable AuthnInstant', 'yesterday'],
  ])('refuses %s', async (_label, instant) => {
    expect(await prove(reauth(), instant)).toBeNull();
  });

  it('refuses when the tenant no longer lets the IdP re-authenticate, or the policy cannot be read', async () => {
    mockReauthPolicy.mockResolvedValue({ reauthEnabled: false, acceptWithoutAuthTime: false });
    expect(await prove(reauth(), new Date(NOW + 1000).toISOString())).toBeNull();

    mockReauthPolicy.mockRejectedValue(new Error('kv down'));
    expect(await prove(reauth(), new Date(NOW + 1000).toISOString())).toBeNull();
  });
});
