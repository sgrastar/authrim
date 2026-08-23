import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SAML_NAMESPACES, STATUS_CODES } from '../../common/constants';

const mocks = vi.hoisted(() => ({
  idp: null as Record<string, unknown> | null,
  builtin: true,
  ui: undefined as { baseUrl: string } | undefined,
  activeUser: null as { id: string } | null,
  userNameId: null as string | null,
  sessionDelete: new Response(null, { status: 204 }),
  sessionThrows: false,
  signingError: false,
  signaturePolicyError: null as Error | null,
  outbound: { requestId: '_outbound', relayState: undefined } as Record<string, unknown> | null,
  outboundThrows: false,
  storeOutbound: vi.fn(async () => undefined),
  consumeOutbound: vi.fn(),
  revoke: vi.fn(async () => undefined),
  verify: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: {
        fetch: vi.fn(async () => {
          if (mocks.sessionThrows) throw new Error('session unavailable');
          return mocks.sessionDelete.clone();
        }),
      },
    })),
    isShardedSessionId: vi.fn((id: string) => id.startsWith('sess_')),
    getUIConfig: vi.fn(async () => mocks.ui),
    buildUIUrl: vi.fn((config: { baseUrl: string }) => `${config.baseUrl}/logout-complete`),
    shouldUseBuiltinForms: vi.fn(async () => mocks.builtin),
    usesNakedDomainIssuer: vi.fn(() => false),
    buildIssuerUrl: vi.fn(() => 'https://tenant.example.test'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    recordHybridUserSessionRevocationEpoch: mocks.revoke,
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
    createLogger: () => ({ module: () => ({ error: vi.fn() }) }),
  };
});

vi.mock('../../admin/providers', () => ({
  getIdPConfigByEntityId: vi.fn(async () => mocks.idp),
}));

vi.mock('../../common/entity-id', () => ({
  getSAMLLocalEntityIds: vi.fn(async () => ({
    issuerUrl: 'https://tenant.example.test',
    spEntityId: 'https://tenant.example.test/saml/sp',
  })),
}));

vi.mock('../../common/saml-signing-keys', () => ({
  getSAMLSigningPolicy: vi.fn(() => 'optional'),
  getSAMLSigningMaterial: vi.fn(async () => {
    if (mocks.signingError) throw new Error('signing unavailable');
    return { privateKeyPem: 'private-key', certificate: 'certificate' };
  }),
}));

vi.mock('../../common/signature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/signature')>();
  return {
    ...actual,
    hasSignature: vi.fn((xml: string) => xml.includes('<Signature')),
    verifyXmlSignature: mocks.verify,
    verifyXmlSignatureAndGetReferences: vi.fn((xml: string, options: unknown) => {
      mocks.verify(xml, options);
      return [{ uri: `#${/\bID="([^"]+)"/.exec(xml)?.[1]}`, xml }];
    }),
    signXml: vi.fn((xml: string) => xml),
  };
});

vi.mock('../../common/user-store', () => ({
  findActiveSamlUserByEmail: vi.fn(async () => mocks.activeUser),
  getSamlUserNameIdById: vi.fn(async () => mocks.userNameId),
}));

vi.mock('../logout-request-signature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logout-request-signature')>();
  return {
    ...actual,
    validateSAMLIdPLogoutRequestSignature: vi.fn(async () => {
      if (mocks.signaturePolicyError) throw mocks.signaturePolicyError;
    }),
  };
});

vi.mock('../../idp/slo-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../idp/slo-state')>();
  return {
    ...actual,
    consumeSAMLOutboundLogoutRequest: mocks.consumeOutbound.mockImplementation(async () => {
      if (mocks.outboundThrows) throw new Error('state store unavailable');
      if (!mocks.outbound) {
        throw new actual.SAMLLogoutResponseCorrelationError('missing request', {});
      }
      return mocks.outbound;
    }),
    storeSAMLOutboundLogoutRequest: mocks.storeOutbound,
  };
});

import { handleSPSLO, initiateSPLogout } from '../slo';
import { SAMLIdPLogoutRequestSignatureValidationError } from '../logout-request-signature';

function idp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: 'https://idp.example.test/entity',
    ssoUrl: 'https://idp.example.test/sso',
    sloUrl: 'https://idp.example.test/slo',
    certificate: 'certificate',
    ...overrides,
  };
}

