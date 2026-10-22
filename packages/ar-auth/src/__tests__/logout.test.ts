/**
 * Logout Endpoint Unit Tests
 *
 * Tests for OIDC Logout functionality:
 * - Front-channel logout (GET /logout)
 * - Back-channel logout (POST /logout/backchannel) - RFC 8725
 *
 * Security-focused tests for token validation, session invalidation,
 * and logout token verification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const securityRegressionIt =
  process.env.AUTHRIM_SECURITY_REGRESSION_SUITE === 'true' ? it : it.skip;

// Mock jose module
vi.mock('jose', () => ({
  jwtVerify: vi.fn(),
  importJWK: vi.fn(),
}));

// Mock hono/cookie
vi.mock('hono/cookie', () => ({
  getCookie: vi.fn(),
  setCookie: vi.fn(),
}));

// Mock session store for sharded session support (RPC pattern)
const mockShardedSessionStore = {
  getSessionRpc: vi.fn().mockResolvedValue(null),
  invalidateSessionRpc: vi.fn().mockResolvedValue(true),
};

// Mock shared module
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    revokeGuestResumeForSession: vi.fn().mockResolvedValue(undefined),
    timingSafeEqual: vi.fn((a: string, b: string) => a === b),
    verifyClientSecretHash: vi.fn(async (secret: string, hash: string) => {
      // Simple mock: check if hash equals 'hash_' + secret
      return hash === 'hash_' + secret;
    }),
    validateIdTokenHint: vi.fn(),
    isNativeSSOEnabled: vi.fn((env: unknown) =>
      (actual as { isNativeSSOEnabled: (env: unknown) => Promise<boolean> }).isNativeSSOEnabled(env)
    ),
    validatePostLogoutRedirectUri: vi.fn(),
    validateLogoutParameters: vi.fn(),
    DEFAULT_DEVICE_SECRET_LOGOUT_SCOPE: 'group',
    normalizeDeviceSecretLogoutScope: vi.fn((scope: string | undefined) =>
      scope === 'local' || scope === 'group' || scope === 'global' ? scope : 'group'
    ),
    revokeDeviceSecretsForLogoutScope: vi.fn().mockResolvedValue({
      scope: 'group',
      tenantId: 'default',
      sessionIds: [],
      revokedDeviceSecrets: 0,
      revokedInstallations: 0,
      matchedInstallations: 0,
    }),
    resolveLogoutTargetsFromSessionClientStore: vi.fn().mockResolvedValue(null),
    // The tenant's canonical issuer, which is not the host the request came in on.
    // (its retries are tested in ar-lib-core)
    resolveLogoutIssuerWithRetry: vi.fn(async () => 'https://canonical.example.com'),
    reportLogoutNotSent: vi.fn().mockResolvedValue({ sessions: 0, clients: 0 }),
    reportIncompleteLogouts: vi.fn().mockResolvedValue(undefined),
    reportLogoutTargetsUnavailable: vi.fn().mockResolvedValue(undefined),
    resolveLogoutWebhookConfig: vi.fn(
      (actual as { resolveLogoutWebhookConfig: (...args: unknown[]) => unknown })
        .resolveLogoutWebhookConfig
    ),
    sendBackchannelLogoutFanout: vi.fn().mockResolvedValue(null),
    sendLogoutWebhookFanout: vi.fn().mockResolvedValue(null),
    purgeEndedSessionsFromSessionClientStore: vi.fn().mockResolvedValue(undefined),
    isShardedSessionId: vi.fn((sessionId: string) => /^\d+_session_/.test(sessionId)),
    // Return { stub: ... } to match the destructuring pattern in logout.ts
    getSessionStoreBySessionId: vi.fn(() => ({ stub: mockShardedSessionStore })),
    recordHybridUserSessionRevocationEpoch: vi.fn().mockResolvedValue(1_750_000_000_000),
  };
});

import {
  frontChannelLogoutHandler,
  backChannelLogoutHandler,
  renderLogoutContinuationPage,
} from '../logout';
import { getCookie, setCookie } from 'hono/cookie';
import { jwtVerify, importJWK } from 'jose';
import {
  revokeGuestResumeForSession,
  timingSafeEqual,
  verifyClientSecretHash,
  validateIdTokenHint,
  isNativeSSOEnabled,
  revokeDeviceSecretsForLogoutScope,
  validatePostLogoutRedirectUri,
  validateLogoutParameters,
  resolveLogoutTargetsFromSessionClientStore,
  recordHybridUserSessionRevocationEpoch,
  sendBackchannelLogoutFanout,
  sendLogoutWebhookFanout,
  resolveLogoutIssuerWithRetry,
  reportLogoutNotSent,
  reportIncompleteLogouts,
  reportLogoutTargetsUnavailable,
  resolveLogoutWebhookConfig,
  purgeEndedSessionsFromSessionClientStore,
  DEFAULT_LOGOUT_CONFIG,
} from '@authrim/ar-lib-core';

// Helper to create mock context
function createMockContext(options: {
  method?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  env?: Partial<Env>;
}) {
  const mockSessionStore = {
    fetch: vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })),
  };

  const mockKeyManager = {
    getAllPublicKeysRpc: vi.fn().mockResolvedValue([
      {
        kty: 'RSA',
        kid: 'key-1',
        n: 'mock-n',
        e: 'AQAB',
      },
    ]),
  };

  const mockEnv: Partial<Env> = {
    ISSUER_URL: 'https://op.example.com',
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
        }),
      }),
    } as unknown as D1Database,
    SESSION_STORE: {
      idFromName: vi.fn().mockReturnValue('session-store-id'),
      get: vi.fn().mockReturnValue(mockSessionStore),
    } as unknown as Env['SESSION_STORE'],
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue('key-manager-id'),
      get: vi.fn().mockReturnValue(mockKeyManager),
    } as unknown as Env['KEY_MANAGER'],
    ...options.env,
  };

  // Store context values (simulating Hono's context store)
  const contextStore = new Map<string, unknown>([
    ['tenantId', 'default'],
    ['tenantMetadataContext', { tenantId: 'default', coreDb: mockEnv.DB }],
  ]);

  const c = {
    req: {
      query: (name: string) => options.query?.[name],
      header: (name: string) => options.headers?.[name],
      method: options.method || 'POST',
      parseBody: vi
        .fn()
        .mockResolvedValue(
          options.body || { confirmation_token: 'session-123', ...(options.query ?? {}) }
        ),
    },
    env: mockEnv as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    redirect: vi.fn(
      (url, status = 302) => new Response(null, { status, headers: { Location: url } })
    ),
    body: vi.fn((body, status = 200) => new Response(body, { status })),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
  } as any;

  return { c, mockSessionStore, mockKeyManager };
}

/**
 * Where the page a confirmed logout answers with sends the browser on to (its meta refresh). A
 * confirmed logout answers the confirmation form's POST, so it must not redirect (see logout.ts).
 */
