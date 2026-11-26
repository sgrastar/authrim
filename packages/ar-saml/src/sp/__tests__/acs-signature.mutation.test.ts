/**
 * SAML ACS signature handling: the certificates tried, what must be signed, and the processing of
 * an Assertion that is signed on its own instead of the whole Response.
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

// The signature module is controlled per test: what verification returns or throws, and whether
// the document counts as signed. By default the whole document is the signed reference.
const sig = vi.hoisted(() => ({
  verify: null as null | ((xml: string, options: unknown) => unknown),
  hasSignature: null as null | boolean,
  calls: [] as Array<{ certificateOrKey: string; strictXswProtection?: boolean }>,
}));
vi.mock('../../common/signature', () => ({
  verifyXmlSignature: vi.fn().mockReturnValue(true),
  verifyXmlSignatureAndGetReferences: vi.fn(
    (xml: string, options: { certificateOrKey: string }) => {
      sig.calls.push(options);
      if (sig.verify) return sig.verify(xml, options);
      return [{ uri: `#${/\bID="([^"]+)"/.exec(xml)?.[1]}`, xml }];
    }
  ),
  hasSignature: vi.fn((xml: string) => sig.hasSignature ?? xml.includes('<ds:Signature')),
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
const NS =
  'xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"';

function idp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: IDP_ENTITY,
    ssoUrl: 'https://idp.example.com/sso',
    certificate: 'cert-1',
    attributeMapping: { email: 'email' },
    ...overrides,
  };
}

/** The Assertion element of a built response, as a standalone document. */
function assertionOf(xml: string): string {
  const match = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(xml)?.[0] ?? '';
  return match.replace('<saml:Assertion ', `<saml:Assertion ${NS} `);
}

async function run(options: ResponseOptions = {}) {
  const response = await callACS(env, pending, { xml: samlResponseXml(options) });
  await Promise.allSettled(pending.splice(0));
  return response;
}

function signatureError(): string | undefined {
  const call = mockLogger.error.mock.calls.find(
    (entry: unknown[]) => entry[0] === 'Signature verification failed'
  );
  return call ? (call[2] as Error).message : undefined;
}

function consumeCalls(): number {
  const store = (env.SAML_REQUEST_STORE as unknown as { get: ReturnType<typeof vi.fn> }).get;
  const fetchMock = (
    store.mock.results[0]?.value as { fetch: ReturnType<typeof vi.fn> } | undefined
  )?.fetch;
  return (fetchMock?.mock.calls ?? []).filter((call: unknown[]) =>
    String(call[0]).includes('/consume/')
  ).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  sig.verify = null;
  sig.hasSignature = null;
  sig.calls.length = 0;
  state.context = undefined;
  state.assertionConsumeStatus = 200;
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
});

describe('certificates and presence', () => {
  it('refuses an IdP without any certificate', async () => {
    mockGetIdPConfigByEntityId.mockResolvedValue(idp({ certificate: '', certificates: [''] }));

    const response = await run();

    expect(response.status).toBe(400);
    expect(signatureError()).toBe('IdP certificate is required to verify SAML Response signatures');
    expect(sig.calls).toEqual([]);
  });

  it('refuses a document that carries no signature', async () => {
    sig.hasSignature = false;

    const response = await run();

    expect(response.status).toBe(400);
    expect(signatureError()).toBe(
      'Signed SAML Response or Assertion is required for configured IdP'
    );
    expect(sig.calls).toEqual([]);
  });

  it('tries each distinct certificate in order, strictly, and stops at the first that verifies', async () => {
    mockGetIdPConfigByEntityId.mockResolvedValue(
      idp({ certificate: 'cert-1', certificates: ['cert-2', 'cert-1', '', 'cert-3'] })
    );
    sig.verify = (xml, options) => {
      if ((options as { certificateOrKey: string }).certificateOrKey === 'cert-1')
        throw new Error('bad cert-1');
      return [{ uri: '#_response_1', xml }];
    };

    const response = await run();

    expect(response.status).toBe(302);
    expect(sig.calls).toEqual([
      { certificateOrKey: 'cert-1', strictXswProtection: true },
      { certificateOrKey: 'cert-2', strictXswProtection: true },
    ]);
  });

  it('reports the last verification failure when no certificate verifies', async () => {
    mockGetIdPConfigByEntityId.mockResolvedValue(idp({ certificates: ['cert-2'] }));
    sig.verify = (_xml, options) => {
      throw new Error(`bad ${(options as { certificateOrKey: string }).certificateOrKey}`);
    };

    const response = await run();

    expect(response.status).toBe(400);
    expect(signatureError()).toBe('bad cert-2');
  });

  it('names a generic failure when verification throws something that is not an Error', async () => {
    const raise = (value: unknown): never => {
      throw value;
    };
    sig.verify = () => raise('nope');

    await run();

    expect(signatureError()).toBe('SAML signature verification failed');
  });

  it('refuses a signature that covers neither the Response nor the Assertion', async () => {
    sig.verify = (xml) => [{ uri: '#_somewhere_else', xml }];

    const response = await run();

    expect(response.status).toBe(400);
    expect(signatureError()).toBe(
      'SAML signature does not cover the processed Response or Assertion'
    );
  });
});

