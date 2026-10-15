import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { DeviceCodeMetadata, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  authenticatedUser: vi.fn(),
  isMockAuthEnabled: vi.fn(),
  storeFetch: vi.fn(),
  limiterFetch: vi.fn(),
  resolveAccount: vi.fn(),
  // The approving user's consent withdrawals for the client, as its account database holds them.
  withdrawalRow: vi.fn(),
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    module: vi.fn().mockReturnThis(),
  },
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    isMockAuthEnabled: mocks.isMockAuthEnabled,
    getLogger: () => mocks.logger,
    resolveAccountDataContextFromHono: mocks.resolveAccount,
    createAccountAuthContextFromHono: () => ({
      coreAdapter: {
        query: vi.fn(),
        queryOne: async (sql: string, params: unknown[]) =>
          sql.includes('FROM oauth_client_consent_revocations')
            ? mocks.withdrawalRow(params)
            : null,
        execute: vi.fn(),
        transaction: vi.fn(),
        batch: vi.fn(),
        isHealthy: vi.fn(),
        getType: () => 'mock',
        close: vi.fn(),
      },
    }),
  };
});

vi.mock('../authenticated-session', async () => {
  const actual = await vi.importActual<typeof import('../authenticated-session')>(
    '../authenticated-session'
  );
  return { ...actual, getAuthenticatedAsyncUser: mocks.authenticatedUser };
});

import { deviceVerifyApiHandler } from '../device-verify-api';
import { settledAnswer } from './real-user-code-limiter';

function pendingMetadata(overrides: Partial<DeviceCodeMetadata> = {}): DeviceCodeMetadata {
  return {
    tenant_id: 'tenant-a',
    device_code: 'device-1',
    user_code: 'WDJB-MJHT',
    client_id: 'client-1',
    scope: 'openid',
    status: 'pending',
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    poll_count: 0,
    ...overrides,
  };
}

function createEnv(withLimiter = true): Env {
  return {
    DEVICE_CODE_STORE: {
      idFromName: vi.fn().mockReturnValue('device-store'),
      get: vi.fn().mockReturnValue({ fetch: mocks.storeFetch }),
    },
    ...(withLimiter
      ? {
          USER_CODE_RATE_LIMITER: {
            idFromName: vi.fn().mockReturnValue('limiter'),
            get: vi.fn().mockReturnValue({ fetch: mocks.limiterFetch }),
          },
        }
      : {}),
  } as unknown as Env;
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (key: string, value: string) => void }).set('tenantId', 'tenant-a');
    await next();
  });
  app.post('/verify', deviceVerifyApiHandler);
  return app;
}

