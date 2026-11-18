import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  DIGEST_ALGORITHMS,
  SAML_NAMESPACES,
  SIGNATURE_ALGORITHMS,
  STATUS_CODES,
} from '../../common/constants';
import { encodeForRedirectBindingQueryValue } from '../../common/slo-messages';

const mocks = vi.hoisted(() => ({
  idp: null as Record<string, unknown> | null,
  refs: undefined as Array<{ uri: string; xml: string }> | undefined,
  findUser: vi.fn(),
  revoke: vi.fn(async () => undefined),
  validate: vi.fn(),
  verifyRefs: vi.fn<(xml: string, options: Record<string, unknown>) => unknown>(),
  verifyRedirect: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  consumeOutbound: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getSessionStoreBySessionId: vi.fn(),
    isShardedSessionId: vi.fn(() => false),
    getUIConfig: vi.fn(async () => ({ baseUrl: 'https://ui.example.test' })),
    buildUIUrl: vi.fn((config: { baseUrl: string }) => `${config.baseUrl}/logout-complete`),
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

vi.mock('../../admin/providers', () => ({ getIdPConfigByEntityId: vi.fn(async () => mocks.idp) }));
vi.mock('../../common/entity-id', () => ({
  getSAMLLocalEntityIds: vi.fn(async () => ({
    issuerUrl: 'https://tenant.example.test',
    spEntityId: 'https://tenant.example.test/saml/sp',
  })),
}));
vi.mock('../../common/saml-signing-keys', () => ({
  getSAMLSigningPolicy: vi.fn(() => 'optional'),
  getSAMLSigningMaterial: vi.fn(async () => ({ privateKeyPem: 'key', certificate: 'cert' })),
}));
vi.mock('../../common/signature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/signature')>();
  return {
    ...actual,
    hasSignature: vi.fn((xml: string) => xml.includes('<Signature')),
    verifyXmlSignatureAndGetReferences: mocks.verifyRefs,
    verifyRedirectBindingSignature: mocks.verifyRedirect,
    signXml: vi.fn((xml: string) => xml),
  };
});
vi.mock('../../common/user-store', () => ({
  findActiveSamlUserByEmail: mocks.findUser,
  getSamlUserNameIdById: vi.fn(),
}));
vi.mock('../logout-request-signature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logout-request-signature')>();
  return { ...actual, validateSAMLIdPLogoutRequestSignature: mocks.validate };
});
vi.mock('../../idp/slo-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../idp/slo-state')>();
  return {
    ...actual,
    consumeSAMLOutboundLogoutRequest: mocks.consumeOutbound,
    storeSAMLOutboundLogoutRequest: vi.fn(),
  };
});

import { handleSPSLO } from '../slo';

const IDP_ENTITY = 'https://idp.example.test/entity';
const NS = `xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}"`;

function requestXml(nameId = 'user@example.test', issuer = IDP_ENTITY, id = '_logout') {
  return `<samlp:LogoutRequest ${NS} ID="${id}" IssueInstant="${new Date().toISOString()}">
    <saml:Issuer>${issuer}</saml:Issuer><saml:NameID>${nameId}</saml:NameID>
  </samlp:LogoutRequest>`;
}

function responseXml(issuer = IDP_ENTITY, id = '_response', signed = true) {
  return `<samlp:LogoutResponse ${NS} ID="${id}" IssueInstant="${new Date().toISOString()}" InResponseTo="_outbound">
    <saml:Issuer>${issuer}</saml:Issuer>${signed ? '<Signature />' : ''}
    <samlp:Status><samlp:StatusCode Value="${STATUS_CODES.SUCCESS}"/></samlp:Status>
  </samlp:LogoutResponse>`;
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

const env = () => ({ STATE_STORE: {}, SETTINGS: { get: vi.fn(async () => null) } });

function postForm(field: 'SAMLRequest' | 'SAMLResponse', xml: string) {
  const form = new FormData();
  form.set(field, btoa(xml));
  return app().request('https://tenant.example.test/slo', { method: 'POST', body: form }, env());
}

function redirectQuery(
  param: 'SAMLRequest' | 'SAMLResponse',
  xml: string,
  extra: { sig?: boolean; relayState?: string } = {}
) {
  const message = encodeURIComponent(encodeForRedirectBindingQueryValue(xml));
  const parts = [`${param}=${message}`];
  if (extra.relayState) parts.push(`RelayState=${extra.relayState}`);
  if (extra.sig ?? true) {
    parts.push(`SigAlg=${encodeURIComponent(SIGNATURE_ALGORITHMS.RSA_SHA256)}`);
    parts.push(`Signature=${encodeURIComponent('c2lnbmF0dXJl')}`);
  }
  return { message, query: parts.join('&') };
}

const getRedirect = (query: string) =>
  app().request(`https://tenant.example.test/slo?${query}`, {}, env());

async function expectInvalid(response: Response) {
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: 'invalid_request', error_code: 'AR130003' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.idp = {
    entityId: IDP_ENTITY,
    ssoUrl: 'https://idp.example.test/sso',
    sloUrl: 'https://idp.example.test/slo',
    certificate: 'cert-a',
  };
  mocks.refs = undefined;
  mocks.validate.mockImplementation(async () => mocks.refs);
  mocks.findUser.mockResolvedValue(null);
  mocks.consumeOutbound.mockResolvedValue({ requestId: '_outbound', relayState: undefined });
  mocks.verifyRefs.mockImplementation((xml: string) => [
    { uri: `#${/\bID="([^"]+)"/.exec(xml)?.[1]}`, xml },
  ]);
  mocks.verifyRedirect.mockResolvedValue(true);
});

