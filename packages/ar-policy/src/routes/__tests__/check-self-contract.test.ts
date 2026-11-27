/**
 * Check API at the route level: the server and self contracts, end-user access token
 * authentication (audience, tenant, pairwise subject, revocation), batch, and the feature gate.
 *
 * The real routes, check-auth and check-access-token run; introspection (ar-lib-core's
 * protected-resource path), the settings reads and the evaluation service are stubbed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const spies = vi.hoisted(() => ({
  introspect: vi.fn(),
  tokenClient: vi.fn(),
  effectiveSettings: vi.fn(),
  platformSettings: vi.fn(),
  createService: vi.fn(),
  check: vi.fn(),
  batchCheck: vi.fn(),
  client: vi.fn(),
  revocation: vi.fn(),
  consentWithdrawal: vi.fn(),
  consentWithdrawn: vi.fn(),
  accountCore: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...original,
    introspectTokenFromContext: spies.introspect,
    introspectedTokenClient: spies.tokenClient,
    resolveEffectiveSettingsWithSources: spies.effectiveSettings,
    resolvePlatformSettingsWithSources: spies.platformSettings,
    getClientCached: spies.client,
    readTokenRevocationState: spies.revocation,
    resolveAccountCoreDataContext: spies.accountCore,
    ensureDatabaseAdapter: (source: unknown) => source,
    findOAuthClientConsentRevocation: spies.consentWithdrawal,
    isAccessTokenConsentWithdrawn: spies.consentWithdrawn,
  };
});
vi.mock('@authrim/ar-lib-core/services/unified-check-service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createUnifiedCheckService: spies.createService,
}));
vi.mock('../../rebac-storage-adapter', () => ({
  getPolicyCoreAdapter: () => ({ name: 'core-adapter' }),
  createPolicyReBACService: () => ({ name: 'rebac' }),
}));
vi.mock('../../tenant-policy', () => ({
  resolveTenantPolicy: async () => ({
    abac: false,
    verifiedAttributes: false,
    logDecisions: false,
  }),
}));

import { checkRoutes } from '../check';
import { createRateLimiterStub } from '../../__tests__/rate-limiter-stub';

const ISSUER_A = 'https://tenant-a.example.com';

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A JWT-shaped token (introspection is stubbed, so the signature is never checked here). */
function token(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256', kid: 'k1' })}.${b64url(payload)}.c2ln`;
}

const TENANT_A_TOKEN = token({ iss: ISSUER_A, sub: 'user-1', tenant_id: 'tenant-a' });

/** The routes behind a request context that resolved the host's tenant to `tenant-a`. */
function app() {
  const wrapper = new Hono<{ Variables: { tenantId: string } }>();
  wrapper.use('*', async (c, next) => {
    c.set('tenantId', 'tenant-a');
    await next();
  });
  wrapper.route('/api/check', checkRoutes as never);
  return wrapper;
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    BASE_DOMAIN: 'example.com',
    POLICY_API_SECRET: 'policy-secret',
    RATE_LIMITER: createRateLimiterStub(),
    ...overrides,
  };
}

