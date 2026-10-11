import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvidenceDb, type EvidenceDb } from './helpers/evidence-db';

const mocks = vi.hoisted(() => ({
  sp: null as Record<string, unknown> | null,
  spList: [] as Array<{ id: string; name: string; entityId: string }>,
  cookieSessionId: undefined as string | undefined,
  sharded: true,
  sessionResponse: new Response(null, { status: 404 }),
  sessionThrows: false,
  user: null as Record<string, unknown> | null,
  uiConfig: undefined as { baseUrl: string; paths?: { login?: string } } | undefined,
  loginPolicy: 'ui_base_url' as 'ui_base_url' | 'tenant_host',
  nakedDomain: false,
  runtimeBinding: null as Record<string, unknown> | null,
  buildResponse: vi.fn(() => '<saml-response/>'),
  applySigning: vi.fn(async () => '<signed-response/>'),
  resolveNameId: vi.fn(async () => 'name-id'),
  buildAttributes: vi.fn((_subject?: unknown, _config?: unknown) => [
    { name: 'mail', values: ['user@example.test'] },
  ]),
  filterDestination: vi.fn(
    async (input: {
      attributes: unknown[];
    }): Promise<{
      attributes: unknown[];
      consentApplied: boolean;
      consentRecordId?: string;
      consentEvidence?: Record<string, unknown>;
    }> => ({
      attributes: input.attributes,
      consentApplied: false,
    })
  ),
  coreExecute: vi.fn(async () => ({ rowsAffected: 1 })),
  enforceConsent: vi.fn(async () => undefined),
  audit: vi.fn(async (_env: unknown, _entry: { metadata?: string }) => undefined),
  assuranceSettings: {} as Record<string, unknown>,
  evidenceAdapter: null as unknown,
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
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: {
        fetch: vi.fn(async () => {
          if (mocks.sessionThrows) throw new Error('session unavailable');
          return mocks.sessionResponse.clone();
        }),
      },
    })),
    isShardedSessionId: vi.fn(() => mocks.sharded),
    getUIConfig: vi.fn(async () => mocks.uiConfig),
    buildUIUrl: vi.fn(
      (
        config: { baseUrl: string },
        _path: string,
        query: Record<string, string>,
        tenant?: string
      ) => {
        const url = new URL('/login', config.baseUrl);
        Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
        if (tenant) url.searchParams.set('tenant', tenant);
        return url.toString();
      }
    ),
    usesNakedDomainIssuer: vi.fn(() => mocks.nakedDomain),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({
      execute: mocks.coreExecute,
    })),
    requireAdminDatabaseAdapter: vi.fn(() => ({})),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => mocks.runtimeBinding),
    filterSamlAttributesByDestinationConsentWithStatus: mocks.filterDestination,
    getLogger: () => ({ module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }),
    createAuditLog: mocks.audit,
    resolveEffectiveSettings: vi.fn(async () => mocks.assuranceSettings),
  };
});

vi.mock('../../admin/providers', () => ({
  getSPConfig: vi.fn(async () => mocks.sp),
  listSPConfigs: vi.fn(async () => mocks.spList),
}));

vi.mock('../../common/session-cookie', () => ({
  extractAuthrimSessionIdFromCookieHeader: vi.fn(() => mocks.cookieSessionId),
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

vi.mock('../assertion', () => ({ buildSAMLResponse: mocks.buildResponse }));
vi.mock('../signing', () => ({ applySAMLResponseSigningPolicy: mocks.applySigning }));
vi.mock('../attributes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../attributes')>();
  return { ...actual, buildSAMLAttributesForSP: mocks.buildAttributes };
});
vi.mock('../attribute-release-consent', () => ({
  enforceSAMLAttributeReleaseConsent: mocks.enforceConsent,
}));
vi.mock('../subject', () => ({
  createSAMLSessionIndex: vi.fn(async () => 'session-index'),
  resolveSAMLNameIDValue: mocks.resolveNameId,
  resolveSAMLPairwiseSecret: vi.fn(async () => 'pairwise-secret'),
  resolveSAMLPersistentNameIDRegistryStore: vi.fn(() => undefined),
  resolveSAMLTransientNameIDStore: vi.fn(() => undefined),
}));

import { handleIdPInitiated } from '../idp-initiated';

function baseSp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: 'https://sp.example.test',
    acsUrl: 'https://sp.example.test/acs',
    enabled: true,
    signResponses: true,
    signAssertions: false,
    ...overrides,
  };
}

const consentTransactionId = '12345678-1234-4234-8234-123456789abc';

