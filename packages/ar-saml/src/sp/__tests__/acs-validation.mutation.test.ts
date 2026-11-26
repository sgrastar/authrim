/**
 * SAML ACS validation of the Response and its Assertion: every structural requirement, the exact
 * time-condition boundaries, audience restrictions, SubjectConfirmation rules and replay
 * protection. A refusal is observed through the error the ACS logs.
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
  ACS_URL,
  IDP_ENTITY,
  NOW,
  REQUEST_ID,
  SKEW_MS,
  SP_AUDIENCE,
  type AcsEnv,
  type AcsEnvState,
  type ResponseOptions,
} from './helpers/acs-harness';

const state: AcsEnvState = {
  relayState: 'https://ui.example.com/',
  assertionConsumeStatus: 200,
  assertionConsumeThrows: false,
};
let env: AcsEnv;
const pending: Promise<unknown>[] = [];

const iso = (ms: number) => new Date(ms).toISOString();

async function run(options: ResponseOptions = {}, strictCookie = true) {
  const response = await callACS(env, pending, {
    xml: samlResponseXml(options),
    inResponseTo: strictCookie ? REQUEST_ID : undefined,
  });
  await Promise.allSettled(pending.splice(0));
  return response;
}

function loggedErrors(): string[] {
  return mockLogger.error.mock.calls
    .filter(
      (call: unknown[]) => call[0] === 'ACS Error' || call[0] === 'Signature verification failed'
    )
    .map((call: unknown[]) => (call[2] as Error).message);
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
  mockGetIdPConfigByEntityId.mockResolvedValue({
    entityId: IDP_ENTITY,
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

describe('a valid Response', () => {
  it('signs the user in and sets up the session redirect', async () => {
    const response = await run();

    expect(response.status).toBe(302);
    expect(loggedErrors()).toEqual([]);
  });
});

describe('Response structure', () => {
  it.each([
    [
      'a non-Response root',
      samlResponseXml().replace(/samlp:Response/g, 'samlp:Other'),
      'Invalid SAML Response: root element must be Response',
    ],
    [
      'a Response in another namespace',
      samlResponseXml().replace('urn:oasis:names:tc:SAML:2.0:protocol', 'urn:evil'),
      'Invalid SAML Response: root element must be Response',
    ],
  ])('refuses %s', async (_label, xml, message) => {
    const response = await callACS(env, pending, { xml });
    await Promise.allSettled(pending.splice(0));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(loggedErrors()).toEqual([message]);
  });

  it.each([
    ['a missing Response ID', { responseId: null }, 'Invalid SAML Response: missing Response ID'],
    ['an empty Response ID', { responseId: '' }, 'Invalid SAML Response: missing Response ID'],
    [
      'a foreign Destination',
      { destination: 'https://evil.example.com/saml/sp/acs' },
      'Invalid Destination in SAML Response',
    ],
    [
      'a Destination with a trailing slash',
      { destination: `${ACS_URL}/` },
      'Invalid Destination in SAML Response',
    ],
    ['a missing Issuer', { responseIssuer: null }, 'Invalid SAML Response: missing Issuer'],
    ['an empty Issuer', { responseIssuer: '' }, 'Invalid SAML Response: missing Issuer'],
    [
      'a different Assertion Issuer',
      { assertionIssuer: 'https://other.example.com' },
      'Invalid SAML Response: Assertion Issuer does not match Response Issuer',
    ],
    [
      'a missing Assertion Issuer',
      { assertionIssuer: null },
      'Invalid SAML Response: Assertion Issuer does not match Response Issuer',
    ],
    [
      'an EncryptedAssertion beside the Assertion',
      { extraResponseChildren: '<saml:EncryptedAssertion/>' },
      'EncryptedAssertion is not supported by this SAML SP ACS endpoint',
    ],
    ['a missing Assertion ID', { assertionId: null }, 'Invalid Assertion: missing ID'],
  ] as Array<[string, ResponseOptions, string]>)('refuses %s', async (_label, options, message) => {
    const response = await run(options);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(loggedErrors()).toEqual([message]);
  });

  it('accepts a Response without a Destination attribute', async () => {
    expect((await run({ destination: null })).status).toBe(302);
  });

  it('requires exactly one Assertion', async () => {
    const xml = samlResponseXml();
    const assertion = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(xml)?.[0] ?? '';
    const none = xml.replace(assertion, '');
    const two = xml.replace(
      assertion,
      assertion + assertion.replace('_assertion_1', '_assertion_2')
    );

    for (const variant of [none, two]) {
      const response = await callACS(env, pending, { xml: variant });
      await Promise.allSettled(pending.splice(0));
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(loggedErrors()).toEqual([
      'Invalid SAML Response: expected exactly one Assertion',
      'Invalid SAML Response: expected exactly one Assertion',
    ]);
  });

  it('refuses a non-success status with the status code and message', async () => {
    const response = await run({
      statusCode: 'urn:oasis:names:tc:SAML:2.0:status:AuthnFailed',
      statusMessage: 'bad password',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(loggedErrors()).toEqual([
      'SAML authentication failed: urn:oasis:names:tc:SAML:2.0:status:AuthnFailed - bad password',
    ]);
  });

  it('names an unknown error when the failure status has no message', async () => {
    await run({ statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Responder' });

    expect(loggedErrors()).toEqual([
      'SAML authentication failed: urn:oasis:names:tc:SAML:2.0:status:Responder - Unknown error',
    ]);
  });

  it('refuses a Response without Status or StatusCode', async () => {
    const xml = samlResponseXml();
    for (const variant of [
      xml.replace(/<samlp:Status>[\s\S]*<\/samlp:Status>/, ''),
      xml.replace(/<samlp:StatusCode[^>]*\/>/, ''),
    ]) {
      await callACS(env, pending, { xml: variant });
      await Promise.allSettled(pending.splice(0));
    }
    expect(loggedErrors()).toEqual([
      'Invalid SAML Response: missing Status element',
      'Invalid SAML Response: missing StatusCode element',
    ]);
  });
});

describe('Subject and SubjectConfirmation', () => {
  it.each([
    ['a missing NameID', { nameId: null }, 'Invalid Assertion: missing NameID'],
    [
      'no SubjectConfirmation',
      { subjectConfirmation: null },
      'Invalid Assertion: missing SubjectConfirmation',
    ],
    [
      'a SubjectConfirmation without Method',
      { confirmationMethod: null },
      'Invalid Assertion: SubjectConfirmation missing Method attribute',
    ],
    [
      'the holder-of-key method',
      { confirmationMethod: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key' },
      'SubjectConfirmation method holder-of-key not supported for browser SSO',
    ],
    [
      'the sender-vouches method',
      { confirmationMethod: 'urn:oasis:names:tc:SAML:2.0:cm:sender-vouches' },
      'SubjectConfirmation method sender-vouches not supported for browser SSO',
    ],
    [
      'an unknown method',
      { confirmationMethod: 'urn:example:cm' },
      'SubjectConfirmation method not supported: urn:example:cm',
    ],
    [
      'a bearer confirmation without data',
      {
        subjectConfirmation:
          '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"/>',
      },
      'Invalid Assertion: bearer SubjectConfirmation missing SubjectConfirmationData',
    ],
    [
      'a missing Recipient',
      { recipient: null },
      'Invalid Assertion: SubjectConfirmationData missing Recipient attribute',
    ],
    [
      'a Recipient for another endpoint',
      { recipient: 'https://evil.example.com/acs' },
      `Invalid SubjectConfirmationData Recipient: expected ${ACS_URL}, got https://evil.example.com/acs`,
    ],
    [
      'a missing NotOnOrAfter',
      { confirmationNotOnOrAfter: null },
      'Invalid Assertion: SubjectConfirmationData missing NotOnOrAfter attribute',
    ],
    [
      'an expired confirmation',
      { confirmationNotOnOrAfter: iso(NOW - SKEW_MS - 1000) },
      'SubjectConfirmationData has expired (NotOnOrAfter)',
    ],
    [
      'an unparsable confirmation time',
      { confirmationNotOnOrAfter: 'soon' },
      'Invalid SAML dateTime: SubjectConfirmationData NotOnOrAfter',
    ],
    [
      'a confirmation for another request',
      { confirmationInResponseTo: '_other_request' },
      `SubjectConfirmationData InResponseTo mismatch: expected ${REQUEST_ID}, got _other_request`,
    ],
  ] as Array<[string, ResponseOptions, string]>)('refuses %s', async (_label, options, message) => {
    const response = await run(options);

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(loggedErrors()).toEqual([message]);
  });

  it('accepts a confirmation that expired less than the clock skew ago', async () => {
    expect(
      (
        await run({
          confirmationNotOnOrAfter: iso(NOW - SKEW_MS),
          conditions: { notOnOrAfter: iso(NOW + 300_000) },
        })
      ).status
    ).toBe(302);
  });
});

describe('Conditions', () => {
  it.each([
    ['missing Conditions', null, 'Invalid Assertion: missing Conditions'],
    [
      'a NotBefore beyond the clock skew',
      { notBefore: iso(NOW + SKEW_MS + 1000) },
      'Assertion is not yet valid (NotBefore)',
    ],
    [
      'a NotOnOrAfter beyond the clock skew',
      { notOnOrAfter: iso(NOW - SKEW_MS - 1000) },
      'Assertion has expired (NotOnOrAfter)',
    ],
    [
      'an unparsable NotBefore',
      { notBefore: 'whenever' },
      'Invalid SAML dateTime: Conditions NotBefore',
    ],
    [
      'an unparsable NotOnOrAfter',
      { notOnOrAfter: 'whenever' },
      'Invalid SAML dateTime: Conditions NotOnOrAfter',
    ],
    ['no AudienceRestriction', { audienceGroups: [] }, 'Invalid Audience in SAML Assertion'],
    [
      'a foreign audience',
      { audienceGroups: [['https://other.example.com']] },
      'Invalid Audience in SAML Assertion',
    ],
    ['an empty audience', { audienceGroups: [['']] }, 'Invalid Audience in SAML Assertion'],
    [
      'one restriction that excludes this SP among several',
      { audienceGroups: [[SP_AUDIENCE], ['https://other.example.com']] },
      'Invalid Audience in SAML Assertion',
    ],
  ] as Array<[string, ResponseOptions['conditions'], string]>)(
    'refuses %s',
    async (_label, conditions, message) => {
      const response = await run({ conditions });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(loggedErrors()).toEqual([message]);
    }
  );

  it.each([
    ['a NotBefore exactly one skew ahead', { notBefore: iso(NOW + SKEW_MS) }],
    ['a NotOnOrAfter exactly one skew behind', { notOnOrAfter: iso(NOW - SKEW_MS) }],
    ['no time conditions at all', { notBefore: null, notOnOrAfter: null }],
    [
      'this SP among several alternatives',
      { audienceGroups: [['https://other.example.com', SP_AUDIENCE]] },
    ],
    ['the same audience in two restrictions', { audienceGroups: [[SP_AUDIENCE], [SP_AUDIENCE]] }],
    [
      'a OneTimeUse and a ProxyRestriction condition',
      { extra: '<saml:OneTimeUse/><saml:ProxyRestriction Count="2"/>' },
    ],
  ] as Array<[string, NonNullable<ResponseOptions['conditions']>]>)(
    'accepts %s',
    async (_label, conditions) => {
      const response = await run({ conditions });

      expect(loggedErrors()).toEqual([]);
      expect(response.status).toBe(302);
    }
  );

  it('reads Conditions only from the direct children of the Assertion', async () => {
    const response = await run({
      conditions: null,
      extraAssertionChildren: `<saml:Advice><saml:Conditions NotBefore="${iso(NOW - 1000)}"><saml:AudienceRestriction><saml:Audience>${SP_AUDIENCE}</saml:Audience></saml:AudienceRestriction></saml:Conditions></saml:Advice>`,
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(loggedErrors()).toEqual(['Invalid Assertion: missing Conditions']);
  });
});

describe('replay protection', () => {
  it('records the assertion id with its confirmation expiry plus the clock skew', async () => {
    await run();

    const store = (env.SAML_REQUEST_STORE as unknown as { get: ReturnType<typeof vi.fn> }).get;
    const fetchMock = (store.mock.results[0]?.value as { fetch: ReturnType<typeof vi.fn> }).fetch;
    const consume = fetchMock.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes('/assertion/consume')
    );
    expect(consume?.[0]).toBe('https://saml-request-store/assertion/consume');
    expect(consume?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String((consume?.[1] as { body: string }).body))).toEqual({
      assertionId: '_assertion_1',
      expiresAt: NOW + 300_000 + SKEW_MS,
    });
  });

  it('refuses a replayed assertion and records a replay_detected failure', async () => {
    state.assertionConsumeStatus = 409;

    const response = await run();

    expect(response.status).toBe(400);
    expect(mockLogger.warn).toHaveBeenCalledWith('Bearer assertion already used', {
      assertionId: '_assertion_1',
    });
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'replay_detected' });
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('refuses when the replay store answers an error and records service_unavailable', async () => {
    state.assertionConsumeStatus = 500;

    const response = await run();

    expect(response.status).toBe(400);
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'service_unavailable' });
  });

  it('refuses when the replay store cannot be reached, logging the assertion id', async () => {
    state.assertionConsumeThrows = true;

    const response = await run();

    expect(response.status).toBe(400);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Bearer assertion replay validation unavailable',
      { assertionId: '_assertion_1' },
      expect.any(Error)
    );
    expect(mockSchedule.mock.calls[0]?.[1]).toMatchObject({ reasonCode: 'service_unavailable' });
  });
});
