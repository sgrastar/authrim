/**
 * SAML SSO AuthnRequest parsing and validation: required attributes, NameIDPolicy and
 * RequestedAuthnContext parsing, the exact IssueInstant window and the Destination allow-list.
 * A refusal is observed through the error the SSO handler logs; an accepted request goes on to
 * the SP lookup (answered here as an unknown SP).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SAML_NAMESPACES } from '../../common/constants';

const mocks = vi.hoisted(() => ({
  logs: [] as Array<{ level: string; message: string; error?: Error }>,
  ttl: 300,
  getSP: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const logger = {
    error: (message: string, _context: unknown, error?: Error) =>
      mocks.logs.push({ level: 'error', message, error }),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return {
    ...actual,
    getLogger: () => ({ module: () => logger }),
    createLogger: () => ({ module: () => logger }),
    resolveSamlRequestTtlSeconds: vi.fn(async () => mocks.ttl),
  };
});
vi.mock('../../common/entity-id', () => ({
  getSAMLLocalEntityIds: vi.fn(async () => ({
    issuerUrl: 'https://tenant.example.test',
    idpEntityId: 'https://tenant.example.test/saml/idp',
  })),
}));
vi.mock('../../admin/providers', () => ({ getSPConfig: mocks.getSP }));

import { handleIdPSSO, parseAuthnRequestXml } from '../sso';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const SKEW_MS = 60_000;
const ISSUER_URL = 'https://tenant.example.test';
const P = `xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}"`;

function authnRequest(
  options: {
    attrs?: Record<string, string | null>;
    issuer?: string | null;
    children?: string;
  } = {}
): string {
  const attrs: Record<string, string | null> = {
    ID: '_req1',
    Version: '2.0',
    IssueInstant: new Date(NOW).toISOString(),
    ...options.attrs,
  };
  const attrText = Object.entries(attrs)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}="${value}"`)
    .join(' ');
  const issuer =
    options.issuer === null
      ? ''
      : `<saml:Issuer>${options.issuer ?? 'https://sp.example.test'}</saml:Issuer>`;
  return `<samlp:AuthnRequest ${P} ${attrText}>${issuer}${options.children ?? ''}</samlp:AuthnRequest>`;
}

async function post(xml: string) {
  const form = new FormData();
  form.set('SAMLRequest', btoa(xml));
  const route = new Hono();
  route.use('*', async (c, next) => {
    (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
    await next();
  });
  route.all('/sso', handleIdPSSO as never);
  const response = await route.fetch(
    new Request('https://tenant.example.test/sso', { method: 'POST', body: form }),
    { SETTINGS: { get: vi.fn(async () => null) }, STATE_STORE: {} },
    { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }
  );
  const body = await response.json<{ message: string; status_code: string }>();
  return { response, body };
}

function loggedError(): string | undefined {
  return mocks.logs.find((log) => log.message === 'SSO Error')?.error?.message;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.logs.length = 0;
  mocks.ttl = 300;
  mocks.getSP.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('IssueInstant window', () => {
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

  it.each([
    ['now', 0],
    ['exactly one skew in the future', SKEW_MS],
    ['as old as lifetime plus skew', -(300_000 + SKEW_MS)],
  ])('accepts a request issued %s', async (_label, offset) => {
    const { body } = await post(authnRequest({ attrs: { IssueInstant: at(offset) } }));

    expect(loggedError()).toBeUndefined();
    expect(body.message).toBe('Unknown Service Provider');
  });

  it.each([
    [
      'one second beyond the skew in the future',
      SKEW_MS + 1000,
      'AuthnRequest IssueInstant is in the future',
    ],
    [
      'one second older than lifetime plus skew',
      -(300_000 + SKEW_MS + 1000),
      'AuthnRequest has expired',
    ],
  ])('refuses a request issued %s', async (_label, offset, message) => {
    const { body } = await post(authnRequest({ attrs: { IssueInstant: at(offset) } }));

    expect(loggedError()).toBe(message);
    expect(body).toEqual({
      error: 'saml_error',
      message: 'SSO processing failed',
      status_code: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
    });
  });

  it('follows the tenant request lifetime', async () => {
    mocks.ttl = 60;

    await post(authnRequest({ attrs: { IssueInstant: at(-(60_000 + SKEW_MS + 1000)) } }));
    expect(loggedError()).toBe('AuthnRequest has expired');

    mocks.logs.length = 0;
    await post(authnRequest({ attrs: { IssueInstant: at(-(60_000 + SKEW_MS)) } }));
    expect(loggedError()).toBeUndefined();
  });

  it('refuses an unparsable IssueInstant', async () => {
    await post(authnRequest({ attrs: { IssueInstant: 'yesterday' } }));

    expect(loggedError()).toBe('AuthnRequest IssueInstant is invalid');
  });
});

describe('Destination', () => {
  it.each([
    `${ISSUER_URL}/saml/idp/sso`,
    `${ISSUER_URL}/idp/profile/SAML2/POST/SSO`,
    `${ISSUER_URL}/idp/profile/SAML2/Redirect/SSO`,
  ])('accepts %s', async (destination) => {
    const { body } = await post(authnRequest({ attrs: { Destination: destination } }));

    expect(loggedError()).toBeUndefined();
    expect(body.message).toBe('Unknown Service Provider');
  });

  it.each([
    `${ISSUER_URL}/saml/idp/slo`,
    `${ISSUER_URL}/saml/idp/sso/`,
    'https://other.example.test/saml/idp/sso',
  ])('refuses %s without naming the endpoint', async (destination) => {
    await post(authnRequest({ attrs: { Destination: destination } }));

    expect(loggedError()).toBe('Invalid Destination in SAML AuthnRequest');
  });

  it('does not require a Destination', async () => {
    const { body } = await post(authnRequest());

    expect(body.message).toBe('Unknown Service Provider');
  });
});

describe('parseAuthnRequestXml', () => {
  it('rejects a document that is not an AuthnRequest', () => {
    expect(() =>
      parseAuthnRequestXml(`<samlp:LogoutRequest ${P} ID="x" IssueInstant="y"/>`)
    ).toThrow('Invalid AuthnRequest: missing AuthnRequest element');
    expect(() =>
      parseAuthnRequestXml('<samlp:AuthnRequest xmlns:samlp="urn:evil" ID="x" IssueInstant="y"/>')
    ).toThrow('Invalid AuthnRequest: missing AuthnRequest element');
  });

  it.each([
    ['ID', { ID: null }],
    ['IssueInstant', { IssueInstant: null }],
    ['an empty ID', { ID: '' }],
  ])('requires %s', (_label, attrs) => {
    expect(() => parseAuthnRequestXml(authnRequest({ attrs }))).toThrow(
      'Invalid AuthnRequest: missing required attributes'
    );
  });

  it('requires an Issuer', () => {
    expect(() => parseAuthnRequestXml(authnRequest({ issuer: null }))).toThrow(
      'Invalid AuthnRequest: missing Issuer'
    );
    expect(() => parseAuthnRequestXml(authnRequest({ issuer: '' }))).toThrow(
      'Invalid AuthnRequest: missing Issuer'
    );
  });

  it('reads the optional attributes and defaults the flags to false', () => {
    const request = parseAuthnRequestXml(
      authnRequest({
        attrs: {
          Destination: 'https://d',
          AssertionConsumerServiceURL: 'https://acs',
          AssertionConsumerServiceIndex: '3',
          ProtocolBinding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
          ForceAuthn: 'true',
          IsPassive: '1',
        },
      })
    );

    expect(request).toMatchObject({
      id: '_req1',
      issuer: 'https://sp.example.test',
      destination: 'https://d',
      assertionConsumerServiceURL: 'https://acs',
      assertionConsumerServiceIndex: 3,
      protocolBinding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
      forceAuthn: true,
      isPassive: true,
    });
    const plain = parseAuthnRequestXml(authnRequest());
    expect(plain).toMatchObject({ forceAuthn: false, isPassive: false });
    expect(plain.destination).toBeUndefined();
    expect(plain.assertionConsumerServiceURL).toBeUndefined();
    expect(plain.assertionConsumerServiceIndex).toBeUndefined();
    expect(plain.nameIdPolicy).toBeUndefined();
  });

  it('accepts a boolean attribute only in its XML Schema forms', () => {
    expect(parseAuthnRequestXml(authnRequest({ attrs: { ForceAuthn: 'false' } })).forceAuthn).toBe(
      false
    );
    expect(parseAuthnRequestXml(authnRequest({ attrs: { IsPassive: '0' } })).isPassive).toBe(false);
    expect(() => parseAuthnRequestXml(authnRequest({ attrs: { ForceAuthn: 'yes' } }))).toThrow(
      'Invalid XML boolean value: yes'
    );
  });

  it.each([
    ['0', 0],
    ['12', 12],
    ['007', 7],
    ['-1', undefined],
    ['1.5', undefined],
    ['abc', undefined],
    ['1a', undefined],
    ['a1', undefined],
    ['', undefined],
    ['99999999999999999999', undefined],
  ])('reads AssertionConsumerServiceIndex %j as %s', (raw, expected) => {
    const request = parseAuthnRequestXml(
      authnRequest({ attrs: { AssertionConsumerServiceIndex: raw } })
    );

    expect(request.assertionConsumerServiceIndex).toBe(expected);
  });

  it('reads NameIDPolicy with AllowCreate defaulting to false', () => {
    const withPolicy = parseAuthnRequestXml(
      authnRequest({
        children: `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" AllowCreate="true" SPNameQualifier="https://sp.example.test"/>`,
      })
    );
    const bare = parseAuthnRequestXml(authnRequest({ children: '<samlp:NameIDPolicy/>' }));

    expect(withPolicy.nameIdPolicy).toEqual({
      format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      allowCreate: true,
      spNameQualifier: 'https://sp.example.test',
    });
    expect(bare.nameIdPolicy).toEqual({
      format: null,
      allowCreate: false,
      spNameQualifier: undefined,
    });
  });

  it('ignores a NameIDPolicy that is not a direct child in the protocol namespace', () => {
    const nested = parseAuthnRequestXml(
      authnRequest({
        children: '<samlp:Extensions><samlp:NameIDPolicy AllowCreate="true"/></samlp:Extensions>',
      })
    );
    const wrongNamespace = parseAuthnRequestXml(
      authnRequest({ children: '<saml:NameIDPolicy AllowCreate="true"/>' })
    );

    expect(nested.nameIdPolicy).toBeUndefined();
    expect(wrongNamespace.nameIdPolicy).toBeUndefined();
  });

  it('reads the Issuer only from a direct child', () => {
    expect(() =>
      parseAuthnRequestXml(
        authnRequest({
          issuer: null,
          children: '<samlp:Extensions><saml:Issuer>https://evil</saml:Issuer></samlp:Extensions>',
        })
      )
    ).toThrow('Invalid AuthnRequest: missing Issuer');
  });
});
