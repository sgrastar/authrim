/**
 * Consent Handlers Unit Tests
 *
 * Tests for OAuth2/OIDC consent screen:
 * - GET: Display consent information
 * - POST: Handle approval/denial
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { getConsentItemsForScreen, processConsentItemDecisions } from '@authrim/ar-lib-core';
import { consentGetHandler, consentPostHandler } from '../consent';

const mockRedirectWithError = vi.hoisted(() => vi.fn());

vi.mock('../authorize', () => ({
  redirectWithError: mockRedirectWithError,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getConsentUserInfo: vi.fn(async (_db, subjectId: string) => {
      if (subjectId !== 'user-123') return null;
      return {
        id: 'user-123',
        email: 'user@example.com',
        name: 'Example User',
        picture: undefined,
      };
    }),
    getConsentItemsForScreen: vi.fn(async () => []),
    processConsentItemDecisions: vi.fn(async () => undefined),
  };
});

// Helper to create mock D1Database
function createMockDB(options: {
  firstResult?: any;
  allResults?: any[];
  runResult?: { success: boolean };
}) {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(options.firstResult ?? null),
    all: vi.fn().mockResolvedValue({ results: options.allResults ?? [] }),
    run: vi.fn().mockResolvedValue(options.runResult ?? { success: true }),
  };

  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    batch: vi.fn().mockResolvedValue([]),
    _mockStatement: mockStatement,
  } as unknown as D1Database & { _mockStatement: typeof mockStatement };
}

// Helper to create mock ChallengeStore DO
function createMockChallengeStore(challengeData?: any) {
  const challenges = new Map<string, any>();

  if (challengeData) {
    challenges.set(challengeData.id, challengeData);
  }

  return {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-id' }),
    get: vi.fn().mockReturnValue({
      // RPC methods (new interface)
      storeChallengeRpc: vi.fn().mockImplementation(async (request: { id: string }) => {
        challenges.set(request.id, request);
        return { success: true };
      }),
      consumeChallengeRpc: vi.fn().mockImplementation(async (request: { id: string }) => {
        const data = challenges.get(request.id);
        if (data) {
          challenges.delete(request.id);
          return data;
        }
        throw new Error('Challenge not found');
      }),
      getChallengeRpc: vi.fn().mockImplementation(async (id: string) => {
        return challenges.get(id) || null;
      }),
      deleteChallengeRpc: vi.fn().mockImplementation(async (id: string) => {
        const existed = challenges.has(id);
        challenges.delete(id);
        return { deleted: existed };
      }),
      // Legacy fetch method (kept for backwards compatibility)
      fetch: vi.fn().mockImplementation(async (request: Request) => {
        const url = new URL(request.url);
        const path = url.pathname;

        // GET /challenge/:id
        if (request.method === 'GET' && path.includes('/challenge/')) {
          const id = path.split('/').pop() ?? '';
          const data = challenges.get(id);
          if (data) {
            return new Response(JSON.stringify(data));
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        // POST /challenge/consume
        if (request.method === 'POST' && path.endsWith('/consume')) {
          const body = (await request.json()) as { id: string };
          const data = challenges.get(body.id);
          if (data) {
            challenges.delete(body.id); // Consume challenge
            return new Response(JSON.stringify(data));
          }
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }

        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }),
    }),
    _challenges: challenges,
  };
}

// Helper to create mock context
function createMockContext(options: {
  method?: string;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  db?: D1Database;
  challengeStore?: ReturnType<typeof createMockChallengeStore>;
  env?: Record<string, unknown>;
}) {
  const mockDB =
    options.db ??
    createMockDB({
      firstResult: null,
      allResults: [],
    });

  const challengeStore = options.challengeStore ?? createMockChallengeStore();

  // Store context values (simulating Hono's context store)
  const contextStore = new Map<string, unknown>([['tenantId', 'default']]);

  const c = {
    req: {
      method: options.method || 'GET',
      query: (name: string) => options.query?.[name],
      json: vi.fn().mockResolvedValue(options.body ?? {}),
      parseBody: vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn().mockImplementation((name: string) => {
        const normalizedName = name.toLowerCase();
        if (normalizedName === 'accept') {
          return options.headers?.accept ?? 'application/json';
        }
        if (normalizedName === 'content-type') {
          return options.headers?.['content-type'] ?? 'application/json';
        }
        return options.headers?.[normalizedName] ?? null;
      }),
    },
    env: {
      DB: mockDB,
      ISSUER_URL: 'https://example.com',
      CHALLENGE_STORE: challengeStore,
      AUTH_CODE_STORE: {
        idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-auth-code-id' }),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }))),
        }),
      },
      ...options.env,
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    html: vi.fn(
      (body: string, status = 200) =>
        new Response(body, {
          status,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        })
    ),
    redirect: vi.fn(
      (url: string, status: number) => new Response(null, { status, headers: { Location: url } })
    ),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
    _mockDB: mockDB,
    _challengeStore: challengeStore,
  } as any;

  return c;
}

describe('Consent Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConsentItemsForScreen).mockResolvedValue([]);
    vi.mocked(processConsentItemDecisions).mockResolvedValue(undefined);
    mockRedirectWithError.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          Location: 'https://example.com/callback?response=signed-jarm',
        },
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('consentGetHandler', () => {
    it('should require challenge_id parameter', async () => {
      const c = createMockContext({
        query: {},
      });

      await consentGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Missing challenge_id parameter',
        }),
        400
      );
    });

    it('should return error for invalid challenge', async () => {
      const c = createMockContext({
        query: { challenge_id: 'invalid-challenge' },
      });

      await consentGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('Invalid'),
        }),
        400
      );
    });

    it('should return error for wrong challenge type', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'test-challenge',
        type: 'passkey_registration', // Wrong type
        userId: 'user-123',
        metadata: {},
      });

      const c = createMockContext({
        query: { challenge_id: 'test-challenge' },
        challengeStore,
      });

      await consentGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Invalid challenge type',
        }),
        400
      );
    });

    it('drops unsafe client metadata URLs from the HTML consent fallback', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'unsafe-consent-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          scope: 'openid profile',
        },
      });

      const mockDB = createMockDB({
        firstResult: {
          client_id: 'test-client',
          client_name: '<img src=x onerror=alert(1)>',
          logo_uri: 'javascript:alert(1)',
          client_uri: 'https://example.com',
          policy_uri: 'javascript:alert(1)',
          tos_uri: 'data:text/html,<script>alert(1)</script>',
          is_trusted: 0,
        },
      });

      const c = createMockContext({
        query: { challenge_id: 'unsafe-consent-challenge' },
        headers: { accept: 'text/html' },
        challengeStore,
        db: mockDB,
      });

      const response = await consentGetHandler(c);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('javascript:alert');
      expect(html).not.toContain('data:text/html');
      expect(html).not.toContain('<img src="javascript:');
      expect(html).not.toContain('href="javascript:');
    });

    it('should return client and scope information', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-123',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          scope: 'openid profile email',
          redirect_uri: 'https://example.com/callback',
          state: 'test-state',
        },
      });

      const mockDB = createMockDB({
        firstResult: {
          client_id: 'test-client',
          client_name: 'Test Application',
          logo_uri: 'https://example.com/logo.png',
          client_uri: 'https://example.com',
          policy_uri: 'https://example.com/privacy',
          tos_uri: 'https://example.com/terms',
          is_trusted: 0,
        },
      });

      const c = createMockContext({
        query: { challenge_id: 'consent-challenge-123' },
        headers: { accept: 'application/json' },
        challengeStore,
        db: mockDB,
      });

      await consentGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          challenge_id: 'consent-challenge-123',
          client: expect.objectContaining({
            client_id: 'test-client',
            client_name: 'Test Application',
          }),
          scopes: expect.any(Array),
        })
      );
    });

    it('should return 400 for non-existent client', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-123',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'nonexistent-client',
          scope: 'openid',
        },
      });

      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        query: { challenge_id: 'consent-challenge-123' },
        challengeStore,
        db: mockDB,
      });

      await consentGetHandler(c);

      // Security: Generic message to prevent client_id enumeration
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        }),
        401
      );
    });

    it('should include human-readable scope descriptions', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-123',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          scope: 'openid profile email',
        },
      });

      const mockDB = createMockDB({
        firstResult: {
          client_id: 'test-client',
          client_name: 'Test App',
          is_trusted: 0,
        },
      });

      const c = createMockContext({
        query: { challenge_id: 'consent-challenge-123' },
        headers: { accept: 'application/json' },
        challengeStore,
        db: mockDB,
      });

      await consentGetHandler(c);

      // Should include scope details
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: expect.arrayContaining([
            expect.objectContaining({
              name: expect.any(String),
            }),
          ]),
        })
      );
    });

    it('rejects JSON consent display when the authenticated user no longer exists', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'missing-user-challenge',
        type: 'consent',
        userId: 'deleted-user',
        metadata: { client_id: 'test-client', scope: 'openid' },
      });
      const c = createMockContext({
        query: { challenge_id: 'missing-user-challenge' },
        headers: { accept: 'application/json' },
        challengeStore,
        db: createMockDB({
          firstResult: { client_id: 'test-client', client_name: null, is_trusted: 0 },
        }),
      });

      await consentGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'access_denied' }), 401);
    });

    it('renders required, optional, and implicit consent items with safe HTML controls', async () => {
      vi.mocked(getConsentItemsForScreen).mockResolvedValue([
        {
          statement_id: 'implicit-statement',
          slug: 'implicit',
          category: 'privacy_policy',
          legal_basis: 'contract',
          title: '<Implicit>',
          description: 'Always applied',
          document_url: 'https://example.com/implicit',
          version: '1',
          version_id: 'version-1',
          is_required: true,
          enforcement: 'block',
          needs_version_upgrade: false,
          show_deletion_link: false,
          checkbox_mode: 'none',
          checkbox_default_checked: true,
          withdrawal_allowed: false,
          display_order: 1,
        },
        {
          statement_id: 'required-statement',
          slug: 'required',
          category: 'terms_of_service',
          legal_basis: 'consent',
          title: 'Required terms',
          description: '',
          version: '1',
          version_id: 'version-2',
          is_required: true,
          enforcement: 'block',
          needs_version_upgrade: false,
          show_deletion_link: false,
          checkbox_mode: 'required',
          checkbox_default_checked: true,
          withdrawal_allowed: true,
          display_order: 2,
        },
        {
          statement_id: 'optional-statement',
          slug: 'optional',
          category: 'marketing',
          legal_basis: 'consent',
          title: 'Optional updates',
          description: 'Product updates',
          version: '1',
          version_id: 'version-3',
          is_required: false,
          enforcement: 'allow_continue',
          needs_version_upgrade: false,
          show_deletion_link: false,
          checkbox_mode: 'optional',
          checkbox_default_checked: false,
          withdrawal_allowed: true,
          display_order: 3,
        },
      ]);
      const challengeStore = createMockChallengeStore({
        id: 'html-items-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: { client_id: 'test-client', scope: 'openid custom_scope' },
      });
      const c = createMockContext({
        query: { challenge_id: 'html-items-challenge' },
        headers: { accept: 'text/html' },
        challengeStore,
        db: createMockDB({
          firstResult: {
            client_id: 'test-client',
            client_name: null,
            logo_uri: 'https://example.com/logo.png',
            policy_uri: 'https://example.com/privacy',
            tos_uri: 'https://example.com/terms',
            is_trusted: 0,
          },
        }),
      });

      const response = await consentGetHandler(c);
      const html = await response.text();

      expect(html).toContain('&lt;Implicit&gt;');
      expect(html).toContain('name="consent_item_decision:implicit-statement" value="granted"');
      expect(html).toContain(
        'name="consent_item_decision:required-statement" value="granted" checked'
      );
      expect(html).toContain('name="consent_item_decision:optional-statement" value="granted"');
      expect(html).toContain('Privacy Policy');
      expect(html).toContain('Terms of Service');
      expect(html).toContain('custom_scope');
    });

    it('falls back to the base HTML screen when optional consent-item loading fails', async () => {
      vi.mocked(getConsentItemsForScreen).mockRejectedValueOnce(new Error('optional unavailable'));
      const challengeStore = createMockChallengeStore({
        id: 'fallback-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: { client_id: 'test-client', scope: 'openid' },
      });
      const c = createMockContext({
        query: { challenge_id: 'fallback-challenge' },
        headers: { accept: 'text/html' },
        challengeStore,
        db: createMockDB({ firstResult: { client_id: 'test-client', is_trusted: 0 } }),
      });

      const response = await consentGetHandler(c);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('Additional consent is required');
    });
  });

  describe('consentPostHandler', () => {
    it('should require challenge_id parameter', async () => {
      const c = createMockContext({
        method: 'POST',
        body: { approved: true },
        headers: { 'content-type': 'application/json' },
      });

      await consentPostHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Missing challenge_id parameter',
        }),
        400
      );
    });

    it('should return error for invalid challenge', async () => {
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'invalid-challenge', approved: true },
        headers: { 'content-type': 'application/json' },
      });

      await consentPostHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('Invalid'),
        }),
        400
      );
    });

    it('should redirect with access_denied on denial', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-123',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
          state: 'test-state',
        },
      });

      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-123', approved: false },
        headers: { 'content-type': 'application/json' },
        challengeStore,
      });

      await consentPostHandler(c);

      // For JSON requests, returns redirect_url
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          redirect_url: expect.stringContaining('error=access_denied'),
        })
      );
    });

    it('should include state in denial redirect', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-123',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
          state: 'my-csrf-state',
        },
      });

      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-123', approved: false },
        headers: { 'content-type': 'application/json' },
        challengeStore,
      });

      await consentPostHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          redirect_url: expect.stringContaining('state=my-csrf-state'),
        })
      );
    });

    it('returns a JARM-secured access_denied response when JWT response mode was requested', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-jarm',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          response_type: 'code',
          response_mode: 'jwt',
          scope: 'openid',
          state: 'test-state',
        },
      });

      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-jarm', approved: false },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        env: {
          SETTINGS: {
            get: vi.fn().mockResolvedValue(
              JSON.stringify({
                fapi: {
                  messageSigning: {
                    enabled: true,
                    requireJarm: true,
                    authorizationSigningAlgorithms: ['ES256'],
                  },
                },
              })
            ),
          },
        },
      });

      await consentPostHandler(c);

      expect(mockRedirectWithError).toHaveBeenCalledWith(
        c,
        'https://example.com/callback',
        'access_denied',
        'User denied the consent request',
        'test-state',
        expect.objectContaining({
          responseMode: 'jwt',
          responseType: 'code',
          clientId: 'test-client',
          isUserCancellation: true,
          messageSigning: expect.objectContaining({ enabled: true, requireJarm: true }),
        })
      );
      expect(c.json).toHaveBeenCalledWith({
        redirect_url: 'https://example.com/callback?response=signed-jarm',
      });
    });

    it('does not downgrade a JARM denial when client metadata is incomplete', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-jarm-no-client',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          redirect_uri: 'https://example.com/callback',
          response_type: 'code',
          response_mode: 'jwt',
          scope: 'openid',
          state: 'test-state',
        },
      });
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-jarm-no-client', approved: false },
        headers: { 'content-type': 'application/json' },
        challengeStore,
      });

      const response = await consentPostHandler(c);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: 'server_error',
      });
      expect(mockRedirectWithError).not.toHaveBeenCalled();
      expect(c.redirect).not.toHaveBeenCalled();
    });

    it('does not downgrade a JARM denial when security settings are unavailable', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-jarm-settings-down',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          response_type: 'code',
          response_mode: 'jwt',
          scope: 'openid',
          state: 'test-state',
        },
      });
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-jarm-settings-down', approved: false },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        env: {
          SETTINGS: {
            get: vi.fn().mockRejectedValue(new Error('KV unavailable')),
          },
        },
      });

      const response = await consentPostHandler(c);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: 'temporarily_unavailable',
      });
      expect(mockRedirectWithError).not.toHaveBeenCalled();
      expect(c.redirect).not.toHaveBeenCalled();
    });

    it('should save consent and redirect on approval', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-123',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
          state: 'test-state',
        },
      });

      const mockDB = createMockDB({
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-123', approved: true },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: mockDB,
      });

      await consentPostHandler(c);

      // Should save consent to database
      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('oauth_client_consents'));
      const jsonBody = c.json.mock.calls[0][0] as { redirect_url: string };
      const redirectUrl = new URL(jsonBody.redirect_url, 'https://example.com');
      const confirmationChallenge = redirectUrl.searchParams.get('_consent_confirmation_challenge');
      expect(confirmationChallenge).toBeTruthy();
      expect(redirectUrl.searchParams.get('_consent_confirmed')).toBeNull();
      expect(challengeStore._challenges.get(confirmationChallenge!)).toMatchObject({
        type: 'consent',
        userId: 'user-123',
        metadata: {
          purpose: 'authorize_consent_confirmation',
          authorization_request: expect.objectContaining({
            response_type: 'code',
            client_id: 'test-client',
            scope: 'openid profile',
          }),
        },
      });
    });

    it('should reject approval when required consent items are not granted', async () => {
      vi.mocked(getConsentItemsForScreen).mockResolvedValue([
        {
          statement_id: 'stmt-required',
          slug: 'terms',
          category: 'terms_of_service',
          legal_basis: 'consent',
          title: 'Terms',
          description: 'Terms',
          version: '20260620',
          version_id: 'ver-required',
          is_required: true,
          enforcement: 'block',
          needs_version_upgrade: false,
          show_deletion_link: false,
          checkbox_mode: 'required',
          checkbox_default_checked: false,
          withdrawal_allowed: true,
          display_order: 1,
        },
      ]);
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-required',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
          state: 'test-state',
        },
      });
      const mockDB = createMockDB({
        runResult: { success: true },
      });
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-required', approved: true },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: mockDB,
      });

      await consentPostHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'consent_required',
        }),
        400
      );
      expect(processConsentItemDecisions).not.toHaveBeenCalled();
      expect(mockDB.prepare).not.toHaveBeenCalledWith(
        expect.stringContaining('oauth_client_consents')
      );
    });

    it('should accept checked form consent item decisions for required items', async () => {
      vi.mocked(getConsentItemsForScreen).mockResolvedValue([
        {
          statement_id: 'stmt-required',
          slug: 'terms',
          category: 'terms_of_service',
          legal_basis: 'consent',
          title: 'Terms',
          description: 'Terms',
          version: '20260620',
          version_id: 'ver-required',
          is_required: true,
          enforcement: 'block',
          needs_version_upgrade: false,
          show_deletion_link: false,
          checkbox_mode: 'required',
          checkbox_default_checked: false,
          withdrawal_allowed: true,
          display_order: 1,
        },
      ]);
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-form-required',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
          state: 'test-state',
          response_type: 'code',
        },
      });
      const mockDB = createMockDB({
        runResult: { success: true },
      });
      const c = createMockContext({
        method: 'POST',
        body: {
          challenge_id: 'consent-challenge-form-required',
          approved: 'true',
          'consent_item_decision:stmt-required': ['denied', 'granted'],
        },
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        challengeStore,
        db: mockDB,
      });

      await consentPostHandler(c);

      expect(processConsentItemDecisions).toHaveBeenCalledWith(
        expect.anything(),
        'default',
        'user-123',
        { 'stmt-required': 'granted' },
        expect.objectContaining({ client_id: 'test-client' }),
        undefined,
        {
          'stmt-required': {
            version_id: 'ver-required',
            version: '20260620',
            withdrawal_allowed: true,
          },
        }
      );
      expect(c.redirect).toHaveBeenCalledWith(
        expect.stringContaining('_consent_confirmation_challenge='),
        302
      );
    });

    it('should handle form-encoded requests', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-123',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
          state: 'test-state',
        },
      });

      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-123', approved: 'false' },
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        challengeStore,
      });

      await consentPostHandler(c);

      // For form requests, should redirect
      expect(c.redirect).toHaveBeenCalledWith(expect.stringContaining('error=access_denied'), 302);
    });

    it('should consume challenge after processing', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-123',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
        },
      });

      const mockDB = createMockDB({
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'consent-challenge-123', approved: true },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: mockDB,
      });

      await consentPostHandler(c);

      // Challenge should be consumed (removed from store)
      expect(challengeStore._challenges.has('consent-challenge-123')).toBe(false);
    });

    it('should handle org_id selection', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-123',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid',
          org_id: 'default-org',
        },
      });

      const mockDB = createMockDB({
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          challenge_id: 'consent-challenge-123',
          approved: true,
          selected_org_id: 'selected-org-123',
        },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: mockDB,
      });

      await consentPostHandler(c);

      // Should save consent
      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('oauth_client_consents'));
    });

    it('rejects granular scope approval that removes the mandatory openid scope', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'granular-openid-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile email',
        },
      });
      const c = createMockContext({
        method: 'POST',
        body: {
          challenge_id: 'granular-openid-challenge',
          approved: true,
          selected_scopes: ['profile'],
        },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        env: { CONSENT_GRANULAR_SCOPES: 'true' },
      });

      await consentPostHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ error_description: expect.stringContaining('openid') }),
        400
      );
    });

    it('filters granular scopes to the original authorization request', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'granular-filter-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          response_type: 'code',
          client_id: 'test-client',
          redirect_uri: 'https://example.com/callback',
          scope: 'openid profile',
        },
      });
      const mockDB = createMockDB({ runResult: { success: true } });
      const c = createMockContext({
        method: 'POST',
        body: {
          challenge_id: 'granular-filter-challenge',
          approved: true,
          selected_scopes: ['openid', 'email'],
        },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: mockDB,
        env: { CONSENT_GRANULAR_SCOPES: 'true' },
      });

      await consentPostHandler(c);

      const response = c.json.mock.calls[0][0] as { redirect_url: string };
      const confirmationId = new URL(response.redirect_url, 'https://example.com').searchParams.get(
        '_consent_confirmation_challenge'
      );
      expect(challengeStore._challenges.get(confirmationId!)?.metadata).toMatchObject({
        authorization_request: expect.objectContaining({ scope: 'openid' }),
      });
    });

    it('uses cancel_uri only for denial and preserves acting-as state', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'cancel-uri-challenge',
        type: 'consent',
        userId: 'user-123',
        metadata: {
          client_id: 'test-client',
          redirect_uri: 'https://client.example/callback',
          cancel_uri: 'https://client.example/cancel',
          scope: 'openid',
          acting_as: 'delegated-user',
        },
      });
      const c = createMockContext({
        method: 'POST',
        body: { challenge_id: 'cancel-uri-challenge', approved: false },
        headers: { 'content-type': 'application/json' },
        challengeStore,
      });

      await consentPostHandler(c);

      const response = c.json.mock.calls[0][0] as { redirect_url: string };
      expect(response.redirect_url).toMatch(/^https:\/\/client\.example\/cancel/);
      expect(response.redirect_url).toContain('error=access_denied');
    });
  });
});
