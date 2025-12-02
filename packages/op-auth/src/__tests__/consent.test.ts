/**
 * Consent Handlers Unit Tests
 *
 * Tests for OAuth2/OIDC consent screen:
 * - GET: Display consent information
 * - POST: Handle approval/denial
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/shared/types/env';
import { consentGetHandler, consentPostHandler } from '../consent';

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
}) {
  const mockDB =
    options.db ??
    createMockDB({
      firstResult: null,
      allResults: [],
    });

  const challengeStore = options.challengeStore ?? createMockChallengeStore();

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
    } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    redirect: vi.fn(
      (url: string, status: number) => new Response(null, { status, headers: { Location: url } })
    ),
    _mockDB: mockDB,
    _challengeStore: challengeStore,
  } as any;

  return c;
}

describe('Consent Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        firstResult: null, // Client not found
      });

      const c = createMockContext({
        query: { challenge_id: 'consent-challenge-123' },
        challengeStore,
        db: mockDB,
      });

      await consentGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client',
          error_description: 'Client not found',
        }),
        400
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

    it('should save consent and redirect on approval', async () => {
      const challengeStore = createMockChallengeStore({
        id: 'consent-challenge-123',
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
        body: { challenge_id: 'consent-challenge-123', approved: true },
        headers: { 'content-type': 'application/json' },
        challengeStore,
        db: mockDB,
      });

      await consentPostHandler(c);

      // Should save consent to database
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO oauth_client_consents')
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
  });
});