async function post(
  path: string,
  body: unknown,
  bearer = TENANT_A_TOKEN,
  environment = env(),
  options: { origin?: string; scheme?: string; headers?: Record<string, string>; raw?: string } = {}
) {
  const response = await app().request(
    `${options.origin ?? ISSUER_A}${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `${options.scheme ?? 'Bearer'} ${bearer}`,
        ...options.headers,
      },
      body: options.raw ?? JSON.stringify(body),
    },
    environment,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as never
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

/** Introspection's answer: an access token (token_use, JWT ID, client) unless overridden. */
function introspected(claims: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  spies.introspect.mockResolvedValue({
    valid: true,
    claims: { token_use: 'access', jti: 'jti-1', client_id: 'app-1', ...claims },
    ...extra,
  });
}

let checkApiEnabled = true;
let checkAudience: unknown = '';

beforeEach(() => {
  vi.clearAllMocks();
  checkApiEnabled = true;
  checkAudience = '';
  spies.platformSettings.mockImplementation(async (_env: unknown, category: string) => ({
    values:
      category === 'feature-flags'
        ? { 'feature.enable_check_api': checkApiEnabled }
        : category === 'check-api-audit'
          ? { 'audit.check_api_enabled': false }
          : {},
  }));
  spies.effectiveSettings.mockImplementation(async (_env: unknown, category: string) => {
    if (category === 'check') {
      if (checkAudience instanceof Error) throw checkAudience;
      return { values: { 'check.audience': checkAudience } };
    }
    return { values: {} };
  });
  spies.tokenClient.mockResolvedValue({ subject_type: 'public' });
  spies.client.mockResolvedValue({ client_id: 'app-1', enabled: true });
  spies.revocation.mockResolvedValue('active');
  spies.consentWithdrawal.mockResolvedValue({ generation: 0 });
  spies.consentWithdrawn.mockReturnValue(false);
  spies.accountCore.mockResolvedValue({ coreDb: { name: 'account-core' } });
  introspected({ sub: 'user-1', tenant_id: 'tenant-a', aud: ISSUER_A, client_id: 'app-1' });
  spies.check.mockResolvedValue({ allowed: true, resolved_via: ['role'], final_decision: 'allow' });
  spies.batchCheck.mockResolvedValue({ results: [], summary: { total: 0 } });
  spies.createService.mockImplementation(() => ({
    check: spies.check,
    batchCheck: spies.batchCheck,
  }));
});

describe('self contract (end-user access token)', () => {
  it('binds the subject to the token and checks only the permission', async () => {
    const result = await post('/api/check', { permission: 'documents:doc_1:read' });
    expect(result.status).toBe(200);
    // Verified against the request host's issuer, which is also the default Check audience;
    // the consent state is read from the account's Core database alone.
    expect(spies.introspect).toHaveBeenCalledWith(expect.anything(), {
      audience: ISSUER_A,
      issuer: ISSUER_A,
      allowSubjectReference: true,
      consentFromAccountCoreOnly: true,
    });
    expect(spies.check).toHaveBeenCalledWith(
      {
        subject_id: 'user-1',
        subject_type: 'user',
        permission: 'documents:doc_1:read',
        tenant_id: 'tenant-a',
      },
      expect.objectContaining({ contract: 'self', clientId: 'app-1' })
    );
  });

  it('accepts a subject_id and tenant_id that name the token’s own', async () => {
    const result = await post('/api/check', {
      subject_id: 'user-1',
      subject_type: 'user',
      tenant_id: 'tenant-a',
      permission: 'documents:read',
    });
    expect(result.status).toBe(200);
  });

  it('never turns debug details on for an access token', async () => {
    await post('/api/check', { permission: 'documents:read' }, TENANT_A_TOKEN, {
      ...env(),
      ENABLE_CHECK_API_DEBUG: 'true',
    });
    expect(spies.createService).toHaveBeenCalledWith(expect.objectContaining({ debugMode: false }));
  });

  it.each([
    ['resource_context', { resource_context: { owner_id: 'user-1' } }],
    ['rebac', { rebac: { relation: 'viewer', object: 'document:doc_1' } }],
    ['another subject', { subject_id: 'user-2' }],
    ['a service subject type', { subject_type: 'service' }],
    ['an unknown field', { attributes: { level: 9 } }],
  ])('refuses %s with 400 (contract violation)', async (_label, extra) => {
    const result = await post('/api/check', { permission: 'documents:doc_1:read', ...extra });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'invalid_request' });
    expect(JSON.stringify(result.body)).toContain('AR050009');
    expect(spies.check).not.toHaveBeenCalled();
  });

  it('refuses a tenant_id of another tenant', async () => {
    const result = await post('/api/check', {
      tenant_id: 'tenant-b',
      permission: 'documents:read',
    });
    expect(result.status).toBe(403);
    expect(spies.check).not.toHaveBeenCalled();
  });

  describe('authentication', () => {
    it('requires the configured Check audience', async () => {
      checkAudience = 'https://api.tenant-a.example.com/check';
      introspected({ sub: 'user-1', tenant_id: 'tenant-a', aud: ISSUER_A });
      const wrong = await post('/api/check', { permission: 'documents:read' });
      expect(wrong.status).toBe(401);
      expect(spies.introspect).toHaveBeenCalledWith(expect.anything(), {
        audience: 'https://api.tenant-a.example.com/check',
        issuer: ISSUER_A,
        allowSubjectReference: true,
        consentFromAccountCoreOnly: true,
      });
      expect(spies.check).not.toHaveBeenCalled();

      introspected({
        sub: 'user-1',
        tenant_id: 'tenant-a',
        aud: ['other', 'https://api.tenant-a.example.com/check'],
      });
      expect((await post('/api/check', { permission: 'documents:read' })).status).toBe(200);
    });

    it('refuses a revoked (or otherwise inactive) token', async () => {
      spies.introspect.mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token has been revoked',
          wwwAuthenticate: 'Bearer error="invalid_token"',
          statusCode: 401,
        },
      });
      const result = await post('/api/check', { permission: 'documents:read' });
      expect(result.status).toBe(401);
      expect(spies.check).not.toHaveBeenCalled();
    });

    it('refuses a token of another tenant before verifying it', async () => {
      const other = token({ iss: 'https://tenant-b.example.com', sub: 'u', tenant_id: 'tenant-b' });
      const result = await post('/api/check', { permission: 'documents:read' }, other);
      expect(result.status).toBe(401);
      expect(spies.introspect).not.toHaveBeenCalled();
      expect(spies.check).not.toHaveBeenCalled();
    });

    it('without a tenant_id claim, requires exactly the issuer of the request host', async () => {
      introspected({ sub: 'user-1', aud: ISSUER_A });
      const ownIssuer = token({ iss: ISSUER_A, sub: 'user-1' });
      expect((await post('/api/check', { permission: 'documents:read' }, ownIssuer)).status).toBe(
        200
      );
      expect(spies.check).toHaveBeenCalledWith(
        expect.objectContaining({ subject_id: 'user-1', tenant_id: 'tenant-a' }),
        expect.anything()
      );

      spies.check.mockClear();
      spies.introspect.mockClear();
      for (const iss of [
        'https://tenant-b.example.com',
        `${ISSUER_A}/`,
        'https://TENANT-A.example.com',
        undefined,
      ]) {
        const other = token({ iss, sub: 'user-1' });
        expect((await post('/api/check', { permission: 'documents:read' }, other)).status).toBe(
          401
        );
      }
      expect(spies.introspect).not.toHaveBeenCalled();
      expect(spies.check).not.toHaveBeenCalled();
    });

    it('refuses a verified token whose tenant_id claim is another tenant', async () => {
      introspected({ sub: 'user-1', tenant_id: 'tenant-b', aud: ISSUER_A });
      const unclaimed = token({ iss: ISSUER_A, sub: 'user-1' });
      expect((await post('/api/check', { permission: 'documents:read' }, unclaimed)).status).toBe(
        401
      );
    });

    it('checks a pairwise token for the account its sealed reference opens', async () => {
      introspected(
        {
          sub: 'pairwise-sub',
          authrim_subject_ref: 'sr1.a.b',
          tenant_id: 'tenant-a',
          aud: ISSUER_A,
          client_id: 'pairwise-app',
        },
        { accountUserId: 'user-real' }
      );
      const result = await post('/api/check', {
        subject_id: 'pairwise-sub',
        permission: 'documents:read',
      });
      expect(result.status).toBe(200);
      expect(spies.check).toHaveBeenCalledWith(
        expect.objectContaining({ subject_id: 'user-real' }),
        expect.objectContaining({ contract: 'self' })
      );

      spies.check.mockClear();
      for (const subjectId of ['user-real', 'user-real-2']) {
        // Never the internal account id (no oracle for a pairwise subject's account).
        const other = await post('/api/check', { subject_id: subjectId, permission: 'a:b' });
        expect(other.status).toBe(400);
      }
      expect(spies.check).not.toHaveBeenCalled();
    });

    it('refuses a pairwise app’s token that carries no account reference', async () => {
      spies.tokenClient.mockResolvedValue({ subject_type: 'pairwise' });
      introspected({
        sub: 'user-1',
        token_use: 'access',
        jti: 'jti-1',
        tenant_id: 'tenant-a',
        aud: ISSUER_A,
        client_id: 'old-app',
      });
      expect((await post('/api/check', { permission: 'documents:read' })).status).toBe(401);
      expect(spies.check).not.toHaveBeenCalled();
    });

    it('answers 503 when the Check audience or the account cannot be read', async () => {
      checkAudience = new Error('settings down');
      expect((await post('/api/check', { permission: 'documents:read' })).status).toBe(503);
      expect(spies.introspect).not.toHaveBeenCalled();

      checkAudience = '';
      spies.introspect.mockResolvedValue({
        valid: false,
        error: {
          error: 'temporarily_unavailable',
          error_description: 'Account data is unavailable',
          wwwAuthenticate: 'Bearer error="invalid_token"',
          statusCode: 503,
        },
      });
      expect((await post('/api/check', { permission: 'documents:read' })).status).toBe(503);
      expect(spies.check).not.toHaveBeenCalled();
    });
  });

  describe('what the token must be', () => {
    async function refusedWith(status: number) {
      const result = await post('/api/check', { permission: 'documents:read' });
      expect(result.status).toBe(status);
      expect(spies.check).not.toHaveBeenCalled();
      return result.body;
    }

    it('refuses an external subject brought in by token exchange (distinct code)', async () => {
      introspected({
        sub: 'ext-123',
        tenant_id: 'tenant-a',
        aud: ISSUER_A,
        authrim_subject_issuer: 'https://idp.partner.test',
      });
      expect(await refusedWith(401)).toMatchObject({
        error: 'invalid_token',
        error_code: 'non_account_subject',
      });
    });

    it('refuses a client_credentials token (distinct code)', async () => {
      introspected({ sub: 'client:app-1', tenant_id: 'tenant-a', aud: ISSUER_A });
      expect(await refusedWith(401)).toMatchObject({ error_code: 'non_account_subject' });
    });

    it('refuses a refresh token, or a token without token_use or JWT ID', async () => {
      for (const claims of [
        { token_use: 'refresh' },
        { token_use: undefined },
        { jti: undefined },
      ]) {
        introspected({ sub: 'user-1', tenant_id: 'tenant-a', aud: ISSUER_A, ...claims });
        await refusedWith(401);
      }
    });

    it('answers 503 when the revocation store is missing or unreachable, 401 when revoked', async () => {
      spies.revocation.mockResolvedValueOnce('unavailable');
      await refusedWith(503);
      spies.revocation.mockResolvedValueOnce('revoked');
      await refusedWith(401);
      expect(spies.revocation).toHaveBeenLastCalledWith(expect.anything(), 'jti-1', 'tenant-a');
    });

    it('refuses a token whose client is unknown or disabled', async () => {
      spies.client.mockResolvedValueOnce(null);
      await refusedWith(401);
      spies.client.mockResolvedValueOnce({ client_id: 'app-1', enabled: false });
      await refusedWith(401);
      expect(spies.client).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'app-1', {
        includeDisabled: true,
      });
    });

    it('applies the iat-based consent withdrawal to a legacy token (and 503 when unreadable)', async () => {
      spies.consentWithdrawn.mockReturnValueOnce(true);
      await refusedWith(401);
      spies.consentWithdrawal.mockRejectedValueOnce(new Error('account db down'));
      await refusedWith(503);
    });

    it('leaves the consent check of a token that records its grant to introspection', async () => {
      introspected({
        sub: 'user-1',
        tenant_id: 'tenant-a',
        aud: ISSUER_A,
        authrim_consent_generation: 3,
      });
      expect((await post('/api/check', { permission: 'documents:read' })).status).toBe(200);
      expect(spies.consentWithdrawal).not.toHaveBeenCalled();
    });
  });

  describe('issuer, elevation, DPoP and failures', () => {
    const CUSTOM = 'https://auth.customer.test';

    /** Introspection as it verifies the issuer and the sender constraint (stubbed). */
    function verifyingIntrospection() {
      spies.introspect.mockImplementation(
        async (c: { req: { header(name: string): string | undefined } }, options) => {
          const authorization = c.req.header('Authorization') ?? '';
          const raw = authorization.split(' ')[1] ?? '';
          const claims = JSON.parse(
            atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
          ) as Record<string, unknown>;
          if (claims.iss !== (options as { issuer?: string }).issuer) return { valid: false };
          const bound = typeof claims.cnf === 'object';
          if (bound !== authorization.startsWith('DPoP ')) return { valid: false };
          if (bound && !c.req.header('DPoP')) return { valid: false };
          return {
            valid: true,
            claims: {
              token_use: 'access',
              jti: 'jti-1',
              client_id: 'app-1',
              aud: [ISSUER_A, CUSTOM],
              ...claims,
            },
          };
        }
      );
    }

    it('accepts a token issued for a custom domain on that host only', async () => {
      verifyingIntrospection();
      const custom = token({ iss: CUSTOM, sub: 'user-1', tenant_id: 'tenant-a' });
      checkAudience = CUSTOM;
      const onCustom = await post('/api/check', { permission: 'a:b' }, custom, env(), {
        origin: CUSTOM,
      });
      expect(onCustom.status).toBe(200);
      expect(spies.introspect).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ issuer: CUSTOM })
      );

      const onCanonical = await post('/api/check', { permission: 'a:b' }, custom);
      expect(onCanonical.status).toBe(401);
    });

    it('refuses an elevation grant token with its own code', async () => {
      introspected({
        sub: 'user-1',
        tenant_id: 'tenant-a',
        aud: ISSUER_A,
        client_id: 'authrim-approval-grant',
        token_use: 'elevation_grant_subject',
        authrim_elevation: { grant_id: 'g1', request_id: 'r1', target_subject_id: 'user-1' },
      });
      const result = await post('/api/check', { permission: 'a:b' });
      expect(result.status).toBe(401);
      expect(result.body).toMatchObject({ error_code: 'elevated_token_not_allowed' });
    });

    it('accepts DPoP for a DPoP-bound token and refuses it as Bearer', async () => {
      verifyingIntrospection();
      const bound = token({
        iss: ISSUER_A,
        sub: 'user-1',
        tenant_id: 'tenant-a',
        cnf: { jkt: 'thumb' },
      });
      const dpop = await post('/api/check', { permission: 'a:b' }, bound, env(), {
        scheme: 'DPoP',
        headers: { DPoP: 'proof.jwt.value' },
      });
      expect(dpop.status).toBe(200);
      const bearer = await post('/api/check', { permission: 'a:b' }, bound);
      expect(bearer.status).toBe(401);
    });

    it('keeps server credentials on Bearer only', async () => {
      const result = await post(
        '/api/check',
        { subject_id: 'u', tenant_id: 'tenant-a', permission: 'a:b' },
        'policy-secret',
        env(),
        { scheme: 'DPoP' }
      );
      expect(result.status).toBe(401);
      expect(spies.check).not.toHaveBeenCalled();
    });

    it('answers 503 for an introspection infrastructure failure, 401 for an invalid proof', async () => {
      for (const [statusCode, expected] of [
        [500, 503], // the verification key could not be loaded
        [503, 503], // the DPoP replay store or the account is unavailable
        [401, 401], // an invalid or replayed proof, an invalid token
      ] as const) {
        spies.introspect.mockResolvedValueOnce({
          valid: false,
          error: { error: 'x', error_description: 'x', wwwAuthenticate: 'DPoP', statusCode },
        });
        expect((await post('/api/check', { permission: 'a:b' })).status).toBe(expected);
      }
      expect(spies.check).not.toHaveBeenCalled();
    });

    it('answers 503, not 500, when a read inside verification throws', async () => {
      spies.introspect.mockRejectedValueOnce(new Error('key manager down'));
      expect((await post('/api/check', { permission: 'a:b' })).status).toBe(503);
      spies.client.mockRejectedValueOnce(new Error('clients db down'));
      expect((await post('/api/check', { permission: 'a:b' })).status).toBe(503);
      expect(spies.check).not.toHaveBeenCalled();
    });

    it('answers 400 for a body that is not JSON and for a non-string tenant_id', async () => {
      expect((await post('/api/check', null, TENANT_A_TOKEN, env(), { raw: '{oops' })).status).toBe(
        400
      );
      expect(
        (await post('/api/check/batch', null, TENANT_A_TOKEN, env(), { raw: '{oops' })).status
      ).toBe(400);
      expect(
        (
          await post(
            '/api/check',
            { subject_id: 'u', tenant_id: 7, permission: 'a:b' },
            'policy-secret'
          )
        ).status
      ).toBe(400);
      expect(
        (
          await post(
            '/api/check/batch',
            { checks: [{ subject_id: 'u', tenant_id: { x: 1 }, permission: 'a:b' }] },
            'policy-secret'
          )
        ).status
      ).toBe(400);
      expect(spies.check).not.toHaveBeenCalled();
      expect(spies.batchCheck).not.toHaveBeenCalled();
    });
  });

  describe('strict request validation', () => {
    it.each([
      [
        'a permission object with an extra key',
        { permission: { resource: 'd', action: 'r', x: 1 } },
      ],
      [
        'a permission object with an empty id',
        { permission: { resource: 'd', action: 'r', id: '' } },
      ],
      ['a permission object without action', { permission: { resource: 'd' } }],
      ['a non-string permission', { permission: 7 }],
    ])('refuses %s with 400', async (_label, body) => {
      expect((await post('/api/check', body)).status).toBe(400);
      expect(spies.check).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-boolean stop_on_deny', { checks: [{ permission: 'a:b' }], stop_on_deny: 'yes' }],
      ['an unknown envelope key', { checks: [{ permission: 'a:b' }], tenant_id: 'tenant-a' }],
      ['a non-object element', { checks: ['a:b'] }],
      ['a malformed permission object', { checks: [{ permission: { resource: 'a' } }] }],
      ['an array body', [{ permission: 'a:b' }]],
    ])('refuses a batch with %s with 400', async (_label, body) => {
      expect((await post('/api/check/batch', body)).status).toBe(400);
      expect(spies.batchCheck).not.toHaveBeenCalled();
    });
  });

  describe('batch', () => {
    it('binds every check to the token’s subject', async () => {
      const result = await post('/api/check/batch', {
        checks: [{ permission: 'documents:read' }, { permission: 'documents:doc_1:write' }],
        stop_on_deny: true,
      });
      expect(result.status).toBe(200);
      expect(spies.batchCheck).toHaveBeenCalledWith(
        {
          checks: [
            {
              subject_id: 'user-1',
              subject_type: 'user',
              permission: 'documents:read',
              tenant_id: 'tenant-a',
            },
            {
              subject_id: 'user-1',
              subject_type: 'user',
              permission: 'documents:doc_1:write',
              tenant_id: 'tenant-a',
            },
          ],
          stop_on_deny: true,
        },
        expect.objectContaining({ contract: 'self' })
      );
    });

    it.each([
      ['resource_context', { resource_context: { owner_id: 'user-1' } }],
      ['rebac', { rebac: { relation: 'viewer', object: 'document:doc_1' } }],
      ['another subject', { subject_id: 'user-2' }],
    ])('refuses the whole batch when one check carries %s', async (_label, extra) => {
      const result = await post('/api/check/batch', {
        checks: [{ permission: 'documents:read' }, { permission: 'documents:read', ...extra }],
      });
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.body)).toContain('AR050009');
      expect(spies.batchCheck).not.toHaveBeenCalled();
    });

    it('refuses a revoked token', async () => {
      spies.introspect.mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token has been revoked',
          wwwAuthenticate: 'Bearer error="invalid_token"',
          statusCode: 401,
        },
      });
      const result = await post('/api/check/batch', { checks: [{ permission: 'a:b' }] });
      expect(result.status).toBe(401);
      expect(spies.batchCheck).not.toHaveBeenCalled();
    });
  });
});

describe('server contract (policy secret)', () => {
  it('passes the subject, resource_context and rebac through', async () => {
    const body = {
      subject_id: 'user-9',
      tenant_id: 'tenant-a',
      permission: 'documents:doc_1:read',
      resource_context: { owner_id: 'user-9', group_id: 'grp-1' },
      rebac: { relation: 'viewer', object: 'document:doc_1' },
    };
    const result = await post('/api/check', body, 'policy-secret');
    expect(result.status).toBe(200);
    expect(spies.introspect).not.toHaveBeenCalled();
    expect(spies.check).toHaveBeenCalledWith(
      { ...body, subject_type: 'user' },
      expect.objectContaining({ contract: 'server' })
    );
  });
});

describe('feature.enable_check_api', () => {
  it('is off by default: both contracts answer 403', async () => {
    checkApiEnabled = false;
    expect((await post('/api/check', { permission: 'a:b' })).status).toBe(403);
    expect(
      (
        await post(
          '/api/check',
          { subject_id: 'u', tenant_id: 'tenant-a', permission: 'a:b' },
          'policy-secret'
        )
      ).status
    ).toBe(403);
    expect((await post('/api/check/batch', { checks: [{ permission: 'a:b' }] })).status).toBe(403);
    expect(spies.introspect).not.toHaveBeenCalled();
    expect(spies.check).not.toHaveBeenCalled();
  });

  it('turned on, serves both contracts', async () => {
    expect((await post('/api/check', { permission: 'a:b' })).status).toBe(200);
    expect(
      (
        await post(
          '/api/check',
          { subject_id: 'u', tenant_id: 'tenant-a', permission: 'a:b' },
          'policy-secret'
        )
      ).status
    ).toBe(200);
    expect(
      spies.check.mock.calls.map((call) => (call[1] as { contract: string }).contract)
    ).toEqual(['self', 'server']);
  });
});