describe('an Assertion signed on its own', () => {
  const signAssertionOnly = (transform: (assertion: string) => string = (value) => value) => {
    sig.verify = (xml) => [{ uri: '#_assertion_1', xml: transform(assertionOf(xml)) }];
  };

  it('is accepted and its own subject confirmation decides the request correlation', async () => {
    signAssertionOnly();

    const response = await run();

    expect(response.status).toBe(302);
    expect(signatureError()).toBeUndefined();
    expect(consumeCalls()).toBe(1);
  });

  it('takes InResponseTo from the signed Assertion, not from the unsigned Response element', async () => {
    signAssertionOnly((assertion) => assertion.replace(` InResponseTo="${REQUEST_ID}"`, ''));

    const response = await run();

    expect(response.status).toBe(302);
    expect(consumeCalls()).toBe(0);
  });

  it.each([
    [
      'an element that is not an Assertion',
      (a: string) => a.replace(/saml:Assertion/g, 'saml:Other'),
      'Signed SAML reference is not an Assertion',
    ],
    [
      'an Assertion of another namespace',
      (a: string) =>
        a.replace('xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"', 'xmlns:saml="urn:evil"'),
      'Signed SAML reference is not an Assertion',
    ],
    [
      'another assertion id',
      (a: string) => a.replace('_assertion_1', '_assertion_2'),
      'Signed Assertion does not match the routed SAML Response',
    ],
    [
      'another issuer',
      (a: string) =>
        a.replace('<saml:Issuer>https://idp.example.com', '<saml:Issuer>https://evil.example.com'),
      'Signed Assertion does not match the routed SAML Response',
    ],
  ])('refuses %s', async (_label, transform, message) => {
    signAssertionOnly(transform);

    const response = await run();

    expect(response.status).toBe(400);
    expect(signatureError()).toBe(message);
  });

  it('applies the Assertion time conditions to the signed copy, not to the unsigned one', async () => {
    signAssertionOnly((assertion) =>
      assertion.replace(
        /(<saml:SubjectConfirmationData[^>]*NotOnOrAfter=")[^"]*/,
        (_match, prefix: string) => `${prefix}2020-01-01T00:00:00.000Z`
      )
    );

    const response = await run();

    expect(response.status).toBe(400);
    expect(signatureError()).toBe('SubjectConfirmationData has expired (NotOnOrAfter)');
  });
});

describe('the signed Response', () => {
  it('is judged from the signed bytes: what differs in the unsigned copy has no effect', async () => {
    sig.verify = (xml) => [
      {
        uri: '#_response_1',
        xml: xml.replace(
          '<saml:Audience>https://auth.example.com/saml/sp/metadata',
          '<saml:Audience>https://other.example.com'
        ),
      },
    ];

    const response = await run();

    expect(response.status).toBe(400);
    expect(signatureError()).toBe('Invalid Audience in SAML Assertion');
  });
});
