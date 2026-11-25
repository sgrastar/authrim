import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throwValue } from './helpers/matchers';
import { argRec, callArg, rec } from './helpers/mock-args';
import { classifyBackchannelLogoutError } from '../handlers/backchannel-logout';
import { NOW_MS, NOW_S, TENANT, postBackchannel } from './helpers/backchannel-harness';

const m = vi.hoisted(() => ({
  moduleNames: [] as string[],
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  getProvider: vi.fn(),
  findLinked: vi.fn(),
  updateLinked: vi.fn(),
  safeFetchJson: vi.fn(),
  createLocalJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
  replay: vi.fn(),
  accountCtx: vi.fn(),
  listSessions: vi.fn(),
  sessionGet: vi.fn(),
  sessionInvalidate: vi.fn(),
  sharded: vi.fn(),
  storeFor: vi.fn(),
  diagCreate: vi.fn(),
  diagToken: vi.fn(),
  diagDecision: vi.fn(),
  diagCleanup: vi.fn(),
  diagSession: vi.fn(),
  issuerUrl: vi.fn(),
  authCtx: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    recordReplayJti: m.replay,
    getLogger: () => ({
      module: (name: string) => {
        m.moduleNames.push(name);
        return m.log;
      },
    }),
    getTenantIdFromContext: (c: { get: (k: string) => unknown }) => c.get('tenantId'),
    createErrorResponse: (
      c: { json: (b: unknown, s: number) => Response },
      code: string,
      opts?: unknown
    ) => c.json({ code, opts }, code === 'internal' ? 500 : code === 'not_found' ? 404 : 400),
    AR_ERROR_CODES: {
      ...actual.AR_ERROR_CODES,
      ADMIN_RESOURCE_NOT_FOUND: 'not_found',
      VALIDATION_REQUIRED_FIELD: 'required',
      VALIDATION_INVALID_VALUE: 'invalid',
      INTERNAL_ERROR: 'internal',
    },
    safeFetchJson: m.safeFetchJson,
    createDiagnosticLoggerFromContext: m.diagCreate,
    getDiagnosticSessionId: m.diagSession,
    resolveAccountDataContextByIdentifier: m.accountCtx,
    listExternalProviderSessions: m.listSessions,
    isShardedSessionId: m.sharded,
    getSessionStoreBySessionId: m.storeFor,
    buildRequestIssuerUrl: m.issuerUrl,
    createAuthContextFromHono: m.authCtx,
    // the downstream send is covered in backchannel-logout-downstream.mutation.test.ts
    resolveLogoutIssuerWithRetry: async () => null,
    resolveLogoutConfig: async () => actual.DEFAULT_LOGOUT_CONFIG,
    resolveLogoutWebhookConfig: async () => null,
    resolveLogoutTargetsFromSessionClientStore: async () => null,
    reportLogoutTargetsUnavailable: async () => undefined,
    reportLogoutNotSent: async () => undefined,
  };
});
vi.mock('jose', () => ({ createLocalJWKSet: m.createLocalJWKSet, jwtVerify: m.jwtVerify }));
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: m.getProvider }));
vi.mock('../services/linked-identity-store', () => ({
  findLinkedIdentitiesByProviderSub: m.findLinked,
  updateLinkedIdentity: m.updateLinked,
}));

const PROVIDER = {
  id: 'provider-google',
  name: 'Google',
  issuer: 'https://accounts.google.com',
  clientId: 'client-123',
  jwksUri: 'https://accounts.google.com/jwks',
};
const ENV = { DB: {} } as never;
const EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const FLOW_HEADER = 'X-Authrim-Diagnostic-Flow-Id';

