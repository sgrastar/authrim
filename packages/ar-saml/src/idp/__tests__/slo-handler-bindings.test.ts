import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SAML_NAMESPACES, STATUS_CODES } from '../../common/constants';
import { encodeForRedirectBindingQueryValue } from '../../common/slo-messages';

const EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

const mocks = vi.hoisted(() => ({
  spByEntity: structuredClone<Record<string, Record<string, unknown> | null>>({}),
  ui: undefined as { baseUrl: string } | undefined,
  outbound: null as Record<string, unknown> | null,
  readNameId: vi.fn<(...args: unknown[]) => Promise<{ format: string; value?: string } | null>>(),
  validateRequestSig: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  validateResponseSig: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  findUser: vi.fn<(...args: unknown[]) => Promise<{ id: string } | null>>(),
  transactions: [] as Array<Record<string, unknown> | null>,
  markCompleted: vi.fn(async () => undefined),
  markSent: vi.fn(async () => undefined),
  storeOutbound: vi.fn(async () => undefined),
  signRedirect: vi.fn<(...args: unknown[]) => Promise<{ signedUrl: string }>>(),
  signingError: false,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: { fetch: vi.fn(async () => new Response(null, { status: 204 })) },
    })),
    isShardedSessionId: vi.fn((id: string) => id.startsWith('sess_')),
    getUIConfig: vi.fn(async () => mocks.ui),
    buildUIUrl: vi.fn((config: { baseUrl: string }) => `${config.baseUrl}/logout-complete`),
    usesNakedDomainIssuer: vi.fn(() => false),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    recordHybridUserSessionRevocationEpoch: vi.fn(async () => undefined),
    createAuditLog: vi.fn(),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
    createLogger: () => ({ module: () => ({ error: vi.fn(), warn: vi.fn() }) }),
  };
});

vi.mock('../../admin/providers', () => ({
  getSPConfig: vi.fn(async (_env: unknown, _tenant: string, entityId: string) => {
    return mocks.spByEntity[entityId] ?? null;
  }),
}));
vi.mock('../../common/entity-id', () => ({
  getSAMLLocalEntityIds: vi.fn(async () => ({
    issuerUrl: 'https://tenant.example.test',
    idpEntityId: 'https://tenant.example.test/saml/idp',
  })),
}));
vi.mock('../../common/idp-signing', () => ({
  getSAMLIdPSigningMaterial: vi.fn(async () => {
    if (mocks.signingError) throw new Error('signing unavailable');
    return { privateKeyPem: 'private-key', certificate: 'certificate' };
  }),
}));
vi.mock('../../common/signature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/signature')>();
  return {
    ...actual,
    signXml: vi.fn((xml: string) => xml),
    signRedirectBinding: (...args: unknown[]) => mocks.signRedirect(...args),
  };
});
vi.mock('../../common/user-store', () => ({
  findActiveSamlUserByEmail: (...args: unknown[]) => mocks.findUser(...args),
  getSamlUserInfoById: vi.fn(async () => null),
  getSamlUserNameIdById: vi.fn(async () => 'user@example.test'),
}));
vi.mock('../subject', () => ({
  readSAMLSessionIndexNameID: (...args: unknown[]) => mocks.readNameId(...args),
  resolveSAMLPersistentNameIDRegistryStore: vi.fn(() => undefined),
  resolveSAMLNameIDValue: vi.fn(async () => 'persistent-name-id'),
  resolveSAMLPairwiseSecret: vi.fn(async () => 'pairwise-secret'),
  resolveSAMLSessionIndexToSessionId: vi.fn(async () => null),
  SAMLNameIDPolicyError: class extends Error {},
}));
vi.mock('../logout-request-signature', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logout-request-signature')>()),
  validateSAMLLogoutRequestSignature: (...args: unknown[]) => mocks.validateRequestSig(...args),
}));
vi.mock('../logout-response-signature', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logout-response-signature')>()),
  validateSAMLLogoutResponseSignature: (...args: unknown[]) => mocks.validateResponseSig(...args),
}));
vi.mock('../slo-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slo-state')>();
  return {
    ...actual,
    getSAMLOutboundLogoutRequest: vi.fn(async () => mocks.outbound),
    deleteSAMLOutboundLogoutRequest: vi.fn(async () => undefined),
    storeSAMLOutboundLogoutRequest: mocks.storeOutbound,
    getSAMLIdPLogoutFanoutTransaction: vi.fn(async () =>
      mocks.transactions.length > 1 ? mocks.transactions.shift() : mocks.transactions[0]
    ),
    markSAMLIdPLogoutFanoutTargetSent: mocks.markSent,
    markSAMLIdPLogoutFanoutTargetCompleted: mocks.markCompleted,
  };
});

