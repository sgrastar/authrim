import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('jose', () => ({ jwtVerify: vi.fn(), importJWK: vi.fn() }));
vi.mock('hono/cookie', () => ({ getCookie: vi.fn(), setCookie: vi.fn() }));

const store = vi.hoisted(() => ({
  getSessionRpc: vi.fn<(id: string) => Promise<unknown>>(),
  invalidateSessionRpc: vi.fn<(id: string) => Promise<boolean>>(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLog: vi.fn().mockResolvedValue(undefined),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    revokeGuestResumeForSession: vi.fn().mockResolvedValue(undefined),
    verifyClientSecretHash: vi.fn(
      async (secret: string, hash: string) => hash === `hash_${secret}`
    ),
    validateIdTokenHint: vi.fn(),
    isNativeSSOEnabled: vi.fn().mockResolvedValue(false),
    validatePostLogoutRedirectUri: vi.fn(),
    validateLogoutParameters: vi.fn(),
    revokeDeviceSecretsForLogoutScope: vi.fn(),
    resolveLogoutTargetsFromSessionClientStore: vi.fn().mockResolvedValue(null),
    resolveLogoutIssuerWithRetry: vi.fn(async () => 'https://canonical.example.com'),
    reportLogoutNotSent: vi.fn().mockResolvedValue({ sessions: 0, clients: 0 }),
    reportIncompleteLogouts: vi.fn().mockResolvedValue(undefined),
    reportLogoutTargetsUnavailable: vi.fn().mockResolvedValue(undefined),
    resolveLogoutConfig: vi.fn(actual.resolveLogoutConfig),
    sendBackchannelLogoutFanout: vi.fn().mockResolvedValue(null),
    sendLogoutWebhookFanout: vi.fn().mockResolvedValue(null),
    purgeEndedSessionsFromSessionClientStore: vi.fn().mockResolvedValue(undefined),
    isShardedSessionId: vi.fn((sessionId: string) => /^\d+_session_/.test(sessionId)),
    getSessionStoreBySessionId: vi.fn(() => ({ stub: store })),
    recordHybridUserSessionRevocationEpoch: vi.fn().mockResolvedValue(1),
  };
});

import { frontChannelLogoutHandler } from '../logout';
import { getCookie, setCookie } from 'hono/cookie';
import { importJWK } from 'jose';
import {
  validateLogoutParameters,
  validatePostLogoutRedirectUri,
  validateIdTokenHint,
  isNativeSSOEnabled,
  publishEvent,
  getSessionStoreBySessionId,
  resolveLogoutConfig,
  GUEST_RESUME_COOKIE,
  BROWSER_STATE_COOKIE_NAME,
} from '@authrim/ar-lib-core';

function createContext(options: {
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  clientRow?: Record<string, unknown> | null;
  keys?: unknown[];
}) {
  const first = vi.fn(async () => options.clientRow ?? null);
  const DB = {
    prepare: vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        first,
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
      }),
    }),
  } as unknown as D1Database;
  const keyManager = {
    getAllPublicKeysRpc: vi
      .fn()
      .mockResolvedValue(options.keys ?? [{ kty: 'RSA', kid: 'key-1', n: 'n', e: 'AQAB' }]),
  };
  const env = {
    ISSUER_URL: 'https://op.example.com',
    DB,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue('km'),
      get: vi.fn().mockReturnValue(keyManager),
    },
  } as unknown as Env;
  const contextStore = new Map<string, unknown>([
    ['tenantId', 'default'],
    ['tenantMetadataContext', { tenantId: 'default', coreDb: DB }],
  ]);
  const waitUntil = vi.fn();
  const c = {
    req: {
      query: (name: string) => options.query?.[name],
      header: (name: string) => options.headers?.[name],
      method: options.method ?? 'POST',
      parseBody: vi.fn(async (): Promise<Record<string, unknown>> => options.body ?? {}),
    },
    env,
    executionCtx: { waitUntil },
    json: vi.fn(
      (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), { status: status ?? 200 })
    ),
    redirect: vi.fn(
      (url: string, status?: number) =>
        new Response(null, { status: status ?? 302, headers: { Location: url } })
    ),
    body: vi.fn(
      (body: BodyInit | null, status?: number, headers?: Record<string, string>) =>
        new Response(body, { status: status ?? 200, headers })
    ),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  };
  return { c, keyManager, waitUntil };
}

function cookies(values: Record<string, string | undefined>) {
  vi.mocked(getCookie).mockImplementation(((_c: unknown, name: string) => values[name]) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.getSessionRpc.mockReset().mockResolvedValue(null);
  store.invalidateSessionRpc.mockReset().mockResolvedValue(true);
  vi.mocked(importJWK).mockResolvedValue({} as never);
  vi.mocked(validateLogoutParameters).mockReturnValue({ valid: true });
  vi.mocked(validatePostLogoutRedirectUri).mockReturnValue({ valid: true });
  vi.mocked(validateIdTokenHint).mockResolvedValue({ valid: false, error: 'invalid' });
  vi.mocked(isNativeSSOEnabled).mockResolvedValue(false);
  cookies({});
});

