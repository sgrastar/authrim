import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  eligibility: vi.fn(),
  audit: vi.fn(),
  ttl: vi.fn(),
  create: vi.fn(),
  status: vi.fn(),
  consume: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    AdminSessionRepository: class {
      createSession = mocks.createSession;
    },
    evaluateAdminCredentialEligibility: mocks.eligibility,
    requireDedicatedAdminDatabaseAdapter: () => ({}),
    scheduleAdminAuthenticationAudit: mocks.audit,
    getRateLimitProfileAsync: async () => ({}),
    rateLimitMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
    getTenantIdFromContext: () => 'tenant-1',
    getAdminCookieSameSite: () => 'Lax',
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});
vi.mock('../issuer', () => ({ getRequestIssuer: () => 'https://idp.example.com' }));
vi.mock('../session-ttl', () => ({ resolveSessionTtl: mocks.ttl }));

import { adminWalletLoginApp, ADMIN_WALLET_LOGIN_CALLBACK_PATH } from '../admin-wallet-login';

const BASE = '/api/admin/auth/wallet-login';
const SECRET = 's'.repeat(43);
const CODE = 'c'.repeat(43);

function env(
  vcIssuer: unknown = {
    createHaipLoginRequest: mocks.create,
    getHaipLoginStatus: mocks.status,
    consumeHaipLoginResult: mocks.consume,
  }
) {
  return { VC_ISSUER: vcIssuer } as unknown as Env;
}

const request = (
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; contentType?: string } = {},
  e: Env = env()
) => {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/', adminWalletLoginApp);
  return app.request(
    `${BASE}${path}`,
    {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body === undefined
          ? {}
          : { 'Content-Type': init.contentType ?? 'application/json' }),
        ...(init.cookie ? { Cookie: init.cookie } : {}),
        'User-Agent': 'test-agent',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    e
  );
};

const setCookies = (response: Response) => response.headers.getSetCookie();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ttl.mockResolvedValue({ seconds: 600, milliseconds: 600_000 });
  mocks.eligibility.mockResolvedValue({ eligible: true, email: 'a@example.com', name: 'A' });
  mocks.createSession.mockResolvedValue({});
  mocks.create.mockResolvedValue({
    requestId: 'g1:apac:0:vp_1',
    expiresAt: 1_800_000_300_000,
    qr: 'openid4vp://?client_id=x',
    deepLink: 'haip-vp://?client_id=x',
  });
  mocks.status.mockResolvedValue({ status: 'pending', flow: 'cross_device', expiresAt: 5 });
  mocks.consume.mockResolvedValue({
    adminUserId: 'admin-1',
    holderJkt: 'J'.repeat(43),
    credentialId: 'credential-1',
    verifiedAt: 1,
  });
});

describe('start', () => {
  it('starts a same-device login: the wallet link, and a binding cookie the browser keeps', async () => {
    const response = await request('/start', { method: 'POST', body: { flow: 'same_device' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      request_id: 'g1:apac:0:vp_1',
      expires_at: 1_800_000_300_000,
      deep_link: 'haip-vp://?client_id=x',
    });
    const created = mocks.create.mock.calls[0][0] as { bindingSecret: string; flow: string };
    expect(created).toMatchObject({
      tenantId: 'tenant-1',
      credentialIssuer: 'https://idp.example.com',
      flow: 'same_device',
    });
    const cookie = setCookies(response)[0];
    expect(cookie).toContain(`authrim_admin_wallet_login=${created.bindingSecret}`);
    expect(cookie).toMatch(/HttpOnly/u);
    expect(cookie).toMatch(/Secure/u);
    expect(cookie).toContain(`Path=${BASE}`);
    expect(cookie).toMatch(/Max-Age=300/u);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('offers no QR (cross-device) login for the admin sign-in', async () => {
    const response = await request('/start', { method: 'POST', body: { flow: 'cross_device' } });
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('starts a same-device login with the link and the redirect to this console', async () => {
    const response = await request('/start', { method: 'POST', body: { flow: 'same_device' } });
    expect(await response.json()).toMatchObject({ deep_link: 'haip-vp://?client_id=x' });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: 'same_device',
        redirectUri: `https://idp.example.com${ADMIN_WALLET_LOGIN_CALLBACK_PATH}`,
      })
    );
  });

  it('returns the browser to the configured console origin when there is one', async () => {
    const e = { ...env(), ADMIN_UI_URL: 'https://console.example.com' } as unknown as Env;
    await request('/start', { method: 'POST', body: { flow: 'same_device' } }, e);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: `https://console.example.com${ADMIN_WALLET_LOGIN_CALLBACK_PATH}`,
      })
    );
  });

  it('refuses a bad request, and says unavailable without the verifier or a usable certificate', async () => {
    for (const body of [{ flow: 'other' }, {}, 'x']) {
      expect((await request('/start', { method: 'POST', body })).status).toBe(400);
    }
    expect(
      (
        await request('/start', {
          method: 'POST',
          body: { flow: 'same_device' },
          contentType: 'text/plain',
        })
      ).status
    ).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    mocks.create.mockRejectedValue(new Error('haip_login_unavailable'));
    const unavailable = await request('/start', { method: 'POST', body: { flow: 'same_device' } });
    // A known refusal, not an unknown outcome: no write happened, so the writer permit may close.
    expect(unavailable.status).toBe(424);
    expect(setCookies(unavailable)).toHaveLength(0);
    expect(
      (await request('/start', { method: 'POST', body: { flow: 'same_device' } }, env(null))).status
    ).toBe(424);
  });
});

