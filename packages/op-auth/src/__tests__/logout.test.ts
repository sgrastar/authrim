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
import type { Env } from '@authrim/shared';

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

// Mock shared module
vi.mock('@authrim/shared', async () => {
  const actual = await vi.importActual('@authrim/shared');
  return {
    ...actual,
    timingSafeEqual: vi.fn((a: string, b: string) => a === b),
    validateIdTokenHint: vi.fn(),
    validatePostLogoutRedirectUri: vi.fn(),
    validateLogoutParameters: vi.fn(),
  };
});

import { frontChannelLogoutHandler, backChannelLogoutHandler } from '../logout';
import { getCookie, setCookie } from 'hono/cookie';
import { jwtVerify, importJWK } from 'jose';
import {
  timingSafeEqual,
  validateIdTokenHint,
  validatePostLogoutRedirectUri,
  validateLogoutParameters,
} from '@authrim/shared';

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
    fetch: vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          keys: [
            {
              kty: 'RSA',
              kid: 'key-1',
              n: 'mock-n',
              e: 'AQAB',
            },
          ],
        }),
        { status: 200 }
      )
    ),
  };

  const mockEnv: Partial<Env> = {
    ISSUER_URL: 'https://op.example.com',
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn(),
        }),
      }),
    } as unknown as D1Database,
    SESSION_STORE: {
      idFromName: vi.fn().mockReturnValue('session-store-id'),
      get: vi.fn().mockReturnValue(mockSessionStore),
    } as unknown as DurableObjectNamespace,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue('key-manager-id'),
      get: vi.fn().mockReturnValue(mockKeyManager),
    } as unknown as DurableObjectNamespace,
    ...options.env,
  };

  const c = {
    req: {
      query: (name: string) => options.query?.[name],
      header: (name: string) => options.headers?.[name],
      method: options.method || 'GET',
      parseBody: vi.fn().mockResolvedValue(options.body || {}),
    },
    env: mockEnv as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    redirect: vi.fn(
      (url, status = 302) => new Response(null, { status, headers: { Location: url } })
    ),
    body: vi.fn((body, status = 200) => new Response(body, { status })),
  } as any;

  return { c, mockSessionStore, mockKeyManager };
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

      expect(c.redirect).toHaveBeenCalledWith('https://op.example.com/logged-out', 302);
    });

    it('should clear session cookie on logout', async () => {
      const { c } = createMockContext({
        query: {},
      });

      vi.mocked(getCookie).mockReturnValue('session-123');

      await frontChannelLogoutHandler(c);

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

    it('should invalidate session in SessionStore', async () => {
      const { c, mockSessionStore } = createMockContext({
        query: {},
      });

      vi.mocked(getCookie).mockReturnValue('session-123');

      await frontChannelLogoutHandler(c);

      expect(mockSessionStore.fetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });

    it('should handle logout when no session exists', async () => {
      const { c } = createMockContext({
        query: {},
      });

      vi.mocked(getCookie).mockReturnValue(undefined);

      const response = await frontChannelLogoutHandler(c);

      expect(c.redirect).toHaveBeenCalledWith('https://op.example.com/logged-out', 302);
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

      await frontChannelLogoutHandler(c);

      expect(validateIdTokenHint).toHaveBeenCalled();
      expect(c.redirect).toHaveBeenCalled();
    });

    it('should return error when id_token_hint validation fails', async () => {
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

      await frontChannelLogoutHandler(c);

      // Should return error for invalid id_token_hint per OIDC spec
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_token',
          error_description: expect.stringContaining('validation failed'),
        }),
        400
      );
    });

    it('should return error when id_token_hint format is invalid', async () => {
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

      await frontChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_token',
        }),
        400
      );
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

      await frontChannelLogoutHandler(c);

      expect(c.redirect).toHaveBeenCalledWith('https://app.example.com/logout-callback', 302);
    });

    it('should reject unregistered post_logout_redirect_uri', async () => {
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

      await frontChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('not registered'),
        }),
        400
      );
    });

    it('should reject when no post_logout_redirect_uris are registered', async () => {
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

      await frontChannelLogoutHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('No post_logout_redirect_uris registered'),
        }),
        400
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

      await frontChannelLogoutHandler(c);

      expect(c.redirect).toHaveBeenCalledWith(
        'https://app.example.com/logout-callback?state=state-value-123',
        302
      );
    });

    it('should require id_token_hint when post_logout_redirect_uri is provided', async () => {
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

      await frontChannelLogoutHandler(c);

      // Should return error when id_token_hint is missing
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('id_token_hint is required'),
        }),
        400
      );
    });

    it('should not include state when no post_logout_redirect_uri', async () => {
      const { c } = createMockContext({
        query: {
          state: 'state-value-123',
        },
      });

      vi.mocked(getCookie).mockReturnValue('session-123');

      await frontChannelLogoutHandler(c);

      expect(c.redirect).toHaveBeenCalledWith('https://op.example.com/logged-out', 302);
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
            client_secret: 'client-secret',
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
      });

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
      });

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
      });

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
      });

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

      // Mock DB for client lookup with correct secret
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
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

      // Mock DB for client lookup with different secret
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'correct-secret',
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

    it('should use timing-safe comparison for client secret', async () => {
      const { c } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
        headers: {
          Authorization: 'Basic ' + btoa('client-123:client-secret'),
        },
      });

      // Mock DB for client lookup
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
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

      expect(timingSafeEqual).toHaveBeenCalled();
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
    it('should invalidate specific session when sid is provided', async () => {
      const { c, mockSessionStore } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
      });

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-123',
          sid: 'session-456',
          events: {
            'http://schemas.openid.net/event/backchannel-logout': {},
          },
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      await backChannelLogoutHandler(c);

      expect(mockSessionStore.fetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'DELETE',
          url: expect.stringContaining('session-456'),
        })
      );
    });

    it('should invalidate all sessions for user when sid is not provided', async () => {
      const { c, mockSessionStore } = createMockContext({
        method: 'POST',
        body: {
          logout_token: 'valid.logout.token',
        },
      });

      // Mock session store to return user sessions
      mockSessionStore.fetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              sessions: [{ id: 'session-1' }, { id: 'session-2' }, { id: 'session-3' }],
            }),
            { status: 200 }
          )
        )
        .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));

      vi.mocked(importJWK).mockResolvedValue({} as any);
      vi.mocked(jwtVerify).mockResolvedValue({
        payload: {
          sub: 'user-123',
          // No 'sid' - should invalidate all sessions
          events: {
            'http://schemas.openid.net/event/backchannel-logout': {},
          },
        },
        protectedHeader: { alg: 'RS256' },
      } as any);

      await backChannelLogoutHandler(c);

      // Should first fetch user sessions, then delete each
      expect(mockSessionStore.fetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: expect.stringContaining('user/user-123'),
        })
      );
    });
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
      });

      mockKeyManager.fetch.mockResolvedValue(
        new Response('Internal Server Error', { status: 500 })
      );

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
