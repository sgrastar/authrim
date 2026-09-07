import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { BINDING_URIS, SAML_NAMESPACES } from '../../common/constants';

const mocks = vi.hoisted(() => ({
  sp: null as Record<string, unknown> | null,
  builtin: false,
  ui: undefined as { baseUrl: string; paths?: { login?: string } } | undefined,
  loginPolicy: 'ui_base_url' as 'ui_base_url' | 'tenant_host',
  storeFetch: vi.fn(async (_url?: string) => new Response('{}', { status: 200 })),
  audit: vi.fn(),
  sessionId: undefined as string | undefined,
  shardedSession: true,
  sessionResponse: new Response(null, { status: 404 }),
  sessionThrows: false,
  user: null as Record<string, unknown> | null,
  attributeError: null as Error | null,
  consentError: null as Error | null,
  destinationConsentApplied: false,
  authnContextError: null as Error | null,
  nameIdError: null as Error | null,
  consentGrant: vi.fn(async () => undefined),
  pairwiseSecret: 'pairwise-secret' as string | undefined,
  pairwiseSecretForRef: 'referenced-secret' as string | undefined,
  persistentProfileRows: [] as Array<Record<string, unknown>>,
  targetedIdOptions: null as Record<string, unknown> | null,
  buildResponse: vi.fn(() => '<saml-success-response/>'),
  buildErrorResponse: vi.fn(() => '<saml-error-response/>'),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getUIConfig: vi.fn(async () => mocks.ui),
    getTenantSettings: vi.fn(async () => ({})),
    buildIssuerUrl: vi.fn(() => 'https://tenant.example.test'),
    buildSAMLRequestStoreInstanceName: vi.fn(
      (tenant: string, role: string, entity: string) => `${tenant}:${role}:${entity}`
    ),
    shouldUseBuiltinForms: vi.fn(async () => mocks.builtin),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: {
        fetch: vi.fn(async () => {
          if (mocks.sessionThrows) throw new Error('session unavailable');
          return mocks.sessionResponse.clone();
        }),
      },
    })),
    isShardedSessionId: vi.fn(() => mocks.shardedSession),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({})),
    requireAdminDatabaseAdapter: vi.fn(() => ({
      query: vi.fn(async () => mocks.persistentProfileRows),
    })),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => ({
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
      destinationProfileId: 'destination-profile-saml',
      destinationProfileIds: ['destination-profile-saml'],
    })),
    filterSamlAttributesByDestinationConsentWithStatus: vi.fn(async (input) => ({
      attributes: input.attributes,
      consentApplied: mocks.destinationConsentApplied,
      ...(mocks.destinationConsentApplied
        ? {
            consentRecordId: 'destination-consent-1',
            consentEvidence: { saml_request_id: '_request' },
          }
        : {}),
    })),
    getLocalization: vi.fn(async () => ({ locale: 'en', t: (key: string) => key })),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
    createAuditLog: mocks.audit,
    AttributeReleaseConsentRepository: class {
      grant = mocks.consentGrant;
    },
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
    buildSAMLAttributesForSPWithDiagnostics: vi.fn(() => {
      if (mocks.attributeError) throw mocks.attributeError;
      return {
        attributes: [{ name: 'mail', values: ['user@example.test'] }],
        optionalMissingAttributes: [],
      };
    }),
  };
});

vi.mock('../attribute-release-consent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../attribute-release-consent')>();
  return {
    ...actual,
    enforceSAMLAttributeReleaseConsent: vi.fn(
      async (input: { destinationFieldConsentConfirmed?: unknown }) => {
        if (input.destinationFieldConsentConfirmed) return;
        if (mocks.consentError) throw mocks.consentError;
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
    applySAMLErrorResponseOverride: vi.fn((xml: string) => xml),
  };
});

import { handleIdPAttributeReleaseConsent, handleIdPSSO } from '../sso';
import { MissingRequiredSAMLAttributeError, SAMLIdentityMappingRuntimeError } from '../attributes';
import { SAMLAttributeReleaseConsentRequiredError } from '../attribute-release-consent';
import { SAMLAuthnContextPolicyError } from '../authn-context';
import { SAMLNameIDPolicyError } from '../subject';