function claims(extra: Record<string, unknown> = {}) {
  return {
    iss: PROVIDER.issuer,
    aud: PROVIDER.clientId,
    iat: NOW_S,
    jti: 'jti-1',
    sub: 'sub-1',
    events: { [EVENT]: {} },
    ...extra,
  };
}
function session(extra: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    userId: 'user-a',
    data: {
      external_provider_id: PROVIDER.id,
      external_provider_sub: 'sub-1',
      external_provider_sid: 'sid-1',
    },
    ...extra,
  };
}
async function body(res: Response): Promise<Record<string, unknown>> {
  return rec(await res.json());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  vi.clearAllMocks();
  m.moduleNames.length = 0;
  m.getProvider.mockReset().mockResolvedValue(PROVIDER);
  m.findLinked.mockReset().mockResolvedValue([]);
  m.updateLinked.mockReset().mockResolvedValue(true);
  m.safeFetchJson.mockReset().mockResolvedValue({ keys: [] });
  m.createLocalJWKSet.mockReset().mockReturnValue('JWKS');
  m.jwtVerify.mockReset().mockResolvedValue({ payload: claims() });
  m.replay.mockReset().mockResolvedValue('recorded');
  m.accountCtx.mockReset().mockResolvedValue({ piiDb: { pii: 1 } });
  m.listSessions.mockReset().mockResolvedValue([{ sessionId: 's1' }]);
  m.sessionGet.mockReset().mockResolvedValue(session());
  m.sessionInvalidate.mockReset().mockResolvedValue(true);
  m.sharded.mockReset().mockReturnValue(true);
  m.storeFor.mockReset().mockReturnValue({
    stub: { getSessionRpc: m.sessionGet, invalidateSessionRpc: m.sessionInvalidate },
  });
  m.diagToken.mockReset().mockResolvedValue(undefined);
  m.diagDecision.mockReset().mockResolvedValue(undefined);
  m.diagCleanup.mockReset().mockResolvedValue(undefined);
  m.diagSession.mockReset().mockReturnValue('diag-session');
  m.diagCreate.mockReset().mockResolvedValue({
    logTokenValidation: m.diagToken,
    logAuthDecision: m.diagDecision,
    cleanup: m.diagCleanup,
  });
  m.issuerUrl.mockReset().mockReturnValue('https://op.example.com');
  m.authCtx.mockReset().mockReturnValue({ repositories: { sessionClient: {} } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('request gates', () => {
  it('answers 404 when the route has no provider parameter', async () => {
    const { response } = await postBackchannel(ENV, {
      route: '/auth/external/backchannel-logout',
      url: 'https://op.example.com/auth/external/backchannel-logout',
    });
    expect(response.status).toBe(404);
    expect((await body(response)).code).toBe('not_found');
    expect(m.getProvider).not.toHaveBeenCalled();
  });

  it('answers 404 and logs when the provider is unknown', async () => {
    m.getProvider.mockResolvedValue(null);
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(404);
    expect(m.getProvider).toHaveBeenCalledWith(ENV, 'google', TENANT);
    expect(m.log.error).toHaveBeenCalledWith('Backchannel logout: Provider not found', {
      providerIdOrSlug: 'google',
    });
    expect(m.diagCreate).not.toHaveBeenCalled();
  });

  it('opens the diagnostic log for the tenant and provider client', async () => {
    await postBackchannel(ENV);
    expect(m.diagCreate).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      clientId: 'client-123',
    });
  });

  it('continues, warning, when the diagnostic log cannot be opened', async () => {
    m.diagCreate.mockRejectedValue(new Error('no log'));
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(200);
    expect(m.log.warn).toHaveBeenCalledWith(
      'Failed to initialize backchannel logout diagnostic logging',
      { error: 'no log' }
    );
    m.diagCreate.mockRejectedValue('text');
    await postBackchannel(ENV);
    expect(m.log.warn).toHaveBeenLastCalledWith(
      'Failed to initialize backchannel logout diagnostic logging',
      { error: 'text' }
    );
  });

  it.each([
    ['a non-form content type', { contentType: 'application/json', body: '{}' }],
    ['no content type', { contentType: null, body: null }],
  ])('rejects %s and records why', async (_n, options) => {
    const { response } = await postBackchannel(ENV, options);
    expect(response.status).toBe(400);
    expect((await body(response)).code).toBe('invalid');
    expect(m.safeFetchJson).not.toHaveBeenCalled();
    const flowId = rec(m.diagToken.mock.calls[0]?.[0]).flowId;
    expect(m.diagToken).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      flowId,
      step: 'logout-token-validation',
      tokenType: 'logout_token',
      result: 'fail',
      errorMessage: 'invalid_content_type',
      details: { validation_error: 'invalid_content_type' },
    });
    expect(m.diagDecision).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      flowId,
      decision: 'deny',
      reason: 'backchannel_logout_rejected',
      flow: 'backchannel_logout',
      context: { validation_error: 'invalid_content_type' },
    });
  });

  it('accepts a form content type that carries a charset', async () => {
    const { response } = await postBackchannel(ENV, {
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    });
    expect(response.status).toBe(200);
  });

  it('asks for the logout_token field when it is missing or empty', async () => {
    for (const form of ['other=1', 'logout_token=']) {
      m.diagToken.mockClear();
      const { response } = await postBackchannel(ENV, { body: form });
      expect(response.status).toBe(400);
      const out = await body(response);
      expect(out).toEqual({ code: 'required', opts: { variables: { field: 'logout_token' } } });
      expect(argRec(m.diagToken).errorMessage).toBe('missing_logout_token');
    }
  });

  it('works without a diagnostic logger and swallows diagnostic write failures', async () => {
    m.diagCreate.mockResolvedValue(null);
    expect((await postBackchannel(ENV, { contentType: 'text/plain' })).response.status).toBe(400);
    expect((await postBackchannel(ENV, { body: 'x=1' })).response.status).toBe(400);
    expect((await postBackchannel(ENV)).response.status).toBe(200);

    m.diagCreate.mockResolvedValue({
      logTokenValidation: m.diagToken.mockRejectedValue(new Error('t-fail')),
      logAuthDecision: m.diagDecision.mockRejectedValue('d-fail'),
      cleanup: m.diagCleanup,
    });
    expect((await postBackchannel(ENV, { body: 'x=1' })).response.status).toBe(400);
    expect(m.log.warn).toHaveBeenCalledWith(
      'Failed to record backchannel logout diagnostic event',
      {
        operation: 'logout token validation rejection',
        error: 't-fail',
      }
    );
    expect(m.log.warn).toHaveBeenCalledWith(
      'Failed to record backchannel logout diagnostic event',
      {
        operation: 'backchannel logout rejection decision',
        error: 'd-fail',
      }
    );
  });
});