async function continuedTo(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  const html = await response.text();
  const match = /<meta http-equiv="refresh" content="0;url=([^"]*)">/u.exec(html);
  expect(match).not.toBeNull();
  return match![1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const VALID_BACKCHANNEL_AUTH_HEADER = {
  Authorization: 'Basic ' + btoa('client-123:client-secret'),
};

function mockValidBackchannelClient(
  c: { env: Env },
  clientId = 'client-123',
  secret = 'client-secret'
) {
  c.env.DB.prepare = vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      first: vi.fn().mockResolvedValue({
        client_id: clientId,
        client_secret_hash: `hash_${secret}`,
      }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 0 } }),
    }),
  }) as unknown as D1Database['prepare'];
}

describe('Front-channel Logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock values for validation functions
    vi.mocked(validateLogoutParameters).mockReturnValue({ valid: true });
    vi.mocked(validateIdTokenHint).mockResolvedValue({ valid: true });
    vi.mocked(validatePostLogoutRedirectUri).mockReturnValue({ valid: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Logout', () => {
    it('should redirect to default logged-out page when no post_logout_redirect_uri', async () => {
      const { c } = createMockContext({
        query: {},
      });

      vi.mocked(getCookie).mockReturnValue('session-123');

      const response = await frontChannelLogoutHandler(c);

      expect(await continuedTo(response)).toBe('https://op.example.com/logged-out');
    });

    it('should clear session cookie on logout', async () => {
      const { c } = createMockContext({
        query: {},
      });

      vi.mocked(getCookie).mockReturnValue('session-123');

      const response = await frontChannelLogoutHandler(c);

      expect(setCookie).toHaveBeenCalledWith(
        c,
        'authrim_session',
        '',
        expect.objectContaining({
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None',
          maxAge: 0,
        })
      );
    });

    it('does not clear the browser session when its credential binding cannot be read', async () => {
      const { c } = createMockContext({ query: {}, body: { confirmation_token: '0_session_123' } });
      vi.mocked(getCookie).mockReturnValue('0_session_123');
      mockShardedSessionStore.getSessionRpc.mockRejectedValue(new Error('storage_unavailable'));
      try {
        const response = await frontChannelLogoutHandler(c);
        expect(c.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'temporarily_unavailable' }),
          503
        );
        expect(mockShardedSessionStore.invalidateSessionRpc).not.toHaveBeenCalled();
      } finally {
        mockShardedSessionStore.getSessionRpc.mockReset().mockResolvedValue(null);
      }
    });

    it('keeps the session retryable when guest credential revocation fails', async () => {
      const { c } = createMockContext({ query: {}, body: { confirmation_token: '0_session_123' } });
      vi.mocked(getCookie).mockReturnValue('0_session_123');
      vi.mocked(revokeGuestResumeForSession).mockRejectedValueOnce(
        new Error('guest_resume_revocation_failed')
      );
      const response = await frontChannelLogoutHandler(c);
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'temporarily_unavailable' }),
        503
      );
      expect(mockShardedSessionStore.invalidateSessionRpc).not.toHaveBeenCalled();
    });

    it('should invalidate session in SessionStore (sharded format)', async () => {
      const { c } = createMockContext({
        query: {},
        body: { confirmation_token: '0_session_123' },
      });

      // Reset mock for sharded session store
      mockShardedSessionStore.invalidateSessionRpc.mockReset();
      mockShardedSessionStore.invalidateSessionRpc.mockResolvedValue(true);

      // Use sharded session ID format
      vi.mocked(getCookie).mockReturnValue('0_session_123');

      const response = await frontChannelLogoutHandler(c);

      // Should call sharded session store's invalidateSessionRpc
      expect(mockShardedSessionStore.invalidateSessionRpc).toHaveBeenCalledWith('0_session_123');
      expect(vi.mocked(revokeGuestResumeForSession).mock.invocationCallOrder[0]).toBeLessThan(
        mockShardedSessionStore.invalidateSessionRpc.mock.invocationCallOrder[0]
      );
    });

    securityRegressionIt(
      '[security regression][AO-16] requires explicit intent before an ambient GET logs out the browser session',
      async () => {
        const { c } = createMockContext({
          method: 'GET',
          query: {},
        });

        mockShardedSessionStore.invalidateSessionRpc.mockReset();
        mockShardedSessionStore.invalidateSessionRpc.mockResolvedValue(true);
        vi.mocked(getCookie).mockReturnValue('0_session_csrf_victim');

        const response = await frontChannelLogoutHandler(c);

        expect(mockShardedSessionStore.invalidateSessionRpc).not.toHaveBeenCalled();
        expect(setCookie).not.toHaveBeenCalledWith(c, 'authrim_session', '', expect.anything());
      }
    );

    it('starts confirmation without invalidating a session for a direct RP-initiated POST', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          id_token_hint: 'valid.id.token',
          post_logout_redirect_uri: 'https://rp.example.com/logged-out',
          state: 'rp-state',
        },
      });

      mockShardedSessionStore.invalidateSessionRpc.mockReset();
      vi.mocked(getCookie).mockReturnValue('0_session_rp_post');

      const response = await frontChannelLogoutHandler(c);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('Confirm logout');
      expect(html).toContain('name="id_token_hint" value="valid.id.token"');
      expect(html).toContain('name="state" value="rp-state"');
      expect(mockShardedSessionStore.invalidateSessionRpc).not.toHaveBeenCalled();
      expect(setCookie).not.toHaveBeenCalledWith(c, 'authrim_session', '', expect.anything());
    });

    it('should render front-channel logout iframes for clients linked to the session', async () => {
      const { c } = createMockContext({
        query: {},
        body: { confirmation_token: '0_session_123' },
      });

      mockShardedSessionStore.invalidateSessionRpc.mockReset();
      mockShardedSessionStore.invalidateSessionRpc.mockResolvedValue(true);
      vi.mocked(getCookie).mockReturnValue('0_session_123');
      vi.mocked(resolveLogoutTargetsFromSessionClientStore).mockResolvedValueOnce({
        backchannelClients: [],
        frontchannelClients: [
          {
            client_id: 'rp-client',
            oidc_sid: 'rp-session-123',
            frontchannel_logout_uri: 'https://rp.example.com/logout',
            frontchannel_logout_session_required: true,
          },
        ],
        webhookClients: [],
      } as unknown as Awaited<ReturnType<typeof resolveLogoutTargetsFromSessionClientStore>>);

      const response = await frontChannelLogoutHandler(c);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      expect(response.headers.get('Set-Cookie')).toContain('authrim_session=');
      expect(html).toContain('https://rp.example.com/logout');
      expect(html).toContain('iss=https%3A%2F%2Fop.example.com');
      expect(html).toContain('sid=rp-session-123');
      expect(html).not.toContain('sid=0_session_123');
      expect(mockShardedSessionStore.invalidateSessionRpc).toHaveBeenCalledWith('0_session_123');
    });

    it('hands the ended session clients to the shared downstream fan-out after the response', async () => {
      const { c } = createMockContext({
        query: {},
        body: { confirmation_token: '0_session_123' },
      });
      const waitUntil = vi.fn();
      c.executionCtx = { waitUntil };
      const backchannelClient = {
        client_id: 'rp-client',
        oidc_sid: 'rp-session-123',
        backchannel_logout_uri: 'https://rp.example.com/backchannel',
        backchannel_logout_session_required: true,
      };
      const webhookClient = {
        client_id: 'rp-webhook',
        logout_webhook_uri: 'https://rp.example.com/webhook',
      };

      mockShardedSessionStore.invalidateSessionRpc.mockReset();
      mockShardedSessionStore.invalidateSessionRpc.mockResolvedValue(true);
      vi.mocked(getCookie).mockReturnValue('0_session_123');
      vi.mocked(resolveLogoutTargetsFromSessionClientStore).mockResolvedValueOnce({
        backchannelClients: [backchannelClient],
        frontchannelClients: [],
        webhookClients: [webhookClient],
      } as unknown as Awaited<ReturnType<typeof resolveLogoutTargetsFromSessionClientStore>>);

      const response = await frontChannelLogoutHandler(c);
      await Promise.all(waitUntil.mock.calls.map(([promise]) => promise));

      expect(reportLogoutNotSent).not.toHaveBeenCalled();
      expect(sendBackchannelLogoutFanout).toHaveBeenCalledWith(
        c.env,
        expect.objectContaining({
          tenantId: 'default',
          issuer: 'https://canonical.example.com',
          config: DEFAULT_LOGOUT_CONFIG.backchannel,
          onAlert: expect.any(Function),
          sessions: [
            expect.objectContaining({
              sessionId: '0_session_123',
              backchannelClients: [backchannelClient],
              webhookClients: [webhookClient],
            }),
          ],
        })
      );
      expect(sendLogoutWebhookFanout).toHaveBeenCalledWith(
        c.env,
        expect.objectContaining({
          issuer: 'https://canonical.example.com',
          sessions: [expect.objectContaining({ sessionId: '0_session_123' })],
        })
      );
    });

    it('sends nothing downstream, and still logs the user out, when the tenant issuer cannot be resolved', async () => {
      const { c } = createMockContext({
        query: {},
        body: { confirmation_token: '0_session_123' },
      });
      const waitUntil = vi.fn();
      c.executionCtx = { waitUntil };

      mockShardedSessionStore.invalidateSessionRpc.mockReset();
      mockShardedSessionStore.invalidateSessionRpc.mockResolvedValue(true);
      vi.mocked(getCookie).mockReturnValue('0_session_123');
      vi.mocked(resolveLogoutTargetsFromSessionClientStore).mockResolvedValueOnce({
        backchannelClients: [{ client_id: 'rp-client', oidc_sid: 'rp-session-123' }],
        frontchannelClients: [],
        webhookClients: [{ client_id: 'rp-webhook' }],
      } as unknown as Awaited<ReturnType<typeof resolveLogoutTargetsFromSessionClientStore>>);
      vi.mocked(resolveLogoutIssuerWithRetry).mockResolvedValueOnce(null);

      const response = await frontChannelLogoutHandler(c);
      await Promise.all(waitUntil.mock.calls.map(([promise]) => promise));

      expect(response.status).toBeLessThan(500);
      expect(mockShardedSessionStore.invalidateSessionRpc).toHaveBeenCalledWith('0_session_123');
      // No other issuer is made up from the request's host: nothing is sent.
      expect(sendBackchannelLogoutFanout).not.toHaveBeenCalled();
      expect(sendLogoutWebhookFanout).not.toHaveBeenCalled();
      // Nothing was told, so the records of the ended session stay until they expire.
      expect(purgeEndedSessionsFromSessionClientStore).not.toHaveBeenCalled();
      // The apps that were not told are recorded for the admin, with the path.
      expect(reportLogoutNotSent).toHaveBeenCalledWith(
        c.env,
        expect.objectContaining({
          tenantId: 'default',
          trigger: 'user_logout',
          backchannelEnabled: DEFAULT_LOGOUT_CONFIG.backchannel.enabled,
          sessions: [
            expect.objectContaining({
              sessionId: '0_session_123',
              backchannelClients: [expect.objectContaining({ client_id: 'rp-client' })],
              webhookClients: [expect.objectContaining({ client_id: 'rp-webhook' })],
            }),
          ],
        })
      );
    });

    describe('removing the ended session from the SessionClientStore', () => {
      const backchannelClient = {
        client_id: 'rp-client',
        oidc_sid: 'rp-session-123',
        backchannel_logout_uri: 'https://rp.example.com/backchannel',
        backchannel_logout_session_required: true,
      };

      function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        return { promise, resolve, reject };
      }

      function setUp() {
        const { c } = createMockContext({
          query: {},
          body: { confirmation_token: '0_session_123' },
        });
        const waitUntil = vi.fn();
        c.executionCtx = { waitUntil };
        mockShardedSessionStore.invalidateSessionRpc.mockReset();
        mockShardedSessionStore.invalidateSessionRpc.mockResolvedValue(true);
        vi.mocked(getCookie).mockReturnValue('0_session_123');
        vi.mocked(resolveLogoutTargetsFromSessionClientStore).mockResolvedValueOnce({
          backchannelClients: [backchannelClient],
          frontchannelClients: [],
          webhookClients: [],
        } as unknown as Awaited<ReturnType<typeof resolveLogoutTargetsFromSessionClientStore>>);
        vi.mocked(purgeEndedSessionsFromSessionClientStore).mockClear();
        return { c, waitUntil };
      }

      const settleAll = (waitUntil: ReturnType<typeof vi.fn>) =>
        Promise.allSettled(waitUntil.mock.calls.map(([promise]) => promise));

      it('removes it only after both notices have finished', async () => {
        const { c, waitUntil } = setUp();
        const backchannel = deferred<null>();
        const webhook = deferred<null>();
        vi.mocked(sendBackchannelLogoutFanout).mockReturnValueOnce(backchannel.promise);
        vi.mocked(sendLogoutWebhookFanout).mockReturnValueOnce(webhook.promise);

        const response = await frontChannelLogoutHandler(c);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(purgeEndedSessionsFromSessionClientStore).not.toHaveBeenCalled();

        backchannel.resolve(null);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(purgeEndedSessionsFromSessionClientStore).not.toHaveBeenCalled();

        webhook.resolve(null);
        await settleAll(waitUntil);
        expect(purgeEndedSessionsFromSessionClientStore).toHaveBeenCalledWith(c.env, 'default', [
          '0_session_123',
        ]);
        // The targets were read before the removal, and the notices got them.
        expect(
          vi.mocked(resolveLogoutTargetsFromSessionClientStore).mock.invocationCallOrder[0]
        ).toBeLessThan(
          vi.mocked(purgeEndedSessionsFromSessionClientStore).mock.invocationCallOrder[0]
        );
        expect(sendBackchannelLogoutFanout).toHaveBeenCalledWith(
          c.env,
          expect.objectContaining({
            sessions: [expect.objectContaining({ backchannelClients: [backchannelClient] })],
          })
        );
      });

      it('still removes it when a notice fails', async () => {
        const { c, waitUntil } = setUp();
        vi.mocked(sendBackchannelLogoutFanout).mockRejectedValueOnce(new Error('send failed'));

        const response = await frontChannelLogoutHandler(c);
        await settleAll(waitUntil);

        expect(purgeEndedSessionsFromSessionClientStore).toHaveBeenCalledWith(c.env, 'default', [
          '0_session_123',
        ]);
      });

      it('keeps the notices when the removal fails', async () => {
        const { c, waitUntil } = setUp();
        vi.mocked(purgeEndedSessionsFromSessionClientStore).mockRejectedValueOnce(
          new Error('storage unavailable')
        );

        const response = await frontChannelLogoutHandler(c);
        const results = await settleAll(waitUntil);

        expect(response.status).not.toBe(503);
        expect(sendBackchannelLogoutFanout).toHaveBeenCalled();
        expect(sendLogoutWebhookFanout).toHaveBeenCalled();
        // Only the removal itself failed: the notices' own work after the response did not.
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      });

      it('keeps it, and records the apps not told, when a notice broke off before sending', async () => {
        const { c, waitUntil } = setUp();
        vi.mocked(sendBackchannelLogoutFanout).mockImplementationOnce(async (_env, params) => {
          params.onIncomplete?.({
            kind: 'backchannel',
            sessionIds: ['0_session_123'],
            reason: 'signing_key_unavailable',
          });
          return null;
        });

        const response = await frontChannelLogoutHandler(c);
        await settleAll(waitUntil);

        expect(reportLogoutTargetsUnavailable).toHaveBeenCalledWith(
          c.env,
          expect.objectContaining({ sessionCount: 0 })
        );
        expect(reportIncompleteLogouts).toHaveBeenCalledWith(
          c.env,
          expect.objectContaining({
            tenantId: 'default',
            trigger: 'user_logout',
            incomplete: [
              {
                kind: 'backchannel',
                sessionIds: ['0_session_123'],
                reason: 'signing_key_unavailable',
              },
            ],
          })
        );
        expect(purgeEndedSessionsFromSessionClientStore).not.toHaveBeenCalled();
      });

      it('keeps it when its clients could not be read', async () => {
        const { c, waitUntil } = setUp();
        vi.mocked(resolveLogoutTargetsFromSessionClientStore)
          .mockReset()
          .mockRejectedValueOnce(new Error('store unavailable'));
        vi.mocked(resolveLogoutTargetsFromSessionClientStore).mockResolvedValue(null);

        const response = await frontChannelLogoutHandler(c);
        await settleAll(waitUntil);

        expect(purgeEndedSessionsFromSessionClientStore).not.toHaveBeenCalled();
        // The admin can see how many sessions ended without their apps being told.
        expect(reportLogoutTargetsUnavailable).toHaveBeenCalledWith(
          c.env,
          expect.objectContaining({
            tenantId: 'default',
            trigger: 'user_logout',
            sessionCount: 1,
          })
        );
      });

      it('does not treat unreadable webhook settings as off: the webhook apps are recorded and kept', async () => {
        const { c, waitUntil } = setUp();
        vi.mocked(resolveLogoutTargetsFromSessionClientStore).mockReset();
        vi.mocked(resolveLogoutTargetsFromSessionClientStore).mockResolvedValueOnce({
          backchannelClients: [],
          frontchannelClients: [],
          webhookClients: [{ client_id: 'rp-webhook' }],
        } as unknown as Awaited<ReturnType<typeof resolveLogoutTargetsFromSessionClientStore>>);
        vi.mocked(resolveLogoutWebhookConfig).mockRejectedValueOnce(new Error('kv down'));

        const response = await frontChannelLogoutHandler(c);
        await settleAll(waitUntil);

        expect(sendLogoutWebhookFanout).not.toHaveBeenCalled();
        expect(reportIncompleteLogouts).toHaveBeenCalledWith(
          c.env,
          expect.objectContaining({
            incomplete: [
              {
                kind: 'webhook',
                sessionIds: ['0_session_123'],
                reason: 'webhook_settings_unavailable',
              },
            ],
          })
        );
        expect(purgeEndedSessionsFromSessionClientStore).not.toHaveBeenCalled();
      });

      it('includes the webhook apps in the report of an unresolved issuer when the webhook settings are unreadable', async () => {
        const { c, waitUntil } = setUp();
        vi.mocked(resolveLogoutIssuerWithRetry).mockResolvedValueOnce(null);
        vi.mocked(resolveLogoutWebhookConfig).mockRejectedValueOnce(new Error('kv down'));

        const response = await frontChannelLogoutHandler(c);
        await settleAll(waitUntil);

        expect(reportLogoutNotSent).toHaveBeenCalledWith(
          c.env,
          expect.objectContaining({ trigger: 'user_logout', webhookEnabled: true })
        );
      });

      it('leaves the webhook apps out of that report when the webhook is explicitly off', async () => {
        const { c, waitUntil } = setUp();
        vi.mocked(resolveLogoutIssuerWithRetry).mockResolvedValueOnce(null);

        const response = await frontChannelLogoutHandler(c);
        await settleAll(waitUntil);

        expect(reportLogoutNotSent).toHaveBeenCalledWith(
          c.env,
          expect.objectContaining({ webhookEnabled: false })
        );
      });

      it('removes nothing when no session ended', async () => {
        const { c, waitUntil } = setUp();
        mockShardedSessionStore.invalidateSessionRpc.mockResolvedValue(false);

        const response = await frontChannelLogoutHandler(c);
        await settleAll(waitUntil);

        expect(purgeEndedSessionsFromSessionClientStore).not.toHaveBeenCalled();
      });
    });

    it('should handle logout when no session exists', async () => {
      const { c } = createMockContext({
        method: 'GET',
        query: {},
      });

      vi.mocked(getCookie).mockReturnValue(undefined);

      const response = await frontChannelLogoutHandler(c);

      expect(c.redirect).toHaveBeenCalledWith('https://op.example.com/logged-out', 302);
    });
  });

  describe('a confirmed logout does not redirect the confirmation form', () => {
    // Browsers apply the confirmation page's form-action ('self') to the redirects after its form
    // is submitted: a 302 to the RP's post_logout_redirect_uri was aborted (net::ERR_ABORTED), so
    // the browser never got back to the RP.
    const confirmedLogoutToRp = () => {
      const { c } = createMockContext({
        query: {
          id_token_hint: 'valid.id.token',
          post_logout_redirect_uri: 'https://app.example.com/logout-callback',
          state: 'state-1',
        },
      });
      vi.mocked(getCookie).mockReturnValue('session-123');
      vi.mocked(validateIdTokenHint).mockResolvedValue({
        valid: true,
        userId: 'user-123',
        clientId: 'client-123',
      });
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            post_logout_redirect_uris: JSON.stringify(['https://app.example.com/logout-callback']),
          }),
        }),
      });
      return c;
    };

    it('answers with a same-origin page that moves on to the RP', async () => {
      const c = confirmedLogoutToRp();
      const response = await frontChannelLogoutHandler(c);

      expect(c.redirect).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
      expect(await continuedTo(response)).toBe(
        'https://app.example.com/logout-callback?state=state-1'
      );
    });

    it('still clears the session cookies on that page', async () => {
      const response = await frontChannelLogoutHandler(confirmedLogoutToRp());
      const cookies = response.headers.get('Set-Cookie') ?? '';
      expect(cookies).toContain('authrim_session=;');
      expect(cookies).toContain('Max-Age=0');
    });

    it("keeps form-action 'self' on the confirmation page", async () => {
      const { c } = createMockContext({
        method: 'GET',
        query: {
          id_token_hint: 'valid.id.token',
          post_logout_redirect_uri: 'https://app.example.com/logout-callback',
        },
      });
      vi.mocked(getCookie).mockReturnValue('session-123');
      await frontChannelLogoutHandler(c);
      const headers = vi.mocked(c.body).mock.calls[0][2] as Record<string, string>;
      expect(headers['Content-Security-Policy']).toContain("form-action 'self';");
    });

    it('escapes the URL it moves on to', () => {
      const html = renderLogoutContinuationPage(
        'https://app.example.com/cb?a=1&b="><script>x</script>'
      );
      const escaped =
        'https://app.example.com/cb?a=1&amp;b=&quot;&gt;&lt;script&gt;x&lt;/script&gt;';
      expect(html).not.toContain('<script>');
      expect(html).toContain(`content="0;url=${escaped}"`);
      expect(html).toContain(`href="${escaped}"`);
    });
  });

  describe('a global logout with an id_token_hint whose sub an identity mapping chose', () => {
    function globalLogoutWithHint(payload: Record<string, unknown>) {
      const { c } = createMockContext({
        query: {},
        body: {
          confirmation_token: '0_session_123',
          id_token_hint: 'signed.id.token',
          logout_scope: 'global',
        },
      });
      vi.mocked(getCookie).mockReturnValue('0_session_123');
      mockShardedSessionStore.invalidateSessionRpc.mockReset().mockResolvedValue(true);
      vi.mocked(isNativeSSOEnabled).mockResolvedValue(true);
      vi.mocked(validateIdTokenHint).mockResolvedValue({
        valid: true,
        userId: payload.sub as string,
        clientId: 'client-123',
        payload,
      });
      return c;
    }

    securityRegressionIt(
      "does not revoke the devices of the account a hint's unproven sub equals",
      async () => {
        // Issued without a sealed reference: its mapped sub equals another user's id.
        await frontChannelLogoutHandler(
          globalLogoutWithHint({ sub: 'user-2', aud: 'client-123', authrim_consent_generation: 0 })
        );

        expect(revokeDeviceSecretsForLogoutScope).toHaveBeenCalledTimes(1);
        const input = vi.mocked(revokeDeviceSecretsForLogoutScope).mock.calls[0][0];
        expect(input.scope).toBe('global');
        expect(input.sessionIds).toEqual(['0_session_123']);
        // The session's own anchors name the user instead.
        expect(input.userId).toBeUndefined();
      }
    );

    it('revokes the devices of the user a marked hint names', async () => {
      await frontChannelLogoutHandler(
        globalLogoutWithHint({ sub: 'user-1', aud: 'client-123', authrim_subject_account: true })
      );

      const input = vi.mocked(revokeDeviceSecretsForLogoutScope).mock.calls[0][0];
      expect(input.userId).toBe('user-1');
    });
  });

  describe('ID Token Hint Validation', () => {
    it('should validate id_token_hint and extract user info', async () => {
      const { c } = createMockContext({
        query: {
          id_token_hint: 'valid.id.token',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');
      vi.mocked(validateIdTokenHint).mockResolvedValue({
        valid: true,
        userId: 'user-123',
        clientId: 'client-123',
      });

      const response = await frontChannelLogoutHandler(c);

      expect(validateIdTokenHint).toHaveBeenCalled();
      expect(await continuedTo(response)).toEqual(expect.any(String));
    });

    it('should redirect to default page when id_token_hint validation fails (without post_logout_redirect_uri)', async () => {
      const { c } = createMockContext({
        query: {
          id_token_hint: 'invalid.id.token',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');
      vi.mocked(validateIdTokenHint).mockResolvedValue({
        valid: false,
        error: 'id_token_hint validation failed',
        errorCode: 'invalid_token',
      });

      const response = await frontChannelLogoutHandler(c);

      // Session should still be invalidated even with invalid id_token_hint
      // Without post_logout_redirect_uri, no validation error - just go to logged-out page
      expect(await continuedTo(response)).toBe('https://op.example.com/logged-out');
    });

    it('should redirect to error page when id_token_hint validation fails (with post_logout_redirect_uri)', async () => {
      const { c } = createMockContext({
        query: {
          id_token_hint: 'invalid.id.token',
          post_logout_redirect_uri: 'https://app.example.com/logout-callback',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');
      vi.mocked(validateIdTokenHint).mockResolvedValue({
        valid: false,
        error: 'id_token_hint validation failed',
        errorCode: 'invalid_token',
      });

      const response = await frontChannelLogoutHandler(c);

      // Session should still be invalidated even with invalid id_token_hint
      // With post_logout_redirect_uri, invalid id_token_hint is an error
      expect(await continuedTo(response)).toBe(
        'https://op.example.com/logout-error?error=invalid_id_token_hint'
      );
    });

    it('should redirect to default page when id_token_hint format is invalid', async () => {
      const { c } = createMockContext({
        query: {
          id_token_hint: 'not-a-valid-jwt',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');
      vi.mocked(validateIdTokenHint).mockResolvedValue({
        valid: false,
        error: 'id_token_hint is not a valid JWT format',
        errorCode: 'invalid_token',
      });

      const response = await frontChannelLogoutHandler(c);

      // Session should still be invalidated even with invalid format
      // Redirect to default logout page instead of returning error
      expect(await continuedTo(response)).toBe('https://op.example.com/logged-out');
    });
  });

  describe('Post Logout Redirect URI Validation', () => {
    it('should redirect to registered post_logout_redirect_uri', async () => {
      const { c } = createMockContext({
        query: {
          id_token_hint: 'valid.id.token',
          post_logout_redirect_uri: 'https://app.example.com/logout-callback',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');
      vi.mocked(validateIdTokenHint).mockResolvedValue({
        valid: true,
        userId: 'user-123',
        clientId: 'client-123',
      });

      // Mock DB to return client with registered post_logout_redirect_uris
      // Per OIDC RP-Initiated Logout 1.0, only post_logout_redirect_uris are used
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            post_logout_redirect_uris: JSON.stringify([
              'https://app.example.com/callback',
              'https://app.example.com/logout-callback',
            ]),
          }),
        }),
      });

      const response = await frontChannelLogoutHandler(c);

      expect(await continuedTo(response)).toBe('https://app.example.com/logout-callback');
    });

    it('should redirect to error page for unregistered post_logout_redirect_uri', async () => {
      const { c } = createMockContext({
        query: {
          id_token_hint: 'valid.id.token',
          post_logout_redirect_uri: 'https://malicious.example.com/callback',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');
      vi.mocked(validateIdTokenHint).mockResolvedValue({
        valid: true,
        userId: 'user-123',
        clientId: 'client-123',
      });
      vi.mocked(validatePostLogoutRedirectUri).mockReturnValue({
        valid: false,
        error: 'post_logout_redirect_uri is not registered for this client',
      });

      // Mock DB to return client with registered post_logout_redirect_uris
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            post_logout_redirect_uris: JSON.stringify(['https://app.example.com/callback']),
          }),
        }),
      });

      const response = await frontChannelLogoutHandler(c);

      // Session should still be invalidated, but redirect to error page
      // instead of malicious URI - per OIDC conformance requirements
      expect(await continuedTo(response)).toBe(
        'https://op.example.com/logout-error?error=unregistered_post_logout_redirect_uri'
      );
    });

    it('should redirect to error page when no post_logout_redirect_uris are registered', async () => {
      const { c } = createMockContext({
        query: {
          id_token_hint: 'valid.id.token',
          post_logout_redirect_uri: 'https://app.example.com/logout-callback',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');
      vi.mocked(validateIdTokenHint).mockResolvedValue({
        valid: true,
        userId: 'user-123',
        clientId: 'client-123',
      });

      // Mock DB to return client WITHOUT post_logout_redirect_uris
      // Only redirect_uris are set, which should NOT be used per OIDC spec
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            redirect_uris: JSON.stringify(['https://app.example.com/callback']),
            post_logout_redirect_uris: null,
          }),
        }),
      });

      const response = await frontChannelLogoutHandler(c);

      // Session should still be invalidated, redirect to error page
      // since no post_logout_redirect_uris are registered - this is a validation error
      expect(await continuedTo(response)).toBe(
        'https://op.example.com/logout-error?error=unregistered_post_logout_redirect_uri'
      );
    });

    it('should include state parameter in redirect', async () => {
      const { c } = createMockContext({
        query: {
          id_token_hint: 'valid.id.token',
          post_logout_redirect_uri: 'https://app.example.com/logout-callback',
          state: 'state-value-123',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');
      vi.mocked(validateIdTokenHint).mockResolvedValue({
        valid: true,
        userId: 'user-123',
        clientId: 'client-123',
      });

      // Mock DB to return client with registered post_logout_redirect_uris
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            post_logout_redirect_uris: JSON.stringify([
              'https://app.example.com/callback',
              'https://app.example.com/logout-callback',
            ]),
          }),
        }),
      });

      const response = await frontChannelLogoutHandler(c);

      expect(await continuedTo(response)).toBe(
        'https://app.example.com/logout-callback?state=state-value-123'
      );
    });

    it('should redirect to error page when id_token_hint is missing but post_logout_redirect_uri provided', async () => {
      const { c } = createMockContext({
        query: {
          post_logout_redirect_uri: 'https://app.example.com/logout-callback',
          state: 'state-value-123',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');
      vi.mocked(validateLogoutParameters).mockReturnValue({
        valid: false,
        error: 'id_token_hint is required when post_logout_redirect_uri is provided',
      });

      const response = await frontChannelLogoutHandler(c);

      // Session should still be invalidated, but redirect to error page
      // since we can't validate post_logout_redirect_uri without id_token_hint
      // Per OIDC RP-Initiated Logout spec, this is a validation error
      expect(await continuedTo(response)).toBe(
        'https://op.example.com/logout-error?error=id_token_hint_required'
      );
    });

    it('should not include state when no post_logout_redirect_uri', async () => {
      const { c } = createMockContext({
        query: {
          state: 'state-value-123',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');

      const response = await frontChannelLogoutHandler(c);

      expect(await continuedTo(response)).toBe('https://op.example.com/logged-out');
    });
  });

  describe('Error Handling', () => {
    it('should return 500 on unexpected error', async () => {
      const { c } = createMockContext({
        query: {},
      });

      vi.mocked(getCookie).mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      await frontChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'server_error',
          error_description: 'Failed to process logout request',
        }),
        500
      );
    });
  });
});

describe('Back-channel Logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Logout Token Validation', () => {
    it('should return 400 when logout_token is missing', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {},
      });

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'logout_token is required',
        }),
        400
      );
    });

    it('should validate logout_token signature', async () => {
      const { c, mockSessionStore } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: {
          Authorization: 'Basic ' + btoa('client-123:client-secret'),
        },
      });

      // Mock session store to handle session deletion (when sid is not provided)
      mockSessionStore.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ sessions: [] }), { status: 200 })
      );

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-123',
          aud: 'client-123',
          sid: 'session-123', // Include sid to avoid sessions lookup
          events: {
            'http://schemas.openid.net/event/backchannel-logout': {},
          },
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      // Mock DB for client lookup
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret_hash: 'hash_client-secret',
          }),
        }),
      });

      await backChannelLogoutHandler(c);

      expect(jwtVerify).toHaveBeenCalled();
      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('should return 400 when logout_token validation fails', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'invalid.logout.token',
        },
        headers: VALID_BACKCHANNEL_AUTH_HEADER,
      });
      mockValidBackchannelClient(c);

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockRejectedValue(new Error('Invalid signature'));

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Invalid logout_token',
        }),
        400
      );
    });
  });

  describe('Logout Token Claims Validation', () => {
    it('should require sub claim in logout_token', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: VALID_BACKCHANNEL_AUTH_HEADER,
      });
      mockValidBackchannelClient(c);

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: {
          // Missing 'sub' claim
          aud: 'client-123',
          events: {
            'http://schemas.openid.net/event/backchannel-logout': {},
          },
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('sub claim'),
        }),
        400
      );
    });

    it('should require backchannel-logout event in logout_token', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: VALID_BACKCHANNEL_AUTH_HEADER,
      });
      mockValidBackchannelClient(c);

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-123',
          aud: 'client-123',
          // Missing 'events' claim
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('backchannel-logout event'),
        }),
        400
      );
    });

    it('should reject logout_token with nonce claim (per spec)', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: VALID_BACKCHANNEL_AUTH_HEADER,
      });
      mockValidBackchannelClient(c);

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-123',
          aud: 'client-123',
          events: {
            'http://schemas.openid.net/event/backchannel-logout': {},
          },
          nonce: 'should-not-be-present', // Per spec, nonce MUST NOT be present
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('nonce claim'),
        }),
        400
      );
    });
  });

  describe('Client Authentication', () => {
    it('should require client authentication', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
      });

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client',
          error_description: 'Client authentication is required',
        }),
        401
      );
    });

    it('should reject unsupported client authentication methods', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: {
          Authorization: 'Bearer test-token',
        },
      });

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client',
          error_description: 'Unsupported client authentication method',
        }),
        401
      );
    });

    it('should authenticate client with HTTP Basic', async () => {
      const { c, mockSessionStore } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: {
          Authorization: 'Basic ' + btoa('client-123:client-secret'),
        },
      });

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-123',
          aud: 'client-123',
          sid: 'session-123', // Include sid to avoid sessions lookup
          events: {
            'http://schemas.openid.net/event/backchannel-logout': {},
          },
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      // Mock DB for client lookup with correct secret hash
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret_hash: 'hash_client-secret',
          }),
        }),
      });

      await backChannelLogoutHandler(c);

      expect(c.body).toHaveBeenCalledWith(null, 200);
    });

    it('should reject invalid client credentials', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: {
          Authorization: 'Basic ' + btoa('client-123:wrong-secret'),
        },
      });

      // Mock DB for client lookup with different secret hash
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret_hash: 'hash_correct-secret',
          }),
        }),
      });

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client',
          error_description: 'Invalid client credentials',
        }),
        401
      );
    });

    it('should use hash verification for client secret', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: {
          Authorization: 'Basic ' + btoa('client-123:client-secret'),
        },
      });

      // Mock DB for client lookup with secret hash
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret_hash: 'hash_client-secret',
          }),
        }),
      });

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-123',
          aud: 'client-123',
          events: {
            'http://schemas.openid.net/event/backchannel-logout': {},
          },
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      await backChannelLogoutHandler(c);

      expect(verifyClientSecretHash).toHaveBeenCalled();
    });

    it('should reject non-existent client', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: {
          Authorization: 'Basic ' + btoa('nonexistent-client:secret'),
        },
      });

      // Mock DB to return null (client not found)
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client',
        }),
        401
      );
    });
  });

  describe('Session Invalidation', () => {
    beforeEach(() => {
      // Reset mock for sharded session store (RPC pattern)
      mockShardedSessionStore.invalidateSessionRpc.mockReset();
      mockShardedSessionStore.invalidateSessionRpc.mockResolvedValue(true);
    });

    it('should invalidate specific session when sid is provided (sharded format)', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: VALID_BACKCHANNEL_AUTH_HEADER,
      });
      mockValidBackchannelClient(c);

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-123',
          sid: '0_session_456', // Sharded session ID format
          events: {
            'http://schemas.openid.net/event/backchannel-logout': {},
          },
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      await backChannelLogoutHandler(c);

      // Should call the sharded session store's invalidateSessionRpc
      expect(mockShardedSessionStore.invalidateSessionRpc).toHaveBeenCalledWith('0_session_456');
    });

    it('should log warning when sid is not a sharded session ID', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: VALID_BACKCHANNEL_AUTH_HEADER,
      });
      mockValidBackchannelClient(c);

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-123',
          sid: 'legacy-session-format', // Non-sharded format
          events: {
            'http://schemas.openid.net/event/backchannel-logout': {},
          },
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      await backChannelLogoutHandler(c);

      // Should NOT call the sharded session store (non-sharded sid is ignored)
      expect(mockShardedSessionStore.invalidateSessionRpc).not.toHaveBeenCalled();
      // Should log a warning about the limitation
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    securityRegressionIt(
      'refuses a logout token without sid rather than end the sessions of the account its sub equals',
      async () => {
        // A logout token carries the sub the app's ID tokens carry, which an identity mapping may
        // have chosen; it may equal another user's id, and no reference says whose it is.
        const { c } = createMockContext({
          method: 'POST',
          body: {
            logout_token: 'valid.logout.token',
          },
          headers: VALID_BACKCHANNEL_AUTH_HEADER,
        });
        mockValidBackchannelClient(c);

        vi.mocked(importJWK).mockResolvedValue({} as any);
        vi.mocked(jwtVerify).mockResolvedValue({
          payload: {
            sub: 'user-123',
            jti: 'logout-jti-1',
            events: {
              'http://schemas.openid.net/event/backchannel-logout': {},
            },
          },
          protectedHeader: { alg: 'RS256' },
        } as any);

        await backChannelLogoutHandler(c);

        expect(c.json).toHaveBeenCalledWith(
          {
            error: 'invalid_request',
            error_description: 'logout_token must contain sid claim',
          },
          400
        );
        expect(mockShardedSessionStore.invalidateSessionRpc).not.toHaveBeenCalled();
        expect(recordHybridUserSessionRevocationEpoch).not.toHaveBeenCalled();
      }
    );

    securityRegressionIt(
      "revokes the devices of the sid session's user, not of the account the sub equals",
      async () => {
        const { c } = createMockContext({
          method: 'POST',
          body: {
            logout_token: 'valid.logout.token',
          },
          headers: VALID_BACKCHANNEL_AUTH_HEADER,
        });
        mockValidBackchannelClient(c);
        mockShardedSessionStore.getSessionRpc.mockResolvedValueOnce({
          id: '0_session_456',
          userId: 'user-1',
          expiresAt: Date.now() + 60_000,
          createdAt: Date.now(),
          data: {},
        });
        mockShardedSessionStore.invalidateSessionRpc.mockReset().mockResolvedValue(true);
        vi.mocked(isNativeSSOEnabled).mockResolvedValue(true);

        vi.mocked(importJWK).mockResolvedValue({} as any);
        vi.mocked(jwtVerify).mockResolvedValue({
          payload: {
            sub: 'user-2',
            sid: '0_session_456',
            jti: 'logout-jti-1',
            events: {
              'http://schemas.openid.net/event/backchannel-logout': {},
            },
          },
          protectedHeader: { alg: 'RS256' },
        } as any);

        await backChannelLogoutHandler(c);

        expect(mockShardedSessionStore.invalidateSessionRpc).toHaveBeenCalledWith('0_session_456');
        const input = vi.mocked(revokeDeviceSecretsForLogoutScope).mock.calls[0][0];
        expect(input.sessionIds).toEqual(['0_session_456']);
        expect(input.userId).toBe('user-1');
      }
    );
  });

  describe('Error Handling', () => {
    it('should return 500 on unexpected error', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
      });

      c.req.parseBody = vi.fn().mockRejectedValue(new Error('Unexpected error'));

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'server_error',
          error_description: 'Failed to process logout request',
        }),
        500
      );
    });

    it('should handle JWKS fetch failure', async () => {
      const { c, mockKeyManager } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: VALID_BACKCHANNEL_AUTH_HEADER,
      });
      mockValidBackchannelClient(c);

      // Mock RPC call to reject (simulating JWKS fetch failure)
      mockKeyManager.getAllPublicKeysRpc.mockRejectedValue(new Error('Failed to fetch JWKS'));

      await backChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Invalid logout_token',
        }),
        400
      );
    });
  });
});
