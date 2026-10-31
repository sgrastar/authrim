/**
 * The SAML IdP SSO endpoint and the AAL a sign-in must have: the SP's minimum AAL and the AAL of
 * the AuthnContextClassRef a request asks for, the step-up to authenticate again, the class
 * reference an assertion carries, and the ForceAuthn sign-in a person returns from.
 *
 * Sessions live in an in-memory store that the endpoint reads (GET) and, for a step-up, combines
 * and writes (RPC, conditional on what it read); the stored AuthnRequest is an in-memory request
 * store that is consumed when the person comes back, as the real one is.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SAML_NAMESPACES, STATUS_CODES } from '../../common/constants';
import { createEvidenceDb, type EvidenceDb } from './helpers/evidence-db';

interface StoredChallenge {
  id: string;
  tenantId: string;
  type: string;
  userId: string;
  ttl: number;
  metadata: Record<string, unknown>;
}

interface FakeSession {
  userId: string;
  expiresAt: number;
  createdAt?: number;
  data: Record<string, unknown>;
}

const mocks = vi.hoisted(() => ({
  sp: null as Record<string, unknown> | null,
  ui: undefined as { baseUrl: string; paths?: { login?: string } } | undefined,
  sessionId: undefined as string | undefined,
  sessions: new Map<string, unknown>(),
  sessionWrites: [] as Array<{ id: string; updates: Record<string, unknown> }>,
  requests: new Map<string, unknown>(),
  /** The authorization challenges stored for the Login UI (ChallengeStore), by id. */
  challenges: new Map<string, StoredChallenge>(),
  challengeError: null as Error | null,
  user: { id: 'user-a', email: 'user@example.test' } as Record<string, unknown> | null,
  assuranceSettings: null as Record<string, unknown> | null,
  settingsReads: 0,
  settingsError: null as Error | null,
  consentError: null as Error | null,
  evidenceAdapter: null as unknown,
  buildResponse: vi.fn((_options?: unknown) => '<saml-success-response/>'),
  buildErrorResponse: vi.fn((_options?: unknown) => '<saml-error-response/>'),
  audit: vi.fn(),
}));

function fakeSessionStore() {
  const sessions = mocks.sessions as Map<string, FakeSession>;
  return {
    async fetch(url: string) {
      const session = sessions.get(url.split('/').pop() ?? '');
      return session && session.expiresAt > Date.now()
        ? new Response(JSON.stringify(session), { status: 200 })
        : new Response(null, { status: 404 });
    },
    async getSessionRpc(id: string) {
      return sessions.get(id) ?? null;
    },
    async updateSessionDataRpc(
      id: string,
      updates: Record<string, unknown>,
      options?: { ifDataMatches?: Record<string, unknown> }
    ) {
      const session = sessions.get(id);
      if (!session) return null;
      const matches = Object.entries(options?.ifDataMatches ?? {}).every(
        ([field, value]) => JSON.stringify(session.data[field]) === JSON.stringify(value)
      );
      if (matches) {
        mocks.sessionWrites.push({ id, updates: { ...updates } });
        session.data = { ...session.data, ...updates };
      }
      return session;
    },
  };
}

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getUIConfig: vi.fn(async () => mocks.ui),
    getTenantSettingsDocument: vi.fn(async () => ({})),
    buildIssuerUrl: vi.fn(() => 'https://tenant.example.test'),
    buildSAMLRequestStoreInstanceName: vi.fn(
      (tenant: string, role: string, entity: string) => `${tenant}:${role}:${entity}`
    ),
    getSessionStoreBySessionId: vi.fn(() => ({ stub: fakeSessionStore() })),
    isShardedSessionId: vi.fn((id: string) => id.startsWith('s')),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => ({})),
    requireAdminDatabaseAdapter: vi.fn(() => ({ query: vi.fn(async () => []) })),
    resolveRuntimeIdentityMappingBinding: vi.fn(async () => ({
      id: 'binding',
      tenantId: 'tenant-a',
      catalog: { entries: [] },
      edges: [],
      transforms: [],
      validationRules: [],
      fieldMappingSet: {},
      fieldMappingSetId: 'set',
      fieldMappingVersionId: 'version',
      destinationNamespace: 'saml',
      destinationProfileId: 'destination-profile-saml',
      destinationProfileIds: ['destination-profile-saml'],
    })),
    filterSamlAttributesByDestinationConsentWithStatus: vi.fn(
      async (input: { attributes: unknown[] }) => ({
        attributes: input.attributes,
        consentApplied: false,
      })
    ),
    getLocalization: vi.fn(async () => ({ locale: 'en', t: (key: string) => key })),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
    createAuditLog: mocks.audit,
  };
});

vi.mock('../../admin/providers', () => ({ getSPConfig: vi.fn(async () => mocks.sp) }));

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

vi.mock('../../common/user-store', () => ({
  getSamlUserInfoById: vi.fn(async () => mocks.user),
  getSamlUserCoreAdapter: vi.fn(async () => mocks.evidenceAdapter),
}));

vi.mock('../../common/idp-signing', () => ({
  getSAMLIdPSigningMaterial: vi.fn(async () => ({
    privateKeyPem: 'private-key',
    certificate: 'certificate',
  })),
}));

vi.mock('../signing', () => ({
  applySAMLResponseSigningPolicy: vi.fn((xml: string) => xml),
  assertSAMLResponseSigningPolicy: vi.fn(),
}));

vi.mock('../assertion', () => ({ buildSAMLResponse: mocks.buildResponse }));

vi.mock('../attributes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../attributes')>();
  return {
    ...actual,
    buildSAMLAttributesForSPWithDiagnostics: vi.fn(() => ({
      attributes: [{ name: 'mail', values: ['user@example.test'] }],
      optionalMissingAttributes: [],
    })),
  };
});

vi.mock('../attribute-release-consent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../attribute-release-consent')>();
  return {
    ...actual,
    enforceSAMLAttributeReleaseConsent: vi.fn(async (input: { confirmedRelease?: unknown }) => {
      if (input.confirmedRelease) return;
      if (mocks.consentError) throw mocks.consentError;
    }),
  };
});

