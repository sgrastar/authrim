import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChallengeRpc: vi.fn(),
  getWebOriginRegistry: vi.fn(),
  isIframeOidcAuthEnabled: vi.fn(),
  resolveSource: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getChallengeStoreByChallengeId: vi.fn(async () => ({ getChallengeRpc: mocks.getChallengeRpc })),
    resolveAuthCorePersistenceAdapterFromEnv: mocks.resolveSource,
    getWebOriginRegistry: mocks.getWebOriginRegistry,
    isIframeOidcAuthEnabled: mocks.isIframeOidcAuthEnabled,
    getLogger: () => ({ module: () => ({ error: mocks.logError }) }),
  };
});

import { loginChallengeGetHandler } from '../login-challenge';

function context(challengeId: string | undefined = 'challenge_1') {
  return {
    req: { query: (name: string) => (name === 'challenge_id' ? challengeId : undefined) },
    env: { DB: 'db' },
    get: (key: string) => (key === 'tenantId' ? 'default' : undefined),
    json: (payload: unknown, status = 200) => Response.json(payload, { status }),
  };
}

async function load(metadata: Record<string, unknown> | undefined, type = 'login') {
  mocks.getChallengeRpc.mockResolvedValue({ id: 'challenge_1', type, userId: 'u', metadata });
  const response = await loginChallengeGetHandler(context() as never);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

beforeEach(() => {
  mocks.getChallengeRpc.mockReset();
  mocks.getWebOriginRegistry.mockReset().mockResolvedValue({ origins: [] });
  mocks.isIframeOidcAuthEnabled.mockReset().mockResolvedValue(false);
  mocks.resolveSource.mockReset().mockResolvedValue('source');
  mocks.logError.mockReset();
});

describe('login challenge request errors', () => {
  it('requires a challenge id', async () => {
    const response = await loginChallengeGetHandler(context('') as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Missing challenge_id parameter',
    });
    expect(mocks.getChallengeRpc).not.toHaveBeenCalled();
  });

  it('refuses an unknown challenge', async () => {
    mocks.getChallengeRpc.mockResolvedValue(null);
    const response = await loginChallengeGetHandler(context() as never);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_request',
      error_description: 'Invalid or expired challenge',
    });
  });

  it('refuses a challenge of another type', async () => {
    expect(await load({ client_id: 'rp' }, 'consent')).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Invalid challenge type' },
    });
  });

  it('serves a re-authentication challenge like a login challenge', async () => {
    expect((await load({ client_id: 'rp' }, 'reauth')).status).toBe(200);
  });

  it('refuses a challenge without a client', async () => {
    for (const metadata of [undefined, {}]) {
      expect(await load(metadata)).toEqual({
        status: 400,
        body: { error: 'invalid_request', error_description: 'Challenge is missing client_id' },
      });
    }
  });

  it('refuses a SAML challenge that is not a re-authentication with the generic error', async () => {
    const result = await load(
      {
        protocol: 'saml',
        saml_request_id: '_r',
        saml_sp_entity_id: 'https://sp.example',
        tenant_id: 'default',
      },
      'login'
    );
    expect(result).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Invalid or expired challenge' },
    });
  });

  it('answers a store failure with server_error and logs it', async () => {
    const failure = new Error('store down');
    mocks.getChallengeRpc.mockRejectedValue(failure);
    const response = await loginChallengeGetHandler(context() as never);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: 'Failed to retrieve login challenge data',
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      'Login challenge get error',
      { action: 'get_challenge' },
      failure
    );
  });
});

describe('login challenge session and handoff metadata', () => {
  it.each([
    ['cookie_session', 'cookie_session', ['cookie_session_finalize']],
    ['token_session', 'token_session', ['dpop_token_verify']],
    ['managed_browser_session', 'managed_browser_session', ['cookie_session_finalize']],
    ['bogus', 'managed_browser_session', ['cookie_session_finalize']],
  ])('maps session mode %s', async (mode, sessionMode, handoff) => {
    const { body } = await load({ client_id: 'rp', session_mode: mode, handoff_methods: 'x' });
    expect(body.session_mode).toBe(sessionMode);
    expect(body.handoff_methods).toEqual(handoff);
  });

  it('keeps only known handoff methods, once each', async () => {
    const { body } = await load({
      client_id: 'rp',
      session_mode: 'cookie_session',
      handoff_methods: [
        'dpop_token_verify',
        'magic',
        'dpop_token_verify',
        'cookie_session_finalize',
      ],
    });
    expect(body.handoff_methods).toEqual(['dpop_token_verify', 'cookie_session_finalize']);
  });

  it('falls back to the session default when no listed method is known', async () => {
    const { body } = await load({
      client_id: 'rp',
      session_mode: 'token_session',
      handoff_methods: ['magic'],
    });
    expect(body.handoff_methods).toEqual(['dpop_token_verify']);
  });

  it('uses the client id as the name when none is stored', async () => {
    const { body } = await load({ client_id: 'rp', logo_uri: 'https://rp/logo.png' });
    expect(body.client).toEqual({
      client_id: 'rp',
      client_name: 'rp',
      logo_uri: 'https://rp/logo.png',
    });
  });
});