function sp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: 'https://sp.example.test/entity',
    acsUrl: 'https://sp.example.test/acs',
    acsUrls: ['https://sp.example.test/acs'],
    allowedBindings: ['post'],
    authnRequestSignaturePolicy: 'optional',
    signResponses: true,
    signAssertions: false,
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
  route.post('/consent', handleIdPAttributeReleaseConsent as never);
  return route;
}

function environment() {
  return {
    SAML_REQUEST_STORE: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({ fetch: mocks.storeFetch })),
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
    { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as never
  );
}

describe('IdP SSO handler policy boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sp = sp();
    mocks.builtin = false;
    mocks.ui = undefined;
    mocks.loginPolicy = 'ui_base_url';
    mocks.storeFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    mocks.sessionId = undefined;
    mocks.shardedSession = true;
    mocks.sessionResponse = new Response(null, { status: 404 });
    mocks.sessionThrows = false;
    mocks.user = null;
    mocks.attributeError = null;
    mocks.consentError = null;
    mocks.destinationConsentApplied = false;
    mocks.authnContextError = null;
    mocks.nameIdError = null;
    mocks.pairwiseSecret = 'pairwise-secret';
    mocks.pairwiseSecretForRef = 'referenced-secret';
    mocks.persistentProfileRows = [];
    mocks.targetedIdOptions = null;
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
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('stores the request before builtin login and preserves force-authn intent', async () => {
    mocks.builtin = true;
    const response = await post(authnRequest({ forceAuthn: true }), 'relay-state');
    expect(response.status).toBe(302);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('/flow/login');
    expect(location).toContain('force_authn=true');
    expect(mocks.storeFetch).toHaveBeenCalledWith(
      'https://saml-request-store/store',
      expect.objectContaining({ method: 'POST' })
    );
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
    mocks.builtin = true;
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
    mocks.builtin = true;
    const result = await post(authnRequest());
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toContain('/flow/login');
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
    mocks.builtin = true;
    const response = await post(authnRequest({ forceAuthn: true }));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('force_authn=true');
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

  it('renders an attribute consent challenge and stores its binding', async () => {
    authenticateSession();
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.consentError = new SAMLAttributeReleaseConsentRequiredError({
      attributeSetHash: 'hash',
      reasonCodes: ['consent.required'],
      consentMode: 'once',
      attributes: [{ name: 'mail', values: ['user@example.test'] }],
    });
    const response = await post(authnRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="challenge_id"');
    expect(mocks.storeFetch).toHaveBeenCalledTimes(1);
    const storeCall = mocks.storeFetch.mock.calls[0] as unknown as [string, { body?: unknown }];
    const storedBody = storeCall[1].body;
    expect(typeof storedBody).toBe('string');
    if (typeof storedBody !== 'string') throw new Error('Expected serialized request state');
    const stored = JSON.parse(storedBody) as {
      context: { attributeReleaseConsentChallenge: Record<string, unknown> };
    };
    expect(stored.context.attributeReleaseConsentChallenge).toMatchObject({
      subjectId: 'user-a',
      destinationType: 'saml_sp',
      destinationId: 'https://sp.example.test/entity',
      attributeSetHash: 'hash',
      consentMode: 'once',
    });
  });

  it('does not render the legacy confirmation after generic destination consent', async () => {
    authenticateSession();
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.destinationConsentApplied = true;
    mocks.consentError = new SAMLAttributeReleaseConsentRequiredError({
      attributeSetHash: 'hash',
      reasonCodes: ['consent.required'],
      consentMode: 'once',
      attributes: [{ name: 'mail', values: ['user@example.test'] }],
    });

    const response = await post(authnRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildResponse).toHaveBeenCalled();
  });

  it('rejects GET redirect binding without a SAMLRequest', async () => {
    const response = await app().fetch(
      new Request('https://tenant.example.test/sso'),
      environment(),
      { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as never
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

function storedConsentRequest(overrides: Record<string, unknown> = {}) {
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
    context: {
      attributeReleaseConsentChallenge: {
        challengeId: 'challenge-a',
        subjectId: 'user-a',
        destinationType: 'saml_sp',
        destinationId: 'https://sp.example.test/entity',
        attributeSetHash: 'hash-a',
        createdAt: Date.now(),
        consentMode: 'once',
        attributeSummaries: [{ name: 'mail', valueCount: 1 }],
        ...overrides,
      },
    },
  };
}

async function postConsent(fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return app().fetch(
    new Request('https://tenant.example.test/consent', { method: 'POST', body: form }),
    environment(),
    { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as never
  );
}

function validConsentFields(overrides: Record<string, string> = {}) {
  return {
    saml_request_id: '_request',
    saml_sp_entity_id: 'https://sp.example.test/entity',
    challenge_id: 'challenge-a',
    attribute_set_hash: 'hash-a',
    decision: 'approve_once',
    ...overrides,
  } as Record<string, string>;
}

describe('IdP attribute-release consent callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sp = sp();
    mocks.sessionId = undefined;
    mocks.shardedSession = true;
    mocks.sessionResponse = new Response(null, { status: 404 });
    mocks.storeFetch.mockImplementation(async (url?: string) =>
      url?.includes('/consume/')
        ? new Response(JSON.stringify(storedConsentRequest()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('{}', { status: 200 })
    );
  });

  it('requires an authenticated session', async () => {
    expect((await postConsent(validConsentFields())).status).toBe(400);
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { saml_request_id: '_request' },
    { saml_request_id: '_request', saml_sp_entity_id: 'https://sp.example.test/entity' },
    {
      saml_request_id: '_request',
      saml_sp_entity_id: 'https://sp.example.test/entity',
      challenge_id: 'challenge-a',
    },
    {
      saml_request_id: '_request',
      saml_sp_entity_id: 'https://sp.example.test/entity',
      challenge_id: 'challenge-a',
      attribute_set_hash: 'hash-a',
    },
  ])('rejects incomplete consent callback fields', async (fields) => {
    authenticateSession();
    expect((await postConsent(fields as Record<string, string>)).status).toBe(400);
  });

  it.each(['approve-later', '', 'APPROVE'])('rejects invalid decision %s', async (decision) => {
    authenticateSession();
    expect((await postConsent(validConsentFields({ decision }))).status).toBe(400);
  });

  it.each([
    ['challengeId', 'other'],
    ['subjectId', 'user-b'],
    ['destinationType', 'oidc_client'],
    ['destinationId', 'https://other-sp.example/entity'],
    ['attributeSetHash', 'other-hash'],
    ['createdAt', 0],
  ])('rejects mismatched or expired challenge field %s', async (key, value) => {
    authenticateSession();
    mocks.storeFetch.mockImplementation(async (url?: string) =>
      url?.includes('/consume/')
        ? new Response(JSON.stringify(storedConsentRequest({ [key]: value })), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response('{}', { status: 200 })
    );
    expect((await postConsent(validConsentFields())).status).toBe(400);
  });

  it('rejects a consumed request without a consent challenge or configured SP', async () => {
    authenticateSession();
    mocks.storeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...storedConsentRequest(), context: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect((await postConsent(validConsentFields())).status).toBe(400);

    mocks.sp = null;
    expect((await postConsent(validConsentFields())).status).toBe(400);
  });

  it('returns a protocol denial response without persisting consent', async () => {
    authenticateSession();
    const response = await postConsent(validConsentFields({ decision: 'deny' }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.consentGrant).not.toHaveBeenCalled();
  });

  it.each([
    ['approve_once', undefined, false],
    ['approve', 'once', false],
    ['approve', 'remember', true],
    ['approve_remember', undefined, true],
  ])('handles %s with scope %s', async (decision, releaseScope, persists) => {
    authenticateSession();
    const fields = validConsentFields({ decision });
    if (releaseScope) fields.release_scope = releaseScope;
    const response = await postConsent(fields);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('saml_request_id=_request');
    expect(mocks.consentGrant).toHaveBeenCalledTimes(persists ? 1 : 0);
  });

  it('fails closed when consumed state cannot be read', async () => {
    authenticateSession();
    mocks.storeFetch.mockRejectedValue(new Error('state unavailable'));
    expect((await postConsent(validConsentFields())).status).toBe(400);
  });
});
