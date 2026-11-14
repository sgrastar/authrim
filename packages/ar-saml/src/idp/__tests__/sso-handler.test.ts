import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { BINDING_URIS, SAML_NAMESPACES } from '../../common/constants';
import { createEvidenceDb, type EvidenceDb } from './helpers/evidence-db';
import { createSamlRequestStoreFake } from './helpers/saml-request-store-fake';
import { createChallengeStoreFake } from './helpers/challenge-store-fake';
import { completeStoredAuthnRequest } from '../sso-stored-request';

const store = createSamlRequestStoreFake();
const challenges = createChallengeStoreFake();

const mocks = vi.hoisted(() => ({
  sp: null as Record<string, unknown> | null,
  ui: undefined as { baseUrl: string; paths?: { login?: string } } | undefined,
  loginPolicy: 'ui_base_url',
  storeFetch: vi.fn(
    async (_url?: string, _init?: { body?: string }) => new Response('{}', { status: 200 })
  ),
  /** The challenges stored for the Login UI and the consent screen (see the challenge fake). */
  storeChallenge: vi.fn(async (_request?: unknown) => ({ success: true })),
  audit: vi.fn(),
  sessionId: undefined as string | undefined,
  shardedSession: true,
  sessionResponse: new Response(null, { status: 404 }),
  sessionThrows: false,
  user: null as Record<string, unknown> | null,
  attributeError: null as Error | null,
  /** The attributes the mapping would release, and the ones the Destination Profile requires. */
  attributes: [{ name: 'mail', values: ['user@example.test'] }] as Array<{
    name: string;
    values: string[];
  }>,
  requiredNames: null as string[] | null,
  authnContextError: null as Error | null,
  nameIdError: null as Error | null,
  pairwiseSecret: 'pairwise-secret' as string | undefined,
  pairwiseSecretForRef: 'referenced-secret' as string | undefined,
  /** The runtime contexts the attribute releases were given, in order. */
  runtimeContexts: [] as Array<Record<string, unknown> | undefined>,
  persistentProfileRows: [] as Array<Record<string, unknown>>,
  targetedIdOptions: null as Record<string, unknown> | null,
  buildResponse: vi.fn((..._args: unknown[]) => '<saml-success-response/>'),
  buildErrorResponse: vi.fn((_options?: unknown) => '<saml-error-response/>'),
  federationSettings: null as Record<string, unknown> | null,
  assuranceSettings: null as Record<string, unknown> | null,
  runtimeEdges: [] as unknown[],
  evidenceAdapter: null as unknown,
  /** The tenant's metadata database (trust policies, Flow assignments, statement versions). */
  metadataAdapter: null as unknown,
  coreAdapterError: null as Error | null,
  getCoreAdapter: vi.fn(async () => {
    if (mocks.coreAdapterError) throw mocks.coreAdapterError;
    return mocks.evidenceAdapter;
  }),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getUIConfig: vi.fn(async () => mocks.ui),
    getTenantSettingsDocument: vi.fn(async () => ({})),
    buildIssuerUrl: vi.fn(() => 'https://tenant.example.test'),
    buildSAMLRequestStoreInstanceName: vi.fn(
      (tenant: string, role: string, entity: string) => `${tenant}:${role}:${entity}`
    ),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: {
        fetch: vi.fn(async () => {
          if (mocks.sessionThrows) throw new Error('session unavailable');
          return mocks.sessionResponse.clone();
        }),
      },
    })),
    isShardedSessionId: vi.fn(() => mocks.shardedSession),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.metadataAdapter),
    requireAdminDatabaseAdapter: vi.fn(() => ({
      query: vi.fn(async () => mocks.persistentProfileRows),
    })),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => ({
      id: 'binding',
      tenantId: 'tenant-a',
      catalog: { entries: [] },
      edges: mocks.runtimeEdges,
      transforms: [],
      validationRules: [],
      fieldMappingSet: {},
      fieldMappingSetId: 'set',
      fieldMappingVersionId: 'version',
      destinationNamespace: 'saml',
      destinationProfileId: 'destination-profile-saml',
      destinationProfileIds: ['destination-profile-saml'],
    })),
    // The Destination Profile offers every attribute, and requires the ones the test names
    // (all of them by default).
    filterSamlAttributesByDestinationProfile: vi.fn(
      async (input: { attributes: Array<{ name: string }> }) => ({
        attributes: input.attributes,
        required: new Set(
          mocks.requiredNames ?? input.attributes.map((attribute) => attribute.name)
        ),
        labels: new Map<string, string>(),
      })
    ),
    getLocalization: vi.fn(async () => ({ locale: 'en', t: (key: string) => key })),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
    createAuditLog: mocks.audit,
  };
});

vi.mock('../../admin/providers', () => ({
  getSPConfig: vi.fn(async () => mocks.sp),
}));

vi.mock('../../common/entity-id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/entity-id')>();
  return {
    ...actual,
    getSAMLInteractiveLoginUrlPolicy: vi.fn(async () => mocks.loginPolicy),
    getSAMLLocalEntityIds: vi.fn(async () => ({
      issuerUrl: 'https://tenant.example.test',
      idpEntityId: 'https://tenant.example.test/saml/idp',
    })),
  };
});

vi.mock('../../common/session-cookie', () => ({
  extractAuthrimSessionIdFromCookieHeader: vi.fn(() => mocks.sessionId),
}));

vi.mock('../../common/user-store', () => ({
  getSamlUserInfoById: vi.fn(async () => mocks.user),
  getSamlUserCoreAdapter: mocks.getCoreAdapter,
}));

vi.mock('../../common/idp-signing', () => ({
  getSAMLIdPSigningMaterial: vi.fn(async () => ({
    privateKeyPem: 'private-key',
    certificate: 'certificate',
  })),
}));

vi.mock('../signing', () => ({
  applySAMLResponseSigningPolicy: vi.fn((xml: string) => xml),
  assertSAMLResponseSigningPolicy: vi.fn(),
}));

vi.mock('../assertion', () => ({
  buildSAMLResponse: mocks.buildResponse,
}));

vi.mock('../attributes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../attributes')>();
  return {
    ...actual,
    buildSAMLAttributesForSPWithDiagnostics: vi.fn(
      (
        _subject: unknown,
        config?: {
          identityMapping?: { runtimeContext?: { saml?: { eduPersonTargetedIdOpaque?: string } } };
        }
      ) => {
        if (mocks.attributeError) throw mocks.attributeError;
        mocks.runtimeContexts.push(
          (config?.identityMapping as { runtimeContext?: Record<string, unknown> } | undefined)
            ?.runtimeContext
        );
        // A mapping that releases eduPersonTargetedID carries the identifier the release
        // context holds: a placeholder until the release is approved, then the real one.
        const targeted = config?.identityMapping?.runtimeContext?.saml?.eduPersonTargetedIdOpaque;
        return {
          attributes: [
            ...mocks.attributes.map((attribute) => ({ ...attribute })),
            ...(typeof targeted === 'string'
              ? [{ name: 'eduPersonTargetedID', values: [targeted] }]
              : []),
            // A persistent_identifier step's value goes out the same way.
            ...Object.values(
              ((config?.identityMapping as { runtimeContext?: { identifiers?: object } })
                ?.runtimeContext?.identifiers ?? {}) as Record<string, string>
            ).map((value) => ({ name: 'pairwise-id', values: [value] })),
          ],
          optionalMissingAttributes: [],
        };
      }
    ),
  };
});

vi.mock('../authn-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../authn-context')>();
  return {
    ...actual,
    resolveSAMLAuthnContextClassRef: vi.fn(() => {
      if (mocks.authnContextError) throw mocks.authnContextError;
      return 'urn:test:loa:1';
    }),
  };
});

vi.mock('../subject', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../subject')>();
  return {
    ...actual,
    createSAMLSessionIndex: vi.fn(async () => 'session-index'),
    resolveSAMLNameIDFormat: vi.fn(() => {
      if (mocks.nameIdError) throw mocks.nameIdError;
      return 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
    }),
    resolveSAMLNameIDValue: vi.fn(async () => 'user@example.test'),
    resolveSAMLEduPersonTargetedIDOpaque: vi.fn(
      async (_user: unknown, options: Record<string, unknown>) => {
        mocks.targetedIdOptions = options;
        return 'targeted-id';
      }
    ),
    resolveSAMLPairwiseSecret: vi.fn(async () => mocks.pairwiseSecret),
    resolveSAMLPairwiseSecretForRef: vi.fn(async () => mocks.pairwiseSecretForRef),
    resolveSAMLPersistentNameIDRegistryStore: vi.fn(() => undefined),
    resolveSAMLTransientNameIDStore: vi.fn(() => undefined),
  };
});

