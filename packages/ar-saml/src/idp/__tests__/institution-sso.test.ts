/**
 * The SSO endpoints for a tenant that has registered the institution it stands for: the scoped
 * attributes are released only under its scopes (checked in the assertion XML the SP would
 * receive), what is withheld is recorded without the values, and the institution attributes are
 * released only to a mapping that chooses them. A tenant that has registered nothing is released
 * as before. The attribute release, the destination profile filter and the assertion builder are
 * the real ones; only storage, sessions and signing are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SAML_NAMESPACES } from '../../common/constants';
import { findElements, getTextContent, parseXml } from '../../common/xml-utils';
import {
  OID_MAIL,
  PRODUCTION_SP_ENTITY_ID,
  productionAdminAdapter,
} from '../__fixtures__/production-shaped-mapping';
import {
  customClaimEdge,
  EDGE_EPPN,
  EDGE_EPSA,
  EDGE_ORGANIZATION_NAME,
  EDGE_SCHAC_HOME_ORGANIZATION,
  institutionBinding,
  institutionCoreAdapter,
  INSTITUTION_DESTINATION_SCHEMA,
  institutionSpConfig,
  OID_EPPN,
  OID_EPSA,
  OID_ORGANIZATION_NAME,
  OID_SCHAC_HOME_ORGANIZATION,
} from '../__fixtures__/institution-mapping';

const mocks = vi.hoisted(() => ({
  sp: null as Record<string, unknown> | null,
  user: null as Record<string, unknown> | null,
  sessionResponse: new Response(null, { status: 404 }),
  assuranceSettings: {} as Record<string, unknown>,
  settingsError: null as Error | null,
  getCoreAdapter: vi.fn(),
  admin: null as unknown,
  core: null as unknown,
  binding: null as unknown,
  warn: vi.fn(),
  error: vi.fn(),
  audit: vi.fn(async (_env: unknown, _entry: { action?: string; metadata?: string }) => undefined),
  buildResponse: vi.fn((_options?: unknown) => undefined),
  lastXml: '' as string,
  buildErrorResponse: vi.fn((_options?: unknown) => '<saml-error-response/>'),
  requestedSettings: [] as string[],
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getUIConfig: vi.fn(async () => undefined),
    buildIssuerUrl: vi.fn(() => 'https://tenant.example.test'),
    buildSAMLRequestStoreInstanceName: vi.fn(() => 'store'),
    getSessionStoreBySessionId: vi.fn(() => ({
      stub: { fetch: vi.fn(async () => mocks.sessionResponse.clone()) },
    })),
    isShardedSessionId: vi.fn(() => true),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.core),
    requireAdminDatabaseAdapter: vi.fn(() => mocks.admin),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => mocks.binding),
    resolveEffectiveSettings: vi.fn(async (_env: unknown, category: string) => {
      mocks.requestedSettings.push(category);
      if (mocks.settingsError) throw mocks.settingsError;
      return mocks.assuranceSettings;
    }),
    getLogger: () => ({
      module: () => ({ error: mocks.error, warn: mocks.warn, info: vi.fn(), debug: vi.fn() }),
    }),
    createAuditLog: mocks.audit,
    buildUIUrl: vi.fn(() => 'https://ui.example.test/login'),
    usesNakedDomainIssuer: vi.fn(() => false),
  };
});
vi.mock('../../admin/providers', () => ({
  getSPConfig: vi.fn(async () => mocks.sp),
  listSPConfigs: vi.fn(async () => []),
}));
vi.mock('../../common/entity-id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/entity-id')>();
  return {
    ...actual,
    getSAMLInteractiveLoginUrlPolicy: vi.fn(async () => 'ui_base_url'),
    getSAMLLocalEntityIds: vi.fn(async () => ({
      issuerUrl: 'https://tenant.example.test',
      idpEntityId: 'https://tenant.example.test/saml/idp',
    })),
  };
});
vi.mock('../../common/session-cookie', () => ({
  extractAuthrimSessionIdFromCookieHeader: vi.fn(() => 'session-id'),
}));
vi.mock('../../common/user-store', () => ({
  getSamlUserInfoById: vi.fn(async () => mocks.user),
  getSamlUserCoreAdapter: mocks.getCoreAdapter,
}));
vi.mock('../../common/idp-signing', () => ({
  getSAMLIdPSigningMaterial: vi.fn(async () => ({ privateKeyPem: 'key', certificate: 'cert' })),
}));
vi.mock('../signing', () => ({
  applySAMLResponseSigningPolicy: vi.fn((xml: string) => xml),
  assertSAMLResponseSigningPolicy: vi.fn(),
}));
vi.mock('../assertion', async () => {
  // The real assertion builder, so the XML the SP would receive is what is checked.
  const actual = await vi.importActual<typeof import('../assertion')>('../assertion');
  return {
    buildSAMLResponse: (options: Parameters<typeof actual.buildSAMLResponse>[0]) => {
      mocks.buildResponse(options);
      const xml = actual.buildSAMLResponse(options);
      mocks.lastXml = xml;
      return xml;
    },
  };
});
vi.mock('../attribute-release-consent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../attribute-release-consent')>();
  return { ...actual, enforceSAMLAttributeReleaseConsent: vi.fn(async () => undefined) };
});
vi.mock('../authn-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../authn-context')>();
  return { ...actual, resolveSAMLAuthnContextClassRef: vi.fn(() => 'urn:test:loa:1') };
});
vi.mock('../subject', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../subject')>();
  return {
    ...actual,
    createSAMLSessionIndex: vi.fn(async () => 'session-index'),
    resolveSAMLNameIDValue: vi.fn(async () => 'user@example.test'),
    resolveSAMLPairwiseSecret: vi.fn(async () => 'secret'),
    resolveSAMLPersistentNameIDRegistryStore: vi.fn(() => undefined),
    resolveSAMLTransientNameIDStore: vi.fn(() => undefined),
  };
});
vi.mock('../encryption', () => ({
  applySAMLAssertionEncryptionPolicy: vi.fn(async (xml: string) => xml),
}));
vi.mock('../error-response', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../error-response')>();
  return {
    ...actual,
    buildSAMLIdPErrorResponse: mocks.buildErrorResponse,
    applySAMLErrorResponseOverride: vi.fn((_config: unknown, input: unknown) => input),
  };
});

import { handleIdPSSO } from '../sso';
import { handleIdPInitiated } from '../idp-initiated';

const consentTransactionId = '12345678-1234-4234-8234-123456789abc';

function authnRequest() {
  return `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ID="_request" IssueInstant="${new Date().toISOString()}">
    <saml:Issuer>${PRODUCTION_SP_ENTITY_ID}</saml:Issuer>
  </samlp:AuthnRequest>`;
}

async function sso() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
    await next();
  });
  app.post('/sso', handleIdPSSO as never);
  const form = new FormData();
  form.set('SAMLRequest', btoa(authnRequest()));
  return app.fetch(
    new Request('https://tenant.example.test/sso', { method: 'POST', body: form }),
    {
      SETTINGS: { get: vi.fn(async () => null) },
      SAML_REQUEST_STORE: {
        idFromName: vi.fn(() => ({})),
        get: vi.fn(() => ({ fetch: vi.fn(async () => new Response('{}')) })),
      },
    },
    { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as never
  );
}

function idpInitiated() {
  return handleIdPInitiated({
    env: { STATE_STORE: {} },
    req: {
      query: vi.fn((name: string) =>
        name === 'sp'
          ? PRODUCTION_SP_ENTITY_ID
          : name === 'consent_tx'
            ? consentTransactionId
            : undefined
      ),
      header: vi.fn((name: string) =>
        name.toLowerCase() === 'cookie' ? 'authrim_session=x' : undefined
      ),
    },
    get: vi.fn((name: string) => (name === 'tenantId' ? 'tenant-a' : undefined)),
    html: vi.fn((body: string) => new Response(body)),
    json: vi.fn(
      (body: unknown, status: number = 200) => new Response(JSON.stringify(body), { status })
    ),
    redirect: vi.fn(),
  } as never);
}

/** The attributes of the assertion the SP received: Name to the values, from the XML itself. */
function assertionAttributes(): Record<string, string[]> {
  const attributes: Record<string, string[]> = {};
  for (const attribute of findElements(
    parseXml(mocks.lastXml),
    SAML_NAMESPACES.SAML2,
    'Attribute'
  )) {
    const values = attribute.getElementsByTagNameNS(SAML_NAMESPACES.SAML2, 'AttributeValue');
    attributes[attribute.getAttribute('Name') ?? ''] = Array.from(
      values,
      (value) => getTextContent(value) ?? ''
    );
  }
  return attributes;
}