describe('logout token validation', () => {
  async function rejectedWith(payload: Record<string, unknown>, code: string) {
    for (const mock of [m.listSessions, m.log.error, m.diagToken, m.diagDecision]) mock.mockClear();
    m.jwtVerify.mockResolvedValue({ payload });
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(400);
    expect(m.listSessions).not.toHaveBeenCalled();
    expect(m.log.error).toHaveBeenCalledWith('Backchannel logout error', {
      errorName: 'Error',
      stage: 'token_validation',
    });
    expect(m.diagToken).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'fail',
        errorMessage: code,
        details: { validation_error: code },
      })
    );
    expect(m.diagDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', context: { validation_error: code } })
    );
  }

  it('fetches the configured JWKS with a bounded request', async () => {
    await postBackchannel(ENV);
    expect(m.safeFetchJson).toHaveBeenCalledWith('https://accounts.google.com/jwks', {
      timeoutMs: 5000,
      maxResponseSize: 256 * 1024,
    });
    expect(m.createLocalJWKSet).toHaveBeenCalledWith({ keys: [] });
  });

  it('falls back to the well-known JWKS location', async () => {
    m.getProvider.mockResolvedValue({ ...PROVIDER, jwksUri: undefined });
    await postBackchannel(ENV);
    expect(callArg(m.safeFetchJson, 0, 0)).toBe(
      'https://accounts.google.com/.well-known/jwks.json'
    );
  });

  it('reports a JWKS fetch failure without leaking it', async () => {
    m.safeFetchJson.mockRejectedValue(new Error('secret internal host'));
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('secret');
    expect(argRec(m.diagToken).errorMessage).toBe('jwks_fetch_failed');
  });

  it('verifies issuer, audience and the pinned algorithm', async () => {
    await postBackchannel(ENV);
    expect(m.jwtVerify).toHaveBeenCalledWith('signed.logout.token', 'JWKS', {
      issuer: PROVIDER.issuer,
      audience: PROVIDER.clientId,
      algorithms: ['RS256'],
    });
  });

  it.each([
    [{ idTokenSignedResponseAlg: 'ES256' }, 'ES256'],
    [{ idTokenSignedResponseAlg: '' }, 'RS256'],
    [{ idTokenSignedResponseAlg: 5 }, 'RS256'],
    [{}, 'RS256'],
    [undefined, 'RS256'],
  ])('pins the algorithm from the quirks %j to %s', async (quirks, alg) => {
    m.getProvider.mockResolvedValue({ ...PROVIDER, providerQuirks: quirks });
    await postBackchannel(ENV);
    expect(rec(callArg(m.jwtVerify, 0, 2)).algorithms).toEqual([alg]);
  });

  it('requires the back-channel logout event', async () => {
    await rejectedWith(claims({ events: undefined }), 'missing_logout_event');
    await rejectedWith(claims({ events: { 'other-event': {} } }), 'missing_logout_event');
  });

  it('requires a sub or a sid', async () => {
    await rejectedWith(claims({ sub: undefined }), 'missing_sub_or_sid');
    await rejectedWith(claims({ sub: '', sid: '' }), 'missing_sub_or_sid');
  });

  it('accepts a sid without a sub, and a sub without a sid', async () => {
    m.jwtVerify.mockResolvedValue({ payload: claims({ sub: undefined, sid: 'sid-1' }) });
    expect((await postBackchannel(ENV)).response.status).toBe(200);
    m.jwtVerify.mockResolvedValue({ payload: claims() });
    expect((await postBackchannel(ENV)).response.status).toBe(200);
  });

  it('refuses a nonce, but tolerates an undefined one', async () => {
    await rejectedWith(claims({ nonce: 'n' }), 'nonce_present');
    m.jwtVerify.mockResolvedValue({ payload: claims({ nonce: undefined }) });
    expect((await postBackchannel(ENV)).response.status).toBe(200);
  });

  it('requires a jti', async () => {
    await rejectedWith(claims({ jti: undefined }), 'missing_jti');
    await rejectedWith(claims({ jti: '' }), 'missing_jti');
  });

  it('accepts an iat exactly five minutes old and rejects one second older', async () => {
    m.jwtVerify.mockResolvedValue({ payload: claims({ iat: NOW_S - 300 }) });
    expect((await postBackchannel(ENV)).response.status).toBe(200);
    await rejectedWith(claims({ iat: NOW_S - 301 }), 'iat_too_old');
  });

  it('records the jti once per provider for the iat window plus a minute', async () => {
    await postBackchannel(ENV);
    expect(m.replay).toHaveBeenCalledWith(ENV, {
      tenantId: TENANT,
      shardKey: 'provider-google',
      jti: 'backchannel-logout:provider-google:jti-1',
      issuedAt: NOW_S,
      ttlSeconds: 360,
    });
  });

  it('refuses a replayed token', async () => {
    m.replay.mockResolvedValue('replayed');
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(400);
    expect(m.listSessions).not.toHaveBeenCalled();
    expect(argRec(m.diagToken).errorMessage).toBe('replay_detected');
  });

  it('names a non-Error rejection UnknownError in the log', async () => {
    m.jwtVerify.mockRejectedValue('weird');
    await postBackchannel(ENV);
    expect(m.log.error).toHaveBeenCalledWith('Backchannel logout error', {
      errorName: 'UnknownError',
      stage: 'token_validation',
    });
    expect(argRec(m.diagToken).errorMessage).toBe('signature_or_claim_validation_failed');
  });
});

