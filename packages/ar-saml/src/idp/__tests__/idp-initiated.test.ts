import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvidenceDb, type EvidenceDb } from './helpers/evidence-db';
import { createSamlRequestStoreFake } from './helpers/saml-request-store-fake';
import { createChallengeStoreFake } from './helpers/challenge-store-fake';
import { samlAttributeItemKey, samlNameIdItemKey } from '../release-items';

// The SAML request store (the pending sign-ins) and the ChallengeStore (the consent screen's
// challenges), as the real Durable Objects keep them.
const requestStore = createSamlRequestStoreFake();
const challenges = createChallengeStoreFake();

const mocks = vi.hoisted(() => ({
  sp: null as Record<string, unknown> | null,
  spList: [] as Array<{ id: string; name: string; entityId: string }>,
  cookieSessionId: undefined as string | undefined,
  sharded: true,
  sessionResponse: new Response(null, { status: 404 }),
  sessionThrows: false,
  user: null as Record<string, unknown> | null,
  uiConfig: undefined as { baseUrl: string; paths?: { login?: string } } | undefined,
  loginPolicy: 'ui_base_url',
  nakedDomain: false,
  runtimeBinding: null as Record<string, unknown> | null,
  buildResponse: vi.fn((..._args: unknown[]) => '<saml-response/>'),
  applySigning: vi.fn(async () => '<signed-response/>'),
  resolveNameId: vi.fn(async () => 'name-id'),
  buildAttributes: vi.fn((_subject?: unknown, _config?: unknown) => [
    { name: 'mail', values: ['user@example.test'] },
  ]),
  // The Destination Profile offers every attribute and requires the ones in `requiredNames`
  // (all of them when null).
  filterDestination: vi.fn(
    async (input: {
      attributes: Array<{ name: string }>;
    }): Promise<{
      attributes: Array<{ name: string }>;
      required: Set<string>;
      labels: Map<string, string>;
    }> => ({
      attributes: input.attributes,
      required: new Set(mocks.requiredNames ?? input.attributes.map((attribute) => attribute.name)),
      labels: new Map<string, string>(),
    })
  ),
  requiredNames: null as string[] | null,
  /** The tenant's metadata database (trust policies, Flow assignments, statement versions). */
  metadataAdapter: null as unknown,
  audit: vi.fn(async (_env: unknown, _entry: { metadata?: string }) => undefined),
  assuranceSettings: {},
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
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.metadataAdapter),
    // Reads the Destination Profile (to give the mapping its destination catalog entries): none here.
    requireAdminDatabaseAdapter: vi.fn(() => ({ queryOne: vi.fn(async () => null) })),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => mocks.runtimeBinding),
    filterSamlAttributesByDestinationProfile: mocks.filterDestination,
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
  return {
    ...actual,
    buildSAMLAttributesForSP: mocks.buildAttributes,
    buildSAMLAttributesForSPWithDiagnostics: (subject: unknown, config: unknown) => ({
      attributes: mocks.buildAttributes(subject, config),
      optionalMissingAttributes: [],
    }),
  };
});
vi.mock('../subject', () => ({
  createSAMLSessionIndex: vi.fn(async () => 'session-index'),
  resolveSAMLNameIDValue: mocks.resolveNameId,
  resolveSAMLPairwiseSecret: vi.fn(async () => 'pairwise-secret'),
  resolveSAMLPairwiseSecretForRef: vi.fn(async () => 'referenced-secret'),
  resolveSAMLEduPersonTargetedIDOpaque: vi.fn(async () => 'targeted-id'),
  resolveSAMLPersistentNameIDRegistryStore: vi.fn(() => undefined),
  resolveSAMLTransientNameIDStore: vi.fn(() => undefined),
}));

import { Hono } from 'hono';
import { handleIdPInitiated } from '../idp-initiated';
import { handleIdPSSO } from '../sso';

function baseSp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: 'https://sp.example.test',
    acsUrl: 'https://sp.example.test/acs',
    enabled: true,
    signResponses: true,
    signAssertions: false,
    // The SP does not ask the person unless a test says so (see the consent tests below).
    informationReleaseConsent: { enabled: false },
    ...overrides,
  };
}

