/**
 * SP SLO LogoutResponse handling: signature verification for both bindings (certificates tried,
 * legacy algorithm opt-in, what must be signed), request correlation and the return redirect.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  DIGEST_ALGORITHMS,
  SAML_NAMESPACES,
  SIGNATURE_ALGORITHMS,
  STATUS_CODES,
} from '../../common/constants';
import * as pako from 'pako';

const mocks = vi.hoisted(() => ({
  idp: null as Record<string, unknown> | null,
  logs: [] as Array<{ level: string; message: string; context: unknown; error?: Error }>,
  hasSignature: true,
  verify: null as null | ((xml: string, options: Record<string, unknown>) => unknown),
  verifyCalls: [] as Array<Record<string, unknown>>,
  redirectVerify: vi.fn(async (..._args: unknown[]): Promise<boolean> => true),
  consume: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({})),
  ui: null as { baseUrl: string } | null,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const log = (level: string) => (message: string, context: unknown, error?: Error) =>
    mocks.logs.push({ level, message, context, error });
  const logger = { error: log('error'), warn: log('warn'), info: log('info'), debug: log('debug') };
  return {
    ...actual,
    getUIConfig: vi.fn(async () => mocks.ui),
    buildUIUrl: vi.fn((config: { baseUrl: string }) => `${config.baseUrl}/logout-complete`),
    usesNakedDomainIssuer: vi.fn(() => false),
    getLogger: () => ({ module: () => logger }),
    createLogger: () => ({ module: () => logger }),
  };
});
vi.mock('../../admin/providers', () => ({ getIdPConfigByEntityId: vi.fn(async () => mocks.idp) }));
vi.mock('../../common/entity-id', () => ({
  getSAMLLocalEntityIds: vi.fn(async () => ({
    issuerUrl: 'https://tenant.example.test',
    spEntityId: 'https://tenant.example.test/saml/sp/metadata',
  })),
}));
vi.mock('../../common/signature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/signature')>();
  return {
    ...actual,
    hasSignature: vi.fn(() => mocks.hasSignature),
    verifyXmlSignatureAndGetReferences: vi.fn((xml: string, options: Record<string, unknown>) => {
      mocks.verifyCalls.push(options);
      if (mocks.verify) return mocks.verify(xml, options);
      return [{ uri: '#_resp', xml }];
    }),
    verifyRedirectBindingSignature: mocks.redirectVerify,
  };
});
vi.mock('../../idp/slo-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../idp/slo-state')>();
  return { ...actual, consumeSAMLOutboundLogoutRequest: mocks.consume };
});

import { handleSPSLO } from '../slo';
import { SAMLLogoutResponseCorrelationError } from '../../idp/slo-state';

const IDP = 'https://idp.example.test/entity';
const NS = `xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}"`;
const RESPONSE_XML = `<samlp:LogoutResponse ${NS} ID="_resp" IssueInstant="2026-06-01T12:00:00Z" InResponseTo="_out"><saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${STATUS_CODES.SUCCESS}"/></samlp:Status></samlp:LogoutResponse>`;

function responseXml(statusCode: string = STATUS_CODES.SUCCESS): string {
  return RESPONSE_XML.replace(STATUS_CODES.SUCCESS, statusCode);
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

const env = (extra: Record<string, unknown> = {}) => ({
  STATE_STORE: {},
  SETTINGS: { get: vi.fn(async () => null) },
  ...extra,
});
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as never;

async function post(xml: string, relayState?: string, extraEnv: Record<string, unknown> = {}) {
  const form = new FormData();
  form.set('SAMLResponse', btoa(xml));
  if (relayState) form.set('RelayState', relayState);
  return app().fetch(
    new Request('https://tenant.example.test/slo', { method: 'POST', body: form }),
    env(extraEnv),
    ctx
  );
}

async function redirect(query: Record<string, string>) {
  const search = new URLSearchParams(query).toString();
  return app().fetch(new Request(`https://tenant.example.test/slo?${search}`), env(), ctx);
}

const errorOf = (message: string) =>
  mocks.logs.find((log) => log.message === message)?.error?.message;
const sigError = () => errorOf('LogoutResponse signature verification failed');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.idp = { entityId: IDP, certificate: 'cert-1', ssoUrl: 'https://idp/sso' };
  mocks.logs.length = 0;
  mocks.hasSignature = true;
  mocks.verify = null;
  mocks.verifyCalls.length = 0;
  mocks.redirectVerify.mockResolvedValue(true);
  mocks.consume.mockResolvedValue({ requestId: '_out' });
  mocks.ui = { baseUrl: 'https://ui.example.test' };
});

describe('POST binding signature', () => {
  it('requires a signature', async () => {
    mocks.hasSignature = false;

    expect((await post(responseXml())).status).toBe(400);
    expect(sigError()).toBe('Signed HTTP-POST LogoutResponse is required');
    expect(mocks.verifyCalls).toEqual([]);
  });

  it('verifies against each distinct certificate in order, strictly and for this response id', async () => {
    mocks.idp = { ...mocks.idp, certificate: 'cert-1', certificates: ['cert-2', 'cert-1', ''] };
    mocks.verify = (xml, options) => {
      if (options.certificateOrKey === 'cert-1') throw new Error('bad cert-1');
      return [{ uri: '#_resp', xml }];
    };

    const response = await post(responseXml());

    expect(response.status).toBe(302);
    expect(mocks.verifyCalls).toEqual([
      { certificateOrKey: 'cert-1', expectedId: '_resp', strictXswProtection: true },
      { certificateOrKey: 'cert-2', expectedId: '_resp', strictXswProtection: true },
    ]);
  });

  it.each([
    [{}, {}],
    [
      {
        logoutRequestLegacyAlgorithmPolicy: 'explicit_opt_in',
        acceptedLogoutRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA1],
      },
      { allowSha1SignatureAlgorithm: true },
    ],
    [
      {
        logoutRequestLegacyAlgorithmPolicy: 'explicit_opt_in',
        acceptedLogoutRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA1],
      },
      { allowSha1DigestAlgorithm: true },
    ],
    [
      {
        logoutRequestLegacyAlgorithmPolicy: 'explicit_opt_in',
        acceptedLogoutRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
        acceptedLogoutRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256],
      },
      {},
    ],
    [
      {
        acceptedLogoutRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA1],
        acceptedLogoutRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA1],
      },
      {},
    ],
  ])('derives the SHA-1 allowances from %o as %o', async (policy, allowances) => {
    mocks.idp = { ...mocks.idp, ...policy };

    await post(responseXml());

    expect(mocks.verifyCalls[0]).toEqual({
      certificateOrKey: 'cert-1',
      expectedId: '_resp',
      strictXswProtection: true,
      ...allowances,
    });
  });

  it('refuses a signature that does not cover the response', async () => {
    mocks.verify = (xml) => [{ uri: '#_other', xml }];

    expect((await post(responseXml())).status).toBe(400);
    expect(sigError()).toBe('Signed LogoutResponse reference is missing');
  });

  it('judges the signed bytes: a signed copy for another issuer is refused', async () => {
    mocks.verify = (xml) => [{ uri: '#_resp', xml: xml.replace(IDP, 'https://evil.example.test') }];

    expect((await post(responseXml())).status).toBe(400);
    expect(sigError()).toBe('Signed LogoutResponse does not match the routed response');
  });

  it('reports the last verification failure, or a generic one for a non-Error', async () => {
    mocks.idp = { ...mocks.idp, certificates: ['cert-2'] };
    mocks.verify = (_xml, options) => {
      throw new Error(`bad ${String(options.certificateOrKey)}`);
    };
    await post(responseXml());
    expect(sigError()).toBe('bad cert-2');

    mocks.logs.length = 0;
    const raise = (value: unknown): never => {
      throw value;
    };
    mocks.verify = () => raise('nope');
    await post(responseXml());
    expect(sigError()).toBe('Signed LogoutResponse does not match the routed response');
  });

  it('refuses an unknown IdP before any verification', async () => {
    mocks.idp = null;

    const response = await post(responseXml());

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.logs).toContainEqual(
      expect.objectContaining({
        message: 'Unknown IdP LogoutResponse issuer',
        context: { issuer: IDP },
      })
    );
    expect(mocks.verifyCalls).toEqual([]);
  });
});

describe('redirect binding signature', () => {
  const encode = (xml: string) =>
    encodeURIComponent(btoa(String.fromCharCode(...pako.deflateRaw(xml))));
  const signed = { Signature: 'c2ln', SigAlg: SIGNATURE_ALGORITHMS.RSA_SHA256 };
  const go = (query: Record<string, string> = {}) =>
    app().fetch(
      new Request(
        `https://tenant.example.test/slo?SAMLResponse=${encode(responseXml())}&RelayState=_out&${new URLSearchParams({ ...signed, ...query }).toString()}`
      ),
      env(),
      ctx
    );

  it.each([
    ['a signature', { Signature: '' }],
    ['a SigAlg', { SigAlg: '' }],
  ])('requires %s', async (_label, query) => {
    const response = await go(query);

    expect(response.status).toBe(400);
    expect(sigError()).toBe('Signed HTTP-Redirect LogoutResponse is required');
    expect(mocks.redirectVerify).not.toHaveBeenCalled();
  });

  it('refuses an unsigned redirect response', async () => {
    const response = await app().fetch(
      new Request(`https://tenant.example.test/slo?SAMLResponse=${encode(responseXml())}`),
      env(),
      ctx
    );

    expect(response.status).toBe(400);
    expect(sigError()).toBe('Signed HTTP-Redirect LogoutResponse is required');
  });

  it('verifies the signed string with each certificate in order and accepts only RSA-SHA256 by default', async () => {
    mocks.idp = { ...mocks.idp, certificates: ['cert-2'] };
    mocks.redirectVerify.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const response = await go();

    expect(response.status).toBe(302);
    expect(mocks.redirectVerify.mock.calls.map((call) => call[5])).toEqual(['cert-1', 'cert-2']);
    const first = mocks.redirectVerify.mock.calls[0] ?? [];
    expect(first[0]).toBe('SAMLResponse');
    expect(first[1]).toBe(encode(responseXml()));
    expect(first[2]).toBe('_out');
    expect(first[3]).toBe('c2ln');
    expect(first[4]).toBe(SIGNATURE_ALGORITHMS.RSA_SHA256);
    expect(mocks.redirectVerify.mock.calls[0]?.[6]).toEqual({
      acceptedSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
    });
  });

  it('widens the accepted algorithms only under explicit opt-in', async () => {
    mocks.idp = {
      ...mocks.idp,
      logoutRequestLegacyAlgorithmPolicy: 'explicit_opt_in',
      acceptedLogoutRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA1],
    };
    await go();
    expect(mocks.redirectVerify.mock.calls[0]?.[6]).toEqual({
      acceptedSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA1],
    });

    mocks.redirectVerify.mockClear();
    mocks.idp = { ...mocks.idp, acceptedLogoutRequestSignatureAlgorithms: undefined };
    await go();
    expect(mocks.redirectVerify.mock.calls[0]?.[6]).toEqual({
      acceptedSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
    });

    mocks.redirectVerify.mockClear();
    mocks.idp = {
      ...mocks.idp,
      logoutRequestLegacyAlgorithmPolicy: undefined,
      acceptedLogoutRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA1],
    };
    await go();
    expect(mocks.redirectVerify.mock.calls[0]?.[6]).toEqual({
      acceptedSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
    });
  });

  it('refuses when no certificate verifies, with the last error or a generic message', async () => {
    mocks.redirectVerify.mockResolvedValue(false);
    await go();
    expect(sigError()).toBe('Invalid HTTP-Redirect LogoutResponse signature');

    mocks.logs.length = 0;
    mocks.redirectVerify.mockRejectedValue(new Error('unsupported algorithm'));
    await go();
    expect(sigError()).toBe('unsupported algorithm');
  });
});

describe('correlation and return', () => {
  it('consumes the outbound request for this tenant, IdP and InResponseTo', async () => {
    await post(responseXml(), '_out');

    expect(mocks.consume).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      spEntityId: IDP,
      inResponseTo: '_out',
    });
  });

  it('refuses without a state store', async () => {
    const form = new FormData();
    form.set('SAMLResponse', btoa(responseXml()));
    const response = await app().fetch(
      new Request('https://tenant.example.test/slo', { method: 'POST', body: form }),
      { SETTINGS: { get: vi.fn(async () => null) } },
      ctx
    );

    expect(response.status).toBe(400);
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.logs).toContainEqual(
      expect.objectContaining({
        message: 'SP LogoutResponse correlation failed',
        context: { tenantId: 'tenant-a', idpEntityId: IDP, logoutResponseId: '_resp' },
      })
    );
  });

  it('refuses a response that does not correlate to an outbound request', async () => {
    mocks.consume.mockRejectedValue(
      new SAMLLogoutResponseCorrelationError('missing', { in_response_to: '_out' })
    );

    expect((await post(responseXml())).status).toBe(400);
  });

  it('refuses a RelayState that is not the id of the outbound request', async () => {
    expect((await post(responseXml(), '_attacker')).status).toBe(400);
    expect(mocks.logs.some((log) => log.message === 'SP LogoutResponse correlation failed')).toBe(
      true
    );
  });

  it('returns to the URL kept with the outbound request and clears the session cookie', async () => {
    mocks.consume.mockResolvedValue({
      requestId: '_out',
      relayState: 'https://app.example.test/bye',
    });

    const response = await post(responseXml(), '_out');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://app.example.test/bye');
    expect(response.headers.get('set-cookie')).toBe(
      'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    );
  });

  it('falls back to the logout-complete page without a kept URL or RelayState', async () => {
    const response = await post(responseXml());

    expect(response.headers.get('location')).toBe('https://ui.example.test/logout-complete');
  });

  it('answers 500 without UI config', async () => {
    mocks.ui = null;

    expect((await post(responseXml())).status).toBe(500);
  });

  it('logs a non-success IdP status but still completes the logout', async () => {
    const response = await post(responseXml(STATUS_CODES.RESPONDER));

    expect(response.status).toBe(302);
    expect(mocks.logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'IdP returned logout error',
        context: { statusCode: STATUS_CODES.RESPONDER, statusMessage: undefined },
      })
    );
  });

  it('answers 400 for a missing SAML parameter', async () => {
    const empty = await app().fetch(
      new Request('https://tenant.example.test/slo', { method: 'POST', body: new FormData() }),
      env(),
      ctx
    );
    const get = await redirect({});

    expect([empty.status, get.status]).toEqual([400, 400]);
  });
});