describe('successful logout', () => {
  it('answers 200 with no body, no-store and the diagnostic flow id', async () => {
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const flow = response.headers.get(FLOW_HEADER);
    expect(flow).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec(m.diagToken.mock.calls[0]?.[0]).flowId).toBe(flow);
  });

  it('records the validation success and the allow decision', async () => {
    const { response } = await postBackchannel(ENV);
    const flowId = response.headers.get(FLOW_HEADER);
    expect(m.diagToken).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      flowId,
      step: 'logout-token-validation',
      tokenType: 'logout_token',
      token: 'signed.logout.token',
      result: 'pass',
      details: {
        issuer_valid: true,
        audience_valid: true,
        signature_valid: true,
        has_sub: true,
        has_sid: false,
        has_jti: true,
        nonce_absent: true,
      },
    });
    expect(m.diagDecision).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      flowId,
      decision: 'allow',
      reason: 'backchannel_logout_processed',
      flow: 'backchannel_logout',
      context: { identities_affected: 0, sessions_terminated: 1, downstream_logout_sessions: 1 },
    });
    expect(m.log.info).toHaveBeenCalledWith('Backchannel logout processed', {
      provider: 'Google',
      hasSub: true,
      hasSid: false,
      identitiesAffected: 0,
      sessionsTerminated: 1,
    });
    expect(m.diagCleanup).toHaveBeenCalledTimes(1);
  });

  it('reports a sid-only token in the diagnostics', async () => {
    m.jwtVerify.mockResolvedValue({ payload: claims({ sub: undefined, sid: 'sid-1' }) });
    await postBackchannel(ENV);
    expect(rec(argRec(m.diagToken).details)).toMatchObject({ has_sub: false, has_sid: true });
    expect(m.log.info).toHaveBeenCalledWith(
      'Backchannel logout processed',
      expect.objectContaining({ hasSub: false, hasSid: true })
    );
  });

  it('survives a failure while flushing the diagnostic log', async () => {
    m.diagCleanup.mockRejectedValue(new Error('flush'));
    expect((await postBackchannel(ENV)).response.status).toBe(200);
    expect(m.log.warn).toHaveBeenCalledWith('Failed to flush backchannel logout diagnostic logs', {
      error: 'flush',
    });
    m.diagCleanup.mockRejectedValue('flush-text');
    await postBackchannel(ENV);
    expect(m.log.warn).toHaveBeenLastCalledWith(
      'Failed to flush backchannel logout diagnostic logs',
      { error: 'flush-text' }
    );
  });

  it('survives write failures for the success diagnostics', async () => {
    m.diagToken.mockRejectedValue(new Error('x'));
    m.diagDecision.mockRejectedValue(new Error('y'));
    expect((await postBackchannel(ENV)).response.status).toBe(200);
    const ops = m.log.warn.mock.calls.map((c) => rec(c[1]).operation);
    expect(ops).toEqual(['logout token validation success', 'backchannel logout success decision']);
  });
});

