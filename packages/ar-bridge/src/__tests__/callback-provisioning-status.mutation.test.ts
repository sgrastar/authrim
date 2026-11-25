import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callArg, rec } from './helpers/mock-args';
import {
  NOW,
  TENANT,
  TOKEN,
  runProvisioning,
  type Continuation,
  type FixtureOptions,
} from './helpers/provisioning-fixture';

const mocks = vi.hoisted(() => ({
  getChallengeStore: vi.fn(),
  schedule: vi.fn(),
  resolveCore: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getChallengeStoreByChallengeId: mocks.getChallengeStore,
  scheduleSignInAttemptFailureRecord: mocks.schedule,
  resolveAuthCorePersistenceAdapterFromEnv: mocks.resolveCore,
  getLogger: () => ({
    module: () => ({ warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));
vi.mock('../services/identity-stitching', () => ({
  completeExternalIdpJIT: vi.fn(),
  handleIdentity: vi.fn(),
}));
vi.mock('../services/signup-invitation', () => ({
  applyExternalSignupInvitation: vi.fn(),
  externalSignupInvitationRequirement: vi.fn(),
  releaseExternalSignupInvitation: vi.fn(),
}));
vi.mock('../services/provider-store', () => ({ getProviderByIdOrSlug: vi.fn() }));

const status = (options: FixtureOptions = {}) => runProvisioning(mocks, options);
const INVALID = { error: 'invalid_or_expired_provisioning_continuation' };

async function rejected(options: FixtureOptions) {
  const { response, getStatus, consume } = await status(options);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(INVALID);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(consume).not.toHaveBeenCalled();
  return { getStatus };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the request', () => {
  it('answers the pending operation and nothing else', async () => {
    const { response, getStatus, store } = await status();
    expect(response.status).toBe(202);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'pending', retry_after_ms: 500 });
    expect(getStatus).toHaveBeenCalledWith({
      schemaVersion: 1,
      tenantId: TENANT,
      operationId: 'account-create-operation-a',
      flow: 'external_idp',
    });
    expect(store.getChallengeRpc).toHaveBeenCalledTimes(1);
    expect(mocks.getChallengeStore).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^external_idp_provisioning:[0-9a-f]{64}$/),
      TENANT
    );
  });

  it('accepts a request of exactly 4096 bytes and refuses one of 4097', async () => {
    // two keys exactly: the padding goes into the token's whitespace instead
    const body = (size: number) => {
      const core = JSON.stringify({ provisioning_token: TOKEN, tenant_id: TENANT });
      return core.slice(0, -1) + ' '.repeat(size - core.length) + '}';
    };
    expect(new TextEncoder().encode(body(4096)).byteLength).toBe(4096);
    expect((await status({ rawBody: body(4096) })).response.status).toBe(202);
    await rejected({ rawBody: body(4097) });
  });

  it.each([
    ['not JSON', '{nope'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['an array', '[]'],
    ['an extra field', JSON.stringify({ provisioning_token: TOKEN, tenant_id: TENANT, x: 1 })],
    ['a missing tenant', JSON.stringify({ provisioning_token: TOKEN })],
    ['another field instead of the token', JSON.stringify({ other: TOKEN, tenant_id: TENANT })],
    [
      'another field instead of the tenant',
      JSON.stringify({ provisioning_token: TOKEN, tenant: TENANT }),
    ],
    ['a numeric token', JSON.stringify({ provisioning_token: 5, tenant_id: TENANT })],
    ['a numeric tenant', JSON.stringify({ provisioning_token: TOKEN, tenant_id: 5 })],
  ])('refuses a body that is %s, before reading anything', async (_n, rawBody) => {
    const { getStatus } = await rejected({ rawBody });
    expect(getStatus).not.toHaveBeenCalled();
    expect(mocks.getChallengeStore).not.toHaveBeenCalled();
  });

  it.each([
    ['a short token', { token: 'A'.repeat(42) }],
    ['a long token', { token: 'A'.repeat(44) }],
    ['a token with other characters', { token: `${'A'.repeat(42)}+` }],
    ['an empty tenant', { tenant: '' }],
    ['an unsafe tenant', { tenant: '-tenant' }],
    ['a tenant with a space', { tenant: 'tenant a' }],
    ['a tenant over 256 characters', { tenant: `a${'b'.repeat(256)}` }],
  ])('refuses %s before any lookup', async (_n, extra) => {
    const rawBody = JSON.stringify({
      provisioning_token: (extra as { token?: string }).token ?? TOKEN,
      tenant_id: (extra as { tenant?: string }).tenant ?? TENANT,
    });
    await rejected({ rawBody });
    expect(mocks.getChallengeStore).not.toHaveBeenCalled();
  });

  it('refuses a request that does not carry the browser binding cookie', async () => {
    for (const cookie of ['none', 'wrong'] as const) {
      const { getStatus } = await rejected({ cookie });
      expect(getStatus).not.toHaveBeenCalled();
    }
    expect(mocks.getChallengeStore).not.toHaveBeenCalled();
  });
});

describe('the stored challenge', () => {
  it.each([
    ['none stored', null],
    ['another type', { type: 'direct_auth_code' }],
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another digest', { challenge: 'f'.repeat(64) }],
    ['a consumed challenge', { consumed: true }],
    ['an expired challenge', { expiresAt: NOW }],
    ['a long-expired challenge', { expiresAt: NOW - 1 }],
    ['no payload', { metadata: {} }],
    ['no metadata', { metadata: undefined }],
    ['a payload that is not text', { metadata: { encrypted_payload: 5 } }],
    ['another user than the continuation', { userId: 'user-b' }],
  ])('refuses %s', async (_n, challenge) => {
    const { getStatus } = await rejected({ challenge });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('accepts a challenge that expires in the next millisecond', async () => {
    const { response } = await status({ challenge: { expiresAt: NOW + 1 } });
    expect(response.status).toBe(202);
  });

  it('refuses when the encryption key is not configured', async () => {
    await rejected({ env: { RP_TOKEN_ENCRYPTION_KEY: undefined } });
  });

  it('refuses a continuation made for another tenant than the request names', async () => {
    await rejected({ mutate: (c) => void (c.authState.tenantId = 'tenant-b') });
  });

  it('refuses when the provisioner is not bound', async () => {
    await rejected({ env: { EXTERNAL_IDP_ACCOUNT_PROVISIONER: undefined } });
  });
});

describe('the stored continuation', () => {
  const long = (n: number) => 'x'.repeat(n);
  const set = (mutate: (c: Continuation) => void): FixtureOptions => ({ mutate });

  it.each<[string, FixtureOptions]>([
    ['text that is not JSON', { payloadText: '{nope' }],
    ['JSON null', { payloadText: 'null' }],
    ['a JSON array', { payloadText: '[]' }],
    ['a JSON string', { payloadText: '"x"' }],
    ['another schema version', set((c) => void (c.schemaVersion = 2))],
    ['no auth state', set((c) => void delete (c as Record<string, unknown>).authState)],
    ['no result', set((c) => void delete (c as Record<string, unknown>).result)],
    ['no user info', set((c) => void delete (c as Record<string, unknown>).userInfo)],
    ['a result that is not pending', set((c) => void (c.result.status = 'ready'))],
    ['a result for an existing user', set((c) => void (c.result.isNewUser = false))],
    ['a stitched result', set((c) => void (c.result.stitchedFromExisting = true))],
    ['a result with no stitched flag', set((c) => void delete c.result.stitchedFromExisting)],
    ['no auth state id', set((c) => void (c.authState.id = ''))],
    ['an auth state id over 256', set((c) => void (c.authState.id = long(257)))],
    ['no auth state tenant', set((c) => void (c.authState.tenantId = ''))],
    ['an unsafe auth state tenant', set((c) => void (c.authState.tenantId = '-x'))],
    ['an auth state provider over 256', set((c) => void (c.authState.providerId = long(257)))],
    ['no auth state', set((c) => void (c.authState.state = ''))],
    ['an auth state over 2048', set((c) => void (c.authState.state = long(2049)))],
    ['no redirect uri', set((c) => void (c.authState.redirectUri = ''))],
    [
      'a redirect uri over 4096',
      set((c) => void (c.authState.redirectUri = `https://a.example/${long(4100)}`)),
    ],
    ['no client id', set((c) => void (c.authState.clientId = ''))],
    ['a client id over 256', set((c) => void (c.authState.clientId = long(257)))],
    ['no code challenge', set((c) => void (c.authState.codeChallenge = ''))],
    ['a code challenge over 2048', set((c) => void (c.authState.codeChallenge = long(2049)))],
    ['a fractional expiry', set((c) => void (c.authState.expiresAt = 1.5))],
    ['a text expiry', set((c) => void (c.authState.expiresAt = '1'))],
    ['a fractional creation time', set((c) => void (c.authState.createdAt = 1.5))],
    ['no creation time', set((c) => void delete c.authState.createdAt)],
    ['no provider id', set((c) => void (c.providerId = ''))],
    ['a provider id over 256', set((c) => void (c.providerId = long(257)))],
    ['a provider other than the auth state', set((c) => void (c.providerId = 'provider-b'))],
    ['no subject', set((c) => void (c.userInfo.sub = ''))],
    ['a subject over 2048', set((c) => void (c.userInfo.sub = long(2049)))],
    ['no user id', set((c) => void (c.result.userId = ''))],
    ['a user id over 256', set((c) => void (c.result.userId = long(257)))],
    ['no account id', set((c) => void (c.result.accountId = ''))],
    ['an account of another user', set((c) => void (c.result.accountId = 'account:user-b'))],
    ['no operation id', set((c) => void (c.result.operationId = ''))],
    ['an operation id over 256', set((c) => void (c.result.operationId = long(257)))],
    ['no result provider', set((c) => void (c.result.providerId = ''))],
    [
      'a result provider other than the continuation',
      set((c) => void (c.result.providerId = 'provider-b')),
    ],
    ['no result subject', set((c) => void (c.result.providerUserId = ''))],
    [
      'a result subject other than the user info',
      set((c) => void (c.result.providerUserId = 'someone')),
    ],
    ['an empty upstream acr', set((c) => void (c.upstreamAcr = ''))],
    ['an upstream acr over 1024', set((c) => void (c.upstreamAcr = long(1025)))],
    ['an upstream acr that is not text', set((c) => void (c.upstreamAcr = 5))],
    ['an empty invitation id', set((c) => void (c.authState.inviteId = ''))],
    ['an invitation id over 256', set((c) => void (c.authState.inviteId = long(257)))],
    ['an empty reservation id', set((c) => void (c.authState.inviteReservationId = ''))],
    ['a reservation id over 256', set((c) => void (c.authState.inviteReservationId = long(257)))],
  ])('refuses %s', async (_n, options) => {
    const { getStatus } = await rejected(options);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it.each<[string, FixtureOptions]>([
    [
      'values at their size limits',
      set((c) => {
        c.authState.id = long(256);
        c.authState.tenantId = TENANT;
        c.authState.state = long(2048);
        c.authState.codeChallenge = long(2048);
        c.authState.clientId = long(256);
        c.authState.redirectUri = `https://a.example/${long(4096 - 'https://a.example/'.length)}`;
        c.userInfo.sub = long(2048);
        c.result.providerUserId = long(2048);
        c.upstreamAcr = long(1024);
        c.authState.inviteId = long(256);
        c.authState.inviteReservationId = long(256);
      }),
    ],
    ['no upstream acr', set((c) => void delete c.upstreamAcr)],
    ['no invitation', {}],
  ])('accepts %s', async (_n, options) => {
    const { response } = await status(options);
    expect(response.status).toBe(202);
  });
});

describe('what the provisioner reports', () => {
  it.each([
    ['another operation', { operationId: 'other' }],
    ['another account', { accountId: 'account:other' }],
    ['another user', { userId: 'other' }],
  ])('refuses an answer for %s, consuming nothing', async (_n, override) => {
    for (const state of ['pending', 'ready', 'failed']) {
      await rejected({ status: { status: state, ...override } });
    }
  });

  it('answers a ready account with the URL to resume at, with the token and tenant encoded', async () => {
    const { response } = await status({ status: { status: 'ready' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      status: 'ready',
      resume_url: `/auth/external/provisioning/resume?token=${TOKEN}&tenant=${TENANT}`,
    });
  });

  it('encodes a tenant that needs it', async () => {
    const { response } = await status({
      tenant: 'tenant:a.b',
      status: { status: 'ready' },
      mutate: (c) => void (c.authState.tenantId = 'tenant:a.b'),
      challenge: { tenantId: 'tenant:a.b' },
    });
    expect(rec(await response.json()).resume_url).toContain('&tenant=tenant%3Aa.b');
  });

  it('keeps a pending account pending', async () => {
    const { response, consume } = await status({ status: { status: 'pending' } });
    expect(response.status).toBe(202);
    expect(consume).not.toHaveBeenCalled();
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  describe('a failed operation', () => {
    const withAttempt = (extra: Record<string, unknown> = {}): FixtureOptions => ({
      status: { status: 'failed' },
      mutate: (c) => {
        c.authState.attemptInteractionId = 'interaction-1';
        Object.assign(c.authState, extra);
      },
    });

    it('is consumed once, answered 409 and its browser binding cleared', async () => {
      const { response, consume, digest, cookieName } = await status(withAttempt());
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ status: 'failed' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(consume).toHaveBeenCalledWith({
        id: `external_idp_provisioning:${digest}`,
        tenantId: TENANT,
        type: 'external_idp_provisioning_resume',
        challenge: digest,
      });
      const cookie = response.headers.get('Set-Cookie') ?? '';
      expect(cookie).toContain(`${cookieName}=;`);
      expect(cookie).toContain('Max-Age=0');
      expect(cookie).toContain('Path=/');
    });

    it('records the failed sign-in attempt, once, for the user it was made for', async () => {
      await status(withAttempt());
      expect(mocks.schedule).toHaveBeenCalledTimes(1);
      expect(callArg(mocks.schedule, 0, 1)).toEqual({
        tenantId: TENANT,
        interactionId: 'interaction-1',
        method: 'external_idp',
        reasonCode: 'provisioning_failed',
        userId: 'user-a',
        dedupeKey: 'auth-state-a',
      });
      const deps = rec(callArg(mocks.schedule, 0, 0));
      expect(deps.env).toEqual(expect.objectContaining({ ISSUER_URL: 'https://auth.example.com' }));
      expect(deps.onError).toEqual(expect.any(Function));
      (deps.onError as (e: unknown) => void)(new RangeError('x'));
      expect(mocks.warn).toHaveBeenCalledWith('Failed to record a failed sign-in attempt', {
        errorType: 'RangeError',
      });
      (deps.onError as (e: unknown) => void)('text');
      expect(mocks.warn).toHaveBeenLastCalledWith('Failed to record a failed sign-in attempt', {
        errorType: 'unknown',
      });
      mocks.resolveCore.mockResolvedValue({ core: 1 });
      await (deps.core as () => Promise<unknown>)();
      expect(mocks.resolveCore).toHaveBeenCalledWith(expect.anything(), 'bridge-sign-in-attempt', {
        tenantId: TENANT,
      });
      const waitUntil = vi.fn();
      const waited = Promise.resolve();
      await status({ ...withAttempt(), executionContext: { waitUntil } });
      const again = rec(callArg(mocks.schedule, 1, 0));
      (again.waitUntil as (p: Promise<unknown>) => void)(waited);
      expect(waitUntil).toHaveBeenCalledWith(waited);
    });

    it('records no attempt for a link or a sign-in with no interaction', async () => {
      await status({ status: { status: 'failed' } });
      await status(withAttempt({ userId: 'someone' }));
      expect(mocks.schedule).not.toHaveBeenCalled();
    });

    it('records no attempt when another request consumed the failure first', async () => {
      const { response } = await status({ ...withAttempt(), consumed: { userId: 'user-b' } });
      expect(response.status).toBe(409);
      expect(mocks.schedule).not.toHaveBeenCalled();
      expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    });

    it('answers invalid when the failure cannot be consumed', async () => {
      const { response } = await status({ ...withAttempt(), consumed: new Error('gone') });
      expect(response.status).toBe(400);
      expect(mocks.schedule).not.toHaveBeenCalled();
    });
  });
});
