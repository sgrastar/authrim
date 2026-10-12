/**
 * The SSO endpoints release attributes for an SP whose mapping is in the shape a deployed tenant
 * has it (see __fixtures__/production-shaped-mapping.ts): the real attribute release, identity
 * assurance sources and Destination Profile filter run; only storage, sessions and signing are
 * stand-ins. Before the mapping carried destination catalog entries, a required attribute here
 * ended as "Required SAML attributes could not be released".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SAML_NAMESPACES } from '../../common/constants';
import { createEvidenceDb, type EvidenceDb } from './helpers/evidence-db';
import {
  emptyCoreAdapter,
  OID_EDU_PERSON_ASSURANCE,
  OID_ENTITLEMENT,
  OID_MAIL,
  OID_SURNAME,
  PRODUCTION_SP_ENTITY_ID,
  productionAdminAdapter,
  productionBinding,
  productionSpConfig,
  PRODUCTION_SAML_INPUT_EDGE,
  PRODUCTION_SAML_INPUT_REQUIRED_RULE,
  PRODUCTION_EDGES,
} from '../__fixtures__/production-shaped-mapping';

const mocks = vi.hoisted(() => ({
  sp: null as Record<string, unknown> | null,
  user: null as Record<string, unknown> | null,
  sessionResponse: new Response(null, { status: 404 }),
  assuranceSettings: {} as Record<string, unknown>,
  evidenceAdapter: null as unknown,
  getCoreAdapter: vi.fn(),
  admin: null as unknown,
  core: null as unknown,
  binding: null as unknown,
  warn: vi.fn(),
  audit: vi.fn(async (_env: unknown, _entry: { metadata?: string }) => undefined),
  buildResponse: vi.fn((_options?: unknown) => '<saml-success-response/>'),
  buildErrorResponse: vi.fn((_options?: unknown) => '<saml-error-response/>'),
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
    resolveEffectiveSettings: vi.fn(async () => mocks.assuranceSettings),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: mocks.warn, info: vi.fn(), debug: vi.fn() }),
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
vi.mock('../assertion', () => ({ buildSAMLResponse: mocks.buildResponse }));
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

const IAL1_URI = 'https://example.org/assurance/IAL1';
const IAL2_URI = 'https://example.org/assurance/IAL2';
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

const releasedAttributes = () =>
  (
    mocks.buildResponse.mock.calls.at(-1)?.[0] as {
      attributes: Array<{ name: string; values: string[] }>;
    }
  ).attributes;

describe('attribute release for an SP with a deployed-tenant mapping', () => {
  let evidence: EvidenceDb;

  beforeAll(async () => {
    evidence = await createEvidenceDb('user-a');
  });
  afterAll(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    evidence.clearEvidence();
    evidence.resetReads();
    evidence.addEvidence('ev-1', 'IAL2');
    mocks.evidenceAdapter = evidence.adapter;
    mocks.getCoreAdapter.mockImplementation(async () => mocks.evidenceAdapter);
    mocks.sp = productionSpConfig();
    mocks.user = { id: 'user-a', email: 'user@example.test', family_name: 'Example' };
    mocks.sessionResponse = new Response(JSON.stringify({ userId: 'user-a', data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    mocks.admin = productionAdminAdapter();
    mocks.core = emptyCoreAdapter();
    mocks.binding = productionBinding();
    mocks.assuranceSettings = {
      'assurance.enabled': true,
      'assurance.ial_assurance_values': JSON.stringify({
        IAL1: [IAL1_URI],
        IAL2: [IAL2_URI, IAL1_URI],
      }),
    };
  });

  describe.each([
    ['SP-initiated SSO', sso],
    ['IdP-initiated SSO', idpInitiated],
  ] as const)('%s', (_name, run) => {
    it('releases mail and the multi-valued eduPersonAssurance, and not the optional attribute nobody selected', async () => {
      const response = await run();
      expect(response.status).toBe(200);
      expect(mocks.buildErrorResponse).not.toHaveBeenCalled();
      expect(releasedAttributes()).toEqual([
        expect.objectContaining({ name: OID_MAIL, values: ['user@example.test'] }),
        expect.objectContaining({ name: OID_EDU_PERSON_ASSURANCE, values: [IAL1_URI, IAL2_URI] }),
      ]);
    });

    it('releases neither a hidden attribute nor a hidden assurance field, and reads no evidence for it', async () => {
      mocks.sp = productionSpConfig({
        [OID_MAIL]: 'required',
        [OID_SURNAME]: 'optional',
        [OID_EDU_PERSON_ASSURANCE]: 'hidden',
        [OID_ENTITLEMENT]: 'optional',
      });
      await run();
      expect(releasedAttributes().map((attribute) => attribute.name)).toEqual([OID_MAIL]);
      expect(evidence.evidenceReads()).toBe(0);
    });
  });

  describe.each([
    ['SP-initiated SSO', sso],
    ['IdP-initiated SSO', idpInitiated],
  ] as const)('%s: a mapping that may not release', (_name, run) => {
    const auditedDetails = () =>
      JSON.parse(mocks.audit.mock.calls.at(-1)?.[1].metadata ?? '{}') as {
        failure_kind?: string;
        policy_details?: { reason_codes?: string[]; field?: string };
      };

    it('does not release an attribute under another field’s name, and says so in the audit log', async () => {
      // mail (personal data) renamed to a field the release policy treats differently.
      mocks.sp = productionSpConfig(
        {
          [OID_MAIL]: 'hidden',
          [OID_SURNAME]: 'optional',
          [OID_EDU_PERSON_ASSURANCE]: 'required',
          [OID_ENTITLEMENT]: 'required',
        },
        {
          identityMapping: {
            ...productionSpConfig().identityMapping,
            destinationFieldPolicies: {
              [OID_MAIL]: 'hidden',
              [OID_SURNAME]: 'optional',
              [OID_EDU_PERSON_ASSURANCE]: 'required',
              [OID_ENTITLEMENT]: 'required',
            },
            attributeDescriptors: { [OID_MAIL]: { name: OID_ENTITLEMENT } },
          },
        }
      );
      await run();
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(auditedDetails()).toMatchObject({
        failure_kind: 'identity_mapping_failed',
        policy_details: { reason_codes: ['policy.attribute_descriptor_renames_field'] },
      });
    });

    const edge = (source: Record<string, unknown>, target: string) => ({
      id: `edge_${target}`,
      sourceRef: { side: 'source', ...source },
      targetRef: { side: 'destination', namespace: 'saml.attribute', path: target },
    });
    const requireAssuranceOnly = () =>
      productionSpConfig({
        [OID_MAIL]: 'optional',
        [OID_SURNAME]: 'optional',
        [OID_EDU_PERSON_ASSURANCE]: 'required',
        [OID_ENTITLEMENT]: 'optional',
      });

    it('issues the assertion when the source profile’s rule asks for the same attribute the destination releases', async () => {
      mocks.binding = {
        ...productionBinding({ validationRules: [PRODUCTION_SAML_INPUT_REQUIRED_RULE] }),
        edges: [PRODUCTION_SAML_INPUT_EDGE, ...PRODUCTION_EDGES],
      };
      const response = await run();
      expect(response.status).toBe(200);
      expect(mocks.buildErrorResponse).not.toHaveBeenCalled();
      expect(releasedAttributes().map((attribute) => attribute.name)).toEqual(
        expect.arrayContaining([OID_MAIL])
      );
    });

    it('does not mix the value of an edge that is not released into one that is (one id for two reads)', async () => {
      mocks.user = { id: 'user-a', email: 'user@example.test', locale: 'ja' };
      mocks.binding = {
        ...productionBinding(),
        edges: [
          edge(
            {
              namespace: 'authrim.profile',
              path: 'email',
              catalogEntryId: 'field.canonical.locale',
            },
            'urn:oid:intermediate'
          ),
          edge(
            {
              namespace: 'authrim.profile',
              path: 'locale',
              catalogEntryId: 'field.canonical.locale',
            },
            OID_EDU_PERSON_ASSURANCE
          ),
        ],
      };
      mocks.sp = requireAssuranceOnly();
      await run();
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(auditedDetails()).toMatchObject({ failure_kind: 'identity_mapping_failed' });
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('user@example.test');
    });

    it('does not skip an edge whose source reference says it is a destination', async () => {
      mocks.binding = {
        ...productionBinding(),
        edges: [
          edge(
            {
              side: 'destination',
              namespace: 'authrim.profile',
              path: 'email',
              catalogEntryId: 'field.canonical.locale',
            },
            OID_EDU_PERSON_ASSURANCE
          ),
        ],
      };
      mocks.sp = requireAssuranceOnly();
      await run();
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(auditedDetails()).toMatchObject({
        failure_kind: 'identity_mapping_failed',
        policy_details: { reason_codes: ['policy.release_edge_reference_invalid'] },
      });
    });

    it('does not release from a source whose classification is unknown, and says so in the audit log', async () => {
      mocks.binding = {
        ...productionBinding(),
        edges: [
          {
            id: 'edge_unknown',
            sourceRef: { side: 'source', namespace: 'authrim.claim', path: 'unlisted' },
            targetRef: {
              side: 'destination',
              namespace: 'saml.attribute',
              path: OID_EDU_PERSON_ASSURANCE,
            },
          },
        ],
      };
      mocks.user = { id: 'user-a', email: 'user@example.test', unlisted: 'private-value' };
      mocks.sp = productionSpConfig({
        [OID_MAIL]: 'optional',
        [OID_SURNAME]: 'optional',
        [OID_EDU_PERSON_ASSURANCE]: 'required',
        [OID_ENTITLEMENT]: 'optional',
      });
      await run();
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(auditedDetails()).toMatchObject({
        failure_kind: 'identity_mapping_failed',
        policy_details: {
          reason_codes: ['policy.release_source_classification_unknown'],
          field: OID_EDU_PERSON_ASSURANCE,
        },
      });
      // The log names the field and the reason, and carries no value.
      expect(mocks.warn).toHaveBeenCalledWith(
        'SAML field mapping set failed',
        expect.objectContaining({
          reasonCodes: ['policy.release_source_classification_unknown'],
          field: OID_EDU_PERSON_ASSURANCE,
        })
      );
      expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private-value');
      expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('user@example.test');
      // No value is in the audit record.
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('user@example.test');
      expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('private-value');
    });
  });

  it('answers a required attribute without a value with InvalidAttrNameOrValue (SP-initiated)', async () => {
    // Assurance values are not configured, so eduPersonAssurance, required, has no value.
    mocks.assuranceSettings = { 'assurance.enabled': true, 'assurance.ial_assurance_values': '{}' };
    const response = await sso();
    expect(response.status).toBe(200);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
    expect(mocks.buildErrorResponse.mock.calls.at(-1)?.[0]).toMatchObject({
      statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Responder',
      secondLevelStatusCode: 'urn:oasis:names:tc:SAML:2.0:status:InvalidAttrNameOrValue',
    });
    expect(evidence.evidenceReads()).toBe(0);
  });

  it('does not issue an assertion for a required attribute without a value (IdP-initiated)', async () => {
    mocks.assuranceSettings = { 'assurance.enabled': false };
    const response = await idpInitiated();
    expect(response.status).toBe(500);
    expect(mocks.buildResponse).not.toHaveBeenCalled();
  });
});