describe('session and identity invalidation', () => {
  it('resolves the routed account of the subject and clears its linked identity tokens', async () => {
    m.findLinked.mockResolvedValue([
      { id: 'l1', tenantId: 't-1' },
      { id: 'l2', tenantId: 't-2' },
    ]);
    await postBackchannel(ENV);
    expect(m.accountCtx).toHaveBeenCalledWith(ENV, {
      tenantId: TENANT,
      indexKind: 'external_subject',
      identifier: { issuer: 'provider-google', subject: 'sub-1' },
    });
    expect(m.findLinked).toHaveBeenCalledWith(ENV, TENANT, 'provider-google', 'sub-1', {
      pii: 1,
    });
    expect(m.updateLinked.mock.calls).toEqual([
      [ENV, 't-1', 'l1', { clearTokens: true }, { pii: 1 }],
      [ENV, 't-2', 'l2', { clearTokens: true }, { pii: 1 }],
    ]);
    expect(m.log.info).toHaveBeenCalledWith(
      'Backchannel logout processed',
      expect.objectContaining({ identitiesAffected: 2 })
    );
  });

  it('skips the identity step for a sid-only token', async () => {
    m.jwtVerify.mockResolvedValue({ payload: claims({ sub: undefined, sid: 'sid-1' }) });
    await postBackchannel(ENV);
    expect(m.accountCtx).not.toHaveBeenCalled();
  });

  it('treats an unrouted subject as having no linked identity', async () => {
    m.accountCtx.mockRejectedValue(new Error('account_data_route_not_found'));
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(200);
    expect(m.findLinked).not.toHaveBeenCalled();
    expect(m.updateLinked).not.toHaveBeenCalled();
    expect(m.listSessions).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('route lookup failed'), 'account_data_route_not_found'])(
    'fails the logout when the account lookup fails with %s',
    async (error) => {
      m.accountCtx.mockRejectedValue(error);
      const { response } = await postBackchannel(ENV);
      expect(response.status).toBe(500);
      expect(m.log.error).toHaveBeenCalledWith('Backchannel logout error', {
        errorName: error instanceof Error ? 'Error' : 'UnknownError',
        stage: 'session_invalidation',
      });
      expect(m.listSessions).not.toHaveBeenCalled();
    }
  );

  it('lists sessions by sub for a sub-only token and ends them', async () => {
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(200);
    expect(m.listSessions).toHaveBeenCalledWith(ENV, {
      tenantId: TENANT,
      providerId: 'provider-google',
      claimKind: 'sub',
      claim: 'sub-1',
    });
    expect(m.storeFor).toHaveBeenCalledWith(ENV, 's1', TENANT);
    expect(m.sessionGet).toHaveBeenCalledWith('s1');
    expect(m.sessionInvalidate).toHaveBeenCalledWith('s1');
  });

  it('lets the sid take precedence over the sub', async () => {
    m.jwtVerify.mockResolvedValue({ payload: claims({ sid: 'sid-1' }) });
    await postBackchannel(ENV);
    expect(callArg(m.listSessions, 0, 1)).toEqual({
      tenantId: TENANT,
      providerId: 'provider-google',
      claimKind: 'sid',
      claim: 'sid-1',
    });
    expect(m.updateLinked).not.toHaveBeenCalled();
  });

  it.each([
    ['a session that is not sharded', () => m.sharded.mockReturnValue(false)],
    ['a vanished session', () => m.sessionGet.mockResolvedValue(null)],
    ['another tenant', () => m.sessionGet.mockResolvedValue(session({ tenantId: 'other-tenant' }))],
    [
      'another provider',
      () =>
        m.sessionGet.mockResolvedValue(
          session({ data: { external_provider_id: 'other', external_provider_sub: 'sub-1' } })
        ),
    ],
    [
      'another subject',
      () =>
        m.sessionGet.mockResolvedValue(
          session({
            data: { external_provider_id: PROVIDER.id, external_provider_sub: 'someone-else' },
          })
        ),
    ],
    ['a session without data', () => m.sessionGet.mockResolvedValue(session({ data: undefined }))],
  ])('leaves %s alone', async (_n, arrange) => {
    arrange();
    const { response, waited } = await postBackchannel(ENV);
    expect(response.status).toBe(200);
    expect(m.sessionInvalidate).not.toHaveBeenCalled();
    expect(waited).toHaveLength(0);
  });

  it('matches a sid-token against the session sid, not its sub', async () => {
    m.jwtVerify.mockResolvedValue({ payload: claims({ sub: undefined, sid: 'sid-1' }) });
    m.sessionGet.mockResolvedValue(
      session({
        data: {
          external_provider_id: PROVIDER.id,
          external_provider_sub: 'sid-1',
          external_provider_sid: 'other-sid',
        },
      })
    );
    await postBackchannel(ENV);
    expect(m.sessionInvalidate).not.toHaveBeenCalled();
  });

  it('answers 500 when a session cannot be ended, but still ends and reports the others', async () => {
    m.listSessions.mockResolvedValue([
      { sessionId: 's1' },
      { sessionId: 's2' },
      { sessionId: 's3' },
    ]);
    m.sessionInvalidate
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('do down'));
    const { response, waited } = await postBackchannel(ENV);
    expect(response.status).toBe(500);
    expect(m.sessionInvalidate).toHaveBeenCalledTimes(3);
    expect(m.log.warn).toHaveBeenCalledWith('Failed to terminate a back-channel logout session');
    expect(m.log.error).toHaveBeenCalledWith('Backchannel logout error', {
      errorName: 'Error',
      stage: 'session_invalidation',
    });
    // a failure after validation is not reported as a token failure
    expect(m.diagToken).not.toHaveBeenCalledWith(expect.objectContaining({ result: 'fail' }));
    expect(m.diagDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'deny',
        context: { validation_error: 'session_invalidation_failed', downstream_logout_sessions: 1 },
      })
    );
    expect(waited).toHaveLength(1);
  });

  it('keeps an unvalidated failure out of the downstream count', async () => {
    m.jwtVerify.mockRejectedValue(new Error('bad'));
    await postBackchannel(ENV);
    expect(rec(argRec(m.diagDecision).context)).not.toHaveProperty('downstream_logout_sessions');
  });
});

