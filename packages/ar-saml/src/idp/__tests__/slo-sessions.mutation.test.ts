/**
 * IdP SLO session termination on a LogoutRequest, and LogoutResponse handling (fan-out
 * bookkeeping, non-success statuses, the return redirect).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { NAMEID_FORMATS, SAML_NAMESPACES, STATUS_CODES } from '../../common/constants';

const mocks = vi.hoisted(() => ({
  sp: null as Record<string, unknown> | null,
  ui: undefined as { baseUrl: string } | undefined,
  sessionFetch: vi.fn(
    async (..._args: unknown[]): Promise<Response> => new Response(null, { status: 204 })
  ),
  resolvedSessionId: null as string | null,
  resolveIndex: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
  activeUser: null as { id: string } | null,
  outbound: { requestId: '', spEntityId: '', transactionId: undefined as string | undefined },
  deleteOutbound: vi.fn(async (..._args: unknown[]) => undefined),
  markCompleted: vi.fn(async (..._args: unknown[]) => undefined),
  nextRequest: vi.fn(async (..._args: unknown[]): Promise<Response | null> => null),
  audit: vi.fn(async (..._args: unknown[]) => undefined),
  epoch: vi.fn(async (..._args: unknown[]) => undefined),
  logs: [] as Array<{ level: string; message: string; context: unknown }>,
  federation: null as Record<string, unknown> | null,
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
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: { marker: 'core' } })),
    recordHybridUserSessionRevocationEpoch: mocks.epoch,
    createAuditLog: mocks.audit,
    getLogger: () => ({ module: () => logger }),
    createLogger: () => ({ module: () => logger }),
  };
});

vi.mock('../../admin/providers', () => ({ getSPConfig: vi.fn(async () => mocks.sp) }));

vi.mock('../../common/entity-id', () => ({
  getSAMLLocalEntityIds: vi.fn(async () => ({
    issuerUrl: 'https://tenant.example.test',
    idpEntityId: 'https://tenant.example.test/saml/idp',
  })),
}));

vi.mock('../../common/idp-signing', () => ({
  getSAMLIdPSigningMaterial: vi.fn(async () => ({
    privateKeyPem: 'private-key',
    certificate: 'certificate',
  })),
}));

vi.mock('../../common/signature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/signature')>();
  return { ...actual, signXml: vi.fn((xml: string) => xml) };
});

vi.mock('../../common/user-store', () => ({
  findActiveSamlUserByEmail: vi.fn(async () => mocks.activeUser),
  getSamlUserInfoById: vi.fn(async () => null),
  getSamlUserNameIdById: vi.fn(async () => null),
}));

vi.mock('../release-items', () => ({ resolveSAMLMappedNameID: vi.fn(async () => undefined) }));
vi.mock('../subject', () => ({
  readSAMLSessionIndexNameID: vi.fn(async () => ({ format: NAMEID_FORMATS.EMAIL })),
  resolveEffectiveSAMLNameIDFormat: () => NAMEID_FORMATS.EMAIL,
  resolveSAMLPersistentNameIDRegistryStore: vi.fn(() => undefined),
  resolveSAMLNameIDValue: vi.fn(async () => 'name-id'),
  resolveSAMLPairwiseSecret: vi.fn(async () => 'secret'),
  resolveSAMLSessionIndexToSessionId: mocks.resolveIndex,
  SAMLNameIDPolicyError: class extends Error {},
}));

vi.mock('../slo-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slo-state')>();
  return {
    ...actual,
    getSAMLOutboundLogoutRequest: vi.fn(async () => mocks.outbound),
    deleteSAMLOutboundLogoutRequest: mocks.deleteOutbound,
    markSAMLIdPLogoutFanoutTargetCompleted: mocks.markCompleted,
    getSAMLIdPLogoutFanoutTransaction: vi.fn(async () => null),
  };
});

import { handleIdPSLO } from '../slo';

const SP_ENTITY = 'https://sp.example.test/entity';
const NOW = Date.parse('2026-06-01T12:00:00Z');

function sp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: SP_ENTITY,
    acsUrl: 'https://sp.example.test/acs',
    sloUrl: 'https://sp.example.test/slo',
    sloResponseUrl: 'https://sp.example.test/slo/response',
    allowedBindings: ['post'],
    logoutRequestSignaturePolicy: 'disabled',
    logoutResponseSignaturePolicy: 'disabled',
    ...overrides,
  };
}

interface RequestOptions {
  issueInstant?: string;
  destination?: string;
  notOnOrAfter?: string;
  nameIdFormat?: string;
  nameQualifier?: string;
  spNameQualifier?: string;
  sessionIndices?: string[];
}

function requestXml(options: RequestOptions = {}): string {
  const attrs = [
    'ID="_logout"',
    `IssueInstant="${options.issueInstant ?? new Date(NOW).toISOString()}"`,
    options.destination ? `Destination="${options.destination}"` : '',
    options.notOnOrAfter ? `NotOnOrAfter="${options.notOnOrAfter}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const nameAttrs = [
    `Format="${options.nameIdFormat ?? NAMEID_FORMATS.EMAIL}"`,
    options.nameQualifier ? `NameQualifier="${options.nameQualifier}"` : '',
    options.spNameQualifier ? `SPNameQualifier="${options.spNameQualifier}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const indices = (options.sessionIndices ?? [])
    .map((index) => `<samlp:SessionIndex>${index}</samlp:SessionIndex>`)
    .join('');
  return `<samlp:LogoutRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ${attrs}>
    <saml:Issuer>${SP_ENTITY}</saml:Issuer>
    <saml:NameID ${nameAttrs}>user@example.test</saml:NameID>${indices}
  </samlp:LogoutRequest>`;
}

function responseXml(options: { destination?: string; statusCode?: string } = {}): string {
  return `<samlp:LogoutResponse xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}"
    ID="_response" IssueInstant="${new Date(NOW).toISOString()}" InResponseTo="_outbound"
    ${options.destination ? `Destination="${options.destination}"` : ''}>
    <saml:Issuer>${SP_ENTITY}</saml:Issuer>
    <samlp:Status><samlp:StatusCode Value="${options.statusCode ?? STATUS_CODES.SUCCESS}"/><samlp:StatusMessage>why</samlp:StatusMessage></samlp:Status>
  </samlp:LogoutResponse>`;
}

async function post(field: 'SAMLRequest' | 'SAMLResponse', xml: string) {
  const form = new FormData();
  form.set(field, btoa(xml));
  const route = new Hono();
  route.use('*', async (c, next) => {
    (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
    await next();
  });
  route.all('/slo', handleIdPSLO as never);
  return route.fetch(
    new Request('https://tenant.example.test/slo', { method: 'POST', body: form }),
    {
      STATE_STORE: {},
      SETTINGS: {
        get: vi.fn(async (key: string) =>
          key === 'settings:tenant:tenant-a:federation' && mocks.federation
            ? JSON.stringify(mocks.federation)
            : null
        ),
      },
    },
    { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }
  );
}

/** The LogoutResponse carried by the auto-submitting POST form of a protocol response. */
async function protocolResponse(response: Response) {
  const html = await response.text();
  const encoded = /name="SAMLResponse" value="([^"]+)"/.exec(html)?.[1] ?? '';
  const xml = atob(encoded.replace(/&#43;/g, '+').replace(/&#x2F;/g, '/'));
  return {
    destination: /action="([^"]*)"/.exec(html)?.[1],
    statusCode: /<samlp:StatusCode Value="([^"]+)"/.exec(xml)?.[1],
    statusMessage: /<samlp:StatusMessage>([^<]*)<\/samlp:StatusMessage>/.exec(xml)?.[1],
    inResponseTo: /InResponseTo="([^"]+)"/.exec(xml)?.[1],
  };
}