describe('status', () => {
  it('shows the progress to the browser that holds the binding', async () => {
    const response = await request('/status?request_id=g1%3Aapac%3A0%3Avp_1', {
      cookie: `authrim_admin_wallet_login=${SECRET}`,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'pending',
      flow: 'cross_device',
      expires_at: 5,
    });
    expect(mocks.status).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      requestId: 'g1:apac:0:vp_1',
      bindingSecret: SECRET,
    });
  });

  it('answers nothing without the binding, with a bad id, or for another browser', async () => {
    expect((await request('/status?request_id=g1%3Aapac%3A0%3Avp_1')).status).toBe(400);
    expect(
      (
        await request('/status?request_id=bad%20id', {
          cookie: `authrim_admin_wallet_login=${SECRET}`,
        })
      ).status
    ).toBe(400);
    mocks.status.mockResolvedValue(null);
    expect(
      (
        await request('/status?request_id=g1%3Aapac%3A0%3Avp_1', {
          cookie: `authrim_admin_wallet_login=${SECRET}`,
        })
      ).status
    ).toBe(404);
  });
});

describe('complete', () => {
  const complete = (
    body: unknown,
    cookie: string | undefined = `authrim_admin_wallet_login=${SECRET}`
  ) => request('/complete', { method: 'POST', body, cookie });

  it('signs the administrator in: an admin session with the second factor satisfied', async () => {
    const response = await complete({ request_id: 'g1:apac:0:vp_1', response_code: CODE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.consume).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      requestId: 'g1:apac:0:vp_1',
      bindingSecret: SECRET,
      responseCode: CODE,
    });
    expect(mocks.eligibility).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-1',
      adminUserId: 'admin-1',
      now: expect.any(Number) as number,
    });
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        admin_user_id: 'admin-1',
        mfa_verified: false,
        user_agent: 'test-agent',
      })
    );
    const sessionId = (mocks.createSession.mock.calls[0][0] as { id: string }).id;
    const cookies = setCookies(response);
    const session = cookies.find((value) => value.startsWith('authrim_admin_session='));
    expect(session).toContain(`authrim_admin_session=${sessionId}`);
    expect(session).toMatch(/HttpOnly/u);
    expect(session).toMatch(/Secure/u);
    expect(session).toMatch(/Max-Age=600/u);
    // The binding cookie is spent.
    expect(cookies.find((value) => value.startsWith('authrim_admin_wallet_login='))).toMatch(
      /Max-Age=0|Expires=/u
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'admin.login',
        method: 'wallet_presentation',
        adminUserId: 'admin-1',
        sessionId,
      })
    );
  });

  it('refuses a completion without the response code of the wallet redirect', async () => {
    const response = await complete({ request_id: 'g1:apac:0:vp_1' });
    expect(response.status).toBe(400);
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('takes the response code of a same-device redirect along', async () => {
    await complete({ request_id: 'g1:apac:0:vp_1', response_code: CODE });
    expect(mocks.consume).toHaveBeenCalledWith(expect.objectContaining({ responseCode: CODE }));
  });

  it('refuses, and creates no session, when nothing is ready, the administrator is no longer eligible or the request is bad', async () => {
    mocks.consume.mockResolvedValue(null);
    const notReady = await complete({ request_id: 'g1:apac:0:vp_1', response_code: CODE });
    expect(notReady.status).toBe(400);
    // An old callback must not cancel a newer login of this browser.
    expect(setCookies(notReady)).toHaveLength(0);
    mocks.consume.mockResolvedValue({
      adminUserId: 'admin-1',
      holderJkt: 'J'.repeat(43),
      credentialId: 'credential-1',
      verifiedAt: 1,
    });
    mocks.eligibility.mockResolvedValue({ eligible: false });
    const ineligible = await complete({ request_id: 'g1:apac:0:vp_1', response_code: CODE });
    expect(ineligible.status).toBe(403);
    expect(setCookies(ineligible).some((value) => value.startsWith('authrim_admin_session='))).toBe(
      false
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin.login_failed', reason: 'not_eligible' })
    );
    for (const body of [
      {},
      { request_id: 5 },
      { request_id: 'bad id' },
      { request_id: 'g1:a', response_code: 'short' },
    ]) {
      expect((await complete(body)).status).toBe(400);
    }
    expect((await complete({ request_id: 'g1:apac:0:vp_1' }, '')).status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('answers 503 when the verifier or the session store fails, without a session', async () => {
    mocks.consume.mockRejectedValue(new Error('down'));
    expect((await complete({ request_id: 'g1:apac:0:vp_1', response_code: CODE })).status).toBe(
      503
    );
    mocks.consume.mockResolvedValue({
      adminUserId: 'admin-1',
      holderJkt: 'J'.repeat(43),
      credentialId: 'c',
      verifiedAt: 1,
    });
    mocks.createSession.mockRejectedValue(new Error('db down'));
    const failed = await complete({ request_id: 'g1:apac:0:vp_1', response_code: CODE });
    expect(failed.status).toBe(503);
    expect(setCookies(failed).some((value) => value.startsWith('authrim_admin_session='))).toBe(
      false
    );
  });
});
