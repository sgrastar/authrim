import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { NAMEID_FORMATS, SAML_NAMESPACES, STATUS_CODES } from '../../common/constants';

const mocks = vi.hoisted(() => ({
  sp: null as Record<string, unknown> | null,
  builtin: true,
  ui: undefined as { baseUrl: string } | undefined,
  sessionDelete: new Response(null, { status: 204 }),
  sessionThrows: false,
  resolvedSessionId: null as string | null,
  activeUser: null as { id: string } | null,
  outbound: {
    requestId: '_outbound',
    spEntityId: 'https://sp.example.test/entity',
  } as Record<string, unknown> | null,
  outboundThrows: false,
  deleteOutbound: vi.fn(async () => undefined),
  audit: vi.fn(),
  userNameId: null as string | null,
  userInfo: null as Record<string, unknown> | null,
  signingError: false,
  storeOutbound: vi.fn(async () => undefined),
  markSent: vi.fn(async () => undefined),
  markCompleted: vi.fn(async () => undefined),
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
    recordUserSessionRevocationEpoch: vi.fn(async () => undefined),
    createAuditLog: mocks.audit,
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
    createLogger: () => ({ module: () => ({ error: vi.fn() }) }),
  };
});

vi.mock('../../admin/providers', () => ({
  getSPConfig: vi.fn(async () => mocks.sp),
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
    signRedirectBinding: vi.fn(async () => ({
      signedUrl: 'SAMLRequest=encoded&SigAlg=rsa-sha256&Signature=signature',
      signature: 'signature',
      sigAlg: 'rsa-sha256',
    })),
  };
});

vi.mock('../../common/user-store', () => ({
  findActiveSamlUserByEmail: vi.fn(async () => mocks.activeUser),
  getSamlUserInfoById: vi.fn(async () => mocks.userInfo),
  getSamlUserNameIdById: vi.fn(async () => mocks.userNameId),
}));

vi.mock('../subject', () => ({
  resolveSAMLPersistentNameIDRegistryStore: vi.fn(() => undefined),
  resolveSAMLNameIDValue: vi.fn(async () => 'persistent-name-id'),
  resolveSAMLPairwiseSecret: vi.fn(async () => 'pairwise-secret'),
  resolveSAMLSessionIndexToSessionId: vi.fn(async () => mocks.resolvedSessionId),
}));

vi.mock('../slo-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slo-state')>();
  return {
    ...actual,
    getSAMLOutboundLogoutRequest: vi.fn(async () => {
      if (mocks.outboundThrows) throw new Error('state store unavailable');
      if (!mocks.outbound) {
        throw new actual.SAMLLogoutResponseCorrelationError('missing request', {
          in_response_to: 'missing',
        });
      }
      return mocks.outbound;
    }),
    deleteSAMLOutboundLogoutRequest: mocks.deleteOutbound,
    storeSAMLOutboundLogoutRequest: mocks.storeOutbound,
    createSAMLIdPLogoutFanoutTransaction: vi.fn(
      async (
        _store: unknown,
        input: {
          transactionId?: string;
          userId: string;
          sessionIndex?: string;
          relayState?: string;
          targets: string[];
        }
      ) => ({
        transactionId: input.transactionId ?? 'transaction-id',
        userId: input.userId,
        sessionIndex: input.sessionIndex,
        relayState: input.relayState,
        targets: input.targets.map((spEntityId) => ({ spEntityId, status: 'pending' })),
      })
    ),
    getSAMLIdPLogoutFanoutTransaction: vi.fn(async () => null),
    markSAMLIdPLogoutFanoutTargetSent: mocks.markSent,
    markSAMLIdPLogoutFanoutTargetCompleted: mocks.markCompleted,
  };
});

import {
  handleIdPSLO,
  initiateIdPLogout,
  initiateIdPLogoutBindingResponse,
  initiateIdPMultiSPLogoutBindingResponse,
  resolveIdPLogoutNameID,
} from '../slo';

function sp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: 'https://sp.example.test/entity',
    acsUrl: 'https://sp.example.test/acs',
    sloUrl: 'https://sp.example.test/slo',
    sloResponseUrl: 'https://sp.example.test/slo/response',
    allowedBindings: ['post'],
    logoutRequestSignaturePolicy: 'disabled',
    logoutResponseSignaturePolicy: 'disabled',
    ...overrides,
  };
}