describe('scheduling the downstream logout', () => {
  it('hands the downstream work to the execution context', async () => {
    const { waited } = await postBackchannel(ENV);
    expect(waited).toHaveLength(1);
    expect(m.issuerUrl).toHaveBeenCalledWith(expect.any(Request), ENV, TENANT);
    expect(m.authCtx).toHaveBeenCalledWith(expect.anything(), TENANT);
    await Promise.all(waited);
  });

  it('warns when there is no execution context', async () => {
    const { response, waited } = await postBackchannel(ENV, { withExecutionContext: false });
    expect(response.status).toBe(200);
    expect(waited).toHaveLength(0);
    expect(m.log.warn).toHaveBeenCalledWith('Downstream logout not sent: no execution context', {
      upstreamFlowId: response.headers.get(FLOW_HEADER),
    });
    expect(m.issuerUrl).not.toHaveBeenCalled();
  });

  it('logs when the downstream work cannot be prepared', async () => {
    m.issuerUrl.mockImplementation(() => {
      throw new Error('no issuer');
    });
    const { response, waited } = await postBackchannel(ENV);
    expect(response.status).toBe(200);
    expect(waited).toHaveLength(0);
    expect(m.log.error).toHaveBeenCalledWith('Downstream logout not sent', {
      upstreamFlowId: response.headers.get(FLOW_HEADER),
      error: 'no issuer',
    });
    m.issuerUrl.mockImplementation(() => {
      throwValue('plain');
    });
    await postBackchannel(ENV);
    expect(m.log.error).toHaveBeenLastCalledWith(
      'Downstream logout not sent',
      expect.objectContaining({ error: 'plain' })
    );
  });

  it('schedules nothing when no session ended', async () => {
    m.listSessions.mockResolvedValue([]);
    const { waited } = await postBackchannel(ENV);
    expect(waited).toHaveLength(0);
    expect(m.authCtx).not.toHaveBeenCalled();
  });
});