vi.mock('../encryption', () => ({
  applySAMLAssertionEncryptionPolicy: vi.fn(async (xml: string) => xml),
}));

vi.mock('../error-response', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../error-response')>();
  return {
    ...actual,
    buildSAMLIdPErrorResponse: mocks.buildErrorResponse,
    // No override configured: the status is the one the handler chose.
    applySAMLErrorResponseOverride: vi.fn((_config: unknown, input: unknown) => input),
  };
});

import { handleIdPSSO } from '../sso';
import { samlAttributeItemKey, samlNameIdItemKey } from '../release-items';
import { applySAMLErrorResponseOverride } from '../error-response';
import {
  buildSAMLAttributesForSPWithDiagnostics,
  MissingRequiredSAMLAttributeError,
  SAMLIdentityMappingRuntimeError,
} from '../attributes';
import { SAMLAuthnContextPolicyError } from '../authn-context';
import {
  createSAMLSessionIndex,
  resolveSAMLEduPersonTargetedIDOpaque,
  resolveSAMLNameIDValue,
  resolveSAMLPersistentNameIDRegistryStore,
  resolveSAMLTransientNameIDStore,
  SAMLNameIDPolicyError,
  resolveSAMLPairwiseSecretForRef,
} from '../subject';
import { getSamlUserInfoById } from '../../common/user-store';
import { computeIdentifier } from '@authrim/ar-lib-core';

function sp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: 'https://sp.example.test/entity',
    acsUrl: 'https://sp.example.test/acs',
    acsUrls: ['https://sp.example.test/acs'],
    allowedBindings: ['post'],
    authnRequestSignaturePolicy: 'optional',
    signResponses: true,
    signAssertions: false,
    // The SP does not ask the person unless a test says so (see the consent tests below).
    informationReleaseConsent: { enabled: false },
    ...overrides,
  };
}

function app() {
  const route = new Hono();
  route.use('*', async (c, next) => {
    (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
    await next();
  });
  route.all('/sso', handleIdPSSO as never);
  return route;
}

function environment() {
  return {
    SETTINGS: {
      get: vi.fn(async (key: string) =>
        key === 'settings:tenant:tenant-a:federation' && mocks.federationSettings
          ? JSON.stringify(mocks.federationSettings)
          : key === 'settings:tenant:tenant-a:assurance' && mocks.assuranceSettings
            ? JSON.stringify(mocks.assuranceSettings)
            : null
      ),
    },
    SAML_REQUEST_STORE: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: mocks.storeFetch })),
    },
    CHALLENGE_STORE: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ ...challenges.stub, storeChallengeRpc: mocks.storeChallenge })),
    },
  };
}