function context(sp?: string, consentTx?: string, relayState?: string) {
  return {
    env: { STATE_STORE: {} },
    req: {
      query: vi.fn((name: string) => {
        if (name === 'sp') return sp;
        if (name === 'consent_tx') return consentTx;
        if (name === 'relay_state') return relayState;
        return undefined;
      }),
      header: vi.fn((name: string) =>
        name.toLowerCase() === 'cookie' && mocks.cookieSessionId
          ? 'authrim_session=test'
          : undefined
      ),
    },
    get: vi.fn((name: string) => (name === 'tenantId' ? 'tenant-a' : undefined)),
    html: vi.fn((body: string) => new Response(body, { headers: { 'Content-Type': 'text/html' } })),
    json: vi.fn(
      (body: unknown, status: number = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
    redirect: vi.fn((location: string) =>
      Response.redirect(location.startsWith('http') ? location : `https://fallback.test${location}`)
    ),
  } as never;
}

describe('IdP-initiated SSO', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sp = baseSp();
    mocks.spList = [];
    mocks.cookieSessionId = undefined;
    mocks.sharded = true;
    mocks.sessionResponse = new Response(null, { status: 404 });
    mocks.sessionThrows = false;
    mocks.user = null;
    mocks.uiConfig = undefined;
    mocks.loginPolicy = 'ui_base_url';
    mocks.nakedDomain = false;
    mocks.runtimeBinding = null;
  });

  it('renders an empty SP selection without reflecting unsafe markup', async () => {
    let response = await handleIdPInitiated(context());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('No service providers configured');

    mocks.spList = [
      {
        id: 'sp-1',
        name: '<script>unsafe & name</script>',
        entityId: 'https://sp.example.test/?a=1&b=2',
      },
    ];
    response = await handleIdPInitiated(context());
    const html = await response.text();
    expect(html).toContain('&lt;script&gt;unsafe &amp; name&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('does not disclose an unknown SP', async () => {
    mocks.sp = null;
    const response = await handleIdPInitiated(context('unknown'));
    expect(response.status).toBe(404);
  });

  it('redirects unauthenticated users to the UI login', async () => {
    mocks.uiConfig = { baseUrl: 'https://ui.example.test' };
    const response = await handleIdPInitiated(
      context('https://sp.example.test', consentTransactionId)
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('https://ui.example.test/login');
    expect(response.headers.get('location')).toContain('return_to=');
  });

  it('preserves RelayState through the interactive login redirect', async () => {
    mocks.uiConfig = { baseUrl: 'https://ui.example.test' };
    const relayState = 'https://sp.example.test/home';
    const response = await handleIdPInitiated(
      context('https://sp.example.test', consentTransactionId, relayState)
    );
    const returnTo = new URL(response.headers.get('location') ?? '').searchParams.get('return_to');

    expect(returnTo).not.toBeNull();
    expect(new URL(returnTo ?? '').searchParams.get('relay_state')).toBe(relayState);
  });

  it('rejects RelayState values over the SAML binding limit', async () => {
    const response = await handleIdPInitiated(
      context('https://sp.example.test', consentTransactionId, 'a'.repeat(81))
    );

    expect(response.status).toBe(400);
  });

  it('fails safely when no interactive UI is configured', async () => {
    const response = await handleIdPInitiated(
      context('https://sp.example.test', consentTransactionId)
    );
    expect(response.status).toBe(500);
  });

  it.each([
    ['tenant_host', false, 'https://tenant.example.test/custom-login', false],
    ['ui_base_url', false, 'https://ui.example.test/login', true],
    ['ui_base_url', true, 'https://ui.example.test/login', false],
  ] as const)(
    'builds a constrained %s login redirect',
    async (policy, naked, expectedPrefix, expectsTenant) => {
      mocks.uiConfig = { baseUrl: 'https://ui.example.test', paths: { login: '/custom-login' } };
      mocks.loginPolicy = policy;
      mocks.nakedDomain = naked;
      const response = await handleIdPInitiated(context('https://sp.example.test'));
      const location = response.headers.get('location') ?? '';
      expect(location).toContain(expectedPrefix);
      expect(location.includes('tenant=tenant-a')).toBe(expectsTenant);
    }
  );

  it.each([
    ['not sharded', false, false, new Response(null, { status: 200 })],
    ['store throws', true, true, new Response(null, { status: 200 })],
    ['store rejects', true, false, new Response(null, { status: 401 })],
    [
      'session has no user',
      true,
      false,
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ],
  ] as const)('treats %s as unauthenticated', async (_name, sharded, throws, response) => {
    mocks.cookieSessionId = 'session-id';
    mocks.sharded = sharded;
    mocks.sessionThrows = throws;
    mocks.sessionResponse = response;
    mocks.uiConfig = { baseUrl: 'https://ui.example.test' };
    const result = await handleIdPInitiated(context('https://sp.example.test'));
    expect(result.headers.get('location')).toContain('https://ui.example.test/login');
  });

  it('routes an authenticated IdP-initiated request through generic destination consent', async () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.uiConfig = { baseUrl: 'https://ui.example.test' };

    const response = await handleIdPInitiated(context('https://sp.example.test'));
    const location = response.headers.get('location') ?? '';

    expect(response.status).toBe(302);
    expect(location).toContain('https://ui.example.test/login');
    expect(location).toContain('saml_request_id=');
    expect(location).toContain('saml_sp_entity_id=https%3A%2F%2Fsp.example.test');
    expect(location).toContain('consent_tx%3D');
  });

  it('rejects an authenticated session whose user no longer exists', async () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(
      JSON.stringify({ userId: 'deleted-user', data: { acr: 123, amr: 'pwd' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    const response = await handleIdPInitiated(
      context('https://sp.example.test', consentTransactionId)
    );
    expect(response.status).toBe(404);
  });

  it('issues a signed response using configured identity mapping', async () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(
      JSON.stringify({ userId: 'user-a', data: { acr: 'loa2', amr: ['pwd', 1, 'mfa'] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.sp = baseSp({
      identityMapping: { catalog: { entries: [] } },
      nameIdFormat: undefined,
      assertionValiditySeconds: 0,
    });

    const response = await handleIdPInitiated(
      context('https://sp.example.test', consentTransactionId)
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildResponse).toHaveBeenCalledWith(
      expect.objectContaining({ nameId: 'name-id' })
    );
    const calls = mocks.buildResponse.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0]?.[0]).not.toHaveProperty('inResponseTo');
    expect(mocks.applySigning).toHaveBeenCalled();
  });

  describe('assertion lifetime', () => {
    async function lifetimeSeconds(
      sp: Record<string, unknown>,
      federation: Record<string, unknown> | null
    ): Promise<number> {
      mocks.cookieSessionId = 'session-id';
      mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      mocks.user = { id: 'user-a', email: 'user@example.test' };
      mocks.sp = baseSp({ identityMapping: { catalog: { entries: [] } }, ...sp });
      const ctx = context('https://sp.example.test', consentTransactionId);
      (ctx as unknown as { env: Record<string, unknown> }).env.SETTINGS = {
        get: vi.fn(async (key: string) =>
          key === 'settings:tenant:tenant-a:federation' && federation
            ? JSON.stringify(federation)
            : null
        ),
      };
      expect((await handleIdPInitiated(ctx)).status).toBe(200);
      const input = (
        mocks.buildResponse.mock.calls.at(-1) as unknown as [Record<string, string>]
      )[0];
      return (Date.parse(input.notOnOrAfter) - Date.parse(input.issueInstant)) / 1000;
    }

    it('is five minutes where nothing is set', async () => {
      expect(await lifetimeSeconds({}, null)).toBe(300);
    });

    it("is the tenant's when the service provider has none", async () => {
      expect(await lifetimeSeconds({}, { 'federation.saml_assertion_ttl': 120 })).toBe(120);
    });

    it("is the service provider's own when it has one", async () => {
      expect(
        await lifetimeSeconds(
          { assertionValiditySeconds: 90 },
          { 'federation.saml_assertion_ttl': 120 }
        )
      ).toBe(90);
    });
  });

  it('includes RelayState in the response sent to the service provider', async () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.sp = baseSp({ identityMapping: { catalog: { entries: [] } } });
    const relayState = 'https://sp.example.test/home';

    const response = await handleIdPInitiated(
      context('https://sp.example.test', consentTransactionId, relayState)
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('RelayState');
    expect(html).toContain(relayState);
  });

  it('loads runtime identity mapping and applies signing policy', async () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.runtimeBinding = {
      id: 'binding',
      tenantId: 'tenant-a',
      catalog: { entries: [] },
      edges: [],
      transforms: [],
      validationRules: [],
      fieldMappingSet: {},
      fieldMappingSetId: 'set',
      fieldMappingVersionId: 'version',
      destinationNamespace: 'saml',
      sourceProfileId: 'source',
      destinationProfileId: 'destination',
      destinationProfileIds: ['destination'],
    };
    mocks.sp = baseSp({
      signResponses: true,
      assertionValiditySeconds: 120,
      attributeReleaseConsent: { enabled: true, mode: 'every_time' },
      identityMapping: {
        fieldMappingSetId: 'set',
        destinationNamespace: 'override',
        sourceProfileId: 'source-override',
        destinationProfileId: 'destination-override',
        destinationFieldPolicies: { mail: 'required' },
      },
    });
    mocks.filterDestination.mockResolvedValueOnce({
      attributes: [{ name: 'mail', values: ['user@example.test'] }],
      consentApplied: true,
      consentRecordId: 'destination-consent-1',
      consentEvidence: { saml_request_id: consentTransactionId },
    });
    const response = await handleIdPInitiated(
      context('https://sp.example.test', consentTransactionId)
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('PHNpZ25lZC1yZXNwb25zZS8+');
    expect(mocks.applySigning).toHaveBeenCalled();
    expect(mocks.filterDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'destination',
        fieldPolicies: { mail: 'required' },
        releaseSafetyBinding: expect.objectContaining({
          fieldMappingSetId: 'set',
          destinationProfileId: 'destination',
        }),
      })
    );
    expect(mocks.enforceConsent).toHaveBeenCalled();
    expect(mocks.coreExecute).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'superseded'"),
      expect.arrayContaining(['destination-consent-1', 'tenant-a', 'user-a'])
    );
  });

  it('fails closed when runtime identity mapping is missing', async () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    const response = await handleIdPInitiated(
      context('https://sp.example.test', consentTransactionId)
    );
    expect(response.status).toBe(500);
  });
});