import { SAMLLogoutRequestSignatureValidationError as RequestSigError } from '../logout-request-signature';
import { SAMLLogoutResponseSignatureValidationError as ResponseSigError } from '../logout-response-signature';
import { handleIdPSLO, initiateIdPLogoutBindingResponse } from '../slo';

const SP_ID = 'https://sp.example.test/entity';

function sp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: SP_ID,
    acsUrl: 'https://sp.example.test/acs',
    sloUrl: 'https://sp.example.test/slo',
    sloResponseUrl: 'https://sp.example.test/slo/response',
    allowedBindings: ['post', 'redirect'],
    logoutRequestSignaturePolicy: 'disabled',
    logoutResponseSignaturePolicy: 'disabled',
    ...overrides,
  };
}

function requestXml(
  options: { id?: string; issueInstant?: string; notOnOrAfter?: string; nameId?: string } = {}
) {
  const attrs = [
    `ID="${options.id ?? '_logout'}"`,
    `IssueInstant="${options.issueInstant ?? new Date().toISOString()}"`,
    options.notOnOrAfter ? `NotOnOrAfter="${options.notOnOrAfter}"` : '',
  ].join(' ');
  return `<samlp:LogoutRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ${attrs}>
    <saml:Issuer>${SP_ID}</saml:Issuer>
    <saml:NameID Format="${EMAIL}">${options.nameId ?? 'user@example.test'}</saml:NameID>
  </samlp:LogoutRequest>`;
}

function responseXml(options: { id?: string; statusCode?: string; issuer?: string } = {}) {
  return `<samlp:LogoutResponse xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}"
    ID="${options.id ?? '_response'}" IssueInstant="${new Date().toISOString()}" InResponseTo="_outbound">
    <saml:Issuer>${options.issuer ?? SP_ID}</saml:Issuer>
    <samlp:Status><samlp:StatusCode Value="${options.statusCode ?? STATUS_CODES.SUCCESS}"/></samlp:Status>
  </samlp:LogoutResponse>`;
}

function redirectSignatureMatching(relayState: string, signature: string): unknown {
  return expect.objectContaining({ relayState, signature });
}