function app() {
  const route = new Hono();
  route.use('*', async (c, next) => {
    (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
    await next();
  });
  route.all('/slo', handleSPSLO as never);
  return route;
}

function environment(withState = true) {
  return withState ? { STATE_STORE: {} } : {};
}

function requestXml(
  options: {
    issueInstant?: string;
    notOnOrAfter?: string;
    destination?: string;
    sessionIndex?: string;
  } = {}
) {
  return `<samlp:LogoutRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}"
    ID="_logout" IssueInstant="${options.issueInstant ?? new Date().toISOString()}"
    ${options.notOnOrAfter ? `NotOnOrAfter="${options.notOnOrAfter}"` : ''}
    ${options.destination ? `Destination="${options.destination}"` : ''}>
    <saml:Issuer>https://idp.example.test/entity</saml:Issuer>
    <saml:NameID>user@example.test</saml:NameID>
    ${options.sessionIndex ? `<samlp:SessionIndex>${options.sessionIndex}</samlp:SessionIndex>` : ''}
  </samlp:LogoutRequest>`;
}

function responseXml(
  options: { statusCode?: string; inResponseTo?: string; signature?: boolean } = {}
) {
  const signature = options.signature ?? true;
  return `<samlp:LogoutResponse xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}"
    ID="_response" IssueInstant="${new Date().toISOString()}" InResponseTo="${options.inResponseTo ?? '_outbound'}">
    <saml:Issuer>https://idp.example.test/entity</saml:Issuer>
    ${signature ? '<Signature />' : ''}
    <samlp:Status><samlp:StatusCode Value="${options.statusCode ?? STATUS_CODES.SUCCESS}"/></samlp:Status>
  </samlp:LogoutResponse>`;
}

async function post(field?: 'SAMLRequest' | 'SAMLResponse', xml?: string, relayState?: string) {
  const form = new FormData();
  if (field && xml) form.set(field, btoa(xml));
  if (relayState) form.set('RelayState', relayState);
  return app().fetch(
    new Request('https://tenant.example.test/slo', { method: 'POST', body: form }),
    environment(),
    { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as never
  );
}

describe('SP SLO handler policy boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.idp = idp();
    mocks.builtin = true;
    mocks.ui = undefined;
    mocks.activeUser = null;
    mocks.userNameId = null;
    mocks.sessionDelete = new Response(null, { status: 204 });
    mocks.sessionThrows = false;
    mocks.signingError = false;
    mocks.signaturePolicyError = null;
    mocks.outbound = { requestId: '_outbound', relayState: undefined };
    mocks.outboundThrows = false;
  });

  it('requires a SAML message for POST and GET bindings', async () => {
    expect((await post()).status).toBe(400);
    expect((await app().request('https://tenant.example.test/slo', {}, environment())).status).toBe(
      400
    );
  });

  it('maps malformed POST logout messages to validation errors', async () => {
    await expectValidationError(await post('SAMLRequest', '<not-saml/>'));
    await expectValidationError(await post('SAMLResponse', '<not-saml/>'));
  });

  it('rejects an oversized RelayState as invalid input', async () => {
    await expectValidationError(await post('SAMLRequest', requestXml(), 'x'.repeat(81)));
  });

  it('rejects an unknown IdP and signature-policy failures', async () => {
    mocks.idp = null;
    expect((await post('SAMLRequest', requestXml())).status).toBe(400);

    mocks.idp = idp();
    mocks.signaturePolicyError = new SAMLIdPLogoutRequestSignatureValidationError(
      'idp_logout_request_signature_required',
      'signature required'
    );
    expect((await post('SAMLRequest', requestXml())).status).toBe(400);
  });

  it.each([
    [new Date(Date.now() + 10 * 60_000).toISOString(), undefined],
    [new Date(Date.now() - 30 * 60_000).toISOString(), undefined],
    ['not-a-date', undefined],
    [new Date().toISOString(), 'https://attacker.example.test/slo'],
  ])('rejects invalid request timing or destination', async (issueInstant, destination) => {
    await expectValidationError(
      await post('SAMLRequest', requestXml({ issueInstant, destination }))
    );
  });

  it('rejects an invalid or expired LogoutRequest NotOnOrAfter', async () => {
    await expectValidationError(
      await post('SAMLRequest', requestXml({ notOnOrAfter: 'not-a-date' }))
    );
    await expectValidationError(
      await post(
        'SAMLRequest',
        requestXml({ notOnOrAfter: new Date(Date.now() - 10 * 60_000).toISOString() })
      )
    );
  });

  it.each([
    ['sess_valid', 204, false],
    ['sess_missing', 404, false],
    ['legacy-session', 204, false],
    [undefined, 204, false],
    ['sess_error', 204, true],
  ])('handles session termination boundary %s', async (sessionIndex, status, throws) => {
    mocks.sessionDelete = new Response(null, { status });
    mocks.sessionThrows = throws;
    mocks.activeUser = { id: 'user-a' };
    const response = await post('SAMLRequest', requestXml({ sessionIndex }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('continues safely when signing a LogoutResponse fails', async () => {
    mocks.signingError = true;
    expect((await post('SAMLRequest', requestXml())).status).toBe(200);
  });

  it('rejects unknown and uncorrelated LogoutResponses', async () => {
    mocks.idp = null;
    expect((await post('SAMLResponse', responseXml())).status).toBe(400);

    mocks.idp = idp();
    mocks.outbound = null;
    expect((await post('SAMLResponse', responseXml())).status).toBe(400);
  });

  it('preserves a 500 response for unexpected state-store failures', async () => {
    mocks.outboundThrows = true;
    expect((await post('SAMLResponse', responseXml())).status).toBe(500);
  });

  it('requires state storage and exact RelayState correlation', async () => {
    const form = new FormData();
    form.set('SAMLResponse', btoa(responseXml()));
    expect(
      (
        await app().fetch(
          new Request('https://tenant.example.test/slo', { method: 'POST', body: form }),
          environment(false)
        )
      ).status
    ).toBe(400);

    expect((await post('SAMLResponse', responseXml(), 'wrong')).status).toBe(400);
  });

  it.each([STATUS_CODES.SUCCESS, STATUS_CODES.RESPONDER])(
    'redirects a correlated %s response to its preserved return URL',
    async (statusCode) => {
      mocks.outbound = { requestId: '_outbound', relayState: 'https://app.example.test/done' };
      const response = await post('SAMLResponse', responseXml({ statusCode }), '_outbound');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://app.example.test/done');
    }
  );

  it('rejects a signed POST response when IdP signature verification fails', async () => {
    mocks.verify.mockImplementationOnce(() => {
      throw new Error('invalid signature');
    });
    const response = await post('SAMLResponse', responseXml({ signature: true }));
    await expectValidationError(response);
    expect(mocks.verify).toHaveBeenCalled();
    expect(mocks.consumeOutbound).not.toHaveBeenCalled();
  });

  it('rejects an unsigned POST LogoutResponse before consuming correlation state', async () => {
    const response = await post('SAMLResponse', responseXml({ signature: false }));
    await expectValidationError(response);
    expect(mocks.consumeOutbound).not.toHaveBeenCalled();
  });

  it('uses builtin, external, and configuration-error logout completion destinations', async () => {
    expect((await post('SAMLResponse', responseXml())).headers.get('location')).toBe(
      'https://tenant.example.test/logout-complete'
    );

    mocks.builtin = false;
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    expect((await post('SAMLResponse', responseXml())).headers.get('location')).toBe(
      'https://ui.example.test/logout-complete'
    );

    mocks.ui = undefined;
    expect((await post('SAMLResponse', responseXml())).status).toBe(500);
  });
});

async function expectValidationError(response: Response) {
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: 'invalid_request',
    error_code: 'AR130003',
  });
}

describe('SP-initiated SLO', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userNameId = 'user@example.test';
    mocks.signingError = false;
  });

  it('requires an explicit tenant, resolvable NameID, and state storage', async () => {
    await expect(
      initiateSPLogout(environment() as never, 'user-a', idp() as never)
    ).rejects.toThrow(/tenant/i);
    mocks.userNameId = null;
    await expect(
      initiateSPLogout(
        environment() as never,
        'user-a',
        idp() as never,
        undefined,
        undefined,
        'tenant-a'
      )
    ).rejects.toThrow('could not be processed');
    mocks.userNameId = 'user@example.test';
    await expect(
      initiateSPLogout({} as never, 'user-a', idp() as never, undefined, undefined, 'tenant-a')
    ).rejects.toThrow('STATE_STORE');
  });

  it.each([
    [undefined, undefined, 'https://idp.example.test/slo'],
    ['sess_valid', 'https://app.example.test/done', 'https://idp.example.test/sso'],
  ])(
    'builds and stores a request for optional session and return state',
    async (sessionIndex, returnUrl, destination) => {
      const config = idp(returnUrl ? { sloUrl: undefined } : {});
      const result = await initiateSPLogout(
        environment() as never,
        'user-a',
        config as never,
        sessionIndex,
        returnUrl,
        'tenant-a'
      );
      expect(result.html).toContain(destination);
      expect(result.html).toContain('SAMLRequest');
      expect(mocks.storeOutbound).toHaveBeenCalled();
    }
  );

  it('continues with an unsigned request when signing material is unavailable', async () => {
    mocks.signingError = true;
    const result = await initiateSPLogout(
      environment() as never,
      'user-a',
      idp() as never,
      undefined,
      undefined,
      'tenant-a'
    );
    expect(typeof result.html).toBe('string');
  });
});
