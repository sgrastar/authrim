/**
 * SP SLO: LogoutRequest timing and destination boundaries, session termination, the POST
 * LogoutResponse and the SP-initiated LogoutRequest.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { NAMEID_FORMATS, SAML_NAMESPACES, STATUS_CODES } from '../../common/constants';

const mocks = vi.hoisted(() => ({
  idp: null as Record<string, unknown> | null,
  sessionFetch: vi.fn(
    async (..._args: unknown[]): Promise<Response> => new Response(null, { status: 204 })
  ),
  activeUser: null as { id: string } | null,
  nameId: null as string | null,
  epoch: vi.fn(async (..._args: unknown[]) => undefined),
  store: vi.fn(async (..._args: unknown[]) => undefined),
  signXml: vi.fn((xml: string, _options: unknown) => `signed(${xml})`),
  signingThrows: false,
  logs: [] as Array<{ level: string; message: string; context: unknown }>,
  ui: { baseUrl: 'https://ui.example.test' },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const logger = {
    error: (message: string, context: unknown) =>
      mocks.logs.push({ level: 'error', message, context }),
    warn: (message: string, context: unknown) =>
      mocks.logs.push({ level: 'warn', message, context }),
    info: (message: string, context: unknown) =>
      mocks.logs.push({ level: 'info', message, context }),
    debug: (message: string, context: unknown) =>
      mocks.logs.push({ level: 'debug', message, context }),
  };
  return {
    ...actual,
    getSessionStoreBySessionId: vi.fn(() => ({ stub: { fetch: mocks.sessionFetch } })),
    isShardedSessionId: vi.fn((id: string) => id.startsWith('sess_')),
    getUIConfig: vi.fn(async () => mocks.ui),
    buildUIUrl: vi.fn((config: { baseUrl: string }) => `${config.baseUrl}/logout-complete`),
    usesNakedDomainIssuer: vi.fn(() => false),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: { marker: 'core' } })),
    recordHybridUserSessionRevocationEpoch: mocks.epoch,
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
vi.mock('../../common/saml-signing-keys', () => ({
  getSAMLSigningMaterial: vi.fn(async () => {
    if (mocks.signingThrows) throw new Error('signing unavailable');
    return { privateKeyPem: 'private-key', certificate: 'certificate' };
  }),
  getSAMLSigningPolicy: vi.fn(() => undefined),
}));
vi.mock('../../common/signature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/signature')>();
  return { ...actual, signXml: mocks.signXml };
});
vi.mock('../../common/user-store', () => ({
  findActiveSamlUserByEmail: vi.fn(async () => mocks.activeUser),
  getSamlUserNameIdById: vi.fn(async () => mocks.nameId),
}));
vi.mock('../../idp/slo-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../idp/slo-state')>();
  return { ...actual, storeSAMLOutboundLogoutRequest: mocks.store };
});

import { handleSPSLO, initiateSPLogout } from '../slo';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const SKEW_MS = 60_000;
const IDP_ENTITY = 'https://idp.example.test/entity';
const SLO_URL = 'https://tenant.example.test/saml/sp/slo';

function requestXml(
  options: {
    issueInstant?: string;
    destination?: string;
    notOnOrAfter?: string;
    sessionIndex?: string;
  } = {}
) {
  const attrs = [
    'ID="_logout"',
    `IssueInstant="${options.issueInstant ?? new Date(NOW).toISOString()}"`,
    options.destination ? `Destination="${options.destination}"` : '',
    options.notOnOrAfter ? `NotOnOrAfter="${options.notOnOrAfter}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const session = options.sessionIndex
    ? `<samlp:SessionIndex>${options.sessionIndex}</samlp:SessionIndex>`
    : '';
  return `<samlp:LogoutRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ${attrs}>
    <saml:Issuer>${IDP_ENTITY}</saml:Issuer>
    <saml:NameID Format="${NAMEID_FORMATS.EMAIL}">user@example.test</saml:NameID>${session}
  </samlp:LogoutRequest>`;
}

async function post(xml: string, relayState?: string) {
  const form = new FormData();
  form.set('SAMLRequest', btoa(xml));
  if (relayState) form.set('RelayState', relayState);
  const route = new Hono();
  route.use('*', async (c, next) => {
    (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
    await next();
  });
  route.all('/slo', handleSPSLO as never);
  return route.fetch(
    new Request('https://tenant.example.test/slo', { method: 'POST', body: form }),
    { STATE_STORE: {}, SETTINGS: { get: vi.fn(async () => null) } },
    { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }
  );
}

const sessionLogs = (message: string) => mocks.logs.filter((log) => log.message === message);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.idp = {
    entityId: IDP_ENTITY,
    ssoUrl: 'https://idp.example.test/sso',
    sloUrl: 'https://idp.example.test/slo',
    certificate: 'cert',
    logoutRequestSignaturePolicy: 'disabled',
  };
  mocks.sessionFetch.mockImplementation(async () =>
    Response.json({ success: true, deleted: 'sess_abc' })
  );
  mocks.activeUser = null;
  mocks.nameId = 'user@example.test';
  mocks.signingThrows = false;
  mocks.logs.length = 0;
  mocks.ui = { baseUrl: 'https://ui.example.test' };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LogoutRequest validation boundaries', () => {
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

  it('accepts an IssueInstant exactly one skew ahead and rejects one second more', async () => {
    expect((await post(requestXml({ issueInstant: at(SKEW_MS) }))).status).toBe(200);
    expect((await post(requestXml({ issueInstant: at(SKEW_MS + 1000) }))).status).toBe(400);
  });

  it('accepts a request as old as lifetime plus skew and rejects one second older', async () => {
    expect((await post(requestXml({ issueInstant: at(-(300_000 + SKEW_MS)) }))).status).toBe(200);
    expect((await post(requestXml({ issueInstant: at(-(300_000 + SKEW_MS + 1000)) }))).status).toBe(
      400
    );
  });

  it('treats NotOnOrAfter as exclusive at the skew boundary', async () => {
    expect((await post(requestXml({ notOnOrAfter: at(-SKEW_MS + 1000) }))).status).toBe(200);
    expect((await post(requestXml({ notOnOrAfter: at(-SKEW_MS) }))).status).toBe(400);
    expect((await post(requestXml({ notOnOrAfter: 'later' }))).status).toBe(400);
  });

  it('accepts only the exact SP logout endpoint as Destination', async () => {
    expect((await post(requestXml({ destination: SLO_URL }))).status).toBe(200);
    expect((await post(requestXml({ destination: `${SLO_URL}/` }))).status).toBe(400);
    expect(
      (await post(requestXml({ destination: 'https://tenant.example.test/saml/sp/acs' }))).status
    ).toBe(400);
  });

  it('rejects an unparsable IssueInstant', async () => {
    expect((await post(requestXml({ issueInstant: 'soon' }))).status).toBe(400);
  });
});

describe('answering the IdP', () => {
  it('sends a POST LogoutResponse to the IdP logout endpoint and clears the session cookie', async () => {
    const response = await post(requestXml(), 'relay-1');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe(
      'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    );
    expect(html).toContain('action="https://idp.example.test/slo"');
    expect(html).toContain('<title>SAML Logout</title>');
    expect(html).toContain('>Continue</button>');
    expect(html).toContain('name="RelayState" value="relay-1"');
    const encoded = /name="SAMLResponse" value="([^"]+)"/.exec(html)?.[1] ?? '';
    const xml = atob(encoded.replace(/&#43;/g, '+').replace(/&#x2F;/g, '/'));
    expect(xml.startsWith('signed(')).toBe(true);
    expect(xml).toContain(`Value="${STATUS_CODES.SUCCESS}"`);
    expect(xml).toContain('InResponseTo="_logout"');
    expect(xml).toContain(
      '<saml:Issuer>https://tenant.example.test/saml/sp/metadata</saml:Issuer>'
    );
    const [, options] = mocks.signXml.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).toMatchObject({
      privateKey: 'private-key',
      certificate: 'certificate',
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
    expect(String(options.referenceUri)).toMatch(/^#_[0-9a-f]+$/);
  });

  it('omits RelayState when none was sent and uses the SSO URL without a logout endpoint', async () => {
    mocks.idp = { ...mocks.idp, sloUrl: undefined };

    const html = await (await post(requestXml())).text();

    expect(html).toContain('action="https://idp.example.test/sso"');
    expect(html).not.toContain('RelayState');
  });

  it('fails closed (no unsigned LogoutResponse) when signing fails, and logs it', async () => {
    mocks.signingThrows = true;

    const response = await post(requestXml());

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('SAMLResponse');
    expect(
      mocks.logs.some(
        (log) => log.level === 'error' && log.message === 'Error signing LogoutResponse'
      )
    ).toBe(true);
    expect(mocks.signXml).not.toHaveBeenCalled();
  });

  it('refuses a LogoutRequest from an unknown IdP', async () => {
    mocks.idp = null;

    const response = await post(requestXml());

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.logs).toContainEqual({
      level: 'error',
      message: 'Unknown IdP',
      context: { issuer: IDP_ENTITY },
    });
  });
});

describe('session termination', () => {
  it('deletes a sharded SessionIndex session through its store and stops', async () => {
    await post(requestXml({ sessionIndex: 'sess_abc' }));

    expect(mocks.sessionFetch).toHaveBeenCalledWith('https://session-store/session/sess_abc', {
      method: 'DELETE',
    });
    expect(sessionLogs('Terminated session')[0]?.context).toEqual({ sessionIndex: 'sess_abc' });
    expect(mocks.epoch).not.toHaveBeenCalled();
  });

  it('falls back to the user revocation epoch when the session is already gone', async () => {
    // Real SessionStore contract: a missing session is HTTP 200 with `deleted: null`.
    mocks.sessionFetch.mockResolvedValue(Response.json({ success: true, deleted: null }));
    mocks.activeUser = { id: 'user-a' };

    await post(requestXml({ sessionIndex: 'sess_gone' }));

    expect(sessionLogs('Session not found or already deleted')[0]?.context).toEqual({
      sessionIndex: 'sess_gone',
    });
    expect(mocks.epoch).toHaveBeenCalledWith(
      expect.anything(),
      { marker: 'core' },
      'tenant-a',
      'user-a'
    );
    expect(sessionLogs('Terminated all user sessions by revocation epoch')).toHaveLength(1);
  });

  it('warns about a SessionIndex that is not a sharded session id, and uses the epoch', async () => {
    mocks.activeUser = { id: 'user-a' };

    await post(requestXml({ sessionIndex: 'opaque-index' }));

    expect(mocks.sessionFetch).not.toHaveBeenCalled();
    expect(sessionLogs('sessionIndex is not in sharded format, cannot delete')[0]?.context).toEqual(
      {
        sessionIndex: 'opaque-index',
      }
    );
    expect(mocks.epoch).toHaveBeenCalledTimes(1);
  });

  it('logs a failed deletion and still tries the user epoch', async () => {
    mocks.sessionFetch.mockRejectedValue(new Error('store down'));
    mocks.activeUser = { id: 'user-a' };

    const response = await post(requestXml({ sessionIndex: 'sess_x' }));

    expect(response.status).toBe(200);
    expect(sessionLogs('Failed to delete session')[0]?.context).toEqual({ sessionIndex: 'sess_x' });
    expect(mocks.epoch).toHaveBeenCalledTimes(1);
  });

  it('answers success even when no user is found, with a PII-free warning', async () => {
    const response = await post(requestXml());

    expect(response.status).toBe(200);
    expect(sessionLogs('No user found for logout request')[0]?.context).toEqual({});
    expect(mocks.epoch).not.toHaveBeenCalled();
  });

  it('logs and survives a failure of the epoch write', async () => {
    mocks.activeUser = { id: 'user-a' };
    mocks.epoch.mockRejectedValueOnce(new Error('db down'));

    const response = await post(requestXml());

    expect(response.status).toBe(200);
    expect(sessionLogs('Error terminating session')).toHaveLength(1);
  });
});

describe('initiateSPLogout', () => {
  const idpConfig = {
    entityId: IDP_ENTITY,
    ssoUrl: 'https://idp.example.test/sso',
    sloUrl: 'https://idp.example.test/slo',
  } as never;
  const env = { STATE_STORE: {}, SETTINGS: { get: vi.fn(async () => null) } } as unknown as Env;

  it('requires a tenant, a NameID and the state store', async () => {
    await expect(
      initiateSPLogout(env, 'user-a', idpConfig, 'sess_1', undefined, undefined)
    ).rejects.toThrow('SP-initiated SLO tenant');
    mocks.nameId = null;
    await expect(
      initiateSPLogout(env, 'user-a', idpConfig, 'sess_1', undefined, 'tenant-a')
    ).rejects.toThrow('Logout request could not be processed');
    mocks.nameId = 'user@example.test';
    await expect(
      initiateSPLogout(
        { SETTINGS: env.SETTINGS } as unknown as Env,
        'user-a',
        idpConfig,
        'sess_1',
        undefined,
        'tenant-a'
      )
    ).rejects.toThrow('STATE_STORE is required for SP-initiated SLO correlation');
  });

  it('records the outbound request, signs it and posts it to the IdP with the request id as RelayState', async () => {
    const { html } = await initiateSPLogout(
      env,
      'user-a',
      idpConfig,
      'sess_1',
      'https://app.example.test/after',
      'tenant-a'
    );

    expect(html).toContain('action="https://idp.example.test/slo"');
    expect(html).toContain('<title>SAML Logout</title>');
    expect(html).toContain('>Continue to Logout</button>');
    const id = /name="RelayState" value="(_[0-9a-f]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(mocks.store).toHaveBeenCalledWith(
      env.STATE_STORE,
      expect.objectContaining({
        tenantId: 'tenant-a',
        spEntityId: IDP_ENTITY,
        requestId: id,
        relayState: 'https://app.example.test/after',
        ttlSeconds: 300,
      })
    );
    const [xml, options] = mocks.signXml.mock.calls[0] as [string, Record<string, unknown>];
    expect(options).toMatchObject({
      referenceUri: `#${id}`,
      signatureLocation: 'prepend',
      includeKeyInfo: true,
    });
    expect(xml).toContain('Destination="https://idp.example.test/slo"');
    expect(xml).toContain('>user@example.test</saml:NameID>');
    expect(xml).toContain('<samlp:SessionIndex>sess_1</samlp:SessionIndex>');
    expect(xml).toContain(`Format="${NAMEID_FORMATS.EMAIL}"`);
  });

  it('omits RelayState without a return URL and uses the SSO URL without a logout endpoint', async () => {
    const { html } = await initiateSPLogout(
      env,
      'user-a',
      { ...(idpConfig as object), sloUrl: undefined } as never,
      'sess_1',
      undefined,
      'tenant-a'
    );

    expect(html).toContain('action="https://idp.example.test/sso"');
    expect(html).not.toContain('RelayState');
  });

  it('logs a signing failure and rejects instead of sending the request unsigned', async () => {
    mocks.signingThrows = true;

    await expect(
      initiateSPLogout(env, 'user-a', idpConfig, 'sess_1', undefined, 'tenant-a')
    ).rejects.toThrow();

    expect(mocks.logs).toContainEqual({
      level: 'error',
      message: 'Error signing LogoutRequest',
      context: { action: 'sign_logout_request' },
    });
    expect(mocks.signXml).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });
});