describe('IdP-initiated SSO and identity assurance', () => {
  const IAL1_URI = 'https://example.org/assurance/IAL1';
  const IAL2_URI = 'https://example.org/assurance/IAL2';
  const EDU_PERSON_ASSURANCE = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.11';
  let evidence: EvidenceDb;

  beforeAll(async () => {
    evidence = await createEvidenceDb('user-a');
  });

  const sessionFor = (userId = 'user-a') => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId, data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const auditedFailureKind = () =>
    (JSON.parse(mocks.audit.mock.calls[0]?.[1].metadata ?? '{}') as { failure_kind?: string })
      .failure_kind;
  const eduMapping = () => ({
    catalog: { entries: [] },
    edges: [
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
          namespace: 'saml.attribute',
          path: EDU_PERSON_ASSURANCE,
          catalogEntryId: 'field.saml.eduPersonAssurance',
        },
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    evidence.clearEvidence();
    evidence.resetReads();
    mocks.evidenceAdapter = evidence.adapter;
    mocks.coreAdapterError = null;
    mocks.sp = baseSp({ minimumIal: 'IAL2', identityMapping: { catalog: { entries: [] } } });
    mocks.spList = [];
    mocks.cookieSessionId = undefined;
    mocks.sharded = true;
    mocks.sessionThrows = false;
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.uiConfig = { baseUrl: 'https://ui.example.test' };
    mocks.loginPolicy = 'ui_base_url';
    mocks.nakedDomain = false;
    mocks.runtimeBinding = null;
    mocks.assuranceSettings = {};
    sessionFor();
  });

  describe('the SP minimum IAL', () => {
    it('shows the error page and builds no assertion for a person below it', async () => {
      evidence.addEvidence('ev-1', 'IAL1');
      const response = await handleIdPInitiated(
        context('https://sp.example.test', consentTransactionId, 'relay')
      );

      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).not.toContain('SAMLResponse');
      expect(body).not.toMatch(/IAL|assurance/i);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(mocks.applySigning).not.toHaveBeenCalled();
      expect(mocks.resolveNameId).not.toHaveBeenCalled();
      expect(mocks.filterDestination).not.toHaveBeenCalled();
      expect(mocks.enforceConsent).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledOnce();
      expect(auditedFailureKind()).toBe('identity_assurance_insufficient');
    });

    it('judges a signed-in person before sending them through the consent flow', async () => {
      evidence.addEvidence('ev-1', 'IAL1');
      const response = await handleIdPInitiated(context('https://sp.example.test'));
      expect(response.status).toBe(403);
      expect(response.headers.get('location')).toBeNull();
    });

    it('lets a person at the minimum on to the consent flow and then to the assertion', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      const toConsent = await handleIdPInitiated(context('https://sp.example.test'));
      expect(toConsent.status).toBe(302);
      expect(toConsent.headers.get('location')).toContain('https://ui.example.test/login');

      const response = await handleIdPInitiated(
        context('https://sp.example.test', consentTransactionId)
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('SAMLResponse');
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
    });

    it('stops a person whose evidence was revoked after they passed the first check', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      expect(
        (await handleIdPInitiated(context('https://sp.example.test'))).headers.get('location')
      ).toContain('https://ui.example.test/login');
      evidence.db
        .prepare('UPDATE assurance_evidence SET revoked_at = ? WHERE id = ?')
        .run(Date.now() - 1, 'ev-1');
      const response = await handleIdPInitiated(
        context('https://sp.example.test', consentTransactionId)
      );
      expect(response.status).toBe(403);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
    });

    it('does not take an unreadable minimum for none', async () => {
      mocks.sp = baseSp({ minimumIal: 'bogus', identityMapping: { catalog: { entries: [] } } });
      evidence.addEvidence('ev-1', 'IAL2');
      const response = await handleIdPInitiated(
        context('https://sp.example.test', consentTransactionId)
      );
      expect(response.status).toBe(403);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
    });

    it('refuses with a server error, not as a person below the minimum, when the evidence cannot be read', async () => {
      evidence.addEvidence('ev-1', 'IAL3');
      mocks.coreAdapterError = new Error('account_data_route_not_found');
      const response = await handleIdPInitiated(
        context('https://sp.example.test', consentTransactionId)
      );
      expect(response.status).toBe(500);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(auditedFailureKind()).toBe('identity_assurance_unavailable');
    });

    it('sends a person who is not signed in to sign in, judging no one', async () => {
      mocks.cookieSessionId = undefined;
      const response = await handleIdPInitiated(
        context('https://sp.example.test', consentTransactionId)
      );
      expect(response.status).toBe(302);
      expect(evidence.evidenceReads()).toBe(0);
      expect(mocks.getCoreAdapter).not.toHaveBeenCalled();
    });

    it('reads no evidence and changes nothing for an SP without a minimum', async () => {
      mocks.sp = baseSp({ identityMapping: { catalog: { entries: [] } } });
      evidence.addEvidence('ev-1', 'IAL1');
      const response = await handleIdPInitiated(
        context('https://sp.example.test', consentTransactionId)
      );
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(evidence.evidenceReads()).toBe(0);
      expect(mocks.getCoreAdapter).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    });
  });

  describe('the assurance attributes', () => {
    beforeEach(() => {
      mocks.sp = baseSp({ identityMapping: eduMapping() });
      mocks.assuranceSettings = {
        'assurance.enabled': true,
        'assurance.ial_assurance_values': JSON.stringify({
          IAL1: [IAL1_URI],
          IAL2: [IAL2_URI, IAL1_URI],
        }),
      };
    });
    const subjectGivenToAttributeRelease = () =>
      mocks.buildAttributes.mock.calls.at(-1)?.[0] as Record<string, unknown>;

    it('hands the values of the person’s IAL to the attribute release', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      await handleIdPInitiated(context('https://sp.example.test', consentTransactionId));
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(subjectGivenToAttributeRelease().edu_person_assurance).toEqual([IAL1_URI, IAL2_URI]);
      expect(evidence.evidenceReads()).toBe(1);
    });

    it('gives the attribute release the tenant, so a tenant-bound mapping binding matches', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      await handleIdPInitiated(context('https://sp.example.test', consentTransactionId));
      const releaseConfig = mocks.buildAttributes.mock.calls.at(-1)?.[1] as { tenantId?: string };
      expect(releaseConfig.tenantId).toEqual(expect.any(String));
      expect(releaseConfig.tenantId).not.toBe('');
    });

    it('reads the evidence once for the minimum and the attribute together', async () => {
      mocks.sp = baseSp({ identityMapping: eduMapping(), minimumIal: 'IAL2' });
      evidence.addEvidence('ev-1', 'IAL2');
      await handleIdPInitiated(context('https://sp.example.test', consentTransactionId));
      expect(subjectGivenToAttributeRelease().edu_person_assurance).toEqual([IAL1_URI, IAL2_URI]);
      expect(evidence.evidenceReads()).toBe(1);
    });

    it('reads nothing while assurance levels are off', async () => {
      mocks.assuranceSettings = { 'assurance.enabled': false };
      evidence.addEvidence('ev-1', 'IAL2');
      await handleIdPInitiated(context('https://sp.example.test', consentTransactionId));
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(subjectGivenToAttributeRelease()).not.toHaveProperty('edu_person_assurance');
      expect(evidence.evidenceReads()).toBe(0);
    });

    it('releases no attribute, and still issues the assertion, when the evidence cannot be read', async () => {
      mocks.coreAdapterError = new Error('account_data_route_not_found');
      await handleIdPInitiated(context('https://sp.example.test', consentTransactionId));
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(subjectGivenToAttributeRelease()).not.toHaveProperty('edu_person_assurance');
    });
  });
});
