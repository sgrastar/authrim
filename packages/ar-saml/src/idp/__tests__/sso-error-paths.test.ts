/**
 * IdP SSO handler: error and edge paths (signed POST request re-parsing, session Flow read
 * failure, release refusals, request parsing failures, response signing/encryption order).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SAML_NAMESPACES } from '../../common/constants';
import { createSamlRequestStoreFake } from './helpers/saml-request-store-fake';

const store = createSamlRequestStoreFake();

interface TestState {
  sp: Record<string, unknown> | null;
  sessionAdapterError: Error | null;
  signatureReferences: Array<{ uri: string; xml: string }> | undefined;
  consent: Record<string, unknown>;
  release: Record<string, unknown>;
  approved: Record<string, unknown>;
  needsIdentifiers: boolean;
}

const mocks = vi.hoisted(() => ({
  ...((): TestState => ({
    sp: null,
    sessionAdapterError: null,
    signatureReferences: undefined,
    consent: { kind: 'issue', approval: ['all'], consentGeneration: 1 },
    release: {},
    needsIdentifiers: false,
    approved: { ok: true, attributes: [] },
  }))(),
  computeRelease: vi.fn<(input: { identifiers: string }) => Promise<unknown>>(),
  withheldAudit: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  signResponse: vi.fn((xml: string, _policy?: unknown, _keys?: unknown) => `${xml}[signed]`),
  encrypt: vi.fn(async (xml: string, _sp?: unknown) => `${xml}[encrypted]`),
  assertSigningPolicy: vi.fn(),
  buildResponse: vi.fn((..._args: unknown[]) => '<saml-success-response/>'),
  buildErrorResponse: vi.fn((_options?: unknown) => '<saml-error-response/>'),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getUIConfig: vi.fn(async () => ({ baseUrl: 'https://ui.example.test' })),
    getTenantSettingsDocument: vi.fn(async () => ({})),
    buildIssuerUrl: vi.fn(() => 'https://tenant.example.test'),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: {
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ userId: 'user-a', data: {} }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
        ),
      },
    })),
    isShardedSessionId: vi.fn(() => true),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async (_env: unknown, purpose: string) => {
      if (purpose === 'saml-idp-sign-in-flow' && mocks.sessionAdapterError) {
        throw mocks.sessionAdapterError;
      }
      return {};
    }),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: mocks.logWarn, info: vi.fn(), debug: mocks.logDebug }),
    }),
  };
});

vi.mock('../../admin/providers', () => ({ getSPConfig: vi.fn(async () => mocks.sp) }));
vi.mock('../../common/entity-id', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/entity-id')>()),
  getSAMLInteractiveLoginUrlPolicy: vi.fn(async () => 'ui_base_url'),
  getSAMLLocalEntityIds: vi.fn(async () => ({
    issuerUrl: 'https://tenant.example.test',
    idpEntityId: 'https://tenant.example.test/saml/idp',
  })),
}));
vi.mock('../../common/session-cookie', () => ({
  extractAuthrimSessionIdFromCookieHeader: vi.fn(() => 'session-id'),
}));
vi.mock('../../common/user-store', () => ({
  getSamlUserInfoById: vi.fn(async () => ({ id: 'user-a', email: 'user@example.test' })),
}));
vi.mock('../../common/idp-signing', () => ({
  getSAMLIdPSigningMaterial: vi.fn(async () => ({ privateKeyPem: 'key', certificate: 'cert' })),
}));
vi.mock('../signing', () => ({
  applySAMLResponseSigningPolicy: mocks.signResponse,
  assertSAMLResponseSigningPolicy: mocks.assertSigningPolicy,
}));
vi.mock('../encryption', () => ({ applySAMLAssertionEncryptionPolicy: mocks.encrypt }));
vi.mock('../assertion', () => ({ buildSAMLResponse: mocks.buildResponse }));
vi.mock('../audit', () => ({
  scheduleSAMLAttributeWithheldAudit: mocks.withheldAudit,
  scheduleSAMLPolicyFailureAudit: vi.fn(),
}));
vi.mock('../authn-request-signature', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../authn-request-signature')>()),
  validateSAMLAuthnRequestSignature: vi.fn(async () => mocks.signatureReferences),
}));
vi.mock('../release-consent', () => ({
  resolveSAMLReleaseConsent: vi.fn(async () => mocks.consent),
  samlReleaseConsentStillCurrent: vi.fn(async () => true),
}));
vi.mock('../release-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../release-items')>()),
  computeSAMLAttributeRelease: (input: { identifiers: string }) => mocks.computeRelease(input),
  samlApprovalNeedsIdentifiers: vi.fn(() => mocks.needsIdentifiers),
  applySAMLReleaseApproval: vi.fn(() => mocks.approved),
  resolveSAMLMappedNameID: vi.fn(async () => undefined),
}));
vi.mock('../subject', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../subject')>()),
  createSAMLSessionIndex: vi.fn(async () => 'session-index'),
  resolveSAMLNameIDFormat: vi.fn(() => 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'),
  resolveSAMLNameIDValue: vi.fn(async () => 'user@example.test'),
}));
vi.mock('../error-response', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../error-response')>()),
  buildSAMLIdPErrorResponse: mocks.buildErrorResponse,
  applySAMLErrorResponseOverride: vi.fn((_config: unknown, input: unknown) => input),
}));

import { handleIdPSSO } from '../sso';

const ISSUER = 'https://sp.example.test/entity';

function sp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: ISSUER,
    acsUrl: 'https://sp.example.test/acs',
    acsUrls: ['https://sp.example.test/acs'],
    allowedBindings: ['post'],
    authnRequestSignaturePolicy: 'optional',
    signResponses: false,
    signAssertions: false,
    informationReleaseConsent: { enabled: false },
    ...overrides,
  };
}

function authnRequest(extra = '') {
  return `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ID="_request" IssueInstant="${new Date().toISOString()}" ${extra}>
    <saml:Issuer>${ISSUER}</saml:Issuer>
  </samlp:AuthnRequest>`;
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

const environment = () => ({
  SETTINGS: { get: vi.fn(async () => null) },
  SAML_REQUEST_STORE: {
    idFromName: vi.fn((name: string) => ({ name })),
    get: vi.fn(() => ({ fetch: store.fetch })),
  },
});

const send = (url: string, init?: RequestInit) =>
  app().fetch(new Request(url, init), environment(), {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  });

function postRequest(xml: string) {
  const form = new FormData();
  form.set('SAMLRequest', btoa(xml));
  return send('https://tenant.example.test/sso', { method: 'POST', body: form });
}

const RESUME_URL = `https://tenant.example.test/sso?saml_request_id=_request&saml_sp_entity_id=${encodeURIComponent(ISSUER)}`;

beforeEach(() => {
  vi.clearAllMocks();
  store.reset();
  mocks.sp = sp();
  mocks.sessionAdapterError = null;
  mocks.signatureReferences = undefined;
  mocks.consent = { kind: 'issue', approval: ['all'], consentGeneration: 1 };
  mocks.release = {
    attributes: [],
    required: 'all',
    labels: new Map(),
    deferred: new Set(),
    withheldScopedValues: [],
    optionalMissingAttributes: [],
  };
  mocks.needsIdentifiers = false;
  mocks.approved = { ok: true, attributes: [{ name: 'mail', values: ['user@example.test'] }] };
  mocks.computeRelease.mockImplementation(async () => mocks.release);
});

const errorStatus = () =>
  mocks.buildErrorResponse.mock.calls[0]?.[0] as
    | { statusCode: string; secondLevelStatusCode: string; statusMessage: string }
    | undefined;

describe('signed POST AuthnRequest', () => {
  const signed = (id: string, issuer = ISSUER, issueInstant = new Date().toISOString()) =>
    `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ID="${id}" IssueInstant="${issueInstant}"><saml:Issuer>${issuer}</saml:Issuer></samlp:AuthnRequest>`;

  it('answers a protocol error when no signed reference covers the request', async () => {
    mocks.signatureReferences = [{ uri: '#_another', xml: signed('_another') }];

    const response = await postRequest(authnRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildErrorResponse).toHaveBeenCalledOnce();
    expect(errorStatus()?.statusMessage).toBe('SAML request was rejected by IdP policy');
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it.each([
    ['another ID', signed('_other')],
    ['another issuer', signed('_request', 'https://attacker.example/entity')],
  ])('answers a protocol error when the signed request has %s', async (_label, xml) => {
    mocks.signatureReferences = [{ uri: '#_request', xml }];

    const response = await postRequest(authnRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildErrorResponse).toHaveBeenCalledOnce();
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('validates the signed request itself, not the routed one', async () => {
    // The routed message is fresh; the signed one is 30 minutes old and so refused.
    mocks.signatureReferences = [
      {
        uri: '#_request',
        xml: signed('_request', ISSUER, new Date(Date.now() - 30 * 60_000).toISOString()),
      },
    ];

    const response = await postRequest(authnRequest());

    expect(response.status).toBe(400);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });

  it('issues a response when the signed request matches the routed one', async () => {
    mocks.signatureReferences = [{ uri: '#_request', xml: signed('_request') }];

    const response = await postRequest(authnRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
    expect(mocks.buildErrorResponse).not.toHaveBeenCalled();
  });
});

describe('request parsing failures', () => {
  it('refuses a GET without any SAMLRequest', async () => {
    const response = await send('https://tenant.example.test/sso');
    expect(response.status).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it('refuses a resume that names no SP entity', async () => {
    const response = await send('https://tenant.example.test/sso?saml_request_id=_request');
    expect(response.status).toBe(400);
    expect(store.calls).toEqual([]);
  });
});

describe('a session whose sign-in Flow cannot be read', () => {
  it('sends the person to sign in again instead of answering', async () => {
    store.seed({
      type: 'authn_request',
      issuer: ISSUER,
      requestId: '_request',
      relayState: 'relay',
      binding: 'post',
      data: {
        id: '_request',
        issueInstant: new Date().toISOString(),
        issuer: ISSUER,
        assertionConsumerServiceURL: 'https://sp.example.test/acs',
      },
      context: { sentToSignInAt: 1 },
    } as never);
    mocks.sessionAdapterError = new Error('flow database unavailable');

    const response = await send(RESUME_URL);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('https://ui.example.test/login');
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'SAML sign-in Flow could not be read for the session',
      {},
      mocks.sessionAdapterError
    );
    // Updated for the next attempt, not used up.
    expect(store.calls).toContain('update');
    expect(store.calls).not.toContain('complete');
  });
});

describe('attribute release', () => {
  it('makes identifiers once approved and audits withheld scoped values', async () => {
    mocks.needsIdentifiers = true;
    const withheld = [{ name: 'eppn', reason: 'scope' }];
    mocks.release = { ...mocks.release, withheldScopedValues: withheld };

    const response = await postRequest(authnRequest());

    expect(response.status).toBe(200);
    expect(mocks.computeRelease.mock.calls.map(([input]) => input.identifiers)).toEqual([
      'deferred',
      'made',
    ]);
    expect(mocks.withheldAudit).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      spEntityId: ISSUER,
      authnRequestId: '_request',
      withheld,
    });
    expect(mocks.buildResponse).toHaveBeenCalledOnce();
  });

  it('keeps the deferred release and audits nothing when no identifier is needed', async () => {
    const response = await postRequest(authnRequest());

    expect(response.status).toBe(200);
    expect(mocks.computeRelease).toHaveBeenCalledOnce();
    expect(mocks.withheldAudit).not.toHaveBeenCalled();
  });

  it('logs the optional attributes it leaves out', async () => {
    mocks.release = { ...mocks.release, optionalMissingAttributes: ['displayName'] };

    const response = await postRequest(authnRequest());

    expect(response.status).toBe(200);
    expect(mocks.logDebug).toHaveBeenCalledWith('Optional SAML attributes omitted', {
      tenantId: 'tenant-a',
      spEntityId: ISSUER,
      authnRequestId: '_request',
      missingAttributes: ['displayName'],
    });
  });

  it('answers a protocol error naming what the approval left out, when the SP asks for detail', async () => {
    mocks.sp = sp({ attributeReleaseFailureUserMessageMode: 'detailed' });
    mocks.approved = { ok: false, missing: ['mail'] };

    const response = await postRequest(authnRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(errorStatus()?.statusMessage).toMatch(/: mail$/u);
  });

  it('keeps the failure message generic by default', async () => {
    mocks.approved = { ok: false, missing: ['mail'] };

    await postRequest(authnRequest());

    expect(errorStatus()?.statusMessage).not.toContain('mail');
  });
});

describe('response signing and encryption order', () => {
  const keys = { privateKeyPem: 'key', certificate: 'cert' };

  it('signs nothing and encrypts nothing for a plain SP', async () => {
    await postRequest(authnRequest());

    expect(mocks.assertSigningPolicy).toHaveBeenCalledWith(mocks.sp);
    expect(mocks.signResponse).not.toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it('encrypts only the NameID before signing the assertion, then signs the response', async () => {
    mocks.sp = sp({ encryptNameID: true, signAssertions: true, signResponses: true });

    const response = await postRequest(authnRequest());

    expect(response.status).toBe(200);
    expect(mocks.encrypt).toHaveBeenCalledOnce();
    expect(mocks.encrypt).toHaveBeenCalledWith('<saml-success-response/>', mocks.sp);
    expect(mocks.signResponse.mock.calls).toEqual([
      ['<saml-success-response/>[encrypted]', { signAssertions: true, signResponses: false }, keys],
      [
        '<saml-success-response/>[encrypted][signed]',
        { signAssertions: false, signResponses: true },
        keys,
      ],
    ]);
  });

  it('encrypts the whole assertion after signing it, and before signing the response', async () => {
    mocks.sp = sp({
      encryptAssertions: true,
      encryptNameID: true,
      signAssertions: true,
      signResponses: true,
    });

    await postRequest(authnRequest());

    // A full-assertion encryption takes the NameID with it: encrypted once, after the signature.
    expect(mocks.encrypt).toHaveBeenCalledOnce();
    expect(mocks.encrypt).toHaveBeenCalledWith('<saml-success-response/>[signed]', mocks.sp);
    expect(mocks.signResponse.mock.calls[0]?.[1]).toEqual({
      signAssertions: true,
      signResponses: false,
    });
    expect(mocks.signResponse.mock.calls[1]?.[0]).toBe(
      '<saml-success-response/>[signed][encrypted]'
    );
  });

  it('only signs the response for an SP that signs responses', async () => {
    mocks.sp = sp({ signResponses: true });

    await postRequest(authnRequest());

    expect(mocks.signResponse).toHaveBeenCalledOnce();
    expect(mocks.signResponse).toHaveBeenCalledWith(
      '<saml-success-response/>',
      { signAssertions: false, signResponses: true },
      keys
    );
  });
});