function request(body: unknown, env = createEnv(), headers: Record<string, string> = {}) {
  return createApp().request(
    'http://localhost/verify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('device verification API branch security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticatedUser.mockResolvedValue({
      userId: 'user-1',
      sub: 'subject-1',
      email: 'user@example.com',
    });
    mocks.isMockAuthEnabled.mockResolvedValue(false);
    mocks.resolveAccount.mockResolvedValue({ tenantId: 'tenant-a' });
    mocks.withdrawalRow.mockResolvedValue(null);
    mocks.storeFetch.mockImplementation(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === '/get-by-user-code') return Response.json(pendingMetadata());
      if (path === '/approve' || path === '/deny') return Response.json({ success: true });
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    mocks.limiterFetch.mockImplementation(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === '/reserve') return Response.json({ blocked: false, reservation_id: 'r1' });
      return settledAnswer(path);
    });
  });

  it.each([
    [{}, 'user_code is required'],
    [{ user_code: 42 }, 'user_code is required'],
    [{ user_code: 'abc' }, 'Invalid user code format'],
    [{ user_code: 'ABCD-EFGH-JKMN-PQRS-T' }, 'Invalid user code format'],
    [{ user_code: 'WDJB_MJHT' }, 'Invalid user code format'],
    [{ user_code: 'WDJB-MJH%' }, 'Invalid user code format'],
  ])('rejects malformed input before store access', async (body, description) => {
    const response = await request(body);
    expect(response.status).toBe(400);
    const answer = await response.json();
    expect(answer).toMatchObject({
      error_description: expect.stringContaining(description),
    });
    expect(JSON.stringify(answer)).not.toContain('XXXX-XXXX');
    expect(mocks.storeFetch).not.toHaveBeenCalled();
    // a malformed code is no guess at a real one: it is refused before a guess is reserved
    expect(mocks.limiterFetch).not.toHaveBeenCalled();
  });

  describe('decides a well-formed code in the form the device showed it, or typed', () => {
    it.each([
      ['WDJB-MJHT', 'WDJBMJHT'],
      ['wdjb mjht', 'WDJBMJHT'],
      ['ABCD', 'ABCD'],
      ['1234-5678-901', '12345678901'],
      ['abcd-efgh-jkmn-pqrs', 'ABCDEFGHJKMNPQRS'],
    ])('%s', async (typed, canonical) => {
      mocks.storeFetch.mockImplementation(async (input: Request) => {
        const path = new URL(input.url).pathname;
        if (path === '/get-by-user-code') {
          return Response.json(pendingMetadata({ user_code: typed }));
        }
        return Response.json({ success: true });
      });

      const approve = await request({ user_code: typed });
      const deny = await request({ user_code: typed, approve: false });

      expect(approve.status).toBe(200);
      expect(deny.status).toBe(200);
      const decided = mocks.storeFetch.mock.calls
        .map(([input]) => input as Request)
        .filter((input) =>
          ['/approve', '/deny', '/get-by-user-code'].includes(new URL(input.url).pathname)
        );
      expect(decided.length).toBe(4);
      for (const call of decided) {
        await expect(call.clone().json()).resolves.toMatchObject({ user_code: canonical });
      }
    });
  });

  it('counts a miss for a code of any length, and blocks like before', async () => {
    mocks.storeFetch.mockResolvedValue(Response.json(null));
    const miss = await request({ user_code: '1234-5678-901' });
    expect(miss.status).toBe(404);
    expect(
      mocks.limiterFetch.mock.calls.map(([input]) => new URL((input as Request).url).pathname)
    ).toEqual(['/reserve', '/record-failure']);

    mocks.limiterFetch.mockResolvedValue(Response.json({ blocked: true, retry_after: 60 }));
    const blocked = await request({ user_code: '1234-5678-901' });
    expect(blocked.status).toBe(429);
  });

  it.each([
    ['no settled flag', { success: true }],
    ['expired as a string', { settled: true, expired: 'false', outcome: 'failure' }],
    ['no outcome', { settled: true, expired: false }],
    ['the outcome of the other call', { settled: true, expired: false, outcome: 'released' }],
  ])('refuses and discloses nothing when a miss is settled with %s', async (_label, answer) => {
    mocks.storeFetch.mockResolvedValue(Response.json(null));
    mocks.limiterFetch.mockImplementation(async (input: Request) =>
      new URL(input.url).pathname === '/reserve'
        ? Response.json({ blocked: false, reservation_id: 'r1' })
        : Response.json(answer)
    );

    const response = await request({ user_code: 'WDJB-MJHT' });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('invalid_code');
  });

  it('refuses and discloses nothing when a found code is released with a contradictory answer', async () => {
    mocks.limiterFetch.mockImplementation(async (input: Request) =>
      new URL(input.url).pathname === '/reserve'
        ? Response.json({ blocked: false, reservation_id: 'r1' })
        : Response.json({ settled: true, expired: false, outcome: 'failure' })
    );

    const response = await request({ user_code: 'WDJB-MJHT' });

    expect(response.status).toBe(503);
    expect(
      mocks.storeFetch.mock.calls.some(([input]) =>
        ['/approve', '/deny'].includes(new URL((input as Request).url).pathname)
      )
    ).toBe(false);
  });

  it('reserves a guess only after the request body is read', async () => {
    let send!: (chunk: string) => void;
    let end!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        send = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
        end = () => controller.close();
      },
    });
    mocks.storeFetch.mockResolvedValue(Response.json(null));
    const response = Promise.resolve(
      createApp().request(
        new Request('http://localhost/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          duplex: 'half',
        } as RequestInit),
        undefined,
        createEnv(true)
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.limiterFetch).not.toHaveBeenCalled();
    expect(mocks.storeFetch).not.toHaveBeenCalled();

    send('{"user_code":"WDJB-MJHT"}');
    end();
    expect((await response).status).toBe(404);
    expect(
      mocks.limiterFetch.mock.calls.map(([input]) => new URL((input as Request).url).pathname)
    ).toEqual(['/reserve', '/record-failure']);
  });

  it('uses the forwarded IP fallback and default retry interval when rate limited', async () => {
    mocks.limiterFetch.mockResolvedValue(Response.json({ blocked: true }));
    const response = await request({ user_code: 'WDJB-MJHT' }, createEnv(true), {
      'X-Forwarded-For': '203.0.113.7',
    });
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: 'slow_down',
      error_description: expect.stringContaining('3600 seconds'),
    });
    const check = mocks.limiterFetch.mock.calls[0][0] as Request;
    await expect(check.json()).resolves.toEqual({ ip: '203.0.113.7' });
  });

  it.each([
    ['answers an error status', () => new Response('unavailable', { status: 503 })],
    ['answers an unexpected body', () => Response.json({})],
    [
      'throws',
      () => {
        throw new Error('limiter unavailable');
      },
    ],
  ])('refuses to read codes when the rate limiter check %s', async (_label, limiterResponse) => {
    mocks.limiterFetch.mockImplementation(async () => limiterResponse());
    const response = await request({ user_code: 'WDJB-MJHT' });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('refuses to read codes without a rate limiter binding', async () => {
    const response = await request({ user_code: 'WDJB-MJHT' }, createEnv(false));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
    expect(mocks.storeFetch).not.toHaveBeenCalled();
  });

  it('runs without a rate limiter binding only where mock authentication is enabled', async () => {
    mocks.isMockAuthEnabled.mockResolvedValue(true);
    const response = await request({ user_code: 'WDJB-MJHT' }, createEnv(false));
    expect(response.status).toBe(200);
  });

  it('counts a confirmed unknown code against the rate limit', async () => {
    mocks.storeFetch.mockResolvedValue(Response.json(null));
    const response = await request({ user_code: 'WDJB-MJHT' });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_code' });
    expect(
      mocks.limiterFetch.mock.calls.map(([input]) => new URL((input as Request).url).pathname)
    ).toEqual(['/reserve', '/record-failure']);
  });

  it.each([
    ['answers an error status', () => new Response('unavailable', { status: 503 })],
    [
      'throws',
      () => {
        throw new Error('record failed');
      },
    ],
  ])('refuses to answer when the rate limiter cannot count a failure (%s)', async (_l, failure) => {
    mocks.storeFetch.mockResolvedValue(Response.json(null));
    mocks.limiterFetch.mockImplementation(async (input: Request) => {
      if (new URL(input.url).pathname === '/reserve')
        return Response.json({ blocked: false, reservation_id: 'r1' });
      return failure();
    });
    const response = await request({ user_code: 'WDJB-MJHT' });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
    // the reservation was valid: the code was looked up, and only the miss could not be counted
    expect(mocks.storeFetch).toHaveBeenCalledTimes(1);
    expect(
      mocks.limiterFetch.mock.calls.map(([input]) => new URL((input as Request).url).pathname)
    ).toEqual(['/reserve', '/record-failure']);
  });

  it.each([
    ['answers an error status', () => Response.json({ error: 'internal' }, { status: 500 })],
    [
      'throws',
      () => {
        throw new Error('store unavailable');
      },
    ],
  ])(
    'does not report a code as unknown, nor count a failure, when the store %s',
    async (_label, storeResponse) => {
      mocks.storeFetch.mockImplementation(async () => storeResponse());
      const response = await request({ user_code: 'WDJB-MJHT' });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
      expect(
        mocks.limiterFetch.mock.calls.map(([input]) => new URL((input as Request).url).pathname)
      ).toEqual(['/reserve', '/release']);
    }
  );

  it('rejects a code which has already transitioned state', async () => {
    mocks.storeFetch.mockResolvedValue(Response.json(pendingMetadata({ status: 'approved' })));
    const response = await request({ user_code: 'WDJB-MJHT' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error_description: 'This code has already been approved',
    });
  });

  it.each([true, false])('requires a session before approve=%s', async (approve) => {
    mocks.authenticatedUser.mockResolvedValue(null);
    const response = await request({ user_code: 'WDJB-MJHT', approve });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'authentication_required' });
    expect(
      mocks.storeFetch.mock.calls.some(([input]) =>
        ['/approve', '/deny'].includes(new URL((input as Request).url).pathname)
      )
    ).toBe(false);
  });

  it('binds approval to the authenticated user and ignores supplied subjects', async () => {
    const response = await request({
      user_code: 'wdjbmjht',
      user_id: 'victim',
      sub: 'victim-sub',
    });
    expect(response.status).toBe(200);
    const approve = mocks.storeFetch.mock.calls
      .map(([input]) => input as Request)
      .find((input) => new URL(input.url).pathname === '/approve');
    await expect(approve?.json()).resolves.toEqual({
      user_code: 'WDJBMJHT',
      user_id: 'user-1',
      sub: 'subject-1',
      consent_generation: 0,
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Ignoring caller-supplied device approval subject',
      expect.anything()
    );
  });

  describe('after the user withdrew the client consent', () => {
    const requestedAt = Date.now() - 10_000;

    function approveCall() {
      return mocks.storeFetch.mock.calls
        .map(([input]) => input as Request)
        .find((input) => new URL(input.url).pathname === '/approve');
    }

    beforeEach(() => {
      mocks.storeFetch.mockImplementation(async (input: Request) => {
        const path = new URL(input.url).pathname;
        if (path === '/get-by-user-code') {
          return Response.json(pendingMetadata({ created_at: requestedAt }));
        }
        if (path === '/approve') return Response.json({ success: true });
        return Response.json({ error: 'not_found' }, { status: 404 });
      });
    });

    it('refuses to approve a code requested before the withdrawal: the device starts again', async () => {
      mocks.withdrawalRow.mockResolvedValue({ generation: 1, revoked_at: requestedAt + 1 });

      const response = await request({ user_code: 'WDJB-MJHT' });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        success: false,
        error: 'consent_withdrawn',
        error_description: expect.stringContaining('Start again'),
      });
      expect(approveCall()).toBeUndefined();
      expect(mocks.withdrawalRow).toHaveBeenCalledWith(['tenant-a', 'subject-1', 'client-1']);
    });

    it('approves a code requested after the withdrawal under the current generation', async () => {
      mocks.withdrawalRow.mockResolvedValue({ generation: 2, revoked_at: requestedAt - 1 });

      const response = await request({ user_code: 'WDJB-MJHT' });

      expect(response.status).toBe(200);
      await expect(approveCall()?.json()).resolves.toMatchObject({ consent_generation: 2 });
    });

    it('leaves the code pending when the withdrawals cannot be read', async () => {
      mocks.withdrawalRow.mockRejectedValue(new Error('account database unavailable'));

      const response = await request({ user_code: 'WDJB-MJHT' });

      expect(response.status).toBe(503);
      expect(approveCall()).toBeUndefined();
    });
  });

  it('allows generated development subjects only when mock authentication is enabled', async () => {
    mocks.authenticatedUser.mockResolvedValue(null);
    mocks.isMockAuthEnabled.mockResolvedValue(true);
    const response = await request({ user_code: 'WDJB-MJHT' });
    expect(response.status).toBe(200);
    const approve = mocks.storeFetch.mock.calls
      .map(([input]) => input as Request)
      .find((input) => new URL(input.url).pathname === '/approve');
    const body = (await approve?.json()) as { user_id: string; sub: string };
    expect(body.user_id).toMatch(/^user_\d+$/);
    expect(body.sub).toBe(body.user_id);
  });

  it.each([
    ['/approve', { error_description: 'approval backend rejected' }, 'approval backend rejected'],
    ['/deny', {}, 'Failed to deny device'],
  ])('does not hide a safe store failure for %s', async (failurePath, errorBody, expected) => {
    mocks.storeFetch.mockImplementation(async (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path === '/get-by-user-code') return Response.json(pendingMetadata());
      if (path === failurePath) return Response.json(errorBody, { status: 500 });
      return Response.json({ success: true });
    });
    const response = await request({
      user_code: 'WDJB-MJHT',
      approve: failurePath === '/approve',
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error_description: expected });
  });

  it('does not touch the failure budget when a code is approved', async () => {
    const response = await request({ user_code: 'WDJB-MJHT' }, createEnv(true));
    expect(response.status).toBe(200);
    // only the check before the lookup: no reset, no failure recorded
    expect(
      mocks.limiterFetch.mock.calls.map(([input]) => new URL((input as Request).url).pathname)
    ).toEqual(['/reserve', '/release']);
  });

  it('successfully denies a pending code for the authenticated user', async () => {
    const response = await request({ user_code: 'WDJB-MJHT', approve: false });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      message: 'Device authorization denied',
    });
  });

  it('masks unexpected parser and storage exceptions', async () => {
    const app = createApp();
    const response = await app.request(
      'http://localhost/verify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      },
      createEnv()
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'server_error',
      error_description: 'Internal server error',
    });
  });
});