describe('SP SLO HTTP-Redirect LogoutRequest', () => {
  it('inflates the request and hands the raw signature input to policy validation', async () => {
    const { message, query } = redirectQuery('SAMLRequest', requestXml(), { relayState: 'rs' });
    const response = await getRedirect(query);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await response.text()).toContain('https://idp.example.test/slo');
    expect(mocks.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: 'redirect',
        redirectSignature: {
          samlMessage: message,
          relayState: 'rs',
          signature: 'c2lnbmF0dXJl',
          sigAlg: SIGNATURE_ALGORITHMS.RSA_SHA256,
        },
      })
    );
  });

  it('maps undecodable redirect payloads to validation errors', async () => {
    await expectInvalid(await getRedirect('SAMLRequest=AAAA'));
    await expectInvalid(await getRedirect('SAMLResponse=AAAA'));
  });

  it('fails closed on a query that carries a request and a response together', async () => {
    const { query } = redirectQuery('SAMLRequest', requestXml());
    const response = await getRedirect(`${query}&SAMLResponse=AAAA`);
    expect(response.status).toBe(500);
  });

  it('requires a SAML message in the query', async () => {
    expect((await getRedirect('RelayState=x')).status).toBe(400);
  });
});

describe('SP SLO POST LogoutRequest signed-reference binding', () => {
  it('rejects when no signed reference covers the routed request ID', async () => {
    mocks.refs = [{ uri: '#_other', xml: requestXml() }];
    await expectInvalid(await postForm('SAMLRequest', requestXml()));
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it.each([
    ['issuer', requestXml('user@example.test', 'https://evil.example.test')],
    ['ID', requestXml('user@example.test', IDP_ENTITY, '_forged')],
  ])('rejects when the signed request carries a different %s', async (_label, signedXml) => {
    mocks.refs = [{ uri: '#_logout', xml: signedXml }];
    await expectInvalid(await postForm('SAMLRequest', requestXml()));
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('acts on the authenticated request content, not the routed envelope', async () => {
    mocks.refs = [{ uri: '#_logout', xml: requestXml('signed@example.test') }];
    const response = await postForm('SAMLRequest', requestXml('unsigned@example.test'));
    expect(response.status).toBe(200);
    expect(mocks.findUser).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      'signed@example.test'
    );
  });

  it('does not apply the reference check to redirect-binding requests', async () => {
    mocks.refs = [{ uri: '#_other', xml: requestXml() }];
    const { query } = redirectQuery('SAMLRequest', requestXml());
    expect((await getRedirect(query)).status).toBe(200);
  });
});

describe('SP SLO session termination by NameID', () => {
  it('revokes all sessions of the user found by NameID', async () => {
    mocks.findUser.mockResolvedValue({ id: 'user-a' });
    expect((await postForm('SAMLRequest', requestXml())).status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'tenant-a',
      'user-a'
    );
  });

  it('still answers the IdP when the user lookup fails', async () => {
    mocks.findUser.mockRejectedValue(new Error('db down'));
    const response = await postForm('SAMLRequest', requestXml());
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});

describe('SP SLO POST LogoutResponse certificate loop', () => {
  it('tries every configured certificate until one verifies', async () => {
    mocks.idp = { ...mocks.idp, certificates: ['cert-a', 'cert-b'] };
    mocks.verifyRefs.mockImplementationOnce(() => {
      throw new Error('wrong cert');
    });
    const response = await postForm('SAMLResponse', responseXml());
    expect(response.status).toBe(302);
    expect(mocks.verifyRefs).toHaveBeenCalledTimes(2);
    expect(mocks.verifyRefs.mock.calls.map((call) => call[1].certificateOrKey)).toEqual([
      'cert-a',
      'cert-b',
    ]);
  });

  it('rejects when every certificate fails', async () => {
    mocks.idp = { ...mocks.idp, certificates: ['cert-b'] };
    mocks.verifyRefs.mockImplementation(() => {
      throw new Error('bad signature');
    });
    await expectInvalid(await postForm('SAMLResponse', responseXml()));
    expect(mocks.verifyRefs).toHaveBeenCalledTimes(2);
    expect(mocks.consumeOutbound).not.toHaveBeenCalled();
  });

  it('rejects when no signed reference covers the response ID', async () => {
    mocks.verifyRefs.mockReturnValue([{ uri: '#_other', xml: responseXml() }]);
    await expectInvalid(await postForm('SAMLResponse', responseXml()));
    expect(mocks.consumeOutbound).not.toHaveBeenCalled();
  });

  it('rejects when the signed response has a different issuer', async () => {
    mocks.verifyRefs.mockReturnValue([
      { uri: '#_response', xml: responseXml('https://evil.example.test') },
    ]);
    await expectInvalid(await postForm('SAMLResponse', responseXml()));
    expect(mocks.consumeOutbound).not.toHaveBeenCalled();
  });

  it('rejects when there are no certificates to verify with', async () => {
    mocks.idp = { ...mocks.idp, certificate: undefined };
    await expectInvalid(await postForm('SAMLResponse', responseXml()));
    expect(mocks.verifyRefs).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy policy and both SHA-1 algorithms accepted', 'explicit_opt_in', true, true],
    ['legacy policy with only SHA-1 signatures accepted', 'explicit_opt_in', true, false],
    ['legacy policy with only SHA-1 digests accepted', 'explicit_opt_in', false, true],
    ['no legacy policy even if SHA-1 is listed', undefined, true, true],
  ])('maps SHA-1 options for %s', async (_label, policy, sigSha1, digestSha1) => {
    mocks.idp = {
      ...mocks.idp,
      logoutRequestLegacyAlgorithmPolicy: policy,
      acceptedLogoutRequestSignatureAlgorithms: sigSha1
        ? [SIGNATURE_ALGORITHMS.RSA_SHA1]
        : [SIGNATURE_ALGORITHMS.RSA_SHA256],
      acceptedLogoutRequestDigestAlgorithms: digestSha1
        ? [DIGEST_ALGORITHMS.SHA1]
        : [DIGEST_ALGORITHMS.SHA256],
    };
    expect((await postForm('SAMLResponse', responseXml())).status).toBe(302);
    const options = mocks.verifyRefs.mock.calls[0][1];
    const legacy = policy === 'explicit_opt_in';
    expect(options.allowSha1SignatureAlgorithm).toBe(legacy && sigSha1 ? true : undefined);
    expect(options.allowSha1DigestAlgorithm).toBe(legacy && digestSha1 ? true : undefined);
    expect(options).toMatchObject({ expectedId: '_response', strictXswProtection: true });
  });
});

describe('SP SLO HTTP-Redirect LogoutResponse', () => {
  const redirectResponse = (extra?: { sig?: boolean; relayState?: string }) =>
    redirectQuery('SAMLResponse', responseXml(IDP_ENTITY, '_response', false), extra);

  it('requires Signature and SigAlg on a redirect LogoutResponse', async () => {
    await expectInvalid(await getRedirect(redirectResponse({ sig: false }).query));
    expect(mocks.verifyRedirect).not.toHaveBeenCalled();
  });

  it('verifies the signature with SHA-256 only by default and redirects on success', async () => {
    const { message, query } = redirectResponse({ relayState: '_outbound' });
    const response = await getRedirect(query);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('_outbound');
    expect(mocks.verifyRedirect).toHaveBeenCalledWith(
      'SAMLResponse',
      message,
      '_outbound',
      'c2lnbmF0dXJl',
      SIGNATURE_ALGORITHMS.RSA_SHA256,
      'cert-a',
      { acceptedSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256] }
    );
  });

  it('uses the configured algorithm list only under explicit_opt_in', async () => {
    const accepted = [SIGNATURE_ALGORITHMS.RSA_SHA1, SIGNATURE_ALGORITHMS.RSA_SHA256];
    mocks.idp = {
      ...mocks.idp,
      logoutRequestLegacyAlgorithmPolicy: 'explicit_opt_in',
      acceptedLogoutRequestSignatureAlgorithms: accepted,
    };
    await getRedirect(redirectResponse().query);
    expect(mocks.verifyRedirect.mock.calls[0][6]).toEqual({
      acceptedSignatureAlgorithms: accepted,
    });

    mocks.verifyRedirect.mockClear();
    mocks.idp = { ...mocks.idp, acceptedLogoutRequestSignatureAlgorithms: undefined };
    await getRedirect(redirectResponse().query);
    expect(mocks.verifyRedirect.mock.calls[0][6]).toEqual({
      acceptedSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
    });
  });

  it('falls through to the next certificate after a throw or a false result', async () => {
    mocks.idp = { ...mocks.idp, certificates: ['cert-b', 'cert-c'] };
    mocks.verifyRedirect
      .mockRejectedValueOnce(new Error('bad key'))
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    expect((await getRedirect(redirectResponse().query)).status).toBe(302);
    expect(mocks.verifyRedirect.mock.calls.map((call) => call[5])).toEqual([
      'cert-a',
      'cert-b',
      'cert-c',
    ]);
  });

  it('rejects when no certificate verifies the signature', async () => {
    mocks.verifyRedirect.mockResolvedValue(false);
    await expectInvalid(await getRedirect(redirectResponse().query));
    expect(mocks.consumeOutbound).not.toHaveBeenCalled();

    mocks.verifyRedirect.mockRejectedValue(new Error('bad key'));
    await expectInvalid(await getRedirect(redirectResponse().query));
    expect(mocks.consumeOutbound).not.toHaveBeenCalled();
  });
});