function app() {
  const route = new Hono();
  route.use('*', async (c, next) => {
    (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
    await next();
  });
  route.all('/slo', handleIdPSLO as never);
  return route;
}

function environment() {
  return { STATE_STORE: {} };
}

function requestXml(
  options: {
    issueInstant?: string;
    destination?: string;
    notOnOrAfter?: string;
    nameIdFormat?: string;
    nameQualifier?: string;
    spNameQualifier?: string;
    sessionIndex?: string;
  } = {}
) {
  const attrs = [
    'ID="_logout"',
    `IssueInstant="${options.issueInstant ?? new Date().toISOString()}"`,
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
  return `<samlp:LogoutRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ${attrs}>
    <saml:Issuer>https://sp.example.test/entity</saml:Issuer>
    <saml:NameID ${nameAttrs}>user@example.test</saml:NameID>
    ${options.sessionIndex ? `<samlp:SessionIndex>${options.sessionIndex}</samlp:SessionIndex>` : ''}
  </samlp:LogoutRequest>`;
}

function responseXml(
  options: {
    destination?: string;
    statusCode?: string;
    inResponseTo?: string;
  } = {}
) {
  return `<samlp:LogoutResponse xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}"
    ID="_response" IssueInstant="${new Date().toISOString()}"
    InResponseTo="${options.inResponseTo ?? '_outbound'}"
    ${options.destination ? `Destination="${options.destination}"` : ''}>
    <saml:Issuer>https://sp.example.test/entity</saml:Issuer>
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

describe('IdP SLO handler policy boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sp = sp();
    mocks.builtin = true;
    mocks.ui = undefined;
    mocks.sessionDelete = new Response(null, { status: 204 });
    mocks.sessionThrows = false;
    mocks.resolvedSessionId = null;
    mocks.activeUser = null;
    mocks.outbound = {
      requestId: '_outbound',
      spEntityId: 'https://sp.example.test/entity',
    };
    mocks.outboundThrows = false;
    mocks.userNameId = null;
    mocks.userInfo = null;
    mocks.signingError = false;
  });

  it('requires either a SAMLRequest or SAMLResponse for both bindings', async () => {
    expect((await post()).status).toBe(400);
    const get = await app().fetch(new Request('https://tenant.example.test/slo'), environment(), {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as never);
    expect(get.status).toBe(400);
  });

  it('maps malformed POST logout messages to validation errors', async () => {
    await expectValidationError(await post('SAMLRequest', '<not-saml/>'));
    await expectValidationError(await post('SAMLResponse', '<not-saml/>'));
  });

  it('rejects an oversized RelayState as invalid input', async () => {
    await expectValidationError(await post('SAMLRequest', requestXml(), 'x'.repeat(81)));
  });

  it.each([
    [new Date(Date.now() + 10 * 60_000).toISOString(), undefined, undefined],
    [new Date(Date.now() - 30 * 60_000).toISOString(), undefined, undefined],
    [new Date().toISOString(), new Date(Date.now() - 10 * 60_000).toISOString(), undefined],
    [new Date().toISOString(), undefined, 'https://attacker.example/slo'],
  ])('rejects invalid LogoutRequest timing and destination', async (issue, expiry, destination) => {
    const response = await post(
      'SAMLRequest',
      requestXml({ issueInstant: issue, notOnOrAfter: expiry, destination })
    );
    await expectValidationError(response);
  });

  it('handles unknown SP without redirecting to an untrusted endpoint', async () => {
    mocks.sp = null;
    const response = await post('SAMLRequest', requestXml(), 'relay');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/logout-complete');
  });

  it.each([
    [{ nameQualifier: 'https://wrong.example/idp' }, 'NameQualifier'],
    [{ spNameQualifier: 'https://wrong.example/sp' }, 'SPNameQualifier'],
    [{ nameIdFormat: 'urn:unsupported' }, 'format'],
    [{ nameIdFormat: NAMEID_FORMATS.PERSISTENT }, 'SessionIndex'],
  ] as const)('returns a protocol response for invalid %s policy', async (options, _label) => {
    const response = await post('SAMLRequest', requestXml(options), 'relay');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('SAMLResponse');
  });

  it('accepts legacy persistent logout without SessionIndex', async () => {
    mocks.sp = sp({ samlProfile: 'legacy' });
    const response = await post(
      'SAMLRequest',
      requestXml({ nameIdFormat: NAMEID_FORMATS.PERSISTENT })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('deletes a resolved sharded session and clears the browser cookie', async () => {
    mocks.resolvedSessionId = 'sess_123';
    const response = await post('SAMLRequest', requestXml({ sessionIndex: 'sidx_123' }), 'relay');
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it.each([
    ['unresolved', null, false, new Response(null, { status: 204 })],
    ['not sharded', 'legacy-session', false, new Response(null, { status: 204 })],
    ['already deleted', 'sess_missing', false, new Response(null, { status: 404 })],
    ['store failure', 'sess_error', true, new Response(null, { status: 204 })],
  ] as const)(
    'does not fail logout when a session is %s',
    async (_name, resolved, throws, result) => {
      mocks.resolvedSessionId = resolved;
      mocks.sessionThrows = throws;
      mocks.sessionDelete = result;
      const response = await post('SAMLRequest', requestXml({ sessionIndex: 'sidx_123' }));
      expect(response.status).toBe(200);
    }
  );

  it('uses revocation epoch fallback for an email NameID', async () => {
    mocks.activeUser = { id: 'user-a' };
    const response = await post('SAMLRequest', requestXml());
    expect(response.status).toBe(200);
  });

  it('rejects an unsigned request when the SP requires signatures', async () => {
    mocks.sp = sp({ logoutRequestSignaturePolicy: 'required' });
    const response = await post('SAMLRequest', requestXml());
    expect(response.status).toBe(200);
  });

  it('rejects a LogoutResponse from an unknown SP', async () => {
    mocks.sp = null;
    await expectValidationError(await post('SAMLResponse', responseXml()));
  });

  it('rejects invalid LogoutResponse destination and correlation', async () => {
    let response = await post(
      'SAMLResponse',
      responseXml({ destination: 'https://attacker.example/slo' })
    );
    await expectValidationError(response);

    mocks.outbound = null;
    response = await post('SAMLResponse', responseXml());
    await expectValidationError(response);
  });

  it('preserves a 500 response for unexpected state-store failures', async () => {
    mocks.outboundThrows = true;
    expect((await post('SAMLResponse', responseXml())).status).toBe(500);
  });

  it.each([STATUS_CODES.SUCCESS, STATUS_CODES.RESPONDER])(
    'consumes a correlated LogoutResponse with status %s',
    async (statusCode) => {
      const response = await post('SAMLResponse', responseXml({ statusCode }), 'relay');
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('/logout-complete');
      expect(mocks.deleteOutbound).toHaveBeenCalled();
    }
  );

  it('returns configuration error when no logout-complete UI exists', async () => {
    mocks.builtin = false;
    mocks.ui = undefined;
    const response = await post('SAMLResponse', responseXml());
    expect(response.status).toBe(500);
  });

  it('uses configured UI for the logout-complete redirect', async () => {
    mocks.builtin = false;
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    const response = await post('SAMLResponse', responseXml());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://ui.example.test/logout-complete');
  });

  it('requires an explicit tenant for IdP-initiated logout', async () => {
    await expect(
      initiateIdPLogout(environment() as never, 'user-a', sp() as never)
    ).rejects.toThrow('tenant');
    await expect(
      initiateIdPLogoutBindingResponse(environment() as never, 'user-a', sp() as never)
    ).rejects.toThrow('tenant');
  });

  it('fails closed when no NameID can be resolved', async () => {
    await expect(
      initiateIdPLogout(
        environment() as never,
        'user-a',
        sp({ nameIdFormat: NAMEID_FORMATS.EMAIL }) as never,
        undefined,
        'tenant-a'
      )
    ).rejects.toThrow('could not be processed');
  });

  it('builds, signs, and stores a core IdP-initiated LogoutRequest', async () => {
    mocks.userNameId = 'user@example.test';
    const result = await initiateIdPLogout(
      environment() as never,
      'user-a',
      sp({ sloUrl: undefined }) as never,
      'session-index',
      'tenant-a'
    );
    expect(result.destination).toBe('https://sp.example.test/acs');
    expect(result.logoutRequestXml).toContain('LogoutRequest');
    expect(mocks.storeOutbound).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-a' })
    );
  });

  it('propagates signing failure without storing an outbound request', async () => {
    mocks.userNameId = 'user@example.test';
    mocks.signingError = true;
    await expect(
      initiateIdPLogout(environment() as never, 'user-a', sp() as never, undefined, 'tenant-a')
    ).rejects.toThrow('signing unavailable');
    expect(mocks.storeOutbound).not.toHaveBeenCalled();
  });

  it.each(['post', 'redirect'] as const)(
    'returns a signed %s binding response and preserves RelayState',
    async (binding) => {
      mocks.userNameId = 'user@example.test';
      const response = await initiateIdPLogoutBindingResponse(
        environment() as never,
        'user-a',
        sp() as never,
        {
          tenantId: 'tenant-a',
          binding,
          sessionIndex: 'session-index',
          relayState: 'relay-state',
        }
      );
      expect(response.status).toBe(binding === 'redirect' ? 302 : 200);
      if (binding === 'redirect') {
        expect(response.headers.get('location')).toContain('SAMLRequest=');
      } else {
        expect(await response.text()).toContain('RelayState');
      }
      expect(mocks.storeOutbound).toHaveBeenCalled();
    }
  );

  it('uses SP profile to choose the default binding', async () => {
    mocks.userNameId = 'user@example.test';
    const response = await initiateIdPLogoutBindingResponse(
      environment() as never,
      'user-a',
      sp({ samlProfile: 'legacy', sloBinding: undefined }) as never,
      { tenantId: 'tenant-a' }
    );
    expect(response.status).toBe(200);
  });

  it('deduplicates multi-SP targets and starts a fanout transaction', async () => {
    mocks.userNameId = 'user@example.test';
    const target = sp() as never;
    const result = await initiateIdPMultiSPLogoutBindingResponse(
      environment() as never,
      'user-a',
      [target, target],
      {
        tenantId: 'tenant-a',
        transactionId: 'transaction-custom',
        binding: 'post',
        relayState: 'relay',
      }
    );
    expect(result.transactionId).toBe('transaction-custom');
    expect(result.response.status).toBe(200);
    expect(mocks.markSent).toHaveBeenCalled();
  });

  it('rejects an empty multi-SP fanout and records target send failure', async () => {
    await expect(
      initiateIdPMultiSPLogoutBindingResponse(environment() as never, 'user-a', [], {
        tenantId: 'tenant-a',
      })
    ).rejects.toThrow('at least one SP target');

    mocks.userNameId = 'user@example.test';
    mocks.signingError = true;
    await expect(
      initiateIdPMultiSPLogoutBindingResponse(environment() as never, 'user-a', [sp() as never], {
        tenantId: 'tenant-a',
      })
    ).rejects.toThrow('signing unavailable');
    expect(mocks.markCompleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', failureReason: 'send_failed' })
    );
  });

  it('resolves email and persistent NameIDs without cross-tenant fallback', async () => {
    mocks.userNameId = 'user@example.test';
    expect(
      await resolveIdPLogoutNameID(environment() as never, 'tenant-a', 'user-a', {
        entityId: 'sp',
        nameIdFormat: NAMEID_FORMATS.EMAIL,
      })
    ).toBe('user@example.test');

    mocks.userInfo = null;
    expect(
      await resolveIdPLogoutNameID(environment() as never, 'tenant-a', 'user-a', {
        entityId: 'sp',
        nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      })
    ).toBeNull();

    mocks.userInfo = { id: 'user-a', email: 'user@example.test' };
    expect(
      await resolveIdPLogoutNameID(environment() as never, 'tenant-a', 'user-a', {
        entityId: 'sp',
        nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      })
    ).toBe('persistent-name-id');
  });
});

async function expectValidationError(response: Response) {
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: 'invalid_request',
    error_code: 'AR130003',
  });
}