vi.mock('../subject', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../subject')>();
  return {
    ...actual,
    createSAMLSessionIndex: vi.fn(async () => 'session-index'),
    resolveSAMLNameIDFormat: vi.fn(() => 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'),
    resolveSAMLNameIDValue: vi.fn(async () => 'user@example.test'),
    resolveSAMLPairwiseSecret: vi.fn(async () => 'pairwise-secret'),
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

import { handleIdPAttributeReleaseConsent, handleIdPSSO } from '../sso';
import { SAMLAttributeReleaseConsentRequiredError } from '../attribute-release-consent';

const SP_ENTITY = 'https://sp.example.test/entity';
const AAL1_REF = 'https://example.org/profile/AAL1';
const AAL2_REF = 'https://example.org/profile/AAL2';
const AAL3_REF = 'https://example.org/profile/AAL3';
const TABLE = JSON.stringify({ [AAL1_REF]: 'AAL1', [AAL2_REF]: 'AAL2', [AAL3_REF]: 'AAL3' });
const ENABLED_WITH_TABLE = { 'assurance.enabled': true, 'assurance.saml_authn_context_aal': TABLE };

const LONG_AGO = Date.now() - 3_600_000;

function sp(overrides: Record<string, unknown> = {}) {
  return {
    entityId: SP_ENTITY,
    acsUrl: 'https://sp.example.test/acs',
    acsUrls: ['https://sp.example.test/acs'],
    allowedBindings: ['post'],
    authnRequestSignaturePolicy: 'optional',
    signResponses: true,
    signAssertions: false,
    ...overrides,
  };
}

function setSession(
  id: string,
  data: Record<string, unknown>,
  userId = 'user-a',
  createdAt?: number
) {
  (mocks.sessions as Map<string, FakeSession>).set(id, {
    userId,
    expiresAt: Date.now() + 3_600_000,
    ...(createdAt !== undefined ? { createdAt } : {}),
    data,
  });
}

function sessionData(id: string): Record<string, unknown> {
  return (mocks.sessions as Map<string, FakeSession>).get(id)?.data ?? {};
}

function app() {
  const route = new Hono();
  route.use('*', async (c, next) => {
    (c.set as (key: string, value: string) => void)('tenantId', 'tenant-a');
    await next();
  });
  route.all('/sso', handleIdPSSO as never);
  route.post('/consent', handleIdPAttributeReleaseConsent as never);
  return route;
}

function environment() {
  return {
    SETTINGS: {
      get: vi.fn(async (key: string) => {
        if (key === 'settings:tenant:tenant-a:assurance') {
          mocks.settingsReads += 1;
          if (mocks.settingsError) throw mocks.settingsError;
          return mocks.assuranceSettings ? JSON.stringify(mocks.assuranceSettings) : null;
        }
        return null;
      }),
    },
    CHALLENGE_STORE: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({
        storeChallengeRpc: async (request: StoredChallenge) => {
          if (mocks.challengeError) throw mocks.challengeError;
          mocks.challenges.set(request.id, request);
          return { success: true };
        },
      })),
    },
    SAML_REQUEST_STORE: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({
        fetch: async (url: string, init?: { body?: string }) => {
          if (url.endsWith('/store')) {
            const stored = JSON.parse(init?.body ?? '{}') as { requestId: string };
            mocks.requests.set(stored.requestId, stored);
            return new Response('{}', { status: 200 });
          }
          const requestId = decodeURIComponent(url.split('/').pop() ?? '');
          const stored = mocks.requests.get(requestId);
          mocks.requests.delete(requestId);
          return stored
            ? new Response(JSON.stringify(stored), { status: 200 })
            : new Response(null, { status: 404 });
        },
      })),
    },
  };
}