describe('login challenge OIDC metadata', () => {
  it('omits the OIDC block when the request has no OIDC parameters', async () => {
    const { body } = await load({ client_id: 'rp', max_age: 'abc', acr_values: '   ' });
    expect(body.oidc).toBeUndefined();
  });

  it.each([
    [{ prompt: 'login' }, { prompt: 'login', nonce_present: false, claims_present: false }],
    [{ max_age: '0' }, { max_age: 0, nonce_present: false, claims_present: false }],
    [
      { acr_values: ' a  b ' },
      { acr_values: ['a', 'b'], nonce_present: false, claims_present: false },
    ],
    [{ nonce: 'n' }, { nonce_present: true, claims_present: false }],
    [{ claims: null }, { nonce_present: false, claims_present: true }],
  ])('reports %j', async (extra, oidc) => {
    const { body } = await load({ client_id: 'rp', ...extra });
    expect(body.oidc).toEqual(oidc);
  });
});

describe('login challenge web origins', () => {
  it('reads the registry of the client and applies the iframe policy', async () => {
    mocks.isIframeOidcAuthEnabled.mockResolvedValue(true);
    mocks.getWebOriginRegistry.mockResolvedValue({
      origins: [
        { origin: 'https://a', csp: { frame_ancestors: ['https://a'] }, iframe_allowed: true },
        { origin: 'https://b', csp: { frame_ancestors: ['https://b'] }, iframe_allowed: 'yes' },
      ],
    });
    const { body } = await load({ client_id: 'rp' });
    expect(mocks.resolveSource).toHaveBeenCalledWith(
      expect.anything(),
      'login-challenge-web-origin-registry',
      { tenantId: 'default' }
    );
    expect(mocks.getWebOriginRegistry).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      'rp',
      'source'
    );
    expect(body.web_origin_registry).toEqual({
      origins: [
        { origin: 'https://a', csp: { frame_ancestors: ['https://a'] }, iframe_allowed: true },
        { origin: 'https://b', csp: {}, iframe_allowed: false },
      ],
    });
  });

  it('falls back to the challenge snapshot when the registry read fails', async () => {
    mocks.getWebOriginRegistry.mockRejectedValue(new Error('down'));
    const { status, body } = await load({
      client_id: 'rp',
      allowed_redirect_origins: ['https://x.example/path'],
    });
    expect(status).toBe(200);
    expect(body.web_origin_registry).toEqual({
      origins: [
        {
          origin: 'https://x.example',
          client_ids: ['rp'],
          cors: { allowed: true },
          csp: {},
          handoff_allowed: true,
          iframe_allowed: false,
        },
      ],
    });
  });

  it('frames only an iframe-allowed snapshot when the tenant enables iframes', async () => {
    mocks.isIframeOidcAuthEnabled.mockResolvedValue(true);
    const allowed = await load({
      client_id: 'rp',
      redirect_uri: 'https://app.example/cb',
      iframe_allowed: true,
    });
    expect(allowed.body.web_origin_registry).toMatchObject({
      origins: [
        {
          origin: 'https://app.example',
          csp: { frame_ancestors: ['https://app.example'] },
          iframe_allowed: true,
        },
      ],
    });
    const notAllowed = await load({ client_id: 'rp', redirect_uri: 'https://app.example/cb' });
    expect(notAllowed.body.web_origin_registry).toMatchObject({
      origins: [{ origin: 'https://app.example', csp: {}, iframe_allowed: false }],
    });
  });

  it('ignores an unparseable redirect uri and non-string snapshot origins', async () => {
    const { body } = await load({
      client_id: 'rp',
      redirect_uri: 'not a url',
      allowed_redirect_origins: [42, 'https://ok.example'],
    });
    expect(
      (body.web_origin_registry as { origins: Array<{ origin: string }> }).origins.map(
        (o) => o.origin
      )
    ).toEqual(['https://ok.example']);
  });
});