const withheldRecords = () =>
  mocks.audit.mock.calls
    .filter(([, entry]) => entry.action === 'saml.attribute.withheld')
    .map(([, entry]) => JSON.parse(entry.metadata ?? '{}') as Record<string, unknown>);

const REGISTERED = {
  'institution.scopes': 'example.ac.jp, med.example.ac.jp',
  'institution.display_names': JSON.stringify({ ja: '例大学', en: 'Example University' }),
};

function arrange(settings: Record<string, unknown>, customClaims: Record<string, unknown>) {
  vi.clearAllMocks();
  mocks.requestedSettings = [];
  mocks.settingsError = null;
  mocks.lastXml = '';
  mocks.sp = institutionSpConfig();
  mocks.user = { id: 'user-a', email: 'user@example.test', customClaims };
  mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a', data: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  mocks.admin = productionAdminAdapter(INSTITUTION_DESTINATION_SCHEMA);
  mocks.core = institutionCoreAdapter();
  mocks.getCoreAdapter.mockImplementation(async () => mocks.core);
  mocks.binding = institutionBinding([EDGE_EPSA, EDGE_EPPN]);
  mocks.assuranceSettings = settings;
}

describe.each([
  ['SP-initiated SSO', sso],
  ['IdP-initiated SSO', idpInitiated],
] as const)('%s for a tenant with an institution', (_name, run) => {
  beforeEach(() =>
    arrange(
      { ...REGISTERED },
      {
        eduPersonScopedAffiliation: ['member@example.ac.jp', 'faculty@other.example'],
        eduPersonPrincipalName: 'alice',
      }
    )
  );

  it('releases a scoped value only under a registered scope, and gives an unscoped one the default', async () => {
    const response = await run();
    expect(response.status).toBe(200);
    expect(assertionAttributes()).toEqual({
      [OID_MAIL]: ['user@example.test'],
      [OID_EPSA]: ['member@example.ac.jp'],
      [OID_EPPN]: ['alice@example.ac.jp'],
    });
    expect(mocks.lastXml).not.toContain('other.example');
    expect(mocks.lastXml).not.toContain('faculty');
  });

  it('does not let the person choose the scope of their principal name', async () => {
    mocks.user = {
      id: 'user-a',
      email: 'user@example.test',
      customClaims: { eduPersonPrincipalName: 'alice@rival.example' },
    };
    mocks.binding = institutionBinding([EDGE_EPPN]);
    const response = await run();
    expect(response.status).toBe(200);
    expect(assertionAttributes()).toEqual({ [OID_MAIL]: ['user@example.test'] });
    expect(mocks.lastXml).not.toContain('rival.example');
  });

  it('applies the scopes to a principal name that a transform makes from an unscoped field', async () => {
    mocks.user = {
      id: 'user-a',
      email: 'user@example.test',
      customClaims: { eduPersonPrincipalName: 'alice@rival.example' },
    };
    // The only edge ends in a field that is not scoped; the transform copies it to the
    // eduPersonPrincipalName no edge names.
    mocks.binding = {
      ...institutionBinding([
        customClaimEdge('edge_in', 'eduPersonPrincipalName', 'urn:oid:2.5.4.4'),
      ]),
      transforms: [
        {
          id: 'transform_eppn',
          inputEdgeIds: ['edge_in'],
          operation: 'copy',
          outputTargetRef: { side: 'destination', namespace: 'saml.attribute', path: OID_EPPN },
        },
      ],
    };
    const response = await run();
    expect(response.status).toBe(200);
    expect(assertionAttributes()).toEqual({ [OID_MAIL]: ['user@example.test'] });
    expect(mocks.lastXml).not.toContain('rival.example');
    expect(withheldRecords()[0]).toMatchObject({
      withheld: [expect.objectContaining({ name: OID_EPPN, reason: 'scope_not_registered' })],
    });
  });

  it('does not release a principal name with more than one @, even when it ends in a registered scope', async () => {
    mocks.user = {
      id: 'user-a',
      email: 'user@example.test',
      customClaims: { eduPersonPrincipalName: 'alice@rival.example@example.ac.jp' },
    };
    mocks.binding = institutionBinding([EDGE_EPPN]);
    await run();
    expect(assertionAttributes()).toEqual({ [OID_MAIL]: ['user@example.test'] });
    expect(withheldRecords()[0]).toMatchObject({
      withheld: [expect.objectContaining({ reason: 'value_malformed', count: 1 })],
    });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('rival');
  });

  it('records what it withheld by reason and scope, with no value of the person', async () => {
    await run();
    expect(withheldRecords()).toEqual([
      {
        protocol: 'saml',
        sp_entity_id: PRODUCTION_SP_ENTITY_ID,
        request_id: expect.any(String),
        withheld: [
          {
            attribute: 'eduPersonScopedAffiliation',
            name: OID_EPSA,
            reason: 'scope_not_registered',
            scope: 'other.example',
            count: 1,
          },
        ],
      },
    ]);
    const recorded = JSON.stringify(mocks.audit.mock.calls);
    for (const personal of ['faculty', 'alice', 'member', 'user@example.test']) {
      expect(recorded).not.toContain(personal);
    }
    expect(mocks.audit.mock.calls.at(-1)?.[1]).toMatchObject({ severity: 'warning' });
  });

  it('records nothing when everything was under a registered scope', async () => {
    mocks.user = {
      id: 'user-a',
      email: 'user@example.test',
      customClaims: { eduPersonScopedAffiliation: ['staff@med.example.ac.jp'] },
    };
    await run();
    expect(assertionAttributes()[OID_EPSA]).toEqual(['staff@med.example.ac.jp']);
    expect(withheldRecords()).toEqual([]);
  });

  it('releases schacHomeOrganization and the organization name only to a mapping that chooses them', async () => {
    await run();
    expect(Object.keys(assertionAttributes())).not.toContain(OID_SCHAC_HOME_ORGANIZATION);
    expect(Object.keys(assertionAttributes())).not.toContain(OID_ORGANIZATION_NAME);

    mocks.binding = institutionBinding([
      EDGE_EPSA,
      EDGE_SCHAC_HOME_ORGANIZATION,
      EDGE_ORGANIZATION_NAME,
    ]);
    await run();
    expect(assertionAttributes()).toMatchObject({
      [OID_SCHAC_HOME_ORGANIZATION]: ['example.ac.jp'],
      [OID_ORGANIZATION_NAME]: ['Example University'],
    });
  });

  it('does not take schacHomeOrganization or the name from what the person holds', async () => {
    mocks.user = {
      id: 'user-a',
      email: 'user@example.test',
      schac_home_organization: 'rival.example',
      organization_name: 'Rival University',
      customClaims: { schac_home_organization: 'rival.example' },
    };
    mocks.binding = institutionBinding([EDGE_SCHAC_HOME_ORGANIZATION, EDGE_ORGANIZATION_NAME]);
    await run();
    expect(assertionAttributes()).toMatchObject({
      [OID_SCHAC_HOME_ORGANIZATION]: ['example.ac.jp'],
      [OID_ORGANIZATION_NAME]: ['Example University'],
    });
    expect(mocks.lastXml).not.toContain('rival');
  });

  it('releases no home organization without scopes, and no name without one', async () => {
    mocks.assuranceSettings = {};
    mocks.binding = institutionBinding([EDGE_SCHAC_HOME_ORGANIZATION, EDGE_ORGANIZATION_NAME]);
    const response = await run();
    expect(response.status).toBe(200);
    expect(assertionAttributes()).toEqual({ [OID_MAIL]: ['user@example.test'] });
  });

  it('withholds the scoped values, and records why, when the institution settings cannot be read', async () => {
    mocks.settingsError = new Error('kv down');
    const response = await run();
    expect(response.status).toBe(200);
    // Not knowing whether scopes are registered is not "none registered": nothing scoped goes out.
    expect(assertionAttributes()).toEqual({ [OID_MAIL]: ['user@example.test'] });
    expect(withheldRecords()[0]).toMatchObject({
      withheld: [
        expect.objectContaining({ reason: 'institution_settings_unavailable', count: 2 }),
        expect.objectContaining({ reason: 'institution_settings_unavailable', count: 1 }),
      ],
    });
    expect(mocks.error).toHaveBeenCalledWith(
      'Failed to read the tenant institution settings',
      expect.objectContaining({ tenantId: 'tenant-a' }),
      expect.any(Error)
    );
  });

  it('withholds the scoped values when the saved scopes are not valid', async () => {
    mocks.assuranceSettings = { 'institution.scopes': 'Example.AC.JP,*.example' };
    await run();
    expect(assertionAttributes()).toEqual({ [OID_MAIL]: ['user@example.test'] });
    expect(withheldRecords()[0]).toMatchObject({
      withheld: [
        expect.objectContaining({ reason: 'institution_scopes_invalid' }),
        expect.objectContaining({ reason: 'institution_scopes_invalid' }),
      ],
    });
  });

  it('reads the institution once, and changes nothing, for a mapping that releases nothing about it', async () => {
    mocks.binding = institutionBinding([]);
    const response = await run();
    expect(response.status).toBe(200);
    expect(mocks.requestedSettings.filter((category) => category === 'institution')).toHaveLength(
      1
    );
    expect(assertionAttributes()).toEqual({ [OID_MAIL]: ['user@example.test'] });
  });

  it('refuses, naming only the attribute and the scope, when a required scoped attribute has no value left', async () => {
    mocks.sp = institutionSpConfig([OID_MAIL, OID_EPPN]);
    mocks.user = {
      id: 'user-a',
      email: 'user@example.test',
      customClaims: { eduPersonPrincipalName: 'alice@rival.example' },
    };
    mocks.binding = institutionBinding([EDGE_EPPN]);
    await run();
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    const failure = mocks.audit.mock.calls
      .map(([, entry]) => entry)
      .find((entry) => entry.action === 'saml.policy.failed');
    expect(JSON.parse(failure?.metadata ?? '{}')).toMatchObject({
      failure_kind: 'required_attribute_missing',
      policy_details: {
        withheld: [
          expect.objectContaining({ reason: 'scope_not_registered', scope: 'rival.example' }),
        ],
      },
    });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('alice');
  });
});

describe.each([
  ['SP-initiated SSO', sso],
  ['IdP-initiated SSO', idpInitiated],
] as const)('%s for a tenant with no institution', (_name, run) => {
  beforeEach(() =>
    arrange(
      {},
      {
        eduPersonScopedAffiliation: ['member@example.ac.jp', 'faculty@other.example'],
        eduPersonPrincipalName: 'alice@rival.example',
      }
    )
  );

  it('releases the values exactly as the person holds them, as it always has', async () => {
    const response = await run();
    expect(response.status).toBe(200);
    expect(assertionAttributes()).toEqual({
      [OID_MAIL]: ['user@example.test'],
      [OID_EPSA]: ['member@example.ac.jp', 'faculty@other.example'],
      [OID_EPPN]: ['alice@rival.example'],
    });
    expect(withheldRecords()).toEqual([]);
  });

  it('releases neither schacHomeOrganization nor the name, though a mapping chooses them', async () => {
    mocks.binding = institutionBinding([
      EDGE_EPSA,
      EDGE_SCHAC_HOME_ORGANIZATION,
      EDGE_ORGANIZATION_NAME,
    ]);
    await run();
    expect(Object.keys(assertionAttributes())).toEqual([OID_MAIL, OID_EPSA]);
  });
});