function send(request: Request) {
  const route = new Hono();
  route.use('*', async (c, next) => {
    (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
    await next();
  });
  route.all('/slo', handleIdPSLO as never);
  return route.fetch(
    request,
    {
      STATE_STORE: {},
      SETTINGS: { get: vi.fn(async () => null) },
    },
    { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }
  );
}

function redirect(param: 'SAMLRequest' | 'SAMLResponse', xml: string, extra = '') {
  const value = encodeURIComponent(encodeForRedirectBindingQueryValue(xml));
  return send(new Request(`https://tenant.example.test/slo?${param}=${value}${extra}`));
}

function post(field: 'SAMLRequest' | 'SAMLResponse', xml: string) {
  const form = new FormData();
  form.set(field, btoa(xml));
  return send(new Request('https://tenant.example.test/slo', { method: 'POST', body: form }));
}

/** The decoded XML carried by a POST-binding auto-submit form. */
async function postedXml(response: Response, field: 'SAMLRequest' | 'SAMLResponse') {
  const html = await response.text();
  const match = new RegExp(`name="${field}" value="([^"]+)"`).exec(html);
  expect(match).not.toBeNull();
  return atob(match?.[1] ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.spByEntity = { [SP_ID]: sp() };
  mocks.ui = { baseUrl: 'https://ui.example.test' };
  mocks.outbound = { requestId: '_outbound', spEntityId: SP_ID };
  mocks.readNameId.mockReset().mockResolvedValue({ format: EMAIL });
  mocks.validateRequestSig.mockReset().mockResolvedValue(undefined);
  mocks.validateResponseSig.mockReset().mockResolvedValue(undefined);
  mocks.findUser.mockReset().mockResolvedValue(null);
  mocks.signRedirect
    .mockReset()
    .mockResolvedValue({ signedUrl: 'SAMLResponse=enc&SigAlg=alg&Signature=sig' });
  mocks.transactions = [];
  mocks.signingError = false;
});

describe('IdP SLO HTTP-Redirect binding', () => {
  it('answers a redirect LogoutRequest with a redirect LogoutResponse and clears the cookie', async () => {
    const response = await redirect(
      'SAMLRequest',
      requestXml(),
      '&RelayState=rs&SigAlg=a&Signature=b%3D'
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://sp.example.test/slo/response?SAMLResponse=enc&SigAlg=alg&Signature=sig'
    );
    expect(response.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(mocks.signRedirect).toHaveBeenCalledWith(
      'SAMLResponse',
      expect.any(String),
      'rs',
      'private-key'
    );
    expect(mocks.validateRequestSig).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: 'redirect',
        redirectSignature: redirectSignatureMatching('rs', 'b='),
      })
    );
  });

  it.each([
    ['https://sp.example.test/slo?x=1', '&'],
    ['https://sp.example.test/slo?', ''],
    ['https://sp.example.test/slo?x=1&', ''],
    ['https://sp.example.test/slo', '?'],
  ])('appends the signed query to %s', async (destination, separator) => {
    mocks.spByEntity = { [SP_ID]: sp({ sloResponseUrl: destination }) };
    const response = await redirect('SAMLRequest', requestXml());
    expect(response.headers.get('location')).toBe(
      `${destination}${separator}SAMLResponse=enc&SigAlg=alg&Signature=sig`
    );
  });

  it('keeps a destination fragment after the signed query', async () => {
    mocks.spByEntity = { [SP_ID]: sp({ sloResponseUrl: 'https://sp.example.test/slo?x=1#frag' }) };
    const response = await redirect('SAMLRequest', requestXml());
    expect(response.headers.get('location')).toBe(
      'https://sp.example.test/slo?x=1&SAMLResponse=enc&SigAlg=alg&Signature=sig#frag'
    );
  });

  it('answers a redirect LogoutRequest by POST when the SP pins a POST response binding', async () => {
    mocks.spByEntity = { [SP_ID]: sp({ logoutResponseBinding: 'post' }) };
    const response = await redirect('SAMLRequest', requestXml());
    expect(response.status).toBe(200);
    expect(await postedXml(response, 'SAMLResponse')).toContain(STATUS_CODES.SUCCESS);
    expect(mocks.signRedirect).not.toHaveBeenCalled();
  });

  it('answers a POST LogoutRequest by redirect when the SP pins a redirect response binding', async () => {
    mocks.spByEntity = { [SP_ID]: sp({ logoutResponseBinding: 'redirect' }) };
    const response = await post('SAMLRequest', requestXml());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('SAMLResponse=enc');
  });

  it('fails when the redirect response cannot be signed', async () => {
    mocks.signingError = true;
    expect((await redirect('SAMLRequest', requestXml())).status).toBe(500);
  });

  it('rejects a redirect RelayState over 80 bytes and undecodable messages', async () => {
    const tooLong = await redirect('SAMLRequest', requestXml(), `&RelayState=${'x'.repeat(81)}`);
    expect(tooLong.status).toBe(400);
    const garbage = await send(
      new Request('https://tenant.example.test/slo?SAMLRequest=!!notdeflate')
    );
    expect(garbage.status).toBe(400);
    const garbageResponse = await send(
      new Request('https://tenant.example.test/slo?SAMLResponse=!!notdeflate')
    );
    expect(garbageResponse.status).toBe(400);
  });

  it('refuses ambiguous redirect signature parameters', async () => {
    expect((await redirect('SAMLRequest', requestXml(), '&Signature=a&Signature=b')).status).toBe(
      500
    );
    expect((await redirect('SAMLResponse', responseXml(), '&SAMLRequest=x')).status).toBe(500);
  });

  it('consumes a redirect LogoutResponse and passes the redirect signature to the verifier', async () => {
    const response = await redirect('SAMLResponse', responseXml(), '&RelayState=rs&Signature=c%3D');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://ui.example.test/logout-complete');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(mocks.validateResponseSig).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: 'redirect',
        redirectSignature: redirectSignatureMatching('rs', 'c='),
      })
    );
  });

  it('requires SAMLRequest or SAMLResponse on a redirect', async () => {
    const response = await send(new Request('https://tenant.example.test/slo?RelayState=rs'));
    expect(response.status).toBe(400);
  });
});