function policyAudits(): Array<Record<string, unknown>> {
  return mocks.audit.mock.calls
    .map((call) => call[1] as Record<string, unknown>)
    .filter((entry) => entry.action === 'saml.policy.failed')
    .map((entry) => JSON.parse(String(entry.metadata)) as Record<string, unknown>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.sp = sp();
  mocks.ui = { baseUrl: 'https://ui.example.test' };
  // Real SessionStore contract: DELETE answers 200 + `deleted` (the id, or null when it did not exist).
  mocks.sessionFetch.mockImplementation(async (...args: unknown[]) =>
    Response.json({ success: true, deleted: (args[0] as string).split('/').pop() })
  );
  mocks.resolveIndex.mockResolvedValue(null);
  mocks.activeUser = null;
  mocks.outbound = { requestId: '_outbound', spEntityId: SP_ENTITY, transactionId: undefined };
  mocks.logs.length = 0;
  mocks.federation = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session termination', () => {
  it('resolves an opaque SessionIndex and deletes the session through its store', async () => {
    mocks.resolveIndex.mockResolvedValue('sess_abc');

    const response = await post('SAMLRequest', requestXml({ sessionIndices: ['sidx_1'] }));

    expect(response.status).toBe(200);
    expect(mocks.resolveIndex.mock.calls[0]?.[1]).toEqual({
      tenantId: 'tenant-a',
      spEntityId: SP_ENTITY,
      sessionIndex: 'sidx_1',
    });
    expect(mocks.sessionFetch).toHaveBeenCalledWith('https://session-store/session/sess_abc', {
      method: 'DELETE',
    });
    expect(mocks.logs).toContainEqual({
      level: 'info',
      message: 'Terminated session',
      context: { sessionIndex: 'sidx_1' },
    });
    expect(mocks.logs).toContainEqual({
      level: 'info',
      message: 'Terminated sessions from SAML LogoutRequest',
      context: { requestedSessionIndexCount: 1, terminatedCount: 1 },
    });
    expect(mocks.epoch).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBe(
      'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    );
  });

  const storeCalls = () => mocks.sessionFetch.mock.calls;

  it('treats a SessionIndex without the sidx_ prefix as unresolvable and never queries the session store', async () => {
    mocks.activeUser = { id: 'user-a' };

    const response = await post(
      'SAMLRequest',
      requestXml({ sessionIndices: ['sess_direct', 'sess_direct', 'sess_other'] })
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveIndex).not.toHaveBeenCalled();
    expect(storeCalls()).toHaveLength(0);
    expect(
      mocks.logs.filter(
        (log) =>
          log.level === 'warn' &&
          log.message === 'sessionIndex could not be resolved to a sharded session'
      )
    ).toHaveLength(2);
  });

  it('falls back to user-level revocation when only non-sidx_ indices are given', async () => {
    mocks.activeUser = { id: 'user-a' };

    await post('SAMLRequest', requestXml({ sessionIndices: ['sess_victim'] }));

    expect(storeCalls()).toHaveLength(0);
    expect(mocks.epoch).toHaveBeenCalledTimes(1);
  });

  it('revokes nothing for a non-sidx_ index when the NameID has no user', async () => {
    mocks.activeUser = null;

    await post('SAMLRequest', requestXml({ sessionIndices: ['sess_x'] }));

    expect(storeCalls()).toHaveLength(0);
    expect(mocks.epoch).not.toHaveBeenCalled();
  });

  it('counts only sessions that were actually deleted', async () => {
    mocks.activeUser = { id: 'user-a' };
    mocks.resolveIndex.mockImplementation(async (...args: unknown[]) =>
      String((args[1] as { sessionIndex: string }).sessionIndex).replace('sidx_', 'sess_')
    );
    mocks.sessionFetch.mockImplementation(async (...args: unknown[]) => {
      const [url] = args as [string];
      // Real contract: a missing session is still HTTP 200, reported as `deleted: null`.
      return Response.json({
        success: true,
        deleted: url.endsWith('sess_missing') ? null : url.split('/').pop(),
      });
    });

    await post('SAMLRequest', requestXml({ sessionIndices: ['sidx_missing', 'sidx_ok'] }));

    expect(mocks.logs).toContainEqual({
      level: 'debug',
      message: 'Session not found or already deleted',
      context: { sessionIndex: 'sidx_missing' },
    });
    expect(mocks.logs).toContainEqual({
      level: 'info',
      message: 'Terminated sessions from SAML LogoutRequest',
      context: { requestedSessionIndexCount: 2, terminatedCount: 1 },
    });
  });

  it('skips an index that does not resolve to a sharded session and then falls back to the user', async () => {
    mocks.resolveIndex.mockResolvedValue(null);
    mocks.activeUser = { id: 'user-a' };

    const response = await post(
      'SAMLRequest',
      requestXml({ sessionIndices: ['sidx_1', 'legacy-1'] })
    );

    expect(response.status).toBe(200);
    expect(mocks.sessionFetch).not.toHaveBeenCalled();
    expect(
      mocks.logs.filter(
        (log) => log.message === 'sessionIndex could not be resolved to a sharded session'
      )
    ).toHaveLength(2);
    expect(mocks.epoch).toHaveBeenCalledWith(
      expect.anything(),
      { marker: 'core' },
      'tenant-a',
      'user-a'
    );
  });

  it('logs a failed session deletion and carries on', async () => {
    mocks.activeUser = { id: 'user-a' };
    mocks.resolveIndex.mockResolvedValue('sess_1');
    mocks.sessionFetch.mockRejectedValue(new Error('store down'));

    const response = await post('SAMLRequest', requestXml({ sessionIndices: ['sidx_1'] }));

    expect(response.status).toBe(200);
    expect(mocks.logs).toContainEqual({
      level: 'error',
      message: 'Failed to delete session',
      context: { sessionIndex: 'sidx_1' },
    });
  });

  it('answers success even when no session or user is found, with a warning', async () => {
    const response = await post('SAMLRequest', requestXml());

    expect((await protocolResponse(response)).statusCode).toBe(STATUS_CODES.SUCCESS);
    expect(mocks.logs).toContainEqual({
      level: 'warn',
      message: 'No user found for logout request',
      context: {},
    });
    expect(mocks.logs).toContainEqual({
      level: 'warn',
      message: 'No session found for logout request',
      context: {},
    });
    expect(mocks.epoch).not.toHaveBeenCalled();
  });

  it('revokes by epoch for an email NameID without SessionIndex', async () => {
    mocks.activeUser = { id: 'user-a' };

    await post('SAMLRequest', requestXml());

    expect(mocks.epoch).toHaveBeenCalledTimes(1);
    expect(mocks.logs).toContainEqual({
      level: 'info',
      message: 'Terminated all user sessions by revocation epoch',
      context: {},
    });
  });
});

describe('LogoutResponse handling', () => {
  it('records fan-out completion from the SP answer and goes on to the next target', async () => {
    mocks.outbound = { requestId: '_outbound', spEntityId: SP_ENTITY, transactionId: 'tx-1' };

    const response = await post('SAMLResponse', responseXml());

    expect(response.status).toBe(302);
    expect(mocks.markCompleted).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      transactionId: 'tx-1',
      spEntityId: SP_ENTITY,
      status: 'succeeded',
      statusCode: STATUS_CODES.SUCCESS,
      statusMessage: 'why',
    });
  });

  it('records a non-success SP answer as failed and audits it', async () => {
    mocks.outbound = { requestId: '_outbound', spEntityId: SP_ENTITY, transactionId: 'tx-1' };

    await post('SAMLResponse', responseXml({ statusCode: STATUS_CODES.RESPONDER }));

    expect(mocks.markCompleted.mock.calls[0]?.[1]).toMatchObject({
      status: 'failed',
      statusCode: STATUS_CODES.RESPONDER,
    });
    expect(policyAudits()[0]).toMatchObject({
      failure_kind: 'logout_response_non_success_status',
      policy_details: {
        logout_response_id: '_response',
        status_code: STATUS_CODES.RESPONDER,
        status_message: 'why',
      },
    });
    expect(mocks.logs).toContainEqual({
      level: 'warn',
      message: 'SP returned logout error',
      context: {
        tenantId: 'tenant-a',
        spEntityId: SP_ENTITY,
        logoutResponseId: '_response',
        statusCode: STATUS_CODES.RESPONDER,
        statusMessage: 'why',
      },
    });
  });

  it('clears the session cookie and returns to the logout-complete page', async () => {
    const response = await post('SAMLResponse', responseXml());

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://ui.example.test/logout-complete');
    expect(response.headers.get('set-cookie')).toBe(
      'authrim_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'
    );
    expect(mocks.markCompleted).not.toHaveBeenCalled();
  });
});