/** The environment of the Worker: the stores the IdP keeps its pending sign-ins and challenges in. */
function environment() {
  return {
    STATE_STORE: {},
    SETTINGS: { get: vi.fn(async () => null) },
    SAML_REQUEST_STORE: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: requestStore.fetch })),
    },
    CHALLENGE_STORE: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => challenges.stub),
    },
  };
}

/** A request to /saml/idp/init: `pending` is the sign-in the person comes back with. */
function context(sp?: string, relayState?: string, pending?: string) {
  return {
    env: environment(),
    req: {
      query: vi.fn((name: string) => {
        if (name === 'sp') return sp;
        if (name === 'relay_state') return relayState;
        if (name === 'pending') return pending;
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

// One real SQLite with the core schema serves as the account database (release decisions,
// withdrawal generations, assurance evidence) and the tenant's metadata database (trust policies,
// Flow assignments, consent statement versions).
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
  mocks.requiredNames = null;
  requestStore.reset();
  challenges.reset();
});

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

  it('redirects unauthenticated users to the UI login, keeping a pending sign-in for their return', async () => {
    mocks.uiConfig = { baseUrl: 'https://ui.example.test' };
    const response = await handleIdPInitiated(context('https://sp.example.test'));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://ui.example.test/login');

    // The first request kept a pending sign-in: its ID is not an SP's AuthnRequest ID.
    expect(requestStore.calls).toEqual(['create']);
    const [pendingId] = [...requestStore.waiting.keys()];
    expect(pendingId).toMatch(/^_idpinit_[0-9a-f-]{36}$/u);
    expect(requestStore.waiting.get(pendingId)).toMatchObject({
      type: 'authn_request',
      issuer: 'https://sp.example.test',
      revision: 1,
      used: false,
      context: { idpInitiated: true },
    });
    expect(location.searchParams.get('saml_request_id')).toBe(pendingId);
    expect(location.searchParams.get('saml_sp_entity_id')).toBe('https://sp.example.test');
    // The person comes back to this endpoint, with the pending sign-in's ID.
    const returnTo = new URL(location.searchParams.get('return_to') ?? '');
    expect(returnTo.origin + returnTo.pathname).toBe('https://tenant.example.test/saml/idp/init');
    expect(returnTo.searchParams.get('sp')).toBe('https://sp.example.test');
    expect(returnTo.searchParams.get('pending')).toBe(pendingId);
  });

  it('keeps RelayState with the pending sign-in, and sends it with the response once they are back', async () => {
    mocks.uiConfig = { baseUrl: 'https://ui.example.test' };
    const relayState = 'https://sp.example.test/home';
    const response = await handleIdPInitiated(context('https://sp.example.test', relayState));
    const location = new URL(response.headers.get('location') ?? '');
    const pendingId = location.searchParams.get('saml_request_id') ?? '';
    // Held by the server, not carried through the login page's URL.
    expect(requestStore.waiting.get(pendingId)).toMatchObject({ relayState });
    expect(location.toString()).not.toContain(encodeURIComponent(relayState));

    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.sp = baseSp({ identityMapping: { catalog: { entries: [] } } });
    const back = await handleIdPInitiated(context('https://sp.example.test', undefined, pendingId));
    const html = await back.text();
    expect(back.status).toBe(200);
    expect(html).toContain('RelayState');
    expect(html).toContain(relayState);
  });

  it('rejects RelayState values over the SAML binding limit', async () => {
    const response = await handleIdPInitiated(context('https://sp.example.test', 'a'.repeat(81)));

    expect(response.status).toBe(400);
  });

  it('fails safely when no interactive UI is configured', async () => {
    const response = await handleIdPInitiated(context('https://sp.example.test'));
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

  it('sends an authenticated person whose SP asks to the consent screen, making no NameID', async () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.uiConfig = { baseUrl: 'https://ui.example.test' };
    mocks.sp = baseSp({
      identityMapping: { catalog: { entries: [] } },
      informationReleaseConsent: { enabled: true, ask: 'once' },
    });

    const response = await handleIdPInitiated(context('https://sp.example.test'));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://ui.example.test/consent');

    // The pending sign-in waits for that challenge.
    const [pendingId] = [...requestStore.waiting.keys()];
    const challengeId = location.searchParams.get('challenge_id') ?? '';
    expect(requestStore.waiting.get(pendingId)).toMatchObject({
      revision: 2,
      context: { idpInitiated: true, releaseConsent: { challengeId } },
    });
    expect(challenges.challenges.get(challengeId)).toMatchObject({
      type: 'consent',
      userId: 'user-a',
      metadata: {
        protocol: 'saml',
        saml_request_id: pendingId,
        saml_sp_entity_id: 'https://sp.example.test',
        idp_initiated: true,
        resume_path: `/saml/idp/init?${new URLSearchParams({
          sp: 'https://sp.example.test',
          pending: pendingId,
        })}`,
        session_id: 'session-id',
        release: {
          items: [
            expect.objectContaining({ kind: 'nameid', required: true }),
            expect.objectContaining({ kind: 'attribute', required: true }),
          ],
        },
      },
    });
    // Nothing was made for the answer, and none was sent.
    expect(mocks.resolveNameId).not.toHaveBeenCalled();
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('rejects an authenticated session whose user no longer exists', async () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(
      JSON.stringify({ userId: 'deleted-user', data: { acr: 123, amr: 'pwd' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    const response = await handleIdPInitiated(context('https://sp.example.test'));
    expect(response.status).toBe(404);
    // The pending sign-in was used up: it is not answered later.
    expect(requestStore.waiting.size).toBe(0);
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

    const response = await handleIdPInitiated(context('https://sp.example.test'));
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
      const ctx = context('https://sp.example.test');
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

  describe('AuthnInstant', () => {
    const MINUTE = 60_000;
    /** An instant as the assertion states it (whole seconds, UTC). */
    const stated = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

    async function answeredWith(session: Record<string, unknown>) {
      mocks.cookieSessionId = 'session-id';
      mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a', ...session }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      mocks.user = { id: 'user-a', email: 'user@example.test' };
      mocks.sp = baseSp({ identityMapping: { catalog: { entries: [] } } });
      // Each answer is a new assertion: never the timing of an earlier request.
      mocks.buildResponse.mockClear();
      expect((await handleIdPInitiated(context('https://sp.example.test'))).status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      return (
        mocks.buildResponse.mock.calls.at(-1) as unknown as [
          { authnInstant: string; issueInstant: string },
        ]
      )[0];
    }

    it('is the time of a fresh sign-in', async () => {
      const provenAt = Date.now() - 4 * MINUTE;
      const timing = await answeredWith({ data: { amr: ['pwd'], proven_at: provenAt } });
      expect(timing.authnInstant).toBe(stated(provenAt));
      expect(Date.parse(timing.authnInstant)).toBeLessThanOrEqual(Date.parse(timing.issueInstant));
    });

    it('stays the time of the sign-in when an old session is reused', async () => {
      const provenAt = Date.now() - 5 * 3_600_000;
      const timing = await answeredWith({ data: { amr: ['pwd'], proven_at: provenAt } });
      expect(timing.authnInstant).toBe(stated(provenAt));
      expect(timing.authnInstant).not.toBe(timing.issueInstant);
    });

    it('is the time of a re-authentication completed in the session after its sign-in', async () => {
      const reauthAt = Date.now() - 2 * MINUTE;
      const timing = await answeredWith({
        data: {
          amr: ['pwd', 'totp'],
          proven_at: Date.now() - 5 * 3_600_000,
          reauth_proven_amr: ['totp'],
          reauth_proven_at: reauthAt,
        },
      });
      expect(timing.authnInstant).toBe(stated(reauthAt));
    });

    it('falls back to the session login time, then its creation time, then the issue instant', async () => {
      const authTime = Math.floor((Date.now() - 80 * MINUTE) / 1000);
      expect((await answeredWith({ data: { amr: ['pwd'], authTime } })).authnInstant).toBe(
        stated(authTime * 1000)
      );

      const createdAt = Date.now() - 30 * MINUTE;
      expect(
        (await answeredWith({ createdAt, data: { amr: ['external_idp'] } })).authnInstant
      ).toBe(stated(createdAt));

      const unknown = await answeredWith({ data: { amr: ['external_idp'] } });
      expect(unknown.authnInstant).toBe(unknown.issueInstant);
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

    const response = await handleIdPInitiated(context('https://sp.example.test', relayState));
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
      identityMapping: {
        fieldMappingSetId: 'set',
        destinationNamespace: 'override',
        sourceProfileId: 'source-override',
        destinationProfileId: 'destination-override',
        destinationFieldPolicies: { mail: 'required' },
      },
    });
    const response = await handleIdPInitiated(context('https://sp.example.test'));
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
  });

  it('fails closed when runtime identity mapping is missing', async () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    const response = await handleIdPInitiated(context('https://sp.example.test'));
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
    evidence.failEvidenceReads(null);
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
      const response = await handleIdPInitiated(context('https://sp.example.test', 'relay'));

      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).not.toContain('SAMLResponse');
      expect(body).not.toMatch(/IAL|assurance/i);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(mocks.applySigning).not.toHaveBeenCalled();
      expect(mocks.resolveNameId).not.toHaveBeenCalled();
      expect(mocks.filterDestination).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledOnce();
      expect(auditedFailureKind()).toBe('identity_assurance_insufficient');
    });

    it('judges a signed-in person on the first request, before anything is released or asked', async () => {
      mocks.sp = baseSp({
        minimumIal: 'IAL2',
        identityMapping: { catalog: { entries: [] } },
        informationReleaseConsent: { enabled: true },
      });
      evidence.addEvidence('ev-1', 'IAL1');
      const response = await handleIdPInitiated(context('https://sp.example.test'));
      expect(response.status).toBe(403);
      expect(response.headers.get('location')).toBeNull();
      // The pending sign-in is used up, and no consent screen was prepared.
      expect(requestStore.waiting.size).toBe(0);
      expect(challenges.consentChallenges()).toHaveLength(0);
    });

    it('lets a person at the minimum who signs in on to the assertion', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      mocks.cookieSessionId = undefined;
      const toLogin = await handleIdPInitiated(context('https://sp.example.test'));
      expect(toLogin.status).toBe(302);
      expect(toLogin.headers.get('location')).toContain('https://ui.example.test/login');
      expect(evidence.evidenceReads()).toBe(0);
      const [pendingId] = [...requestStore.waiting.keys()];

      sessionFor();
      const response = await handleIdPInitiated(
        context('https://sp.example.test', undefined, pendingId)
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('SAMLResponse');
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
    });

    it('stops a person whose evidence was revoked after they were sent to sign in', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      mocks.cookieSessionId = undefined;
      const toLogin = await handleIdPInitiated(context('https://sp.example.test'));
      expect(toLogin.headers.get('location')).toContain('https://ui.example.test/login');
      const [pendingId] = [...requestStore.waiting.keys()];
      evidence.db
        .prepare('UPDATE assurance_evidence SET revoked_at = ? WHERE id = ?')
        .run(Date.now() - 1, 'ev-1');

      sessionFor();
      const response = await handleIdPInitiated(
        context('https://sp.example.test', undefined, pendingId)
      );
      expect(response.status).toBe(403);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(requestStore.waiting.size).toBe(0);
    });

    it('does not take an unreadable minimum for none', async () => {
      mocks.sp = baseSp({ minimumIal: 'bogus', identityMapping: { catalog: { entries: [] } } });
      evidence.addEvidence('ev-1', 'IAL2');
      const response = await handleIdPInitiated(context('https://sp.example.test'));
      expect(response.status).toBe(403);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
    });

    it('refuses with a server error, not as a person below the minimum, when the evidence cannot be read', async () => {
      evidence.addEvidence('ev-1', 'IAL3');
      mocks.coreAdapterError = new Error('account_data_route_not_found');
      const response = await handleIdPInitiated(context('https://sp.example.test'));
      expect(response.status).toBe(500);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(auditedFailureKind()).toBe('identity_assurance_unavailable');
    });

    it('sends a person who is not signed in to sign in, judging no one', async () => {
      mocks.cookieSessionId = undefined;
      const response = await handleIdPInitiated(context('https://sp.example.test'));
      expect(response.status).toBe(302);
      expect(evidence.evidenceReads()).toBe(0);
      expect(mocks.getCoreAdapter).not.toHaveBeenCalled();
    });

    it('reads no evidence and changes nothing for an SP without a minimum', async () => {
      mocks.sp = baseSp({ identityMapping: { catalog: { entries: [] } } });
      evidence.addEvidence('ev-1', 'IAL1');
      const response = await handleIdPInitiated(context('https://sp.example.test'));
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(evidence.evidenceReads()).toBe(0);
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
      await handleIdPInitiated(context('https://sp.example.test'));
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(subjectGivenToAttributeRelease().edu_person_assurance).toEqual([IAL1_URI, IAL2_URI]);
      expect(evidence.evidenceReads()).toBe(1);
    });

    it('gives the attribute release the tenant, so a tenant-bound mapping binding matches', async () => {
      evidence.addEvidence('ev-1', 'IAL2');
      await handleIdPInitiated(context('https://sp.example.test'));
      const releaseConfig = mocks.buildAttributes.mock.calls.at(-1)?.[1] as { tenantId?: string };
      expect(releaseConfig.tenantId).toEqual(expect.any(String));
      expect(releaseConfig.tenantId).not.toBe('');
    });

    it('reads the evidence once for the minimum and the attribute together', async () => {
      mocks.sp = baseSp({ identityMapping: eduMapping(), minimumIal: 'IAL2' });
      evidence.addEvidence('ev-1', 'IAL2');
      await handleIdPInitiated(context('https://sp.example.test'));
      expect(subjectGivenToAttributeRelease().edu_person_assurance).toEqual([IAL1_URI, IAL2_URI]);
      expect(evidence.evidenceReads()).toBe(1);
    });

    it('reads nothing while assurance levels are off', async () => {
      mocks.assuranceSettings = { 'assurance.enabled': false };
      evidence.addEvidence('ev-1', 'IAL2');
      await handleIdPInitiated(context('https://sp.example.test'));
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(subjectGivenToAttributeRelease()).not.toHaveProperty('edu_person_assurance');
      expect(evidence.evidenceReads()).toBe(0);
    });

    it('releases no attribute, and still issues the assertion, when the evidence cannot be read', async () => {
      // Only the evidence cannot be read (the rest of the account database answers).
      evidence.failEvidenceReads(new Error('account_data_route_not_found'));
      await handleIdPInitiated(context('https://sp.example.test'));
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(subjectGivenToAttributeRelease()).not.toHaveProperty('edu_person_assurance');
    });
  });
});

describe('IdP-initiated SSO and the SP minimum AAL', () => {
  const AAL2_REF = 'https://example.org/profile/AAL2';
  const sessionWith = (data: Record<string, unknown>) => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a', data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const auditedFailureKind = () =>
    (JSON.parse(mocks.audit.mock.calls[0]?.[1].metadata ?? '{}') as { failure_kind?: string })
      .failure_kind;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sp = baseSp({ minimumAal: 'AAL2', identityMapping: { catalog: { entries: [] } } });
    mocks.spList = [];
    mocks.sharded = true;
    mocks.sessionThrows = false;
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.uiConfig = { baseUrl: 'https://ui.example.test' };
    mocks.loginPolicy = 'ui_base_url';
    mocks.nakedDomain = false;
    mocks.runtimeBinding = null;
    mocks.assuranceSettings = {};
  });

  it('shows the error page and builds no assertion for a session below it', async () => {
    sessionWith({ amr: ['pwd'], proven_at: 1 });
    const response = await handleIdPInitiated(context('https://sp.example.test', 'relay'));
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain('SAMLResponse');
    expect(body).not.toMatch(/AAL|assurance/i);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(mocks.resolveNameId).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(auditedFailureKind()).toBe('authn_assurance_insufficient');
  });

  it('answers a session that reaches it', async () => {
    sessionWith({ amr: ['pwd', 'totp'], proven_at: 1 });
    const response = await handleIdPInitiated(context('https://sp.example.test'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
  });

  it('applies while assurance levels are off, as the SP setting does everywhere', async () => {
    mocks.assuranceSettings = { 'assurance.enabled': false };
    sessionWith({ amr: ['pwd'], proven_at: 1 });
    const response = await handleIdPInitiated(context('https://sp.example.test'));
    expect(response.status).toBe(403);
  });

  it('judges the session the person comes back from sign-in with, not one they had before', async () => {
    mocks.cookieSessionId = undefined;
    const response = await handleIdPInitiated(context('https://sp.example.test'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('https://ui.example.test/login');
    expect(mocks.audit).not.toHaveBeenCalled();
    const [pendingId] = [...requestStore.waiting.keys()];

    sessionWith({ amr: ['pwd'], proven_at: 1 });
    const back = await handleIdPInitiated(context('https://sp.example.test', undefined, pendingId));
    expect(back.status).toBe(403);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(requestStore.waiting.size).toBe(0);
  });

  it('does not take an unreadable minimum for none', async () => {
    mocks.sp = baseSp({ minimumAal: 'bogus', identityMapping: { catalog: { entries: [] } } });
    sessionWith({ amr: ['pwd', 'totp'], proven_at: 1 });
    const response = await handleIdPInitiated(context('https://sp.example.test'));
    expect(response.status).toBe(403);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('refuses with a server error, not as a session below the minimum, when the settings cannot be read', async () => {
    const lib = await import('@authrim/ar-lib-core');
    vi.mocked(lib.resolveEffectiveSettings).mockRejectedValueOnce(new Error('settings down'));
    sessionWith({ amr: ['pwd', 'totp'], proven_at: 1 });
    const response = await handleIdPInitiated(context('https://sp.example.test'));
    expect(response.status).toBe(500);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(auditedFailureKind()).toBe('authn_assurance_unavailable');
  });

  it('reads nothing and changes nothing for an SP without a minimum', async () => {
    const lib = await import('@authrim/ar-lib-core');
    vi.mocked(lib.resolveEffectiveSettings).mockClear();
    mocks.sp = baseSp({ identityMapping: { catalog: { entries: [] } } });
    sessionWith({ amr: ['pwd'], proven_at: 1 });
    const response = await handleIdPInitiated(context('https://sp.example.test'));
    expect(response.status).toBe(200);
    // The assurance settings are not read; the tenant's institution is, once, for every release.
    expect(lib.resolveEffectiveSettings).not.toHaveBeenCalledWith(
      expect.anything(),
      'assurance',
      expect.anything()
    );
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('puts the class reference of the AAL reached in the assertion for an SP in assurance mode', async () => {
    mocks.sp = baseSp({
      authnContextClassRefMode: 'assurance',
      identityMapping: { catalog: { entries: [] } },
    });
    mocks.assuranceSettings = {
      'assurance.enabled': true,
      'assurance.saml_authn_context_aal': JSON.stringify({ [AAL2_REF]: 'AAL2' }),
    };
    sessionWith({ amr: ['pwd', 'totp'], proven_at: 1 });
    await handleIdPInitiated(context('https://sp.example.test'));
    expect(
      (mocks.buildResponse.mock.calls.at(-1) as unknown as [{ authnContextClassRef: string }])[0]
        .authnContextClassRef
    ).toBe(AAL2_REF);
  });
  it('does not issue the static reference of a higher AAL than the sign-in reached', async () => {
    const AAL3_REF = 'https://example.org/profile/AAL3';
    mocks.sp = baseSp({
      minimumAal: 'AAL1',
      authnContextClassRefMode: 'legacy_static',
      defaultAuthnContextClassRef: AAL3_REF,
      identityMapping: { catalog: { entries: [] } },
    });
    mocks.assuranceSettings = {
      'assurance.enabled': true,
      'assurance.saml_authn_context_aal': JSON.stringify({ [AAL3_REF]: 'AAL3' }),
    };
    sessionWith({ amr: ['pwd'], proven_at: 1 });
    const response = await handleIdPInitiated(context('https://sp.example.test'));
    expect(response.status).toBe(403);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(auditedFailureKind()).toBe('authn_assurance_insufficient');
  });
});

describe('IdP-initiated SSO: the pending sign-in and the consent screen', () => {
  const SP = 'https://sp.example.test';
  const NAMEID_KEY = samlNameIdItemKey('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress');
  const MAIL_KEY = samlAttributeItemKey({ name: 'mail' });
  const NAME_KEY = samlAttributeItemKey({ name: 'displayName' });
  const signedIn = () => {
    mocks.cookieSessionId = 'session-id';
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a', data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const resume = (pendingId: string) => handleIdPInitiated(context(SP, undefined, pendingId));
  const released = () =>
    (
      mocks.buildResponse.mock.calls.at(-1)?.[0] as { attributes: Array<{ name: string }> }
    ).attributes.map((attribute) => attribute.name);
  const failureKinds = () =>
    mocks.audit.mock.calls.map(
      ([, entry]) =>
        (JSON.parse(String((entry as { metadata: string }).metadata)) as { failure_kind: string })
          .failure_kind
    );
  /** The person is signed in and the SP asks: the pending sign-in waits at the consent screen. */
  async function sentToTheScreen() {
    const response = await handleIdPInitiated(context(SP));
    expect(response.status).toBe(302);
    const [pendingId] = [...requestStore.waiting.keys()];
    const challengeId = new URL(response.headers.get('location') ?? '').searchParams.get(
      'challenge_id'
    ) as string;
    return { pendingId, challengeId };
  }
  const decide = (challengeId: string, approved: string[], declined: string[]) => {
    consentDb.saveReleaseDecision({
      spEntityId: SP,
      presented: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
      approved,
      declined,
    });
    challenges.decide(challengeId, {
      approved: true,
      approved_items: approved,
      declined_items: declined,
      decision_revision: 1,
      decided_at: Date.now(),
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sp = baseSp({
      identityMapping: { fieldMappingSetId: 'set', destinationFieldPolicies: { mail: 'required' } },
      informationReleaseConsent: { enabled: true, ask: 'once' },
    });
    mocks.uiConfig = { baseUrl: 'https://ui.example.test' };
    mocks.loginPolicy = 'ui_base_url';
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    // A Destination Profile, so the filter says which attributes the SP requires.
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
      destinationProfileId: 'destination',
      destinationProfileIds: ['destination'],
    };
    mocks.assuranceSettings = {};
    mocks.sharded = true;
    mocks.sessionThrows = false;
    mocks.buildAttributes.mockImplementation(() => [
      { name: 'mail', values: ['user@example.test'] },
      { name: 'displayName', values: ['User A'] },
    ]);
    mocks.requiredNames = ['mail'];
    signedIn();
  });

  it('answers a pending sign-in once: a second resume of it fails and sends nothing', async () => {
    const { pendingId, challengeId } = await sentToTheScreen();
    decide(challengeId, [NAMEID_KEY, MAIL_KEY], [NAME_KEY]);

    const first = await resume(pendingId);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('SAMLResponse');
    expect(released()).toEqual(['mail']);
    expect(challenges.challenges.get(challengeId)?.consumed).toBe(true);
    expect(requestStore.waiting.size).toBe(0);

    const second = await resume(pendingId);
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
  });

  it('refuses a malformed, unknown or another SP’s pending ID, answering nothing', async () => {
    expect((await resume('not-a-pending-id')).status).toBe(400);
    const unknown = `_idpinit_${crypto.randomUUID()}`;
    expect((await resume(unknown)).status).toBeGreaterThanOrEqual(400);
    // A pending sign-in is only read for the SP it was started for.
    const { pendingId } = await sentToTheScreen();
    mocks.sp = baseSp({ entityId: 'https://other.example.test' });
    const other = await handleIdPInitiated(
      context('https://other.example.test', undefined, pendingId)
    );
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(requestStore.waiting.has(pendingId)).toBe(true);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('refuses to resume a request that is not an IdP-initiated sign-in', async () => {
    const id = `_idpinit_${crypto.randomUUID()}`;
    requestStore.seed({ requestId: id, issuer: SP, context: {}, data: { id } as never });
    const response = await resume(id);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('sends a pending sign-in resumed at /saml/idp/sso back to /saml/idp/init, answering nothing', async () => {
    const { pendingId } = await sentToTheScreen();
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
      await next();
    });
    app.get('/saml/idp/sso', handleIdPSSO as never);
    const response = await app.request(
      `https://tenant.example.test/saml/idp/sso?${new URLSearchParams({
        saml_request_id: pendingId,
        saml_sp_entity_id: SP,
        return_to: 'saml_sso',
      })}`,
      undefined,
      environment()
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://tenant.example.test/saml/idp/init');
    expect(location.searchParams.get('sp')).toBe(SP);
    expect(location.searchParams.get('pending')).toBe(pendingId);
    // Not answered, not completed there.
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(requestStore.waiting.has(pendingId)).toBe(true);
  });

  it('answers 403 and uses the pending sign-in up when the person refused', async () => {
    const { pendingId, challengeId } = await sentToTheScreen();
    challenges.decide(challengeId, {
      approved: false,
      approved_items: [],
      declined_items: [],
      decided_at: Date.now(),
    });
    const response = await resume(pendingId);
    expect(response.status).toBe(403);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(failureKinds()).toEqual(['release_consent_refused']);
    expect(requestStore.waiting.size).toBe(0);
  });

  it('asks again, with a new challenge, when the answer is no longer the current decision', async () => {
    const { pendingId, challengeId } = await sentToTheScreen();
    decide(challengeId, [NAMEID_KEY, MAIL_KEY, NAME_KEY], []);
    consentDb.db.exec('DELETE FROM saml_sp_release_consents');
    consentDb.saveReleaseDecision({
      spEntityId: SP,
      presented: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
      approved: [],
      declined: [NAMEID_KEY, MAIL_KEY, NAME_KEY],
      refused: true,
      revision: 2,
    });
    const response = await resume(pendingId);
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get('location') ?? '').searchParams.get('challenge_id')
    ).not.toBe(challengeId);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('issues nothing when the person withdrew between their decision and the answer', async () => {
    const { pendingId, challengeId } = await sentToTheScreen();
    decide(challengeId, [NAMEID_KEY, MAIL_KEY, NAME_KEY], []);
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
    const response = await resume(pendingId);
    // Built (the check is the last one, just before the answer) but not sent: the error page.
    expect(response.status).toBe(403);
    expect(failureKinds()).toEqual(['release_consent_withdrawn']);
    expect(requestStore.waiting.size).toBe(0);
  });

  it('releases only what the SP requires when it does not ask, everything for a trusted SP', async () => {
    mocks.sp = baseSp({
      identityMapping: { fieldMappingSetId: 'set', destinationFieldPolicies: { mail: 'required' } },
      informationReleaseConsent: { enabled: false },
    });
    expect((await handleIdPInitiated(context(SP))).status).toBe(200);
    expect(released()).toEqual(['mail']);

    consentDb.trustSP(SP, { trusted: true });
    mocks.sp = baseSp({
      identityMapping: { fieldMappingSetId: 'set', destinationFieldPolicies: { mail: 'required' } },
      informationReleaseConsent: { enabled: true, ask: 'every_time' },
    });
    expect((await handleIdPInitiated(context(SP))).status).toBe(200);
    expect(released()).toEqual(['mail', 'displayName']);
    expect(challenges.consentChallenges()).toHaveLength(0);
  });
});