describe('IdP SLO LogoutRequest validation and session handling', () => {
  it('refuses an unparsable or non-finite IssueInstant and NotOnOrAfter', async () => {
    for (const xml of [
      requestXml({ issueInstant: 'not-a-date' }),
      requestXml({ notOnOrAfter: 'not-a-date' }),
    ]) {
      const response = await post('SAMLRequest', xml);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error_code: 'AR130003' });
    }
  });

  it('reports a unknown SP as a 500 when no logout-complete UI is configured', async () => {
    mocks.spByEntity = {};
    mocks.ui = undefined;
    expect((await post('SAMLRequest', requestXml())).status).toBe(500);
  });

  it('redirects to logout-complete with the cookie cleared when the SP has no response endpoint', async () => {
    mocks.spByEntity = { [SP_ID]: sp({ sloResponseUrl: '', sloUrl: '', acsUrl: '' }) };
    const response = await post('SAMLRequest', requestXml());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://ui.example.test/logout-complete');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('still answers Success when terminating the session throws', async () => {
    mocks.findUser.mockRejectedValue(new Error('directory unavailable'));
    const response = await post('SAMLRequest', requestXml());
    expect(response.status).toBe(200);
    expect(await postedXml(response, 'SAMLResponse')).toContain(STATUS_CODES.SUCCESS);
  });

  it('terminates by the NameID of the signed reference, not the unsigned envelope', async () => {
    const signed = requestXml({ nameId: 'signed@example.test' });
    mocks.validateRequestSig.mockResolvedValue([{ uri: '#_logout', xml: signed }]);
    const response = await post('SAMLRequest', requestXml({ nameId: 'forged@example.test' }));
    expect(response.status).toBe(200);
    expect(mocks.findUser).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'signed@example.test'
    );
    expect(await postedXml(response, 'SAMLResponse')).toContain('InResponseTo="_logout"');
  });

  it.each([
    ['has no reference for the request', [{ uri: '#_other', xml: requestXml({ id: '_other' }) }]],
    ['signs a different request id', [{ uri: '#_logout', xml: requestXml({ id: '_swapped' }) }]],
    [
      'signs a different issuer',
      [{ uri: '#_logout', xml: requestXml().replace(SP_ID, 'https://evil.example/entity') }],
    ],
  ])('rejects a signed POST LogoutRequest whose signature %s', async (_label, references) => {
    mocks.validateRequestSig.mockResolvedValue(references);
    const response = await post('SAMLRequest', requestXml());
    expect(response.status).toBe(200);
    const xml = await postedXml(response, 'SAMLResponse');
    expect(xml).toContain(STATUS_CODES.REQUESTER);
    expect(xml).toContain('rejected by IdP policy');
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('returns a Requester response when request signature validation fails', async () => {
    mocks.validateRequestSig.mockRejectedValue(
      new RequestSigError('logout_request_invalid_signature', 'bad signature')
    );
    const response = await redirect('SAMLRequest', requestXml());
    expect(response.status).toBe(302);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('propagates an unexpected verifier error as a 500', async () => {
    mocks.validateRequestSig.mockRejectedValue(new Error('verifier crashed'));
    expect((await post('SAMLRequest', requestXml())).status).toBe(500);
  });
});

describe('IdP SLO LogoutResponse signature handling', () => {
  it('maps a signature policy failure to a validation error', async () => {
    mocks.validateResponseSig.mockRejectedValue(
      new ResponseSigError('logout_response_invalid_signature', 'bad signature')
    );
    const response = await post('SAMLResponse', responseXml());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_code: 'AR130003' });
  });

  it.each([
    ['has no reference for the response', [{ uri: '#_other', xml: responseXml({ id: '_other' }) }]],
    ['signs a different id', [{ uri: '#_response', xml: responseXml({ id: '_swapped' }) }]],
    [
      'signs a different issuer',
      [{ uri: '#_response', xml: responseXml().replace(SP_ID, 'https://evil.example/entity') }],
    ],
  ])('rejects a signed POST LogoutResponse whose signature %s', async (_label, references) => {
    mocks.validateResponseSig.mockResolvedValue(references);
    expect((await post('SAMLResponse', responseXml())).status).toBe(400);
  });

  it('uses the status of the signed reference, not the unsigned envelope', async () => {
    mocks.outbound = { requestId: '_outbound', spEntityId: SP_ID, transactionId: 'tx-1' };
    mocks.transactions = [null];
    mocks.validateResponseSig.mockResolvedValue([
      { uri: '#_response', xml: responseXml({ statusCode: STATUS_CODES.RESPONDER }) },
    ]);
    const response = await post('SAMLResponse', responseXml({ statusCode: STATUS_CODES.SUCCESS }));
    expect(response.status).toBe(302);
    expect(mocks.markCompleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        transactionId: 'tx-1',
        spEntityId: SP_ID,
        status: 'failed',
        statusCode: STATUS_CODES.RESPONDER,
      })
    );
  });
});

