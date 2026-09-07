import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sp: null as Record<string, unknown> | null,
  spList: [] as Array<{ id: string; name: string; entityId: string }>,
  cookieSessionId: undefined as string | undefined,
  sharded: true,
  sessionResponse: new Response(null, { status: 404 }),
  sessionThrows: false,
  user: null as Record<string, unknown> | null,
  builtin: false,
  uiConfig: undefined as { baseUrl: string; paths?: { login?: string } } | undefined,
  loginPolicy: 'ui_base_url' as 'ui_base_url' | 'tenant_host',
  nakedDomain: false,
  runtimeBinding: null as Record<string, unknown> | null,
  buildResponse: vi.fn(() => '<saml-response/>'),
  applySigning: vi.fn(async () => '<signed-response/>'),
  resolveNameId: vi.fn(async () => 'name-id'),
  buildAttributes: vi.fn(() => [{ name: 'mail', values: ['user@example.test'] }]),
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
    shouldUseBuiltinForms: vi.fn(async () => mocks.builtin),
    usesNakedDomainIssuer: vi.fn(() => mocks.nakedDomain),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({
      execute: mocks.coreExecute,
    })),
    requireAdminDatabaseAdapter: vi.fn(() => ({})),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => mocks.runtimeBinding),
    filterSamlAttributesByDestinationConsentWithStatus: mocks.filterDestination,
    getLogger: () => ({ module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }),
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
    mocks.builtin = false;
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

  it('redirects unauthenticated users to builtin login when enabled', async () => {
    mocks.builtin = true;
    const response = await handleIdPInitiated(
      context('https://sp.example.test', consentTransactionId)
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/flow/login');
    expect(response.headers.get('location')).toContain('return_to=');
  });

  it('preserves RelayState through the interactive login redirect', async () => {
    mocks.builtin = true;
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
    mocks.builtin = true;
    const result = await handleIdPInitiated(context('https://sp.example.test'));
    expect(result.headers.get('location')).toContain('/flow/login');
  });

  it('routes an authenticated IdP-initiated request through generic destination consent', async () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.builtin = true;

    const response = await handleIdPInitiated(context('https://sp.example.test'));
    const location = response.headers.get('location') ?? '';

    expect(response.status).toBe(302);
    expect(location).toContain('/flow/login');
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