describe('response headers and logger', () => {
  it('logs under the BACKCHANNEL-LOGOUT module', async () => {
    await postBackchannel(ENV);
    expect(m.moduleNames).toEqual(['BACKCHANNEL-LOGOUT']);
  });

  it('keeps no-store and the flow id on error answers too', async () => {
    m.jwtVerify.mockRejectedValue(new Error('bad'));
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get(FLOW_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers a rejected token without a diagnostic logger', async () => {
    m.diagCreate.mockResolvedValue(null);
    m.jwtVerify.mockRejectedValue(new Error('bad'));
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(400);
    m.listSessions.mockRejectedValue(new Error('store'));
    m.jwtVerify.mockResolvedValue({ payload: claims() });
    expect((await postBackchannel(ENV)).response.status).toBe(500);
  });

  it('survives write failures while recording a rejected token', async () => {
    m.diagToken.mockRejectedValue(new Error('t'));
    m.diagDecision.mockRejectedValue(new Error('d'));
    m.jwtVerify.mockRejectedValue(new Error('bad'));
    expect((await postBackchannel(ENV)).response.status).toBe(400);
    const ops = m.log.warn.mock.calls.map((c) => rec(c[1]).operation);
    expect(ops).toEqual([
      'logout token validation rejection',
      'backchannel logout rejection decision',
    ]);
  });

  it('records a post-validation failure with its own labels', async () => {
    m.listSessions.mockRejectedValue(new Error('store'));
    const { response } = await postBackchannel(ENV);
    expect(response.status).toBe(500);
    expect(m.diagDecision).toHaveBeenCalledWith({
      diagnosticSessionId: 'diag-session',
      flowId: response.headers.get(FLOW_HEADER),
      decision: 'deny',
      reason: 'backchannel_logout_rejected',
      flow: 'backchannel_logout',
      context: { validation_error: 'session_invalidation_failed', downstream_logout_sessions: 0 },
    });
    m.diagDecision.mockRejectedValue(new Error('d'));
    await postBackchannel(ENV);
    expect(m.log.warn).toHaveBeenCalledWith(
      'Failed to record backchannel logout diagnostic event',
      {
        operation: 'backchannel logout rejection decision',
        error: 'd',
      }
    );
  });

  it('warns, not crashes, when the execution context is undefined', async () => {
    const { Hono } = await import('hono');
    const { handleBackchannelLogout } = await import('../handlers/backchannel-logout');
    const app = new Hono<{ Bindings: never }>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, TENANT);
      Object.defineProperty(c, 'executionCtx', { get: () => undefined });
      await next();
    });
    app.post('/auth/external/:provider/backchannel-logout', handleBackchannelLogout);
    const res = await app.request(
      'https://op.example.com/auth/external/google/backchannel-logout',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'logout_token=t',
      },
      ENV
    );
    expect(res.status).toBe(200);
    expect(m.log.warn).toHaveBeenCalledWith(
      'Downstream logout not sent: no execution context',
      expect.anything()
    );
    expect(m.log.error).not.toHaveBeenCalledWith('Downstream logout not sent', expect.anything());
  });
});