function authnRequest(
  options: {
    issueInstant?: string;
    destination?: string;
    acsUrl?: string;
    protocolBinding?: string;
    forceAuthn?: boolean;
    isPassive?: boolean;
  } = {}
) {
  const issueInstant = options.issueInstant ?? new Date().toISOString();
  const attrs = [
    'ID="_request"',
    `IssueInstant="${issueInstant}"`,
    options.destination ? `Destination="${options.destination}"` : '',
    options.acsUrl ? `AssertionConsumerServiceURL="${options.acsUrl}"` : '',
    options.protocolBinding ? `ProtocolBinding="${options.protocolBinding}"` : '',
    options.forceAuthn ? 'ForceAuthn="true"' : '',
    options.isPassive ? 'IsPassive="true"' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ${attrs}>
    <saml:Issuer>https://sp.example.test/entity</saml:Issuer>
  </samlp:AuthnRequest>`;
}

async function post(xml?: string, relayState?: string) {
  const form = new FormData();
  if (xml !== undefined) form.set('SAMLRequest', btoa(xml));
  if (relayState !== undefined) form.set('RelayState', relayState);
  return app().fetch(
    new Request('https://tenant.example.test/sso', { method: 'POST', body: form }),
    environment(),
    { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }
  );
}

// The tenant's databases: one real SQLite with the core schema serves as the account database
// (release decisions and withdrawal generations, assurance evidence) and the metadata database
// (trust policies, Flow assignments, consent statement versions).
let consentDb: EvidenceDb;

beforeAll(async () => {
  consentDb = await createEvidenceDb('user-a');
});

beforeEach(() => {
  consentDb.clearConsent();
  consentDb.failEvidenceReads(null);
  mocks.evidenceAdapter = consentDb.adapter;
  mocks.metadataAdapter = consentDb.adapter;
  mocks.coreAdapterError = null;
  mocks.attributes = [{ name: 'mail', values: ['user@example.test'] }];
  mocks.requiredNames = null;
  mocks.ui = undefined;
  // What the tests store and read back (the consent screen's challenges) is forgotten.
  challenges.reset();
  mocks.storeChallenge.mockImplementation(challenges.stub.storeChallengeRpc as never);
});

describe('IdP SSO handler policy boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sp = sp();
    mocks.ui = undefined;
    mocks.loginPolicy = 'ui_base_url';
    store.reset();
    mocks.storeFetch.mockReset();
    mocks.storeFetch.mockImplementation(store.fetch);
    mocks.sessionId = undefined;
    mocks.shardedSession = true;
    mocks.sessionResponse = new Response(null, { status: 404 });
    mocks.sessionThrows = false;
    mocks.user = null;
    mocks.attributeError = null;
    mocks.authnContextError = null;
    mocks.nameIdError = null;
    mocks.pairwiseSecret = 'pairwise-secret';
    mocks.pairwiseSecretForRef = 'referenced-secret';
    mocks.persistentProfileRows = [];
    mocks.targetedIdOptions = null;
    mocks.federationSettings = null;
    mocks.assuranceSettings = null;
    mocks.runtimeEdges = [];
  });

  it('rejects missing and malformed POST messages without details', async () => {
    expect((await post()).status).toBe(400);
    expect((await post('<not-saml/>')).status).toBe(400);
  });

  it('rejects an unknown SP before creating login state', async () => {
    mocks.sp = null;
    const response = await post(authnRequest());
    expect(response.status).toBe(400);
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['not-a-date', undefined],
    [new Date(Date.now() + 10 * 60_000).toISOString(), undefined],
    [new Date(Date.now() - 30 * 60_000).toISOString(), undefined],
    [new Date().toISOString(), 'https://attacker.example/sso'],
  ])('rejects invalid request timing or Destination', async (issueInstant, destination) => {
    const response = await post(authnRequest({ issueInstant, destination }));
    expect(response.status).toBe(400);
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('rejects an unregistered ACS URL without redirecting to it', async () => {
    const response = await post(authnRequest({ acsUrl: 'https://attacker.example/acs' }));
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });

  it('returns a signed protocol error for unsupported response binding', async () => {
    const response = await post(
      authnRequest({ protocolBinding: BINDING_URIS.HTTP_REDIRECT }),
      'relay'
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('SAMLResponse');
    expect(html).toContain('RelayState');
    expect(mocks.buildErrorResponse).toHaveBeenCalled();
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('returns a protocol error when a required request signature is absent', async () => {
    mocks.sp = sp({ authnRequestSignaturePolicy: 'required' });
    const response = await post(authnRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildErrorResponse).toHaveBeenCalled();
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('handles passive authentication without starting an interactive login', async () => {
    const response = await post(authnRequest({ isPassive: true }));
    expect(response.status).toBe(200);
    // Answered at once (NoPassive): the request is only recorded and used up, never kept waiting.
    expect(store.calls).toEqual(['create', 'complete']);
    expect(store.waiting.size).toBe(0);
  });

  it('stores the request before the UI login and preserves force-authn intent', async () => {
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    const response = await post(authnRequest({ forceAuthn: true }), 'relay-state');
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('https://ui.example.test/login');
    expect(location).toContain('force_authn=true');
    expect(mocks.storeFetch).toHaveBeenCalledWith(
      'https://saml-request-store/authn/create',
      expect.objectContaining({ method: 'POST' })
    );
    // Recorded as it arrived (revision 1), then kept for the sign-in (revision 2).
    expect(store.calls).toEqual(['create', 'update']);
    expect(store.waiting.get('_request')).toMatchObject({ revision: 2, relayState: 'relay-state' });
    // Nobody is signed in: they have to sign in anyway, so there is no challenge to answer.
    expect(mocks.storeChallenge).not.toHaveBeenCalled();
    expect(new URL(location).searchParams.has('challenge_id')).toBe(false);
  });

  it('puts a login nonce on the login URL and keeps only its hash in the stored request', async () => {
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    const response = await post(authnRequest(), 'relay-state');
    const nonce = new URL(response.headers.get('location') ?? '').searchParams.get(
      'saml_login_nonce'
    );
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const context = store.waiting.get('_request')?.context as { loginNonceHash?: string };
    const body = mocks.storeFetch.mock.calls.map(([, init]) => String(init?.body)).join('\n');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce ?? ''));
    expect(context.loginNonceHash).toBe(
      Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    );
    expect(body).not.toContain(nonce);
  });

  it('fails safely after storing when interactive UI is not configured', async () => {
    const response = await post(authnRequest());
    expect(response.status).toBe(500);
    expect(mocks.storeFetch).toHaveBeenCalled();
  });

  it.each([
    ['ui_base_url', '/custom-login', 'https://ui.example.test/custom-login', true],
    ['ui_base_url', undefined, 'https://ui.example.test/login', true],
    ['tenant_host', '/custom-login', 'https://tenant.example.test/custom-login', false],
  ] as const)(
    'redirects through the constrained %s UI policy',
    async (policy, path, expected, tenantHint) => {
      mocks.loginPolicy = policy;
      mocks.ui = { baseUrl: 'https://ui.example.test', paths: path ? { login: path } : undefined };
      const response = await post(authnRequest());
      const location = response.headers.get('location') ?? '';
      expect(location).toContain(expected);
      expect(location.includes('tenant_hint=tenant-a')).toBe(tenantHint);
    }
  );

  it('fails closed if request state cannot be stored', async () => {
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    mocks.storeFetch.mockRejectedValue(new Error('state unavailable'));
    const response = await post(authnRequest());
    expect(response.status).toBe(400);
  });

  it.each([
    ['non-sharded cookie', false, false, new Response(null, { status: 200 })],
    ['session store failure', true, true, new Response(null, { status: 200 })],
    ['expired session', true, false, new Response(null, { status: 401 })],
    [
      'session without user',
      true,
      false,
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ],
  ] as const)('treats %s as unauthenticated', async (_name, sharded, throws, response) => {
    mocks.sessionId = 'session-id';
    mocks.shardedSession = sharded;
    mocks.sessionThrows = throws;
    mocks.sessionResponse = response;
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    const result = await post(authnRequest());
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toContain('https://ui.example.test/login');
  });

  it('fails authentication when the session user no longer exists', async () => {
    authenticateSession();
    mocks.user = null;
    const response = await post(authnRequest());
    expect(response.status).toBe(400);
  });

  it('forces an authenticated session through interactive reauthentication', async () => {
    authenticateSession();
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    const response = await post(authnRequest({ forceAuthn: true }));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('force_authn')).toBe('true');
    // The Login UI is given a challenge for the person who is signed in.
    expect(mocks.storeChallenge).toHaveBeenCalledOnce();
    const stored = mocks.storeChallenge.mock.calls[0]?.[0] as { id: string };
    expect(location.searchParams.get('challenge_id')).toBe(stored.id);
  });

  it('issues a SAML response for an authenticated user and preserves RelayState', async () => {
    authenticateSession({ acr: 'loa2', amr: ['pwd', 1, 'mfa'] });
    mocks.user = { id: 'user-a', email: 'user@example.test', name: 'User A' };
    const response = await post(authnRequest(), 'relay-state');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('SAMLResponse');
    expect(html).toContain('RelayState');
    expect(mocks.buildResponse).toHaveBeenCalled();
    expect(mocks.buildErrorResponse).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing required attribute',
      () =>
        (mocks.attributeError = new MissingRequiredSAMLAttributeError([
          { name: 'mail', friendlyName: 'Email', source: 'email' } as never,
        ])),
    ],
    [
      'identity mapping failure',
      () =>
        (mocks.attributeError = new SAMLIdentityMappingRuntimeError([
          { category: 'policy', code: 'policy.mapping_failed', severity: 'critical' },
        ] as never)),
    ],
    [
      'unsupported authentication context',
      () =>
        (mocks.authnContextError = new SAMLAuthnContextPolicyError('unsupported', {
          comparison: 'exact',
          authnContextClassRef: ['urn:unsupported'],
        })),
    ],
    [
      'invalid NameID policy',
      () => (mocks.nameIdError = new SAMLNameIDPolicyError('invalid', { format: 'unsupported' })),
    ],
  ] as const)('returns a protocol error for %s', async (_name, configure) => {
    authenticateSession();
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    configure();
    const response = await post(authnRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildErrorResponse).toHaveBeenCalled();
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('rejects GET redirect binding without a SAMLRequest', async () => {
    const response = await app().fetch(
      new Request('https://tenant.example.test/sso'),
      environment(),
      { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }
    );
    expect(response.status).toBe(400);
  });

  it('builds eduPersonTargetedID runtime context from the tenant pairwise secret', async () => {
    authenticateSession();
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.sp = sp({
      identityMapping: targetedIdMapping(),
    });
    expect((await post(authnRequest())).status).toBe(200);
    expect(mocks.targetedIdOptions).toMatchObject({
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.test/entity',
      pairwiseSalt: 'pairwise-secret',
    });
  });

  it('makes a persistent_identifier step from the account ID with the tenant salt', async () => {
    authenticateSession();
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.pairwiseSecretForRef = 'tenant-identifier-salt';
    mocks.runtimeContexts = [];
    const target = {
      side: 'destination',
      namespace: 'saml.attribute',
      path: 'urn:oasis:names:tc:SAML:attribute:pairwise-id',
    };
    mocks.sp = sp({
      identityMapping: {
        catalog: { entries: [] },
        edges: [
          {
            id: 'edge-uid',
            sourceRef: { side: 'source', namespace: 'authrim.system', path: 'uid' },
            targetRef: target,
          },
        ],
        transforms: [
          {
            id: 'step-pairwise',
            operation: 'persistent_identifier',
            inputEdgeIds: ['edge-uid'],
            parameters: {
              format: 'saml_pairwise_id',
              algorithm: 'shibboleth',
              encoding: 'base32',
              scope: 'example.test',
            },
            outputTargetRef: target,
          },
        ],
      },
    });
    expect((await post(authnRequest())).status).toBe(200);
    const made = await computeIdentifier({
      algorithm: 'shibboleth',
      value: 'user-a',
      audience: 'https://sp.example.test/entity',
      salt: new TextEncoder().encode('tenant-identifier-salt'),
      encoding: 'base32',
    });
    const identifiers = mocks.runtimeContexts.map((context) => context?.identifiers);
    // Before consent a placeholder stands for it; the assertion carries the identifier made.
    expect(identifiers).toContainEqual({ 'step-pairwise': `${made}@example.test` });
    expect(JSON.stringify(identifiers)).not.toContain('user-a');
    expect(resolveSAMLPairwiseSecretForRef).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'identifier-salt:default'
    );
  });

  it.each([
    [[], 'policy.persistent_identifier_profile_not_found'],
    [
      [{ id: 'profile-a', mode: 'stored', protocol_scope: 'saml', algorithm: 'sha256' }],
      'policy.persistent_identifier_profile_unsupported_mode',
    ],
    [
      [{ id: 'profile-a', mode: 'computed', protocol_scope: 'oidc', algorithm: 'sha256' }],
      'policy.persistent_identifier_profile_unsupported_mode',
    ],
  ])('fails closed for unusable persistent identifier profile %#', async (rows) => {
    authenticateSession();
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.sp = sp({ identityMapping: targetedIdMapping('profile-a') });
    mocks.persistentProfileRows = rows;
    const response = await post(authnRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.targetedIdOptions).toBeNull();
    expect(mocks.buildErrorResponse).toHaveBeenCalled();
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it.each([
    [targetedIdMapping(), undefined, [], undefined],
    [
      targetedIdMapping('profile-a'),
      'pairwise-secret',
      [
        {
          id: 'profile-a',
          mode: 'computed',
          protocol_scope: 'saml',
          algorithm: 'sha256',
          secret_ref: 'secret-ref',
        },
      ],
      undefined,
    ],
  ])(
    'fails closed when targeted identifier secret is unavailable %#',
    async (identityMapping, baseSecret, rows, refSecret) => {
      authenticateSession();
      mocks.user = { id: 'user-a', email: 'user@example.test' };
      mocks.sp = sp({ identityMapping });
      mocks.pairwiseSecret = baseSecret;
      mocks.pairwiseSecretForRef = refSecret;
      mocks.persistentProfileRows = rows;
      expect((await post(authnRequest())).status).toBe(200);
      expect(mocks.targetedIdOptions).toBeNull();
      expect(mocks.buildErrorResponse).toHaveBeenCalled();
      expect(mocks.buildResponse).not.toHaveBeenCalled();
    }
  );

  it('applies a complete computed persistent identifier profile', async () => {
    authenticateSession();
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.sp = sp({ identityMapping: targetedIdMapping('profile-a') });
    mocks.persistentProfileRows = [
      {
        id: 'profile-a',
        mode: 'computed',
        protocol_scope: 'generic',
        algorithm: 'shibboleth_sha1_base64',
        secret_ref: 'secret-ref',
        issuer_entity_id: 'https://persistent.example.test/idp',
        audience_mode: 'saml_sp_entity_id',
      },
    ];
    expect((await post(authnRequest())).status).toBe(200);
    expect(mocks.targetedIdOptions).toMatchObject({
      pairwiseSalt: 'referenced-secret',
      pairwiseAlgorithm: 'shibboleth_sha1_base64',
      pairwiseAudienceMode: 'saml_sp_entity_id',
      persistentProfileId: 'profile-a',
    });
  });
});

function targetedIdMapping(profileId?: string) {
  return {
    catalog: { entries: [] },
    edges: [],
    transforms: [
      {
        operation: 'saml_edu_person_targeted_id',
        parameters: profileId ? { persistentIdentifierProfileId: profileId } : {},
      },
    ],
  };
}

function authenticateSession(data: Record<string, unknown> = {}) {
  mocks.sessionId = 'session-id';
  mocks.shardedSession = true;
  mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function storedRequest(context: Record<string, unknown> = {}) {
  return {
    type: 'authn_request',
    issuer: 'https://sp.example.test/entity',
    requestId: '_request',
    relayState: 'relay-state',
    binding: 'post',
    data: {
      id: '_request',
      issueInstant: new Date().toISOString(),
      issuer: 'https://sp.example.test/entity',
      assertionConsumerServiceURL: 'https://sp.example.test/acs',
    },
    context,
  };
}

describe('resuming a stored request after the Login UI', () => {
  const NONCE = 'r'.repeat(43);
  const sha = async (value: string) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
      (b) => b.toString(16).padStart(2, '0')
    ).join('');
  const resume = (nonce?: string) =>
    app().request(
      `https://tenant.example.test/sso?saml_request_id=_request&saml_sp_entity_id=${encodeURIComponent(
        'https://sp.example.test/entity'
      )}&return_to=saml_sso${nonce ? `&saml_login_nonce=${nonce}` : ''}`,
      undefined,
      environment()
    );
  // What the resume updated the stored request's context to (an update of a resume).
  const storedBody = () => {
    const call = mocks.storeFetch.mock.calls.find(
      ([url]) => url === 'https://saml-request-store/authn/update'
    );
    return JSON.parse(String(call?.[1]?.body)) as {
      expectedRevision: number;
      context: { loginNonceHash?: string };
    };
  };
  const serveStored = (context: Record<string, unknown>) => {
    store.seed({ ...storedRequest(), context } as never);
  };
  beforeEach(() => {
    vi.clearAllMocks();
    store.reset();
    mocks.storeFetch.mockReset();
    mocks.storeFetch.mockImplementation(store.fetch);
    mocks.sp = sp();
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    mocks.sessionId = undefined;
    mocks.federationSettings = null;
  });

  it('resumes without a nonce as ever, keeping the original hash and issuing no nonce', async () => {
    serveStored({ loginNonceHash: await sha(NONCE) });
    const response = await resume();
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.has('saml_login_nonce')).toBe(false);
    expect(storedBody().context.loginNonceHash).toBe(await sha(NONCE));
  });

  it('puts no nonce on the login URL for a wrong one either, and keeps the original hash', async () => {
    serveStored({ loginNonceHash: await sha(NONCE) });
    const response = await resume('w'.repeat(43));
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get('location') ?? '').searchParams.has('saml_login_nonce')
    ).toBe(false);
    expect(storedBody().context.loginNonceHash).toBe(await sha(NONCE));
  });

  it('refuses a resume the store will not release, sending nobody to sign in', async () => {
    // Nothing is waiting under that id: the store answers 404 to the read.
    const response = await resume('w'.repeat(43));
    expect(response.status).toBe(400);
    expect(store.calls).toEqual(['read']);
  });

  it('keeps the matched nonce when it sends the person to sign in again', async () => {
    serveStored({ loginNonceHash: await sha(NONCE) });
    const response = await resume(NONCE);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('saml_login_nonce')).toBe(NONCE);
    expect(storedBody().context.loginNonceHash).toBe(await sha(NONCE));
  });

  it('resumes a request stored before nonces as it was, and gives it none', async () => {
    serveStored({ sentToSignInAt: 1 });
    const response = await resume();
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.has('saml_login_nonce')).toBe(false);
    expect(storedBody().context.loginNonceHash).toBeUndefined();
  });
});

describe('IdP SSO lifetimes from the tenant settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sp = sp();
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    mocks.loginPolicy = 'ui_base_url';
    store.reset();
    mocks.storeFetch.mockReset();
    mocks.storeFetch.mockImplementation(store.fetch);
    mocks.sessionId = undefined;
    mocks.user = null;
    mocks.federationSettings = null;
  });

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  async function storedLifetimeSeconds(): Promise<number> {
    const stored = store.waiting.get('_request') as { expiresAt: number };
    return Math.round((stored.expiresAt - Date.now()) / 1000);
  }

  async function assertionLifetimeSeconds(): Promise<number> {
    const input = (mocks.buildResponse.mock.calls.at(-1) as unknown as [Record<string, string>])[0];
    return (Date.parse(input.notOnOrAfter) - Date.parse(input.issueInstant)) / 1000;
  }

  it('keeps the request for five minutes where the tenant sets nothing', async () => {
    expect((await post(authnRequest())).status).toBe(302);
    expect(await storedLifetimeSeconds()).toBe(300);
  });

  it('keeps the request for the tenant request lifetime', async () => {
    mocks.federationSettings = { 'federation.saml_request_ttl': 120 };
    expect((await post(authnRequest())).status).toBe(302);
    expect(await storedLifetimeSeconds()).toBe(120);
  });

  it('accepts a request as old as the tenant request lifetime allows', async () => {
    mocks.federationSettings = { 'federation.saml_request_ttl': 600 };
    expect((await post(authnRequest({ issueInstant: minutesAgo(8) }))).status).toBe(302);
  });

  it('rejects a request older than the tenant request lifetime', async () => {
    mocks.federationSettings = { 'federation.saml_request_ttl': 60 };
    expect((await post(authnRequest({ issueInstant: minutesAgo(3) }))).status).toBe(400);
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('uses the default request lifetime for a value out of range', async () => {
    mocks.federationSettings = { 'federation.saml_request_ttl': 86_400 };
    expect((await post(authnRequest({ issueInstant: minutesAgo(8) }))).status).toBe(400);
  });

  describe('assertion lifetime', () => {
    beforeEach(() => {
      authenticateSession();
      mocks.user = { id: 'user-a', email: 'user@example.test' };
    });

    it('is five minutes where nothing is set', async () => {
      expect((await post(authnRequest())).status).toBe(200);
      expect(await assertionLifetimeSeconds()).toBe(300);
    });

    it("is the tenant's when the service provider has none", async () => {
      mocks.federationSettings = { 'federation.saml_assertion_ttl': 120 };
      expect((await post(authnRequest())).status).toBe(200);
      expect(await assertionLifetimeSeconds()).toBe(120);
    });

    it("is the service provider's own when it has one", async () => {
      mocks.federationSettings = { 'federation.saml_assertion_ttl': 120 };
      mocks.sp = sp({ assertionValiditySeconds: 90 });
      expect((await post(authnRequest())).status).toBe(200);
      expect(await assertionLifetimeSeconds()).toBe(90);
    });
  });
});

describe('SP minimum identity assurance (SP-initiated)', () => {
  let evidence: EvidenceDb;

  beforeAll(async () => {
    evidence = await createEvidenceDb('user-a');
  });

  beforeEach(() => {
    // Each test sends the request anew (the store refuses an id it knows, as a replay).
    store.reset();
    vi.clearAllMocks();
    evidence.clearEvidence();
    evidence.resetReads();
    mocks.evidenceAdapter = evidence.adapter;
    mocks.coreAdapterError = null;
    mocks.sp = sp({ minimumIal: 'IAL2' });
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    mocks.loginPolicy = 'ui_base_url';
    store.reset();
    mocks.storeFetch.mockReset();
    mocks.storeFetch.mockImplementation(store.fetch);
    mocks.shardedSession = true;
    mocks.sessionThrows = false;
    mocks.user = { id: 'user-a', email: 'user@example.test', name: 'User A' };
    mocks.attributeError = null;
    mocks.federationSettings = null;
    mocks.targetedIdOptions = null;
    authenticateSession();
  });

  const errorResponseOptions = () =>
    mocks.buildErrorResponse.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  const auditedKinds = () =>
    mocks.audit.mock.calls.map(
      ([, entry]) =>
        (JSON.parse(String((entry as { metadata: string }).metadata)) as { failure_kind: string })
          .failure_kind
    );

  it('answers a person below the minimum with Responder/RequestDenied and builds no assertion', async () => {
    evidence.addEvidence('ev-1', 'IAL1');
    const response = await post(authnRequest(), 'relay-state');

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('action="https://sp.example.test/acs"');
    expect(html).toContain('SAMLResponse');
    expect(html).toContain('relay-state');
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(errorResponseOptions()).toMatchObject({
      destination: 'https://sp.example.test/acs',
      inResponseTo: '_request',
      statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
      secondLevelStatusCode: 'urn:oasis:names:tc:SAML:2.0:status:RequestDenied',
    });
    expect(auditedKinds()).toEqual(['identity_assurance_insufficient']);
  });

  it('says neither the level the person holds nor the one the SP requires', async () => {
    evidence.addEvidence('ev-1', 'IAL1');
    const response = await post(authnRequest());
    const { statusMessage, statusCode, secondLevelStatusCode } = errorResponseOptions();
    expect(
      [statusMessage, statusCode, secondLevelStatusCode, await response.text()].join(' ')
    ).not.toMatch(/IAL|assurance/i);
  });

  it('refuses before the NameID, the attributes, the session index and the consent screen', async () => {
    // An SP that would ask the person: no screen is shown to someone who may not be answered.
    mocks.sp = sp({ minimumIal: 'IAL2', informationReleaseConsent: { enabled: true } });
    const response = await post(authnRequest());

    expect(response.headers.get('location')).toBeNull();
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(getSamlUserInfoById).not.toHaveBeenCalled();
    expect(resolveSAMLNameIDValue).not.toHaveBeenCalled();
    expect(createSAMLSessionIndex).not.toHaveBeenCalled();
    // No consent challenge was stored: the request was only recorded and used up by the refusal.
    expect(challenges.consentChallenges()).toHaveLength(0);
    expect(store.calls).toEqual(['create', 'complete']);
    expect(store.waiting.size).toBe(0);
  });

  it('issues the assertion to a person at the minimum', async () => {
    evidence.addEvidence('ev-1', 'IAL2');
    const response = await post(authnRequest(), 'relay-state');
    expect(response.status).toBe(200);
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(mocks.buildErrorResponse).not.toHaveBeenCalled();
    expect(evidence.evidenceReads()).toBe(1);
  });

  it.each([
    ['revoked', { revoked_at: Date.now() - 1_000 }],
    ['expired', { expires_at: Date.now() - 1_000 }],
  ])('refuses a person whose only evidence is %s', async (_name, overrides) => {
    evidence.addEvidence('ev-1', 'IAL2', overrides);
    await post(authnRequest());
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(auditedKinds()).toEqual(['identity_assurance_insufficient']);
  });

  it('refuses a person with no evidence at all', async () => {
    await post(authnRequest());
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(evidence.evidenceReads()).toBe(1);
  });

  it('does not take an unreadable minimum for none', async () => {
    mocks.sp = sp({ minimumIal: 'bogus' });
    evidence.addEvidence('ev-1', 'IAL2');
    await post(authnRequest());
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('refuses with a plain Responder status, not as insufficient, when the evidence cannot be read', async () => {
    evidence.addEvidence('ev-1', 'IAL3');
    mocks.coreAdapterError = new Error('account_data_route_not_found');
    const response = await post(authnRequest(), 'relay-state');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    const options = errorResponseOptions();
    expect(options).toMatchObject({
      statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
    });
    expect(options.secondLevelStatusCode).toBeUndefined();
    expect(String(options.statusMessage)).not.toMatch(/IAL|assurance/i);
    expect(auditedKinds()).toEqual(['identity_assurance_unavailable']);
  });

  it('reads no evidence and changes nothing for an SP without a minimum', async () => {
    mocks.sp = sp();
    evidence.addEvidence('ev-1', 'IAL1');
    const response = await post(authnRequest(), 'relay-state');
    expect(response.status).toBe(200);
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(evidence.evidenceReads()).toBe(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('applies whether or not tenant-wide assurance is on, and ignores the scope map', async () => {
    mocks.federationSettings = null;
    evidence.addEvidence('ev-1', 'IAL1');
    await post(authnRequest());
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('sends a person who is not signed in to the login page without judging anyone', async () => {
    mocks.sessionId = undefined;
    mocks.sessionResponse = new Response(null, { status: 404 });
    const response = await post(authnRequest());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('https://ui.example.test/login');
    expect(evidence.evidenceReads()).toBe(0);
    expect(mocks.getCoreAdapter).not.toHaveBeenCalled();
  });

  it('judges a ForceAuthn request when it comes back, not before sending the person to sign in again', async () => {
    evidence.addEvidence('ev-1', 'IAL1');
    const response = await post(authnRequest({ forceAuthn: true }));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('force_authn=true');
    expect(evidence.evidenceReads()).toBe(0);
  });

  it('answers IsPassive with a session below the minimum with RequestDenied, not an assertion', async () => {
    evidence.addEvidence('ev-1', 'IAL1');
    await post(authnRequest({ isPassive: true }));
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(errorResponseOptions()).toMatchObject({
      secondLevelStatusCode: 'urn:oasis:names:tc:SAML:2.0:status:RequestDenied',
    });
  });

  it('keeps answering IsPassive without a session with NoPassive', async () => {
    mocks.sessionId = undefined;
    mocks.sessionResponse = new Response(null, { status: 404 });
    await post(authnRequest({ isPassive: true }));
    expect(errorResponseOptions()).toMatchObject({
      secondLevelStatusCode: 'urn:oasis:names:tc:SAML:2.0:status:NoPassive',
    });
    expect(evidence.evidenceReads()).toBe(0);
  });

  it('judges the request that comes back from sign-in (stored request) too', async () => {
    evidence.addEvidence('ev-1', 'IAL1');
    store.seed(storedRequest() as never);
    const response = await app().fetch(
      new Request(
        'https://tenant.example.test/sso?saml_request_id=_request&saml_sp_entity_id=https%3A%2F%2Fsp.example.test%2Fentity&return_to=saml_sso'
      ),
      environment(),
      { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(errorResponseOptions()).toMatchObject({
      secondLevelStatusCode: 'urn:oasis:names:tc:SAML:2.0:status:RequestDenied',
    });
  });

  it('judges again when the person comes back from the consent screen', async () => {
    // The consent POST redirects to this same endpoint, where the evidence is read afresh: a
    // person whose evidence was revoked in between gets no assertion.
    evidence.addEvidence('ev-1', 'IAL2');
    expect((await post(authnRequest())).status).toBe(200);
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    evidence.db
      .prepare('UPDATE assurance_evidence SET revoked_at = ? WHERE id = ?')
      .run(Date.now() - 1, 'ev-1');
    mocks.buildResponse.mockClear();
    await post(authnRequest());
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });
});

describe('assurance attributes in the SP-initiated assertion', () => {
  const IAL1_URI = 'https://example.org/assurance/IAL1';
  const IAL2_URI = 'https://example.org/assurance/IAL2';
  const EDU_PERSON_ASSURANCE = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.11';
  let evidence: EvidenceDb;

  beforeAll(async () => {
    evidence = await createEvidenceDb('user-a');
  });

  beforeEach(() => {
    // Each test sends the request anew (the store refuses an id it knows, as a replay).
    store.reset();
    vi.clearAllMocks();
    evidence.clearEvidence();
    evidence.resetReads();
    evidence.failEvidenceReads(null);
    mocks.evidenceAdapter = evidence.adapter;
    mocks.coreAdapterError = null;
    mocks.sp = sp();
    mocks.shardedSession = true;
    mocks.sessionThrows = false;
    mocks.user = { id: 'user-a', email: 'user@example.test', name: 'User A' };
    mocks.attributeError = null;
    mocks.federationSettings = null;
    mocks.assuranceSettings = {
      'assurance.enabled': true,
      'assurance.ial_assurance_values': JSON.stringify({
        IAL1: [IAL1_URI],
        IAL2: [IAL2_URI, IAL1_URI],
      }),
    };
    mocks.runtimeEdges = [
      {
        id: 'edge.edu',
        sourceRef: {
          side: 'source',
          namespace: 'authrim.profile',
          path: 'edu_person_assurance',
          catalogEntryId: 'system.identity.edu_person_assurance',
        },
        targetRef: {
          side: 'destination',
          namespace: 'saml', // the namespace the mocked binding releases into
          path: EDU_PERSON_ASSURANCE,
          catalogEntryId: 'field.saml.eduPersonAssurance',
        },
      },
    ];
    authenticateSession();
  });

  const subjectGivenToAttributeRelease = () =>
    vi.mocked(buildSAMLAttributesForSPWithDiagnostics).mock.calls.at(-1)?.[0] as unknown as Record<
      string,
      unknown
    >;

  it('hands the values of the person’s IAL to the attribute release when a mapping releases them', async () => {
    evidence.addEvidence('ev-1', 'IAL2');
    const response = await post(authnRequest());
    expect(response.status).toBe(200);
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(subjectGivenToAttributeRelease()).toMatchObject({
      id: 'user-a',
      edu_person_assurance: [IAL1_URI, IAL2_URI],
    });
    expect(evidence.evidenceReads()).toBe(1);
  });

  it('reads the evidence once for the SP’s minimum and the attribute together', async () => {
    mocks.sp = sp({ minimumIal: 'IAL2' });
    evidence.addEvidence('ev-1', 'IAL2');
    await post(authnRequest());
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(subjectGivenToAttributeRelease().edu_person_assurance).toEqual([IAL1_URI, IAL2_URI]);
    expect(evidence.evidenceReads()).toBe(1);
  });

  it('reads nothing while assurance levels are off', async () => {
    mocks.assuranceSettings = { 'assurance.enabled': false };
    evidence.addEvidence('ev-1', 'IAL2');
    await post(authnRequest());
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(subjectGivenToAttributeRelease()).not.toHaveProperty('edu_person_assurance');
    expect(evidence.evidenceReads()).toBe(0);
  });

  it('reads nothing when the mapping releases no assurance source', async () => {
    mocks.runtimeEdges = [];
    evidence.addEvidence('ev-1', 'IAL2');
    await post(authnRequest());
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(evidence.evidenceReads()).toBe(0);
  });

  it('issues the assertion without the attribute, and reports it, when the evidence cannot be read', async () => {
    // Only the evidence cannot be read (the rest of the account database answers).
    evidence.failEvidenceReads(new Error('account_data_route_not_found'));
    const response = await post(authnRequest());
    expect(response.status).toBe(200);
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(subjectGivenToAttributeRelease()).not.toHaveProperty('edu_person_assurance');
  });
});

describe('the stored AuthnRequest lifecycle', () => {
  const SP = 'https://sp.example.test/entity';
  const RESUME_URL = `https://tenant.example.test/sso?saml_request_id=_request&saml_sp_entity_id=${encodeURIComponent(
    SP
  )}&return_to=saml_sso`;
  const sha = async (value: string) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
      (b) => b.toString(16).padStart(2, '0')
    ).join('');
  const resume = (extra = '', ctx?: Record<string, unknown>) =>
    app().request(RESUME_URL + extra, undefined, environment(), ctx as never);

  beforeEach(() => {
    vi.clearAllMocks();
    store.reset();
    mocks.storeFetch.mockReset();
    mocks.storeFetch.mockImplementation(store.fetch);
    mocks.sp = sp();
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    mocks.loginPolicy = 'ui_base_url';
    mocks.shardedSession = true;
    mocks.sessionThrows = false;
    mocks.sessionId = undefined;
    mocks.sessionResponse = new Response(null, { status: 404 });
    mocks.attributeError = null;
    mocks.federationSettings = null;
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    store.seed({ ...storedRequest(), context: {} } as never);
    authenticateSession();
  });

  it('never resumes a request recorded as refused on arrival, even if it was left waiting', async () => {
    store.reset();
    store.seed({ ...storedRequest(), context: { refusedOnArrival: true } } as never);
    const response = await resume();
    expect(await response.text()).not.toContain('SAMLResponse');
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(store.calls).toEqual(['read']);
  });

  it('records a request answered as it arrives, so the same AuthnRequest sent again is refused', async () => {
    store.reset();
    const first = await post(authnRequest());
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('SAMLResponse');
    expect(store.calls).toEqual(['create', 'complete']);
    expect(store.waiting.size).toBe(0);

    mocks.buildResponse.mockClear();
    vi.mocked(getSamlUserInfoById).mockClear();
    const again = await post(authnRequest());
    expect(await again.text()).not.toContain('SAMLResponse');
    // Refused before anything is done for it.
    expect(getSamlUserInfoById).not.toHaveBeenCalled();
    expect(store.calls).toEqual(['create', 'complete', 'create']);
  });

  it('reads a resumed request without using it up, so a failure before answering leaves it waiting', async () => {
    mocks.user = null; // the session's user is gone: the answer cannot be built
    const response = await resume();
    expect(response.status).toBe(400);
    expect(store.calls).toEqual(['read']);
    expect(store.waiting.get('_request')).toMatchObject({ revision: 1 });
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('completes the request right before answering, and answers it only once', async () => {
    const first = await resume();
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('SAMLResponse');
    expect(store.calls).toEqual(['read', 'complete']);
    expect(store.waiting.size).toBe(0);
    const complete = mocks.storeFetch.mock.calls.find(
      ([url]) => url === 'https://saml-request-store/authn/complete'
    );
    expect(JSON.parse(String(complete?.[1]?.body))).toMatchObject({
      spEntityId: SP,
      requestId: '_request',
      expectedRevision: 1,
    });

    // The same resume again finds nothing waiting: it is not found, and nothing is answered.
    const second = await resume();
    expect(second.status).toBe(400);
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(store.calls).toEqual(['read', 'complete', 'read']);
  });

  it('does not answer a request another tab changed after it was read', async () => {
    mocks.buildResponse.mockImplementationOnce(() => {
      // Another tab updates the stored request while this one builds its answer.
      (store.waiting.get('_request') as { revision: number }).revision = 2;
      return '<saml-success-response/>';
    });
    const response = await resume();
    // The SP is not answered (an error page, not a SAML Response).
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain('SAMLResponse');
    expect(store.calls).toEqual(['read', 'complete']);
    // The stale completion changed nothing: the request still waits at its new revision.
    expect(store.waiting.get('_request')).toMatchObject({ revision: 2 });
  });

  it('refuses the same AuthnRequest arriving again once it was stored', async () => {
    store.reset();
    mocks.sessionId = undefined;
    mocks.sessionResponse = new Response(null, { status: 404 });
    const first = await post(authnRequest(), 'relay-state');
    expect(first.status).toBe(302);
    // Recorded as it arrived, then kept for the sign-in.
    expect(store.waiting.get('_request')).toMatchObject({ revision: 2 });

    const again = await post(authnRequest(), 'relay-state');
    expect(again.status).toBe(400);
    expect(again.headers.get('location')).toBeNull();
    expect(store.calls).toEqual(['create', 'update', 'create']);
    expect(store.waiting.size).toBe(1);

    // Nor does answering it make it acceptable again.
    await completeStoredAuthnRequest(environment() as never, 'tenant-a', '_request', SP);
    expect(store.waiting.size).toBe(0);
    expect((await post(authnRequest(), 'relay-state')).status).toBe(400);
    expect(store.waiting.size).toBe(0);
  });

  it('keeps the login nonce hash through the consent page, so a login cancel can still complete it', async () => {
    store.reset();
    // An SP that asks the person.
    mocks.sp = sp({ informationReleaseConsent: { enabled: true, ask: 'once' } });
    // 1. Nobody is signed in: the request is stored and the person is sent to sign in.
    mocks.sessionId = undefined;
    mocks.sessionResponse = new Response(null, { status: 404 });
    const sent = await post(authnRequest(), 'relay-state');
    const nonce = new URL(sent.headers.get('location') ?? '').searchParams.get('saml_login_nonce');
    expect(nonce).toBeTruthy();
    const hash = await sha(nonce ?? '');

    // 2. They come back signed in and are sent to the consent screen: the stored request is
    // updated and waits for that challenge.
    authenticateSession();
    // (The sign-in Flow check of a returning session is not under test here.)
    delete (store.waiting.get('_request')?.context as { sentToSignInAt?: number }).sentToSignInAt;
    const page = await resume(`&saml_login_nonce=${nonce}`, {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    });
    expect(page.status).toBe(302);
    expect(new URL(page.headers.get('location') ?? '').pathname).toBe('/consent');
    expect(store.calls).toEqual(['create', 'update', 'read', 'update']);
    const challenged = store.waiting.get('_request');
    expect(challenged).toMatchObject({ revision: 3, context: { loginNonceHash: hash } });
    const first = (challenged?.context as { releaseConsent?: { challengeId: string } })
      .releaseConsent?.challengeId;
    expect(first).toBeTruthy();

    // 3. They come back without having answered: asked again with a new challenge, the request
    // updated again, still holding the hash.
    const again = await resume();
    expect(again.status).toBe(302);
    const waiting = store.waiting.get('_request');
    expect(waiting).toMatchObject({ revision: 4, context: { loginNonceHash: hash } });
    const second = (waiting?.context as { releaseConsent?: { challengeId: string } }).releaseConsent
      ?.challengeId;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // 4. A login cancel (complete on the nonce hash) still finds it, and only with that hash.
    const env = environment() as never;
    await expect(
      completeStoredAuthnRequest(env, 'tenant-a', '_request', SP, {
        loginNonceHash: await sha('another-nonce'),
      })
    ).rejects.toThrow('not found or already used');
    expect(store.waiting.size).toBe(1);
    await expect(
      completeStoredAuthnRequest(env, 'tenant-a', '_request', SP, { loginNonceHash: hash })
    ).resolves.toMatchObject({ requestId: '_request' });
    expect(store.waiting.size).toBe(0);
  });
});

describe('information release consent on the shared consent screen (SP-initiated)', () => {
  const SP = 'https://sp.example.test/entity';
  const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
  const NAMEID_KEY = samlNameIdItemKey(EMAIL_FORMAT);
  const MAIL_KEY = samlAttributeItemKey({ name: 'mail' });
  const NAME_KEY = samlAttributeItemKey({ name: 'displayName' });
  const RESUME_URL = `https://tenant.example.test/sso?saml_request_id=_request&saml_sp_entity_id=${encodeURIComponent(
    SP
  )}&return_to=saml_sso`;
  const asks = { enabled: true, ask: 'once', show_values: false };

  const resume = () =>
    app().request(RESUME_URL, undefined, environment(), {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    });
  const errorOptions = () =>
    mocks.buildErrorResponse.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  const auditedKinds = () =>
    mocks.audit.mock.calls.map(
      ([, entry]) =>
        (JSON.parse(String((entry as { metadata: string }).metadata)) as { failure_kind: string })
          .failure_kind
    );
  const releasedNames = () =>
    (
      mocks.buildResponse.mock.calls.at(-1)?.[0] as { attributes: Array<{ name: string }> }
    ).attributes.map((attribute) => attribute.name);
  const storedChallengeId = () =>
    (store.waiting.get('_request')?.context as { releaseConsent?: { challengeId: string } })
      ?.releaseConsent?.challengeId;
  /** The consent screen answered: the decision on the challenge, and the record it wrote. */
  const answer = (
    challengeId: string,
    approvedItems: string[],
    declinedItems: string[],
    options: { revision?: number; record?: boolean } = {}
  ) => {
    const revision = options.revision ?? 1;
    // The record the answer was written as (the screen writes it with the answer).
    if (options.record !== false) {
      consentDb.saveReleaseDecision({
        spEntityId: SP,
        presented: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
        approved: approvedItems,
        declined: declinedItems,
        revision,
      });
    }
    challenges.decide(challengeId, {
      approved: true,
      approved_items: approvedItems,
      declined_items: declinedItems,
      decision_revision: revision,
      decided_at: Date.now(),
    });
  };
  const nothingMade = () => {
    expect(resolveSAMLNameIDValue).not.toHaveBeenCalled();
    expect(createSAMLSessionIndex).not.toHaveBeenCalled();
    expect(resolveSAMLEduPersonTargetedIDOpaque).not.toHaveBeenCalled();
    expect(resolveSAMLPersistentNameIDRegistryStore).not.toHaveBeenCalled();
    expect(resolveSAMLTransientNameIDStore).not.toHaveBeenCalled();
  };
  /** The person is signed in and the SP asks: sent to the consent screen, with its challenge. */
  async function sentToTheScreen() {
    const response = await post(authnRequest(), 'relay-state');
    expect(response.status).toBe(302);
    const challengeId = storedChallengeId() as string;
    expect(challengeId).toBeTruthy();
    return { response, challengeId, challenge: challenges.challenges.get(challengeId) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    store.reset();
    mocks.storeFetch.mockReset();
    mocks.storeFetch.mockImplementation(store.fetch);
    mocks.sp = sp({ informationReleaseConsent: asks });
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    mocks.loginPolicy = 'ui_base_url';
    mocks.shardedSession = true;
    mocks.sessionThrows = false;
    mocks.user = { id: 'user-a', email: 'user@example.test', name: 'User A' };
    mocks.attributeError = null;
    mocks.federationSettings = null;
    mocks.attributes = [
      { name: 'mail', values: ['user@example.test'] },
      { name: 'displayName', values: ['User A'] },
    ];
    mocks.requiredNames = ['mail'];
    authenticateSession();
  });

  it('sends a person nobody has asked to the consent screen, and makes no NameID or session index', async () => {
    const { response, challengeId, challenge } = await sentToTheScreen();

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://ui.example.test/consent');
    expect(location.searchParams.get('challenge_id')).toBe(challengeId);
    expect(location.searchParams.get('tenant_hint')).toBe('tenant-a');

    // The challenge is the SAML consent one, with the items the SP would be given.
    expect(challenge).toMatchObject({
      type: 'consent',
      tenantId: 'tenant-a',
      userId: 'user-a',
      consumed: false,
      metadata: {
        protocol: 'saml',
        purpose: 'saml_release_consent',
        session_id: 'session-id',
        saml_request_id: '_request',
        saml_sp_entity_id: SP,
        idp_initiated: false,
        resume_path: `/saml/idp/sso?saml_request_id=_request&saml_sp_entity_id=${encodeURIComponent(
          SP
        )}&return_to=saml_sso`,
        release: { ask: 'once', show_values: false, consent_generation: 0 },
      },
    });
    const release = (
      challenge?.metadata as {
        release: {
          items: Array<{ key: string; required: boolean; values?: string[] }>;
          presentation_key: string;
        };
      }
    ).release;
    expect(release.items.map((item) => [item.key, item.required])).toEqual([
      [samlNameIdItemKey(EMAIL_FORMAT), true],
      [MAIL_KEY, true],
      [NAME_KEY, false],
    ]);
    expect(release.presentation_key).toEqual(expect.any(String));
    // The SP shows no values: none is put on the challenge.
    expect(release.items.every((item) => item.values === undefined)).toBe(true);

    // The request waits for that challenge, and nothing was made for the answer.
    expect(store.calls).toEqual(['create', 'update']);
    expect(store.waiting.get('_request')).toMatchObject({
      revision: 2,
      context: { releaseConsent: { challengeId } },
    });
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(mocks.buildErrorResponse).not.toHaveBeenCalled();
    nothingMade();
    // The challenge never lives past the request itself.
    expect(challenge?.notAfterMs).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it('ends the screen when the request ends, at the tenant request lifetime', async () => {
    mocks.federationSettings = { 'federation.saml_request_ttl': 120 };
    const { challenge } = await sentToTheScreen();
    expect(challenge?.notAfterMs).toBeGreaterThan(Date.now());
    expect(challenge?.notAfterMs).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('shows the values only when the SP says so', async () => {
    mocks.sp = sp({ informationReleaseConsent: { ...asks, show_values: true } });
    const { challenge } = await sentToTheScreen();
    const items = (
      challenge?.metadata as { release: { items: Array<{ key: string; values?: string[] }> } }
    ).release.items;
    expect(items.find((item) => item.key === MAIL_KEY)?.values).toEqual(['user@example.test']);
  });

  it('answers IsPassive with NoPassive when the person would have to be asked', async () => {
    const response = await post(authnRequest({ isPassive: true }), 'relay-state');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(errorOptions()).toMatchObject({
      statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
      secondLevelStatusCode: 'urn:oasis:names:tc:SAML:2.0:status:NoPassive',
    });
    expect(auditedKinds()).toEqual(['release_consent_no_passive']);
    expect(challenges.consentChallenges()).toHaveLength(0);
    expect(store.calls).toEqual(['create', 'complete']);
    expect(store.waiting.size).toBe(0);
    nothingMade();
  });

  it('answers IsPassive with the assertion when nothing has to be asked', async () => {
    mocks.sp = sp({ informationReleaseConsent: { enabled: false } });
    const response = await post(authnRequest({ isPassive: true }), 'relay-state');
    expect(response.status).toBe(200);
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(mocks.buildErrorResponse).not.toHaveBeenCalled();
  });

  it('answers with only the approved items when the person comes back with an approved decision', async () => {
    const { challengeId } = await sentToTheScreen();
    // The person approves the NameID and the mail, and declines the display name.
    answer(challengeId, [NAMEID_KEY, MAIL_KEY], [NAME_KEY]);

    const response = await resume();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(releasedNames()).toEqual(['mail']);
    // The challenge is used up (and only a decided one), the request completed.
    expect(challenges.stub.consumeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        id: challengeId,
        tenantId: 'tenant-a',
        type: 'consent',
        requireDecided: true,
      })
    );
    expect(challenges.challenges.get(challengeId)?.consumed).toBe(true);
    expect(store.waiting.size).toBe(0);
    // The NameID and the session index are made now, once.
    expect(resolveSAMLNameIDValue).toHaveBeenCalledOnce();
    expect(createSAMLSessionIndex).toHaveBeenCalledOnce();
  });

  it('answers RequestDenied and ends the request when the person refused', async () => {
    const { challengeId } = await sentToTheScreen();
    challenges.decide(challengeId, {
      approved: false,
      approved_items: [],
      declined_items: [],
      decided_at: Date.now(),
    });

    const response = await resume();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(errorOptions()).toMatchObject({
      statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
      secondLevelStatusCode: 'urn:oasis:names:tc:SAML:2.0:status:RequestDenied',
    });
    expect(auditedKinds()).toEqual(['release_consent_refused']);
    expect(challenges.challenges.get(challengeId)?.consumed).toBe(true);
    expect(store.waiting.size).toBe(0);
    nothingMade();

    // The same resume again has nothing to answer.
    expect((await resume()).status).toBe(400);
    expect(mocks.buildErrorResponse).toHaveBeenCalledOnce();
  });

  it('asks again, with a new challenge, when the decision is not the current record', async () => {
    const { challengeId } = await sentToTheScreen();
    answer(challengeId, [NAMEID_KEY, MAIL_KEY, NAME_KEY], [], { revision: 1 });
    // The person then refused in another tab: a later decision (revision 2) replaced the one this
    // answer was written as (revision 1), and a refusal answers nothing.
    consentDb.db.exec('DELETE FROM saml_sp_release_consents');
    consentDb.saveReleaseDecision({
      spEntityId: SP,
      presented: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
      approved: [],
      declined: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
      refused: true,
      revision: 2,
    });

    const response = await resume();
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/consent');
    const next = storedChallengeId();
    expect(next).toBeTruthy();
    expect(next).not.toBe(challengeId);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    // The challenge that was answered for another decision is not used up here.
    expect(challenges.challenges.get(challengeId)?.consumed).toBe(false);
    expect(challenges.consentChallenges()).toHaveLength(2);
    nothingMade();
  });

  it('asks again when the answered challenge is not for this request', async () => {
    const { challengeId } = await sentToTheScreen();
    answer(challengeId, [NAMEID_KEY, MAIL_KEY, NAME_KEY], [], { record: false });
    (
      challenges.challenges.get(challengeId)?.metadata as { saml_request_id: string }
    ).saml_request_id = '_another_request';

    const response = await resume();
    expect(response.status).toBe(302);
    expect(storedChallengeId()).not.toBe(challengeId);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('asks again, and does not answer, when the items changed since the person answered', async () => {
    const { challengeId } = await sentToTheScreen();
    answer(challengeId, [NAMEID_KEY, MAIL_KEY, NAME_KEY], []);
    // The SP is now given one more attribute than the screen showed.
    mocks.attributes = [...mocks.attributes, { name: 'affiliation', values: ['staff'] }];

    const response = await resume();
    expect(response.status).toBe(302);
    expect(storedChallengeId()).not.toBe(challengeId);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('issues nothing when the person withdrew between their decision and the answer', async () => {
    const { challengeId } = await sentToTheScreen();
    answer(challengeId, [NAMEID_KEY, MAIL_KEY, NAME_KEY], []);
    // The withdrawal lands after the generation was read for this request, before it is answered.
    const account = consentDb.adapter;
    let reads = 0;
    mocks.evidenceAdapter = {
      ...account,
      queryOne: async (sql: string, params?: unknown[], options?: unknown) => {
        const row = await (account.queryOne as (...args: unknown[]) => Promise<unknown>)(
          sql,
          params,
          options
        );
        if (sql.includes('saml_sp_release_consent_revocations') && (reads += 1) === 1) {
          consentDb.setReleaseGeneration(SP, 1);
        }
        return row;
      },
    };

    const response = await resume();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    // Built (the check is the last one, just before the answer) but not sent: the error response.
    expect(errorOptions()).toMatchObject({
      secondLevelStatusCode: 'urn:oasis:names:tc:SAML:2.0:status:RequestDenied',
    });
    // The answer to the SP carries the failure kind (what a tenant's error override keys on).
    expect(applySAMLErrorResponseOverride).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ failureKind: 'release_consent_withdrawn' })
    );
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(store.waiting.size).toBe(0);
    // The NameID was made for the approval the person gave (the response is built before the
    // last check); what was built is not sent.
  });

  it('does not use a decision made before a withdrawal', async () => {
    consentDb.saveReleaseDecision({
      spEntityId: SP,
      presented: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
      approved: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
      generation: 0,
    });
    consentDb.setReleaseGeneration(SP, 1);
    const response = await post(authnRequest(), 'relay-state');
    expect(response.status).toBe(302);
    expect(challenges.consentChallenges()).toHaveLength(1);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('answers without asking when the person’s earlier decision still answers today’s items', async () => {
    consentDb.saveReleaseDecision({
      spEntityId: SP,
      presented: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
      approved: [NAMEID_KEY, MAIL_KEY],
      declined: [NAME_KEY],
    });
    const response = await post(authnRequest(), 'relay-state');
    expect(response.status).toBe(200);
    expect(challenges.consentChallenges()).toHaveLength(0);
    expect(releasedNames()).toEqual(['mail']);
  });

  it.each([
    ['asks every time', { ...asks, ask: 'every_time' }, {}],
    ['refused it', asks, { refused: true }],
  ])(
    'asks again though the person decided before when the SP %s',
    async (_name, setting, extra) => {
      mocks.sp = sp({ informationReleaseConsent: setting });
      consentDb.saveReleaseDecision({
        spEntityId: SP,
        presented: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
        approved: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
        ...extra,
      });
      const response = await post(authnRequest(), 'relay-state');
      expect(response.status).toBe(302);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
    }
  );

  it('releases only what the SP requires, without asking, when the SP does not ask', async () => {
    mocks.sp = sp({ informationReleaseConsent: { enabled: false } });
    const response = await post(authnRequest(), 'relay-state');
    expect(response.status).toBe(200);
    expect(challenges.consentChallenges()).toHaveLength(0);
    expect(releasedNames()).toEqual(['mail']);
  });

  it('releases everything, without asking, to a trusted SP even if its setting asks', async () => {
    consentDb.trustSP(SP, { trusted: true });
    const response = await post(authnRequest(), 'relay-state');
    expect(response.status).toBe(200);
    expect(challenges.consentChallenges()).toHaveLength(0);
    expect(releasedNames()).toEqual(['mail', 'displayName']);
  });

  it('refuses to release an attribute the SP requires when it was not approved', async () => {
    const { challengeId } = await sentToTheScreen();
    // The (altered) answer leaves the required mail out.
    answer(challengeId, [NAMEID_KEY, NAME_KEY], [MAIL_KEY]);
    const response = await resume();
    expect(response.status).toBe(200);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(errorOptions()).toMatchObject({
      secondLevelStatusCode: 'urn:oasis:names:tc:SAML:2.0:status:InvalidAttrNameOrValue',
    });
  });

  it('shows a pairwise identifier as an item without making it, until it is approved', async () => {
    mocks.sp = sp({ informationReleaseConsent: asks, identityMapping: targetedIdMapping() });
    mocks.requiredNames = ['mail', 'eduPersonTargetedID'];
    const { challengeId, challenge } = await sentToTheScreen();
    const items = (
      challenge?.metadata as { release: { items: Array<{ key: string; deferred?: boolean }> } }
    ).release.items;
    const targetedKey = samlAttributeItemKey({ name: 'eduPersonTargetedID' });
    expect(items.find((item) => item.key === targetedKey)).toMatchObject({ deferred: true });
    // Nothing was made for it while the person is asked.
    expect(mocks.targetedIdOptions).toBeNull();
    nothingMade();

    answer(challengeId, [NAMEID_KEY, MAIL_KEY, NAME_KEY, targetedKey], []);
    expect((await resume()).status).toBe(200);
    // Approved: made once, and released with its real value.
    expect(mocks.targetedIdOptions).toMatchObject({ tenantId: 'tenant-a', spEntityId: SP });
    expect(releasedNames()).toContain('eduPersonTargetedID');
    expect(
      (
        mocks.buildResponse.mock.calls.at(-1)?.[0] as { attributes: Array<{ values: string[] }> }
      ).attributes.flatMap((attribute) => attribute.values)
    ).not.toContain('authrim-deferred-identifier');
  });

  it('answers nothing when the consent state cannot be read', async () => {
    mocks.coreAdapterError = new Error('account_data_route_not_found');
    const response = await post(authnRequest(), 'relay-state');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(challenges.consentChallenges()).toHaveLength(0);
    nothingMade();
  });
});