function authnRequestXml(
  options: {
    forceAuthn?: boolean;
    isPassive?: boolean;
    comparison?: string;
    classRefs?: string[];
  } = {}
) {
  const attrs = [
    'ID="_request"',
    `IssueInstant="${new Date().toISOString()}"`,
    options.forceAuthn ? 'ForceAuthn="true"' : '',
    options.isPassive ? 'IsPassive="true"' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const requested = options.classRefs
    ? `<samlp:RequestedAuthnContext${options.comparison ? ` Comparison="${options.comparison}"` : ''}>${options.classRefs
        .map((ref) => `<saml:AuthnContextClassRef>${ref}</saml:AuthnContextClassRef>`)
        .join('')}</samlp:RequestedAuthnContext>`
    : '';
  return `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ${attrs}>
    <saml:Issuer>${SP_ENTITY}</saml:Issuer>${requested}
  </samlp:AuthnRequest>`;
}

async function send(request: Request) {
  return app().fetch(request, environment(), {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as never);
}

/** The SP sends an AuthnRequest by POST, with the cookie of `sessionId` (if any). */
async function post(xml: string, sessionId?: string) {
  mocks.sessionId = sessionId;
  const form = new FormData();
  form.set('SAMLRequest', btoa(xml));
  return send(
    new Request('https://tenant.example.test/sso', {
      method: 'POST',
      body: form,
      headers: sessionId ? { Cookie: `authrim_session=${sessionId}` } : {},
    })
  );
}

/** The person comes back from the login page, with the cookie of `sessionId`. */
async function resume(sessionId?: string) {
  mocks.sessionId = sessionId;
  const query = new URLSearchParams({
    saml_request_id: '_request',
    saml_sp_entity_id: SP_ENTITY,
    return_to: 'saml_sso',
  });
  return send(
    new Request(`https://tenant.example.test/sso?${query}`, {
      headers: sessionId ? { Cookie: `authrim_session=${sessionId}` } : {},
    })
  );
}

interface StoredContext {
  reauthentication?: { issuedAt: number };
  assuranceStepUp?: {
    issuedAt: number;
    priorSessionId?: string;
    requiredAal: string;
    completed?: { sessionId: string; aal: string };
  };
  attributeReleaseConsentChallenge?: { challengeId: string };
}

const storedContext = (): StoredContext | undefined =>
  (mocks.requests.get('_request') as { context?: StoredContext } | undefined)?.context;

const stepUpOf = () => {
  const stepUp = storedContext()?.assuranceStepUp;
  if (!stepUp) throw new Error('No step-up was stored with the request');
  return stepUp;
};
const reauthOf = () => {
  const reauthentication = storedContext()?.reauthentication;
  if (!reauthentication) throw new Error('No ForceAuthn sign-in was stored with the request');
  return reauthentication;
};

const lastSuccess = () =>
  mocks.buildResponse.mock.calls.at(-1)?.[0] as { authnContextClassRef: string } | undefined;
const lastError = () =>
  mocks.buildErrorResponse.mock.calls.at(-1)?.[0] as
    | { statusCode: string; secondLevelStatusCode?: string; statusMessage?: string }
    | undefined;
const lastTiming = () =>
  mocks.buildResponse.mock.calls.at(-1)?.[0] as { authnInstant: string; issueInstant: string };
/** An instant as the assertion states it (whole seconds, UTC). */
const stated = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const auditKinds = () =>
  mocks.audit.mock.calls.flatMap((call) => {
    const metadata = JSON.stringify(call);
    return (
      /authn_assurance_insufficient|authn_request_no_passive|authn_request_force_authn_unmet|authn_assurance_unavailable/.exec(
        metadata
      )?.[0] ?? []
    );
  });

describe('SAML IdP SSO and authentication assurance', () => {
  let evidence: EvidenceDb;
  beforeAll(async () => {
    evidence = await createEvidenceDb('user-a');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sp = sp();
    mocks.ui = { baseUrl: 'https://ui.example.test' };
    mocks.sessionId = undefined;
    mocks.sessions.clear();
    mocks.sessionWrites.length = 0;
    mocks.requests.clear();
    mocks.challenges.clear();
    mocks.challengeError = null;
    mocks.user = { id: 'user-a', email: 'user@example.test' };
    mocks.assuranceSettings = null;
    mocks.settingsReads = 0;
    mocks.settingsError = null;
    mocks.consentError = null;
    mocks.evidenceAdapter = evidence.adapter;
    evidence.clearEvidence();
    evidence.resetReads();
  });

  describe('with nothing configured', () => {
    it('answers a session as before and reads no assurance setting', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml(), 's-1');
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(mocks.settingsReads).toBe(0);
      expect(mocks.requests.size).toBe(0);
    });

    it('does not apply the tenant table while assurance levels are off', async () => {
      // Off: the table maps nothing; the request is handled as it always was (not step-up).
      mocks.assuranceSettings = { ...ENABLED_WITH_TABLE, 'assurance.enabled': false };
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml({ classRefs: [AAL2_REF] }), 's-1');
      expect(response.status).toBe(200);
      // The existing handling cannot satisfy an unlisted reference: NoAuthnContext, no sign-in.
      expect(mocks.requests.size).toBe(0);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({
        secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT,
      });
    });
  });

  describe('the SP minimum AAL', () => {
    beforeEach(() => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
    });

    it('answers a session that reaches it, and records nothing', async () => {
      setSession('s-1', { amr: ['pwd', 'totp'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml(), 's-1');
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(mocks.requests.size).toBe(0);
    });

    it('applies while assurance levels are off', async () => {
      mocks.assuranceSettings = { 'assurance.enabled': false };
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml(), 's-1');
      expect(response.status).toBe(302);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
    });

    it('sends a session below it to authenticate again, once, asking for a new sign-in', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml(), 's-1');
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location') ?? '');
      // A signed-in person proves themselves again on the re-authentication screen.
      expect(location.origin + location.pathname).toBe('https://ui.example.test/reauth');
      expect(location.searchParams.get('force_authn')).toBe('true');
      expect(location.searchParams.get('required_aal')).toBe('AAL2');
      expect(location.searchParams.get('saml_request_id')).toBe('_request');
      expect(stepUpOf()).toMatchObject({
        priorSessionId: 's-1',
        requiredAal: 'AAL2',
        issuedAt: expect.any(Number) as number,
      });
      expect(mocks.buildResponse).not.toHaveBeenCalled();
    });

    it('sends nobody who has no session to a step-up: the ordinary sign-in comes first', async () => {
      const response = await post(authnRequestXml());
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location') ?? '');
      expect(location.searchParams.has('force_authn')).toBe(false);
      expect(location.searchParams.has('required_aal')).toBe(false);
      expect(storedContext()?.assuranceStepUp).toBeUndefined();
    });

    it('combines the earlier password with the TOTP of the new sign-in and answers', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      const issuedAt = stepUpOf().issuedAt;
      setSession('s-2', { amr: ['totp'], proven_at: issuedAt + 10 });

      const response = await resume('s-2');
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      // The combination is recorded in the session, as for an OIDC step-up.
      expect(sessionData('s-2')).toMatchObject({ amr: ['pwd', 'totp'], proven_at: LONG_AGO });
    });

    it('does not send a person who comes back below it round again: NoAuthnContext', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      const issuedAt = stepUpOf().issuedAt;
      // A password again: AAL1 combined with AAL1 is still AAL1.
      setSession('s-2', { amr: ['pwd'], proven_at: issuedAt + 10 });

      const response = await resume('s-2');
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(mocks.requests.size).toBe(0);
      expect(lastError()).toMatchObject({
        statusCode: STATUS_CODES.RESPONDER,
        secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT,
      });
      expect(auditKinds()).toContain('authn_assurance_insufficient');
    });

    it('counts only a session proven after the step-up began', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      // A session that is AAL2 by itself, but was proven before the step-up began.
      setSession('s-2', { amr: ['pwd', 'totp'], proven_at: LONG_AGO });

      const response = await resume('s-2');
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT });
      expect(mocks.sessionWrites).toEqual([]);
    });

    it('does not count the session it stepped up from when the person comes back with it', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      const response = await resume('s-1');
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT });
    });

    it('does not combine with the session of another person', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      // The stepped-up-from session now belongs to someone else.
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO }, 'user-b');
      const issuedAt = stepUpOf().issuedAt;
      setSession('s-2', { amr: ['totp'], proven_at: issuedAt + 10 });

      await resume('s-2');
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT });
    });

    it('answers a passive request below it with NoPassive, without sending anyone', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml({ isPassive: true }), 's-1');
      expect(response.status).toBe(200);
      expect(mocks.requests.size).toBe(0);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({
        statusCode: STATUS_CODES.RESPONDER,
        secondLevelStatusCode: STATUS_CODES.NO_PASSIVE,
      });
      expect(auditKinds()).toContain('authn_request_no_passive');
    });

    it('reads a stored minimum that is not a level as the highest', async () => {
      mocks.sp = sp({ minimumAal: 'bogus' });
      setSession('s-1', { amr: ['pwd', 'totp'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml(), 's-1');
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('location') ?? '').searchParams.get('required_aal')).toBe(
        'AAL3'
      );
    });

    it('does not say the levels in the answer', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml({ isPassive: true }), 's-1');
      const answer = lastError();
      expect(answer?.statusMessage).toBeTruthy();
      expect(JSON.stringify([answer?.statusMessage, answer?.statusCode])).not.toMatch(/AAL|IAL/);
    });

    it("counts the acr an external IdP gave through the tenant's mapping while assurance is on", async () => {
      mocks.assuranceSettings = {
        'assurance.enabled': true,
        'assurance.upstream_acr_mappings': JSON.stringify({ 'urn:upstream:mfa': 'AAL2' }),
      };
      setSession('s-1', { amr: ['external_idp'], upstream_acr: 'urn:upstream:mfa' });
      const response = await post(authnRequestXml(), 's-1');
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();

      // Off, the mapping is not the tenant's to apply: the login counts as AAL1.
      mocks.assuranceSettings = { ...mocks.assuranceSettings, 'assurance.enabled': false };
      mocks.buildResponse.mockClear();
      const stepUp = await post(authnRequestXml(), 's-1');
      expect(stepUp.status).toBe(302);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
    });

    it('refuses with a temporary error, not as a session below the minimum, when the settings cannot be read', async () => {
      mocks.settingsError = new Error('settings down');
      setSession('s-1', { amr: ['pwd', 'totp'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml(), 's-1');
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(mocks.requests.size).toBe(0);
      const answer = lastError();
      expect(answer?.statusCode).toBe(STATUS_CODES.RESPONDER);
      expect(answer?.secondLevelStatusCode).toBeUndefined();
      expect(auditKinds()).toContain('authn_assurance_unavailable');
    });

    it('refuses for the IAL before it sends anyone to authenticate again', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2', minimumIal: 'IAL2' });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml(), 's-1');
      expect(response.status).toBe(200);
      expect(mocks.requests.size).toBe(0);
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.REQUEST_DENIED });
    });
  });

  describe('the AuthnContext a request asks for', () => {
    beforeEach(() => {
      mocks.assuranceSettings = ENABLED_WITH_TABLE;
      mocks.sp = sp({ authnContextClassRefMode: 'assurance' });
    });

    it('sends a session below the AAL of the requested class reference to authenticate again', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml({ classRefs: [AAL2_REF] }), 's-1');
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('location') ?? '').searchParams.get('required_aal')).toBe(
        'AAL2'
      );
      expect(stepUpOf().requiredAal).toBe('AAL2');
    });

    it('answers a session that reaches it with that class reference', async () => {
      setSession('s-1', { amr: ['pwd', 'totp'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml({ classRefs: [AAL2_REF] }), 's-1');
      expect(response.status).toBe(200);
      expect(lastSuccess()?.authnContextClassRef).toBe(AAL2_REF);
    });

    it('answers a stronger session with the class reference of the AAL reached when the request is minimum', async () => {
      setSession('s-1', { amr: ['passkey'], proven_at: LONG_AGO });
      // A passkey sign-in is AAL2; a request for at least AAL1 gets AAL2's reference.
      await post(authnRequestXml({ classRefs: [AAL1_REF], comparison: 'minimum' }), 's-1');
      expect(lastSuccess()?.authnContextClassRef).toBe(AAL2_REF);
    });

    it('answers an exact request with the requested reference even from a stronger session', async () => {
      setSession('s-1', { amr: ['passkey'], proven_at: LONG_AGO });
      await post(authnRequestXml({ classRefs: [AAL1_REF], comparison: 'exact' }), 's-1');
      expect(lastSuccess()?.authnContextClassRef).toBe(AAL1_REF);
    });

    it('gives the reference of the AAL reached to a request with no AuthnContext', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      expect(lastSuccess()?.authnContextClassRef).toBe(AAL1_REF);
    });

    it('answers NoAuthnContext, without a step-up, to a request better than the highest AAL', async () => {
      setSession('s-1', { amr: ['passkey'], proven_at: LONG_AGO });
      const response = await post(
        authnRequestXml({ classRefs: [AAL3_REF], comparison: 'better' }),
        's-1'
      );
      expect(response.status).toBe(200);
      expect(mocks.requests.size).toBe(0);
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT });
    });

    it('does not step up for a maximum request', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(
        authnRequestXml({ classRefs: [AAL2_REF], comparison: 'maximum' }),
        's-1'
      );
      expect(response.status).toBe(200);
      expect(lastSuccess()?.authnContextClassRef).toBe(AAL1_REF);
    });

    it('does not let a reference of the table beside an unlisted one round the AAL it stands for', async () => {
      const phishingResistant = 'urn:authrim:acr:phishing-resistant';
      mocks.assuranceSettings = {
        'assurance.enabled': true,
        'assurance.saml_authn_context_aal': JSON.stringify({ [phishingResistant]: 'AAL2' }),
      };
      mocks.sp = sp({
        authnContextClassRefMode: 'assurance',
        defaultAuthnContextClassRef: 'urn:legacy:context',
      });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(
        authnRequestXml({ classRefs: [phishingResistant, 'urn:legacy:context'] }),
        's-1'
      );
      // An AAL1 password sign-in is sent to authenticate again rather than given the AAL2 reference.
      expect(response.status).toBe(302);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(stepUpOf().requiredAal).toBe('AAL2');
    });

    it('refuses, after the step-up falls short, instead of issuing the reference of a higher AAL', async () => {
      const phishingResistant = 'urn:authrim:acr:phishing-resistant';
      mocks.assuranceSettings = {
        'assurance.enabled': true,
        'assurance.saml_authn_context_aal': JSON.stringify({ [phishingResistant]: 'AAL2' }),
      };
      mocks.sp = sp({
        authnContextClassRefMode: 'assurance',
        defaultAuthnContextClassRef: 'urn:legacy:context',
      });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml({ classRefs: [phishingResistant, 'urn:legacy:context'] }), 's-1');
      setSession('s-2', { amr: ['pwd'], proven_at: stepUpOf().issuedAt + 10 });
      await resume('s-2');
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT });
    });

    it('does not issue the static reference of a higher AAL than the sign-in reached', async () => {
      // The request lists AAL2's and AAL3's references; the SP's static default is AAL3's. A
      // sign-in at AAL2 passes the AAL2 gate, but must not be given the AAL3 reference.
      mocks.sp = sp({
        authnContextClassRefMode: 'legacy_static',
        defaultAuthnContextClassRef: AAL3_REF,
      });
      setSession('s-1', { amr: ['pwd', 'totp'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml({ classRefs: [AAL2_REF, AAL3_REF] }), 's-1');
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT });
    });

    it('does not issue the static reference of a higher AAL when only the SP minimum applies', async () => {
      mocks.sp = sp({
        authnContextClassRefMode: 'legacy_static',
        defaultAuthnContextClassRef: AAL3_REF,
        minimumAal: 'AAL1',
      });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT });
    });

    it('does not issue the static reference of a higher AAL to a maximum request', async () => {
      mocks.sp = sp({
        authnContextClassRefMode: 'legacy_static',
        defaultAuthnContextClassRef: AAL3_REF,
      });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml({ classRefs: [AAL3_REF], comparison: 'maximum' }), 's-1');
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT });
    });

    it('answers better than one of the listed references with a stronger one, not all', async () => {
      setSession('s-1', { amr: ['passkey'], proven_at: LONG_AGO });
      await post(authnRequestXml({ classRefs: [AAL1_REF, AAL3_REF], comparison: 'better' }), 's-1');
      expect(lastSuccess()?.authnContextClassRef).toBe(AAL2_REF);
    });

    it('steps up for better than the weakest listed reference', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(
        authnRequestXml({ classRefs: [AAL1_REF, AAL3_REF], comparison: 'better' }),
        's-1'
      );
      expect(response.status).toBe(302);
      expect(stepUpOf().requiredAal).toBe('AAL2');
    });

    describe.each(['legacy_static', 'session'] as const)(
      'a request read through the table, in %s mode',
      (mode) => {
        const PPT = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
        const withTable = (table: Record<string, string>) => {
          mocks.sp = sp({ authnContextClassRefMode: mode });
          mocks.assuranceSettings = {
            'assurance.enabled': true,
            'assurance.saml_authn_context_aal': JSON.stringify(table),
          };
          setSession('s-1', { amr: ['pwd', 'totp'], proven_at: LONG_AGO });
        };

        it('does not answer better than a reference with that very reference', async () => {
          // AAL2 passes the gate (better than AAL1), but the existing handling would return the
          // requested PasswordProtectedTransport itself, which is not better than itself.
          withTable({ [PPT]: 'AAL1', [AAL2_REF]: 'AAL2' });
          const response = await post(
            authnRequestXml({ classRefs: [PPT], comparison: 'better' }),
            's-1'
          );
          expect(response.status).toBe(200);
          expect(lastSuccess()?.authnContextClassRef).toBe(AAL2_REF);
        });

        it('refuses when no reference of the table fits and the sign-in has reached', async () => {
          withTable({ [PPT]: 'AAL1', [AAL3_REF]: 'AAL3' });
          await post(authnRequestXml({ classRefs: [PPT], comparison: 'better' }), 's-1');
          expect(mocks.buildResponse).not.toHaveBeenCalled();
          expect(lastError()).toMatchObject({
            secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT,
          });
        });

        it('still answers an exact request with the reference it named', async () => {
          withTable({ [PPT]: 'AAL1', [AAL2_REF]: 'AAL2' });
          await post(authnRequestXml({ classRefs: [PPT], comparison: 'exact' }), 's-1');
          expect(lastSuccess()?.authnContextClassRef).toBe(PPT);
        });
      }
    );

    it('leaves a request for a reference the table does not list to the existing handling', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const ppt = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
      const response = await post(authnRequestXml({ classRefs: [ppt] }), 's-1');
      expect(response.status).toBe(200);
      expect(lastSuccess()?.authnContextClassRef).toBe(ppt);
      expect(mocks.requests.size).toBe(0);
    });

    it.each([
      ['AAL3', AAL2_REF, 'AAL3'],
      ['AAL2', AAL3_REF, 'AAL3'],
    ])(
      'requires the higher of the SP minimum %s and the requested reference (%s)',
      async (minimum, ref, required) => {
        mocks.sp = sp({ authnContextClassRefMode: 'assurance', minimumAal: minimum });
        setSession('s-1', { amr: ['pwd', 'totp'], proven_at: LONG_AGO });
        const response = await post(authnRequestXml({ classRefs: [ref] }), 's-1');
        expect(response.status).toBe(302);
        expect(
          new URL(response.headers.get('location') ?? '').searchParams.get('required_aal')
        ).toBe(required);
      }
    );

    it('keeps the static choice in the other modes, after the AAL is met', async () => {
      mocks.sp = sp({
        authnContextClassRefMode: 'legacy_static',
        defaultAuthnContextClassRef: AAL2_REF,
      });
      setSession('s-1', { amr: ['pwd', 'totp'], proven_at: LONG_AGO });
      await post(authnRequestXml({ classRefs: [AAL2_REF] }), 's-1');
      expect(lastSuccess()?.authnContextClassRef).toBe(AAL2_REF);

      // Below the AAL of the requested class reference, the static mode steps up as well.
      setSession('s-3', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml({ classRefs: [AAL2_REF] }), 's-3');
      expect(response.status).toBe(302);
    });

    it('falls back to the static reference when the table has none the sign-in meets', async () => {
      mocks.assuranceSettings = {
        ...ENABLED_WITH_TABLE,
        'assurance.saml_authn_context_aal': JSON.stringify({ [AAL2_REF]: 'AAL2' }),
      };
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      expect(lastSuccess()?.authnContextClassRef).toBe(
        'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
      );
    });
  });

  describe('attribute release consent after a step-up', () => {
    it('is not judged again on the session that holds the combined evidence', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
      mocks.consentError = new SAMLAttributeReleaseConsentRequiredError({
        attributeSetHash: 'hash',
        reasonCodes: ['consent.required'],
        consentMode: 'once',
        attributes: [{ name: 'mail', values: ['user@example.test'] }],
      });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      const issuedAt = stepUpOf().issuedAt;
      setSession('s-2', { amr: ['totp'], proven_at: issuedAt + 10 });

      // Back from the step-up: combined (AAL2), then the consent screen stores the request.
      const consentScreen = await resume('s-2');
      expect(consentScreen.status).toBe(200);
      expect(await consentScreen.text()).toContain('name="challenge_id"');
      expect(stepUpOf().completed).toEqual({
        sessionId: 's-2',
        aal: 'AAL2',
      });
      // The session now records the combined factors, as old as the oldest proof.
      expect(sessionData('s-2')).toMatchObject({ amr: ['pwd', 'totp'], proven_at: LONG_AGO });

      // The person approves; the request comes back with that session and is answered.
      const challengeId = storedContext()?.attributeReleaseConsentChallenge?.challengeId ?? '';
      const form = new FormData();
      form.set('saml_request_id', '_request');
      form.set('saml_sp_entity_id', SP_ENTITY);
      form.set('challenge_id', challengeId);
      form.set('attribute_set_hash', 'hash');
      form.set('decision', 'approve_once');
      mocks.sessionId = 's-2';
      const approved = await send(
        new Request('https://tenant.example.test/consent', {
          method: 'POST',
          body: form,
          headers: { Cookie: 'authrim_session=s-2' },
        })
      );
      expect(approved.status).toBe(302);
      expect(stepUpOf().completed).toEqual({ sessionId: 's-2', aal: 'AAL2' });
      mocks.consentError = null;
      const answered = await resume('s-2');
      expect(answered.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
    });
  });

  describe('ForceAuthn', () => {
    it('sends the person to sign in again, once, and answers when they come back', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml({ forceAuthn: true }), 's-1');
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('location') ?? '').searchParams.get('force_authn')).toBe(
        'true'
      );
      const issuedAt = reauthOf().issuedAt;
      expect(issuedAt).toEqual(expect.any(Number));

      // They sign in again: a new session proven after they were sent.
      setSession('s-2', { amr: ['pwd'], proven_at: issuedAt + 10 });
      const answered = await resume('s-2');
      expect(answered.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(mocks.requests.size).toBe(0);
    });

    it('does not send the person round again when they come back with a session that is not that sign-in', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml({ forceAuthn: true }), 's-1');
      // Back with the old session (the login page was skipped, or the session cannot be shown new).
      const response = await resume('s-1');
      expect(response.status).toBe(200);
      expect(mocks.requests.size).toBe(0);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({
        statusCode: STATUS_CODES.RESPONDER,
        secondLevelStatusCode: STATUS_CODES.AUTHN_FAILED,
      });
      expect(auditKinds()).toContain('authn_request_force_authn_unmet');
    });

    it('does not send a person who comes back with no session round again', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml({ forceAuthn: true }), 's-1');
      // The sign-in page was left, or the cookie was refused: they come back with no session.
      const response = await resume();
      expect(response.status).toBe(200);
      expect(mocks.requests.size).toBe(0);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.AUTHN_FAILED });
    });

    it('does not send a person who comes back from a step-up with no session round again', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      const response = await resume();
      expect(response.status).toBe(200);
      expect(mocks.requests.size).toBe(0);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.AUTHN_FAILED });
    });

    it('still sends a first request with no session to sign in, and answers when they come back', async () => {
      const first = await post(authnRequestXml());
      expect(first.status).toBe(302);
      setSession('s-1', { amr: ['pwd'], proven_at: Date.now() });
      const back = await resume('s-1');
      expect(back.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
    });

    it('also asks for the AAL the request needs after the sign-in it asked for', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml({ forceAuthn: true }), 's-1');
      const forceIssuedAt = reauthOf().issuedAt;

      // The sign-in it asked for is a password: ForceAuthn is met, AAL2 is not, so a step-up.
      setSession('s-2', { amr: ['pwd'], proven_at: forceIssuedAt + 10 });
      const stepUp = await resume('s-2');
      expect(stepUp.status).toBe(302);
      expect(reauthOf().issuedAt).toBe(forceIssuedAt);
      const stepUpIssuedAt = stepUpOf().issuedAt;
      expect(stepUpOf().priorSessionId).toBe('s-2');

      // The step-up adds the TOTP: AAL2, and ForceAuthn is still met by the newest session.
      setSession('s-3', { amr: ['totp'], proven_at: stepUpIssuedAt + 10 });
      const answered = await resume('s-3');
      expect(answered.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
    });
  });
  describe('the challenge the Login UI is given when the person is already signed in', () => {
    const challengeOf = (location: string) => {
      const id = new URL(location).searchParams.get('challenge_id');
      return id ? mocks.challenges.get(id) : undefined;
    };

    it('gives a step-up a reauth challenge bound to the request, the SP, the tenant and the person', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml(), 's-1');
      const location = response.headers.get('location') ?? '';

      const challenge = challengeOf(location);
      expect(challenge).toMatchObject({
        tenantId: 'tenant-a',
        type: 'reauth',
        userId: 'user-a',
        metadata: {
          protocol: 'saml',
          saml_request_id: '_request',
          saml_sp_entity_id: SP_ENTITY,
          tenant_id: 'tenant-a',
          sessionUserId: 'user-a',
        },
      });
      // The same instant as the step-up the stored request records, so that what the Login UI
      // accepts as the new sign-in is what the SSO endpoint counts.
      expect(challenge?.metadata.reauth_issued_at).toBe(stepUpOf().issuedAt);
      // It lasts as long as the stored request, and keeps the rest of the URL as it was.
      const stored = mocks.requests.get('_request') as { expiresAt: number };
      expect(challenge!.ttl * 1000).toBeGreaterThan(stored.expiresAt - Date.now() - 5_000);
      expect(challenge!.ttl * 1000).toBeLessThanOrEqual(stored.expiresAt - Date.now() + 5_000);
      const params = new URL(location).searchParams;
      expect(params.get('saml_request_id')).toBe('_request');
      expect(params.get('saml_sp_entity_id')).toBe(SP_ENTITY);
      expect(params.get('return_to')).toBe('saml_sso');
      expect(params.get('force_authn')).toBe('true');
      expect(params.get('required_aal')).toBe('AAL2');
      // No level is kept in the challenge.
      expect(JSON.stringify(challenge)).not.toMatch(/AAL|IAL/);
    });

    it('sends the person to the configured re-authentication path, and a person with no challenge to the sign-in page', async () => {
      mocks.ui = {
        baseUrl: 'https://ui.example.test',
        paths: { login: '/sign-in', reauth: '/prove' },
      } as never;
      mocks.sp = sp({ minimumAal: 'AAL2' });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const reauth = await post(authnRequestXml(), 's-1');
      expect(new URL(reauth.headers.get('location') ?? '').pathname).toBe('/prove');

      mocks.requests.clear();
      const signIn = await post(authnRequestXml());
      expect(new URL(signIn.headers.get('location') ?? '').pathname).toBe('/sign-in');
    });

    it('gives a ForceAuthn request of a signed-in person a reauth challenge for them', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO }, 'user-b');
      const response = await post(authnRequestXml({ forceAuthn: true }), 's-1');
      const challenge = challengeOf(response.headers.get('location') ?? '');
      expect(challenge).toMatchObject({
        type: 'reauth',
        userId: 'user-b',
        metadata: { protocol: 'saml', sessionUserId: 'user-b', saml_request_id: '_request' },
      });
      expect(challenge?.metadata.reauth_issued_at).toBe(reauthOf().issuedAt);
    });

    it('gives a second challenge, later than the first, to the step-up that follows a ForceAuthn sign-in', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const first = await post(authnRequestXml({ forceAuthn: true }), 's-1');
      const firstChallenge = challengeOf(first.headers.get('location') ?? '');
      setSession('s-2', { amr: ['pwd'], proven_at: reauthOf().issuedAt + 10 });
      const second = await resume('s-2');
      const secondChallenge = challengeOf(second.headers.get('location') ?? '');

      expect(secondChallenge?.id).not.toBe(firstChallenge?.id);
      expect(secondChallenge?.metadata.reauth_issued_at).toBe(stepUpOf().issuedAt);
      expect(secondChallenge?.metadata.reauth_issued_at as number).toBeGreaterThanOrEqual(
        firstChallenge?.metadata.reauth_issued_at as number
      );
    });

    it.each([
      ['a ForceAuthn request with no session', { forceAuthn: true }],
      ['an ordinary request with no session', {}],
    ])('gives %s no challenge: the person has to sign in anyway', async (_name, options) => {
      const response = await post(authnRequestXml(options));
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('location') ?? '').searchParams.has('challenge_id')).toBe(
        false
      );
      expect(mocks.challenges.size).toBe(0);
    });

    it('does not send the person when the challenge cannot be stored: the sign-in is not skipped', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
      mocks.challengeError = new Error('ChallengeStore unavailable');
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const response = await post(authnRequestXml(), 's-1');
      expect(response.headers.get('location')).toBeNull();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(mocks.buildResponse).not.toHaveBeenCalled();
    });

    it('answers when the person comes back from the Login UI with the session the sign-in updated', async () => {
      // The Login UI re-proved the same session: it records the new proof beside the first.
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml({ forceAuthn: true }), 's-1');
      const challenge = [...mocks.challenges.values()][0];
      const issuedAt = challenge?.metadata.reauth_issued_at as number;
      setSession('s-1', {
        amr: ['pwd', 'totp'],
        proven_at: LONG_AGO,
        reauth_proven_amr: ['totp'],
        reauth_proven_at: issuedAt + 25,
      });

      const answered = await resume('s-1');
      expect(answered.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(mocks.requests.size).toBe(0);
    });

    it('answers an AAL2 step-up completed by re-proving the same session, and keeps the password old', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const sent = await post(authnRequestXml(), 's-1');
      const challenge = challengeOf(sent.headers.get('location') ?? '');
      const issuedAt = challenge?.metadata.reauth_issued_at as number;
      // The sign-in proved a TOTP in the session itself, beside the password's old proof.
      setSession('s-1', {
        amr: ['pwd'],
        proven_at: LONG_AGO,
        reauth_proven_amr: ['totp'],
        reauth_proven_at: issuedAt + 25,
      });

      const answered = await resume('s-1');

      expect(answered.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      // The combination is recorded, but the password is not dated again.
      expect(sessionData('s-1')).toMatchObject({
        amr: ['pwd', 'totp'],
        proven_at: LONG_AGO,
        reauth_proven_at: issuedAt + 25,
      });
    });

    it('does not take a re-proof made before the step-up began for the step-up', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const sent = await post(authnRequestXml(), 's-1');
      const issuedAt = challengeOf(sent.headers.get('location') ?? '')?.metadata
        .reauth_issued_at as number;
      setSession('s-1', {
        amr: ['pwd', 'totp'],
        proven_at: LONG_AGO,
        reauth_proven_amr: ['totp'],
        reauth_proven_at: issuedAt - 1,
      });

      await resume('s-1');

      expect(mocks.buildResponse).not.toHaveBeenCalled();
      expect(lastError()).toMatchObject({ secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT });
    });

    it('answers a step-up that comes back from the Login UI with the combined evidence', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      const sent = await post(authnRequestXml(), 's-1');
      const challenge = challengeOf(sent.headers.get('location') ?? '');
      setSession('s-2', {
        amr: ['totp'],
        proven_at: (challenge?.metadata.reauth_issued_at as number) + 10,
      });
      const answered = await resume('s-2');
      expect(answered.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
    });
  });
  describe('AuthnInstant', () => {
    const MINUTE = 60_000;

    /** The person comes back `delayMs` later: the assertion is made then. */
    async function resumeLater(sessionId: string, delayMs: number) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + delayMs);
      try {
        return await resume(sessionId);
      } finally {
        vi.useRealTimers();
      }
    }

    it('is the time of a fresh sign-in, not later than the assertion it is in', async () => {
      const provenAt = Date.now() - 5 * MINUTE;
      setSession('s-1', { amr: ['pwd'], proven_at: provenAt });
      expect((await post(authnRequestXml(), 's-1')).status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(lastTiming().authnInstant).toBe(stated(provenAt));
      expect(Date.parse(lastTiming().authnInstant)).toBeLessThanOrEqual(
        Date.parse(lastTiming().issueInstant)
      );
    });

    it('stays the time of the sign-in when an old session is reused for single sign-on', async () => {
      const provenAt = Date.now() - 3 * 3_600_000;
      setSession('s-1', {
        amr: ['pwd'],
        proven_at: provenAt,
        authTime: Math.floor(provenAt / 1000),
      });
      expect((await post(authnRequestXml(), 's-1')).status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(lastTiming().authnInstant).toBe(stated(provenAt));
      expect(lastTiming().authnInstant).not.toBe(lastTiming().issueInstant);
    });

    it('is the re-authentication time of a session that was stepped up later', async () => {
      const provenAt = Date.now() - 3 * 3_600_000;
      const reauthAt = Date.now() - 2 * MINUTE;
      setSession('s-1', {
        amr: ['pwd', 'totp'],
        proven_at: provenAt,
        reauth_proven_amr: ['totp'],
        reauth_proven_at: reauthAt,
      });
      expect((await post(authnRequestXml(), 's-1')).status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(lastTiming().authnInstant).toBe(stated(reauthAt));
    });

    it('is the time of the step-up sign-in a person returns with (the combined session)', async () => {
      mocks.sp = sp({ minimumAal: 'AAL2' });
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml(), 's-1');
      const stepUpAt = stepUpOf().issuedAt + 10;
      setSession('s-2', { amr: ['totp'], proven_at: stepUpAt }, 'user-a', stepUpAt);
      // The assertion is made a few minutes after the person signed in.
      const response = await resumeLater('s-2', 3 * MINUTE);
      expect(response.status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(lastTiming().authnInstant).toBe(stated(stepUpAt));
      expect(lastTiming().authnInstant).not.toBe(lastTiming().issueInstant);
      expect(lastTiming().authnInstant).not.toBe(stated(LONG_AGO));
    });

    it('is the time of the sign-in a ForceAuthn request was sent to, not that of the old session', async () => {
      setSession('s-1', { amr: ['pwd'], proven_at: LONG_AGO });
      await post(authnRequestXml({ forceAuthn: true }), 's-1');
      const sentAt = reauthOf().issuedAt;
      const signedInAt = sentAt + 10;
      setSession('s-2', { amr: ['pwd'], proven_at: signedInAt });
      expect((await resumeLater('s-2', 3 * MINUTE)).status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      expect(lastTiming().authnInstant).toBe(stated(signedInAt));
      // What the SP compares it with: not before the request it sent.
      expect(Date.parse(lastTiming().authnInstant)).toBeGreaterThanOrEqual(
        Math.floor(sentAt / 1000) * 1000
      );
      expect(lastTiming().authnInstant).not.toBe(lastTiming().issueInstant);
      expect(lastTiming().authnInstant).not.toBe(stated(LONG_AGO));
    });

    /** A plain request answered from the session: one new assertion, whose timing is returned. */
    async function answeredTiming(sessionId: string) {
      mocks.buildResponse.mockClear();
      expect((await post(authnRequestXml(), sessionId)).status).toBe(200);
      expect(mocks.buildResponse).toHaveBeenCalledOnce();
      return lastTiming();
    }

    it('falls back to the session login time, then the creation time of the session', async () => {
      const authTime = Math.floor((Date.now() - 90 * MINUTE) / 1000);
      setSession('s-1', { amr: ['pwd'], authTime });
      expect((await answeredTiming('s-1')).authnInstant).toBe(stated(authTime * 1000));

      const createdAt = Date.now() - 45 * MINUTE;
      setSession('s-2', { amr: ['external_idp'] }, 'user-a', createdAt);
      expect((await answeredTiming('s-2')).authnInstant).toBe(stated(createdAt));
    });

    it('is the issue instant when the session says nothing, and is never later than it', async () => {
      setSession('s-1', { amr: ['external_idp'] });
      const nothing = await answeredTiming('s-1');
      expect(nothing.authnInstant).toBe(nothing.issueInstant);

      // A time far ahead of this clock is not believed.
      setSession('s-2', { amr: ['pwd'], proven_at: Date.now() + 3_600_000 });
      const future = await answeredTiming('s-2');
      expect(future.authnInstant).toBe(future.issueInstant);
    });
  });
});