describe('classifyBackchannelLogoutError', () => {
  const jose = (code: string, claim?: string) => Object.assign(new Error('x'), { code, claim });
  it.each([
    [new Error('Failed to fetch provider JWKS'), 'jwks_fetch_failed'],
    [new Error('Logout token missing backchannel-logout event'), 'missing_logout_event'],
    [new Error('Logout token must contain either sub or sid claim'), 'missing_sub_or_sid'],
    [new Error('Logout token MUST NOT contain nonce claim'), 'nonce_present'],
    [new Error('Logout token missing jti claim'), 'missing_jti'],
    [new Error('Logout token is too old'), 'iat_too_old'],
    [new Error('Logout token replay detected'), 'replay_detected'],
    [jose('ERR_JOSE_ALG_NOT_ALLOWED'), 'unexpected_signing_algorithm'],
    [jose('ERR_JWS_SIGNATURE_VERIFICATION_FAILED'), 'invalid_signature'],
    [jose('ERR_JWKS_NO_MATCHING_KEY'), 'signing_key_not_found'],
    [jose('ERR_JWS_INVALID'), 'malformed_logout_token'],
    [jose('ERR_JWT_INVALID'), 'malformed_logout_token'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'iss'), 'issuer_mismatch'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'aud'), 'audience_mismatch'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'iat'), 'invalid_iat'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', 'exp'), 'expired_token'],
    [jose('ERR_JWT_EXPIRED', 'exp'), 'expired_token'],
    [jose('ERR_JWT_EXPIRED', 'other'), 'claim_validation_failed'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED'), 'claim_validation_failed'],
    [jose('ERR_JWT_CLAIM_VALIDATION_FAILED', '5'), 'claim_validation_failed'],
    [jose('ERR_OTHER'), 'signature_or_claim_validation_failed'],
    [new Error('unknown'), 'signature_or_claim_validation_failed'],
    [
      Object.assign(new Error('x'), { code: 5, claim: 'iss' }),
      'signature_or_claim_validation_failed',
    ],
    [
      Object.assign(new Error('x'), { code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 5 }),
      'claim_validation_failed',
    ],
    [undefined, 'signature_or_claim_validation_failed'],
    [null, 'signature_or_claim_validation_failed'],
    ['Logout token is too old', 'signature_or_claim_validation_failed'],
  ])('classifies %s as %s', (error, expected) => {
    expect(classifyBackchannelLogoutError(error)).toBe(expected);
  });
});
