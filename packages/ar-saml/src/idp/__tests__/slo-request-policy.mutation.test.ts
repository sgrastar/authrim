/**
 * IdP SLO LogoutRequest/LogoutResponse handling: the exact timing and destination boundaries,
 * the NameID/SessionIndex policy answers (decoded from the returned protocol response), policy
 * failure audit records and session termination.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { NAMEID_FORMATS, SAML_NAMESPACES, STATUS_CODES } from '../../common/constants';
import { dig } from '../../admin/__tests__/helpers/provider-handler-harness';

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

const ISSUER_URL = 'https://tenant.example.test';
const IDP_ENTITY = 'https://tenant.example.test/saml/idp';
const SP_ENTITY = 'https://sp.example.test/entity';
const NOW = Date.parse('2026-06-01T12:00:00Z');
const SKEW_MS = 60_000;

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
  mocks.sessionFetch.mockImplementation(async () => new Response(null, { status: 204 }));
  mocks.resolveIndex.mockResolvedValue(null);
  mocks.activeUser = null;
  mocks.outbound = { requestId: '_outbound', spEntityId: SP_ENTITY, transactionId: undefined };
  mocks.logs.length = 0;
  mocks.federation = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LogoutRequest timing boundaries', () => {
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

  it('accepts an IssueInstant exactly one skew in the future and rejects one second more', async () => {
    expect((await post('SAMLRequest', requestXml({ issueInstant: at(SKEW_MS) }))).status).toBe(200);
    expect(
      (await post('SAMLRequest', requestXml({ issueInstant: at(SKEW_MS + 1000) }))).status
    ).toBe(400);
  });

  it('accepts a request exactly as old as lifetime plus skew and rejects one second older', async () => {
    const ttlMs = 300_000;
    expect(
      (await post('SAMLRequest', requestXml({ issueInstant: at(-(ttlMs + SKEW_MS)) }))).status
    ).toBe(200);
    expect(
      (await post('SAMLRequest', requestXml({ issueInstant: at(-(ttlMs + SKEW_MS + 1000)) })))
        .status
    ).toBe(400);
  });

  it('treats NotOnOrAfter as exclusive at the skew boundary', async () => {
    expect(
      (await post('SAMLRequest', requestXml({ notOnOrAfter: at(-SKEW_MS + 1000) }))).status
    ).toBe(200);
    expect((await post('SAMLRequest', requestXml({ notOnOrAfter: at(-SKEW_MS) }))).status).toBe(
      400
    );
    expect(
      (await post('SAMLRequest', requestXml({ notOnOrAfter: at(-SKEW_MS - 1000) }))).status
    ).toBe(400);
  });

  it('rejects an unparsable IssueInstant or NotOnOrAfter', async () => {
    expect((await post('SAMLRequest', requestXml({ issueInstant: 'yesterday' }))).status).toBe(400);
    expect((await post('SAMLRequest', requestXml({ notOnOrAfter: 'later' }))).status).toBe(400);
  });
});

describe('Destination checks', () => {
  it.each([
    `${ISSUER_URL}/saml/idp/slo`,
    `${ISSUER_URL}/idp/profile/SAML2/POST/SLO`,
    `${ISSUER_URL}/idp/profile/SAML2/Redirect/SLO`,
  ])('accepts the LogoutRequest destination %s', async (destination) => {
    const response = await post('SAMLRequest', requestXml({ destination }));

    expect(response.status).toBe(200);
    expect(await protocolResponse(response)).toMatchObject({ statusCode: STATUS_CODES.SUCCESS });
  });

  it.each([
    `${ISSUER_URL}/saml/idp/sso`,
    `${ISSUER_URL}/saml/idp/slo/`,
    'https://other.example.test/saml/idp/slo',
  ])('rejects the LogoutRequest destination %s', async (destination) => {
    expect((await post('SAMLRequest', requestXml({ destination }))).status).toBe(400);
  });

  it('accepts a LogoutResponse addressed to this IdP and rejects another destination with an audit', async () => {
    const accepted = await post(
      'SAMLResponse',
      responseXml({ destination: `${ISSUER_URL}/saml/idp/slo` })
    );
    expect(accepted.status).toBe(302);

    const rejected = await post(
      'SAMLResponse',
      responseXml({ destination: 'https://attacker.example/slo' })
    );
    expect(rejected.status).toBe(400);
    expect(policyAudits().at(-1)).toMatchObject({
      failure_kind: 'logout_response_invalid_destination',
      sp_entity_id: SP_ENTITY,
      policy_details: {
        destination: 'https://attacker.example/slo',
        expected_destinations: [
          `${ISSUER_URL}/saml/idp/slo`,
          `${ISSUER_URL}/idp/profile/SAML2/POST/SLO`,
          `${ISSUER_URL}/idp/profile/SAML2/Redirect/SLO`,
        ],
      },
    });
  });
});

describe('NameID and SessionIndex policy answers', () => {
  it('answers success with the SP response URL as destination for a plain request', async () => {
    const response = await post('SAMLRequest', requestXml());

    expect(await protocolResponse(response)).toEqual({
      destination: 'https://sp.example.test/slo/response',
      statusCode: STATUS_CODES.SUCCESS,
      statusMessage: undefined,
      inResponseTo: '_logout',
    });
  });

  it('falls back to the SP slo URL then the ACS URL for the response destination', async () => {
    mocks.sp = sp({ sloResponseUrl: undefined });
    expect((await protocolResponse(await post('SAMLRequest', requestXml()))).destination).toBe(
      'https://sp.example.test/slo'
    );
    mocks.sp = sp({ sloResponseUrl: undefined, sloUrl: undefined });
    expect((await protocolResponse(await post('SAMLRequest', requestXml()))).destination).toBe(
      'https://sp.example.test/acs'
    );
  });

  it('rejects a foreign NameQualifier with a Requester answer and an audit', async () => {
    const response = await post(
      'SAMLRequest',
      requestXml({ nameQualifier: 'https://wrong.example/idp' })
    );

    expect(await protocolResponse(response)).toMatchObject({
      statusCode: STATUS_CODES.REQUESTER,
      statusMessage: 'SAML logout request NameID qualifier is not supported',
    });
    expect(policyAudits()[0]).toMatchObject({
      failure_kind: 'logout_request_invalid_nameid_qualifier',
      request_id: '_logout',
      policy_details: {
        qualifier: 'NameQualifier',
        requested_name_qualifier: 'https://wrong.example/idp',
        expected_name_qualifier: IDP_ENTITY,
      },
    });
    expect(
      mocks.logs.some((log) => log.message === 'SAML LogoutRequest NameID qualifier policy failed')
    ).toBe(true);
  });

  it('rejects a foreign SPNameQualifier with its own message and details', async () => {
    const response = await post(
      'SAMLRequest',
      requestXml({ spNameQualifier: 'https://wrong.example/sp' })
    );

    expect(await protocolResponse(response)).toMatchObject({
      statusCode: STATUS_CODES.REQUESTER,
      statusMessage: 'SAML logout request SPNameQualifier is not supported',
    });
    expect(policyAudits()[0]?.policy_details).toEqual({
      qualifier: 'SPNameQualifier',
      requested_sp_name_qualifier: 'https://wrong.example/sp',
      expected_sp_name_qualifier: SP_ENTITY,
    });
  });

  it('accepts the qualifiers this IdP and SP are known by', async () => {
    const response = await post(
      'SAMLRequest',
      requestXml({ nameQualifier: IDP_ENTITY, spNameQualifier: SP_ENTITY })
    );

    expect((await protocolResponse(response)).statusCode).toBe(STATUS_CODES.SUCCESS);
    expect(policyAudits()).toEqual([]);
  });

  it('rejects an unsupported NameID format and lists the supported ones', async () => {
    const response = await post('SAMLRequest', requestXml({ nameIdFormat: 'urn:unsupported' }));

    expect(await protocolResponse(response)).toMatchObject({
      statusCode: STATUS_CODES.REQUESTER,
      statusMessage: 'SAML logout request NameID format is not supported',
    });
    const details = policyAudits()[0]?.policy_details;
    expect(dig(details, 'requested_nameid_format')).toBe('urn:unsupported');
    expect(dig(details, 'supported_nameid_formats')).toEqual([
      NAMEID_FORMATS.EMAIL,
      NAMEID_FORMATS.PERSISTENT,
      NAMEID_FORMATS.TRANSIENT,
      NAMEID_FORMATS.UNSPECIFIED,
    ]);
    expect(policyAudits()[0]?.failure_kind).toBe('logout_request_invalid_nameid_format');
  });

  it.each([NAMEID_FORMATS.PERSISTENT, NAMEID_FORMATS.TRANSIENT])(
    'requires a SessionIndex for a %s NameID',
    async (nameIdFormat) => {
      const response = await post('SAMLRequest', requestXml({ nameIdFormat }));

      expect(await protocolResponse(response)).toMatchObject({
        statusCode: STATUS_CODES.REQUESTER,
        statusMessage: 'SAML logout request requires SessionIndex for this NameID format',
      });
      expect(policyAudits()[0]).toMatchObject({
        failure_kind: 'logout_request_session_index_required',
        policy_details: { requested_nameid_format: nameIdFormat, session_index_required: true },
      });
      expect(
        mocks.logs.some((log) => log.message === 'SAML LogoutRequest session policy failed')
      ).toBe(true);
    }
  );

  it.each([NAMEID_FORMATS.EMAIL, NAMEID_FORMATS.UNSPECIFIED])(
    'lets a %s NameID log out without a SessionIndex',
    async (nameIdFormat) => {
      const response = await post('SAMLRequest', requestXml({ nameIdFormat }));

      expect((await protocolResponse(response)).statusCode).toBe(STATUS_CODES.SUCCESS);
    }
  );

  it('accepts a persistent NameID with a SessionIndex, and a legacy profile without one', async () => {
    mocks.resolveIndex.mockResolvedValue('sess_1');
    expect(
      (
        await protocolResponse(
          await post(
            'SAMLRequest',
            requestXml({ nameIdFormat: NAMEID_FORMATS.PERSISTENT, sessionIndices: ['sidx_1'] })
          )
        )
      ).statusCode
    ).toBe(STATUS_CODES.SUCCESS);

    mocks.sp = sp({ samlProfile: 'legacy' });
    expect(
      (
        await protocolResponse(
          await post('SAMLRequest', requestXml({ nameIdFormat: NAMEID_FORMATS.PERSISTENT }))
        )
      ).statusCode
    ).toBe(STATUS_CODES.SUCCESS);
  });
});