afterEach(() => {
  vi.mocked(getCookie).mockReset();
});

const SESSION = '0_session_abc';
const CONFIRM = 'confirm-token';

async function continuedTo(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  const match = /content="0;url=([^"]*)"/u.exec(await response.text());
  return (match?.[1] ?? '').replace(/&amp;/g, '&');
}

/** A confirmed logout POST (the double-submit token matches its cookie). */
async function confirmedLogout(
  body: Record<string, string> = {},
  options: { clientRow?: Record<string, unknown> | null; session?: string } = {}
) {
  cookies({ authrim_session: options.session ?? SESSION, authrim_logout_confirmation: CONFIRM });
  const ctx = createContext({
    body: { confirmation_token: CONFIRM, ...body },
    clientRow: options.clientRow,
  });
  const response = await frontChannelLogoutHandler(ctx.c as never);
  return { ...ctx, response };
}

describe('front-channel logout confirmation', () => {
  it('sends a POST without token, session or hint straight to the logged-out page', async () => {
    const { c } = createContext({ body: {} });
    const response = await frontChannelLogoutHandler(c as never);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://op.example.com/logged-out');
    expect(setCookie).not.toHaveBeenCalled();
  });

  it('asks a POST carrying only an id_token_hint to confirm', async () => {
    const { c } = createContext({
      body: { id_token_hint: 'hint.jwt', post_logout_redirect_uri: 'https://rp/x', state: 's"1' },
    });
    const response = await frontChannelLogoutHandler(c as never);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<input type="hidden" name="id_token_hint" value="hint.jwt">');
    expect(html).toContain(
      '<input type="hidden" name="post_logout_redirect_uri" value="https://rp/x">'
    );
    expect(html).toContain('<input type="hidden" name="state" value="s&quot;1">');
    expect(html).not.toContain('name="logout_scope"');
    expect(store.invalidateSessionRpc).not.toHaveBeenCalled();
  });

  it('sets a strict, short-lived confirmation cookie and locks down the confirmation page', async () => {
    cookies({ authrim_session: SESSION });
    const { c } = createContext({ method: 'GET', query: { logout_scope: 'global' } });
    const response = await frontChannelLogoutHandler(c as never);
    const [, name, token, options] = vi.mocked(setCookie).mock.calls[0];
    expect(name).toBe('authrim_logout_confirmation');
    expect(options).toEqual({
      path: '/logout',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      maxAge: 300,
    });
    const html = await response.text();
    expect(html).toContain(`name="confirmation_token" value="${token}"`);
    expect(html).toContain('<input type="hidden" name="logout_scope" value="global">');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('sends a GET without session or hint to the logged-out page, and confirms one with a hint', async () => {
    const plain = await frontChannelLogoutHandler(createContext({ method: 'GET' }).c as never);
    expect(plain.headers.get('Location')).toBe('https://op.example.com/logged-out');
    const hinted = await frontChannelLogoutHandler(
      createContext({ method: 'GET', query: { id_token_hint: 'hint.jwt' } }).c as never
    );
    expect(hinted.status).toBe(200);
    expect(await hinted.text()).toContain('name="id_token_hint" value="hint.jwt"');
  });

  it('refuses a confirmation token that does not match its cookie', async () => {
    for (const cookie of [undefined, 'other-token']) {
      cookies({ authrim_session: SESSION, authrim_logout_confirmation: cookie });
      const response = await frontChannelLogoutHandler(
        createContext({ body: { confirmation_token: CONFIRM } }).c as never
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'invalid_request',
        error_description: 'Logout confirmation is missing or expired',
      });
    }
    expect(store.invalidateSessionRpc).not.toHaveBeenCalled();
  });
});

describe('front-channel logout session ending', () => {
  it('answers 503 with the guest message when the session cannot be read', async () => {
    store.getSessionRpc.mockRejectedValueOnce(new Error('down'));
    const { response } = await confirmedLogout();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'temporarily_unavailable',
      error_description: 'Guest sign-out could not be completed',
    });
  });

  it('still logs out when routing to the session store fails otherwise', async () => {
    vi.mocked(getSessionStoreBySessionId).mockImplementationOnce(() => {
      throw new Error('bad shard');
    });
    const { response } = await confirmedLogout();
    expect(await continuedTo(response)).toBe('https://op.example.com/logged-out');
  });

  it('uses the default settings when the logout settings cannot be read', async () => {
    vi.mocked(resolveLogoutConfig).mockRejectedValueOnce(new Error('kv down'));
    const { response } = await confirmedLogout();
    expect(await continuedTo(response)).toBe('https://op.example.com/logged-out');
  });

  it('ends the session a validated hint names besides the cookie session', async () => {
    vi.mocked(validateIdTokenHint).mockResolvedValue({
      valid: true,
      clientId: 'client-1',
      sid: '1_session_hint',
      payload: {},
    });
    store.invalidateSessionRpc.mockImplementation(async (id: string) => id === SESSION);
    const { response } = await confirmedLogout({ id_token_hint: 'hint.jwt' });
    expect(response.status).toBe(200);
    expect(store.invalidateSessionRpc.mock.calls.map(([id]) => id)).toEqual([
      SESSION,
      '1_session_hint',
    ]);
    // Only the deleted (cookie) session is announced.
    const ids = vi
      .mocked(publishEvent)
      .mock.calls.map(([, event]) => (event as { data: { sessionId: string } }).data.sessionId);
    expect(new Set(ids)).toEqual(new Set([SESSION]));
  });

  it('still logs out when the hinted session store fails otherwise', async () => {
    vi.mocked(validateIdTokenHint).mockResolvedValue({
      valid: true,
      clientId: 'client-1',
      sid: '1_session_hint',
      payload: {},
    });
    vi.mocked(getSessionStoreBySessionId)
      .mockImplementationOnce(() => ({ stub: store }) as never)
      .mockImplementationOnce(() => {
        throw new Error('bad shard');
      });
    const { response } = await confirmedLogout({ id_token_hint: 'hint.jwt' });
    expect(await continuedTo(response)).toBe('https://op.example.com/logged-out');
  });
});

