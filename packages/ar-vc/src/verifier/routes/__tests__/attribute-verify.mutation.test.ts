/**
 * Attribute verification: access token rules, evidence policy arithmetic, source value lookup,
 * flow step authorization and the wallet request URL, with fakes at every boundary.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return {
    logger,
    protectedContext: vi.fn(),
    introspect: vi.fn(),
    accountUserId: vi.fn(),
    adminQueryOne: vi.fn(),
    coreQueryOne: vi.fn(),
    resolveMapping: vi.fn(),
    snapshotMatches: vi.fn(),
    executeMapping: vi.fn(),
    executeServerFlow: vi.fn(),
    getStoreById: vi.fn(),
    getNewStore: vi.fn(),
    isConfiguredShard: vi.fn(),
    verify: vi.fn(),
    link: vi.fn(),
    getAttributes: vi.fn(),
    sha: vi.fn(),
    invalidateStale: vi.fn(),
    invalidateUntrusted: vi.fn(),
    findByUser: vi.fn(),
    invalidateVerification: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getLogger: () => h.logger,
    createLogger: () => h.logger,
    getTenantIdFromContext: () => 'tenant-1',
    getActiveAccessTokenProtectedResourceContext: h.protectedContext,
    introspectTokenFromContext: h.introspect,
    introspectedTokenClient: async () => ({}),
    resolveIntrospectedAccountUserId: h.accountUserId,
    requireDedicatedAdminDatabaseAdapter: () => ({ queryOne: h.adminQueryOne }),
    resolveAuthCorePersistenceAdapterFromEnv: async () => ({ queryOne: h.coreQueryOne }),
    resolveRuntimeIdentityMappingBinding: h.resolveMapping,
    executeServerFlow: h.executeServerFlow,
    AttributeVerificationRepository: class {
      invalidateStaleForUser = h.invalidateStale;
      invalidateUntrustedForUser = h.invalidateUntrusted;
      findByUser = h.findByUser;
      invalidateVerification = h.invalidateVerification;
    },
    UserVerifiedAttributeRepository: class {},
  };
});
vi.mock('@authrim/ar-lib-core/services/mapping-hash', () => ({
  executeTenantMapping: h.executeMapping,
}));
vi.mock('@authrim/ar-lib-core/services/mapping-snapshot-equivalence', () => ({
  runtimeMappingSnapshotMatches: h.snapshotMatches,
}));
vi.mock('../../../utils/vp-request-sharding', () => ({
  getVPRequestStoreById: h.getStoreById,
  getVPRequestStoreForNewRequest: h.getNewStore,
}));
vi.mock('../../../utils/configured-shard', () => ({ isConfiguredShard: h.isConfiguredShard }));
vi.mock('../../services/vp-verifier', () => ({ verifyVPToken: h.verify }));
vi.mock('../../services/attribute-mapper', () => ({
  linkVerificationToUser: h.link,
  getUserVerifiedAttributes: h.getAttributes,
}));
vi.mock('../../../utils/crypto', () => ({ sha256Base64url: h.sha }));
vi.mock('../../../request-identifiers', () => ({
  getRequestIssuerUrl: () => 'https://verifier.example.com',
  getRequestVerifierIdentifier: () => 'verifier-id',
}));

import { attributeVerifyResponse } from '../attribute-verify';

const NOW_MS = 1_800_000_000_000;
const SECRET = 'e'.repeat(32);
const REQUEST_ID = 'g1:apac:1:vp_1';
const AUDIENCE = 'svc://op-vc/attribute-elevation';
let env: Record<string, unknown>;
let stub: { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>> };

const answer = (body: unknown) => new Response(JSON.stringify(body));
const stored = {
  id: REQUEST_ID,
  clientId: 'verifier-id',
  tenantId: 'tenant-1',
  nonce: 'n-1',
  userId: 'user-1',
  credentialProfileId: 'profile-1',
  credentialProfileVersionId: 'profile-v1',
  verificationFlowVersionId: 'flow-v1',
  verificationMappingVersionId: 'map-v1',
  verificationMappingSnapshotHash: 'hash-1',
  maximumAttributeAgeSeconds: 600,
};
let storedRequest: Record<string, unknown>;

interface Edge {
  sourceRef: { side: string; namespace: string; path: string };
}
const src = (path: string, namespace = 'vc'): Edge => ({
  sourceRef: { side: 'source', namespace, path },
});
const dst = (path: string, namespace = 'authrim.verified_attribute') => ({
  sourceRef: { side: 'destination', namespace, path },
});
let binding: Record<string, unknown>;
let verification: Record<string, unknown>;
let flowRefs: { presentation: unknown; attribute: unknown };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
  vi.resetAllMocks();
  h.logger.module.mockReturnValue(h.logger);
  env = { VC_EVIDENCE_HMAC_SECRET: SECRET, HAIP_POLICY_VERSION: 'final-1.0' };
  stub = { fetch: vi.fn<(request: Request) => Promise<unknown>>() };
  storedRequest = { ...stored };
  stub.fetch.mockImplementation(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/reserve')
      return answer({ reserved: true, reservationId: 'res-1', request: storedRequest });
    if (path === '/complete') return answer({ completed: true });
    return answer({});
  });
  h.getStoreById.mockReturnValue({ stub, resolution: 'r' });
  h.isConfiguredShard.mockResolvedValue(true);
  h.sha.mockResolvedValue('fp');
  h.protectedContext.mockReturnValue({
    subject: 'user-1',
    tenantId: 'tenant-1',
    claims: { sub: 'user-1' },
  });
  h.introspect.mockResolvedValue({
    valid: true,
    claims: { tenant_id: 'tenant-1', aud: AUDIENCE, scope: 'vc.attribute', sub: 'user-1' },
  });
  h.accountUserId.mockReturnValue('user-1');
  verification = {
    verified: true,
    issuerDid: 'did:web:issuer.example',
    credentialType: 'vct-1',
    disclosedClaims: { age: 20 },
    haipCompliant: true,
    errors: [],
    warnings: [],
  };
  h.verify.mockResolvedValue(verification);
  binding = {
    edges: [src('age')],
    catalog: {
      entries: [
        { namespace: 'authrim.verified_attribute', path: 'age_ok', allowedValues: ['yes'] },
      ],
    },
    graphRules: 'rules',
    transforms: 'transforms',
    validationRules: 'validation',
    fieldMappingSet: 'set',
    destinationNamespace: undefined,
  };
  h.resolveMapping.mockResolvedValue(binding);
  h.snapshotMatches.mockReturnValue(true);
  h.executeMapping.mockResolvedValue({ status: 'ok', values: [{ ...dst('age_ok'), value: true }] });
  h.coreQueryOne.mockResolvedValue({ runtime_snapshot_json: '{}' });
  flowRefs = { presentation: 'profile-1', attribute: 'profile-1' };
  h.executeServerFlow.mockImplementation(
    async (input: {
      handlers: Record<string, (a: unknown) => Promise<unknown>>;
      state: unknown;
    }) => {
      await input.handlers.credential_presentation({
        step: { config: { credential_profile_ref: flowRefs.presentation } },
        state: input.state,
      });
      await input.handlers.verified_attribute({
        step: { config: { credential_profile_ref: flowRefs.attribute } },
        state: input.state,
      });
    }
  );
  h.link.mockResolvedValue({ success: true, attributes: [{ name: 'age_ok' }] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function respond(body: Record<string, unknown> = { vp_token: 'a.b.c', state: REQUEST_ID }) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/r', attributeVerifyResponse);
  const response = await app.request(
    'https://verifier.example.com/r',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env as unknown as Env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
const policyOf = () => h.link.mock.calls[0][5] as Record<string, unknown>;
const loggedErrors = () =>
  h.logger.error.mock.calls.map((call) => (call[2] as Error | undefined)?.message);

describe('evidence policy', () => {
  it('hands the mapped attributes and exact evidence to the repository', async () => {
    verification.credentialExpiresAt = NOW_MS + 100_000;
    verification.statusCheckedAt = NOW_MS - 1000;
    verification.statusFreshUntil = NOW_MS + 50_000;
    const result = await respond();
    expect(result).toEqual({
      status: 200,
      body: {
        success: true,
        request_id: REQUEST_ID,
        attributes_verified: ['age_ok'],
        haip_compliant: true,
      },
    });
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const evidence = JSON.stringify({
      tenantId: 'tenant-1',
      requestId: REQUEST_ID,
      issuerDid: 'did:web:issuer.example',
      credentialType: 'vct-1',
      attributes: [['age_ok', 'true']],
    });
    const mac = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(evidence))
    );
    const fingerprint = btoa(String.fromCharCode(...mac))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(policyOf()).toEqual({
      attributes: [{ name: 'age_ok', value: 'true', originalClaim: 'age_ok' }],
      expiresAt: NOW_MS + 100_000,
      revalidateAfter: NOW_MS + 50_000,
      credentialProfileId: 'profile-1',
      credentialProfileVersionId: 'profile-v1',
      mappingVersionId: 'map-v1',
      mappingSnapshotHash: 'hash-1',
      policyVersion: 'final-1.0',
      evidenceFingerprint: fingerprint,
      statusCheckedAt: NOW_MS - 1000,
      statusFreshUntil: NOW_MS + 50_000,
    });
  });

  it('caps the expiry at the profile age and revalidates at the status freshness', async () => {
    verification.credentialExpiresAt = NOW_MS + 9_999_000;
    verification.statusFreshUntil = NOW_MS + 700_000;
    await respond();
    expect(policyOf()).toMatchObject({
      expiresAt: NOW_MS + 600_000,
      revalidateAfter: NOW_MS + 600_000,
      statusCheckedAt: NOW_MS,
      statusFreshUntil: NOW_MS + 700_000,
    });
  });

  it('treats a status without freshness information as not fresh, and the profile age as the expiry', async () => {
    expect((await respond()).status).toBe(500);
    expect(loggedErrors()).toContain('vp_evidence_not_fresh');
    verification.statusFreshUntil = NOW_MS + 10_000;
    expect((await respond()).status).toBe(200);
    expect(policyOf()).toMatchObject({
      expiresAt: NOW_MS + 600_000,
      revalidateAfter: NOW_MS + 10_000,
    });
  });

  it.each([
    ['a status that is fresh only until now', { statusFreshUntil: NOW_MS }],
    [
      'a credential that expires now',
      { credentialExpiresAt: NOW_MS, statusFreshUntil: NOW_MS + 5000 },
    ],
    [
      'a credential that expired',
      { credentialExpiresAt: NOW_MS - 1, statusFreshUntil: NOW_MS + 5000 },
    ],
  ])('refuses %s as not fresh', async (_name, overrides) => {
    Object.assign(verification, overrides);
    expect(await respond()).toMatchObject({ status: 500, body: { error: 'server_error' } });
    expect(loggedErrors()).toContain('vp_evidence_not_fresh');
    expect(h.link).not.toHaveBeenCalled();
  });

  it('accepts evidence that is fresh by a millisecond', async () => {
    Object.assign(verification, { credentialExpiresAt: NOW_MS + 1, statusFreshUntil: NOW_MS + 1 });
    expect((await respond()).status).toBe(200);
    expect(policyOf()).toMatchObject({ expiresAt: NOW_MS + 1, revalidateAfter: NOW_MS + 1 });
  });

  it('needs a signing secret of at least 32 characters', async () => {
    verification.statusFreshUntil = NOW_MS + 5000;
    for (const secret of [undefined, '', 'e'.repeat(31)]) {
      env.VC_EVIDENCE_HMAC_SECRET = secret;
      expect((await respond()).status).toBe(500);
    }
    expect(loggedErrors()).toEqual(Array(3).fill('vc_evidence_hmac_secret_missing'));
    env.VC_EVIDENCE_HMAC_SECRET = 'e'.repeat(32);
    expect((await respond()).status).toBe(200);
  });

  it('requires the profile evidence the request was pinned with', async () => {
    for (const field of [
      'credentialProfileId',
      'credentialProfileVersionId',
      'verificationMappingVersionId',
      'verificationMappingSnapshotHash',
      'maximumAttributeAgeSeconds',
    ]) {
      storedRequest = { ...stored, [field]: field === 'maximumAttributeAgeSeconds' ? 0 : '' };
      h.logger.error.mockClear();
      expect((await respond()).status).toBe(500);
      expect(loggedErrors()).toContain(
        field === 'credentialProfileId'
          ? 'vp_verification_flow_missing'
          : 'vp_profile_evidence_missing'
      );
    }
  });

  it('refuses a mapping that is gone or changed', async () => {
    h.resolveMapping.mockResolvedValue(null);
    expect((await respond()).status).toBe(500);
    expect(loggedErrors()).toEqual(['vp_mapping_snapshot_unavailable']);
    h.logger.error.mockClear();
    h.resolveMapping.mockResolvedValue(binding);
    h.snapshotMatches.mockReturnValue(false);
    expect((await respond()).status).toBe(500);
    expect(loggedErrors()).toEqual(['vp_mapping_snapshot_unavailable']);
    expect(h.snapshotMatches).toHaveBeenCalledWith(binding, 'hash-1');
  });
});

describe('source values and mapped attributes', () => {
  const run = async (claims: Record<string, unknown>, edges: Edge[], values: unknown[] = []) => {
    verification.disclosedClaims = claims;
    verification.statusFreshUntil = NOW_MS + 5000;
    binding.edges = edges;
    h.executeMapping.mockResolvedValue({
      status: 'ok',
      values: [...values, { ...dst('age_ok'), value: true }],
    });
    const result = await respond();
    return { result, input: h.executeMapping.mock.calls[0]?.[2] as { sourceValues: unknown[] } };
  };

  it('reads a claim by its full path, its last segment, or through nested objects', async () => {
    const { input, result } = await run(
      { 'a.b': 1, c: 2, x: { y: { z: 3 } }, w: 'not-an-object', n: { m: null } },
      [src('a.b'), src('p.c'), src('x.y.z'), src('w.q'), src('n.m'), src('missing')]
    );
    expect(result.status).toBe(200);
    expect(input.sourceValues).toEqual([
      { value: 1, sourceRef: src('a.b').sourceRef },
      { value: 2, sourceRef: src('p.c').sourceRef },
      { value: 3, sourceRef: src('x.y.z').sourceRef },
    ]);
  });

  it('passes a single-segment path only through the direct lookup', async () => {
    const { input } = await run({ other: { age: 5 } }, [src('age')]);
    expect(input.sourceValues).toEqual([]);
  });

  it('lets a null claim count as missing and a false claim as present', async () => {
    const { input } = await run({ a: null, b: false, 0: 0 }, [src('a'), src('b')]);
    expect(input.sourceValues).toEqual([{ value: false, sourceRef: src('b').sourceRef }]);
  });

  it('considers each source reference once and only source-side edges', async () => {
    const { input } = await run({ a: 1 }, [
      src('a'),
      src('a'),
      { sourceRef: { side: 'destination', namespace: 'vc', path: 'a' } },
    ]);
    expect(input.sourceValues).toHaveLength(1);
  });

  it('runs the mapping for the tenant with the whole binding', async () => {
    await run({ age: 20 }, [src('age')]);
    expect(h.executeMapping).toHaveBeenCalledWith(env, 'tenant-1', {
      catalog: binding.catalog,
      graphRules: 'rules',
      sourceValues: [{ value: 20, sourceRef: src('age').sourceRef }],
      edges: binding.edges,
      transforms: 'transforms',
      validationRules: 'validation',
      fieldMappingSet: 'set',
    });
  });

  it('refuses a failed mapping and a mapping with no policy-ready attribute', async () => {
    h.executeMapping.mockResolvedValue({ status: 'failed', values: [] });
    expect((await respond()).status).toBe(500);
    h.executeMapping.mockResolvedValue({ status: 'ok', values: [] });
    expect((await respond()).status).toBe(500);
    expect(loggedErrors()).toEqual([
      'vp_attribute_mapping_failed',
      'vp_no_policy_ready_attributes',
    ]);
  });

  it('keeps booleans and catalog-listed short strings, in the destination namespace only', async () => {
    verification.statusFreshUntil = NOW_MS + 5000;
    const long = 'x'.repeat(128);
    binding.catalog = {
      entries: [
        {
          namespace: 'authrim.verified_attribute',
          path: 'tier',
          allowedValues: ['gold', long, 'y'.repeat(129)],
        },
        { namespace: 'authrim.verified_attribute', path: 'free' },
      ],
    };
    h.executeMapping.mockResolvedValue({
      status: 'ok',
      values: [
        { ...dst('zeta'), value: false },
        { ...dst('tier'), value: 'gold' },
        { ...dst('tier'), value: long },
        { ...dst('tier'), value: 'y'.repeat(129) },
        { ...dst('tier'), value: 'silver' },
        { ...dst('free'), value: 'anything' },
        { ...dst('alpha', 'other.namespace'), value: true },
        { ...src('alpha'), value: true },
        { ...dst('num'), value: 5 },
      ],
    });
    await respond();
    expect(
      (policyOf().attributes as Array<{ name: string; value: string }>).map((a) => [
        a.name,
        a.value,
      ])
    ).toEqual([
      ['zeta', 'false'],
      ['tier', 'gold'],
      ['tier', long],
    ]);
  });

  it('honours a destination namespace of the binding', async () => {
    verification.statusFreshUntil = NOW_MS + 5000;
    binding.destinationNamespace = 'custom.ns';
    h.executeMapping.mockResolvedValue({
      status: 'ok',
      values: [
        { ...dst('a', 'custom.ns'), value: true },
        { ...dst('b'), value: true },
      ],
    });
    await respond();
    expect((policyOf().attributes as Array<{ name: string }>).map((a) => a.name)).toEqual(['a']);
  });

  it('sorts the attributes in the evidence so their order does not change the fingerprint', async () => {
    verification.statusFreshUntil = NOW_MS + 5000;
    const values = [
      { ...dst('b'), value: true },
      { ...dst('a'), value: true },
    ];
    h.executeMapping.mockResolvedValue({ status: 'ok', values });
    await respond();
    const first = policyOf().evidenceFingerprint;
    h.link.mockClear();
    h.executeMapping.mockResolvedValue({ status: 'ok', values: [...values].reverse() });
    await respond();
    expect(policyOf().evidenceFingerprint).toBe(first);
  });
});

describe('flow steps and request ownership', () => {
  it.each([
    ['an id string', 'profile-1', 200],
    ['an object with the id', { id: 'profile-1' }, 200],
    ['an object with another id', { id: 'other' }, 500],
    ['another string', 'other', 500],
    ['null', null, 500],
    ['a number', 7, 500],
  ])('lets the presentation step name its profile as %s', async (_name, ref, status) => {
    verification.statusFreshUntil = NOW_MS + 5000;
    flowRefs.presentation = ref;
    const result = await respond();
    expect(result.status).toBe(status);
    if (status === 500) expect(loggedErrors()).toContain('vp_presentation_step_rejected');
  });

  it('lets the attribute step name its profile in the same ways', async () => {
    verification.statusFreshUntil = NOW_MS + 5000;
    flowRefs.attribute = { id: 'profile-1' };
    expect((await respond()).status).toBe(200);
    for (const ref of [null, 'other']) {
      h.logger.error.mockClear();
      flowRefs.attribute = ref;
      expect((await respond()).status).toBe(500);
      expect(loggedErrors()).toEqual(['vp_attribute_commit_step_rejected']);
    }
  });

  it('commits the attribute only after the presentation step verified', async () => {
    verification.statusFreshUntil = NOW_MS + 5000;
    h.executeServerFlow.mockImplementation(
      async (input: {
        handlers: Record<string, (a: unknown) => Promise<unknown>>;
        state: unknown;
      }) => {
        await input.handlers.verified_attribute({
          step: { config: { credential_profile_ref: 'profile-1' } },
          state: input.state,
        });
      }
    );
    expect((await respond()).status).toBe(500);
    expect(loggedErrors()).toContain('vp_attribute_commit_step_rejected');
  });

  it('fails when the repository reports the commit as unsuccessful', async () => {
    verification.statusFreshUntil = NOW_MS + 5000;
    h.link.mockResolvedValue({ success: false, attributes: [] });
    expect((await respond()).status).toBe(500);
    expect(loggedErrors()).toContain('vp_attribute_commit_failed');
  });

  it('refuses a request of another user and one without a user, releasing the reservation', async () => {
    storedRequest = { ...stored, userId: 'other-user' };
    expect(await respond()).toMatchObject({
      status: 403,
      body: { error: 'invalid_token', error_description: 'Subject mismatch' },
    });
    storedRequest = { ...stored, tenantId: 'tenant-2' };
    expect((await respond()).status).toBe(403);
    storedRequest = { ...stored, userId: undefined };
    expect(await respond()).toMatchObject({
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: 'This endpoint is for authenticated users only',
      },
    });
    const releases = stub.fetch.mock.calls.filter(
      (call) => new URL((call[0] as Request).url).pathname === '/release'
    );
    expect(releases).toHaveLength(3);
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('answers 400 with the exact body when the request cannot be reserved', async () => {
    stub.fetch.mockResolvedValue(answer({ reserved: false }));
    expect(await respond()).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'VP request unavailable' },
    });
    h.isConfiguredShard.mockResolvedValue(false);
    expect(await respond()).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'VP request unavailable' },
    });
  });
});
