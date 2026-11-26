/**
 * Attribute verification reads and initiation: exact bodies, adapter names and queries.
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
    coreAdapterArgs: vi.fn(),
    adminAdapterArgs: vi.fn(),
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
    requireDedicatedAdminDatabaseAdapter: (...args: unknown[]) => {
      h.adminAdapterArgs(...args);
      return { queryOne: h.adminQueryOne };
    },
    resolveAuthCorePersistenceAdapterFromEnv: async (...args: unknown[]) => {
      h.coreAdapterArgs(...args);
      return { queryOne: h.coreQueryOne };
    },
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

import { getAttributes, initiateAttributeVerification } from '../attribute-verify';

const NOW_MS = 1_800_000_000_000;
const SECRET = 'e'.repeat(32);
const REQUEST_ID = 'g1:apac:1:vp_1';
const AUDIENCE = 'svc://op-vc/attribute-elevation';
let env: Record<string, unknown>;
let stub: { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>> };

const answer = (body: unknown, ok = true) =>
  new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
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
    if (path === '/fail') return answer({ failed: true });
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

describe('reads', () => {
  async function read(headers: Record<string, string> = { Authorization: 'Bearer t' }) {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/a', getAttributes);
    const response = await app.request(
      'https://verifier.example.com/a',
      { headers },
      env as unknown as Env
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  const verificationRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'v1',
    invalidated_at: null,
    credential_profile_id: 'profile-1',
    mapping_version_id: 'map-v1',
    mapping_snapshot_hash: 'hash-1',
    ...overrides,
  });

  beforeEach(() => {
    h.findByUser.mockResolvedValue({ items: [] });
    h.getAttributes.mockResolvedValue({ age_ok: 'true' });
    h.invalidateStale.mockResolvedValue(undefined);
    h.invalidateUntrusted.mockResolvedValue(undefined);
  });

  it('names its logger module and refuses a missing or invalid token with exact bodies', async () => {
    expect(await read({})).toEqual({
      status: 401,
      body: { error: 'invalid_token', error_description: 'Missing access token' },
    });
    expect(await read({ Authorization: 'Basic abc' })).toMatchObject({ status: 401 });
    h.protectedContext.mockReturnValue(null);
    h.introspect.mockResolvedValue({ valid: false });
    expect(await read()).toEqual({
      status: 401,
      body: { error: 'invalid_token', error_description: 'Invalid access token' },
    });
    expect(h.logger.module).toHaveBeenCalledWith('VC-VERIFIER');
  });

  it('invalidates stale and untrusted evidence now, then lists the first hundred verifications', async () => {
    await read();
    expect(h.coreAdapterArgs).toHaveBeenCalledWith(env, 'vc-verifier-core', {
      tenantId: 'tenant-1',
    });
    expect(h.invalidateStale).toHaveBeenCalledWith('tenant-1', 'user-1', NOW_MS);
    expect(h.invalidateUntrusted).toHaveBeenCalledWith('tenant-1', 'user-1', NOW_MS);
    expect(h.findByUser).toHaveBeenCalledWith('tenant-1', 'user-1', { limit: 100 });
    expect(h.getAttributes).toHaveBeenCalledWith(expect.anything(), 'user-1', 'tenant-1');
  });

  it('keeps evidence whose mapping still matches and invalidates the rest, skipping what is done', async () => {
    h.findByUser.mockResolvedValue({
      items: [
        verificationRow({ id: 'kept' }),
        verificationRow({ id: 'changed', mapping_snapshot_hash: 'old' }),
        verificationRow({ id: 'gone', credential_profile_id: 'profile-2' }),
        verificationRow({ id: 'done', invalidated_at: 5 }),
        verificationRow({ id: 'no-profile', credential_profile_id: null }),
        verificationRow({ id: 'no-mapping', mapping_version_id: '' }),
        verificationRow({ id: 'no-hash', mapping_snapshot_hash: null }),
      ],
    });
    h.resolveMapping.mockImplementation(
      async (_adapter: unknown, query: { credentialProfileId: string }) =>
        query.credentialProfileId === 'profile-2' ? null : { edges: [] }
    );
    h.snapshotMatches.mockImplementation((_binding: unknown, hash: string) => hash === 'hash-1');
    await read();
    expect(h.adminAdapterArgs).toHaveBeenCalledWith(env, 'vc-attribute-revalidation');
    expect(h.resolveMapping).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-1',
      protocol: 'vc',
      role: 'verifier',
      direction: 'verification',
      credentialProfileId: 'profile-1',
      fieldMappingVersionId: 'map-v1',
    });
    expect(h.invalidateVerification.mock.calls).toEqual([
      ['tenant-1', 'changed', 'mapping_policy_changed'],
      ['tenant-1', 'gone', 'mapping_policy_changed'],
    ]);
  });

  it('invalidates evidence whose mapping lookup fails', async () => {
    h.findByUser.mockResolvedValue({ items: [verificationRow()] });
    h.resolveMapping.mockRejectedValue(new Error('db'));
    expect((await read()).status).toBe(200);
    expect(h.invalidateVerification).toHaveBeenCalledWith(
      'tenant-1',
      'v1',
      'mapping_policy_changed'
    );
  });

  it('answers a generic server error when evidence storage fails', async () => {
    h.findByUser.mockRejectedValue(new Error('db detail'));
    expect(await read()).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Internal server error' },
    });
  });
});

describe('initiation', () => {
  const profileRow = {
    profile_id: 'profile-1',
    version_id: 'profile-v1',
    verification_flow_version_id: 'flow-v1',
    credential_configuration_id: 'cfg-1',
    verification_mapping_set_id: 'set-1',
    verification_mapping_version_id: 'map-v1',
    verification_mapping_snapshot_hash: 'hash-1',
    claim_allowlist_json: '["age","country"]',
    maximum_attribute_age_seconds: 600,
  };
  async function initiate(
    body: unknown = { credential_profile_id: 'profile-1' },
    headers: Record<string, string> = { Authorization: 'Bearer t' }
  ) {
    h.adminQueryOne.mockResolvedValue(profileRow);
    h.coreQueryOne.mockResolvedValue({ vct: 'vct-cfg', is_active: 1 });
    h.getNewStore.mockResolvedValue({ stub, requestId: REQUEST_ID });
    stub.fetch.mockResolvedValue(answer({}));
    const app = new Hono<{ Bindings: Env }>();
    app.post('/i', initiateAttributeVerification);
    const response = await app.request(
      'https://verifier.example.com/i',
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env as unknown as Env
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  const described = (error: string, error_description: string) => ({ error, error_description });

  beforeEach(() => {
    h.protectedContext.mockReturnValue(null);
  });

  it('names its logger module and refuses a missing or invalid token', async () => {
    expect(await initiate(undefined, {})).toEqual({
      status: 401,
      body: described('invalid_token', 'Missing access token'),
    });
    expect(await initiate(undefined, { Authorization: 'Basic abc' })).toMatchObject({
      status: 401,
    });
    h.introspect.mockResolvedValue({ valid: false });
    expect(await initiate()).toEqual({
      status: 401,
      body: described('invalid_token', 'Invalid access token'),
    });
    expect(h.logger.module).toHaveBeenCalledWith('VC-VERIFIER');
  });

  it('refuses a missing or unpublished profile, an inactive configuration and an unavailable mapping', async () => {
    expect(await initiate({})).toEqual({
      status: 400,
      body: described('invalid_request', 'credential_profile_id is required'),
    });
    h.adminQueryOne.mockResolvedValue(null);
    const app = new Hono<{ Bindings: Env }>();
    app.post('/i', initiateAttributeVerification);
    const run = async () =>
      (
        await app.request(
          'https://verifier.example.com/i',
          {
            method: 'POST',
            headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential_profile_id: 'p' }),
          },
          env as unknown as Env
        )
      ).json();
    expect(await run()).toEqual(
      described('invalid_request', 'Published verification profile not found')
    );
    h.adminQueryOne.mockResolvedValue(profileRow);
    h.coreQueryOne.mockResolvedValue({ vct: 'v', is_active: 0 });
    expect(await run()).toEqual(
      described('invalid_request', 'Credential configuration is inactive')
    );
    h.coreQueryOne.mockResolvedValue(null);
    expect(await run()).toEqual(
      described('invalid_request', 'Credential configuration is inactive')
    );
    h.coreQueryOne.mockResolvedValue({ vct: 'v', is_active: 1 });
    h.resolveMapping.mockResolvedValue(null);
    expect(await run()).toEqual(
      described('invalid_request', 'Verification mapping is unavailable')
    );
    h.resolveMapping.mockResolvedValue({ edges: [] });
    h.snapshotMatches.mockReturnValue(false);
    expect(await run()).toEqual(
      described('invalid_request', 'Verification mapping is unavailable')
    );
  });

  it('reads the published profile, the active configuration and the mapping with exact arguments', async () => {
    await initiate();
    expect(h.adminQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM credential_profiles'),
      ['tenant-1', 'profile-1']
    );
    expect(h.adminAdapterArgs).toHaveBeenCalledWith(env, 'vc-attribute-profile');
    expect(h.coreAdapterArgs).toHaveBeenCalledWith(env, 'vc-attribute-profile-core', {
      tenantId: 'tenant-1',
    });
    expect(h.coreQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM credential_configurations'),
      ['tenant-1', 'cfg-1']
    );
    expect(h.resolveMapping).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-1',
      protocol: 'vc',
      role: 'verifier',
      direction: 'verification',
      credentialProfileId: 'profile-1',
      credentialConfigurationId: 'cfg-1',
      fieldMappingSetId: 'set-1',
      fieldMappingVersionId: 'map-v1',
    });
    expect(h.snapshotMatches).toHaveBeenCalledWith(expect.anything(), 'hash-1');
  });

  it('stores the request with the profile evidence, as JSON, and builds the presentation definition', async () => {
    const result = await initiate();
    expect(result.status).toBe(200);
    const request = stub.fetch.mock.calls[0][0] as Request;
    expect(request.headers.get('Content-Type')).toBe('application/json');
    const created = (await request.json()) as Record<string, unknown>;
    expect(created).toMatchObject({
      id: REQUEST_ID,
      clientId: 'verifier-id',
      tenantId: 'tenant-1',
      status: 'pending',
      responseUri: 'https://verifier.example.com/vp/attribute-response',
      responseMode: 'direct_post',
      createdAt: NOW_MS,
      expiresAt: NOW_MS + 300_000,
      userId: 'user-1',
      credentialProfileId: 'profile-1',
      credentialProfileVersionId: 'profile-v1',
      verificationFlowVersionId: 'flow-v1',
      verificationMappingVersionId: 'map-v1',
      verificationMappingSnapshotHash: 'hash-1',
      maximumAttributeAgeSeconds: 600,
    });
    expect(created.presentationDefinition).toEqual({
      id: `pd-vct-cfg-${NOW_MS}`,
      input_descriptors: [
        {
          id: 'id-vct-cfg',
          format: { 'dc+sd-jwt': { alg: ['ES256', 'ES384', 'ES512'] } },
          constraints: {
            fields: [
              { path: ['$.vct'], filter: { type: 'string', enum: ['vct-cfg'] } },
              { path: ['$.age'], intent_to_retain: false },
              { path: ['$.country'], intent_to_retain: false },
            ],
          },
        },
      ],
    });
  });

  it('answers 500 when the request cannot be stored, and hides other failures', async () => {
    h.adminQueryOne.mockResolvedValue(profileRow);
    h.coreQueryOne.mockResolvedValue({ vct: 'v', is_active: 1 });
    h.getNewStore.mockResolvedValue({ stub, requestId: REQUEST_ID });
    stub.fetch.mockResolvedValue(answer({}, false));
    const app = new Hono<{ Bindings: Env }>();
    app.post('/i', initiateAttributeVerification);
    const run = async () =>
      (
        await app.request(
          'https://verifier.example.com/i',
          {
            method: 'POST',
            headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential_profile_id: 'p' }),
          },
          env as unknown as Env
        )
      ).json();
    expect(await run()).toEqual(described('server_error', 'Failed to create request'));
    h.adminQueryOne.mockRejectedValue(new Error('db detail'));
    expect(await run()).toEqual(described('server_error', 'Internal server error'));
  });

  it('inlines a definition up to 2047 characters and refers to it from 2048', async () => {
    // Claim names stay within the 128 character admin limit: whole claims of 100 characters
    // plus one claim whose length grows by a character per step.
    const claimsFor = (step: number) => [
      ...Array.from({ length: Math.floor(step / 100) }, (_, index) =>
        String(index).padStart(3, '0').padEnd(100, 'x')
      ),
      'z'.repeat((step % 100) + 1),
    ];
    let lastInline = 0;
    let switched = false;
    for (let step = 0; step < 4000 && !switched; step += 1) {
      h.adminQueryOne.mockResolvedValue({
        ...profileRow,
        claim_allowlist_json: JSON.stringify(claimsFor(step)),
      });
      h.coreQueryOne.mockResolvedValue({ vct: 'vct-cfg', is_active: 1 });
      h.getNewStore.mockResolvedValue({ stub, requestId: REQUEST_ID });
      stub.fetch.mockResolvedValue(answer({}));
      const app = new Hono<{ Bindings: Env }>();
      app.post('/i', initiateAttributeVerification);
      const response = await app.request(
        'https://verifier.example.com/i',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential_profile_id: 'p' }),
        },
        env as unknown as Env
      );
      const url = new URL(
        ((await response.json()) as { authorization_request: string }).authorization_request
      );
      const inline = url.searchParams.get('presentation_definition');
      if (inline !== null) lastInline = inline.length;
      else {
        switched = true;
        // The reference target is served by GET /vp/pd/:id.
        expect(
          new URL(url.searchParams.get('presentation_definition_uri') ?? 'invalid:').pathname
        ).toMatch(/^\/vp\/pd\/[^/]+$/);
      }
    }
    expect(switched).toBe(true);
    expect(lastInline).toBe(2047);
  });
});
