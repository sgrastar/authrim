/**
 * Attribute verification responses and reads: exact bodies, store protocol, adapter names and
 * queries, with fakes at every boundary.
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

import { attributeVerifyResponse } from '../attribute-verify';

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

async function respond(
  body: Record<string, unknown> = { vp_token: 'a.b.c', state: REQUEST_ID },
  form?: Record<string, string>
) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/r', attributeVerifyResponse);
  const response = await app.request(
    'https://verifier.example.com/r',
    form
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString(),
        }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
    env as unknown as Env
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
const loggedErrors = () =>
  h.logger.error.mock.calls.map((call) => (call[2] as Error | undefined)?.message);

const calls = (path: string) =>
  stub.fetch.mock.calls.filter((call) => new URL((call[0] as Request).url).pathname === path);
const sent = async (call: unknown[]) => (await (call[0] as Request).clone().json()) as unknown;
const contentType = (call: unknown[]) => (call[0] as Request).headers.get('Content-Type');

beforeEach(() => {
  verification.statusFreshUntil = NOW_MS + 5000;
});

describe('response: access and input', () => {
  it('names its logger module and refuses an inactive token with the exact body', async () => {
    h.protectedContext.mockReturnValue(null);
    h.introspect.mockResolvedValue({ valid: false });
    expect(await respond()).toEqual({
      status: 401,
      body: { error: 'invalid_token', error_description: 'Invalid access token' },
    });
    expect(h.logger.module).toHaveBeenCalledWith('VC-VERIFIER');
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('reads a form body, parsing the presentation submission', async () => {
    const result = await respond(undefined, {
      vp_token: 'a.b.c',
      state: REQUEST_ID,
      presentation_submission: '{"id":"x"}',
    });
    expect(result.status).toBe(200);
    expect(h.sha).toHaveBeenCalledWith('a.b.c');
    expect(h.getStoreById).toHaveBeenCalledWith(env, REQUEST_ID, 'tenant-1');
    expect((await respond(undefined, { vp_token: 'a.b.c', state: REQUEST_ID })).status).toBe(200);
  });

  it('requires a token and a state with their own messages', async () => {
    expect(await respond({ state: REQUEST_ID })).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'vp_token is required' },
    });
    expect(await respond({ vp_token: 'x' })).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'state is required' },
    });
  });

  it('answers a generic server error for a failing request', async () => {
    h.verify.mockRejectedValue(new Error('internal detail'));
    expect(await respond()).toEqual({
      status: 500,
      body: { error: 'server_error', error_description: 'Internal server error' },
    });
  });
});

describe('response: store protocol and failures', () => {
  it('speaks JSON to the store and releases a foreign request with its identifiers', async () => {
    storedRequest = { ...stored, userId: 'other-user' };
    await respond();
    expect(contentType(calls('/reserve')[0])).toBe('application/json');
    expect(await sent(calls('/release')[0])).toEqual({
      id: REQUEST_ID,
      tenantId: 'tenant-1',
      reservationId: 'res-1',
    });
    expect(contentType(calls('/release')[0])).toBe('application/json');
    stub.fetch.mockClear();
    storedRequest = { ...stored, userId: undefined };
    await respond();
    expect(await sent(calls('/release')[0])).toEqual({
      id: REQUEST_ID,
      tenantId: 'tenant-1',
      reservationId: 'res-1',
    });
    expect(contentType(calls('/release')[0])).toBe('application/json');
  });

  it('fails an unverified presentation with its joined reasons and returns them with the warnings', async () => {
    Object.assign(verification, {
      verified: false,
      errors: ['first', 'second'],
      warnings: ['w1', 'w2'],
    });
    expect(await respond()).toEqual({
      status: 400,
      body: {
        error: 'invalid_presentation',
        error_description: 'first; second',
        warnings: ['w1', 'w2'],
      },
    });
    expect(await sent(calls('/fail')[0])).toEqual({
      id: REQUEST_ID,
      tenantId: 'tenant-1',
      reservationId: 'res-1',
      errorCode: 'verification_failed',
      errorDescription: 'first; second',
    });
    expect(contentType(calls('/fail')[0])).toBe('application/json');
  });

  it('releases the reservation and answers 500 when the failure transition is refused', async () => {
    Object.assign(verification, { verified: false, errors: ['x'] });
    stub.fetch.mockImplementation(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/reserve')
        return answer({ reserved: true, reservationId: 'res-1', request: storedRequest });
      if (path === '/fail') return answer({ failed: true }, false);
      return answer({});
    });
    expect((await respond()).status).toBe(500);
    expect(calls('/release')).toHaveLength(1);
    expect(loggedErrors()).toContain('vp_attribute_failure_transition_failed');
    expect(contentType(calls('/release')[0])).toBe('application/json');
  });

  it('completes with the claim names and trusts no completion answer of a failing store', async () => {
    expect((await respond()).status).toBe(200);
    expect(await sent(calls('/complete')[0])).toEqual({
      id: REQUEST_ID,
      tenantId: 'tenant-1',
      reservationId: 'res-1',
      verifiedClaimNames: ['age'],
    });
    expect(contentType(calls('/complete')[0])).toBe('application/json');
    stub.fetch.mockImplementation(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/reserve')
        return answer({ reserved: true, reservationId: 'res-1', request: storedRequest });
      if (path === '/complete') return answer({ completed: true }, false);
      return answer({});
    });
    expect((await respond()).status).toBe(500);
    expect(loggedErrors()).toContain('vp_attribute_completion_failed');
  });
});

describe('response: persistence', () => {
  it('re-checks the token online before persisting and requires the same user and tenant', async () => {
    await respond();
    // The second validation never trusts the cached protected-resource context.
    expect(h.introspect).toHaveBeenCalledTimes(1);
    h.introspect.mockResolvedValue({
      valid: true,
      claims: {
        tenant_id: 'tenant-1',
        aud: 'svc://op-vc/attribute-elevation',
        scope: 'vc.attribute',
        sub: 'other',
      },
    });
    h.accountUserId.mockReturnValue('other-user');
    expect((await respond()).status).toBe(500);
    expect(loggedErrors()).toContain('vp_persistence_authorization_expired');
    h.introspect.mockResolvedValue({
      valid: true,
      claims: {
        tenant_id: 'tenant-2',
        aud: 'svc://op-vc/attribute-elevation',
        scope: 'vc.attribute',
        sub: 'user-1',
      },
    });
    h.accountUserId.mockReturnValue('user-1');
    h.logger.error.mockClear();
    expect((await respond()).status).toBe(500);
    h.introspect.mockResolvedValue({ valid: false });
    expect((await respond()).status).toBe(500);
    expect(h.link).toHaveBeenCalledTimes(1);
  });

  it('refuses a request without its flow or profile before reading the flow', async () => {
    for (const field of ['verificationFlowVersionId']) {
      storedRequest = { ...stored, [field]: undefined };
      expect((await respond()).status).toBe(500);
    }
    expect(loggedErrors()).toContain('vp_verification_flow_missing');
    expect(h.coreAdapterArgs).toHaveBeenCalledWith(env, 'vc-verifier-core', {
      tenantId: 'tenant-1',
    });
  });

  it('reads the flow version of the request and refuses a missing one', async () => {
    h.coreQueryOne.mockResolvedValue(null);
    expect((await respond()).status).toBe(500);
    expect(loggedErrors()).toContain('vp_verification_flow_not_found');
    expect(h.coreQueryOne).toHaveBeenCalledWith(
      'SELECT runtime_snapshot_json FROM flow_versions WHERE tenant_id = ? AND id = ?',
      ['tenant-1', 'flow-v1']
    );
  });

  it('runs the attribute flow with the committed outcome and the mapping adapter name', async () => {
    h.executeServerFlow.mockImplementation(
      async (input: {
        handlers: Record<string, (a: unknown) => Promise<{ handle: string }>>;
        state: unknown;
        expectedKind: string;
      }) => {
        expect(input.expectedKind).toBe('attribute_elevation');
        const presented = await input.handlers.credential_presentation({
          step: { config: { credential_profile_ref: 'profile-1' } },
          state: input.state,
        });
        expect(presented).toEqual({ handle: 'verified' });
        const committed = await input.handlers.verified_attribute({
          step: { config: { credential_profile_ref: 'profile-1' } },
          state: input.state,
        });
        expect(committed).toEqual({ handle: 'committed' });
        h.link.mockResolvedValueOnce({ success: false, attributes: [] });
      }
    );
    expect((await respond()).status).toBe(200);
    expect(h.adminAdapterArgs).toHaveBeenCalledWith(env, 'vc-attribute-mapping');
    expect(h.resolveMapping).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-1',
      protocol: 'vc',
      role: 'verifier',
      direction: 'verification',
      credentialProfileId: 'profile-1',
      fieldMappingVersionId: 'map-v1',
    });
  });

  it('reports a rejected commit through its handle', async () => {
    h.link.mockResolvedValue({ success: false, attributes: [] });
    let handle = '';
    h.executeServerFlow.mockImplementation(
      async (input: {
        handlers: Record<string, (a: unknown) => Promise<{ handle: string }>>;
        state: unknown;
      }) => {
        await input.handlers.credential_presentation({
          step: { config: { credential_profile_ref: 'profile-1' } },
          state: input.state,
        });
        handle = (
          await input.handlers.verified_attribute({
            step: { config: { credential_profile_ref: 'profile-1' } },
            state: input.state,
          })
        ).handle;
      }
    );
    await respond();
    expect(handle).toBe('rejected');
  });

  it('lets a profile reference be an object only when it is an object with the id', async () => {
    for (const ref of [{ id: 'profile-1' }, 'profile-1']) {
      flowRefs.presentation = ref;
      expect((await respond()).status).toBe(200);
    }
    for (const ref of [null, 'x', 5, undefined, true]) {
      flowRefs.presentation = ref;
      expect((await respond()).status).toBe(500);
    }
  });

  it('requires the subject of the request, as the user the token is for', async () => {
    storedRequest = { ...stored, userId: '' };
    expect((await respond()).status).toBe(400);
  });
});