describe('front-channel post_logout_redirect_uri validation', () => {
  const redirect = 'https://rp.example.com/after';

  it('reports an invalid hint when a redirect is requested', async () => {
    const { response } = await confirmedLogout({
      id_token_hint: 'bad.jwt',
      post_logout_redirect_uri: redirect,
    });
    expect(await continuedTo(response)).toBe(
      'https://op.example.com/logout-error?error=invalid_id_token_hint'
    );
  });

  it('reports an invalid hint when the valid hint names no client', async () => {
    vi.mocked(validateIdTokenHint).mockResolvedValue({ valid: true, payload: {} });
    const { response } = await confirmedLogout({
      id_token_hint: 'hint.jwt',
      post_logout_redirect_uri: redirect,
    });
    expect(await continuedTo(response)).toBe(
      'https://op.example.com/logout-error?error=invalid_id_token_hint'
    );
  });

  it('reports an unknown client', async () => {
    vi.mocked(validateIdTokenHint).mockResolvedValue({
      valid: true,
      clientId: 'client-1',
      payload: {},
    });
    const { response } = await confirmedLogout(
      { id_token_hint: 'hint.jwt', post_logout_redirect_uri: redirect },
      { clientRow: null }
    );
    expect(await continuedTo(response)).toBe(
      'https://op.example.com/logout-error?error=invalid_client'
    );
  });

  it('validates against the registered URIs parsed from JSON and appends state', async () => {
    vi.mocked(validateIdTokenHint).mockResolvedValue({
      valid: true,
      clientId: 'client-1',
      payload: {},
    });
    const { response } = await confirmedLogout(
      { id_token_hint: 'hint.jwt', post_logout_redirect_uri: redirect, state: 'xyz' },
      {
        clientRow: { client_id: 'client-1', post_logout_redirect_uris: JSON.stringify([redirect]) },
      }
    );
    expect(validatePostLogoutRedirectUri).toHaveBeenCalledWith(redirect, [redirect]);
    expect(await continuedTo(response)).toBe(`${redirect}?state=xyz`);
  });
});

describe('front-channel logout failure', () => {
  it('clears the session cookies and answers server_error', async () => {
    const { c } = createContext({});
    c.req.parseBody = vi.fn().mockRejectedValue(new Error('body'));
    const response = await frontChannelLogoutHandler(c as never);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'server_error',
      error_description: 'Failed to process logout request',
    });
    const cleared = Object.fromEntries(
      vi.mocked(setCookie).mock.calls.map(([, name, value, options]) => [name, { value, options }])
    );
    expect(cleared[GUEST_RESUME_COOKIE]).toEqual({
      value: '',
      options: { path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 0 },
    });
    expect(cleared.authrim_session).toEqual({
      value: '',
      options: expect.objectContaining({
        path: '/',
        httpOnly: true,
        secure: true,
        maxAge: 0,
      }) as unknown,
    });
    expect(cleared[BROWSER_STATE_COOKIE_NAME]).toEqual({
      value: '',
      options: expect.objectContaining({ path: '/', secure: true, maxAge: 0 }) as unknown,
    });
    expect(cleared[BROWSER_STATE_COOKIE_NAME].options).not.toHaveProperty('httpOnly');
  });
});