describe('IdP SLO multi-SP logout loop', () => {
  const SECOND = 'https://second.example.test/entity';
  const THIRD = 'https://third.example.test/entity';
  const FOURTH = 'https://fourth.example.test/entity';

  function transaction(statuses: Record<string, string>, extra: Record<string, unknown> = {}) {
    return {
      transactionId: 'tx-1',
      tenantId: 'tenant-a',
      userId: 'user-a',
      sessionIndex: 'sidx-shared',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      targets: Object.entries(statuses).map(([spEntityId, status]) => ({ spEntityId, status })),
      ...extra,
    };
  }

  beforeEach(() => {
    mocks.outbound = { requestId: '_outbound', spEntityId: SP_ID, transactionId: 'tx-1' };
    mocks.spByEntity = {
      [SP_ID]: sp(),
      [SECOND]: sp({ entityId: SECOND, sloUrl: 'https://second.example.test/slo' }),
      [THIRD]: sp({
        entityId: THIRD,
        sloUrl: 'https://third.example.test/slo',
        sloBinding: 'post',
      }),
      [FOURTH]: sp({ entityId: FOURTH, sloUrl: 'https://fourth.example.test/slo' }),
    };
  });

  it.each([
    ['the transaction is gone', null],
    ['every target is done', transaction({ [SP_ID]: 'succeeded', [SECOND]: 'failed' })],
    [
      'the transaction expired with pending targets',
      transaction({ [SECOND]: 'pending' }, { expiresAt: 1 }),
    ],
    ['no target is pending', transaction({ [SP_ID]: 'succeeded', [SECOND]: 'sent' })],
  ])('finishes at the logout-complete page when %s', async (_label, state) => {
    mocks.transactions = [state];
    const response = await post('SAMLResponse', responseXml());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://ui.example.test/logout-complete');
    expect(mocks.markSent).not.toHaveBeenCalled();
  });

  it('sends the next pending SP its LogoutRequest by redirect and records it', async () => {
    mocks.signRedirect.mockResolvedValue({ signedUrl: 'SAMLRequest=enc&Signature=sig' });
    mocks.transactions = [
      transaction({ [SP_ID]: 'succeeded', [SECOND]: 'pending' }, { relayState: 'tx-relay' }),
    ];
    const response = await post('SAMLResponse', responseXml());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://second.example.test/slo?SAMLRequest=enc&Signature=sig'
    );
    expect(mocks.signRedirect).toHaveBeenCalledWith(
      'SAMLRequest',
      expect.any(String),
      'tx-relay',
      'private-key'
    );
    expect(mocks.markCompleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spEntityId: SP_ID, status: 'succeeded' })
    );
    expect(mocks.markSent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ transactionId: 'tx-1', spEntityId: SECOND })
    );
    expect(mocks.storeOutbound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spEntityId: SECOND, transactionId: 'tx-1' })
    );
  });

  it('skips a missing SP and an unnameable SP, then logs the next one out by POST', async () => {
    const GONE = 'https://gone.example.test/entity';
    const snapshot = (statuses: Record<string, string>) =>
      transaction({ [SP_ID]: 'succeeded', ...statuses });
    mocks.transactions = [
      snapshot({ [GONE]: 'pending', [SECOND]: 'pending', [THIRD]: 'pending' }),
      snapshot({ [GONE]: 'failed', [SECOND]: 'pending', [THIRD]: 'pending' }),
      snapshot({ [GONE]: 'failed', [SECOND]: 'failed', [THIRD]: 'pending' }),
    ];
    mocks.readNameId.mockImplementation(async (...args: unknown[]) => {
      const key = args[1] as { spEntityId: string };
      return key.spEntityId === SECOND ? { format: TRANSIENT } : { format: EMAIL };
    });
    const response = await post('SAMLResponse', responseXml());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('https://third.example.test/slo');
    expect(mocks.markCompleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        spEntityId: GONE,
        status: 'failed',
        failureReason: 'sp_config_missing',
      })
    );
    expect(mocks.markCompleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        spEntityId: SECOND,
        status: 'failed',
        failureReason: 'nameid_unavailable',
      })
    );
    expect(mocks.markSent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spEntityId: THIRD })
    );
  });

  it('marks the target failed and surfaces the error when sending the next request fails', async () => {
    mocks.transactions = [transaction({ [SP_ID]: 'succeeded', [FOURTH]: 'pending' })];
    mocks.signingError = true;
    expect((await post('SAMLResponse', responseXml())).status).toBe(500);
    expect(mocks.markCompleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        spEntityId: FOURTH,
        status: 'failed',
        failureReason: 'send_failed',
      })
    );
  });
});

describe('IdP-initiated logout binding response failures', () => {
  it('propagates a signing failure and stores no outbound request', async () => {
    mocks.signingError = true;
    await expect(
      initiateIdPLogoutBindingResponse({ STATE_STORE: {} } as never, 'user-a', sp() as never, {
        tenantId: 'tenant-a',
        sessionIndex: 'sidx-1',
        binding: 'redirect',
      })
    ).rejects.toThrow('signing unavailable');
    expect(mocks.storeOutbound).not.toHaveBeenCalled();
  });
});
