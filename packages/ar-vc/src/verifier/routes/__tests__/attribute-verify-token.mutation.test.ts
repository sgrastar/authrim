/**
 * Attribute verification: access token rules for reads and the wallet request URL.
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
    getNewStore: vi.fn(),
    getAttributes: vi.fn(),
    findByUser: vi.fn(),
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
    AttributeVerificationRepository: class {
      invalidateStaleForUser = vi.fn();
      invalidateUntrustedForUser = vi.fn();
      findByUser = h.findByUser;
      invalidateVerification = vi.fn();
    },
    UserVerifiedAttributeRepository: class {},
  };
});
vi.mock('@authrim/ar-lib-core/services/mapping-hash', () => ({ executeTenantMapping: vi.fn() }));
vi.mock('@authrim/ar-lib-core/services/mapping-snapshot-equivalence', () => ({
  runtimeMappingSnapshotMatches: h.snapshotMatches,
}));
vi.mock('../../../utils/vp-request-sharding', () => ({
  getVPRequestStoreById: vi.fn(),
  getVPRequestStoreForNewRequest: h.getNewStore,
}));
vi.mock('../../../utils/configured-shard', () => ({ isConfiguredShard: vi.fn() }));
vi.mock('../../services/vp-verifier', () => ({ verifyVPToken: vi.fn() }));
vi.mock('../../services/attribute-mapper', () => ({
  linkVerificationToUser: vi.fn(),
  getUserVerifiedAttributes: h.getAttributes,
}));
vi.mock('../../../utils/crypto', () => ({ sha256Base64url: vi.fn() }));
vi.mock('../../../request-identifiers', () => ({
  getRequestIssuerUrl: () => 'https://verifier.example.com',
  getRequestVerifierIdentifier: () => 'verifier-id',
}));

import { getAttributes, initiateAttributeVerification } from '../attribute-verify';

const AUDIENCE = 'svc://op-vc/attribute-elevation';
const REQUEST_ID = 'g1:apac:1:vp_1';
let env: Record<string, unknown>;
let stub: { fetch: ReturnType<typeof vi.fn<(request: Request) => Promise<unknown>>> };

const answer = (body: unknown) => new Response(JSON.stringify(body));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_800_000_000_000);
  vi.resetAllMocks();
  h.logger.module.mockReturnValue(h.logger);
  env = { VC_EVIDENCE_HMAC_SECRET: 'e'.repeat(32), HAIP_POLICY_VERSION: 'final-1.0' };
  stub = { fetch: vi.fn<(request: Request) => Promise<unknown>>() };
  h.introspect.mockResolvedValue({
    valid: true,
    claims: { tenant_id: 'tenant-1', aud: AUDIENCE, scope: 'vc.attribute', sub: 'user-1' },
  });
  h.accountUserId.mockReturnValue('user-1');
  h.resolveMapping.mockResolvedValue({ edges: [] });
  h.snapshotMatches.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('access tokens (verified attribute reads)', () => {
  async function read() {
    const app = new Hono<{ Bindings: Env }>();
    app.get('/a', getAttributes);
    const response = await app.request(
      'https://verifier.example.com/a',
      { headers: { Authorization: 'Bearer t' } },
      env as unknown as Env
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  beforeEach(() => {
    h.protectedContext.mockReturnValue(null);
    h.findByUser.mockResolvedValue({ items: [] });
    h.getAttributes.mockResolvedValue({ age_ok: 'true' });
  });

  it('accepts a token with the attribute scope and the elevation audience', async () => {
    expect(await read()).toEqual({
      status: 200,
      body: { user_id: 'user-1', attributes: { age_ok: 'true' } },
    });
  });

  it('reports the presented sub of an active protected-resource context, else the subject', async () => {
    h.protectedContext.mockReturnValue({
      subject: 'account-1',
      tenantId: 'tenant-1',
      claims: { sub: 'pairwise' },
    });
    expect((await read()).body.user_id).toBe('pairwise');
    h.protectedContext.mockReturnValue({
      subject: 'account-1',
      tenantId: 'tenant-1',
      claims: { sub: 5 },
    });
    expect((await read()).body.user_id).toBe('account-1');
    expect(h.introspect).not.toHaveBeenCalled();
  });

  it('refuses tokens by audience, scope, tenant and subject', async () => {
    const claims = { tenant_id: 'tenant-1', aud: AUDIENCE, scope: 'vc.attribute', sub: 'user-1' };
    const attempts: Array<Record<string, unknown>> = [
      { ...claims, aud: 'other' },
      { ...claims, aud: undefined },
      { ...claims, scope: 'vc.other' },
      { ...claims, scope: undefined },
      { ...claims, scope: 'vc.attributes' },
      { ...claims, tenant_id: 'tenant-2' },
      { ...claims, tenant_id: undefined },
    ];
    for (const attempt of attempts) {
      h.introspect.mockResolvedValue({ valid: true, claims: attempt });
      expect(await read()).toMatchObject({ status: 401, body: { error: 'invalid_token' } });
    }
    h.introspect.mockResolvedValue({ valid: true, claims });
    h.accountUserId.mockReturnValue(null);
    expect((await read()).status).toBe(401);
    h.introspect.mockResolvedValue({ valid: false, claims });
    h.accountUserId.mockReturnValue('user-1');
    expect((await read()).status).toBe(401);
    h.introspect.mockResolvedValue({ valid: true });
    expect((await read()).status).toBe(401);
  });

  it('accepts several audiences and scopes, and a configured audience', async () => {
    h.introspect.mockResolvedValue({
      valid: true,
      claims: {
        tenant_id: 'tenant-1',
        aud: ['x', AUDIENCE],
        scope: 'openid  vc.attribute',
        sub: 's',
      },
    });
    expect((await read()).status).toBe(200);
    env.VC_ATTRIBUTE_ELEVATION_AUDIENCE = 'svc://custom';
    expect((await read()).status).toBe(401);
    h.introspect.mockResolvedValue({
      valid: true,
      claims: { tenant_id: 'tenant-1', aud: 'svc://custom', scope: 'vc.attribute', sub: 's' },
    });
    expect((await read()).status).toBe(200);
  });

  it('logs an introspection failure and refuses the token', async () => {
    h.introspect.mockRejectedValue(new Error('introspection down'));
    expect((await read()).status).toBe(401);
    expect(h.logger.error).toHaveBeenCalledWith(
      'Access token validation failed',
      {},
      expect.objectContaining({ message: 'introspection down' })
    );
  });
});

describe('wallet request URL', () => {
  async function initiate(claims: string[] = ['age']) {
    h.adminQueryOne.mockResolvedValue({
      profile_id: 'profile-1',
      version_id: 'profile-v1',
      verification_flow_version_id: 'flow-v1',
      credential_configuration_id: 'cfg-1',
      verification_mapping_set_id: 'set-1',
      verification_mapping_version_id: 'map-v1',
      verification_mapping_snapshot_hash: 'hash-1',
      claim_allowlist_json: JSON.stringify(claims),
      maximum_attribute_age_seconds: 600,
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
        body: JSON.stringify({ credential_profile_id: 'profile-1' }),
      },
      env as unknown as Env
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, string | number>,
    };
  }

  it('answers with an inline definition, the response_uri and the default expiry', async () => {
    const { status, body } = await initiate();
    expect(status).toBe(200);
    expect(body.expires_in).toBe(300);
    expect(body.state).toBe(REQUEST_ID);
    const url = new URL(String(body.authorization_request));
    expect(url.protocol).toBe('openid4vp:');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'vp_token',
      client_id: 'verifier-id',
      response_mode: 'direct_post',
      nonce: body.nonce,
      state: REQUEST_ID,
      response_uri: 'https://verifier.example.com/vp/attribute-response',
    });
    expect(url.searchParams.has('redirect_uri')).toBe(false);
    expect(url.searchParams.has('presentation_definition_uri')).toBe(false);
    const definition = JSON.parse(url.searchParams.get('presentation_definition') ?? '{}') as {
      input_descriptors: Array<{ constraints: { fields: Array<{ path: string[] }> } }>;
    };
    expect(definition.input_descriptors[0].constraints.fields.map((f) => f.path[0])).toEqual([
      '$.vct',
      '$.age',
    ]);
    const created = JSON.parse(await (stub.fetch.mock.calls[0][0] as Request).text()) as Record<
      string,
      number
    >;
    expect(created.expiresAt - created.createdAt).toBe(300_000);
  });

  it('reads the expiry setting', async () => {
    env.VP_REQUEST_EXPIRY_SECONDS = '120';
    expect((await initiate()).body.expires_in).toBe(120);
  });

  it('refers to the definition by URI when it is not small', async () => {
    const claims = Array.from({ length: 80 }, (_, index) => `claim_number_${index}`);
    const url = new URL(String((await initiate(claims)).body.authorization_request));
    // The target is served by GET /vp/pd/:id (see presentation-definition-routing test).
    const reference = new URL(url.searchParams.get('presentation_definition_uri') ?? '');
    expect(reference.origin).toBe('https://verifier.example.com');
    expect(reference.pathname).toBe(`/vp/pd/${REQUEST_ID}`);
    expect(url.searchParams.has('presentation_definition')).toBe(false);
  });
});
